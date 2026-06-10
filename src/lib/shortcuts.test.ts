import { describe, expect, it } from "vitest";
import { DEFAULT_SHORTCUTS, findConflict, SHORTCUT_ACTIONS } from "./shortcuts";

describe("DEFAULT_SHORTCUTS", () => {
	it("splitClip default key is b", () => {
		expect(DEFAULT_SHORTCUTS.splitClip.key).toBe("b");
	});

	it("no conflicts in the default set", () => {
		for (const action of SHORTCUT_ACTIONS) {
			const conflict = findConflict(DEFAULT_SHORTCUTS[action], action, DEFAULT_SHORTCUTS);
			expect(conflict).toBeNull();
		}
	});
});
