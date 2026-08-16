import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import {
  defineWorkflowFunction,
  type JsonValue,
  type ShellResult,
  type WorkflowFunctionContext,
  type WorkflowWorktreeReference,
} from "pi-extensible-workflows";
import {
  fetchIssueDetailsOutputSchema,
  type IssueDetail,
} from "./fetch-issue-details.js";
import {
  reviewLoopInputSchema,
  reviewLoopOutputSchema,
} from "./review-loop.js";

const integrationResultSchema = Type.Object(
  {
    issue: Type.Integer(),
    status: Type.Union([
      Type.Literal("integrated"),
      Type.Literal("failed"),
      Type.Literal("not-approved"),
    ]),
    stage: Type.String(),
    findings: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

export const developIssues = defineWorkflowFunction({
  description:
    "Develop issues in parallel worktrees and integrate approved results in readiness order",
  async run(
    { issueDetails, maxIterations = 5 },
    { agent, log, invoke, phase, shell, parallel, prompt, withWorktree, run },
  ) {
    const tasks: Record<string, () => Promise<IssueResult>> = {};
    let integrationTail: Promise<unknown> = Promise.resolve();
    let firstIntegrationFailure: string | undefined;

    const enqueueIntegration = (
      issue: IssueDetail,
      worktree: WorkflowWorktreeReference,
    ): Promise<IntegrationResult> => {
      const queued = integrationTail.then(async () => {
        const result = await integrateIssue(
          issue,
          worktree,
          run.cwd,
          maxIterations,
          { invoke, shell },
        );
        if (
          result.status === "failed" &&
          firstIntegrationFailure === undefined
        ) {
          const message = `Integration failed for issue #${String(result.issue)} at ${result.stage}: ${result.findings.join("; ")} Worktree retained: ${worktree.path} (${worktree.branch}).`;
          firstIntegrationFailure = message;
          log(message);
        }
        return result;
      });
      integrationTail = queued;
      return queued;
    };

    for (const issue of issueDetails) {
      tasks[`issue-${issue.number}`] = () =>
        withWorktree(`issue-${issue.number}`, async (worktree) => {
          const devRes = reviewResult(
            await invoke("developUntilApproved", {
              task: issueTask(issue),
              maxIterations,
            }),
          );
          const integration = devRes.pass
            ? await enqueueIntegration(issue, worktree)
            : integrationResult(
                issue.number,
                "not-approved",
                "development",
                devRes.review.findings,
              );
          return { devRes, integration, worktree };
        });
    }

    phase("issues");
    log(`Developing ${issueDetails.length} issue(s) in parallel worktrees`);
    const issueResults = await parallel("issues", tasks);
    const entries = Object.entries(issueResults);
    const failedIssueNames = entries
      .filter(([, result]) => !result.devRes.pass)
      .map(([name]) => name);
    if (failedIssueNames.length > 0)
      log(`Skipping failed issue worktrees: ${failedIssueNames.join(", ")}`);

    const integratedWorktrees = entries
      .filter(([, result]) => result.integration.status === "integrated")
      .map(([, result]) => result.worktree);
    let cleanupFailure: string | undefined;
    if (integratedWorktrees.length === 0) {
      log("No successfully integrated issue worktrees to clean up");
    } else {
      const cleanup = await cleanupMergedWorktrees(shell, integratedWorktrees);
      log(`Integrated worktree cleanup: ${JSON.stringify(cleanup)}`);
      if (cleanup.failed.length > 0)
        cleanupFailure = `Worktree cleanup failed: ${cleanup.failed.join("; ")}`;
    }

    phase("summary");
    const issues = issueDetails.map((issue) => issue.number);
    const summary = await agent(
      prompt(
        `Summarize what succeeded, what failed review, what was tested, and what was integrated. Do not change files.

Issues:
{issues}

Issue results:
{issueResults}

Failed issues:
{failedIssueNames}`,
        {
          issues,
          issueResults,
          failedIssueNames,
        },
      ),
      { role: "summarizer" },
    );

    if (firstIntegrationFailure !== undefined)
      throw new Error(firstIntegrationFailure);
    if (cleanupFailure !== undefined) throw new Error(cleanupFailure);

    return { issues, issueResults, summary };
  },
  input: Type.Object(
    {
      issueDetails: fetchIssueDetailsOutputSchema.properties.issueDetails,
      maxIterations: reviewLoopInputSchema.properties.maxIterations,
    },
    { additionalProperties: false },
  ),
  output: Type.Object(
    {
      issues: Type.Array(Type.Integer()),
      issueResults: Type.Object(
        {},
        {
          additionalProperties: Type.Object(
            {
              devRes: reviewLoopOutputSchema,
              integration: integrationResultSchema,
              worktree: Type.Object(
                { path: Type.String(), branch: Type.String() },
                { additionalProperties: false },
              ),
            },
            { additionalProperties: false },
          ),
        },
      ),
      summary: Type.Any(),
    },
    { additionalProperties: false },
  ),
});

export const developIssuesInputSchema = developIssues.input;
export const developIssuesOutputSchema = developIssues.output;

type IntegrationResult = Static<typeof integrationResultSchema>;

type IssueResult = {
  devRes: Static<typeof reviewLoopOutputSchema>;
  integration: IntegrationResult;
  worktree: { path: string; branch: string };
};

type WorktreeCleanup = {
  removed: string[];
  skipped: string[];
  failed: string[];
};

function reviewResult(value: JsonValue): Static<typeof reviewLoopOutputSchema> {
  if (!Value.Check(reviewLoopOutputSchema, value))
    throw new Error("developUntilApproved returned an unexpected result");
  return value;
}

function integrationResult(
  issue: number,
  status: IntegrationResult["status"],
  stage: string,
  findings: readonly string[],
): IntegrationResult {
  return { issue, status, stage, findings: [...findings] };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function integrateIssue(
  issue: IssueDetail,
  worktree: WorkflowWorktreeReference,
  mainPath: string,
  maxIterations: number,
  { invoke, shell }: Pick<WorkflowFunctionContext, "invoke" | "shell">,
): Promise<IntegrationResult> {
  let stage = "precondition";
  const fail = (findings: readonly string[]): IntegrationResult =>
    integrationResult(
      issue.number,
      "failed",
      stage,
      findings.length > 0 ? findings : ["Integration failed without findings"],
    );

  try {
    const options: { env: Record<string, string> } = {
      env: {
        PI_MAIN_PATH: mainPath,
        PI_WORKTREE_PATH: worktree.path,
        PI_WORKTREE_BRANCH: worktree.branch,
      },
    };
    const mainStatus = await shell(
      'git -C "$PI_MAIN_PATH" status --porcelain',
      options,
    );
    if (mainStatus.exitCode !== 0)
      return fail([shellFailure("main status", mainStatus)]);
    if (mainStatus.stdout.trim()) return fail(["Main working tree is not clean"]);

    const mainHeadResult = await shell(
      'git -C "$PI_MAIN_PATH" rev-parse --verify HEAD',
      options,
    );
    if (mainHeadResult.exitCode !== 0)
      return fail([shellFailure("main HEAD", mainHeadResult)]);
    const capturedMainHead = mainHeadResult.stdout.trim();
    if (!capturedMainHead || /\s/.test(capturedMainHead))
      return fail(["Could not capture a single main HEAD"]);
    options.env.PI_MAIN_HEAD = capturedMainHead;

    const alreadyContained = await shell(
      'git -C "$PI_MAIN_PATH" merge-base --is-ancestor "$PI_WORKTREE_BRANCH" "$PI_MAIN_HEAD"',
      options,
    );
    if (alreadyContained.exitCode !== 0 && alreadyContained.exitCode !== 1)
      return fail([shellFailure("branch ancestry", alreadyContained)]);
    if (alreadyContained.exitCode === 0)
      return integrationResult(
        issue.number,
        "integrated",
        "already-integrated",
        [],
      );

    stage = "rebase";
    const rebase = await shell(
      'git -C "$PI_WORKTREE_PATH" rebase "$PI_MAIN_HEAD"',
      options,
    );
    const rebaseFindings =
      rebase.exitCode === 0
        ? "Rebase onto the captured main HEAD completed."
        : shellFailure("rebase", rebase);

    stage = "review";
    const review = reviewResult(
      await invoke("developUntilApproved", {
        task: `Integrate issue #${issue.number} in the current issue worktree only.

Issue title: ${issue.title}
Issue worktree: ${worktree.path}
Issue branch: ${worktree.branch}
Main worktree: ${mainPath}
Captured main HEAD: ${capturedMainHead}

A deterministic rebase onto the captured main HEAD was attempted before this developer/reviewer loop:
${rebaseFindings}

Resolve any rebase conflicts in the current issue worktree, complete the integration there, and run the relevant repository tests. The reviewer must check the rebased branch and test results. Do not modify the main worktree, create a merge commit, squash, cherry-pick, or fast-forward main. Main is moved only by the orchestrator after this integration review passes and all preconditions are rechecked.`,
        maxIterations,
      }),
    );
    if (!review.pass)
      return fail(
        review.review.findings.length > 0
          ? review.review.findings
          : ["Integration review did not pass"],
      );

    stage = "post-review";
    const worktreeStatus = await shell(
      'git -C "$PI_WORKTREE_PATH" status --porcelain',
      options,
    );
    if (worktreeStatus.exitCode !== 0)
      return fail([shellFailure("issue worktree status", worktreeStatus)]);
    if (worktreeStatus.stdout.trim())
      return fail(["Issue worktree is dirty after integration review"]);

    const rebased = await shell(
      'git -C "$PI_WORKTREE_PATH" merge-base --is-ancestor "$PI_MAIN_HEAD" "$PI_WORKTREE_BRANCH"',
      options,
    );
    if (rebased.exitCode !== 0)
      return fail([shellFailure("rebased branch ancestry", rebased)]);

    const worktreeHead = await shell(
      'git -C "$PI_WORKTREE_PATH" rev-parse --verify HEAD',
      options,
    );
    const branchHead = await shell(
      'git -C "$PI_WORKTREE_PATH" rev-parse --verify "$PI_WORKTREE_BRANCH"',
      options,
    );
    if (worktreeHead.exitCode !== 0 || branchHead.exitCode !== 0)
      return fail([
        shellFailure(
          "reviewed branch HEAD",
          worktreeHead.exitCode !== 0 ? worktreeHead : branchHead,
        ),
      ]);
    if (worktreeHead.stdout.trim() !== branchHead.stdout.trim())
      return fail(["Issue worktree HEAD is not the reviewed branch HEAD"]);
    options.env.PI_REVIEWED_HEAD = branchHead.stdout.trim();

    const mainStatusAfterReview = await shell(
      'git -C "$PI_MAIN_PATH" status --porcelain',
      options,
    );
    if (mainStatusAfterReview.exitCode !== 0)
      return fail([shellFailure("main status after review", mainStatusAfterReview)]);
    if (mainStatusAfterReview.stdout.trim())
      return fail(["Main working tree changed during integration review"]);
    const mainHeadAfterReview = await shell(
      'git -C "$PI_MAIN_PATH" rev-parse --verify HEAD',
      options,
    );
    if (mainHeadAfterReview.exitCode !== 0)
      return fail([shellFailure("main HEAD after review", mainHeadAfterReview)]);
    if (mainHeadAfterReview.stdout.trim() !== capturedMainHead)
      return fail(["Main HEAD changed during integration review"]);

    stage = "fast-forward";
    const fastForward = await shell(
      'test -z "$(git -C "$PI_MAIN_PATH" status --porcelain)" && test "$(git -C "$PI_MAIN_PATH" rev-parse --verify HEAD)" = "$PI_MAIN_HEAD" && git -C "$PI_MAIN_PATH" merge-base --is-ancestor "$PI_MAIN_HEAD" "$PI_REVIEWED_HEAD" && git -C "$PI_MAIN_PATH" merge --ff-only "$PI_REVIEWED_HEAD"',
      options,
    );
    if (fastForward.exitCode !== 0)
      return fail([shellFailure("fast-forward", fastForward)]);

    return integrationResult(issue.number, "integrated", "fast-forward", []);
  } catch (error) {
    return fail([errorMessage(error)]);
  }
}

function shellFailure(name: string, result: ShellResult): string {
  const detail =
    result.stderr || result.stdout || `git exited ${String(result.exitCode)}`;
  return `${name}: ${detail.trim()}`;
}

async function cleanupMergedWorktrees(
  shell: WorkflowFunctionContext["shell"],
  references: readonly WorkflowWorktreeReference[],
): Promise<WorktreeCleanup> {
  const cleanup: WorktreeCleanup = { removed: [], skipped: [], failed: [] };

  for (const reference of references) {
    const name = reference.branch;
    const options = {
      env: {
        PI_WORKTREE_BRANCH: reference.branch,
        PI_WORKTREE_PATH: reference.path,
      },
    };
    const ancestry = await shell(
      'git merge-base --is-ancestor "$PI_WORKTREE_BRANCH" HEAD',
      options,
    );

    if (ancestry.exitCode === 1) {
      cleanup.skipped.push(`${name}: not merged`);
      continue;
    }
    if (ancestry.exitCode !== 0) {
      cleanup.failed.push(shellFailure(name, ancestry));
      continue;
    }

    const status = await shell(
      'git -C "$PI_WORKTREE_PATH" status --porcelain',
      options,
    );
    if (status.exitCode !== 0) {
      cleanup.failed.push(shellFailure(name, status));
      continue;
    }
    if (status.stdout.trim()) {
      cleanup.skipped.push(`${name}: dirty`);
      continue;
    }

    const removal = await shell(
      'git worktree remove "$PI_WORKTREE_PATH"',
      options,
    );
    if (removal.exitCode === 0) cleanup.removed.push(name);
    else cleanup.failed.push(shellFailure(name, removal));
  }

  return cleanup;
}

function issueTask(issue: IssueDetail): string {
  return `Resolve issue #${issue.number} in the current repository. The final commit should reference the issue.
Issue details:
<issue_number>${issue.number}</issue_number>
<issue_title>${issue.title}</issue_title>
<issue_content>${issue.content}</issue_content>
<issue_comments>${JSON.stringify(issue.comments, null, 2)}</issue_comments>`;
}
