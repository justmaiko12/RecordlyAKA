import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auditRecordingRun } from "./audit-recording-run.mjs";

let tempDir;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-cli-audit-"));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

async function writeRun(events) {
  const videoPath = path.join(tempDir, "recording-123.mp4");
  const eventLogPath = path.join(
    tempDir,
    "recording-123.recordly-events.jsonl",
  );
  await fs.writeFile(videoPath, "not-a-real-video", "utf8");
  await fs.writeFile(
    eventLogPath,
    events
      .map((entry) =>
        JSON.stringify({
          timestamp: "2026-06-17T00:00:00.000Z",
          sessionId: "123",
          ...entry,
        }),
      )
      .join("\n"),
    "utf8",
  );
  await fs.writeFile(
    path.join(tempDir, "recording-123.recording-diagnostics.json"),
    JSON.stringify({
      version: 1,
      latest: {
        phase: "stop",
        expectedDurationMs: 600_000,
      },
    }),
    "utf8",
  );
  return videoPath;
}

function healthyScreenOnlyEvents() {
  return [
    {
      event: "native-video-first-frame-written",
      details: { frames: 1, pts: 0 },
    },
    {
      event: "native-video-recording-finalized",
      details: {
        writerStatus: "completed",
        frames: 18_000,
        realFrames: 18_000,
        holdFrames: 0,
        duration: 600,
      },
    },
    { event: "native-screen-recording-accepted", details: {} },
  ];
}

describe("audit-recording-run CLI helper", () => {
  it("fails when accepted webcam proof samples contain an isolated timestamp gap", async () => {
    const videoPath = await writeRun([
      {
        event: "native-video-first-frame-written",
        details: { frames: 1, pts: 0 },
      },
      { event: "native-webcam-capture-started", details: { label: "Camera" } },
      {
        event: "native-webcam-first-visible-frame-written",
        details: { frames: 1, pts: 0.033 },
      },
      {
        event: "native-webcam-proof-preview-accepted",
        details: { sequence: 1, acceptedFrame: 1, acceptedPts: 0.033 },
      },
      {
        event: "native-webcam-proof-preview-accepted",
        details: { sequence: 2, acceptedFrame: 31, acceptedPts: 1.033 },
      },
      {
        event: "native-webcam-proof-preview-accepted",
        details: { sequence: 3, acceptedFrame: 150, acceptedPts: 5.1 },
      },
      {
        event: "native-video-recording-finalized",
        details: {
          writerStatus: "completed",
          frames: 180,
          realFrames: 180,
          holdFrames: 0,
          duration: 6,
        },
      },
      {
        event: "native-webcam-recording-finalized",
        details: {
          writerStatus: "completed",
          frames: 180,
          duration: 6,
        },
      },
      { event: "native-screen-recording-accepted", details: {} },
      { event: "native-webcam-sidecar-accepted", details: {} },
    ]);
    const result = await auditRecordingRun(videoPath, {
      probeSourceMediaDurations: async () => ({
        videoDurationSeconds: 6,
        audioDurationSeconds: 6,
      }),
    });

    expect(result.status).toBe("fail");
    expect(
      result.issues.some((issue) => issue.code === "accepted-proof-preview-gap"),
    ).toBe(true);
    expect(result.summary.proof).toMatchObject({
      largeGapCount: 1,
      maxAcceptedPtsGapSeconds: 4.067,
      maxAcceptedFrameGap: 119,
    });
  });

  it("fails when finalized embedded source audio still has duration drift", async () => {
    const videoPath = await writeRun(healthyScreenOnlyEvents());
    const result = await auditRecordingRun(videoPath, {
      probeSourceMediaDurations: async () => ({
        videoDurationSeconds: 600,
        audioDurationSeconds: 571,
      }),
    });

    expect(result.status).toBe("fail");
    expect(
      result.issues.some(
        (issue) => issue.code === "source-media-audio-duration-drift",
      ),
    ).toBe(true);
    expect(result.summary.sourceMediaDurations).toMatchObject({
      preferredAudioSource: "embedded",
      videoDurationSeconds: 600,
      audioDurationSeconds: 571,
      driftSeconds: 29,
      planAction: "reject",
    });
  });

  it("fails when native microphone capture was selected but never wrote a first buffer", async () => {
    const videoPath = await writeRun([
      ...healthyScreenOnlyEvents(),
      {
        event: "native-microphone-device-default",
        details: {
          requestedLabel: "",
          requestedDeviceId: "",
          available: "MacBook Air Microphone [BuiltInMicrophoneDevice]",
        },
      },
    ]);
    const result = await auditRecordingRun(videoPath, {
      probeSourceMediaDurations: async () => ({
        videoDurationSeconds: 600,
        audioDurationSeconds: 600,
      }),
    });

    expect(result.status).toBe("fail");
    expect(
      result.issues.some(
        (issue) =>
          issue.code === "native-microphone-audio-missing-first-buffer",
      ),
    ).toBe(true);
    expect(result.summary.nativeMicrophone).toMatchObject({
      requested: true,
      firstBufferWritten: false,
      unavailable: false,
    });
  });

  it("prefers a mic companion sidecar over drifted embedded source audio", async () => {
    const videoPath = await writeRun(healthyScreenOnlyEvents());
    await fs.writeFile(
      path.join(tempDir, "recording-123.mic.wav"),
      "mic-sidecar",
      "utf8",
    );
    const result = await auditRecordingRun(videoPath, {
      probeSourceMediaDurations: async () => ({
        videoDurationSeconds: 600,
        audioDurationSeconds: 571,
      }),
      probeCompanionAudioDurationSeconds: async () => 600,
    });

    expect(result.status).toBe("pass");
    expect(
      result.issues.some(
        (issue) => issue.code === "source-media-audio-duration-drift",
      ),
    ).toBe(false);
    expect(result.summary.sourceMediaDurations).toMatchObject({
      preferredAudioSource: "mic-companion",
      planAction: "reject",
    });
    expect(result.summary.companionAudioDurations).toEqual([
      expect.objectContaining({
        audioPath: path.join(tempDir, "recording-123.mic.wav"),
        trackKind: "mic",
        videoDurationSeconds: 600,
        audioDurationSeconds: 600,
        driftSeconds: 0,
        planAction: "none",
      }),
    ]);
  });

  it("fails when the preferred mic companion sidecar still has duration drift", async () => {
    const videoPath = await writeRun(healthyScreenOnlyEvents());
    await fs.writeFile(
      path.join(tempDir, "recording-123.mic.wav"),
      "mic-sidecar",
      "utf8",
    );
    const result = await auditRecordingRun(videoPath, {
      probeSourceMediaDurations: async () => ({
        videoDurationSeconds: 600,
        audioDurationSeconds: 571,
      }),
      probeCompanionAudioDurationSeconds: async () => 571,
    });

    expect(result.status).toBe("fail");
    expect(
      result.issues.some(
        (issue) => issue.code === "companion-mic-audio-duration-drift",
      ),
    ).toBe(true);
    expect(result.summary.companionAudioDurations).toEqual([
      expect.objectContaining({
        videoDurationSeconds: 600,
        audioDurationSeconds: 571,
        driftSeconds: 29,
        planAction: "reject",
      }),
    ]);
  });
});
