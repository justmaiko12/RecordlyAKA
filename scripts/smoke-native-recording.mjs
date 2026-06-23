#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const ffprobeStatic = require("ffprobe-static");
const ffmpegStatic = require("ffmpeg-static");

const projectRoot = process.cwd();
const defaultDurationSeconds = 45;
const startupTimeoutMs = 20_000;
const shutdownGraceMs = 30_000;
const minAcceptableWebcamFps = 10;
const maxNativeWebcamDurationDriftSeconds = 1;
const minNativeWebcamDurationDriftSeconds = 0.75;
const nativeWebcamDurationDriftRatio = 0.001;
const fatalMarkers = [
  "VIDEO_PIPELINE_STALLED",
  "VIDEO_PIXEL_BUFFER_APPEND_FAILED",
  "WEBCAM_PIPELINE_STALLED",
  "WEBCAM_PIXEL_BUFFER_APPEND_FAILED",
  "WEBCAM_CAPTURE_DISABLED",
  "WEBCAM_DEVICE_NOT_FOUND",
  "WEBCAM_VISUAL_STALL_SUSPECTED",
  "AUDIO_PIPELINE_STALLED",
  "FINAL_VIDEO_KEEPALIVE_APPENDED",
];

function fail(message, details = {}) {
  const error = new Error(message);
  const { nativeOutput, ...publicDetails } = details;
  error.details = publicDetails;
  error.nativeOutput = nativeOutput;
  throw error;
}

function usage() {
  return [
    "Usage: node scripts/smoke-native-recording.mjs [options]",
    "",
    "Options:",
    "  --duration <seconds>       Recording duration after native proof-start (default: 45)",
    "  --webcam-label <label>     Require a specific webcam label",
    "  --webcam-device-id <id>    Require a specific webcam unique ID",
    "  --microphone               Capture microphone audio into a native sidecar",
    "  --finalize-microphone-audio Repair and validate microphone sidecar duration",
    "  --microphone-label <label> Require a specific microphone label",
    "  --microphone-device-id <id> Require a specific microphone unique ID",
    "  --screen-only              Do not capture webcam",
    "  --width <px>               Webcam output width (default: 1280)",
    "  --height <px>              Webcam output height (default: 720)",
    "  --fps <fps>                Screen FPS (default: 30)",
    "  --webcam-fps <fps>         Webcam FPS (default: 30)",
    "  --helper <path>            Native helper path",
    "  --output-dir <path>        Directory for smoke artifacts",
    "  --keep                     Keep artifacts after a passing smoke",
    "  --json                     Print a machine-readable summary",
    "  --verbose                  Stream native helper output while running",
  ].join("\n");
}

function parsePositiveNumber(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    fail(`Invalid ${label}: ${value}`);
  }
  return parsed;
}

