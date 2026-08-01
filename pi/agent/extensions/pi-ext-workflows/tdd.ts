import { Type } from "typebox";
import {
  defineWorkflowFunction,
  registerWorkflowExtension,
  type WorkflowExtension,
} from "pi-extensible-workflows";

export const tddDev = defineWorkflowFunction({
  description:
    "Develop something using TDD, input a task and the shell command to run tests",
  async run({ task, testCmd, maxAttempts }, { agent, shell, prompt }) {
    let testRes = await shell(testCmd);
    if (testRes.exitCode !== 0)
      return { error: "The given test command failed to run" };

    await agent(
      prompt("Create only the tests for this task: <task>{task}</task>", {
        task,
      }),
      { role: "tests-expert" },
    );

    testRes = await shell(testCmd);
    if (testRes.exitCode === 0)
      return {
        error:
          "Test agent created tests that are already passing. Either the task is already resolved or no tests were produced",
      };

    for (
      let attempt = 1;
      attempt <= maxAttempts && testRes.exitCode !== 0;
      attempt++
    ) {
      await agent(
        prompt(
          `You're the developer of a TDD workflow. Tests were created and are still not passing.
The test command is \`{testCmd}\` and the task is <task>{task}</task>`,
          { testCmd, task },
        ),
        { role: "developer", label: "implementor" },
      );
      testRes = await shell(testCmd);
    }

    return testRes.exitCode === 0
      ? { success: "Tests created and implemented. Check worktree" }
      : {
          error: `The TDD (red->green) loop failed as it reached the ${maxAttempts} attempts limit`,
        };
  },
  input: Type.Object(
    {
      task: Type.String(),
      testCmd: Type.String(),
      maxAttempts: Type.Integer(),
    },
    { additionalProperties: false },
  ),
  output: Type.Union([
    Type.Object({ error: Type.String() }, { additionalProperties: false }),
    Type.Object({ success: Type.String() }, { additionalProperties: false }),
  ]),
});

const extension: WorkflowExtension = {
  version: "1.0.0",
  headline: "TDD development",
  functions: { tddDev },
};

export default function (): void {
  registerWorkflowExtension(extension);
}
