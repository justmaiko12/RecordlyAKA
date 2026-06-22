import { BrowserWindow } from "electron";
import { registerAssetHandlers } from "./register/assets";
import { registerCaptionHandlers } from "./register/captions";
import { registerDeviceHandlers } from "./register/devices";
import { registerExportHandlers } from "./register/export";
import { registerNativeWebcamPreviewHandlers } from "./register/nativeWebcamPreview";
import { registerPermissionHandlers } from "./register/permissions";
import { registerProjectHandlers } from "./register/project";
import { registerRecordingHandlers } from "./register/recording";
import { registerSettingsHandlers } from "./register/settings";
import { registerSourceHandlers } from "./register/sources";
import {
	nativeCaptureProcess,
	selectedSource,
	setNativeCaptureMicrophonePath,
	setNativeCapturePaused,
	setNativeCaptureProcess,
	setNativeCaptureStopRequested,
	setNativeCaptureSystemAudioPath,
	setNativeCaptureTargetPath,
	setNativeCaptureWebcamPath,
	setNativeScreenRecordingActive,
	setWindowsCapturePaused,
	setWindowsCaptureProcess,
	setWindowsCaptureStopRequested,
	setWindowsCaptureTargetPath,
	setWindowsMicAudioPath,
	setWindowsNativeCaptureActive,
	setWindowsOrphanedMicAudioPath,
	setWindowsPendingVideoPath,
	setWindowsSystemAudioPath,
	windowsCaptureProcess,
} from "./state";

export { cleanupAllExportStreams } from "./export/exportStream";
export { cleanupNativeVideoExportSessions } from "./export/native-video";

/** Returns the currently selected source ID for setDisplayMediaRequestHandler */
export function getSelectedSourceId(): string | null {
	return (selectedSource?.id as string | null) ?? null;
}

export function killWindowsCaptureProcess() {
	if (windowsCaptureProcess) {
		try {
			windowsCaptureProcess.kill();
		} catch {
			/* ignore */
		}
		setWindowsCaptureProcess(null);
		setWindowsCaptureTargetPath(null);
		setWindowsNativeCaptureActive(false);
		setNativeScreenRecordingActive(false);
		setWindowsCaptureStopRequested(false);
		setWindowsCapturePaused(false);
		setWindowsSystemAudioPath(null);
		setWindowsMicAudioPath(null);
		setWindowsOrphanedMicAudioPath(null);
		setWindowsPendingVideoPath(null);
	}
}

export function killNativeCaptureProcess() {
	if (nativeCaptureProcess) {
		try {
			nativeCaptureProcess.kill();
		} catch {
			/* ignore */
		}
		setNativeCaptureProcess(null);
		setNativeCaptureTargetPath(null);
		setNativeCaptureSystemAudioPath(null);
		setNativeCaptureMicrophonePath(null);
		setNativeCaptureWebcamPath(null);
		setNativeScreenRecordingActive(false);
		setNativeCaptureStopRequested(false);
		setNativeCapturePaused(false);
	}
}

export function registerIpcHandlers(
	createEditorWindow: () => void,
	createSourceSelectorWindow: () => BrowserWindow,
	_getMainWindow: () => BrowserWindow | null,
	getSourceSelectorWindow: () => BrowserWindow | null,
	onRecordingStateChange?: (recording: boolean, sourceName: string) => void,
) {
	registerSourceHandlers({
		createEditorWindow,
		createSourceSelectorWindow,
		getSourceSelectorWindow,
	});
	registerRecordingHandlers(onRecordingStateChange);
	registerNativeWebcamPreviewHandlers();
	registerPermissionHandlers();
	registerAssetHandlers();
	registerDeviceHandlers();
	registerExportHandlers();
	registerCaptionHandlers();
	registerProjectHandlers();
	registerSettingsHandlers();
}
