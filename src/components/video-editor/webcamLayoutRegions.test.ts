import { describe, expect, it } from "vitest";
import {
	eventsToWebcamLayoutRegions,
	getLetterboxRect,
	isCameraFullAtMs,
	type WebcamLayoutEvent,
} from "./webcamLayoutRegions";

describe("eventsToWebcamLayoutRegions", () => {
	it("pairs camera-full/screen events into regions", () => {
		const events: WebcamLayoutEvent[] = [
			{ timeMs: 5000, mode: "camera-full" },
			{ timeMs: 9000, mode: "screen" },
			{ timeMs: 20000, mode: "camera-full" },
			{ timeMs: 31000, mode: "screen" },
		];
		const regions = eventsToWebcamLayoutRegions(events);
		expect(regions.map((r) => [r.startMs, r.endMs])).toEqual([
			[5000, 9000],
			[20000, 31000],
		]);
		expect(regions[0].id).not.toBe(regions[1].id);
	});

	it("extends an unterminated camera-full segment to the end", () => {
		const regions = eventsToWebcamLayoutRegions([{ timeMs: 5000, mode: "camera-full" }]);
		expect(regions).toHaveLength(1);
		expect(regions[0].endMs).toBe(Number.MAX_SAFE_INTEGER);
	});

	it("dedupes consecutive same-mode events and sorts by time", () => {
		const regions = eventsToWebcamLayoutRegions([
			{ timeMs: 9000, mode: "screen" },
			{ timeMs: 5000, mode: "camera-full" },
			{ timeMs: 6000, mode: "camera-full" },
		]);
		expect(regions.map((r) => [r.startMs, r.endMs])).toEqual([[5000, 9000]]);
	});

	it("drops zero-length segments and ignores leading screen events", () => {
		expect(
			eventsToWebcamLayoutRegions([
				{ timeMs: 0, mode: "screen" },
				{ timeMs: 5000, mode: "camera-full" },
				{ timeMs: 5000, mode: "screen" },
			]),
		).toEqual([]);
	});

	it("ignores invalid events", () => {
		expect(
			eventsToWebcamLayoutRegions([
				{ timeMs: Number.NaN, mode: "camera-full" },
				{ timeMs: -5, mode: "camera-full" },
			]),
		).toEqual([]);
	});
});

describe("isCameraFullAtMs", () => {
	const regions = eventsToWebcamLayoutRegions([
		{ timeMs: 5000, mode: "camera-full" },
		{ timeMs: 9000, mode: "screen" },
	]);
	it("is true inside and false outside (end exclusive)", () => {
		expect(isCameraFullAtMs(regions, 4999)).toBe(false);
		expect(isCameraFullAtMs(regions, 5000)).toBe(true);
		expect(isCameraFullAtMs(regions, 8999)).toBe(true);
		expect(isCameraFullAtMs(regions, 9000)).toBe(false);
	});
});

describe("getLetterboxRect", () => {
	it("fits wide content into a taller frame, centered, with padding", () => {
		const rect = getLetterboxRect(
			{ width: 1600, height: 900 },
			{ width: 1000, height: 1000 },
			50,
		);
		// available 900x900; 16:9 fit -> 900x506.25
		expect(rect.width).toBeCloseTo(900);
		expect(rect.height).toBeCloseTo(506.25);
		expect(rect.x).toBeCloseTo(50);
		expect(rect.y).toBeCloseTo((1000 - 506.25) / 2);
	});

	it("fits tall content into a wider frame", () => {
		const rect = getLetterboxRect(
			{ width: 900, height: 1600 },
			{ width: 1920, height: 1080 },
			0,
		);
		expect(rect.height).toBeCloseTo(1080);
		expect(rect.width).toBeCloseTo(1080 * (900 / 1600));
		expect(rect.y).toBeCloseTo(0);
	});

	it("degrades safely on invalid input", () => {
		const rect = getLetterboxRect({ width: 0, height: 0 }, { width: 1000, height: 500 }, 10);
		expect(rect).toEqual({ x: 10, y: 10, width: 980, height: 480 });
	});
});
