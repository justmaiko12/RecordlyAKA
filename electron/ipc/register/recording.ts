import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  systemPreferences,
} from "electron";
import { showCursor } from "../../cursorHider";
import {
  buildMediaUrl,
  buildMjpegPreviewSnapshotUrl,
  buildMjpegPreviewStreamUrl,
  ensureMediaServer,
  getMediaServerBaseUrl,
  publishMjpegPreviewFrame,
  registerMjpegPreviewStream,
  unregisterMjpegPreviewStream,
} from "../../mediaServer";
import { ALLOW_RECORDLY_WINDOW_CAPTURE } from "../constants";
import {
  startWindowBoundsCapture,
  stopWindowBoundsCapture,
} from "../cursor/bounds";
import {
  startInteractionCapture,
  stopInteractionCapture,
} from "../cursor/interaction";
import {
  startNativeCursorMonitor,
  stopNativeCursorMonitor,
} from "../cursor/monitor";
import {
  normalizeCursorTelemetrySamples,
  pauseCursorCaptureAtBoundary,
  persistPendingCursorTelemetry,
  resetCursorCaptureClock,
  resumeCursorCapture,
  sampleCursorPoint,
  snapshotCursorTelemetryForPersistence,
  startCursorSampling,
  stopCursorCapture,
  writeCursorTelemetry,
} from "../cursor/telemetry";
import { getFfmpegBinaryPath } from "../ffmpeg/binary";
import { getMonitorHandles } from "../monitorResolver";
import {
  ensureNativeCaptureHelperBinary,
  ensureSwiftHelperBinary,
  getNativeCaptureHelperBinaryPath,
  getSystemCursorHelperBinaryPath,
  getSystemCursorHelperSourcePath,
  getWindowsCaptureExePath,
} from "../paths/binaries";
import { rememberApprovedLocalReadPath } from "../project/manager";
import { shouldKeepRecordingAudioSidecars } from "../recording/audioFilters";
import {
  assertRecordingRunAuditPassed,
  auditRecordingRun,
  type RecordingRunAuditResult,
} from "../recording/auditRecordingRun";
import {
  getCompanionAudioFallbackInfo,
  getFileSizeIfPresent,
  type RecordingDiagnosticsSnapshot,
  recordNativeCaptureDiagnostics,
  validateRecordedVideo,
  writeRecordingDiagnosticsSnapshot,
} from "../recording/diagnostics";
import {
  emitNativeWebcamPreview,
  emitRecordingDegraded,
} from "../recording/events";
import {
  buildFfmpegCaptureArgs,
  waitForFfmpegCaptureStart,
  waitForFfmpegCaptureStop,
} from "../recording/ffmpeg";
import {
  attachNativeCaptureLifecycle,
  finalizeStoredVideo,
  getNativeCaptureStartLeadMs,
  getNativeWebcamStartOffsetMs,
  muxNativeMacRecordingWithAudio,
  NATIVE_WEBCAM_PREVIEW_HANDOFF_REPROOF_SECONDS,
  recoverNativeMacCaptureOutput,
  resolveNativeWebcamPathAfterStart,
  waitForNativeCaptureStart,
  waitForNativeCaptureStop,
} from "../recording/mac";
import {
  clearMacRecoveryManifestWebcamPathSync,
  MAC_RECOVERY_FRAGMENT_INTERVAL_SECONDS,
  removeMacRecoveryManifest,
  writeMacRecoveryManifest,
} from "../recording/macRecoveryManifest";
import {
  storeBrowserMicrophoneSidecar,
  type BrowserMicrophoneSidecarOptions,
} from "../recording/microphoneSidecarStore";
import { NativeCaptureHealthSupervisor } from "../recording/nativeCaptureHealth";
import {
  requestNativeFailClosedHelperStop,
  shouldRequestNativeFailClosedHelperStop,
} from "../recording/nativeFailClosedStop";
import { parseNativeHelperOutputLine } from "../recording/nativeHelperOutput";
import {
  recordNativeScreenDurationIntegrityEvent,
  resolveValidatedNativeWebcamPath,
  validateNativeScreenRecordingIntegrity,
} from "../recording/nativeIntegrity";
import { createNativeWebcamPreviewCorrelationTracker } from "../recording/nativeWebcamPreviewCorrelation";
import {
  deriveNativeWebcamPreviewFramePaths,
  resolveNativeWebcamPreviewFramePath,
} from "../recording/nativeWebcamPreviewPaths";
import { publishNativeWebcamProofPreviewFrame } from "../recording/nativeWebcamPreviewPublish";
import { createNativeWebcamPreviewRendererUpdateGate } from "../recording/nativeWebcamPreviewRender";
import { appendRecordingEventLogEntry } from "../recording/recordingEventLog";
import {
  type NativeWebcamPreviewRendererIssuePayload,
  resolveNativeWebcamPreviewRendererIssueTarget,
  sanitizeNativeWebcamPreviewRendererIssuePayload,
} from "../recording/rendererPreviewIssue";
import {
  readSceneStyleEvents,
  recordSceneStyleEvent,
  type SceneStyleMode,
} from "../recording/sceneStyleEvents";
import { repairRecordingSourceAudioSyncIfNeeded } from "../recording/sourceAudioSync";
import {
  readWebcamLayoutSidecar,
  recordWebcamLayoutEvent,
  type WebcamLayoutMode,
} from "../recording/webcamLayoutEvents";
import { normalizeWebcamSidecarIfNeeded } from "../recording/webcamSidecarNormalize";
import { WebcamSidecarStreamRegistry } from "../recording/webcamSidecarStream";
import {
  attachWindowsCaptureLifecycle,
  isNativeWindowsCaptureAvailable,
  muxNativeWindowsVideoWithAudio,
  waitForWindowsCaptureStart,
  waitForWindowsCaptureStop,
} from "../recording/windows";
import {
  shouldStartWindowsBrowserMicrophoneFallback,
  shouldUseWindowsBrowserMicrophoneFallback,
} from "../recording/windowsFallbacks";
import {
  appendNativeCaptureOutputBuffer,
  cachedSystemCursorAssets,
  cachedSystemCursorAssetsSourceMtimeMs,
  currentVideoPath,
  ffmpegCaptureOutputBuffer,
  ffmpegCaptureProcess,
  ffmpegCaptureTargetPath,
  ffmpegScreenRecordingActive,
  lastNativeCaptureDiagnostics,
  nativeCaptureMicrophonePath,
  nativeCaptureOutputBuffer,
  nativeCapturePaused,
  nativeCaptureProcess,
  nativeCaptureSystemAudioPath,
  nativeCaptureTargetPath,
  nativeCaptureWebcamPath,
  nativeScreenRecordingActive,
  selectedSource,
  setActiveCursorSamples,
  setCachedSystemCursorAssets,
  setCachedSystemCursorAssetsSourceMtimeMs,
  setCursorCaptureStartTimeMs,
  setFfmpegCaptureOutputBuffer,
  setFfmpegCaptureProcess,
  setFfmpegCaptureTargetPath,
  setFfmpegScreenRecordingActive,
  setIsCursorCaptureActive,
  setLastLeftClick,
  setLinuxCursorScreenPoint,
  setNativeCaptureMicrophonePath,
  setNativeCaptureOutputBuffer,
  setNativeCapturePaused,
  setNativeCaptureProcess,
  setNativeCaptureStopRequested,
  setNativeCaptureSystemAudioPath,
  setNativeCaptureTargetPath,
  setNativeCaptureWebcamPath,
  setNativeScreenRecordingActive,
  setPendingCursorSamples,
  setWindowsCaptureOutputBuffer,
  setWindowsCapturePaused,
  setWindowsCaptureProcess,
  setWindowsCaptureStopRequested,
  setWindowsCaptureTargetPath,
  setWindowsMicAudioPath,
  setWindowsNativeCaptureActive,
  setWindowsOrphanedMicAudioPath,
  setWindowsPendingVideoPath,
  setWindowsSystemAudioPath,
  windowsCaptureOutputBuffer,
  windowsCapturePaused,
  windowsCaptureProcess,
  windowsCaptureTargetPath,
  windowsMicAudioPath,
  windowsNativeCaptureActive,
  windowsOrphanedMicAudioPath,
  windowsPendingVideoPath,
  windowsSystemAudioPath,
} from "../state";
import type {
  CursorTelemetryPoint,
  NativeMacRecordingOptions,
  SelectedSource,
} from "../types";
import {
  approveUserPath,
  getMacPrivacySettingsUrl,
  getRecordingsDir,
  getScreen,
  getTelemetryPathForVideo,
  moveFileWithOverwrite,
  normalizeVideoSourcePath,
  parseJsonWithByteOrderMark,
  parseWindowId,
} from "../utils";
import { resolveWindowsCaptureTarget } from "../windowsCaptureSelection";
import { stopNativeWebcamPreviewSession } from "./nativeWebcamPreview";

const execFileAsync = promisify(execFile);
const webcamSidecarStreams = new WebcamSidecarStreamRegistry();

async function writeWindowsRecordingDiagnostics(
  videoPath: string | null | undefined,
  snapshot: Omit<RecordingDiagnosticsSnapshot, "backend">,
) {
  if (!videoPath) {
    return null;
  }

  try {
    return await writeRecordingDiagnosticsSnapshot(videoPath, {
      backend: "windows-wgc",
      ...snapshot,
    });
  } catch (error) {
    console.warn("Failed to write Windows recording diagnostics:", error);
    return null;
  }
}

async function writeMacRecordingDiagnostics(
  videoPath: string | null | undefined,
  snapshot: Omit<RecordingDiagnosticsSnapshot, "backend">,
) {
  if (!videoPath) {
    return null;
  }

  try {
    return await writeRecordingDiagnosticsSnapshot(videoPath, {
      backend: "mac-screencapturekit",
      ...snapshot,
    });
  } catch (error) {
    console.warn("Failed to write macOS recording diagnostics:", error);
    return null;
  }
}

const nativeEventLogWrites = new Set<Promise<void>>();

function queueNativeEventLogWrite(
  input: Parameters<typeof appendRecordingEventLogEntry>[0],
  warningMessage: string,
) {
  const writePromise = appendRecordingEventLogEntry(input)
    .catch((error) => {
      console.warn(warningMessage, error);
    })
    .then(() => undefined);
  nativeEventLogWrites.add(writePromise);
  writePromise.finally(() => {
    nativeEventLogWrites.delete(writePromise);
  });
  return writePromise;
}

async function drainNativeEventLogWrites() {
  while (nativeEventLogWrites.size > 0) {
    await Promise.allSettled([...nativeEventLogWrites]);
  }
}

function getRecordingSessionIdForVideoPath(videoPath: string) {
  const baseName = path.basename(videoPath, path.extname(videoPath));
  return baseName.startsWith("recording-")
    ? baseName.slice("recording-".length)
    : baseName;
}

export function summarizeRecordingAuditForIpc(audit: RecordingRunAuditResult) {
  return {
    status: audit.status,
    paths: audit.paths,
    issues: audit.issues.slice(0, 8),
    warnings: audit.warnings.slice(0, 8),
    summary: {
      eventCount: audit.summary.eventCount ?? 0,
      sawWebcamEvidence: audit.summary.sawWebcamEvidence === true,
      proofCount: audit.summary.proof?.count ?? 0,
      proofRejectedCount: audit.summary.proof?.rejectedCount ?? 0,
      proofMonotonic: audit.summary.proof?.monotonic ?? null,
      rendererPreviewIssueCount:
        audit.summary.rendererPreviewIssues?.count ?? 0,
      screenWriterStatus:
        audit.summary.screenFinalization?.writerStatus ?? null,
      screenDuration: audit.summary.screenFinalization?.duration ?? null,
      screenFrames: audit.summary.screenFinalization?.frames ?? null,
      webcamWriterStatus:
        audit.summary.webcamFinalization?.writerStatus ?? null,
      webcamDuration: audit.summary.webcamFinalization?.duration ?? null,
      webcamFrames: audit.summary.webcamFinalization?.frames ?? null,
      sourceMediaDurations: audit.summary.sourceMediaDurations ?? null,
      companionAudioDurations: audit.summary.companionAudioDurations ?? [],
      webcamCadence: {
        statsCount: audit.summary.webcamCadence?.statsCount ?? 0,
        targetFps: audit.summary.webcamCadence?.targetFps ?? null,
        maxRecentFps: audit.summary.webcamCadence?.maxRecentFps ?? null,
        maxTotalFps: audit.summary.webcamCadence?.maxTotalFps ?? null,
        throttledFrames: audit.summary.webcamCadence?.throttledFrames ?? 0,
      },
      webcamVisualFreezeReviews: {
        count: audit.summary.webcamVisualFreezeReviews?.count ?? 0,
        totalDurationSeconds:
          audit.summary.webcamVisualFreezeReviews?.totalDurationSeconds ?? 0,
        ...(typeof audit.summary.webcamVisualFreezeReviews
          ?.firstStartPtsSeconds === "number"
          ? {
              firstStartPtsSeconds:
                audit.summary.webcamVisualFreezeReviews.firstStartPtsSeconds,
            }
          : {}),
        ...(typeof audit.summary.webcamVisualFreezeReviews
          ?.firstEndPtsSeconds === "number"
          ? {
              firstEndPtsSeconds:
                audit.summary.webcamVisualFreezeReviews.firstEndPtsSeconds,
            }
          : {}),
        ...(typeof audit.summary.webcamVisualFreezeReviews
          ?.lastStartPtsSeconds === "number"
          ? {
              lastStartPtsSeconds:
                audit.summary.webcamVisualFreezeReviews.lastStartPtsSeconds,
            }
          : {}),
        ...(typeof audit.summary.webcamVisualFreezeReviews
          ?.lastEndPtsSeconds === "number"
          ? {
              lastEndPtsSeconds:
                audit.summary.webcamVisualFreezeReviews.lastEndPtsSeconds,
            }
          : {}),
      },
      audioContinuityRepairs: {
        count: audit.summary.audioContinuityRepairs?.count ?? 0,
        ...(audit.summary.audioContinuityRepairs?.totalFrames
          ? { totalFrames: audit.summary.audioContinuityRepairs.totalFrames }
          : {}),
        ...(audit.summary.audioContinuityRepairs?.totalBuffers
          ? { totalBuffers: audit.summary.audioContinuityRepairs.totalBuffers }
          : {}),
        totalDurationSeconds:
          audit.summary.audioContinuityRepairs?.totalDurationSeconds ?? 0,
        ...(typeof audit.summary.audioContinuityRepairs
          ?.firstTargetPtsSeconds === "number"
          ? {
              firstTargetPtsSeconds:
                audit.summary.audioContinuityRepairs.firstTargetPtsSeconds,
            }
          : {}),
        ...(typeof audit.summary.audioContinuityRepairs
          ?.lastTargetPtsSeconds === "number"
          ? {
              lastTargetPtsSeconds:
                audit.summary.audioContinuityRepairs.lastTargetPtsSeconds,
            }
          : {}),
      },
      webcamContinuityRepairs: {
        count: audit.summary.webcamContinuityRepairs?.count ?? 0,
        ...(audit.summary.webcamContinuityRepairs?.totalFrames
          ? { totalFrames: audit.summary.webcamContinuityRepairs.totalFrames }
          : {}),
        ...(audit.summary.webcamContinuityRepairs?.totalBuffers
          ? { totalBuffers: audit.summary.webcamContinuityRepairs.totalBuffers }
          : {}),
        totalDurationSeconds:
          audit.summary.webcamContinuityRepairs?.totalDurationSeconds ?? 0,
        ...(typeof audit.summary.webcamContinuityRepairs
          ?.firstTargetPtsSeconds === "number"
          ? {
              firstTargetPtsSeconds:
                audit.summary.webcamContinuityRepairs.firstTargetPtsSeconds,
            }
          : {}),
        ...(typeof audit.summary.webcamContinuityRepairs
          ?.lastTargetPtsSeconds === "number"
          ? {
              lastTargetPtsSeconds:
                audit.summary.webcamContinuityRepairs.lastTargetPtsSeconds,
            }
          : {}),
      },
      nativeMicrophone: audit.summary.nativeMicrophone ?? {
        requested: false,
        firstBufferWritten: false,
        unavailable: false,
        deviceEvent: null,
        firstBuffer: null,
      },
    },
  };
}

