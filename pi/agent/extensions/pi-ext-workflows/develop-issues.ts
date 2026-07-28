import { Type, type Static } from "typebox";
import {
  registerWorkflowExtension,
  type JsonValue,
  type ShellResult,
  type WorkflowExtension,
  type WorkflowFunctionContext,
  type WorkflowWorktreeReference,
} from "../../../../git/personale/pi-workflows/packages/core/dist/src/index.js";

const loopResultSchema = Type.Object(
  {
    pass: Type.Boolean(),
    iterations: Type.Integer(),
    devResult: Type.Any(),
    review: Type.Object(
      {
        pass: Type.Boolean(),
        findings: Type.Array(Type.String()),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const issueResultSchema = Type.Object(
  {
    devRes: loopResultSchema,
    worktree: Type.Object(
      {
        path: Type.String(),
        branch: Type.String(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

type IssueResult = Static<typeof issueResultSchema>;

type WorktreeCleanup = {
  removed: string[];
  skipped: string[];
  failed: string[];
};

function shellFailure(name: string, result: ShellResult): string {
  const detail =
    result.stderr || result.stdout || `git exited ${String(result.exitCode)}`;
  return `${name}: ${detail.trim()}`;
}

type IssueDetailResult = {
  title: string;
  content: string;
  comments: Array<{ author: string; comment: string }>;
};
async function getIssueDetail(
  shell: WorkflowFunctionContext["shell"],
  issueId: number,
): Promise<IssueDetailResult> {
  const options = { env: { PI_ISSUE_ID: String(issueId) } };
  const ghResult = await shell(
    'gh issue view "$PI_ISSUE_ID" --json title,body,comments',
    options,
  );
  let result = ghResult;
  if (result.exitCode !== 0) {
    const glabResult = await shell(
      'glab issue view "$PI_ISSUE_ID" --comments --output json',
      options,
    );
    if (glabResult.exitCode !== 0)
      throw new Error(
        `${shellFailure("gh issue view", ghResult)}; ${shellFailure("glab issue view", glabResult)}`,
      );
    result = glabResult;
  }

  let issue: {
    title?: unknown;
    body?: unknown;
    description?: unknown;
    comments?: unknown;
    notes?: unknown;
  };
  try {
    issue = JSON.parse(result.stdout) as typeof issue;
  } catch {
    throw new Error(`Issue #${String(issueId)} returned invalid JSON`);
  }

  if (typeof issue.title !== "string")
    throw new Error(`Issue #${String(issueId)} is missing a title`);
  const content = issue.body ?? issue.description ?? "";
  if (typeof content !== "string")
    throw new Error(`Issue #${String(issueId)} is missing valid content`);

  const rawComments = issue.comments ?? issue.notes ?? [];
  if (!Array.isArray(rawComments))
    throw new Error(`Issue #${String(issueId)} has invalid comments`);
  const comments = rawComments.map((rawComment) => {
    if (rawComment === null || typeof rawComment !== "object")
      throw new Error(`Issue #${String(issueId)} has an invalid comment`);
    const comment = rawComment as Record<string, unknown>;
    const authorValue = comment.author;
    const author =
      typeof authorValue === "string"
        ? authorValue
        : authorValue !== null && typeof authorValue === "object"
          ? ((authorValue as Record<string, unknown>).login ??
            (authorValue as Record<string, unknown>).username)
          : undefined;
    const body = comment.body ?? comment.comment;
    if (typeof author !== "string" || typeof body !== "string")
      throw new Error(`Issue #${String(issueId)} has an invalid comment`);
    return { author, comment: body };
  });

  return { title: issue.title, content, comments };
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

export const developIssuesExtension: WorkflowExtension = {
  version: "1.0.0",
  headline: "Parallel issue development",
  description:
    "Develops GitHub issues in isolated worktrees, merges approved results, and summarizes the work.",
  functions: {
    developIssuesUntilApproved: {
      description:
        "Develop issue numbers in parallel worktrees, merge them into main after review, then summarize the result. Issue info is automatically fetched",
      input: Type.Object(
        {
          issues: Type.Array(Type.Integer({ minimum: 1 }), {
            minItems: 1,
            uniqueItems: true,
          }),
          maxIterations: Type.Optional(Type.Integer({ minimum: 1 })),
        },
        { additionalProperties: false },
      ),
      output: Type.Object(
        {
          issues: Type.Array(Type.Integer()),
          issueResults: Type.Object(
            {},
            { additionalProperties: issueResultSchema },
          ),
          merge: Type.Union([loopResultSchema, Type.Null()]),
          summary: Type.Any(),
        },
        { additionalProperties: false },
      ),
      async run(
        input,
        { agent, log, invoke, phase, shell, parallel, prompt, withWorktree },
      ) {
        const issues = input.issues as number[];
        const maxIterations = (input.maxIterations as number | undefined) ?? 5;
        const tasks: Record<string, () => Promise<JsonValue>> = {};

        for (const issue of issues) {
          tasks[`issue-${issue}`] = () =>
            withWorktree(`issue-${issue}`, async (worktree) => {
              const issueDetail = await getIssueDetail(shell, issue);
              const devRes = await invoke("developUntilApproved", {
                task: `Resolve issue #${issue} in the current repository. The final commit should reference the issue.
Issue details:
<issue_number>${issue}</issue_number>
<issue_title>${issueDetail.title}</issue_title>
<issue_content>${issueDetail.content}</issue_content>
<issue_comments>${JSON.stringify(issueDetail.comments, null, 2)}</issue_comments>`,
                maxIterations,
              });

              return { devRes, worktree };
            });
        }

        phase("issues");
        log(`Developing ${issues.length} issue(s) in parallel worktrees`);
        const issueResults = await parallel("issues", tasks);
        const entries = Object.entries(
          issueResults as Record<string, IssueResult>,
        );
        const approvedEntries = entries.filter(
          ([, result]) => result.devRes.pass,
        );
        const failedEntries = entries.filter(
          ([, result]) => !result.devRes.pass,
        );
        const approvedResults = Object.fromEntries(approvedEntries);
        const failedResults = Object.fromEntries(failedEntries);
        const failedIssueNames = Object.keys(failedResults);

        if (failedIssueNames.length > 0)
          log(
            `Skipping failed issue worktrees: ${failedIssueNames.join(", ")}\n${JSON.stringify(failedResults)}`,
          );

        const approvedWorktrees = approvedEntries.map(
          ([, result]) => result.worktree,
        );

        let merge: JsonValue = null;
        if (approvedWorktrees.length > 0) {
          phase("merge");
          log("Merging approved issue worktrees into main");
          let mergeFailure: unknown = null;
          try {
            merge = await invoke("developUntilApproved", {
              task: prompt(
                `Merge only the approved issue worktrees into the current main working tree.
Do not merge failed issue worktrees. Use each approved result's worktree to
identify the exact branch and path, merge the approved branches, resolve conflicts,
run the full relevant test suite, commit the merge result, and leave the current
working tree clean.

Approved issue results:
{approvedResults}
Failed issue worktrees to skip:
{failedIssueNames}`,
                {
                  approvedResults,
                  failedIssueNames,
                },
              ),
              maxIterations,
            });
          } catch (error) {
            mergeFailure = error;
          }

          const cleanup = await cleanupMergedWorktrees(
            shell,
            approvedWorktrees,
          );
          log(`Approved worktree cleanup: ${JSON.stringify(cleanup)}`);

          if (mergeFailure !== null) throw mergeFailure;
          if (cleanup.failed.length > 0)
            throw new Error(
              `Worktree cleanup failed: ${cleanup.failed.join("; ")}`,
            );
          if (!(merge as { pass?: boolean }).pass)
            throw new Error("Merged result failed review");
        } else {
          log("No approved issue worktrees to merge");
        }

        phase("summary");
        const summary = await agent(
          prompt(
            `Summarize what succeeded, what failed review, what was tested, and what
was merged. Do not change files.

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
    },
  },
};

export default function (): void {
  registerWorkflowExtension(developIssuesExtension);
}
