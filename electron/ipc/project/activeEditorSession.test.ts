import { afterEach, describe, expect, it } from "vitest";
import {
	currentProjectPath,
	currentRecordingSession,
	currentVideoPath,
	setCurrentProjectPath,
	setCurrentRecordingSession,
	setCurrentVideoPath,
} from "../state";
import {
	clearActiveEditorSession,
	clearDismissedEditorSession,
	getDismissedEditorSessionForTesting,
	isDismissedEditorSessionVideoPath,
} from "./activeEditorSession";

describe("active editor session state", () => {
	afterEach(() => {
		clearDismissedEditorSession();
	});

	it("clears the active project, video, and recording session together", () => {
		setCurrentProjectPath("/tmp/project.recordly");
		setCurrentVideoPath("/tmp/video.mp4");
		setCurrentRecordingSession({
			videoPath: "/tmp/video.mp4",
			webcamPath: "/tmp/webcam.mp4",
			timeOffsetMs: 120,
		});

		clearActiveEditorSession();

		expect(currentProjectPath).toBeNull();
		expect(currentVideoPath).toBeNull();
		expect(currentRecordingSession).toBeNull();
		expect(getDismissedEditorSessionForTesting()).toMatchObject({
			projectPath: "/tmp/project.recordly",
			videoPath: "/tmp/video.mp4",
		});
		expect(isDismissedEditorSessionVideoPath("/tmp/video.mp4")).toBe(true);
		expect(isDismissedEditorSessionVideoPath("/tmp/other.mp4")).toBe(false);
	});
});
