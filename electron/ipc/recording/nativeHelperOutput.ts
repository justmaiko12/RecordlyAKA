export type NativeHelperOutputSeverity = "info" | "warning" | "error";

export type NativeHelperOutputEvent = {
  event: string;
  severity: NativeHelperOutputSeverity;
  details: Record<string, unknown>;
  notifyRenderer?: boolean;
  message?: string;
};

const MIN_NATIVE_WEBCAM_RECENT_FPS = 10;

function parseScalar(value: string) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && value.trim() !== "" ? numeric : value;
}

function parseKeyValueTail(tail: string) {
  const details: Record<string, unknown> = {};
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

function getFiniteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseWebcamCaptureStarted(
  line: string,
): NativeHelperOutputEvent | null {
  const pathMarker = " path=";
  const labelMarker = "label=";
  const labelStart = line.indexOf(labelMarker);
  const pathStart = line.indexOf(pathMarker);
  if (labelStart < 0 || pathStart < 0 || pathStart <= labelStart) {
    return null;
  }

  return {
    event: "native-webcam-capture-started",
    severity: "info",
    details: {
      label: line.slice(labelStart + labelMarker.length, pathStart),
      path: line.slice(pathStart + pathMarker.length),
    },
  };
}

export function parseNativeHelperOutputLine(
  line: string,
): NativeHelperOutputEvent | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith("VIDEO_OUTPUT_DOWNSCALED ")) {
    return {
      event: "native-screen-output-downscaled",
      severity: "info",
      details: parseKeyValueTail(
        trimmed.slice("VIDEO_OUTPUT_DOWNSCALED ".length),
      ),
    };
  }

  if (trimmed.startsWith("VIDEO_OUTPUT_NATIVE ")) {
    return {
      event: "native-screen-output-native",
      severity: "info",
      details: parseKeyValueTail(trimmed.slice("VIDEO_OUTPUT_NATIVE ".length)),
    };
  }

  if (trimmed.startsWith("WEBCAM_CAPTURE_STARTED ")) {
    return parseWebcamCaptureStarted(trimmed);
  }

  if (trimmed.startsWith("MICROPHONE_CAPTURE_DEVICE_RESOLVED ")) {
    return {
      event: "native-microphone-device-resolved",
      severity: "info",
      details: parseKeyValueTail(
        trimmed.slice("MICROPHONE_CAPTURE_DEVICE_RESOLVED ".length),
      ),
    };
  }

  if (trimmed.startsWith("MICROPHONE_CAPTURE_DEVICE_DEFAULT ")) {
    return {
      event: "native-microphone-device-default",
      severity: "warning",
      details: parseKeyValueTail(
        trimmed.slice("MICROPHONE_CAPTURE_DEVICE_DEFAULT ".length),
      ),
      message:
        "Recordly could not resolve the selected microphone natively and used the macOS default input.",
    };
  }

  if (trimmed === "MICROPHONE_CAPTURE_UNAVAILABLE") {
    return {
      event: "native-microphone-capture-unavailable",
      severity: "warning",
      details: {},
      notifyRenderer: true,
      message:
        "Native microphone capture is unavailable. Recordly will use the browser microphone fallback.",
    };
  }

  if (trimmed.startsWith("CAPTURE_GATE_OPENED ")) {
    return {
      event: "native-capture-gate-opened",
      severity: "info",
      details: parseKeyValueTail(trimmed.slice("CAPTURE_GATE_OPENED ".length)),
    };
  }

  if (trimmed.startsWith("WEBCAM_DEVICE_NOT_FOUND ")) {
    return {
      event: "native-webcam-device-not-found",
      severity: "error",
      details: parseKeyValueTail(
        trimmed.slice("WEBCAM_DEVICE_NOT_FOUND ".length),
      ),
      notifyRenderer: true,
      message:
        "Recordly could not find the selected webcam. Re-select the camera before recording.",
    };
  }

  if (trimmed.startsWith("VIDEO_FIRST_FRAME_WRITTEN ")) {
    return {
      event: "native-video-first-frame-written",
      severity: "info",
      details: parseKeyValueTail(
        trimmed.slice("VIDEO_FIRST_FRAME_WRITTEN ".length),
      ),
    };
  }

  if (trimmed.startsWith("WEBCAM_FIRST_FRAME_WRITTEN ")) {
    return {
      event: "native-webcam-first-frame-written",
      severity: "info",
      details: parseKeyValueTail(
        trimmed.slice("WEBCAM_FIRST_FRAME_WRITTEN ".length),
      ),
    };
  }

  if (trimmed.startsWith("WEBCAM_FIRST_VISIBLE_FRAME_WRITTEN ")) {
    return {
      event: "native-webcam-first-visible-frame-written",
      severity: "info",
      details: parseKeyValueTail(
        trimmed.slice("WEBCAM_FIRST_VISIBLE_FRAME_WRITTEN ".length),
      ),
    };
  }

  if (trimmed.startsWith("WEBCAM_PREFLIGHT_VISIBLE_FRAME_READY ")) {
    return {
      event: "native-webcam-preflight-visible-frame-ready",
      severity: "info",
      details: parseKeyValueTail(
        trimmed.slice("WEBCAM_PREFLIGHT_VISIBLE_FRAME_READY ".length),
      ),
    };
  }

  if (trimmed.startsWith("VIDEO_CAPTURE_STATS ")) {
    return {
      event: "native-video-capture-stats",
      severity: "info",
      details: parseKeyValueTail(trimmed.slice("VIDEO_CAPTURE_STATS ".length)),
    };
  }

  if (trimmed.startsWith("WEBCAM_CAPTURE_STATS ")) {
    const details = parseKeyValueTail(
      trimmed.slice("WEBCAM_CAPTURE_STATS ".length),
    );
    const recentFps = getFiniteNumber(details.recentFps);
    const lowCadence =
      recentFps !== null && recentFps < MIN_NATIVE_WEBCAM_RECENT_FPS;
    return {
      event: lowCadence
        ? "native-webcam-capture-low-cadence"
        : "native-webcam-capture-stats",
      severity: lowCadence ? "warning" : "info",
      details,
    };
  }

  if (trimmed.startsWith("MICROPHONE_AUDIO_FIRST_BUFFER_WRITTEN ")) {
    return {
      event: "native-microphone-audio-first-buffer-written",
      severity: "info",
      details: parseKeyValueTail(
        trimmed.slice("MICROPHONE_AUDIO_FIRST_BUFFER_WRITTEN ".length),
      ),
    };
  }

  if (trimmed.startsWith("AUDIO_CAPTURE_STATS ")) {
    return {
      event: "native-audio-capture-stats",
      severity: "info",
      details: parseKeyValueTail(trimmed.slice("AUDIO_CAPTURE_STATS ".length)),
    };
  }

  if (trimmed.startsWith("AUDIO_PIPELINE_STALLED ")) {
    return {
      event: "native-audio-pipeline-stalled",
      severity: "error",
      details: parseKeyValueTail(
        trimmed.slice("AUDIO_PIPELINE_STALLED ".length),
      ),
      notifyRenderer: true,
      message:
        "Microphone audio stalled while video kept recording. Recordly stopped the take instead of saving an out-of-sync recording.",
    };
  }

  if (trimmed.startsWith("VIDEO_RECORDING_FINALIZED ")) {
    return {
      event: "native-video-recording-finalized",
      severity: "info",
      details: parseKeyValueTail(
        trimmed.slice("VIDEO_RECORDING_FINALIZED ".length),
      ),
    };
  }

  if (trimmed.startsWith("WEBCAM_RECORDING_FINALIZED ")) {
    return {
      event: "native-webcam-recording-finalized",
      severity: "info",
      details: parseKeyValueTail(
        trimmed.slice("WEBCAM_RECORDING_FINALIZED ".length),
      ),
    };
  }

  if (trimmed.startsWith("MICROPHONE_RECORDING_FINALIZED ")) {
    const details = parseKeyValueTail(
      trimmed.slice("MICROPHONE_RECORDING_FINALIZED ".length),
    );
    const buffers = getFiniteNumber(details.buffers);
    const writerStatus =
      typeof details.writerStatus === "string" ? details.writerStatus : "";
    const unhealthy =
      writerStatus !== "completed" || buffers === null || buffers <= 0;
    return {
      event: unhealthy
        ? "native-microphone-recording-finalized-unhealthy"
        : "native-microphone-recording-finalized",
      severity: unhealthy ? "error" : "info",
      details,
      ...(unhealthy
        ? {
            notifyRenderer: true,
            message:
              "Native microphone recording finalized without a healthy audio sidecar.",
          }
        : {}),
    };
  }

  if (trimmed.startsWith("WEBCAM_PREVIEW_FRAME_WRITTEN ")) {
    return {
      event: "native-webcam-preview-frame-written",
      severity: "info",
      details: parseKeyValueTail(
        trimmed.slice("WEBCAM_PREVIEW_FRAME_WRITTEN ".length),
      ),
    };
  }

  if (trimmed.startsWith("WEBCAM_PREVIEW_FRAME_WRITE_FAILED ")) {
    return {
      event: "native-webcam-preview-frame-write-failed",
      severity: "warning",
      details: parseKeyValueTail(
        trimmed.slice("WEBCAM_PREVIEW_FRAME_WRITE_FAILED ".length),
      ),
    };
  }

  if (trimmed.startsWith("WEBCAM_PREVIEW_FRAME_COPY_FAILED ")) {
    return {
      event: "native-webcam-preview-frame-copy-failed",
      severity: "warning",
      details: parseKeyValueTail(
        trimmed.slice("WEBCAM_PREVIEW_FRAME_COPY_FAILED ".length),
      ),
    };
  }

  if (trimmed.startsWith("WEBCAM_INPUT_NOT_READY ")) {
    return {
      event: "native-webcam-input-not-ready",
      severity: "warning",
      details: parseKeyValueTail(
        trimmed.slice("WEBCAM_INPUT_NOT_READY ".length),
      ),
    };
  }

  if (trimmed.startsWith("WEBCAM_PIPELINE_STALLED ")) {
    const details = parseKeyValueTail(
      trimmed.slice("WEBCAM_PIPELINE_STALLED ".length),
    );
    return {
      event: "native-webcam-pipeline-stalled",
      severity: "error",
      details,
      notifyRenderer: true,
      message:
        "Webcam capture stalled. Recordly stopped the recording instead of saving frozen or missing facecam footage.",
    };
  }

  if (trimmed.startsWith("WEBCAM_CAPTURE_DISABLED ")) {
    const details = parseKeyValueTail(
      trimmed.slice("WEBCAM_CAPTURE_DISABLED ".length),
    );
    return {
      event: "native-webcam-capture-disabled",
      severity: "error",
      details,
      notifyRenderer: true,
      message:
        "Webcam capture was disabled. Recordly stopped the recording instead of continuing as a screen-only take.",
    };
  }

  if (trimmed.startsWith("WEBCAM_VISUAL_STALL_SUSPECTED ")) {
    return {
      event: "native-webcam-visual-stall-suspected",
      severity: "warning",
      details: parseKeyValueTail(
        trimmed.slice("WEBCAM_VISUAL_STALL_SUSPECTED ".length),
      ),
      message:
        "Native webcam image appears unusually still. Recordly is checking sustained camera liveness before trusting the take.",
    };
  }

  if (trimmed.startsWith("WEBCAM_VISUAL_STALL_RECOVERED ")) {
    return {
      event: "native-webcam-visual-stall-recovered",
      severity: "info",
      details: parseKeyValueTail(
        trimmed.slice("WEBCAM_VISUAL_STALL_RECOVERED ".length),
      ),
      notifyRenderer: true,
      message: "Native webcam image recovered.",
    };
  }

  if (trimmed.startsWith("VIDEO_STREAM_STOPPED_WITH_ERROR ")) {
    return {
      event: "native-video-stream-stopped-with-error",
      severity: "error",
      details: parseKeyValueTail(
        trimmed.slice("VIDEO_STREAM_STOPPED_WITH_ERROR ".length),
      ),
      notifyRenderer: true,
      message:
        "Screen capture stream stopped unexpectedly. Recordly is stopping the recording instead of extending stale frames.",
    };
  }

  if (trimmed.startsWith("VIDEO_PIPELINE_STALLED ")) {
    return {
      event: "native-video-pipeline-stalled",
      severity: "error",
      details: parseKeyValueTail(
        trimmed.slice("VIDEO_PIPELINE_STALLED ".length),
      ),
      notifyRenderer: true,
      message:
        "Screen recording stalled and was stopped to prevent a corrupted timeline.",
    };
  }

  if (trimmed.startsWith("VIDEO_PIXEL_BUFFER_APPEND_SKIPPED ")) {
    return {
      event: "native-video-pixel-buffer-append-skipped",
      severity: "error",
      details: parseKeyValueTail(
        trimmed.slice("VIDEO_PIXEL_BUFFER_APPEND_SKIPPED ".length),
      ),
    };
  }

  if (trimmed.startsWith("VIDEO_PIXEL_BUFFER_APPEND_FAILED ")) {
    return {
      event: "native-video-pixel-buffer-append-failed",
      severity: "error",
      details: parseKeyValueTail(
        trimmed.slice("VIDEO_PIXEL_BUFFER_APPEND_FAILED ".length),
      ),
    };
  }

  if (trimmed.startsWith("FINAL_VIDEO_KEEPALIVE_APPENDED ")) {
    return {
      event: "native-final-video-keepalive-appended",
      severity: "info",
      details: parseKeyValueTail(
        trimmed.slice("FINAL_VIDEO_KEEPALIVE_APPENDED ".length),
      ),
    };
  }

  if (trimmed.startsWith("FINAL_VIDEO_KEEPALIVE_APPEND_TIMEOUT ")) {
    return {
      event: "native-final-video-keepalive-append-timeout",
      severity: "warning",
      details: parseKeyValueTail(
        trimmed.slice("FINAL_VIDEO_KEEPALIVE_APPEND_TIMEOUT ".length),
      ),
      notifyRenderer: true,
      message:
        "Recordly could not append the final video keep-alive frame before closing the native recording.",
    };
  }

  if (trimmed.startsWith("FINAL_VIDEO_KEEPALIVE_SKIPPED_AT_STOP ")) {
    return {
      event: "native-final-video-keepalive-skipped-at-stop",
      severity: "info",
      details: parseKeyValueTail(
        trimmed.slice("FINAL_VIDEO_KEEPALIVE_SKIPPED_AT_STOP ".length),
      ),
    };
  }

  return null;
}
