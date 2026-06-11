const FLOATING_WEBCAM_PREVIEW_WIDTH = 1920;
const FLOATING_WEBCAM_PREVIEW_HEIGHT = 1080;
const FLOATING_WEBCAM_PREVIEW_FRAME_RATE = 30;

export function canShowFloatingWebcamPreview(
	requested: boolean,
	hudOverlayMousePassthroughSupported: boolean | null,
): boolean {
	return requested && hudOverlayMousePassthroughSupported === true;
}

export function canToggleFloatingWebcamPreview(
	hudOverlayMousePassthroughSupported: boolean | null,
): boolean {
	return hudOverlayMousePassthroughSupported !== false;
}

export function createFloatingWebcamPreviewVideoConstraints(
	webcamDeviceId?: string,
): MediaTrackConstraints {
	return {
		...(webcamDeviceId ? { deviceId: { exact: webcamDeviceId } } : {}),
		aspectRatio: { ideal: 16 / 9 },
		resizeMode: "none",
		width: { ideal: FLOATING_WEBCAM_PREVIEW_WIDTH, min: 1280 },
		height: { ideal: FLOATING_WEBCAM_PREVIEW_HEIGHT, min: 720 },
		frameRate: {
			ideal: FLOATING_WEBCAM_PREVIEW_FRAME_RATE,
			max: FLOATING_WEBCAM_PREVIEW_FRAME_RATE,
		},
	} as MediaTrackConstraints;
}
