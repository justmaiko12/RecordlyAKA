import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  attachWebcamFrameWatchdog,
  attemptNativeRecordingStartupRecovery,
  createBrowserRecordingOptions,
  createProcessedMicrophoneConstraints,
  createWebcamRecordingOptions,
  finalizeRequiredMicrophoneSidecarBeforeEditor,
  getFinalizedRecordingAuditFailureMessage,
  getNativeMacWebcamCaptureTimeOffsetMs,
  getNativeRecordingAuditFailureMessage,
  getNativeRecordingAuditWarningMessage,
  getMicrophoneSidecarFinalizationFailureMessage,
  getRecordingStartFailureAlertMessage,
  isNativeRecordingHardFailure,
  isNativeWebcamFailureReason,
  normalizeBrowserMicrophoneProfile,
  requireNativeMacWebcamPathAfterStart,
  resolveBrowserCaptureCursorPolicy,
  resolveImmediateFinalizationWebcamPath,
  resolveNativeMacWebcamCaptureSettings,
  resolveNativeMacMicrophoneCaptureSelection,
  resolveNativeMacWebcamCaptureSelection,
  resolveRecoveredNativeWebcamPath,
  resolveWebcamCaptureOwner,
  shouldCleanupCapturedMediaForNativeDegradedEvent,
  shouldFailClosedForWebcamVisualStall,
  shouldUseBrowserMicrophoneSidecarForNativeMac,
  shouldRetainWebcamChunkForFinalBlob,
  shouldUseNativeWindowsCaptureForSource,
  WIRED_CONTINUITY_CAMERA_TIME_OFFSET_MS,
  WIRELESS_CONTINUITY_CAMERA_TIME_OFFSET_MS,
  WEBCAM_TRACK_MUTE_FAIL_CLOSED_MS,
  WEBCAM_VISUAL_STALL_FAIL_CLOSED_MS,
} from "./useScreenRecorder";

type RecordingState = "inactive" | "recording" | "paused";

function createMockMediaRecorder(initialState: RecordingState = "inactive") {
  let _state: RecordingState = initialState;
  return {
    get state() {
      return _state;
    },
    pause: vi.fn(() => {
      if (_state === "recording") _state = "paused";
    }),
    resume: vi.fn(() => {
      if (_state === "paused") _state = "recording";
    }),
    requestData: vi.fn(),
    stop: vi.fn(() => {
      _state = "inactive";
    }),
    start: vi.fn(() => {
      _state = "recording";
    }),
  };
}

