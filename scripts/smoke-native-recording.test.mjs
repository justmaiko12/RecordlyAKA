import { describe, expect, it } from "vitest";
import {
  allowedDurationDriftSeconds,
  buildMicrophoneAudioSyncArgs,
  buildHelperConfig,
  buildSmokePaths,
  findNativeFatalMarker,
  getMicrophoneAudioSyncPlan,
  hasNativeProofStartEvidence,
  nativeProofStartTimeoutMessage,
  parseArgs,
  resolveSmokeFfprobePath,
} from "./smoke-native-recording.mjs";

describe("native recording smoke binary resolution", () => {
  it("prefers native system ffprobe on Apple Silicon before ffprobe-static", () => {
    const result = resolveSmokeFfprobePath({
      staticPath: "/repo/node_modules/ffprobe-static/bin/darwin/arm64/ffprobe",
      platform: "darwin",
      arch: "arm64",
      existsSync: (candidate) => candidate === "/opt/homebrew/bin/ffprobe",
    });

    expect(result).toBe("/opt/homebrew/bin/ffprobe");
  });

  it("falls back to ffprobe-static when no system ffprobe is available", () => {
    const result = resolveSmokeFfprobePath({
      staticPath: "/repo/node_modules/ffprobe-static/bin/darwin/arm64/ffprobe",
      platform: "darwin",
      arch: "arm64",
      existsSync: (candidate) =>
        candidate ===
        "/repo/node_modules/ffprobe-static/bin/darwin/arm64/ffprobe",
    });

    expect(result).toBe(
      "/repo/node_modules/ffprobe-static/bin/darwin/arm64/ffprobe",
    );
  });
});

describe("native recording smoke proof-start gate", () => {
  it("does not treat the helper banner alone as a started screen recording", () => {
    expect(
      hasNativeProofStartEvidence("Recording started\n", {
        capturesWebcam: false,
      }),
    ).toBe(false);
  });

  it("accepts screen-only startup after a screen frame is written", () => {
    expect(
      hasNativeProofStartEvidence(
        "Recording started\nVIDEO_FIRST_FRAME_WRITTEN frames=1 pts=0\n",
        { capturesWebcam: false },
      ),
    ).toBe(true);
  });

  it("requires visible webcam and preview proof evidence for webcam startup", () => {
    const screenOnlyEvidence = [
      "Recording started",
      "VIDEO_FIRST_FRAME_WRITTEN frames=1 pts=0",
      "WEBCAM_FIRST_FRAME_WRITTEN frames=1 pts=0",
    ].join("\n");

    expect(
      hasNativeProofStartEvidence(screenOnlyEvidence, { capturesWebcam: true }),
    ).toBe(false);
    expect(
      hasNativeProofStartEvidence(
        [
          screenOnlyEvidence,
          "WEBCAM_FIRST_VISIBLE_FRAME_WRITTEN frames=2 pts=0.033 averageLuma=10 maxLuma=90",
          "WEBCAM_PREVIEW_FRAME_WRITTEN path=/tmp/preview.jpg bytes=123 sequence=1 acceptedFrame=2 acceptedPts=0.033",
        ].join("\n"),
        { capturesWebcam: true },
      ),
    ).toBe(true);
  });

  it("explains proof-start timeout by webcam evidence when webcam is required", () => {
    expect(nativeProofStartTimeoutMessage({ capturesWebcam: true })).toContain(
      "visible webcam, and preview proof frames",
    );
  });

  it("reports blank webcam startup when writer and preview frames exist without visible video", () => {
    expect(
      nativeProofStartTimeoutMessage({
        capturesWebcam: true,
        output: [
          "Recording started",
          "VIDEO_FIRST_FRAME_WRITTEN frames=1 pts=0",
          "WEBCAM_FIRST_FRAME_WRITTEN frames=1 pts=0",
          "WEBCAM_PREVIEW_FRAME_WRITTEN path=/tmp/preview.jpg bytes=2035 sequence=1 acceptedFrame=1 acceptedPts=0",
        ].join("\n"),
      }),
    ).toContain("blank video");
  });
});

describe("native recording smoke microphone gate", () => {
  it("parses microphone capture options", () => {
    const options = parseArgs([
      "--microphone",
      "--finalize-microphone-audio",
      "--microphone-label",
      "USB Mic",
      "--microphone-device-id",
      "device-123",
    ]);

    expect(options.capturesMicrophone).toBe(true);
    expect(options.finalizeMicrophoneAudio).toBe(true);
    expect(options.microphoneLabel).toBe("USB Mic");
    expect(options.microphoneDeviceId).toBe("device-123");
  });

  it("waits for microphone audio proof before treating a microphone smoke as started", () => {
    const screenEvidence =
      "Recording started\nVIDEO_FIRST_FRAME_WRITTEN frames=1 pts=0\n";

    expect(
      hasNativeProofStartEvidence(screenEvidence, {
        capturesWebcam: false,
        capturesMicrophone: true,
      }),
    ).toBe(false);

    expect(
      hasNativeProofStartEvidence(
        `${screenEvidence}MICROPHONE_AUDIO_FIRST_BUFFER_WRITTEN buffers=1 pts=0 duration=0.023\n`,
        { capturesWebcam: false, capturesMicrophone: true },
      ),
    ).toBe(true);
  });

  it("configures a microphone companion sidecar when microphone capture is enabled", () => {
    const paths = buildSmokePaths("/tmp/recordly-native-smoke-test");
    const options = parseArgs([
      "--microphone",
      "--microphone-label",
      "USB Mic",
      "--microphone-device-id",
      "device-123",
    ]);
    const config = buildHelperConfig(options, paths);

    expect(paths.microphone).toBe(
      "/tmp/recordly-native-smoke-test/microphone.m4a",
    );
    expect(config).toMatchObject({
      capturesMicrophone: true,
      microphoneOutputPath: paths.microphone,
      microphoneLabel: "USB Mic",
      microphoneDeviceId: "device-123",
    });
  });

  it("treats audio pipeline stalls as fatal helper output", () => {
    expect(findNativeFatalMarker("AUDIO_PIPELINE_STALLED reason=test")).toBe(
      "AUDIO_PIPELINE_STALLED",
    );
  });

  it("plans a tempo repair for the observed long-run microphone drift", () => {
    expect(
      getMicrophoneAudioSyncPlan({
        videoDurationSeconds: 960.02,
        audioDurationSeconds: 956.629333,
      }),
    ).toMatchObject({
      action: "repair",
      reason: "tempo",
      driftSeconds: 3.391,
      tempoRatio: 0.996468,
    });
  });

  it("builds finalized microphone audio args that trim exactly to video duration", () => {
    expect(
      buildMicrophoneAudioSyncArgs({
        inputPath: "microphone.m4a",
        outputPath: "microphone.finalized.m4a",
        videoDurationSeconds: 960.02,
        tempoRatio: 0.996468,
      }),
    ).toEqual([
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "microphone.m4a",
      "-filter_complex",
      "[0:a]atempo=0.996468,apad,atrim=duration=960.020,aresample=async=1:first_pts=0,asetpts=PTS-STARTPTS[aout_sync]",
      "-map",
      "[aout_sync]",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-t",
      "960.020",
      "microphone.finalized.m4a",
    ]);
  });
});

describe("native recording smoke webcam sync tolerance", () => {
  it("keeps long-run webcam duration drift tolerance below visible multi-second skew", () => {
    expect(allowedDurationDriftSeconds(45)).toBe(0.75);
    expect(allowedDurationDriftSeconds(600)).toBe(0.75);
    expect(allowedDurationDriftSeconds(1200)).toBe(1);
  });
});
