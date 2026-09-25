import { expect, test } from "bun:test";
import { isGitDiffCommand } from "../tool-renderer/text.js";

for (const command of ["git diff", "git --no-pager diff", "git -C repo diff", "env GIT_PAGER=cat git diff", "a && git diff HEAD"]) {
	test(`isGitDiffCommand ${JSON.stringify(command)}`, () => {
		expect(isGitDiffCommand(command)).toBe(true);
	});
}

test("isGitDiffCommand does not backtrack on long option lists", () => {
	// Hung the pi main thread with the old nested `(...)*` option group.
	const command = `git -c a=b ${Array.from({ length: 80 }, (_, i) => `-o v${i}`).join(" ")}`;
	const start = performance.now();
	expect(isGitDiffCommand(command)).toBe(false);
	expect(performance.now() - start).toBeLessThan(50);
});
