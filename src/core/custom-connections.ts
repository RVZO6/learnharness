import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export const CUSTOM_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Discovery can be incomplete. Only complete, explicitly described models can run. */
export interface CustomModelDraft {
	id: string;
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	imageInput?: boolean;
	supportedLevels?: ThinkingLevel[];
}
export interface CustomModel extends CustomModelDraft {
	contextWindow: number;
	maxTokens: number;
	imageInput: boolean;
	supportedLevels: ThinkingLevel[];
}
export interface CustomConnection {
	id: string;
	name: string;
	baseUrl: string;
	apiKey: string;
	models: CustomModel[];
}
export type CustomConnectionInfo = Omit<CustomConnection, "apiKey"> & { keyPresent: boolean };
export function isCustomConnection(id: string): boolean { return /^custom-[a-f0-9-]{36}$/.test(id); }

export function customBaseUrl(value: unknown): string {
	if (typeof value !== "string" || !value.trim()) throw new Error("Base URL is required.");
	let url: URL;
	try { url = new URL(value.trim()); } catch { throw new Error("Enter a valid base URL."); }
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Use an HTTP or HTTPS base URL without credentials, a query, or a fragment.");
	return url.href.replace(/\/+$/, "");
}
export function validateCustomModels(value: unknown): CustomModel[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > 500) throw new Error("Add between 1 and 500 models.");
	const ids = new Set<string>();
	return value.map((raw) => {
		if (!raw || typeof raw !== "object") throw new Error("Invalid model details.");
		const m = raw as CustomModelDraft;
		if (typeof m.id !== "string" || !m.id.trim() || m.id.length > 256 || /[\r\n]/.test(m.id)) throw new Error("Model ID is required.");
		const id = m.id.trim();
		if (ids.has(id)) throw new Error(`Duplicate model ID: ${id}`);
		ids.add(id);
		if (!Number.isSafeInteger(m.contextWindow) || m.contextWindow! <= 0 || !Number.isSafeInteger(m.maxTokens) || m.maxTokens! <= 0 || m.maxTokens! > m.contextWindow!) throw new Error(`${id}: enter valid context and output limits.`);
		if (typeof m.imageInput !== "boolean") throw new Error(`${id}: specify image support.`);
		if (!Array.isArray(m.supportedLevels) || !m.supportedLevels.length || m.supportedLevels.some((l) => !CUSTOM_THINKING_LEVELS.includes(l))) throw new Error(`${id}: specify supported reasoning levels, or off.`);
		return { id, ...(typeof m.name === "string" && m.name.trim() ? { name: m.name.trim().slice(0, 256) } : {}), contextWindow: m.contextWindow!, maxTokens: m.maxTokens!, imageInput: m.imageInput, supportedLevels: [...new Set(m.supportedLevels)] };
	});
}

/** Use server-published metadata, including Codex-compatible catalogs. No local capability defaults. */
export function discoverCustomModels(body: unknown): CustomModelDraft[] {
	const catalog = body as { data?: unknown; models?: unknown } | null;
	const data = Array.isArray(catalog?.data) ? catalog.data : catalog?.models;
	if (!Array.isArray(data)) throw new Error("The endpoint did not return a model list. Add models manually.");
	const seen = new Set<string>();
	return data.flatMap((raw): CustomModelDraft[] => {
		if (!raw || typeof raw !== "object" || raw.visibility === "hide") return [];
		const id = typeof raw.id === "string" ? raw.id.trim() : typeof raw.slug === "string" ? raw.slug.trim() : "";
		if (!id || id.length > 256 || /[\r\n]/.test(id) || seen.has(id)) return [];
		seen.add(id);
		const positive = (...values: unknown[]) => values.find((v) => Number.isSafeInteger(v) && (v as number) > 0) as number | undefined;
		const modalities = raw.input ?? raw.input_modalities ?? raw.architecture?.input_modalities;
		const levels = raw.supportedLevels ?? raw.supported_thinking_levels ?? raw.supported_reasoning_levels;
		const normalizedLevels = Array.isArray(levels) ? levels.map((l: unknown) => typeof l === "string" ? l : l && typeof l === "object" && "effort" in l ? l.effort : undefined).map((l: unknown) => l === "none" ? "off" : l).filter((l: unknown): l is ThinkingLevel => CUSTOM_THINKING_LEVELS.includes(l as ThinkingLevel)) : undefined;
		return [{
			id,
			...(typeof raw.display_name === "string" ? { name: raw.display_name } : {}),
			// context_window is the active limit; max_context_window may require another service tier.
			contextWindow: positive(raw.contextWindow, raw.context_window, raw.context_length, raw.top_provider?.context_length),
			maxTokens: positive(raw.maxTokens, raw.max_tokens, raw.max_output_tokens, raw.max_completion_tokens, raw.top_provider?.max_completion_tokens),
			imageInput: typeof raw.imageInput === "boolean" ? raw.imageInput : Array.isArray(modalities) && modalities.includes("text") ? modalities.includes("image") : undefined,
			supportedLevels: normalizedLevels?.length ? [...new Set(normalizedLevels)] : raw.reasoning === false || (Array.isArray(levels) && levels.length === 0) ? ["off"] : undefined,
		}];
	}).slice(0, 500);
}
