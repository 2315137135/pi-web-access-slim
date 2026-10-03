import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Value } from "typebox/value";

import initializeExtension from "../index.ts";

const indexUrl = new URL("../index.ts", import.meta.url).href;
const readmeSrc = readFileSync(new URL("../README.md", import.meta.url), "utf8");

function runRegistration(config) {
	return runRegistrationWithConfig(JSON.stringify(config) + "\n");
}

function runRegistrationWithConfig(configText) {
	const root = mkdtempSync(join(tmpdir(), "pi-web-access-tool-names-"));
	writeFileSync(join(root, "web-search.json"), configText, "utf8");
	return spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const { default: initializeExtension } = await import(${JSON.stringify(indexUrl)});
			const tools = [];
			const commands = [];
			initializeExtension({
				registerTool(tool) { tools.push({ name: tool.name, description: tool.description, promptSnippet: tool.promptSnippet, parameters: tool.parameters }); },
				registerCommand(name) { commands.push(name); },
				registerShortcut() {},
				on() {},
			});
			console.log(JSON.stringify({ tools, commands }));
		`,
		encoding: "utf8",
		env: { ...process.env, PI_CODING_AGENT_DIR: root, XDG_CONFIG_HOME: "", HOME: join(root, "home"), USERPROFILE: join(root, "home") },
	});
}

function registered(config) {
	const child = runRegistration(config);
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout);
}

function registeredToolNames(config) {
	return registered(config).tools.map(tool => tool.name);
}

function registeredTool(config, name) {
	return registered(config).tools.find(tool => tool.name === name);
}

function registeredCommandNames(config) {
	return registered(config).commands;
}

function registrationError(config) {
	const child = runRegistration(config);
	assert.notEqual(child.status, 0, child.stdout);
	return child.stderr;
}

test("malformed config falls back during extension registration", () => {
	const child = runRegistrationWithConfig("{");
	assert.equal(child.status, 0, child.stderr);
	const registered = JSON.parse(child.stdout);
	assert.deepEqual(registered.tools.map(tool => tool.name), ["web_search", "web_fetch"]);
});

test("web_search constrains numResults to integer values from 1 through 20", () => {
	const schema = registeredTool({}, "web_search").parameters.properties.numResults;
	assert.equal(schema.type, "integer");
	assert.equal(schema.minimum, 1);
	assert.equal(schema.maximum, 20);
	for (const value of [0, -1, 1.5, 21, Number.NaN, Number.POSITIVE_INFINITY]) {
		assert.equal(Value.Check(schema, value), false, `web_search accepts ${value}`);
	}
	for (const value of [1, 5, 20]) {
		assert.equal(Value.Check(schema, value), true, `web_search rejects ${value}`);
	}
});

test("tool registration gates support legacy and per-tool config", () => {
	assert.deepEqual(registeredToolNames({ webSearch: { enabled: false } }), ["web_fetch"]);
	assert.deepEqual(registeredToolNames({
		webSearch: { enabled: false },
		tools: { webSearch: { enabled: true }, fetchContent: { enabled: false } },
	}), ["web_search"]);
	assert.deepEqual(registeredToolNames({
		tools: { fetchContent: { enabled: false } },
	}), ["web_search"]);
});

test("command registration gates default to enabled and web-search-config is ungated", () => {
	assert.deepEqual(registeredCommandNames({}), ["web-search-config", "web-search-auth", "web-search-history"]);
	assert.deepEqual(registeredCommandNames({
		commands: { curator: { enabled: false }, search: { enabled: false } },
	}), ["web-search-config", "web-search-auth"]);
});

test("web_fetch schema exposes only url, as, and refresh", () => {
	const properties = registeredTool({}, "web_fetch").parameters.properties;
	assert.deepEqual(Object.keys(properties).sort(), ["as", "refresh", "url"]);
	assert.equal(properties.url.type, "string");
	assert.equal(Value.Check(properties.as, "readable"), true);
	assert.equal(Value.Check(properties.as, "raw"), true);
	assert.equal(Value.Check(properties.as, "answer"), false);
	assert.equal(properties.refresh.type, "boolean");
});

test("slim agent schemas omit provider, curator, and video controls", () => {
	const searchTool = registeredTool({}, "web_search");
	const fetchTool = registeredTool({}, "web_fetch");

	assert.equal(searchTool.parameters.properties.provider, undefined);
	assert.equal(searchTool.parameters.properties.workflow, undefined);
	assert.equal(searchTool.parameters.properties.includeContent, undefined);
	assert.doesNotMatch(`${searchTool.description}\n${searchTool.promptSnippet}`, /Gemini|Ollama|provider array|browser curator|automatic summary/i);
	for (const name of ["timestamp", "frames", "model", "urls", "prompt", "mode", "answerModel", "auth", "proxy", "forceClone"]) {
		assert.equal(fetchTool.parameters.properties[name], undefined);
	}
	assert.doesNotMatch(`${fetchTool.description}\n${fetchTool.promptSnippet}`, /YouTube|video|frames|Gemini/i);
});

test("web activity shortcut renders through the supported string-array API", async () => {
	const shortcuts = [];
	initializeExtension({
		registerTool() {},
		registerCommand() {},
		registerShortcut(name, shortcut) { shortcuts.push({ name, shortcut }); },
		on() {},
	});

	const activityShortcut = shortcuts.find(({ shortcut }) => shortcut.description === "Toggle web search activity");
	assert.ok(activityShortcut, "activity shortcut was not registered");
	const widgets = [];
	const ctx = {
		ui: {
			theme: { fg: (_color, text) => text },
			setWidget(key, content) { widgets.push({ key, content }); },
		},
	};

	await activityShortcut.shortcut.handler(ctx);
	assert.equal(widgets[0].key, "web-activity");
	assert.ok(Array.isArray(widgets[0].content), "activity widget content must be a string array");
	assert.ok(widgets[0].content.length > 0);

	await activityShortcut.shortcut.handler(ctx);
});

test("tool names can be configured without changing defaults", () => {
	assert.deepEqual(registeredToolNames({}), ["web_search", "web_fetch"]);
	assert.deepEqual(registeredToolNames({
		toolNames: {
			webSearch: "research_web",
			fetchContent: "grab_content",
		},
	}), ["research_web", "grab_content"]);
});

test("tool name config rejects invalid and duplicate registered names", () => {
	assert.match(registrationError({ toolNames: { webSearch: "1bad" } }), /toolNames\.webSearch/);
	assert.match(registrationError({ toolNames: { webSearch: "same_name", fetchContent: "same_name" } }), /duplicates/);
});

test("webSearch.enabled false registers only the fetch tool and ignores disabled-name duplicates", () => {
	assert.deepEqual(registeredToolNames({
		webSearch: { enabled: false },
		toolNames: {
			webSearch: "content_only",
			fetchContent: "grab_content",
		},
	}), ["grab_content"]);
});

test("README documents registration gates and toolNames", () => {
	assert.match(readmeSrc, /"tools": \{/);
	assert.match(readmeSrc, /"commands": \{/);
	assert.match(readmeSrc, /Pi restart is required for tool and command registration changes/);
	assert.match(readmeSrc, /`toolNames` can opt into alternate public tool names/);
});
