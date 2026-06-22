import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("mac recording recovery manifest", () => {
	let tempRoot: string;

	beforeEach(async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-mac-recovery-"));
	});

	afterEach(async () => {
		if (tempRoot) {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	it("writes an active manifest beside the video so a restarted app can find it", async () => {
		const { getMacRecoveryManifestPath, readMacRecoveryManifest, writeMacRecoveryManifest } =
			await import("./macRecoveryManifest");
		const videoPath = path.join(tempRoot, "recording-123.mp4");

		await writeMacRecoveryManifest({
			videoPath,
			systemAudioPath: path.join(tempRoot, "recording-123.system.m4a"),
			microphonePath: null,
			webcamPath: path.join(tempRoot, "recording-123-webcam.mp4"),
			sourceId: "screen:1",
			sourceType: "screen",
			displayId: 1,
			helperPid: 42,
		});

		const manifestPath = getMacRecoveryManifestPath(videoPath);
		const manifest = await readMacRecoveryManifest(manifestPath);

		expect(manifest).toMatchObject({
			version: 1,
			status: "active",
			backend: "mac-screencapturekit",
			videoPath,
			systemAudioPath: path.join(tempRoot, "recording-123.system.m4a"),
			microphonePath: null,
			webcamPath: path.join(tempRoot, "recording-123-webcam.mp4"),
			sourceId: "screen:1",
			sourceType: "screen",
			displayId: 1,
			helperPid: 42,
		});
		expect(manifest?.createdAt).toEqual(expect.any(String));
		expect(manifest?.updatedAt).toEqual(expect.any(String));
	});

	it("finds active manifest candidates after in-memory capture state was lost", async () => {
		const {
			findMacRecoveryCandidates,
			writeMacRecoveryManifest,
			markMacRecoveryManifestFinalized,
		} = await import("./macRecoveryManifest");
		const staleVideoPath = path.join(tempRoot, "recording-100.mp4");
		const activeVideoPath = path.join(tempRoot, "recording-200.mp4");
		const finalizedVideoPath = path.join(tempRoot, "recording-300.mp4");

		await fs.writeFile(staleVideoPath, "stale");
		await fs.writeFile(activeVideoPath, "active");
		await fs.writeFile(finalizedVideoPath, "finalized");
		await writeMacRecoveryManifest({ videoPath: staleVideoPath });
		await writeMacRecoveryManifest({
			videoPath: activeVideoPath,
			systemAudioPath: path.join(tempRoot, "recording-200.system.m4a"),
			webcamPath: path.join(tempRoot, "recording-200-webcam.mp4"),
		});
		await writeMacRecoveryManifest({ videoPath: finalizedVideoPath });
		await markMacRecoveryManifestFinalized(finalizedVideoPath);

		const activeTime = new Date(Date.now() + 10_000);
		await fs.utimes(activeVideoPath, activeTime, activeTime);

		const candidates = await findMacRecoveryCandidates({
			recordingsDir: tempRoot,
			currentTargetPath: null,
			diagnosticsPath: null,
		});

		expect(candidates.map((candidate) => candidate.videoPath)).toEqual([
			activeVideoPath,
			staleVideoPath,
		]);
		expect(candidates[0]).toMatchObject({
			videoPath: activeVideoPath,
			systemAudioPath: path.join(tempRoot, "recording-200.system.m4a"),
			webcamPath: path.join(tempRoot, "recording-200-webcam.mp4"),
		});
	});

	it("marks corrupt manifests failed so recovery does not retry them forever", async () => {
		const {
			findMacRecoveryCandidates,
			markMacRecoveryManifestFailed,
			readMacRecoveryManifest,
			writeMacRecoveryManifest,
			getMacRecoveryManifestPath,
		} = await import("./macRecoveryManifest");
		const videoPath = path.join(tempRoot, "recording-400.mp4");

		await fs.writeFile(videoPath, "not a valid mp4");
		await writeMacRecoveryManifest({ videoPath });
		await markMacRecoveryManifestFailed(videoPath, "moov atom not found");

		const candidates = await findMacRecoveryCandidates({
			recordingsDir: tempRoot,
			currentTargetPath: null,
			diagnosticsPath: null,
		});
		const manifest = await readMacRecoveryManifest(getMacRecoveryManifestPath(videoPath));

		expect(candidates).toEqual([]);
		expect(manifest).toMatchObject({
			status: "failed",
			failureReason: "moov atom not found",
		});
	});

	it("clears rejected webcam paths without losing screen recovery", async () => {
		const {
			clearMacRecoveryManifestWebcamPath,
			clearMacRecoveryManifestWebcamPathSync,
			findMacRecoveryCandidates,
			getMacRecoveryManifestPath,
			readMacRecoveryManifest,
			writeMacRecoveryManifest,
		} = await import("./macRecoveryManifest");
		const videoPath = path.join(tempRoot, "recording-450.mp4");
		const webcamPath = path.join(tempRoot, "recording-450-webcam.mp4");

		await fs.writeFile(videoPath, "screen");
		await fs.writeFile(webcamPath, "rejected webcam");
		await writeMacRecoveryManifest({
			videoPath,
			webcamPath,
			systemAudioPath: path.join(tempRoot, "recording-450.system.m4a"),
		});

		await clearMacRecoveryManifestWebcamPath(videoPath, "main-webcam-low-cadence");
		clearMacRecoveryManifestWebcamPathSync(videoPath, "main-webcam-low-cadence-sync");

		const manifest = await readMacRecoveryManifest(getMacRecoveryManifestPath(videoPath));
		const candidates = await findMacRecoveryCandidates({
			recordingsDir: tempRoot,
			currentTargetPath: null,
			diagnosticsPath: null,
		});

		expect(manifest).toMatchObject({
			status: "active",
			videoPath,
			webcamPath: null,
			failureReason: "main-webcam-low-cadence-sync",
		});
		expect(candidates).toHaveLength(1);
		expect(candidates[0]).toMatchObject({
			videoPath,
			webcamPath: null,
			systemAudioPath: path.join(tempRoot, "recording-450.system.m4a"),
		});
	});

	it("can ignore diagnostics-only candidates during startup recovery", async () => {
		const {
			findMacRecoveryCandidates,
			markMacRecoveryManifestFinalized,
			writeMacRecoveryManifest,
		} = await import("./macRecoveryManifest");
		const finalizedVideoPath = path.join(tempRoot, "recording-500.mp4");

		await fs.writeFile(finalizedVideoPath, "finalized");
		await writeMacRecoveryManifest({ videoPath: finalizedVideoPath });
		await markMacRecoveryManifestFinalized(finalizedVideoPath);

		const startupCandidates = await findMacRecoveryCandidates({
			recordingsDir: tempRoot,
			currentTargetPath: null,
			includeDiagnosticsCandidate: false,
			diagnosticsPath: finalizedVideoPath,
		});
		const explicitRecoveryCandidates = await findMacRecoveryCandidates({
			recordingsDir: tempRoot,
			currentTargetPath: null,
			includeDiagnosticsCandidate: true,
			diagnosticsPath: finalizedVideoPath,
		});

		expect(startupCandidates).toEqual([]);
		expect(explicitRecoveryCandidates.map((candidate) => candidate.videoPath)).toEqual([
			finalizedVideoPath,
		]);
	});
});
