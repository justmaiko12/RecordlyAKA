import path from "node:path";
import {
	currentProjectPath,
	currentRecordingSession,
	currentVideoPath,
	setCurrentProjectPath,
	setCurrentRecordingSession,
	setCurrentVideoPath,
} from "../state";

type DismissedEditorSession = {
	projectPath: string | null;
	videoPath: string | null;
	dismissedAtMs: number;
};

let dismissedEditorSession: DismissedEditorSession | null = null;

function normalizeComparablePath(filePath: string | null | undefined) {
	return filePath ? path.resolve(filePath) : null;
}

export function clearActiveEditorSession() {
	dismissedEditorSession = {
		projectPath: normalizeComparablePath(currentProjectPath),
		videoPath: normalizeComparablePath(currentRecordingSession?.videoPath ?? currentVideoPath),
		dismissedAtMs: Date.now(),
	};
	setCurrentProjectPath(null);
	setCurrentVideoPath(null);
	setCurrentRecordingSession(null);
}

export function clearDismissedEditorSession() {
	dismissedEditorSession = null;
}

export function isDismissedEditorSessionVideoPath(filePath: string | null | undefined) {
	const dismissedVideoPath = dismissedEditorSession?.videoPath;
	const candidatePath = normalizeComparablePath(filePath);
	return Boolean(dismissedVideoPath && candidatePath && dismissedVideoPath === candidatePath);
}

export function getDismissedEditorSessionForTesting() {
	return dismissedEditorSession;
}
