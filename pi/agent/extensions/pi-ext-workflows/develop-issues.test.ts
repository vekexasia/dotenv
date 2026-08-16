// @ts-ignore Bun supplies the test module at runtime.
import { expect, test } from "bun:test";
// @ts-ignore Bun loads the TypeScript source directly.
import { developIssues } from "./develop-issues.ts";

const approved = () => ({
  pass: true,
  iterations: 1,
  devResult: null,
  review: { pass: true, findings: [] },
});

const issueDetails = (numbers: readonly number[]) =>
  numbers.map((number) => ({
    number,
    title: `Issue ${number}`,
    content: "content",
    comments: [],
  }));

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function prompt(template: string, values: Record<string, unknown>): string {
  return template.replace(/{(\w+)}/g, (_match, key: string) => {
    const value = values[key];
    return typeof value === "string" ? value : JSON.stringify(value);
  });
}

function context(
  invoke: (name: string, input: Record<string, unknown>) => Promise<unknown>,
  shell: (
    command: string,
    options?: { env?: Record<string, string> },
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
) {
  return {
    agent: async () => null,
    invoke,
    shell,
    prompt,
    parallel: async (
      _name: string,
      tasks: Record<string, () => Promise<unknown>>,
    ) =>
      Object.fromEntries(
        await Promise.all(
          Object.entries(tasks).map(async ([name, task]) => [name, await task()]),
        ),
      ),
    phase: () => {},
    log: () => {},
    withWorktree: async (
      name: string,
      callback: (reference: { path: string; branch: string }) => Promise<unknown>,
    ) => callback({ path: `/worktrees/${name}`, branch: `branch-${name}` }),
    run: { cwd: "/repo" },
  } as unknown as Parameters<typeof developIssues.run>[1];
}

function integrationShell(
  calls: Array<{ command: string; branch?: string }>,
): (
  command: string,
  options?: { env?: Record<string, string> },
) => Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return async (command, options) => {
    const branch = options?.env?.PI_WORKTREE_BRANCH;
    calls.push({ command, ...(branch === undefined ? {} : { branch }) });
    if (command.includes("merge --ff-only"))
      return { exitCode: 0, stdout: "", stderr: "" };
    if (command.includes("status --porcelain"))
      return { exitCode: 0, stdout: "", stderr: "" };
    if (command.includes("merge-base --is-ancestor"))
      return {
        exitCode: command.includes("PI_MAIN_PATH") ? 1 : 0,
        stdout: "",
        stderr: "",
      };
    if (command.includes("rev-parse"))
      return {
        exitCode: 0,
        stdout: command.includes("PI_MAIN_PATH")
          ? "main-head\n"
          : "branch-head\n",
        stderr: "",
      };
    return { exitCode: 0, stdout: "", stderr: "" };
  };
}

test("queues integrations by readiness and keeps one integration active", async () => {
  const developmentOne = deferred<void>();
  const integrationTwo = deferred<void>();
  const integrationTwoStarted = deferred<void>();
  const starts: number[] = [];
  const ends: number[] = [];
  let active = 0;
  let maxActive = 0;
  const shellCalls: Array<{ command: string; branch?: string }> = [];

  const invoke = async (_name: string, input: Record<string, unknown>) => {
    const task = String(input.task);
    if (task.startsWith("Resolve issue #")) {
      const issue = Number(task.match(/#(\d+)/)?.[1]);
      if (issue === 1) await developmentOne.promise;
      return approved();
    }

    const issue = Number(task.match(/#(\d+)/)?.[1]);
    starts.push(issue);
    active += 1;
    maxActive = Math.max(maxActive, active);
    if (issue === 2) {
      integrationTwoStarted.resolve();
      await integrationTwo.promise;
    }
    ends.push(issue);
    active -= 1;
    return approved();
  };

  const run = developIssues.run(
    { issueDetails: issueDetails([1, 2, 3]), maxIterations: 1 },
    context(invoke, integrationShell(shellCalls)),
  );
  await integrationTwoStarted.promise;
  expect(starts).toEqual([2]);

  developmentOne.resolve();
  await Promise.resolve();
  expect(starts).toEqual([2]);
  integrationTwo.resolve();

  const result = await run;
  expect(starts).toEqual([2, 3, 1]);
  expect(ends).toEqual([2, 3, 1]);
  expect(maxActive).toBe(1);
  expect(
    shellCalls.filter(({ command }) => command.includes("merge --ff-only")),
  ).toHaveLength(3);
  expect(result.issueResults["issue-2"]?.integration.status).toBe("integrated");
});

test("preserves prior integrations, continues after a failed integration, and never fast-forwards a failed issue", async () => {
  const starts: number[] = [];
  const shellCalls: Array<{ command: string; branch?: string }> = [];
  const invoke = async (_name: string, input: Record<string, unknown>) => {
    const task = String(input.task);
    if (task.startsWith("Resolve issue #")) return approved();
    const issue = Number(task.match(/#(\d+)/)?.[1]);
    starts.push(issue);
    return issue === 2
      ? {
          pass: false,
          iterations: 1,
          devResult: null,
          review: { pass: false, findings: ["integration review failed"] },
        }
      : approved();
  };

  let failure: unknown;
  try {
    await developIssues.run(
      { issueDetails: issueDetails([1, 2, 3]), maxIterations: 1 },
      context(invoke, integrationShell(shellCalls)),
    );
  } catch (error) {
    failure = error;
  }

  expect(String(failure)).toContain("issue #2");
  expect(String(failure)).toContain("review");
  expect(String(failure)).toContain("/worktrees/issue-2");
  expect(starts).toEqual([1, 2, 3]);
  expect(
    shellCalls
      .filter(({ command }) => command.includes("merge --ff-only"))
      .map(({ branch }) => branch),
  ).toEqual(["branch-issue-1", "branch-issue-3"]);
  expect(
    shellCalls.filter(({ command }) => command.includes("merge --ff-only")),
  ).toHaveLength(2);
  expect(
    shellCalls.some(
      ({ command, branch }) =>
        command.includes("merge --ff-only") && branch === "branch-issue-2",
    ),
  ).toBe(false);
});

test("does not fast-forward when main moves during integration review", async () => {
  const shellCalls: Array<{ command: string; branch?: string }> = [];
  const baseShell = integrationShell(shellCalls);
  let mainHeadReads = 0;
  const shell = async (
    command: string,
    options?: { env?: Record<string, string> },
  ) => {
    if (
      command.includes('git -C "$PI_MAIN_PATH" rev-parse --verify HEAD') &&
      !command.includes("merge --ff-only")
    ) {
      mainHeadReads += 1;
      return {
        exitCode: 0,
        stdout: mainHeadReads === 1 ? "main-head\n" : "changed-head\n",
        stderr: "",
      };
    }
    return baseShell(command, options);
  };

  let failure: unknown;
  try {
    await developIssues.run(
      { issueDetails: issueDetails([1]), maxIterations: 1 },
      context(async () => approved(), shell),
    );
  } catch (error) {
    failure = error;
  }

  expect(String(failure)).toContain("Main HEAD changed during integration review");
  expect(
    shellCalls.filter(({ command }) => command.includes("merge --ff-only")),
  ).toHaveLength(0);
});
