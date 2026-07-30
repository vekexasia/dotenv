import { Type, type Static } from "typebox";
import {
  defineWorkflowFunction,
  registerWorkflowExtension,
  type ShellResult,
  type WorkflowExtension,
  type WorkflowFunctionContext,
} from "pi-extensible-workflows";

export const fetchIssueDetails = defineWorkflowFunction({
  description: "Fetch issue titles, content, and comments by issue number",

  async run({ issues }, { shell, parallel, phase }) {
    phase("Fetching issue details");
    const tasks: Record<string, () => ReturnType<typeof getIssueDetail>> = {};
    for (const issue of issues)
      tasks[`issue-${issue}`] = () => getIssueDetail(shell, issue);
    return {
      issueDetails: Object.values(await parallel("issue-details", tasks)),
    };
  },
  input: Type.Object(
    {
      issues: Type.Array(Type.Integer({ minimum: 1 }), {
        minItems: 1,
        uniqueItems: true,
      }),
    },
    { additionalProperties: false },
  ),
  output: Type.Object(
    {
      issueDetails: Type.Array(
        Type.Object(
          {
            number: Type.Integer({ minimum: 1 }),
            title: Type.String(),
            content: Type.String(),
            comments: Type.Array(
              Type.Object(
                { author: Type.String(), comment: Type.String() },
                { additionalProperties: false },
              ),
            ),
          },
          { additionalProperties: false },
        ),
        { minItems: 1 },
      ),
    },
    { additionalProperties: false },
  ),
});

export const fetchIssueDetailsInputSchema = fetchIssueDetails.input;
export const fetchIssueDetailsOutputSchema = fetchIssueDetails.output;
export type IssueDetail = Static<
  typeof fetchIssueDetailsOutputSchema
>["issueDetails"][number];

const extension: WorkflowExtension = {
  version: "1.0.0",
  headline: "Fetch issue details",
  description: "Fetches GitHub or GitLab issue details for other workflows.",
  functions: { fetchIssueDetails },
};

export default function (): void {
  registerWorkflowExtension(extension);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function shellFailure(name: string, result: ShellResult): string {
  const detail =
    result.stderr || result.stdout || `git exited ${String(result.exitCode)}`;
  return `${name}: ${detail.trim()}`;
}

async function getIssueDetail(
  shell: WorkflowFunctionContext["shell"],
  issueNumber: number,
) {
  const options = { env: { PI_ISSUE_NUMBER: String(issueNumber) } };
  const ghResult = await shell(
    'gh issue view "$PI_ISSUE_NUMBER" --json number,title,body,comments',
    options,
  );
  let result = ghResult;
  if (result.exitCode !== 0) {
    const glabResult = await shell(
      'glab issue view "$PI_ISSUE_NUMBER" --comments --output json',
      options,
    );
    if (glabResult.exitCode !== 0)
      throw new Error(
        `${shellFailure("gh issue view", ghResult)}; ${shellFailure("glab issue view", glabResult)}`,
      );
    result = glabResult;
  }

  let issue: unknown;
  try {
    issue = JSON.parse(result.stdout);
  } catch {
    throw new Error(`Issue #${String(issueNumber)} returned invalid JSON`);
  }
  if (!record(issue))
    throw new Error(`Issue #${String(issueNumber)} returned invalid JSON`);

  const number = issue.number ?? issue.iid ?? issueNumber;
  if (typeof number !== "number" || !Number.isInteger(number) || number < 1)
    throw new Error(`Issue #${String(issueNumber)} is missing a valid number`);

  const title = issue.title;
  if (typeof title !== "string")
    throw new Error(`Issue #${String(issueNumber)} is missing a title`);

  const content = issue.body ?? issue.description ?? "";
  if (typeof content !== "string")
    throw new Error(`Issue #${String(issueNumber)} is missing valid content`);

  const rawComments = issue.comments ?? issue.notes ?? [];
  if (!Array.isArray(rawComments))
    throw new Error(`Issue #${String(issueNumber)} has invalid comments`);

  const comments = rawComments.map((comment) => {
    if (!record(comment))
      throw new Error(`Issue #${String(issueNumber)} has an invalid comment`);
    const authorValue = comment.author;
    const author =
      typeof authorValue === "string"
        ? authorValue
        : record(authorValue)
          ? (authorValue.login ?? authorValue.username)
          : undefined;
    const body = comment.body ?? comment.comment;
    if (typeof author !== "string" || typeof body !== "string")
      throw new Error(`Issue #${String(issueNumber)} has an invalid comment`);
    return { author, comment: body };
  });

  return { number, title, content, comments };
}
