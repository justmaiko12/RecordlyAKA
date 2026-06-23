import { fixWebmDuration } from "@fix-webm-duration/fix";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { getEffectiveRecordingDurationMs } from "@/lib/mediaTiming";
import {
  acquireWebcamSession,
  coerceWebcamFrameRate,
  coerceWebcamQualityMode,
  DEFAULT_WEBCAM_FRAME_RATE,
  DEFAULT_WEBCAM_QUALITY_MODE,
  forceRestartWebcamSessionForRecording,
  getWebcamQualityProfile,
  type WebcamFrameRate,
  type WebcamQualityMode,
  type WebcamSessionHandle,
} from "@/lib/webcamSession";
import {
  getVideoExtensionForMimeType,
  isWebmMimeType,
  selectRecordingMimeType,
  selectWebcamRecordingMimeType,
} from "./recordingMimeType";

const TARGET_FRAME_RATE = 60;
const TARGET_WIDTH = 3840;
const TARGET_HEIGHT = 2160;
const FOUR_K_PIXELS = TARGET_WIDTH * TARGET_HEIGHT;
const QHD_WIDTH = 2560;
const QHD_HEIGHT = 1440;
const QHD_PIXELS = QHD_WIDTH * QHD_HEIGHT;
const BITRATE_4K = 45_000_000;
const BITRATE_QHD = 28_000_000;
const BITRATE_BASE = 18_000_000;
const HIGH_FRAME_RATE_THRESHOLD = 60;
const HIGH_FRAME_RATE_BOOST = 1.7;
const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;
const CODEC_ALIGNMENT = 2;
const RECORDER_TIMESLICE_MS = 250;
const BITS_PER_MEGABIT = 1_000_000;
const MIN_FRAME_RATE = 30;
const CHROME_MEDIA_SOURCE = "desktop";
const RECORDING_FILE_PREFIX = "recording-";
const AUDIO_BITRATE_VOICE = 128_000;
const AUDIO_BITRATE_SYSTEM = 192_000;
const MIC_GAIN_BOOST = 1.4;
const WEBCAM_BITRATE_BY_QUALITY: Record<WebcamQualityMode, number> = {
  stable: 8_000_000,
  sharp: 18_000_000,
  max: 35_000_000,
};
const WEBCAM_SUFFIX = "-webcam";
const MICROPHONE_SIDECAR_ERROR_TOAST_ID = "recording-microphone-sidecar-error";
const RECORDING_DEGRADED_TOAST_ID = "recording-degraded";
const RECORDING_AUDIT_WARNING_TOAST_ID = "recording-audit-warning";

const NATIVE_RECORDING_HARD_FAILURE_REASONS = new Set([
  "native-video-capture-stats-stale",
  "native-video-stream-stopped-with-error",
  "native-webcam-capture-stats-stale",
  "native-webcam-capture-low-cadence-sustained",
  "native-webcam-visual-stall-fail-closed",
  "native-webcam-proof-preview-stale",
  "native-webcam-proof-preview-lagging",
  "native-webcam-proof-preview-invalid",
  "native-webcam-proof-preview-publish-failed",
  "native-webcam-pipeline-stalled",
  "native-webcam-capture-disabled",
  "native-webcam-device-not-found",
  "native-webcam-fail-closed",
  "native-audio-capture-stats-stale",
  "native-microphone-recording-finalized-unhealthy",
]);

function isContinuityOrIPhoneCameraLabel(label: string | null | undefined) {
  const normalized = (label ?? "").toLowerCase();
  return (
    normalized.includes("iphone") || normalized.includes("continuity camera")
  );
}

export function shouldUseBrowserMicrophoneSidecarForNativeMac({
  useNativeMacScreenCapture: _useNativeMacScreenCapture,
  microphoneEnabled: _microphoneEnabled,
}: {
  useNativeMacScreenCapture: boolean;
  microphoneEnabled: boolean;
}) {
  // Keep screen, webcam, and microphone on the native ScreenCaptureKit clock
  // whenever possible. Browser microphone fallback is only used when the native
  // helper reports that native mic capture is unavailable.
  return false;
}

export type BrowserMicrophoneProfile =
  | "processed"
  | "no-agc"
  | "no-echo"
  | "no-noise-suppression"
  | "raw";
type BrowserCaptureCursorMode = "always" | "never";
export type BrowserCaptureCursorPolicy = {
  streamCursor: BrowserCaptureCursorMode;
  hideOsCursorBeforeRecording: boolean;
  hideEditorOverlayCursorByDefault: boolean;
};
const DEFAULT_BROWSER_MICROPHONE_PROFILE: BrowserMicrophoneProfile =
  "processed";
const BROWSER_MICROPHONE_PROFILES = new Set<BrowserMicrophoneProfile>([
  "processed",
  "no-agc",
  "no-echo",
  "no-noise-suppression",
  "raw",
]);
type MicrophoneTrackSettingsSnapshot = Partial<
  Pick<
    MediaTrackSettings,
    | "autoGainControl"
    | "channelCount"
    | "deviceId"
    | "echoCancellation"
    | "groupId"
    | "noiseSuppression"
    | "sampleRate"
    | "sampleSize"
  >
> & {
  trackId?: string;
  trackLabel?: string;
  trackEnabled?: boolean;
  trackMuted?: boolean;
  trackReadyState?: MediaStreamTrackState;
};
type MicrophoneAudioInputDeviceSnapshot = {
  deviceId: string;
  groupId?: string;
  label: string;
};
type MicrophoneFallbackChunkEvent = {
  index: number;
  size: number;
  elapsedMs: number;
  deltaMs: number | null;
  recordedElapsedMs: number;
  recordedDeltaMs: number | null;
};
type MicrophoneFallbackPauseInterval = {
  startElapsedMs: number;
  endElapsedMs?: number;
  durationMs?: number;
};
type MicrophoneFallbackRecorderMetadata = {
  mimeType: string;
  audioBitsPerSecond: number;
  timesliceMs: number;
};
type MicrophoneSidecarOptions = {
  startDelayMs?: number;
  browserMicrophoneProfile?: BrowserMicrophoneProfile;
  requestedBrowserMicrophoneProfile?: string | null;
  requestedConstraints?: MediaStreamConstraints;
  mediaTrackSettings?: MicrophoneTrackSettingsSnapshot;
  audioInputDevices?: MicrophoneAudioInputDeviceSnapshot[];
  mediaRecorder?: MicrophoneFallbackRecorderMetadata;
  chunkEvents?: MicrophoneFallbackChunkEvent[];
  pauseIntervals?: MicrophoneFallbackPauseInterval[];
};
export type MicrophoneSidecarFinalizationResult = {
  required: boolean;
  success: boolean;
  path?: string | null;
  error?: string | null;
};
const LINUX_PORTAL_SOURCE: ProcessedDesktopSource = {
  id: "screen:linux-portal",
  name: "Linux Portal",
  display_id: "",
  thumbnail: null,
  appIcon: null,
  sourceType: "screen",
};

type DesktopCaptureMediaDevices = {
  getUserMedia: (constraints: unknown) => Promise<MediaStream>;
  getDisplayMedia: (constraints: unknown) => Promise<MediaStream>;
};

type UseScreenRecorderReturn = {
  recording: boolean;
  paused: boolean;
  finalizing: boolean;
  countdownActive: boolean;
  toggleRecording: () => void;
  pauseRecording: () => void;
  resumeRecording: () => void;
  cancelRecording: () => void;
  preparePermissions: (options?: { startup?: boolean }) => Promise<boolean>;
  isMacOS: boolean;
  microphoneEnabled: boolean;
  setMicrophoneEnabled: (enabled: boolean) => void;
  microphoneDeviceId: string | undefined;
  setMicrophoneDeviceId: (deviceId: string | undefined) => void;
  systemAudioEnabled: boolean;
  setSystemAudioEnabled: (enabled: boolean) => void;
  webcamEnabled: boolean;
  setWebcamEnabled: (enabled: boolean) => void;
  webcamDeviceId: string | undefined;
  setWebcamDeviceId: (deviceId: string | undefined) => void;
  webcamFrameRate: WebcamFrameRate;
  setWebcamFrameRate: (frameRate: WebcamFrameRate) => void;
  webcamQualityMode: WebcamQualityMode;
  setWebcamQualityMode: (qualityMode: WebcamQualityMode) => void;
  cameraFullActive: boolean;
  toggleCameraLayout: () => void;
  sceneStyleMode: "fill" | "framed";
  applySceneStyleHotkey: (mode: "fill" | "framed") => void;
  countdownDelay: number;
  setCountdownDelay: (delay: number) => void;
};

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  if (typeof error === "object" && error !== null) {
    try {
      const serialized = JSON.stringify(error);
      if (serialized && serialized !== "{}") {
        return serialized;
      }
    } catch {
      // Ignore stringify failures and fall through to a generic message.
    }

    if (typeof (error as { toString?: () => string }).toString === "function") {
      const stringified = (error as { toString: () => string }).toString();
      if (stringified && stringified !== "[object Object]") {
        return stringified;
      }
    }
  }

  return "An unexpected error occurred";
}

export function getRecordingStartFailureAlertMessage(error: unknown): string {
  const message = getErrorMessage(error);
  if (
    message.includes(
      "Native webcam capture failed before writing a first frame",
    )
  ) {
    return "Failed to start recording: the selected webcam opened but did not deliver usable frames to Recordly's native recorder. Recording was not started because the facecam would be missing or frozen.";
  }
  if (message.includes("Selected webcam is delivering blank frames")) {
    return "Failed to start recording: the selected webcam is delivering blank frames. Recording was not started because the native proof preview could not verify visible facecam video.";
  }
  if (
    message.includes(
      "Native webcam proof preview started too late after preview handoff",
    )
  ) {
    return "Failed to start recording: the webcam preview did not re-verify quickly enough after switching into recording. Recording was not started because the facecam could be stale or frozen.";
  }
  if (
    message.includes(
      "Native webcam visible video started too late after preview handoff",
    )
  ) {
    return "Failed to start recording: the webcam did not deliver visible video quickly enough after switching into recording. Recording was not started because the facecam could begin stale, dark, or frozen.";
  }
  if (
    message.includes(
      "Timed out waiting for native screen, visible webcam, and proof-preview frames to be written",
    )
  ) {
    return "Failed to start recording: Recordly could not verify the native webcam proof preview. Recording was not started because the preview could not be proven to match frames accepted by the recorder.";
  }
  if (
    message.includes(
      "Timed out waiting for native screen first frame to be written",
    )
  ) {
    return "Failed to start recording: Recordly could not capture the selected screen. Recording was not started because the screen stream did not deliver a first frame. Re-select the screen source if your monitor setup changed.";
  }
  if (
    message.includes(
      "Timed out waiting for native screen and visible webcam frames to be written",
    )
  ) {
    return "Failed to start recording: the selected webcam did not deliver visible frames to Recordly's native recorder. Recording was not started because the facecam would be missing or frozen.";
  }
  return `Failed to start recording: ${message}`;
}

export function getMicrophoneSidecarFinalizationFailureMessage(
  result: MicrophoneSidecarFinalizationResult,
) {
  if (!result.required || result.success) {
    return null;
  }

  const detail = result.error ? ` Error: ${result.error}` : "";
  return `Failed to finish the recording because fallback microphone audio could not be saved safely.${detail} The editor was not opened because the recording would be missing its synced microphone track.`;
}

export function isNativeRecordingHardFailure({
  reason,
  severity,
}: {
  reason?: string | null;
  severity?: "info" | "warning" | "error";
}) {
  if (!reason) {
    return false;
  }
  return (
    NATIVE_RECORDING_HARD_FAILURE_REASONS.has(reason) ||
    (severity === "error" &&
      (reason.startsWith("native-webcam-") ||
        reason.startsWith("native-video-")))
  );
}

export function isNativeWebcamFailureReason(reason?: string | null) {
  if (!reason) {
    return false;
  }
  return (
    reason === "native-webcam-fail-closed" ||
    reason.startsWith("native-webcam-") ||
    reason.startsWith("main-webcam-")
  );
}

export function shouldCleanupCapturedMediaForNativeDegradedEvent(state: {
  reason?: string | null;
  severity?: "info" | "warning" | "error";
}) {
  return isNativeRecordingHardFailure(state);
}

export function normalizeBrowserMicrophoneProfile(
  value?: string | null,
): BrowserMicrophoneProfile {
  const normalized = value?.trim().toLowerCase();
  return normalized &&
    BROWSER_MICROPHONE_PROFILES.has(normalized as BrowserMicrophoneProfile)
    ? (normalized as BrowserMicrophoneProfile)
    : DEFAULT_BROWSER_MICROPHONE_PROFILE;
}

export function resolveBrowserCaptureCursorPolicy({
  nativeWindowsCaptureStartFailed = false,
}: {
  nativeWindowsCaptureStartFailed?: boolean;
} = {}): BrowserCaptureCursorPolicy {
  if (nativeWindowsCaptureStartFailed) {
    // If WGC already failed, avoid the telemetry overlay path that can lag on
    // constrained Windows systems; keep the browser-captured cursor instead.
    return {
      streamCursor: "always",
      hideOsCursorBeforeRecording: false,
      hideEditorOverlayCursorByDefault: true,
    };
  }

  return {
    streamCursor: "never",
    hideOsCursorBeforeRecording: true,
    hideEditorOverlayCursorByDefault: true,
  };
}

export function shouldUseNativeWindowsCaptureForSource(
  source: Pick<ProcessedDesktopSource, "id"> | null | undefined,
): boolean {
  return (
    source?.id?.startsWith("screen:") === true ||
    source?.id?.startsWith("window:") === true
  );
}

export type WebcamCaptureOwner = "none" | "native-mac" | "browser";

type BrowserVideoDeviceForNativeSelection = {
  deviceId: string;
  label?: string | null;
};

type BrowserAudioDeviceForNativeSelection =
  BrowserVideoDeviceForNativeSelection;

type NativeVideoDeviceForNativeSelection = {
  label?: string | null;
  normalizedLabel?: string | null;
  uniqueId?: string | null;
  connectionKind?: "built-in" | "usb" | "wireless" | "external" | "unknown";
  connectionLabel?: string | null;
};

type NativeAudioDeviceForNativeSelection = NativeVideoDeviceForNativeSelection;

export type NativeMacWebcamCaptureSelection = {
  webcamDeviceId?: string;
  webcamLabel?: string;
  webcamConnectionKind?: NativeVideoDeviceForNativeSelection["connectionKind"];
  webcamConnectionLabel?: string | null;
  matchedBrowserDevice: boolean;
  matchedNativeDevice: boolean;
};

export type NativeMacWebcamCaptureSettings = {
  width: number;
  height: number;
  fps: number;
  effectiveQualityMode: WebcamQualityMode;
  downgradedReason?: "continuity-camera-stability";
};

export type NativeMacMicrophoneCaptureSelection = {
  microphoneDeviceId?: string;
  microphoneLabel?: string;
  microphoneConnectionKind?: NativeAudioDeviceForNativeSelection["connectionKind"];
  microphoneConnectionLabel?: string | null;
  matchedBrowserDevice: boolean;
  matchedNativeDevice: boolean;
};

export const WIRELESS_CONTINUITY_CAMERA_TIME_OFFSET_MS = -250;
export const WIRED_CONTINUITY_CAMERA_TIME_OFFSET_MS = -100;

