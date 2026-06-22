import { describe, expect, it } from "vitest";
import { shouldShowCursorAtMs } from "./cursorVisibility";

describe("shouldShowCursorAtMs", () => {
	it("keeps the cursor hidden when the global cursor toggle is off", () => {
		expect(
			shouldShowCursorAtMs({
				showCursor: false,
				hideCursorInFillFrame: true,
				fillFrameRegions: [{ id: "fill", startMs: 1_000, endMs: 2_000 }],
				timeMs: 500,
			}),
		).toBe(false);
	});

	it("shows the cursor everywhere when fullscreen suppression is disabled", () => {
		expect(
			shouldShowCursorAtMs({
				showCursor: true,
				hideCursorInFillFrame: false,
				fillFrameRegions: [{ id: "fill", startMs: 1_000, endMs: 2_000 }],
				timeMs: 1_500,
			}),
		).toBe(true);
	});

	it("shows the cursor in framed sections and hides it in fill-frame fullscreen sections", () => {
		const fillFrameRegions = [{ id: "fill", startMs: 1_000, endMs: 2_000 }];

		expect(
			shouldShowCursorAtMs({
				showCursor: true,
				hideCursorInFillFrame: true,
				fillFrameRegions,
				timeMs: 999,
			}),
		).toBe(true);
		expect(
			shouldShowCursorAtMs({
				showCursor: true,
				hideCursorInFillFrame: true,
				fillFrameRegions,
				timeMs: 1_000,
			}),
		).toBe(false);
		expect(
			shouldShowCursorAtMs({
				showCursor: true,
				hideCursorInFillFrame: true,
				fillFrameRegions,
				timeMs: 2_000,
			}),
		).toBe(true);
	});

	it("hides the cursor for whole-video fill-frame projects", () => {
		expect(
			shouldShowCursorAtMs({
				showCursor: true,
				hideCursorInFillFrame: true,
				fillFrameDefault: true,
				timeMs: 500,
			}),
		).toBe(false);
	});
});
