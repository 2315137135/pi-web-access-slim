export interface WebFetchParams {
	url?: unknown;
	as?: unknown;
	refresh?: unknown;
}

export interface NormalizedWebFetchParams {
	url: string | null;
	as: "readable" | "raw";
	refresh: boolean;
}

export function normalizeWebFetchParams(params: WebFetchParams): NormalizedWebFetchParams {
	return {
		url: normalizeSingleUrl(params.url),
		as: normalizeTarget(params.as),
		refresh: params.refresh === true,
	};
}

function normalizeSingleUrl(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed || null;
}

function normalizeTarget(value: unknown): "readable" | "raw" {
	if (value === undefined || value === null) return "readable";
	if (value === "readable" || value === "raw") return value;
	throw new Error('as must be "readable" or "raw"');
}
