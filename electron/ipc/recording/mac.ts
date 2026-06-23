import type { ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { BrowserWindow } from "electron";
import {
  persistPendingCursorTelemetry,
  snapshotCursorTelemetryForPersistence,
} from "../cursor/telemetry";
import {
  lastNativeCaptureDiagnostics,
  nativeCaptureMicrophonePath,
  nativeCaptureOutputBuffer,
  nativeCaptureStopRequested,
  nativeCaptureSystemAudioPath,
  nativeCaptureTargetPath,
  nativeCaptureWebcamPath,
  nativeScreenRecordingActive,
  selectedSource,
  setCurrentProjectPath,
  setCurrentVideoPath,
  setNativeCaptureProcess,
  setNativeCaptureStopRequested,
  setNativeScreenRecordingActive,
} from "../state";
import {
  getRecordingsDir,
  isAutoRecordingPath,
  moveFileWithOverwrite,
} from "../utils";
import {
  getFileSizeIfPresent,
  recordNativeCaptureDiagnostics,
  validateRecordedVideo,
  writeRecordingDiagnosticsSnapshot,
} from "./diagnostics";
import { emitRecordingInterrupted } from "./events";
import { getFinalMacCompanionAudioPath } from "./macCompanionAudio";
import {
  findMacRecoveryCandidates,
  markMacRecoveryManifestFailed,
  markMacRecoveryManifestFinalized,
} from "./macRecoveryManifest";
import {
  resolveValidatedNativeWebcamPath,
  validateNativeScreenRecordingIntegrity,
} from "./nativeIntegrity";
import { pruneAutoRecordings } from "./prune";
import { appendRecordingEventLogEntry } from "./recordingEventLog";
import { persistSceneStyleEvents } from "./sceneStyleEvents";
import {
  repairRecordingCompanionAudioSyncIfNeeded,
  repairRecordingSourceAudioSyncIfNeeded,
} from "./sourceAudioSync";
import { persistWebcamLayoutEvents } from "./webcamLayoutEvents";

type NativeRecordingRecoveryAudit = (videoPath: string) => Promise<unknown>;

export const NATIVE_WEBCAM_PREVIEW_HANDOFF_REPROOF_SECONDS = 3;

function getRecordingSessionIdForVideoPath(videoPath: string) {
  const baseName = path.basename(videoPath, path.extname(videoPath));
  return baseName.startsWith("recording-")
    ? baseName.slice("recording-".length)
    : baseName;
}

export interface NativeCaptureStartWaitOptions {
  maxInitialWebcamProofAcceptedPtsSeconds?: number;
  maxInitialWebcamVisiblePtsSeconds?: number;
  requiresMicrophoneAudio?: boolean;
  requiresWebcamFirstFrame?: boolean;
  requiresWebcamProofPreview?: boolean;
  timeoutMs?: number;
}

export interface MicrophoneAudioBufferEvidence {
  buffers: number;
  pts: number;
  duration: number;
}

export interface AcceptedWebcamProofPreviewEvidence {
  acceptedFrame: number;
  acceptedPts: number;
  sequence: number;
}

export interface VisibleWebcamFrameEvidence {
  frames: number;
  pts: number;
}

type NativeWebcamProofFrame = {
  acceptedFrame: number;
  acceptedPts: number;
  sequence: number;
};

type NativeWebcamPreviewProofFrame = NativeWebcamProofFrame & {
  hostTime: number;
};

export function resolveNativeWebcamPathAfterStart({
  webcamOutputPath,
  nativeWebcamFailClosed,
}: {
  webcamOutputPath: string | null;
  nativeWebcamFailClosed: boolean;
}) {
  return nativeWebcamFailClosed ? null : webcamOutputPath;
}

function readPositiveIntField(line: string, field: string) {
  const match = line.match(new RegExp(`\\b${field}=(\\d+)\\b`));
  if (!match) {
    return null;
  }
  const value = Number.parseInt(match[1] ?? "", 10);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function readNonNegativeNumberField(line: string, field: string) {
  const match = line.match(new RegExp(`\\b${field}=(-?\\d+(?:\\.\\d+)?)\\b`));
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function getFirstAcceptedWebcamProofPreviewEvidence(
  output: string,
): AcceptedWebcamProofPreviewEvidence | null {
  for (const line of output.split(/\r?\n/)) {
    if (!line.includes("WEBCAM_PROOF_PREVIEW_ACCEPTED")) {
      continue;
    }
    const sequence = readPositiveIntField(line, "sequence");
    const acceptedFrame = readPositiveIntField(line, "acceptedFrame");
    const acceptedPts = readNonNegativeNumberField(line, "acceptedPts");
    if (sequence !== null && acceptedFrame !== null && acceptedPts !== null) {
      return { acceptedFrame, acceptedPts, sequence };
    }
  }
  return null;
}

export function hasAcceptedWebcamProofPreviewEvidence(output: string) {
  return getFirstAcceptedWebcamProofPreviewEvidence(output) !== null;
}

function numbersNearlyEqual(left: number, right: number) {
  return Math.abs(left - right) <= 0.001;
}

function getCaptureGateHostTime(output: string) {
  for (const line of output.split(/\r?\n/)) {
    if (!line.includes("CAPTURE_GATE_OPENED")) {
      continue;
    }
    const hostTime = readNonNegativeNumberField(line, "hostTime");
    if (hostTime !== null) {
      return hostTime;
    }
  }
  return null;
}

function getAcceptedWebcamProofPreviewFrames(
  output: string,
): NativeWebcamProofFrame[] {
  const frames: NativeWebcamProofFrame[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.includes("WEBCAM_PROOF_PREVIEW_ACCEPTED")) {
      continue;
    }
    const sequence = readPositiveIntField(line, "sequence");
    const acceptedFrame = readPositiveIntField(line, "acceptedFrame");
    const acceptedPts = readNonNegativeNumberField(line, "acceptedPts");
    if (sequence !== null && acceptedFrame !== null && acceptedPts !== null) {
      frames.push({ acceptedFrame, acceptedPts, sequence });
    }
  }
  return frames;
}

function getWrittenWebcamPreviewProofFrames(
  output: string,
): NativeWebcamPreviewProofFrame[] {
  const frames: NativeWebcamPreviewProofFrame[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.includes("WEBCAM_PREVIEW_FRAME_WRITTEN")) {
      continue;
    }
    const sequence = readPositiveIntField(line, "sequence");
    const acceptedFrame = readPositiveIntField(line, "acceptedFrame");
    const acceptedPts = readNonNegativeNumberField(line, "acceptedPts");
    const hostTime = readNonNegativeNumberField(line, "hostTime");
    if (
      sequence !== null &&
      acceptedFrame !== null &&
      acceptedPts !== null &&
      hostTime !== null
    ) {
      frames.push({ acceptedFrame, acceptedPts, hostTime, sequence });
    }
  }
  return frames;
}

function findMatchingWebcamPreviewProofFrame(
  previews: NativeWebcamPreviewProofFrame[],
  proof: NativeWebcamProofFrame,
) {
  return (
    previews.find(
      (preview) =>
        preview.sequence === proof.sequence &&
        preview.acceptedFrame === proof.acceptedFrame &&
        numbersNearlyEqual(preview.acceptedPts, proof.acceptedPts),
    ) ?? null
  );
}

function getPreferredWebcamPreviewProofFrame(output: string) {
  const proofs = getAcceptedWebcamProofPreviewFrames(output);
  const previews = getWrittenWebcamPreviewProofFrames(output);
  if (proofs.length === 0 || previews.length === 0) {
    return null;
  }

  const firstVisiblePts = getFirstVisibleWebcamFrameEvidence(output)?.pts ?? null;
  const visibleProof =
    firstVisiblePts === null
      ? null
      : proofs.find((proof) => proof.acceptedPts + 0.001 >= firstVisiblePts) ??
        null;
  const proof = visibleProof ?? proofs[0];
  return findMatchingWebcamPreviewProofFrame(previews, proof);
}

export function getNativeCaptureStartLeadMs(output: string): number | null {
  const gateHostTime = getCaptureGateHostTime(output);
  if (gateHostTime === null) {
    return null;
  }
  const preview = getPreferredWebcamPreviewProofFrame(output);
  if (!preview) {
    return null;
  }

  const leadSeconds = preview.hostTime - gateHostTime;
  if (!Number.isFinite(leadSeconds) || leadSeconds <= 0) {
    return 0;
  }

  return Math.round(leadSeconds * 1000);
}

export function getNativeWebcamStartOffsetMs(output: string): number | null {
  const gateHostTime = getCaptureGateHostTime(output);
  if (gateHostTime === null) {
    return null;
  }
  const preview = getPreferredWebcamPreviewProofFrame(output);
  if (!preview) {
    return null;
  }

  const offsetSeconds = preview.hostTime - gateHostTime - preview.acceptedPts;
  if (!Number.isFinite(offsetSeconds) || offsetSeconds <= 0) {
    return 0;
  }

  return Math.round(offsetSeconds * 1000);
}

export function getFirstMicrophoneAudioBufferEvidence(
  output: string,
): MicrophoneAudioBufferEvidence | null {
  for (const line of output.split(/\r?\n/)) {
    if (!line.includes("MICROPHONE_AUDIO_FIRST_BUFFER_WRITTEN")) {
      continue;
    }
    const buffers = readPositiveIntField(line, "buffers");
    const pts = readNonNegativeNumberField(line, "pts");
    const duration = readNonNegativeNumberField(line, "duration");
    if (buffers !== null && pts !== null && duration !== null) {
      return { buffers, pts, duration };
    }
  }
  return null;
}

export function hasNativeMicrophoneAudioEvidence(output: string) {
  return getFirstMicrophoneAudioBufferEvidence(output) !== null;
}

function hasNativeMicrophoneUnavailableEvidence(output: string) {
  return output.includes("MICROPHONE_CAPTURE_UNAVAILABLE");
}

export function getFirstVisibleWebcamFrameEvidence(
  output: string,
): VisibleWebcamFrameEvidence | null {
  for (const line of output.split(/\r?\n/)) {
    if (!line.includes("WEBCAM_FIRST_VISIBLE_FRAME_WRITTEN")) {
      continue;
    }
    const frames = readPositiveIntField(line, "frames");
    const pts = readNonNegativeNumberField(line, "pts");
    if (frames !== null && pts !== null) {
      return { frames, pts };
    }
  }
  return null;
}

export function waitForNativeCaptureStart(
  process: ChildProcessWithoutNullStreams,
  options: NativeCaptureStartWaitOptions = {},
) {
  return new Promise<void>((resolve, reject) => {
    const requiresMicrophoneAudio = options.requiresMicrophoneAudio === true;
    const requiresWebcamFirstFrame = options.requiresWebcamFirstFrame === true;
    const requiresWebcamProofPreview =
      options.requiresWebcamProofPreview === true;
    const maxInitialWebcamProofAcceptedPtsSeconds =
      typeof options.maxInitialWebcamProofAcceptedPtsSeconds === "number" &&
      Number.isFinite(options.maxInitialWebcamProofAcceptedPtsSeconds) &&
      options.maxInitialWebcamProofAcceptedPtsSeconds >= 0
        ? options.maxInitialWebcamProofAcceptedPtsSeconds
        : null;
    const maxInitialWebcamVisiblePtsSeconds =
      typeof options.maxInitialWebcamVisiblePtsSeconds === "number" &&
      Number.isFinite(options.maxInitialWebcamVisiblePtsSeconds) &&
      options.maxInitialWebcamVisiblePtsSeconds >= 0
        ? options.maxInitialWebcamVisiblePtsSeconds
        : null;
    let settled = false;
    let outputBuffer = nativeCaptureOutputBuffer;
    let sawRecordingStarted = outputBuffer.includes("Recording started");
    let sawVideoFirstFrame = outputBuffer.includes("VIDEO_FIRST_FRAME_WRITTEN");
    let firstMicrophoneAudioBuffer = requiresMicrophoneAudio
      ? getFirstMicrophoneAudioBufferEvidence(outputBuffer)
      : null;
    let sawMicrophoneAudio =
      !requiresMicrophoneAudio ||
      firstMicrophoneAudioBuffer !== null ||
      hasNativeMicrophoneUnavailableEvidence(outputBuffer);
    let sawWebcamWriterFrame = outputBuffer.includes(
      "WEBCAM_FIRST_FRAME_WRITTEN",
    );
    let firstVisibleWebcamFrame = requiresWebcamFirstFrame
      ? getFirstVisibleWebcamFrameEvidence(outputBuffer)
      : null;
    let sawWebcamFirstFrame =
      !requiresWebcamFirstFrame || firstVisibleWebcamFrame !== null;
    let firstAcceptedWebcamProofPreview = requiresWebcamProofPreview
      ? getFirstAcceptedWebcamProofPreviewEvidence(outputBuffer)
      : null;
    let sawWebcamProofPreview =
      !requiresWebcamProofPreview || firstAcceptedWebcamProofPreview !== null;

    const refreshOutputBuffer = () => {
      const sharedBuffer = nativeCaptureOutputBuffer;
      if (!sharedBuffer || outputBuffer.includes(sharedBuffer)) {
        return;
      }
      if (sharedBuffer.includes(outputBuffer)) {
        outputBuffer = sharedBuffer;
        return;
      }
      outputBuffer = `${outputBuffer}\n${sharedBuffer}`;
    };

    const refreshEvidence = () => {
      refreshOutputBuffer();
      sawRecordingStarted =
        sawRecordingStarted || outputBuffer.includes("Recording started");
      sawVideoFirstFrame =
        sawVideoFirstFrame ||
        outputBuffer.includes("VIDEO_FIRST_FRAME_WRITTEN");
      if (requiresMicrophoneAudio && firstMicrophoneAudioBuffer === null) {
        firstMicrophoneAudioBuffer =
          getFirstMicrophoneAudioBufferEvidence(outputBuffer);
      }
      sawMicrophoneAudio =
        sawMicrophoneAudio ||
        !requiresMicrophoneAudio ||
        firstMicrophoneAudioBuffer !== null ||
        hasNativeMicrophoneUnavailableEvidence(outputBuffer);
      sawWebcamWriterFrame =
        sawWebcamWriterFrame ||
        outputBuffer.includes("WEBCAM_FIRST_FRAME_WRITTEN");
      if (requiresWebcamFirstFrame && firstVisibleWebcamFrame === null) {
        firstVisibleWebcamFrame =
          getFirstVisibleWebcamFrameEvidence(outputBuffer);
      }
      sawWebcamFirstFrame =
        sawWebcamFirstFrame ||
        !requiresWebcamFirstFrame ||
        firstVisibleWebcamFrame !== null;
      if (
        requiresWebcamProofPreview &&
        firstAcceptedWebcamProofPreview === null
      ) {
        firstAcceptedWebcamProofPreview =
          getFirstAcceptedWebcamProofPreviewEvidence(outputBuffer);
      }
      sawWebcamProofPreview =
        sawWebcamProofPreview ||
        !requiresWebcamProofPreview ||
        firstAcceptedWebcamProofPreview !== null;
    };

    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      cleanup();
      settled = true;
      reject(error);
    };

    const maybeResolve = () => {
      refreshEvidence();
      if (
        !settled &&
        requiresWebcamProofPreview &&
        maxInitialWebcamProofAcceptedPtsSeconds !== null &&
        firstAcceptedWebcamProofPreview &&
        firstAcceptedWebcamProofPreview.acceptedPts >
          maxInitialWebcamProofAcceptedPtsSeconds
      ) {
        fail(
          new Error(
            `Native webcam proof preview started too late after preview handoff. First accepted proof was at ${firstAcceptedWebcamProofPreview.acceptedPts.toFixed(3)}s; expected <= ${maxInitialWebcamProofAcceptedPtsSeconds.toFixed(3)}s.`,
          ),
        );
        return true;
      }
      if (
        !settled &&
        requiresWebcamFirstFrame &&
        maxInitialWebcamVisiblePtsSeconds !== null &&
        firstVisibleWebcamFrame &&
        firstVisibleWebcamFrame.pts > maxInitialWebcamVisiblePtsSeconds
      ) {
        fail(
          new Error(
            `Native webcam visible video started too late after preview handoff. First visible frame was at ${firstVisibleWebcamFrame.pts.toFixed(3)}s; expected <= ${maxInitialWebcamVisiblePtsSeconds.toFixed(3)}s.`,
          ),
        );
        return true;
      }
      if (
        settled ||
        !sawRecordingStarted ||
        !sawVideoFirstFrame ||
        !sawMicrophoneAudio ||
        !sawWebcamFirstFrame ||
        !sawWebcamProofPreview
      ) {
        return false;
      }

      cleanup();
      settled = true;
      resolve();
      return true;
    };

    const timer = setTimeout(() => {
      if (maybeResolve()) {
        return;
      }
      const timeoutMessage = !sawVideoFirstFrame
        ? "Timed out waiting for native screen first frame to be written"
        : requiresWebcamFirstFrame &&
            sawRecordingStarted &&
            sawVideoFirstFrame &&
            sawWebcamWriterFrame &&
            sawWebcamProofPreview &&
            !sawWebcamFirstFrame
          ? "Selected webcam is delivering blank frames. Recordly did not start because the native webcam proof preview could not verify visible facecam video."
          : requiresWebcamFirstFrame
            ? requiresWebcamProofPreview
              ? requiresMicrophoneAudio
                ? "Timed out waiting for native screen, microphone audio, visible webcam, and proof-preview frames to be written"
                : "Timed out waiting for native screen, visible webcam, and proof-preview frames to be written"
              : requiresMicrophoneAudio
                ? "Timed out waiting for native screen, microphone audio, and visible webcam frames to be written"
                : "Timed out waiting for native screen and visible webcam frames to be written"
            : requiresMicrophoneAudio
              ? "Timed out waiting for native screen and microphone audio frames to be written"
              : "Timed out waiting for native screen frames to be written";
      fail(
        new Error(timeoutMessage),
      );
    }, options.timeoutMs ?? 15000);

    const onOutput = (chunk: Buffer) => {
      outputBuffer += chunk.toString();
      refreshEvidence();

      if (
        requiresWebcamFirstFrame &&
        (outputBuffer.includes("WEBCAM_PIPELINE_STALLED") ||
          outputBuffer.includes("WEBCAM_CAPTURE_DISABLED"))
      ) {
        fail(
          new Error(
            "Native webcam capture failed before writing a first frame",
          ),
        );
        return;
      }

      maybeResolve();
    };

    const onError = (error: Error) => {
      fail(error);
    };

    const onExit = (code: number | null) => {
      fail(
        new Error(
          outputBuffer.trim() ||
            nativeCaptureOutputBuffer.trim() ||
            `Native capture helper exited before recording started (code ${code ?? "unknown"})`,
        ),
      );
    };

    const cleanup = () => {
      clearTimeout(timer);
      process.stdout.off("data", onOutput);
      process.stderr.off("data", onOutput);
      process.off("error", onError);
      process.off("exit", onExit);
    };

    process.stdout.on("data", onOutput);
    process.stderr.on("data", onOutput);
    process.once("error", onError);
    process.once("exit", onExit);
    maybeResolve();
  });
}

