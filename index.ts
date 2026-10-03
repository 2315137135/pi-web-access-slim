import { getSelectListTheme, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, type SettingItem, SettingsList, SelectList, Text } from "@earendil-works/pi-tui";
import { Box, truncateToWidth, type KeyId } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai/compat";
import type { ExtractedContent, ExtractOptions } from "./extract.ts";
import { normalizeWebFetchParams } from "./fetch-params.ts";
import { contentTypeForPath, pruneWebFetchCache, readWebFetchCache, writeWebFetchContent } from "./web-fetch-store.ts";
import { clearCloneCache } from "./github-extract.ts";
import { getConfiguredSearchRouting, normalizeSearchProviderSelection, RESOLVED_SEARCH_PROVIDERS, search, type SearchProviderSelection } from "./gemini-search.ts";
import type { SearchResult } from "./perplexity.ts";
import { getWebSearchConfigDir, getWebSearchConfigPath, installGlobalProxyFetch, runWithProxy } from "./utils.ts";
import {
	clearResults,
	deleteResult,
	generateId,
	getAllResults,
	restoreFromSession,
	storeFetchedContentResult,
	storeResult,
	type QueryResultData,
	type StoredSearchData,
} from "./storage.ts";
import { activityMonitor, type ActivityEntry } from "./activity.ts";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { isPerplexityAvailable } from "./perplexity.ts";
import { isExaAvailable } from "./exa.ts";
import { isGeminiApiAvailable } from "./gemini-api.ts";
import { getActiveGoogleEmail, getGeminiWebAvailabilityDiagnostic, isGeminiWebAvailable } from "./gemini-web.ts";
import { isBrowserCookieAccessAllowed } from "./gemini-web-config.ts";
import { isBraveAvailable } from "./brave.ts";
import { isOpenAISearchAvailable } from "./openai-search.ts";
import { isParallelAvailable } from "./parallel.ts";
import { isParallelMcpAvailable } from "./parallel-mcp.ts";
import { isTinyFishAvailable } from "./tinyfish.ts";
import { isSearch1APIAvailable } from "./search1api.ts";
import { isSearchinfinityAvailable } from "./searchinfinity.ts";
import { isQueritAvailable } from "./querit.ts";
import { isTavilyAvailable } from "./tavily.ts";
import { isFirecrawlAvailable } from "./firecrawl.ts";
import { isJinaSearchAvailable } from "./jina-search.ts";
import { isSerpdiveAvailable } from "./serpdive.ts";
import { isKagiAvailable } from "./kagi.ts";
import { isBochaAvailable } from "./bocha.ts";
import { isOllamaAvailable } from "./ollama.ts";
import { isSearXNGAvailable } from "./searxng.ts";
import { isDuckDuckGoAvailable } from "./duckduckgo.ts";
import { isAnySearchAvailable } from "./anysearch.ts";
import { isXaiSearchAvailable } from "./xai-search.ts";
import { isKimiSearchAvailable } from "./kimi-search.ts";
import { isBrightDataAvailable } from "./brightdata.ts";
import { isSerpBaseAvailable } from "./serpbase.ts";
import { isSerperAvailable } from "./serper.ts";
import { isValyuAvailable } from "./valyu.ts";
import { buildSearchErrorPlan, type SearchErrorDetails, type SearchErrorPlan } from "./render-search-error.ts";

type RecencyFilter = "day" | "week" | "month" | "year";

type ExtensionTheme = ExtensionContext["ui"]["theme"];

const WEB_SEARCH_CONFIG_PATH = getWebSearchConfigPath();

let extractModulePromise: Promise<typeof import("./extract.ts")> | undefined;
async function fetchAllContent(
	urls: string[],
	signal?: AbortSignal,
	options?: ExtractOptions,
): Promise<ExtractedContent[]> {
	const extractModule = await (extractModulePromise ??= import("./extract.ts"));
	return extractModule.fetchAllContent(urls, signal, options);
}

function withRegisteredFetchOptions(
	options: ExtractOptions | undefined,
	toolNames: ExtractOptions["toolNames"],
	proxy?: string,
): ExtractOptions {
	return {
		...(options ?? {}),
		toolNames,
		...(proxy !== undefined ? { proxy } : {}),
	};
}

function isAbortError(err: unknown): boolean {
	return (err instanceof Error ? err.message : String(err)).toLowerCase().includes("abort");
}

/** Shared collapsed/expanded renderer for an error/cancel plan produced by
 * buildSearchErrorPlan(). Used by every tool renderResult's error branch so
 * Ctrl+O (app.tools.expand) reveals diagnostics instead of a dead-end single line. */
function renderSearchErrorPlan(plan: SearchErrorPlan, expanded: boolean, theme: ExtensionTheme) {
	if (expanded) {
		return new Text(plan.expanded.map((l, i) => i === 0 ? theme.fg("error", l) : theme.fg("toolOutput", l)).join("\n"), 0, 0);
	}
	const box = new Box(1, 0, (t) => theme.bg("toolErrorBg", t));
	box.addChild(new Text(theme.fg("error", plan.expanded[0]), 0, 0));
	for (const line of plan.collapsed) {
		box.addChild(new Text(theme.fg("dim", line), 0, 0));
	}
	if (plan.expandHint) {
		box.addChild(new Text(theme.fg("muted", plan.expandHint), 0, 0));
	}
	return box;
}

interface WebSearchConfig {
	anysearchApiKey?: unknown;
	bochaApiKey?: unknown;
	brightdataApiKey?: unknown;
	brightdataSerpZone?: unknown;
	exaApiKey?: unknown;
	firecrawlBaseUrl?: unknown;
	geminiApiKey?: unknown;
	jinaApiKey?: unknown;
	kagiApiKey?: unknown;
	ollamaApiKey?: unknown;
	openaiApiKey?: unknown;
	parallelApiKey?: unknown;
	perplexityApiKey?: unknown;
	queritApiKey?: unknown;
	searxngBaseUrl?: unknown;
	search1apiApiKey?: unknown;
	searchinfinityApiKey?: unknown;
	serpbaseApiKey?: unknown;
	serpdiveApiKey?: unknown;
	serperApiKey?: unknown;
	tinyfishApiKey?: unknown;
	tavilyApiKey?: unknown;
	valyuApiKey?: unknown;
	xaiApiKey?: unknown;
	provider?: unknown;
	searchProvider?: unknown;
	maxInlineContentChars?: unknown;
	webSearch?: {
		enabled?: boolean;
	};
	tools?: Partial<Record<keyof ToolNames, { enabled?: boolean }>>;
	commands?: Partial<Record<"search" | "auth", { enabled?: boolean }>>;
	toolNames?: Partial<ToolNames>;
	shortcuts?: {
		activity?: KeyId;
	};
	ssrf?: {
		/** CIDR ranges exempted from the SSRF guard (e.g. fake-IP proxy ranges). */
		allowRanges?: string[];
		/** Skip local hostname DNS preflight when an HTTP(S)_PROXY env var applies. */
		trustEnvProxy?: boolean;
	};
}

export interface ProviderAvailability {
	all: boolean;
	openai: boolean;
	brave: boolean;
	parallel: boolean;
	"parallel-mcp": boolean;
	tinyfish: boolean;
	search1api: boolean;
	searchinfinity: boolean;
	querit: boolean;
	tavily: boolean;
	firecrawl: boolean;
	jina: boolean;
	serpdive: boolean;
	searxng: boolean;
	duckduckgo: boolean;
	perplexity: boolean;
	exa: boolean;
	gemini: boolean;
	kimi: boolean;
	kagi: boolean;
	bocha: boolean;
	ollama: boolean;
	anysearch: boolean;
	xai: boolean;
	brightdata: boolean;
	serpbase: boolean;
	serper: boolean;
	valyu: boolean;
}

