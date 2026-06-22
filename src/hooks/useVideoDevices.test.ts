import { describe, expect, it } from "vitest";
import { mergeVideoConnectionInfo, resolveVideoDeviceLoadResult } from "./useVideoDevices";

describe("mergeVideoConnectionInfo", () => {
	const macbookNativeDevice = {
		label: "MacBook Air Camera",
		normalizedLabel: "macbook air camera",
		modelId: "MacBook Air Camera",
		uniqueId: "6C707041-05AC-0011-0004-000000000001",
		connectionKind: "built-in" as const,
		connectionLabel: "Built-in",
		confidence: "system" as const,
		detail: "Mac built-in camera",
	};
	const iphoneNativeDevice = {
		label: "Justmaiko's iPhone Camera",
		normalizedLabel: "justmaiko's iphone camera",
		modelId: "iPhone18,2",
		uniqueId: "D0B50AEF-3573-491E-9CA6-08E600000001",
		connectionKind: "wireless" as const,
		connectionLabel: "Wireless",
		confidence: "inferred" as const,
		detail: "Continuity Camera inferred from no attached iPhone/iPad USB device",
	};

	it("keeps browser cameras and appends native-only Continuity cameras", () => {
		const devices = [
			{
				deviceId: "browser-macbook-camera",
				label: "MacBook Air Camera",
				groupId: "macbook-group",
			},
		];
		const nativeDevices = [macbookNativeDevice, iphoneNativeDevice];

		const merged = mergeVideoConnectionInfo(devices, nativeDevices);

		expect(merged).toEqual([
			{
				...devices[0],
				connection: {
					kind: "built-in",
					label: "Built-in",
					confidence: "system",
					detail: "Mac built-in camera",
				},
				nativeDeviceId: "6C707041-05AC-0011-0004-000000000001",
				nativeLabel: "MacBook Air Camera",
			},
			{
				deviceId: "D0B50AEF-3573-491E-9CA6-08E600000001",
				label: "Justmaiko's iPhone Camera",
				groupId: "native:justmaiko's iphone camera",
				connection: {
					kind: "wireless",
					label: "Wireless",
					confidence: "inferred",
					detail: "Continuity Camera inferred from no attached iPhone/iPad USB device",
				},
				nativeDeviceId: "D0B50AEF-3573-491E-9CA6-08E600000001",
				nativeLabel: "Justmaiko's iPhone Camera",
				nativeOnly: true,
			},
		]);
	});

	it("deduplicates native Continuity cameras when Chromium exposes the same camera label", () => {
		const devices = [
			{
				deviceId: "browser-iphone-camera",
				label: "Justmaiko’s iPhone Camera",
				groupId: "iphone-browser-group",
			},
		];

		const merged = mergeVideoConnectionInfo(devices, [iphoneNativeDevice]);

		expect(merged).toEqual([
			{
				...devices[0],
				connection: {
					kind: "wireless",
					label: "Wireless",
					confidence: "inferred",
					detail: "Continuity Camera inferred from no attached iPhone/iPad USB device",
				},
				nativeDeviceId: "D0B50AEF-3573-491E-9CA6-08E600000001",
				nativeLabel: "Justmaiko's iPhone Camera",
			},
		]);
	});

	it("can build a native-only list when browser camera enumeration has no usable devices", () => {
		const result = resolveVideoDeviceLoadResult({
			browserVideoInputs: [],
			nativeVideoDevices: [macbookNativeDevice, iphoneNativeDevice],
			browserError: new Error("Permission denied"),
		});

		expect(result.error).toBeNull();
		expect(result.devices).toEqual([
			{
				deviceId: "6C707041-05AC-0011-0004-000000000001",
				label: "MacBook Air Camera",
				groupId: "native:macbook air camera",
				connection: {
					kind: "built-in",
					label: "Built-in",
					confidence: "system",
					detail: "Mac built-in camera",
				},
				nativeDeviceId: "6C707041-05AC-0011-0004-000000000001",
				nativeLabel: "MacBook Air Camera",
				nativeOnly: true,
			},
			{
				deviceId: "D0B50AEF-3573-491E-9CA6-08E600000001",
				label: "Justmaiko's iPhone Camera",
				groupId: "native:justmaiko's iphone camera",
				connection: {
					kind: "wireless",
					label: "Wireless",
					confidence: "inferred",
					detail: "Continuity Camera inferred from no attached iPhone/iPad USB device",
				},
				nativeDeviceId: "D0B50AEF-3573-491E-9CA6-08E600000001",
				nativeLabel: "Justmaiko's iPhone Camera",
				nativeOnly: true,
			},
		]);
	});

	it("surfaces errors only when neither browser nor native camera discovery returns devices", () => {
		const result = resolveVideoDeviceLoadResult({
			browserVideoInputs: [],
			nativeVideoDevices: [],
			browserError: new Error("Browser camera enumeration failed"),
			nativeError: new Error("Native camera enumeration failed"),
		});

		expect(result).toEqual({
			devices: [],
			error: "Browser camera enumeration failed",
		});
	});
});
