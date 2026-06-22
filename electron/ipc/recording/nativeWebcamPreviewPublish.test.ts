import { describe, expect, it, vi } from "vitest";
import { publishNativeWebcamProofPreviewFrame } from "./nativeWebcamPreviewPublish";

describe("publishNativeWebcamProofPreviewFrame", () => {
	it("accepts proof-preview only after the MJPEG stream publishes the frame", () => {
		const publishFrame = vi.fn(() => true);

		expect(
			publishNativeWebcamProofPreviewFrame({
				streamId: "stream-1",
				framePath: "/tmp/webcam-preview-0.jpg",
				sequence: 12,
				publishFrame,
			}),
		).toEqual({ accepted: true });
		expect(publishFrame).toHaveBeenCalledWith("stream-1", "/tmp/webcam-preview-0.jpg", 12);
	});

	it("rejects proof-preview when publishing fails so stale MJPEG frames cannot look live", () => {
		const publishFrame = vi.fn(() => false);

		expect(
			publishNativeWebcamProofPreviewFrame({
				streamId: "stream-1",
				framePath: "/tmp/webcam-preview-0.jpg",
				sequence: 13,
				publishFrame,
			}),
		).toEqual({
			accepted: false,
			reason: "mjpeg-preview-publish-failed",
			details: {
				streamId: "stream-1",
				framePath: "/tmp/webcam-preview-0.jpg",
				sequence: 13,
			},
		});
	});

	it("rejects proof-preview when the stream id is missing", () => {
		const publishFrame = vi.fn(() => true);

		expect(
			publishNativeWebcamProofPreviewFrame({
				streamId: null,
				framePath: "/tmp/webcam-preview-0.jpg",
				sequence: 14,
				publishFrame,
			}),
		).toEqual({
			accepted: false,
			reason: "mjpeg-preview-publish-failed",
			details: {
				streamId: null,
				framePath: "/tmp/webcam-preview-0.jpg",
				sequence: 14,
			},
		});
		expect(publishFrame).not.toHaveBeenCalled();
	});
});
