import { getSelectListTheme, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, type SettingItem, SettingsList, SelectList, Text } from "@earendil-works/pi-tui";
import { Box, truncateToWidth, type KeyId } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { StringEnum, type ImageContent, type TextContent } from "@earendil-works/pi-ai/compat";
import type { ExtractedContent, ExtractOptions } from "./extract.ts";
import { normalizeFetchContentParams } from "./fetch-params.ts";
import { resolveAuthFetchProfile, type AuthFetchProfile } from "./auth-fetch.ts";
import { findContent, type FindMode } from "./content-find.ts";
import { answerFromPage } from "./page-query.ts";
import { rewriteSearchQuery } from "./query-rewrite.ts";
import { clearCloneCache } from "./github-extract.ts";
import { getConfiguredSearchRouting, normalizeSearchProviderSelection, RESOLVED_SEARCH_PROVIDERS, search, type AttributedSearchResponse, type SearchProvider, type SearchProviderSelection, type ResolvedSearchProvider } from "./gemini-search.ts";
import type { SearchResult } from "./perplexity.ts";
import { formatSeconds, getWebSearchConfigDir, getWebSearchConfigPath, installGlobalProxyFetch, resolveCuratorNetworkConfig, runWithProxy } from "./utils.ts";
import {
	clearResults,
	deleteResult,
	generateId,
	getAllResults,
	getResult,
	restoreFromSession,
	storeFetchedContentResult,
	storeResult,
	type QueryResultData,
	type StoredSearchData,
} from "./storage.ts";
import { activityMonitor, type ActivityEntry } from "./activity.ts";
import { startCuratorServer, type CuratorSearchEntry, type CuratorServerHandle, type IndexedCuratorSearchEntry } from "./curator-server.ts";
import {
	buildDeterministicSummary,
	generateSummaryDraft,
	SUMMARY_GENERATION_DEADLINE_MS,
	type SummaryGenerationContext,
	type SummaryMeta,
} from "./summary-review.ts";
import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { platform } from "node:os";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { isPerplexityAvailable } from "./perplexity.ts";
import { isExaAvailable } from "./exa.ts";
import { isGeminiApiAvailable } from "./gemini-api.ts";
import { getActiveGoogleEmail, getGeminiWebAvailabilityDiagnostic, isGeminiWebAvailable } from "./gemini-web.ts";
import { isBrowserCookieAccessAllowed } from "./gemini-web-config.ts";
import { isBraveAvailable } from "./brave.ts";
import { isCurrentModelHostedSearchEligible, isOpenAISearchAvailable } from "./openai-search.ts";
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
import { findModelWithProviderRouting, loadEnabledModelPatterns, modelMatchesEnabledPatterns, splitThinkingSuffix } from "./summary-model-scope.ts";

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
	workflow?: string;
	curatorTimeoutSeconds?: unknown;
	autoOpenBrowser?: unknown;
	curatorRemote?: unknown;
	summaryModel?: string;
	summaryGenerationDeadlineMs?: unknown;
	maxInlineContentChars?: unknown;
	webSearch?: {
		enabled?: boolean;
	};
	tools?: Partial<Record<keyof ToolNames, { enabled?: boolean }>>;
	commands?: Partial<Record<"curator" | "search" | "auth", { enabled?: boolean }>>;
	toolNames?: Partial<ToolNames>;
	shortcuts?: {
		curate?: KeyId;
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

type WebSearchWorkflow = "none" | "summary-review" | "auto-summary";
type CuratorWorkflow = "summary-review";
export type CuratorProvider = Exclude<SearchProvider, "auto">;
type SummaryWorkflow = "summary-review" | "auto-summary";

interface CuratorBootstrap {
	availableProviders: ProviderAvailability;
	defaultProvider: CuratorProvider;
	timeoutSeconds: number;
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
	getSearchContent: string;
};

const DEFAULT_TOOL_NAMES: ToolNames = {
	webSearch: "web_search",
	fetchContent: "fetch_content",
	getSearchContent: "get_search_content",
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
const DEFAULT_SHORTCUTS = { curate: "ctrl+shift+s", activity: "ctrl+shift+w" } satisfies Record<string, KeyId>;
const DEFAULT_CURATOR_TIMEOUT_SECONDS = 20;
const DEFAULT_REMOTE_CURATOR_TIMEOUT_SECONDS = 60;
const MAX_CURATOR_TIMEOUT_SECONDS = 600;
const MAX_SUMMARY_GENERATION_DEADLINE_MS = 600_000;

function isToolEnabled(config: WebSearchConfig, key: keyof ToolNames): boolean {
	const override = config.tools?.[key]?.enabled;
	if (typeof override === "boolean") return override;
	return key !== "webSearch" || config.webSearch?.enabled !== false;
}

function isCommandEnabled(config: WebSearchConfig, name: "curator" | "search" | "auth"): boolean {
	return config.commands?.[name]?.enabled !== false;
}

function joinToolNames(names: string[]): string {
	if (names.length === 0) return "stored content";
	if (names.length === 1) return names[0];
	if (names.length === 2) return `${names[0]} or ${names[1]}`;
	return `${names.slice(0, -1).join(", ")}, or ${names[names.length - 1]}`;
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

function toCuratorProvider(provider: SearchProviderSelection): CuratorProvider | undefined {
	if (Array.isArray(provider)) return "all";
	return provider === "auto" ? undefined : provider;
}

function resolveCuratorSearchProvider(requested: unknown, current: SearchProviderSelection): SearchProviderSelection {
	const normalized = normalizeProviderInput(requested);
	if (!normalized || normalized === "auto") return current;
	if (normalized === "all" && Array.isArray(current)) return current;
	return normalized;
}

function normalizeRecencyFilter(value: unknown): RecencyFilter | undefined {
	return value === "day" || value === "week" || value === "month" || value === "year"
		? value
		: undefined;
}

function normalizeCuratorTimeoutSeconds(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	const normalized = Math.floor(value);
	if (normalized < 1) return undefined;
	return Math.min(normalized, MAX_CURATOR_TIMEOUT_SECONDS);
}

function resolveWorkflow(input: unknown, hasUI: boolean): WebSearchWorkflow {
	const normalized = typeof input === "string" ? input.trim().toLowerCase() : "";
	if (normalized === "auto-summary") return "auto-summary";
	if (!hasUI) return "none";
	if (normalized === "none") return "none";
	return "summary-review";
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

function getCuratorTimeoutSeconds(): number {
	const source = loadConfig();
	const explicit = normalizeCuratorTimeoutSeconds(source.curatorTimeoutSeconds);
	if (explicit !== undefined) return explicit;
	// Remote users must notice and click a printed link, so allow more idle time.
	return resolveCuratorNetworkConfig().enabled ? DEFAULT_REMOTE_CURATOR_TIMEOUT_SECONDS : DEFAULT_CURATOR_TIMEOUT_SECONDS;
}

export function getSummaryGenerationDeadlineMs(): number {
	const value = loadConfig().summaryGenerationDeadlineMs;
	if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
		return SUMMARY_GENERATION_DEADLINE_MS;
	}
	return Math.min(value, MAX_SUMMARY_GENERATION_DEADLINE_MS);
}

function shouldAutoOpenCuratorBrowser(config: WebSearchConfig): boolean {
	if (config.autoOpenBrowser === false) return false;
	if (resolveCuratorNetworkConfig().enabled && config.autoOpenBrowser !== true) return false;
	return true;
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

function shouldUseOpenAICodexDefault(ctx?: Pick<ExtensionContext, "model">): boolean {
	return ctx?.model?.provider === "openai-codex";
}

function shouldPreferOpenAI(options: Pick<PendingCurate, "numResults" | "recencyFilter"> | undefined, preferOpenAICodexDefault: boolean): boolean {
	if (options?.recencyFilter) return false;
	if (typeof options?.numResults === "number" && Number.isFinite(options.numResults) && Math.floor(options.numResults) !== 5) {
		return false;
	}
	return preferOpenAICodexDefault;
}

async function loadCuratorBootstrap(
	requestedProvider: unknown,
	ctx: ExtensionContext,
	options?: Pick<PendingCurate, "numResults" | "recencyFilter">,
): Promise<CuratorBootstrap> {
	const provider = resolveRequestedProvider(requestedProvider);
	const availableProviders = await getProviderAvailability(ctx);
	if (Array.isArray(provider)) availableProviders.all = true;
	return {
		availableProviders,
		defaultProvider: resolveCuratorDefaultProvider(provider, availableProviders, ctx, options),
		timeoutSeconds: getCuratorTimeoutSeconds(),
	};
}

export function resolveCuratorDefaultProvider(
	provider: SearchProviderSelection,
	available: ProviderAvailability,
	ctx?: Pick<ExtensionContext, "model">,
	options?: Pick<PendingCurate, "numResults" | "recencyFilter">,
): CuratorProvider {
	return resolveProvider(provider, available, options, shouldUseOpenAICodexDefault(ctx), ctx);
}

function firstAvailableProvider(available: ProviderAvailability, preferOpenAI: boolean, fallback: ResolvedSearchProvider): ResolvedSearchProvider {
	if (available.searxng) return "searxng";
	if (preferOpenAI && available.openai) return "openai";
	if (available.exa) return "exa";
	if (available.openai) return "openai";
	if (available.brave) return "brave";
	if (available.parallel) return "parallel";
	if (available.tinyfish) return "tinyfish";
	if (available.search1api) return "search1api";
	if (available.searchinfinity) return "searchinfinity";
	if (available.querit) return "querit";
	if (available.tavily) return "tavily";
	if (available.firecrawl) return "firecrawl";
	if (available.jina) return "jina";
	if (available.serpdive) return "serpdive";
	if (available.kagi) return "kagi";
	if (available.bocha) return "bocha";
	if (available.ollama) return "ollama";
	if (available.perplexity) return "perplexity";
	if (available.gemini) return "gemini";
	return fallback;
}

function resolveProvider(
	provider: SearchProviderSelection,
	available: ProviderAvailability,
	options?: Pick<PendingCurate, "numResults" | "recencyFilter">,
	preferOpenAICodexDefault = false,
	ctx?: Pick<ExtensionContext, "model">,
): CuratorProvider {
	if (Array.isArray(provider)) return "all";
	const preferOpenAI = shouldPreferOpenAI(options, preferOpenAICodexDefault);

	if (provider === "auto") {
		const routing = getConfiguredSearchRouting();
		if (routing) {
			for (const candidate of routing.providers) {
				if (candidate === "openai" && routing.useCurrentModel === true && !isCurrentModelHostedSearchEligible(ctx)) continue;
				if (available[candidate]) return candidate;
			}
			return routing.providers.find(candidate => candidate !== "openai" || routing.useCurrentModel !== true || isCurrentModelHostedSearchEligible(ctx)) ?? routing.providers[0];
		}
		return firstAvailableProvider(available, preferOpenAI, "exa");
	}
	if (provider === "all" && !available.all) {
		return firstAvailableProvider(available, preferOpenAI, "exa");
	}
	if (provider === "openai" && !available.openai) {
		return firstAvailableProvider(available, false, "openai");
	}
	if (provider === "brave" && !available.brave) {
		return firstAvailableProvider(available, preferOpenAI, "brave");
	}
	if (provider === "parallel" && !available.parallel) {
		return firstAvailableProvider(available, preferOpenAI, "parallel");
	}
	if (provider === "tinyfish" && !available.tinyfish) {
		return firstAvailableProvider(available, preferOpenAI, "tinyfish");
	}
	if (provider === "search1api" && !available.search1api) {
		return firstAvailableProvider(available, preferOpenAI, "search1api");
	}
	if (provider === "searchinfinity" && !available.searchinfinity) {
		return firstAvailableProvider(available, preferOpenAI, "searchinfinity");
	}
	if (provider === "querit" && !available.querit) {
		return firstAvailableProvider(available, preferOpenAI, "querit");
	}
	if (provider === "tavily" && !available.tavily) {
		return firstAvailableProvider(available, preferOpenAI, "tavily");
	}
	if (provider === "firecrawl" && !available.firecrawl) {
		return firstAvailableProvider(available, preferOpenAI, "firecrawl");
	}
	if (provider === "jina" && !available.jina) {
		return firstAvailableProvider(available, preferOpenAI, "jina");
	}
	if (provider === "serpdive" && !available.serpdive) {
		return firstAvailableProvider(available, preferOpenAI, "serpdive");
	}
	if (provider === "kagi" && !available.kagi) {
		return firstAvailableProvider(available, preferOpenAI, "kagi");
	}
	if (provider === "bocha" && !available.bocha) {
		return firstAvailableProvider(available, preferOpenAI, "bocha");
	}
	if (provider === "ollama" && !available.ollama) {
		return firstAvailableProvider(available, preferOpenAI, "ollama");
	}
	if (provider === "searxng" && !available.searxng) {
		return firstAvailableProvider(available, preferOpenAI, "searxng");
	}
	if (provider === "exa" && !available.exa) {
		return firstAvailableProvider(available, preferOpenAI, "exa");
	}
	if (provider === "perplexity" && !available.perplexity) {
		return firstAvailableProvider(available, preferOpenAI, "perplexity");
	}
	if (provider === "gemini" && !available.gemini) {
		return firstAvailableProvider(available, preferOpenAI, "gemini");
	}
	return provider;
}

const pendingFetches = new Map<string, AbortController>();
let sessionActive = false;
let widgetVisible = false;
let widgetUnsubscribe: (() => void) | null = null;
const pendingCurates = new Map<string, PendingCurate>();
const activeCurators = new Map<string, CuratorServerHandle>();
const glimpseWins = new Map<string, GlimpseWindow>();

interface PendingCurate {
	phase: "searching" | "curating";
	workflow: CuratorWorkflow;
	summaryContext: SummaryGenerationContext;
	searchResults: Map<number, QueryResultData>;
	resultSlots: Map<number, number>;
	allInlineContent: ExtractedContent[];
	queryList: string[];
	includeContent: boolean;
	numResults?: number;
	recencyFilter?: "day" | "week" | "month" | "year";
	domainFilter?: string[];
	availableProviders: ProviderAvailability;
	defaultProvider: CuratorProvider;
	searchProvider: SearchProviderSelection;
	summaryModels: Array<{ value: string; label: string }>;
	defaultSummaryModel: string | null;
	timeoutSeconds: number;
	proxy?: string;
	curatorUrl?: string;
	onUpdate: ((update: { content: Array<{ type: string; text: string }>; details?: Record<string, unknown> }) => void) | undefined;
	signal: AbortSignal | undefined;
	abortSearches: () => void;
	finish: (value: AgentToolResult<Record<string, unknown>>) => void;
	cancel: (reason?: "user" | "stale") => void;
	browserPromise?: Promise<void>;
	browserOpenError?: string;
}


const DEFAULT_MAX_INLINE_CONTENT_CHARS = 30_000;
const MAX_INLINE_CONTENT_CHARS = 200_000;

function getMaxInlineContentChars(config = loadConfig()): number {
	const value = config.maxInlineContentChars;
	if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
		return DEFAULT_MAX_INLINE_CONTENT_CHARS;
	}
	return Math.min(value, MAX_INLINE_CONTENT_CHARS);
}

function stripThumbnails(results: ExtractedContent[]): ExtractedContent[] {
	return results.map(({ thumbnail, frames, ...rest }) => rest);
}

function storeFetchResult(pi: { appendEntry(type: string, data: unknown): void }, responseId: string, data: StoredSearchData & { type: "fetch"; urls: ExtractedContent[] }, authProfile?: AuthFetchProfile): boolean {
	if (authProfile?.cache === "off") return false;
	pi.appendEntry("web-search-results", storeFetchedContentResult(responseId, data));
	return true;
}

function initialContentSlice(content: string, maxChars: number): {
	text: string;
	endOffset: number;
	totalBytes: number;
	totalLines: number;
	shownBytes: number;
	shownLines: number;
} {
	let endOffset = Math.min(content.length, maxChars);
	if (endOffset < content.length) {
		const lineBreak = content.lastIndexOf("\n", endOffset);
		if (lineBreak >= Math.floor(maxChars * 0.8)) endOffset = lineBreak + 1;
	}
	const text = content.slice(0, endOffset);
	return {
		text,
		endOffset,
		totalBytes: Buffer.byteLength(content),
		totalLines: content.length === 0 ? 0 : content.split("\n").length,
		shownBytes: Buffer.byteLength(text),
		shownLines: text.length === 0 ? 0 : text.split("\n").length,
	};
}

function normalizeFindQueries(value: string | string[]): string[] {
	const queries = (Array.isArray(value) ? value : [value]).map(query => query.trim()).filter(Boolean);
	if (queries.length === 0) throw new Error("findText must contain at least one non-empty string");
	return queries;
}

interface GetSearchContentParams {
	responseId: string;
	query?: string;
	queryIndex?: number;
	url?: string;
	urlIndex?: number;
	offset?: number;
	limit?: number;
	findText?: string | string[];
	findMode?: FindMode;
}

type RawGetSearchContentParams = Omit<GetSearchContentParams, "findMode"> & { findMode?: unknown };

function normalizeFindMode(value: unknown): FindMode | undefined {
	if (value === undefined) return undefined;
	if (value === "exact" || value === "case-insensitive" || value === "fuzzy") return value;
	throw new Error('findMode must be "exact", "case-insensitive", or "fuzzy"');
}

function normalizeGetSearchContentParams(params: RawGetSearchContentParams): GetSearchContentParams {
	const normalized: GetSearchContentParams = { ...params, findMode: normalizeFindMode(params.findMode) };

	if (normalized.query?.trim() === "") delete normalized.query;
	if (normalized.url?.trim() === "") delete normalized.url;

	if (normalized.findText !== undefined) {
		delete normalized.offset;
		delete normalized.limit;
	}

	return normalized;
}

function formatInputValue(value: unknown): string {
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number") return Number.isNaN(value) ? "NaN" : String(value);
	try {
		const serialized = JSON.stringify(value);
		return serialized === undefined ? String(value) : serialized;
	} catch {
		return String(value);
	}
}

function formatSearchSummary(results: SearchResult[], answer: string): string {
	if (results.length === 0) {
		return answer ? `${answer}\n\n---\n\n**Sources:**\nNo sources returned.` : "No results found.";
	}
	let output = answer ? `${answer}\n\n---\n\n**Sources:**\n` : "";
	output += results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}`).join("\n\n");
	return output;
}

function duplicateQuerySet(results: QueryResultData[]): Set<string> {
	const counts = new Map<string, number>();
	for (const result of results) {
		counts.set(result.query, (counts.get(result.query) ?? 0) + 1);
	}
	const duplicates = new Set<string>();
	for (const [query, count] of counts) {
		if (count > 1) duplicates.add(query);
	}
	return duplicates;
}

function formatQueryHeader(query: string, provider: string | undefined, duplicateQueries: Set<string>): string {
	const suffix = duplicateQueries.has(query) && provider ? ` (${provider})` : "";
	return `## Query: "${query}"${suffix}\n\n`;
}

function hasFullInlineCoverage(urls: string[], inlineContent: ExtractedContent[] | undefined): boolean {
	if (!inlineContent || inlineContent.length === 0) return false;
	const coveredUrls = new Set(inlineContent.map(c => c.url));
	return urls.every(url => coveredUrls.has(url));
}

function formatFullResults(queryData: QueryResultData): string {
	let output = `## Results for: "${queryData.query}"\n\n`;
	if (queryData.answer) {
		output += `${queryData.answer}\n\n---\n\n`;
	}
	for (const r of queryData.results) {
		output += `### ${r.title}\n${r.url}\n\n`;
	}
	return output;
}

function abortPendingFetches(): void {
	for (const controller of pendingFetches.values()) {
		controller.abort();
	}
	pendingFetches.clear();
}

function closeCurator(callId?: string): void {
	if (callId !== undefined) {
		const win = glimpseWins.get(callId);
		glimpseWins.delete(callId);
		try { win?.close(); } catch {}
		pendingCurates.get(callId)?.cancel("stale");
		pendingCurates.delete(callId);
		const curator = activeCurators.get(callId);
		activeCurators.delete(callId);
		try { curator?.close(); } catch {}
		return;
	}

	for (const win of glimpseWins.values()) {
		try { win.close(); } catch {}
	}
	glimpseWins.clear();
	for (const pc of pendingCurates.values()) {
		try { pc.cancel("stale"); } catch {}
	}
	pendingCurates.clear();
	for (const curator of activeCurators.values()) {
		try { curator.close(); } catch {}
	}
	activeCurators.clear();
}

async function openInBrowser(pi: ExtensionAPI, url: string): Promise<void> {
	const plat = platform();
	if (plat !== "darwin" && plat !== "win32") {
		await new Promise<void>((resolve, reject) => {
			const child = spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
			const timer = setTimeout(resolve, 100);
			child.once("error", (err) => {
				clearTimeout(timer);
				reject(err);
			});
			child.once("exit", (code) => {
				clearTimeout(timer);
				if (code === 0) resolve();
				else reject(new Error(`Failed to open browser (exit code ${code ?? "unknown"})`));
			});
			child.unref();
		});
		return;
	}
	const result = plat === "darwin"
		? await pi.exec("open", [url])
		: await pi.exec("cmd", ["/c", "start", "", url]);
	if (result.code !== 0) {
		throw new Error(result.stderr || `Failed to open browser (exit code ${result.code})`);
	}
}

interface GlimpseWindow {
	on(event: "closed", handler: () => void): void;
	on(event: "message", handler: (data: unknown) => void): void;
	on(event: "ready", handler: (info: { screen?: { visibleHeight?: number } }) => void): void;
	close(): void;
	_write(obj: Record<string, unknown>): void;
}

let glimpseOpen: ((html: string, opts: Record<string, unknown>) => GlimpseWindow) | null | undefined;

function findGlimpseMjs(): string | null {
	try {
		const req = createRequire(import.meta.url);
		return req.resolve("glimpseui");
	} catch {
		// Optional dependency.
	}
	try {
		const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf-8" }).trim();
		const entry = join(globalRoot, "glimpseui", "src", "glimpse.mjs");
		if (existsSync(entry)) return entry;
	} catch {
		// npm may be unavailable.
	}
	return null;
}

async function getGlimpseOpen() {
	if (glimpseOpen !== undefined) return glimpseOpen;
	const resolved = findGlimpseMjs();
	if (resolved) {
		try {
			glimpseOpen = (await import(resolved)).open;
			return glimpseOpen;
		} catch {}
	}
	glimpseOpen = null;
	return glimpseOpen;
}

function openInGlimpse(
	open: (html: string, opts: Record<string, unknown>) => GlimpseWindow,
	url: string,
	title: string,
): GlimpseWindow {
	const shellHTML = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>${title}</title></head>
<body style="margin:0; background:#1a1a2e;">
  <script>window.location.replace(${JSON.stringify(url)});</script>
</body>
</html>`;
	const win = open(shellHTML, {
		width: 800,
		height: 900,
		title,
	});

	let maxHeight = 1200;
	win.on("ready", (info) => {
		const visibleHeight = info?.screen?.visibleHeight;
		if (typeof visibleHeight === "number" && visibleHeight > 0) {
			maxHeight = Math.floor(visibleHeight * 0.85);
		}
	});
	win.on("message", (data) => {
		if (!data || typeof data !== "object") return;
		const msg = data as Record<string, unknown>;
		if (msg.type !== "resize" || typeof msg.height !== "number") return;
		const clamped = Math.max(400, Math.min(Math.round(msg.height), maxHeight));
		win._write({ type: "resize", width: 800, height: clamped });
	});

	return win;
}

function extractDomain(url: string): string {
	try { return new URL(url).hostname; }
	catch { return url; }
}

function toCuratorSearchEntries(response: AttributedSearchResponse): CuratorSearchEntry[] {
	const providerResponses = response.provider === "all" && response.providerResponses?.length
		? response.providerResponses
		: [response];
	const entries: CuratorSearchEntry[] = providerResponses.map(result => ({
		answer: result.answer,
		results: result.results.map(source => ({ ...source, domain: extractDomain(source.url) })),
		provider: result.provider,
	}));
	for (const failure of response.providerErrors ?? []) {
		entries.push({
			answer: "",
			results: [],
			provider: failure.provider,
			error: failure.error,
		});
	}
	return entries;
}

function indexedCuratorEntryToQueryResult(entry: IndexedCuratorSearchEntry): QueryResultData {
	return {
		query: entry.query,
		answer: entry.answer,
		results: entry.results.map(source => ({
			title: source.title,
			url: source.url,
			snippet: source.snippet ?? "",
		})),
		error: entry.error ?? null,
		provider: entry.provider,
	};
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
	closeCurator();
	clearCloneCache();
	sessionActive = true;
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
	const getSearchContentEnabled = isToolEnabled(initConfig, "getSearchContent");
	// Names as registered this session, so fetch failure guidance never points
	// at tools that are disabled or were renamed after init.
	const registeredToolNames = {
		...(webSearchEnabled ? { webSearch: toolNames.webSearch } : {}),
		...(fetchContentEnabled ? { fetchContent: toolNames.fetchContent } : {}),
	};
	const storedContentSources = joinToolNames([
		...(webSearchEnabled ? [toolNames.webSearch] : []),
		...(fetchContentEnabled ? [toolNames.fetchContent] : []),
	]);
	const searchQueryDescription = webSearchEnabled
		? `Get content for this query (${toolNames.webSearch})`
		: "Get content for a stored search query";
	const fetchContentStorageNote = getSearchContentEnabled
		? `Full original content is stored for retrieval with ${toolNames.getSearchContent}.`
		: "Full original content is stored internally, but the retrieval tool is not registered.";
	const curateKey = initConfig.shortcuts?.curate || DEFAULT_SHORTCUTS.curate;
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
		curated?: boolean;
		curatedFrom?: number;
		workflow?: SummaryWorkflow;
		approvedSummary?: string;
		summaryMeta?: SummaryMeta;
		proxy?: string;
	}

	function normalizeSummaryMeta(meta: SummaryMeta | undefined, summaryText: string): SummaryMeta {
		const normalizedText = summaryText.trim();
		if (!meta) {
			return {
				model: null,
				durationMs: 0,
				tokenEstimate: normalizedText.length > 0 ? Math.max(1, Math.ceil(normalizedText.length / 4)) : 0,
				fallbackUsed: false,
				edited: false,
			};
		}

		return {
			model: meta.model,
			durationMs: Number.isFinite(meta.durationMs) && meta.durationMs >= 0 ? meta.durationMs : 0,
			tokenEstimate: Number.isFinite(meta.tokenEstimate) && meta.tokenEstimate >= 0
				? meta.tokenEstimate
				: (normalizedText.length > 0 ? Math.max(1, Math.ceil(normalizedText.length / 4)) : 0),
			fallbackUsed: meta.fallbackUsed === true,
			fallbackReason: meta.fallbackReason,
			phase: meta.phase,
			edited: meta.edited === true,
		};
	}

	function buildCurationCancelledReturn(
		reason: "user" | "stale",
		partial?: {
			queries?: QueryResultData[];
			queryCount?: number;
			browserConnected?: boolean;
			lastHeartbeatAgeMs?: number | null;
			curatorUrl?: string;
			browserOpenError?: string;
		},
	): AgentToolResult<Record<string, unknown>> {
		const message = `Search curation cancelled (${reason}).`;
		const cancelledQueries = partial?.queries?.length
			? partial.queries.map(q => ({
				query: q.query,
				provider: q.provider ?? null,
				error: q.error,
				resultCount: q.results?.length ?? 0,
			}))
			: undefined;
		const extraLines: string[] = [];
		if (partial?.curatorUrl) extraLines.push(`curator: ${partial.curatorUrl}`);
		if (partial?.browserOpenError) extraLines.push(`browser open error: ${partial.browserOpenError}`);
		return {
			content: [{ type: "text", text: message }],
			details: {
				error: message,
				cancelled: true,
				cancelReason: reason,
				browserConnected: partial?.browserConnected,
				lastHeartbeatAgeMs: partial?.lastHeartbeatAgeMs,
				queryCount: partial?.queryCount,
				cancelledQueries,
				extraLines: extraLines.length > 0 ? extraLines : undefined,
			},
		};
	}

	async function generateSummaryForSelectedIndices(
		selectedQueryIndices: number[],
		resultsByIndex: Map<number, QueryResultData>,
		summaryContext: SummaryGenerationContext,
		signal?: AbortSignal,
		modelOverride?: string,
		feedback?: string,
	): Promise<{ summary: string; meta: SummaryMeta }> {
		const selectedResults: QueryResultData[] = [];
		for (const qi of selectedQueryIndices) {
			const result = resultsByIndex.get(qi);
			if (result) selectedResults.push(result);
		}
		if (selectedResults.length === 0) {
			throw new Error("No selected results available for summary generation");
		}
		try {
			return await generateSummaryDraft(
				selectedResults,
				summaryContext,
				signal,
				modelOverride,
				feedback,
				undefined,
				getSummaryGenerationDeadlineMs(),
			);
		} catch (err) {
			const isEmptyResponse = err instanceof Error && err.message.includes("Summary model returned empty response");
			if (!isEmptyResponse) throw err;
			const deterministic = buildDeterministicSummary(selectedResults);
			return {
				summary: deterministic.summary,
				meta: {
					...deterministic.meta,
					fallbackReason: "summary-model-empty-response",
				},
			};
		}
	}

	async function loadSummaryModelChoices(
		summaryContext: SummaryGenerationContext,
	): Promise<{ summaryModels: Array<{ value: string; label: string }>; defaultSummaryModel: string | null }> {
		const summaryModels: Array<{ value: string; label: string }> = [];
		const seen = new Set<string>();
		const availableValues = new Set<string>();

		const addModel = (provider: string, id: string) => {
			const value = `${provider}/${id}`;
			if (seen.has(value)) return;
			seen.add(value);
			summaryModels.push({ value, label: value });
		};

		let enabledModelPatterns: string[] | null = null;
		let scopeLoaded = true;
		try {
			enabledModelPatterns = loadEnabledModelPatterns(summaryContext);
			const availableModels = summaryContext.modelRegistry.getAvailable();
			for (const model of availableModels) {
				if (!modelMatchesEnabledPatterns(model, enabledModelPatterns)) continue;
				const value = `${model.provider}/${model.id}`;
				availableValues.add(value);
				addModel(model.provider, model.id);
			}
		} catch (err) {
			scopeLoaded = false;
			const message = err instanceof Error ? err.message : String(err);
			console.error(`Failed to load summary models: ${message}`);
		}

		const currentModelValue = summaryContext.model
			? `${summaryContext.model.provider}/${summaryContext.model.id}`
			: null;
		if (scopeLoaded && summaryContext.model && currentModelValue && !seen.has(currentModelValue) && modelMatchesEnabledPatterns(summaryContext.model, enabledModelPatterns)) {
			addModel(summaryContext.model.provider, summaryContext.model.id);
		}

		const config = loadConfig();
		const configuredSummaryModel = typeof config.summaryModel === "string" ? config.summaryModel.trim() : "";
		const preferredDefaults = [
			{ provider: "anthropic", id: "claude-haiku-4-5" },
			{ provider: "openai-codex", id: "gpt-5.6-luna" },
			{ provider: "openai-codex", id: "gpt-5.6-terra" },
			{ provider: "google", id: "gemini-3.6-flash" },
			{ provider: "openai", id: "gpt-5-mini" },
			{ provider: "deepseek", id: "deepseek-v4-flash" },
		];

		const resolveAvailableModelValue = (selector: string): string | null => {
			const parsed = splitThinkingSuffix(selector);
			const slashIndex = parsed.value.indexOf("/");
			if (slashIndex <= 0 || slashIndex >= parsed.value.length - 1) return null;
			const model = findModelWithProviderRouting(
				summaryContext.modelRegistry,
				parsed.value.slice(0, slashIndex),
				parsed.value.slice(slashIndex + 1),
			);
			if (!model) return null;
			const value = `${model.provider}/${model.id}`;
			if (!availableValues.has(value)) return null;
			if (selector !== value && !seen.has(selector)) {
				seen.add(selector);
				summaryModels.push({ value: selector, label: selector });
			}
			return selector;
		};

		let defaultSummaryModel: string | null = null;
		if (scopeLoaded && configuredSummaryModel.length > 0) {
			defaultSummaryModel = availableValues.has(configuredSummaryModel)
				? configuredSummaryModel
				: resolveAvailableModelValue(configuredSummaryModel);
		}
		if (scopeLoaded && !defaultSummaryModel) {
			for (const preferred of preferredDefaults) {
				const model = findModelWithProviderRouting(summaryContext.modelRegistry, preferred.provider, preferred.id);
				const value = model ? `${model.provider}/${model.id}` : null;
				if (value && availableValues.has(value)) {
					defaultSummaryModel = value;
					break;
				}
			}
		}
		return { summaryModels, defaultSummaryModel };
	}

	function resolveSummaryForSubmit(
		payload: { selectedQueryIndices: number[]; summary?: string; summaryMeta?: SummaryMeta },
		resultsByIndex: Map<number, QueryResultData>,
	): { approvedSummary: string; summaryMeta: SummaryMeta } {
		const submittedSummary = typeof payload.summary === "string" ? payload.summary.trim() : "";
		if (submittedSummary.length > 0) {
			return {
				approvedSummary: submittedSummary,
				summaryMeta: normalizeSummaryMeta(payload.summaryMeta, submittedSummary),
			};
		}

		const selected = filterByQueryIndices(payload.selectedQueryIndices, resultsByIndex).results;
		const fallbackResults = selected.length > 0 ? selected : [...resultsByIndex.values()];
		const deterministic = buildDeterministicSummary(fallbackResults);
		return {
			approvedSummary: deterministic.summary,
			summaryMeta: deterministic.meta,
		};
	}

	function buildSearchReturn(opts: SearchReturnOptions): AgentToolResult<Record<string, unknown>> {
		const sc = opts.results.filter(r => !r.error).length;
		const tr = opts.results.reduce((sum, r) => sum + r.results.length, 0);

		const hasApprovedSummary = typeof opts.approvedSummary === "string" && opts.approvedSummary.trim().length > 0;
		let output = "";
		if (hasApprovedSummary) {
			output = opts.approvedSummary!.trim();
		} else {
			if (opts.curated) {
				output += "[These results were manually curated by the user in the browser. Use them as-is — do not re-search or discard.]\n\n";
			}
			const duplicateQueries = opts.curated ? duplicateQuerySet(opts.results) : new Set<string>();
			for (const { query, answer, results, error, provider } of opts.results) {
				if (opts.queryList.length > 1) {
					output += opts.curated
						? formatQueryHeader(query, provider, duplicateQueries)
						: `## Query: "${query}"\n\n`;
				}
				if (error) output += `Error: ${error}\n\n`;
				else output += formatSearchSummary(results, answer) + "\n\n";
			}
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
			if (!hasApprovedSummary) {
				output += `---\nFull content for ${opts.inlineContent.length} sources available [${fetchId}].`;
			}
		} else if (opts.includeContent) {
			fetchId = startBackgroundFetch(opts.urls, opts.proxy);
			if (fetchId && !hasApprovedSummary) {
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
				...(opts.curated ? {
					curated: true,
					curatedFrom: opts.curatedFrom,
					curatedQueries: opts.results.map(r => ({
						query: r.query,
						provider: r.provider || null,
						answer: r.answer || null,
						sources: r.results.map(s => ({ title: s.title, url: s.url })),
						error: r.error,
					})),
				} : {}),
				...((opts.workflow && hasApprovedSummary)
					? {
						summary: {
							text: opts.approvedSummary!.trim(),
							workflow: opts.workflow,
							model: opts.summaryMeta?.model ?? null,
							durationMs: opts.summaryMeta?.durationMs ?? 0,
							tokenEstimate: opts.summaryMeta?.tokenEstimate ?? 0,
							fallbackUsed: opts.summaryMeta?.fallbackUsed === true,
							fallbackReason: opts.summaryMeta?.fallbackReason,
							phase: opts.summaryMeta?.phase,
							edited: opts.summaryMeta?.edited === true,
						},
					}
					: {}),
			},
		};
	}

	function filterByQueryIndices(selectedQueryIndices: number[], results: Map<number, QueryResultData>) {
		const filteredResults: QueryResultData[] = [];
		const filteredUrls: string[] = [];
		for (const qi of selectedQueryIndices) {
			const r = results.get(qi);
			if (r) {
				filteredResults.push(r);
				for (const res of r.results) {
					if (!filteredUrls.includes(res.url)) filteredUrls.push(res.url);
				}
			}
		}
		return { results: filteredResults, urls: filteredUrls };
	}

	function collectAllResultsAndUrls(resultsByIndex: Map<number, QueryResultData>) {
		const results = [...resultsByIndex.values()];
		const urls: string[] = [];
		for (const result of results) {
			for (const source of result.results) {
				if (!urls.includes(source.url)) urls.push(source.url);
			}
		}
		return { results, urls };
	}

	async function openCuratorBrowser(callId: string, pc: PendingCurate, ctx: ExtensionContext, searchesComplete = true): Promise<void> {
		if (pendingCurates.get(callId) !== pc) return;
		let handle: CuratorServerHandle | null = null;
		const sendCuratorFallbackUpdate = (message: string) => {
			if (!handle) return;
			pc.onUpdate?.({
				content: [{ type: "text", text: `${message}\nOpen manually: ${handle.url}` }],
				details: {
					phase: "curator-fallback",
					progress: searchesComplete ? 1 : 0.5,
					curatorUrl: handle.url,
					timeoutSeconds: pc.timeoutSeconds,
					shortcut: curateKey,
					browserOpenError: pc.browserOpenError,
				},
			});
		};
		try {
			pc.phase = "curating";

			const searchAbort = new AbortController();
			const addSearchSignal = pc.signal
				? AbortSignal.any([pc.signal, searchAbort.signal])
				: searchAbort.signal;

			const sessionToken = randomUUID();
			handle = await startCuratorServer(
				{
					queries: pc.queryList,
					sessionToken,
					timeout: pc.timeoutSeconds,
					availableProviders: pc.availableProviders,
					defaultProvider: pc.defaultProvider,
					searchProvider: toCuratorProvider(pc.searchProvider) ?? "auto",
					summaryModels: pc.summaryModels,
					defaultSummaryModel: pc.defaultSummaryModel,
				},
				{
					async onSummarize(selectedQueryIndices, summarizeSignal, model, feedback) {
						return runWithProxy(pc.proxy, async () => {
							if (pendingCurates.get(callId) !== pc) throw new Error("Curator session is no longer active.");
							pc.onUpdate?.({
								content: [{ type: "text", text: "Generating summary draft..." }],
								details: { phase: "generating-summary", progress: 0.9, curatorUrl: pc.curatorUrl, timeoutSeconds: pc.timeoutSeconds, shortcut: curateKey },
							});
							const draft = await generateSummaryForSelectedIndices(
								selectedQueryIndices,
								pc.searchResults,
								pc.summaryContext,
								summarizeSignal,
								model,
								feedback,
							);
							if (pendingCurates.get(callId) !== pc) throw new Error("Curator session is no longer active.");
							pc.onUpdate?.({
								content: [{ type: "text", text: "Summary draft ready — waiting for approval..." }],
								details: { phase: "waiting-for-approval", progress: 1, curatorUrl: pc.curatorUrl, timeoutSeconds: pc.timeoutSeconds, shortcut: curateKey },
							});
							return draft;
						});
					},
					onSubmit(payload) {
						if (pendingCurates.get(callId) !== pc) return;
						searchAbort.abort();
						const filtered = payload.selectedQueryIndices.length > 0
							? filterByQueryIndices(payload.selectedQueryIndices, pc.searchResults)
							: collectAllResultsAndUrls(pc.searchResults);
						const filteredInline = pc.allInlineContent.filter(c => filtered.urls.includes(c.url));
						const base: SearchReturnOptions = {
							queryList: filtered.results.map(r => r.query),
							results: filtered.results,
							urls: filtered.urls,
							includeContent: pc.includeContent,
							inlineContent: filteredInline.length > 0 ? filteredInline : undefined,
							curated: true,
							curatedFrom: pc.searchResults.size,
							proxy: pc.proxy,
						};
						if (!payload.rawResults) {
							const resolvedSummary = resolveSummaryForSubmit(payload, pc.searchResults);
							base.workflow = pc.workflow;
							base.approvedSummary = resolvedSummary.approvedSummary;
							base.summaryMeta = resolvedSummary.summaryMeta;
						}
						pc.finish(buildSearchReturn(base));
						closeCurator(callId);
					},
					onCancel(reason) {
						if (pendingCurates.get(callId) !== pc) return;
						searchAbort.abort();
						if (reason === "timeout") {
							const resolvedSummary = resolveSummaryForSubmit({ selectedQueryIndices: [], summary: undefined, summaryMeta: undefined }, pc.searchResults);
							const all = collectAllResultsAndUrls(pc.searchResults);
							const filteredInline = pc.allInlineContent.filter(c => all.urls.includes(c.url));
							pc.finish(buildSearchReturn({
								queryList: all.results.map(r => r.query),
								results: all.results,
								urls: all.urls,
								includeContent: pc.includeContent,
								inlineContent: filteredInline.length > 0 ? filteredInline : undefined,
								curated: true,
								curatedFrom: pc.searchResults.size,
								workflow: pc.workflow,
								approvedSummary: resolvedSummary.approvedSummary,
								summaryMeta: resolvedSummary.summaryMeta,
								proxy: pc.proxy,
							}));
						} else {
							const conn = activeCurators.get(callId)?.getConnectionState();
							pc.finish(buildCurationCancelledReturn(reason, {
								queries: Array.from(pc.searchResults.values()),
								queryCount: pc.queryList.length,
								browserConnected: conn?.browserConnected,
								lastHeartbeatAgeMs: conn?.lastHeartbeatAgeMs,
								curatorUrl: pc.curatorUrl,
								browserOpenError: pc.browserOpenError,
							}));
						}
						closeCurator(callId);
					},
					onProviderChange(provider) {
						if (pendingCurates.get(callId) !== pc) return;
						const normalized = normalizeProviderInput(provider);
						if (!normalized || normalized === "auto" || Array.isArray(normalized)) return;
						pc.defaultProvider = normalized;
						pc.searchProvider = normalized;
						try {
							saveConfig({ provider: normalized });
						} catch (err) {
							const message = err instanceof Error ? err.message : String(err);
							console.error(`Failed to persist default provider: ${message}`);
						}
					},
					async onAddSearch(query, provider) {
						return runWithProxy(pc.proxy, async () => {
							if (pendingCurates.get(callId) !== pc) throw new Error("Curator session is no longer active.");
							const requestedProvider = resolveCuratorSearchProvider(provider, pc.searchProvider);
							const response = await search(query, {
								provider: requestedProvider,
								numResults: pc.numResults,
								recencyFilter: pc.recencyFilter,
								domainFilter: pc.domainFilter,
								includeContent: pc.includeContent,
								signal: addSearchSignal,
								extensionContext: ctx,
							});
							if (pendingCurates.get(callId) !== pc) throw new Error("Curator session is no longer active.");
							if (response.inlineContent) pc.allInlineContent.push(...response.inlineContent);
							return toCuratorSearchEntries(response);
						});
					},
					onAddSearchResults(entries) {
						if (pendingCurates.get(callId) !== pc) return;
						for (const entry of entries) {
							pc.searchResults.set(entry.queryIndex, indexedCuratorEntryToQueryResult(entry));
						}
					},
					async onRewriteQuery(query, rewriteSignal) {
						return runWithProxy(pc.proxy, async () => {
							if (pendingCurates.get(callId) !== pc) throw new Error("Curator session is no longer active.");
							return rewriteSearchQuery(query, pc.summaryContext, rewriteSignal);
						});
					},
				},
			);

			if (pendingCurates.get(callId) !== pc) {
				handle.close();
				return;
			}

			activeCurators.set(callId, handle);
			pc.curatorUrl = handle.url;

			for (const [qi, data] of pc.searchResults) {
				const slotIndex = pc.resultSlots.get(qi);
				if (data.error) {
					handle.pushError(qi, data.error, data.provider, { query: data.query, slotIndex });
				} else {
					handle.pushResult(qi, {
						answer: data.answer,
						results: data.results.map(r => ({ ...r, domain: extractDomain(r.url) })),
						provider: data.provider || pc.defaultProvider,
						query: data.query,
						slotIndex,
					});
				}
			}
			if (searchesComplete) handle.searchesDone();

			pc.onUpdate?.({
				content: [{ type: "text", text: searchesComplete ? "Waiting for summary approval in browser..." : "Searches streaming to browser..." }],
				details: {
					phase: "curating",
					progress: searchesComplete ? 1 : 0.5,
					curatorUrl: handle.url,
					timeoutSeconds: pc.timeoutSeconds,
					shortcut: curateKey,
				},
			});

			if (!shouldAutoOpenCuratorBrowser(loadConfig())) {
				sendCuratorFallbackUpdate("Search curator is running. Open the curator URL manually.");
				return;
			}

			const open = platform() === "darwin" ? await getGlimpseOpen() : null;
			if (open) {
				try {
					const win = openInGlimpse(open, handle.url, "Search Curator");
					glimpseWins.set(callId, win);
					win.on("closed", () => {
						if (glimpseWins.get(callId) === win) {
							glimpseWins.delete(callId);
							closeCurator(callId);
						}
					});
					return;
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					console.error(`Failed to open Glimpse curator window: ${message}`);
					glimpseWins.delete(callId);
				}
			}
			await openInBrowser(pi, handle.url);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error(`Failed to open curator UI: ${message}`);
			if (handle && activeCurators.get(callId) === handle && pendingCurates.get(callId) === pc) {
				pc.browserOpenError = message;
				sendCuratorFallbackUpdate("Search curator is running, but the browser did not open automatically.");
			} else if (pendingCurates.get(callId) === pc || (handle && activeCurators.get(callId) === handle)) {
				closeCurator(callId);
			}
		}
	}

	pi.registerShortcut(curateKey, {
		description: "Review search results",
		handler: async (ctx) => {
			const entries = [...pendingCurates.entries()];
			if (entries.length === 0) return;
			const [callId, pc] = entries[entries.length - 1];

			if (pc.phase === "searching") {
				pc.browserPromise = openCuratorBrowser(callId, pc, ctx, false);
				ctx.ui.notify("Opening curator — remaining searches will stream in", "info");
				return;
			}
		},
	});

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
		closeCurator();
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
			"Search the web through the configured default route. Supports single or multiple queries, result limits, recency and domain filters, optional background page retrieval, and the configured automatic summary workflow.",
		promptSnippet:
			"Search the web through the configured default route; use 2-4 varied queries when broader research is needed.",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Single search query. For research tasks, prefer 'queries' with multiple varied angles instead." })),
			queries: Type.Optional(Type.Array(Type.String(), { description: "Multiple queries searched in sequence, each returning its own synthesized answer. Prefer this for research — vary phrasing, scope, and angle across 2-4 queries to maximize coverage. Good: ['React vs Vue performance benchmarks 2026', 'React vs Vue developer experience comparison', 'React ecosystem size vs Vue ecosystem']. Bad: ['React vs Vue', 'React vs Vue comparison', 'React vs Vue review'] (too similar, redundant results)." })),
			numResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Results per query (default: 5, max: 20)" })),
			includeContent: Type.Optional(Type.Boolean({ description: "Fetch full page content (async)" })),
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
			const legacyParams = params as typeof params & { provider?: unknown; workflow?: unknown };
			return runWithProxy(typeof params.proxy === "string" ? params.proxy : undefined, async () => {
				const rawQueryList: unknown[] = Array.isArray(params.queries)
					? params.queries
					: (params.query !== undefined ? [params.query] : []);
				const queryList = normalizeQueryList(rawQueryList);
				const configWorkflow = loadConfigForExtensionInit().workflow;
				const workflow = resolveWorkflow(legacyParams.workflow ?? configWorkflow, ctx?.hasUI !== false);
				const shouldCurate = workflow === "summary-review";
				const recencyFilter = normalizeRecencyFilter(params.recencyFilter);

				if (queryList.length === 0) {
					return {
						content: [{ type: "text", text: "Error: No query provided. Use 'query' or 'queries' parameter." }],
						details: { error: "No query provided" },
					};
				}

				if (shouldCurate && !ctx) {
					return {
						content: [{ type: "text", text: "Error: Curation requires an active extension context." }],
						details: { error: "Missing extension context" },
					};
				}

				if (shouldCurate) {
				closeCurator(callId);

				let resolvePromise: (value: AgentToolResult<Record<string, unknown>>) => void = () => {};
				const promise = new Promise<AgentToolResult<Record<string, unknown>>>((resolve) => {
					resolvePromise = resolve;
				});
				const includeContent = params.includeContent ?? false;
				const searchResults = new Map<number, QueryResultData>();
				const resultSlots = new Map<number, number>();
				const allInlineContent: ExtractedContent[] = [];
				let nextResultIndex = queryList.length;
				const searchAbort = new AbortController();
				const searchSignal = signal
					? AbortSignal.any([signal, searchAbort.signal])
					: searchAbort.signal;
				let cancelled = false;

				const requestedProvider = resolveRequestedProvider(legacyParams.provider);
				const bootstrap = await loadCuratorBootstrap(requestedProvider, ctx, {
					numResults: params.numResults,
					recencyFilter,
				});
				const availableProviders = bootstrap.availableProviders;
				const defaultProvider = bootstrap.defaultProvider;
				const searchProvider = requestedProvider;
				const curatorTimeoutSeconds = bootstrap.timeoutSeconds;
				const curatorWorkflow: CuratorWorkflow = "summary-review";

				const summaryContext: SummaryGenerationContext = {
					model: ctx.model,
					modelRegistry: ctx.modelRegistry,
					cwd: ctx.cwd,
					isProjectTrusted: () => ctx.isProjectTrusted(),
				};
				const summaryModelChoices = await loadSummaryModelChoices(summaryContext);

				const pc: PendingCurate = {
					phase: "searching",
					workflow: curatorWorkflow,
					summaryContext,
					searchResults,
					resultSlots,
					allInlineContent,
					queryList,
					includeContent,
					numResults: params.numResults,
					recencyFilter,
					domainFilter: params.domainFilter,
					availableProviders,
					defaultProvider,
					searchProvider,
					summaryModels: summaryModelChoices.summaryModels,
					defaultSummaryModel: summaryModelChoices.defaultSummaryModel,
					timeoutSeconds: curatorTimeoutSeconds,
					proxy: typeof params.proxy === "string" ? params.proxy : undefined,
					onUpdate: onUpdate as PendingCurate["onUpdate"],
					signal,
					abortSearches: () => {
						if (!searchAbort.signal.aborted) searchAbort.abort();
					},
					finish: () => {},
					cancel: () => {},
				};

				const finish = (value: AgentToolResult<Record<string, unknown>>) => {
					if (cancelled) return;
					cancelled = true;
					pc.abortSearches();
					signal?.removeEventListener("abort", onAbort);
					pendingCurates.delete(callId);
					resolvePromise(value);
				};

				const cancel = (reason: "user" | "stale" = "stale") => {
					if (cancelled) return;
					const conn = activeCurators.get(callId)?.getConnectionState();
					finish(buildCurationCancelledReturn(reason, {
						queries: Array.from(searchResults.values()),
						queryCount: queryList.length,
						browserConnected: conn?.browserConnected,
						lastHeartbeatAgeMs: conn?.lastHeartbeatAgeMs,
						curatorUrl: pc.curatorUrl,
						browserOpenError: pc.browserOpenError,
					}));
				};

				pc.finish = finish;
				pc.cancel = cancel;

				const onAbort = () => closeCurator(callId);
				pendingCurates.set(callId, pc);
				signal?.addEventListener("abort", onAbort, { once: true });
				pc.browserPromise = openCuratorBrowser(callId, pc, ctx, false);

				for (let qi = 0; qi < queryList.length; qi++) {
					if (signal?.aborted || cancelled || searchAbort.signal.aborted) break;
					onUpdate?.({
						content: [{ type: "text", text: `Searching ${qi + 1}/${queryList.length}: "${queryList[qi]}"...` }],
						details: { phase: "searching", progress: qi / queryList.length, currentQuery: queryList[qi] },
					});
					const requestedProvider = pc.searchProvider;
					try {
						const response = await search(queryList[qi], {
							provider: requestedProvider,
							numResults: params.numResults,
							recencyFilter,
							domainFilter: params.domainFilter,
							includeContent: params.includeContent,
							signal: searchSignal,
							extensionContext: ctx,
						});
						if (signal?.aborted || cancelled || searchAbort.signal.aborted) break;
						if (response.inlineContent) allInlineContent.push(...response.inlineContent);
						const entries = toCuratorSearchEntries(response);
						const curator = activeCurators.get(callId);
						for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
							const entry = entries[entryIndex];
							const resultIndex = entryIndex === 0 ? qi : nextResultIndex++;
							const indexedEntry: IndexedCuratorSearchEntry = {
								...entry,
								queryIndex: resultIndex,
								query: queryList[qi],
							};
							searchResults.set(resultIndex, indexedCuratorEntryToQueryResult(indexedEntry));
							resultSlots.set(resultIndex, qi);
							if (curator) {
								if (entry.error) {
									curator.pushError(resultIndex, entry.error, entry.provider, { query: queryList[qi], slotIndex: qi });
								} else {
									curator.pushResult(resultIndex, { ...entry, query: queryList[qi], slotIndex: qi });
								}
							}
						}
					} catch (err) {
						if (signal?.aborted || cancelled || searchAbort.signal.aborted) break;
						const message = err instanceof Error ? err.message : String(err);
						const failedProvider = toCuratorProvider(requestedProvider);
						searchResults.set(qi, { query: queryList[qi], answer: "", results: [], error: message, provider: failedProvider });
						resultSlots.set(qi, qi);
						const curator = activeCurators.get(callId);
						if (curator) {
							curator.pushError(qi, message, failedProvider, { query: queryList[qi], slotIndex: qi });
						}
					}
				}

				if (signal?.aborted || cancelled || searchAbort.signal.aborted) {
					cancel();
					return promise;
				}

				await pc.browserPromise;
				const curator = activeCurators.get(callId);
				if (curator && !cancelled) {
					curator.searchesDone();
					if (pc.browserOpenError) {
						pc.onUpdate?.({
							content: [{ type: "text", text: `All searches complete. Open the curator manually: ${pc.curatorUrl}` }],
							details: {
								phase: "curator-fallback",
								progress: 1,
								curatorUrl: pc.curatorUrl,
								timeoutSeconds: pc.timeoutSeconds,
								shortcut: curateKey,
								browserOpenError: pc.browserOpenError,
							},
						});
					} else {
						pc.onUpdate?.({
							content: [{ type: "text", text: "All searches complete — waiting for summary approval in browser..." }],
							details: {
								phase: "curating",
								progress: 1,
								curatorUrl: pc.curatorUrl,
								timeoutSeconds: pc.timeoutSeconds,
								shortcut: curateKey,
							},
						});
					}
				}

				return promise;
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
						includeContent: params.includeContent,
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
					const requestedProvider = toCuratorProvider(resolvedProvider);
					searchResults.push({ query, answer: "", results: [], error: message, provider: requestedProvider });
				}
			}

			let approvedSummary: string | undefined;
			let summaryMeta: SummaryMeta | undefined;
			if (workflow === "auto-summary") {
				if (!ctx) {
					return {
						content: [{ type: "text", text: "Error: Auto-summary requires an active extension context." }],
						details: { error: "Missing extension context" },
					};
				}
				onUpdate?.({
					content: [{ type: "text", text: "Generating summary..." }],
					details: { phase: "generating-summary", progress: 1 },
				});
				const summaryContext: SummaryGenerationContext = {
					model: ctx.model,
					modelRegistry: ctx.modelRegistry,
					cwd: ctx.cwd,
					isProjectTrusted: () => ctx.isProjectTrusted(),
				};
				const summaryModelChoices = await loadSummaryModelChoices(summaryContext);
				const generated = await generateSummaryDraft(
					searchResults,
					summaryContext,
					signal,
					summaryModelChoices.defaultSummaryModel ?? undefined,
					undefined,
					undefined,
					getSummaryGenerationDeadlineMs(),
				);
				approvedSummary = generated.summary;
				summaryMeta = generated.meta;
			}

			return buildSearchReturn({
				queryList,
				results: searchResults,
				urls: allUrls,
				includeContent: params.includeContent ?? false,
				inlineContent: allInlineContent.length > 0 ? allInlineContent : undefined,
				workflow: workflow === "auto-summary" ? "auto-summary" : undefined,
				approvedSummary,
				summaryMeta,
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
			type QueryDetail = {
				query: string;
				provider: string | null;
				answer: string | null;
				sources: Array<{ title: string; url: string }>;
				error: string | null;
			};
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
				curated?: boolean;
				curatedFrom?: number;
				curatedQueries?: QueryDetail[];
				cancelled?: boolean;
				cancelReason?: string;
				browserConnected?: boolean;
				lastHeartbeatAgeMs?: number | null;
				cancelledQueries?: import("./render-search-error.ts").CancelledQueryDetail[];
				curatorUrl?: string;
				browserOpenError?: string;
				timeoutSeconds?: number;
				shortcut?: string;
				summary?: {
					text: string;
					workflow: SummaryWorkflow;
					model: string | null;
					durationMs: number;
					tokenEstimate: number;
					fallbackUsed: boolean;
					fallbackReason?: string;
					phase?: "summary-model" | "deterministic-fallback";
					edited?: boolean;
				};
			};

			if (isPartial) {
				if (details?.phase === "curator-fallback") {
					const lines = [theme.fg("warning", "Open the search curator manually:")];
					if (details?.curatorUrl) lines.push(theme.fg("muted", `  ${details.curatorUrl}`));
					if (details?.browserOpenError) lines.push(theme.fg("dim", `  auto-open failed: ${details.browserOpenError}`));
					const timeout = typeof details?.timeoutSeconds === "number" ? details.timeoutSeconds : undefined;
					const shortcut = typeof details?.shortcut === "string" ? details.shortcut : curateKey;
					lines.push(theme.fg("dim", timeout ? `  auto-submits after ${timeout}s idle; ${shortcut} reopens` : `  ${shortcut} reopens`));
					return new Text(lines.join("\n"), 0, 0);
				}
				if (details?.phase === "curating" || details?.phase === "waiting-for-approval" || details?.phase === "generating-summary") {
					const phaseText = details?.phase === "generating-summary"
						? "generating summary draft..."
						: details?.phase === "waiting-for-approval"
							? "summary draft ready; approve in browser..."
							: "waiting for summary approval in browser...";
					const lines = [theme.fg("accent", phaseText)];
					if (details?.curatorUrl) {
						lines.push(theme.fg("muted", `  ${details.curatorUrl}`));
					}
					const timeout = typeof details?.timeoutSeconds === "number" ? details.timeoutSeconds : undefined;
					const shortcut = typeof details?.shortcut === "string" ? details.shortcut : curateKey;
					if (timeout) {
						lines.push(theme.fg("dim", `  auto-submits after ${timeout}s idle; ${shortcut} reopens`));
					} else {
						lines.push(theme.fg("dim", `  ${shortcut} reopens`));
					}
					return new Text(lines.join("\n"), 0, 0);
				}
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
			if (details?.curated && details?.curatedFrom) {
				statusLine += theme.fg("muted", ` (${details.queryCount}/${details.curatedFrom} queries curated)`);
			}
			if (details?.fetchId && details?.fetchUrls) {
				statusLine += theme.fg("muted", ` (fetching ${details.fetchUrls.length} URLs)`);
			} else if (details?.fetchId) {
				statusLine += theme.fg("muted", " (content ready)");
			}

			// Build expanded lines first so collapsed view can reference total count
			const lines = [statusLine];
			if (details?.summary?.text) {
				lines.push("");
				lines.push(theme.fg("accent", `── Summary (${details.summary.workflow}) ` + "─".repeat(32)));
				lines.push("");
				for (const line of details.summary.text.split("\n")) {
					lines.push(`  ${line}`);
				}
				lines.push("");
				const metaParts = [
					details.summary.model ? `model=${details.summary.model}` : "model=deterministic",
					`duration=${details.summary.durationMs}ms`,
					`tokens~${details.summary.tokenEstimate}`,
					details.summary.fallbackUsed ? "fallback=true" : "fallback=false",
					details.summary.phase ? `phase=${details.summary.phase}` : "",
					details.summary.edited ? "edited=true" : "edited=false",
				];
				if (details.summary.fallbackReason) {
					metaParts.push(`reason=${details.summary.fallbackReason}`);
				}
				lines.push(theme.fg("dim", "  " + metaParts.filter(Boolean).join(" · ")));
			}

			const queryDetails = details?.curatedQueries;
			if (queryDetails?.length) {
				const kept = queryDetails.length;
				const from = details?.curatedFrom ?? kept;
				lines.push("");
				lines.push(theme.fg("accent", `\u2500\u2500 Curated Results (${kept} of ${from} queries kept) ` + "\u2500".repeat(24)));

				for (const cq of queryDetails) {
					lines.push("");
					const dq = cq.query.length > 65 ? cq.query.slice(0, 62) + "..." : cq.query;
					const providerLabel = cq.provider ? ` (${cq.provider})` : "";
					lines.push(theme.fg("accent", `  "${dq}"${providerLabel}`));

					if (cq.error) {
						lines.push(theme.fg("error", `  ${cq.error}`));
					} else if (cq.answer) {
						lines.push("");
						for (const line of cq.answer.split("\n")) {
							lines.push(`  ${line}`);
						}
					}

					if (cq.sources.length > 0) {
						lines.push("");
						for (const s of cq.sources) {
							const domain = s.url.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
							const title = s.title.length > 50 ? s.title.slice(0, 47) + "..." : s.title;
							lines.push(theme.fg("muted", `  \u25b8 ${title}`) + theme.fg("dim", ` \u00b7 ${domain}`));
						}
					}
				}
				lines.push("");
			} else {
				const textContent = result.content.find((c) => c.type === "text")?.text || "";
				const preview = textContent.length > 500 ? textContent.slice(0, 500) + "..." : textContent;
				for (const line of preview.split("\n")) {
					lines.push(theme.fg("dim", line));
				}
			}

			if (details?.fetchUrls && details.fetchUrls.length > 0) {
				if (details.curated) {
					lines.push(theme.fg("muted", `Fetching ${details.fetchUrls.length} URLs in background`));
				} else {
					lines.push(theme.fg("muted", "Fetching:"));
					for (const u of details.fetchUrls.slice(0, 5)) {
						const display = u.length > 60 ? u.slice(0, 57) + "..." : u;
						lines.push(theme.fg("dim", "  " + display));
					}
					if (details.fetchUrls.length > 5) {
						lines.push(theme.fg("dim", `  ... and ${details.fetchUrls.length - 5} more`));
					}
				}
			}

			const totalLines = lines.length;

			if (!expanded) {
				const box = new Box(1, 0);
				box.addChild(new Text(statusLine, 0, 0));

				let collapsedLines = 1; // statusLine
				const summaryPreview = details?.summary?.text?.trim() || "";
				if (summaryPreview) {
					const preview = summaryPreview.length > 120 ? summaryPreview.slice(0, 117) + "..." : summaryPreview;
					box.addChild(new Text(theme.fg("dim", preview), 0, 0));
					collapsedLines++;
				} else if (details?.curatedQueries?.length) {
					for (const cq of details.curatedQueries.slice(0, 3)) {
						const dq = cq.query.length > 55 ? cq.query.slice(0, 52) + "..." : cq.query;
						const srcCount = cq.sources?.length ?? 0;
						const suffix = cq.error ? theme.fg("error", " (error)") : theme.fg("dim", ` · ${srcCount} sources`);
						box.addChild(new Text(theme.fg("accent", `  "${dq}"`) + suffix, 0, 0));
						collapsedLines++;
					}
					if (details.curatedQueries.length > 3) {
						box.addChild(new Text(theme.fg("dim", `  ... and ${details.curatedQueries.length - 3} more`), 0, 0));
						collapsedLines++;
					}
				} else {
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
		label: "Fetch Content",
		description: `Fetch URL(s) as readable Markdown or exact textual HTTP bodies. Mode "answer" answers a page-local question using only fetched content. Supports web pages, direct images, GitHub repositories, pull requests, issues, and PDFs. ${fetchContentStorageNote}`,
		promptSnippet:
			"Fetch web pages, direct images, GitHub resources, and PDFs; mode answer handles page-local questions.",
		parameters: Type.Object({
			url: Type.Optional(Type.String({ description: "Single URL to fetch" })),
			urls: Type.Optional(Type.Array(Type.String(), { description: "Multiple URLs (parallel)" })),
			forceClone: Type.Optional(Type.Boolean({
				description: "Force cloning large GitHub repositories that exceed the size threshold",
			})),
			prompt: Type.Optional(Type.String({
				description: "Page-local question required by mode answer.",
			})),
			mode: Type.Optional(StringEnum(["readable", "raw", "answer"], {
				description: "Fetch mode: readable (default extraction), raw (exact textual HTTP body), or answer (answer prompt using only fetched content).",
			})),
			answerModel: Type.Optional(Type.String({
				description: "Optional provider/model-id override for mode answer. Defaults to the current Pi model.",
			})),
			auth: Type.Optional(Type.Union([Type.String(), Type.Boolean()], {
				description: "Opt into an authFetch profile for local browser-cookie fetching. Use a profile name, or true only when exactly one profile exists.",
			})),
			proxy: Type.Optional(Type.String({
				description: "http(s) proxy URL (e.g. http://host:port) used for this fetch. Needed when the target is unreachable directly; localhost and NO_PROXY hosts always bypass the proxy. Empty string forces direct access.",
			})),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<Record<string, unknown>>> {
			let normalized: ReturnType<typeof normalizeFetchContentParams>;
			try {
				normalized = normalizeFetchContentParams(params);
			} catch (err) {
				const error = err instanceof Error ? err.message : String(err);
				return { content: [{ type: "text", text: `Error: ${error}` }], details: { error } };
			}
			const { urlList, options } = normalized;
			return runWithProxy(options.proxy, async () => {
				const mode = options.mode ?? "readable";
				if (mode === "answer" && !options.prompt) {
					return { content: [{ type: "text", text: "Error: mode answer requires prompt." }], details: { error: "mode answer requires prompt" } };
				}
				if (mode === "raw" && (options.forceClone === true || options.prompt || options.answerModel)) {
					return { content: [{ type: "text", text: "Error: mode raw cannot be combined with forceClone, prompt, or answerModel." }], details: { error: "Incompatible raw mode options" } };
				}
				if (mode !== "answer" && options.answerModel) {
					return { content: [{ type: "text", text: "Error: answerModel requires mode answer." }], details: { error: "answerModel requires mode answer" } };
				}
				if (mode === "answer" && options.auth !== undefined) {
					return { content: [{ type: "text", text: "Error: auth cannot be combined with mode answer." }], details: { error: "auth cannot be combined with mode answer" } };
				}
				let authFetchProfile: AuthFetchProfile | undefined;
				if (options.auth !== undefined) {
					try {
						authFetchProfile = resolveAuthFetchProfile(options.auth);
					} catch (err) {
						const error = err instanceof Error ? err.message : String(err);
						return { content: [{ type: "text", text: `Error: ${error}` }], details: { error } };
					}
				}
				if (urlList.length === 0) {
					return {
						content: [{ type: "text", text: "Error: No URL provided." }],
						details: { error: "No URL provided" },
					};
				}

				onUpdate?.({
					content: [{ type: "text", text: `Fetching ${urlList.length} URL(s)...` }],
					details: { phase: "fetch", progress: 0 },
				});

				const { answerModel: _answerModel, auth: _auth, ...extractionOptions } = options;
				const fetchOptions = mode === "answer"
					? (() => {
						const { prompt: _prompt, ...rest } = extractionOptions;
						return { ...rest, ...(authFetchProfile ? { authFetchProfile } : {}) };
					})()
					: { ...extractionOptions, ...(authFetchProfile ? { authFetchProfile } : {}) };
				const fetchResults = await fetchAllContent(urlList, signal, withRegisteredFetchOptions(fetchOptions, registeredToolNames, options.proxy));
				const presentedResults = mode === "answer"
					? await Promise.all(fetchResults.map(async result => {
						if (result.error) return result;
						if (result.thumbnail || result.mimeType?.startsWith("image/")) {
							return { ...result, error: "Page answer requires textual fetched content" };
						}
						try {
							const answer = await answerFromPage({
								question: options.prompt!,
								pageText: result.content,
								sourceUrl: result.url,
								...(options.answerModel ? { model: options.answerModel } : {}),
							}, ctx, signal);
							return { ...result, content: answer.text };
						} catch (err) {
							return { ...result, error: `Page answer failed: ${err instanceof Error ? err.message : String(err)}` };
						}
					}))
					: fetchResults;
				const successful = presentedResults.filter((r) => !r.error).length;
				const totalChars = presentedResults.reduce((sum, r) => sum + r.content.length, 0);

				const responseId = generateId();
				const data = {
					id: responseId,
					type: "fetch",
					timestamp: Date.now(),
					urls: stripThumbnails(fetchResults),
				} satisfies StoredSearchData & { type: "fetch"; urls: ExtractedContent[] };
				const storedContent = storeFetchResult(pi, responseId, data, authFetchProfile);

				if (urlList.length === 1) {
					const result = presentedResults[0];
					if (result.error) {
						return {
							content: [{ type: "text", text: `Error: ${result.error}` }],
							details: { urls: urlList, urlCount: 1, successful: 0, error: result.error, ...(storedContent ? { responseId } : {}), prompt: params.prompt },
						};
					}

					const fullLength = result.content.length;
					const slice = initialContentSlice(result.content, getMaxInlineContentChars());
					const truncated = slice.endOffset < fullLength;
					let output = slice.text;

					if (truncated) {
						output += `\n\n---\nShowing ${slice.endOffset} of ${fullLength} chars, ${slice.shownBytes} of ${slice.totalBytes} bytes, and ${slice.shownLines} of ${slice.totalLines} lines. `;
						output += storedContent
							? getSearchContentEnabled
								? `Use ${toolNames.getSearchContent}({ responseId: "${responseId}", urlIndex: 0, offset: ${slice.endOffset} }) for the next slice.`
								: "Content retrieval is not registered."
							: "Authenticated fetch cache is off; repeat the fetch to read more.";
					}

					const content: Array<TextContent | ImageContent> = [];
					if (result.frames?.length) {
						for (const frame of result.frames) {
							content.push({ type: "image", data: frame.data, mimeType: frame.mimeType });
							content.push({ type: "text", text: `Frame at ${frame.timestamp}` });
						}
					} else if (result.thumbnail) {
						content.push({ type: "image", data: result.thumbnail.data, mimeType: result.thumbnail.mimeType });
					}
					content.push({ type: "text", text: output });

					const imageCount = (result.frames?.length ?? 0) + (result.thumbnail ? 1 : 0);
					return {
						content,
						details: {
							urls: urlList,
							urlCount: 1,
							successful: 1,
							totalChars: fullLength,
							title: result.title,
							...(storedContent ? { responseId } : {}),
							truncated,
							hasImage: imageCount > 0,
							imageCount,
							prompt: params.prompt,
							duration: result.duration,
							mode,
							mimeType: result.mimeType,
							status: result.status,
							totalBytes: slice.totalBytes,
							totalLines: slice.totalLines,
							shownBytes: slice.shownBytes,
							shownLines: slice.shownLines,
						},
					};
				}

				let output = "## Fetched URLs\n\n";
				for (const { url, title, content, error } of presentedResults) {
					if (error) {
						output += `- ${url}: Error - ${error}\n`;
					} else {
						output += `- ${title || url} (${content.length} chars)\n`;
					}
				}
				output += storedContent
					? getSearchContentEnabled
						? `\n---\nUse ${toolNames.getSearchContent}({ responseId: "${responseId}", urlIndex: 0 }) to retrieve bounded content slices.`
						: "\n---\nContent retrieval is not registered."
					: "\n---\nAuthenticated fetch cache is off; repeat the fetch to read content.";

				return {
					content: [{ type: "text", text: output }],
					details: { urls: urlList, urlCount: urlList.length, successful, totalChars, ...(storedContent ? { responseId } : {}) },
				};
			});
		},

		renderCall(args, theme) {
			const { urlList, options } = normalizeFetchContentParams(args);
			const { prompt, mode, answerModel, auth } = options;
			if (urlList.length === 0) {
				return new Text(theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("error", "(no URL)"), 0, 0);
			}
			const lines: string[] = [];
			if (urlList.length === 1) {
				const display = urlList[0].length > 60 ? urlList[0].slice(0, 57) + "..." : urlList[0];
				lines.push(theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("accent", display));
			} else {
				lines.push(theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("accent", `${urlList.length} URLs`));
				for (const u of urlList.slice(0, 5)) {
					const display = u.length > 60 ? u.slice(0, 57) + "..." : u;
					lines.push(theme.fg("muted", "  " + display));
				}
				if (urlList.length > 5) {
					lines.push(theme.fg("muted", `  ... and ${urlList.length - 5} more`));
				}
			}
			if (mode && mode !== "readable") {
				lines.push(theme.fg("dim", "  mode: ") + theme.fg("warning", mode));
			}
			if (prompt) {
				const display = prompt.length > 250 ? prompt.slice(0, 247) + "..." : prompt;
				lines.push(theme.fg("dim", "  prompt: ") + theme.fg("muted", `"${display}"`));
			}
			if (answerModel) {
				lines.push(theme.fg("dim", "  answer model: ") + theme.fg("warning", answerModel));
			}
			if (auth !== undefined) {
				lines.push(theme.fg("dim", "  auth: ") + theme.fg("warning", auth === true ? "true" : auth));
			}
			return new Text(lines.join("\n"), 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as {
				urlCount?: number;
				successful?: number;
				totalChars?: number;
				error?: string;
				title?: string;
				truncated?: boolean;
				responseId?: string;
				phase?: string;
				progress?: number;
				hasImage?: boolean;
				imageCount?: number;
				prompt?: string;
				duration?: number;
			};

			if (isPartial) {
				const progress = details?.progress ?? 0;
				const bar = "\u2588".repeat(Math.floor(progress * 10)) + "\u2591".repeat(10 - Math.floor(progress * 10));
				return new Text(theme.fg("accent", `[${bar}] ${details?.phase || "fetching"}`), 0, 0);
			}

			if (details?.error) {
				const fd = details as typeof details & { urls?: string[] };
				const extras: string[] = [];
				if (typeof fd.urlCount === "number" || typeof fd.successful === "number") {
					extras.push(`urls: ${fd.successful ?? 0}/${fd.urlCount ?? 0} succeeded`);
				}
				if (fd.responseId) extras.push(`response id: ${fd.responseId}`);
				if (fd.urls && fd.urls.length > 0) {
					for (const u of fd.urls.slice(0, 8)) extras.push(`  \u25b8 ${u}`);
					if (fd.urls.length > 8) extras.push(`  ... and ${fd.urls.length - 8} more`);
				}
				const plan = buildSearchErrorPlan({ error: details.error, extraLines: extras });
				if (plan) return renderSearchErrorPlan(plan, expanded, theme);
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			if (details?.urlCount === 1) {
				const title = details?.title || "Untitled";
				const imgCount = details?.imageCount ?? (details?.hasImage ? 1 : 0);
				const imageBadge = imgCount > 1
					? theme.fg("accent", ` [${imgCount} images]`)
					: imgCount === 1
						? theme.fg("accent", " [image]")
						: "";
				let statusLine = theme.fg("success", title) + theme.fg("muted", ` (${details?.totalChars ?? 0} chars)`) + imageBadge;
				if (details?.truncated) {
					statusLine += theme.fg("warning", " [truncated]");
				}
				if (typeof details?.duration === "number") {
					statusLine += theme.fg("muted", ` | ${formatSeconds(Math.floor(details.duration))} total`);
				}
				const textContent = result.content.find((c) => c.type === "text")?.text || "";
				if (!expanded) {
					const brief = textContent.length > 200 ? textContent.slice(0, 200) + "..." : textContent;
					return new Text(statusLine + "\n" + theme.fg("dim", brief), 0, 0);
				}
				const lines = [statusLine];
				if (details?.prompt) {
					const display = details.prompt.length > 250 ? details.prompt.slice(0, 247) + "..." : details.prompt;
					lines.push(theme.fg("dim", `  prompt: "${display}"`));
				}
				const preview = textContent.length > 500 ? textContent.slice(0, 500) + "..." : textContent;
				lines.push(theme.fg("dim", preview));
				return new Text(lines.join("\n"), 0, 0);
			}

			const countColor = (details?.successful ?? 0) > 0 ? "success" : "error";
			const statusLine = theme.fg(countColor, `${details?.successful}/${details?.urlCount} URLs`) + theme.fg("muted", getSearchContentEnabled ? " (content stored)" : " (content fetched)");
			if (!expanded) {
				return new Text(statusLine, 0, 0);
			}
			const textContent = result.content.find((c) => c.type === "text")?.text || "";
			const preview = textContent.length > 500 ? textContent.slice(0, 500) + "..." : textContent;
			return new Text(statusLine + "\n" + theme.fg("dim", preview), 0, 0);
		},
	});

	if (getSearchContentEnabled) {
		const maxInlineContentChars = getMaxInlineContentChars(initConfig);
		pi.registerTool({
		name: toolNames.getSearchContent,
		label: "Get Search Content",
		description: `Retrieve bounded content slices or find matching passages in a previous ${storedContentSources} call.`,
		promptSnippet:
			`Use after ${storedContentSources} to retrieve stored content via responseId. Use findText to locate passages without paging through the full content.`,
		parameters: Type.Object({
			responseId: Type.String({ description: `The responseId from ${storedContentSources}` }),
			query: Type.Optional(Type.String({ description: searchQueryDescription })),
			queryIndex: Type.Optional(Type.Integer({ minimum: 0, description: "Get content for query at index" })),
			url: Type.Optional(Type.String({ description: "Get content for this URL" })),
			urlIndex: Type.Optional(Type.Integer({ minimum: 0, description: "Get content for URL at index" })),
			offset: Type.Optional(Type.Integer({ minimum: 0, description: "Character offset for fetched URL content slices (default 0). Ignored when findText is supplied." })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: maxInlineContentChars, description: "Maximum characters to return for fetched URL content slices (default and max are set by maxInlineContentChars). Ignored when findText is supplied." })),
			findText: Type.Optional(Type.Union([
				Type.String({ minLength: 1, maxLength: 500 }),
				Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 1, maxItems: 10 }),
			], { description: "Text or texts to find in the selected stored content. When supplied, offset and limit are ignored." })),
			findMode: Type.Optional(StringEnum(["exact", "case-insensitive", "fuzzy"], { description: "Matching mode for findText (default: case-insensitive). Requires findText." })),
		}),

		async execute(_toolCallId, rawParams): Promise<AgentToolResult<Record<string, unknown>>> {
			const params = normalizeGetSearchContentParams(rawParams);
			if (params.findMode !== undefined && params.findText === undefined) {
				return {
					content: [{ type: "text", text: `findMode ${formatInputValue(params.findMode)} requires findText; provide findText or omit findMode.` }],
					details: { error: "findMode requires findText" },
				};
			}
			const data = getResult(params.responseId);
			if (!data) {
				return {
					content: [{ type: "text", text: `Error: No stored results for responseId ${formatInputValue(params.responseId)}. Use a responseId returned by ${storedContentSources}.` }],
					details: { error: "Not found", responseId: params.responseId },
				};
			}

			if (data.type === "search" && data.queries) {
				let queryData: QueryResultData | undefined;

				if (params.query !== undefined) {
					queryData = data.queries.find((q) => q.query === params.query);
					if (!queryData) {
						const available = data.queries.map((q) => `"${q.query}"`).join(", ");
						return {
							content: [{ type: "text", text: `Query ${formatInputValue(params.query)} was not found for responseId ${formatInputValue(params.responseId)}. Received query=${formatInputValue(params.query)}. Available queries: ${available || "none"}. Use one of the available queries or queryIndex.` }],
							details: { error: "Query not found" },
						};
					}
				} else if (params.queryIndex !== undefined) {
					queryData = data.queries[params.queryIndex];
					if (!queryData) {
						const available = data.queries.map((q, i) => `${i}: "${q.query}"`).join(", ");
						return {
							content: [{ type: "text", text: `Query index ${formatInputValue(params.queryIndex)} is out of range for responseId ${formatInputValue(params.responseId)}. Received queryIndex=${formatInputValue(params.queryIndex)}; valid indexes are 0-${data.queries.length - 1}. Available queries: ${available || "none"}. Use one of the available indexes.` }],
							details: { error: "Index out of range" },
						};
					}
				} else {
					const available = data.queries.map((q, i) => `${i}: "${q.query}"`).join(", ");
					return {
						content: [{ type: "text", text: `Specify query or queryIndex for responseId ${formatInputValue(params.responseId)}. Available queries: ${available || "none"}.` }],
						details: { error: "No query specified" },
					};
				}

				if (queryData.error) {
					return {
						content: [{ type: "text", text: `Error retrieving query ${formatInputValue(queryData.query)} from responseId ${formatInputValue(params.responseId)}: ${queryData.error}. Check the stored search result and retry with another query or queryIndex if needed.` }],
						details: { error: queryData.error, query: queryData.query },
					};
				}

				const fullResults = formatFullResults(queryData);
				if (params.findText !== undefined) {
					try {
						const found = findContent(fullResults, normalizeFindQueries(params.findText), params.findMode ?? "case-insensitive");
						const { text, ...findDetails } = found;
						return {
							content: [{ type: "text", text }],
							details: { query: queryData.query, resultCount: queryData.results.length, findMode: params.findMode ?? "case-insensitive", ...findDetails },
						};
					} catch (err) {
						const error = err instanceof Error ? err.message : String(err);
						return {
							content: [{ type: "text", text: `Unable to find ${formatInputValue(params.findText)} in query ${formatInputValue(queryData.query)} for responseId ${formatInputValue(params.responseId)}: ${error}. Check findText and use a supported findMode.` }],
							details: { error, query: queryData.query },
						};
					}
				}

				return {
					content: [{ type: "text", text: fullResults }],
					details: { query: queryData.query, resultCount: queryData.results.length },
				};
			}

			if (data.type === "fetch" && data.urls) {
				let urlData: ExtractedContent | undefined;
				let selectedUrlIndex = -1;

				if (params.url !== undefined) {
					selectedUrlIndex = data.urls.findIndex((u) => u.url === params.url);
					urlData = data.urls[selectedUrlIndex];
					if (!urlData) {
						const available = data.urls.map((u) => u.url).join("\n  ");
						return {
							content: [{ type: "text", text: `URL ${formatInputValue(params.url)} was not found for responseId ${formatInputValue(params.responseId)}. Received url=${formatInputValue(params.url)}. Available URLs:\n  ${available || "  none"}\nUse one of the available URLs or urlIndex.` }],
							details: { error: "URL not found" },
						};
					}
				} else if (params.urlIndex !== undefined) {
					selectedUrlIndex = params.urlIndex;
					urlData = data.urls[selectedUrlIndex];
					if (!urlData) {
						const available = data.urls.map((u, i) => `${i}: ${u.url}`).join("\n  ");
						return {
							content: [{ type: "text", text: `URL index ${formatInputValue(params.urlIndex)} is out of range for responseId ${formatInputValue(params.responseId)}. Received urlIndex=${formatInputValue(params.urlIndex)}; valid indexes are 0-${data.urls.length - 1}. Available URLs:\n  ${available || "  none"}\nUse one of the available indexes.` }],
							details: { error: "Index out of range" },
						};
					}
				} else {
					const available = data.urls.map((u, i) => `${i}: ${u.url}`).join("\n  ");
					return {
						content: [{ type: "text", text: `Specify url or urlIndex for responseId ${formatInputValue(params.responseId)}. Available URLs:\n  ${available || "  none"}` }],
						details: { error: "No URL specified" },
					};
				}

				if (urlData.error) {
					return {
						content: [{ type: "text", text: `Error retrieving URL ${formatInputValue(urlData.url)} from responseId ${formatInputValue(params.responseId)}: ${urlData.error}. Check the stored fetch result and retry with another URL or urlIndex if needed.` }],
						details: { error: urlData.error, url: urlData.url },
					};
				}

				if (params.findText !== undefined) {
					try {
						const found = findContent(urlData.content, normalizeFindQueries(params.findText), params.findMode ?? "case-insensitive");
						const { text, ...findDetails } = found;
						return {
							content: [{ type: "text", text: `# ${urlData.title || urlData.url}\n\n${text}` }],
							details: { url: urlData.url, title: urlData.title, contentLength: urlData.content.length, findMode: params.findMode ?? "case-insensitive", ...findDetails },
						};
					} catch (err) {
						const error = err instanceof Error ? err.message : String(err);
						return {
							content: [{ type: "text", text: `Unable to find ${formatInputValue(params.findText)} in URL ${formatInputValue(urlData.url)} for responseId ${formatInputValue(params.responseId)}: ${error}. Check findText and use a supported findMode.` }],
							details: { error, url: urlData.url },
						};
					}
				}

				const offset = params.offset ?? 0;
				const limit = params.limit ?? maxInlineContentChars;
				if (!Number.isInteger(offset) || offset < 0) {
					return {
						content: [{ type: "text", text: `Invalid offset: received ${formatInputValue(offset)} for URL ${formatInputValue(urlData.url)}; offset must be a non-negative integer. Use 0 or a larger integer.` }],
						details: { error: "Invalid offset", offset },
					};
				}
				if (!Number.isInteger(limit) || limit <= 0 || limit > maxInlineContentChars) {
					return {
						content: [{ type: "text", text: `Invalid limit: received ${formatInputValue(limit)} for URL ${formatInputValue(urlData.url)}; limit must be an integer from 1 to ${maxInlineContentChars}. Use a value in that range.` }],
						details: { error: "Invalid limit", limit, maxLimit: maxInlineContentChars },
					};
				}
				if (offset > urlData.content.length) {
					return {
						content: [{ type: "text", text: `Offset ${offset} is out of range for URL ${formatInputValue(urlData.url)} in responseId ${formatInputValue(params.responseId)}. Received offset ${offset}; valid range is 0-${urlData.content.length}. Use an offset within that range.` }],
						details: { error: "Offset out of range", offset, contentLength: urlData.content.length },
					};
				}

				const endOffset = Math.min(offset + limit, urlData.content.length);
				const contentSlice = urlData.content.slice(offset, endOffset);
				const hasMore = endOffset < urlData.content.length;
				let text = `# ${urlData.title || urlData.url}\n\n${contentSlice}`;
				if (hasMore || offset > 0) {
					text += `\n\n---\nShowing chars ${offset}-${endOffset} of ${urlData.content.length}.`;
					if (hasMore) {
						text += ` Use ${toolNames.getSearchContent}({ responseId: "${params.responseId}", urlIndex: ${selectedUrlIndex}, offset: ${endOffset}, limit: ${limit} }) for the next slice.`;
					}
				}

				return {
					content: [{ type: "text", text }],
					details: {
						url: urlData.url,
						title: urlData.title,
						contentLength: urlData.content.length,
						offset,
						limit,
						returnedChars: contentSlice.length,
						nextOffset: hasMore ? endOffset : null,
						truncated: hasMore,
					},
				};
			}

			return {
				content: [{ type: "text", text: `Invalid stored data for responseId ${formatInputValue(params.responseId)}: received type ${formatInputValue(data.type)}. Use a responseId returned by ${storedContentSources}.` }],
				details: { error: "Invalid data" },
			};
		},

		renderCall(args, theme) {
			const { responseId, query, queryIndex, url, urlIndex, offset, findText } = args as {
				responseId: string;
				query?: string;
				queryIndex?: number;
				url?: string;
				urlIndex?: number;
				offset?: number;
				findText?: string | string[];
			};
			let target = "";
			if (query) target = `query="${query}"`;
			else if (queryIndex !== undefined) target = `queryIndex=${queryIndex}`;
			else if (url) target = url.length > 30 ? url.slice(0, 27) + "..." : url;
			else if (urlIndex !== undefined) target = `urlIndex=${urlIndex}`;
			if (offset !== undefined) target += target ? ` @ ${offset}` : `offset=${offset}`;
			if (findText !== undefined) {
				const queries = Array.isArray(findText) ? findText : [findText];
				target += `${target ? " · " : ""}find ${queries.length}`;
			}
			return new Text(theme.fg("toolTitle", theme.bold("get_content ")) + theme.fg("accent", target || responseId.slice(0, 8)), 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as {
				error?: string;
				query?: string;
				url?: string;
				title?: string;
				resultCount?: number;
				contentLength?: number;
				offset?: number;
				returnedChars?: number;
				nextOffset?: number | null;
				matchCount?: number;
				returnedMatches?: number;
			};

			if (details?.error) {
				const extras: string[] = [];
				if (details.query) extras.push(`query: ${details.query}`);
				if (details.url) extras.push(`url: ${details.url}`);
				else if (details.title) extras.push(`resource: ${details.title}`);
				const plan = buildSearchErrorPlan({ error: details.error, extraLines: extras });
				if (plan) return renderSearchErrorPlan(plan, expanded, theme);
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			let statusLine: string;
			if (typeof details?.matchCount === "number") {
				statusLine = theme.fg("success", details?.title || details?.query || "Content") + theme.fg("muted", ` (${details.matchCount} matches, ${details.returnedMatches ?? 0} shown)`);
			} else if (details?.query) {
				statusLine = theme.fg("success", `"${details.query}"`) + theme.fg("muted", ` (${details.resultCount} results)`);
			} else {
				const start = details?.offset ?? 0;
				const returned = details?.returnedChars ?? details?.contentLength ?? 0;
				const end = start + returned;
				const slice = details?.nextOffset !== undefined || start > 0
					? `, showing ${start}-${end}`
					: "";
				statusLine = theme.fg("success", details?.title || "Content") + theme.fg("muted", ` (${details?.contentLength ?? 0} chars${slice})`);
			}

			if (!expanded) {
				return new Text(statusLine, 0, 0);
			}

			const textContent = result.content.find((c) => c.type === "text")?.text || "";
			const preview = textContent.length > 500 ? textContent.slice(0, 500) + "..." : textContent;
			return new Text(statusLine + "\n" + theme.fg("dim", preview), 0, 0);
		},
	});
	}


	if (isCommandEnabled(initConfig, "curator")) pi.registerCommand("web-search-config", {
		description: "Configure web access: summary mode (cyclic), summary model (searchable), thinking level",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/web-search-config 需要交互式 TUI 模式", "error");
				return;
			}

			// 抽成函数：嵌套 ctx.ui.input（供应商 key 设置）结束后外层面板不会恢复，完成后自动重开
			const openConfigPanel = async (): Promise<void> => {
				const workflowValues: WebSearchWorkflow[] = ["summary-review", "auto-summary", "none"];
				const workflowLabels: Record<string, string> = {
					"summary-review": "总结并打开浏览器",
					"auto-summary": "总结，不打开浏览器",
					"none": "不总结",
				};
				const workflowDescriptions: Record<WebSearchWorkflow, string> = {
					"summary-review": "总结后自动在浏览器展开搜索过程",
					"auto-summary": "仅在会话内总结，不打开浏览器",
					"none": "不总结，原文直接交给模型",
				};
				const thinkingValues = ["默认", "off", "minimal", "low", "medium", "high", "xhigh", "max"];

				const initialConfig = loadConfigForExtensionInit();
				const initialParsed = splitThinkingSuffix(typeof initialConfig.summaryModel === "string" ? initialConfig.summaryModel.trim() : "");
				let currentWorkflow = resolveWorkflow(initialConfig.workflow, true);
				let modelBase = initialParsed.value;
				let thinkingLevel: string | null = initialParsed.thinkingLevel ?? null;

				// 全量模型目录（不按 enabledModels 过滤），子菜单中输入字符实时过滤
				const modelItems: SelectItem[] = ctx.modelRegistry.getAvailable()
					.map((model) => `${model.provider}/${model.id}`)
					.sort()
					.map((value) => ({ value, label: value }));

				// 模型选择子菜单：标题 + 过滤计数 + SelectList
				const buildModelPicker = (tui: { requestRender(): void }, theme: { fg(id: string, text: string): string; bold(text: string): string }, currentBase: string, subDone: (selectedValue?: string) => void) => {
					const items: SelectItem[] = modelItems.map((item) => ({
						value: item.value,
						label: item.value === currentBase ? `${item.value} (当前)` : item.value,
					}));
					let filter = "";
					let selectList = new SelectList(items.slice(), 12, getSelectListTheme());
					let filteredCount = items.length;

					const rebuild = () => {
						const query = filter.toLowerCase();
						let filtered = query
							? items.filter((item) => item.value.toLowerCase().includes(query))
							: [...items];
						// 无过滤时把当前模型置顶，便于快速确认
						if (!query && currentBase) {
							const idx = filtered.findIndex((item) => item.value === currentBase);
							if (idx > 0) filtered = [filtered[idx], ...filtered.slice(0, idx), ...filtered.slice(idx + 1)];
						}
						filteredCount = filtered.length;
						selectList = new SelectList(filtered, 12, getSelectListTheme());
						if (currentBase) {
							const idx = filtered.findIndex((item) => item.value === currentBase);
							if (idx >= 0) selectList.setSelectedIndex(idx);
						}
						selectList.onSelect = (item) => subDone(item.value);
						selectList.onCancel = () => subDone();
					};
					rebuild();

					return {
						render: (width: number) => {
							const lines: string[] = [];
							lines.push(theme.fg("accent", theme.bold("选择总结模型")));
							lines.push(theme.fg("dim", filter ? `过滤 "${filter}" • 命中 ${filteredCount}/${items.length} 个模型` : `共 ${items.length} 个模型（输入字符过滤）`));
							lines.push("");
							if (filteredCount === 0) {
								lines.push(theme.fg("dim", "无匹配模型 — backspace 清除过滤"));
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

				// 与 web_search 自动总结一致的默认模型挑选逻辑
				const autoModel = (await loadSummaryModelChoices({
					model: ctx.model,
					modelRegistry: ctx.modelRegistry,
					cwd: ctx.cwd,
					isProjectTrusted: () => ctx.isProjectTrusted(),
				})).defaultSummaryModel;

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
					currentWorkflow = resolveWorkflow(config.workflow, true);
					const parsed = splitThinkingSuffix(typeof config.summaryModel === "string" ? config.summaryModel.trim() : "");
					modelBase = parsed.value;
					thinkingLevel = parsed.thinkingLevel ?? null;
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

					const modelPickerItem: SettingItem = {
						id: "summary-model",
						label: "总结模型",
						currentValue: modelBase ? `${modelBase}${thinkingLevel ? `:${thinkingLevel}` : ""}` : "自动（不指定）",
						description: "enter 打开全量模型搜索选择（不做 enabledModels 过滤）",
						submenu: (current, subDone) => buildModelPicker(tui, theme, current, subDone),
					};

					// 思考等级说明行：回显实际生效的 provider/model:level（含自动默认模型）
					const thinkingDescription = () => {
						const base = modelBase || autoModel;
						return base
							? `生效: ${base}:${thinkingLevel ?? "默认（不附加等级）"} • 空格或←→切换`
							: "无可用总结模型 — 请先在“总结模型”中指定";
					};

					const providerPickerItem: SettingItem = {
						id: "search-provider",
						label: "搜索供应商",
						currentValue: providerRowLabel(currentProviderSelection),
						description: `${describeProviderSelection(currentProviderSelection)} • enter 打开选择（✓ 已配置 / ✗ 未配置）`,
						submenu: (_current, subDone) => buildProviderPicker(tui, theme, subDone),
					};

					const items: SettingItem[] = [
						{
							id: "summary-mode",
							label: "总结模式",
							currentValue: `${currentWorkflow} (${workflowLabels[currentWorkflow] ?? currentWorkflow})`,
							values: workflowValues.map((wf) => `${wf} (${workflowLabels[wf]})`),
							description: workflowDescriptions[currentWorkflow],
						},
						modelPickerItem,
						{
							id: "summary-thinking",
							label: "思考等级",
							currentValue: thinkingLevel ?? "默认",
							values: thinkingValues,
							description: thinkingDescription(),
						},
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
							if (id === "summary-mode") {
								const wf = newValue.slice(0, newValue.indexOf(" ")) as WebSearchWorkflow;
								if (save({ workflow: wf })) {
									currentWorkflow = wf;
									items[0].description = workflowDescriptions[wf];
								} else {
									items[0].currentValue = `${currentWorkflow} (${workflowLabels[currentWorkflow]})`;
								}
								return;
							}
							if (id === "summary-model") {
								const value = `${newValue}${thinkingLevel ? `:${thinkingLevel}` : ""}`;
								if (save({ summaryModel: value })) {
									modelBase = newValue;
									modelPickerItem.currentValue = value;
									items[2].description = thinkingDescription();
								}
								return;
							}
							if (id === "summary-thinking") {
								const base = modelBase || autoModel;
								if (!base) {
									ctx.ui.notify("没有可用的总结模型，请先在“总结模型”中显式指定", "error");
									items[2].currentValue = thinkingLevel ?? "默认";
									return;
								}
								const level = newValue === "默认" ? null : newValue;
								const value = level ? `${base}:${level}` : base;
								if (save({ summaryModel: value })) {
									modelBase = base;
									thinkingLevel = level;
									modelPickerItem.currentValue = value;
									items[2].description = thinkingDescription();
								} else {
									items[2].currentValue = thinkingLevel ?? "默认";
								}
								return;
							}
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
					container.addChild(new Text(theme.fg("dim", "enter/空格 循环切换 • enter 打开模型/供应商选择 • esc 退出"), 1, 1));
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
