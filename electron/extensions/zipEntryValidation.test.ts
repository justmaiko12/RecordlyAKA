import { describe, expect, it } from "vitest";
import { assertSafeZipEntries, ZipValidationError } from "./zipEntryValidation";

interface FakeEntry {
	name: string;
	data?: Buffer;
	unixMode?: number;
	hostOs?: number;
}

/** Build a minimal stored (uncompressed) zip archive from entry specs. */
function buildZip(entries: FakeEntry[]): Buffer {
	const localParts: Buffer[] = [];
	const centralParts: Buffer[] = [];
	let localOffset = 0;

	for (const entry of entries) {
		const nameBytes = Buffer.from(entry.name, "utf8");
		const data = entry.data ?? Buffer.alloc(0);

		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4); // version needed
		local.writeUInt32LE(0, 14); // crc (not validated here)
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(nameBytes.length, 26);
		const localRecord = Buffer.concat([local, nameBytes, data]);

		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		const hostOs = entry.hostOs ?? 3; // unix
		central.writeUInt16LE((hostOs << 8) | 20, 4); // version made by
		central.writeUInt16LE(20, 6); // version needed
		central.writeUInt32LE(data.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(nameBytes.length, 28);
		const unixMode = entry.unixMode ?? 0o100644;
		central.writeUInt32LE((unixMode << 16) >>> 0, 38);
		central.writeUInt32LE(localOffset, 42);
		centralParts.push(Buffer.concat([central, nameBytes]));

		localParts.push(localRecord);
		localOffset += localRecord.length;
	}

	const centralDirectory = Buffer.concat(centralParts);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(entries.length, 8);
	eocd.writeUInt16LE(entries.length, 10);
	eocd.writeUInt32LE(centralDirectory.length, 12);
	eocd.writeUInt32LE(localOffset, 16);

	return Buffer.concat([...localParts, centralDirectory, eocd]);
}

describe("assertSafeZipEntries", () => {
	it("accepts a normal extension archive", () => {
		const zip = buildZip([
			{ name: "recordly-extension.json", data: Buffer.from("{}") },
			{ name: "assets/wallpaper.png" },
			{ name: "main.js", data: Buffer.from("export {}") },
		]);
		expect(() => assertSafeZipEntries(zip)).not.toThrow();
	});

	it("rejects .. traversal segments", () => {
		const zip = buildZip([{ name: "../outside.txt" }]);
		expect(() => assertSafeZipEntries(zip)).toThrow(ZipValidationError);
	});

	it("rejects nested .. traversal with backslashes", () => {
		const zip = buildZip([{ name: "safe\\..\\..\\outside.txt" }]);
		expect(() => assertSafeZipEntries(zip)).toThrow(/Unsafe path/);
	});

	it("rejects absolute posix paths", () => {
		const zip = buildZip([{ name: "/etc/passwd" }]);
		expect(() => assertSafeZipEntries(zip)).toThrow(/Unsafe path/);
	});

	it("rejects Windows drive and UNC paths", () => {
		expect(() => assertSafeZipEntries(buildZip([{ name: "C:/evil.txt" }]))).toThrow(
			/Unsafe path/,
		);
		expect(() => assertSafeZipEntries(buildZip([{ name: "\\\\server\\share" }]))).toThrow(
			/Unsafe path/,
		);
	});

	it("rejects symlink entries", () => {
		const zip = buildZip([{ name: "link-to-home", unixMode: 0o120777 }]);
		expect(() => assertSafeZipEntries(zip)).toThrow(/Symlink entry/);
	});

	it("allows regular files even when a non-unix host set odd attributes", () => {
		const zip = buildZip([{ name: "file.txt", hostOs: 0, unixMode: 0o120777 }]);
		expect(() => assertSafeZipEntries(zip)).not.toThrow();
	});

	it("rejects non-zip data", () => {
		expect(() => assertSafeZipEntries(Buffer.from("not a zip file at all"))).toThrow(
			ZipValidationError,
		);
	});

	it("rejects truncated central directories", () => {
		const zip = buildZip([{ name: "a.txt" }]);
		// Point the EOCD's central-directory offset past the end of the buffer.
		zip.writeUInt32LE(zip.length, zip.length - 6);
		expect(() => assertSafeZipEntries(zip)).toThrow(/truncated|signature/);
	});
});