export function parseArgs(argv) {
  const options = {
    durationSeconds: defaultDurationSeconds,
    capturesWebcam: true,
    capturesMicrophone: false,
    finalizeMicrophoneAudio: false,
    webcamWidth: 1280,
    webcamHeight: 720,
    fps: 30,
    webcamFps: 30,
    webcamLabel: null,
    webcamDeviceId: null,
    microphoneLabel: null,
    microphoneDeviceId: null,
    helperPath: null,
    outputDir: null,
    keep: false,
    json: false,
    verbose: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) {
        fail(`Missing value for ${arg}`);
      }
      return argv[index];
    };

    switch (arg) {
      case "--duration":
        options.durationSeconds = parsePositiveNumber(next(), "duration");
        break;
      case "--webcam-label":
        options.webcamLabel = next();
        break;
      case "--webcam-device-id":
        options.webcamDeviceId = next();
        break;
      case "--microphone":
        options.capturesMicrophone = true;
        break;
      case "--finalize-microphone-audio":
        options.capturesMicrophone = true;
        options.finalizeMicrophoneAudio = true;
        break;
      case "--microphone-label":
        options.microphoneLabel = next();
        break;
      case "--microphone-device-id":
        options.microphoneDeviceId = next();
        break;
      case "--screen-only":
        options.capturesWebcam = false;
        break;
      case "--width":
        options.webcamWidth = Math.round(parsePositiveNumber(next(), "width"));
        break;
      case "--height":
        options.webcamHeight = Math.round(
          parsePositiveNumber(next(), "height"),
        );
        break;
      case "--fps":
        options.fps = Math.round(parsePositiveNumber(next(), "fps"));
        break;
      case "--webcam-fps":
        options.webcamFps = Math.round(
          parsePositiveNumber(next(), "webcam-fps"),
        );
        break;
      case "--helper":
        options.helperPath = path.resolve(next());
        break;
      case "--output-dir":
        options.outputDir = path.resolve(next());
        break;
      case "--keep":
        options.keep = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--verbose":
        options.verbose = true;
        break;
      case "--help":
      case "-h":
        console.log(usage());
        process.exit(0);
        break;
      default:
        fail(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function nativeArchTag() {
  if (process.platform === "darwin") {
    return process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  }
  return `${process.platform}-${process.arch}`;
}

function defaultHelperPath() {
  return path.join(
    projectRoot,
    "electron",
    "native",
    "bin",
    nativeArchTag(),
    "recordly-screencapturekit-helper",
  );
}

export function buildSmokePaths(outputDir) {
  return {
    outputDir,
    screen: path.join(outputDir, "screen.mp4"),
    webcam: path.join(outputDir, "webcam.mp4"),
    preview: path.join(outputDir, "webcam-preview.jpg"),
    microphone: path.join(outputDir, "microphone.m4a"),
    microphoneFinalized: path.join(outputDir, "microphone.finalized.m4a"),
  };
}

export function buildHelperConfig(options, paths) {
  const config = {
    fps: options.fps,
    outputPath: paths.screen,
    capturesSystemAudio: false,
    capturesMicrophone: options.capturesMicrophone,
    capturesWebcam: options.capturesWebcam,
  };

  if (options.capturesMicrophone) {
    config.microphoneOutputPath = paths.microphone;
    if (options.microphoneLabel) {
      config.microphoneLabel = options.microphoneLabel;
    }
    if (options.microphoneDeviceId) {
      config.microphoneDeviceId = options.microphoneDeviceId;
    }
  }

  if (options.capturesWebcam) {
    Object.assign(config, {
      webcamOutputPath: paths.webcam,
      webcamPreviewPath: paths.preview,
      webcamWidth: options.webcamWidth,
      webcamHeight: options.webcamHeight,
      webcamFPS: options.webcamFps,
    });
    if (options.webcamLabel) {
      config.webcamLabel = options.webcamLabel;
    }
    if (options.webcamDeviceId) {
      config.webcamDeviceId = options.webcamDeviceId;
    }
  }

  return config;
}

function parseScalar(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && value.trim() !== "" ? numeric : value;
}

function parseKeyValueTail(tail) {
  const details = {};
  const keyValuePattern = /([a-zA-Z][a-zA-Z0-9_]*)=("[^"]*"|'[^']*'|\S+)/g;
  let match = keyValuePattern.exec(tail);
  while (match !== null) {
    const rawValue = match[2];
    const unquoted =
      (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
      (rawValue.startsWith("'") && rawValue.endsWith("'"))
        ? rawValue.slice(1, -1)
        : rawValue;
    details[match[1]] = parseScalar(unquoted);
    match = keyValuePattern.exec(tail);
  }
  return details;
}

function lastLineStartingWith(output, prefix) {
  const lines = output.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() ?? "";
    if (line.startsWith(prefix)) {
      return line;
    }
  }
  return null;
}

function parseFinalization(output, prefix) {
  const line = lastLineStartingWith(output, prefix);
  if (!line) {
    return null;
  }
  return {
    line,
    ...parseKeyValueTail(line.slice(prefix.length)),
  };
}

function ffprobePath() {
  const candidate =
    typeof ffprobeStatic === "string" ? ffprobeStatic : ffprobeStatic.path;
  return resolveSmokeFfprobePath({ staticPath: candidate });
}

function findSystemFfprobePath(existsSyncImpl = fs.existsSync) {
  const candidates =
    process.platform === "win32"
      ? []
      : [
          "/opt/homebrew/bin/ffprobe",
          "/usr/local/bin/ffprobe",
          "/usr/bin/ffprobe",
        ];

  return candidates.find((candidate) => existsSyncImpl(candidate)) ?? null;
}

export function resolveSmokeFfprobePath({
  staticPath,
  platform = process.platform,
  arch = process.arch,
  existsSync: existsSyncImpl = fs.existsSync,
} = {}) {
  if (platform === "darwin" && arch === "arm64") {
    const systemFfprobe = findSystemFfprobePath(existsSyncImpl);
    if (systemFfprobe) {
      return systemFfprobe;
    }
  }

  if (!staticPath) {
    fail("Unable to resolve ffprobe-static path");
  }
  return staticPath;
}

function ffmpegPath() {
  const candidate =
    typeof ffmpegStatic === "string" ? ffmpegStatic : ffmpegStatic?.default;
  if (!candidate) {
    fail("Unable to resolve ffmpeg-static path");
  }
  return candidate;
}

function formatSeconds(value) {
  return (Math.round(value * 1000) / 1000).toFixed(3);
}

function roundSeconds(value) {
  return Math.round(value * 1000) / 1000;
}

function buildAtempoFilters(tempoRatio) {
  if (!Number.isFinite(tempoRatio) || tempoRatio <= 0) {
    return [];
  }
  const filters = [];
  let remaining = tempoRatio;
  while (remaining < 0.5) {
    filters.push("atempo=0.5");
    remaining /= 0.5;
  }
  while (remaining > 2) {
    filters.push("atempo=2.0");
    remaining /= 2.0;
  }
  if (Math.abs(remaining - 1) > 0.0005) {
    filters.push(`atempo=${remaining.toFixed(6)}`);
  }
  return filters;
}

export function getMicrophoneAudioSyncPlan({
  videoDurationSeconds,
  audioDurationSeconds,
}) {
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
  if (Math.abs(driftSeconds) <= 0.05) {
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
  const relativeDelta =
    Math.abs(durationDeltaMs) / Math.max(videoDurationSeconds * 1000, 1);
  if (relativeDelta <= 0.03 || Math.abs(durationDeltaMs) <= 1500) {
    return {
      action: "repair",
      reason: "pad",
      videoDurationSeconds,
      audioDurationSeconds,
      driftSeconds,
      tempoRatio: 1,
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

export function buildMicrophoneAudioSyncArgs({
  inputPath,
  outputPath,
  videoDurationSeconds,
  tempoRatio,
}) {
  const outputDuration = formatSeconds(videoDurationSeconds);
  const filterParts = [
    ...buildAtempoFilters(tempoRatio),
    "apad",
    `atrim=duration=${outputDuration}`,
    "aresample=async=1:first_pts=0",
    "asetpts=PTS-STARTPTS",
  ];
  return [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    inputPath,
    "-filter_complex",
    `[0:a]${filterParts.join(",")}[aout_sync]`,
    "-map",
    "[aout_sync]",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-t",
    outputDuration,
    outputPath,
  ];
}

function finalizeMicrophoneAudio({
  inputPath,
  outputPath,
  screen,
  microphone,
}) {
  const plan = getMicrophoneAudioSyncPlan({
    videoDurationSeconds: screen.durationSeconds,
    audioDurationSeconds: microphone.durationSeconds,
  });
  if (plan.action === "none") {
    return {
      repaired: false,
      plan,
      audio: microphone,
      driftSeconds: Math.abs(
        screen.durationSeconds - microphone.durationSeconds,
      ),
    };
  }
  if (plan.action === "reject") {
    fail("Microphone audio/video mismatch is too large to repair safely", plan);
  }

  const result = spawnSync(
    ffmpegPath(),
    buildMicrophoneAudioSyncArgs({
      inputPath,
      outputPath,
      videoDurationSeconds: plan.videoDurationSeconds,
      tempoRatio: plan.tempoRatio,
    }),
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    fail("Microphone audio finalization failed", {
      status: result.status,
      stderr: result.stderr.trim(),
    });
  }

  const finalized = assertExistingAudio(
    outputPath,
    "finalized microphone",
    screen.durationSeconds - 0.25,
  );
  const driftSeconds = Math.abs(
    screen.durationSeconds - finalized.durationSeconds,
  );
  if (driftSeconds > 0.05) {
    fail("Finalized microphone duration still drifted too far", {
      screenDurationSeconds: screen.durationSeconds,
      microphoneDurationSeconds: finalized.durationSeconds,
      driftSeconds,
      allowedDriftSeconds: 0.05,
      plan,
    });
  }
  return {
    repaired: true,
    plan,
    audio: finalized,
    driftSeconds,
  };
}

function probeVideo(filePath) {
  const result = spawnSync(
    ffprobePath(),
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-count_frames",
      "-show_entries",
      "stream=duration,nb_read_frames,r_frame_rate:format=duration",
      "-of",
      "json",
      filePath,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    fail(`ffprobe failed for ${filePath}`, { stderr: result.stderr.trim() });
  }
  const parsed = JSON.parse(result.stdout);
  const stream = parsed.streams?.[0] ?? {};
  const durationSeconds = Number(stream.duration ?? parsed.format?.duration);
  const frameCount = Number(stream.nb_read_frames);
  const frameRate = parseFrameRate(stream.r_frame_rate);
  return {
    durationSeconds,
    frameCount: Number.isFinite(frameCount) ? frameCount : null,
    frameRate,
  };
}

function probeAudio(filePath) {
  const result = spawnSync(
    ffprobePath(),
    [
      "-v",
      "error",
      "-select_streams",
      "a:0",
      "-show_entries",
      "stream=duration:format=duration",
      "-of",
      "json",
      filePath,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    fail(`ffprobe failed for ${filePath}`, { stderr: result.stderr.trim() });
  }
  const parsed = JSON.parse(result.stdout);
  const stream = parsed.streams?.[0] ?? {};
  const durationSeconds = Number(stream.duration ?? parsed.format?.duration);
  return { durationSeconds };
}

function parseFrameRate(value) {
  if (typeof value !== "string" || !value.includes("/")) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }
  const [numerator, denominator] = value.split("/").map(Number);
  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    denominator === 0
  ) {
    return null;
  }
  return numerator / denominator;
}

function assertExistingVideo(filePath, label, minDurationSeconds) {
  if (!fs.existsSync(filePath)) {
    fail(`${label} file is missing`, { filePath });
  }
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size <= 0) {
    fail(`${label} file is empty`, { filePath, size: stat.size });
  }
  const probe = probeVideo(filePath);
  if (
    !Number.isFinite(probe.durationSeconds) ||
    probe.durationSeconds < minDurationSeconds
  ) {
    fail(`${label} duration is too short`, {
      filePath,
      durationSeconds: probe.durationSeconds,
      minDurationSeconds,
    });
  }
  return {
    path: filePath,
    sizeBytes: stat.size,
    ...probe,
  };
}

function assertExistingAudio(filePath, label, minDurationSeconds) {
  if (!fs.existsSync(filePath)) {
    fail(`${label} file is missing`, { filePath });
  }
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size <= 0) {
    fail(`${label} file is empty`, { filePath, size: stat.size });
  }
  const probe = probeAudio(filePath);
  if (
    !Number.isFinite(probe.durationSeconds) ||
    probe.durationSeconds < minDurationSeconds
  ) {
    fail(`${label} duration is too short`, {
      filePath,
      durationSeconds: probe.durationSeconds,
      minDurationSeconds,
    });
  }
  return {
    path: filePath,
    sizeBytes: stat.size,
    ...probe,
  };
}

export function allowedDurationDriftSeconds(durationSeconds) {
  return Math.min(
    maxNativeWebcamDurationDriftSeconds,
    Math.max(
      minNativeWebcamDurationDriftSeconds,
      durationSeconds * nativeWebcamDurationDriftRatio,
    ),
  );
}

function previewSummary(output) {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("WEBCAM_PREVIEW_FRAME_WRITTEN "));
  let monotonic = true;
  let previous = null;
  const paths = new Set();
  for (const line of lines) {
    const details = parseKeyValueTail(
      line.slice("WEBCAM_PREVIEW_FRAME_WRITTEN ".length),
    );
    if (typeof details.path === "string" && details.path) {
      paths.add(details.path);
    }
    const current = {
      sequence: typeof details.sequence === "number" ? details.sequence : null,
      acceptedFrame:
        typeof details.acceptedFrame === "number"
          ? details.acceptedFrame
          : null,
      acceptedPts:
        typeof details.acceptedPts === "number" ? details.acceptedPts : null,
      path: typeof details.path === "string" ? details.path : null,
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
    count: lines.length,
    distinctPathCount: paths.size,
    monotonic,
    last: previous,
  };
}

export function hasNativeProofStartEvidence(
  output,
  { capturesWebcam, capturesMicrophone = false },
) {
  if (
    !output.includes("Recording started") ||
    !output.includes("VIDEO_FIRST_FRAME_WRITTEN")
  ) {
    return false;
  }
  if (
    capturesMicrophone &&
    !output.includes("MICROPHONE_AUDIO_FIRST_BUFFER_WRITTEN")
  ) {
    return false;
  }
  if (!capturesWebcam) {
    return true;
  }
  return (
    output.includes("WEBCAM_FIRST_VISIBLE_FRAME_WRITTEN") &&
    output.includes("WEBCAM_PREVIEW_FRAME_WRITTEN")
  );
}

export function nativeProofStartTimeoutMessage({
  capturesWebcam,
  capturesMicrophone = false,
  output = "",
}) {
  if (
    capturesMicrophone &&
    !output.includes("MICROPHONE_AUDIO_FIRST_BUFFER_WRITTEN")
  ) {
    return "Native helper did not write a microphone audio buffer before timeout";
  }

  if (!capturesWebcam) {
    return "Native helper did not write a screen frame before timeout";
  }

  if (
    output.includes("Recording started") &&
    output.includes("VIDEO_FIRST_FRAME_WRITTEN") &&
    output.includes("WEBCAM_FIRST_FRAME_WRITTEN") &&
    output.includes("WEBCAM_PREVIEW_FRAME_WRITTEN") &&
    !output.includes("WEBCAM_FIRST_VISIBLE_FRAME_WRITTEN")
  ) {
    return "Native helper received webcam frames and proof-preview frames, but the selected webcam appears to be delivering blank video.";
  }

  return "Native helper did not write screen, visible webcam, and preview proof frames before timeout";
}

function runHelper({
  helperPath,
  config,
  durationSeconds,
  capturesWebcam,
  capturesMicrophone,
  verbose,
}) {
  return new Promise((resolve, reject) => {
    const child = spawn(helperPath, [JSON.stringify(config)], {
      cwd: path.dirname(config.outputPath),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let started = false;
    let stopSent = false;
    let stopTimer = null;

    const rejectWithOutput = (message) => {
      const error = new Error(message);
      error.nativeOutput = output;
      reject(error);
    };

    const cleanup = () => {
      clearTimeout(startTimer);
      clearTimeout(stopTimer);
      clearTimeout(killTimer);
    };

    const sendStop = () => {
      if (stopSent || child.killed) {
        return;
      }
      stopSent = true;
      child.stdin.write("stop\n");
    };

    const handleOutput = (chunk) => {
      const text = chunk.toString();
      output += text;
      if (verbose) {
        process.stderr.write(text);
      }
      if (
        !started &&
        hasNativeProofStartEvidence(output, {
          capturesWebcam,
          capturesMicrophone,
        })
      ) {
        started = true;
        stopTimer = setTimeout(sendStop, durationSeconds * 1000);
      }
    };

    const startTimer = setTimeout(() => {
      if (!started) {
        child.kill("SIGTERM");
        rejectWithOutput(
          nativeProofStartTimeoutMessage({
            capturesWebcam,
            capturesMicrophone,
            output,
          }),
        );
      }
    }, startupTimeoutMs);

    const killTimer = setTimeout(
      () => {
        child.kill("SIGTERM");
        reject(new Error("Native helper did not stop before timeout"));
      },
      startupTimeoutMs + durationSeconds * 1000 + shutdownGraceMs,
    );

    child.stdout.on("data", handleOutput);
    child.stderr.on("data", handleOutput);
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("close", (code, signal) => {
      cleanup();
      resolve({ code, signal, output, started, stopSent });
    });
  });
}

export function findNativeFatalMarker(output) {
  for (const marker of fatalMarkers) {
    if (output.includes(marker)) {
      return marker;
    }
  }
  return null;
}

function validateResult({
  result,
  paths,
  durationSeconds,
  capturesWebcam,
  capturesMicrophone,
  finalizeMicrophoneAudio: shouldFinalizeMicrophoneAudio = false,
}) {
  if (!result.started) {
    fail("Native helper exited before recording started", {
      code: result.code,
      signal: result.signal,
      nativeOutput: result.output,
    });
  }
  if (!result.stopSent) {
    fail("Native helper exited before the smoke duration elapsed", {
      code: result.code,
      signal: result.signal,
      nativeOutput: result.output,
    });
  }
  if (result.code !== 0) {
    fail("Native helper exited with a nonzero code", {
      code: result.code,
      signal: result.signal,
      nativeOutput: result.output,
    });
  }

  const fatalMarker = findNativeFatalMarker(result.output);
  if (fatalMarker) {
    fail(`Native helper emitted fatal marker: ${fatalMarker}`, {
      marker: fatalMarker,
      nativeOutput: result.output,
    });
  }

  const screenFinalization = parseFinalization(
    result.output,
    "VIDEO_RECORDING_FINALIZED ",
  );
  if (!screenFinalization) {
    fail("Screen writer finalization is missing", {
      nativeOutput: result.output,
    });
  }
  if (screenFinalization.writerStatus !== "completed") {
    fail("Screen writer did not complete", {
      screenFinalization,
      nativeOutput: result.output,
    });
  }
  if (
    typeof screenFinalization.realFrames === "number" &&
    screenFinalization.realFrames <= 0
  ) {
    fail("Screen writer reported zero real frames", {
      screenFinalization,
      nativeOutput: result.output,
    });
  }

  const minScreenDuration = Math.max(1, durationSeconds - 2.5);
  const screen = assertExistingVideo(paths.screen, "screen", minScreenDuration);

  let webcam = null;
  let webcamFinalization = null;
  let preview = null;
  if (capturesWebcam) {
    webcamFinalization = parseFinalization(
      result.output,
      "WEBCAM_RECORDING_FINALIZED ",
    );
    if (!webcamFinalization) {
      fail("Webcam writer finalization is missing", {
        nativeOutput: result.output,
      });
    }
    if (webcamFinalization.writerStatus !== "completed") {
      fail("Webcam writer did not complete", {
        webcamFinalization,
        nativeOutput: result.output,
      });
    }
    if (
      typeof webcamFinalization.frames === "number" &&
      webcamFinalization.frames <= 0
    ) {
      fail("Webcam writer reported zero frames", {
        webcamFinalization,
        nativeOutput: result.output,
      });
    }

    const minWebcamDuration = Math.max(1, durationSeconds - 3.5);
    webcam = assertExistingVideo(paths.webcam, "webcam", minWebcamDuration);
    const effectiveFps =
      webcam.frameCount && webcam.durationSeconds
        ? webcam.frameCount / webcam.durationSeconds
        : null;
    if (effectiveFps !== null && effectiveFps < minAcceptableWebcamFps) {
      fail("Webcam effective FPS is too low", { effectiveFps, webcam });
    }

    const driftSeconds = Math.abs(
      screen.durationSeconds - webcam.durationSeconds,
    );
    const allowedDriftSeconds = allowedDurationDriftSeconds(
      screen.durationSeconds,
    );
    if (driftSeconds > allowedDriftSeconds) {
      fail("Screen and webcam durations drifted too far", {
        screenDurationSeconds: screen.durationSeconds,
        webcamDurationSeconds: webcam.durationSeconds,
        driftSeconds,
        allowedDriftSeconds,
      });
    }

    preview = previewSummary(result.output);
    const minPreviewCount = Math.max(3, Math.floor(durationSeconds / 2));
    if (preview.count < minPreviewCount) {
      fail("Too few webcam proof-preview frames were written", {
        previewCount: preview.count,
        minPreviewCount,
      });
    }
    if (preview.count > 1 && preview.distinctPathCount < 2) {
      fail("Webcam proof-preview frames did not rotate across frame files", {
        preview,
      });
    }
    if (!preview.monotonic) {
      fail("Webcam proof-preview frames were not monotonic", { preview });
    }
  }

  let microphone = null;
  let microphoneFinalization = null;
  if (capturesMicrophone) {
    if (!result.output.includes("MICROPHONE_AUDIO_FIRST_BUFFER_WRITTEN")) {
      fail("Microphone first audio buffer is missing", {
        nativeOutput: result.output,
      });
    }
    if (!result.output.includes("AUDIO_CAPTURE_STATS")) {
      fail("Microphone audio capture stats are missing", {
        nativeOutput: result.output,
      });
    }
    const minMicrophoneDuration = Math.max(1, durationSeconds - 3.5);
    microphone = assertExistingAudio(
      paths.microphone,
      "microphone",
      minMicrophoneDuration,
    );
    const driftSeconds = Math.abs(
      screen.durationSeconds - microphone.durationSeconds,
    );
    if (shouldFinalizeMicrophoneAudio) {
      microphoneFinalization = finalizeMicrophoneAudio({
        inputPath: paths.microphone,
        outputPath: paths.microphoneFinalized,
        screen,
        microphone,
      });
    } else {
      const allowedDriftSeconds = allowedDurationDriftSeconds(
        screen.durationSeconds,
      );
      if (driftSeconds > allowedDriftSeconds) {
        fail("Screen and microphone durations drifted too far", {
          screenDurationSeconds: screen.durationSeconds,
          microphoneDurationSeconds: microphone.durationSeconds,
          driftSeconds,
          allowedDriftSeconds,
        });
      }
    }
  }

  return {
    status: "pass",
    durationSeconds,
    screen,
    webcam,
    microphone,
    microphoneFinalization,
    preview,
    screenFinalization,
    webcamFinalization,
    artifacts: paths,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (process.platform !== "darwin") {
    console.log(
      "[native-smoke] skipping: ScreenCaptureKit helper is macOS-only",
    );
    return;
  }

  const helperPath = options.helperPath ?? defaultHelperPath();
  if (!fs.existsSync(helperPath)) {
    fail(`Native helper is missing: ${helperPath}`);
  }

  const outputDir =
    options.outputDir ??
    fs.mkdtempSync(path.join(os.tmpdir(), "recordly-native-smoke-"));
  await fsp.mkdir(outputDir, { recursive: true });
  const paths = buildSmokePaths(outputDir);
  const config = buildHelperConfig(options, paths);

  console.log(
    `[native-smoke] helper=${path.relative(projectRoot, helperPath)} duration=${options.durationSeconds}s output=${outputDir}`,
  );
  let summary;
  try {
    const result = await runHelper({
      helperPath,
      config,
      durationSeconds: options.durationSeconds,
      capturesWebcam: options.capturesWebcam,
      capturesMicrophone: options.capturesMicrophone,
      verbose: options.verbose,
    });
    summary = validateResult({
      result,
      paths,
      durationSeconds: options.durationSeconds,
      capturesWebcam: options.capturesWebcam,
      capturesMicrophone: options.capturesMicrophone,
      finalizeMicrophoneAudio: options.finalizeMicrophoneAudio,
    });
    if (options.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(
        `[native-smoke] PASS screen=${summary.screen.durationSeconds.toFixed(3)}s webcam=${summary.webcam ? `${summary.webcam.durationSeconds.toFixed(3)}s` : "disabled"} microphone=${summary.microphone ? `${summary.microphone.durationSeconds.toFixed(3)}s` : "disabled"} previewFrames=${summary.preview?.count ?? 0}`,
      );
    }
    if (!options.keep && !options.outputDir) {
      await fsp.rm(outputDir, { recursive: true, force: true });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const details = error?.details ?? {};
    const nativeOutput = error?.nativeOutput ?? "";
    if (options.json) {
      console.error(
        JSON.stringify(
          {
            status: "fail",
            message,
            details,
            artifacts: paths,
          },
          null,
          2,
        ),
      );
    } else {
      console.error(`[native-smoke] FAIL ${message}`);
      if (Object.keys(details).length > 0) {
        console.error(JSON.stringify(details, null, 2));
      }
      const fatalLines = collectInterestingLines(nativeOutput);
      if (fatalLines.length > 0) {
        console.error("[native-smoke] interesting native lines:");
        for (const line of fatalLines) {
          console.error(line);
        }
      }
      console.error(`[native-smoke] artifacts kept at ${outputDir}`);
    }
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error);
    process.exit(2);
  });
}

function collectInterestingLines(output) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) =>
      /PIPELINE_STALLED|APPEND_FAILED|APPEND_SKIPPED|RECORDING_FINALIZED|KEEPALIVE|DEVICE_NOT_FOUND|CAPTURE_DISABLED|VISUAL_STALL/.test(
        line,
      ),
    )
    .slice(-40);
}
