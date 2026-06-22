import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ipcMain } from "electron";
import { ensureNativeCaptureHelperBinary } from "../paths/binaries";

const execFileAsync = promisify(execFile);
const DEVICE_PROBE_TIMEOUT_MS = 5_000;

type CameraSystemProfilerEntry = {
	_name?: unknown;
	"spcamera_model-id"?: unknown;
	"spcamera_unique-id"?: unknown;
};

type NativeAudioDeviceEntry = {
	label?: unknown;
	uniqueId?: unknown;
	modelId?: unknown;
	connected?: unknown;
};

export type VideoDeviceConnectionKind = "built-in" | "usb" | "wireless" | "external" | "unknown";

export type VideoDeviceConnectionConfidence = "system" | "inferred" | "ambiguous";

export type VideoDeviceConnectionInfo = {
	label: string;
	normalizedLabel: string;
	modelId: string | null;
	uniqueId: string | null;
	connectionKind: VideoDeviceConnectionKind;
	connectionLabel: string;
	confidence: VideoDeviceConnectionConfidence;
	detail: string | null;
};

export type AudioDeviceConnectionInfo = VideoDeviceConnectionInfo;

function normalizeCameraLabel(label: string) {
	return label
		.normalize("NFKC")
		.replace(/[’‘]/g, "'")
		.replace(/\s+\([^)]*\)\s*$/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

function stringValue(value: unknown) {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function hasIosUsbDevice(ioregOutput: string) {
	return (
		/"idVendor"\s*=\s*1452/.test(ioregOutput) &&
		/("USB Product Name"|"kUSBProductString")\s*=\s*"(iPhone|iPad|iPod)"/i.test(ioregOutput)
	);
}

function inferConnection({
	label,
	modelId,
	usbIosDeviceCount,
	continuityCameraCount,
}: {
	label: string;
	modelId: string | null;
	usbIosDeviceCount: number;
	continuityCameraCount: number;
}): Pick<
	VideoDeviceConnectionInfo,
	"connectionKind" | "connectionLabel" | "confidence" | "detail"
> {
	const identity = `${label} ${modelId ?? ""}`;
	const isContinuityCamera = /\b(iPhone|iPad|iPod)\b/i.test(identity);
	const isBuiltIn =
		/\b(macbook|facetime|built-?in)\b/i.test(identity) ||
		/\bAVCaptureDeviceTypeBuiltIn/i.test(identity);

	if (isBuiltIn) {
		return {
			connectionKind: "built-in",
			connectionLabel: "Built-in",
			confidence: "system",
			detail: "Mac built-in camera",
		};
	}

	if (isContinuityCamera) {
		if (usbIosDeviceCount <= 0) {
			return {
				connectionKind: "wireless",
				connectionLabel: "Wireless",
				confidence: "inferred",
				detail: "Continuity Camera inferred from no attached iPhone/iPad USB device",
			};
		}

		if (continuityCameraCount <= usbIosDeviceCount) {
			return {
				connectionKind: "usb",
				connectionLabel: "USB",
				confidence: "inferred",
				detail: "Continuity Camera with iPhone/iPad detected over USB",
			};
		}

		return {
			connectionKind: "usb",
			connectionLabel: "USB?",
			confidence: "ambiguous",
			detail: "An iPhone/iPad is attached over USB, but macOS does not map it to one specific Continuity Camera entry",
		};
	}

	return {
		connectionKind: "external",
		connectionLabel: "External",
		confidence: "inferred",
		detail: "External camera",
	};
}

function inferAudioConnection({
	label,
	modelId,
	uniqueId,
}: {
	label: string;
	modelId: string | null;
	uniqueId: string | null;
}): Pick<
	AudioDeviceConnectionInfo,
	"connectionKind" | "connectionLabel" | "confidence" | "detail"
> {
	const identity = `${label} ${modelId ?? ""} ${uniqueId ?? ""}`;
	const isContinuityMicrophone = /\b(iPhone|iPad|iPod)\b/i.test(identity);
	const isBuiltIn =
		/\b(macbook|built-?in|digital mic)\b/i.test(identity) ||
		uniqueId === "BuiltInMicrophoneDevice";
	const isUsb = /\b(usb|AppleUSBAudioEngine)\b/i.test(identity);

	if (isBuiltIn) {
		return {
			connectionKind: "built-in",
			connectionLabel: "Built-in",
			confidence: "system",
			detail: "Mac built-in microphone",
		};
	}

	if (isContinuityMicrophone) {
		return {
			connectionKind: "wireless",
			connectionLabel: "Wireless",
			confidence: "inferred",
			detail: "Continuity microphone from iPhone/iPad",
		};
	}

	if (isUsb) {
		return {
			connectionKind: "usb",
			connectionLabel: "USB",
			confidence: "system",
			detail: "USB audio input",
		};
	}

	return {
		connectionKind: "external",
		connectionLabel: "External",
		confidence: "inferred",
		detail: "External audio input",
	};
}

async function readCameraEntries() {
	const { stdout } = await execFileAsync(
		"/usr/sbin/system_profiler",
		["SPCameraDataType", "-json"],
		{ timeout: DEVICE_PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
	);
	const parsed = JSON.parse(stdout) as { SPCameraDataType?: CameraSystemProfilerEntry[] };
	return Array.isArray(parsed.SPCameraDataType) ? parsed.SPCameraDataType : [];
}

async function readUsbIosDeviceCount() {
	const { stdout } = await execFileAsync(
		"/usr/sbin/ioreg",
		["-r", "-c", "IOUSBHostDevice", "-l"],
		{ timeout: DEVICE_PROBE_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024 },
	);
	const deviceBlocks = stdout.split(/\n\+-o /g);
	return deviceBlocks.filter(hasIosUsbDevice).length;
}

async function readNativeAudioEntries(): Promise<
	Array<{ label: string; normalizedLabel: string; modelId: string | null; uniqueId: string | null }>
> {
	if (process.platform !== "darwin") {
		return [];
	}

	const helperPath = await ensureNativeCaptureHelperBinary();
	const { stdout } = await execFileAsync(helperPath, ["--list-audio-devices"], {
		timeout: DEVICE_PROBE_TIMEOUT_MS,
		maxBuffer: 1024 * 1024,
	});
	const parsed = JSON.parse(stdout) as NativeAudioDeviceEntry[];
	if (!Array.isArray(parsed)) {
		return [];
	}

	return parsed
		.map((entry) => {
			const label = stringValue(entry.label);
			if (!label || entry.connected === false) {
				return null;
			}
			return {
				label,
				normalizedLabel: normalizeCameraLabel(label),
				modelId: stringValue(entry.modelId),
				uniqueId: stringValue(entry.uniqueId),
			};
		})
		.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
}

export async function getVideoDeviceConnectionInfo(): Promise<VideoDeviceConnectionInfo[]> {
	const [cameraEntries, usbIosDeviceCount] = await Promise.all([
		readCameraEntries(),
		readUsbIosDeviceCount().catch(() => 0),
	]);

	const normalizedEntries = cameraEntries
		.map((entry) => {
			const label = stringValue(entry._name);
			if (!label) {
				return null;
			}
			return {
				label,
				normalizedLabel: normalizeCameraLabel(label),
				modelId: stringValue(entry["spcamera_model-id"]),
				uniqueId: stringValue(entry["spcamera_unique-id"]),
			};
		})
		.filter((entry): entry is NonNullable<typeof entry> => entry !== null);

	const continuityCameraCount = normalizedEntries.filter((entry) =>
		/\b(iPhone|iPad|iPod)\b/i.test(`${entry.label} ${entry.modelId ?? ""}`),
	).length;

	return normalizedEntries.map((entry) => ({
		...entry,
		...inferConnection({
			label: entry.label,
			modelId: entry.modelId,
			usbIosDeviceCount,
			continuityCameraCount,
		}),
	}));
}

export async function getAudioDeviceConnectionInfo(): Promise<AudioDeviceConnectionInfo[]> {
	const audioEntries = await readNativeAudioEntries();

	return audioEntries.map((entry) => ({
		...entry,
		...inferAudioConnection({
			label: entry.label,
			modelId: entry.modelId,
			uniqueId: entry.uniqueId,
		}),
	}));
}

export function registerDeviceHandlers() {
	ipcMain.handle("get-video-device-connection-info", async () => {
		try {
			return {
				success: true,
				devices: await getVideoDeviceConnectionInfo(),
			};
		} catch (error) {
			return {
				success: false,
				devices: [],
				error: error instanceof Error ? error.message : String(error),
			};
		}
	});

	ipcMain.handle("get-audio-device-connection-info", async () => {
		try {
			return {
				success: true,
				devices: await getAudioDeviceConnectionInfo(),
			};
		} catch (error) {
			return {
				success: false,
				devices: [],
				error: error instanceof Error ? error.message : String(error),
			};
		}
	});
}
