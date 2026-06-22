import { afterEach, describe, expect, it, vi } from "vitest";
import {
	acquireWebcamSession,
	coerceWebcamFrameRate,
	coerceWebcamQualityMode,
	createWebcamSessionConstraints,
	forceRestartWebcamSessionForRecording,
	resetWebcamSessionForTests,
} from "./webcamSession";

function createFakeTrack() {
	return { stop: vi.fn(), readyState: "live" } as unknown as MediaStreamTrack & {
		stop: ReturnType<typeof vi.fn>;
		readyState: MediaStreamTrackState;
	};
}

function createFakeStream() {
	const track = createFakeTrack();
	const stream = {
		getTracks: () => [track],
		getVideoTracks: () => [track],
	} as unknown as MediaStream;
	return { stream, track };
}

afterEach(() => {
	resetWebcamSessionForTests();
});

describe("acquireWebcamSession", () => {
	it("shares one getUserMedia stream between concurrent consumers", async () => {
		const { stream } = createFakeStream();
		const getUserMedia = vi.fn().mockResolvedValue(stream);

		const [a, b] = await Promise.all([
			acquireWebcamSession("cam-1", 30, getUserMedia),
			acquireWebcamSession("cam-1", 30, getUserMedia),
		]);

		expect(getUserMedia).toHaveBeenCalledTimes(1);
		expect(a.stream).toBe(stream);
		expect(b.stream).toBe(stream);
	});

	it("keeps the device alive until every consumer releases", async () => {
		const { stream, track } = createFakeStream();
		const getUserMedia = vi.fn().mockResolvedValue(stream);

		const recorder = await acquireWebcamSession("cam-1", 30, getUserMedia);
		const preview = await acquireWebcamSession("cam-1", 30, getUserMedia);

		preview.release();
		expect(track.stop).not.toHaveBeenCalled();

		recorder.release();
		expect(track.stop).toHaveBeenCalledTimes(1);
	});

	it("reuses a live session even when constraints differ, instead of opening a second camera pipeline", async () => {
		const { stream, track } = createFakeStream();
		const getUserMedia = vi.fn().mockResolvedValue(stream);

		const recorder = await acquireWebcamSession("cam-1", 30, getUserMedia);
		const preview = await acquireWebcamSession("cam-1", 60, getUserMedia);

		expect(getUserMedia).toHaveBeenCalledTimes(1);
		expect(preview.stream).toBe(recorder.stream);
		expect(track.stop).not.toHaveBeenCalled();
	});

	it("restarts the session for new constraints once fully released", async () => {
		const first = createFakeStream();
		const second = createFakeStream();
		const getUserMedia = vi
			.fn()
			.mockResolvedValueOnce(first.stream)
			.mockResolvedValueOnce(second.stream);

		const a = await acquireWebcamSession("cam-1", 30, getUserMedia);
		a.release();
		expect(first.track.stop).toHaveBeenCalledTimes(1);

		const b = await acquireWebcamSession("cam-1", 60, getUserMedia);
		expect(getUserMedia).toHaveBeenCalledTimes(2);
		expect(b.stream).toBe(second.stream);
	});

	it("release is idempotent", async () => {
		const { stream, track } = createFakeStream();
		const getUserMedia = vi.fn().mockResolvedValue(stream);

		const a = await acquireWebcamSession("cam-1", 30, getUserMedia);
		const b = await acquireWebcamSession("cam-1", 30, getUserMedia);
		a.release();
		a.release();
		expect(track.stop).not.toHaveBeenCalled();
		b.release();
		expect(track.stop).toHaveBeenCalledTimes(1);
	});

	it("stops the stream when every consumer released while getUserMedia was in flight", async () => {
		const { stream, track } = createFakeStream();
		let resolveGum: (value: MediaStream) => void = () => {};
		const getUserMedia = vi.fn().mockImplementation(
			() =>
				new Promise<MediaStream>((resolve) => {
					resolveGum = resolve;
				}),
		);

		const pending = acquireWebcamSession("cam-1", 30, getUserMedia);
		// Releasing before the stream resolves must still stop the device.
		resolveGum(stream);
		const handle = await pending;
		handle.release();
		expect(track.stop).toHaveBeenCalledTimes(1);
	});

	it("reopens the camera instead of reusing a session whose tracks have ended", async () => {
		const first = createFakeStream();
		const second = createFakeStream();
		const getUserMedia = vi
			.fn()
			.mockResolvedValueOnce(first.stream)
			.mockResolvedValueOnce(second.stream);

		const held = await acquireWebcamSession("cam-1", 30, getUserMedia);
		// Continuity Camera disconnect: the track dies while a consumer holds it.
		first.track.readyState = "ended";

		const reacquired = await acquireWebcamSession("cam-1", 30, getUserMedia);
		expect(getUserMedia).toHaveBeenCalledTimes(2);
		expect(reacquired.stream).toBe(second.stream);

		// The stale holder's release must not stop the fresh session.
		held.release();
		expect(second.track.stop).not.toHaveBeenCalled();
		reacquired.release();
		expect(second.track.stop).toHaveBeenCalledTimes(1);
	});

	it("propagates getUserMedia failures and recovers on the next acquire", async () => {
		const { stream } = createFakeStream();
		const getUserMedia = vi
			.fn()
			.mockRejectedValueOnce(new Error("NotReadableError"))
			.mockResolvedValueOnce(stream);

		await expect(acquireWebcamSession("cam-1", 30, getUserMedia)).rejects.toThrow(
			"NotReadableError",
		);

		const handle = await acquireWebcamSession("cam-1", 30, getUserMedia);
		expect(handle.stream).toBe(stream);
	});

	it("passes the chosen quality mode into the shared camera constraints", async () => {
		const { stream } = createFakeStream();
		const getUserMedia = vi.fn().mockResolvedValue(stream);

		const handle = await acquireWebcamSession("cam-1", 30, "sharp", getUserMedia);
		handle.release();

		expect(getUserMedia).toHaveBeenCalledWith({
			audio: false,
			video: expect.objectContaining({
				width: { ideal: 1920, max: 1920 },
				height: { ideal: 1080, max: 1080 },
			}),
		});
	});

	it("can force a pre-recording restart so stable constraints replace a held preview session", async () => {
		const preview = createFakeStream();
		const recording = createFakeStream();
		const getUserMedia = vi
			.fn()
			.mockResolvedValueOnce(preview.stream)
			.mockResolvedValueOnce(recording.stream);

		const previewHandle = await acquireWebcamSession("iphone", 30, "sharp", getUserMedia);
		forceRestartWebcamSessionForRecording();
		const recordingHandle = await acquireWebcamSession("iphone", 30, "stable", getUserMedia);

		expect(preview.track.stop).toHaveBeenCalledTimes(1);
		expect(recordingHandle.stream).toBe(recording.stream);
		expect(getUserMedia).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				video: expect.objectContaining({
					width: { ideal: 1280, max: 1280 },
					height: { ideal: 720, max: 720 },
				}),
			}),
		);

		previewHandle.release();
		recordingHandle.release();
		expect(recording.track.stop).toHaveBeenCalledTimes(1);
	});
});

