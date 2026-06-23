#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

const MAX_NATIVE_WEBCAM_DURATION_DRIFT_SECONDS = 1;
const MIN_NATIVE_WEBCAM_DURATION_DRIFT_SECONDS = 0.75;
const NATIVE_WEBCAM_DURATION_DRIFT_RATIO = 0.001;
const MAX_ACCEPTED_PROOF_TAIL_DRIFT_SECONDS = 15;
const MAX_ACCEPTED_PROOF_TAIL_FRAME_DRIFT = 90;
const MAX_ACCEPTED_PROOF_HEAD_DRIFT_SECONDS = 15;
const MAX_ACCEPTED_PROOF_HEAD_FRAME_DRIFT = 90;
const MIN_ACCEPTED_PROOF_SAMPLE_COUNT = 3;
const MAX_SECONDS_PER_ACCEPTED_PROOF_SAMPLE = 3;
const RECORDING_SOURCE_AUDIO_SYNC_TOLERANCE_SECONDS = 0.05;
const RECORDING_SOURCE_AUDIO_MAX_TEMPO_DRIFT_SECONDS = 1.5;
const RECORDING_SOURCE_AUDIO_MAX_TEMPO_DRIFT_RATIO = 0.0015;

const FAILURE_EVENTS = new Set([
  "native-helper-exited-unexpectedly",
  "native-recording-degraded",
  "native-video-capture-stats-stale",
  "native-video-stream-stopped-with-error",
  "native-video-pipeline-stalled",
  "native-audio-capture-stats-stale",
  "native-audio-pipeline-stalled",
  "native-microphone-recording-finalized-unhealthy",
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
  "native-webcam-sidecar-rejected",
  "native-screen-recording-rejected",
  "native-screen-duration-short",
  "native-screen-duration-long",
  "native-screen-duration-validation-failed",
  "recording-run-audit-failed",
  "recording-companion-audio-sync-rejected",
  "recording-companion-audio-sync-repair-failed",
  "recording-companion-audio-missing",
  "recording-source-audio-sync-rejected",
  "recording-source-audio-sync-repair-failed",
  "webcam-sidecar-normalize-failed",
  "webcam-sidecar-video-store-failed",
  "webcam-sidecar-stream-start-failed",
]);

const WEBCAM_EVIDENCE_EVENTS = new Set([
  "native-webcam-capture-started",
  "native-webcam-first-frame-written",
  "native-webcam-first-visible-frame-written",
  "native-webcam-capture-stats",
  "native-webcam-capture-low-cadence",
  "native-webcam-preview-frame-written",
  "native-webcam-hold-frames-inserted",
  "native-webcam-proof-preview-accepted",
  "native-webcam-sidecar-accepted",
  "native-webcam-sidecar-rejected",
  "native-webcam-sidecar-missing",
  "native-webcam-recording-finalized",
]);

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function getNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getString(value) {
  return typeof value === "string" ? value : null;
}

