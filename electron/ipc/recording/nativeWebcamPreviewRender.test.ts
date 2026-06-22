import { describe, expect, it } from "vitest";
import { createNativeWebcamPreviewRendererUpdateGate } from "./nativeWebcamPreviewRender";

describe("createNativeWebcamPreviewRendererUpdateGate", () => {
	it("emits the first frame immediately and throttles renderer-only preview updates", () => {
		let now = 1_000;
		const shouldEmit = createNativeWebcamPreviewRendererUpdateGate({
			minIntervalMs: 33,
			nowMs: () => now,
		});

		expect(shouldEmit(1)).toBe(true);
		now += 16;
		expect(shouldEmit(2)).toBe(false);
		now += 1;
		expect(shouldEmit(3)).toBe(false);
		now += 16;
		expect(shouldEmit(4)).toBe(true);
	});

	it("rejects invalid or non-monotonic frame sequences", () => {
		const shouldEmit = createNativeWebcamPreviewRendererUpdateGate({
			minIntervalMs: 0,
			nowMs: () => 1_000,
		});

		expect(shouldEmit(0)).toBe(false);
		expect(shouldEmit(Number.NaN)).toBe(false);
		expect(shouldEmit(2)).toBe(true);
		expect(shouldEmit(2)).toBe(false);
		expect(shouldEmit(1)).toBe(false);
		expect(shouldEmit(3)).toBe(true);
	});
});
