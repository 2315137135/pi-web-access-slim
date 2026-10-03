import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

export type WebFetchMode = "readable" | "raw";

export const WEB_FETCH_TTL_MS = 60 * 60 * 1000;
export const WEB_FETCH_MAX_ENTRIES = 256;
export const WEB_FETCH_MAX_BYTES = 256 * 1024 * 1024;

const WEB_FETCH_DIR_NAME = "pi-web-fetch";
const FILE_NAME_PATTERN = /^[a-f0-9]{16}\.[a-z0-9]+$/;
const TMP_NAME_PATTERN = /^[a-f0-9]{16}\.[a-z0-9]+\.[0-9]+\.[a-f0-9]{16}\.tmp$/;

export interface WebFetchLimits {
	maxEntries: number;
	maxBytes: number;
}

export interface WebFetchFile {
	path: string;
	bytes: number;
}

interface WebFetchDirEntry {
	name: string;
	path: string;
	size: number;
	mtimeMs: number;
}

export function getWebFetchDir(): string {
	return join(tmpdir(), WEB_FETCH_DIR_NAME);
}

function toPosixPath(path: string): string {
	return sep === "/" ? path : path.split(sep).join("/");
}

function hashFor(url: string, as: WebFetchMode): string {
	return createHash("sha256").update(`${as}\n${url}`).digest("hex").slice(0, 16);
}

function extensionFor(as: WebFetchMode, mimeType?: string): string {
	if (mimeType?.startsWith("image/")) {
		const subtype = mimeType.slice("image/".length).split(";")[0].trim().toLowerCase();
		if (subtype === "jpeg") return ".jpg";
		if (subtype === "svg+xml") return ".svg";
		if (/^[a-z0-9+]+$/.test(subtype)) return `.${subtype.replace("+", "-")}`;
	}
	return as === "raw" ? ".txt" : ".md";
}

/** Best-effort content type inferred from a cached file extension. */
export function contentTypeForPath(path: string): string {
	const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
	if (ext === "md") return "text/markdown";
	if (ext === "txt") return "text/plain";
	if (ext === "htm" || ext === "html") return "text/html";
	if (ext === "json") return "application/json";
	if (ext === "pdf") return "application/pdf";
	// Image subtypes are the only extensions extensionFor() derives from the mime type.
	if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
	if (/^(png|gif|webp|avif|bmp|tiff?|svg)$/.test(ext)) return ext === "svg" ? "image/svg+xml" : `image/${ext}`;
	return "application/octet-stream";
}

function resolveLimits(limits?: Partial<WebFetchLimits>): WebFetchLimits {
	const resolved = {
		maxEntries: limits?.maxEntries ?? WEB_FETCH_MAX_ENTRIES,
		maxBytes: limits?.maxBytes ?? WEB_FETCH_MAX_BYTES,
	};
	if (!Number.isInteger(resolved.maxEntries) || resolved.maxEntries <= 0 ||
		!Number.isInteger(resolved.maxBytes) || resolved.maxBytes <= 0) {
		throw new Error("Web fetch cache limits must be finite positive integers");
	}
	return resolved;
}

