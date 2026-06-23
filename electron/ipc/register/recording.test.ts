import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => process.env.TEMP ?? "/tmp",
    isPackaged: false,
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
  desktopCapturer: {
    getSources: vi.fn(),
  },
  dialog: {
    showOpenDialog: vi.fn(),
  },
  ipcMain: {
    handle: vi.fn(),
  },
  shell: {
    openExternal: vi.fn(),
    showItemInFolder: vi.fn(),
  },
  systemPreferences: {
    getMediaAccessStatus: vi.fn(),
    askForMediaAccess: vi.fn(),
  },
}));

import {
  auditFinalizedRecordingForRenderer,
  finalizeStoredVideoWithSourceAudioSync,
  storeRecordedVideoWithSourceAudioSync,
  summarizeRecordingAuditForIpc,
} from "./recording";

const summarizedAudit = {
  status: "fail",
  paths: {
    inputPath: "/tmp/recording-123.mp4",
    videoPath: "/tmp/recording-123.mp4",
    eventLogPath: "/tmp/recording-123.recordly-events.jsonl",
    diagnosticsPath: "/tmp/recording-123.recording-diagnostics.json",
  },
  issues: [
    {
      code: "recording-companion-audio-missing",
      message: "Required companion microphone audio was not found.",
    },
  ],
  warnings: [],
  summary: {
    eventCount: 5,
    sawWebcamEvidence: false,
    proofCount: 0,
    proofRejectedCount: 0,
    proofMonotonic: null,
    rendererPreviewIssueCount: 0,
    screenWriterStatus: "completed",
    screenDuration: 30,
    screenFrames: 900,
    webcamWriterStatus: null,
    webcamDuration: null,
    webcamFrames: null,
  },
};

describe("auditFinalizedRecordingForRenderer", () => {
  it("preserves audio duration evidence in the renderer audit summary", () => {
    const result = summarizeRecordingAuditForIpc({
      status: "fail",
      paths: summarizedAudit.paths,
      issues: summarizedAudit.issues,
      warnings: [],
      summary: {
        eventCount: 10,
        sawWebcamEvidence: false,
        sourceMediaDurations: {
          videoDurationSeconds: 512.531667,
          audioDurationSeconds: 483.637333,
          driftSeconds: 28.894,
          planAction: "reject",
          planReason: "unsafe-short-audio-mismatch",
          tempoRatio: 1,
          toleranceSeconds: 0.05,
          preferredAudioSource: "embedded",
          preferredAudioPaths: ["/tmp/recording-123.mp4"],
        },
        companionAudioDurations: [
          {
            trackKind: "mic",
            audioPath: "/tmp/recording-123.mic.wav",
            videoDurationSeconds: 512.531667,
            audioDurationSeconds: 483.637333,
            driftSeconds: 28.894,
            planAction: "reject",
            planReason: "unsafe-short-audio-mismatch",
            tempoRatio: 1,
            toleranceSeconds: 0.05,
          },
        ],
        audioContinuityRepairs: {
          count: 1,
          totalBuffers: 12,
          totalDurationSeconds: 0.256,
          firstTargetPtsSeconds: 14.2,
          lastTargetPtsSeconds: 14.2,
          first: { targetPts: 14.2 },
          last: { targetPts: 14.2 },
        },
        webcamContinuityRepairs: {
          count: 1,
          totalFrames: 9,
          totalDurationSeconds: 0.3,
          firstTargetPtsSeconds: 5.3,
          lastTargetPtsSeconds: 5.3,
          first: { targetPts: 5.3 },
          last: { targetPts: 5.3 },
        },
        nativeMicrophone: {
          requested: true,
          firstBufferWritten: false,
          unavailable: false,
          deviceEvent: { requestedDeviceId: "default" },
          firstBuffer: null,
        },
      },
    } as never);

    expect(result.summary.sourceMediaDurations).toMatchObject({
      videoDurationSeconds: 512.531667,
      audioDurationSeconds: 483.637333,
      driftSeconds: 28.894,
      preferredAudioSource: "embedded",
    });
    expect(result.summary.companionAudioDurations).toEqual([
      expect.objectContaining({
        audioPath: "/tmp/recording-123.mic.wav",
        driftSeconds: 28.894,
        planAction: "reject",
      }),
    ]);
    expect(result.summary.nativeMicrophone).toMatchObject({
      requested: true,
      firstBufferWritten: false,
      unavailable: false,
    });
    expect(result.summary.audioContinuityRepairs).toMatchObject({
      count: 1,
      totalBuffers: 12,
      totalDurationSeconds: 0.256,
      firstTargetPtsSeconds: 14.2,
    });
    expect(result.summary.webcamContinuityRepairs).toMatchObject({
      count: 1,
      totalFrames: 9,
      totalDurationSeconds: 0.3,
      firstTargetPtsSeconds: 5.3,
    });
  });

  it("returns a successful summarized audit when final media passes", async () => {
    const audit = { status: "pass" };
    const result = await auditFinalizedRecordingForRenderer(
      "/tmp/recording-123.mp4",
      {
        auditAndRecordFinalizedRecording: vi.fn(async () => audit as never),
        assertRecordingRunAuditPassed: vi.fn(),
        summarizeRecordingAuditForIpc: vi.fn(
          () => ({ ...summarizedAudit, status: "pass", issues: [] }) as never,
        ),
      },
    );

    expect(result).toMatchObject({
      success: true,
      recordingAudit: { status: "pass", issues: [] },
    });
  });

  it("returns the failed audit payload when final media fails safety verification", async () => {
    const audit = { status: "fail" };
    const result = await auditFinalizedRecordingForRenderer(
      "/tmp/recording-123.mp4",
      {
        auditAndRecordFinalizedRecording: vi.fn(async () => audit as never),
        assertRecordingRunAuditPassed: vi.fn(() => {
          throw new Error("Recording companion audio is missing.");
        }),
        summarizeRecordingAuditForIpc: vi.fn(() => summarizedAudit as never),
      },
    );

    expect(result).toMatchObject({
      success: false,
      error: "Recording companion audio is missing.",
      recordingAudit: summarizedAudit,
    });
  });
});

