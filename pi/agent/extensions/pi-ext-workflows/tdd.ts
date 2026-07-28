import { Type } from "typebox";
import {
  registerWorkflowExtension,
  type WorkflowExtension,
} from "../../../../git/personale/pi-workflows/packages/core/dist/src/index.js";
export const tddDev: WorkflowExtension = {
  version: "1.0.0",
  headline: "TDD development",
  description: "Develops something using TDD",
  functions: {
    tddDev: {
      description:
        "Develop something using TDD, input a task and the shell command to run tests",
      input: Type.Object(
        {
          task: Type.String(),
          testCmd: Type.String(),
          maxAttempts: Type.Integer(),
        },
        { additionalProperties: false },
      ),
      output: Type.Object(
        {
          error: Type.String(),
          success: Type.String(),
        },
        { additionalProperties: false },
      ),
      async run(input, { agent, shell, prompt }) {
        const task = input.task as string;
        const testCmd = input.testCmd as string;
        const maxAttempts = input.maxAttempts as number;

        let testRes = await shell(testCmd);
        if (testRes.exitCode !== 0) {
          return { error: `The given test command failed to run` };
        }

        await agent(
          prompt(`Create only the tests for this task: <task>{task}</task>`, {
            task,
          }),
          {
            role: "tests-expert",
          },
        );

        testRes = await shell(testCmd);
        if (testRes.exitCode === 0) {
          return {
            error: `Test agent created tests that are already passing. Either the task is already resolved or no tests were produced`,
          };
        }

        for (let att = 1; att <= maxAttempts && testRes.exitCode !== 0; att++) {
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

        if (testRes.exitCode === 0) {
          return { success: "Tests created and implemented. Check worktree" };
        }

        return {
          error: `The TDD (red->green) loop failed as it reached the ${maxAttempts} attempts limit`,
        };
      },
    },
  },
};

export default function (): void {
  registerWorkflowExtension(tddDev);
}
