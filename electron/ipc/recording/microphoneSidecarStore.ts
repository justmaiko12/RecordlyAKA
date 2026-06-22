import type fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getFfmpegBinaryPath } from "../ffmpeg/binary";
import {
  getBrowserMicSidecarFilters,
  shouldKeepRecordingAudioSidecars,
} from "./audioFilters";
import {
  type MicrophoneChunkTimingEvent,
  type MicrophonePauseInterval,
  summarizeMicrophoneChunkTiming,
  writeRecordingDiagnosticsSnapshot,
} from "./diagnostics";
import { repairRecordingCompanionAudioSyncIfNeeded } from "./sourceAudioSync";

const execFileAsync = promisify(execFile);

export interface BrowserMicrophoneSidecarOptions {
  startDelayMs?: number;
  browserMicrophoneProfile?: string;
  requestedBrowserMicrophoneProfile?: string | null;
  requestedConstraints?: unknown;
  mediaTrackSettings?: Record<string, boolean | number | string>;
  audioInputDevices?: unknown;
  mediaRecorder?: unknown;
  chunkEvents?: unknown;
  pauseIntervals?: unknown;
}

export interface StoreBrowserMicrophoneSidecarParams {
  audioData: ArrayBuffer;
  videoPath: string;
  options?: BrowserMicrophoneSidecarOptions;
}

