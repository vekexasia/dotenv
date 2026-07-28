import { expect, test } from "bun:test";
import install from "./index";

test("manual Herdr state is disabled by default", () => {
  const previousHerdr = process.env.HERDR_ENV;
  const previousManual = process.env.HERDR_MANUAL_STATE;
  process.env.HERDR_ENV = "1";
  delete process.env.HERDR_MANUAL_STATE;

  const commands: string[] = [];
  install({
    registerCommand(name: string) {
      commands.push(name);
    },
  } as never);

  expect(commands).toEqual([]);

  if (previousHerdr === undefined) delete process.env.HERDR_ENV;
  else process.env.HERDR_ENV = previousHerdr;
  if (previousManual === undefined) delete process.env.HERDR_MANUAL_STATE;
  else process.env.HERDR_MANUAL_STATE = previousManual;
});
