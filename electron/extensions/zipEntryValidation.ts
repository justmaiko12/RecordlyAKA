/**
 * Pre-extraction zip entry validation.
 *
 * Parses the zip central directory directly (no extraction, no external
 * tools) and rejects archives containing entries that could escape the
 * extraction directory: absolute paths, `..` traversal segments, drive
 * letters, and symlinks. Running this BEFORE extraction closes the TOCTOU
 * window where a hostile archive writes outside the target directory (for
 * example via a symlink entry that later entries write through) before any
 * post-extraction scan can notice.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
// EOCD is 22 bytes plus up to 65535 bytes of zip comment.
const MAX_EOCD_SCAN = 22 + 0xffff;
const UNIX_HOST = 3;
const S_IFMT = 0xf000;
const S_IFLNK = 0xa000;

export class ZipValidationError extends Error {}

function findEndOfCentralDirectory(buffer: Buffer): number {
	const scanStart = Math.max(0, buffer.length - MAX_EOCD_SCAN);
	for (let offset = buffer.length - 22; offset >= scanStart; offset--) {
		if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) {
			return offset;
		}
	}
	throw new ZipValidationError("Not a zip archive (missing end-of-central-directory record)");
}

function isUnsafeEntryName(name: string): boolean {
	if (!name || name.includes("\0")) {
		return true;
	}

	// Absolute posix path, Windows drive path, or UNC path.
	if (name.startsWith("/") || /^[A-Za-z]:/.test(name) || name.startsWith("\\\\")) {
		return true;
	}

	// Any `..` path segment (either separator) escapes the extraction root.
	const segments = name.split(/[\\/]/);
	return segments.includes("..");
}

/**
 * Validate every entry in the archive's central directory.
 * Throws ZipValidationError describing the first offending entry.
 */
export function assertSafeZipEntries(zipBuffer: Buffer): void {
	const eocdOffset = findEndOfCentralDirectory(zipBuffer);
	const entryCount = zipBuffer.readUInt16LE(eocdOffset + 10);
	const centralDirectoryOffset = zipBuffer.readUInt32LE(eocdOffset + 16);

	// Zip64 archives store 0xffff/0xffffffff sentinels here. Extensions are
	// small; refuse rather than mis-parse.
	if (entryCount === 0xffff || centralDirectoryOffset === 0xffffffff) {
		throw new ZipValidationError("Zip64 archives are not supported for extensions");
	}

	let offset = centralDirectoryOffset;
	for (let index = 0; index < entryCount; index++) {
		if (offset + 46 > zipBuffer.length) {
			throw new ZipValidationError("Corrupt zip: central directory truncated");
		}
		if (zipBuffer.readUInt32LE(offset) !== CENTRAL_HEADER_SIGNATURE) {
			throw new ZipValidationError("Corrupt zip: bad central directory entry signature");
		}

		const versionMadeBy = zipBuffer.readUInt16LE(offset + 4);
		const nameLength = zipBuffer.readUInt16LE(offset + 28);
		const extraLength = zipBuffer.readUInt16LE(offset + 30);
		const commentLength = zipBuffer.readUInt16LE(offset + 32);
		const externalAttributes = zipBuffer.readUInt32LE(offset + 38);
		const name = zipBuffer.toString("utf8", offset + 46, offset + 46 + nameLength);

		if (isUnsafeEntryName(name)) {
			throw new ZipValidationError(`Unsafe path in archive: ${name}`);
		}

		const hostOs = versionMadeBy >> 8;
		if (hostOs === UNIX_HOST) {
			const unixMode = (externalAttributes >>> 16) & 0xffff;
			if ((unixMode & S_IFMT) === S_IFLNK) {
				throw new ZipValidationError(`Symlink entry in archive: ${name}`);
			}
		}

		offset += 46 + nameLength + extraLength + commentLength;
	}
}
