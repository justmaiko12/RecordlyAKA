import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	deriveNativeWebcamPreviewFramePaths,
	NATIVE_WEBCAM_PREVIEW_RING_SIZE,
	resolveNativeWebcamPreviewFramePath,
} from "./nativeWebcamPreviewPaths";

describe("deriveNativeWebcamPreviewFramePaths", () => {
	it("derives a stable preview frame ring next to the base preview path", () => {
		const basePath = "/Users/me/Application Support/Recordly/recording-webcam-preview.jpg";

		expect(deriveNativeWebcamPreviewFramePaths(basePath)).toEqual(
			Array.from({ length: NATIVE_WEBCAM_PREVIEW_RING_SIZE }, (_, index) =>
				path.resolve(
					"/Users/me/Application Support/Recordly",
					`recording-webcam-preview-${index}.jpg`,
				),
			),
		);
	});
});

describe("resolveNativeWebcamPreviewFramePath", () => {
	it("accepts only paths from the derived preview frame ring", () => {
		const allowedPaths = new Set(
			deriveNativeWebcamPreviewFramePaths("/tmp/recording-webcam-preview.jpg"),
		);

		expect(
			resolveNativeWebcamPreviewFramePath(
				"/tmp/recording-webcam-preview-3.jpg",
				allowedPaths,
			),
		).toBe(path.resolve("/tmp/recording-webcam-preview-3.jpg"));
		expect(
			resolveNativeWebcamPreviewFramePath("/tmp/recording-webcam-preview.jpg", allowedPaths),
		).toBeNull();
		expect(resolveNativeWebcamPreviewFramePath("/tmp/other.jpg", allowedPaths)).toBeNull();
		expect(resolveNativeWebcamPreviewFramePath(null, allowedPaths)).toBeNull();
	});
});
