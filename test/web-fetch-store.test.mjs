import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, rmSync, utimesSync, mkdirSync } from "node:fs";
import { test } from "node:test";

import initializeExtension from "../index.ts";
import {
	WEB_FETCH_TTL_MS,
	getWebFetchDir,
	pruneWebFetchCache,
	readWebFetchCache,
	writeWebFetchContent,
} from "../web-fetch-store.ts";

const originalFetch = globalThis.fetch;

function registerWebFetch() {
	const tools = [];
	initializeExtension({
		registerTool(tool) { tools.push(tool); },
		registerCommand() {},
		registerShortcut() {},
		on() {},
		appendEntry() {},
	});
	const tool = tools.find(candidate => candidate.name === "web_fetch");
	assert.ok(tool, "web_fetch tool was not registered");
	return tool;
}

function cleanCache() {
	rmSync(getWebFetchDir(), { recursive: true, force: true });
}

test("writeWebFetchContent derives a stable forward-slash path per (url, as)", () => {
	cleanCache();
	const first = writeWebFetchContent("https://example.com/stable", "readable", "hello");
	const second = writeWebFetchContent("https://example.com/stable", "readable", "hello again");
	assert.equal(first.path, second.path);
	assert.match(first.path, /^[A-Za-z]:\/|\//);
	assert.doesNotMatch(first.path, /\\/);

	const raw = writeWebFetchContent("https://example.com/stable", "raw", "raw body");
	assert.notEqual(raw.path, first.path);
	assert.ok(raw.path.endsWith(".txt"));

	const hit = readWebFetchCache("https://example.com/stable", "readable");
	assert.equal(hit?.path, first.path);
	assert.equal(readFileSync(hit.path, "utf8"), "hello again");
	assert.equal(readWebFetchCache("https://example.com/missing", "readable"), null);
	cleanCache();
});

test("readWebFetchCache ignores expired files and pruneWebFetchCache enforces limits", () => {
	cleanCache();
	const dir = getWebFetchDir();
	mkdirSync(dir, { recursive: true });
	const now = Date.now();
	const expired = writeWebFetchContent("https://example.com/old", "readable", "old");
	utimesSync(expired.path, new Date(now - WEB_FETCH_TTL_MS - 1000), new Date(now - WEB_FETCH_TTL_MS - 1000));
	assert.equal(readWebFetchCache("https://example.com/old", "readable", now), null);

	writeWebFetchContent("https://example.com/a", "readable", "a".repeat(100));
	writeWebFetchContent("https://example.com/b", "readable", "b".repeat(100));
	pruneWebFetchCache(now, { maxEntries: 1, maxBytes: 10_000 });
	assert.ok(readdirSync(dir).length <= 1);
	assert.throws(() => pruneWebFetchCache(now, { maxEntries: 0 }), /finite positive integers/);
	cleanCache();
});

test("web_fetch writes content to disk, then serves it from cache without network", async () => {
	cleanCache();
	let calls = 0;
	globalThis.fetch = async () => {
		calls += 1;
		return new Response("Page body for cache test. ".repeat(10), { status: 200, headers: { "content-type": "text/plain" } });
	};
	try {
		const tool = registerWebFetch();
		const url = `https://93.184.216.34/web-fetch-cache-${Date.now()}`;
		const first = await tool.execute("call", { url });
		assert.equal(first.isError, undefined);
		assert.equal(first.details.cached, false);
		assert.equal(typeof first.details.path, "string");
		assert.ok(existsSync(first.details.path));
		assert.match(readFileSync(first.details.path, "utf8"), /Page body for cache test/);
		assert.match(first.content[0].text, /path: /);

		const second = await tool.execute("call", { url });
		assert.equal(second.details.cached, true);
		assert.equal(second.details.path, first.details.path);
		assert.equal(calls, 1);

		const refreshed = await tool.execute("call", { url, refresh: true });
		assert.equal(refreshed.details.cached, false);
		assert.equal(calls, 2);
	} finally {
		globalThis.fetch = originalFetch;
		cleanCache();
	}
});

test("web_fetch returns a structured isError result on failure", async () => {
	cleanCache();
	globalThis.fetch = async () => new Response("gone", { status: 404, statusText: "Not Found" });
	try {
		const tool = registerWebFetch();
		const result = await tool.execute("call", { url: `https://93.184.216.34/web-fetch-missing-${Date.now()}` });
		assert.equal(result.isError, true);
		assert.equal(typeof result.details.error, "string");
		assert.match(result.details.url, /web-fetch-missing/);
		assert.equal(result.details.path, undefined);
	} finally {
		globalThis.fetch = originalFetch;
		cleanCache();
	}
});

test("web_fetch requires a url", async () => {
	const tool = registerWebFetch();
	const result = await tool.execute("call", {});
	assert.equal(result.isError, true);
	assert.match(result.details.error, /No URL provided/);
});
