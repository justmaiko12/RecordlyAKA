import { describe, expect, it } from "vitest";
import { getSourceAudioPreviewSyncRatio } from "./useAudioPreviewSync";

describe("getSourceAudioPreviewSyncRatio", () => {
	it("slows slightly short source audio so the preview stays synced through the end", () => {
		expect(getSourceAudioPreviewSyncRatio(1038.661667, 1038.112)).toBeCloseTo(
			0.999471,
			6,
		);
		expect(getSourceAudioPreviewSyncRatio(563.546667, 561.450667)).toBeCloseTo(
			0.996281,
			6,
		);
	});

	it("ignores tiny duration differences and longer audio streams", () => {
		expect(getSourceAudioPreviewSyncRatio(120, 119.99)).toBe(1);
		expect(getSourceAudioPreviewSyncRatio(120, 120.5)).toBe(1);
	});

	it("does not stretch large mismatches that are unlikely to be recorder clock drift", () => {
		expect(getSourceAudioPreviewSyncRatio(600, 480)).toBe(1);
	});
});