describe("createProcessedMicrophoneConstraints", () => {
  it("requests browser voice processing with AGC for the default microphone", () => {
    expect(createProcessedMicrophoneConstraints()).toEqual({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: { ideal: 1 },
        sampleRate: { ideal: 48000 },
      },
      video: false,
    });
  });

  it("keeps default voice processing when a specific microphone is selected", () => {
    expect(createProcessedMicrophoneConstraints("device-123")).toMatchObject({
      audio: {
        deviceId: { exact: "device-123" },
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: { ideal: 1 },
        sampleRate: { ideal: 48000 },
      },
      video: false,
    });
  });

  it("does not send the synthetic default microphone id as an exact device constraint", () => {
    expect(createProcessedMicrophoneConstraints("default")).toEqual({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: { ideal: 1 },
        sampleRate: { ideal: 48000 },
      },
      video: false,
    });
  });

  it("can request the legacy browser processed profile for lab comparisons", () => {
    expect(
      createProcessedMicrophoneConstraints(undefined, "processed"),
    ).toMatchObject({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
  });

  it("can disable AGC for lab comparisons", () => {
    expect(
      createProcessedMicrophoneConstraints(undefined, "no-agc"),
    ).toMatchObject({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,
      },
      video: false,
    });
  });

  it("can disable echo cancellation for lab comparisons", () => {
    expect(
      createProcessedMicrophoneConstraints(undefined, "no-echo"),
    ).toMatchObject({
      audio: {
        echoCancellation: false,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
  });

  it("can request a raw browser microphone stream for lab comparisons", () => {
    expect(
      createProcessedMicrophoneConstraints(undefined, "raw"),
    ).toMatchObject({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    });
  });

  it("normalizes invalid lab microphone profiles to production voice processing", () => {
    expect(normalizeBrowserMicrophoneProfile("RAW")).toBe("raw");
    expect(normalizeBrowserMicrophoneProfile("unknown")).toBe("processed");
    expect(normalizeBrowserMicrophoneProfile(null)).toBe("processed");
  });
});

describe("shouldUseBrowserMicrophoneSidecarForNativeMac", () => {
  it("does not force browser microphone sidecar capture when mac native screen capture needs a mic", () => {
    expect(
      shouldUseBrowserMicrophoneSidecarForNativeMac({
        useNativeMacScreenCapture: true,
        microphoneEnabled: true,
      }),
    ).toBe(false);
  });

  it("does not force a browser microphone sidecar when native mac capture or microphone is disabled", () => {
    expect(
      shouldUseBrowserMicrophoneSidecarForNativeMac({
        useNativeMacScreenCapture: false,
        microphoneEnabled: true,
      }),
    ).toBe(false);
    expect(
      shouldUseBrowserMicrophoneSidecarForNativeMac({
        useNativeMacScreenCapture: true,
        microphoneEnabled: false,
      }),
    ).toBe(false);
  });
});

describe("getRecordingStartFailureAlertMessage", () => {
  it("explains native webcam no-first-frame failures as a facecam safety stop", () => {
    expect(
      getRecordingStartFailureAlertMessage(
        new Error("Native webcam capture failed before writing a first frame"),
      ),
    ).toContain("facecam would be missing or frozen");
  });

  it("explains missing proof-preview evidence as a native preview verification failure", () => {
    expect(
      getRecordingStartFailureAlertMessage(
        new Error(
          "Timed out waiting for native screen, visible webcam, and proof-preview frames to be written",
        ),
      ),
    ).toContain("could not verify the native webcam proof preview");
  });

  it("explains missing native screen frames as a screen capture failure", () => {
    expect(
      getRecordingStartFailureAlertMessage(
        new Error("Timed out waiting for native screen first frame to be written"),
      ),
    ).toContain("could not capture the selected screen");
  });

  it("explains blank native webcam frames as a visible-facecam failure", () => {
    expect(
      getRecordingStartFailureAlertMessage(
        new Error(
          "Selected webcam is delivering blank frames. Recordly did not start because the native webcam proof preview could not verify visible facecam video.",
        ),
      ),
    ).toContain("delivering blank frames");
  });

  it("explains slow preview handoff re-proof as a stale-facecam safety stop", () => {
    expect(
      getRecordingStartFailureAlertMessage(
        new Error(
          "Native webcam proof preview started too late after preview handoff. First accepted proof was at 3.250s; expected <= 3.000s.",
        ),
      ),
    ).toContain("facecam could be stale or frozen");
  });

  it("explains slow visible-video handoff as a stale-facecam safety stop", () => {
    expect(
      getRecordingStartFailureAlertMessage(
        new Error(
          "Native webcam visible video started too late after preview handoff. First visible frame was at 3.400s; expected <= 3.000s.",
        ),
      ),
    ).toContain("facecam could begin stale, dark, or frozen");
  });

  it("keeps generic start failures readable", () => {
    expect(
      getRecordingStartFailureAlertMessage(
        new Error("Screen permission denied"),
      ),
    ).toBe("Failed to start recording: Screen permission denied");
  });
});

describe("native recording audit finalization", () => {
  const failedAudit: RendererRecordingRunAudit = {
    status: "fail",
    paths: {
      inputPath: "/tmp/recording-1.mp4",
      videoPath: "/tmp/recording-1.mp4",
      eventLogPath: "/tmp/recording-1.recordly-events.jsonl",
      diagnosticsPath: "/tmp/recording-1.recording-diagnostics.json",
    },
    issues: [
      {
        code: "screen-writer-not-completed",
        message: "Native screen writer did not finalize as completed.",
      },
    ],
    warnings: [],
    summary: {
      eventCount: 10,
      sawWebcamEvidence: true,
      proofCount: 2,
      proofRejectedCount: 0,
      proofMonotonic: true,
      rendererPreviewIssueCount: 0,
      screenWriterStatus: "failed",
      screenDuration: 15,
      screenFrames: 295,
      webcamWriterStatus: "completed",
      webcamDuration: 15,
      webcamFrames: 453,
      audioContinuityRepairs: {
        count: 0,
        totalDurationSeconds: 0,
      },
      webcamContinuityRepairs: {
        count: 0,
        totalDurationSeconds: 0,
      },
    },
  };

  it("blocks native editor finalization when the audit failed", () => {
    expect(
      getNativeRecordingAuditFailureMessage({
        path: "/tmp/recording-1.mp4",
        recordingAudit: failedAudit,
      }),
    ).toContain("Native screen writer did not finalize as completed.");
  });

  it("explains preview and recording camera source mismatches", () => {
    expect(
      getNativeRecordingAuditFailureMessage({
        path: "/tmp/recording-1.mp4",
        recordingAudit: {
          ...failedAudit,
          issues: [
            {
              code: "preview-handoff-label-mismatch",
              message:
                "Native webcam preview and recording used different webcam labels.",
            },
          ],
        },
      }),
    ).toContain(
      "the live webcam preview and the native recorder did not prove they were using the same camera source",
    );
  });

  it("explains preview handoffs that were not proven before recording", () => {
    expect(
      getNativeRecordingAuditFailureMessage({
        path: "/tmp/recording-1.mp4",
        recordingAudit: {
          ...failedAudit,
          issues: [
            {
              code: "preview-handoff-without-prior-visible-video",
              message:
                "Native webcam preview was handed to recording, but the preview session itself had not proven visible webcam video.",
            },
          ],
        },
      }),
    ).toContain("had not proven visible webcam video before recording started");
  });

  it("explains preview handoffs that were not re-proven by recording", () => {
    expect(
      getNativeRecordingAuditFailureMessage({
        path: "/tmp/recording-1.mp4",
        recordingAudit: {
          ...failedAudit,
          issues: [
            {
              code: "preview-handoff-reproof-started-too-late",
              message:
                "Native webcam preview was handed to recording, but the recording helper did not quickly re-prove accepted webcam frames.",
            },
          ],
        },
      }),
    ).toContain("did not quickly re-prove accepted webcam frames");
  });

  it("allows native editor finalization when the audit passed or is absent", () => {
    expect(
      getNativeRecordingAuditFailureMessage({
        path: "/tmp/recording-1.mp4",
        recordingAudit: { ...failedAudit, status: "pass", issues: [] },
      }),
    ).toBeNull();
    expect(
      getNativeRecordingAuditFailureMessage({ path: "/tmp/recording-1.mp4" }),
    ).toBeNull();
  });

  it("warns without blocking when the audit reports renderer preview issues", () => {
    const warningAudit: RendererRecordingRunAudit = {
      ...failedAudit,
      status: "warning",
      issues: [],
      warnings: [
        {
          code: "native-webcam-preview-renderer-issue",
          message:
            "The native recorder kept proof evidence, but the renderer preview surface reported stale or failed display frames.",
        },
      ],
      summary: {
        ...failedAudit.summary,
        rendererPreviewIssueCount: 2,
        screenWriterStatus: "completed",
      },
    };

    expect(
      getNativeRecordingAuditFailureMessage({
        path: "/tmp/recording-1.mp4",
        recordingAudit: warningAudit,
      }),
    ).toBeNull();
    expect(
      getNativeRecordingAuditWarningMessage({
        path: "/tmp/recording-1.mp4",
        recordingAudit: warningAudit,
      }),
    ).toContain(
      "Recording saved, but the live webcam preview was not trustworthy during capture (2 preview issues reported).",
    );
  });

  it("warns with continuity repair details when audio or webcam gaps were corrected", () => {
    const warningAudit: RendererRecordingRunAudit = {
      ...failedAudit,
      status: "warning",
      issues: [],
      warnings: [
        {
          code: "native-audio-continuity-repaired",
          message:
            "The native recorder inserted silence to keep audio sample time continuous after device callback gaps.",
        },
        {
          code: "native-webcam-continuity-held-frames",
          message:
            "The native recorder held the last good webcam frame to keep the camera track continuous after device callback gaps.",
        },
      ],
      summary: {
        ...failedAudit.summary,
        screenWriterStatus: "completed",
        audioContinuityRepairs: {
          count: 2,
          totalBuffers: 28,
          totalDurationSeconds: 0.597,
        },
        webcamContinuityRepairs: {
          count: 1,
          totalFrames: 9,
          totalDurationSeconds: 0.3,
        },
      },
    };

    expect(
      getNativeRecordingAuditWarningMessage({
        path: "/tmp/recording-1.mp4",
        recordingAudit: warningAudit,
      }),
    ).toContain(
      "Recordly kept the timeline continuous by applying 0.597s of audio silence across 2 events and 9 held webcam frames across 1 event after device callback gaps.",
    );
  });

  it("does not show an audit warning when the audit passed or is absent", () => {
    expect(
      getNativeRecordingAuditWarningMessage({
        path: "/tmp/recording-1.mp4",
        recordingAudit: { ...failedAudit, status: "pass", issues: [] },
      }),
    ).toBeNull();
    expect(
      getNativeRecordingAuditWarningMessage({ path: "/tmp/recording-1.mp4" }),
    ).toBeNull();
  });

  it("blocks finalization when the post-sidecar audit call fails without an audit payload", () => {
    expect(
      getFinalizedRecordingAuditFailureMessage({
        success: false,
        path: "/tmp/recording-1.mp4",
        error: "Recording audit could not read the event log.",
      }),
    ).toBe(
      "Recording audit could not read the event log. Saved file: /tmp/recording-1.mp4",
    );
  });

  it("uses the audit issue when the post-sidecar audit reports final media corruption", () => {
    expect(
      getFinalizedRecordingAuditFailureMessage({
        success: false,
        path: "/tmp/recording-1.mp4",
        recordingAudit: failedAudit,
        error: "Recording failed final safety verification.",
      }),
    ).toContain("Native screen writer did not finalize as completed.");
  });
});

describe("microphone sidecar finalization", () => {
  const passedAudit: RendererRecordingRunAudit = {
    status: "pass",
    paths: {
      inputPath: "/tmp/recording-1.mp4",
      videoPath: "/tmp/recording-1.mp4",
      eventLogPath: "/tmp/recording-1.recordly-events.jsonl",
      diagnosticsPath: "/tmp/recording-1.recording-diagnostics.json",
    },
    issues: [],
    warnings: [],
    summary: {
      eventCount: 12,
      sawWebcamEvidence: true,
      proofCount: 2,
      proofRejectedCount: 0,
      proofMonotonic: true,
      rendererPreviewIssueCount: 0,
      screenWriterStatus: "completed",
      screenDuration: 30,
      screenFrames: 900,
      webcamWriterStatus: "completed",
      webcamDuration: 30,
      webcamFrames: 900,
    },
  };

  it("blocks editor finalization when a required fallback mic sidecar failed to store", () => {
    expect(
      getMicrophoneSidecarFinalizationFailureMessage({
        required: true,
        success: false,
        error:
          "Companion mic audio/video mismatch is too large to repair safely",
      }),
    ).toContain("fallback microphone audio could not be saved safely");
  });

  it("allows editor finalization when no fallback mic sidecar was required", () => {
    expect(
      getMicrophoneSidecarFinalizationFailureMessage({
        required: false,
        success: false,
        error: "No microphone blob",
      }),
    ).toBeNull();
  });

  it("allows editor finalization after a required fallback mic sidecar is stored", () => {
    expect(
      getMicrophoneSidecarFinalizationFailureMessage({
        required: true,
        success: true,
        path: "/tmp/recording-1.mic.wav",
      }),
    ).toBeNull();
  });

  it("stores a required fallback mic sidecar before auditing the finalized recording", async () => {
    const micFallbackBlobPromise = Promise.resolve(new Blob());
    const storeMicrophoneSidecar = vi.fn(async () => ({
      required: true,
      success: true,
      path: "/tmp/recording-1.mic.wav",
    }));
    const auditFinalizedRecording = vi.fn(async () => ({
      success: true,
      recordingAudit: passedAudit,
    }));
    const notifyRecordingFinalizationFailure = vi.fn();

    const result = await finalizeRequiredMicrophoneSidecarBeforeEditor({
      micFallbackBlobPromise,
      finalPath: "/tmp/recording-1.mp4",
      fallbackStartDelayMs: 125,
      fallbackTrackSettings: { sampleRate: 48000 },
      existingAuditWarningMessage: null,
      storeMicrophoneSidecar,
      auditFinalizedRecording,
      notifyRecordingFinalizationFailure,
    });

    expect(result).toEqual({ success: true, auditWarningMessage: null });
    expect(storeMicrophoneSidecar).toHaveBeenCalledWith(
      micFallbackBlobPromise,
      "/tmp/recording-1.mp4",
      125,
      { sampleRate: 48000 },
      true,
    );
    expect(auditFinalizedRecording).toHaveBeenCalledWith(
      "/tmp/recording-1.mp4",
    );
    expect(storeMicrophoneSidecar.mock.invocationCallOrder[0]).toBeLessThan(
      auditFinalizedRecording.mock.invocationCallOrder[0],
    );
    expect(notifyRecordingFinalizationFailure).not.toHaveBeenCalled();
  });

  it("blocks editor finalization when the post-sidecar audit fails", async () => {
    const notifyRecordingFinalizationFailure = vi.fn();
    const closeHudOverlay = vi.fn();

    const result = await finalizeRequiredMicrophoneSidecarBeforeEditor({
      micFallbackBlobPromise: Promise.resolve(new Blob()),
      finalPath: "/tmp/recording-1.mp4",
      storeMicrophoneSidecar: vi.fn(async () => ({
        required: true,
        success: true,
        path: "/tmp/recording-1.mic.wav",
      })),
      auditFinalizedRecording: vi.fn(async () => ({
        success: false,
        error: "Recording companion audio is missing.",
      })),
      notifyRecordingFinalizationFailure,
      closeHudOverlay,
    });

    expect(result).toEqual({ success: false });
    expect(notifyRecordingFinalizationFailure).toHaveBeenCalledWith(
      "Recording companion audio is missing. Saved file: /tmp/recording-1.mp4",
    );
    expect(closeHudOverlay).toHaveBeenCalled();
  });
});

describe("native recording degraded event classification", () => {
  it("treats native webcam proof-preview failures as hard recording failures", () => {
    expect(
      isNativeRecordingHardFailure({
        reason: "native-webcam-proof-preview-lagging",
        severity: "error",
      }),
    ).toBe(true);
    expect(
      isNativeRecordingHardFailure({
        reason: "native-webcam-fail-closed",
        severity: "error",
      }),
    ).toBe(true);
  });

  it("treats native video pipeline failures as hard recording failures", () => {
    expect(
      isNativeRecordingHardFailure({
        reason: "native-video-stream-stopped-with-error",
        severity: "error",
      }),
    ).toBe(true);
  });

  it("does not hard-stop for unrelated warnings", () => {
    expect(
      isNativeRecordingHardFailure({
        reason: "native-webcam-input-not-ready",
        severity: "warning",
      }),
    ).toBe(false);
    expect(
      isNativeRecordingHardFailure({
        reason: "network-warning",
        severity: "error",
      }),
    ).toBe(false);
  });

  it("clears native webcam paths for native or main-process webcam failures", () => {
    expect(isNativeWebcamFailureReason("native-webcam-fail-closed")).toBe(true);
    expect(
      isNativeWebcamFailureReason("native-webcam-proof-preview-stale"),
    ).toBe(true);
    expect(isNativeWebcamFailureReason("main-webcam-proof-preview-stale")).toBe(
      true,
    );
    expect(
      isNativeWebcamFailureReason("native-video-stream-stopped-with-error"),
    ).toBe(false);
  });

  it("cleans up browser companion recorders after native hard failures", () => {
    expect(
      shouldCleanupCapturedMediaForNativeDegradedEvent({
        reason: "native-webcam-fail-closed",
        severity: "error",
      }),
    ).toBe(true);
    expect(
      shouldCleanupCapturedMediaForNativeDegradedEvent({
        reason: "native-webcam-input-not-ready",
        severity: "warning",
      }),
    ).toBe(false);
  });
});

describe("createBrowserRecordingOptions", () => {
  it("sets an aggregate bitrate target for browser screen recordings", () => {
    expect(
      createBrowserRecordingOptions({
        audioBitsPerSecond: 128_000,
        mimeType: "video/webm;codecs=vp9",
        videoBitsPerSecond: 30_600_000,
      }),
    ).toEqual({
      audioBitsPerSecond: 128_000,
      bitsPerSecond: 30_728_000,
      mimeType: "video/webm;codecs=vp9",
      videoBitsPerSecond: 30_600_000,
    });
  });

  it("keeps video-only recordings on the requested video budget", () => {
    expect(
      createBrowserRecordingOptions({
        videoBitsPerSecond: 30_600_000,
      }),
    ).toEqual({
      bitsPerSecond: 30_600_000,
      videoBitsPerSecond: 30_600_000,
    });
  });
});

describe("webcam recording quality", () => {
  // Camera constraints are covered by webcamSession.test.ts; the recorder
  // now acquires its stream through the shared webcam session.
  it("records the webcam sidecar at a long-session-safe bitrate", () => {
    expect(createWebcamRecordingOptions()).toEqual({
      videoBitsPerSecond: 8_000_000,
    });
    expect(createWebcamRecordingOptions("video/mp4")).toEqual({
      videoBitsPerSecond: 8_000_000,
      mimeType: "video/mp4",
    });
  });

  it("raises webcam bitrate only when a sharper capture profile is selected", () => {
    expect(createWebcamRecordingOptions(undefined, "sharp")).toEqual({
      videoBitsPerSecond: 18_000_000,
    });
    expect(createWebcamRecordingOptions("video/mp4", "max")).toEqual({
      videoBitsPerSecond: 35_000_000,
      mimeType: "video/mp4",
    });
  });
});

describe("resolveNativeMacWebcamCaptureSettings", () => {
  it("allows direct cameras to use the selected 4K quality profile", () => {
    expect(
      resolveNativeMacWebcamCaptureSettings({
        qualityMode: "max",
        frameRate: 60,
        selection: {
          webcamLabel: "Elgato Facecam Pro",
          webcamConnectionKind: "usb",
        },
      }),
    ).toEqual({
      width: 3840,
      height: 2160,
      fps: 30,
      effectiveQualityMode: "max",
    });
  });

  it("uses 1080p for the sharp native webcam profile", () => {
    expect(
      resolveNativeMacWebcamCaptureSettings({
        qualityMode: "sharp",
        frameRate: 30,
        selection: {
          webcamLabel: "USB Camera",
          webcamConnectionKind: "usb",
        },
      }),
    ).toEqual({
      width: 1920,
      height: 1080,
      fps: 30,
      effectiveQualityMode: "sharp",
    });
  });

  it("downgrades Continuity Camera quality for stability", () => {
    expect(
      resolveNativeMacWebcamCaptureSettings({
        qualityMode: "max",
        frameRate: 30,
        selection: {
          webcamLabel: "Justmaiko's iPhone Camera",
          webcamConnectionKind: "wireless",
        },
      }),
    ).toEqual({
      width: 1280,
      height: 720,
      fps: 30,
      effectiveQualityMode: "stable",
      downgradedReason: "continuity-camera-stability",
    });
  });
});

describe("resolveWebcamCaptureOwner", () => {
  it("uses the native mac capture pipeline as the webcam owner when available", () => {
    expect(
      resolveWebcamCaptureOwner({
        platform: "darwin",
        webcamEnabled: true,
        nativeMacScreenCaptureAvailable: true,
      }),
    ).toBe("native-mac");
  });

  it("uses browser webcam recording only when native mac ownership is unavailable", () => {
    expect(
      resolveWebcamCaptureOwner({
        platform: "darwin",
        webcamEnabled: true,
        nativeMacScreenCaptureAvailable: false,
      }),
    ).toBe("browser");
    expect(
      resolveWebcamCaptureOwner({
        platform: "win32",
        webcamEnabled: true,
        nativeMacScreenCaptureAvailable: true,
      }),
    ).toBe("browser");
  });

  it("does not assign any webcam owner when webcam recording is disabled", () => {
    expect(
      resolveWebcamCaptureOwner({
        platform: "darwin",
        webcamEnabled: false,
        nativeMacScreenCaptureAvailable: true,
      }),
    ).toBe("none");
  });
});

describe("resolveNativeMacWebcamCaptureSelection", () => {
  const nativeDevices = [
    {
      label: "MacBook Air Camera",
      normalizedLabel: "macbook air camera",
      uniqueId: "6C707041-05AC-0011-0004-000000000001",
    },
    {
      label: "Justmaiko's iPhone Camera",
      normalizedLabel: "justmaiko's iphone camera",
      uniqueId: "D0B50AEF-3573-491E-9CA6-08E600000001",
    },
  ];

  it("keeps a native-only selected camera on its native unique ID", () => {
    expect(
      resolveNativeMacWebcamCaptureSelection({
        selectedDeviceId: "D0B50AEF-3573-491E-9CA6-08E600000001",
        browserDevices: [],
        nativeDevices,
      }),
    ).toEqual({
      webcamDeviceId: "D0B50AEF-3573-491E-9CA6-08E600000001",
      webcamLabel: "Justmaiko's iPhone Camera",
      webcamConnectionKind: undefined,
      webcamConnectionLabel: null,
      matchedBrowserDevice: false,
      matchedNativeDevice: true,
    });
  });

  it("translates a browser-selected camera to the native unique ID by label", () => {
    expect(
      resolveNativeMacWebcamCaptureSelection({
        selectedDeviceId: "browser-iphone-camera",
        browserDevices: [
          {
            deviceId: "browser-iphone-camera",
            label: "Justmaiko’s iPhone Camera",
          },
        ],
        nativeDevices,
      }),
    ).toEqual({
      webcamDeviceId: "D0B50AEF-3573-491E-9CA6-08E600000001",
      webcamLabel: "Justmaiko's iPhone Camera",
      webcamConnectionKind: undefined,
      webcamConnectionLabel: null,
      matchedBrowserDevice: true,
      matchedNativeDevice: true,
    });
  });

  it("falls back to the selected browser device and label when native discovery misses it", () => {
    expect(
      resolveNativeMacWebcamCaptureSelection({
        selectedDeviceId: "browser-usb-camera",
        browserDevices: [
          {
            deviceId: "browser-usb-camera",
            label: "USB Camera",
          },
        ],
        nativeDevices: [],
      }),
    ).toEqual({
      webcamDeviceId: "browser-usb-camera",
      webcamLabel: "USB Camera",
      webcamConnectionKind: undefined,
      webcamConnectionLabel: null,
      matchedBrowserDevice: true,
      matchedNativeDevice: false,
    });
  });

  it("lets the native recorder use its default camera for default selections", () => {
    expect(
      resolveNativeMacWebcamCaptureSelection({
        selectedDeviceId: "default",
        browserDevices: [],
        nativeDevices,
      }),
    ).toEqual({
      webcamDeviceId: undefined,
      webcamLabel: undefined,
      webcamConnectionKind: undefined,
      webcamConnectionLabel: null,
      matchedBrowserDevice: false,
      matchedNativeDevice: false,
    });
  });

  it("carries native connection info for Continuity Camera sync decisions", () => {
    expect(
      resolveNativeMacWebcamCaptureSelection({
        selectedDeviceId: "browser-iphone-camera",
        browserDevices: [
          {
            deviceId: "browser-iphone-camera",
            label: "Justmaiko’s iPhone Camera",
          },
        ],
        nativeDevices: [
          {
            label: "Justmaiko's iPhone Camera",
            normalizedLabel: "justmaiko's iphone camera",
            uniqueId: "D0B50AEF-3573-491E-9CA6-08E600000001",
            connectionKind: "wireless",
            connectionLabel: "Wireless",
          },
        ],
      }),
    ).toEqual({
      webcamDeviceId: "D0B50AEF-3573-491E-9CA6-08E600000001",
      webcamLabel: "Justmaiko's iPhone Camera",
      webcamConnectionKind: "wireless",
      webcamConnectionLabel: "Wireless",
      matchedBrowserDevice: true,
      matchedNativeDevice: true,
    });
  });
});

describe("resolveNativeMacMicrophoneCaptureSelection", () => {
  const nativeDevices = [
    {
      label: "Wireless microphone",
      normalizedLabel: "wireless microphone",
      uniqueId:
        "AppleUSBAudioEngine:Shenzhen Hollyland Technology Co.,Ltd:Wireless microphone:95CX2H374W8B:3",
      connectionKind: "usb" as const,
      connectionLabel: "USB",
    },
    {
      label: "MacBook Air Microphone",
      normalizedLabel: "macbook air microphone",
      uniqueId: "BuiltInMicrophoneDevice",
      connectionKind: "built-in" as const,
      connectionLabel: "Built-in",
    },
  ];

  it("translates a browser-selected wireless microphone to its native unique ID", () => {
    expect(
      resolveNativeMacMicrophoneCaptureSelection({
        selectedDeviceId: "browser-wireless-mic",
        browserDevices: [
          {
            deviceId: "browser-wireless-mic",
            label: "Wireless microphone",
          },
        ],
        nativeDevices,
      }),
    ).toEqual({
      microphoneDeviceId:
        "AppleUSBAudioEngine:Shenzhen Hollyland Technology Co.,Ltd:Wireless microphone:95CX2H374W8B:3",
      microphoneLabel: "Wireless microphone",
      microphoneConnectionKind: "usb",
      microphoneConnectionLabel: "USB",
      matchedBrowserDevice: true,
      matchedNativeDevice: true,
    });
  });

  it("keeps a native-only selected microphone on its native unique ID", () => {
    expect(
      resolveNativeMacMicrophoneCaptureSelection({
        selectedDeviceId:
          "AppleUSBAudioEngine:Shenzhen Hollyland Technology Co.,Ltd:Wireless microphone:95CX2H374W8B:3",
        browserDevices: [],
        nativeDevices,
      }),
    ).toMatchObject({
      microphoneDeviceId:
        "AppleUSBAudioEngine:Shenzhen Hollyland Technology Co.,Ltd:Wireless microphone:95CX2H374W8B:3",
      microphoneLabel: "Wireless microphone",
      matchedNativeDevice: true,
    });
  });

  it("falls back with evidence when a stale browser hash cannot be resolved", () => {
    expect(
      resolveNativeMacMicrophoneCaptureSelection({
        selectedDeviceId: "stale-browser-hash",
        browserDevices: [],
        nativeDevices,
      }),
    ).toEqual({
      microphoneDeviceId: "stale-browser-hash",
      microphoneLabel: undefined,
      microphoneConnectionKind: undefined,
      microphoneConnectionLabel: null,
      matchedBrowserDevice: false,
      matchedNativeDevice: false,
    });
  });
});

describe("getNativeMacWebcamCaptureTimeOffsetMs", () => {
  it("does not offset built-in cameras", () => {
    expect(
      getNativeMacWebcamCaptureTimeOffsetMs({
        webcamLabel: "MacBook Air Camera",
        webcamConnectionKind: "built-in",
      }),
    ).toBe(0);
  });

  it("advances wireless Continuity Camera by the default compensation", () => {
    expect(
      getNativeMacWebcamCaptureTimeOffsetMs({
        webcamLabel: "Justmaiko's iPhone Camera",
        webcamConnectionKind: "wireless",
      }),
    ).toBe(WIRELESS_CONTINUITY_CAMERA_TIME_OFFSET_MS);
  });

  it("uses a smaller advance for wired Continuity Camera", () => {
    expect(
      getNativeMacWebcamCaptureTimeOffsetMs({
        webcamLabel: "Justmaiko's iPhone Camera",
        webcamConnectionKind: "usb",
      }),
    ).toBe(WIRED_CONTINUITY_CAMERA_TIME_OFFSET_MS);
  });
});

describe("requireNativeMacWebcamPathAfterStart", () => {
  it("accepts a validated native webcam path when native webcam capture is required", () => {
    expect(
      requireNativeMacWebcamPathAfterStart({
        requiresNativeWebcam: true,
        webcamPath: "/tmp/recording-webcam.mp4",
      }),
    ).toBe("/tmp/recording-webcam.mp4");
  });

  it("fails closed when native webcam capture starts without a webcam path", () => {
    expect(() =>
      requireNativeMacWebcamPathAfterStart({
        requiresNativeWebcam: true,
        webcamPath: null,
      }),
    ).toThrow(/without a validated webcam file/);
    expect(() =>
      requireNativeMacWebcamPathAfterStart({
        requiresNativeWebcam: true,
        webcamPath: "   ",
      }),
    ).toThrow(/without a validated webcam file/);
  });

  it("allows a missing webcam path when native webcam capture was not requested", () => {
    expect(
      requireNativeMacWebcamPathAfterStart({
        requiresNativeWebcam: false,
        webcamPath: null,
      }),
    ).toBeNull();
  });
});

describe("shouldRetainWebcamChunkForFinalBlob", () => {
  it("does not retain streamed MP4 chunks in renderer memory", () => {
    expect(
      shouldRetainWebcamChunkForFinalBlob({
        hasStreamingSidecar: true,
        mimeType: "video/mp4",
      }),
    ).toBe(false);
  });

  it("retains chunks when there is no streaming sidecar fallback", () => {
    expect(
      shouldRetainWebcamChunkForFinalBlob({
        hasStreamingSidecar: false,
        mimeType: "video/mp4",
      }),
    ).toBe(true);
  });

  it("retains streamed WebM chunks so duration repair can run", () => {
    expect(
      shouldRetainWebcamChunkForFinalBlob({
        hasStreamingSidecar: true,
        mimeType: "video/webm;codecs=vp9",
      }),
    ).toBe(true);
  });
});

describe("resolveRecoveredNativeWebcamPath", () => {
  it("uses main-process validated recovery webcam paths", async () => {
    const stopWebcamRecorder = vi.fn(async () => "stale-local-webcam.mp4");

    await expect(
      resolveRecoveredNativeWebcamPath({
        recoveryResult: { webcamPath: "validated-webcam.mp4" },
        stopWebcamRecorder,
      }),
    ).resolves.toBe("validated-webcam.mp4");
    expect(stopWebcamRecorder).not.toHaveBeenCalled();
  });

  it("does not fall back to stale local webcam paths when recovery explicitly rejects webcam", async () => {
    const stopWebcamRecorder = vi.fn(async () => "stale-local-webcam.mp4");

    await expect(
      resolveRecoveredNativeWebcamPath({
        recoveryResult: { webcamPath: null },
        stopWebcamRecorder,
      }),
    ).resolves.toBeNull();
    expect(stopWebcamRecorder).not.toHaveBeenCalled();
  });

  it("falls back to the renderer webcam recorder only for older recovery responses", async () => {
    const stopWebcamRecorder = vi.fn(async () => "browser-webcam.webm");

    await expect(
      resolveRecoveredNativeWebcamPath({
        recoveryResult: {},
        stopWebcamRecorder,
      }),
    ).resolves.toBe("browser-webcam.webm");
    expect(stopWebcamRecorder).toHaveBeenCalledTimes(1);
  });
});

describe("resolveImmediateFinalizationWebcamPath", () => {
  it("uses the stop-time validated native mac webcam path before opening the editor", () => {
    expect(
      resolveImmediateFinalizationWebcamPath({
        hasNativeMacWebcamPath: true,
        stopResultWebcamPath: "/tmp/recording-123-webcam.mp4",
      }),
    ).toBe("/tmp/recording-123-webcam.mp4");
  });

  it("does not reuse stale native mac webcam paths when stop validation rejects webcam", () => {
    expect(
      resolveImmediateFinalizationWebcamPath({
        hasNativeMacWebcamPath: true,
        stopResultWebcamPath: null,
      }),
    ).toBeNull();
  });

  it("leaves browser webcam sidecars for background finalization", () => {
    expect(
      resolveImmediateFinalizationWebcamPath({
        hasNativeMacWebcamPath: false,
        stopResultWebcamPath: "/tmp/browser-webcam.webm",
      }),
    ).toBeNull();
  });
});

describe("webcam fail-closed watchdog", () => {
  it("fails closed only after the sustained visual-stall threshold", () => {
    expect(
      shouldFailClosedForWebcamVisualStall(
        WEBCAM_VISUAL_STALL_FAIL_CLOSED_MS - 1,
      ),
    ).toBe(false);
    expect(
      shouldFailClosedForWebcamVisualStall(WEBCAM_VISUAL_STALL_FAIL_CLOSED_MS),
    ).toBe(true);
  });

  it("turns a muted webcam track into one pipeline failure", () => {
    vi.useFakeTimers();
    const originalWindow = globalThis.window;
    Object.defineProperty(globalThis, "window", {
      value: {
        setTimeout,
        clearTimeout,
      },
      configurable: true,
    });

    const listeners = new Map<string, Array<() => void>>();
    const track = {
      label: "iPhone Camera",
      readyState: "live",
      addEventListener: vi.fn((event: string, callback: () => void) => {
        listeners.set(event, [...(listeners.get(event) ?? []), callback]);
      }),
      removeEventListener: vi.fn((event: string, callback: () => void) => {
        listeners.set(
          event,
          (listeners.get(event) ?? []).filter(
            (listener) => listener !== callback,
          ),
        );
      }),
    };
    const stream = {
      getVideoTracks: () => [track],
    };
    const recordEvent = vi.fn();
    const failClosed = vi.fn();

    const cleanup = attachWebcamFrameWatchdog(
      stream as unknown as MediaStream,
      recordEvent,
      failClosed,
    );
    listeners.get("mute")?.forEach((listener) => listener());
    vi.advanceTimersByTime(WEBCAM_TRACK_MUTE_FAIL_CLOSED_MS);
    listeners.get("mute")?.forEach((listener) => listener());
    vi.advanceTimersByTime(WEBCAM_TRACK_MUTE_FAIL_CLOSED_MS);

    expect(failClosed).toHaveBeenCalledTimes(1);
    expect(failClosed).toHaveBeenCalledWith(
      "track-muted",
      expect.objectContaining({
        trackLabel: "iPhone Camera",
        trackReadyState: "live",
      }),
    );
    expect(recordEvent).toHaveBeenCalledWith(
      "webcam-track-fail-closed",
      expect.objectContaining({ reason: "track-muted" }),
    );

    cleanup();
    Object.defineProperty(globalThis, "window", {
      value: originalWindow,
      configurable: true,
    });
    vi.useRealTimers();
  });

  it("does not fail-close a muted webcam track while recording is paused", () => {
    vi.useFakeTimers();
    const originalWindow = globalThis.window;
    Object.defineProperty(globalThis, "window", {
      value: {
        setTimeout,
        clearTimeout,
      },
      configurable: true,
    });

    const listeners = new Map<string, Array<() => void>>();
    const track = {
      label: "iPhone Camera",
      readyState: "live",
      addEventListener: vi.fn((event: string, callback: () => void) => {
        listeners.set(event, [...(listeners.get(event) ?? []), callback]);
      }),
      removeEventListener: vi.fn((event: string, callback: () => void) => {
        listeners.set(
          event,
          (listeners.get(event) ?? []).filter(
            (listener) => listener !== callback,
          ),
        );
      }),
    };
    const stream = {
      getVideoTracks: () => [track],
    };
    const recordEvent = vi.fn();
    const failClosed = vi.fn();

    const cleanup = attachWebcamFrameWatchdog(
      stream as unknown as MediaStream,
      recordEvent,
      failClosed,
      () => true,
    );
    listeners.get("mute")?.forEach((listener) => listener());
    vi.advanceTimersByTime(WEBCAM_TRACK_MUTE_FAIL_CLOSED_MS);

    expect(failClosed).not.toHaveBeenCalled();
    expect(recordEvent).toHaveBeenCalledWith(
      "webcam-track-fail-closed-suppressed",
      expect.objectContaining({
        reason: "track-muted",
        suppression: "recording-paused",
      }),
    );

    cleanup();
    Object.defineProperty(globalThis, "window", {
      value: originalWindow,
      configurable: true,
    });
    vi.useRealTimers();
  });
});

describe("resolveBrowserCaptureCursorPolicy", () => {
  it("preserves the existing hidden-cursor browser policy by default", () => {
    expect(resolveBrowserCaptureCursorPolicy()).toEqual({
      streamCursor: "never",
      hideOsCursorBeforeRecording: true,
      hideEditorOverlayCursorByDefault: true,
    });
  });

  it("uses the browser captured cursor after native Windows capture fails to start", () => {
    expect(
      resolveBrowserCaptureCursorPolicy({
        nativeWindowsCaptureStartFailed: true,
      }),
    ).toEqual({
      streamCursor: "always",
      hideOsCursorBeforeRecording: false,
      hideEditorOverlayCursorByDefault: true,
    });
  });
});

describe("shouldUseNativeWindowsCaptureForSource", () => {
  it("keeps native Windows capture on screen sources", () => {
    expect(shouldUseNativeWindowsCaptureForSource({ id: "screen:101:0" })).toBe(
      true,
    );
  });

  it("keeps native Windows capture on window sources", () => {
    expect(
      shouldUseNativeWindowsCaptureForSource({ id: "window:123456:0" }),
    ).toBe(true);
  });

  it("keeps browser capture for non-desktop sources", () => {
    expect(
      shouldUseNativeWindowsCaptureForSource({ id: "browser-tab:abc" }),
    ).toBe(false);
  });
});

describe("attemptNativeRecordingStartupRecovery", () => {
  it("skips startup recovery outside macOS", async () => {
    const recover = vi.fn(async () => "/tmp/recovered.mp4");

    const result = await attemptNativeRecordingStartupRecovery({
      isMacOS: false,
      recover,
    });

    expect(result).toBeNull();
    expect(recover).not.toHaveBeenCalled();
  });

  it("returns a recovered path on macOS", async () => {
    const result = await attemptNativeRecordingStartupRecovery({
      isMacOS: true,
      recover: async () => "/tmp/recovered.mp4",
    });

    expect(result).toBe("/tmp/recovered.mp4");
  });

  it("logs diagnostics when startup recovery throws", async () => {
    const logDiagnostics = vi.fn(async () => undefined);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
      const result = await attemptNativeRecordingStartupRecovery({
        isMacOS: true,
        recover: async () => {
          throw new Error("recovery failed");
        },
        logDiagnostics,
      });

      expect(result).toBeNull();
      expect(logDiagnostics).toHaveBeenCalledWith(
        "startup-recover-native-screen-recording",
      );
    } finally {
      consoleError.mockRestore();
    }
  });
});

function stopRecording(
  recorder: ReturnType<typeof createMockMediaRecorder>,
  isNativeRecording: boolean,
  webcamRecorder?: ReturnType<typeof createMockMediaRecorder> | null,
) {
  if (isNativeRecording) {
    if (webcamRecorder && webcamRecorder.state !== "inactive") {
      webcamRecorder.stop();
    }
    return { stopped: true, wasNative: true };
  }

  const recorderState = recorder.state;
  if (recorderState === "recording" || recorderState === "paused") {
    if (recorderState === "paused") {
      try {
        recorder.resume();
      } catch {
        // Stopping a paused recorder is still valid; mirror the hook's fallback path.
      }
    }
    if (webcamRecorder && webcamRecorder.state !== "inactive") {
      webcamRecorder.stop();
    }
    try {
      recorder.requestData();
    } catch {
      // Stopping should continue even if the browser refuses an explicit flush.
    }
    recorder.stop();
    return { stopped: true, wasNative: false };
  }
  return { stopped: false, wasNative: false };
}

function pauseRecording(
  recorder: ReturnType<typeof createMockMediaRecorder>,
  recording: boolean,
  paused: boolean,
  isNativeRecording: boolean,
  webcamRecorder?: ReturnType<typeof createMockMediaRecorder> | null,
  micFallbackRecorder?: ReturnType<typeof createMockMediaRecorder> | null,
): boolean {
  if (!recording || paused) return false;
  if (isNativeRecording) {
    if (webcamRecorder?.state === "recording") {
      webcamRecorder.pause();
    }
    if (micFallbackRecorder?.state === "recording") {
      micFallbackRecorder.requestData();
      micFallbackRecorder.pause();
    }
    return true;
  }
  if (recorder.state === "recording") {
    recorder.pause();
    if (webcamRecorder?.state === "recording") {
      webcamRecorder.pause();
    }
    return true;
  }
  return false;
}

function resumeRecording(
  recorder: ReturnType<typeof createMockMediaRecorder>,
  recording: boolean,
  paused: boolean,
  isNativeRecording: boolean,
  webcamRecorder?: ReturnType<typeof createMockMediaRecorder> | null,
  micFallbackRecorder?: ReturnType<typeof createMockMediaRecorder> | null,
): boolean {
  if (!recording || !paused) return false;
  if (isNativeRecording) {
    if (webcamRecorder?.state === "paused") {
      webcamRecorder.resume();
    }
    if (micFallbackRecorder?.state === "paused") {
      micFallbackRecorder.resume();
    }
    return true;
  }
  if (recorder.state === "paused") {
    recorder.resume();
    if (webcamRecorder?.state === "paused") {
      webcamRecorder.resume();
    }
    return true;
  }
  return false;
}

async function pauseNativeRecording(
  webcamRecorder?: ReturnType<typeof createMockMediaRecorder> | null,
  result: { success: boolean } = { success: true },
  micFallbackRecorder?: ReturnType<typeof createMockMediaRecorder> | null,
): Promise<boolean> {
  if (!result.success) {
    return false;
  }

  if (webcamRecorder?.state === "recording") {
    webcamRecorder.pause();
  }
  if (micFallbackRecorder?.state === "recording") {
    micFallbackRecorder.requestData();
    micFallbackRecorder.pause();
  }

  return true;
}

async function resumeNativeRecording(
  webcamRecorder?: ReturnType<typeof createMockMediaRecorder> | null,
  result: { success: boolean } = { success: true },
  micFallbackRecorder?: ReturnType<typeof createMockMediaRecorder> | null,
): Promise<boolean> {
  if (!result.success) {
    return false;
  }

  if (webcamRecorder?.state === "paused") {
    webcamRecorder.resume();
  }
  if (micFallbackRecorder?.state === "paused") {
    micFallbackRecorder.resume();
  }

  return true;
}

async function stopNativeRecordingWithCompanions({
  getRecordingDurationMs,
  markRecordingResumed,
  now,
  stopMicFallbackRecorder,
  stopNativeScreenRecording,
  stopWebcamRecorder,
}: {
  getRecordingDurationMs: (timestampMs: number) => number;
  markRecordingResumed: (timestampMs: number) => void;
  now: () => number;
  stopMicFallbackRecorder: () => Promise<Blob | null>;
  stopNativeScreenRecording: () => Promise<{ success: boolean; path?: string }>;
  stopWebcamRecorder: () => Promise<string | null>;
}) {
  const stoppedAtMs = now();
  markRecordingResumed(stoppedAtMs);
  const expectedDurationMs = getRecordingDurationMs(stoppedAtMs);
  const micFallbackBlobPromise = stopMicFallbackRecorder();
  const webcamPathPromise = stopWebcamRecorder();
  const result = await stopNativeScreenRecording();
  const webcamPath = await webcamPathPromise;
  const micFallbackBlob = await micFallbackBlobPromise;

  return { expectedDurationMs, micFallbackBlob, result, webcamPath };
}

function cancelRecording(
  recorder: ReturnType<typeof createMockMediaRecorder>,
  isNativeRecording: boolean,
  chunks: { current: Blob[] },
  webcamRecorder?: ReturnType<typeof createMockMediaRecorder> | null,
  webcamChunks?: { current: Blob[] },
) {
  if (webcamChunks) webcamChunks.current = [];
  if (webcamRecorder && webcamRecorder.state !== "inactive") {
    webcamRecorder.stop();
  }

  if (isNativeRecording) {
    return { cancelled: true, wasNative: true };
  }

  chunks.current = [];
  if (recorder.state !== "inactive") {
    recorder.stop();
  }
  return { cancelled: true, wasNative: false };
}

describe("useScreenRecorder state machine", () => {
  let recorder: ReturnType<typeof createMockMediaRecorder>;

  beforeEach(() => {
    recorder = createMockMediaRecorder("recording");
  });

  describe("stopRecording", () => {
    it("stops from recording state", () => {
      const result = stopRecording(recorder, false);

      expect(result.stopped).toBe(true);
      expect(recorder.stop).toHaveBeenCalled();
      expect(recorder.resume).not.toHaveBeenCalled();
      expect(recorder.state).toBe("inactive");
    });

    it("resumes then stops from paused state", () => {
      recorder.pause();
      expect(recorder.state).toBe("paused");

      const result = stopRecording(recorder, false);

      expect(result.stopped).toBe(true);
      expect(recorder.resume).toHaveBeenCalled();
      expect(recorder.stop).toHaveBeenCalled();
      expect(recorder.state).toBe("inactive");
    });

    it("resume is called before stop when paused", () => {
      recorder.pause();
      const callOrder: string[] = [];
      recorder.resume.mockImplementation(() => {
        callOrder.push("resume");
      });
      recorder.stop.mockImplementation(() => {
        callOrder.push("stop");
      });

      stopRecording(recorder, false);

      expect(callOrder).toEqual(["resume", "stop"]);
    });

    it("flushes the current recorder data before stopping", () => {
      const callOrder: string[] = [];
      recorder.requestData.mockImplementation(() => {
        callOrder.push("requestData");
      });
      recorder.stop.mockImplementation(() => {
        callOrder.push("stop");
      });

      stopRecording(recorder, false);

      expect(callOrder).toEqual(["requestData", "stop"]);
    });

    it("resumes, flushes, then stops from paused state", () => {
      recorder.pause();
      const callOrder: string[] = [];
      recorder.resume.mockImplementation(() => {
        callOrder.push("resume");
      });
      recorder.requestData.mockImplementation(() => {
        callOrder.push("requestData");
      });
      recorder.stop.mockImplementation(() => {
        callOrder.push("stop");
      });

      stopRecording(recorder, false);

      expect(callOrder).toEqual(["resume", "requestData", "stop"]);
    });

    it("still stops when the explicit data flush fails", () => {
      recorder.requestData.mockImplementation(() => {
        throw new Error("flush failed");
      });

      const result = stopRecording(recorder, false);

      expect(result.stopped).toBe(true);
      expect(recorder.stop).toHaveBeenCalled();
    });

    it("still stops from paused state when the explicit data flush fails", () => {
      recorder.pause();
      const callOrder: string[] = [];
      recorder.resume.mockImplementation(() => {
        callOrder.push("resume");
      });
      recorder.requestData.mockImplementation(() => {
        callOrder.push("requestData");
        throw new Error("flush failed");
      });
      recorder.stop.mockImplementation(() => {
        callOrder.push("stop");
      });

      const result = stopRecording(recorder, false);

      expect(result.stopped).toBe(true);
      expect(callOrder).toEqual(["resume", "requestData", "stop"]);
    });

    it("still stops when resume throws from paused state", () => {
      recorder.pause();
      recorder.resume.mockImplementation(() => {
        throw new Error("resume failed");
      });

      const result = stopRecording(recorder, false);

      expect(result.stopped).toBe(true);
      expect(recorder.stop).toHaveBeenCalled();
      expect(recorder.state).toBe("inactive");
    });

    it("does nothing when already inactive", () => {
      const inactiveRecorder = createMockMediaRecorder("inactive");

      const result = stopRecording(inactiveRecorder, false);

      expect(result.stopped).toBe(false);
      expect(inactiveRecorder.stop).not.toHaveBeenCalled();
    });

    it("delegates to native path for native recordings", () => {
      const result = stopRecording(recorder, true);

      expect(result.stopped).toBe(true);
      expect(result.wasNative).toBe(true);
      expect(recorder.stop).not.toHaveBeenCalled();
    });

    it("stops webcam when stopping browser recording", () => {
      const webcam = createMockMediaRecorder("recording");

      stopRecording(recorder, false, webcam);

      expect(webcam.stop).toHaveBeenCalled();
      expect(webcam.state).toBe("inactive");
    });

    it("stops webcam when stopping native recording", () => {
      const webcam = createMockMediaRecorder("recording");

      stopRecording(recorder, true, webcam);

      expect(webcam.stop).toHaveBeenCalled();
      expect(webcam.state).toBe("inactive");
    });
  });

  describe("pauseRecording", () => {
    it("pauses an active recording", () => {
      const result = pauseRecording(recorder, true, false, false);

      expect(result).toBe(true);
      expect(recorder.pause).toHaveBeenCalled();
      expect(recorder.state).toBe("paused");
    });

    it("does nothing when already paused", () => {
      recorder.pause();
      recorder.pause.mockClear();

      const result = pauseRecording(recorder, true, true, false);

      expect(result).toBe(false);
      expect(recorder.pause).not.toHaveBeenCalled();
    });

    it("does nothing when not recording", () => {
      const result = pauseRecording(recorder, false, false, false);

      expect(result).toBe(false);
      expect(recorder.pause).not.toHaveBeenCalled();
    });

    it("allows pause for native recordings", () => {
      const result = pauseRecording(recorder, true, false, true);

      expect(result).toBe(true);
    });

    it("pauses webcam alongside browser recording", () => {
      const webcam = createMockMediaRecorder("recording");

      pauseRecording(recorder, true, false, false, webcam);

      expect(recorder.state).toBe("paused");
      expect(webcam.state).toBe("paused");
    });

    it("pauses webcam during native recording pause", () => {
      const webcam = createMockMediaRecorder("recording");

      const result = pauseRecording(recorder, true, false, true, webcam);

      expect(result).toBe(true);
      expect(webcam.state).toBe("paused");
    });

    it("pauses browser mic fallback during native recording pause", () => {
      const micFallback = createMockMediaRecorder("recording");

      const result = pauseRecording(
        recorder,
        true,
        false,
        true,
        null,
        micFallback,
      );

      expect(result).toBe(true);
      expect(micFallback.requestData).toHaveBeenCalled();
      expect(micFallback.state).toBe("paused");
    });

    it("skips webcam pause when webcam is not recording", () => {
      const webcam = createMockMediaRecorder("inactive");

      pauseRecording(recorder, true, false, false, webcam);

      expect(webcam.pause).not.toHaveBeenCalled();
    });
  });

  describe("resumeRecording", () => {
    it("resumes a paused recording", () => {
      recorder.pause();

      const result = resumeRecording(recorder, true, true, false);

      expect(result).toBe(true);
      expect(recorder.resume).toHaveBeenCalled();
      expect(recorder.state).toBe("recording");
    });

    it("does nothing when not paused", () => {
      const result = resumeRecording(recorder, true, false, false);

      expect(result).toBe(false);
      expect(recorder.resume).not.toHaveBeenCalled();
    });

    it("does nothing when not recording", () => {
      const result = resumeRecording(recorder, false, true, false);

      expect(result).toBe(false);
    });

    it("resumes webcam alongside browser recording", () => {
      const webcam = createMockMediaRecorder("recording");
      recorder.pause();
      webcam.pause();

      resumeRecording(recorder, true, true, false, webcam);

      expect(recorder.state).toBe("recording");
      expect(webcam.state).toBe("recording");
    });

    it("resumes webcam during native recording resume", () => {
      const webcam = createMockMediaRecorder("recording");
      webcam.pause();

      const result = resumeRecording(recorder, true, true, true, webcam);

      expect(result).toBe(true);
      expect(webcam.state).toBe("recording");
    });

    it("resumes browser mic fallback during native recording resume", () => {
      const micFallback = createMockMediaRecorder("recording");
      micFallback.pause();

      const result = resumeRecording(
        recorder,
        true,
        true,
        true,
        null,
        micFallback,
      );

      expect(result).toBe(true);
      expect(micFallback.state).toBe("recording");
    });

    it("skips webcam resume when webcam is not paused", () => {
      recorder.pause();
      const webcam = createMockMediaRecorder("inactive");

      resumeRecording(recorder, true, true, false, webcam);

      expect(webcam.resume).not.toHaveBeenCalled();
    });
  });

  describe("cancelRecording", () => {
    it("clears chunks and stops browser recording", () => {
      const chunks = { current: [new Blob(["data"])] };

      const result = cancelRecording(recorder, false, chunks);

      expect(result.cancelled).toBe(true);
      expect(result.wasNative).toBe(false);
      expect(chunks.current).toEqual([]);
      expect(recorder.stop).toHaveBeenCalled();
      expect(recorder.state).toBe("inactive");
    });

    it("clears webcam chunks and stops webcam on cancel", () => {
      const chunks = { current: [new Blob(["data"])] };
      const webcamChunks = { current: [new Blob(["cam"])] };
      const webcam = createMockMediaRecorder("recording");

      cancelRecording(recorder, false, chunks, webcam, webcamChunks);

      expect(webcamChunks.current).toEqual([]);
      expect(webcam.stop).toHaveBeenCalled();
      expect(webcam.state).toBe("inactive");
    });

    it("stops webcam when cancelling native recording", () => {
      const chunks = { current: [] as Blob[] };
      const webcam = createMockMediaRecorder("recording");

      const result = cancelRecording(recorder, true, chunks, webcam);

      expect(result.wasNative).toBe(true);
      expect(webcam.stop).toHaveBeenCalled();
      expect(recorder.stop).not.toHaveBeenCalled();
    });

    it("handles cancel when recorder is already inactive", () => {
      const inactiveRecorder = createMockMediaRecorder("inactive");
      const chunks = { current: [new Blob(["data"])] };

      const result = cancelRecording(inactiveRecorder, false, chunks);

      expect(result.cancelled).toBe(true);
      expect(chunks.current).toEqual([]);
      expect(inactiveRecorder.stop).not.toHaveBeenCalled();
    });

    it("handles cancel when webcam is already inactive", () => {
      const chunks = { current: [] as Blob[] };
      const webcam = createMockMediaRecorder("inactive");

      cancelRecording(recorder, false, chunks, webcam);

      expect(webcam.stop).not.toHaveBeenCalled();
    });
  });

  describe("pause → stop → editor flow", () => {
    it("record → pause → stop completes cleanly", () => {
      expect(recorder.state).toBe("recording");

      pauseRecording(recorder, true, false, false);
      expect(recorder.state).toBe("paused");

      const result = stopRecording(recorder, false);
      expect(result.stopped).toBe(true);
      expect(recorder.state).toBe("inactive");
    });

    it("record → pause → resume → stop completes cleanly", () => {
      expect(recorder.state).toBe("recording");

      pauseRecording(recorder, true, false, false);
      expect(recorder.state).toBe("paused");

      resumeRecording(recorder, true, true, false);
      expect(recorder.state).toBe("recording");

      const result = stopRecording(recorder, false);
      expect(result.stopped).toBe(true);
      expect(recorder.state).toBe("inactive");
    });

    it("webcam stays in sync through full pause/resume/stop cycle", () => {
      const webcam = createMockMediaRecorder("recording");

      pauseRecording(recorder, true, false, false, webcam);
      expect(recorder.state).toBe("paused");
      expect(webcam.state).toBe("paused");

      resumeRecording(recorder, true, true, false, webcam);
      expect(recorder.state).toBe("recording");
      expect(webcam.state).toBe("recording");

      stopRecording(recorder, false, webcam);
      expect(recorder.state).toBe("inactive");
      expect(webcam.state).toBe("inactive");
    });

    it("native recording pauses webcam only after native pause succeeds", async () => {
      const webcam = createMockMediaRecorder("recording");
      const micFallback = createMockMediaRecorder("recording");

      const pausedResult = await pauseNativeRecording(
        webcam,
        { success: true },
        micFallback,
      );
      expect(pausedResult).toBe(true);
      expect(webcam.state).toBe("paused");
      expect(micFallback.requestData).toHaveBeenCalled();
      expect(micFallback.state).toBe("paused");
      expect(recorder.pause).not.toHaveBeenCalled();

      const resumedResult = await resumeNativeRecording(
        webcam,
        { success: true },
        micFallback,
      );
      expect(resumedResult).toBe(true);
      expect(webcam.state).toBe("recording");
      expect(micFallback.state).toBe("recording");
      expect(recorder.resume).not.toHaveBeenCalled();
    });

    it("native recording leaves webcam state alone when native pause fails", async () => {
      const webcam = createMockMediaRecorder("recording");
      const micFallback = createMockMediaRecorder("recording");

      const pausedResult = await pauseNativeRecording(
        webcam,
        { success: false },
        micFallback,
      );

      expect(pausedResult).toBe(false);
      expect(webcam.state).toBe("recording");
      expect(webcam.pause).not.toHaveBeenCalled();
      expect(micFallback.state).toBe("recording");
      expect(micFallback.pause).not.toHaveBeenCalled();
    });

    it("stops native capture before awaiting webcam finalization", async () => {
      const callOrder: string[] = [];
      let resolveWebcam: (path: string | null) => void = () => {};
      const webcamPathPromise = new Promise<string | null>((resolve) => {
        resolveWebcam = resolve;
      });
      const stopWebcamRecorder = vi.fn(() => {
        callOrder.push("stop-webcam-started");
        return webcamPathPromise;
      });
      const stopNativeScreenRecording = vi.fn(async () => {
        callOrder.push("stop-native");
        return { success: true, path: "screen.mp4" };
      });
      const markRecordingResumed = vi.fn((timestampMs: number) => {
        callOrder.push(`mark-resumed-${timestampMs}`);
      });
      const getRecordingDurationMs = vi.fn((timestampMs: number) => {
        callOrder.push(`duration-${timestampMs}`);
        return 35000;
      });

      let finalized = false;
      const stopped = stopNativeRecordingWithCompanions({
        getRecordingDurationMs,
        markRecordingResumed,
        now: () => 123456,
        stopMicFallbackRecorder: vi.fn(async () => null),
        stopNativeScreenRecording,
        stopWebcamRecorder,
      }).then((result) => {
        finalized = true;
        return result;
      });

      await Promise.resolve();
      expect(callOrder).toEqual([
        "mark-resumed-123456",
        "duration-123456",
        "stop-webcam-started",
        "stop-native",
      ]);
      expect(finalized).toBe(false);

      resolveWebcam("webcam.webm");
      await expect(stopped).resolves.toMatchObject({
        expectedDurationMs: 35000,
        webcamPath: "webcam.webm",
      });
    });

    it("cancel discards both screen and webcam recordings", () => {
      const webcam = createMockMediaRecorder("recording");
      const chunks = { current: [new Blob(["screen"])] };
      const webcamChunks = { current: [new Blob(["cam"])] };

      cancelRecording(recorder, false, chunks, webcam, webcamChunks);

      expect(chunks.current).toEqual([]);
      expect(webcamChunks.current).toEqual([]);
      expect(recorder.state).toBe("inactive");
      expect(webcam.state).toBe("inactive");
    });
  });
});
