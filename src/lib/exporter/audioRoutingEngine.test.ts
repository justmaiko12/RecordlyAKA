import { describe, expect, it } from "vitest";
import { buildResolvedAudioPlan } from "./audioRoutingEngine";

describe("buildResolvedAudioPlan", () => {
	it("preserves sourceStartMs on user audio regions", () => {
		const plan = buildResolvedAudioPlan({
			videoResource: null,
			sourceAudioFallbackPaths: [],
			audioRegions: [
				{
					id: "webcam-replacement-audio-1",
					startMs: 0,
					endMs: 10_000,
					sourceStartMs: 1250,
					audioPath: "/tmp/camera.mp4",
					volume: 1,
				},
			],
		});

		expect(plan.tracks).toHaveLength(1);
		expect(plan.tracks[0]).toMatchObject({
			id: "user:webcam-replacement-audio-1",
			kind: "user",
			sourceRef: {
				path: "/tmp/camera.mp4",
				startDelayMs: 1250,
			},
			timelineBinding: {
				startMs: 0,
				endMs: 10_000,
			},
		});
	});
});