export interface StoreBrowserMicrophoneSidecarDeps {
  writeFile: typeof fs.writeFile;
  rm: typeof fs.rm;
  rename: typeof fs.rename;
  copyFile: typeof fs.copyFile;
  execFileAsync: typeof execFileAsync;
  getFfmpegBinaryPath: () => string;
  getBrowserMicSidecarFilters: typeof getBrowserMicSidecarFilters;
  shouldKeepRecordingAudioSidecars: typeof shouldKeepRecordingAudioSidecars;
  repairCompanionAudioSync: typeof repairRecordingCompanionAudioSyncIfNeeded;
  writeRecordingDiagnosticsSnapshot: typeof writeRecordingDiagnosticsSnapshot;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function pickPrimitiveRecord(value: unknown) {
  if (!isRecord(value)) {
    return null;
  }

  const entries = Object.entries(value).filter(
    (entry): entry is [string, boolean | number | string] => {
      const primitive = entry[1];
      return (
        typeof primitive === "boolean" ||
        typeof primitive === "number" ||
        typeof primitive === "string"
      );
    },
  );

  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

function pickMicrophoneChunkEvents(
  value: unknown,
): MicrophoneChunkTimingEvent[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const events = value
    .map((event) => {
      if (!isRecord(event)) {
        return null;
      }

      const {
        index,
        size,
        elapsedMs,
        deltaMs,
        recordedElapsedMs,
        recordedDeltaMs,
      } = event;
      if (
        typeof index !== "number" ||
        !Number.isFinite(index) ||
        index < 0 ||
        typeof size !== "number" ||
        !Number.isFinite(size) ||
        size < 0 ||
        typeof elapsedMs !== "number" ||
        !Number.isFinite(elapsedMs) ||
        elapsedMs < 0
      ) {
        return null;
      }

      return {
        index: Math.round(index),
        size: Math.round(size),
        elapsedMs: Math.round(elapsedMs),
        deltaMs:
          typeof deltaMs === "number" && Number.isFinite(deltaMs)
            ? Math.max(0, Math.round(deltaMs))
            : null,
        ...(typeof recordedElapsedMs === "number" &&
        Number.isFinite(recordedElapsedMs) &&
        recordedElapsedMs >= 0
          ? { recordedElapsedMs: Math.round(recordedElapsedMs) }
          : {}),
        recordedDeltaMs:
          typeof recordedDeltaMs === "number" &&
          Number.isFinite(recordedDeltaMs)
            ? Math.max(0, Math.round(recordedDeltaMs))
            : null,
      };
    })
    .filter((event): event is NonNullable<typeof event> => event !== null);

  return events.length > 0 ? events : null;
}

function pickMicrophonePauseIntervals(
  value: unknown,
): MicrophonePauseInterval[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const intervals = value
    .map((interval) => {
      if (
        !isRecord(interval) ||
        typeof interval.startElapsedMs !== "number" ||
        !Number.isFinite(interval.startElapsedMs) ||
        interval.startElapsedMs < 0
      ) {
        return null;
      }

      const startElapsedMs = Math.max(0, Math.round(interval.startElapsedMs));
      return {
        startElapsedMs,
        ...(typeof interval.endElapsedMs === "number" &&
        Number.isFinite(interval.endElapsedMs) &&
        interval.endElapsedMs >= startElapsedMs
          ? { endElapsedMs: Math.round(interval.endElapsedMs) }
          : {}),
        ...(typeof interval.durationMs === "number" &&
        Number.isFinite(interval.durationMs) &&
        interval.durationMs >= 0
          ? { durationMs: Math.round(interval.durationMs) }
          : {}),
      };
    })
    .filter(
      (interval): interval is NonNullable<typeof interval> => interval !== null,
    );

  return intervals.length > 0 ? intervals : null;
}

function pickAudioInputDevices(value: unknown) {
  if (!Array.isArray(value)) {
    return null;
  }

  const devices = value
    .map((device) => {
      if (!isRecord(device) || typeof device.deviceId !== "string") {
        return null;
      }

      return {
        deviceId: device.deviceId,
        ...(typeof device.groupId === "string"
          ? { groupId: device.groupId }
          : {}),
        label: typeof device.label === "string" ? device.label : "",
      };
    })
    .filter((device): device is NonNullable<typeof device> => device !== null);

  return devices.length > 0 ? devices : null;
}

export function resolveBrowserMicrophoneSidecarPaths(videoPath: string) {
  const baseName = videoPath.replace(/\.[^.]+$/, "");
  const sidecarPath = `${baseName}.mic.wav`;
  const sourceWebmPath = `${baseName}.mic.source.webm`;
  const tempWebmPath = `${sourceWebmPath}.tmp`;
  return { sidecarPath, sourceWebmPath, tempWebmPath };
}

function getBrowserMicrophoneStartDelayFilter(startDelayMs: unknown) {
  if (typeof startDelayMs !== "number" || !Number.isFinite(startDelayMs)) {
    return null;
  }

  const delayMs = Math.max(0, Math.round(startDelayMs));
  return delayMs > 0 ? `adelay=delays=${delayMs}:all=1` : null;
}

export async function storeBrowserMicrophoneSidecar(
  { audioData, videoPath, options }: StoreBrowserMicrophoneSidecarParams,
  deps?: Partial<StoreBrowserMicrophoneSidecarDeps>,
) {
  const fsPromises = await import("node:fs/promises");
  const activeDeps: StoreBrowserMicrophoneSidecarDeps = {
    writeFile: fsPromises.writeFile,
    rm: fsPromises.rm,
    rename: fsPromises.rename,
    copyFile: fsPromises.copyFile,
    execFileAsync,
    getFfmpegBinaryPath,
    getBrowserMicSidecarFilters,
    shouldKeepRecordingAudioSidecars,
    repairCompanionAudioSync: repairRecordingCompanionAudioSyncIfNeeded,
    writeRecordingDiagnosticsSnapshot,
    ...deps,
  };
  const { sidecarPath, sourceWebmPath, tempWebmPath } =
    resolveBrowserMicrophoneSidecarPaths(videoPath);

  try {
    await activeDeps.writeFile(tempWebmPath, Buffer.from(audioData));
    await activeDeps.execFileAsync(
      activeDeps.getFfmpegBinaryPath(),
      [
        "-y",
        "-hide_banner",
        "-nostdin",
        "-nostats",
        "-i",
        tempWebmPath,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "48000",
        "-af",
        [
          ...activeDeps.getBrowserMicSidecarFilters(
            options?.browserMicrophoneProfile,
          ),
          getBrowserMicrophoneStartDelayFilter(options?.startDelayMs),
          "aresample=async=1:first_pts=0",
        ]
          .filter((filter): filter is string => Boolean(filter))
          .join(","),
        "-c:a",
        "pcm_s16le",
        sidecarPath,
      ],
      { timeout: 120000, maxBuffer: 10 * 1024 * 1024 },
    );
    await activeDeps.repairCompanionAudioSync({
      videoPath,
      audioPath: sidecarPath,
      trackKind: "mic",
    });

    if (activeDeps.shouldKeepRecordingAudioSidecars()) {
      await activeDeps.rename(tempWebmPath, sourceWebmPath).catch(async () => {
        await activeDeps.copyFile(tempWebmPath, sourceWebmPath);
        await activeDeps.rm(tempWebmPath, { force: true });
      });
    } else {
      await activeDeps.rm(tempWebmPath, { force: true });
    }
    const startDelayMs = options?.startDelayMs;
    const mediaTrackSettings = pickPrimitiveRecord(options?.mediaTrackSettings);
    const audioInputDevices = pickAudioInputDevices(options?.audioInputDevices);
    const mediaRecorder = isRecord(options?.mediaRecorder)
      ? {
          ...(typeof options.mediaRecorder.mimeType === "string"
            ? { mimeType: options.mediaRecorder.mimeType }
            : {}),
          ...(typeof options.mediaRecorder.audioBitsPerSecond === "number"
            ? {
                audioBitsPerSecond: Math.round(
                  options.mediaRecorder.audioBitsPerSecond,
                ),
              }
            : {}),
          ...(typeof options.mediaRecorder.timesliceMs === "number"
            ? { timesliceMs: Math.round(options.mediaRecorder.timesliceMs) }
            : {}),
        }
      : null;
    const chunkEvents = pickMicrophoneChunkEvents(options?.chunkEvents);
    const pauseIntervals = pickMicrophonePauseIntervals(
      options?.pauseIntervals,
    );
    const chunkTiming =
      chunkEvents || pauseIntervals
        ? summarizeMicrophoneChunkTiming(
            chunkEvents,
            pauseIntervals,
            mediaRecorder?.timesliceMs,
          )
        : null;
    const metadata = {
      ...(Number.isFinite(startDelayMs) && (startDelayMs ?? 0) >= 0
        ? { startDelayMs: Math.round(startDelayMs ?? 0) }
        : {}),
      ...(typeof options?.browserMicrophoneProfile === "string"
        ? { browserMicrophoneProfile: options.browserMicrophoneProfile }
        : {}),
      ...(typeof options?.requestedBrowserMicrophoneProfile === "string"
        ? {
            requestedBrowserMicrophoneProfile:
              options.requestedBrowserMicrophoneProfile,
          }
        : {}),
      ...(isRecord(options?.requestedConstraints)
        ? { requestedConstraints: options.requestedConstraints }
        : {}),
      ...(mediaTrackSettings ? { mediaTrackSettings } : {}),
      ...(audioInputDevices ? { audioInputDevices } : {}),
      ...(mediaRecorder && Object.keys(mediaRecorder).length > 0
        ? { mediaRecorder }
        : {}),
      ...(chunkEvents ? { chunkEvents } : {}),
      ...(pauseIntervals ? { pauseIntervals } : {}),
      ...(chunkTiming ? { chunkTiming } : {}),
    };
    if (Object.keys(metadata).length > 0) {
      try {
        await activeDeps.writeFile(
          `${sidecarPath}.json`,
          JSON.stringify(metadata),
        );
      } catch (metadataError) {
        console.warn(
          "Failed to store microphone sidecar timing metadata:",
          metadataError,
        );
      }
    }
    await activeDeps
      .writeRecordingDiagnosticsSnapshot(videoPath, {
        backend: "browser-store",
        phase: "mic-sidecar",
        outputPath: videoPath,
        microphonePath: sidecarPath,
        details: {
          sourceBytes: audioData.byteLength,
          sourceWebmPath: activeDeps.shouldKeepRecordingAudioSidecars()
            ? sourceWebmPath
            : null,
          metadata,
        },
      })
      .catch((diagnosticsError) => {
        console.warn(
          "Failed to write microphone sidecar diagnostics:",
          diagnosticsError,
        );
      });
    return { success: true, path: sidecarPath };
  } catch (error) {
    await Promise.all([
      activeDeps.rm(tempWebmPath, { force: true }).catch(() => undefined),
      activeDeps.rm(sourceWebmPath, { force: true }).catch(() => undefined),
      activeDeps.rm(sidecarPath, { force: true }).catch(() => undefined),
    ]);
    console.error("Failed to store microphone sidecar:", error);
    return { success: false, error: String(error) };
  }
}
