import assert from "node:assert/strict";
import { test } from "node:test";

import initializeExtension from "../index.ts";

function getFetchTool() {
	const tools = [];
	initializeExtension({
		registerTool(tool) { tools.push(tool); },
		registerCommand() {},
		registerShortcut() {},
		on() {},
		appendEntry() {},
	});
	return tools.find(tool => tool.name === "web_fetch");
}

const theme = {
	bold: text => text,
	fg: (_name, text) => text,
};

test("web_fetch renderCall shows the url and optional overrides", () => {
	const tool = getFetchTool();
	assert.ok(tool, "web_fetch tool was not registered");

	const lines = tool.renderCall({
		url: "https://example.com/docs",
		as: "readable",
		refresh: false,
	}, theme).render(120).map(line => line.trimEnd());
	assert.deepEqual(lines, ["fetch https://example.com/docs"]);

	const raw = tool.renderCall({ url: "https://example.com/docs", as: "raw", refresh: true }, theme)
		.render(120).map(line => line.trimEnd());
	assert.deepEqual(raw, ["fetch https://example.com/docs", "  as: raw", "  refresh: true"]);
});
