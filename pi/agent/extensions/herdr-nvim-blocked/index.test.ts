import { expect, test } from "bun:test";
import { isOpenNvim } from "./index";

test("only open-nvim.sh bash calls count as blocking", () => {
  expect(isOpenNvim("bash", "~/.pi/agent/bin/open-nvim.sh /tmp/wf.js")).toBe(true);
  expect(isOpenNvim("bash", "nvim /tmp/wf.js")).toBe(false);
  expect(isOpenNvim("read", "open-nvim.sh")).toBe(false);
  expect(isOpenNvim("bash", undefined)).toBe(false);
});