function normalizeWebcamSelectionLabel(label: string | null | undefined) {
  return (label ?? "")
    .normalize("NFKC")
    .replace(/[’‘]/g, "'")
    .replace(/\s+\([^)]*\)\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function nonEmptyString(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveNativeMacWebcamCaptureSelection({
  selectedDeviceId,
  browserDevices,
  nativeDevices,
}: {
  selectedDeviceId?: string | null;
  browserDevices: BrowserVideoDeviceForNativeSelection[];
  nativeDevices: NativeVideoDeviceForNativeSelection[];
}): NativeMacWebcamCaptureSelection {
  const requestedDeviceId = nonEmptyString(selectedDeviceId);
  if (!requestedDeviceId || requestedDeviceId === "default") {
    return {
      webcamDeviceId: undefined,
      webcamLabel: undefined,
      webcamConnectionKind: undefined,
      webcamConnectionLabel: null,
      matchedBrowserDevice: false,
      matchedNativeDevice: false,
    };
  }

  const browserDevice = browserDevices.find(
    (device) => device.deviceId === requestedDeviceId,
  );
  const browserLabel = nonEmptyString(browserDevice?.label);
  const browserNormalizedLabel = normalizeWebcamSelectionLabel(browserLabel);
  const nativeDevice =
    nativeDevices.find(
      (device) => nonEmptyString(device.uniqueId) === requestedDeviceId,
    ) ??
    (browserNormalizedLabel
      ? nativeDevices.find((device) => {
          const normalizedLabel = normalizeWebcamSelectionLabel(
            device.normalizedLabel ?? device.label,
          );
          return normalizedLabel === browserNormalizedLabel;
        })
      : undefined);
  const nativeDeviceId = nonEmptyString(nativeDevice?.uniqueId);
  const nativeLabel = nonEmptyString(nativeDevice?.label);

  return {
    webcamDeviceId: nativeDeviceId ?? requestedDeviceId,
    webcamLabel: nativeLabel ?? browserLabel,
    webcamConnectionKind: nativeDevice?.connectionKind,
    webcamConnectionLabel: nativeDevice?.connectionLabel ?? null,
    matchedBrowserDevice: Boolean(browserDevice),
    matchedNativeDevice: Boolean(nativeDevice),
  };
}

export function resolveNativeMacWebcamCaptureSettings({
  qualityMode,
  frameRate,
  selection,
}: {
  qualityMode: WebcamQualityMode;
  frameRate: WebcamFrameRate;
  selection: Pick<
    NativeMacWebcamCaptureSelection,
    "webcamLabel" | "webcamConnectionKind"
  >;
}): NativeMacWebcamCaptureSettings {
  const shouldDowngradeContinuityCamera =
    qualityMode !== "stable" &&
    (isContinuityOrIPhoneCameraLabel(selection.webcamLabel) ||
      selection.webcamConnectionKind === "wireless");
  const effectiveQualityMode = shouldDowngradeContinuityCamera
    ? DEFAULT_WEBCAM_QUALITY_MODE
    : qualityMode;
  const profile = getWebcamQualityProfile(effectiveQualityMode);

  return {
    width: profile.idealWidth,
    height: profile.idealHeight,
    fps: Math.min(frameRate, 30),
    effectiveQualityMode,
    ...(shouldDowngradeContinuityCamera
      ? { downgradedReason: "continuity-camera-stability" as const }
      : {}),
  };
}

export function resolveNativeMacMicrophoneCaptureSelection({
  selectedDeviceId,
  browserDevices,
  nativeDevices,
}: {
  selectedDeviceId?: string | null;
  browserDevices: BrowserAudioDeviceForNativeSelection[];
  nativeDevices: NativeAudioDeviceForNativeSelection[];
}): NativeMacMicrophoneCaptureSelection {
  const requestedDeviceId = nonEmptyString(selectedDeviceId);
  if (!requestedDeviceId || requestedDeviceId === "default") {
    return {
      microphoneDeviceId: undefined,
      microphoneLabel: undefined,
      microphoneConnectionKind: undefined,
      microphoneConnectionLabel: null,
      matchedBrowserDevice: false,
      matchedNativeDevice: false,
    };
  }

  const browserDevice = browserDevices.find(
    (device) => device.deviceId === requestedDeviceId,
  );
  const browserLabel = nonEmptyString(browserDevice?.label);
  const browserNormalizedLabel = normalizeWebcamSelectionLabel(browserLabel);
  const nativeDevice =
    nativeDevices.find(
      (device) => nonEmptyString(device.uniqueId) === requestedDeviceId,
    ) ??
    (browserNormalizedLabel
      ? nativeDevices.find((device) => {
          const normalizedLabel = normalizeWebcamSelectionLabel(
            device.normalizedLabel ?? device.label,
          );
          return normalizedLabel === browserNormalizedLabel;
        })
      : undefined);
  const nativeDeviceId = nonEmptyString(nativeDevice?.uniqueId);
  const nativeLabel = nonEmptyString(nativeDevice?.label);

  return {
    microphoneDeviceId: nativeDeviceId ?? requestedDeviceId,
    microphoneLabel: nativeLabel ?? browserLabel,
    microphoneConnectionKind: nativeDevice?.connectionKind,
    microphoneConnectionLabel: nativeDevice?.connectionLabel ?? null,
    matchedBrowserDevice: Boolean(browserDevice),
    matchedNativeDevice: Boolean(nativeDevice),
  };
}

export function getNativeMacWebcamCaptureTimeOffsetMs(
  selection: Pick<
    NativeMacWebcamCaptureSelection,
    "webcamLabel" | "webcamConnectionKind"
  >,
): number {
  const label = normalizeWebcamSelectionLabel(selection.webcamLabel);
  const isContinuityCamera = /\b(iphone|ipad|ipod)\b/.test(label);
  if (!isContinuityCamera) {
    return 0;
  }

  if (selection.webcamConnectionKind === "usb") {
    return WIRED_CONTINUITY_CAMERA_TIME_OFFSET_MS;
  }

  return WIRELESS_CONTINUITY_CAMERA_TIME_OFFSET_MS;
}

export function resolveWebcamCaptureOwner({
  platform,
  webcamEnabled,
  nativeMacScreenCaptureAvailable,
}: {
  platform: string;
  webcamEnabled: boolean;
  nativeMacScreenCaptureAvailable: boolean;
}): WebcamCaptureOwner {
  if (!webcamEnabled) {
    return "none";
  }

  return platform === "darwin" && nativeMacScreenCaptureAvailable
    ? "native-mac"
    : "browser";
}

export function requireNativeMacWebcamPathAfterStart({
  requiresNativeWebcam,
  webcamPath,
}: {
  requiresNativeWebcam: boolean;
  webcamPath?: string | null;
}) {
  if (!requiresNativeWebcam) {
    return webcamPath ?? null;
  }

  if (typeof webcamPath === "string" && webcamPath.trim().length > 0) {
    return webcamPath;
  }

  throw new Error(
    "Native mac webcam capture started without a validated webcam file. Recordly stopped instead of continuing with a missing facecam.",
  );
}

export async function attemptNativeRecordingStartupRecovery({
  isMacOS,
  recover,
  logDiagnostics,
}: {
  isMacOS: boolean;
  recover: () => Promise<string | null>;
  logDiagnostics?: (context: string) => Promise<void> | void;
}) {
  if (!isMacOS) {
    return null;
  }

  try {
    return await recover();
  } catch (error) {
    console.error(
      "Failed to recover native screen recording on startup:",
      error,
    );
    await logDiagnostics?.("startup-recover-native-screen-recording");
    return null;
  }
}

export function createProcessedMicrophoneConstraints(
  microphoneDeviceId?: string,
  profile: BrowserMicrophoneProfile = DEFAULT_BROWSER_MICROPHONE_PROFILE,
): MediaStreamConstraints {
  const normalizedProfile = normalizeBrowserMicrophoneProfile(profile);
  const audio: MediaTrackConstraints = {
    echoCancellation:
      normalizedProfile !== "no-echo" && normalizedProfile !== "raw",
    noiseSuppression:
      normalizedProfile !== "no-noise-suppression" &&
      normalizedProfile !== "raw",
    autoGainControl:
      normalizedProfile !== "no-agc" && normalizedProfile !== "raw",
    channelCount: { ideal: 1 },
    sampleRate: { ideal: 48000 },
  };

  if (microphoneDeviceId && microphoneDeviceId !== "default") {
    audio.deviceId = { exact: microphoneDeviceId };
  }

  return { audio, video: false };
}

export function createBrowserRecordingOptions({
  audioBitsPerSecond,
  mimeType,
  videoBitsPerSecond,
}: {
  audioBitsPerSecond?: number;
  mimeType?: string;
  videoBitsPerSecond: number;
}): MediaRecorderOptions {
  const options: MediaRecorderOptions = {
    videoBitsPerSecond,
    bitsPerSecond: videoBitsPerSecond + (audioBitsPerSecond ?? 0),
  };

  if (audioBitsPerSecond !== undefined) {
    options.audioBitsPerSecond = audioBitsPerSecond;
  }

  if (mimeType) {
    options.mimeType = mimeType;
  }

  return options;
}

export function createWebcamRecordingOptions(
  mimeType?: string,
  qualityMode: WebcamQualityMode = DEFAULT_WEBCAM_QUALITY_MODE,
): MediaRecorderOptions {
  return {
    videoBitsPerSecond: WEBCAM_BITRATE_BY_QUALITY[qualityMode],
    ...(mimeType ? { mimeType } : {}),
  };
}

export function shouldRetainWebcamChunkForFinalBlob({
  hasStreamingSidecar,
  mimeType,
}: {
  hasStreamingSidecar: boolean;
  mimeType?: string | null;
}) {
  return !hasStreamingSidecar || isWebmMimeType(mimeType);
}

export async function resolveRecoveredNativeWebcamPath({
  recoveryResult,
  stopWebcamRecorder,
}: {
  recoveryResult: { webcamPath?: string | null };
  stopWebcamRecorder: () => Promise<string | null>;
}) {
  if (Object.getOwnPropertyDescriptor(recoveryResult, "webcamPath")) {
    return recoveryResult.webcamPath ?? null;
  }

  return stopWebcamRecorder();
}

export function resolveImmediateFinalizationWebcamPath({
  hasNativeMacWebcamPath,
  stopResultWebcamPath,
}: {
  hasNativeMacWebcamPath: boolean;
  stopResultWebcamPath?: string | null;
}): string | null {
  if (!hasNativeMacWebcamPath) {
    return null;
  }

  if (typeof stopResultWebcamPath !== "string") {
    return null;
  }

  const trimmedPath = stopResultWebcamPath.trim();
  return trimmedPath ? stopResultWebcamPath : null;
}

export function getNativeRecordingAuditFailureMessage(result: {
  path?: string;
  recordingAudit?: RendererRecordingRunAudit | null;
}) {
  if (result.recordingAudit?.status !== "fail") {
    return null;
  }

  const primaryIssue = result.recordingAudit.issues[0];
  const primaryMessage = (() => {
    switch (primaryIssue?.code) {
      case "preview-handoff-device-mismatch":
      case "preview-handoff-label-mismatch":
        return "Recording failed safety verification: the live webcam preview and the native recorder did not prove they were using the same camera source.";
      case "preview-handoff-without-recording-device-identity":
      case "preview-handoff-without-recording-camera-label":
      case "preview-handoff-without-preview-camera-identity":
        return "Recording failed safety verification: Recordly could not prove the live webcam preview and the native recorder used the same camera source.";
      case "preview-handoff-without-prior-proof":
        return "Recording failed safety verification: the live webcam preview had not proven accepted native webcam frames before recording started.";
      case "preview-handoff-without-prior-visible-video":
        return "Recording failed safety verification: the live webcam preview had not proven visible webcam video before recording started.";
      case "preview-handoff-without-recording-proof":
      case "preview-handoff-reproof-started-too-late":
        return "Recording failed safety verification: after switching from preview into recording, the native recorder did not quickly re-prove accepted webcam frames.";
      case "preview-handoff-without-visible-video":
      case "preview-handoff-visible-video-started-too-late":
        return "Recording failed safety verification: after switching from preview into recording, the native recorder did not quickly prove visible webcam video.";
      default:
        return (
          primaryIssue?.message ??
          "Recording failed the native integrity audit."
        );
    }
  })();
  return [
    primaryMessage,
    result.path ? `Saved file: ${result.path}` : null,
    `Event log: ${result.recordingAudit.paths.eventLogPath}`,
  ]
    .filter(Boolean)
    .join(" ");
}

function formatAuditReviewTimestamp(seconds: number | undefined) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
    return null;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds - minutes * 60;
  return `${minutes}:${remainingSeconds.toFixed(1).padStart(4, "0")}`;
}

export function getNativeRecordingAuditWarningMessage(result: {
  path?: string;
  recordingAudit?: RendererRecordingRunAudit | null;
}) {
  if (result.recordingAudit?.status !== "warning") {
    return null;
  }

  const primaryWarning = result.recordingAudit.warnings[0];
  const rendererPreviewIssueCount =
    result.recordingAudit.summary.rendererPreviewIssueCount ?? 0;
  const audioContinuityRepairs =
    result.recordingAudit.summary.audioContinuityRepairs;
  const webcamContinuityRepairs =
    result.recordingAudit.summary.webcamContinuityRepairs;
  const webcamVisualFreezeReviews =
    result.recordingAudit.summary.webcamVisualFreezeReviews;
  const continuityWarningParts = [
    audioContinuityRepairs && audioContinuityRepairs.count > 0
      ? `${audioContinuityRepairs.totalDurationSeconds.toFixed(3)}s of audio silence across ${audioContinuityRepairs.count} event${audioContinuityRepairs.count === 1 ? "" : "s"}`
      : null,
    webcamContinuityRepairs && webcamContinuityRepairs.count > 0
      ? `${webcamContinuityRepairs.totalFrames ?? 0} held webcam frame${(webcamContinuityRepairs.totalFrames ?? 0) === 1 ? "" : "s"} across ${webcamContinuityRepairs.count} event${webcamContinuityRepairs.count === 1 ? "" : "s"}`
      : null,
  ].filter(Boolean);
  const webcamVisualFreezeReviewText =
    webcamVisualFreezeReviews && webcamVisualFreezeReviews.count > 0
      ? `${webcamVisualFreezeReviews.count} webcam visual freeze review${webcamVisualFreezeReviews.count === 1 ? "" : "s"} totaling ${webcamVisualFreezeReviews.totalDurationSeconds.toFixed(3)}s`
      : null;
  const firstAuditReviewSeconds = [
    audioContinuityRepairs?.firstTargetPtsSeconds,
    webcamContinuityRepairs?.firstTargetPtsSeconds,
    webcamVisualFreezeReviews?.firstStartPtsSeconds,
  ]
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    .sort((left, right) => left - right)[0];
  const firstAuditReviewTimestamp = formatAuditReviewTimestamp(
    firstAuditReviewSeconds,
  );
  const warningMessage =
    rendererPreviewIssueCount > 0
      ? `Recording saved, but the live webcam preview was not trustworthy during capture (${rendererPreviewIssueCount} preview issue${rendererPreviewIssueCount === 1 ? "" : "s"} reported). The native recorder kept proof evidence and did not find blocking media corruption.`
      : continuityWarningParts.length > 0
        ? `Recording saved. Recordly kept the timeline continuous by applying ${continuityWarningParts.join(" and ")} after device callback gaps.${webcamVisualFreezeReviewText ? ` It also marked ${webcamVisualFreezeReviewText}.` : ""}${firstAuditReviewTimestamp ? ` First affected point: ${firstAuditReviewTimestamp}.` : ""}`
        : webcamVisualFreezeReviewText
          ? `Recording saved. Recordly marked ${webcamVisualFreezeReviewText}.${firstAuditReviewTimestamp ? ` First affected point: ${firstAuditReviewTimestamp}.` : ""}`
      : (primaryWarning?.message ??
        "Recording completed with native audit warnings.");

  return [
    warningMessage,
    result.path ? `Saved file: ${result.path}` : null,
    `Event log: ${result.recordingAudit.paths.eventLogPath}`,
  ]
    .filter(Boolean)
    .join(" ");
}

export function getFinalizedRecordingAuditFailureMessage(result: {
  success?: boolean;
  path?: string;
  recordingAudit?: RendererRecordingRunAudit | null;
  message?: string;
  error?: string;
}) {
  const auditFailureMessage = getNativeRecordingAuditFailureMessage(result);
  if (auditFailureMessage) {
    return auditFailureMessage;
  }

  if (result.success !== false) {
    return null;
  }

  return [
    result.error ??
      result.message ??
      "Recording failed final safety verification.",
    result.path ? `Saved file: ${result.path}` : null,
  ]
    .filter(Boolean)
    .join(" ");
}

export async function finalizeRequiredMicrophoneSidecarBeforeEditor({
  micFallbackBlobPromise,
  finalPath,
  fallbackStartDelayMs,
  fallbackTrackSettings,
  existingAuditWarningMessage,
  storeMicrophoneSidecar,
  auditFinalizedRecording,
  notifyRecordingFinalizationFailure,
  closeHudOverlay,
}: {
  micFallbackBlobPromise: Promise<Blob | null> | null | undefined;
  finalPath: string;
  fallbackStartDelayMs?: number | null;
  fallbackTrackSettings?: MicrophoneTrackSettingsSnapshot | null;
  existingAuditWarningMessage?: string | null;
  storeMicrophoneSidecar: (
    micFallbackBlobPromise: Promise<Blob | null> | null | undefined,
    finalPath: string,
    startDelayMs?: number | null,
    mediaTrackSettings?: MicrophoneTrackSettingsSnapshot | null,
    required?: boolean,
  ) => Promise<MicrophoneSidecarFinalizationResult>;
  auditFinalizedRecording: (videoPath: string) => Promise<{
    success: boolean;
    recordingAudit?: RendererRecordingRunAudit;
    message?: string;
    error?: string;
  }>;
  notifyRecordingFinalizationFailure: (message: string) => Promise<void>;
  closeHudOverlay?: () => void;
}): Promise<
  | {
      success: true;
      auditWarningMessage: string | null;
    }
  | { success: false }
> {
  const micSidecarResult = await storeMicrophoneSidecar(
    micFallbackBlobPromise,
    finalPath,
    fallbackStartDelayMs,
    fallbackTrackSettings,
    true,
  );
  const micSidecarFailureMessage =
    getMicrophoneSidecarFinalizationFailureMessage(micSidecarResult);
  if (micSidecarFailureMessage) {
    await notifyRecordingFinalizationFailure(micSidecarFailureMessage);
    closeHudOverlay?.();
    return { success: false };
  }

  const postSidecarAuditResult = await auditFinalizedRecording(finalPath);
  const postSidecarAuditFailureMessage =
    getFinalizedRecordingAuditFailureMessage({
      ...postSidecarAuditResult,
      path: finalPath,
    });
  if (postSidecarAuditFailureMessage) {
    console.error(
      "[recording-audit-failed-after-microphone-sidecar]",
      postSidecarAuditResult.recordingAudit,
    );
    await notifyRecordingFinalizationFailure(postSidecarAuditFailureMessage);
    closeHudOverlay?.();
    return { success: false };
  }

  return {
    success: true,
    auditWarningMessage:
      getNativeRecordingAuditWarningMessage({
        path: finalPath,
        recordingAudit: postSidecarAuditResult.recordingAudit,
      }) ??
      existingAuditWarningMessage ??
      null,
  };
}

type WebcamWatchdogEventRecorder = (
  event: string,
  details?: Record<string, unknown>,
) => void;
type WebcamPipelineFailureHandler = (
  reason: "visual-stall" | "track-muted" | "track-ended" | "recorder-error",
  details?: Record<string, unknown>,
) => void;
type WebcamPipelineFailureSuppression = () => boolean;

const WEBCAM_VISUAL_STALL_SAMPLE_INTERVAL_MS = 2_000;
const WEBCAM_VISUAL_STALL_MIN_MS = 20_000;
export const WEBCAM_VISUAL_STALL_FAIL_CLOSED_MS = 60_000;
export const WEBCAM_TRACK_MUTE_FAIL_CLOSED_MS = 5_000;
const WEBCAM_VISUAL_STALL_DIFF_THRESHOLD = 1.5;

export function shouldFailClosedForWebcamVisualStall(stallMs: number): boolean {
  return (
    Number.isFinite(stallMs) && stallMs >= WEBCAM_VISUAL_STALL_FAIL_CLOSED_MS
  );
}

function attachWebcamVisualStallWatchdog(
  stream: MediaStream,
  attachedAt: number,
  recordEvent?: WebcamWatchdogEventRecorder,
  onPipelineFailure?: WebcamPipelineFailureHandler,
  shouldSuppressPipelineFailure?: WebcamPipelineFailureSuppression,
) {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return () => undefined;
  }

  const video = document.createElement("video");
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 36;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    return () => undefined;
  }

  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;

  let previousFrame: Uint8ClampedArray | null = null;
  let stableSince: number | null = null;
  let visualStallActive = false;
  let visualStallFailedClosed = false;
  let lastDiff: number | null = null;
  const elapsedMs = () => Date.now() - attachedAt;

  const sample = () => {
    if (shouldSuppressPipelineFailure?.()) {
      previousFrame = null;
      stableSince = null;
      visualStallActive = false;
      visualStallFailedClosed = false;
      return;
    }

    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      return;
    }

    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const currentFrame = context.getImageData(
      0,
      0,
      canvas.width,
      canvas.height,
    ).data;

    if (previousFrame) {
      let totalDiff = 0;
      for (let index = 0; index < currentFrame.length; index += 16) {
        totalDiff += Math.abs(currentFrame[index] - previousFrame[index]);
        totalDiff += Math.abs(
          currentFrame[index + 1] - previousFrame[index + 1],
        );
        totalDiff += Math.abs(
          currentFrame[index + 2] - previousFrame[index + 2],
        );
      }
      const samples = currentFrame.length / 16;
      const meanDiff = totalDiff / Math.max(1, samples * 3);
      lastDiff = meanDiff;

      if (meanDiff <= WEBCAM_VISUAL_STALL_DIFF_THRESHOLD) {
        stableSince ??= Date.now();
        const stallMs = Date.now() - stableSince;
        if (!visualStallActive && stallMs >= WEBCAM_VISUAL_STALL_MIN_MS) {
          visualStallActive = true;
          recordEvent?.("webcam-visual-stall-suspected", {
            elapsedMs: elapsedMs(),
            stallMs,
            meanDiff,
            sampleWidth: canvas.width,
            sampleHeight: canvas.height,
          });
        }
        if (
          !visualStallFailedClosed &&
          shouldFailClosedForWebcamVisualStall(stallMs)
        ) {
          visualStallFailedClosed = true;
          const details = {
            elapsedMs: elapsedMs(),
            stallMs,
            meanDiff,
            sampleWidth: canvas.width,
            sampleHeight: canvas.height,
          };
          if (shouldSuppressPipelineFailure?.()) {
            recordEvent?.("webcam-visual-stall-fail-closed-suppressed", {
              reason: "visual-stall",
              suppression: "recording-paused",
              ...details,
            });
            return;
          }
          recordEvent?.("webcam-visual-stall-fail-closed", details);
          onPipelineFailure?.("visual-stall", details);
        }
      } else {
        if (visualStallActive) {
          recordEvent?.("webcam-visual-stall-recovered", {
            elapsedMs: elapsedMs(),
            stallMs: stableSince === null ? null : Date.now() - stableSince,
            meanDiff,
          });
        }
        stableSince = null;
        visualStallActive = false;
      }
    }

    previousFrame = new Uint8ClampedArray(currentFrame);
  };

  void video.play().catch((error) => {
    recordEvent?.("webcam-visual-watchdog-start-failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  const intervalId = window.setInterval(
    sample,
    WEBCAM_VISUAL_STALL_SAMPLE_INTERVAL_MS,
  );

  return () => {
    window.clearInterval(intervalId);
    if (visualStallActive) {
      recordEvent?.("webcam-visual-stall-ended-with-recording", {
        elapsedMs: elapsedMs(),
        stallMs: stableSince === null ? null : Date.now() - stableSince,
        meanDiff: lastDiff,
      });
    }
    video.pause();
    video.srcObject = null;
  };
}

/**
 * Logs webcam frame-delivery stalls during recording. Chromium mutes a
 * MediaStreamTrack while its capture device stops delivering frames (device
 * renegotiation, Continuity Camera hiccups, phone lock); any gap recorded
 * into the webcam file shows up here with timestamps, so a frozen facecam in
 * a recording is diagnosable instead of a mystery.
 */
export function attachWebcamFrameWatchdog(
  stream: MediaStream,
  recordEvent?: WebcamWatchdogEventRecorder,
  onPipelineFailure?: WebcamPipelineFailureHandler,
  shouldSuppressPipelineFailure?: WebcamPipelineFailureSuppression,
): () => void {
  const track = stream.getVideoTracks()[0];
  if (!track) {
    return () => {
      /* no track to detach from */
    };
  }

  const attachedAt = Date.now();
  let mutedAt: number | null = null;
  let muteFailureTimer: number | null = null;
  let pipelineFailureTriggered = false;
  const elapsedMs = () => Date.now() - attachedAt;
  const elapsed = () => `${((Date.now() - attachedAt) / 1000).toFixed(2)}s`;
  const cleanupVisualWatchdog = attachWebcamVisualStallWatchdog(
    stream,
    attachedAt,
    recordEvent,
    onPipelineFailure,
    shouldSuppressPipelineFailure,
  );

  const failPipelineOnce = (
    reason: "track-muted" | "track-ended",
    details?: Record<string, unknown>,
  ) => {
    if (pipelineFailureTriggered) {
      return;
    }
    if (shouldSuppressPipelineFailure?.()) {
      recordEvent?.("webcam-track-fail-closed-suppressed", {
        reason,
        suppression: "recording-paused",
        ...details,
      });
      return;
    }
    pipelineFailureTriggered = true;
    recordEvent?.("webcam-track-fail-closed", {
      reason,
      ...details,
    });
    onPipelineFailure?.(reason, details);
  };

  const clearMuteFailureTimer = () => {
    if (muteFailureTimer !== null && typeof window !== "undefined") {
      window.clearTimeout(muteFailureTimer);
    }
    muteFailureTimer = null;
  };

  const handleMute = () => {
    mutedAt = Date.now();
    recordEvent?.("webcam-track-muted", {
      elapsedMs: elapsedMs(),
      trackReadyState: track.readyState,
      trackLabel: track.label,
    });
    console.warn(
      `[webcam-watchdog] camera stopped delivering frames at ${elapsed()} into recording`,
    );
    clearMuteFailureTimer();
    if (typeof window !== "undefined") {
      muteFailureTimer = window.setTimeout(() => {
        const stallMs = mutedAt === null ? null : Date.now() - mutedAt;
        failPipelineOnce("track-muted", {
          elapsedMs: elapsedMs(),
          stallMs,
          trackReadyState: track.readyState,
          trackLabel: track.label,
        });
      }, WEBCAM_TRACK_MUTE_FAIL_CLOSED_MS);
    }
  };
  const handleUnmute = () => {
    const stallMs = mutedAt === null ? null : Date.now() - mutedAt;
    mutedAt = null;
    clearMuteFailureTimer();
    recordEvent?.("webcam-track-unmuted", {
      elapsedMs: elapsedMs(),
      stallMs,
      trackReadyState: track.readyState,
      trackLabel: track.label,
    });
    console.warn(
      `[webcam-watchdog] camera resumed at ${elapsed()}${
        stallMs === null ? "" : ` after a ${(stallMs / 1000).toFixed(2)}s stall`
      }`,
    );
  };
  const handleEnded = () => {
    recordEvent?.("webcam-track-ended", {
      elapsedMs: elapsedMs(),
      trackReadyState: track.readyState,
      trackLabel: track.label,
    });
    console.warn(
      `[webcam-watchdog] camera track ended at ${elapsed()} into recording`,
    );
    clearMuteFailureTimer();
    failPipelineOnce("track-ended", {
      elapsedMs: elapsedMs(),
      trackReadyState: track.readyState,
      trackLabel: track.label,
    });
  };

  track.addEventListener("mute", handleMute);
  track.addEventListener("unmute", handleUnmute);
  track.addEventListener("ended", handleEnded);

  return () => {
    track.removeEventListener("mute", handleMute);
    track.removeEventListener("unmute", handleUnmute);
    track.removeEventListener("ended", handleEnded);
    clearMuteFailureTimer();
    cleanupVisualWatchdog();
  };
}

function createMicrophoneTrackSettingsSnapshot(
  stream: MediaStream,
): MicrophoneTrackSettingsSnapshot | null {
  const track = stream.getAudioTracks()[0];
  const settings = track?.getSettings?.();
  if (!track || !settings) {
    return null;
  }

  const snapshot: MicrophoneTrackSettingsSnapshot = {
    trackId: track.id,
    trackLabel: track.label,
    trackEnabled: track.enabled,
    trackMuted: track.muted,
    trackReadyState: track.readyState,
  };
  for (const key of [
    "autoGainControl",
    "channelCount",
    "deviceId",
    "echoCancellation",
    "groupId",
    "noiseSuppression",
    "sampleRate",
    "sampleSize",
  ] as const) {
    const value = settings[key];
    if (value !== undefined) {
      snapshot[key] = value as never;
    }
  }

  return Object.keys(snapshot).length > 0 ? snapshot : null;
}

async function createAudioInputDeviceSnapshot(): Promise<
  MicrophoneAudioInputDeviceSnapshot[] | null
> {
  if (typeof navigator.mediaDevices?.enumerateDevices !== "function") {
    return null;
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  const audioInputs = devices
    .filter((device) => device.kind === "audioinput")
    .map((device) => ({
      deviceId: device.deviceId,
      ...(device.groupId ? { groupId: device.groupId } : {}),
      label: device.label,
    }));

  return audioInputs.length > 0 ? audioInputs : null;
}

export function useScreenRecorder(): UseScreenRecorderReturn {
  const [recording, setRecording] = useState(false);
  const [paused, setPaused] = useState(false);
  const [starting, setStarting] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [countdownActive, setCountdownActive] = useState(false);
  const [isMacOS, setIsMacOS] = useState(false);
  const [microphoneEnabled, setMicrophoneEnabled] = useState(false);
  const [microphoneDeviceId, setMicrophoneDeviceId] = useState<
    string | undefined
  >(undefined);
  const [systemAudioEnabled, setSystemAudioEnabled] = useState(false);
  const [webcamEnabled, setWebcamEnabled] = useState(false);
  const [webcamDeviceId, setWebcamDeviceId] = useState<string | undefined>(
    undefined,
  );
  const [webcamFrameRate, setWebcamFrameRate] = useState<WebcamFrameRate>(
    DEFAULT_WEBCAM_FRAME_RATE,
  );
  const [webcamQualityMode, setWebcamQualityMode] = useState<WebcamQualityMode>(
    DEFAULT_WEBCAM_QUALITY_MODE,
  );
  const [cameraFullActive, setCameraFullActive] = useState(false);
  const cameraFullActiveRef = useRef(false);
  const [sceneStyleMode, setSceneStyleMode] = useState<"fill" | "framed">(
    "framed",
  );
  const sceneStyleModeRef = useRef<"fill" | "framed">("framed");
  const [countdownDelay, setCountdownDelayState] = useState(3);
  const mediaRecorder = useRef<MediaRecorder | null>(null);
  const webcamRecorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const screenStream = useRef<MediaStream | null>(null);
  const microphoneStream = useRef<MediaStream | null>(null);
  const webcamStream = useRef<MediaStream | null>(null);
  const webcamSessionHandle = useRef<WebcamSessionHandle | null>(null);
  const webcamWatchdogCleanup = useRef<(() => void) | null>(null);

  // Stops the recorder's cloned webcam tracks and releases the shared camera
  // session. The physical device only powers down once the preview (or any
  // other consumer) has released it too — never mid-renegotiation.
  const releaseWebcamCapture = useCallback(() => {
    webcamWatchdogCleanup.current?.();
    webcamWatchdogCleanup.current = null;
    webcamStream.current?.getTracks().forEach((track) => track.stop());
    webcamStream.current = null;
    webcamSessionHandle.current?.release();
    webcamSessionHandle.current = null;
  }, []);
  const mixingContext = useRef<AudioContext | null>(null);
  const chunks = useRef<Blob[]>([]);
  const webcamChunks = useRef<Blob[]>([]);
  const startTime = useRef<number>(0);
  const webcamStartTime = useRef<number | null>(null);
  const webcamTimeOffsetMs = useRef(0);
  const recordingSessionTimestamp = useRef<number | null>(null);
  const nativeScreenRecording = useRef(false);
  const nativeWindowsRecording = useRef(false);
  const nativeMacWebcamPath = useRef<string | null>(null);
  const startInFlight = useRef(false);
  const startupNativeRecoveryAttempted = useRef(false);
  const hasPromptedForReselect = useRef(false);
  const hasShownNativeWindowsFallbackToast = useRef(false);
  const countdownDelayLoaded = useRef(false);
  const recordingPrefsLoaded = useRef(false);
  const pendingWebcamPathPromise = useRef<Promise<string | null> | null>(null);
  const webcamStopPromise = useRef<Promise<string | null> | null>(null);
  const webcamStopResolver = useRef<((path: string | null) => void) | null>(
    null,
  );
  const resolvedWebcamPath = useRef<string | null>(null);
  const webcamSidecarStreamId = useRef<string | null>(null);
  const webcamSidecarPath = useRef<string | null>(null);
  const webcamChunkWriteChain = useRef<Promise<void>>(Promise.resolve());
  const webcamChunkIndex = useRef(0);
  const webcamPipelineFailureTriggered = useRef(false);
  const accumulatedPausedDurationMs = useRef(0);
  const pauseStartedAtMs = useRef<number | null>(null);
  const micFallbackRecorder = useRef<MediaRecorder | null>(null);
  const micFallbackChunks = useRef<Blob[]>([]);
  const micFallbackStartDelayMs = useRef<number | null>(null);
  const micFallbackTrackSettings =
    useRef<MicrophoneTrackSettingsSnapshot | null>(null);
  const micFallbackRequestedConstraints = useRef<MediaStreamConstraints | null>(
    null,
  );
  const micFallbackAudioInputDevices = useRef<
    MicrophoneAudioInputDeviceSnapshot[] | null
  >(null);
  const micFallbackRecorderMetadata =
    useRef<MicrophoneFallbackRecorderMetadata | null>(null);
  const micFallbackChunkEvents = useRef<MicrophoneFallbackChunkEvent[]>([]);
  const micFallbackRecorderStartedAt = useRef<number | null>(null);
  const micFallbackPauseStartedAt = useRef<number | null>(null);
  const micFallbackPausedDurationMs = useRef(0);
  const micFallbackPauseIntervals = useRef<MicrophoneFallbackPauseInterval[]>(
    [],
  );
  const browserMicrophoneProfile = useRef<BrowserMicrophoneProfile>(
    DEFAULT_BROWSER_MICROPHONE_PROFILE,
  );
  const requestedBrowserMicrophoneProfile = useRef<string | null>(null);
  const hideEditorOverlayCursorByDefault = useRef(false);

  const notifyRecordingFinalizationFailure = useCallback(
    async (message: string) => {
      setFinalizing(false);
      toast.error(message, { duration: 10000 });
    },
    [],
  );

  const notifyRecordingFinalizationWarning = useCallback((message: string) => {
    toast.warning(message, {
      id: RECORDING_AUDIT_WARNING_TOAST_ID,
      duration: 12000,
    });
  }, []);

  const logNativeCaptureDiagnostics = useCallback(async (context: string) => {
    if (
      typeof window.electronAPI?.getLastNativeCaptureDiagnostics !== "function"
    ) {
      return;
    }

    try {
      const result = await window.electronAPI.getLastNativeCaptureDiagnostics();
      if (result.success && result.diagnostics) {
        console.warn(
          `[NativeCaptureDiagnostics:${context}]`,
          result.diagnostics,
        );
      }
    } catch (error) {
      console.warn("Failed to load native capture diagnostics:", error);
    }
  }, []);

  const recordRecordingEvent = useCallback(
    (event: string, details?: Record<string, unknown>) => {
      const sessionTimestamp = recordingSessionTimestamp.current;
      if (
        sessionTimestamp === null ||
        typeof window.electronAPI?.recordRecordingEvent !== "function"
      ) {
        return;
      }

      void window.electronAPI.recordRecordingEvent({
        sessionId: String(sessionTimestamp),
        event,
        details,
      });
    },
    [],
  );

  const enqueueWebcamSidecarChunk = useCallback(
    (blob: Blob) => {
      const streamId = webcamSidecarStreamId.current;
      if (
        !streamId ||
        typeof window.electronAPI?.appendWebcamSidecarChunk !== "function"
      ) {
        return;
      }

      const index = webcamChunkIndex.current;
      webcamChunkIndex.current += 1;
      const elapsedMs =
        webcamStartTime.current === null
          ? null
          : Date.now() - webcamStartTime.current;

      webcamChunkWriteChain.current = webcamChunkWriteChain.current
        .catch(() => undefined)
        .then(async () => {
          const arrayBuffer = await blob.arrayBuffer();
          const result = await window.electronAPI.appendWebcamSidecarChunk?.(
            streamId,
            arrayBuffer,
            { index, elapsedMs },
          );
          if (!result?.success) {
            throw new Error(result?.error ?? "Failed to append webcam chunk");
          }
        })
        .catch((error) => {
          console.warn("Failed to append webcam sidecar chunk:", error);
          recordRecordingEvent("webcam-sidecar-chunk-write-failed", {
            index,
            elapsedMs,
            size: blob.size,
            error: getErrorMessage(error),
          });
        });
    },
    [recordRecordingEvent],
  );

  const handleWebcamPipelineFailure = useCallback(
    (
      reason: Parameters<WebcamPipelineFailureHandler>[0],
      details?: Record<string, unknown>,
    ) => {
      if (pauseStartedAtMs.current !== null) {
        recordRecordingEvent("webcam-pipeline-fail-closed-suppressed", {
          reason,
          suppression: "recording-paused",
          ...details,
        });
        return;
      }
      if (webcamPipelineFailureTriggered.current) {
        return;
      }
      webcamPipelineFailureTriggered.current = true;
      recordRecordingEvent("webcam-pipeline-fail-closed", {
        reason,
        ...details,
      });
      toast.error(
        "Webcam feed stalled, so Recordly stopped the recording instead of saving frozen facecam footage.",
        { duration: 10000 },
      );

      const browserRecorderState = mediaRecorder.current?.state;
      const hasActiveBrowserRecording =
        browserRecorderState === "recording" ||
        browserRecorderState === "paused";
      if (nativeScreenRecording.current || hasActiveBrowserRecording) {
        stopRecording.current();
      }
    },
    [recordRecordingEvent],
  );

  const buildNativeCaptureFailureMessage = useCallback(
    async (context: string, fallbackMessage: string) => {
      if (
        typeof window.electronAPI?.getLastNativeCaptureDiagnostics !==
        "function"
      ) {
        return fallbackMessage;
      }

      try {
        const result =
          await window.electronAPI.getLastNativeCaptureDiagnostics();
        const diagnostics = result.success
          ? (result.diagnostics ?? null)
          : null;
        if (!diagnostics) {
          return fallbackMessage;
        }

        console.warn(`[NativeCaptureDiagnostics:${context}]`, diagnostics);

        const details: string[] = [];
        if (diagnostics.error) {
          details.push(diagnostics.error);
        }
        if (diagnostics.outputPath) {
          details.push(`Saved file: ${diagnostics.outputPath}`);
        }

        return details.length > 0
          ? `${fallbackMessage} ${details.join(". ")}`
          : fallbackMessage;
      } catch (error) {
        console.warn("Failed to load native capture diagnostics:", error);
        return fallbackMessage;
      }
    },
    [],
  );

  const resetRecordingClock = useCallback((startedAt: number) => {
    startTime.current = startedAt;
    accumulatedPausedDurationMs.current = 0;
    pauseStartedAtMs.current = null;
    cameraFullActiveRef.current = false;
    setCameraFullActive(false);
    sceneStyleModeRef.current = "framed";
    setSceneStyleMode("framed");
  }, []);

  const markRecordingPaused = useCallback((pausedAt: number) => {
    if (pauseStartedAtMs.current === null) {
      pauseStartedAtMs.current = pausedAt;
    }
  }, []);

  const markRecordingResumed = useCallback((resumedAt: number) => {
    if (pauseStartedAtMs.current === null) {
      return;
    }

    const pauseStart = pauseStartedAtMs.current;
    const pauseDurationMs = Math.max(0, resumedAt - pauseStart);
    accumulatedPausedDurationMs.current += pauseDurationMs;
    pauseStartedAtMs.current = null;
  }, []);

  const getRecordingDurationMs = useCallback((endedAt: number) => {
    return getEffectiveRecordingDurationMs({
      startTimeMs: startTime.current,
      endTimeMs: endedAt,
      accumulatedPausedDurationMs: accumulatedPausedDurationMs.current,
      pauseStartedAtMs: pauseStartedAtMs.current,
    });
  }, []);

  const toggleCameraLayout = useCallback(() => {
    if (!recording || !webcamEnabled) {
      return;
    }
    const timeMs = Math.round(getRecordingDurationMs(Date.now()));
    const next = !cameraFullActiveRef.current;
    cameraFullActiveRef.current = next;
    setCameraFullActive(next);
    window.electronAPI?.webcamLayoutToggle?.({
      timeMs,
      mode: next ? "camera-full" : "screen",
    });
  }, [getRecordingDurationMs, webcamEnabled, recording]);

  const applySceneStyleHotkey = useCallback(
    (mode: "fill" | "framed") => {
      if (!recording || paused || sceneStyleModeRef.current === mode) {
        return;
      }
      const timeMs = Math.round(getRecordingDurationMs(Date.now()));
      sceneStyleModeRef.current = mode;
      setSceneStyleMode(mode);
      window.electronAPI?.sceneStyleToggle?.({ timeMs, mode });
    },
    [getRecordingDurationMs, recording, paused],
  );

  const getMicFallbackRecordedElapsedMs = useCallback(
    (now = performance.now()) => {
      const startedAt = micFallbackRecorderStartedAt.current;
      if (startedAt === null) {
        return 0;
      }

      const currentPauseDurationMs =
        micFallbackPauseStartedAt.current === null
          ? 0
          : Math.max(0, now - micFallbackPauseStartedAt.current);
      return Math.max(
        0,
        Math.round(
          now -
            startedAt -
            micFallbackPausedDurationMs.current -
            currentPauseDurationMs,
        ),
      );
    },
    [],
  );

  const resetMicFallbackTimingDiagnostics = useCallback(() => {
    micFallbackChunkEvents.current = [];
    micFallbackRecorderStartedAt.current = null;
    micFallbackPauseStartedAt.current = null;
    micFallbackPausedDurationMs.current = 0;
    micFallbackPauseIntervals.current = [];
  }, []);

  const preparePermissions = useCallback(
    async (options: { startup?: boolean } = {}) => {
      const platform = await window.electronAPI.getPlatform();
      if (platform !== "darwin") {
        return true;
      }

      const screenPermission =
        await window.electronAPI.getScreenRecordingPermissionStatus();
      if (!screenPermission.success || screenPermission.status !== "granted") {
        await window.electronAPI.openScreenRecordingPreferences();
        alert(
          options.startup
            ? "Recordly needs Screen Recording permission before you start. System Settings has been opened. After enabling it, quit and reopen Recordly."
            : "Screen Recording permission is still missing. System Settings has been opened again. Enable it, then quit and reopen Recordly before recording.",
        );
        return false;
      }

      const accessibilityPermission =
        await window.electronAPI.getAccessibilityPermissionStatus();
      if (!accessibilityPermission.success) {
        return false;
      }

      if (accessibilityPermission.trusted) {
        return true;
      }

      const requestedAccessibility =
        await window.electronAPI.requestAccessibilityPermission();
      if (requestedAccessibility.success && requestedAccessibility.trusted) {
        return true;
      }

      await window.electronAPI.openAccessibilityPreferences();
      alert(
        options.startup
          ? "Recordly also needs Accessibility permission for cursor tracking. System Settings has been opened. After enabling it, quit and reopen Recordly."
          : "Accessibility permission is still missing. System Settings has been opened again. Enable it, then quit and reopen Recordly before recording.",
      );

      return false;
    },
    [],
  );

  const selectMimeType = useCallback(() => {
    return selectRecordingMimeType();
  }, []);

  const selectWebcamMimeType = useCallback(() => {
    return selectWebcamRecordingMimeType();
  }, []);

  const computeBitrate = (width: number, height: number) => {
    const pixels = width * height;
    const highFrameRateBoost =
      TARGET_FRAME_RATE >= HIGH_FRAME_RATE_THRESHOLD
        ? HIGH_FRAME_RATE_BOOST
        : 1;

    if (pixels >= FOUR_K_PIXELS) {
      return Math.round(BITRATE_4K * highFrameRateBoost);
    }

    if (pixels >= QHD_PIXELS) {
      return Math.round(BITRATE_QHD * highFrameRateBoost);
    }

    return Math.round(BITRATE_BASE * highFrameRateBoost);
  };

  const cleanupCapturedMedia = useCallback(() => {
    if (stream.current) {
      stream.current.getTracks().forEach((track) => track.stop());
      stream.current = null;
    }

    if (screenStream.current) {
      screenStream.current.getTracks().forEach((track) => track.stop());
      screenStream.current = null;
    }

    if (microphoneStream.current) {
      microphoneStream.current.getTracks().forEach((track) => track.stop());
      microphoneStream.current = null;
    }

    releaseWebcamCapture();
    nativeMacWebcamPath.current = null;

    if (mixingContext.current) {
      mixingContext.current.close().catch(() => undefined);
      mixingContext.current = null;
    }

    if (micFallbackRecorder.current) {
      try {
        if (micFallbackRecorder.current.state !== "inactive") {
          micFallbackRecorder.current.stop();
        }
        micFallbackRecorder.current.stream
          ?.getTracks()
          .forEach((track) => track.stop());
      } catch {
        /* ignore */
      }
      micFallbackRecorder.current = null;
      micFallbackChunks.current = [];
      micFallbackTrackSettings.current = null;
      micFallbackRequestedConstraints.current = null;
      micFallbackAudioInputDevices.current = null;
      micFallbackRecorderMetadata.current = null;
      resetMicFallbackTimingDiagnostics();
    }
  }, [releaseWebcamCapture, resetMicFallbackTimingDiagnostics]);

  const appendMicFallbackChunk = useCallback(
    (event: BlobEvent) => {
      if (event.data.size <= 0) {
        return;
      }

      micFallbackChunks.current.push(event.data);
      const startedAt = micFallbackRecorderStartedAt.current;
      if (startedAt === null) {
        return;
      }

      const now = performance.now();
      const elapsedMs = Math.max(0, Math.round(now - startedAt));
      const recordedElapsedMs = getMicFallbackRecordedElapsedMs(now);
      const previous =
        micFallbackChunkEvents.current[
          micFallbackChunkEvents.current.length - 1
        ];
      micFallbackChunkEvents.current.push({
        index: micFallbackChunkEvents.current.length,
        size: event.data.size,
        elapsedMs,
        deltaMs: previous ? Math.max(0, elapsedMs - previous.elapsedMs) : null,
        recordedElapsedMs,
        recordedDeltaMs: previous
          ? Math.max(0, recordedElapsedMs - previous.recordedElapsedMs)
          : null,
      });
    },
    [getMicFallbackRecordedElapsedMs],
  );

  const resolveBrowserCaptureSource = useCallback(
    async (source: ProcessedDesktopSource) => {
      if (!source?.id?.startsWith("screen:")) {
        return source;
      }

      // Linux/Wayland portal sentinel: do NOT call getSources here, because
      // on Wayland that triggers an additional xdg-desktop-portal dialog.
      // The sentinel is handled later by routing through getDisplayMedia,
      // which lets the portal pick the source in a single dialog.
      if (source.id === "screen:linux-portal") {
        return source;
      }

      try {
        const liveSources = await window.electronAPI.getSources({
          types: ["screen"],
          thumbnailSize: { width: 1, height: 1 },
          fetchWindowIcons: false,
        });

        const exactMatch = liveSources.find(
          (candidate) => candidate.id === source.id,
        );
        if (exactMatch) {
          return {
            ...source,
            id: exactMatch.id,
            name: exactMatch.name ?? source.name,
            display_id: exactMatch.display_id ?? source.display_id,
          };
        }

        const displayMatch = liveSources.find(
          (candidate) =>
            String(candidate.display_id ?? "") ===
            String(source.display_id ?? ""),
        );
        if (displayMatch) {
          return {
            ...source,
            id: displayMatch.id,
            name: displayMatch.name ?? source.name,
            display_id: displayMatch.display_id ?? source.display_id,
          };
        }

        const nameMatch = liveSources.find(
          (candidate) =>
            candidate.name === source.name ||
            candidate.originalName === source.originalName,
        );
        if (nameMatch) {
          return {
            ...source,
            id: nameMatch.id,
            name: nameMatch.name ?? source.name,
            display_id: nameMatch.display_id ?? source.display_id,
          };
        }

        const sourceName = `${source.name ?? ""} ${source.originalName ?? ""}`;
        if (sourceName.includes("(Primary)")) {
          const primaryMatch = liveSources.find((candidate) =>
            `${candidate.name ?? ""} ${candidate.originalName ?? ""}`.includes(
              "(Primary)",
            ),
          );
          if (primaryMatch) {
            return {
              ...source,
              id: primaryMatch.id,
              name: primaryMatch.name ?? source.name,
              display_id: primaryMatch.display_id ?? source.display_id,
            };
          }
        }

        if (liveSources.length === 1) {
          const [onlySource] = liveSources;
          if (onlySource) {
            return {
              ...source,
              id: onlySource.id,
              name: onlySource.name ?? source.name,
              display_id: onlySource.display_id ?? source.display_id,
            };
          }
        }
      } catch (error) {
        console.warn("Failed to resolve browser capture source:", error);
      }

      return source;
    },
    [],
  );

  const finalizeRecordingSession = useCallback(
    async (videoPath: string, webcamPath: string | null) => {
      const start = performance.now();
      console.log(
        "[PERF:RENDERER] Finalize Session & Switch to Editor: STARTED",
      );
      const shouldHideOverlayCursor = hideEditorOverlayCursorByDefault.current;
      try {
        if (webcamPath) {
          await window.electronAPI.setCurrentRecordingSession(
            {
              videoPath,
              webcamPath,
              timeOffsetMs: webcamTimeOffsetMs.current,
              hideOverlayCursorByDefault: shouldHideOverlayCursor,
            },
            {
              source: "recording-finalization",
            },
          );
        } else {
          await window.electronAPI.setCurrentVideoPath(videoPath, {
            hideOverlayCursorByDefault: shouldHideOverlayCursor,
            source: "recording-finalization",
          });
        }
      } catch (error) {
        console.error("Failed to persist recording session metadata:", error);

        try {
          await window.electronAPI.setCurrentVideoPath(videoPath, {
            hideOverlayCursorByDefault: shouldHideOverlayCursor,
            source: "recording-finalization",
          });
        } catch (fallbackError) {
          console.error(
            "Failed to persist fallback video path:",
            fallbackError,
          );
        }
      }

      setFinalizing(false);
      await window.electronAPI.switchToEditor();
      console.log(
        `[PERF:RENDERER] Finalize Session & Switch to Editor: COMPLETED in ${(performance.now() - start).toFixed(2)}ms`,
      );
    },
    [],
  );

  const closeMicFallbackPauseInterval = useCallback(
    (now = performance.now()) => {
      const pauseStartedAt = micFallbackPauseStartedAt.current;
      if (pauseStartedAt === null) {
        return;
      }

      const durationMs = Math.max(0, Math.round(now - pauseStartedAt));
      micFallbackPausedDurationMs.current += durationMs;
      const startedAt = micFallbackRecorderStartedAt.current ?? now;
      const lastInterval =
        micFallbackPauseIntervals.current[
          micFallbackPauseIntervals.current.length - 1
        ];
      if (lastInterval && lastInterval.endElapsedMs === undefined) {
        lastInterval.endElapsedMs = Math.max(
          lastInterval.startElapsedMs,
          Math.round(now - startedAt),
        );
        lastInterval.durationMs = durationMs;
      }
      micFallbackPauseStartedAt.current = null;
    },
    [],
  );

  const stopMicFallbackRecorder = useCallback((): Promise<Blob | null> => {
    return new Promise((resolve) => {
      const recorder = micFallbackRecorder.current;
      if (!recorder || recorder.state === "inactive") {
        micFallbackRecorder.current = null;
        resolve(null);
        return;
      }
      closeMicFallbackPauseInterval();
      recorder.ondataavailable = appendMicFallbackChunk;
      recorder.onstop = () => {
        const blob =
          micFallbackChunks.current.length > 0
            ? new Blob(micFallbackChunks.current, { type: recorder.mimeType })
            : null;
        micFallbackChunks.current = [];
        recorder.stream.getTracks().forEach((track) => track.stop());
        micFallbackRecorder.current = null;
        micFallbackRecorderStartedAt.current = null;
        resolve(blob);
      };
      recorder.stop();
    });
  }, [appendMicFallbackChunk, closeMicFallbackPauseInterval]);

  const pauseMicFallbackRecorder = useCallback(() => {
    const recorder = micFallbackRecorder.current;
    if (recorder?.state !== "recording") {
      return;
    }

    try {
      recorder.requestData();
    } catch (error) {
      console.warn(
        "Failed to flush microphone fallback chunk before pause:",
        error,
      );
    }

    recorder.pause();
    const now = performance.now();
    const startedAt = micFallbackRecorderStartedAt.current ?? now;
    micFallbackPauseStartedAt.current = now;
    micFallbackPauseIntervals.current.push({
      startElapsedMs: Math.max(0, Math.round(now - startedAt)),
    });
  }, []);

  const resumeMicFallbackRecorder = useCallback(() => {
    const recorder = micFallbackRecorder.current;
    if (recorder?.state !== "paused") {
      return;
    }

    closeMicFallbackPauseInterval();
    recorder.resume();
  }, [closeMicFallbackPauseInterval]);

  const storeMicrophoneSidecar = useCallback(
    async (
      micFallbackBlobPromise: Promise<Blob | null> | null | undefined,
      finalPath: string,
      startDelayMs?: number | null,
      mediaTrackSettings?: MicrophoneTrackSettingsSnapshot | null,
      required = false,
    ): Promise<MicrophoneSidecarFinalizationResult> => {
      const micFallbackBlob = await micFallbackBlobPromise;
      if (!micFallbackBlob) {
        micFallbackStartDelayMs.current = null;
        micFallbackTrackSettings.current = null;
        micFallbackRequestedConstraints.current = null;
        micFallbackAudioInputDevices.current = null;
        micFallbackRecorderMetadata.current = null;
        resetMicFallbackTimingDiagnostics();
        return {
          required,
          success: !required,
          error: required
            ? "No fallback microphone audio data was produced."
            : null,
        };
      }

      try {
        const arrayBuffer = await micFallbackBlob.arrayBuffer();
        const effectiveStartDelayMs =
          startDelayMs ?? micFallbackStartDelayMs.current;
        const effectiveTrackSettings =
          mediaTrackSettings ?? micFallbackTrackSettings.current;
        const sidecarOptions: MicrophoneSidecarOptions = {
          ...(Number.isFinite(effectiveStartDelayMs) &&
          (effectiveStartDelayMs ?? 0) >= 0
            ? { startDelayMs: effectiveStartDelayMs ?? 0 }
            : {}),
          browserMicrophoneProfile: browserMicrophoneProfile.current,
          ...(requestedBrowserMicrophoneProfile.current
            ? {
                requestedBrowserMicrophoneProfile:
                  requestedBrowserMicrophoneProfile.current,
              }
            : {}),
          ...(micFallbackRequestedConstraints.current
            ? { requestedConstraints: micFallbackRequestedConstraints.current }
            : {}),
          ...(effectiveTrackSettings
            ? { mediaTrackSettings: effectiveTrackSettings }
            : {}),
          ...(micFallbackAudioInputDevices.current
            ? { audioInputDevices: micFallbackAudioInputDevices.current }
            : {}),
          ...(micFallbackRecorderMetadata.current
            ? { mediaRecorder: micFallbackRecorderMetadata.current }
            : {}),
          ...(micFallbackChunkEvents.current.length > 0
            ? { chunkEvents: [...micFallbackChunkEvents.current] }
            : {}),
          ...(micFallbackPauseIntervals.current.length > 0
            ? {
                pauseIntervals: micFallbackPauseIntervals.current.map(
                  (interval) => ({ ...interval }),
                ),
              }
            : {}),
        };
        const result = await window.electronAPI.storeMicrophoneSidecar(
          arrayBuffer,
          finalPath,
          sidecarOptions,
        );
        if (!result.success) {
          const errorMessage =
            result.error ||
            "Failed to save the fallback microphone audio track";
          console.warn("Failed to store microphone sidecar:", errorMessage);
          if (!required) {
            toast.error(
              `${errorMessage}. Recording was saved without the fallback microphone track.`,
              { id: MICROPHONE_SIDECAR_ERROR_TOAST_ID, duration: 10000 },
            );
          }
          return { required, success: false, error: errorMessage };
        }
        return { required, success: true, path: result.path ?? null };
      } catch (error) {
        console.warn("Failed to store microphone sidecar:", error);
        if (!required) {
          toast.error(
            `${getErrorMessage(error)}. Recording was saved without the fallback microphone track.`,
            { id: MICROPHONE_SIDECAR_ERROR_TOAST_ID, duration: 10000 },
          );
        }
        return { required, success: false, error: getErrorMessage(error) };
      } finally {
        micFallbackStartDelayMs.current = null;
        micFallbackTrackSettings.current = null;
        micFallbackRequestedConstraints.current = null;
        micFallbackAudioInputDevices.current = null;
        micFallbackRecorderMetadata.current = null;
        resetMicFallbackTimingDiagnostics();
      }
    },
    [resetMicFallbackTimingDiagnostics],
  );

  const stopWebcamRecorder = useCallback(async () => {
    const recorder = webcamRecorder.current;
    const pending = webcamStopPromise.current;

    if (!recorder) {
      const result = pending ? await pending : resolvedWebcamPath.current;
      webcamStopPromise.current = null;
      pendingWebcamPathPromise.current = null;
      resolvedWebcamPath.current = result ?? null;
      return result ?? null;
    }

    if (recorder.state !== "inactive") {
      recorder.stop();
    } else {
      if (pending && webcamStopResolver.current) {
        webcamStopResolver.current(resolvedWebcamPath.current);
        webcamStopResolver.current = null;
      }
      // Recorder was prepared but never started, so its onstop handler
      // (which normally releases the camera) will never run.
      webcamRecorder.current = null;
      releaseWebcamCapture();
    }

    const result = pending ? await pending : resolvedWebcamPath.current;
    webcamStopPromise.current = null;
    pendingWebcamPathPromise.current = null;
    resolvedWebcamPath.current = result ?? null;
    return result ?? null;
  }, [releaseWebcamCapture]);

  const recoverNativeRecordingSession = useCallback(
    async (
      micFallbackBlobPromise?: Promise<Blob | null> | null,
      startDelayMs?: number | null,
      options?: {
        includeDiagnosticsCandidate?: boolean;
        requireMicrophoneSidecar?: boolean;
        mediaTrackSettings?: MicrophoneTrackSettingsSnapshot | null;
      },
    ) => {
      if (
        typeof window.electronAPI?.recoverNativeScreenRecording !== "function"
      ) {
        return null;
      }

      const result = await window.electronAPI.recoverNativeScreenRecording({
        includeDiagnosticsCandidate:
          options?.includeDiagnosticsCandidate !== false,
        deferAudioValidationUntilMicrophoneSidecar:
          options?.requireMicrophoneSidecar === true,
      });
      if (!result.success || !result.path) {
        return null;
      }

      const auditFailureMessage = getNativeRecordingAuditFailureMessage(result);
      if (auditFailureMessage) {
        console.error(
          "[recording-recovery-audit-failed]",
          result.recordingAudit,
        );
        await notifyRecordingFinalizationFailure(auditFailureMessage);
        if (typeof window.electronAPI?.hudOverlayClose === "function") {
          window.electronAPI.hudOverlayClose();
        }
        return null;
      }
      let auditWarningMessage = getNativeRecordingAuditWarningMessage(result);

      const resolvedMicFallbackBlobPromise =
        micFallbackBlobPromise ?? stopMicFallbackRecorder();
      const webcamPath = await resolveRecoveredNativeWebcamPath({
        recoveryResult: result,
        stopWebcamRecorder,
      });
      if (options?.requireMicrophoneSidecar === true) {
        const requiredSidecarResult =
          await finalizeRequiredMicrophoneSidecarBeforeEditor({
            micFallbackBlobPromise: resolvedMicFallbackBlobPromise,
            finalPath: result.path,
            fallbackStartDelayMs: startDelayMs,
            fallbackTrackSettings: options.mediaTrackSettings,
            existingAuditWarningMessage: auditWarningMessage,
            storeMicrophoneSidecar,
            auditFinalizedRecording: window.electronAPI.auditFinalizedRecording,
            notifyRecordingFinalizationFailure,
            closeHudOverlay:
              typeof window.electronAPI?.hudOverlayClose === "function"
                ? window.electronAPI.hudOverlayClose
                : undefined,
          });
        if (!requiredSidecarResult.success) {
          return null;
        }
        auditWarningMessage = requiredSidecarResult.auditWarningMessage;
      } else {
        const micSidecarResult = await storeMicrophoneSidecar(
          resolvedMicFallbackBlobPromise,
          result.path,
          startDelayMs,
          options?.mediaTrackSettings ?? null,
          false,
        );
        const micSidecarFailureMessage =
          getMicrophoneSidecarFinalizationFailureMessage(micSidecarResult);
        if (micSidecarFailureMessage) {
          await notifyRecordingFinalizationFailure(micSidecarFailureMessage);
          if (typeof window.electronAPI?.hudOverlayClose === "function") {
            window.electronAPI.hudOverlayClose();
          }
          return null;
        }
      }
      await finalizeRecordingSession(result.path, webcamPath);
      if (auditWarningMessage) {
        console.warn(
          "[recording-recovery-audit-warning]",
          result.recordingAudit,
        );
        notifyRecordingFinalizationWarning(auditWarningMessage);
      }

      if (typeof window.electronAPI?.hudOverlayClose === "function") {
        window.electronAPI.hudOverlayClose();
      }

      return result.path;
    },
    [
      finalizeRecordingSession,
      notifyRecordingFinalizationFailure,
      notifyRecordingFinalizationWarning,
      stopMicFallbackRecorder,
      stopWebcamRecorder,
      storeMicrophoneSidecar,
    ],
  );

  /**
   * Acquire the webcam stream and prepare the MediaRecorder, but do NOT start
   * recording yet. Call {@link beginWebcamCapture} after the main recording
   * has started so both begin at approximately the same time.
   */
  const prepareWebcamRecorder = useCallback(async () => {
    if (!webcamEnabled) {
      resolvedWebcamPath.current = null;
      pendingWebcamPathPromise.current = Promise.resolve(null);
      webcamStartTime.current = null;
      webcamTimeOffsetMs.current = 0;
      return;
    }

    try {
      // Share the camera with the floating preview through the session
      // manager. Recording a clone of the shared track means stopping the
      // recorder never touches the preview, and preview show/hide never
      // restarts the device mid-recording.
      let effectiveWebcamQualityMode = webcamQualityMode;
      webcamSessionHandle.current = await acquireWebcamSession(
        webcamDeviceId,
        webcamFrameRate,
        effectiveWebcamQualityMode,
      );
      let sessionStream = webcamSessionHandle.current.stream;
      let sessionVideoTrack = sessionStream.getVideoTracks()[0];
      if (
        effectiveWebcamQualityMode !== "stable" &&
        isContinuityOrIPhoneCameraLabel(sessionVideoTrack?.label)
      ) {
        recordRecordingEvent("webcam-quality-auto-downgraded", {
          requestedQualityMode: webcamQualityMode,
          effectiveQualityMode: "stable",
          reason: "continuity-camera-stability",
          trackLabel: sessionVideoTrack?.label ?? null,
          trackSettings: sessionVideoTrack?.getSettings
            ? { ...sessionVideoTrack.getSettings() }
            : null,
        });
        webcamSessionHandle.current.release();
        webcamSessionHandle.current = null;
        forceRestartWebcamSessionForRecording();
        effectiveWebcamQualityMode = "stable";
        webcamSessionHandle.current = await acquireWebcamSession(
          webcamDeviceId,
          webcamFrameRate,
          effectiveWebcamQualityMode,
        );
        sessionStream = webcamSessionHandle.current.stream;
        sessionVideoTrack = sessionStream.getVideoTracks()[0];
      }

      const recordingStream = sessionStream.clone();
      webcamStream.current = recordingStream;
      const webcamVideoTrack = recordingStream.getVideoTracks()[0];
      recordRecordingEvent("webcam-capture-settings", {
        requestedQualityMode: webcamQualityMode,
        effectiveQualityMode: effectiveWebcamQualityMode,
        requestedFrameRate: webcamFrameRate,
        trackSettings: webcamVideoTrack?.getSettings
          ? { ...webcamVideoTrack.getSettings() }
          : null,
        trackLabel: webcamVideoTrack?.label ?? null,
        trackReadyState: webcamVideoTrack?.readyState ?? null,
      });
      webcamWatchdogCleanup.current = attachWebcamFrameWatchdog(
        recordingStream,
        recordRecordingEvent,
        handleWebcamPipelineFailure,
        () => pauseStartedAtMs.current !== null,
      );

      const mimeType = selectWebcamMimeType();
      const sessionTimestamp = recordingSessionTimestamp.current ?? Date.now();
      const webcamFileName = `${RECORDING_FILE_PREFIX}${sessionTimestamp}${WEBCAM_SUFFIX}${getVideoExtensionForMimeType(mimeType)}`;
      webcamChunks.current = [];
      resolvedWebcamPath.current = null;
      webcamSidecarStreamId.current = null;
      webcamSidecarPath.current = null;
      webcamChunkWriteChain.current = Promise.resolve();
      webcamChunkIndex.current = 0;
      webcamStopPromise.current = new Promise((resolve) => {
        webcamStopResolver.current = resolve;
      });
      pendingWebcamPathPromise.current = webcamStopPromise.current;

      if (
        typeof window.electronAPI?.startWebcamSidecarRecording === "function"
      ) {
        const streamResult =
          await window.electronAPI.startWebcamSidecarRecording({
            sessionId: String(sessionTimestamp),
            fileName: webcamFileName,
            mimeType,
          });
        if (streamResult.success && streamResult.streamId) {
          webcamSidecarStreamId.current = streamResult.streamId;
          webcamSidecarPath.current = streamResult.path ?? null;
          recordRecordingEvent("webcam-sidecar-stream-ready", {
            fileName: webcamFileName,
            mimeType: mimeType ?? null,
            path: streamResult.path ?? null,
          });
        } else {
          recordRecordingEvent("webcam-sidecar-stream-unavailable", {
            fileName: webcamFileName,
            mimeType: mimeType ?? null,
            error: streamResult.error ?? null,
          });
        }
      }

      const recorder = new MediaRecorder(
        recordingStream,
        createWebcamRecordingOptions(mimeType, effectiveWebcamQualityMode),
      );

      webcamRecorder.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          if (
            shouldRetainWebcamChunkForFinalBlob({
              hasStreamingSidecar: Boolean(webcamSidecarStreamId.current),
              mimeType: recorder.mimeType || mimeType,
            })
          ) {
            webcamChunks.current.push(event.data);
          }
          enqueueWebcamSidecarChunk(event.data);
        }
      };
      recorder.onerror = () => {
        const streamId = webcamSidecarStreamId.current;
        if (
          streamId &&
          typeof window.electronAPI?.abortWebcamSidecarRecording === "function"
        ) {
          void window.electronAPI.abortWebcamSidecarRecording(
            streamId,
            "recorder-error",
          );
        }
        recordRecordingEvent("webcam-recorder-error");
        handleWebcamPipelineFailure("recorder-error", {
          recorderState: recorder.state,
          mimeType: recorder.mimeType || mimeType || null,
        });
        webcamStopResolver.current?.(null);
        webcamStopResolver.current = null;
      };
      recorder.onstop = async () => {
        const webcamMimeType = recorder.mimeType || mimeType;
        const streamId = webcamSidecarStreamId.current;

        try {
          await webcamChunkWriteChain.current.catch((error) => {
            console.warn("Failed while draining webcam sidecar chunks:", error);
          });

          let streamedPath = webcamSidecarPath.current;
          if (
            streamId &&
            typeof window.electronAPI?.finishWebcamSidecarRecording ===
              "function"
          ) {
            const finishResult =
              await window.electronAPI.finishWebcamSidecarRecording(streamId);
            if (finishResult.success && finishResult.path) {
              streamedPath = finishResult.path;
              recordRecordingEvent("webcam-sidecar-stream-finished", {
                path: streamedPath,
                bytesWritten: finishResult.bytesWritten ?? null,
                chunksWritten: finishResult.chunksWritten ?? null,
                normalized: finishResult.normalized ?? false,
                normalizedBytesWritten:
                  finishResult.normalizedBytesWritten ?? null,
                normalizationError: finishResult.normalizationError ?? null,
              });
            } else {
              recordRecordingEvent("webcam-sidecar-stream-finish-failed", {
                error: finishResult.error ?? null,
              });
            }
          }

          if (webcamChunks.current.length === 0) {
            webcamStopResolver.current?.(streamedPath ?? null);
            return;
          }

          if (streamedPath && !isWebmMimeType(webcamMimeType)) {
            webcamChunks.current = [];
            webcamStopResolver.current?.(streamedPath);
            return;
          }

          if (webcamChunks.current.length === 0) {
            webcamStopResolver.current?.(null);
            return;
          }

          const duration = Math.max(
            0,
            getRecordingDurationMs(Date.now()) - webcamTimeOffsetMs.current,
          );
          const webcamBlob = new Blob(
            webcamChunks.current,
            webcamMimeType ? { type: webcamMimeType } : undefined,
          );
          webcamChunks.current = [];
          const finalBlob = isWebmMimeType(webcamMimeType)
            ? await fixWebmDuration(webcamBlob, duration)
            : webcamBlob;
          const arrayBuffer = await finalBlob.arrayBuffer();
          const result =
            typeof window.electronAPI?.storeWebcamSidecarVideo === "function"
              ? await window.electronAPI.storeWebcamSidecarVideo(
                  arrayBuffer,
                  webcamFileName,
                  {
                    sessionId: String(sessionTimestamp),
                    mimeType: webcamMimeType,
                  },
                )
              : await window.electronAPI.storeRecordedVideo(
                  arrayBuffer,
                  webcamFileName,
                );
          webcamStopResolver.current?.(
            result.success ? (result.path ?? null) : null,
          );
        } catch (error) {
          console.error("Error saving webcam recording:", error);
          recordRecordingEvent("webcam-sidecar-save-failed", {
            error: getErrorMessage(error),
            streamPath: webcamSidecarPath.current,
          });
          webcamStopResolver.current?.(null);
        } finally {
          webcamStopResolver.current = null;
          webcamRecorder.current = null;
          webcamStartTime.current = null;
          webcamSidecarStreamId.current = null;
          webcamSidecarPath.current = null;
          releaseWebcamCapture();
        }
      };
    } catch (error) {
      console.warn(
        "Failed to start webcam recording; continuing without webcam layer:",
        error,
      );
      const streamId = webcamSidecarStreamId.current;
      if (
        streamId &&
        typeof window.electronAPI?.abortWebcamSidecarRecording === "function"
      ) {
        void window.electronAPI.abortWebcamSidecarRecording(
          streamId,
          "webcam-prepare-failed",
        );
      }
      resolvedWebcamPath.current = null;
      pendingWebcamPathPromise.current = Promise.resolve(null);
      webcamStopPromise.current = Promise.resolve(null);
      webcamRecorder.current = null;
      webcamStartTime.current = null;
      webcamTimeOffsetMs.current = 0;
      webcamSidecarStreamId.current = null;
      webcamSidecarPath.current = null;
      releaseWebcamCapture();
    }
  }, [
    enqueueWebcamSidecarChunk,
    getRecordingDurationMs,
    handleWebcamPipelineFailure,
    recordRecordingEvent,
    releaseWebcamCapture,
    selectWebcamMimeType,
    webcamDeviceId,
    webcamEnabled,
    webcamFrameRate,
    webcamQualityMode,
  ]);

  /** Start the prepared webcam MediaRecorder. Call after main recording begins. */
  const beginWebcamCapture = useCallback(() => {
    const recorder = webcamRecorder.current;
    if (recorder && recorder.state === "inactive") {
      webcamStartTime.current = Date.now();
      recorder.start(RECORDER_TIMESLICE_MS);
    }
  }, []);

  const stopRecording = useRef(() => {
    setPaused(false);
    if (nativeScreenRecording.current) {
      nativeScreenRecording.current = false;
      setRecording(false);
      setFinalizing(true);

      void (async () => {
        const stopStart = performance.now();
        console.log("[PERF:RENDERER] Total Stop Sequence: STARTED");

        const fallbackStartDelayMs = micFallbackStartDelayMs.current;
        const fallbackTrackSettings = micFallbackTrackSettings.current;
        const stoppedAtMs = Date.now();
        markRecordingResumed(stoppedAtMs);
        const expectedDurationMs = getRecordingDurationMs(stoppedAtMs);
        const requiresMicFallbackSidecarBeforeEditor =
          micFallbackRecorder.current !== null;
        const micFallbackBlobPromise = stopMicFallbackRecorder();
        const hasNativeMacWebcamPath = nativeMacWebcamPath.current !== null;
        const webcamPathPromise = hasNativeMacWebcamPath
          ? Promise.resolve(nativeMacWebcamPath.current)
          : stopWebcamRecorder();
        const isNativeWindows = nativeWindowsRecording.current;
        nativeWindowsRecording.current = false;

        const ipcStopStart = performance.now();
        console.log("[PERF:RENDERER] IPC: stopNativeScreenRecording: STARTED");
        const result = await window.electronAPI.stopNativeScreenRecording({
          expectedDurationMs,
          deferAudioValidationUntilMicrophoneSidecar:
            requiresMicFallbackSidecarBeforeEditor,
        });
        console.log(
          `[PERF:RENDERER] IPC: stopNativeScreenRecording: COMPLETED in ${(performance.now() - ipcStopStart).toFixed(2)}ms`,
        );

        await window.electronAPI?.setRecordingState(false);

        if (!result.success || !result.path) {
          console.error(
            "Failed to stop native screen recording:",
            result.error ?? result.message,
          );
          void logNativeCaptureDiagnostics("stop-native-screen-recording");
          try {
            const recoveredPath = await recoverNativeRecordingSession(
              micFallbackBlobPromise,
              fallbackStartDelayMs,
              {
                requireMicrophoneSidecar:
                  requiresMicFallbackSidecarBeforeEditor,
                mediaTrackSettings: fallbackTrackSettings,
              },
            );
            if (recoveredPath) {
              console.log(
                `[PERF:RENDERER] Total Stop Sequence (RECOVERED) in ${(performance.now() - stopStart).toFixed(2)}ms`,
              );
              return;
            }
          } catch (recoveryError) {
            console.error(
              "Failed to recover native screen recording:",
              recoveryError,
            );
          }

          const failureMessage = await buildNativeCaptureFailureMessage(
            "stop-native-screen-recording",
            isMacOS
              ? "Failed to finish the macOS recording, so the editor was not opened."
              : "Failed to finish the recording, so the editor was not opened.",
          );
          await notifyRecordingFinalizationFailure(failureMessage);
          return;
        }

        const auditFailureMessage =
          getNativeRecordingAuditFailureMessage(result);
        if (auditFailureMessage) {
          console.error("[recording-audit-failed]", result.recordingAudit);
          await notifyRecordingFinalizationFailure(auditFailureMessage);
          if (typeof window.electronAPI?.hudOverlayClose === "function") {
            window.electronAPI.hudOverlayClose();
          }
          return;
        }
        let auditWarningMessage = getNativeRecordingAuditWarningMessage(result);

        const finalPath = result.path;
        const immediateWebcamPath = resolveImmediateFinalizationWebcamPath({
          hasNativeMacWebcamPath,
          stopResultWebcamPath: result.webcamPath,
        });
        if (immediateWebcamPath) {
          nativeMacWebcamPath.current = immediateWebcamPath;
        }

        let microphoneSidecarStoredBeforeEditor = false;
        if (requiresMicFallbackSidecarBeforeEditor) {
          const requiredSidecarResult =
            await finalizeRequiredMicrophoneSidecarBeforeEditor({
              micFallbackBlobPromise,
              finalPath,
              fallbackStartDelayMs,
              fallbackTrackSettings,
              existingAuditWarningMessage: auditWarningMessage,
              storeMicrophoneSidecar,
              auditFinalizedRecording:
                window.electronAPI.auditFinalizedRecording,
              notifyRecordingFinalizationFailure,
              closeHudOverlay:
                typeof window.electronAPI?.hudOverlayClose === "function"
                  ? window.electronAPI.hudOverlayClose
                  : undefined,
            });
          if (!requiredSidecarResult.success) {
            return;
          }
          auditWarningMessage = requiredSidecarResult.auditWarningMessage;
          microphoneSidecarStoredBeforeEditor = true;
        }

        // Native mac webcam paths are validated by the stop IPC response. Required
        // fallback microphone sidecars are now validated before opening the editor
        // so a project cannot open without its synced mic track.
        await finalizeRecordingSession(finalPath, immediateWebcamPath);
        if (auditWarningMessage) {
          console.warn("[recording-audit-warning]", result.recordingAudit);
          notifyRecordingFinalizationWarning(auditWarningMessage);
        }

        // 2. Perform background finalization (webcam, muxing, sidecars)
        // We don't await this to keep the UI responsive
        void (async () => {
          try {
            // Await the webcam path in the background
            const webcamPath = hasNativeMacWebcamPath
              ? (result.webcamPath ?? null)
              : await webcamPathPromise;
            console.log(
              "[useScreenRecorder] Background native processing: webcamPath is",
              webcamPath,
            );

            // Store optional sidecars that were not required before editor open.
            if (!microphoneSidecarStoredBeforeEditor) {
              await storeMicrophoneSidecar(
                micFallbackBlobPromise,
                finalPath,
                fallbackStartDelayMs,
                fallbackTrackSettings,
                false,
              );
            }

            // Perform muxing/renaming if on Windows
            if (isNativeWindows) {
              await window.electronAPI.muxNativeWindowsRecording(
                expectedDurationMs,
              );
            }

            console.log(
              "[useScreenRecorder] Emitting setCurrentRecordingSession with:",
              { finalPath, webcamPath },
            );

            // Update the session state to notify the editor that all background assets (webcam, mic, etc.) are now ready.
            // This broadcasts a 'recording-session-changed' event that the open editor listens to for re-scanning assets.
            await window.electronAPI.setCurrentRecordingSession(
              {
                videoPath: finalPath,
                webcamPath,
                timeOffsetMs: webcamTimeOffsetMs.current,
                hideOverlayCursorByDefault:
                  hideEditorOverlayCursorByDefault.current,
              },
              {
                source: "recording-background-finalization",
              },
            );

            console.log(
              `[PERF:RENDERER] Background Stop Sequence: COMPLETED in ${(performance.now() - stopStart).toFixed(2)}ms`,
            );
          } catch (bgError) {
            console.error("Error in background finalization:", bgError);
          } finally {
            // After all background tasks are done (webcam, mic sidecars, muxing),
            // we can safely close the HUD window to release hardware and resources.
            if (typeof window.electronAPI?.hudOverlayClose === "function") {
              console.log(
                "[useScreenRecorder] All background tasks finished, closing HUD",
              );
              window.electronAPI.hudOverlayClose();
            }
          }
        })();
      })();
      return;
    }

    const recorder = mediaRecorder.current;
    const recorderState = recorder?.state;
    if (
      recorder &&
      (recorderState === "recording" || recorderState === "paused")
    ) {
      if (recorderState === "paused") {
        try {
          recorder.resume();
          markRecordingResumed(Date.now());
        } catch (error) {
          console.warn("Failed to resume recorder before stopping:", error);
        }
      }
      pendingWebcamPathPromise.current = stopWebcamRecorder();
      try {
        recorder.requestData();
      } catch (error) {
        console.warn("Failed to flush recorder before stopping:", error);
      }
      recorder.stop();
      setRecording(false);
      setFinalizing(true);
      window.electronAPI?.setRecordingState(false);
    }
  });

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const platform = await window.electronAPI.getPlatform();
      if (cancelled) {
        return;
      }

      const macOS = platform === "darwin";
      setIsMacOS(macOS);

      if (!macOS || startupNativeRecoveryAttempted.current) {
        return;
      }

      startupNativeRecoveryAttempted.current = true;
      await attemptNativeRecordingStartupRecovery({
        isMacOS: macOS,
        recover: () =>
          recoverNativeRecordingSession(null, null, {
            includeDiagnosticsCandidate: false,
          }),
        logDiagnostics: logNativeCaptureDiagnostics,
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [logNativeCaptureDiagnostics, recoverNativeRecordingSession]);

  useEffect(() => {
    if (typeof window.electronAPI?.getRecordingAudioLabConfig !== "function") {
      return;
    }

    void (async () => {
      const result = await window.electronAPI.getRecordingAudioLabConfig();
      browserMicrophoneProfile.current = normalizeBrowserMicrophoneProfile(
        result.browserMicrophoneProfile,
      );
      requestedBrowserMicrophoneProfile.current =
        result.requestedBrowserMicrophoneProfile ?? null;
      console.info(
        "Browser microphone profile:",
        browserMicrophoneProfile.current,
      );
    })();
  }, []);

  useEffect(() => {
    if (countdownDelayLoaded.current) return;
    countdownDelayLoaded.current = true;

    void (async () => {
      const result = await window.electronAPI.getCountdownDelay();
      if (result.success && typeof result.delay === "number") {
        setCountdownDelayState(result.delay);
      }
    })();
  }, []);

  const setCountdownDelay = useCallback((delay: number) => {
    setCountdownDelayState(delay);
    void window.electronAPI.setCountdownDelay(delay);
  }, []);

  useEffect(() => {
    if (recordingPrefsLoaded.current) return;
    recordingPrefsLoaded.current = true;

    void (async () => {
      const result = await window.electronAPI.getRecordingPreferences();
      if (result.success) {
        setMicrophoneEnabled(result.microphoneEnabled);
        if (result.microphoneDeviceId) {
          setMicrophoneDeviceId(result.microphoneDeviceId);
        }
        setSystemAudioEnabled(result.systemAudioEnabled);
        setWebcamFrameRate(coerceWebcamFrameRate(result.webcamFrameRate));
        setWebcamQualityMode(coerceWebcamQualityMode(result.webcamQualityMode));
      }
    })();
  }, []);

  const persistMicrophoneEnabled = useCallback((enabled: boolean) => {
    setMicrophoneEnabled(enabled);
    void window.electronAPI.setRecordingPreferences({
      microphoneEnabled: enabled,
    });
  }, []);

  const persistMicrophoneDeviceId = useCallback(
    (deviceId: string | undefined) => {
      setMicrophoneDeviceId(deviceId);
      void window.electronAPI.setRecordingPreferences({
        microphoneDeviceId: deviceId,
      });
    },
    [],
  );

  const persistSystemAudioEnabled = useCallback((enabled: boolean) => {
    setSystemAudioEnabled(enabled);
    void window.electronAPI.setRecordingPreferences({
      systemAudioEnabled: enabled,
    });
  }, []);

  const persistWebcamFrameRate = useCallback((frameRate: WebcamFrameRate) => {
    setWebcamFrameRate(frameRate);
    void window.electronAPI.setRecordingPreferences({
      webcamFrameRate: frameRate,
    });
  }, []);

  const persistWebcamQualityMode = useCallback(
    (qualityMode: WebcamQualityMode) => {
      setWebcamQualityMode(qualityMode);
      void window.electronAPI.setRecordingPreferences({
        webcamQualityMode: qualityMode,
      });
    },
    [],
  );

  useEffect(() => {
    let cleanup: (() => void) | undefined;

    if (window.electronAPI?.onStopRecordingFromTray) {
      cleanup = window.electronAPI.onStopRecordingFromTray(() => {
        stopRecording.current();
      });
    }

    const removeRecordingStateListener =
      window.electronAPI?.onRecordingStateChanged?.((state) => {
        setRecording(state.recording);
      });

    const removeRecordingInterruptedListener =
      window.electronAPI?.onRecordingInterrupted?.((state) => {
        void (async () => {
          setRecording(false);
          nativeScreenRecording.current = false;
          await window.electronAPI.setRecordingState(false);

          if (state.reason !== "window-unavailable") {
            try {
              const recoveredPath = await recoverNativeRecordingSession();
              if (recoveredPath) {
                cleanupCapturedMedia();
                return;
              }
            } catch (recoveryError) {
              console.error(
                "Failed to recover interrupted native screen recording:",
                recoveryError,
              );
            }
          }

          cleanupCapturedMedia();
          if (
            state.reason === "window-unavailable" &&
            !hasPromptedForReselect.current
          ) {
            hasPromptedForReselect.current = true;
            alert(state.message);
            await window.electronAPI.openSourceSelector();
          } else {
            console.error(state.message);
            toast.error(state.message);
          }
        })();
      });
    const removeRecordingDegradedListener =
      window.electronAPI?.onRecordingDegraded?.((state) => {
        console.warn("[recording-degraded]", state);
        const hardFailure = isNativeRecordingHardFailure({
          reason: state.reason,
          severity: state.severity,
        });
        recordRecordingEvent("native-recording-degraded", {
          reason: state.reason,
          message: state.message,
          severity: state.severity ?? "warning",
          ...(state.details ?? {}),
        });

        if (isNativeWebcamFailureReason(state.reason)) {
          nativeMacWebcamPath.current = null;
          resolvedWebcamPath.current = null;
          pendingWebcamPathPromise.current = Promise.resolve(null);
        }

        if (hardFailure) {
          setRecording(false);
          nativeScreenRecording.current = false;
          void window.electronAPI?.setRecordingState(false);
          if (shouldCleanupCapturedMediaForNativeDegradedEvent(state)) {
            cleanupCapturedMedia();
          }
        }

        const toastFn =
          state.severity === "error"
            ? toast.error
            : state.severity === "info"
              ? toast.info
              : toast.warning;
        toastFn(state.message, {
          id: `${RECORDING_DEGRADED_TOAST_ID}-${state.reason}`,
          duration: 10000,
        });
      });

    return () => {
      cleanup?.();
      removeRecordingStateListener?.();
      removeRecordingInterruptedListener?.();
      removeRecordingDegradedListener?.();

      if (nativeScreenRecording.current) {
        nativeScreenRecording.current = false;
        void window.electronAPI.stopNativeScreenRecording();
      }

      const recorder = mediaRecorder.current;
      const recorderState = recorder?.state;
      if (
        recorder &&
        (recorderState === "recording" || recorderState === "paused")
      ) {
        recorder.stop();
      }

      cleanupCapturedMedia();
    };
  }, [
    cleanupCapturedMedia,
    recoverNativeRecordingSession,
    recordRecordingEvent,
  ]);

  const startRecording = async () => {
    if (startInFlight.current) {
      return;
    }

    let hudSourceSelectionActive = false;
    const setHudSourceSelectionActive = (active: boolean) => {
      if (hudSourceSelectionActive === active) {
        return;
      }

      hudSourceSelectionActive = active;
      window.electronAPI?.hudOverlaySetSourceSelectionActive?.(active);
    };

    hasPromptedForReselect.current = false;
    webcamPipelineFailureTriggered.current = false;
    startInFlight.current = true;
    setStarting(true);

    try {
      const platform = await window.electronAPI.getPlatform();
      hideEditorOverlayCursorByDefault.current = false;
      const existingSource = await window.electronAPI.getSelectedSource();
      const selectedSource =
        existingSource ?? (platform === "linux" ? LINUX_PORTAL_SOURCE : null);
      if (!selectedSource) {
        alert("Please select a source to record");
        return;
      }
      // Persist the synthetic Linux portal sentinel to main so that the
      // setDisplayMediaRequestHandler can short-circuit getSources() and
      // avoid triggering an extra portal dialog.
      if (!existingSource && selectedSource.id === "screen:linux-portal") {
        try {
          await window.electronAPI.selectSource(selectedSource);
        } catch (err) {
          console.warn("Failed to persist Linux portal sentinel source:", err);
        }
      }

      const permissionsReady = await preparePermissions();
      if (!permissionsReady) {
        return;
      }

      recordingSessionTimestamp.current = Date.now();
      resetRecordingClock(recordingSessionTimestamp.current);
      nativeMacWebcamPath.current = null;
      const useNativeMacScreenCapture =
        platform === "darwin" &&
        (selectedSource.id?.startsWith("screen:") ||
          selectedSource.id?.startsWith("window:")) &&
        typeof window.electronAPI.startNativeScreenRecording === "function";
      const nativeMacCaptureSource = useNativeMacScreenCapture
        ? await resolveBrowserCaptureSource(selectedSource)
        : selectedSource;
      if (
        useNativeMacScreenCapture &&
        (nativeMacCaptureSource.id !== selectedSource.id ||
          String(nativeMacCaptureSource.display_id ?? "") !==
            String(selectedSource.display_id ?? ""))
      ) {
        recordRecordingEvent("native-screen-source-refreshed", {
          previousId: selectedSource.id,
          previousDisplayId: selectedSource.display_id ?? null,
          nextId: nativeMacCaptureSource.id,
          nextDisplayId: nativeMacCaptureSource.display_id ?? null,
          sourceName: nativeMacCaptureSource.name ?? selectedSource.name,
        });
      }
      const webcamCaptureOwner = resolveWebcamCaptureOwner({
        platform,
        webcamEnabled,
        nativeMacScreenCaptureAvailable: useNativeMacScreenCapture,
      });
      const useNativeMacWebcamCapture = webcamCaptureOwner === "native-mac";

      let useNativeWindowsCapture = false;
      let nativeWindowsCaptureStartFailed = false;
      if (
        platform === "win32" &&
        shouldUseNativeWindowsCaptureForSource(selectedSource) &&
        typeof window.electronAPI.isNativeWindowsCaptureAvailable === "function"
      ) {
        try {
          const nativeWindowsResult =
            await window.electronAPI.isNativeWindowsCaptureAvailable();
          useNativeWindowsCapture = nativeWindowsResult.available;
          if (
            !useNativeWindowsCapture &&
            !hasShownNativeWindowsFallbackToast.current
          ) {
            void logNativeCaptureDiagnostics(
              "is-native-windows-capture-available",
            );
            hasShownNativeWindowsFallbackToast.current = true;
            toast.info(
              "Native Windows capture is unavailable. Falling back to browser capture.",
            );
          }
        } catch {
          useNativeWindowsCapture = false;
          if (!hasShownNativeWindowsFallbackToast.current) {
            hasShownNativeWindowsFallbackToast.current = true;
            toast.info(
              "Unable to check native Windows capture. Falling back to browser capture.",
            );
          }
        }
      }

      if (webcamCaptureOwner === "browser") {
        await prepareWebcamRecorder();
      } else if (webcamCaptureOwner === "native-mac") {
        forceRestartWebcamSessionForRecording();
        recordRecordingEvent("native-webcam-browser-session-released", {
          reason: "native-webcam-capture",
        });
        resolvedWebcamPath.current = null;
        pendingWebcamPathPromise.current = Promise.resolve(null);
        webcamStartTime.current = null;
        webcamTimeOffsetMs.current = 0;
      } else {
        resolvedWebcamPath.current = null;
        pendingWebcamPathPromise.current = Promise.resolve(null);
        webcamStartTime.current = null;
        webcamTimeOffsetMs.current = 0;
      }

      if (useNativeMacScreenCapture || useNativeWindowsCapture) {
        // Resolve the selected mic label for native capture backends.
        let micLabel: string | undefined;
        let browserMicrophoneDeviceIdForFallback = microphoneDeviceId;
        let nativeMicrophoneSelection: NativeMacMicrophoneCaptureSelection = {
          microphoneDeviceId,
          microphoneLabel: undefined,
          microphoneConnectionKind: undefined,
          microphoneConnectionLabel: null,
          matchedBrowserDevice: false,
          matchedNativeDevice: false,
        };
        if (microphoneEnabled) {
          let browserAudioDevices: BrowserAudioDeviceForNativeSelection[] = [];
          try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            browserAudioDevices = devices
              .filter((device) => device.kind === "audioinput")
              .map((device) => ({
                deviceId: device.deviceId,
                label: device.label,
              }));
            const mic = browserAudioDevices.find(
              (d) => d.deviceId === microphoneDeviceId,
            );
            micLabel = mic?.label || undefined;
            browserMicrophoneDeviceIdForFallback = mic
              ? microphoneDeviceId
              : undefined;
          } catch {
            // Fall through — native process will use the default mic
          }
          if (useNativeMacScreenCapture) {
            let nativeAudioDevices: NativeAudioDeviceForNativeSelection[] = [];
            if (
              typeof window.electronAPI?.getAudioDeviceConnectionInfo ===
              "function"
            ) {
              try {
                const nativeAudioDevicesResult =
                  await window.electronAPI.getAudioDeviceConnectionInfo();
                nativeAudioDevices = nativeAudioDevicesResult.success
                  ? nativeAudioDevicesResult.devices
                  : [];
              } catch {
                // Fall through — helper can still try label-based resolution.
              }
            }
            nativeMicrophoneSelection =
              resolveNativeMacMicrophoneCaptureSelection({
                selectedDeviceId: microphoneDeviceId,
                browserDevices: browserAudioDevices,
                nativeDevices: nativeAudioDevices,
              });
            micLabel = nativeMicrophoneSelection.microphoneLabel ?? micLabel;
            recordRecordingEvent("native-microphone-selection-resolved", {
              selectedDeviceId: microphoneDeviceId ?? null,
              resolvedDeviceId:
                nativeMicrophoneSelection.microphoneDeviceId ?? null,
              resolvedLabel: nativeMicrophoneSelection.microphoneLabel ?? null,
              connectionKind:
                nativeMicrophoneSelection.microphoneConnectionKind ?? null,
              connectionLabel:
                nativeMicrophoneSelection.microphoneConnectionLabel ?? null,
              matchedBrowserDevice:
                nativeMicrophoneSelection.matchedBrowserDevice,
              matchedNativeDevice:
                nativeMicrophoneSelection.matchedNativeDevice,
            });
          }
        }
        const forceBrowserMicrophoneSidecar =
          shouldUseBrowserMicrophoneSidecarForNativeMac({
            useNativeMacScreenCapture,
            microphoneEnabled,
          });
        if (forceBrowserMicrophoneSidecar) {
          recordRecordingEvent("browser-microphone-sidecar-forced", {
            reason: "mac-native-screen-capture-audio-sync",
            selectedDeviceId: microphoneDeviceId ?? null,
            browserDeviceId: browserMicrophoneDeviceIdForFallback ?? null,
            nativeResolvedDeviceId:
              nativeMicrophoneSelection.microphoneDeviceId ?? null,
            nativeResolvedLabel:
              nativeMicrophoneSelection.microphoneLabel ?? null,
          });
        }

        let nativeWebcamSelection: NativeMacWebcamCaptureSelection = {
          webcamDeviceId,
          webcamLabel: undefined,
          webcamConnectionKind: undefined,
          webcamConnectionLabel: null,
          matchedBrowserDevice: false,
          matchedNativeDevice: false,
        };
        if (useNativeMacWebcamCapture) {
          let browserVideoDevices: BrowserVideoDeviceForNativeSelection[] = [];
          let nativeVideoDevices: NativeVideoDeviceForNativeSelection[] = [];
          try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            browserVideoDevices = devices
              .filter((device) => device.kind === "videoinput")
              .map((device) => ({
                deviceId: device.deviceId,
                label: device.label,
              }));
          } catch {
            // Fall through — native process can still resolve native camera IDs.
          }

          if (
            typeof window.electronAPI?.getVideoDeviceConnectionInfo ===
            "function"
          ) {
            try {
              const nativeDevicesResult =
                await window.electronAPI.getVideoDeviceConnectionInfo();
              nativeVideoDevices = nativeDevicesResult.success
                ? nativeDevicesResult.devices
                : [];
            } catch {
              // Fall through — existing selected ID/label fallback will be used.
            }
          }

          nativeWebcamSelection = resolveNativeMacWebcamCaptureSelection({
            selectedDeviceId: webcamDeviceId,
            browserDevices: browserVideoDevices,
            nativeDevices: nativeVideoDevices,
          });
          recordRecordingEvent("native-webcam-selection-resolved", {
            selectedDeviceId: webcamDeviceId ?? null,
            resolvedDeviceId: nativeWebcamSelection.webcamDeviceId ?? null,
            resolvedLabel: nativeWebcamSelection.webcamLabel ?? null,
            connectionKind: nativeWebcamSelection.webcamConnectionKind ?? null,
            connectionLabel:
              nativeWebcamSelection.webcamConnectionLabel ?? null,
            matchedBrowserDevice: nativeWebcamSelection.matchedBrowserDevice,
            matchedNativeDevice: nativeWebcamSelection.matchedNativeDevice,
          });
        }
        const nativeWebcamCaptureSettings =
          resolveNativeMacWebcamCaptureSettings({
            qualityMode: webcamQualityMode,
            frameRate: webcamFrameRate,
            selection: nativeWebcamSelection,
          });
        if (useNativeMacWebcamCapture) {
          recordRecordingEvent("native-webcam-capture-settings-resolved", {
            requestedQualityMode: webcamQualityMode,
            effectiveQualityMode:
              nativeWebcamCaptureSettings.effectiveQualityMode,
            requestedFrameRate: webcamFrameRate,
            effectiveFrameRate: nativeWebcamCaptureSettings.fps,
            width: nativeWebcamCaptureSettings.width,
            height: nativeWebcamCaptureSettings.height,
            downgradedReason:
              nativeWebcamCaptureSettings.downgradedReason ?? null,
            label: nativeWebcamSelection.webcamLabel ?? null,
            connectionKind: nativeWebcamSelection.webcamConnectionKind ?? null,
            connectionLabel:
              nativeWebcamSelection.webcamConnectionLabel ?? null,
          });
        }

        const nativeResult =
          await window.electronAPI.startNativeScreenRecording(nativeMacCaptureSource, {
            sessionId: String(recordingSessionTimestamp.current),
            capturesSystemAudio: systemAudioEnabled,
            capturesMicrophone:
              microphoneEnabled && !forceBrowserMicrophoneSidecar,
            microphoneDeviceId: useNativeMacScreenCapture
              ? nativeMicrophoneSelection.microphoneDeviceId
              : microphoneDeviceId,
            microphoneLabel: micLabel,
            capturesWebcam: useNativeMacWebcamCapture,
            webcamDeviceId: nativeWebcamSelection.webcamDeviceId,
            webcamLabel: nativeWebcamSelection.webcamLabel,
            webcamWidth: nativeWebcamCaptureSettings.width,
            webcamHeight: nativeWebcamCaptureSettings.height,
            webcamFPS: nativeWebcamCaptureSettings.fps,
          });
        if (!nativeResult.success) {
          if (useNativeWindowsCapture) {
            nativeWindowsCaptureStartFailed = true;
            console.warn(
              "Native Windows capture failed, falling back to browser capture:",
              nativeResult.error ?? nativeResult.message,
            );
            void logNativeCaptureDiagnostics("start-native-screen-recording");
            if (!hasShownNativeWindowsFallbackToast.current) {
              hasShownNativeWindowsFallbackToast.current = true;
              toast.warning(
                "Native Windows capture failed to start. Falling back to browser capture.",
              );
            }
          } else if (!nativeResult.userNotified) {
            throw new Error(
              nativeResult.error ??
                nativeResult.message ??
                "Failed to start native screen recording",
            );
          } else {
            setRecording(false);
            cleanupCapturedMedia();
            await stopWebcamRecorder();
            return;
          }
        }

        if (nativeResult.success) {
          const nativeRecordingStartLeadMs =
            typeof nativeResult.recordingStartLeadMs === "number" &&
            Number.isFinite(nativeResult.recordingStartLeadMs)
              ? Math.max(0, nativeResult.recordingStartLeadMs)
              : 0;
          const mainStartedAt = Date.now() - nativeRecordingStartLeadMs;
          micFallbackStartDelayMs.current = null;
          if (useNativeMacWebcamCapture) {
            try {
              nativeMacWebcamPath.current =
                requireNativeMacWebcamPathAfterStart({
                  requiresNativeWebcam: true,
                  webcamPath: nativeResult.webcamPath,
                });
            } catch (error) {
              try {
                await window.electronAPI.stopNativeScreenRecording({
                  expectedDurationMs: getRecordingDurationMs(Date.now()),
                });
              } catch (stopError) {
                console.warn(
                  "Failed to stop native recording after missing webcam path:",
                  stopError,
                );
              }
              throw error;
            }
            pendingWebcamPathPromise.current = Promise.resolve(
              nativeMacWebcamPath.current,
            );
            resolvedWebcamPath.current = nativeMacWebcamPath.current;
            webcamStartTime.current = mainStartedAt;
          } else {
            beginWebcamCapture();
          }
          nativeScreenRecording.current = true;
          nativeWindowsRecording.current = useNativeWindowsCapture;
          resetRecordingClock(mainStartedAt);
          const nativeMacWebcamBaselineOffsetMs =
            useNativeMacWebcamCapture
              ? getNativeMacWebcamCaptureTimeOffsetMs(nativeWebcamSelection)
              : 0;
          const nativeMacMeasuredWebcamStartOffsetMs =
            typeof nativeResult.webcamStartOffsetMs === "number" &&
            Number.isFinite(nativeResult.webcamStartOffsetMs)
              ? nativeResult.webcamStartOffsetMs
              : null;
          webcamTimeOffsetMs.current = useNativeMacWebcamCapture
            ? nativeMacMeasuredWebcamStartOffsetMs !== null
              ? nativeMacMeasuredWebcamStartOffsetMs +
                nativeMacWebcamBaselineOffsetMs
              : nativeMacWebcamBaselineOffsetMs
            : webcamStartTime.current === null
              ? 0
              : webcamStartTime.current - mainStartedAt;
          if (useNativeMacWebcamCapture && webcamTimeOffsetMs.current !== 0) {
            recordRecordingEvent("native-webcam-time-offset-applied", {
              timeOffsetMs: webcamTimeOffsetMs.current,
              measuredStartOffsetMs: nativeMacMeasuredWebcamStartOffsetMs,
              baselineOffsetMs: nativeMacWebcamBaselineOffsetMs,
              label: nativeWebcamSelection.webcamLabel ?? null,
              connectionKind:
                nativeWebcamSelection.webcamConnectionKind ?? null,
              connectionLabel:
                nativeWebcamSelection.webcamConnectionLabel ?? null,
            });
          }
          if (nativeRecordingStartLeadMs > 0) {
            recordRecordingEvent("native-recording-start-lead-applied", {
              leadMs: nativeRecordingStartLeadMs,
              usesBrowserMicrophoneFallback:
                (nativeResult.microphoneFallbackRequired ||
                  forceBrowserMicrophoneSidecar) &&
                microphoneEnabled,
            });
          }

          // When native mic capture is unavailable or explicitly bypassed,
          // record mic via browser getUserMedia as a sidecar file.
          if (
            (nativeResult.microphoneFallbackRequired ||
              forceBrowserMicrophoneSidecar) &&
            microphoneEnabled
          ) {
            void logNativeCaptureDiagnostics(
              "start-browser-microphone-fallback",
            );
            console.info(
              "Using browser microphone processing for this recording.",
            );
            try {
              const microphoneConstraints =
                createProcessedMicrophoneConstraints(
                  browserMicrophoneDeviceIdForFallback,
                  browserMicrophoneProfile.current,
                );
              micFallbackRequestedConstraints.current = microphoneConstraints;
              const micStream = await navigator.mediaDevices.getUserMedia(
                microphoneConstraints,
              );
              micFallbackTrackSettings.current =
                createMicrophoneTrackSettingsSnapshot(micStream);
              micFallbackAudioInputDevices.current =
                await createAudioInputDeviceSnapshot().catch(() => null);
              console.info(
                "Browser microphone track settings:",
                micFallbackTrackSettings.current,
              );
              console.info(
                "Browser microphone audio input devices:",
                micFallbackAudioInputDevices.current,
              );
              micFallbackChunks.current = [];
              const recorder = new MediaRecorder(micStream, {
                mimeType: "audio/webm;codecs=opus",
                audioBitsPerSecond: AUDIO_BITRATE_VOICE,
              });
              micFallbackRecorderMetadata.current = {
                mimeType: recorder.mimeType,
                audioBitsPerSecond: AUDIO_BITRATE_VOICE,
                timesliceMs: RECORDER_TIMESLICE_MS,
              };
              resetMicFallbackTimingDiagnostics();
              micFallbackRecorderStartedAt.current = performance.now();
              recorder.ondataavailable = appendMicFallbackChunk;
              micFallbackStartDelayMs.current = Math.max(
                0,
                Date.now() - mainStartedAt,
              );
              recorder.start(RECORDER_TIMESLICE_MS);
              micFallbackRecorder.current = recorder;
            } catch (micError) {
              try {
                await window.electronAPI.stopNativeScreenRecording({
                  expectedDurationMs: getRecordingDurationMs(Date.now()),
                });
              } catch (stopError) {
                console.warn(
                  "Failed to stop native recording after microphone sidecar startup failed:",
                  stopError,
                );
              }
              nativeScreenRecording.current = false;
              micFallbackStartDelayMs.current = null;
              micFallbackTrackSettings.current = null;
              micFallbackRequestedConstraints.current = null;
              micFallbackAudioInputDevices.current = null;
              micFallbackRecorderMetadata.current = null;
              resetMicFallbackTimingDiagnostics();
              console.warn("Browser microphone fallback failed:", micError);
              const permissionDenied =
                micError instanceof DOMException &&
                (micError.name === "NotAllowedError" ||
                  micError.name === "SecurityError");
              throw new Error(
                permissionDenied
                  ? "Microphone permission denied. Recording was not started because microphone audio is required for a synced take."
                  : `${getErrorMessage(micError)}. Recording was not started because microphone audio is required for a synced take.`,
              );
            }
          }

          setRecording(true);
          try {
            await window.electronAPI?.setRecordingState(true);
          } catch (stateError) {
            console.warn(
              "Failed to notify main process that native recording started:",
              stateError,
            );
          }

          return;
        }
      }

      const browserCursorPolicy = resolveBrowserCaptureCursorPolicy({
        nativeWindowsCaptureStartFailed,
      });
      hideEditorOverlayCursorByDefault.current =
        browserCursorPolicy.hideEditorOverlayCursorByDefault;

      const wantsAudioCapture = microphoneEnabled || systemAudioEnabled;
      const browserCaptureSource =
        await resolveBrowserCaptureSource(nativeMacCaptureSource);

      if (
        browserCaptureSource?.id?.startsWith("screen:fallback:") ||
        browserCaptureSource?.id?.startsWith("window:fallback:")
      ) {
        throw new Error(
          "Selected display is not available for browser capture on this system.",
        );
      }

      if (browserCursorPolicy.hideOsCursorBeforeRecording) {
        try {
          const hideCursorResult = await window.electronAPI.hideOsCursor?.();
          if (hideCursorResult && !hideCursorResult.success) {
            console.warn(
              "Could not hide OS cursor before recording.",
              hideCursorResult,
            );
          }
        } catch {
          console.warn("Could not hide OS cursor before recording.");
        }
      }

      let videoTrack: MediaStreamTrack | undefined;
      let systemAudioIncluded = false;
      const mediaDevices = navigator.mediaDevices as DesktopCaptureMediaDevices;
      const useLinuxPortal = selectedSource.id === "screen:linux-portal";
      const browserScreenVideoConstraints = {
        mandatory: {
          chromeMediaSource: CHROME_MEDIA_SOURCE,
          chromeMediaSourceId: browserCaptureSource.id,
          maxWidth: TARGET_WIDTH,
          maxHeight: TARGET_HEIGHT,
          maxFrameRate: TARGET_FRAME_RATE,
          minFrameRate: MIN_FRAME_RATE,
          googCaptureCursor: browserCursorPolicy.streamCursor === "always",
        },
        cursor: browserCursorPolicy.streamCursor,
      };

      if (wantsAudioCapture) {
        let screenMediaStream: MediaStream;
        const acquireLinuxPortalStream = (withAudio: boolean) =>
          mediaDevices.getDisplayMedia({
            audio: withAudio,
            video: {
              displaySurface: "monitor",
              width: { ideal: TARGET_WIDTH, max: TARGET_WIDTH },
              height: { ideal: TARGET_HEIGHT, max: TARGET_HEIGHT },
              frameRate: { ideal: TARGET_FRAME_RATE, max: TARGET_FRAME_RATE },
              cursor: browserCursorPolicy.streamCursor,
            },
            selfBrowserSurface: "exclude",
            surfaceSwitching: "exclude",
          });

        if (systemAudioEnabled) {
          try {
            screenMediaStream = useLinuxPortal
              ? await acquireLinuxPortalStream(true)
              : await mediaDevices.getUserMedia({
                  audio: {
                    mandatory: {
                      chromeMediaSource: CHROME_MEDIA_SOURCE,
                      chromeMediaSourceId: browserCaptureSource.id,
                    },
                  },
                  video: browserScreenVideoConstraints,
                });
          } catch (audioError) {
            console.warn(
              "System audio capture failed, falling back to video-only:",
              audioError,
            );
            alert(
              "System audio is not available for this source. Recording will continue without system audio.",
            );
            screenMediaStream = useLinuxPortal
              ? await acquireLinuxPortalStream(false)
              : await mediaDevices.getUserMedia({
                  audio: false,
                  video: browserScreenVideoConstraints,
                });
          }
        } else {
          screenMediaStream = useLinuxPortal
            ? await acquireLinuxPortalStream(false)
            : await mediaDevices.getUserMedia({
                audio: false,
                video: browserScreenVideoConstraints,
              });
        }

        screenStream.current = screenMediaStream;
        stream.current = new MediaStream();

        videoTrack = screenMediaStream.getVideoTracks()[0];
        if (!videoTrack) {
          throw new Error("Video track is not available.");
        }

        stream.current.addTrack(videoTrack);

        if (microphoneEnabled) {
          try {
            microphoneStream.current =
              await navigator.mediaDevices.getUserMedia(
                createProcessedMicrophoneConstraints(
                  microphoneDeviceId,
                  browserMicrophoneProfile.current,
                ),
              );
          } catch (audioError) {
            console.warn("Failed to get microphone access:", audioError);
            alert(
              "Microphone access was denied. Recording will continue without microphone audio.",
            );
            setMicrophoneEnabled(false);
          }
        }

        const systemAudioTrack = screenMediaStream.getAudioTracks()[0];
        const micAudioTrack = microphoneStream.current?.getAudioTracks()[0];

        if (systemAudioTrack && micAudioTrack) {
          const context = new AudioContext({ sampleRate: 48000 });
          mixingContext.current = context;
          const systemSource = context.createMediaStreamSource(
            new MediaStream([systemAudioTrack]),
          );
          const micSource = context.createMediaStreamSource(
            new MediaStream([micAudioTrack]),
          );
          const micGain = context.createGain();
          micGain.gain.value = MIC_GAIN_BOOST;
          const destination = context.createMediaStreamDestination();

          systemSource.connect(destination);
          micSource.connect(micGain).connect(destination);

          const mixedTrack = destination.stream.getAudioTracks()[0];
          if (mixedTrack) {
            stream.current.addTrack(mixedTrack);
            systemAudioIncluded = true;
          }
        } else if (systemAudioTrack) {
          stream.current.addTrack(systemAudioTrack);
          systemAudioIncluded = true;
        } else if (micAudioTrack) {
          stream.current.addTrack(micAudioTrack);
        }
      } else {
        const mediaStream = useLinuxPortal
          ? await mediaDevices.getDisplayMedia({
              audio: false,
              video: {
                displaySurface: selectedSource.id?.startsWith("window:")
                  ? "window"
                  : "monitor",
                width: { ideal: TARGET_WIDTH, max: TARGET_WIDTH },
                height: { ideal: TARGET_HEIGHT, max: TARGET_HEIGHT },
                frameRate: { ideal: TARGET_FRAME_RATE, max: TARGET_FRAME_RATE },
                cursor: browserCursorPolicy.streamCursor,
              },
              selfBrowserSurface: "exclude",
              surfaceSwitching: "exclude",
            })
          : await mediaDevices.getUserMedia({
              audio: false,
              video: browserScreenVideoConstraints,
            });

        stream.current = mediaStream;
        videoTrack = mediaStream.getVideoTracks()[0];
      }

      if (!stream.current || !videoTrack) {
        throw new Error("Media stream is not available.");
      }

      try {
        await videoTrack.applyConstraints({
          frameRate: { ideal: TARGET_FRAME_RATE, max: TARGET_FRAME_RATE },
          width: { ideal: TARGET_WIDTH, max: TARGET_WIDTH },
          height: { ideal: TARGET_HEIGHT, max: TARGET_HEIGHT },
        } as MediaTrackConstraints);
      } catch (error) {
        console.warn(
          "Unable to lock 4K/60fps constraints, using best available track settings.",
          error,
        );
      }

      let {
        width = DEFAULT_WIDTH,
        height = DEFAULT_HEIGHT,
        frameRate = TARGET_FRAME_RATE,
      } = videoTrack.getSettings();

      width = Math.floor(width / CODEC_ALIGNMENT) * CODEC_ALIGNMENT;
      height = Math.floor(height / CODEC_ALIGNMENT) * CODEC_ALIGNMENT;

      const videoBitsPerSecond = computeBitrate(width, height);
      const mimeType = selectMimeType();

      console.log(
        `Recording at ${width}x${height} @ ${frameRate ?? TARGET_FRAME_RATE}fps using ${mimeType ?? "browser default"} / ${Math.round(
          videoBitsPerSecond / BITS_PER_MEGABIT,
        )} Mbps`,
      );

      chunks.current = [];
      const hasAudio = stream.current.getAudioTracks().length > 0;
      const audioBitsPerSecond = hasAudio
        ? systemAudioIncluded
          ? AUDIO_BITRATE_SYSTEM
          : AUDIO_BITRATE_VOICE
        : undefined;
      const recorder = new MediaRecorder(
        stream.current,
        createBrowserRecordingOptions({
          audioBitsPerSecond,
          mimeType,
          videoBitsPerSecond,
        }),
      );

      mediaRecorder.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) chunks.current.push(event.data);
      };
      recorder.onstop = async () => {
        cleanupCapturedMedia();
        if (chunks.current.length === 0) {
          setFinalizing(false);
          return;
        }

        const duration = getRecordingDurationMs(Date.now());
        const recordedChunks = chunks.current;
        const recordingBlobType = recorder.mimeType || mimeType;
        const buggyBlob = new Blob(
          recordedChunks,
          recordingBlobType ? { type: recordingBlobType } : undefined,
        );
        chunks.current = [];
        const timestamp = recordingSessionTimestamp.current ?? Date.now();
        const videoFileName = `${RECORDING_FILE_PREFIX}${timestamp}${getVideoExtensionForMimeType(recordingBlobType)}`;

        try {
          const videoBlob = isWebmMimeType(recordingBlobType)
            ? await fixWebmDuration(buggyBlob, duration)
            : buggyBlob;
          const arrayBuffer = await videoBlob.arrayBuffer();
          const videoResult = await window.electronAPI.storeRecordedVideo(
            arrayBuffer,
            videoFileName,
          );
          if (!videoResult.success) {
            console.error("Failed to store video:", videoResult.message);
            await notifyRecordingFinalizationFailure(
              videoResult.message || "Failed to store the recording.",
            );
            return;
          }

          if (videoResult.path) {
            const finalVideoPath = videoResult.path;
            // 1. Launch editor immediately (Optimistic UI)
            await finalizeRecordingSession(finalVideoPath, null);

            // 2. Background webcam processing
            void (async () => {
              const webcamPath = pendingWebcamPathPromise.current
                ? await pendingWebcamPathPromise.current
                : resolvedWebcamPath.current;

              try {
                if (webcamPath) {
                  await window.electronAPI.setCurrentRecordingSession({
                    videoPath: finalVideoPath,
                    webcamPath,
                    timeOffsetMs: webcamTimeOffsetMs.current,
                    hideOverlayCursorByDefault:
                      hideEditorOverlayCursorByDefault.current,
                  });
                }
              } finally {
                // After all background tasks are done (webcam),
                // we can safely close the HUD window to release hardware and resources.
                if (typeof window.electronAPI?.hudOverlayClose === "function") {
                  console.log(
                    "[useScreenRecorder:browser] All background tasks finished, closing HUD",
                  );
                  window.electronAPI.hudOverlayClose();
                }
              }
            })();
          } else {
            await notifyRecordingFinalizationFailure(
              "Failed to save the recording.",
            );
          }
        } catch (error) {
          console.error("Error saving recording:", error);
          const message =
            error instanceof Error ? error.message : String(error);
          await notifyRecordingFinalizationFailure(
            `Failed to finalize the recording. ${message}`,
          );
        }
      };
      recorder.onerror = () => {
        setRecording(false);
      };
      const mainStartedAt = Date.now();
      beginWebcamCapture();
      resetRecordingClock(mainStartedAt);
      webcamTimeOffsetMs.current =
        webcamStartTime.current === null
          ? 0
          : webcamStartTime.current - mainStartedAt;
      recorder.start(RECORDER_TIMESLICE_MS);
      setRecording(true);
      try {
        await window.electronAPI?.setRecordingState(true);
      } catch (stateError) {
        console.warn(
          "Failed to notify main process that recording started:",
          stateError,
        );
      }
    } catch (error) {
      console.error("Failed to start recording:", error);
      alert(getRecordingStartFailureAlertMessage(error));
      setRecording(false);
      try {
        await window.electronAPI?.setRecordingState(false);
      } catch (stateError) {
        console.warn(
          "Failed to reset main-process recording state:",
          stateError,
        );
      } finally {
        cleanupCapturedMedia();
        await stopWebcamRecorder();
      }
    } finally {
      setHudSourceSelectionActive(false);
      startInFlight.current = false;
      setStarting(false);
    }
  };

  const pauseRecording = useCallback(() => {
    if (!recording || paused) return;
    if (nativeScreenRecording.current) {
      void (async () => {
        const result = await window.electronAPI.pauseNativeScreenRecording();
        if (!result.success) {
          console.error(
            "Failed to pause native screen recording:",
            result.error ?? result.message,
          );
          return;
        }

        if (webcamRecorder.current?.state === "recording") {
          webcamRecorder.current.pause();
        }
        pauseMicFallbackRecorder();
        const boundaryMs = Date.now();
        markRecordingPaused(boundaryMs);
        setPaused(true);
        try {
          await window.electronAPI.pauseCursorCapture(boundaryMs);
        } catch (error) {
          console.warn("Failed to pause cursor capture:", error);
        }
      })();
      return;
    }
    if (mediaRecorder.current?.state === "recording") {
      mediaRecorder.current.pause();
      if (webcamRecorder.current?.state === "recording") {
        webcamRecorder.current.pause();
      }
      void (async () => {
        const boundaryMs = Date.now();
        markRecordingPaused(boundaryMs);
        setPaused(true);
        try {
          await window.electronAPI.pauseCursorCapture(boundaryMs);
        } catch (error) {
          console.warn("Failed to pause cursor capture:", error);
        }
      })();
    }
  }, [markRecordingPaused, pauseMicFallbackRecorder, paused, recording]);

  const resumeRecording = useCallback(() => {
    if (!recording || !paused) return;
    if (nativeScreenRecording.current) {
      void (async () => {
        const result = await window.electronAPI.resumeNativeScreenRecording();
        if (!result.success) {
          console.error(
            "Failed to resume native screen recording:",
            result.error ?? result.message,
          );
          return;
        }

        if (webcamRecorder.current?.state === "paused") {
          webcamRecorder.current.resume();
        }
        resumeMicFallbackRecorder();
        const boundaryMs = Date.now();
        markRecordingResumed(boundaryMs);
        setPaused(false);
        try {
          await window.electronAPI.resumeCursorCapture(boundaryMs);
        } catch (error) {
          console.warn("Failed to resume cursor capture:", error);
        }
      })();
      return;
    }
    if (mediaRecorder.current?.state === "paused") {
      mediaRecorder.current.resume();
      if (webcamRecorder.current?.state === "paused") {
        webcamRecorder.current.resume();
      }
      void (async () => {
        const boundaryMs = Date.now();
        markRecordingResumed(boundaryMs);
        setPaused(false);
        try {
          await window.electronAPI.resumeCursorCapture(boundaryMs);
        } catch (error) {
          console.warn("Failed to resume cursor capture:", error);
        }
      })();
    }
  }, [markRecordingResumed, paused, recording, resumeMicFallbackRecorder]);

  const cancelRecording = useCallback(() => {
    if (!recording) return;
    setPaused(false);
    markRecordingResumed(Date.now());

    // Discard webcam recording regardless of recording mode
    webcamChunks.current = [];
    if (webcamRecorder.current && webcamRecorder.current.state !== "inactive") {
      webcamRecorder.current.stop();
    }
    webcamRecorder.current = null;
    webcamStartTime.current = null;
    webcamTimeOffsetMs.current = 0;
    if (
      webcamSidecarStreamId.current &&
      typeof window.electronAPI?.abortWebcamSidecarRecording === "function"
    ) {
      void window.electronAPI.abortWebcamSidecarRecording(
        webcamSidecarStreamId.current,
        "recording-cancelled",
      );
    }
    webcamSidecarStreamId.current = null;
    webcamSidecarPath.current = null;
    releaseWebcamCapture();
    pendingWebcamPathPromise.current = null;
    resolvedWebcamPath.current = null;

    if (nativeScreenRecording.current) {
      nativeScreenRecording.current = false;
      nativeWindowsRecording.current = false;
      setRecording(false);
      window.electronAPI?.setRecordingState(false);
      void (async () => {
        try {
          const result = await window.electronAPI.stopNativeScreenRecording();
          if (result?.path) {
            await window.electronAPI.deleteRecordingFile(result.path);
          }
        } catch {
          // Best-effort cleanup
        }
      })();
      return;
    }

    if (mediaRecorder.current) {
      chunks.current = [];
      cleanupCapturedMedia();
      if (mediaRecorder.current.state !== "inactive") {
        mediaRecorder.current.stop();
      }
      setRecording(false);
      window.electronAPI?.setRecordingState(false);
    }
  }, [
    cleanupCapturedMedia,
    markRecordingResumed,
    recording,
    releaseWebcamCapture,
  ]);

  const toggleRecording = async () => {
    if (starting || countdownActive || finalizing) {
      return;
    }

    if (recording) {
      stopRecording.current();
      return;
    }

    // Start recording with optional countdown
    if (countdownDelay > 0) {
      setCountdownActive(true);
      try {
        const result = await window.electronAPI.startCountdown(countdownDelay);
        if (!result.success || result.cancelled) {
          return;
        }
      } finally {
        setCountdownActive(false);
      }
    }

    startRecording();
  };

  return {
    recording,
    paused,
    finalizing,
    countdownActive,
    toggleRecording,
    pauseRecording,
    resumeRecording,
    cancelRecording,
    preparePermissions,
    isMacOS,
    microphoneEnabled,
    setMicrophoneEnabled: persistMicrophoneEnabled,
    microphoneDeviceId,
    setMicrophoneDeviceId: persistMicrophoneDeviceId,
    systemAudioEnabled,
    setSystemAudioEnabled: persistSystemAudioEnabled,
    webcamEnabled,
    setWebcamEnabled,
    webcamDeviceId,
    setWebcamDeviceId,
    webcamFrameRate,
    setWebcamFrameRate: persistWebcamFrameRate,
    webcamQualityMode,
    setWebcamQualityMode: persistWebcamQualityMode,
    cameraFullActive,
    toggleCameraLayout,
    sceneStyleMode,
    applySceneStyleHotkey,
    countdownDelay,
    setCountdownDelay,
  };
}