function parseConfigRoot(raw: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${WEB_SEARCH_CONFIG_PATH}: ${message}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Invalid config in ${WEB_SEARCH_CONFIG_PATH}: expected a JSON object`);
	}
	return parsed as Record<string, unknown>;
}

function loadConfig(): WebSearchConfig {
	if (!existsSync(WEB_SEARCH_CONFIG_PATH)) return {};
	return parseConfigRoot(readFileSync(WEB_SEARCH_CONFIG_PATH, "utf-8")) as WebSearchConfig;
}

function saveConfig(updates: Partial<WebSearchConfig> & Record<string, unknown>): void {
	let config: Record<string, unknown> = {};
	if (existsSync(WEB_SEARCH_CONFIG_PATH)) {
		config = parseConfigRoot(readFileSync(WEB_SEARCH_CONFIG_PATH, "utf-8"));
	}

	Object.assign(config, updates);
	const dir = getWebSearchConfigDir();
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(WEB_SEARCH_CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

type ToolNames = {
	webSearch: string;
	fetchContent: string;
};

const DEFAULT_TOOL_NAMES: ToolNames = {
	webSearch: "web_search",
	fetchContent: "web_fetch",
};
const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
// is*Available() 恒真的供应商：无需 key 即可用（exa 无 key 时降级 Exa MCP）
const FREE_PROVIDERS: ReadonlySet<string> = new Set(["duckduckgo", "anysearch", "parallel-mcp", "exa"]);

// 未配置供应商的交互式设置入口：选中 ✗ 供应商时弹输入框，写入对应 json 字段
// configKey 必须与各供应商模块 loadConfig() 读取的字段同名
const PROVIDER_SETUP: Record<string, { configKey: string; kind: "api-key" | "base-url"; hint: string }> = {
	openai: { configKey: "openaiApiKey", kind: "api-key", hint: "pi 已登录 OpenAI 时自动可用；也可设环境变量 OPENAI_API_KEY" },
	brave: { configKey: "braveApiKey", kind: "api-key", hint: "免费 tier: brave.com/search/api • 或环境变量 BRAVE_API_KEY" },
	parallel: { configKey: "parallelApiKey", kind: "api-key", hint: "或环境变量 PARALLEL_API_KEY" },
	tinyfish: { configKey: "tinyfishApiKey", kind: "api-key", hint: "或环境变量 TINYFISH_API_KEY" },
	search1api: { configKey: "search1apiApiKey", kind: "api-key", hint: "或环境变量 SEARCH1API_KEY" },
	searchinfinity: { configKey: "searchinfinityApiKey", kind: "api-key", hint: "或环境变量 SEARCHINFINITY_API_KEY" },
	querit: { configKey: "queritApiKey", kind: "api-key", hint: "或环境变量 QUERIT_API_KEY" },
	tavily: { configKey: "tavilyApiKey", kind: "api-key", hint: "或环境变量 TAVILY_API_KEY" },
	firecrawl: { configKey: "firecrawlBaseUrl", kind: "base-url", hint: "自托管 Firecrawl 地址，如 https://firecrawl.example.com（或环境变量 FIRECRAWL_BASE_URL）" },
	jina: { configKey: "jinaApiKey", kind: "api-key", hint: "或环境变量 JINA_API_KEY" },
	searxng: { configKey: "searxngBaseUrl", kind: "base-url", hint: "SearXNG 实例地址，如 http://localhost:8080（或环境变量 SEARXNG_BASE_URL）" },
	perplexity: { configKey: "perplexityApiKey", kind: "api-key", hint: "或环境变量 PERPLEXITY_API_KEY" },
	gemini: { configKey: "geminiApiKey", kind: "api-key", hint: "也可登录 gemini.google.com（浏览器 Cookie）或配置 gcloud ADC" },
	exa: { configKey: "exaApiKey", kind: "api-key", hint: "或环境变量 EXA_API_KEY" },
	serpdive: { configKey: "serpdiveApiKey", kind: "api-key", hint: "或环境变量 SERPDIVE_API_KEY" },
	kagi: { configKey: "kagiApiKey", kind: "api-key", hint: "或环境变量 KAGI_API_KEY" },
	ollama: { configKey: "ollamaApiKey", kind: "api-key", hint: "或环境变量 OLLAMA_API_KEY" },
	xai: { configKey: "xaiApiKey", kind: "api-key", hint: "也可通过 pi 登录的 xAI 模型授权；或环境变量 XAI_API_KEY" },
	brightdata: { configKey: "brightdataApiKey", kind: "api-key", hint: "或环境变量 BRIGHTDATA_API_KEY" },
	serpbase: { configKey: "serpbaseApiKey", kind: "api-key", hint: "或环境变量 SERPBASE_API_KEY" },
	serper: { configKey: "serperApiKey", kind: "api-key", hint: "或环境变量 SERPER_API_KEY" },
	valyu: { configKey: "valyuApiKey", kind: "api-key", hint: "或环境变量 VALYU_API_KEY" },
	bocha: { configKey: "bochaApiKey", kind: "api-key", hint: "或环境变量 BOCHA_API_KEY" },
};
const DEFAULT_SHORTCUTS = { activity: "ctrl+shift+w" } satisfies Record<string, KeyId>;

function isToolEnabled(config: WebSearchConfig, key: keyof ToolNames): boolean {
	const override = config.tools?.[key]?.enabled;
	if (typeof override === "boolean") return override;
	return key !== "webSearch" || config.webSearch?.enabled !== false;
}

function isCommandEnabled(config: WebSearchConfig, name: "search" | "auth"): boolean {
	return config.commands?.[name]?.enabled !== false;
}

function resolveToolNames(config: WebSearchConfig): ToolNames {
	if (config.toolNames !== undefined && (!config.toolNames || typeof config.toolNames !== "object" || Array.isArray(config.toolNames))) {
		throw new Error(`toolNames in ${WEB_SEARCH_CONFIG_PATH} must be an object`);
	}
	const names = { ...DEFAULT_TOOL_NAMES };
	for (const key of Object.keys(DEFAULT_TOOL_NAMES) as Array<keyof ToolNames>) {
		const value = config.toolNames?.[key];
		if (value === undefined) continue;
		if (typeof value !== "string") throw new Error(`toolNames.${key} in ${WEB_SEARCH_CONFIG_PATH} must be a string`);
		const trimmed = value.trim();
		if (!TOOL_NAME_PATTERN.test(trimmed)) {
			throw new Error(`toolNames.${key} in ${WEB_SEARCH_CONFIG_PATH} must start with a letter and contain only letters, numbers, underscores, or hyphens`);
		}
		names[key] = trimmed;
	}
	const registeredKeys = (Object.keys(DEFAULT_TOOL_NAMES) as Array<keyof ToolNames>)
		.filter(key => isToolEnabled(config, key));
	const seen = new Map<string, keyof ToolNames>();
	for (const key of registeredKeys) {
		const name = names[key];
		const previous = seen.get(name);
		if (previous) throw new Error(`toolNames.${key} duplicates toolNames.${previous} in ${WEB_SEARCH_CONFIG_PATH}`);
		seen.set(name, key);
	}
	return names;
}

function loadConfigForExtensionInit(): WebSearchConfig {
	try {
		return loadConfig();
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`[pi-web-access] ${message}`);
		return {};
	}
}

function normalizeProviderInput(value: unknown, label = "provider"): SearchProviderSelection | undefined {
	if (value === undefined) return undefined;
	return normalizeSearchProviderSelection(value, label);
}

function resolveRequestedProvider(requested: unknown): SearchProviderSelection {
	const normalizedRequested = normalizeProviderInput(requested);
	if (normalizedRequested && normalizedRequested !== "auto") return normalizedRequested;
	const config = loadConfig();
	return normalizeProviderInput(config.searchProvider ?? config.provider, `provider in ${WEB_SEARCH_CONFIG_PATH}`) ?? "auto";
}

function toProviderLabel(provider: SearchProviderSelection): string | undefined {
	if (Array.isArray(provider)) return "all";
	return provider === "auto" ? undefined : provider;
}

function normalizeRecencyFilter(value: unknown): RecencyFilter | undefined {
	return value === "day" || value === "week" || value === "month" || value === "year"
		? value
		: undefined;
}

function normalizeQueryList(queryList: unknown[]): string[] {
	const normalized: string[] = [];
	for (const query of queryList) {
		if (typeof query !== "string") continue;
		const trimmed = query.trim();
		if (trimmed.length > 0) normalized.push(trimmed);
	}
	return normalized;
}

async function getProviderAvailability(ctx: ExtensionContext): Promise<ProviderAvailability> {
	const geminiWebAvail = await getOptionalGeminiWebAvailability();
	const geminiApiAvail = isGeminiApiAvailable();
	const providers = {
		openai: await isOpenAISearchAvailable(ctx),
		brave: isBraveAvailable(),
		parallel: isParallelAvailable(),
		"parallel-mcp": isParallelMcpAvailable(),
		tinyfish: isTinyFishAvailable(),
		search1api: isSearch1APIAvailable(),
		searchinfinity: isSearchinfinityAvailable(),
		querit: isQueritAvailable(),
		tavily: isTavilyAvailable(),
		firecrawl: isFirecrawlAvailable(),
		jina: isJinaSearchAvailable(),
		serpdive: isSerpdiveAvailable(),
		kagi: isKagiAvailable(),
		bocha: isBochaAvailable(),
		ollama: isOllamaAvailable(),
		searxng: isSearXNGAvailable(),
		duckduckgo: isDuckDuckGoAvailable(),
		perplexity: isPerplexityAvailable(),
		exa: isExaAvailable(),
		gemini: geminiApiAvail || !!geminiWebAvail,
		kimi: await isKimiSearchAvailable(ctx),
		anysearch: isAnySearchAvailable(),
		xai: await isXaiSearchAvailable(ctx),
		brightdata: isBrightDataAvailable(),
		serpbase: isSerpBaseAvailable(),
		serper: isSerperAvailable(),
		valyu: isValyuAvailable(),
	};
	return {
		// Parallel MCP, DuckDuckGo, Kimi, AnySearch, Valyu, xAI, Bright Data, SerpBase, and Serper are explicit-only, so they never make `all` eligible.
		all: Object.entries(providers).some(([provider, available]) => provider !== "parallel-mcp" && provider !== "duckduckgo" && provider !== "kimi" && provider !== "anysearch" && provider !== "valyu" && provider !== "xai" && provider !== "brightdata" && provider !== "serpbase" && provider !== "serper" && provider !== "gemini" && available) || geminiApiAvail,
		...providers,
	};
}

async function getOptionalGeminiWebAvailability() {
	try {
		return await isGeminiWebAvailable();
	} catch {
		return null;
	}
}

const pendingFetches = new Map<string, AbortController>();
let sessionActive = false;
let widgetVisible = false;
let widgetUnsubscribe: (() => void) | null = null;

function stripThumbnails(results: ExtractedContent[]): ExtractedContent[] {
	return results.map(({ thumbnail, frames, ...rest }) => rest);
}

interface WebFetchSuccessDetails {
	finalUrl: string;
	as: "readable" | "raw";
	path: string;
	title?: string;
	contentType: string;
	bytes: number;
	cached: boolean;
}

function webFetchSuccess(details: WebFetchSuccessDetails): AgentToolResult<Record<string, unknown>> {
	const lines = [
		`Fetched ${details.finalUrl} [${details.as}] ${details.bytes} bytes`,
		`path: ${details.path}`,
	];
	if (details.title) lines.push(`title: ${details.title}`);
	lines.push(`cached: ${details.cached}`);
	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: {
			path: details.path,
			finalUrl: details.finalUrl,
			...(details.title ? { title: details.title } : {}),
			contentType: details.contentType,
			bytes: details.bytes,
			cached: details.cached,
		},
	};
}

function webFetchError(error: string, url: string): AgentToolResult<Record<string, unknown>> {
	return {
		content: [{ type: "text", text: `Error: ${error}` }],
		details: { error, url },
		isError: true,
	};
}

function formatSearchSummary(results: SearchResult[], answer: string): string {
	if (results.length === 0) {
		return answer ? `${answer}\n\n---\n\n**Sources:**\nNo sources returned.` : "No results found.";
	}
	let output = answer ? `${answer}\n\n---\n\n**Sources:**\n` : "";
	output += results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}`).join("\n\n");
	return output;
}

