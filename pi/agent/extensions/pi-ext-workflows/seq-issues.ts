import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import {
  defineWorkflowFunction,
  registerWorkflowExtension,
  type WorkflowExtension,
} from "pi-extensible-workflows";
import {
  fetchIssueDetailsInputSchema,
  fetchIssueDetailsOutputSchema,
} from "./fetch-issue-details.js";
import { developIssues, developIssuesOutputSchema } from "./develop-issues.js";
import { reviewLoopInputSchema } from "./review-loop.js";

export const devIssuesInBatches = defineWorkflowFunction({
  description:
    "Analyze issue dependencies and invoke parallel issue development once per sequential batch",
  async run({ issues, maxIterations = 5 }, context) {
    const { agent, invoke, log, phase, prompt } = context;

    phase("fetch");
    const fetched = await invoke("fetchIssueDetails", { issues });
    if (!Value.Check(fetchIssueDetailsOutputSchema, fetched))
      throw new Error("fetchIssueDetails returned an unexpected result");
    const issueDetails = fetched.issueDetails;

    const batchPlanSchema = Type.Object(
      {
        batches: Type.Array(
          Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1 }),
          { minItems: 1 },
        ),
      },
      { additionalProperties: false },
    );
    const plan = await agent(
      prompt(
        `Analyze these issue details and group issues into dependency batches. Issues in the same batch can be developed in parallel. Later batches depend on earlier batches, so put a prerequisite issue in an earlier batch than any issue that depends on it. Include every requested issue exactly once and do not invent issues.

Issue details:
{issueDetails}`,
        { issueDetails },
      ),
      { model: "cheap-model", tools: [], outputSchema: batchPlanSchema },
    );
    validateBatches(plan.batches, issues);

    const detailsByNumber = new Map(
      issueDetails.map((issue) => [issue.number, issue]),
    );
    const batchResults: Static<typeof developIssuesOutputSchema>[] = [];
    for (const [index, batch] of plan.batches.entries()) {
      phase(`batch-${index + 1}`);
      log(`Developing batch ${index + 1}/${plan.batches.length}`);
      const batchDetails = batch.map((issue) => {
        const detail = detailsByNumber.get(issue);
        if (!detail)
          throw new Error(
            `Missing fetched details for issue #${String(issue)}`,
          );
        return detail;
      });
      batchResults.push(
        await developIssues.run(
          { issueDetails: batchDetails, maxIterations },
          context,
        ),
      );
    }

    return { issues, batches: plan.batches, batchResults };
  },
  input: Type.Object(
    {
      issues: fetchIssueDetailsInputSchema.properties.issues,
      maxIterations: reviewLoopInputSchema.properties.maxIterations,
    },
    { additionalProperties: false },
  ),
  output: Type.Object(
    {
      issues: Type.Array(Type.Integer()),
      batches: Type.Array(Type.Array(Type.Integer())),
      batchResults: Type.Array(developIssuesOutputSchema),
    },
    { additionalProperties: false },
  ),
});

export const seqIssuesOutputSchema = devIssuesInBatches.output;

const extension: WorkflowExtension = {
  version: "1.0.0",
  headline: "Batch issue development",
  description:
    "Fetches issue details, identifies dependencies, and develops dependency batches sequentially.",
  functions: { devIssuesInBatches },
};

export default function (): void {
  registerWorkflowExtension(extension);
}

function validateBatches(batches: number[][], issues: number[]): void {
  const flattened = batches.flat();
  const expected = new Set(issues);
  if (
    flattened.length !== issues.length ||
    new Set(flattened).size !== issues.length ||
    flattened.some((issue) => !expected.has(issue))
  )
    throw new Error(
      `Agent returned an invalid issue batch plan: ${JSON.stringify(batches)}`,
    );
}
