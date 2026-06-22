import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	app: {
		getAppPath: () => process.cwd(),
		getPath: () => process.env.TEMP ?? process.cwd(),
		isPackaged: false,
	},
}));

import { storeBrowserMicrophoneSidecar } from "./microphoneSidecarStore";

describe("storeBrowserMicrophoneSidecar", () => {
	it("repairs the stored fallback microphone sidecar against the final video duration", async () => {
		const writeFile = vi.fn().mockResolvedValue(undefined);
		const rm = vi.fn().mockResolvedValue(undefined);
		const rename = vi.fn().mockResolvedValue(undefined);
		const copyFile = vi.fn().mockResolvedValue(undefined);
		const execFileAsync = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
		const repairCompanionAudioSync = vi.fn().mockResolvedValue(undefined);
		const writeRecordingDiagnosticsSnapshot = vi.fn().mockResolvedValue(undefined);

		const result = await storeBrowserMicrophoneSidecar(
			{
				audioData: new Uint8Array([1, 2, 3]).buffer,
				videoPath: "/tmp/recording-123.mp4",
				options: {
					startDelayMs: 125,
					browserMicrophoneProfile: "voice",
					mediaRecorder: {
						mimeType: "audio/webm;codecs=opus",
						timesliceMs: 1000,
					},
					chunkEvents: [
						{
							index: 0,
							size: 1024,
							elapsedMs: 1000,
							deltaMs: null,
							recordedElapsedMs: 1000,
							recordedDeltaMs: null,
						},
						{
							index: 1,
							size: 1024,
							elapsedMs: 9000,
							deltaMs: 8000,
							recordedElapsedMs: 2000,
							recordedDeltaMs: 1000,
						},
					],
					pauseIntervals: [
						{
							startElapsedMs: 1000,
							endElapsedMs: 9000,
							durationMs: 7000,
						},
					],
				},
			},
			{
				writeFile,
				rm,
				rename,
				copyFile,
				execFileAsync,
				getFfmpegBinaryPath: () => "/usr/local/bin/ffmpeg",
				getBrowserMicSidecarFilters: () => ["volume=1.5"],
				shouldKeepRecordingAudioSidecars: () => false,
				repairCompanionAudioSync,
				writeRecordingDiagnosticsSnapshot,
			},
		);

		expect(result).toEqual({
			success: true,
			path: "/tmp/recording-123.mic.wav",
		});
		expect(execFileAsync).toHaveBeenCalledWith(
			"/usr/local/bin/ffmpeg",
			expect.arrayContaining(["-i", "/tmp/recording-123.mic.source.webm.tmp"]),
			expect.objectContaining({ timeout: 120000 }),
		);
		const ffmpegArgs = execFileAsync.mock.calls[0]?.[1] as string[];
		const filterIndex = ffmpegArgs.indexOf("-af");
		expect(filterIndex).toBeGreaterThanOrEqual(0);
		expect(ffmpegArgs[filterIndex + 1]).toBe(
			"volume=1.5,adelay=delays=125:all=1,aresample=async=1:first_pts=0",
		);
		expect(repairCompanionAudioSync).toHaveBeenCalledWith({
			videoPath: "/tmp/recording-123.mp4",
			audioPath: "/tmp/recording-123.mic.wav",
			trackKind: "mic",
		});
		expect(writeRecordingDiagnosticsSnapshot).toHaveBeenCalledWith(
			"/tmp/recording-123.mp4",
			expect.objectContaining({
				backend: "browser-store",
				phase: "mic-sidecar",
				microphonePath: "/tmp/recording-123.mic.wav",
			}),
		);
		expect(rm).toHaveBeenCalledWith("/tmp/recording-123.mic.source.webm.tmp", {
			force: true,
		});
		expect(writeFile).toHaveBeenCalledWith(
			"/tmp/recording-123.mic.source.webm.tmp",
			Buffer.from(new Uint8Array([1, 2, 3]).buffer),
		);
		const metadataWrite = writeFile.mock.calls.find(
			([filePath]) => filePath === "/tmp/recording-123.mic.wav.json",
		);
		expect(metadataWrite).toBeTruthy();
		const metadata = JSON.parse(String(metadataWrite?.[1]));
		expect(metadata.chunkTiming).toMatchObject({
			status: "pause-accounted",
			eventCount: 2,
			wallClockGapCount: 1,
			recordedGapCount: 0,
		});
		expect(writeRecordingDiagnosticsSnapshot).toHaveBeenCalledWith(
			"/tmp/recording-123.mp4",
			expect.objectContaining({
				details: expect.objectContaining({
					metadata: expect.objectContaining({
						chunkTiming: expect.objectContaining({
							status: "pause-accounted",
							recordedGapCount: 0,
						}),
					}),
				}),
			}),
		);
	});

	it("fails closed and removes browser microphone sidecar files when sync repair rejects", async () => {
		const writeFile = vi.fn().mockResolvedValue(undefined);
		const rm = vi.fn().mockResolvedValue(undefined);
		const rename = vi.fn().mockResolvedValue(undefined);
		const copyFile = vi.fn().mockResolvedValue(undefined);
		const execFileAsync = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
		const repairCompanionAudioSync = vi
			.fn()
			.mockRejectedValue(
				new Error("Companion mic audio/video mismatch is too large to repair safely"),
			);

		const result = await storeBrowserMicrophoneSidecar(
			{
				audioData: new Uint8Array([4, 5, 6]).buffer,
				videoPath: "/tmp/recording-456.mp4",
			},
			{
				writeFile,
				rm,
				rename,
				copyFile,
				execFileAsync,
				getFfmpegBinaryPath: () => "/usr/local/bin/ffmpeg",
				getBrowserMicSidecarFilters: () => [],
				shouldKeepRecordingAudioSidecars: () => true,
				repairCompanionAudioSync,
				writeRecordingDiagnosticsSnapshot: vi.fn().mockResolvedValue(undefined),
			},
		);

		expect(result).toEqual({
			success: false,
			error: "Error: Companion mic audio/video mismatch is too large to repair safely",
		});
		expect(repairCompanionAudioSync).toHaveBeenCalledWith({
			videoPath: "/tmp/recording-456.mp4",
			audioPath: "/tmp/recording-456.mic.wav",
			trackKind: "mic",
		});
		expect(rename).not.toHaveBeenCalled();
		expect(copyFile).not.toHaveBeenCalled();
		expect(rm).toHaveBeenCalledWith("/tmp/recording-456.mic.source.webm.tmp", { force: true });
		expect(rm).toHaveBeenCalledWith("/tmp/recording-456.mic.source.webm", {
			force: true,
		});
		expect(rm).toHaveBeenCalledWith("/tmp/recording-456.mic.wav", {
			force: true,
		});
	});
});