function hasFullInlineCoverage(urls: string[], inlineContent: ExtractedContent[] | undefined): boolean {
	if (!inlineContent || inlineContent.length === 0) return false;
	const coveredUrls = new Set(inlineContent.map(c => c.url));
	return urls.every(url => coveredUrls.has(url));
}

function abortPendingFetches(): void {
	for (const controller of pendingFetches.values()) {
		controller.abort();
	}
	pendingFetches.clear();
}

function updateWidget(ctx: ExtensionContext): void {
	const theme = ctx.ui.theme;
	const entries = activityMonitor.getEntries();
	const lines: string[] = [];

	lines.push(theme.fg("accent", "─── Web Search Activity " + "─".repeat(36)));

	if (entries.length === 0) {
		lines.push(theme.fg("muted", "  No activity yet"));
	} else {
		for (const e of entries) {
			lines.push("  " + formatEntryLine(e, theme));
		}
	}

	lines.push(theme.fg("accent", "─".repeat(60)));

	const rateInfo = activityMonitor.getRateLimitInfo();
	const resetMs = rateInfo.oldestTimestamp ? Math.max(0, rateInfo.oldestTimestamp + rateInfo.windowMs - Date.now()) : 0;
	const resetSec = Math.ceil(resetMs / 1000);
	lines.push(
		theme.fg("muted", `Rate: ${rateInfo.used}/${rateInfo.max}`) +
			(resetMs > 0 ? theme.fg("dim", ` (resets in ${resetSec}s)`) : ""),
	);

	ctx.ui.setWidget("web-activity", lines);
}

