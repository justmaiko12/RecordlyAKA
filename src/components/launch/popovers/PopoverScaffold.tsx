import { MicrophoneIcon, MicrophoneSlashIcon } from "@phosphor-icons/react";
import type { ReactElement, ReactNode } from "react";
import { AudioLevelMeter } from "@/components/ui/audio-level-meter";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useAudioLevelMeter } from "@/hooks/useAudioLevelMeter";
import styles from "../LaunchWindow.module.css";
import "../launchTheme.css";
import { useHudInteraction } from "../contexts/HudInteractionContext";
import type { DeviceOption } from "./launchPopoverTypes";

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

export function DeviceConnectionTag({ device }: { device: DeviceOption }) {
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

export function DropdownItem({
	onClick,
	selected,
	icon,
	children,
	trailing,
}: {
	onClick: () => void;
	selected?: boolean;
	icon: ReactNode;
	children: ReactNode;
	trailing?: ReactNode;
}) {
	return (
		<button
			type="button"
			className={`${styles.ddItem} ${selected ? styles.ddItemSelected : ""}`}
			onClick={onClick}
		>
			<span className="shrink-0">{icon}</span>
			<span className="min-w-0 flex-1 truncate">{children}</span>
			{trailing}
		</button>
	);
}

export function MicDeviceRow({
	device,
	selected,
	onSelect,
}: {
	device: DeviceOption;
	selected: boolean;
	onSelect: () => void;
}) {
	const { level } = useAudioLevelMeter({
		enabled: !device.nativeOnly,
		deviceId: device.deviceId,
	});

	return (
		<button
			type="button"
			className={`${styles.ddItem} ${selected ? styles.ddItemSelected : ""}`}
			onClick={onSelect}
		>
			<span className="shrink-0">
				{selected ? <MicrophoneIcon size={16} /> : <MicrophoneSlashIcon size={16} />}
			</span>
			<span className="truncate flex-1">{device.label}</span>
			<DeviceConnectionTag device={device} />
			{!device.nativeOnly ? <AudioLevelMeter level={level} className="w-16 shrink-0" /> : null}
		</button>
	);
}

export function HudPopover({
	open,
	onOpenChange,
	trigger,
	children,
	align = "center",
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	trigger: ReactElement;
	children: ReactNode;
	align?: "start" | "center" | "end";
}) {
	const { onMouseEnter } = useHudInteraction();
	return (
		<Popover open={open} onOpenChange={onOpenChange} modal={false}>
			<PopoverTrigger asChild>{trigger}</PopoverTrigger>
			<PopoverContent
				className={`launch-theme ${styles.menuCard} ${styles.electronNoDrag}`}
				data-hud-interactive
				unstyled
				side="top"
				align={align}
				sideOffset={8}
				avoidCollisions
				collisionPadding={10}
				usePortal={false}
				onMouseEnter={onMouseEnter}
			>
				{children}
			</PopoverContent>
		</Popover>
	);
}
