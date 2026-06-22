import { describe, expect, it } from "vitest";
import {
	CAMERA_OPACITY_DEFAULT,
	CAMERA_OPACITY_MAX,
	CAMERA_OPACITY_MIN,
	clampCameraOpacity,
	createTeleprompterCameraConstraintFallbacks,
	createTeleprompterCameraConstraints,
	getNativeTeleprompterPreviewStopReason,
	getTeleprompterBrowserCameraCandidates,
	getTeleprompterNativePreviewUnavailableEvent,
	isNativeTeleprompterPreviewSessionActive,
	parseStoredCameraOpacity,
	reduceTeleprompterNativePreviewSurfaceState,
	shouldAcquireTeleprompterBrowserCamera,
} from "./teleprompterCamera";

describe("clampCameraOpacity", () => {
	it("clamps into [min, max]", () => {
		expect(clampCameraOpacity(0)).toBe(CAMERA_OPACITY_MIN);
		expect(clampCameraOpacity(1)).toBe(CAMERA_OPACITY_MAX);
		expect(clampCameraOpacity(0.35)).toBe(0.35);
	});
});

describe("createTeleprompterCameraConstraints", () => {
	it("uses a stable 720p camera preview profile", () => {
		expect(createTeleprompterCameraConstraints("camera-1")).toEqual({
			audio: false,
			video: {
				deviceId: { exact: "camera-1" },
				aspectRatio: { ideal: 16 / 9 },
				width: { ideal: 1280, max: 1280 },
				height: { ideal: 720, max: 720 },
				frameRate: { ideal: 30, max: 30 },
			},
		});
	});

	it("falls back from the selected camera to stable default camera constraints", () => {
		expect(createTeleprompterCameraConstraintFallbacks("camera-1")).toEqual([
			createTeleprompterCameraConstraints("camera-1"),
			createTeleprompterCameraConstraints(),
			{ video: true },
		]);
	});
});

describe("getTeleprompterBrowserCameraCandidates", () => {
	it("uses the selected browser camera and then falls back to default", () => {
		expect(
			getTeleprompterBrowserCameraCandidates({
				selectedDeviceId: "browser-cam-1",
				browserDeviceIds: ["browser-cam-1"],
				nativeDeviceIds: [],
			}),
		).toEqual(["browser-cam-1", undefined]);
	});

	it("does not fall back to the default browser camera for native-only selections", () => {
		expect(
			getTeleprompterBrowserCameraCandidates({
				selectedDeviceId: "D0B50AEF-3573-491E-9CA6-08E600000001",
				browserDeviceIds: ["macbook-browser-camera"],
				nativeDeviceIds: ["D0B50AEF-3573-491E-9CA6-08E600000001"],
			}),
		).toEqual([]);
	});

	it("uses the default browser camera when no device is selected", () => {
		expect(
			getTeleprompterBrowserCameraCandidates({
				selectedDeviceId: null,
				browserDeviceIds: ["macbook-browser-camera"],
				nativeDeviceIds: ["D0B50AEF-3573-491E-9CA6-08E600000001"],
			}),
		).toEqual([undefined]);
	});
});

describe("parseStoredCameraOpacity", () => {
	it("parses valid stored values and falls back otherwise", () => {
		expect(parseStoredCameraOpacity("0.5")).toBe(0.5);
		expect(parseStoredCameraOpacity("2")).toBe(CAMERA_OPACITY_MAX);
		expect(parseStoredCameraOpacity("junk")).toBe(CAMERA_OPACITY_DEFAULT);
		expect(parseStoredCameraOpacity(null)).toBe(CAMERA_OPACITY_DEFAULT);
	});
});

describe("isNativeTeleprompterPreviewSessionActive", () => {
	it("keeps native ownership active for starting and frame events only", () => {
		expect(isNativeTeleprompterPreviewSessionActive({ active: true, status: "starting" })).toBe(
			true,
		);
		expect(isNativeTeleprompterPreviewSessionActive({ active: true, status: "frame" })).toBe(
			true,
		);
		expect(isNativeTeleprompterPreviewSessionActive({ active: true, status: "stopped" })).toBe(
			false,
		);
		expect(isNativeTeleprompterPreviewSessionActive({ active: false, status: "frame" })).toBe(
			false,
		);
	});
});

