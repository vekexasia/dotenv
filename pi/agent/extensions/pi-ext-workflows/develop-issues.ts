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

export const developIssues = defineWorkflowFunction({
  description:
    "Develop issues in parallel worktrees and merge approved results",
  async run(
    { issueDetails, maxIterations = 5 },
    { agent, log, invoke, phase, shell, parallel, prompt, withWorktree },
  ) {
    const tasks: Record<string, () => Promise<IssueResult>> = {};
    for (const issue of issueDetails) {
      tasks[`issue-${issue.number}`] = () =>
        withWorktree(`issue-${issue.number}`, async (worktree) => ({
          devRes: reviewResult(
            await invoke("developUntilApproved", {
              task: issueTask(issue),
              maxIterations,
            }),
          ),
          worktree,
        }));
    }

    phase("issues");
    log(`Developing ${issueDetails.length} issue(s) in parallel worktrees`);
    const issueResults = await parallel("issues", tasks);
    const entries = Object.entries(issueResults);
    const approvedEntries = entries.filter(([, result]) => result.devRes.pass);
    const failedEntries = entries.filter(([, result]) => !result.devRes.pass);
    const approvedResults = Object.fromEntries(approvedEntries);
    const failedIssueNames = failedEntries.map(([name]) => name);
    const approvedWorktrees = approvedEntries.map(
      ([, result]) => result.worktree,
    );

    if (failedIssueNames.length > 0)
      log(`Skipping failed issue worktrees: ${failedIssueNames.join(", ")}`);

    let merge: Static<typeof reviewLoopOutputSchema> | null = null;
    if (approvedWorktrees.length > 0) {
      phase("merge");
      let mergeFailure: unknown = null;
      try {
        merge = reviewResult(
          await invoke("developUntilApproved", {
            task: prompt(
              `Integrate only the approved issue worktrees into the current main working tree.
Do not integrate failed issue worktrees. Process approved worktrees sequentially in the order provided. For each one:

1. Rebase its branch onto the current main HEAD from its worktree.
2. Resolve conflicts and run the relevant tests.
3. Fast-forward main to the rebased branch using git merge --ff-only.

Do not create merge commits, squash commits, or cherry-pick commits. After all approved branches are integrated, run the relevant test suite and leave the current working tree and approved worktrees clean.

Approved issue results:
{approvedResults}
Failed issue worktrees to skip:
{failedIssueNames}`,
              { approvedResults, failedIssueNames },
            ),
            maxIterations,
          }),
        );
      } catch (error) {
        mergeFailure = error;
      }

      const cleanup = await cleanupMergedWorktrees(shell, approvedWorktrees);
      log(`Approved worktree cleanup: ${JSON.stringify(cleanup)}`);

      if (mergeFailure !== null) throw mergeFailure;
      if (cleanup.failed.length > 0)
        throw new Error(
          `Worktree cleanup failed: ${cleanup.failed.join("; ")}`,
        );
      if (!merge?.pass) throw new Error("Merged result failed review");
    } else {
      log("No approved issue worktrees to merge");
    }

    phase("summary");
    const issues = issueDetails.map((issue) => issue.number);
    const summary = await agent(
      prompt(
        `Summarize what succeeded, what failed review, what was tested, and what was merged. Do not change files.

Issues:
{issues}

Issue results:
{issueResults}

Failed issues:
{failedIssueNames}

Merge result:
{merge}`,
        { issues, issueResults, failedIssueNames, merge },
      ),
      { role: "summarizer" },
    );

    return { issues, issueResults, merge, summary };
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
              worktree: Type.Object(
                { path: Type.String(), branch: Type.String() },
                { additionalProperties: false },
              ),
            },
            { additionalProperties: false },
          ),
        },
      ),
      merge: Type.Union([reviewLoopOutputSchema, Type.Null()]),
      summary: Type.Any(),
    },
    { additionalProperties: false },
  ),
});

export const developIssuesInputSchema = developIssues.input;
export const developIssuesOutputSchema = developIssues.output;

type IssueResult = {
  devRes: Static<typeof reviewLoopOutputSchema>;
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
