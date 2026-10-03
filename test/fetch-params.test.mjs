import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeWebFetchParams } from "../fetch-params.ts";

test("web_fetch requires a non-empty single url", () => {
	assert.equal(normalizeWebFetchParams({ url: "  https://example.com/docs  " }).url, "https://example.com/docs");
	assert.equal(normalizeWebFetchParams({ url: "" }).url, null);
	assert.equal(normalizeWebFetchParams({ url: "   " }).url, null);
	assert.equal(normalizeWebFetchParams({}).url, null);
	assert.equal(normalizeWebFetchParams({ url: 42 }).url, null);
});

test("web_fetch defaults to readable form and accepts raw", () => {
	assert.equal(normalizeWebFetchParams({ url: "https://example.com" }).as, "readable");
	assert.equal(normalizeWebFetchParams({ url: "https://example.com", as: "readable" }).as, "readable");
	assert.equal(normalizeWebFetchParams({ url: "https://example.com", as: "raw" }).as, "raw");
	assert.throws(() => normalizeWebFetchParams({ url: "https://example.com", as: "answer" }), /as must be/);
	assert.throws(() => normalizeWebFetchParams({ url: "https://example.com", as: "invalid" }), /as must be/);
});

test("web_fetch refresh is only true for boolean true", () => {
	assert.equal(normalizeWebFetchParams({ url: "https://example.com" }).refresh, false);
	assert.equal(normalizeWebFetchParams({ url: "https://example.com", refresh: true }).refresh, true);
	assert.equal(normalizeWebFetchParams({ url: "https://example.com", refresh: "true" }).refresh, false);
	assert.equal(normalizeWebFetchParams({ url: "https://example.com", refresh: 1 }).refresh, false);
});