function formatEntryLine(
	entry: ActivityEntry,
	theme: ExtensionTheme,
): string {
	const typeStr = entry.type === "api" ? "API" : "GET";
	const target =
		entry.type === "api"
			? `"${truncateToWidth(entry.query || "", 28, "")}"`
			: truncateToWidth(entry.url?.replace(/^https?:\/\//, "") || "", 30, "");

	const duration = entry.endTime
		? `${((entry.endTime - entry.startTime) / 1000).toFixed(1)}s`
		: `${((Date.now() - entry.startTime) / 1000).toFixed(1)}s`;

	let statusStr: string;
	let indicator: string;
	if (entry.error) {
		statusStr = "err";
		indicator = theme.fg("error", "✗");
	} else if (entry.status === null) {
		statusStr = "...";
		indicator = theme.fg("warning", "⋯");
	} else if (entry.status === 0) {
		statusStr = "abort";
		indicator = theme.fg("muted", "○");
	} else {
		statusStr = String(entry.status);
		indicator = entry.status >= 200 && entry.status < 300 ? theme.fg("success", "✓") : theme.fg("error", "✗");
	}

	return `${typeStr.padEnd(4)} ${target.padEnd(32)} ${statusStr.padStart(5)} ${duration.padStart(5)} ${indicator}`;
}

function handleSessionChange(ctx: ExtensionContext): void {
	abortPendingFetches();
	clearCloneCache();
	sessionActive = true;
	pruneWebFetchCache();
	restoreFromSession(ctx);
	// Unsubscribe before clear() to avoid callback with stale ctx
	widgetUnsubscribe?.();
	widgetUnsubscribe = null;
	activityMonitor.clear();
	if (widgetVisible) {
		// Re-subscribe with new ctx
		widgetUnsubscribe = activityMonitor.onUpdate(() => updateWidget(ctx));
		updateWidget(ctx);
	}
}

export default function (pi: ExtensionAPI) {
	const initConfig = loadConfigForExtensionInit();
	installGlobalProxyFetch();
	const toolNames = resolveToolNames(initConfig);
	const webSearchEnabled = isToolEnabled(initConfig, "webSearch");
	const fetchContentEnabled = isToolEnabled(initConfig, "fetchContent");
	// Names as registered this session, so fetch failure guidance never points
	// at tools that are disabled or were renamed after init.
	const registeredToolNames = {
		...(webSearchEnabled ? { webSearch: toolNames.webSearch } : {}),
		...(fetchContentEnabled ? { fetchContent: toolNames.fetchContent } : {}),
	};
	const activityKey = initConfig.shortcuts?.activity || DEFAULT_SHORTCUTS.activity;

	function startBackgroundFetch(urls: string[], proxy?: string): string | null {
		if (urls.length === 0) return null;
		const fetchId = generateId();
		const controller = new AbortController();
		pendingFetches.set(fetchId, controller);
		runWithProxy(proxy, () => fetchAllContent(urls, controller.signal, withRegisteredFetchOptions(undefined, registeredToolNames, proxy)))
			.then((fetched) => {
				if (!sessionActive || !pendingFetches.has(fetchId)) return;
				const data = {
					id: fetchId,
					type: "fetch",
					timestamp: Date.now(),
					urls: stripThumbnails(fetched),
				} satisfies StoredSearchData & { type: "fetch"; urls: ExtractedContent[] };
				pi.appendEntry("web-search-results", storeFetchedContentResult(fetchId, data));
				const ok = fetched.filter(f => !f.error).length;
				const availability = ok === fetched.length
					? "Full page content now available."
					: ok > 0
						? "Partial page content now available."
						: "No page content was fetched. Stored fetch diagnostics are available.";
				pi.sendMessage(
					{
						customType: "web-search-content-ready",
						content: `Content fetched for ${ok}/${fetched.length} URLs [${fetchId}]. ${availability}`,
						display: true,
					},
					{ triggerTurn: true },
				);
			})
			.catch((err) => {
				if (!sessionActive || !pendingFetches.has(fetchId)) return;
				const message = err instanceof Error ? err.message : String(err);
				const isAbort = (err instanceof Error && err.name === "AbortError") || message.toLowerCase().includes("abort");
				if (!isAbort) {
					pi.sendMessage(
						{
							customType: "web-search-error",
							content: `Content fetch failed [${fetchId}]: ${message}`,
							display: true,
						},
						{ triggerTurn: false },
					);
				}
			})
			.finally(() => { pendingFetches.delete(fetchId); });
		return fetchId;
	}

	function storeAndPublishSearch(results: QueryResultData[]): string {
		const id = generateId();
		const data: StoredSearchData = {
			id, type: "search", timestamp: Date.now(), queries: results,
		};
		storeResult(id, data);
		pi.appendEntry("web-search-results", data);
		return id;
	}

	interface SearchReturnOptions {
		queryList: string[];
		results: QueryResultData[];
		urls: string[];
		includeContent: boolean;
		inlineContent?: ExtractedContent[];
		proxy?: string;
	}

	function buildSearchReturn(opts: SearchReturnOptions): AgentToolResult<Record<string, unknown>> {
		const sc = opts.results.filter(r => !r.error).length;
		const tr = opts.results.reduce((sum, r) => sum + r.results.length, 0);

		let output = "";
		for (const { query, answer, results, error } of opts.results) {
			if (opts.queryList.length > 1) {
				output += `## Query: "${query}"\n\n`;
			}
			if (error) output += `Error: ${error}\n\n`;
			else output += formatSearchSummary(results, answer) + "\n\n";
		}

		const hasInlineReady = hasFullInlineCoverage(opts.urls, opts.inlineContent);
		let fetchId: string | null = null;
		if (hasInlineReady && opts.inlineContent) {
			fetchId = generateId();
			const data = {
				id: fetchId,
				type: "fetch",
				timestamp: Date.now(),
				urls: opts.inlineContent,
			} satisfies StoredSearchData & { type: "fetch"; urls: ExtractedContent[] };
			pi.appendEntry("web-search-results", storeFetchedContentResult(fetchId, data));
			output += `---\nFull content for ${opts.inlineContent.length} sources available [${fetchId}].`;
		} else if (opts.includeContent) {
			fetchId = startBackgroundFetch(opts.urls, opts.proxy);
			if (fetchId) {
				output += `---\nContent fetching in background [${fetchId}]. Will notify when ready.`;
			}
		}

		const searchId = storeAndPublishSearch(opts.results);
		const isBackgroundFetch = fetchId !== null && !hasInlineReady;

		return {
			content: [{ type: "text", text: output.trim() }],
			details: {
				queries: opts.queryList,
				queryCount: opts.queryList.length,
				successfulQueries: sc,
				totalResults: tr,
				includeContent: opts.includeContent,
				fetchId,
				fetchUrls: isBackgroundFetch ? opts.urls : undefined,
				searchId,
			},
		};
	}

	pi.registerShortcut(activityKey, {
		description: "Toggle web search activity",
		handler: async (ctx) => {
			widgetVisible = !widgetVisible;
			if (widgetVisible) {
				widgetUnsubscribe = activityMonitor.onUpdate(() => updateWidget(ctx));
				updateWidget(ctx);
			} else {
				widgetUnsubscribe?.();
				widgetUnsubscribe = null;
				ctx.ui.setWidget("web-activity", undefined);
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => handleSessionChange(ctx));
	pi.on("session_tree", async (_event, ctx) => handleSessionChange(ctx));

	pi.on("session_shutdown", () => {
		sessionActive = false;
		abortPendingFetches();
		clearCloneCache();
		clearResults();
		// Unsubscribe before clear() to avoid callback with stale ctx
		widgetUnsubscribe?.();
		widgetUnsubscribe = null;
		activityMonitor.clear();
		widgetVisible = false;
	});

	if (webSearchEnabled) pi.registerTool({
		name: toolNames.webSearch,
		label: "Web Search",
		description:
			"Search the web through the configured default route. Supports single or multiple queries, result limits, recency and domain filters.",
		promptSnippet:
			"Search the web through the configured default route; use 2-4 varied queries when broader research is needed.",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Single search query. For research tasks, prefer 'queries' with multiple varied angles instead." })),
			queries: Type.Optional(Type.Array(Type.String(), { description: "Multiple queries searched in sequence, each returning its own synthesized answer. Prefer this for research — vary phrasing, scope, and angle across 2-4 queries to maximize coverage. Good: ['React vs Vue performance benchmarks 2026', 'React vs Vue developer experience comparison', 'React ecosystem size vs Vue ecosystem']. Bad: ['React vs Vue', 'React vs Vue comparison', 'React vs Vue review'] (too similar, redundant results)." })),
			numResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Results per query (default: 5, max: 20)" })),
			recencyFilter: Type.Optional(
				StringEnum(["day", "week", "month", "year"], { description: "Filter by recency" }),
			),
			domainFilter: Type.Optional(Type.Array(Type.String(), { description: "Limit to domains (prefix with - to exclude)" })),
			proxy: Type.Optional(Type.String({
				description: "http(s) proxy URL (e.g. http://host:port) used for every outbound request in this call (search APIs and content fetches). Node fetch ignores HTTP(S)_PROXY env vars, so set this (or `proxy` in web-search.json) when direct access is blocked; empty string forces direct access.",
			})),
		}),

		async execute(callId, params, signal, onUpdate, ctx) {
			// Published v0.25.0 sessions may still contain these arguments. Keep them
			// readable for resume compatibility without advertising them to new agents.
			const legacyParams = params as typeof params & { provider?: unknown };
			return runWithProxy(typeof params.proxy === "string" ? params.proxy : undefined, async () => {
				const rawQueryList: unknown[] = Array.isArray(params.queries)
					? params.queries
					: (params.query !== undefined ? [params.query] : []);
				const queryList = normalizeQueryList(rawQueryList);
				const recencyFilter = normalizeRecencyFilter(params.recencyFilter);

				if (queryList.length === 0) {
					return {
						content: [{ type: "text", text: "Error: No query provided. Use 'query' or 'queries' parameter." }],
						details: { error: "No query provided" },
					};
				}

			const searchResults: QueryResultData[] = [];
			const allUrls: string[] = [];
			const allInlineContent: ExtractedContent[] = [];
			const resolvedProvider = resolveRequestedProvider(legacyParams.provider);

			for (let i = 0; i < queryList.length; i++) {
				const query = queryList[i];

				onUpdate?.({
					content: [{ type: "text", text: `Searching ${i + 1}/${queryList.length}: "${query}"...` }],
					details: { phase: "search", progress: i / queryList.length, currentQuery: query },
				});

				try {
					const { answer, results, inlineContent, provider } = await search(query, {
						provider: resolvedProvider,
						numResults: params.numResults,
						recencyFilter,
						domainFilter: params.domainFilter,
						includeContent: false,
						signal,
						extensionContext: ctx,
					});

					searchResults.push({ query, answer, results, error: null, provider });
					for (const r of results) {
						if (!allUrls.includes(r.url)) {
							allUrls.push(r.url);
						}
					}
					if (inlineContent) allInlineContent.push(...inlineContent);
				} catch (err) {
					if (signal?.aborted || isAbortError(err)) throw err;
					const message = err instanceof Error ? err.message : String(err);
					const requestedProvider = toProviderLabel(resolvedProvider);
					searchResults.push({ query, answer: "", results: [], error: message, provider: requestedProvider });
				}
			}

			return buildSearchReturn({
				queryList,
				results: searchResults,
				urls: allUrls,
				includeContent: false,
				inlineContent: allInlineContent.length > 0 ? allInlineContent : undefined,
				proxy: typeof params.proxy === "string" ? params.proxy : undefined,
			});
			});
		},

		renderCall(args, theme) {
			const input = args as { query?: unknown; queries?: unknown };
			const rawQueryList: unknown[] = Array.isArray(input.queries)
				? input.queries
				: (input.query !== undefined ? [input.query] : []);
			const queryList = normalizeQueryList(rawQueryList);
			if (queryList.length === 0) {
				return new Text(theme.fg("toolTitle", theme.bold("search ")) + theme.fg("error", "(no query)"), 0, 0);
			}
			if (queryList.length === 1) {
				const q = queryList[0];
				const display = q.length > 60 ? q.slice(0, 57) + "..." : q;
				return new Text(theme.fg("toolTitle", theme.bold("search ")) + theme.fg("accent", `"${display}"`), 0, 0);
			}
			const lines = [theme.fg("toolTitle", theme.bold("search ")) + theme.fg("accent", `${queryList.length} queries`)];
			for (const q of queryList.slice(0, 5)) {
				const display = q.length > 50 ? q.slice(0, 47) + "..." : q;
				lines.push(theme.fg("muted", `  "${display}"`));
			}
			if (queryList.length > 5) {
				lines.push(theme.fg("muted", `  ... and ${queryList.length - 5} more`));
			}
			return new Text(lines.join("\n"), 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as {
				queryCount?: number;
				successfulQueries?: number;
				totalResults?: number;
				error?: string;
				fetchId?: string;
				fetchUrls?: string[];
				phase?: string;
				progress?: number;
				currentQuery?: string;
			};

			if (isPartial) {
				if (details?.phase === "searching") {
					const progress = details?.progress ?? 0;
					const bar = "\u2588".repeat(Math.floor(progress * 10)) + "\u2591".repeat(10 - Math.floor(progress * 10));
					const query = details?.currentQuery || "";
					const display = query.length > 40 ? query.slice(0, 37) + "..." : query;
					return new Text(theme.fg("accent", `[${bar}] ${display}`), 0, 0);
				}
				const progress = details?.progress ?? 0;
				const bar = "\u2588".repeat(Math.floor(progress * 10)) + "\u2591".repeat(10 - Math.floor(progress * 10));
				return new Text(theme.fg("accent", `[${bar}] ${details?.phase || "searching"}`), 0, 0);
			}

			if (details?.error) {
				// Expandable Ctrl+O diagnostics: which queries completed, per-query errors,
				// browser connection state, cancel reason. See render-search-error.ts.
				const plan = buildSearchErrorPlan(details as SearchErrorDetails);
				if (plan) return renderSearchErrorPlan(plan, expanded, theme);
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			let statusLine: string;
			const queryInfo = details?.queryCount === 1 ? "" : `${details?.successfulQueries}/${details?.queryCount} queries, `;
			statusLine = theme.fg("success", `${queryInfo}${details?.totalResults ?? 0} sources`);
			if (details?.fetchId && details?.fetchUrls) {
				statusLine += theme.fg("muted", ` (fetching ${details.fetchUrls.length} URLs)`);
			} else if (details?.fetchId) {
				statusLine += theme.fg("muted", " (content ready)");
			}

			// Build expanded lines first so collapsed view can reference total count
			const lines = [statusLine];
			{
				const textContent = result.content.find((c) => c.type === "text")?.text || "";
				const preview = textContent.length > 500 ? textContent.slice(0, 500) + "..." : textContent;
				for (const line of preview.split("\n")) {
					lines.push(theme.fg("dim", line));
				}
			}

			if (details?.fetchUrls && details.fetchUrls.length > 0) {
				lines.push(theme.fg("muted", "Fetching:"));
				for (const u of details.fetchUrls.slice(0, 5)) {
					const display = u.length > 60 ? u.slice(0, 57) + "..." : u;
					lines.push(theme.fg("dim", "  " + display));
				}
				if (details.fetchUrls.length > 5) {
					lines.push(theme.fg("dim", `  ... and ${details.fetchUrls.length - 5} more`));
				}
			}

			const totalLines = lines.length;

			if (!expanded) {
				const box = new Box(1, 0);
				box.addChild(new Text(statusLine, 0, 0));

				let collapsedLines = 1; // statusLine
				{
					const textContent = result.content.find((c) => c.type === "text")?.text || "";
					const firstContentLine = textContent.split("\n").find(l => {
						const t = l.trim();
						return t && !t.startsWith("[") && !t.startsWith("#") && !t.startsWith("---");
					});
					const fallbackLine = (firstContentLine?.trim() || "").replace(/\*\*/g, "");
					if (fallbackLine) {
						const preview = fallbackLine.length > 120 ? fallbackLine.slice(0, 117) + "..." : fallbackLine;
						box.addChild(new Text(theme.fg("dim", preview), 0, 0));
						collapsedLines++;
					}
				}
				const moreLines = Math.max(0, totalLines - collapsedLines);
				if (moreLines > 0) {
					box.addChild(new Text(theme.fg("muted", `\n... (${moreLines} more lines, ${totalLines} total, ctrl+o to expand)`), 0, 0));
				}
				return box;
			}

			return new Text(lines.join("\n"), 0, 0);
		},
	});


	if (fetchContentEnabled) pi.registerTool({
		name: toolNames.fetchContent,
		label: "Web Fetch",
		description: "Fetch a URL and write the extracted content to a file in the system temp directory. Readable mode extracts article Markdown; raw mode keeps the exact textual HTTP body. Supports web pages, direct images, GitHub repositories, pull requests, issues, and PDFs. Returns the absolute file path so callers can read it with read/rg/bash.",
		promptSnippet:
			"Fetch a web page, image, GitHub resource, or PDF to a local file; read the returned path with read/rg/bash.",
		parameters: Type.Object({
			url: Type.String({ description: "URL to fetch" }),
			as: Type.Optional(StringEnum(["readable", "raw"], {
				description: "Content form: readable (default article extraction) or raw (exact textual HTTP body).",
			})),
			refresh: Type.Optional(Type.Boolean({
				description: "Bypass the on-disk cache and refetch the URL (default: false).",
			})),
		}),

		async execute(_toolCallId, params, signal, onUpdate): Promise<AgentToolResult<Record<string, unknown>>> {
			let normalized: ReturnType<typeof normalizeWebFetchParams>;
			try {
				normalized = normalizeWebFetchParams(params);
			} catch (err) {
				return webFetchError(err instanceof Error ? err.message : String(err), "");
			}
			const { url, as, refresh } = normalized;
			if (!url) return webFetchError("No URL provided.", "");

			if (!refresh) {
				const hit = readWebFetchCache(url, as);
				if (hit) {
					return webFetchSuccess({
						finalUrl: url,
						as,
						path: hit.path,
						contentType: contentTypeForPath(hit.path),
						bytes: hit.bytes,
						cached: true,
					});
				}
			}

			onUpdate?.({
				content: [{ type: "text", text: `Fetching ${url}...` }],
				details: { phase: "fetch", progress: 0 },
			});

			let result: ExtractedContent | undefined;
			try {
				[result] = await fetchAllContent([url], signal, withRegisteredFetchOptions({ mode: as }, registeredToolNames));
			} catch (err) {
				if (isAbortError(err)) throw err;
				return webFetchError(err instanceof Error ? err.message : String(err), url);
			}
			if (!result) return webFetchError("No content returned.", url);
			if (result.error) return webFetchError(result.error, url);

			const isImage = typeof result.mimeType === "string" && result.mimeType.startsWith("image/") && result.thumbnail !== undefined;
			let file;
			try {
				file = isImage
					? writeWebFetchContent(url, as, Buffer.from(result.thumbnail!.data, "base64"), result.mimeType)
					: writeWebFetchContent(url, as, result.content, result.mimeType);
			} catch (err) {
				return webFetchError(`Failed to write fetched content: ${err instanceof Error ? err.message : String(err)}`, url);
			}

			return webFetchSuccess({
				finalUrl: result.url || url,
				as,
				path: file.path,
				title: result.title,
				contentType: result.mimeType ?? contentTypeForPath(file.path),
				bytes: file.bytes,
				cached: false,
			});
		},

		renderCall(args, theme) {
			const { url, as, refresh } = normalizeWebFetchParams(args as { url?: unknown; as?: unknown; refresh?: unknown });
			if (!url) {
				return new Text(theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("error", "(no URL)"), 0, 0);
			}
			const display = url.length > 60 ? url.slice(0, 57) + "..." : url;
			const lines = [theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("accent", display)];
			if (as !== "readable") lines.push(theme.fg("dim", "  as: ") + theme.fg("warning", as));
			if (refresh) lines.push(theme.fg("dim", "  refresh: ") + theme.fg("warning", "true"));
			return new Text(lines.join("\n"), 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as {
				path?: string;
				finalUrl?: string;
				title?: string;
				contentType?: string;
				bytes?: number;
				cached?: boolean;
				error?: string;
				url?: string;
				phase?: string;
				progress?: number;
			};

			if (isPartial) {
				const progress = details?.progress ?? 0;
				const bar = "\u2588".repeat(Math.floor(progress * 10)) + "\u2591".repeat(10 - Math.floor(progress * 10));
				return new Text(theme.fg("accent", `[${bar}] ${details?.phase || "fetching"}`), 0, 0);
			}

			if (result.isError) {
				const extras: string[] = [];
				if (details?.url) extras.push(`url: ${details.url}`);
				const plan = buildSearchErrorPlan({ error: details?.error ?? "Fetch failed", extraLines: extras });
				if (plan) return renderSearchErrorPlan(plan, expanded, theme);
				return new Text(theme.fg("error", `Error: ${details?.error ?? "Fetch failed"}`), 0, 0);
			}

			const title = details?.title || details?.finalUrl || "Fetched";
			const cached = details?.cached ? theme.fg("muted", " [cached]") : "";
			const statusLine = theme.fg("success", title) + theme.fg("muted", ` (${details?.bytes ?? 0} bytes)`) + cached;
			const pathLine = theme.fg("accent", details?.path ?? "");
			if (!expanded) {
				return new Text(statusLine + "\n" + pathLine, 0, 0);
			}
			const lines = [statusLine, pathLine];
			if (details?.contentType) lines.push(theme.fg("dim", `  content type: ${details.contentType}`));
			return new Text(lines.join("\n"), 0, 0);
		},
	});

	pi.registerCommand("web-search-config", {
		description: "Configure web access search provider route",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/web-search-config 需要交互式 TUI 模式", "error");
				return;
			}

			// 抽成函数：嵌套 ctx.ui.input（供应商 key 设置）结束后外层面板不会恢复，完成后自动重开
			const openConfigPanel = async (): Promise<void> => {
				const initialConfig = loadConfigForExtensionInit();

				// 搜索供应商：面板打开时统一探测可用性，选中未配置项时即时警告
				const availability = await getProviderAvailability(ctx);
				const availabilityMap = availability as unknown as Record<string, boolean>;
				const providerRowLabel = (value: SearchProviderSelection): string => {
					if (Array.isArray(value)) return value.join(" → ");
					if (value === "auto") return "auto（自动回退）";
					if (value === "all") return "all（并行聚合）";
					return availabilityMap[value] ? value : `${value}（未配置）`;
				};
				const describeProviderSelection = (value: SearchProviderSelection): string => {
					if (Array.isArray(value)) return `按序回退: ${value.join(" → ")}`;
					if (value === "all") return "已配置供应商并行聚合，取并集";
					if (value === "auto") {
						const routing = getConfiguredSearchRouting();
						return routing
							? `自动回退: ${routing.providers.join(" → ")}`
							: "自动回退: 内建顺序（searxng → exa → brave → …）";
					}
					return `固定使用 ${value}，失败不回退`;
				};
				let currentProviderSelection: SearchProviderSelection = normalizeProviderInput(initialConfig.searchProvider ?? initialConfig.provider) ?? "auto";

				// 供应商子菜单：同模型选择器的形态，项带可用性/免费徽标
				const providerBadge = (p: string): string => {
					if (availabilityMap[p]) return FREE_PROVIDERS.has(p) ? `✓ ${p}（免费）` : `✓ ${p}`;
					if (PROVIDER_SETUP[p]?.kind === "base-url") return `✗ ${p}（免费，需自托管地址）`;
					return `✗ ${p}（未配置）`;
				};
				const providerEntries: SelectItem[] = [
					{ value: "auto", label: "auto（自动回退）" },
					{ value: "all", label: "all（并行聚合）" },
					...RESOLVED_SEARCH_PROVIDERS.map((p) => ({
						value: p,
						label: providerBadge(p),
					})),
				];
				const buildProviderPicker = (tui: { requestRender(): void }, theme: { fg(id: string, text: string): string; bold(text: string): string }, subDone: (selectedValue?: string) => void) => {
					const pinKey = Array.isArray(currentProviderSelection) ? currentProviderSelection.join(" → ") : currentProviderSelection;
					const entries = providerEntries.map((item) => ({
						value: item.value,
						label: item.value === pinKey ? `${item.label} (当前)` : item.label,
					}));
					let filter = "";
					let selectList = new SelectList(entries.slice(), 12, getSelectListTheme());
					let filteredCount = entries.length;

					const rebuild = () => {
						const query = filter.toLowerCase();
						let filtered = query
							? entries.filter((item) => item.value.toLowerCase().includes(query) || item.label.toLowerCase().includes(query))
							: [...entries];
						if (!query && pinKey) {
							const idx = filtered.findIndex((item) => item.value === pinKey);
							if (idx > 0) filtered = [filtered[idx], ...filtered.slice(0, idx), ...filtered.slice(idx + 1)];
						}
						filteredCount = filtered.length;
						selectList = new SelectList(filtered, 12, getSelectListTheme());
						if (pinKey) {
							const idx = filtered.findIndex((item) => item.value === pinKey);
							if (idx >= 0) selectList.setSelectedIndex(idx);
						}
						selectList.onSelect = (item) => subDone(item.value);
						selectList.onCancel = () => subDone();
					};
					rebuild();

					return {
						render: (width: number) => {
							const lines: string[] = [];
							lines.push(theme.fg("accent", theme.bold("选择搜索供应商")));
							lines.push(theme.fg("dim", filter ? `过滤 "${filter}" • 命中 ${filteredCount}/${entries.length} 个供应商` : `共 ${entries.length} 个供应商（✓ 已配置 / ✗ 未配置，输入字符过滤）`));
							lines.push("");
							if (filteredCount === 0) {
								lines.push(theme.fg("dim", "无匹配供应商 — backspace 清除过滤"));
							} else {
								lines.push(...selectList.render(width));
							}
							lines.push(theme.fg("dim", "输入过滤 • backspace 删除 • ↑↓ 选择 • enter 确认 • esc 取消"));
							return lines;
						},
						invalidate: () => selectList.invalidate(),
						handleInput: (data: string) => {
							if (data.length === 1 && data >= " " && data !== "\x7f" && data !== "\x1b") {
								filter += data;
								rebuild();
								tui.requestRender();
								return;
							}
							if (data === "\x7f" || data === "\b") {
								filter = filter.slice(0, -1);
								rebuild();
								tui.requestRender();
								return;
							}
							selectList.handleInput(data);
							tui.requestRender();
						},
					};
				};

				// Gemini Web 账号状态（只读展示，面板打开时读取一次）
				const resolveGoogleAccountLabel = async (): Promise<string> => {
					if (!isBrowserCookieAccessAllowed()) return `未启用（allowBrowserCookies）`;
					const cookies = await isGeminiWebAvailable();
					if (!cookies) {
						const diag = getGeminiWebAvailabilityDiagnostic();
						return diag ? `不可用： ${diag}` : "不可用（未登录 gemini.google.com）";
					}
					const email = await getActiveGoogleEmail(cookies);
					return email ?? "可用（账号未知）";
				};
				const googleAccountLabel = await resolveGoogleAccountLabel();

				await ctx.ui.custom((tui, theme, _kb, done) => {
					const config = loadConfigForExtensionInit();
					currentProviderSelection = normalizeProviderInput(config.searchProvider ?? config.provider) ?? "auto";

					const save = (updates: Partial<WebSearchConfig>, successLabel?: string): boolean => {
						try {
							saveConfig(updates);
							if (successLabel !== undefined) ctx.ui.notify(successLabel, "info");
							return true;
						} catch (err) {
							const message = err instanceof Error ? err.message : String(err);
							ctx.ui.notify(`Failed to save config: ${message}`, "error");
							return false;
						}
					};

					const providerPickerItem: SettingItem = {
						id: "search-provider",
						label: "搜索供应商",
						currentValue: providerRowLabel(currentProviderSelection),
						description: `${describeProviderSelection(currentProviderSelection)} • enter 打开选择（✓ 已配置 / ✗ 未配置）`,
						submenu: (_current, subDone) => buildProviderPicker(tui, theme, subDone),
					};

					const items: SettingItem[] = [
						providerPickerItem,
						{
							id: "google-account",
							label: "Google 账号",
							currentValue: googleAccountLabel,
							description: "Gemini Web 浏览器 Cookie 状态（只读，重新打开面板刷新）",
						},
					];

					const settingsList = new SettingsList(
						items,
						items.length + 2,
						getSettingsListTheme(),
						(id, newValue) => {
							if (id === "search-provider") {
								const provider = newValue as SearchProviderSelection;
								if (save({ searchProvider: provider })) {
									currentProviderSelection = provider;
									providerPickerItem.currentValue = providerRowLabel(provider);
									providerPickerItem.description = `${describeProviderSelection(provider)} • 凭据在 /web-search-auth 面板管理 • enter 打开选择`;
									if (provider !== "auto" && provider !== "all" && !Array.isArray(provider) && !availabilityMap[provider]) {
										const setup = PROVIDER_SETUP[provider];
										if (setup) {
											ctx.ui.notify(`${provider} 未配置 — 请运行 /web-search-auth 设置${setup.kind === "base-url" ? " Base URL" : " API key"}（或配环境变量）`, "warning");
										} else {
											ctx.ui.notify(`${provider} 未配置（凭据由 pi 模型注册表提供，请在 pi 配置中设置 kimi provider 的模型与 API key）`, "warning");
										}
									}
								} else {
									providerPickerItem.currentValue = providerRowLabel(currentProviderSelection);
								}
								return;
							}
						},
						() => done(undefined),
					);

					const container = new Container();
					container.addChild(new Text(theme.fg("accent", theme.bold("Web Access 配置")), 1, 1));
					container.addChild(new Text(theme.fg("dim", "enter 打开供应商选择 • esc 退出"), 1, 1));
					container.addChild(settingsList);

					return {
						render: (width: number) => container.render(width),
						invalidate: () => container.invalidate(),
						handleInput: (data: string) => {
							settingsList.handleInput?.(data);
							tui.requestRender();
						},
					};
				});
			};
			await openConfigPanel();
		},
	});

	if (isCommandEnabled(initConfig, "auth")) pi.registerCommand("web-search-auth", {
		description: "Manage provider credentials: set/clear API keys and base URLs",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/web-search-auth 需要交互式 TUI 模式", "error");
				return;
			}

			const maskSecret = (v: string): string => (v.length <= 8 ? "••••" : `${v.slice(0, 4)}…${v.slice(-4)}`);
			const availability = await getProviderAvailability(ctx);
			const availabilityMap = availability as unknown as Record<string, boolean>;

			// 嵌套 ctx.ui.input 结束后外层面板不会恢复，抽成函数完成后重开
			const saveConfigSilently = (updates: Partial<WebSearchConfig> & Record<string, unknown>): boolean => {
				try {
					saveConfig(updates);
					return true;
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					ctx.ui.notify(`Failed to save config: ${message}`, "error");
					return false;
				}
			};
			// 顺序化流程：面板用 done() 把动作带出（面板自然关闭），在外层输入 key，再用循环重开面板。
			// 不能在 ctx.ui.custom 回调里嵌套 ctx.ui.input —— 嵌套会破坏 pi 的 overlay 栈，
			// 导致输入框关闭后回车键被残留组件截走（编辑器能输入但不能发送）。
			for (;;) {
				const action = await ctx.ui.custom((tui, theme, _kb, done: (value?: { kind: "setup" | "clear"; provider: string }) => void) => {
					let config = loadConfigForExtensionInit();

					// 凭据管理子菜单：两个动作（SettingsList 的 values 是循环切换，currentValue 不在列表内时永远到不了“清除”，故用子菜单）
					const buildAuthOptionPicker = (pickerTheme: { fg(id: string, text: string): string; bold(text: string): string }, subDone: (action?: "setup" | "clear") => void) => {
						const options: SelectItem[] = [
							{ value: "setup", label: "设置 / 更新" },
							{ value: "clear", label: "清除已保存的值" },
						];
						let selectList = new SelectList(options.slice(), 4, getSelectListTheme());
						selectList.onSelect = (item) => subDone(item.value as "setup" | "clear");
						selectList.onCancel = () => subDone();
						return {
							render: (width: number) => {
								const lines: string[] = [];
								lines.push(pickerTheme.fg("accent", pickerTheme.bold("选择动作")));
								lines.push("");
								lines.push(...selectList.render(width));
								lines.push(pickerTheme.fg("dim", "↑↓ 选择 • enter 确认 • esc 取消"));
								return lines;
							},
							invalidate: () => selectList.invalidate(),
							handleInput: (data: string) => {
								selectList.handleInput(data);
								tui.requestRender();
							},
						};
					};

					const items: SettingItem[] = Object.keys(PROVIDER_SETUP).sort().map((provider) => {
						const setup = PROVIDER_SETUP[provider]!;
						const current = (config as Record<string, unknown>)[setup.configKey];
						const configured = typeof current === "string" && current.trim().length > 0;
						const valueKind = setup.kind === "base-url" ? "Base URL" : "API key";
						const freeNote = FREE_PROVIDERS.has(provider) ? " • 免费供应商（无需 key 也可用）" : "";
						return {
							id: `provider-auth:${provider}`,
							label: provider,
							currentValue: configured
								? `✓ ${setup.kind === "base-url" ? String(current) : maskSecret(String(current))}`
								: availabilityMap[provider] ? "✓（环境变量/其他途径）" : "✗ 未配置",
							submenu: (_current: string, subDone: (action?: "setup" | "clear") => void) => buildAuthOptionPicker(theme, subDone),
							description: `${valueKind} • ${setup.hint}${freeNote}`,
						};
					});
					items.push({
						id: "auth-note-kimi",
						label: "kimi",
						currentValue: "凭据由 pi 模型注册表提供",
						description: "在 pi 配置中设置 kimi provider 的模型与 API key（本面板不管理）",
					});

					const saveLocal = (updates: Partial<WebSearchConfig> & Record<string, unknown>): boolean => {
						try {
							saveConfig(updates);
							return true;
						} catch (err) {
							const message = err instanceof Error ? err.message : String(err);
							ctx.ui.notify(`Failed to save config: ${message}`, "error");
							return false;
						}
					};

					const settingsList = new SettingsList(
						items,
						items.length + 2,
						getSettingsListTheme(),
						(id, newValue) => {
							if (!id.startsWith("provider-auth:")) return;
							const provider = id.slice("provider-auth:".length);
							if (newValue === "setup") {
								done({ kind: "setup", provider });
								return;
							}
							if (newValue === "clear") {
								const setup = PROVIDER_SETUP[provider]!;
								const updates: Partial<WebSearchConfig> & Record<string, unknown> = {};
								updates[setup.configKey] = undefined;
								if (saveLocal(updates)) {
									ctx.ui.notify(`${provider} 的 ${setup.configKey} 已清除，重启 pi 后生效`, "info");
								}
								done({ kind: "clear", provider }); // 循环重开面板以刷新该行状态
								return;
							}
						},
						() => done(undefined),
					);

					const container = new Container();
					container.addChild(new Text(theme.fg("accent", theme.bold(" Web Access 供应商凭据")), 1, 1));
					container.addChild(new Text(theme.fg("dim", `共 ${Object.keys(PROVIDER_SETUP).length} 个供应商（enter 设置，选择“清除”移除；修改后重启 pi 生效）`), 1, 1));
					container.addChild(new Text(theme.fg("dim", "免费无需 key: duckduckgo • anysearch • parallel-mcp • exa • searxng/firecrawl（免费自托管）"), 1, 1));
					container.addChild(settingsList);

					return {
						render: (width: number) => container.render(width),
						invalidate: () => container.invalidate(),
						handleInput: (data: string) => {
							settingsList.handleInput?.(data);
							tui.requestRender();
						},
					};
				});
				if (!action) return; // esc / 面板关闭
				if (action.kind === "clear") continue; // 已在 onChange 中处理，直接重开面板刷新
				const setup = PROVIDER_SETUP[action.provider]!;
				const title = setup.kind === "base-url" ? `设置 ${action.provider} Base URL` : `设置 ${action.provider} API Key`;
				const value = await ctx.ui.input(title, setup.hint);
				const trimmed = value?.trim();
				if (!trimmed) {
					ctx.ui.notify("未修改", "info");
					continue;
				}
				const updates: Partial<WebSearchConfig> & Record<string, unknown> = {};
				updates[setup.configKey] = trimmed;
				if (saveConfigSilently(updates)) {
					ctx.ui.notify(`${action.provider} 的 ${setup.configKey} 已保存，重启 pi 后生效`, "info");
				}
				// 循环重开面板，显示更新后的状态
			}
			return;
		},
	});

	if (isCommandEnabled(initConfig, "search")) pi.registerCommand("web-search-history", {
		description: "Browse stored web search results",
		handler: async (_args, ctx) => {
			const results = getAllResults();

			if (results.length === 0) {
				ctx.ui.notify("No stored search results", "info");
				return;
			}

			const options = results.map((r) => {
				const age = Math.floor((Date.now() - r.timestamp) / 60000);
				const ageStr = age < 60 ? `${age}m ago` : `${Math.floor(age / 60)}h ago`;
				if (r.type === "search" && r.queries) {
					const query = r.queries[0]?.query || "unknown";
					return `[${r.id.slice(0, 6)}] "${query}" (${r.queries.length} queries) - ${ageStr}`;
				}
				if (r.type === "fetch" && (r.urls || r.urlMetadata)) {
					return `[${r.id.slice(0, 6)}] ${(r.urls ?? r.urlMetadata ?? []).length} URLs fetched - ${ageStr}`;
				}
				return `[${r.id.slice(0, 6)}] ${r.type} - ${ageStr}`;
			});

			const choice = await ctx.ui.select("Stored Search Results", options);
			if (!choice) return;

			const match = choice.match(/^\[([a-z0-9]+)\]/);
			if (!match) return;

			const selected = results.find((r) => r.id.startsWith(match[1]));
			if (!selected) return;

			const actions = ["View details", "Delete"];
			const action = await ctx.ui.select(`Result ${selected.id.slice(0, 6)}`, actions);

			if (action === "Delete") {
				deleteResult(selected.id);
				ctx.ui.notify(`Deleted ${selected.id.slice(0, 6)}`, "info");
			} else if (action === "View details") {
				let info = `ID: ${selected.id}\nType: ${selected.type}\nAge: ${Math.floor((Date.now() - selected.timestamp) / 60000)}m\n\n`;
				if (selected.type === "search" && selected.queries) {
					info += "Queries:\n";
					const queries = selected.queries.slice(0, 10);
					for (const q of queries) {
						info += `- "${q.query}" (${q.results.length} results)\n`;
					}
					if (selected.queries.length > 10) {
						info += `... and ${selected.queries.length - 10} more\n`;
					}
				}
				if (selected.type === "fetch" && (selected.urls || selected.urlMetadata)) {
					info += "URLs:\n";
					const urlItems = selected.urls ?? selected.urlMetadata ?? [];
					const urls = urlItems.slice(0, 10);
					for (const u of urls) {
						const urlDisplay = u.url.length > 50 ? u.url.slice(0, 47) + "..." : u.url;
						const contentLength = "content" in u ? u.content.length : u.contentLength;
						info += `- ${urlDisplay} (${u.error || `${contentLength} chars`})\n`;
					}
					if (urlItems.length > 10) {
						info += `... and ${urlItems.length - 10} more\n`;
					}
				}
				ctx.ui.notify(info, "info");
			}
		},
	});
}