describe("finalizeStoredVideoWithSourceAudioSync", () => {
  it("repairs or rejects embedded source audio before finalizing an existing recording", async () => {
    const videoPath = "/tmp/recordly/recording-123.mp4";
    const repairRecordingSourceAudioSync = vi.fn(async () => undefined);
    const finalizeStoredVideo = vi.fn(async () => ({
      success: true,
      path: videoPath,
      message: "Video stored successfully",
    }));

    const result = await finalizeStoredVideoWithSourceAudioSync(videoPath, {
      repairRecordingSourceAudioSync,
      finalizeStoredVideo,
    });

    expect(result.success).toBe(true);
    expect(repairRecordingSourceAudioSync).toHaveBeenCalledWith(videoPath);
    expect(finalizeStoredVideo).toHaveBeenCalledWith(videoPath);
    expect(
      repairRecordingSourceAudioSync.mock.invocationCallOrder[0],
    ).toBeLessThan(finalizeStoredVideo.mock.invocationCallOrder[0]);
  });

  it("does not finalize an existing recording when source audio sync repair rejects", async () => {
    const videoPath = "/tmp/recordly/recording-123.mp4";
    const repairError = new Error(
      "Recording source audio/video mismatch is too large",
    );
    const finalizeStoredVideo = vi.fn();

    await expect(
      finalizeStoredVideoWithSourceAudioSync(videoPath, {
        repairRecordingSourceAudioSync: vi.fn(async () => {
          throw repairError;
        }),
        finalizeStoredVideo,
      }),
    ).rejects.toThrow("Recording source audio/video mismatch is too large");

    expect(finalizeStoredVideo).not.toHaveBeenCalled();
  });
});

describe("storeRecordedVideoWithSourceAudioSync", () => {
  it("repairs or rejects embedded source audio before finalizing a browser recording", async () => {
    const videoPath = "/tmp/recordly/recording-123.webm";
    const writeFile = vi.fn(async () => undefined);
    const repairRecordingSourceAudioSync = vi.fn(async () => undefined);
    const finalizeStoredVideo = vi.fn(async () => ({
      success: true,
      path: videoPath,
      message: "Video stored successfully",
    }));

    const result = await storeRecordedVideoWithSourceAudioSync(
      new Uint8Array([1, 2, 3]).buffer,
      path.basename(videoPath),
      {
        getRecordingsDir: async () => path.dirname(videoPath),
        writeFile,
        repairRecordingSourceAudioSync,
        finalizeStoredVideo,
      },
    );

    expect(result.success).toBe(true);
    expect(writeFile).toHaveBeenCalledWith(
      videoPath,
      Buffer.from(new Uint8Array([1, 2, 3]).buffer),
    );
    expect(repairRecordingSourceAudioSync).toHaveBeenCalledWith(videoPath);
    expect(finalizeStoredVideo).toHaveBeenCalledWith(videoPath);
    expect(
      repairRecordingSourceAudioSync.mock.invocationCallOrder[0],
    ).toBeLessThan(finalizeStoredVideo.mock.invocationCallOrder[0]);
  });

  it("does not finalize browser recordings when source audio sync repair rejects", async () => {
    const videoPath = "/tmp/recordly/recording-123.webm";
    const repairError = new Error(
      "Recording source audio/video mismatch is too large",
    );
    const finalizeStoredVideo = vi.fn();

    await expect(
      storeRecordedVideoWithSourceAudioSync(
        new Uint8Array([1, 2, 3]).buffer,
        "recording-123.webm",
        {
          getRecordingsDir: async () => path.dirname(videoPath),
          writeFile: vi.fn(async () => undefined),
          repairRecordingSourceAudioSync: vi.fn(async () => {
            throw repairError;
          }),
          finalizeStoredVideo,
        },
      ),
    ).rejects.toThrow("Recording source audio/video mismatch is too large");

    expect(finalizeStoredVideo).not.toHaveBeenCalled();
  });
});