export function waitForNativeCaptureStop(
  process: ChildProcessWithoutNullStreams,
) {
  return new Promise<string>((resolve, reject) => {
    const onClose = (code: number | null) => {
      cleanup();
      const match = nativeCaptureOutputBuffer.match(
        /Recording stopped\. Output path: (.+)/,
      );
      if (match?.[1]) {
        resolve(match[1].trim());
        return;
      }
      if (code === 0 && nativeCaptureTargetPath) {
        resolve(nativeCaptureTargetPath);
        return;
      }
      reject(
        new Error(
          nativeCaptureOutputBuffer.trim() ||
            `Native capture helper exited with code ${code ?? "unknown"}`,
        ),
      );
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const cleanup = () => {
      process.off("close", onClose);
      process.off("error", onError);
    };

    process.once("close", onClose);
    process.once("error", onError);
  });
}

function isMissingFileError(error: unknown) {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

async function recordMissingMacCompanionAudio({
  videoPath,
  audioPath,
  trackKind,
  reason,
}: {
  videoPath: string;
  audioPath: string;
  trackKind: "system" | "mic";
  reason: "missing-file" | "empty-file";
}) {
  await appendRecordingEventLogEntry({
    recordingsDir: path.dirname(videoPath),
    sessionId: getRecordingSessionIdForVideoPath(videoPath),
    event: "recording-companion-audio-missing",
    details: {
      videoPath,
      audioPath,
      trackKind,
      reason,
    },
  });
}

async function rejectMissingMacCompanionAudio({
  videoPath,
  audioPath,
  trackKind,
  reason,
}: {
  videoPath: string;
  audioPath: string;
  trackKind: "system" | "mic";
  reason: "missing-file" | "empty-file";
}): Promise<never> {
  await recordMissingMacCompanionAudio({
    videoPath,
    audioPath,
    trackKind,
    reason,
  });
  throw new Error(
    `Expected native ${trackKind} audio sidecar was ${
      reason === "missing-file" ? "missing" : "empty"
    }: ${audioPath}`,
  );
}

export async function muxNativeMacRecordingWithAudio(
  videoPath: string,
  systemAudioPath?: string | null,
  microphonePath?: string | null,
  nativeCaptureOutput?: string | null,
) {
  console.log("[mac-mux] Optimization active: keeping tracks separate.");

  // Optimization: instead of heavy FFmpeg muxing, we ensure audio sidecars
  // are available alongside the video for the editor.
  if (systemAudioPath) {
    const finalSystemPath = getFinalMacCompanionAudioPath(
      videoPath,
      systemAudioPath,
      "system",
    );
    try {
      const stat = await fs.stat(systemAudioPath);
      if (stat.size <= 0) {
        await rejectMissingMacCompanionAudio({
          videoPath,
          audioPath: systemAudioPath,
          trackKind: "system",
          reason: "empty-file",
        });
      } else if (systemAudioPath !== finalSystemPath) {
        await moveFileWithOverwrite(systemAudioPath, finalSystemPath);
        await repairRecordingCompanionAudioSyncIfNeeded({
          videoPath,
          audioPath: finalSystemPath,
          trackKind: "system",
          ...(nativeCaptureOutput ? { nativeCaptureOutput } : {}),
        });
      } else {
        await repairRecordingCompanionAudioSyncIfNeeded({
          videoPath,
          audioPath: finalSystemPath,
          trackKind: "system",
          ...(nativeCaptureOutput ? { nativeCaptureOutput } : {}),
        });
      }
    } catch (err) {
      if (isMissingFileError(err)) {
        await rejectMissingMacCompanionAudio({
          videoPath,
          audioPath: systemAudioPath,
          trackKind: "system",
          reason: "missing-file",
        });
      } else {
        console.error(`[mac-mux] Failed to handle system audio:`, err);
        throw err;
      }
    }
  }

  if (microphonePath) {
    const finalMicPath = getFinalMacCompanionAudioPath(
      videoPath,
      microphonePath,
      "mic",
    );
    try {
      const stat = await fs.stat(microphonePath);
      if (stat.size <= 0) {
        await rejectMissingMacCompanionAudio({
          videoPath,
          audioPath: microphonePath,
          trackKind: "mic",
          reason: "empty-file",
        });
      }
      if (microphonePath !== finalMicPath) {
        await moveFileWithOverwrite(microphonePath, finalMicPath);
      }
      await repairRecordingCompanionAudioSyncIfNeeded({
        videoPath,
        audioPath: finalMicPath,
        trackKind: "mic",
        ...(nativeCaptureOutput ? { nativeCaptureOutput } : {}),
      });
    } catch (err) {
      if (isMissingFileError(err)) {
        await rejectMissingMacCompanionAudio({
          videoPath,
          audioPath: microphonePath,
          trackKind: "mic",
          reason: "missing-file",
        });
      }
      console.error(`[mac-mux] Failed to handle mic audio:`, err);
      throw err;
    }
  }
}

export function attachNativeCaptureLifecycle(
  process: ChildProcessWithoutNullStreams,
) {
  process.once("close", (code, signal) => {
    const wasActive = nativeScreenRecordingActive;
    setNativeCaptureProcess(null);

    if (!wasActive || nativeCaptureStopRequested) {
      return;
    }

    setNativeScreenRecordingActive(false);
    console.log(
      "[mac-finalize] Optimization active: skipping safety-net muxing.",
    );
    setNativeCaptureStopRequested(false);

    const sourceName = selectedSource?.name ?? "Screen";
    BrowserWindow.getAllWindows().forEach((window) => {
      if (!window.isDestroyed()) {
        window.webContents.send("recording-state-changed", {
          recording: false,
          sourceName,
        });
      }
    });

    const webcamPipelineFailed =
      nativeCaptureOutputBuffer.includes("WEBCAM_PIPELINE_STALLED") ||
      nativeCaptureOutputBuffer.includes("WEBCAM_CAPTURE_DISABLED") ||
      nativeCaptureOutputBuffer.includes("WEBCAM_CAPTURE_FAIL_CLOSED");
    const reason = nativeCaptureOutputBuffer.includes("WINDOW_UNAVAILABLE")
      ? "window-unavailable"
      : nativeCaptureOutputBuffer.includes("VIDEO_PIPELINE_STALLED")
        ? "video-pipeline-stalled"
        : webcamPipelineFailed
          ? "webcam-pipeline-stalled"
          : "capture-stopped";
    const message =
      reason === "window-unavailable"
        ? "The selected window is no longer capturable. Please reselect a window."
        : reason === "video-pipeline-stalled"
          ? "Screen recording stalled and was stopped to prevent a corrupted timeline."
          : reason === "webcam-pipeline-stalled"
            ? "Webcam recording stalled and was stopped to prevent frozen facecam footage."
            : "Recording stopped unexpectedly.";

    const outputPath = nativeCaptureTargetPath;
    const processOutput = nativeCaptureOutputBuffer.trim() || undefined;
    if (outputPath) {
      recordNativeCaptureDiagnostics({
        backend: "mac-screencapturekit",
        phase: "stop",
        sourceId: lastNativeCaptureDiagnostics?.sourceId ?? null,
        sourceType: lastNativeCaptureDiagnostics?.sourceType ?? "unknown",
        displayId: lastNativeCaptureDiagnostics?.displayId ?? null,
        displayBounds: lastNativeCaptureDiagnostics?.displayBounds ?? null,
        windowHandle: lastNativeCaptureDiagnostics?.windowHandle ?? null,
        helperPath: lastNativeCaptureDiagnostics?.helperPath ?? null,
        outputPath,
        systemAudioPath: nativeCaptureSystemAudioPath,
        microphonePath: nativeCaptureMicrophonePath,
        osRelease: lastNativeCaptureDiagnostics?.osRelease,
        supported: lastNativeCaptureDiagnostics?.supported,
        helperExists: lastNativeCaptureDiagnostics?.helperExists,
        processOutput,
        error: message,
      });

      void (async () => {
        await appendRecordingEventLogEntry({
          recordingsDir: path.dirname(outputPath),
          sessionId: getRecordingSessionIdForVideoPath(outputPath),
          event: "native-helper-exited-unexpectedly",
          details: {
            reason,
            message,
            code,
            signal,
            outputPath,
            processOutput,
          },
        }).catch((error) => {
          console.warn("Failed to write native helper exit event:", error);
        });

        await writeRecordingDiagnosticsSnapshot(outputPath, {
          backend: "mac-screencapturekit",
          phase: "stop",
          outputPath,
          systemAudioPath: nativeCaptureSystemAudioPath,
          microphonePath: nativeCaptureMicrophonePath,
          processOutput,
          error: message,
          details: {
            unexpectedHelperClose: true,
            reason,
            code,
            signal,
          },
        }).catch((error) => {
          console.warn(
            "Failed to write native helper exit diagnostics:",
            error,
          );
        });
      })();
    }

    emitRecordingInterrupted(reason, message);
  });
}

export async function finalizeStoredVideo(videoPath: string) {
  console.log("[finalize] Optimization active: skipping safety-net muxing.");

  let validation: { fileSizeBytes: number; durationSeconds: number | null };
  try {
    validation = await validateRecordedVideo(videoPath);
  } catch (error) {
    if (
      lastNativeCaptureDiagnostics?.backend === "mac-screencapturekit" ||
      lastNativeCaptureDiagnostics?.backend === "windows-wgc"
    ) {
      recordNativeCaptureDiagnostics({
        backend: lastNativeCaptureDiagnostics.backend,
        phase: lastNativeCaptureDiagnostics.phase === "mux" ? "mux" : "stop",
        sourceId: lastNativeCaptureDiagnostics.sourceId ?? null,
        sourceType: lastNativeCaptureDiagnostics.sourceType ?? "unknown",
        displayId: lastNativeCaptureDiagnostics.displayId ?? null,
        displayBounds: lastNativeCaptureDiagnostics.displayBounds ?? null,
        windowHandle: lastNativeCaptureDiagnostics.windowHandle ?? null,
        helperPath: lastNativeCaptureDiagnostics.helperPath ?? null,
        outputPath: videoPath,
        systemAudioPath: lastNativeCaptureDiagnostics.systemAudioPath ?? null,
        microphonePath: lastNativeCaptureDiagnostics.microphonePath ?? null,
        osRelease: lastNativeCaptureDiagnostics.osRelease,
        supported: lastNativeCaptureDiagnostics.supported,
        helperExists: lastNativeCaptureDiagnostics.helperExists,
        processOutput: lastNativeCaptureDiagnostics.processOutput,
        fileSizeBytes: await getFileSizeIfPresent(videoPath),
        expectedDurationMs:
          lastNativeCaptureDiagnostics.expectedDurationMs ?? null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  }

  snapshotCursorTelemetryForPersistence();
  setCurrentVideoPath(videoPath);
  setCurrentProjectPath(null);
  try {
    await persistPendingCursorTelemetry(videoPath);
  } catch (error) {
    console.warn("[mac-stop] Failed to persist cursor telemetry:", error);
  }
  await persistWebcamLayoutEvents(videoPath);
  await persistSceneStyleEvents(videoPath);
  await markMacRecoveryManifestFinalized(videoPath);
  if (isAutoRecordingPath(videoPath)) {
    await pruneAutoRecordings([videoPath]);
  }

  if (
    lastNativeCaptureDiagnostics?.backend === "mac-screencapturekit" ||
    lastNativeCaptureDiagnostics?.backend === "windows-wgc"
  ) {
    recordNativeCaptureDiagnostics({
      backend: lastNativeCaptureDiagnostics.backend,
      phase: lastNativeCaptureDiagnostics.phase === "mux" ? "mux" : "stop",
      sourceId: lastNativeCaptureDiagnostics.sourceId ?? null,
      sourceType: lastNativeCaptureDiagnostics.sourceType ?? "unknown",
      displayId: lastNativeCaptureDiagnostics.displayId ?? null,
      displayBounds: lastNativeCaptureDiagnostics.displayBounds ?? null,
      windowHandle: lastNativeCaptureDiagnostics.windowHandle ?? null,
      helperPath: lastNativeCaptureDiagnostics.helperPath ?? null,
      outputPath: videoPath,
      systemAudioPath: lastNativeCaptureDiagnostics.systemAudioPath ?? null,
      microphonePath: lastNativeCaptureDiagnostics.microphonePath ?? null,
      osRelease: lastNativeCaptureDiagnostics.osRelease,
      supported: lastNativeCaptureDiagnostics.supported,
      helperExists: lastNativeCaptureDiagnostics.helperExists,
      processOutput: lastNativeCaptureDiagnostics.processOutput,
      fileSizeBytes: validation.fileSizeBytes,
      expectedDurationMs:
        lastNativeCaptureDiagnostics.expectedDurationMs ?? null,
    });
  }

  return {
    success: true,
    path: videoPath,
    message:
      validation.durationSeconds !== null
        ? `Video stored successfully (${validation.fileSizeBytes} bytes, ${validation.durationSeconds.toFixed(2)}s)`
        : `Video stored successfully`,
  };
}

export async function recoverNativeMacCaptureOutput({
  includeDiagnosticsCandidate = true,
  auditFinalizedRecording,
}: {
  includeDiagnosticsCandidate?: boolean;
  auditFinalizedRecording?: NativeRecordingRecoveryAudit;
} = {}) {
  const macDiagnostics =
    lastNativeCaptureDiagnostics?.backend === "mac-screencapturekit"
      ? lastNativeCaptureDiagnostics
      : null;
  const recordingsDir = await getRecordingsDir();
  const candidates = await findMacRecoveryCandidates({
    recordingsDir,
    currentTargetPath: nativeCaptureTargetPath,
    currentSystemAudioPath: nativeCaptureSystemAudioPath,
    currentMicrophonePath: nativeCaptureMicrophonePath,
    currentWebcamPath: nativeCaptureWebcamPath,
    includeDiagnosticsCandidate,
    diagnosticsPath: macDiagnostics?.outputPath ?? null,
    diagnosticsSystemAudioPath: macDiagnostics?.systemAudioPath ?? null,
    diagnosticsMicrophonePath: macDiagnostics?.microphonePath ?? null,
  });

  for (const candidate of candidates) {
    try {
      if (candidate.systemAudioPath || candidate.microphonePath) {
        try {
          await muxNativeMacRecordingWithAudio(
            candidate.videoPath,
            candidate.systemAudioPath,
            candidate.microphonePath,
            nativeCaptureOutputBuffer,
          );
        } catch (muxError) {
          console.warn("Failed to mux audio during recovery:", muxError);
          throw muxError;
        }
      }

      await repairRecordingSourceAudioSyncIfNeeded(candidate.videoPath);

      await validateNativeScreenRecordingIntegrity({
        screenPath: candidate.videoPath,
        processOutput: nativeCaptureOutputBuffer,
      });
      const recoveredWebcamPath = await resolveValidatedNativeWebcamPath({
        screenPath: candidate.videoPath,
        webcamPath: candidate.webcamPath,
        processOutput: nativeCaptureOutputBuffer,
      });
      const recordingAudit = auditFinalizedRecording
        ? await auditFinalizedRecording(candidate.videoPath)
        : undefined;
      return {
        ...(await finalizeStoredVideo(candidate.videoPath)),
        webcamPath: recoveredWebcamPath,
        ...(recordingAudit ? { recordingAudit } : {}),
      };
    } catch (error) {
      if (candidate.manifestPath) {
        await markMacRecoveryManifestFailed(
          candidate.videoPath,
          error instanceof Error ? error.message : String(error),
        );
      }
      recordNativeCaptureDiagnostics({
        backend: "mac-screencapturekit",
        phase: "stop",
        outputPath: candidate.videoPath,
        systemAudioPath: candidate.systemAudioPath,
        microphonePath: candidate.microphonePath,
        processOutput: nativeCaptureOutputBuffer.trim() || undefined,
        fileSizeBytes: await getFileSizeIfPresent(candidate.videoPath),
        error: String(error),
      });
    }
  }

  return null;
}
