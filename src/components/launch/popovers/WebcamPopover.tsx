import {
	ArrowClockwise,
	CornersIn,
	CornersOut,
	VideoCamera as Video,
	VideoCameraSlash as VideoOff,
} from "@phosphor-icons/react";
import type { ReactElement, SyntheticEvent } from "react";
import { useScopedT } from "@/contexts/I18nContext";
import {
	WEBCAM_FRAME_RATE_OPTIONS,
	WEBCAM_QUALITY_MODE_OPTIONS,
	type WebcamFrameRate,
	type WebcamQualityMode,
} from "@/lib/webcamSession";
import { useLaunchPopoverCoordinator } from "./LaunchPopoverCoordinator";
import type { DeviceOption } from "./launchPopoverTypes";
import { DropdownItem, HudPopover } from "./PopoverScaffold";

const POPOVER_ID = "webcam";

function getConnectionTagClass(device: DeviceOption) {
	switch (device.connection?.kind) {
		case "usb":
			return device.connection.confidence === "ambiguous"
				? "border-amber-400/30 bg-amber-400/10 text-amber-200"
				: "border-emerald-400/30 bg-emerald-400/10 text-emerald-200";
		case "wireless":
			return "border-sky-400/30 bg-sky-400/10 text-sky-200";
		case "built-in":
			return "border-white/15 bg-white/10 text-[var(--launch-text-muted)]";
		default:
			return "border-white/10 bg-white/5 text-[var(--launch-label)]";
	}
}

