import { describe, expect, it } from "vitest";
import {
	resolveNativeWebcamPreviewStartupTimeoutFailure,
	shouldExposeNativeWebcamPreviewProofFrame,
} from "./nativeWebcamPreviewVisibility";

describe("native webcam preview visibility gate", () => {
	it("does not expose proof-preview frames until visible webcam video is proven", () => {
		expect(shouldExposeNativeWebcamPreviewProofFrame({ hasVisibleWebcamFrame: false })).toBe(
			false,
		);
		expect(shouldExposeNativeWebcamPreviewProofFrame({ hasVisibleWebcamFrame: true })).toBe(
			true,
		);
	});

	it("reports blank webcam startup when proof frames arrive but no visible frame arrives", () => {
		expect(
			resolveNativeWebcamPreviewStartupTimeoutFailure({
				acceptedProofCount: 12,
				hasVisibleWebcamFrame: false,
				lastAcceptedProof: { sequence: 12, acceptedFrame: 24 },
				timeoutMs: 8000,
			}),
		).toEqual({
			error: "native-preview-blank-webcam",
			details: {
				timeoutMs: 8000,
				acceptedProofCount: 12,
				hasVisibleWebcamFrame: false,
				lastAcceptedProof: { sequence: 12, acceptedFrame: 24 },
			},
		});
	});

	it("keeps the generic timeout when no proof frame arrives at all", () => {
		expect(
			resolveNativeWebcamPreviewStartupTimeoutFailure({
				acceptedProofCount: 0,
				hasVisibleWebcamFrame: false,
				lastAcceptedProof: null,
				timeoutMs: 8000,
			}).error,
		).toBe("native-preview-first-frame-timeout");
	});
});
