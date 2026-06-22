import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getRecordingEventLogPath } from "./recordingEventLog";
import { WebcamSidecarStreamRegistry } from "./webcamSidecarStream";

describe("WebcamSidecarStreamRegistry", () => {
	let tempRoot: string;

	beforeEach(async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-webcam-sidecar-"));
	});

	afterEach(async () => {
		if (tempRoot) {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	it("mirrors webcam chunks to disk and writes a recording event log", async () => {
		const registry = new WebcamSidecarStreamRegistry();
		const sessionId = "1781642935692";
		const started = await registry.start({
			recordingsDir: tempRoot,
			sessionId,
			fileName: "recording-1781642935692-webcam.mp4",
			mimeType: "video/mp4",
		});

		await registry.append({
			streamId: started.streamId,
			chunk: Buffer.from("chunk-one"),
			index: 0,
			elapsedMs: 250,
		});
		await registry.append({
			streamId: started.streamId,
			chunk: Buffer.from("chunk-two"),
			index: 1,
			elapsedMs: 500,
		});
		const finished = await registry.finish(started.streamId);

		await expect(fs.readFile(finished.path, "utf8")).resolves.toBe("chunk-onechunk-two");
		expect(finished).toMatchObject({
			bytesWritten: 18,
			chunksWritten: 2,
		});

		const logPath = getRecordingEventLogPath(tempRoot, sessionId);
		const logLines = (await fs.readFile(logPath, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));

		expect(logLines.map((entry) => entry.event)).toEqual([
			"webcam-sidecar-stream-started",
			"webcam-sidecar-chunk-written",
			"webcam-sidecar-stream-finished",
		]);
		expect(logLines[1].details).toMatchObject({
			index: 0,
			bytesWritten: 9,
			chunksWritten: 1,
		});
	});

	it("rejects sidecar names that would escape the recordings directory", async () => {
		const registry = new WebcamSidecarStreamRegistry();

		await expect(
			registry.start({
				recordingsDir: tempRoot,
				sessionId: "1781642935692",
				fileName: "../outside.mp4",
			}),
		).rejects.toThrow("Invalid webcam sidecar file name");
	});
});