describe("shouldAcquireTeleprompterBrowserCamera", () => {
	it("allows browser preview only for idle reading mode", () => {
		expect(
			shouldAcquireTeleprompterBrowserCamera({
				cameraOn: true,
				editing: false,
				nativePreviewActive: false,
				nativePreviewPreferred: false,
				recordingActive: false,
			}),
		).toBe(true);
	});

	it("blocks browser fallback while native recording is active", () => {
		expect(
			shouldAcquireTeleprompterBrowserCamera({
				cameraOn: true,
				editing: false,
				nativePreviewActive: false,
				nativePreviewPreferred: false,
				recordingActive: true,
			}),
		).toBe(false);
	});

	it("blocks browser preview when native accepted-frame preview owns the camera", () => {
		expect(
			shouldAcquireTeleprompterBrowserCamera({
				cameraOn: true,
				editing: false,
				nativePreviewActive: true,
				nativePreviewPreferred: false,
				recordingActive: false,
			}),
		).toBe(false);
	});

	it("blocks browser preview when native proof preview is preferred", () => {
		expect(
			shouldAcquireTeleprompterBrowserCamera({
				cameraOn: true,
				editing: false,
				nativePreviewActive: false,
				nativePreviewPreferred: true,
				recordingActive: false,
			}),
		).toBe(false);
	});
});

describe("getNativeTeleprompterPreviewStopReason", () => {
	it("preserves recording handoff evidence when cleanup races recording start", () => {
		expect(getNativeTeleprompterPreviewStopReason(true)).toBe("recording-start");
		expect(getNativeTeleprompterPreviewStopReason(false)).toBe("renderer-stop");
	});
});

describe("reduceTeleprompterNativePreviewSurfaceState", () => {
	it("blocks the visible stream immediately when proof becomes unreadable", () => {
		expect(
			reduceTeleprompterNativePreviewSurfaceState(
				{
					previewIssue: false,
					visiblePreviewBlocked: false,
					issueReason: null,
				},
				{ type: "proof-unreadable" },
			),
		).toEqual({
			previewIssue: true,
			visiblePreviewBlocked: true,
			issueReason: "proof",
		});
	});

	it("does not let a visible stream load clear a proof failure", () => {
		expect(
			reduceTeleprompterNativePreviewSurfaceState(
				{
					previewIssue: true,
					visiblePreviewBlocked: true,
					issueReason: "proof",
				},
				{ type: "visible-stream-loaded" },
			),
		).toEqual({
			previewIssue: true,
			visiblePreviewBlocked: true,
			issueReason: "proof",
		});
	});

	it("unblocks a proof failure only when proof becomes readable again", () => {
		expect(
			reduceTeleprompterNativePreviewSurfaceState(
				{
					previewIssue: true,
					visiblePreviewBlocked: true,
					issueReason: "proof",
				},
				{ type: "proof-readable" },
			),
		).toEqual({
			previewIssue: false,
			visiblePreviewBlocked: false,
			issueReason: null,
		});
	});

	it("does not let a hidden proof load clear a visible preview failure", () => {
		expect(
			reduceTeleprompterNativePreviewSurfaceState(
				{
					previewIssue: true,
					visiblePreviewBlocked: true,
					issueReason: "visible",
				},
				{ type: "proof-readable" },
			),
		).toEqual({
			previewIssue: true,
			visiblePreviewBlocked: true,
			issueReason: "visible",
		});
	});

	it("unblocks a visible preview failure only after the visible preview loads", () => {
		expect(
			reduceTeleprompterNativePreviewSurfaceState(
				{
					previewIssue: true,
					visiblePreviewBlocked: true,
					issueReason: "visible",
				},
				{ type: "visible-stream-loaded" },
			),
		).toEqual({
			previewIssue: false,
			visiblePreviewBlocked: false,
			issueReason: null,
		});
	});
});

describe("getTeleprompterNativePreviewUnavailableEvent", () => {
	it("treats a stale native preview as proof unreadable instead of healthy", () => {
		expect(
			getTeleprompterNativePreviewUnavailableEvent({
				cameraOn: true,
				nativePreviewActive: true,
				nativePreviewStale: true,
			}),
		).toEqual({ type: "proof-unreadable" });
	});

	it("resets unavailable state while waiting for initial proof or when camera is off", () => {
		expect(
			getTeleprompterNativePreviewUnavailableEvent({
				cameraOn: true,
				nativePreviewActive: true,
				nativePreviewStale: false,
			}),
		).toEqual({ type: "reset" });
		expect(
			getTeleprompterNativePreviewUnavailableEvent({
				cameraOn: false,
				nativePreviewActive: true,
				nativePreviewStale: true,
			}),
		).toEqual({ type: "reset" });
	});
});
