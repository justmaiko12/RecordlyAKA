import { readFileSync, renameSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { SelectedSource } from "../types";

export const MAC_RECOVERY_MANIFEST_SUFFIX = ".recordly-recovery.json";
export const MAC_RECOVERY_FRAGMENT_INTERVAL_SECONDS = 5;

export type MacRecoveryManifest = {
	version: 1;
	backend: "mac-screencapturekit";
	status: "active" | "finalized" | "failed";
	createdAt: string;
	updatedAt: string;
	videoPath: string;
	systemAudioPath: string | null;
	microphonePath: string | null;
	webcamPath: string | null;
	sourceId: string | null;
	sourceType: SelectedSource["sourceType"] | "unknown";
	displayId: number | null;
	helperPid: number | null;
	fragmentIntervalSeconds: number;
	failureReason?: string;
};

export type MacRecoveryCandidate = {
	videoPath: string;
	systemAudioPath: string | null;
	microphonePath: string | null;
	webcamPath: string | null;
	manifestPath: string | null;
	updatedAtMs: number;
};

type WriteMacRecoveryManifestInput = {
	videoPath: string;
	systemAudioPath?: string | null;
	microphonePath?: string | null;
	webcamPath?: string | null;
	sourceId?: string | null;
	sourceType?: SelectedSource["sourceType"] | "unknown";
	displayId?: number | null;
	helperPid?: number | null;
	fragmentIntervalSeconds?: number;
};

type FindMacRecoveryCandidatesInput = {
	recordingsDir: string;
	currentTargetPath?: string | null;
	currentSystemAudioPath?: string | null;
	currentMicrophonePath?: string | null;
	currentWebcamPath?: string | null;
	includeDiagnosticsCandidate?: boolean;
	diagnosticsPath?: string | null;
	diagnosticsSystemAudioPath?: string | null;
	diagnosticsMicrophonePath?: string | null;
	diagnosticsWebcamPath?: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeNullableString(value: unknown) {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function normalizeNullableNumber(value: unknown) {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeSourceType(value: unknown): SelectedSource["sourceType"] | "unknown" {
	return value === "screen" || value === "window" ? value : "unknown";
}

function normalizeFailureReason(value: unknown) {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function parseManifest(raw: unknown): MacRecoveryManifest | null {
	if (!isRecord(raw)) {
		return null;
	}

	if (
		raw.version !== 1 ||
		raw.backend !== "mac-screencapturekit" ||
		(raw.status !== "active" && raw.status !== "finalized" && raw.status !== "failed") ||
		typeof raw.createdAt !== "string" ||
		typeof raw.updatedAt !== "string" ||
		typeof raw.videoPath !== "string" ||
		raw.videoPath.length === 0
	) {
		return null;
	}

	return {
		version: 1,
		backend: "mac-screencapturekit",
		status: raw.status,
		createdAt: raw.createdAt,
		updatedAt: raw.updatedAt,
		videoPath: raw.videoPath,
		systemAudioPath: normalizeNullableString(raw.systemAudioPath),
		microphonePath: normalizeNullableString(raw.microphonePath),
		webcamPath: normalizeNullableString(raw.webcamPath),
		sourceId: normalizeNullableString(raw.sourceId),
		sourceType: normalizeSourceType(raw.sourceType),
		displayId: normalizeNullableNumber(raw.displayId),
		helperPid: normalizeNullableNumber(raw.helperPid),
		fragmentIntervalSeconds:
			normalizeNullableNumber(raw.fragmentIntervalSeconds) ??
			MAC_RECOVERY_FRAGMENT_INTERVAL_SECONDS,
		...(normalizeFailureReason(raw.failureReason)
			? { failureReason: normalizeFailureReason(raw.failureReason) }
			: {}),
	};
}

function timestampMs(value: string | null | undefined) {
	if (!value) {
		return null;
	}
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

async function fileStat(filePath: string) {
	try {
		const stat = await fs.stat(filePath);
		return stat.isFile() && stat.size > 0 ? stat : null;
	} catch {
		return null;
	}
}

export function getMacRecoveryManifestPath(videoPath: string) {
	const parsed = path.parse(videoPath);
	const baseName = parsed.ext ? parsed.name : parsed.base;
	return path.join(parsed.dir, `${baseName}${MAC_RECOVERY_MANIFEST_SUFFIX}`);
}

export async function readMacRecoveryManifest(
	manifestPath: string,
): Promise<MacRecoveryManifest | null> {
	try {
		const raw = JSON.parse(await fs.readFile(manifestPath, "utf8"));
		return parseManifest(raw);
	} catch {
		return null;
	}
}

export async function writeMacRecoveryManifest(input: WriteMacRecoveryManifestInput) {
	const manifestPath = getMacRecoveryManifestPath(input.videoPath);
	const existing = await readMacRecoveryManifest(manifestPath);
	const now = new Date().toISOString();
	const manifest: MacRecoveryManifest = {
		version: 1,
		backend: "mac-screencapturekit",
		status: "active",
		createdAt: existing?.createdAt ?? now,
		updatedAt: now,
		videoPath: input.videoPath,
		systemAudioPath: input.systemAudioPath ?? null,
		microphonePath: input.microphonePath ?? null,
		webcamPath: input.webcamPath ?? null,
		sourceId: input.sourceId ?? null,
		sourceType: input.sourceType ?? "unknown",
		displayId: input.displayId ?? null,
		helperPid: input.helperPid ?? null,
		fragmentIntervalSeconds:
			input.fragmentIntervalSeconds ?? MAC_RECOVERY_FRAGMENT_INTERVAL_SECONDS,
	};

	await fs.mkdir(path.dirname(manifestPath), { recursive: true });
	await writeManifestFile(manifestPath, manifest);
	return manifest;
}

async function writeManifestFile(manifestPath: string, manifest: MacRecoveryManifest) {
	const tempPath = `${manifestPath}.${process.pid}.${Date.now()}.tmp`;
	await fs.writeFile(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
	await fs.rename(tempPath, manifestPath);
}

function writeManifestFileSync(manifestPath: string, manifest: MacRecoveryManifest) {
	const tempPath = `${manifestPath}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
	renameSync(tempPath, manifestPath);
}

export async function markMacRecoveryManifestFinalized(videoPath: string) {
	const manifestPath = getMacRecoveryManifestPath(videoPath);
	const existing = await readMacRecoveryManifest(manifestPath);
	if (!existing) {
		return null;
	}

	const manifest: MacRecoveryManifest = {
		...existing,
		status: "finalized",
		updatedAt: new Date().toISOString(),
	};
	await writeManifestFile(manifestPath, manifest);
	return manifest;
}

export async function markMacRecoveryManifestFailed(videoPath: string, failureReason?: string) {
	const manifestPath = getMacRecoveryManifestPath(videoPath);
	const existing = await readMacRecoveryManifest(manifestPath);
	if (!existing) {
		return null;
	}

	const manifest: MacRecoveryManifest = {
		...existing,
		status: "failed",
		updatedAt: new Date().toISOString(),
		...(failureReason?.trim() ? { failureReason: failureReason.trim() } : {}),
	};
	await writeManifestFile(manifestPath, manifest);
	return manifest;
}

export async function clearMacRecoveryManifestWebcamPath(
	videoPath: string,
	failureReason?: string,
) {
	const manifestPath = getMacRecoveryManifestPath(videoPath);
	const existing = await readMacRecoveryManifest(manifestPath);
	if (!existing) {
		return null;
	}

	const manifest: MacRecoveryManifest = {
		...existing,
		webcamPath: null,
		updatedAt: new Date().toISOString(),
		...(failureReason?.trim() ? { failureReason: failureReason.trim() } : {}),
	};
	await writeManifestFile(manifestPath, manifest);
	return manifest;
}

export function clearMacRecoveryManifestWebcamPathSync(
	videoPath: string,
	failureReason?: string,
) {
	const manifestPath = getMacRecoveryManifestPath(videoPath);
	let existing: MacRecoveryManifest | null = null;
	try {
		existing = parseManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
	} catch {
		return null;
	}
	if (!existing) {
		return null;
	}

	const manifest: MacRecoveryManifest = {
		...existing,
		webcamPath: null,
		updatedAt: new Date().toISOString(),
		...(failureReason?.trim() ? { failureReason: failureReason.trim() } : {}),
	};
	writeManifestFileSync(manifestPath, manifest);
	return manifest;
}

export async function removeMacRecoveryManifest(videoPath: string | null | undefined) {
	if (!videoPath) {
		return;
	}
	await fs.rm(getMacRecoveryManifestPath(videoPath), { force: true }).catch(() => undefined);
}

async function buildCandidate(
	videoPath: string | null | undefined,
	options: {
		systemAudioPath?: string | null;
		microphonePath?: string | null;
		webcamPath?: string | null;
		manifestPath?: string | null;
		manifestUpdatedAt?: string | null;
	},
): Promise<MacRecoveryCandidate | null> {
	if (!videoPath) {
		return null;
	}

	const stat = await fileStat(videoPath);
	if (!stat) {
		return null;
	}

	return {
		videoPath,
		systemAudioPath: options.systemAudioPath ?? null,
		microphonePath: options.microphonePath ?? null,
		webcamPath: options.webcamPath ?? null,
		manifestPath: options.manifestPath ?? null,
		updatedAtMs: Math.max(timestampMs(options.manifestUpdatedAt) ?? 0, stat.mtimeMs),
	};
}

export async function findMacRecoveryCandidates({
	recordingsDir,
	currentTargetPath,
	currentSystemAudioPath,
	currentMicrophonePath,
	currentWebcamPath,
	includeDiagnosticsCandidate = true,
	diagnosticsPath,
	diagnosticsSystemAudioPath,
	diagnosticsMicrophonePath,
	diagnosticsWebcamPath,
}: FindMacRecoveryCandidatesInput) {
	const candidates: MacRecoveryCandidate[] = [];
	const seen = new Set<string>();

	const addCandidate = (candidate: MacRecoveryCandidate | null) => {
		if (!candidate || seen.has(candidate.videoPath)) {
			return;
		}
		seen.add(candidate.videoPath);
		candidates.push(candidate);
	};

	addCandidate(
		await buildCandidate(currentTargetPath, {
			systemAudioPath: currentSystemAudioPath,
			microphonePath: currentMicrophonePath,
			webcamPath: currentWebcamPath,
		}),
	);
	if (includeDiagnosticsCandidate) {
		addCandidate(
			await buildCandidate(diagnosticsPath, {
				systemAudioPath: diagnosticsSystemAudioPath,
				microphonePath: diagnosticsMicrophonePath,
				webcamPath: diagnosticsWebcamPath,
			}),
		);
	}

	let manifestEntries: string[] = [];
	try {
		manifestEntries = await fs.readdir(recordingsDir);
	} catch {
		return candidates;
	}

	const manifestCandidates = await Promise.all(
		manifestEntries
			.filter((entry) => entry.endsWith(MAC_RECOVERY_MANIFEST_SUFFIX))
			.map(async (entry) => {
				const manifestPath = path.join(recordingsDir, entry);
				const manifest = await readMacRecoveryManifest(manifestPath);
				if (!manifest || manifest.status !== "active") {
					return null;
				}
				return buildCandidate(manifest.videoPath, {
					systemAudioPath: manifest.systemAudioPath,
					microphonePath: manifest.microphonePath,
					webcamPath: manifest.webcamPath,
					manifestPath,
					manifestUpdatedAt: manifest.updatedAt,
				});
			}),
	);

	for (const candidate of manifestCandidates
		.filter((candidate): candidate is MacRecoveryCandidate => candidate !== null)
		.sort((left, right) => right.updatedAtMs - left.updatedAtMs)) {
		addCandidate(candidate);
	}

	return candidates;
}
