import { describe, expect, it } from "vitest";
import { shouldMutePreviewVideoAudio } from "./useVideoEditorAudio";

describe("shouldMutePreviewVideoAudio", () => {
	it("keeps embedded audio audible while controlled preview audio has not started", () => {
		expect(
			shouldMutePreviewVideoAudio({
				muteEmbeddedPreview: false,
				controlledEmbeddedAudioPreview: true,
				sourceAudioPreviewPlaybackConfirmed: false,
			}),
		).toBe(false);
	});

	it("mutes embedded audio after controlled preview audio confirms playback", () => {
		expect(
			shouldMutePreviewVideoAudio({
				muteEmbeddedPreview: false,
				controlledEmbeddedAudioPreview: true,
				sourceAudioPreviewPlaybackConfirmed: true,
			}),
		).toBe(true);
	});

	it("keeps forced source routing mute behavior", () => {
		expect(
			shouldMutePreviewVideoAudio({
				muteEmbeddedPreview: true,
				controlledEmbeddedAudioPreview: false,
				sourceAudioPreviewPlaybackConfirmed: false,
			}),
		).toBe(true);
	});
});
