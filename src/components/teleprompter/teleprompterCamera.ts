export const CAMERA_OPACITY_MIN = 0.05;
export const CAMERA_OPACITY_MAX = 0.8;
export const CAMERA_OPACITY_DEFAULT = 0.35;

const TELEPROMPTER_CAMERA_WIDTH = 1280;
const TELEPROMPTER_CAMERA_HEIGHT = 720;
const TELEPROMPTER_CAMERA_FRAME_RATE = 30;

export function clampCameraOpacity(value: number): number {
	if (!Number.isFinite(value)) return CAMERA_OPACITY_DEFAULT;
	return Math.max(CAMERA_OPACITY_MIN, Math.min(CAMERA_OPACITY_MAX, value));
}

export function parseStoredCameraOpacity(raw: string | null): number {
	if (raw === null) return CAMERA_OPACITY_DEFAULT;
	const parsed = Number.parseFloat(raw);
	if (!Number.isFinite(parsed)) return CAMERA_OPACITY_DEFAULT;
	return clampCameraOpacity(parsed);
}

export function isNativeTeleprompterPreviewSessionActive(event: {
	active: boolean;
	status: "starting" | "frame" | "stopped";
}): boolean {
	return event.active && event.status !== "stopped";
}

export function shouldAcquireTeleprompterBrowserCamera({
	cameraOn,
	editing,
	nativePreviewActive,
	nativePreviewPreferred,
	recordingActive,
}: {
	cameraOn: boolean;
	editing: boolean;
	nativePreviewActive: boolean;
	nativePreviewPreferred?: boolean;
	recordingActive: boolean;
}): boolean {
	return (
		cameraOn && !editing && !nativePreviewActive && !nativePreviewPreferred && !recordingActive
	);
}

export function getNativeTeleprompterPreviewStopReason(recordingActive: boolean) {
	return recordingActive ? "recording-start" : "renderer-stop";
}

export type TeleprompterNativePreviewSurfaceState = {
	previewIssue: boolean;
	visiblePreviewBlocked: boolean;
	issueReason: "proof" | "visible" | null;
};

export type TeleprompterNativePreviewSurfaceEvent =
	| { type: "proof-readable" }
	| { type: "proof-unreadable" }
	| { type: "visible-stream-loaded" }
	| { type: "visible-stream-failed" }
	| { type: "reset" };

export function reduceTeleprompterNativePreviewSurfaceState(
	state: TeleprompterNativePreviewSurfaceState,
	event: TeleprompterNativePreviewSurfaceEvent,
): TeleprompterNativePreviewSurfaceState {
	switch (event.type) {
		case "reset":
			return { previewIssue: false, visiblePreviewBlocked: false, issueReason: null };
		case "proof-readable":
			return state.issueReason === "proof"
				? { previewIssue: false, visiblePreviewBlocked: false, issueReason: null }
				: state;
		case "proof-unreadable":
			return { previewIssue: true, visiblePreviewBlocked: true, issueReason: "proof" };
		case "visible-stream-failed":
			return { previewIssue: true, visiblePreviewBlocked: true, issueReason: "visible" };
		case "visible-stream-loaded":
			return state.issueReason === "visible"
				? { previewIssue: false, visiblePreviewBlocked: false, issueReason: null }
				: state;
	}
}

export function getTeleprompterNativePreviewUnavailableEvent({
	cameraOn,
	nativePreviewActive,
	nativePreviewStale,
}: {
	cameraOn: boolean;
	nativePreviewActive: boolean;
	nativePreviewStale: boolean;
}): TeleprompterNativePreviewSurfaceEvent {
	if (!cameraOn) {
		return { type: "reset" };
	}
	return nativePreviewActive && nativePreviewStale
		? { type: "proof-unreadable" }
		: { type: "reset" };
}

export function getTeleprompterBrowserCameraCandidates({
	selectedDeviceId,
	browserDeviceIds,
	nativeDeviceIds,
}: {
	selectedDeviceId?: string | null;
	browserDeviceIds: string[];
	nativeDeviceIds: string[];
}): Array<string | undefined> {
	const normalizedSelectedDeviceId =
		typeof selectedDeviceId === "string" && selectedDeviceId.trim()
			? selectedDeviceId.trim()
			: null;

	if (!normalizedSelectedDeviceId) {
		return [undefined];
	}

	if (browserDeviceIds.includes(normalizedSelectedDeviceId)) {
		return [normalizedSelectedDeviceId, undefined];
	}

	if (nativeDeviceIds.includes(normalizedSelectedDeviceId)) {
		return [];
	}

	return [normalizedSelectedDeviceId, undefined];
}

export function createTeleprompterCameraConstraints(
	deviceId?: string | null,
): MediaStreamConstraints {
	const video: MediaTrackConstraints = {
		...(deviceId ? { deviceId: { exact: deviceId } } : {}),
		aspectRatio: { ideal: 16 / 9 },
		width: { ideal: TELEPROMPTER_CAMERA_WIDTH, max: TELEPROMPTER_CAMERA_WIDTH },
		height: { ideal: TELEPROMPTER_CAMERA_HEIGHT, max: TELEPROMPTER_CAMERA_HEIGHT },
		frameRate: {
			ideal: TELEPROMPTER_CAMERA_FRAME_RATE,
			max: TELEPROMPTER_CAMERA_FRAME_RATE,
		},
	};
	return { video, audio: false };
}

export function createTeleprompterCameraConstraintFallbacks(
	deviceId?: string | null,
): MediaStreamConstraints[] {
	const stableFallback = createTeleprompterCameraConstraints();
	return deviceId
		? [createTeleprompterCameraConstraints(deviceId), stableFallback, { video: true }]
		: [stableFallback, { video: true }];
}
