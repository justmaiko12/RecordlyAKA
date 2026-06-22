import { describe, expect, it } from "vitest";
import {
	resolveNativeWebcamPreviewRendererIssueTarget,
	sanitizeNativeWebcamPreviewRendererIssuePayload,
} from "./rendererPreviewIssue";

describe("resolveNativeWebcamPreviewRendererIssueTarget", () => {
	it("derives the recording event log target from the active video path", () => {
		expect(
			resolveNativeWebcamPreviewRendererIssueTarget(
				"/Users/michael/Recordly/recording-12345.mp4",
			),
		).toEqual({
			recordingsDir: "/Users/michael/Recordly",
			sessionId: "12345",
		});

		expect(
			resolveNativeWebcamPreviewRendererIssueTarget("/Users/michael/Recordly/custom.mp4"),
		).toEqual({
			recordingsDir: "/Users/michael/Recordly",
			sessionId: "custom",
		});
	});

	it("rejects missing active video paths", () => {
		expect(resolveNativeWebcamPreviewRendererIssueTarget(null)).toBeNull();
		expect(resolveNativeWebcamPreviewRendererIssueTarget("")).toBeNull();
	});
});

describe("sanitizeNativeWebcamPreviewRendererIssuePayload", () => {
	it("keeps bounded JSON-safe preview issue details", () => {
		expect(
			sanitizeNativeWebcamPreviewRendererIssuePayload({
				surface: "teleprompter",
				issue: "visible-load-stale",
				previewUrl: "http://127.0.0.1/frame.jpg",
				visibleStartedAtMs: 1000,
				lastVisibleLoadAtMs: 1200,
				nowMs: 3500,
				recordingActive: true,
				details: {
					acceptedFrame: 42,
					healthy: false,
					ignored: { nested: true },
				},
			}),
		).toEqual({
			surface: "teleprompter",
			issue: "visible-load-stale",
			previewUrl: "http://127.0.0.1/frame.jpg",
			visibleStartedAtMs: 1000,
			lastVisibleLoadAtMs: 1200,
			nowMs: 3500,
			recordingActive: true,
			acceptedFrame: 42,
			healthy: false,
		});
	});

	it("falls back to unknown labels for malformed payloads", () => {
		expect(
			sanitizeNativeWebcamPreviewRendererIssuePayload({
				surface: "",
				issue: null,
				previewUrl: 123,
			}),
		).toEqual({
			surface: "unknown",
			issue: "unknown",
		});
	});
});