function finitePositive(value) {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function roundSeconds(value) {
  return Math.round(value * 1000) / 1000;
}

function loadFfprobeStatic() {
  try {
    const moduleExports = require("ffprobe-static");
    if (typeof moduleExports === "string") {
      return moduleExports;
    }
    if (typeof moduleExports?.path === "string") {
      return moduleExports.path;
    }
    if (typeof moduleExports?.default === "string") {
      return moduleExports.default;
    }
    if (typeof moduleExports?.default?.path === "string") {
      return moduleExports.default.path;
    }
  } catch {
    // ffprobe-static is optional for this script; fall through to system ffprobe.
  }
  return null;
}

function resolveSystemFfprobeBinaryPath() {
  const locator = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(locator, ["ffprobe"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status === 0) {
    const candidate = result.stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    if (candidate) {
      return candidate;
    }
  }

  if (process.platform !== "win32") {
    for (const candidate of [
      "/opt/homebrew/bin/ffprobe",
      "/usr/local/bin/ffprobe",
      "/usr/bin/ffprobe",
    ]) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function getFfprobeBinaryPath() {
  if (process.platform === "darwin" && process.arch === "arm64") {
    const systemFfprobe = resolveSystemFfprobeBinaryPath();
    if (systemFfprobe) {
      return systemFfprobe;
    }
  }

  const ffprobeStatic = loadFfprobeStatic();
  if (ffprobeStatic && existsSync(ffprobeStatic)) {
    return ffprobeStatic;
  }

  const systemFfprobe = resolveSystemFfprobeBinaryPath();
  if (systemFfprobe) {
    return systemFfprobe;
  }

  throw new Error(
    "FFprobe binary is unavailable. Install ffprobe-static for this platform or make ffprobe available on PATH.",
  );
}

function getAllowedDurationDriftSeconds(durationSeconds) {
  return Math.min(
    MAX_NATIVE_WEBCAM_DURATION_DRIFT_SECONDS,
    Math.max(
      MIN_NATIVE_WEBCAM_DURATION_DRIFT_SECONDS,
      durationSeconds * NATIVE_WEBCAM_DURATION_DRIFT_RATIO,
    ),
  );
}

function getRecordingSourceAudioSyncPlan({
  videoDurationSeconds,
  audioDurationSeconds,
}) {
  if (videoDurationSeconds === null || audioDurationSeconds === null) {
    return {
      action: "none",
      reason:
        audioDurationSeconds === null ? "missing-audio" : "invalid-duration",
      videoDurationSeconds,
      audioDurationSeconds,
      driftSeconds: null,
      tempoRatio: 1,
    };
  }

  if (
    !Number.isFinite(videoDurationSeconds) ||
    !Number.isFinite(audioDurationSeconds) ||
    videoDurationSeconds <= 0 ||
    audioDurationSeconds <= 0
  ) {
    return {
      action: "none",
      reason: "invalid-duration",
      videoDurationSeconds,
      audioDurationSeconds,
      driftSeconds: null,
      tempoRatio: 1,
    };
  }

  const driftSeconds = roundSeconds(
    videoDurationSeconds - audioDurationSeconds,
  );
  if (Math.abs(driftSeconds) <= RECORDING_SOURCE_AUDIO_SYNC_TOLERANCE_SECONDS) {
    return {
      action: "none",
      reason: "within-tolerance",
      videoDurationSeconds,
      audioDurationSeconds,
      driftSeconds,
      tempoRatio: 1,
    };
  }

  if (driftSeconds < 0) {
    return {
      action: "repair",
      reason: "trim",
      videoDurationSeconds,
      audioDurationSeconds,
      driftSeconds,
      tempoRatio: 1,
    };
  }

  const durationDeltaMs = Math.round(
    (videoDurationSeconds - audioDurationSeconds) * 1000,
  );
  const relativeDrift = driftSeconds / videoDurationSeconds;
  if (
    driftSeconds > RECORDING_SOURCE_AUDIO_MAX_TEMPO_DRIFT_SECONDS &&
    relativeDrift > RECORDING_SOURCE_AUDIO_MAX_TEMPO_DRIFT_RATIO
  ) {
    return {
      action: "reject",
      reason: "unsafe-short-audio-mismatch",
      videoDurationSeconds,
      audioDurationSeconds,
      driftSeconds,
      tempoRatio: 1,
    };
  }

  const relativeDelta =
    Math.abs(durationDeltaMs) / Math.max(videoDurationSeconds * 1000, 1);
  if (relativeDelta <= 0.03 || Math.abs(durationDeltaMs) <= 1500) {
    return {
      action: "repair",
      reason: "tempo",
      videoDurationSeconds,
      audioDurationSeconds,
      driftSeconds,
      tempoRatio: Number(
        (audioDurationSeconds / videoDurationSeconds).toFixed(6),
      ),
    };
  }

  return {
    action: "reject",
    reason: "unsafe-short-audio-mismatch",
    videoDurationSeconds,
    audioDurationSeconds,
    driftSeconds,
    tempoRatio: 1,
  };
}

function parseRecordingSourceAudioVideoDurations(ffprobeJson) {
  let parsed;
  try {
    parsed = JSON.parse(ffprobeJson);
  } catch {
    return { videoDurationSeconds: null, audioDurationSeconds: null };
  }

  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const videoStream = streams.find((stream) => stream.codec_type === "video");
  const audioStream = streams.find((stream) => stream.codec_type === "audio");
  return {
    videoDurationSeconds:
      finitePositive(videoStream?.duration) ??
      finitePositive(parsed.format?.duration),
    audioDurationSeconds: finitePositive(audioStream?.duration),
  };
}

function probeRecordingSourceAudioVideoDurations(videoPath) {
  const result = spawnSync(
    getFfprobeBinaryPath(),
    [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      videoPath,
    ],
    { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || `ffprobe failed for ${videoPath}`);
  }
  return parseRecordingSourceAudioVideoDurations(result.stdout);
}

function probeRecordingAudioDurationSeconds(audioPath) {
  const result = spawnSync(
    getFfprobeBinaryPath(),
    [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      audioPath,
    ],
    { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || `ffprobe failed for ${audioPath}`);
  }
  return parseRecordingSourceAudioVideoDurations(result.stdout)
    .audioDurationSeconds;
}

function summarizeSourceMediaDurations(durations, preferredAudio) {
  const plan = getRecordingSourceAudioSyncPlan(durations);
  return {
    videoDurationSeconds: plan.videoDurationSeconds,
    audioDurationSeconds: plan.audioDurationSeconds,
    driftSeconds: plan.driftSeconds,
    planAction: plan.action,
    planReason: plan.reason,
    tempoRatio: plan.tempoRatio,
    toleranceSeconds: RECORDING_SOURCE_AUDIO_SYNC_TOLERANCE_SECONDS,
    preferredAudioSource: preferredAudio.source,
    preferredAudioPaths: preferredAudio.paths,
  };
}

function summarizeCompanionAudioDurations({
  audioPath,
  videoDurationSeconds,
  audioDurationSeconds,
}) {
  const plan = getRecordingSourceAudioSyncPlan({
    videoDurationSeconds,
    audioDurationSeconds,
  });
  return {
    audioPath,
    trackKind: "mic",
    videoDurationSeconds: plan.videoDurationSeconds,
    audioDurationSeconds: plan.audioDurationSeconds,
    driftSeconds: plan.driftSeconds,
    planAction: plan.action,
    planReason: plan.reason,
    tempoRatio: plan.tempoRatio,
    toleranceSeconds: RECORDING_SOURCE_AUDIO_SYNC_TOLERANCE_SECONDS,
  };
}

async function getPreferredSourceAudioForAudit(videoPath) {
  const basePath = videoPath.replace(/\.[^.]+$/u, "");
  const candidatePaths = [
    `${basePath}.mic.m4a`,
    `${basePath}.mic.webm`,
    `${basePath}.mic.wav`,
  ];
  const micCompanionPaths = [];

  for (const candidatePath of candidatePaths) {
    try {
      const stat = await fs.stat(candidatePath);
      if (stat.size > 0) {
        micCompanionPaths.push(candidatePath);
      }
    } catch {
      // Missing companion audio is expected for screen-only or system-audio-only recordings.
    }
  }

  if (micCompanionPaths.length > 0) {
    return {
      source: "mic-companion",
      paths: micCompanionPaths,
    };
  }

  return {
    source: "embedded",
    paths: [videoPath],
  };
}

function getArtifactsForInput(inputPath) {
  const absoluteInput = path.resolve(inputPath);
  const ext = path.extname(absoluteInput).toLowerCase();
  if (ext === ".jsonl") {
    const eventLogPath = absoluteInput;
    const videoPath = absoluteInput.replace(
      /\.recordly-events\.jsonl$/u,
      ".mp4",
    );
    return {
      inputPath: absoluteInput,
      videoPath,
      eventLogPath,
      diagnosticsPath: videoPath.replace(
        /\.[^.]+$/u,
        ".recording-diagnostics.json",
      ),
    };
  }

  return {
    inputPath: absoluteInput,
    videoPath: absoluteInput,
    eventLogPath: absoluteInput.replace(/\.[^.]+$/u, ".recordly-events.jsonl"),
    diagnosticsPath: absoluteInput.replace(
      /\.[^.]+$/u,
      ".recording-diagnostics.json",
    ),
  };
}

async function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function readEventLog(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  const entries = [];
  const parseErrors = [];
  for (const [index, line] of raw.split(/\r?\n/u).entries()) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (isRecord(parsed) && typeof parsed.event === "string") {
        entries.push(parsed);
      }
    } catch (error) {
      parseErrors.push({
        line: index + 1,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { entries, parseErrors };
}

function getDetails(entry) {
  return isRecord(entry.details) ? entry.details : {};
}

function findLast(entries, eventName) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.event === eventName) {
      return entries[index];
    }
  }
  return null;
}

function findFirst(entries, eventName) {
  return entries.find((entry) => entry.event === eventName) ?? null;
}

function countByEvent(entries) {
  const counts = {};
  for (const entry of entries) {
    counts[entry.event] = (counts[entry.event] ?? 0) + 1;
  }
  return counts;
}

function getFinalizationSummary(entry) {
  if (!entry) {
    return null;
  }
  const details = getDetails(entry);
  return {
    writerStatus: getString(details.writerStatus),
    frames: getNumber(details.frames),
    realFrames: getNumber(details.realFrames),
    holdFrames: getNumber(details.holdFrames),
    duration: getNumber(details.duration),
    lastPts: getNumber(details.lastPts),
    path: getString(details.path),
  };
}

function getProofSummary(entries) {
  const proofEntries = entries.filter(
    (entry) => entry.event === "native-webcam-proof-preview-accepted",
  );
  const rejectedEntries = entries.filter(
    (entry) => entry.event === "native-webcam-preview-frame-rejected",
  );
  let monotonic = true;
  let previous = null;
  for (const entry of proofEntries) {
    const details = getDetails(entry);
    const current = {
      sequence: getNumber(details.sequence),
      acceptedFrame: getNumber(details.acceptedFrame),
      acceptedPts: getNumber(details.acceptedPts),
      timestamp: typeof entry.timestamp === "string" ? entry.timestamp : null,
    };
    if (
      previous &&
      current.sequence !== null &&
      previous.sequence !== null &&
      current.sequence <= previous.sequence
    ) {
      monotonic = false;
    }
    if (
      previous &&
      current.acceptedFrame !== null &&
      previous.acceptedFrame !== null &&
      current.acceptedFrame <= previous.acceptedFrame
    ) {
      monotonic = false;
    }
    if (
      previous &&
      current.acceptedPts !== null &&
      previous.acceptedPts !== null &&
      current.acceptedPts < previous.acceptedPts
    ) {
      monotonic = false;
    }
    previous = current;
  }

  return {
    count: proofEntries.length,
    rejectedCount: rejectedEntries.length,
    monotonic,
    first: proofEntries[0] ? getDetails(proofEntries[0]) : null,
    last: proofEntries.at(-1) ? getDetails(proofEntries.at(-1)) : null,
  };
}

function getContinuityRepairSummary(entries, eventName) {
  const issueEntries = entries.filter((entry) => entry.event === eventName);
  let totalFrames = 0;
  let totalBuffers = 0;
  let totalDurationSeconds = 0;

  for (const entry of issueEntries) {
    const details = getDetails(entry);
    totalFrames += getNumber(details.frames) ?? 0;
    totalBuffers += getNumber(details.buffers) ?? 0;
    totalDurationSeconds += getNumber(details.duration) ?? 0;
  }

  return {
    count: issueEntries.length,
    ...(totalFrames > 0 ? { totalFrames } : {}),
    ...(totalBuffers > 0 ? { totalBuffers } : {}),
    totalDurationSeconds: Math.round(totalDurationSeconds * 1000) / 1000,
    first: issueEntries[0] ? getDetails(issueEntries[0]) : null,
    last: issueEntries.at(-1) ? getDetails(issueEntries.at(-1)) : null,
  };
}

function pushIssue(issues, code, message, details = {}) {
  issues.push({ code, message, details });
}

function getMinimumAcceptedProofCount(durationSeconds) {
  return Math.max(
    MIN_ACCEPTED_PROOF_SAMPLE_COUNT,
    Math.floor(durationSeconds / MAX_SECONDS_PER_ACCEPTED_PROOF_SAMPLE),
  );
}

export async function auditRecordingRun(inputPath, options = {}) {
  const artifacts = getArtifactsForInput(inputPath);
  const issues = [];
  const warnings = [];
  let eventLog;
  try {
    eventLog = await readEventLog(artifacts.eventLogPath);
  } catch (error) {
    return {
      status: "fail",
      paths: artifacts,
      issues: [
        {
          code: "missing-event-log",
          message: `Recording event log is missing or unreadable: ${artifacts.eventLogPath}`,
          details: {
            error: error instanceof Error ? error.message : String(error),
          },
        },
      ],
      warnings: [],
      summary: {},
    };
  }

  const diagnostics = await readJsonIfPresent(artifacts.diagnosticsPath);
  const entries = eventLog.entries;
  const eventCounts = countByEvent(entries);
  const sawWebcamEvidence = entries.some((entry) =>
    WEBCAM_EVIDENCE_EVENTS.has(entry.event),
  );
  const proof = getProofSummary(entries);
  const audioContinuityRepairs = getContinuityRepairSummary(
    entries,
    "native-audio-silence-inserted",
  );
  const webcamContinuityRepairs = getContinuityRepairSummary(
    entries,
    "native-webcam-hold-frames-inserted",
  );
  const screenFinalization = getFinalizationSummary(
    findLast(entries, "native-video-recording-finalized"),
  );
  const webcamFinalization = getFinalizationSummary(
    findLast(entries, "native-webcam-recording-finalized"),
  );
  const nativeMicrophoneDevice =
    findLast(entries, "native-microphone-device-resolved") ??
    findLast(entries, "native-microphone-device-default");
  const nativeMicrophoneFirstBuffer = findFirst(
    entries,
    "native-microphone-audio-first-buffer-written",
  );
  const nativeMicrophoneUnavailable = findFirst(
    entries,
    "native-microphone-capture-unavailable",
  );
  const nativeMicrophoneRequested = nativeMicrophoneDevice !== null;
  let sourceMediaDurations = null;
  const companionAudioDurations = [];

  try {
    const preferredAudio = await getPreferredSourceAudioForAudit(
      artifacts.videoPath,
    );
    const probeSourceMediaDurations =
      options.probeSourceMediaDurations ??
      probeRecordingSourceAudioVideoDurations;
    const probedDurations = await probeSourceMediaDurations(
      artifacts.videoPath,
    );
    if (probedDurations) {
      sourceMediaDurations = summarizeSourceMediaDurations(
        probedDurations,
        preferredAudio,
      );
      if (
        preferredAudio.source === "embedded" &&
        (sourceMediaDurations.planAction === "repair" ||
          sourceMediaDurations.planAction === "reject")
      ) {
        pushIssue(
          issues,
          "source-media-audio-duration-drift",
          "Finalized source media still has embedded audio/video duration drift after recording finalization.",
          sourceMediaDurations,
        );
      } else if (
        sourceMediaDurations.planReason === "invalid-duration" &&
        (preferredAudio.source === "embedded" ||
          sourceMediaDurations.videoDurationSeconds === null ||
          !Number.isFinite(sourceMediaDurations.videoDurationSeconds) ||
          sourceMediaDurations.videoDurationSeconds <= 0)
      ) {
        pushIssue(
          issues,
          "source-media-duration-invalid",
          "Finalized source media has invalid video or audio duration metadata.",
          sourceMediaDurations,
        );
      }

      if (preferredAudio.source === "mic-companion") {
        const probeCompanionAudioDurationSeconds =
          options.probeCompanionAudioDurationSeconds ??
          probeRecordingAudioDurationSeconds;
        for (const audioPath of preferredAudio.paths) {
          try {
            const companionSummary = summarizeCompanionAudioDurations({
              audioPath,
              videoDurationSeconds: sourceMediaDurations.videoDurationSeconds,
              audioDurationSeconds:
                await probeCompanionAudioDurationSeconds(audioPath),
            });
            companionAudioDurations.push(companionSummary);
            if (
              companionSummary.planReason === "missing-audio" ||
              companionSummary.planReason === "invalid-duration"
            ) {
              pushIssue(
                issues,
                "companion-mic-audio-duration-invalid",
                "Preferred companion mic audio is missing or has invalid duration.",
                companionSummary,
              );
            } else if (companionSummary.planAction !== "none") {
              pushIssue(
                issues,
                "companion-mic-audio-duration-drift",
                "Preferred companion mic audio still has duration drift after recording finalization.",
                companionSummary,
              );
            }
          } catch (error) {
            pushIssue(
              issues,
              "companion-mic-audio-duration-probe-failed",
              "Failed to probe preferred companion mic audio duration.",
              {
                audioPath,
                error: error instanceof Error ? error.message : String(error),
              },
            );
          }
        }
      }
    }
  } catch (error) {
    pushIssue(
      issues,
      "source-media-duration-probe-failed",
      "Failed to probe finalized source media duration.",
      {
        videoPath: artifacts.videoPath,
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }

  for (const parseError of eventLog.parseErrors) {
    pushIssue(
      issues,
      "event-log-parse-error",
      "Event log contains an invalid JSON line.",
      parseError,
    );
  }

  for (const entry of entries) {
    if (!FAILURE_EVENTS.has(entry.event)) {
      continue;
    }
    const details = getDetails(entry);
    if (
      entry.event === "native-recording-degraded" &&
      details.severity &&
      details.severity !== "error"
    ) {
      continue;
    }
    if (
      entry.event === "native-webcam-preview-frame-rejected" &&
      details.failClosed !== true
    ) {
      continue;
    }
    pushIssue(
      issues,
      entry.event,
      `Failure event recorded: ${entry.event}`,
      details,
    );
  }

  if (
    nativeMicrophoneRequested &&
    !nativeMicrophoneFirstBuffer &&
    !nativeMicrophoneUnavailable
  ) {
    pushIssue(
      issues,
      "native-microphone-audio-missing-first-buffer",
      "Native microphone capture was selected, but no first microphone audio buffer was recorded.",
      {
        deviceEvent: getDetails(nativeMicrophoneDevice),
      },
    );
  }

  if (audioContinuityRepairs.count > 0) {
    pushIssue(
      warnings,
      "native-audio-continuity-repaired",
      "The native recorder inserted silence to keep audio sample time continuous after device callback gaps.",
      audioContinuityRepairs,
    );
  }

  if (webcamContinuityRepairs.count > 0) {
    pushIssue(
      warnings,
      "native-webcam-continuity-held-frames",
      "The native recorder held the last good webcam frame to keep the camera track continuous after device callback gaps.",
      webcamContinuityRepairs,
    );
  }

  if (!screenFinalization) {
    pushIssue(
      issues,
      "missing-screen-finalization",
      "Native screen writer finalization was not recorded.",
    );
  } else if (screenFinalization.writerStatus !== "completed") {
    pushIssue(
      issues,
      "screen-writer-not-completed",
      "Native screen writer did not finalize as completed.",
      screenFinalization,
    );
  }

  if (sawWebcamEvidence) {
    if (proof.count === 0) {
      pushIssue(
        issues,
        "missing-accepted-proof-preview",
        "Webcam was active, but no accepted proof-preview samples were recorded.",
      );
    }
    if (!proof.monotonic) {
      pushIssue(
        issues,
        "non-monotonic-accepted-proof-preview",
        "Accepted proof-preview samples were not monotonic.",
        proof,
      );
    }
    if (!webcamFinalization) {
      pushIssue(
        issues,
        "missing-webcam-finalization",
        "Webcam was active, but native webcam writer finalization was not recorded.",
      );
    } else if (webcamFinalization.writerStatus !== "completed") {
      pushIssue(
        issues,
        "webcam-writer-not-completed",
        "Native webcam writer did not finalize as completed.",
        webcamFinalization,
      );
    }

    const screenDuration = screenFinalization?.duration;
    const webcamDuration = webcamFinalization?.duration;
    const proofCoverageDuration = webcamDuration ?? screenDuration;
    if (
      typeof proofCoverageDuration === "number" &&
      Number.isFinite(proofCoverageDuration) &&
      proofCoverageDuration > 0
    ) {
      const minimumProofCount = getMinimumAcceptedProofCount(
        proofCoverageDuration,
      );
      if (proof.count < minimumProofCount) {
        pushIssue(
          issues,
          "accepted-proof-preview-too-sparse",
          "Accepted proof-preview samples were too sparse for the recording duration.",
          {
            proofCount: proof.count,
            minimumProofCount,
            proofCoverageDuration,
            maxSecondsPerProofSample: MAX_SECONDS_PER_ACCEPTED_PROOF_SAMPLE,
          },
        );
      }
    }
    if (
      screenDuration !== null &&
      webcamDuration !== null &&
      screenDuration &&
      webcamDuration
    ) {
      const driftSeconds = Math.abs(screenDuration - webcamDuration);
      const allowedDriftSeconds =
        getAllowedDurationDriftSeconds(screenDuration);
      if (driftSeconds > allowedDriftSeconds) {
        pushIssue(
          issues,
          "screen-webcam-duration-drift",
          "Screen and webcam writer durations drifted beyond the native acceptance window.",
          { screenDuration, webcamDuration, driftSeconds, allowedDriftSeconds },
        );
      }

      const lastAcceptedPts = getNumber(proof.last?.acceptedPts);
      if (lastAcceptedPts !== null) {
        const proofTailDriftSeconds = webcamDuration - lastAcceptedPts;
        if (proofTailDriftSeconds > MAX_ACCEPTED_PROOF_TAIL_DRIFT_SECONDS) {
          pushIssue(
            issues,
            "accepted-proof-ended-too-early",
            "Accepted proof-preview samples ended too far before webcam writer finalization.",
            { webcamDuration, lastAcceptedPts, proofTailDriftSeconds },
          );
        }
      }
    }

    const firstAcceptedPts = getNumber(proof.first?.acceptedPts);
    if (
      firstAcceptedPts !== null &&
      firstAcceptedPts > MAX_ACCEPTED_PROOF_HEAD_DRIFT_SECONDS
    ) {
      pushIssue(
        issues,
        "accepted-proof-started-too-late",
        "Accepted proof-preview samples started too far after webcam recording began.",
        {
          firstAcceptedPts,
          allowedHeadDriftSeconds: MAX_ACCEPTED_PROOF_HEAD_DRIFT_SECONDS,
        },
      );
    }

    const firstAcceptedFrame = getNumber(proof.first?.acceptedFrame);
    if (
      firstAcceptedFrame !== null &&
      firstAcceptedFrame > MAX_ACCEPTED_PROOF_HEAD_FRAME_DRIFT
    ) {
      pushIssue(
        issues,
        "accepted-proof-frame-started-too-late",
        "Accepted proof-preview frame count started too far after webcam recording began.",
        {
          firstAcceptedFrame,
          allowedHeadFrameDrift: MAX_ACCEPTED_PROOF_HEAD_FRAME_DRIFT,
        },
      );
    }

    const webcamFrames = webcamFinalization?.frames;
    const lastAcceptedFrame = getNumber(proof.last?.acceptedFrame);
    if (typeof webcamFrames === "number" && lastAcceptedFrame !== null) {
      const proofTailFrameDrift = webcamFrames - lastAcceptedFrame;
      if (proofTailFrameDrift > MAX_ACCEPTED_PROOF_TAIL_FRAME_DRIFT) {
        pushIssue(
          issues,
          "accepted-proof-frame-ended-too-early",
          "Accepted proof-preview frame count ended too far before webcam writer finalization.",
          {
            webcamFrames,
            lastAcceptedFrame,
            proofTailFrameDrift,
            allowedFrameDrift: MAX_ACCEPTED_PROOF_TAIL_FRAME_DRIFT,
          },
        );
      }
    }

    if (!findLast(entries, "native-webcam-sidecar-accepted")) {
      pushIssue(
        issues,
        "missing-webcam-sidecar-accepted",
        "Native webcam sidecar acceptance was not recorded.",
      );
    }
  }

  if (!findLast(entries, "native-screen-recording-accepted")) {
    pushIssue(
      issues,
      "missing-screen-accepted-event",
      "Native screen acceptance event was not found in the event log.",
    );
  }

  const summary = {
    eventCount: entries.length,
    eventCounts,
    sawWebcamEvidence,
    sourceMediaDurations,
    companionAudioDurations,
    nativeMicrophone: {
      requested: nativeMicrophoneRequested,
      firstBufferWritten: nativeMicrophoneFirstBuffer !== null,
      unavailable: nativeMicrophoneUnavailable !== null,
      deviceEvent: nativeMicrophoneDevice
        ? getDetails(nativeMicrophoneDevice)
        : null,
      firstBuffer: nativeMicrophoneFirstBuffer
        ? getDetails(nativeMicrophoneFirstBuffer)
        : null,
    },
    proof,
    audioContinuityRepairs,
    webcamContinuityRepairs,
    screenFinalization,
    webcamFinalization,
    diagnosticsLatestPhase: isRecord(diagnostics?.latest)
      ? (diagnostics.latest.phase ?? null)
      : null,
    diagnosticsExpectedDurationMs: isRecord(diagnostics?.latest)
      ? (diagnostics.latest.expectedDurationMs ?? null)
      : null,
  };

  return {
    status:
      issues.length > 0 ? "fail" : warnings.length > 0 ? "warning" : "pass",
    paths: artifacts,
    issues,
    warnings,
    summary,
  };
}

function formatHuman(result) {
  const lines = [];
  lines.push(`Recordly recording audit: ${result.status.toUpperCase()}`);
  lines.push(`Event log: ${result.paths.eventLogPath}`);
  lines.push(`Diagnostics: ${result.paths.diagnosticsPath}`);
  lines.push(`Events: ${result.summary.eventCount ?? 0}`);
  if (result.summary.screenFinalization) {
    lines.push(
      `Screen writer: ${result.summary.screenFinalization.writerStatus ?? "unknown"} duration=${result.summary.screenFinalization.duration ?? "unknown"}s frames=${result.summary.screenFinalization.frames ?? "unknown"}`,
    );
  }
  if (result.summary.webcamFinalization) {
    lines.push(
      `Webcam writer: ${result.summary.webcamFinalization.writerStatus ?? "unknown"} duration=${result.summary.webcamFinalization.duration ?? "unknown"}s frames=${result.summary.webcamFinalization.frames ?? "unknown"}`,
    );
  }
  if (result.summary.sourceMediaDurations) {
    const source = result.summary.sourceMediaDurations;
    lines.push(
      `Source audio: preferred=${source.preferredAudioSource ?? "unknown"} video=${source.videoDurationSeconds ?? "unknown"}s audio=${source.audioDurationSeconds ?? "unknown"}s drift=${source.driftSeconds ?? "unknown"}s plan=${source.planAction}/${source.planReason}`,
    );
  }
  for (const companion of result.summary.companionAudioDurations ?? []) {
    lines.push(
      `Companion ${companion.trackKind} audio: ${companion.audioPath} audio=${companion.audioDurationSeconds ?? "unknown"}s drift=${companion.driftSeconds ?? "unknown"}s plan=${companion.planAction}/${companion.planReason}`,
    );
  }
  if (result.summary.proof) {
    lines.push(
      `Accepted proof samples: ${result.summary.proof.count} rejected=${result.summary.proof.rejectedCount} monotonic=${result.summary.proof.monotonic}`,
    );
  }
  if ((result.summary.audioContinuityRepairs?.count ?? 0) > 0) {
    lines.push(
      `Audio continuity repairs: events=${result.summary.audioContinuityRepairs.count} duration=${result.summary.audioContinuityRepairs.totalDurationSeconds}s`,
    );
  }
  if ((result.summary.webcamContinuityRepairs?.count ?? 0) > 0) {
    lines.push(
      `Webcam continuity repairs: events=${result.summary.webcamContinuityRepairs.count} heldFrames=${result.summary.webcamContinuityRepairs.totalFrames ?? 0} duration=${result.summary.webcamContinuityRepairs.totalDurationSeconds}s`,
    );
  }
  for (const issue of result.issues) {
    lines.push(`FAIL ${issue.code}: ${issue.message}`);
  }
  for (const warning of result.warnings) {
    lines.push(`WARN ${warning.code}: ${warning.message}`);
  }
  return lines.join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const inputPath = args.find((arg) => arg !== "--json");
  if (!inputPath) {
    console.error(
      "Usage: node scripts/audit-recording-run.mjs [--json] <recording.mp4|recording.recordly-events.jsonl>",
    );
    process.exit(2);
  }

  const result = await auditRecordingRun(inputPath);
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatHuman(result));
  }
  process.exit(result.status === "fail" ? 1 : 0);
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  main().catch((error) => {
    console.error(error);
    process.exit(2);
  });
}
