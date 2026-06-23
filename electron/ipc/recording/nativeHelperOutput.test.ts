import { describe, expect, it } from "vitest";
import { parseNativeHelperOutputLine } from "./nativeHelperOutput";

describe("parseNativeHelperOutputLine", () => {
  it("parses native screen downscale diagnostics", () => {
    expect(
      parseNativeHelperOutputLine(
        "VIDEO_OUTPUT_DOWNSCALED sourceWidth=3420 sourceHeight=2214 outputWidth=2386 outputHeight=1544 scale=0.6977",
      ),
    ).toEqual({
      event: "native-screen-output-downscaled",
      severity: "info",
      details: {
        sourceWidth: 3420,
        sourceHeight: 2214,
        outputWidth: 2386,
        outputHeight: 1544,
        scale: 0.6977,
      },
    });
  });

  it("parses webcam capture started labels with spaces", () => {
    expect(
      parseNativeHelperOutputLine(
        "WEBCAM_CAPTURE_STARTED label=Justmaiko's iPhone Camera path=/tmp/recording-webcam.mp4",
      ),
    ).toEqual({
      event: "native-webcam-capture-started",
      severity: "info",
      details: {
        label: "Justmaiko's iPhone Camera",
        path: "/tmp/recording-webcam.mp4",
      },
    });
  });

  it("parses the native capture gate opening after requested sources are prepared", () => {
    expect(
      parseNativeHelperOutputLine(
        "CAPTURE_GATE_OPENED capturesWebcam=true hostTime=123.456",
      ),
    ).toEqual({
      event: "native-capture-gate-opened",
      severity: "info",
      details: {
        capturesWebcam: "true",
        hostTime: 123.456,
      },
    });
  });

  it("parses native microphone resolution evidence", () => {
    expect(
      parseNativeHelperOutputLine(
        'MICROPHONE_CAPTURE_DEVICE_RESOLVED requestedLabel="Wireless microphone" requestedDeviceId="browser-hash" resolvedDeviceId="AppleUSBAudioEngine:Wireless microphone:123"',
      ),
    ).toEqual({
      event: "native-microphone-device-resolved",
      severity: "info",
      details: {
        requestedLabel: "Wireless microphone",
        requestedDeviceId: "browser-hash",
        resolvedDeviceId: "AppleUSBAudioEngine:Wireless microphone:123",
      },
    });

    expect(
      parseNativeHelperOutputLine(
        'MICROPHONE_CAPTURE_DEVICE_DEFAULT requestedLabel="" requestedDeviceId="stale-browser-hash" available="MacBook Air Microphone [BuiltInMicrophoneDevice]"',
      ),
    ).toMatchObject({
      event: "native-microphone-device-default",
      severity: "warning",
      details: {
        requestedLabel: "",
        requestedDeviceId: "stale-browser-hash",
        available: "MacBook Air Microphone [BuiltInMicrophoneDevice]",
      },
    });
  });

  it("marks missing selected webcam as a renderer-visible error", () => {
    expect(
      parseNativeHelperOutputLine(
        'WEBCAM_DEVICE_NOT_FOUND requestedLabel="Definitely Missing Camera" requestedDeviceId="" available="MacBook Air Camera [6C707041-05AC-0011-0004-000000000001]"',
      ),
    ).toMatchObject({
      event: "native-webcam-device-not-found",
      severity: "error",
      details: {
        requestedLabel: "Definitely Missing Camera",
        requestedDeviceId: "",
        available: "MacBook Air Camera [6C707041-05AC-0011-0004-000000000001]",
      },
    });
  });

  it("parses native webcam first visible-frame diagnostics", () => {
    expect(
      parseNativeHelperOutputLine(
        "WEBCAM_FIRST_VISIBLE_FRAME_WRITTEN frames=2 pts=0.066 averageLuma=12.5 maxLuma=88",
      ),
    ).toEqual({
      event: "native-webcam-first-visible-frame-written",
      severity: "info",
      details: {
        frames: 2,
        pts: 0.066,
        averageLuma: 12.5,
        maxLuma: 88,
      },
    });
  });

  it("parses native microphone writer finalization as healthy only when buffers were written", () => {
    expect(
      parseNativeHelperOutputLine(
        'MICROPHONE_RECORDING_FINALIZED path="/tmp/recording-123.mic.m4a" writerStatus=completed buffers=321 duration=12.4 lastPts=12.377',
      ),
    ).toEqual({
      event: "native-microphone-recording-finalized",
      severity: "info",
      details: {
        path: "/tmp/recording-123.mic.m4a",
        writerStatus: "completed",
        buffers: 321,
        duration: 12.4,
        lastPts: 12.377,
      },
    });

    expect(
      parseNativeHelperOutputLine(
        'MICROPHONE_RECORDING_FINALIZED path="/tmp/recording-123.mic.m4a" writerStatus=failed buffers=0 duration=0 lastPts=-1 errorDescription="writer failed"',
      ),
    ).toMatchObject({
      event: "native-microphone-recording-finalized-unhealthy",
      severity: "error",
      notifyRenderer: true,
      details: {
        writerStatus: "failed",
        buffers: 0,
      },
    });
  });

  it("marks webcam pipeline stalls as fatal renderer-visible degradation", () => {
    expect(
      parseNativeHelperOutputLine(
        "WEBCAM_PIPELINE_STALLED reason=webcam-input-not-ready stalledFor=5.1 hostTime=123 action=stop-recording",
      ),
    ).toMatchObject({
      event: "native-webcam-pipeline-stalled",
      severity: "error",
      details: {
        reason: "webcam-input-not-ready",
        stalledFor: 5.1,
        hostTime: 123,
        action: "stop-recording",
      },
      notifyRenderer: true,
    });
  });

  it("marks disabled webcam capture as fatal renderer-visible degradation", () => {
    expect(
      parseNativeHelperOutputLine(
        "WEBCAM_CAPTURE_DISABLED reason=main-webcam-stats-timeout staleForMs=15000",
      ),
    ).toMatchObject({
      event: "native-webcam-capture-disabled",
      severity: "error",
      details: {
        reason: "main-webcam-stats-timeout",
        staleForMs: 15000,
      },
      notifyRenderer: true,
    });
  });

  it("parses native webcam visual-stall diagnostics", () => {
    expect(
      parseNativeHelperOutputLine(
        "WEBCAM_VISUAL_STALL_SUSPECTED stalledFor=8.01 meanDiff=0.12",
      ),
    ).toMatchObject({
      event: "native-webcam-visual-stall-suspected",
      severity: "warning",
      details: {
        stalledFor: 8.01,
        meanDiff: 0.12,
      },
    });

    expect(
      parseNativeHelperOutputLine("WEBCAM_VISUAL_STALL_RECOVERED meanDiff=4.5"),
    ).toMatchObject({
      event: "native-webcam-visual-stall-recovered",
      severity: "info",
      details: {
        meanDiff: 4.5,
      },
      notifyRenderer: true,
    });
  });

  it("marks sustained native webcam visual stalls as fatal pipeline stalls", () => {
    expect(
      parseNativeHelperOutputLine(
        "WEBCAM_PIPELINE_STALLED reason=webcam-visual-stall stalledFor=30.2 hostTime=991 action=stop-recording",
      ),
    ).toMatchObject({
      event: "native-webcam-pipeline-stalled",
      severity: "error",
      details: {
        reason: "webcam-visual-stall",
        stalledFor: 30.2,
        hostTime: 991,
        action: "stop-recording",
      },
      notifyRenderer: true,
    });
  });

  it("parses native first-frame writer evidence", () => {
    expect(
      parseNativeHelperOutputLine(
        "VIDEO_FIRST_FRAME_WRITTEN frames=1 realFrames=1 holdFrames=0 pts=0.033",
      ),
    ).toEqual({
      event: "native-video-first-frame-written",
      severity: "info",
      details: {
        frames: 1,
        realFrames: 1,
        holdFrames: 0,
        pts: 0.033,
      },
    });

    expect(
      parseNativeHelperOutputLine(
        "WEBCAM_FIRST_FRAME_WRITTEN frames=1 pts=0.0",
      ),
    ).toEqual({
      event: "native-webcam-first-frame-written",
      severity: "info",
      details: {
        frames: 1,
        pts: 0,
      },
    });
  });

  it("parses native video capture cadence stats", () => {
    expect(
      parseNativeHelperOutputLine(
        "VIDEO_CAPTURE_STATS frames=300 realFrames=290 holdFrames=10 elapsed=10.0 recentFps=29.8 totalFps=30.0 lastPts=9.96",
      ),
    ).toEqual({
      event: "native-video-capture-stats",
      severity: "info",
      details: {
        frames: 300,
        realFrames: 290,
        holdFrames: 10,
        elapsed: 10,
        recentFps: 29.8,
        totalFps: 30,
        lastPts: 9.96,
      },
    });
  });

  it("parses healthy native webcam capture cadence stats", () => {
    expect(
      parseNativeHelperOutputLine(
        "WEBCAM_CAPTURE_STATS frames=150 elapsed=5.0 recentFps=29.9 totalFps=30.0 lastPts=4.96",
      ),
    ).toEqual({
      event: "native-webcam-capture-stats",
      severity: "info",
      details: {
        frames: 150,
        elapsed: 5,
        recentFps: 29.9,
        totalFps: 30,
        lastPts: 4.96,
      },
    });
  });

  it("parses native webcam hold-frame continuity evidence", () => {
    expect(
      parseNativeHelperOutputLine(
        "WEBCAM_HOLD_FRAMES_INSERTED frames=9 totalFrames=159 holdFrames=9 duration=0.3 targetPts=5.3 lastPts=5.266667",
      ),
    ).toEqual({
      event: "native-webcam-hold-frames-inserted",
      severity: "info",
      details: {
        frames: 9,
        totalFrames: 159,
        holdFrames: 9,
        duration: 0.3,
        targetPts: 5.3,
        lastPts: 5.266667,
      },
    });
  });

  it("parses native microphone audio health diagnostics", () => {
    expect(
      parseNativeHelperOutputLine("MICROPHONE_CAPTURE_UNAVAILABLE"),
    ).toEqual({
      event: "native-microphone-capture-unavailable",
      severity: "warning",
      details: {},
      notifyRenderer: true,
      message:
        "Native microphone capture is unavailable. Recordly will use the browser microphone fallback.",
    });

    expect(
      parseNativeHelperOutputLine(
        "MICROPHONE_AUDIO_FIRST_BUFFER_WRITTEN buffers=1 pts=0.021 duration=0.021",
      ),
    ).toEqual({
      event: "native-microphone-audio-first-buffer-written",
      severity: "info",
      details: {
        buffers: 1,
        pts: 0.021,
        duration: 0.021,
      },
    });

    expect(
      parseNativeHelperOutputLine(
        "AUDIO_CAPTURE_STATS microphoneBuffers=250 inlineBuffers=250 elapsed=5.0 recentBuffersPerSecond=50 totalBuffersPerSecond=50 lastMicPts=4.98 lastInlinePts=4.98 audioVideoDrift=0.02",
      ),
    ).toEqual({
      event: "native-audio-capture-stats",
      severity: "info",
      details: {
        microphoneBuffers: 250,
        inlineBuffers: 250,
        elapsed: 5,
        recentBuffersPerSecond: 50,
        totalBuffersPerSecond: 50,
        lastMicPts: 4.98,
        lastInlinePts: 4.98,
        audioVideoDrift: 0.02,
      },
    });

    expect(
      parseNativeHelperOutputLine(
        "AUDIO_PIPELINE_STALLED reason=microphone-audio-lagging-video stalledFor=5.3 audioVideoDrift=5.3 audioEnd=483.6 videoEnd=488.9 action=stop-recording",
      ),
    ).toMatchObject({
      event: "native-audio-pipeline-stalled",
      severity: "error",
      details: {
        reason: "microphone-audio-lagging-video",
        stalledFor: 5.3,
        audioVideoDrift: 5.3,
        audioEnd: 483.6,
        videoEnd: 488.9,
        action: "stop-recording",
      },
      notifyRenderer: true,
    });
  });

  it("logs low native webcam capture cadence without immediately warning the renderer", () => {
    expect(
      parseNativeHelperOutputLine(
        "WEBCAM_CAPTURE_STATS frames=20 elapsed=10.0 recentFps=3.5 totalFps=2.0 lastPts=9.5",
      ),
    ).toEqual({
      event: "native-webcam-capture-low-cadence",
      severity: "warning",
      details: {
        frames: 20,
        elapsed: 10,
        recentFps: 3.5,
        totalFps: 2,
        lastPts: 9.5,
      },
    });

    expect(
      parseNativeHelperOutputLine(
        "AUDIO_SILENCE_INSERTED track=mic buffers=12 duration=0.256 totalInserted=0.256 targetPts=14.2 nextPts=14.186667",
      ),
    ).toEqual({
      event: "native-audio-silence-inserted",
      severity: "info",
      details: {
        track: "mic",
        buffers: 12,
        duration: 0.256,
        totalInserted: 0.256,
        targetPts: 14.2,
        nextPts: 14.186667,
      },
    });
  });

  it("parses final native writer summaries", () => {
    expect(
      parseNativeHelperOutputLine(
        'VIDEO_RECORDING_FINALIZED path="/Users/me/Recordly Captures/recording-1.mp4" writerStatus=completed frames=3600 realFrames=3590 holdFrames=10 duration=120.0 lastPts=119.966',
      ),
    ).toEqual({
      event: "native-video-recording-finalized",
      severity: "info",
      details: {
        path: "/Users/me/Recordly Captures/recording-1.mp4",
        writerStatus: "completed",
        frames: 3600,
        realFrames: 3590,
        holdFrames: 10,
        duration: 120,
        lastPts: 119.966,
      },
    });

    expect(
      parseNativeHelperOutputLine(
        'WEBCAM_RECORDING_FINALIZED path="/Users/me/Recordly Captures/recording-1-webcam.mp4" writerStatus=completed frames=3600 duration=120.0 lastPts=119.966',
      ),
    ).toEqual({
      event: "native-webcam-recording-finalized",
      severity: "info",
      details: {
        path: "/Users/me/Recordly Captures/recording-1-webcam.mp4",
        writerStatus: "completed",
        frames: 3600,
        duration: 120,
        lastPts: 119.966,
      },
    });
  });

  it("parses native webcam proof-preview frames", () => {
    expect(
      parseNativeHelperOutputLine(
        'WEBCAM_PREVIEW_FRAME_WRITTEN path="/Users/me/Application Support/Recordly/recording-preview-1.jpg" bytes=12345 hostTime=456.7 sequence=9 acceptedFrame=42 acceptedPts=1.366',
      ),
    ).toEqual({
      event: "native-webcam-preview-frame-written",
      severity: "info",
      details: {
        path: "/Users/me/Application Support/Recordly/recording-preview-1.jpg",
        bytes: 12345,
        hostTime: 456.7,
        sequence: 9,
        acceptedFrame: 42,
        acceptedPts: 1.366,
      },
    });

    expect(
      parseNativeHelperOutputLine(
        "WEBCAM_PREVIEW_FRAME_COPY_FAILED hostTime=456.7 acceptedFrame=42 acceptedPts=1.366",
      ),
    ).toEqual({
      event: "native-webcam-preview-frame-copy-failed",
      severity: "warning",
      details: {
        hostTime: 456.7,
        acceptedFrame: 42,
        acceptedPts: 1.366,
      },
    });
  });

  it("parses native webcam preflight visible-frame readiness", () => {
    expect(
      parseNativeHelperOutputLine(
        "WEBCAM_PREFLIGHT_VISIBLE_FRAME_READY frames=3 hostTime=100.45 averageLuma=12.5 maxLuma=88",
      ),
    ).toEqual({
      event: "native-webcam-preflight-visible-frame-ready",
      severity: "info",
      details: {
        frames: 3,
        hostTime: 100.45,
        averageLuma: 12.5,
        maxLuma: 88,
      },
    });
  });

  it("parses screen pipeline stalls as fatal degradation", () => {
    expect(
      parseNativeHelperOutputLine(
        'VIDEO_STREAM_STOPPED_WITH_ERROR message="stream disconnected"',
      ),
    ).toMatchObject({
      event: "native-video-stream-stopped-with-error",
      severity: "error",
      details: {
        message: "stream disconnected",
      },
      notifyRenderer: true,
    });

    expect(
      parseNativeHelperOutputLine(
        "VIDEO_PIPELINE_STALLED reason=video-keepalive-append-failed lag=5.17 stalledFor=5.17",
      ),
    ).toMatchObject({
      event: "native-video-pipeline-stalled",
      severity: "error",
      details: {
        reason: "video-keepalive-append-failed",
        lag: 5.17,
        stalledFor: 5.17,
      },
      notifyRenderer: true,
    });
  });

  it("parses final video keep-alive diagnostics", () => {
    expect(
      parseNativeHelperOutputLine(
        "FINAL_VIDEO_KEEPALIVE_APPENDED wallClockEnd=120.5",
      ),
    ).toEqual({
      event: "native-final-video-keepalive-appended",
      severity: "info",
      details: {
        wallClockEnd: 120.5,
      },
    });

    expect(
      parseNativeHelperOutputLine(
        "FINAL_VIDEO_KEEPALIVE_APPEND_TIMEOUT wallClockEnd=120.5",
      ),
    ).toMatchObject({
      event: "native-final-video-keepalive-append-timeout",
      severity: "warning",
      details: {
        wallClockEnd: 120.5,
      },
      notifyRenderer: true,
    });

    expect(
      parseNativeHelperOutputLine(
        "FINAL_VIDEO_KEEPALIVE_SKIPPED_AT_STOP wallClockEnd=12.5 videoEnd=11.9 reason=avoid-final-append-corruption",
      ),
    ).toEqual({
      event: "native-final-video-keepalive-skipped-at-stop",
      severity: "info",
      details: {
        wallClockEnd: 12.5,
        videoEnd: 11.9,
        reason: "avoid-final-append-corruption",
      },
    });
  });

  it("ignores unrelated helper chatter", () => {
    expect(parseNativeHelperOutputLine("Recording started")).toBeNull();
  });
});
