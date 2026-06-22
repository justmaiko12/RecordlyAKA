import { BrowserWindow } from "electron";

export type RecordingDegradedPayload = {
	reason: string;
	message: string;
	severity?: "info" | "warning" | "error";
	details?: Record<string, unknown>;
};

export type NativeWebcamPreviewPayload = {
	active: boolean;
	status: "starting" | "frame" | "stopped";
	url?: string | null;
	streamUrl?: string | null;
	path?: string | null;
	updatedAt?: number;
	details?: Record<string, unknown>;
};

export function emitRecordingInterrupted(reason: string, message: string) {
	BrowserWindow.getAllWindows().forEach((window) => {
		if (!window.isDestroyed()) {
			window.webContents.send("recording-interrupted", { reason, message });
		}
	});
}

export function emitNativeWebcamPreview(payload: NativeWebcamPreviewPayload) {
	BrowserWindow.getAllWindows().forEach((window) => {
		if (!window.isDestroyed()) {
			window.webContents.send("native-webcam-preview", payload);
		}
	});
}

export function emitRecordingDegraded(payload: RecordingDegradedPayload) {
	BrowserWindow.getAllWindows().forEach((window) => {
		if (!window.isDestroyed()) {
			window.webContents.send("recording-degraded", payload);
		}
	});
}
