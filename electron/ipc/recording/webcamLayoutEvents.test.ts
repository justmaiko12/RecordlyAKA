import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
	beginWebcamLayoutSession,
	getWebcamLayoutEventsPath,
	persistWebcamLayoutEvents,
	readWebcamLayoutEvents,
	recordWebcamLayoutEvent,
} from "./webcamLayoutEvents";

describe("webcam layout events session", () => {
	let videoPath: string;

	beforeEach(async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-layout-"));
		videoPath = path.join(dir, "recording.mp4");
	});

	it("persists recorded events as a sidecar and reads them back", async () => {
		beginWebcamLayoutSession();
		recordWebcamLayoutEvent({ timeMs: 5000, mode: "camera-full" });
		recordWebcamLayoutEvent({ timeMs: 9000, mode: "screen" });
		await persistWebcamLayoutEvents(videoPath);

		const raw = JSON.parse(await fs.readFile(getWebcamLayoutEventsPath(videoPath), "utf8"));
		expect(raw.version).toBe(1);
		expect(raw.events).toHaveLength(2);

		const read = await readWebcamLayoutEvents(videoPath);
		expect(read).toEqual([
			{ timeMs: 5000, mode: "camera-full" },
			{ timeMs: 9000, mode: "screen" },
		]);
	});

	it("writes nothing when no events were recorded", async () => {
		beginWebcamLayoutSession();
		await persistWebcamLayoutEvents(videoPath);
		await expect(fs.stat(getWebcamLayoutEventsPath(videoPath))).rejects.toThrow();
	});

	it("ignores events outside a session and invalid payloads", async () => {
		recordWebcamLayoutEvent({ timeMs: 5000, mode: "camera-full" }); // no session begun
		beginWebcamLayoutSession();
		recordWebcamLayoutEvent({ timeMs: Number.NaN, mode: "camera-full" } as never);
		recordWebcamLayoutEvent({ timeMs: 5, mode: "bogus" } as never);
		await persistWebcamLayoutEvents(videoPath);
		await expect(fs.stat(getWebcamLayoutEventsPath(videoPath))).rejects.toThrow();
	});

	it("returns empty array for missing/corrupt sidecars", async () => {
		expect(await readWebcamLayoutEvents(videoPath)).toEqual([]);
		await fs.writeFile(getWebcamLayoutEventsPath(videoPath), "not json");
		expect(await readWebcamLayoutEvents(videoPath)).toEqual([]);
	});
});
