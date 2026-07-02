import type { Icon, IconProps } from "@phosphor-icons/react";
import * as PhosphorIcons from "@phosphor-icons/react";
import { EXTENSION_PROTOCOL_PREFIX } from "@/lib/extensions/fileUrls";

const WINDOWS_ABSOLUTE_PATH = /^[a-zA-Z]:[\\/]/;
const { PuzzlePiece } = PhosphorIcons;

const ICON_NAME_ALIASES: Record<string, keyof typeof PhosphorIcons> = {
	Check: "Check",
	ChevronDown: "CaretDown",
	ChevronLeft: "CaretLeft",
	ChevronRight: "CaretRight",
	ChevronUp: "CaretUp",
	Download: "DownloadSimple",
	ExternalLink: "ArrowSquareOut",
	Film: "FilmSlate",
	FolderOpen: "FolderOpen",
	HelpCircle: "Question",
	ImageIcon: "ImageSquare",
	Loader2: "Spinner",
	MessageSquare: "ChatCircle",
	MessageSquareMore: "ChatCircleDots",
	Palette: "Palette",
	Puzzle: "PuzzlePiece",
	Redo2: "ArrowClockwise",
	RefreshCw: "ArrowClockwise",
	RotateCcw: "ArrowCounterClockwise",
	Save: "FloppyDisk",
	Search: "MagnifyingGlass",
	Settings2: "Gear",
	ShieldAlert: "ShieldWarning",
	Trash2: "Trash",
	Twitter: "TwitterLogo",
	Undo2: "ArrowCounterClockwise",
	Upload: "UploadSimple",
	User: "UserCircle",
	Volume1: "SpeakerLow",
	Volume2: "SpeakerHigh",
	VolumeX: "SpeakerX",
	WandSparkles: "MagicWand",
	ZoomIn: "MagnifyingGlassPlus",
};

function isImagePath(value: string): boolean {
	return (
		value.startsWith("data:") ||
		value.startsWith("file://") ||
		value.startsWith("recordly-ext://") ||
		value.startsWith("http://") ||
		value.startsWith("https://") ||
		value.includes("/") ||
		/\.(png|svg|jpg|jpeg|webp|gif)$/i.test(value)
	);
}

// Extension icons load over recordly-ext:// — with webSecurity enabled, raw
// file:// images are blocked on the http-served renderer.
function toExtensionHref(filePath: string): string {
	const normalized = filePath.replace(/\\/g, "/");

	if (normalized.startsWith(`${EXTENSION_PROTOCOL_PREFIX}/`)) {
		return normalized;
	}

	if (normalized.startsWith("file://")) {
		return `${EXTENSION_PROTOCOL_PREFIX}${normalized.replace(/^file:\/\//, "")}`;
	}

	if (normalized.startsWith("/")) {
		return `${EXTENSION_PROTOCOL_PREFIX}${normalized}`;
	}

	if (WINDOWS_ABSOLUTE_PATH.test(normalized)) {
		return `${EXTENSION_PROTOCOL_PREFIX}/${normalized}`;
	}

	return normalized;
}

function resolveIconSrc(icon: string, extensionPath?: string | null): string | null {
	if (!isImagePath(icon)) {
		return null;
	}

	if (
		icon.startsWith("data:") ||
		icon.startsWith("recordly-ext://") ||
		icon.startsWith("http://") ||
		icon.startsWith("https://")
	) {
		return icon;
	}

	if (icon.startsWith("file://") || icon.startsWith("/") || WINDOWS_ABSOLUTE_PATH.test(icon)) {
		return toExtensionHref(icon);
	}

	if (!extensionPath) {
		return icon;
	}

	const baseHref = toExtensionHref(
		extensionPath.endsWith("/") ? extensionPath : `${extensionPath}/`,
	);
	return new URL(icon, baseHref).toString();
}

function resolvePhosphorIcon(name: string): Icon | null {
	const direct = PhosphorIcons[name as keyof typeof PhosphorIcons];
	if (typeof direct === "function") {
		return direct as Icon;
	}

	const alias = ICON_NAME_ALIASES[name];
	if (!alias) {
		return null;
	}

	const mapped = PhosphorIcons[alias];
	return typeof mapped === "function" ? (mapped as Icon) : null;
}

/**
	* Renders either a Phosphor icon (by PascalCase name) or an image (by path/URL).
	* Falls back to the PuzzlePiece icon if nothing matches.
 */
export function ExtensionIcon({
	icon,
	extensionPath,
	className = "w-4 h-4",
	imageClassName,
	...rest
}: {
	icon?: string | null;
	extensionPath?: string | null;
	className?: string;
	imageClassName?: string;
} & Omit<IconProps, "ref">) {
	if (!icon) {
		return <PuzzlePiece className={className} {...rest} />;
	}

	const iconSrc = resolveIconSrc(icon, extensionPath);
	if (iconSrc) {
		return (
			<img
				src={iconSrc}
				alt=""
				className={imageClassName ?? className}
				style={{ objectFit: "cover" }}
			/>
		);
	}

	const PhosphorIcon = resolvePhosphorIcon(icon);
	if (PhosphorIcon) {
		return <PhosphorIcon className={className} {...rest} />;
	}

	return <PuzzlePiece className={className} {...rest} />;
}
