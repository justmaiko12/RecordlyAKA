import { useEffect, useState } from "react";

const DEVICE_CHANGE_RELOAD_DELAY_MS = 500;

export interface MicrophoneDevice {
	deviceId: string;
	label: string;
	groupId: string;
	connection?: MicrophoneDeviceConnection;
	nativeDeviceId?: string;
	nativeLabel?: string;
	nativeOnly?: boolean;
}

let hasRequestedMicrophoneLabels = false;

export interface MicrophoneDeviceConnection {
	kind: "built-in" | "usb" | "wireless" | "external" | "unknown";
	label: string;
	confidence: "system" | "inferred" | "ambiguous";
	detail: string | null;
}

export type NativeAudioDeviceConnectionInfo = Awaited<
	ReturnType<Window["electronAPI"]["getAudioDeviceConnectionInfo"]>
>["devices"][number];

type BrowserMicrophoneDeviceInput = Omit<
	MicrophoneDevice,
	"connection" | "nativeDeviceId" | "nativeLabel" | "nativeOnly"
>;

function normalizeMicrophoneLabel(label: string) {
	return label
		.normalize("NFKC")
		.replace(/[’‘]/g, "'")
		.replace(/\s+\([^)]*\)\s*$/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

function connectionFromNativeDevice(
	nativeDevice: NativeAudioDeviceConnectionInfo,
): MicrophoneDeviceConnection {
	return {
		kind: nativeDevice.connectionKind,
		label: nativeDevice.connectionLabel,
		confidence: nativeDevice.confidence,
		detail: nativeDevice.detail,
	};
}

function nativeDeviceId(nativeDevice: NativeAudioDeviceConnectionInfo) {
	return nativeDevice.uniqueId?.trim() || `native:${nativeDevice.normalizedLabel}`;
}

export function mergeMicrophoneConnectionInfo(
	devices: BrowserMicrophoneDeviceInput[],
	nativeDevices: NativeAudioDeviceConnectionInfo[],
): MicrophoneDevice[] {
	const nativeByLabel = new Map(nativeDevices.map((device) => [device.normalizedLabel, device]));
	const browserNormalizedLabels = new Set(
		devices.map((device) => normalizeMicrophoneLabel(device.label)),
	);
	const browserDeviceIds = new Set(devices.map((device) => device.deviceId));

	const mergedDevices: MicrophoneDevice[] = devices.map((device): MicrophoneDevice => {
		const nativeDevice = nativeByLabel.get(normalizeMicrophoneLabel(device.label));
		if (!nativeDevice) {
			return device;
		}

		const resolvedNativeDeviceId = nativeDeviceId(nativeDevice);
		return {
			...device,
			connection: connectionFromNativeDevice(nativeDevice),
			nativeDeviceId: resolvedNativeDeviceId || undefined,
			nativeLabel: nativeDevice.label,
		};
	});

	for (const nativeDevice of nativeDevices) {
		const deviceId = nativeDeviceId(nativeDevice);
		if (!deviceId) {
			continue;
		}
		if (browserDeviceIds.has(deviceId)) {
			continue;
		}
		const duplicateBrowserLabel = browserNormalizedLabels.has(nativeDevice.normalizedLabel);
		if (duplicateBrowserLabel) {
			continue;
		}
		mergedDevices.push({
			deviceId,
			label: nativeDevice.label,
			groupId: `native:${nativeDevice.normalizedLabel}`,
			connection: connectionFromNativeDevice(nativeDevice),
			nativeDeviceId: deviceId,
			nativeLabel: nativeDevice.label,
			nativeOnly: true,
		});
	}

	return mergedDevices;
}

export function useMicrophoneDevices(enabled: boolean = true, preferredDeviceId?: string) {
	const [devices, setDevices] = useState<MicrophoneDevice[]>([]);
	const [selectedDeviceId, setSelectedDeviceId] = useState<string>("default");
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!enabled) {
			return;
		}

		let mounted = true;
		let activeLoadId = 0;
		let deviceChangeReloadTimer: ReturnType<typeof setTimeout> | undefined;

		const loadDevices = async () => {
			const loadId = ++activeLoadId;
			let permissionStream: MediaStream | null = null;

			try {
				if (mounted && loadId === activeLoadId) {
					setIsLoading(true);
					setError(null);
				}

				let allDevices = await navigator.mediaDevices.enumerateDevices();
				let audioInputs: BrowserMicrophoneDeviceInput[] = allDevices
					.filter((device) => device.kind === "audioinput")
					.map((device) => ({
						deviceId: device.deviceId,
						label: device.label || `Microphone ${device.deviceId.slice(0, 8)}`,
						groupId: device.groupId,
					}));

				const needsLabelPermission =
					audioInputs.length > 0 && audioInputs.every((device) => !device.label.trim());

				if (needsLabelPermission && !hasRequestedMicrophoneLabels) {
					hasRequestedMicrophoneLabels = true;
					permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true });
					allDevices = await navigator.mediaDevices.enumerateDevices();
					audioInputs = allDevices
						.filter((device) => device.kind === "audioinput")
						.map((device) => ({
							deviceId: device.deviceId,
							label: device.label || `Microphone ${device.deviceId.slice(0, 8)}`,
							groupId: device.groupId,
						}));
				}

				let nativeAudioDevices: NativeAudioDeviceConnectionInfo[] = [];
				if (typeof window.electronAPI?.getAudioDeviceConnectionInfo === "function") {
					try {
						const result = await window.electronAPI.getAudioDeviceConnectionInfo();
						nativeAudioDevices = result.success ? result.devices : [];
					} catch (error) {
						console.warn("Error loading native microphone devices:", error);
					}
				}

				const mergedAudioInputs = mergeMicrophoneConnectionInfo(
					audioInputs,
					nativeAudioDevices,
				);

				if (mounted && loadId === activeLoadId) {
					setDevices(mergedAudioInputs);
					setSelectedDeviceId((currentDeviceId) => {
						const normalizedPreferredDeviceId = preferredDeviceId ?? "default";
						if (
							mergedAudioInputs.some(
								(device) =>
									device.deviceId === normalizedPreferredDeviceId ||
									device.nativeDeviceId === normalizedPreferredDeviceId,
							)
						) {
							return normalizedPreferredDeviceId;
						}

						if (
							currentDeviceId !== "default" &&
							mergedAudioInputs.some(
								(device) =>
									device.deviceId === currentDeviceId ||
									device.nativeDeviceId === currentDeviceId,
							)
						) {
							return currentDeviceId;
						}

						return "default";
					});
				}
			} catch (error) {
				if (mounted && loadId === activeLoadId) {
					const message =
						error instanceof Error
							? error.message
							: "Failed to enumerate audio devices";
					setError(message);
					console.error("Error loading microphone devices:", error);
				}
			} finally {
				permissionStream?.getTracks().forEach((track) => track.stop());
				if (mounted && loadId === activeLoadId) {
					setIsLoading(false);
				}
			}
		};

		void loadDevices();

		const handleDeviceChange = () => {
			if (deviceChangeReloadTimer) {
				clearTimeout(deviceChangeReloadTimer);
			}
			deviceChangeReloadTimer = setTimeout(() => {
				deviceChangeReloadTimer = undefined;
				void loadDevices();
			}, DEVICE_CHANGE_RELOAD_DELAY_MS);
		};

		navigator.mediaDevices.addEventListener("devicechange", handleDeviceChange);

		return () => {
			mounted = false;
			if (deviceChangeReloadTimer) {
				clearTimeout(deviceChangeReloadTimer);
			}
			navigator.mediaDevices.removeEventListener("devicechange", handleDeviceChange);
		};
	}, [enabled, preferredDeviceId]);

	return {
		devices,
		selectedDeviceId,
		setSelectedDeviceId,
		isLoading,
		error,
	};
}