function safeDir(create: boolean): string | null {
	const dir = getWebFetchDir();
	if (create) mkdirSync(dir, { recursive: true });
	let info;
	try {
		info = lstatSync(dir);
	} catch (err) {
		if (!create && (err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
	if (info.isSymbolicLink() || !info.isDirectory()) {
		throw new Error("Web fetch cache path is not a safe directory");
	}
	return dir;
}

function listFiles(dir: string): WebFetchDirEntry[] {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	const files: WebFetchDirEntry[] = [];
	for (const name of names) {
		if (!FILE_NAME_PATTERN.test(name)) continue;
		const path = join(dir, name);
		try {
			const info = lstatSync(path);
			if (!info.isFile() || info.isSymbolicLink()) continue;
			files.push({ name, path, size: info.size, mtimeMs: info.mtimeMs });
		} catch {
			// Missing entries are treated as cache misses.
		}
	}
	return files;
}

/** Deletes expired files, then evicts the oldest until TTL and size limits hold. */
export function pruneWebFetchCache(now = Date.now(), requestedLimits?: Partial<WebFetchLimits>): void {
	const limits = resolveLimits(requestedLimits);
	try {
		const dir = safeDir(false);
		if (!dir) return;
		let files: WebFetchDirEntry[];
		try {
			files = listFiles(dir);
		} catch {
			return;
		}
		const live: WebFetchDirEntry[] = [];
		for (const file of files) {
			if (now - file.mtimeMs >= WEB_FETCH_TTL_MS) {
				try { unlinkSync(file.path); } catch { /* best effort */ }
				continue;
			}
			live.push(file);
		}
		live.sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
		let bytes = live.reduce((total, file) => total + file.size, 0);
		while (live.length > limits.maxEntries || bytes > limits.maxBytes) {
			const file = live.shift();
			if (!file) break;
			try {
				unlinkSync(file.path);
				bytes -= file.size;
			} catch {
				// Keep evicting past files that vanished underneath us.
			}
		}
	} catch {
		// Cache housekeeping must never block a fetch.
	}
	try {
		const dir = safeDir(false);
		if (!dir) return;
		for (const name of readdirSync(dir)) {
			if (!TMP_NAME_PATTERN.test(name)) continue;
			try {
				const info = lstatSync(join(dir, name));
				if (info.isFile() && now - info.mtimeMs >= WEB_FETCH_TTL_MS) unlinkSync(join(dir, name));
			} catch {
				// Ignore temp-file races.
			}
		}
	} catch {
		// Ignore.
	}
}

/** Returns a fresh cached file for (url, as) without touching the network. */
export function readWebFetchCache(url: string, as: WebFetchMode, now = Date.now()): WebFetchFile | null {
	let dir: string | null;
	try {
		dir = safeDir(false);
	} catch {
		return null;
	}
	if (!dir) return null;
	const base = hashFor(url, as);
	let match: WebFetchDirEntry | undefined;
	try {
		match = listFiles(dir).find((file) => file.name.startsWith(`${base}.`));
	} catch {
		return null;
	}
	if (!match) return null;
	if (now - match.mtimeMs >= WEB_FETCH_TTL_MS) {
		try { unlinkSync(match.path); } catch { /* best effort */ }
		return null;
	}
	return { path: toPosixPath(match.path), bytes: match.size };
}

/** Writes fetched content to a stable per-(url, as) file and returns its absolute path. */
export function writeWebFetchContent(
	url: string,
	as: WebFetchMode,
	content: string | Buffer,
	mimeType?: string,
): WebFetchFile {
	const dir = safeDir(true)!;
	pruneWebFetchCache();
	const base = hashFor(url, as);
	try {
		for (const name of readdirSync(dir)) {
			if (name.startsWith(`${base}.`)) {
				try { unlinkSync(join(dir, name)); } catch { /* best effort */ }
			}
		}
	} catch {
		// Ignore stale-variant cleanup failures; the new write still wins.
	}
	const finalPath = join(dir, `${base}${extensionFor(as, mimeType)}`);
	const tmpPath = join(dir, `${base}.${Date.now()}.${randomBytes(8).toString("hex")}.tmp`);
	let fd: number | null = null;
	try {
		fd = openSync(tmpPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
		const info = fstatSync(fd);
		if (!info.isFile()) throw new Error("Web fetch cache entry is not a regular file");
		writeFileSync(fd, content);
		closeSync(fd);
		fd = null;
		renameSync(tmpPath, finalPath);
	} catch (err) {
		if (fd !== null) try { closeSync(fd); } catch { /* ignore */ }
		try { unlinkSync(tmpPath); } catch { /* ignore */ }
		throw err;
	}
	const written = lstatSync(finalPath);
	pruneWebFetchCache();
	return { path: toPosixPath(finalPath), bytes: written.size };
}
