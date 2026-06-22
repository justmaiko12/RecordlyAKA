import { spawnSync } from "node:child_process";
import { cp, rm } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();
const releaseRoot = path.join(projectRoot, "release");
const sourceBinRoot = path.join(projectRoot, "electron", "native", "bin");

function relativePath(filePath) {
	return path.relative(projectRoot, filePath).replaceAll("\\", "/");
}

function findDirectoriesByName(rootDir, directoryName, maxDepth = 8) {
	if (!existsSync(rootDir)) {
		return [];
	}

	const matches = [];
	const queue = [{ dir: rootDir, depth: 0 }];

	while (queue.length > 0) {
		const current = queue.shift();
		if (!current || current.depth > maxDepth) {
			continue;
		}

		for (const entry of readdirSync(current.dir, { withFileTypes: true })) {
			if (!entry.isDirectory()) {
				continue;
			}

			const childDir = path.join(current.dir, entry.name);
			if (entry.name === directoryName) {
				matches.push(childDir);
				continue;
			}

			queue.push({ dir: childDir, depth: current.depth + 1 });
		}
	}

	return matches;
}

function findAppBundleDir(startDir) {
	let current = startDir;
	while (current !== path.dirname(current)) {
		if (current.endsWith(".app")) {
			return current;
		}
		current = path.dirname(current);
	}

	return null;
}

function signMacAppBundle(appBundleDir) {
	if (process.platform !== "darwin" || !appBundleDir) {
		return;
	}

	const result = spawnSync("codesign", ["--force", "--deep", "--sign", "-", appBundleDir], {
		encoding: "utf8",
	});

	if (result.status !== 0) {
		const details = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
		throw new Error(
			`[sync-packaged-native-helpers] failed to re-sign ${relativePath(appBundleDir)} after helper sync: ${details}`,
		);
	}

	console.log(`[sync-packaged-native-helpers] re-signed ${relativePath(appBundleDir)}`);
}

if (!existsSync(sourceBinRoot)) {
	throw new Error(`[sync-packaged-native-helpers] Source helper bin missing: ${sourceBinRoot}`);
}

const unpackedRoots = findDirectoriesByName(releaseRoot, "app.asar.unpacked");

if (unpackedRoots.length === 0) {
	throw new Error("[sync-packaged-native-helpers] no packaged app.asar.unpacked directory found");
}

async function syncDirectory(sourceDir, targetDir) {
	if (process.platform !== "win32") {
		const result = spawnSync("rsync", ["-a", "--delete", `${sourceDir}/`, `${targetDir}/`], {
			encoding: "utf8",
		});
		if (result.status === 0) {
			return;
		}

		const details = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
		console.warn(
			`[sync-packaged-native-helpers] rsync failed; falling back to node copy: ${details}`,
		);
	}

	await rm(targetDir, { recursive: true, force: true });
	await cp(sourceDir, targetDir, { recursive: true, force: true });
}

for (const unpackedRoot of unpackedRoots) {
	const packagedBinRoot = path.join(unpackedRoot, "electron", "native", "bin");
	await syncDirectory(sourceBinRoot, packagedBinRoot);
	console.log(
		`[sync-packaged-native-helpers] synced ${relativePath(sourceBinRoot)} -> ${relativePath(packagedBinRoot)}`,
	);

	signMacAppBundle(findAppBundleDir(unpackedRoot));
}
