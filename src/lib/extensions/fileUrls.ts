/**
 * Extension asset/module URLs use the recordly-ext:// protocol (registered in
 * the main process, gated to the extension directories) instead of file://.
 * With webSecurity enabled, file:// subresources are blocked on the
 * http-served renderer; the custom protocol keeps dynamic import(), <img>,
 * <video>, and Audio loads working without reopening arbitrary file access.
 *
 * URL shape: recordly-ext://local/<absolute posix-style path>
 * (Windows paths become /C:/Users/...).
 */

export const EXTENSION_PROTOCOL_PREFIX = "recordly-ext://local";

const WINDOWS_ABSOLUTE_PATH = /^[a-zA-Z]:[\\/]/;

function ensureTrailingSlash(value: string): string {
	return value.endsWith("/") ? value : `${value}/`;
}

function trimTrailingSlash(value: string): string {
	return value.endsWith("/") ? value.slice(0, -1) : value;
}

function toDirectoryExtensionUrl(directoryPath: string): URL {
	const normalized = directoryPath.replace(/\\/g, "/");

	if (normalized.startsWith(`${EXTENSION_PROTOCOL_PREFIX}/`)) {
		return new URL(ensureTrailingSlash(normalized));
	}

	if (WINDOWS_ABSOLUTE_PATH.test(normalized)) {
		return new URL(`${EXTENSION_PROTOCOL_PREFIX}/${ensureTrailingSlash(normalized)}`);
	}

	const absolute = normalized.startsWith("/") ? normalized : `/${normalized}`;
	return new URL(`${EXTENSION_PROTOCOL_PREFIX}${ensureTrailingSlash(absolute)}`);
}

/** Extract the local filesystem path from a recordly-ext:// URL, or null. */
export function extensionUrlToLocalPath(url: string): string | null {
	if (!url.startsWith(`${EXTENSION_PROTOCOL_PREFIX}/`)) {
		return null;
	}

	try {
		const pathname = decodeURIComponent(new URL(url).pathname);
		if (/^\/[A-Za-z]:\//.test(pathname)) {
			return pathname.slice(1);
		}
		return pathname;
	} catch {
		return null;
	}
}

export function resolveExtensionRelativeFileUrl(
	extensionPath: string,
	relativePath: string,
): string {
	const baseUrl = toDirectoryExtensionUrl(extensionPath);
	const basePath = trimTrailingSlash(baseUrl.pathname);
	const resolvedUrl = new URL(relativePath, baseUrl);
	const resolvedPath = trimTrailingSlash(resolvedUrl.pathname);

	if (resolvedPath !== basePath && !resolvedPath.startsWith(`${basePath}/`)) {
		throw new Error(`Invalid extension path: ${relativePath}`);
	}

	return resolvedUrl.toString();
}

export function createExtensionModuleUrl(extensionPath: string, entryPoint: string): string {
	const base = resolveExtensionRelativeFileUrl(extensionPath, entryPoint);
	// Cache-bust so re-installs / updates load the fresh module
	return `${base}?v=${Date.now()}`;
}
