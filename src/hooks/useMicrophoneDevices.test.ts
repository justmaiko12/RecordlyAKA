import { describe, expect, it } from "vitest";
import { mergeMicrophoneConnectionInfo } from "./useMicrophoneDevices";

describe("mergeMicrophoneConnectionInfo", () => {
	const wirelessNativeDevice = {
		label: "Wireless microphone",
		normalizedLabel: "wireless microphone",
		modelId: "Wireless microphone:3547:0402",
		uniqueId:
			"AppleUSBAudioEngine:Shenzhen Hollyland Technology Co.,Ltd:Wireless microphone:95CX2H374W8B:3",
		connectionKind: "usb" as const,
		connectionLabel: "USB",
		confidence: "system" as const,
		detail: "USB audio input",
	};
	const macbookNativeDevice = {
		label: "MacBook Air Microphone",
		normalizedLabel: "macbook air microphone",
		modelId: "Digital Mic",
		uniqueId: "BuiltInMicrophoneDevice",
		connectionKind: "built-in" as const,
		connectionLabel: "Built-in",
		confidence: "system" as const,
		detail: "Mac built-in microphone",
	};

	it("attaches native IDs and connection labels to browser microphones", () => {
		const devices = [
			{
				deviceId: "browser-wireless-mic",
				label: "Wireless microphone",
				groupId: "wireless-group",
			},
		];

		expect(mergeMicrophoneConnectionInfo(devices, [wirelessNativeDevice])).toEqual([
			{
				...devices[0],
				connection: {
					kind: "usb",
					label: "USB",
					confidence: "system",
					detail: "USB audio input",
				},
				nativeDeviceId:
					"AppleUSBAudioEngine:Shenzhen Hollyland Technology Co.,Ltd:Wireless microphone:95CX2H374W8B:3",
				nativeLabel: "Wireless microphone",
			},
		]);
	});

	it("can build native-only microphone rows without duplicating matching browser labels", () => {
		const devices = [
			{
				deviceId: "browser-wireless-mic",
				label: "Wireless microphone",
				groupId: "wireless-group",
			},
		];

		expect(
			mergeMicrophoneConnectionInfo(devices, [wirelessNativeDevice, macbookNativeDevice]),
		).toEqual([
			{
				...devices[0],
				connection: {
					kind: "usb",
					label: "USB",
					confidence: "system",
					detail: "USB audio input",
				},
				nativeDeviceId:
					"AppleUSBAudioEngine:Shenzhen Hollyland Technology Co.,Ltd:Wireless microphone:95CX2H374W8B:3",
				nativeLabel: "Wireless microphone",
			},
			{
				deviceId: "BuiltInMicrophoneDevice",
				label: "MacBook Air Microphone",
				groupId: "native:macbook air microphone",
				connection: {
					kind: "built-in",
					label: "Built-in",
					confidence: "system",
					detail: "Mac built-in microphone",
				},
				nativeDeviceId: "BuiltInMicrophoneDevice",
				nativeLabel: "MacBook Air Microphone",
				nativeOnly: true,
			},
		]);
	});
});