function hasMicrophoneCompanionAudioPath(paths: string[], videoPath: string) {
  return paths.some((audioPath) => {
    if (audioPath === videoPath) {
      return false;
    }
    return (
      audioPath.endsWith(".mic.m4a") ||
      audioPath.endsWith(".mic.webm") ||
      audioPath.endsWith(".mic.wav")
    );
  });
}

async function repairRecordingSourceAudioUnlessMicCompanionPreferred(
  videoPath: string,
) {
  const companionInfo = await getCompanionAudioFallbackInfo(videoPath);
  if (!hasMicrophoneCompanionAudioPath(companionInfo.paths, videoPath)) {
    await repairRecordingSourceAudioSyncIfNeeded(videoPath);
    return;
  }

  await appendRecordingEventLogEntry({
    recordingsDir: path.dirname(videoPath),
    sessionId: getRecordingSessionIdForVideoPath(videoPath),
    event: "recording-source-audio-sync-skipped",
    details: {
      reason: "mic-companion-audio-preferred",
      videoPath,
      audioPaths: companionInfo.paths,
    },
  });
}

async function auditAndRecordFinalizedRecording(videoPath: string) {
  const audit = await auditRecordingRun(videoPath);
  const recordingsDir = path.dirname(videoPath);
  const sessionId = getRecordingSessionIdForVideoPath(videoPath);
  const event =
    audit.status === "fail"
      ? "recording-run-audit-failed"
      : audit.status === "warning"
        ? "recording-run-audit-warning"
        : "recording-run-audit-passed";
  await appendRecordingEventLogEntry({
    recordingsDir,
    sessionId,
    event,
    details: summarizeRecordingAuditForIpc(audit),
  });
  return audit;
}

async function auditAndSummarizeFinalizedRecording(videoPath: string) {
  const audit = await auditAndRecordFinalizedRecording(videoPath);
  assertRecordingRunAuditPassed(audit, videoPath);
  return summarizeRecordingAuditForIpc(audit);
}

function formatRecordingIpcError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

type AuditFinalizedRecordingForRendererDeps = {
  auditAndRecordFinalizedRecording: typeof auditAndRecordFinalizedRecording;
  assertRecordingRunAuditPassed: typeof assertRecordingRunAuditPassed;
  summarizeRecordingAuditForIpc: typeof summarizeRecordingAuditForIpc;
};

export async function auditFinalizedRecordingForRenderer(
  videoPath: string,
  deps?: Partial<AuditFinalizedRecordingForRendererDeps>,
) {
  if (typeof videoPath !== "string" || !videoPath.trim()) {
    return {
      success: false,
      error: "Recording audit failed because no video path was provided.",
    };
  }

  const activeDeps: AuditFinalizedRecordingForRendererDeps = {
    auditAndRecordFinalizedRecording,
    assertRecordingRunAuditPassed,
    summarizeRecordingAuditForIpc,
    ...deps,
  };

  try {
    const audit = await activeDeps.auditAndRecordFinalizedRecording(videoPath);
    const recordingAudit = activeDeps.summarizeRecordingAuditForIpc(audit);
    try {
      activeDeps.assertRecordingRunAuditPassed(audit, videoPath);
    } catch (error) {
      return {
        success: false,
        error: formatRecordingIpcError(error),
        recordingAudit,
      };
    }
    return { success: true, recordingAudit };
  } catch (error) {
    return {
      success: false,
      error: formatRecordingIpcError(error),
    };
  }
}

function normalizeRendererTimestampMs(value: unknown) {
  const nowMs = Date.now();
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return nowMs;
  }

  return Math.min(Math.max(0, Math.round(value)), nowMs);
}

async function getSystemCursorAssets() {
  if (process.platform !== "darwin") {
    setCachedSystemCursorAssets({});
    setCachedSystemCursorAssetsSourceMtimeMs(null);
    return cachedSystemCursorAssets ?? {};
  }
  const sourcePath = getSystemCursorHelperSourcePath();
  const sourceStat = await fs.stat(sourcePath);
  if (
    cachedSystemCursorAssets &&
    cachedSystemCursorAssetsSourceMtimeMs === sourceStat.mtimeMs
  ) {
    return cachedSystemCursorAssets;
  }
  const binaryPath = await ensureSwiftHelperBinary(
    sourcePath,
    getSystemCursorHelperBinaryPath(),
    "system cursor helper",
    "recordly-system-cursors",
  );
  const { stdout } = await execFileAsync(binaryPath, [], {
    timeout: 15000,
    maxBuffer: 20 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout) as Record<
    string,
    Partial<import("../types").SystemCursorAsset>
  >;
  const result = Object.fromEntries(
    Object.entries(parsed).filter(
      ([, asset]) =>
        typeof asset?.dataUrl === "string" &&
        typeof asset?.hotspotX === "number" &&
        typeof asset?.hotspotY === "number" &&
        typeof asset?.width === "number" &&
        typeof asset?.height === "number",
    ),
  ) as Record<string, import("../types").SystemCursorAsset>;
  setCachedSystemCursorAssets(result);
  setCachedSystemCursorAssetsSourceMtimeMs(sourceStat.mtimeMs);
  return result;
}

function normalizeDesktopSourceName(value: string) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

async function cleanupWindowsOrphanedMicAudioPath(filePath: string | null) {
  if (!filePath) {
    return;
  }

  if (shouldKeepRecordingAudioSidecars()) {
    console.log(
      `[recording] Keeping orphaned native mic sidecar for diagnostics: ${filePath}`,
    );
    return;
  }

  await fs.rm(filePath, { force: true }).catch(() => undefined);
}

async function pathExists(filePath: string | null | undefined) {
  if (!filePath) {
    return false;
  }

  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveExistingPath(
  ...candidates: Array<string | null | undefined>
) {
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate ?? null;
    }
  }

  return null;
}

function resolveRecordingSessionId(options?: NativeMacRecordingOptions) {
  const sessionId = options?.sessionId?.trim();
  return sessionId && /^\d+$/.test(sessionId) ? sessionId : String(Date.now());
}

type FinalizeStoredVideoWithSourceAudioSyncDeps = {
  repairRecordingSourceAudioSync: typeof repairRecordingSourceAudioSyncIfNeeded;
  finalizeStoredVideo: typeof finalizeStoredVideo;
};

export async function finalizeStoredVideoWithSourceAudioSync(
  videoPath: string,
  deps?: Partial<FinalizeStoredVideoWithSourceAudioSyncDeps>,
) {
  const activeDeps: FinalizeStoredVideoWithSourceAudioSyncDeps = {
    repairRecordingSourceAudioSync: repairRecordingSourceAudioSyncIfNeeded,
    finalizeStoredVideo,
    ...deps,
  };
  await activeDeps.repairRecordingSourceAudioSync(videoPath);
  return activeDeps.finalizeStoredVideo(videoPath);
}

type StoreRecordedVideoWithSourceAudioSyncDeps =
  FinalizeStoredVideoWithSourceAudioSyncDeps & {
    getRecordingsDir: typeof getRecordingsDir;
    writeFile: typeof fs.writeFile;
  };

export async function storeRecordedVideoWithSourceAudioSync(
  videoData: ArrayBuffer,
  fileName: string,
  deps?: Partial<StoreRecordedVideoWithSourceAudioSyncDeps>,
) {
  const activeDeps: StoreRecordedVideoWithSourceAudioSyncDeps = {
    getRecordingsDir,
    writeFile: fs.writeFile,
    repairRecordingSourceAudioSync: repairRecordingSourceAudioSyncIfNeeded,
    finalizeStoredVideo,
    ...deps,
  };
  const recordingsDir = await activeDeps.getRecordingsDir();
  const videoPath = path.join(recordingsDir, fileName);
  await activeDeps.writeFile(videoPath, Buffer.from(videoData));
  return finalizeStoredVideoWithSourceAudioSync(videoPath, activeDeps);
}

