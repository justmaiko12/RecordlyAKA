import { describe, expect, it } from "vitest";
import {
	getNativeWebcamPreviewStopReason,
	hasNativeWebcamPreviewIssue,
	selectRenderableNativePreviewUrl,
	shouldAcquireBrowserWebcamPreview,
	shouldAcquireNativeWebcamPreview,
	shouldShowRecordingWebcamPreview,
} from "./useWebcamPreviewOverlay";

describe("shouldShowRecordingWebcamPreview", () => {
	it("hides the floating preview when the HUD is compact during recording", () => {
		expect(
			shouldShowRecordingWebcamPreview({
				webcamEnabled: true,
				hudCompact: true,
				showFloatingWebcamPreview: true,
				hudOverlayMousePassthroughSupported: true,
			}),
		).toBe(false);
	});

	it("does not show the separate floating preview even when webcam and passthrough are enabled", () => {
		expect(
			shouldShowRecordingWebcamPreview({
				webcamEnabled: true,
				hudCompact: false,
				showFloatingWebcamPreview: true,
				hudOverlayMousePassthroughSupported: true,
			}),
		).toBe(false);
		expect(
			shouldShowRecordingWebcamPreview({
				webcamEnabled: false,
				hudCompact: false,
				showFloatingWebcamPreview: true,
				hudOverlayMousePassthroughSupported: true,
			}),
		).toBe(false);
	});
});

describe("shouldAcquireBrowserWebcamPreview", () => {
	it("does not acquire a browser camera stream just because webcam is enabled", () => {
		expect(
			shouldAcquireBrowserWebcamPreview({
				webcamEnabled: true,
				showRecordingWebcamPreview: false,
				showWebcamControls: false,
				webcamPopoverOpen: false,
			}),
		).toBe(false);
	});

	it("acquires a browser camera stream for the idle popover preview", () => {
		expect(
			shouldAcquireBrowserWebcamPreview({
				webcamEnabled: true,
				showRecordingWebcamPreview: false,
				showWebcamControls: true,
				webcamPopoverOpen: true,
			}),
		).toBe(true);
	});

	it("does not acquire a browser preview for native-only cameras", () => {
		expect(
			shouldAcquireBrowserWebcamPreview({
				webcamEnabled: true,
				browserPreviewAvailable: false,
				showRecordingWebcamPreview: false,
				showWebcamControls: true,
				webcamPopoverOpen: true,
			}),
		).toBe(false);
	});

	it("does not acquire a browser preview when native proof preview is preferred", () => {
		expect(
			shouldAcquireBrowserWebcamPreview({
				webcamEnabled: true,
				nativePreviewPreferred: true,
				showRecordingWebcamPreview: false,
				showWebcamControls: true,
				webcamPopoverOpen: true,
			}),
		).toBe(false);
	});
});

describe("shouldAcquireNativeWebcamPreview", () => {
	it("acquires a native proof preview for the idle popover when preferred", () => {
		expect(
			shouldAcquireNativeWebcamPreview({
				webcamEnabled: true,
				nativePreviewPreferred: true,
				showRecordingWebcamPreview: false,
				showWebcamControls: true,
				webcamPopoverOpen: true,
			}),
		).toBe(true);
	});

	it("does not acquire native preview when the preview is not visible", () => {
		expect(
			shouldAcquireNativeWebcamPreview({
				webcamEnabled: true,
				nativePreviewPreferred: true,
				showRecordingWebcamPreview: false,
				showWebcamControls: false,
				webcamPopoverOpen: false,
			}),
		).toBe(false);
	});
});

describe("hasNativeWebcamPreviewIssue", () => {
	it("reports native preview start failures as visible preview issues", () => {
		expect(
			hasNativeWebcamPreviewIssue({
				nativePreviewPreferred: true,
				nativePreviewStartIssue: "native-preview-first-frame-timeout",
				nativePreviewImageIssue: false,
			}),
		).toBe(true);
	});

	it("reports failed native preview image delivery as a visible preview issue", () => {
		expect(
			hasNativeWebcamPreviewIssue({
				nativePreviewPreferred: true,
				nativePreviewStartIssue: null,
				nativePreviewImageIssue: true,
			}),
		).toBe(true);
	});

	it("ignores native preview issues when native preview is not the active policy", () => {
		expect(
			hasNativeWebcamPreviewIssue({
				nativePreviewPreferred: false,
				nativePreviewStartIssue: "native-preview-first-frame-timeout",
				nativePreviewImageIssue: true,
			}),
		).toBe(false);
	});
});

describe("getNativeWebcamPreviewStopReason", () => {
	it("uses an explicit recording-start reason for native preview handoff", () => {
		expect(getNativeWebcamPreviewStopReason(true)).toBe("recording-start");
		expect(getNativeWebcamPreviewStopReason(false)).toBe("renderer-stop");
	});
});

describe("selectRenderableNativePreviewUrl", () => {
	it("only renders the assigned native proof image when it has not failed", () => {
		expect(
			selectRenderableNativePreviewUrl({
				assignedUrl: "http://127.0.0.1/native-proof?seq=1",
				failedUrl: null,
			}),
		).toBe("http://127.0.0.1/native-proof?seq=1");
		expect(
			selectRenderableNativePreviewUrl({
				assignedUrl: "http://127.0.0.1/native-proof?seq=1",
				failedUrl: "http://127.0.0.1/native-proof?seq=1",
			}),
		).toBeNull();
		expect(
			selectRenderableNativePreviewUrl({
				assignedUrl: null,
				failedUrl: "http://127.0.0.1/native-proof?seq=1",
			}),
		).toBeNull();
	});
});
