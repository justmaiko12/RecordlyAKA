import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("mac native capture lifecycle", () => {
  let appendRecordingEventLogEntryMock: ReturnType<typeof vi.fn>;
  let emitRecordingInterruptedMock: ReturnType<typeof vi.fn>;
  let recordNativeCaptureDiagnosticsMock: ReturnType<typeof vi.fn>;
  let writeRecordingDiagnosticsSnapshotMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    appendRecordingEventLogEntryMock = vi.fn(async () => ({
      logPath: "/tmp/log.jsonl",
    }));
    emitRecordingInterruptedMock = vi.fn();
    recordNativeCaptureDiagnosticsMock = vi.fn();
    writeRecordingDiagnosticsSnapshotMock = vi.fn(async () => "/tmp/diag.json");

    vi.resetModules();
    vi.doMock("electron", () => ({
      app: {
        getPath: () => "/tmp/recordly-test-user-data",
      },
      BrowserWindow: {
        getAllWindows: () => [],
      },
    }));
    vi.doMock("./diagnostics", () => ({
      getFileSizeIfPresent: vi.fn(async () => 1024),
      recordNativeCaptureDiagnostics: recordNativeCaptureDiagnosticsMock,
      validateRecordedVideo: vi.fn(async () => ({
        fileSizeBytes: 1024,
        durationSeconds: 1,
      })),
      writeRecordingDiagnosticsSnapshot: writeRecordingDiagnosticsSnapshotMock,
    }));
    vi.doMock("./events", () => ({
      emitRecordingInterrupted: emitRecordingInterruptedMock,
    }));
    vi.doMock("./recordingEventLog", () => ({
      appendRecordingEventLogEntry: appendRecordingEventLogEntryMock,
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    vi.doUnmock("electron");
    vi.doUnmock("./diagnostics");
    vi.doUnmock("./events");
    vi.doUnmock("./recordingEventLog");
    vi.doUnmock("./sourceAudioSync");
  });

  function createNativeProcessStub() {
    const process = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    process.stdout = new EventEmitter();
    process.stderr = new EventEmitter();
    return process;
  }

  it("keeps native webcam path after startup only when webcam did not fail close", async () => {
    const { resolveNativeWebcamPathAfterStart } = await import("./mac");
    const webcamPath = "/tmp/recording-123-webcam.mp4";

    expect(
      resolveNativeWebcamPathAfterStart({
        webcamOutputPath: webcamPath,
        nativeWebcamFailClosed: false,
      }),
    ).toBe(webcamPath);
    expect(
      resolveNativeWebcamPathAfterStart({
        webcamOutputPath: webcamPath,
        nativeWebcamFailClosed: true,
      }),
    ).toBeNull();
  });

  it("propagates companion mic audio sync failures during finalization", async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "recordly-mac-audio-"),
    );
    const videoPath = path.join(tempDir, "recording-123.mp4");
    const micPath = path.join(tempDir, "recording-123.mic.m4a");
    const repairError = new Error("unsafe mic audio drift");
    const repairCompanionMock = vi.fn(async () => {
      throw repairError;
    });

    vi.doMock("./sourceAudioSync", () => ({
      repairRecordingCompanionAudioSyncIfNeeded: repairCompanionMock,
      repairRecordingSourceAudioSyncIfNeeded: vi.fn(async () => undefined),
    }));

    await fs.writeFile(micPath, "mic");
    const { muxNativeMacRecordingWithAudio } = await import("./mac");

    await expect(
      muxNativeMacRecordingWithAudio(videoPath, null, micPath),
    ).rejects.toThrow("unsafe mic audio drift");
    expect(repairCompanionMock).toHaveBeenCalledWith({
      videoPath,
      audioPath: micPath,
      trackKind: "mic",
    });

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("rejects finalization when an expected companion mic file is missing", async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "recordly-mac-audio-"),
    );
    const videoPath = path.join(tempDir, "recording-123.mp4");
    const micPath = path.join(tempDir, "recording-123.mic.m4a");
    const repairCompanionMock = vi.fn(async () => undefined);

    vi.doMock("./sourceAudioSync", () => ({
      repairRecordingCompanionAudioSyncIfNeeded: repairCompanionMock,
      repairRecordingSourceAudioSyncIfNeeded: vi.fn(async () => undefined),
    }));

    const { muxNativeMacRecordingWithAudio } = await import("./mac");

    await expect(
      muxNativeMacRecordingWithAudio(videoPath, null, micPath),
    ).rejects.toThrow(
      `Expected native mic audio sidecar was missing: ${micPath}`,
    );
    expect(repairCompanionMock).not.toHaveBeenCalled();
    expect(appendRecordingEventLogEntryMock).toHaveBeenCalledWith({
      recordingsDir: tempDir,
      sessionId: "123",
      event: "recording-companion-audio-missing",
      details: {
        videoPath,
        audioPath: micPath,
        trackKind: "mic",
        reason: "missing-file",
      },
    });

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("recognizes only complete native webcam proof-preview evidence", async () => {
    const {
      getFirstAcceptedWebcamProofPreviewEvidence,
      getFirstVisibleWebcamFrameEvidence,
      hasAcceptedWebcamProofPreviewEvidence,
    } = await import("./mac");

    expect(
      hasAcceptedWebcamProofPreviewEvidence("WEBCAM_PROOF_PREVIEW_ACCEPTED\n"),
    ).toBe(false);
    expect(
      getFirstAcceptedWebcamProofPreviewEvidence(
        "WEBCAM_PROOF_PREVIEW_ACCEPTED\n",
      ),
    ).toBe(null);
    expect(
      hasAcceptedWebcamProofPreviewEvidence(
        "WEBCAM_PROOF_PREVIEW_ACCEPTED sequence=0 acceptedFrame=2 acceptedPts=0.033\n",
      ),
    ).toBe(false);
    expect(
      hasAcceptedWebcamProofPreviewEvidence(
        "WEBCAM_PROOF_PREVIEW_ACCEPTED sequence=1 acceptedFrame=0 acceptedPts=0.033\n",
      ),
    ).toBe(false);
    expect(
      hasAcceptedWebcamProofPreviewEvidence(
        "WEBCAM_PROOF_PREVIEW_ACCEPTED sequence=1 acceptedFrame=2 acceptedPts=-0.033\n",
      ),
    ).toBe(false);
    expect(
      hasAcceptedWebcamProofPreviewEvidence(
        "WEBCAM_PROOF_PREVIEW_ACCEPTED sequence=1 acceptedFrame=2 acceptedPts=0\n",
      ),
    ).toBe(true);
    expect(
      getFirstAcceptedWebcamProofPreviewEvidence(
        "ignored\nWEBCAM_PROOF_PREVIEW_ACCEPTED sequence=3 acceptedFrame=12 acceptedPts=0.367\n",
      ),
    ).toEqual({
      acceptedFrame: 12,
      acceptedPts: 0.367,
      sequence: 3,
    });
    expect(
      getFirstVisibleWebcamFrameEvidence(
        "ignored\nWEBCAM_FIRST_VISIBLE_FRAME_WRITTEN frames=102 pts=3.40002 averageLuma=4.0 maxLuma=10\n",
      ),
    ).toEqual({
      frames: 102,
      pts: 3.40002,
    });
    expect(
      getFirstVisibleWebcamFrameEvidence(
        "WEBCAM_FIRST_VISIBLE_FRAME_WRITTEN frames=0 pts=0.033\n",
      ),
    ).toBeNull();
  });

  it("measures hidden native webcam startup skew from gate and proof-preview host times", async () => {
    const { getNativeCaptureStartLeadMs, getNativeWebcamStartOffsetMs } =
      await import("./mac");

    const output = [
      "CAPTURE_GATE_OPENED capturesWebcam=true hostTime=100.000",
      "VIDEO_FIRST_FRAME_WRITTEN frames=1 pts=0",
      "WEBCAM_FIRST_FRAME_WRITTEN frames=1 pts=0",
      "WEBCAM_FIRST_VISIBLE_FRAME_WRITTEN frames=4 pts=0.100 averageLuma=16 maxLuma=88",
      'WEBCAM_PREVIEW_FRAME_WRITTEN path="/tmp/preview-1.jpg" bytes=2000 hostTime=100.650 sequence=1 acceptedFrame=1 acceptedPts=0',
      "WEBCAM_PROOF_PREVIEW_ACCEPTED sequence=1 acceptedFrame=1 acceptedPts=0",
      'WEBCAM_PREVIEW_FRAME_WRITTEN path="/tmp/preview-2.jpg" bytes=2400 hostTime=100.780 sequence=2 acceptedFrame=4 acceptedPts=0.100',
      "WEBCAM_PROOF_PREVIEW_ACCEPTED sequence=2 acceptedFrame=4 acceptedPts=0.100",
    ].join("\n");

    expect(getNativeWebcamStartOffsetMs(output)).toBe(680);
    expect(getNativeCaptureStartLeadMs(output)).toBe(780);
  });

  it("does not report native capture as started until a screen frame is written", async () => {
    const state = await import("../state");
    const { waitForNativeCaptureStart } = await import("./mac");
    const process = createNativeProcessStub();
    state.setNativeCaptureOutputBuffer("");

    let resolved = false;
    const started = waitForNativeCaptureStart(process as never, {
      timeoutMs: 1000,
    }).then(() => {
      resolved = true;
    });

    process.stdout.emit("data", Buffer.from("Recording started\n"));
    await Promise.resolve();
    expect(resolved).toBe(false);

    process.stderr.emit(
      "data",
      Buffer.from("VIDEO_FIRST_FRAME_WRITTEN frames=1 pts=0\n"),
    );
    await expect(started).resolves.toBeUndefined();
    expect(resolved).toBe(true);
  });

  it("requires native webcam visible-frame evidence when webcam capture is enabled", async () => {
    const state = await import("../state");
    const { waitForNativeCaptureStart } = await import("./mac");
    const process = createNativeProcessStub();
    state.setNativeCaptureOutputBuffer("");

    let resolved = false;
    const started = waitForNativeCaptureStart(process as never, {
      requiresWebcamFirstFrame: true,
      timeoutMs: 1000,
    }).then(() => {
      resolved = true;
    });

    process.stdout.emit("data", Buffer.from("Recording started\n"));
    process.stderr.emit(
      "data",
      Buffer.from("VIDEO_FIRST_FRAME_WRITTEN frames=1 pts=0\n"),
    );
    await Promise.resolve();
    expect(resolved).toBe(false);

    process.stderr.emit(
      "data",
      Buffer.from("WEBCAM_FIRST_FRAME_WRITTEN frames=1 pts=0\n"),
    );
    await Promise.resolve();
    expect(resolved).toBe(false);

    process.stderr.emit(
      "data",
      Buffer.from(
        "WEBCAM_FIRST_VISIBLE_FRAME_WRITTEN frames=2 pts=0.033 averageLuma=12.5 maxLuma=88\n",
      ),
    );
    await expect(started).resolves.toBeUndefined();
    expect(resolved).toBe(true);
  });

  it("does not report native webcam proof-preview startup from malformed evidence", async () => {
    const state = await import("../state");
    const { waitForNativeCaptureStart } = await import("./mac");
    const process = createNativeProcessStub();
    state.setNativeCaptureOutputBuffer("");

    let resolved = false;
    const started = waitForNativeCaptureStart(process as never, {
      requiresWebcamFirstFrame: true,
      requiresWebcamProofPreview: true,
      timeoutMs: 1000,
    }).then(() => {
      resolved = true;
    });

    process.stdout.emit("data", Buffer.from("Recording started\n"));
    process.stderr.emit(
      "data",
      Buffer.from("VIDEO_FIRST_FRAME_WRITTEN frames=1 pts=0\n"),
    );
    process.stderr.emit(
      "data",
      Buffer.from(
        "WEBCAM_FIRST_VISIBLE_FRAME_WRITTEN frames=2 pts=0.033 averageLuma=12.5 maxLuma=88\n",
      ),
    );
    process.stderr.emit("data", Buffer.from("WEBCAM_PROOF_PREVIEW_ACCEPTED\n"));
    await Promise.resolve();
    expect(resolved).toBe(false);

    process.stderr.emit(
      "data",
      Buffer.from(
        "WEBCAM_PROOF_PREVIEW_ACCEPTED sequence=1 acceptedFrame=2 acceptedPts=0.033\n",
      ),
    );
    await expect(started).resolves.toBeUndefined();
    expect(resolved).toBe(true);
  });

  it("requires native microphone audio proof when microphone capture is enabled", async () => {
    const state = await import("../state");
    const { waitForNativeCaptureStart } = await import("./mac");
    const process = createNativeProcessStub();
    state.setNativeCaptureOutputBuffer("");

    let resolved = false;
    const started = waitForNativeCaptureStart(process as never, {
      requiresMicrophoneAudio: true,
      timeoutMs: 1000,
    }).then(() => {
      resolved = true;
    });

    process.stdout.emit("data", Buffer.from("Recording started\n"));
    process.stderr.emit(
      "data",
      Buffer.from("VIDEO_FIRST_FRAME_WRITTEN frames=1 pts=0\n"),
    );
    await Promise.resolve();
    expect(resolved).toBe(false);

    process.stderr.emit(
      "data",
      Buffer.from(
        "MICROPHONE_AUDIO_FIRST_BUFFER_WRITTEN buffers=1 pts=0 duration=0.023\n",
      ),
    );
    await expect(started).resolves.toBeUndefined();
    expect(resolved).toBe(true);
  });

  it("allows native microphone unavailable startup so the browser fallback can take over", async () => {
    const state = await import("../state");
    const { waitForNativeCaptureStart } = await import("./mac");
    const process = createNativeProcessStub();
    state.setNativeCaptureOutputBuffer("");

    const started = waitForNativeCaptureStart(process as never, {
      requiresMicrophoneAudio: true,
      timeoutMs: 1000,
    });

    process.stdout.emit("data", Buffer.from("Recording started\n"));
    process.stderr.emit(
      "data",
      Buffer.from("VIDEO_FIRST_FRAME_WRITTEN frames=1 pts=0\n"),
    );
    process.stderr.emit(
      "data",
      Buffer.from("MICROPHONE_CAPTURE_UNAVAILABLE\n"),
    );

    await expect(started).resolves.toBeUndefined();
  });

  it("times out when requested native microphone capture never writes audio", async () => {
    vi.useFakeTimers();
    const state = await import("../state");
    const { waitForNativeCaptureStart } = await import("./mac");
    const process = createNativeProcessStub();
    state.setNativeCaptureOutputBuffer("");

    const started = waitForNativeCaptureStart(process as never, {
      requiresMicrophoneAudio: true,
      timeoutMs: 1000,
    });

    process.stdout.emit("data", Buffer.from("Recording started\n"));
    process.stderr.emit(
      "data",
      Buffer.from("VIDEO_FIRST_FRAME_WRITTEN frames=1 pts=0\n"),
    );

    const expectation = expect(started).rejects.toThrow(
      "Timed out waiting for native screen and microphone audio frames to be written",
    );
    await vi.advanceTimersByTimeAsync(1000);
    await expectation;
  });

  it("requires native webcam proof-preview evidence when requested", async () => {
    const state = await import("../state");
    const { waitForNativeCaptureStart } = await import("./mac");
    const process = createNativeProcessStub();
    state.setNativeCaptureOutputBuffer("");

    let resolved = false;
    const started = waitForNativeCaptureStart(process as never, {
      requiresWebcamFirstFrame: true,
      requiresWebcamProofPreview: true,
      timeoutMs: 1000,
    }).then(() => {
      resolved = true;
    });

    process.stdout.emit("data", Buffer.from("Recording started\n"));
    process.stderr.emit(
      "data",
      Buffer.from("VIDEO_FIRST_FRAME_WRITTEN frames=1 pts=0\n"),
    );
    process.stderr.emit(
      "data",
      Buffer.from(
        "WEBCAM_FIRST_VISIBLE_FRAME_WRITTEN frames=2 pts=0.033 averageLuma=12.5 maxLuma=88\n",
      ),
    );
    await Promise.resolve();
    expect(resolved).toBe(false);

    process.stderr.emit(
      "data",
      Buffer.from(
        "WEBCAM_PREVIEW_FRAME_WRITTEN path=/tmp/recording-preview.jpg bytes=12345 hostTime=456.7 sequence=1 acceptedFrame=2 acceptedPts=0.033\n",
      ),
    );
    await Promise.resolve();
    expect(resolved).toBe(false);

    process.stderr.emit(
      "data",
      Buffer.from(
        "WEBCAM_PROOF_PREVIEW_ACCEPTED sequence=1 acceptedFrame=2 acceptedPts=0.033\n",
      ),
    );
    await expect(started).resolves.toBeUndefined();
    expect(resolved).toBe(true);
  });

  it("accepts webcam proof-preview startup inside the preview handoff re-proof window", async () => {
    const state = await import("../state");
    const { waitForNativeCaptureStart } = await import("./mac");
    const process = createNativeProcessStub();
    state.setNativeCaptureOutputBuffer("");

    const started = waitForNativeCaptureStart(process as never, {
      maxInitialWebcamProofAcceptedPtsSeconds: 3,
      requiresWebcamFirstFrame: true,
      requiresWebcamProofPreview: true,
      timeoutMs: 1000,
    });

    process.stdout.emit("data", Buffer.from("Recording started\n"));
    process.stderr.emit(
      "data",
      Buffer.from("VIDEO_FIRST_FRAME_WRITTEN frames=1 pts=0\n"),
    );
    process.stderr.emit(
      "data",
      Buffer.from(
        "WEBCAM_FIRST_VISIBLE_FRAME_WRITTEN frames=2 pts=0.033 averageLuma=12.5 maxLuma=88\n",
      ),
    );
    process.stderr.emit(
      "data",
      Buffer.from(
        "WEBCAM_PROOF_PREVIEW_ACCEPTED sequence=1 acceptedFrame=2 acceptedPts=3\n",
      ),
    );

    await expect(started).resolves.toBeUndefined();
  });

  it("rejects webcam proof-preview startup outside the preview handoff re-proof window", async () => {
    const state = await import("../state");
    const { waitForNativeCaptureStart } = await import("./mac");
    const process = createNativeProcessStub();
    state.setNativeCaptureOutputBuffer("");

    const started = waitForNativeCaptureStart(process as never, {
      maxInitialWebcamProofAcceptedPtsSeconds: 3,
      requiresWebcamFirstFrame: true,
      requiresWebcamProofPreview: true,
      timeoutMs: 1000,
    });

    process.stdout.emit("data", Buffer.from("Recording started\n"));
    process.stderr.emit(
      "data",
      Buffer.from("VIDEO_FIRST_FRAME_WRITTEN frames=1 pts=0\n"),
    );
    process.stderr.emit(
      "data",
      Buffer.from(
        "WEBCAM_FIRST_VISIBLE_FRAME_WRITTEN frames=2 pts=0.033 averageLuma=12.5 maxLuma=88\n",
      ),
    );
    process.stderr.emit(
      "data",
      Buffer.from(
        "WEBCAM_PROOF_PREVIEW_ACCEPTED sequence=1 acceptedFrame=2 acceptedPts=3.25\n",
      ),
    );

    await expect(started).rejects.toThrow(
      "Native webcam proof preview started too late after preview handoff",
    );
  });

  it("rejects webcam startup when visible video is late after preview handoff", async () => {
    const state = await import("../state");
    const { waitForNativeCaptureStart } = await import("./mac");
    const process = createNativeProcessStub();
    state.setNativeCaptureOutputBuffer("");

    const started = waitForNativeCaptureStart(process as never, {
      maxInitialWebcamProofAcceptedPtsSeconds: 3,
      maxInitialWebcamVisiblePtsSeconds: 3,
      requiresWebcamFirstFrame: true,
      requiresWebcamProofPreview: true,
      timeoutMs: 1000,
    });

    process.stdout.emit("data", Buffer.from("Recording started\n"));
    process.stderr.emit(
      "data",
      Buffer.from("VIDEO_FIRST_FRAME_WRITTEN frames=1 pts=0\n"),
    );
    process.stderr.emit(
      "data",
      Buffer.from(
        "WEBCAM_PROOF_PREVIEW_ACCEPTED sequence=1 acceptedFrame=2 acceptedPts=0\n",
      ),
    );
    process.stderr.emit(
      "data",
      Buffer.from(
        "WEBCAM_FIRST_VISIBLE_FRAME_WRITTEN frames=102 pts=3.40002 averageLuma=4.0 maxLuma=10\n",
      ),
    );

    await expect(started).rejects.toThrow(
      "Native webcam visible video started too late after preview handoff",
    );
  });

  it("accepts parser-appended proof-preview evidence from the shared output buffer", async () => {
    const state = await import("../state");
    const { waitForNativeCaptureStart } = await import("./mac");
    const process = createNativeProcessStub();
    state.setNativeCaptureOutputBuffer("");
    process.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      state.appendNativeCaptureOutputBuffer(text);
      if (text.includes("WEBCAM_PREVIEW_FRAME_WRITTEN")) {
        state.appendNativeCaptureOutputBuffer(
          "WEBCAM_PROOF_PREVIEW_ACCEPTED sequence=1 acceptedFrame=2 acceptedPts=0.033\n",
        );
      }
    });

    let resolved = false;
    const started = waitForNativeCaptureStart(process as never, {
      requiresWebcamFirstFrame: true,
      requiresWebcamProofPreview: true,
      timeoutMs: 1000,
    }).then(() => {
      resolved = true;
    });

    process.stdout.emit("data", Buffer.from("Recording started\n"));
    process.stderr.emit(
      "data",
      Buffer.from("VIDEO_FIRST_FRAME_WRITTEN frames=1 pts=0\n"),
    );
    process.stderr.emit(
      "data",
      Buffer.from(
        "WEBCAM_FIRST_VISIBLE_FRAME_WRITTEN frames=2 pts=0.033 averageLuma=12.5 maxLuma=88\n",
      ),
    );
    process.stderr.emit(
      "data",
      Buffer.from(
        "WEBCAM_PREVIEW_FRAME_WRITTEN path=/tmp/recording-preview.jpg bytes=12345 hostTime=456.7 sequence=1 acceptedFrame=2 acceptedPts=0.033\n",
      ),
    );

    await expect(started).resolves.toBeUndefined();
    expect(resolved).toBe(true);
  });

  it("times out when native webcam proof-preview evidence never arrives", async () => {
    vi.useFakeTimers();
    const state = await import("../state");
    const { waitForNativeCaptureStart } = await import("./mac");
    const process = createNativeProcessStub();
    state.setNativeCaptureOutputBuffer("");

    const started = waitForNativeCaptureStart(process as never, {
      requiresWebcamFirstFrame: true,
      requiresWebcamProofPreview: true,
      timeoutMs: 1000,
    });

    process.stdout.emit("data", Buffer.from("Recording started\n"));
    process.stderr.emit(
      "data",
      Buffer.from("VIDEO_FIRST_FRAME_WRITTEN frames=1 pts=0\n"),
    );
    process.stderr.emit(
      "data",
      Buffer.from(
        "WEBCAM_FIRST_VISIBLE_FRAME_WRITTEN frames=2 pts=0.033 averageLuma=12.5 maxLuma=88\n",
      ),
    );

    const expectation = expect(started).rejects.toThrow(
      "Timed out waiting for native screen, visible webcam, and proof-preview frames to be written",
    );
    await vi.advanceTimersByTimeAsync(1000);
    await expectation;
  });

  it("reports blank webcam frames when proof-preview exists but no visible frame arrives", async () => {
    vi.useFakeTimers();
    const state = await import("../state");
    const { waitForNativeCaptureStart } = await import("./mac");
    const process = createNativeProcessStub();
    state.setNativeCaptureOutputBuffer("");

    const started = waitForNativeCaptureStart(process as never, {
      requiresWebcamFirstFrame: true,
      requiresWebcamProofPreview: true,
      timeoutMs: 1000,
    });

    process.stdout.emit("data", Buffer.from("Recording started\n"));
    process.stderr.emit(
      "data",
      Buffer.from("VIDEO_FIRST_FRAME_WRITTEN frames=1 pts=0\n"),
    );
    process.stderr.emit(
      "data",
      Buffer.from("WEBCAM_FIRST_FRAME_WRITTEN frames=1 pts=0\n"),
    );
    process.stderr.emit(
      "data",
      Buffer.from(
        "WEBCAM_PROOF_PREVIEW_ACCEPTED sequence=1 acceptedFrame=1 acceptedPts=0\n",
      ),
    );

    const expectation = expect(started).rejects.toThrow(
      "Selected webcam is delivering blank frames",
    );
    await vi.advanceTimersByTimeAsync(1000);
    await expectation;
  });

  it("rejects native startup when webcam fails before the first written frame", async () => {
    const state = await import("../state");
    const { waitForNativeCaptureStart } = await import("./mac");
    const process = createNativeProcessStub();
    state.setNativeCaptureOutputBuffer("");

    const started = waitForNativeCaptureStart(process as never, {
      requiresWebcamFirstFrame: true,
      timeoutMs: 1000,
    });

    process.stdout.emit("data", Buffer.from("Recording started\n"));
    process.stderr.emit(
      "data",
      Buffer.from("VIDEO_FIRST_FRAME_WRITTEN frames=1 pts=0\n"),
    );
    process.stderr.emit(
      "data",
      Buffer.from(
        "WEBCAM_PIPELINE_STALLED reason=webcam-no-first-frame action=stop-recording\n",
      ),
    );

    await expect(started).rejects.toThrow(
      "Native webcam capture failed before writing a first frame",
    );
  });

  it("preserves recovery paths when the helper exits unexpectedly", async () => {
    const state = await import("../state");
    const { attachNativeCaptureLifecycle } = await import("./mac");
    const process = new EventEmitter() as never;

    state.setSelectedSource({ id: "screen:1", name: "Built-in Display" });
    state.setNativeScreenRecordingActive(true);
    state.setNativeCaptureStopRequested(false);
    state.setNativeCaptureTargetPath("/tmp/recording-123.mp4");
    state.setNativeCaptureSystemAudioPath("/tmp/recording-123.system.m4a");
    state.setNativeCaptureMicrophonePath("/tmp/recording-123.mic.m4a");
    state.setNativeCaptureOutputBuffer(
      "VIDEO_PIPELINE_STALLED reason=writer-lag lag=6 stalledFor=5",
    );

    attachNativeCaptureLifecycle(process);
    (process as EventEmitter).emit("close", 1);
    await Promise.resolve();
    await Promise.resolve();

    expect(state.nativeScreenRecordingActive).toBe(false);
    expect(state.nativeCaptureTargetPath).toBe("/tmp/recording-123.mp4");
    expect(state.nativeCaptureSystemAudioPath).toBe(
      "/tmp/recording-123.system.m4a",
    );
    expect(state.nativeCaptureMicrophonePath).toBe(
      "/tmp/recording-123.mic.m4a",
    );
    expect(state.nativeCaptureStopRequested).toBe(false);
    expect(emitRecordingInterruptedMock).toHaveBeenCalledWith(
      "video-pipeline-stalled",
      "Screen recording stalled and was stopped to prevent a corrupted timeline.",
    );
    expect(appendRecordingEventLogEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        recordingsDir: "/tmp",
        sessionId: "123",
        event: "native-helper-exited-unexpectedly",
        details: expect.objectContaining({
          reason: "video-pipeline-stalled",
          code: 1,
          outputPath: "/tmp/recording-123.mp4",
          processOutput:
            "VIDEO_PIPELINE_STALLED reason=writer-lag lag=6 stalledFor=5",
        }),
      }),
    );
    expect(writeRecordingDiagnosticsSnapshotMock).toHaveBeenCalledWith(
      "/tmp/recording-123.mp4",
      expect.objectContaining({
        backend: "mac-screencapturekit",
        phase: "stop",
        outputPath: "/tmp/recording-123.mp4",
        systemAudioPath: "/tmp/recording-123.system.m4a",
        microphonePath: "/tmp/recording-123.mic.m4a",
        processOutput:
          "VIDEO_PIPELINE_STALLED reason=writer-lag lag=6 stalledFor=5",
        error:
          "Screen recording stalled and was stopped to prevent a corrupted timeline.",
        details: expect.objectContaining({
          unexpectedHelperClose: true,
          reason: "video-pipeline-stalled",
          code: 1,
        }),
      }),
    );
    expect(recordNativeCaptureDiagnosticsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: "mac-screencapturekit",
        phase: "stop",
        outputPath: "/tmp/recording-123.mp4",
        error:
          "Screen recording stalled and was stopped to prevent a corrupted timeline.",
      }),
    );
  });

  it.each([
    "WEBCAM_CAPTURE_DISABLED reason=main-webcam-stats-timeout staleForMs=15000",
    "WEBCAM_CAPTURE_FAIL_CLOSED reason=native-webcam-capture-disabled",
  ])(
    "reports webcam fail-closed exits as webcam pipeline stalls: %s",
    async (processOutput) => {
      const state = await import("../state");
      const { attachNativeCaptureLifecycle } = await import("./mac");
      const process = new EventEmitter() as never;

      state.setSelectedSource({ id: "screen:1", name: "Built-in Display" });
      state.setNativeScreenRecordingActive(true);
      state.setNativeCaptureStopRequested(false);
      state.setNativeCaptureTargetPath("/tmp/recording-456.mp4");
      state.setNativeCaptureSystemAudioPath(null);
      state.setNativeCaptureMicrophonePath(null);
      state.setNativeCaptureOutputBuffer(processOutput);

      attachNativeCaptureLifecycle(process);
      (process as EventEmitter).emit("close", 0);
      await Promise.resolve();
      await Promise.resolve();

      expect(state.nativeScreenRecordingActive).toBe(false);
      expect(emitRecordingInterruptedMock).toHaveBeenCalledWith(
        "webcam-pipeline-stalled",
        "Webcam recording stalled and was stopped to prevent frozen facecam footage.",
      );
      expect(appendRecordingEventLogEntryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          recordingsDir: "/tmp",
          sessionId: "456",
          event: "native-helper-exited-unexpectedly",
          details: expect.objectContaining({
            reason: "webcam-pipeline-stalled",
            code: 0,
            outputPath: "/tmp/recording-456.mp4",
            processOutput,
          }),
        }),
      );
      expect(recordNativeCaptureDiagnosticsMock).toHaveBeenCalledWith(
        expect.objectContaining({
          backend: "mac-screencapturekit",
          phase: "stop",
          outputPath: "/tmp/recording-456.mp4",
          error:
            "Webcam recording stalled and was stopped to prevent frozen facecam footage.",
        }),
      );
    },
  );
});
