import { describe, expect, it } from "vitest";

import {
	canShowFloatingWebcamPreview,
	canToggleFloatingWebcamPreview,
	createFloatingWebcamPreviewVideoConstraints,
} from "./floatingWebcamPreview";

describe("canShowFloatingWebcamPreview", () => {
	it("shows the floating preview only when it was requested and passthrough is supported", () => {
		expect(canShowFloatingWebcamPreview(true, true)).toBe(true);
		expect(canShowFloatingWebcamPreview(false, true)).toBe(false);
		expect(canShowFloatingWebcamPreview(true, false)).toBe(false);
		expect(canShowFloatingWebcamPreview(true, null)).toBe(false);
	});
});

describe("canToggleFloatingWebcamPreview", () => {
	it("keeps the toggle visible while support is unknown or available", () => {
		expect(canToggleFloatingWebcamPreview(null)).toBe(true);
		expect(canToggleFloatingWebcamPreview(true)).toBe(true);
	});

	it("hides the toggle when the platform cannot support the floating preview", () => {
		expect(canToggleFloatingWebcamPreview(false)).toBe(false);
	});
});

describe("createFloatingWebcamPreviewVideoConstraints", () => {
	it("keeps the phone camera preview on a high-definition 16:9 stream", () => {
		expect(createFloatingWebcamPreviewVideoConstraints()).toEqual({
			aspectRatio: { ideal: 16 / 9 },
			resizeMode: "none",
			width: { ideal: 1920, min: 1280 },
			height: { ideal: 1080, min: 720 },
			frameRate: { ideal: 30, max: 30 },
		});
		expect(createFloatingWebcamPreviewVideoConstraints("phone-camera")).toEqual({
			aspectRatio: { ideal: 16 / 9 },
			deviceId: { exact: "phone-camera" },
			resizeMode: "none",
			width: { ideal: 1920, min: 1280 },
			height: { ideal: 1080, min: 720 },
			frameRate: { ideal: 30, max: 30 },
		});
	});
});
