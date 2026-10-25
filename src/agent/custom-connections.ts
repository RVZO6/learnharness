import { createProvider, type createModels, type ThinkingLevelMap } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { CUSTOM_THINKING_LEVELS, usableCustomModels, type CustomConnection } from "../core/custom-connections.ts";

// The composition root supplies storage. Agent code never imports a store.
const KEY = Symbol.for("lh.customConnections");
type Models = ReturnType<typeof createModels>;
interface State { read: () => CustomConnection[]; revisions: WeakMap<Models, string> }
function state(): State {
	const global = globalThis as typeof globalThis & { [KEY]?: State };
	return global[KEY] ??= { read: () => [], revisions: new WeakMap() };
}
export function configureCustomConnections(read: () => CustomConnection[]) { state().read = read; state().revisions = new WeakMap(); }
export function syncCustomConnections(models: Models) {
	const connections = state().read();
	const revision = JSON.stringify(connections);
	if (state().revisions.get(models) === revision) return;
	for (const p of models.getProviders()) if (p.id.startsWith("custom-")) models.deleteProvider(p.id);
	for (const connection of connections) {
		models.setProvider(createProvider({
			id: connection.id, name: connection.name, baseUrl: connection.baseUrl,
			auth: { apiKey: { name: "Connection API key", resolve: async () => {
				const live = state().read().find((c) => c.id === connection.id);
				if (!live || live.baseUrl !== connection.baseUrl) return undefined;
				// The SDK requires a nonempty internal key. A null header removes its
				// generated Authorization header, so keyless requests send no token.
				return { auth: { apiKey: live.apiKey || "unused", baseUrl: live.baseUrl, ...(!live.apiKey ? { headers: { Authorization: null } } : {}) } };
			} } },
			models: usableCustomModels(connection.models).map((m) => ({
				id: m.id, name: m.name ?? m.id, provider: connection.id, api: "openai-completions" as const, baseUrl: connection.baseUrl,
				contextWindow: m.contextWindow, maxTokens: m.maxTokens, input: m.imageInput ? ["text", "image"] : ["text"],
				reasoning: m.supportedLevels.some((l) => l !== "off"),
				thinkingLevelMap: Object.fromEntries(CUSTOM_THINKING_LEVELS.map((l) => [l, m.supportedLevels.includes(l) ? l : null])) as ThinkingLevelMap,
				// Pi requires rates. These internal placeholders are never shown or used for app pricing.
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			})),
			api: openAICompletionsApi(),
		}));
	}
	state().revisions.set(models, revision);
}
