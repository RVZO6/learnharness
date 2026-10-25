import { randomUUID } from "node:crypto";
import { customBaseUrl, discoverCustomModels, isCustomConnection, validateCustomModelDrafts, usableCustomModels, type CustomConnectionInfo } from "../core/custom-connections.ts";
import { customConnectionStore } from "../store/custom-connections.ts";
import { configureCustomConnections } from "../agent/custom-connections.ts";

configureCustomConnections(() => customConnectionStore.read());
export class CustomConnectionInputError extends Error {}
export function customConnections(): CustomConnectionInfo[] {
	return customConnectionStore.read().map(({ apiKey, ...entry }) => ({ ...entry, keyPresent: !!apiKey, ready: usableCustomModels(entry.models).length > 0 }));
}
function input(body: unknown, id?: string) {
	if (!body || typeof body !== "object" || Array.isArray(body)) throw new CustomConnectionInputError("Enter connection details.");
	if (id && !isCustomConnection(id)) throw new CustomConnectionInputError("Invalid connection ID.");
	const value = body as Record<string, unknown>;
	const previous = id ? customConnectionStore.read().find((c) => c.id === id) : undefined;
	if (id && !previous) throw new CustomConnectionInputError("Connection not found.");
	let baseUrl: string;
	try { baseUrl = customBaseUrl(value.baseUrl); } catch (error) { throw new CustomConnectionInputError((error as Error).message); }
	const key = value.apiKey;
	if (key !== undefined && typeof key !== "string") throw new CustomConnectionInputError("Invalid API key.");
	if (key === undefined && previous?.apiKey && previous.baseUrl !== baseUrl) throw new CustomConnectionInputError("Re-enter the API key when changing the base URL.");
	const apiKey = typeof key === "string" ? key.trim() : previous?.apiKey ?? "";
	if (apiKey.length > 16384 || /[\r\n\x00]/.test(apiKey)) throw new CustomConnectionInputError("Enter a valid API key.");
	return { value, baseUrl, apiKey };
}
export function saveCustomConnection(body: unknown, id?: string): string {
	const { value, baseUrl, apiKey } = input(body, id);
	if (typeof value.name !== "string" || !value.name.trim() || value.name.length > 80 || /[\r\n]/.test(value.name)) throw new CustomConnectionInputError("Enter a connection name (up to 80 characters).");
	let models;
	try { models = validateCustomModelDrafts(value.models); } catch (error) { throw new CustomConnectionInputError((error as Error).message); }
	const connectionId = id ?? `custom-${randomUUID()}`;
	customConnectionStore.save({ id: connectionId, name: value.name.trim(), baseUrl, apiKey, models });
	return connectionId;
}
/** Save first. Discovery failure must not discard a connection or manual model details. */
export async function saveAndDiscoverCustomConnection(body: unknown, id?: string) {
	const connectionId = saveCustomConnection(body, id);
	const saved = customConnectionStore.read().find((c) => c.id === connectionId)!;
	const { baseUrl, models } = saved;
	try {
		const discovered = await discoverCustomConnection({ id: connectionId, baseUrl });
		// Match exact served IDs. Manual values take precedence; discovery fills gaps.
		const byId = new Map(discovered.map((m) => [m.id, m]));
		const merged = new Map(models.map((m) => [m.id, { ...byId.get(m.id), ...m }]));
		for (const m of discovered) if (!merged.has(m.id) && merged.size < 500) merged.set(m.id, m);
		const current = customConnectionStore.read().find((c) => c.id === connectionId);
		// Do not resurrect a deleted connection or overwrite a concurrent edit.
		if (current && JSON.stringify(current) === JSON.stringify(saved)) customConnectionStore.save({ ...saved, models: validateCustomModelDrafts([...merged.values()].slice(0, 500)) });
	} catch {
		// Discovery is optional. A successful save stays successful without a warning.
	}
	return { ok: true };
}
export function deleteCustomConnection(id: string): void {
	if (!isCustomConnection(id)) throw new CustomConnectionInputError("Invalid connection ID.");
	customConnectionStore.delete(id);
}
export async function discoverCustomConnection(body: unknown) {
	const id = body && typeof body === "object" && "id" in body ? (body as { id?: unknown }).id : undefined;
	if (id !== undefined && typeof id !== "string") throw new CustomConnectionInputError("Invalid connection ID.");
	const { baseUrl, apiKey } = input(body, id);
	// Query only the user-selected endpoint. Ordinary OpenAI-compatible servers can
	// ignore the query or reject it; neither case requires a dedicated integration.
	const signal = AbortSignal.timeout(15000);
	async function load(suffix: string) {
		const response = await fetch(`${baseUrl}/models${suffix}`, {
			headers: { ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}), accept: "application/json" },
			redirect: "error", signal,
		});
		if (!response.ok) { await response.body?.cancel(); return { status: response.status }; }
		const reader = response.body?.getReader();
		if (!reader) throw new Error("Empty body");
		const chunks: Uint8Array[] = []; let size = 0;
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error("Large response"); }
			chunks.push(value);
		}
		return { status: response.status, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown };
	}
	try {
		// client_version=cpa requests the server's richer catalog using the same
		// inference key. Do not copy instructions or other agent configuration.
		let response = await load("?client_version=cpa");
		if (response.status === 401 || response.status === 403) throw new CustomConnectionInputError(`Model discovery failed (HTTP ${response.status}). Check the API key.`);
		if (!response.body || typeof response.body !== "object" || (!Array.isArray((response.body as { models?: unknown }).models) && !Array.isArray((response.body as { data?: unknown }).data))) response = await load("");
		if (!response.body) throw new CustomConnectionInputError(`Model discovery failed (HTTP ${response.status}). Add models manually or check the connection.`);
		return discoverCustomModels(response.body);
	} catch (error) {
		if (error instanceof CustomConnectionInputError) throw error;
		throw new CustomConnectionInputError("Could not load models. Check the connection or add models manually.");
	}
}
