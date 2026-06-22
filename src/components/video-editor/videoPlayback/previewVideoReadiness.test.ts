import { describe, expect, it } from "vitest";
import {
	PREVIEW_READY_FALLBACK_TIMEOUT_MS,
	resolvePreviewVideoReadiness,
} from "./previewVideoReadiness";

describe("resolvePreviewVideoReadiness", () => {
	it("requires video dimensions before enabling the timeline preview", () => {
		expect(
			resolvePreviewVideoReadiness(
				{ readyState: 4, videoHeight: 0, videoWidth: 1920 },
				PREVIEW_READY_FALLBACK_TIMEOUT_MS,
			),
		).toEqual({
			hasData: true,
			hasDimensions: false,
			ready: false,
			usedFallback: false,
		});
	});

	it("enables the timeline preview when the browser has current frame data", () => {
		expect(
			resolvePreviewVideoReadiness({ readyState: 2, videoHeight: 1080, videoWidth: 1920 }, 0),
		).toEqual({
			hasData: true,
			hasDimensions: true,
			ready: true,
			usedFallback: false,
		});
	});

	it("does not wait forever when a valid hidden preview video has dimensions but no frame event yet", () => {
		expect(
			resolvePreviewVideoReadiness(
				{ readyState: 1, videoHeight: 1080, videoWidth: 1920 },
				PREVIEW_READY_FALLBACK_TIMEOUT_MS,
			),
		).toEqual({
			hasData: false,
			hasDimensions: true,
			ready: true,
			usedFallback: true,
		});
	});
});
