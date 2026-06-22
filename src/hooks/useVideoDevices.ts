import { useCallback, useEffect, useState } from "react";

const DEVICE_CHANGE_RELOAD_DELAY_MS = 500;

export interface VideoDevice {
	deviceId: string;
	label: string;
	groupId: string;
	connection?: VideoDeviceConnection;
	nativeDeviceId?: string;
	nativeLabel?: string;
	nativeOnly?: boolean;
}

let hasRequestedVideoLabels = false;

export interface VideoDeviceConnection {
	kind: "built-in" | "usb" | "wireless" | "external" | "unknown";
	label: string;
	confidence: "system" | "inferred" | "ambiguous";
	detail: string | null;
}

export type NativeVideoDeviceConnectionInfo = Awaited<
	ReturnType<Window["electronAPI"]["getVideoDeviceConnectionInfo"]>
>["devices"][number];

type BrowserVideoDeviceInput = Omit<VideoDevice, "connection">;

function normalizeCameraLabel(label: string) {
	return label
		.normalize("NFKC")
		.replace(/[’‘]/g, "'")
		.replace(/\s+\([^)]*\)\s*$/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

function connectionFromNativeDevice(
	nativeDevice: NativeVideoDeviceConnectionInfo,
): VideoDeviceConnection {
	return {
		kind: nativeDevice.connectionKind,
		label: nativeDevice.connectionLabel,
		confidence: nativeDevice.confidence,
		detail: nativeDevice.detail,
	};
}

function nativeDeviceId(nativeDevice: NativeVideoDeviceConnectionInfo) {
	return nativeDevice.uniqueId?.trim() || `native:${nativeDevice.normalizedLabel}`;
}

export function mergeVideoConnectionInfo(
	devices: BrowserVideoDeviceInput[],
	nativeDevices: NativeVideoDeviceConnectionInfo[],
): VideoDevice[] {
	const nativeByLabel = new Map(nativeDevices.map((device) => [device.normalizedLabel, device]));
	const browserNormalizedLabels = new Set(
		devices.map((device) => normalizeCameraLabel(device.label)),
	);
	const browserDeviceIds = new Set(devices.map((device) => device.deviceId));

	const mergedDevices = devices.map((device) => {
		const nativeDevice = nativeByLabel.get(normalizeCameraLabel(device.label));
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

function loadErrorMessage(error: unknown, fallback: string) {
	if (!error) {
		return null;
	}
	return error instanceof Error ? error.message : fallback;
}

export function resolveVideoDeviceLoadResult({
	browserVideoInputs,
	nativeVideoDevices,
	browserError,
	nativeError,
}: {
	browserVideoInputs: BrowserVideoDeviceInput[];
	nativeVideoDevices: NativeVideoDeviceConnectionInfo[];
	browserError?: unknown;
	nativeError?: unknown;
}): { devices: VideoDevice[]; error: string | null } {
	const devices = mergeVideoConnectionInfo(browserVideoInputs, nativeVideoDevices);
	if (devices.length > 0) {
		return { devices, error: null };
	}

	return {
		devices,
		error:
			loadErrorMessage(browserError, "Failed to enumerate browser video devices") ??
			loadErrorMessage(nativeError, "Failed to enumerate native video devices"),
	};
}

export function useVideoDevices(enabled: boolean = true) {
	const [devices, setDevices] = useState<VideoDevice[]>([]);
	const [selectedDeviceId, setSelectedDeviceId] = useState<string>("default");
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [reloadNonce, setReloadNonce] = useState(0);

	const refreshDevices = useCallback(() => {
		if (!enabled) {
			return;
		}
		setReloadNonce((current) => current + 1);
	}, [enabled]);

	useEffect(() => {
		if (!enabled) {
			return;
		}
		void reloadNonce;

		let mounted = true;
		let activeLoadId = 0;
		let deviceChangeReloadTimer: ReturnType<typeof setTimeout> | undefined;

		const loadDevices = async () => {
			const loadId = ++activeLoadId;
			let permissionStream: MediaStream | null = null;
			let videoInputs: BrowserVideoDeviceInput[] = [];
			let browserError: unknown;
			let nativeError: unknown;

			try {
				if (mounted && loadId === activeLoadId) {
					setIsLoading(true);
					setError(null);
				}

				try {
					let allDevices = await navigator.mediaDevices.enumerateDevices();
					let rawVideoDevices = allDevices.filter(
						(device) => device.kind === "videoinput",
					);
					videoInputs = rawVideoDevices.map((device, index) => ({
						deviceId: device.deviceId,
						label: device.label || `Camera ${index + 1}`,
						groupId: device.groupId,
					}));

					const needsLabelPermission =
						rawVideoDevices.length > 0 &&
						rawVideoDevices.every((device) => !device.label.trim());

					if (needsLabelPermission && !hasRequestedVideoLabels) {
						try {
							permissionStream = await navigator.mediaDevices.getUserMedia({
								video: true,
								audio: false,
							});
							allDevices = await navigator.mediaDevices.enumerateDevices();
							rawVideoDevices = allDevices.filter(
								(device) => device.kind === "videoinput",
							);
							videoInputs = rawVideoDevices.map((device, index) => ({
								deviceId: device.deviceId,
								label: device.label || `Camera ${index + 1}`,
								groupId: device.groupId,
							}));
							hasRequestedVideoLabels = true;
						} catch (error) {
							browserError = error;
							console.warn("Unable to request camera labels:", error);
						}
					}
				} catch (error) {
					browserError = error;
					console.error("Error loading browser video devices:", error);
				}

				let nativeVideoDevices: NativeVideoDeviceConnectionInfo[] = [];
				if (typeof window.electronAPI?.getVideoDeviceConnectionInfo === "function") {
					try {
						const result = await window.electronAPI.getVideoDeviceConnectionInfo();
						if (result.success) {
							nativeVideoDevices = result.devices;
						} else {
							nativeError =
								result.error ?? "Failed to enumerate native video devices";
						}
					} catch (error) {
						nativeError = error;
						console.warn("Error loading native video devices:", error);
					}
				}

				const result = resolveVideoDeviceLoadResult({
					browserVideoInputs: videoInputs,
					nativeVideoDevices,
					browserError,
					nativeError,
				});

				if (mounted && loadId === activeLoadId) {
					setDevices(result.devices);
					setError(result.error);
					setSelectedDeviceId((currentDeviceId) => {
						if (currentDeviceId === "default" && result.devices.length > 0) {
							return result.devices[0].deviceId;
						}

						if (
							currentDeviceId !== "default" &&
							result.devices.some((device) => device.deviceId === currentDeviceId)
						) {
							return currentDeviceId;
						}

						return result.devices[0]?.deviceId ?? "default";
					});
				}
			} catch (error) {
				if (mounted && loadId === activeLoadId) {
					const message =
						error instanceof Error
							? error.message
							: "Failed to enumerate video devices";
					setError(message);
					console.error("Error loading video devices:", error);
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
	}, [enabled, reloadNonce]);

	return {
		devices,
		selectedDeviceId,
		setSelectedDeviceId,
		refreshDevices,
		isLoading,
		error,
	};
}