function getConnectionTag(device: DeviceOption) {
	if (!device.connection) {
		return null;
	}

	return (
		<span
			className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold leading-none ${getConnectionTagClass(
				device,
			)}`}
			title={device.connection.detail ?? undefined}
			aria-label={`${device.label} connection: ${device.connection.label}`}
		>
			{device.connection.label}
		</span>
	);
}

export function WebcamPopover({
	trigger,
	disabled,
	webcamEnabled,
	onDisableWebcam,
	webcamLayoutStyle,
	onWebcamLayoutStyleChange,
	showWebcamControls,
	setWebcamPreviewNode,
	nativePreviewPreferred,
	nativePreviewUrl,
	nativePreviewImageIssue,
	onNativePreviewImageLoad,
	onNativePreviewImageError,
	videoDevices,
	webcamDeviceId,
	selectedVideoDeviceId,
	onSelectVideoDevice,
	onRefreshVideoDevices,
	videoDevicesLoading,
	videoDevicesError,
	webcamFrameRate,
	onWebcamFrameRateChange,
	webcamQualityMode,
	onWebcamQualityModeChange,
}: {
	trigger: ReactElement;
	disabled?: boolean;
	webcamEnabled: boolean;
	onDisableWebcam: () => void;
	webcamLayoutStyle: "fit" | "fill";
	onWebcamLayoutStyleChange: (style: "fit" | "fill") => void;
	showWebcamControls: boolean;
	setWebcamPreviewNode: (node: HTMLVideoElement | null) => void;
	nativePreviewPreferred?: boolean;
	nativePreviewUrl?: string | null;
	nativePreviewImageIssue?: boolean;
	onNativePreviewImageLoad?: (event: SyntheticEvent<HTMLImageElement>) => void;
	onNativePreviewImageError?: (event: SyntheticEvent<HTMLImageElement>) => void;
	videoDevices: DeviceOption[];
	webcamDeviceId?: string;
	selectedVideoDeviceId?: string;
	onSelectVideoDevice: (deviceId: string) => void;
	onRefreshVideoDevices: () => void;
	videoDevicesLoading?: boolean;
	videoDevicesError?: string | null;
	webcamFrameRate: WebcamFrameRate;
	onWebcamFrameRateChange: (frameRate: WebcamFrameRate) => void;
	webcamQualityMode: WebcamQualityMode;
	onWebcamQualityModeChange: (qualityMode: WebcamQualityMode) => void;
}) {
	const t = useScopedT("launch");
	const { isOpen, requestOpen, requestClose } = useLaunchPopoverCoordinator();
	const open = isOpen(POPOVER_ID);

	return (
		<HudPopover
			open={open}
			onOpenChange={(nextOpen) => {
				if (!nextOpen) {
					requestClose(POPOVER_ID);
					return;
				}
				if (disabled) {
					return;
				}
				onRefreshVideoDevices();
				requestOpen(POPOVER_ID);
			}}
			trigger={trigger}
			align="center"
		>
			<div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--launch-label)]">
				{t("recording.webcam")}
			</div>
			<DropdownItem icon={<ArrowClockwise size={16} />} onClick={onRefreshVideoDevices}>
				{videoDevicesLoading
					? t("recording.refreshingCameras", "Refreshing cameras")
					: t("recording.refreshCameras", "Refresh cameras")}
			</DropdownItem>
			{webcamEnabled && (
				<>
					<DropdownItem
						icon={<VideoOff size={16} />}
						onClick={() => {
							onDisableWebcam();
							requestClose(POPOVER_ID);
						}}
					>
						{t("recording.turnOffWebcam")}
					</DropdownItem>
					<DropdownItem
						icon={<CornersIn size={16} />}
						selected={webcamLayoutStyle === "fit"}
						onClick={() => onWebcamLayoutStyleChange("fit")}
					>
						{t("recording.webcamStyleFit", "Camera fullscreen: fit with background")}
					</DropdownItem>
					<DropdownItem
						icon={<CornersOut size={16} />}
						selected={webcamLayoutStyle === "fill"}
						onClick={() => onWebcamLayoutStyleChange("fill")}
					>
						{t("recording.webcamStyleFill", "Camera fullscreen: fill screen")}
					</DropdownItem>
				</>
			)}
			{!webcamEnabled && (
				<div className="px-3 py-2 text-xs text-[var(--launch-text-muted)]">
					{t("recording.selectWebcamToEnable")}
				</div>
			)}
			{showWebcamControls && (
				<div className="flex justify-center px-3 py-2">
					<div
						className={`h-24 w-24 overflow-hidden rounded-2xl bg-[var(--launch-hover)] ring-1 ${
							nativePreviewImageIssue
								? "ring-red-400/70"
								: "ring-[var(--launch-border-strong)]"
						}`}
					>
						{nativePreviewPreferred ? (
							nativePreviewUrl ? (
								<img
									src={nativePreviewUrl}
									alt=""
									className="h-full w-full object-cover"
									draggable={false}
									onError={onNativePreviewImageError}
									onLoad={onNativePreviewImageLoad}
									style={{ transform: "scaleX(-1)" }}
								/>
							) : null
						) : (
							<video
								ref={setWebcamPreviewNode}
								className="h-full w-full object-cover"
								muted
								playsInline
								style={{ transform: "scaleX(-1)" }}
							/>
						)}
					</div>
				</div>
			)}
			{videoDevices.map((device) => (
				<DropdownItem
					key={device.deviceId}
					icon={
						webcamEnabled &&
						(webcamDeviceId === device.deviceId ||
							selectedVideoDeviceId === device.deviceId) ? (
							<Video size={16} />
						) : (
							<VideoOff size={16} />
						)
					}
					selected={
						webcamEnabled &&
						(webcamDeviceId === device.deviceId ||
							selectedVideoDeviceId === device.deviceId)
					}
					onClick={() => onSelectVideoDevice(device.deviceId)}
					trailing={getConnectionTag(device)}
				>
					{device.label}
				</DropdownItem>
			))}
			{videoDevices.length === 0 && (
				<div className="text-center text-xs text-[var(--launch-text-muted)] py-4">
					{t("recording.noWebcamsFound")}
				</div>
			)}
			{videoDevicesError && (
				<div className="px-3 pb-2 text-[11px] leading-snug text-red-200/80">
					{videoDevicesError}
				</div>
			)}
			{webcamEnabled && (
				<>
					<div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--launch-label)]">
						{t("recording.webcamQuality", "Quality")}
					</div>
					<div className="grid grid-cols-3 gap-1 px-3 pb-2">
						{WEBCAM_QUALITY_MODE_OPTIONS.map((option) => (
							<button
								key={option.value}
								type="button"
								onClick={() => onWebcamQualityModeChange(option.value)}
								className={`min-w-0 rounded-lg px-2 py-1 text-left ring-1 transition-colors ${
									webcamQualityMode === option.value
										? "bg-[var(--launch-hover)] font-semibold ring-[var(--launch-border-strong)]"
										: "ring-[var(--launch-border)] text-[var(--launch-text-muted)] hover:bg-[var(--launch-hover)]"
								}`}
							>
								<span className="block truncate text-xs leading-tight">{option.label}</span>
								<span className="block truncate text-[10px] leading-tight opacity-70">
									{option.description}
								</span>
							</button>
						))}
					</div>
					<div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--launch-label)]">
						{t("recording.webcamFrameRate", "Frame rate")}
					</div>
					<div className="flex gap-1 px-3 pb-2">
						{WEBCAM_FRAME_RATE_OPTIONS.map((rate) => (
							<button
								key={rate}
								type="button"
								onClick={() => onWebcamFrameRateChange(rate)}
								className={`flex-1 rounded-lg px-2 py-1 text-xs ring-1 transition-colors ${
									webcamFrameRate === rate
										? "bg-[var(--launch-hover)] font-semibold ring-[var(--launch-border-strong)]"
										: "ring-[var(--launch-border)] text-[var(--launch-text-muted)] hover:bg-[var(--launch-hover)]"
								}`}
							>
								{rate} fps
							</button>
						))}
					</div>
				</>
			)}
		</HudPopover>
	);
}
