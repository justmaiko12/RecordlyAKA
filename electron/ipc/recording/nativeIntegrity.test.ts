import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("native recording integrity guards", () => {
	let getFileSizeIfPresentMock: ReturnType<typeof vi.fn>;
	let probeVideoStreamDurationMock: ReturnType<typeof vi.fn>;
	let validateRecordedVideoMock: ReturnType<typeof vi.fn>;
	let appendRecordingEventLogEntryMock: ReturnType<typeof vi.fn>;

	const tempRoot = "/tmp/recordly-native-integrity";
	const screenPath = path.join(tempRoot, "recording-1781657811579.mp4");
	const webcamPath = path.join(tempRoot, "recording-1781657811579-webcam.mp4");

	beforeEach(async () => {
		await fs.rm(tempRoot, { recursive: true, force: true });
		await fs.mkdir(tempRoot, { recursive: true });

		getFileSizeIfPresentMock = vi.fn(async () => 1024 * 1024);
		probeVideoStreamDurationMock = vi.fn(async () => ({
			durationSeconds: 600,
			frameCount: 18_000,
			frameRate: 30,
		}));
		validateRecordedVideoMock = vi.fn();
		appendRecordingEventLogEntryMock = vi.fn(async () => ({
			logPath: path.join(tempRoot, "recording-1781657811579.recordly-events.jsonl"),
			entry: {},
		}));

		vi.resetModules();
		vi.doMock("./diagnostics", () => ({
			getFileSizeIfPresent: getFileSizeIfPresentMock,
			probeVideoStreamDuration: probeVideoStreamDurationMock,
			validateRecordedVideo: validateRecordedVideoMock,
		}));
		vi.doMock("./recordingEventLog", () => ({
			appendRecordingEventLogEntry: appendRecordingEventLogEntryMock,
		}));
	});

	afterEach(() => {
		vi.resetModules();
		vi.doUnmock("./diagnostics");
		vi.doUnmock("./recordingEventLog");
	});

	it("rejects a native webcam sidecar when its duration does not match the screen recording", async () => {
		validateRecordedVideoMock.mockImplementation(async (filePath: string) => {
			if (filePath === screenPath) {
				return { fileSizeBytes: 798_000_000, durationSeconds: 745 };
			}
			if (filePath === webcamPath) {
				return { fileSizeBytes: 388_000_000, durationSeconds: 1224.97 };
			}
			throw new Error(`unexpected path ${filePath}`);
		});

		const { resolveValidatedNativeWebcamPath } = await import("./nativeIntegrity");

		await expect(
			resolveValidatedNativeWebcamPath({ screenPath, webcamPath }),
		).resolves.toBeNull();

		expect(appendRecordingEventLogEntryMock).toHaveBeenCalledWith(
			expect.objectContaining({
				recordingsDir: tempRoot,
				sessionId: "1781657811579",
				event: "native-webcam-sidecar-rejected",
				details: expect.objectContaining({
					reason: "duration-mismatch",
					screenDurationSeconds: 745,
					webcamDurationSeconds: 1224.97,
					driftSeconds: expect.closeTo(479.97, 2),
					allowedDriftSeconds: 7.45,
				}),
			}),
		);
	});

	it("accepts a native webcam sidecar when duration drift is within tolerance", async () => {
		validateRecordedVideoMock.mockImplementation(async (filePath: string) => {
			if (filePath === screenPath) {
				return { fileSizeBytes: 798_000_000, durationSeconds: 600 };
			}
			if (filePath === webcamPath) {
				return { fileSizeBytes: 388_000_000, durationSeconds: 604.5 };
			}
			throw new Error(`unexpected path ${filePath}`);
		});

		const { resolveValidatedNativeWebcamPath } = await import("./nativeIntegrity");

		await expect(resolveValidatedNativeWebcamPath({ screenPath, webcamPath })).resolves.toBe(
			webcamPath,
		);

		expect(appendRecordingEventLogEntryMock).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "native-webcam-sidecar-accepted",
				details: expect.objectContaining({
					screenDurationSeconds: 600,
					webcamDurationSeconds: 604.5,
					driftSeconds: 4.5,
					allowedDriftSeconds: 6,
					webcamEffectiveFps: expect.closeTo(29.78, 2),
					webcamFrameCount: 18_000,
				}),
			}),
		);
	});

	it("rejects a native webcam sidecar when helper output reported webcam failure", async () => {
		const { resolveValidatedNativeWebcamPath } = await import("./nativeIntegrity");

		await expect(
			resolveValidatedNativeWebcamPath({
				screenPath,
				webcamPath,
				processOutput:
					"Recording started\nWEBCAM_CAPTURE_DISABLED reason=main-webcam-visual-stall stalledFor=8.02 meanDiff=0.04\nRecording stopped",
			}),
		).resolves.toBeNull();

		expect(validateRecordedVideoMock).not.toHaveBeenCalled();
		expect(probeVideoStreamDurationMock).not.toHaveBeenCalled();
		expect(appendRecordingEventLogEntryMock).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "native-webcam-sidecar-rejected",
				details: expect.objectContaining({
					reason: "native-webcam-failed-closed",
					failureMarker: "WEBCAM_CAPTURE_DISABLED",
					failureLine:
						"WEBCAM_CAPTURE_DISABLED reason=main-webcam-visual-stall stalledFor=8.02 meanDiff=0.04",
				}),
			}),
		);
	});

	it("rejects a native webcam sidecar when the event log already contains a native failure", async () => {
		await fs.writeFile(
			path.join(tempRoot, "recording-1781657811579.recordly-events.jsonl"),
			`${JSON.stringify({
				event: "native-helper-exited-unexpectedly",
				details: {
					reason: "webcam-pipeline-stalled",
				},
			})}\n`,
			"utf8",
		);
		const { resolveValidatedNativeWebcamPath } = await import("./nativeIntegrity");

		await expect(
			resolveValidatedNativeWebcamPath({ screenPath, webcamPath }),
		).resolves.toBeNull();

		expect(validateRecordedVideoMock).not.toHaveBeenCalled();
		expect(probeVideoStreamDurationMock).not.toHaveBeenCalled();
		expect(appendRecordingEventLogEntryMock).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "native-webcam-sidecar-rejected",
				details: expect.objectContaining({
					reason: "persistent-native-failure-event",
					persistentEvent: "native-helper-exited-unexpectedly",
					persistentDetails: {
						reason: "webcam-pipeline-stalled",
					},
				}),
			}),
		);
	});

	it("rejects a native webcam sidecar when the selected webcam was not found", async () => {
		const { resolveValidatedNativeWebcamPath } = await import("./nativeIntegrity");

		await expect(
			resolveValidatedNativeWebcamPath({
				screenPath,
				webcamPath,
				processOutput:
					'Recording started\nWEBCAM_DEVICE_NOT_FOUND requestedLabel="Definitely Missing Camera" requestedDeviceId="" available="MacBook Air Camera [6C707041-05AC-0011-0004-000000000001]"\nError starting capture: Unable to find selected webcam',
			}),
		).resolves.toBeNull();

		expect(validateRecordedVideoMock).not.toHaveBeenCalled();
		expect(probeVideoStreamDurationMock).not.toHaveBeenCalled();
		expect(appendRecordingEventLogEntryMock).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "native-webcam-sidecar-rejected",
				details: expect.objectContaining({
					reason: "native-webcam-failed-closed",
					failureMarker: "WEBCAM_DEVICE_NOT_FOUND",
					failureLine:
						'WEBCAM_DEVICE_NOT_FOUND requestedLabel="Definitely Missing Camera" requestedDeviceId="" available="MacBook Air Camera [6C707041-05AC-0011-0004-000000000001]"',
				}),
			}),
		);
	});

	it("rejects a native webcam sidecar when writer finalization did not complete", async () => {
		const { resolveValidatedNativeWebcamPath } = await import("./nativeIntegrity");

		await expect(
			resolveValidatedNativeWebcamPath({
				screenPath,
				webcamPath,
				processOutput:
					'WEBCAM_RECORDING_FINALIZED path="/tmp/recording-webcam.mp4" writerStatus=failed frames=120 duration=4 lastPts=3.96 errorDescription="disk full"',
			}),
		).resolves.toBeNull();

		expect(validateRecordedVideoMock).not.toHaveBeenCalled();
		expect(probeVideoStreamDurationMock).not.toHaveBeenCalled();
		expect(appendRecordingEventLogEntryMock).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "native-webcam-sidecar-rejected",
				details: expect.objectContaining({
					reason: "writer-finalization-failed",
					writerStatus: "failed",
					writerFrames: 120,
					writerDurationSeconds: 4,
					writerLine:
						'WEBCAM_RECORDING_FINALIZED path="/tmp/recording-webcam.mp4" writerStatus=failed frames=120 duration=4 lastPts=3.96 errorDescription="disk full"',
				}),
			}),
		);
	});

	it("rejects a native webcam sidecar when the saved file frame count trails the writer summary", async () => {
		validateRecordedVideoMock.mockImplementation(async (filePath: string) => {
			if (filePath === screenPath) {
				return { fileSizeBytes: 798_000_000, durationSeconds: 600 };
			}
			if (filePath === webcamPath) {
				return { fileSizeBytes: 388_000_000, durationSeconds: 600 };
			}
			throw new Error(`unexpected path ${filePath}`);
		});
		probeVideoStreamDurationMock.mockResolvedValue({
			durationSeconds: 600,
			frameCount: 15_000,
			frameRate: 30,
		});
		const { resolveValidatedNativeWebcamPath } = await import("./nativeIntegrity");

		await expect(
			resolveValidatedNativeWebcamPath({
				screenPath,
				webcamPath,
				processOutput:
					'WEBCAM_RECORDING_FINALIZED path="/tmp/recording-webcam.mp4" writerStatus=completed frames=18000 duration=600 lastPts=599.966',
			}),
		).resolves.toBeNull();

		expect(appendRecordingEventLogEntryMock).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "native-webcam-sidecar-rejected",
				details: expect.objectContaining({
					reason: "saved-frame-count-below-writer-summary",
					writerStatus: "completed",
					writerFrameCount: 18_000,
					probedFrameCount: 15_000,
					missingFrameCount: 3_000,
					allowedFrameCountDrift: 900,
				}),
			}),
		);
	});

	it("rejects a native webcam sidecar when frame cadence is too low for its duration", async () => {
		validateRecordedVideoMock.mockImplementation(async (filePath: string) => {
			if (filePath === screenPath) {
				return { fileSizeBytes: 798_000_000, durationSeconds: 600 };
			}
			if (filePath === webcamPath) {
				return { fileSizeBytes: 388_000_000, durationSeconds: 600 };
			}
			throw new Error(`unexpected path ${filePath}`);
		});
		probeVideoStreamDurationMock.mockResolvedValue({
			durationSeconds: 600,
			frameCount: 900,
			frameRate: 30,
		});

		const { resolveValidatedNativeWebcamPath } = await import("./nativeIntegrity");

		await expect(
			resolveValidatedNativeWebcamPath({ screenPath, webcamPath }),
		).resolves.toBeNull();

		expect(appendRecordingEventLogEntryMock).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "native-webcam-sidecar-rejected",
				details: expect.objectContaining({
					reason: "low-frame-cadence",
					webcamDurationSeconds: 600,
					webcamEffectiveFps: 1.5,
					minAcceptableFps: 10,
					webcamFrameCount: 900,
					webcamFrameRate: 30,
				}),
			}),
		);
	});

	it("rejects a native screen recording when writer finalization failed", async () => {
		const { validateNativeScreenRecordingIntegrity } = await import("./nativeIntegrity");

		await expect(
			validateNativeScreenRecordingIntegrity({
				screenPath,
				processOutput:
					'VIDEO_RECORDING_FINALIZED path="/tmp/recording.mp4" writerStatus=failed frames=120 realFrames=119 holdFrames=1 duration=4 lastPts=3.96 errorDescription="disk full"',
			}),
		).rejects.toThrow("writer-finalization-failed");

		expect(validateRecordedVideoMock).not.toHaveBeenCalled();
		expect(probeVideoStreamDurationMock).not.toHaveBeenCalled();
		expect(appendRecordingEventLogEntryMock).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "native-screen-recording-rejected",
				details: expect.objectContaining({
					reason: "writer-finalization-failed",
					writerStatus: "failed",
					writerFrames: 120,
					writerRealFrames: 119,
					writerHoldFrames: 1,
					writerDurationSeconds: 4,
				}),
			}),
		);
	});

	it("rejects a native screen recording when a clean stop has no writer summary", async () => {
		const { validateNativeScreenRecordingIntegrity } = await import("./nativeIntegrity");

		await expect(
			validateNativeScreenRecordingIntegrity({
				screenPath,
				processOutput: `Recording stopped. Output path: ${screenPath}`,
			}),
		).rejects.toThrow("writer-finalization-missing-after-stop");

		expect(validateRecordedVideoMock).not.toHaveBeenCalled();
		expect(probeVideoStreamDurationMock).not.toHaveBeenCalled();
		expect(appendRecordingEventLogEntryMock).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "native-screen-recording-rejected",
				details: expect.objectContaining({
					reason: "writer-finalization-missing-after-stop",
				}),
			}),
		);
	});

	it("rejects a native screen recording when the event log already contains a native failure", async () => {
		await fs.writeFile(
			path.join(tempRoot, "recording-1781657811579.recordly-events.jsonl"),
			`${JSON.stringify({
				event: "native-recording-degraded",
				details: {
					reason: "webcam-sample-append-failed",
				},
			})}\n`,
			"utf8",
		);
		const { validateNativeScreenRecordingIntegrity } = await import("./nativeIntegrity");

		await expect(validateNativeScreenRecordingIntegrity({ screenPath })).rejects.toThrow(
			"persistent-native-failure-event",
		);

		expect(validateRecordedVideoMock).not.toHaveBeenCalled();
		expect(probeVideoStreamDurationMock).not.toHaveBeenCalled();
		expect(appendRecordingEventLogEntryMock).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "native-screen-recording-rejected",
				details: expect.objectContaining({
					reason: "persistent-native-failure-event",
					persistentEvent: "native-recording-degraded",
					persistentDetails: {
						reason: "webcam-sample-append-failed",
					},
				}),
			}),
		);
	});

	it("rejects a native screen recording when the event log contains an audio pipeline stall", async () => {
		await fs.writeFile(
			path.join(tempRoot, "recording-1781657811579.recordly-events.jsonl"),
			`${JSON.stringify({
				event: "native-audio-pipeline-stalled",
				details: {
					reason: "microphone-audio-lagging-video",
					stalledFor: 5.3,
				},
			})}\n`,
			"utf8",
		);
		const { validateNativeScreenRecordingIntegrity } = await import("./nativeIntegrity");

		await expect(validateNativeScreenRecordingIntegrity({ screenPath })).rejects.toThrow(
			"persistent-native-failure-event",
		);

		expect(validateRecordedVideoMock).not.toHaveBeenCalled();
		expect(probeVideoStreamDurationMock).not.toHaveBeenCalled();
		expect(appendRecordingEventLogEntryMock).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "native-screen-recording-rejected",
				details: expect.objectContaining({
					reason: "persistent-native-failure-event",
					persistentEvent: "native-audio-pipeline-stalled",
					persistentDetails: {
						reason: "microphone-audio-lagging-video",
						stalledFor: 5.3,
					},
				}),
			}),
		);
	});

	it("rejects a native screen recording when writer finalization has no real frames", async () => {
		const { validateNativeScreenRecordingIntegrity } = await import("./nativeIntegrity");

		await expect(
			validateNativeScreenRecordingIntegrity({
				screenPath,
				processOutput:
					'VIDEO_RECORDING_FINALIZED path="/tmp/recording.mp4" writerStatus=completed frames=1 realFrames=0 holdFrames=1 duration=20 lastPts=19.96',
			}),
		).rejects.toThrow("writer-zero-real-frames");

		expect(validateRecordedVideoMock).not.toHaveBeenCalled();
		expect(probeVideoStreamDurationMock).not.toHaveBeenCalled();
		expect(appendRecordingEventLogEntryMock).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "native-screen-recording-rejected",
				details: expect.objectContaining({
					reason: "writer-zero-real-frames",
					writerFrames: 1,
					writerRealFrames: 0,
					writerHoldFrames: 1,
				}),
			}),
		);
	});

	it("rejects a native screen recording when saved frames trail the writer summary", async () => {
		validateRecordedVideoMock.mockResolvedValue({
			fileSizeBytes: 798_000_000,
			durationSeconds: 600,
		});
		probeVideoStreamDurationMock.mockResolvedValue({
			durationSeconds: 600,
			frameCount: 12_000,
			frameRate: 30,
		});
		const { validateNativeScreenRecordingIntegrity } = await import("./nativeIntegrity");

		await expect(
			validateNativeScreenRecordingIntegrity({
				screenPath,
				processOutput:
					'VIDEO_RECORDING_FINALIZED path="/tmp/recording.mp4" writerStatus=completed frames=18000 realFrames=17990 holdFrames=10 duration=600 lastPts=599.966',
			}),
		).rejects.toThrow("saved-frame-count-below-writer-summary");

		expect(appendRecordingEventLogEntryMock).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "native-screen-recording-rejected",
				details: expect.objectContaining({
					reason: "saved-frame-count-below-writer-summary",
					writerFrameCount: 18_000,
					writerRealFrames: 17_990,
					writerHoldFrames: 10,
					probedFrameCount: 12_000,
					missingFrameCount: 6_000,
					allowedFrameCountDrift: 900,
				}),
			}),
		);
	});

	it("accepts a native screen recording when a transient low-cadence warning recovered", async () => {
		await fs.writeFile(
			path.join(tempRoot, "recording-1781657811579.recordly-events.jsonl"),
			`${JSON.stringify({
				event: "native-recording-degraded",
				details: {
					reason: "native-webcam-capture-low-cadence",
					severity: "warning",
					recentFps: 9.1,
				},
			})}\n`,
			"utf8",
		);
		validateRecordedVideoMock.mockResolvedValue({
			fileSizeBytes: 798_000_000,
			durationSeconds: 120,
		});
		probeVideoStreamDurationMock.mockResolvedValue({
			durationSeconds: 120,
			frameCount: 3_590,
			frameRate: 29.92,
		});
		const { validateNativeScreenRecordingIntegrity } = await import("./nativeIntegrity");

		await expect(
			validateNativeScreenRecordingIntegrity({
				screenPath,
				processOutput:
					'VIDEO_RECORDING_FINALIZED path="/tmp/recording.mp4" writerStatus=completed frames=3600 realFrames=3590 holdFrames=10 duration=120 lastPts=119.966',
			}),
		).resolves.toEqual({
			fileSizeBytes: 798_000_000,
			durationSeconds: 120,
		});

		expect(appendRecordingEventLogEntryMock).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "native-screen-recording-accepted",
			}),
		);
	});

	it("accepts a native screen recording when writer and saved file agree", async () => {
		validateRecordedVideoMock.mockResolvedValue({
			fileSizeBytes: 798_000_000,
			durationSeconds: 600,
		});
		probeVideoStreamDurationMock.mockResolvedValue({
			durationSeconds: 600,
			frameCount: 17_950,
			frameRate: 29.92,
		});
		const { validateNativeScreenRecordingIntegrity } = await import("./nativeIntegrity");

		await expect(
			validateNativeScreenRecordingIntegrity({
				screenPath,
				processOutput:
					'VIDEO_RECORDING_FINALIZED path="/tmp/recording.mp4" writerStatus=completed frames=18000 realFrames=17990 holdFrames=10 duration=600 lastPts=599.966',
			}),
		).resolves.toEqual({
			fileSizeBytes: 798_000_000,
			durationSeconds: 600,
		});

		expect(appendRecordingEventLogEntryMock).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "native-screen-recording-accepted",
				details: expect.objectContaining({
					writerStatus: "completed",
					writerFrameCount: 18_000,
					writerRealFrames: 17_990,
					writerHoldFrames: 10,
					probedFrameCount: 17_950,
					probedFrameRate: 29.92,
				}),
			}),
		);
	});

	it("logs when the screen recording is materially shorter than the expected recording time", async () => {
		validateRecordedVideoMock.mockResolvedValue({
			fileSizeBytes: 798_000_000,
			durationSeconds: 745,
		});

		const { recordNativeScreenDurationIntegrityEvent } = await import("./nativeIntegrity");

		await recordNativeScreenDurationIntegrityEvent({
			screenPath,
			expectedDurationMs: 20 * 60 * 1000,
		});

		expect(appendRecordingEventLogEntryMock).toHaveBeenCalledWith(
			expect.objectContaining({
				recordingsDir: tempRoot,
				sessionId: "1781657811579",
				event: "native-screen-duration-short",
				details: expect.objectContaining({
					expectedDurationSeconds: 1200,
					actualDurationSeconds: 745,
					shortfallSeconds: 455,
					allowedDriftSeconds: 10,
				}),
			}),
		);
	});

	it("does not log a screen duration anomaly when actual duration is within tolerance", async () => {
		validateRecordedVideoMock.mockResolvedValue({
			fileSizeBytes: 798_000_000,
			durationSeconds: 1193,
		});

		const { recordNativeScreenDurationIntegrityEvent } = await import("./nativeIntegrity");

		await recordNativeScreenDurationIntegrityEvent({
			screenPath,
			expectedDurationMs: 20 * 60 * 1000,
		});

		expect(appendRecordingEventLogEntryMock).not.toHaveBeenCalled();
	});
});