describe("createWebcamSessionConstraints", () => {
	it("locks webcam capture to 30fps even when a stale setting requests another rate", () => {
		const constraints = createWebcamSessionConstraints("cam-1", 24) as Record<string, unknown>;
		expect(constraints.frameRate).toEqual({ ideal: 30, max: 30 });
		expect(constraints.deviceId).toEqual({ exact: "cam-1" });
	});

	it("caps capture size to the stable 720p facecam profile", () => {
		const constraints = createWebcamSessionConstraints(undefined, 30) as Record<
			string,
			unknown
		>;
		expect(constraints.width).toEqual({ ideal: 1280, max: 1280 });
		expect(constraints.height).toEqual({ ideal: 720, max: 720 });
	});

	it("supports an opt-in 1080p webcam profile", () => {
		const constraints = createWebcamSessionConstraints(undefined, 30, "sharp") as Record<
			string,
			unknown
		>;
		expect(constraints.width).toEqual({ ideal: 1920, max: 1920 });
		expect(constraints.height).toEqual({ ideal: 1080, max: 1080 });
	});

	it("supports an opt-in max webcam profile up to 4K", () => {
		const constraints = createWebcamSessionConstraints(undefined, 30, "max") as Record<
			string,
			unknown
		>;
		expect(constraints.width).toEqual({ ideal: 3840, max: 3840 });
		expect(constraints.height).toEqual({ ideal: 2160, max: 2160 });
	});
});

describe("coerceWebcamFrameRate", () => {
	it("keeps webcam capture locked to 30fps", () => {
		expect(coerceWebcamFrameRate(24)).toBe(30);
		expect(coerceWebcamFrameRate(60)).toBe(30);
		expect(coerceWebcamFrameRate(48)).toBe(30);
		expect(coerceWebcamFrameRate(undefined)).toBe(30);
		expect(coerceWebcamFrameRate("30")).toBe(30);
	});
});

describe("coerceWebcamQualityMode", () => {
	it("accepts supported modes and falls back to stable", () => {
		expect(coerceWebcamQualityMode("stable")).toBe("stable");
		expect(coerceWebcamQualityMode("sharp")).toBe("sharp");
		expect(coerceWebcamQualityMode("max")).toBe("max");
		expect(coerceWebcamQualityMode("4k")).toBe("stable");
		expect(coerceWebcamQualityMode(undefined)).toBe("stable");
	});
});