export function registerRecordingHandlers(
  onRecordingStateChange?: (recording: boolean, sourceName: string) => void,
) {
  ipcMain.handle(
    "start-native-screen-recording",
    async (_, source: SelectedSource, options?: NativeMacRecordingOptions) => {
      // Windows native capture path
      if (process.platform === "win32") {
        const windowsCaptureAvailable = await isNativeWindowsCaptureAvailable();
        if (!windowsCaptureAvailable) {
          return {
            success: false,
            message: "Native Windows capture is not available on this system.",
          };
        }

        if (windowsCaptureProcess && !windowsNativeCaptureActive) {
          try {
            windowsCaptureProcess.kill();
          } catch {
            /* ignore */
          }
          setWindowsCaptureProcess(null);
          setWindowsCaptureTargetPath(null);
          setWindowsCaptureStopRequested(false);
        }

        if (windowsCaptureProcess) {
          return {
            success: false,
            message: "A native Windows screen recording is already active.",
          };
        }

        let wcProc: ChildProcessWithoutNullStreams | null = null;
        let tempVideoPath: string | null = null;
        let tempSystemAudioPath: string | null = null;
        let tempMicPath: string | null = null;
        try {
          const exePath = getWindowsCaptureExePath();
          const recordingsDir = await getRecordingsDir();
          const timestamp = resolveRecordingSessionId(options);
          const outputPath = path.join(
            recordingsDir,
            `recording-${timestamp}.mp4`,
          );
          tempVideoPath = path.join(
            app.getPath("temp"),
            `recordly-native-${timestamp}.mp4`,
          );

          let captureOutput = "";
          let systemAudioPath: string | null = null;
          let microphonePath: string | null = null;
          let orphanedMicAudioPath: string | null = null;

          const browserMicFallbackRequested =
            shouldStartWindowsBrowserMicrophoneFallback(options);
          const captureTarget = resolveWindowsCaptureTarget(
            source,
            getScreen().getAllDisplays(),
            getScreen().getPrimaryDisplay(),
          );
          const displayBounds =
            captureTarget.kind === "display" ? captureTarget.bounds : null;
          setWindowsOrphanedMicAudioPath(null);

          const config: Record<string, unknown> = {
            outputPath: tempVideoPath,
            fps: 60,
          };

          if (captureTarget.kind === "invalid-window") {
            return {
              success: false,
              message:
                "Selected window is no longer available. Please choose the window again.",
            };
          }

          if (captureTarget.kind === "window") {
            config.windowHandle = captureTarget.windowHandle;
          } else {
            // Windows Graphics Capture (WGC) requires a raw HMONITOR handle.
            // We attempt to resolve the handle by matching the physical coordinates of the target display.
            const monitors = getMonitorHandles();
            const matchedMonitor = monitors.find(
              (monitor) =>
                monitor.x === Math.round(captureTarget.bounds.x) &&
                monitor.y === Math.round(captureTarget.bounds.y),
            );

            if (matchedMonitor) {
              config.displayId = matchedMonitor.handle;
            } else {
              // Fallback to coordinate-based matching if handle resolution fails
              config.displayId = captureTarget.displayId;
            }

            config.displayX = Math.round(captureTarget.bounds.x);
            config.displayY = Math.round(captureTarget.bounds.y);
            config.displayW = Math.round(captureTarget.bounds.width);
            config.displayH = Math.round(captureTarget.bounds.height);
          }

          if (options?.capturesSystemAudio) {
            systemAudioPath = path.join(
              recordingsDir,
              `recording-${timestamp}.system.wav`,
            );
            tempSystemAudioPath = path.join(
              app.getPath("temp"),
              `recordly-native-${timestamp}.system.wav`,
            );
            config.captureSystemAudio = true;
            config.audioOutputPath = tempSystemAudioPath;
            setWindowsSystemAudioPath(systemAudioPath);
          } else {
            setWindowsSystemAudioPath(null);
          }

          if (options?.capturesMicrophone && !browserMicFallbackRequested) {
            microphonePath = path.join(
              recordingsDir,
              `recording-${timestamp}.mic.wav`,
            );
            tempMicPath = path.join(
              app.getPath("temp"),
              `recordly-native-${timestamp}.mic.wav`,
            );
            config.captureMic = true;
            config.micOutputPath = tempMicPath;
            if (options.microphoneLabel) {
              config.micDeviceName = options.microphoneLabel;
            }
            setWindowsMicAudioPath(microphonePath);
          } else if (browserMicFallbackRequested) {
            config.captureMic = false;
            setWindowsMicAudioPath(null);
          } else {
            setWindowsMicAudioPath(null);
          }

          recordNativeCaptureDiagnostics({
            backend: "windows-wgc",
            phase: "start",
            sourceId: source?.id ?? null,
            sourceType: source?.sourceType ?? "unknown",
            displayId:
              typeof config.displayId === "number" ? config.displayId : null,
            displayBounds,
            windowHandle:
              typeof config.windowHandle === "number"
                ? config.windowHandle
                : null,
            helperPath: exePath,
            outputPath,
            systemAudioPath,
            microphonePath,
          });

          setWindowsCaptureOutputBuffer("");
          setWindowsCaptureTargetPath(outputPath);
          setWindowsCaptureStopRequested(false);
          setWindowsCapturePaused(false);

          // The native helper currently does not declare DPI awareness in its own
          // manifest or process setup, so we keep the compatibility flag here until
          // scaled-display capture is verified without it on Windows.
          wcProc = spawn(exePath, [JSON.stringify(config)], {
            cwd: recordingsDir,
            stdio: ["pipe", "pipe", "pipe"],
            env: { ...process.env, __COMPAT_LAYER: "HighDpiAware" },
          });
          setWindowsCaptureProcess(wcProc);
          attachWindowsCaptureLifecycle(wcProc);

          wcProc.stdout.on("data", (chunk: Buffer) => {
            const msg = chunk.toString();
            captureOutput += msg;
            setWindowsCaptureOutputBuffer(captureOutput);
          });
          wcProc.stderr.on("data", (chunk: Buffer) => {
            const msg = chunk.toString();
            captureOutput += msg;
            setWindowsCaptureOutputBuffer(captureOutput);
          });

          await waitForWindowsCaptureStart(wcProc);
          const microphoneFallbackRequired =
            browserMicFallbackRequested ||
            shouldUseWindowsBrowserMicrophoneFallback(captureOutput, options);
          if (microphoneFallbackRequired) {
            orphanedMicAudioPath = tempMicPath ?? microphonePath;
            setWindowsOrphanedMicAudioPath(orphanedMicAudioPath);
            microphonePath = null;
            setWindowsMicAudioPath(null);
          }
          setWindowsNativeCaptureActive(true);
          setNativeScreenRecordingActive(true);
          recordNativeCaptureDiagnostics({
            backend: "windows-wgc",
            phase: "start",
            sourceId: source?.id ?? null,
            sourceType: source?.sourceType ?? "unknown",
            displayId:
              typeof config.displayId === "number" ? config.displayId : null,
            displayBounds,
            windowHandle:
              typeof config.windowHandle === "number"
                ? config.windowHandle
                : null,
            helperPath: exePath,
            outputPath,
            systemAudioPath,
            microphonePath,
            processOutput: captureOutput.trim() || undefined,
          });
          return { success: true, microphoneFallbackRequired };
        } catch (error) {
          recordNativeCaptureDiagnostics({
            backend: "windows-wgc",
            phase: "start",
            sourceId: source?.id ?? null,
            sourceType: source?.sourceType ?? "unknown",
            helperPath: windowsCaptureTargetPath
              ? getWindowsCaptureExePath()
              : null,
            outputPath: windowsCaptureTargetPath,
            systemAudioPath: windowsSystemAudioPath,
            microphonePath: windowsMicAudioPath,
            processOutput: windowsCaptureOutputBuffer.trim() || undefined,
            error: String(error),
          });
          console.error("Failed to start native Windows capture:", error);
          try {
            if (wcProc) wcProc.kill();
          } catch {
            /* ignore */
          }
          await Promise.allSettled([
            tempVideoPath
              ? fs.rm(tempVideoPath, { force: true }).catch(() => undefined)
              : Promise.resolve(),
            tempSystemAudioPath
              ? fs
                  .rm(tempSystemAudioPath, { force: true })
                  .catch(() => undefined)
              : Promise.resolve(),
            tempMicPath
              ? fs.rm(tempMicPath, { force: true }).catch(() => undefined)
              : Promise.resolve(),
          ]);
          setWindowsNativeCaptureActive(false);
          setNativeScreenRecordingActive(false);
          setWindowsCaptureProcess(null);
          setWindowsCaptureTargetPath(null);
          setWindowsSystemAudioPath(null);
          setWindowsMicAudioPath(null);
          setWindowsOrphanedMicAudioPath(null);
          setWindowsCaptureStopRequested(false);
          setWindowsCapturePaused(false);
          return {
            success: false,
            message: "Failed to start native Windows capture",
            error: String(error),
          };
        }
      }

      if (process.platform !== "darwin") {
        return {
          success: false,
          message: "Native screen recording is only available on macOS.",
        };
      }

      if (nativeCaptureProcess && !nativeScreenRecordingActive) {
        try {
          nativeCaptureProcess.kill();
        } catch {
          // ignore stale helper cleanup failures
        }
        setNativeCaptureProcess(null);
        setNativeCaptureTargetPath(null);
        setNativeCaptureStopRequested(false);
      }

      if (nativeCaptureProcess) {
        return {
          success: false,
          message: "A native screen recording is already active.",
        };
      }

      let captProc: ChildProcessWithoutNullStreams | null = null;
      let activeNativeWebcamPreviewPath: string | null = null;
      let activeNativeWebcamPreviewFramePaths = new Set<string>();
      let activeNativeWebcamPreviewStreamId: string | null = null;
      let activeNativeWebcamPreviewStreamUrl: string | null = null;
      const shouldEmitNativeWebcamPreviewRendererFrame =
        createNativeWebcamPreviewRendererUpdateGate();
      let nativeWebcamFailClosed = false;
      const stopActiveNativeWebcamPreview = (
        details?: Record<string, unknown>,
      ) => {
        if (!activeNativeWebcamPreviewPath) {
          return;
        }
        emitNativeWebcamPreview({
          active: false,
          status: "stopped",
          path: activeNativeWebcamPreviewPath,
          streamUrl: activeNativeWebcamPreviewStreamUrl,
          updatedAt: Date.now(),
          details,
        });
        unregisterMjpegPreviewStream(activeNativeWebcamPreviewStreamId);
        activeNativeWebcamPreviewPath = null;
        activeNativeWebcamPreviewFramePaths = new Set();
        activeNativeWebcamPreviewStreamId = null;
        activeNativeWebcamPreviewStreamUrl = null;
      };
      const failClosedNativeWebcamCapture = (
        reason: string,
        details?: Record<string, unknown>,
      ) => {
        if (nativeWebcamFailClosed) {
          return;
        }
        nativeWebcamFailClosed = true;
        setNativeCaptureWebcamPath(null);
        const currentVideoPath = nativeCaptureTargetPath;
        if (currentVideoPath) {
          try {
            clearMacRecoveryManifestWebcamPathSync(currentVideoPath, reason);
          } catch (error) {
            console.warn("Failed to clear native webcam recovery path:", error);
          }
        }
        stopActiveNativeWebcamPreview({
          reason,
          ...(details ?? {}),
        });
        emitRecordingDegraded({
          reason: "native-webcam-fail-closed",
          message:
            "Native webcam capture failed closed. Recordly stopped the recording instead of continuing with stale or missing facecam frames.",
          severity: "error",
          details: {
            failClosedReason: reason,
            ...(details ?? {}),
          },
        });
        appendNativeCaptureOutputBuffer(
          `WEBCAM_CAPTURE_FAIL_CLOSED reason=${reason}\n`,
        );
        if (shouldRequestNativeFailClosedHelperStop(details)) {
          requestNativeFailClosedHelperStop({
            process: captProc,
            appendLog: appendNativeCaptureOutputBuffer,
          });
        }
      };
      try {
        const recordingsDir = await getRecordingsDir();

        // Ensure microphone TCC is granted for this process tree when mic capture
        // is requested, so the child helper inherits the grant.
        if (options?.capturesMicrophone) {
          const micStatus =
            systemPreferences.getMediaAccessStatus("microphone");
          if (micStatus !== "granted") {
            await systemPreferences.askForMediaAccess("microphone");
          }
        }

        if (options?.capturesWebcam) {
          const cameraStatus = systemPreferences.getMediaAccessStatus("camera");
          if (cameraStatus !== "granted") {
            await systemPreferences.askForMediaAccess("camera");
          }
        }

        const appName = normalizeDesktopSourceName(
          String(source?.appName ?? ""),
        );
        const ownAppName = normalizeDesktopSourceName(app.getName());
        if (
          !ALLOW_RECORDLY_WINDOW_CAPTURE &&
          source?.id?.startsWith("window:") &&
          appName &&
          (appName === ownAppName || appName === "recordly")
        ) {
          return {
            success: false,
            message:
              "Cannot record Recordly windows. Please select another app window.",
          };
        }

        const helperPath = await ensureNativeCaptureHelperBinary();
        const timestamp = resolveRecordingSessionId(options);
        const outputPath = path.join(
          recordingsDir,
          `recording-${timestamp}.mp4`,
        );
        const capturesSystemAudio = Boolean(options?.capturesSystemAudio);
        const capturesMicrophone = Boolean(options?.capturesMicrophone);
        const capturesWebcam = Boolean(options?.capturesWebcam);
        const nativePreviewHandoff = capturesWebcam
          ? await stopNativeWebcamPreviewSession("recording-start")
          : null;
        if (nativePreviewHandoff?.stopped) {
          void queueNativeEventLogWrite(
            {
              recordingsDir,
              sessionId: timestamp,
              event: "native-webcam-preview-handoff",
              details: {
                reason: "recording-start",
                ...nativePreviewHandoff.summary,
              },
            },
            "Failed to write native webcam preview handoff event:",
          );
        }
        const systemAudioOutputPath = capturesSystemAudio
          ? path.join(recordingsDir, `recording-${timestamp}.system.m4a`)
          : null;
        const microphoneOutputPath = capturesMicrophone
          ? path.join(recordingsDir, `recording-${timestamp}.mic.m4a`)
          : null;
        const webcamOutputPath = capturesWebcam
          ? path.join(recordingsDir, `recording-${timestamp}-webcam.mp4`)
          : null;
        const webcamPreviewPath = capturesWebcam
          ? path.join(
              recordingsDir,
              `recording-${timestamp}-webcam-preview.jpg`,
            )
          : null;
        const config: Record<string, unknown> = {
          fps: 30,
          outputPath,
          capturesSystemAudio,
          capturesMicrophone,
          capturesWebcam,
        };

        if (options?.microphoneDeviceId) {
          config.microphoneDeviceId = options.microphoneDeviceId;
        }

        if (options?.microphoneLabel) {
          config.microphoneLabel = options.microphoneLabel;
        }

        if (systemAudioOutputPath) {
          config.systemAudioOutputPath = systemAudioOutputPath;
        }

        if (microphoneOutputPath) {
          config.microphoneOutputPath = microphoneOutputPath;
        }

        if (webcamOutputPath) {
          config.webcamOutputPath = webcamOutputPath;
          config.webcamPreviewPath = webcamPreviewPath;
          config.webcamWidth = options?.webcamWidth ?? 1280;
          config.webcamHeight = options?.webcamHeight ?? 720;
          config.webcamFPS = options?.webcamFPS ?? 30;
          if (options?.webcamDeviceId) {
            config.webcamDeviceId = options.webcamDeviceId;
          }
          if (options?.webcamLabel) {
            config.webcamLabel = options.webcamLabel;
          }
        }

        const windowId = parseWindowId(source?.id);
        const screenId = Number(source?.display_id);

        if (
          Number.isFinite(windowId) &&
          windowId &&
          source?.id?.startsWith("window:")
        ) {
          config.windowId = windowId;
        } else if (Number.isFinite(screenId) && screenId > 0) {
          config.displayId = screenId;
        } else {
          config.displayId = Number(getScreen().getPrimaryDisplay().id);
        }

        const nextNativeWebcamPreviewFramePaths: Set<string> = webcamPreviewPath
          ? new Set<string>(
              deriveNativeWebcamPreviewFramePaths(webcamPreviewPath),
            )
          : new Set<string>();
        const nextNativeWebcamPreviewStreamId: string | null = webcamPreviewPath
          ? `recording-${timestamp}-${randomUUID()}`
          : null;
        let nextNativeWebcamPreviewStreamUrl: string | null = null;
        if (webcamPreviewPath) {
          if (
            !nextNativeWebcamPreviewStreamId ||
            nextNativeWebcamPreviewFramePaths.size === 0
          ) {
            return {
              success: false,
              message:
                "Native webcam preview stream could not start. Recordly did not start recording because webcam preview would be unreliable.",
            };
          }

          let baseUrl: string;
          try {
            baseUrl = await ensureMediaServer();
          } catch (error) {
            return {
              success: false,
              message:
                "Native webcam preview stream could not start. Recordly did not start recording because webcam preview would be unreliable.",
              error: String(error),
            };
          }

          approveUserPath(webcamPreviewPath);
          for (const previewFramePath of nextNativeWebcamPreviewFramePaths) {
            approveUserPath(previewFramePath);
          }
          registerMjpegPreviewStream(
            nextNativeWebcamPreviewStreamId,
            Array.from(nextNativeWebcamPreviewFramePaths),
          );
          nextNativeWebcamPreviewStreamUrl = buildMjpegPreviewStreamUrl(
            baseUrl,
            nextNativeWebcamPreviewStreamId,
          );
        }

        setNativeCaptureOutputBuffer("");
        setNativeCaptureTargetPath(outputPath);
        setNativeCaptureSystemAudioPath(systemAudioOutputPath);
        setNativeCaptureMicrophonePath(microphoneOutputPath);
        setNativeCaptureWebcamPath(webcamOutputPath);
        activeNativeWebcamPreviewPath = webcamPreviewPath;
        activeNativeWebcamPreviewFramePaths = nextNativeWebcamPreviewFramePaths;
        activeNativeWebcamPreviewStreamId = nextNativeWebcamPreviewStreamId;
        activeNativeWebcamPreviewStreamUrl = nextNativeWebcamPreviewStreamUrl;
        if (webcamPreviewPath) {
          emitNativeWebcamPreview({
            active: true,
            status: "starting",
            path: webcamPreviewPath,
            streamUrl: nextNativeWebcamPreviewStreamUrl,
            updatedAt: Date.now(),
          });
        }
        setNativeCaptureStopRequested(false);
        setNativeCapturePaused(false);
        const nativeHelperEventCounts = new Map<string, number>();
        const notifiedNativeHelperEvents = new Set<string>();
        let nativeHelperLineBuffer = "";
        let nativeCaptureHealth: NativeCaptureHealthSupervisor;
        nativeCaptureHealth = new NativeCaptureHealthSupervisor({
          requiresWebcam: capturesWebcam,
          requiresMicrophoneAudio: capturesMicrophone,
          isPaused: () => nativeCapturePaused,
          onIssue: (issue) => {
            void queueNativeEventLogWrite(
              {
                recordingsDir,
                sessionId: timestamp,
                event: issue.event,
                details: {
                  severity: issue.severity,
                  source: "native-capture-health-supervisor",
                  ...issue.details,
                },
              },
              "Failed to write native capture health event:",
            );

            if (!notifiedNativeHelperEvents.has(issue.event)) {
              notifiedNativeHelperEvents.add(issue.event);
              emitRecordingDegraded({
                reason: issue.event,
                message: issue.message,
                severity: issue.severity,
                details: issue.details,
              });
            }

            if (
              issue.event === "native-webcam-capture-stats-stale" ||
              issue.event === "native-webcam-capture-low-cadence-sustained" ||
              issue.event === "native-webcam-visual-stall-fail-closed" ||
              issue.event === "native-webcam-proof-preview-stale" ||
              issue.event === "native-webcam-proof-preview-lagging"
            ) {
              let reason = "main-webcam-stats-timeout";
              if (
                issue.event === "native-webcam-capture-low-cadence-sustained"
              ) {
                reason = "main-webcam-low-cadence";
              } else if (
                issue.event === "native-webcam-visual-stall-fail-closed"
              ) {
                reason = "main-webcam-visual-stall";
              } else if (issue.event === "native-webcam-proof-preview-stale") {
                reason = "main-webcam-proof-preview-stale";
              } else if (
                issue.event === "native-webcam-proof-preview-lagging"
              ) {
                reason = "main-webcam-proof-preview-lagging";
              }
              appendNativeCaptureOutputBuffer(
                `WEBCAM_CAPTURE_DISABLED reason=${reason} staleForMs=${issue.details.staleForMs ?? "unknown"} previewStaleForMs=${issue.details.previewStaleForMs ?? "unknown"} previewWriterLagSeconds=${issue.details.previewWriterLagSeconds ?? "unknown"} previewWriterFrameLag=${issue.details.previewWriterFrameLag ?? "unknown"} lowCadenceForMs=${issue.details.lowCadenceForMs ?? "unknown"} stalledFor=${issue.details.stalledFor ?? "unknown"} meanDiff=${issue.details.meanDiff ?? "unknown"}\n`,
              );
              nativeCaptureHealth.observe({
                event: "native-webcam-capture-disabled",
                severity: "error",
                details: issue.details,
              });
              failClosedNativeWebcamCapture(reason, issue.details);
            }

            if (
              issue.event === "native-video-capture-stats-stale" ||
              issue.event === "native-video-stream-stopped-with-error"
            ) {
              const reason =
                issue.event === "native-video-stream-stopped-with-error"
                  ? "main-video-stream-stopped-with-error"
                  : "main-video-stats-timeout";
              appendNativeCaptureOutputBuffer(
                `VIDEO_PIPELINE_STALLED reason=${reason} lag=${issue.details.staleForMs ?? "unknown"} stalledFor=${issue.details.staleForMs ?? "unknown"}\n`,
              );
              nativeCaptureHealth.stop();
              captProc?.kill("SIGTERM");
            }

            if (issue.event === "native-audio-capture-stats-stale") {
              appendNativeCaptureOutputBuffer(
                `AUDIO_PIPELINE_STALLED reason=main-audio-stats-timeout stalledFor=${issue.details.staleForMs ?? "unknown"} audioVideoDrift=unknown audioEnd=unknown videoEnd=unknown action=stop-recording\n`,
              );
              nativeCaptureHealth.stop();
              captProc?.kill("SIGTERM");
            }
          },
        });
        const handleNativeHelperOutputLine = (line: string) => {
          const parsed = parseNativeHelperOutputLine(line);
          if (!parsed) {
            return;
          }
          nativeCaptureHealth.observe(parsed);

          const eventCount =
            (nativeHelperEventCounts.get(parsed.event) ?? 0) + 1;
          nativeHelperEventCounts.set(parsed.event, eventCount);
          const isRepeatedWriterAppendEvent =
            parsed.event === "native-video-pixel-buffer-append-skipped" ||
            parsed.event === "native-video-pixel-buffer-append-failed";
          const isHighFrequencyPreviewEvent =
            parsed.event === "native-webcam-preview-frame-written";
          const shouldPersist =
            isRepeatedWriterAppendEvent || isHighFrequencyPreviewEvent
              ? eventCount <= 5 || eventCount % 30 === 0
              : true;

          if (shouldPersist) {
            void queueNativeEventLogWrite(
              {
                recordingsDir,
                sessionId: timestamp,
                event: parsed.event,
                details: {
                  severity: parsed.severity,
                  count: eventCount,
                  line,
                  ...parsed.details,
                },
              },
              "Failed to write native helper output event:",
            );
          }

          if (
            parsed.notifyRenderer &&
            !notifiedNativeHelperEvents.has(parsed.event)
          ) {
            notifiedNativeHelperEvents.add(parsed.event);
            emitRecordingDegraded({
              reason: parsed.event,
              message: parsed.message ?? parsed.event,
              severity: parsed.severity,
              details: parsed.details,
            });
          }

          if (
            parsed.event === "native-webcam-preview-frame-written" &&
            activeNativeWebcamPreviewPath
          ) {
            const baseUrl = getMediaServerBaseUrl();
            if (
              !baseUrl ||
              !activeNativeWebcamPreviewStreamId ||
              !activeNativeWebcamPreviewStreamUrl
            ) {
              failClosedNativeWebcamCapture(
                "main-webcam-preview-stream-unavailable",
                {
                  line,
                  baseUrl,
                  hasStreamId: Boolean(activeNativeWebcamPreviewStreamId),
                  hasStreamUrl: Boolean(activeNativeWebcamPreviewStreamUrl),
                  ...parsed.details,
                },
              );
              return;
            }

            const previewFramePath = resolveNativeWebcamPreviewFramePath(
              parsed.details.path,
              activeNativeWebcamPreviewFramePaths,
            );
            if (!previewFramePath) {
              const rejectionDetails = {
                reason: "preview-path-outside-approved-ring",
                line,
                path: parsed.details.path,
                allowedPaths: Array.from(activeNativeWebcamPreviewFramePaths),
                ...parsed.details,
              };
              void queueNativeEventLogWrite(
                {
                  recordingsDir,
                  sessionId: timestamp,
                  event: "native-webcam-preview-frame-rejected",
                  details: rejectionDetails,
                },
                "Failed to write native preview rejection event:",
              );
              failClosedNativeWebcamCapture(
                "main-webcam-proof-preview-path-invalid",
                rejectionDetails,
              );
              return;
            }
            const previewDecision = acceptNativeWebcamPreviewCorrelation(
              parsed.details,
            );
            if (!previewDecision.accepted) {
              const rejectionDetails = {
                reason: previewDecision.reason,
                line,
                previousCorrelation: previewDecision.previous,
                correlation: previewDecision.correlation,
                consecutiveRejectedCount:
                  previewDecision.consecutiveRejectedCount,
                failClosed: previewDecision.failClosed,
                ...parsed.details,
              };
              void queueNativeEventLogWrite(
                {
                  recordingsDir,
                  sessionId: timestamp,
                  event: "native-webcam-preview-frame-rejected",
                  details: rejectionDetails,
                },
                "Failed to write native preview rejection event:",
              );
              if (previewDecision.failClosed) {
                const issueEvent = "native-webcam-proof-preview-invalid";
                if (!notifiedNativeHelperEvents.has(issueEvent)) {
                  notifiedNativeHelperEvents.add(issueEvent);
                  emitRecordingDegraded({
                    reason: issueEvent,
                    message:
                      "Native webcam proof preview stopped matching accepted writer frames. Recordly stopped the recording instead of trusting stale preview evidence.",
                    severity: "error",
                    details: rejectionDetails,
                  });
                }
                failClosedNativeWebcamCapture(
                  "main-webcam-proof-preview-invalid",
                  rejectionDetails,
                );
              }
              return;
            }
            const acceptedProofDetails = {
              ...parsed.details,
              sequence: previewDecision.correlation.sequence,
              acceptedFrame: previewDecision.correlation.acceptedFrame,
              acceptedPts: previewDecision.correlation.acceptedPts,
            };
            const publishDecision = publishNativeWebcamProofPreviewFrame({
              streamId: activeNativeWebcamPreviewStreamId,
              framePath: previewFramePath,
              sequence: previewDecision.correlation.sequence,
              publishFrame: publishMjpegPreviewFrame,
            });
            if (!publishDecision.accepted) {
              const rejectionDetails = {
                reason: publishDecision.reason,
                line,
                ...publishDecision.details,
                ...acceptedProofDetails,
              };
              void queueNativeEventLogWrite(
                {
                  recordingsDir,
                  sessionId: timestamp,
                  event: "native-webcam-preview-frame-rejected",
                  details: rejectionDetails,
                },
                "Failed to write native preview publish rejection event:",
              );
              const issueEvent = "native-webcam-proof-preview-publish-failed";
              void queueNativeEventLogWrite(
                {
                  recordingsDir,
                  sessionId: timestamp,
                  event: issueEvent,
                  details: rejectionDetails,
                },
                "Failed to write native preview publish failure event:",
              );
              if (!notifiedNativeHelperEvents.has(issueEvent)) {
                notifiedNativeHelperEvents.add(issueEvent);
                emitRecordingDegraded({
                  reason: issueEvent,
                  message:
                    "Native webcam proof preview could not publish the accepted writer frame. Recordly stopped the recording instead of showing stale camera frames.",
                  severity: "error",
                  details: rejectionDetails,
                });
              }
              failClosedNativeWebcamCapture(
                "main-webcam-proof-preview-publish-failed",
                rejectionDetails,
              );
              return;
            }
            const acceptedProofCount =
              (nativeHelperEventCounts.get(
                "native-webcam-proof-preview-accepted",
              ) ?? 0) + 1;
            nativeHelperEventCounts.set(
              "native-webcam-proof-preview-accepted",
              acceptedProofCount,
            );
            const shouldPersistAcceptedProof =
              acceptedProofCount <= 5 || acceptedProofCount % 30 === 0;
            if (shouldPersistAcceptedProof) {
              void queueNativeEventLogWrite(
                {
                  recordingsDir,
                  sessionId: timestamp,
                  event: "native-webcam-proof-preview-accepted",
                  details: {
                    count: acceptedProofCount,
                    ...acceptedProofDetails,
                  },
                },
                "Failed to write native accepted proof-preview event:",
              );
            }
            nativeCaptureHealth.observe({
              event: "native-webcam-proof-preview-accepted",
              severity: "info",
              details: acceptedProofDetails,
            });
            if (shouldPersistAcceptedProof) {
              appendNativeCaptureOutputBuffer(
                `WEBCAM_PROOF_PREVIEW_ACCEPTED sequence=${previewDecision.correlation.sequence} acceptedFrame=${previewDecision.correlation.acceptedFrame} acceptedPts=${previewDecision.correlation.acceptedPts}\n`,
              );
            }
            if (
              shouldEmitNativeWebcamPreviewRendererFrame(
                previewDecision.correlation.sequence,
              )
            ) {
              emitNativeWebcamPreview({
                active: true,
                status: "frame",
                path: previewFramePath,
                url: activeNativeWebcamPreviewStreamId
                  ? `${buildMjpegPreviewSnapshotUrl(baseUrl, activeNativeWebcamPreviewStreamId)}&seq=${previewDecision.correlation.sequence}`
                  : `${buildMediaUrl(baseUrl, previewFramePath)}&seq=${previewDecision.correlation.sequence}`,
                streamUrl: activeNativeWebcamPreviewStreamUrl,
                updatedAt: Date.now(),
                details: acceptedProofDetails,
              });
            }
          }

          if (
            parsed.event === "native-webcam-pipeline-stalled" ||
            parsed.event === "native-webcam-capture-disabled"
          ) {
            failClosedNativeWebcamCapture(parsed.event, parsed.details);
          }

          if (parsed.event === "native-audio-pipeline-stalled") {
            nativeCaptureHealth.stop();
          }
        };
        const acceptNativeWebcamPreviewCorrelation =
          createNativeWebcamPreviewCorrelationTracker();
        const handleNativeHelperOutput = (chunk: Buffer) => {
          const text = chunk.toString();
          appendNativeCaptureOutputBuffer(text);
          nativeHelperLineBuffer += text;
          const lines = nativeHelperLineBuffer.split(/\r?\n/);
          nativeHelperLineBuffer = lines.pop() ?? "";
          for (const line of lines) {
            handleNativeHelperOutputLine(line);
          }
        };
        captProc = spawn(helperPath, [JSON.stringify(config)], {
          cwd: recordingsDir,
          stdio: ["pipe", "pipe", "pipe"],
        });
        setNativeCaptureProcess(captProc);
        await writeMacRecoveryManifest({
          videoPath: outputPath,
          systemAudioPath: systemAudioOutputPath,
          microphonePath: microphoneOutputPath,
          webcamPath: webcamOutputPath,
          sourceId: source?.id ?? null,
          sourceType: source?.sourceType ?? "unknown",
          displayId:
            typeof config.displayId === "number" ? config.displayId : null,
          helperPid: captProc.pid ?? null,
          fragmentIntervalSeconds: MAC_RECOVERY_FRAGMENT_INTERVAL_SECONDS,
        });
        attachNativeCaptureLifecycle(captProc);

        captProc.stdout.on("data", handleNativeHelperOutput);
        captProc.stderr.on("data", handleNativeHelperOutput);
        captProc.once("close", () => {
          const trailingLine = nativeHelperLineBuffer.trim();
          if (trailingLine) {
            handleNativeHelperOutputLine(trailingLine);
          }
          nativeHelperLineBuffer = "";
          nativeCaptureHealth.stop();
          stopActiveNativeWebcamPreview();
        });

        await waitForNativeCaptureStart(captProc, {
          maxInitialWebcamProofAcceptedPtsSeconds: nativePreviewHandoff?.stopped
            ? NATIVE_WEBCAM_PREVIEW_HANDOFF_REPROOF_SECONDS
            : undefined,
          maxInitialWebcamVisiblePtsSeconds: nativePreviewHandoff?.stopped
            ? NATIVE_WEBCAM_PREVIEW_HANDOFF_REPROOF_SECONDS
            : undefined,
          requiresMicrophoneAudio: capturesMicrophone,
          requiresWebcamFirstFrame: capturesWebcam,
          requiresWebcamProofPreview: capturesWebcam,
        });
        nativeCaptureHealth.start();
        setNativeScreenRecordingActive(true);

        // If the native helper reported MICROPHONE_CAPTURE_UNAVAILABLE, it started
        // capture without microphone.  Clear the mic path so the renderer can fall
        // back to a browser-side sidecar recording for the microphone track.
        const micUnavailableNatively = nativeCaptureOutputBuffer.includes(
          "MICROPHONE_CAPTURE_UNAVAILABLE",
        );
        if (micUnavailableNatively) {
          nativeCaptureHealth.setRequiresMicrophoneAudio(false);
          setNativeCaptureMicrophonePath(null);
        }
        const nativeWebcamPath = resolveNativeWebcamPathAfterStart({
          webcamOutputPath,
          nativeWebcamFailClosed,
        });
        const nativeWebcamStartOffsetMs = capturesWebcam
          ? getNativeWebcamStartOffsetMs(nativeCaptureOutputBuffer)
          : null;
        const nativeRecordingStartLeadMs = capturesWebcam
          ? getNativeCaptureStartLeadMs(nativeCaptureOutputBuffer)
          : 0;
        if (nativeWebcamStartOffsetMs !== null) {
          void queueNativeEventLogWrite(
            {
              recordingsDir,
              sessionId: timestamp,
              event: "native-webcam-start-offset-measured",
              details: {
                offsetMs: nativeWebcamStartOffsetMs,
                webcamPath: nativeWebcamPath,
              },
            },
            "Failed to write native webcam start-offset event:",
          );
        }
        if (nativeRecordingStartLeadMs !== null && nativeRecordingStartLeadMs > 0) {
          void queueNativeEventLogWrite(
            {
              recordingsDir,
              sessionId: timestamp,
              event: "native-recording-start-lead-measured",
              details: {
                leadMs: nativeRecordingStartLeadMs,
                capturesWebcam,
              },
            },
            "Failed to write native recording start-lead event:",
          );
        }

        recordNativeCaptureDiagnostics({
          backend: "mac-screencapturekit",
          phase: "start",
          sourceId: source?.id ?? null,
          sourceType: source?.sourceType ?? "unknown",
          displayId:
            typeof config.displayId === "number" ? config.displayId : null,
          helperPath,
          outputPath,
          systemAudioPath: systemAudioOutputPath,
          microphonePath: nativeCaptureMicrophonePath,
          processOutput: nativeCaptureOutputBuffer.trim() || undefined,
        });
        return {
          success: true,
          microphoneFallbackRequired: micUnavailableNatively,
          webcamPath: nativeWebcamPath,
          webcamStartOffsetMs: nativeWebcamStartOffsetMs,
          recordingStartLeadMs: nativeRecordingStartLeadMs,
        };
      } catch (error) {
        console.error(
          "Failed to start native ScreenCaptureKit recording:",
          error,
        );
        stopActiveNativeWebcamPreview({
          reason: "native-start-failed",
          error: String(error),
        });
        const errorStr = String(error);

        // Detect TCC (screen recording permission) errors and show a helpful dialog
        if (
          errorStr.includes("declined TCC") ||
          errorStr.includes("declined TCCs") ||
          errorStr.includes("SCREEN_RECORDING_PERMISSION_DENIED")
        ) {
          const { response } = await dialog.showMessageBox({
            type: "warning",
            title: "Screen Recording Permission Required",
            message:
              "Recordly needs screen recording permission to capture your screen.",
            detail:
              "Please open System Settings > Privacy & Security > Screen Recording, make sure Recordly is toggled ON, then try recording again.",
            buttons: ["Open System Settings", "Cancel"],
            defaultId: 0,
            cancelId: 1,
          });
          if (response === 0) {
            await shell.openExternal(getMacPrivacySettingsUrl("screen"));
          }
          try {
            if (captProc) captProc.kill();
          } catch {
            /* ignore */
          }
          await removeMacRecoveryManifest(nativeCaptureTargetPath);
          setNativeScreenRecordingActive(false);
          setNativeCaptureProcess(null);
          setNativeCaptureTargetPath(null);
          setNativeCaptureSystemAudioPath(null);
          setNativeCaptureMicrophonePath(null);
          setNativeCaptureWebcamPath(null);
          setNativeCaptureStopRequested(false);
          setNativeCapturePaused(false);
          return {
            success: false,
            message:
              "Screen recording permission not granted. Please allow access in System Settings and restart the app.",
            userNotified: true,
          };
        }

        if (errorStr.includes("MICROPHONE_PERMISSION_DENIED")) {
          const { response } = await dialog.showMessageBox({
            type: "warning",
            title: "Microphone Permission Required",
            message: "Recordly needs microphone permission to record audio.",
            detail:
              "Please open System Settings > Privacy & Security > Microphone, make sure Recordly is toggled ON, then try recording again.",
            buttons: ["Open System Settings", "Cancel"],
            defaultId: 0,
            cancelId: 1,
          });
          if (response === 0) {
            await shell.openExternal(getMacPrivacySettingsUrl("microphone"));
          }
          try {
            if (captProc) captProc.kill();
          } catch {
            /* ignore */
          }
          await removeMacRecoveryManifest(nativeCaptureTargetPath);
          setNativeScreenRecordingActive(false);
          setNativeCaptureProcess(null);
          setNativeCaptureTargetPath(null);
          setNativeCaptureSystemAudioPath(null);
          setNativeCaptureMicrophonePath(null);
          setNativeCaptureWebcamPath(null);
          setNativeCaptureStopRequested(false);
          setNativeCapturePaused(false);
          return {
            success: false,
            message:
              "Microphone permission not granted. Please allow access in System Settings.",
            userNotified: true,
          };
        }

        if (errorStr.includes("CAMERA_PERMISSION_DENIED")) {
          const { response } = await dialog.showMessageBox({
            type: "warning",
            title: "Camera Permission Required",
            message: "Recordly needs camera permission to record the webcam.",
            detail:
              "Please open System Settings > Privacy & Security > Camera, make sure Recordly is toggled ON, then try recording again.",
            buttons: ["Open System Settings", "Cancel"],
            defaultId: 0,
            cancelId: 1,
          });
          if (response === 0) {
            await shell.openExternal(getMacPrivacySettingsUrl("camera"));
          }
          try {
            if (captProc) captProc.kill();
          } catch {
            /* ignore */
          }
          await removeMacRecoveryManifest(nativeCaptureTargetPath);
          setNativeScreenRecordingActive(false);
          setNativeCaptureProcess(null);
          setNativeCaptureTargetPath(null);
          setNativeCaptureSystemAudioPath(null);
          setNativeCaptureMicrophonePath(null);
          setNativeCaptureWebcamPath(null);
          setNativeCaptureStopRequested(false);
          setNativeCapturePaused(false);
          return {
            success: false,
            message:
              "Camera permission not granted. Please allow access in System Settings.",
            userNotified: true,
          };
        }

        recordNativeCaptureDiagnostics({
          backend: "mac-screencapturekit",
          phase: "start",
          sourceId: source?.id ?? null,
          sourceType: source?.sourceType ?? "unknown",
          helperPath: getNativeCaptureHelperBinaryPath(),
          outputPath: nativeCaptureTargetPath,
          systemAudioPath: nativeCaptureSystemAudioPath,
          microphonePath: nativeCaptureMicrophonePath,
          processOutput: nativeCaptureOutputBuffer.trim() || undefined,
          fileSizeBytes: await getFileSizeIfPresent(nativeCaptureTargetPath),
          error: String(error),
        });
        try {
          if (captProc) captProc.kill();
        } catch {
          // ignore cleanup failures
        }
        await removeMacRecoveryManifest(nativeCaptureTargetPath);
        setNativeScreenRecordingActive(false);
        setNativeCaptureProcess(null);
        setNativeCaptureTargetPath(null);
        setNativeCaptureSystemAudioPath(null);
        setNativeCaptureMicrophonePath(null);
        setNativeCaptureWebcamPath(null);
        setNativeCaptureStopRequested(false);
        setNativeCapturePaused(false);
        return {
          success: false,
          message: "Failed to start native ScreenCaptureKit recording",
          error: String(error),
        };
      }
    },
  );

  ipcMain.handle(
    "stop-native-screen-recording",
    async (
      _,
      options?: {
        expectedDurationMs?: number | null;
        deferAudioValidationUntilMicrophoneSidecar?: boolean;
      },
    ) => {
      const start = Date.now();
      const expectedDurationMs =
        typeof options?.expectedDurationMs === "number" &&
        Number.isFinite(options.expectedDurationMs)
          ? Math.max(0, Math.round(options.expectedDurationMs))
          : null;
      const deferAudioValidationUntilMicrophoneSidecar = Boolean(
        options?.deferAudioValidationUntilMicrophoneSidecar,
      );
      console.log("[PERF:MAIN] Handler: stop-native-screen-recording: STARTED");
      try {
        // Windows native capture stop path
        if (process.platform === "win32" && windowsNativeCaptureActive) {
          let stagedTempVideoPath: string | null = null;
          let stagedTempSystemAudioPath: string | null = null;
          let stagedTempMicAudioPath: string | null = null;
          try {
            if (!windowsCaptureProcess) {
              throw new Error("Native Windows capture process is not running");
            }

            const proc = windowsCaptureProcess;
            const preferredVideoPath = windowsCaptureTargetPath;
            const preferredOrphanedMicAudioPath = windowsOrphanedMicAudioPath;
            const diagnosticsSystemAudioPath = windowsSystemAudioPath;
            const diagnosticsMicAudioPath = windowsMicAudioPath;
            setWindowsCaptureStopRequested(true);
            proc.stdin.write("stop\n");
            const tempVideoPath = await waitForWindowsCaptureStop(proc);
            stagedTempVideoPath = tempVideoPath;
            const finalVideoPath = preferredVideoPath ?? tempVideoPath;

            // Native Windows capture results are initially written to a safe temporary path
            // (to avoid encoding failures with non-ASCII characters). We move them to the final
            // destination now using Node.js, which handles Unicode paths correctly.
            if (tempVideoPath !== finalVideoPath) {
              await moveFileWithOverwrite(tempVideoPath, finalVideoPath);
            }

            if (windowsSystemAudioPath && tempVideoPath.endsWith(".mp4")) {
              const tempAudioPath = tempVideoPath.replace(
                ".mp4",
                ".system.wav",
              );
              stagedTempSystemAudioPath = tempAudioPath;
              const finalAudioPath = windowsSystemAudioPath;
              if (await pathExists(tempAudioPath)) {
                await moveFileWithOverwrite(tempAudioPath, finalAudioPath);
                const tempJson = tempAudioPath + ".json";
                if (await pathExists(tempJson)) {
                  await moveFileWithOverwrite(
                    tempJson,
                    finalAudioPath + ".json",
                  );
                }
              }
            }

            if (windowsMicAudioPath && tempVideoPath.endsWith(".mp4")) {
              const tempMicPath = tempVideoPath.replace(".mp4", ".mic.wav");
              stagedTempMicAudioPath = tempMicPath;
              const finalMicPath = windowsMicAudioPath;
              if (await pathExists(tempMicPath)) {
                await moveFileWithOverwrite(tempMicPath, finalMicPath);
                const tempJson = tempMicPath + ".json";
                if (await pathExists(tempJson)) {
                  await moveFileWithOverwrite(tempJson, finalMicPath + ".json");
                }
              }
            }
            const validation = await validateRecordedVideo(finalVideoPath);

            setWindowsCaptureProcess(null);
            setWindowsNativeCaptureActive(false);
            setNativeScreenRecordingActive(false);
            setWindowsCaptureTargetPath(null);
            setWindowsCaptureStopRequested(false);
            setWindowsCapturePaused(false);
            setWindowsOrphanedMicAudioPath(null);
            await cleanupWindowsOrphanedMicAudioPath(
              preferredOrphanedMicAudioPath,
            );
            setWindowsPendingVideoPath(finalVideoPath);
            recordNativeCaptureDiagnostics({
              backend: "windows-wgc",
              phase: "stop",
              outputPath: finalVideoPath,
              systemAudioPath: diagnosticsSystemAudioPath,
              microphonePath: diagnosticsMicAudioPath,
              processOutput: windowsCaptureOutputBuffer.trim() || undefined,
              fileSizeBytes: validation.fileSizeBytes,
              expectedDurationMs,
            });
            await writeWindowsRecordingDiagnostics(finalVideoPath, {
              phase: "stop",
              expectedDurationMs,
              outputPath: finalVideoPath,
              systemAudioPath: diagnosticsSystemAudioPath,
              microphonePath: diagnosticsMicAudioPath,
              processOutput: windowsCaptureOutputBuffer.trim() || undefined,
              details: {
                fileSizeBytes: validation.fileSizeBytes,
                durationSeconds: validation.durationSeconds,
              },
            });

            // Persist cursor telemetry before returning so the editor can find it immediately
            snapshotCursorTelemetryForPersistence();
            try {
              await persistPendingCursorTelemetry(finalVideoPath);
            } catch (error) {
              console.warn(
                "Failed to persist cursor telemetry during native stop:",
                error,
              );
            }

            return { success: true, path: finalVideoPath };
          } catch (error) {
            console.error("Failed to stop native Windows capture:", error);
            const fallbackPath = await resolveExistingPath(
              windowsCaptureTargetPath,
              stagedTempVideoPath,
            );
            const recoveredSystemAudioPath = await resolveExistingPath(
              windowsSystemAudioPath,
              stagedTempSystemAudioPath,
            );
            const recoveredMicAudioPath = await resolveExistingPath(
              windowsMicAudioPath,
              stagedTempMicAudioPath,
            );
            const fallbackOrphanedMicAudioPath = windowsOrphanedMicAudioPath;
            const diagnosticsSystemAudioPath =
              recoveredSystemAudioPath ?? windowsSystemAudioPath;
            const diagnosticsMicAudioPath =
              recoveredMicAudioPath ?? windowsMicAudioPath;
            setWindowsNativeCaptureActive(false);
            setNativeScreenRecordingActive(false);
            setWindowsCaptureProcess(null);
            setWindowsCaptureTargetPath(null);
            setWindowsCaptureStopRequested(false);
            setWindowsCapturePaused(false);
            setWindowsOrphanedMicAudioPath(null);

            if (fallbackPath) {
              try {
                const validation = await validateRecordedVideo(fallbackPath);
                setWindowsPendingVideoPath(fallbackPath);
                setWindowsSystemAudioPath(recoveredSystemAudioPath);
                setWindowsMicAudioPath(recoveredMicAudioPath);
                await cleanupWindowsOrphanedMicAudioPath(
                  fallbackOrphanedMicAudioPath,
                );
                recordNativeCaptureDiagnostics({
                  backend: "windows-wgc",
                  phase: "stop",
                  outputPath: fallbackPath,
                  systemAudioPath: diagnosticsSystemAudioPath,
                  microphonePath: diagnosticsMicAudioPath,
                  processOutput: windowsCaptureOutputBuffer.trim() || undefined,
                  fileSizeBytes: validation.fileSizeBytes,
                  expectedDurationMs,
                  error: String(error),
                });
                await writeWindowsRecordingDiagnostics(fallbackPath, {
                  phase: "stop",
                  expectedDurationMs,
                  outputPath: fallbackPath,
                  systemAudioPath: diagnosticsSystemAudioPath,
                  microphonePath: diagnosticsMicAudioPath,
                  processOutput: windowsCaptureOutputBuffer.trim() || undefined,
                  error: String(error),
                  details: {
                    fileSizeBytes: validation.fileSizeBytes,
                    durationSeconds: validation.durationSeconds,
                    recoveredAfterStopFailure: true,
                  },
                });
                return { success: true, path: fallbackPath };
              } catch {
                // File is absent or failed validation.
              }
            }

            setWindowsSystemAudioPath(null);
            setWindowsMicAudioPath(null);
            setWindowsPendingVideoPath(null);
            await cleanupWindowsOrphanedMicAudioPath(
              fallbackOrphanedMicAudioPath,
            );

            recordNativeCaptureDiagnostics({
              backend: "windows-wgc",
              phase: "stop",
              outputPath: fallbackPath,
              systemAudioPath: diagnosticsSystemAudioPath,
              microphonePath: diagnosticsMicAudioPath,
              processOutput: windowsCaptureOutputBuffer.trim() || undefined,
              fileSizeBytes: await getFileSizeIfPresent(fallbackPath),
              expectedDurationMs,
              error: String(error),
            });
            await writeWindowsRecordingDiagnostics(fallbackPath, {
              phase: "stop",
              expectedDurationMs,
              outputPath: fallbackPath,
              systemAudioPath: diagnosticsSystemAudioPath,
              microphonePath: diagnosticsMicAudioPath,
              processOutput: windowsCaptureOutputBuffer.trim() || undefined,
              error: String(error),
              details: {
                fileSizeBytes: await getFileSizeIfPresent(fallbackPath),
              },
            });

            return {
              success: false,
              message: "Failed to stop native Windows capture",
              error: String(error),
            };
          }
        }

        if (process.platform !== "darwin") {
          return {
            success: false,
            message: "Native screen recording is only available on macOS.",
          };
        }

        if (!nativeScreenRecordingActive) {
          const recovered = await recoverNativeMacCaptureOutput({
            deferAudioValidationUntilMicrophoneSidecar,
            auditFinalizedRecording: auditAndSummarizeFinalizedRecording,
          });
          if (recovered) {
            return recovered;
          }

          return {
            success: false,
            message: "No native screen recording is active.",
          };
        }

        try {
          if (!nativeCaptureProcess) {
            throw new Error("Native capture helper process is not running");
          }

          const process = nativeCaptureProcess;
          const preferredVideoPath = nativeCaptureTargetPath;
          const preferredSystemAudioPath = nativeCaptureSystemAudioPath;
          const preferredMicrophonePath = nativeCaptureMicrophonePath;
          const preferredWebcamPath = nativeCaptureWebcamPath;
          console.log(
            "[stop-native] Audio paths — system:",
            preferredSystemAudioPath,
            "mic:",
            preferredMicrophonePath,
          );
          setNativeCaptureStopRequested(true);
          process.stdin.write("stop\n");
          const tempVideoPath = await waitForNativeCaptureStop(process);
          console.log(
            "[stop-native] Helper stopped, tempVideoPath:",
            tempVideoPath,
          );
          setNativeCaptureProcess(null);
          setNativeScreenRecordingActive(false);
          setNativeCaptureTargetPath(null);
          setNativeCaptureSystemAudioPath(null);
          setNativeCaptureMicrophonePath(null);
          setNativeCaptureWebcamPath(null);
          setNativeCaptureStopRequested(false);
          setNativeCapturePaused(false);

          const finalVideoPath = preferredVideoPath ?? tempVideoPath;
          if (tempVideoPath !== finalVideoPath) {
            await moveFileWithOverwrite(tempVideoPath, finalVideoPath);
          }

          if (preferredSystemAudioPath || preferredMicrophonePath) {
            console.log(
              "[stop-native] Attempting audio mux (merging separate tracks) into:",
              finalVideoPath,
            );
            try {
              await muxNativeMacRecordingWithAudio(
                finalVideoPath,
                preferredSystemAudioPath,
                preferredMicrophonePath,
                nativeCaptureOutputBuffer,
              );
              console.log("[stop-native] Audio mux completed successfully");
            } catch (error) {
              console.warn(
                "[stop-native] Audio mux failed (video still has inline audio):",
                error,
              );
              throw error;
            }
          } else {
            console.log("[stop-native] No separate audio tracks to mux");
          }

          if (deferAudioValidationUntilMicrophoneSidecar) {
            await appendRecordingEventLogEntry({
              recordingsDir: path.dirname(finalVideoPath),
              sessionId: getRecordingSessionIdForVideoPath(finalVideoPath),
              event: "recording-source-audio-sync-skipped",
              details: {
                reason: "pending-mic-companion-audio",
                videoPath: finalVideoPath,
              },
            });
          } else {
            await repairRecordingSourceAudioUnlessMicCompanionPreferred(
              finalVideoPath,
            );
          }

          const screenValidation = await validateNativeScreenRecordingIntegrity(
            {
              screenPath: finalVideoPath,
              processOutput: nativeCaptureOutputBuffer,
            },
          );

          recordNativeCaptureDiagnostics({
            backend: "mac-screencapturekit",
            phase: "stop",
            sourceId: lastNativeCaptureDiagnostics?.sourceId ?? null,
            sourceType: lastNativeCaptureDiagnostics?.sourceType ?? "unknown",
            displayId: lastNativeCaptureDiagnostics?.displayId ?? null,
            displayBounds: lastNativeCaptureDiagnostics?.displayBounds ?? null,
            windowHandle: lastNativeCaptureDiagnostics?.windowHandle ?? null,
            helperPath: lastNativeCaptureDiagnostics?.helperPath ?? null,
            outputPath: finalVideoPath,
            systemAudioPath: preferredSystemAudioPath,
            microphonePath: preferredMicrophonePath,
            osRelease: lastNativeCaptureDiagnostics?.osRelease,
            supported: lastNativeCaptureDiagnostics?.supported,
            helperExists: lastNativeCaptureDiagnostics?.helperExists,
            processOutput: nativeCaptureOutputBuffer.trim() || undefined,
            fileSizeBytes: screenValidation.fileSizeBytes,
            expectedDurationMs,
          });

          const finalWebcamPath = await resolveValidatedNativeWebcamPath({
            screenPath: finalVideoPath,
            webcamPath: preferredWebcamPath,
            processOutput: nativeCaptureOutputBuffer,
          });
          await recordNativeScreenDurationIntegrityEvent({
            screenPath: finalVideoPath,
            expectedDurationMs,
          });
          await writeMacRecordingDiagnostics(finalVideoPath, {
            phase: "stop",
            expectedDurationMs,
            outputPath: finalVideoPath,
            systemAudioPath: preferredSystemAudioPath,
            microphonePath: preferredMicrophonePath,
            processOutput: nativeCaptureOutputBuffer.trim() || undefined,
            details: {
              nativeWebcamPath: preferredWebcamPath,
              acceptedWebcamPath: finalWebcamPath,
            },
          });
          await drainNativeEventLogWrites();
          const recordingAudit = deferAudioValidationUntilMicrophoneSidecar
            ? null
            : await auditAndRecordFinalizedRecording(finalVideoPath);
          if (recordingAudit) {
            assertRecordingRunAuditPassed(recordingAudit, finalVideoPath);
          }
          return {
            ...(await finalizeStoredVideo(finalVideoPath)),
            webcamPath: finalWebcamPath,
            ...(recordingAudit
              ? { recordingAudit: summarizeRecordingAuditForIpc(recordingAudit) }
              : {}),
          };
        } catch (error) {
          console.error(
            "Failed to stop native ScreenCaptureKit recording:",
            error,
          );
          const fallbackPath = nativeCaptureTargetPath;
          const fallbackSystemAudioPath = nativeCaptureSystemAudioPath;
          const fallbackMicrophonePath = nativeCaptureMicrophonePath;
          const fallbackWebcamPath = nativeCaptureWebcamPath;
          const fallbackFileSizeBytes =
            await getFileSizeIfPresent(fallbackPath);
          setNativeScreenRecordingActive(false);
          setNativeCaptureProcess(null);
          setNativeCaptureTargetPath(null);
          setNativeCaptureSystemAudioPath(null);
          setNativeCaptureMicrophonePath(null);
          setNativeCaptureWebcamPath(null);
          setNativeCaptureStopRequested(false);
          setNativeCapturePaused(false);

          recordNativeCaptureDiagnostics({
            backend: "mac-screencapturekit",
            phase: "stop",
            sourceId: lastNativeCaptureDiagnostics?.sourceId ?? null,
            sourceType: lastNativeCaptureDiagnostics?.sourceType ?? "unknown",
            displayId: lastNativeCaptureDiagnostics?.displayId ?? null,
            displayBounds: lastNativeCaptureDiagnostics?.displayBounds ?? null,
            windowHandle: lastNativeCaptureDiagnostics?.windowHandle ?? null,
            helperPath: lastNativeCaptureDiagnostics?.helperPath ?? null,
            outputPath: fallbackPath,
            systemAudioPath: fallbackSystemAudioPath,
            microphonePath: fallbackMicrophonePath,
            osRelease: lastNativeCaptureDiagnostics?.osRelease,
            supported: lastNativeCaptureDiagnostics?.supported,
            helperExists: lastNativeCaptureDiagnostics?.helperExists,
            processOutput: nativeCaptureOutputBuffer.trim() || undefined,
            fileSizeBytes: fallbackFileSizeBytes,
            expectedDurationMs,
            error: String(error),
          });

          // Try to recover: if the target file exists on disk, finalize with it
          if (fallbackPath) {
            try {
              await fs.access(fallbackPath);
              console.log(
                "[stop-native-screen-recording] Recovering with fallback path:",
                fallbackPath,
              );
              if (fallbackSystemAudioPath || fallbackMicrophonePath) {
                try {
                  await muxNativeMacRecordingWithAudio(
                    fallbackPath,
                    fallbackSystemAudioPath,
                    fallbackMicrophonePath,
                    nativeCaptureOutputBuffer,
                  );
                } catch (muxError) {
                  console.warn(
                    "Failed to mux recovered native macOS audio into capture:",
                    muxError,
                  );
                  throw muxError;
                }
              }
              if (deferAudioValidationUntilMicrophoneSidecar) {
                await appendRecordingEventLogEntry({
                  recordingsDir: path.dirname(fallbackPath),
                  sessionId: getRecordingSessionIdForVideoPath(fallbackPath),
                  event: "recording-source-audio-sync-skipped",
                  details: {
                    reason: "pending-mic-companion-audio",
                    videoPath: fallbackPath,
                  },
                });
              } else {
                await repairRecordingSourceAudioSyncIfNeeded(fallbackPath);
              }
              await validateNativeScreenRecordingIntegrity({
                screenPath: fallbackPath,
                processOutput: nativeCaptureOutputBuffer,
              });
              const recoveredWebcamPath =
                await resolveValidatedNativeWebcamPath({
                  screenPath: fallbackPath,
                  webcamPath: fallbackWebcamPath,
                  processOutput: nativeCaptureOutputBuffer,
                });
              await recordNativeScreenDurationIntegrityEvent({
                screenPath: fallbackPath,
                expectedDurationMs,
              });
              await writeMacRecordingDiagnostics(fallbackPath, {
                phase: "stop",
                expectedDurationMs,
                outputPath: fallbackPath,
                systemAudioPath: fallbackSystemAudioPath,
                microphonePath: fallbackMicrophonePath,
                processOutput: nativeCaptureOutputBuffer.trim() || undefined,
                error: String(error),
                details: {
                  recoveredAfterStopFailure: true,
                  nativeWebcamPath: fallbackWebcamPath,
                  acceptedWebcamPath: recoveredWebcamPath,
                },
              });
              await drainNativeEventLogWrites();
              const recordingAudit =
                deferAudioValidationUntilMicrophoneSidecar
                  ? null
                  : await auditAndRecordFinalizedRecording(fallbackPath);
              if (recordingAudit) {
                assertRecordingRunAuditPassed(recordingAudit, fallbackPath);
              }
              return {
                ...(await finalizeStoredVideo(fallbackPath)),
                webcamPath: recoveredWebcamPath,
                ...(recordingAudit
                  ? {
                      recordingAudit:
                        summarizeRecordingAuditForIpc(recordingAudit),
                    }
                  : {}),
              };
            } catch {
              // File doesn't exist or isn't accessible
            }
          }

          const recovered = await recoverNativeMacCaptureOutput({
            deferAudioValidationUntilMicrophoneSidecar,
            auditFinalizedRecording: auditAndSummarizeFinalizedRecording,
          });
          if (recovered) {
            return recovered;
          }

          return {
            success: false,
            message: "Failed to stop native ScreenCaptureKit recording",
            error: String(error),
          };
        }
      } finally {
        console.log(
          `[PERF:MAIN] Handler: stop-native-screen-recording: COMPLETED in ${Date.now() - start}ms`,
        );
      }
    },
  );

  ipcMain.handle(
    "recover-native-screen-recording",
    async (
      _,
      options?: {
        includeDiagnosticsCandidate?: boolean;
        deferAudioValidationUntilMicrophoneSidecar?: boolean;
      },
    ) => {
      if (process.platform !== "darwin") {
        return {
          success: false,
          message:
            "Native screen recording recovery is only available on macOS.",
        };
      }

      const recovered = await recoverNativeMacCaptureOutput({
        includeDiagnosticsCandidate:
          options?.includeDiagnosticsCandidate !== false,
        deferAudioValidationUntilMicrophoneSidecar: Boolean(
          options?.deferAudioValidationUntilMicrophoneSidecar,
        ),
        auditFinalizedRecording: auditAndSummarizeFinalizedRecording,
      });
      if (recovered) {
        return recovered;
      }

      return {
        success: false,
        message: "No recoverable native macOS recording output was found.",
      };
    },
  );

  ipcMain.handle("pause-native-screen-recording", async () => {
    if (process.platform === "win32") {
      if (!windowsNativeCaptureActive || !windowsCaptureProcess) {
        return {
          success: false,
          message: "No native Windows screen recording is active.",
        };
      }

      if (windowsCapturePaused) {
        return { success: true };
      }

      try {
        windowsCaptureProcess.stdin.write("pause\n");
        setWindowsCapturePaused(true);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          message: "Failed to pause native Windows capture",
          error: String(error),
        };
      }
    }

    if (process.platform !== "darwin") {
      return {
        success: false,
        message: "Native screen recording is only available on macOS.",
      };
    }

    if (!nativeScreenRecordingActive || !nativeCaptureProcess) {
      return {
        success: false,
        message: "No native screen recording is active.",
      };
    }

    if (nativeCapturePaused) {
      return { success: true };
    }

    try {
      nativeCaptureProcess.stdin.write("pause\n");
      setNativeCapturePaused(true);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        message: "Failed to pause native screen recording",
        error: String(error),
      };
    }
  });

  ipcMain.handle("resume-native-screen-recording", async () => {
    if (process.platform === "win32") {
      if (!windowsNativeCaptureActive || !windowsCaptureProcess) {
        return {
          success: false,
          message: "No native Windows screen recording is active.",
        };
      }

      if (!windowsCapturePaused) {
        return { success: true };
      }

      try {
        windowsCaptureProcess.stdin.write("resume\n");
        setWindowsCapturePaused(false);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          message: "Failed to resume native Windows capture",
          error: String(error),
        };
      }
    }

    if (process.platform !== "darwin") {
      return {
        success: false,
        message: "Native screen recording is only available on macOS.",
      };
    }

    if (!nativeScreenRecordingActive || !nativeCaptureProcess) {
      return {
        success: false,
        message: "No native screen recording is active.",
      };
    }

    if (!nativeCapturePaused) {
      return { success: true };
    }

    try {
      nativeCaptureProcess.stdin.write("resume\n");
      setNativeCapturePaused(false);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        message: "Failed to resume native screen recording",
        error: String(error),
      };
    }
  });

  ipcMain.handle("get-system-cursor-assets", async () => {
    try {
      return { success: true, cursors: await getSystemCursorAssets() };
    } catch (error) {
      console.error("Failed to load system cursor assets:", error);
      return { success: false, cursors: {}, error: String(error) };
    }
  });

  ipcMain.handle("is-native-windows-capture-available", async () => {
    return { available: await isNativeWindowsCaptureAvailable() };
  });

  ipcMain.handle("get-last-native-capture-diagnostics", async () => {
    return { success: true, diagnostics: lastNativeCaptureDiagnostics };
  });

  ipcMain.handle(
    "report-native-webcam-preview-renderer-issue",
    async (_event, payload: NativeWebcamPreviewRendererIssuePayload) => {
      const target = resolveNativeWebcamPreviewRendererIssueTarget(
        nativeCaptureTargetPath,
      );
      if (!target) {
        return {
          success: true,
          recorded: false,
          reason: "no-active-native-recording",
        };
      }

      try {
        const details = sanitizeNativeWebcamPreviewRendererIssuePayload(
          payload ?? {},
        );
        const { logPath } = await appendRecordingEventLogEntry({
          ...target,
          event: "native-webcam-preview-renderer-issue",
          details,
        });
        return { success: true, recorded: true, logPath };
      } catch (error) {
        console.warn(
          "Failed to write native webcam renderer preview issue:",
          error,
        );
        return {
          success: false,
          recorded: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  ipcMain.handle(
    "get-video-audio-fallback-paths",
    async (_event, videoPath: string) => {
      if (!videoPath) {
        return { success: true, paths: [], startDelayMsByPath: {} };
      }

      try {
        const { paths, startDelayMsByPath } =
          await getCompanionAudioFallbackInfo(videoPath);
        await Promise.all([
          rememberApprovedLocalReadPath(videoPath),
          ...paths.map((fallbackPath) =>
            rememberApprovedLocalReadPath(fallbackPath),
          ),
        ]);
        return { success: true, paths, startDelayMsByPath };
      } catch (error) {
        console.error(
          "Failed to resolve companion audio fallback paths:",
          error,
        );
        return {
          success: false,
          paths: [],
          startDelayMsByPath: {},
          error: String(error),
        };
      }
    },
  );

  ipcMain.on(
    "webcam-layout-toggle",
    (_event, payload: { timeMs: number; mode: string }) => {
      recordWebcamLayoutEvent({
        timeMs: payload?.timeMs,
        mode: payload?.mode as WebcamLayoutMode,
      });
    },
  );

  ipcMain.handle(
    "get-webcam-layout-events",
    async (_event, videoPath: string) => {
      if (!videoPath) {
        return { success: true, style: "fit", events: [] };
      }
      const sidecar = await readWebcamLayoutSidecar(videoPath);
      return { success: true, style: sidecar.style, events: sidecar.events };
    },
  );

  ipcMain.on(
    "scene-style-toggle",
    (_event, payload: { timeMs: number; mode: string }) => {
      recordSceneStyleEvent({
        timeMs: payload?.timeMs,
        mode: payload?.mode as SceneStyleMode,
      });
    },
  );

  ipcMain.handle(
    "get-scene-style-events",
    async (_event, videoPath: string) => {
      if (!videoPath) {
        return { success: true, events: [] };
      }
      const events = await readSceneStyleEvents(videoPath);
      return { success: true, events };
    },
  );

  ipcMain.handle(
    "mux-native-windows-recording",
    async (_event, expectedDurationMs?: number) => {
      const start = Date.now();
      console.log("[PERF:MAIN] Handler: mux-native-windows-recording: STARTED");
      try {
        const videoPath = windowsPendingVideoPath;
        const orphanedMicAudioPath = windowsOrphanedMicAudioPath;
        const diagnosticsSystemAudioPath = windowsSystemAudioPath;
        const diagnosticsMicAudioPath = windowsMicAudioPath;
        setWindowsPendingVideoPath(null);
        setWindowsOrphanedMicAudioPath(null);

        if (!videoPath) {
          return {
            success: false,
            message: "No native Windows video pending for mux",
          };
        }

        try {
          await writeWindowsRecordingDiagnostics(videoPath, {
            phase: "mux-start",
            expectedDurationMs,
            outputPath: videoPath,
            systemAudioPath: diagnosticsSystemAudioPath,
            microphonePath: diagnosticsMicAudioPath,
            details: {
              hasSystemAudio: Boolean(diagnosticsSystemAudioPath),
              hasMicrophone: Boolean(diagnosticsMicAudioPath),
              hasOrphanedMicrophone: Boolean(orphanedMicAudioPath),
            },
          });
          console.log("[mux-win] Optimization active: skipping video padding.");

          let muxDetails: unknown = null;
          if (diagnosticsSystemAudioPath || diagnosticsMicAudioPath) {
            muxDetails = await muxNativeWindowsVideoWithAudio(
              videoPath,
              diagnosticsSystemAudioPath,
              diagnosticsMicAudioPath,
            );
            setWindowsSystemAudioPath(null);
            setWindowsMicAudioPath(null);
          }

          recordNativeCaptureDiagnostics({
            backend: "windows-wgc",
            phase: "mux",
            outputPath: videoPath,
            fileSizeBytes: await getFileSizeIfPresent(videoPath),
          });
          await writeWindowsRecordingDiagnostics(videoPath, {
            phase: "mux-complete",
            expectedDurationMs,
            outputPath: videoPath,
            systemAudioPath: diagnosticsSystemAudioPath,
            microphonePath: diagnosticsMicAudioPath,
            details: {
              fileSizeBytes: await getFileSizeIfPresent(videoPath),
              mux: muxDetails,
            },
          });
          await cleanupWindowsOrphanedMicAudioPath(orphanedMicAudioPath);
          return await finalizeStoredVideoWithSourceAudioSync(videoPath);
        } catch (error) {
          console.error("Failed to mux native Windows recording:", error);
          recordNativeCaptureDiagnostics({
            backend: "windows-wgc",
            phase: "mux",
            outputPath: videoPath,
            systemAudioPath: diagnosticsSystemAudioPath,
            microphonePath: diagnosticsMicAudioPath,
            fileSizeBytes: await getFileSizeIfPresent(videoPath),
            error: String(error),
          });
          await writeWindowsRecordingDiagnostics(videoPath, {
            phase: "mux-error",
            expectedDurationMs,
            outputPath: videoPath,
            systemAudioPath: diagnosticsSystemAudioPath,
            microphonePath: diagnosticsMicAudioPath,
            error: String(error),
            details: {
              fileSizeBytes: await getFileSizeIfPresent(videoPath),
            },
          });
          setWindowsSystemAudioPath(null);
          setWindowsMicAudioPath(null);
          await cleanupWindowsOrphanedMicAudioPath(orphanedMicAudioPath);
          try {
            return await finalizeStoredVideoWithSourceAudioSync(videoPath);
          } catch {
            try {
              await validateRecordedVideo(videoPath);
              return {
                success: false,
                path: videoPath,
                message: "Failed to mux native Windows recording",
                error: String(error),
              };
            } catch {
              // The fallback path is not safely playable; surface the original mux error.
            }

            return {
              success: false,
              message: "Failed to mux native Windows recording",
              error: String(error),
            };
          }
        }
      } finally {
        console.log(
          `[PERF:MAIN] Handler: mux-native-windows-recording: COMPLETED in ${Date.now() - start}ms`,
        );
      }
    },
  );

  ipcMain.handle(
    "start-ffmpeg-recording",
    async (_, source: SelectedSource) => {
      if (ffmpegCaptureProcess) {
        return {
          success: false,
          message: "An FFmpeg recording is already active.",
        };
      }

      try {
        const recordingsDir = await getRecordingsDir();
        const ffmpegPath = getFfmpegBinaryPath();
        const outputPath = path.join(
          recordingsDir,
          `recording-${Date.now()}.mp4`,
        );
        const args = await buildFfmpegCaptureArgs(source, outputPath);

        setFfmpegCaptureOutputBuffer("");
        setFfmpegCaptureTargetPath(outputPath);
        const ffProc = spawn(ffmpegPath, args, {
          cwd: recordingsDir,
          stdio: ["pipe", "pipe", "pipe"],
        });
        setFfmpegCaptureProcess(ffProc);

        ffProc.stdout.on("data", (chunk: Buffer) => {
          setFfmpegCaptureOutputBuffer(
            ffmpegCaptureOutputBuffer + chunk.toString(),
          );
        });
        ffProc.stderr.on("data", (chunk: Buffer) => {
          setFfmpegCaptureOutputBuffer(
            ffmpegCaptureOutputBuffer + chunk.toString(),
          );
        });

        await waitForFfmpegCaptureStart(ffProc);
        setFfmpegScreenRecordingActive(true);
        return { success: true };
      } catch (error) {
        console.error("Failed to start FFmpeg recording:", error);
        setFfmpegScreenRecordingActive(false);
        setFfmpegCaptureProcess(null);
        setFfmpegCaptureTargetPath(null);
        return {
          success: false,
          message: "Failed to start FFmpeg recording",
          error: String(error),
        };
      }
    },
  );

  ipcMain.handle("stop-ffmpeg-recording", async () => {
    if (!ffmpegScreenRecordingActive) {
      return { success: false, message: "No FFmpeg recording is active." };
    }

    try {
      if (!ffmpegCaptureProcess || !ffmpegCaptureTargetPath) {
        throw new Error("FFmpeg process is not running");
      }

      const process = ffmpegCaptureProcess;
      const outputPath = ffmpegCaptureTargetPath;
      process.stdin.write("q\n");
      const finalVideoPath = await waitForFfmpegCaptureStop(
        process,
        outputPath,
      );

      setFfmpegCaptureProcess(null);
      setFfmpegCaptureTargetPath(null);
      setFfmpegScreenRecordingActive(false);

      return await finalizeStoredVideoWithSourceAudioSync(finalVideoPath);
    } catch (error) {
      console.error("Failed to stop FFmpeg recording:", error);
      try {
        ffmpegCaptureProcess?.kill();
      } catch {
        // ignore cleanup failures
      }
      setFfmpegCaptureProcess(null);
      setFfmpegCaptureTargetPath(null);
      setFfmpegScreenRecordingActive(false);
      return {
        success: false,
        message: "Failed to stop FFmpeg recording",
        error: String(error),
      };
    }
  });

  ipcMain.handle(
    "store-microphone-sidecar",
    async (
      _,
      audioData: ArrayBuffer,
      videoPath: string,
      options?: BrowserMicrophoneSidecarOptions,
    ) => storeBrowserMicrophoneSidecar({ audioData, videoPath, options }),
  );

  ipcMain.handle("audit-finalized-recording", async (_, videoPath: string) =>
    auditFinalizedRecordingForRenderer(videoPath),
  );

  ipcMain.handle(
    "store-recorded-video",
    async (_, videoData: ArrayBuffer, fileName: string) => {
      try {
        return await storeRecordedVideoWithSourceAudioSync(videoData, fileName);
      } catch (error) {
        console.error("Failed to store video:", error);
        return {
          success: false,
          message: "Failed to store video",
          error: String(error),
        };
      }
    },
  );

  ipcMain.handle(
    "store-webcam-sidecar-video",
    async (
      _,
      videoData: ArrayBuffer,
      fileName: string,
      options?: { sessionId?: string | null; mimeType?: string | null },
    ) => {
      const recordingsDir = await getRecordingsDir();
      try {
        const videoPath = path.join(recordingsDir, path.basename(fileName));
        await fs.writeFile(videoPath, Buffer.from(videoData));
        await appendRecordingEventLogEntry({
          recordingsDir,
          sessionId:
            options?.sessionId ??
            path.basename(fileName, path.extname(fileName)),
          event: "webcam-sidecar-video-stored",
          details: {
            filePath: videoPath,
            mimeType: options?.mimeType ?? null,
            fileSizeBytes: await getFileSizeIfPresent(videoPath),
          },
        });
        return { success: true, path: videoPath };
      } catch (error) {
        await appendRecordingEventLogEntry({
          recordingsDir,
          sessionId:
            options?.sessionId ??
            path.basename(fileName, path.extname(fileName)),
          event: "webcam-sidecar-video-store-failed",
          details: { fileName, error: String(error) },
        }).catch(() => undefined);
        console.error("Failed to store webcam sidecar video:", error);
        return {
          success: false,
          message: "Failed to store webcam sidecar video",
          error: String(error),
        };
      }
    },
  );

  ipcMain.handle(
    "start-webcam-sidecar-recording",
    async (
      _,
      options: {
        sessionId: string;
        fileName: string;
        mimeType?: string | null;
      },
    ) => {
      const recordingsDir = await getRecordingsDir();
      try {
        const result = await webcamSidecarStreams.start({
          recordingsDir,
          sessionId: options.sessionId,
          fileName: options.fileName,
          mimeType: options.mimeType ?? null,
        });
        return { success: true, ...result };
      } catch (error) {
        await appendRecordingEventLogEntry({
          recordingsDir,
          sessionId: options.sessionId,
          event: "webcam-sidecar-stream-start-failed",
          details: { fileName: options.fileName, error: String(error) },
        }).catch(() => undefined);
        return { success: false, error: String(error) };
      }
    },
  );

  ipcMain.handle(
    "append-webcam-sidecar-chunk",
    async (
      _,
      streamId: string,
      chunk: ArrayBuffer,
      metadata?: { index?: number | null; elapsedMs?: number | null },
    ) => {
      try {
        const result = await webcamSidecarStreams.append({
          streamId,
          chunk: Buffer.from(chunk),
          index: metadata?.index ?? null,
          elapsedMs: metadata?.elapsedMs ?? null,
        });
        return { success: true, ...result };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },
  );

  ipcMain.handle(
    "finish-webcam-sidecar-recording",
    async (_, streamId: string) => {
      try {
        const result = await webcamSidecarStreams.finish(streamId);
        const normalizeResult = await normalizeWebcamSidecarIfNeeded({
          recordingsDir: path.dirname(result.path),
          sessionId: result.sessionId,
          filePath: result.path,
          mimeType: result.mimeType,
        });
        return {
          success: true,
          ...result,
          path: normalizeResult.path,
          normalized: normalizeResult.normalized,
          normalizationError: normalizeResult.error,
          normalizedBytesWritten: normalizeResult.bytesAfter,
        };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },
  );

  ipcMain.handle(
    "abort-webcam-sidecar-recording",
    async (_, streamId: string, reason?: string | null) => {
      try {
        const result = await webcamSidecarStreams.abort(
          streamId,
          reason ?? undefined,
        );
        return { success: true, ...(result ?? {}) };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },
  );

  ipcMain.handle(
    "record-recording-event",
    async (
      _,
      input: {
        sessionId: string;
        event: string;
        details?: Record<string, unknown>;
      },
    ) => {
      try {
        const recordingsDir = await getRecordingsDir();
        const result = await appendRecordingEventLogEntry({
          recordingsDir,
          sessionId: input.sessionId,
          event: input.event,
          details: input.details,
        });
        return { success: true, path: result.logPath };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },
  );

  ipcMain.handle("get-recorded-video-path", async () => {
    try {
      const recordingsDir = await getRecordingsDir();
      const entries = await fs.readdir(recordingsDir, { withFileTypes: true });
      const candidates = await Promise.all(
        entries
          .filter(
            (entry) =>
              entry.isFile() &&
              /^recording-\d+\.(webm|mov|mp4)$/i.test(entry.name),
          )
          .map(async (entry) => {
            const fullPath = path.join(recordingsDir, entry.name);
            const stat = await fs.stat(fullPath).catch(() => null);
            return stat ? { path: fullPath, mtimeMs: stat.mtimeMs } : null;
          }),
      );
      const sortedCandidates = candidates
        .filter(
          (candidate): candidate is { path: string; mtimeMs: number } =>
            candidate !== null,
        )
        .sort((left, right) => right.mtimeMs - left.mtimeMs);

      for (const candidate of sortedCandidates) {
        try {
          await validateRecordedVideo(candidate.path);
          return { success: true, path: candidate.path };
        } catch (error) {
          console.warn(
            "Skipping unusable recovered recording candidate:",
            candidate.path,
            error,
          );
        }
      }

      if (sortedCandidates.length === 0) {
        return { success: false, message: "No recorded video found" };
      }

      return { success: false, message: "No usable recorded video found" };
    } catch (error) {
      console.error("Failed to get video path:", error);
      return {
        success: false,
        message: "Failed to get video path",
        error: String(error),
      };
    }
  });

  ipcMain.handle("set-recording-state", (_, recording: boolean) => {
    if (recording) {
      stopCursorCapture();
      stopInteractionCapture();
      startWindowBoundsCapture();
      void startNativeCursorMonitor();
      setIsCursorCaptureActive(true);
      setActiveCursorSamples([]);
      setPendingCursorSamples([]);
      setCursorCaptureStartTimeMs(Date.now());
      resetCursorCaptureClock();
      setLinuxCursorScreenPoint(null);
      setLastLeftClick(null);
      sampleCursorPoint();
      startCursorSampling();
      void startInteractionCapture();
    } else {
      setIsCursorCaptureActive(false);
      stopCursorCapture();
      stopInteractionCapture();
      stopWindowBoundsCapture();
      stopNativeCursorMonitor();
      showCursor();
      setLinuxCursorScreenPoint(null);
      resetCursorCaptureClock();
      snapshotCursorTelemetryForPersistence();
      setActiveCursorSamples([]);
    }

    const source = selectedSource || { name: "Screen" };
    BrowserWindow.getAllWindows().forEach((window) => {
      if (!window.isDestroyed()) {
        window.webContents.send("recording-state-changed", {
          recording,
          sourceName: source.name,
        });
      }
    });

    if (onRecordingStateChange) {
      onRecordingStateChange(recording, source.name);
    }
  });

  ipcMain.handle("pause-cursor-capture", (_, pausedAtMs?: unknown) => {
    pauseCursorCaptureAtBoundary(normalizeRendererTimestampMs(pausedAtMs));
    return { success: true };
  });

  ipcMain.handle("resume-cursor-capture", (_, resumedAtMs?: unknown) => {
    resumeCursorCapture(normalizeRendererTimestampMs(resumedAtMs));
    sampleCursorPoint();
    return { success: true };
  });

  ipcMain.handle("get-cursor-telemetry", async (_, videoPath?: string) => {
    const targetVideoPath = normalizeVideoSourcePath(
      videoPath ?? currentVideoPath,
    );
    if (!targetVideoPath) {
      return { success: true, samples: [] };
    }

    const telemetryPath = getTelemetryPathForVideo(targetVideoPath);
    try {
      const content = await fs.readFile(telemetryPath, "utf-8");
      const parsed = parseJsonWithByteOrderMark<unknown>(content);
      const samples = normalizeCursorTelemetrySamples(parsed);

      return { success: true, samples };
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT") {
        return { success: true, samples: [] };
      }
      console.error("Failed to load cursor telemetry:", error);
      return {
        success: false,
        message: "Failed to load cursor telemetry",
        error: String(error),
        samples: [],
      };
    }
  });

  ipcMain.handle(
    "set-cursor-telemetry",
    async (
      _,
      videoPath: string | undefined,
      samples: CursorTelemetryPoint[],
    ) => {
      const targetVideoPath = normalizeVideoSourcePath(
        videoPath ?? currentVideoPath,
      );
      if (!targetVideoPath) {
        return {
          success: false,
          samples: [],
          message: "No video path available for cursor telemetry",
          error: "Missing video path",
        };
      }

      try {
        const normalizedSamples = await writeCursorTelemetry(
          targetVideoPath,
          samples,
        );
        return { success: true, samples: normalizedSamples };
      } catch (error) {
        console.error("Failed to save cursor telemetry:", error);
        return {
          success: false,
          samples: [],
          message: "Failed to save cursor telemetry",
          error: String(error),
        };
      }
    },
  );
}
