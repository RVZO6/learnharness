import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { renderToStaticMarkup } from "react-dom/server";
import { CustomConnections } from "../components/settings/custom-connections.tsx";
import { ModelMenuList } from "../components/settings/model-menu.tsx";
import { customBaseUrl, discoverCustomModels, validateCustomModels, validateCustomModelDrafts, usableCustomModels } from "../src/core/custom-connections.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-custom-connections-"));
process.env.LH_DATA_DIR = dir;
process.env.LH_IGNORE_ENV_KEYS = "1";
const { createCustomConnectionStore } = await import("../src/store/custom-connections.ts");
const { customConnections, saveCustomConnection, deleteCustomConnection, discoverCustomConnection, saveAndDiscoverCustomConnection } = await import("../src/server/custom-connections.ts");
const { piEngineForSpec, piModels } = await import("../src/agent/models.ts");
const { modelCatalog, validateChatSettings, catalogContextLimits } = await import("../src/server/model-catalog.ts");
const { callCost } = await import("../src/server/pricing.ts");
const { providerKeyPresent, providerKeyList } = await import("../src/server/keys.ts");
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const model = { id: "test-model", contextWindow: 128000, maxTokens: 8192, imageInput: true, supportedLevels: ["off", "low", "high"] as const };
const complete = { ...model, supportedLevels: [...model.supportedLevels] };

test("custom model details are required; no invented limits or capabilities", () => {
	const draft = discoverCustomModels({ data: [{ id: "unknown-model" }] })[0]!;
	assert.equal(draft.contextWindow, undefined);
	assert.equal(draft.maxTokens, undefined);
	assert.equal(draft.imageInput, undefined);
	assert.equal(draft.supportedLevels, undefined);
	assert.throws(() => validateCustomModels([draft]), /limits/);
	assert.throws(() => validateCustomModels([{ ...complete, imageInput: undefined }]), /image support/);
	assert.throws(() => validateCustomModels([{ ...complete, supportedLevels: [] }]), /reasoning/);
	assert.throws(() => validateCustomModels([{ ...complete, maxTokens: 999999 }]), /limits/);
	assert.throws(() => validateCustomModels([complete, complete]), /Duplicate/);
	assert.deepEqual(validateCustomModels([complete]), [complete]);
});

test("rich Codex catalog populates limits, modalities, and exact supported levels", () => {
	const drafts = discoverCustomModels({ models: [{
		slug: "served-alias", display_name: "Published model", context_window: 200000, max_context_window: 1000000,
		max_tokens: 32000, input_modalities: ["text", "image"],
		supported_reasoning_levels: [{ effort: "none" }, { effort: "low" }, { effort: "high" }, { effort: "max" }, { effort: "ultra" }],
		base_instructions: "Do not import this prompt", visibility: "list",
	}, { slug: "image-only", visibility: "hide" }] });
	assert.deepEqual(drafts, [{ id: "served-alias", name: "Published model", contextWindow: 200000, maxTokens: 32000, imageInput: true, supportedLevels: ["off", "low", "high", "max"] }]);
	assert.equal(validateCustomModels(drafts)[0]!.contextWindow, 200000);
	assert.equal(JSON.stringify(drafts).includes("instructions"), false);
	assert.equal(discoverCustomModels({ models: [{ slug: "no-limits", input_modalities: ["text"], supported_reasoning_levels: [] }] })[0]!.maxTokens, undefined);
});

test("custom base URLs reject credentials, unsupported schemes, and query strings", () => {
	for (const value of ["https://example.test", "https://example.test/", "https://example.test/v1", "https://example.test/v1/"]) assert.equal(customBaseUrl(value), "https://example.test/v1");
	assert.equal(customBaseUrl("https://example.test/api/v1/"), "https://example.test/api/v1");
	assert.equal(customBaseUrl("https://example.test/custom/api/"), "https://example.test/custom/api");
	for (const value of ["file:///tmp/example", "https://key@example.test/v1", "https://example.test/v1?key=secret", "bad-url"]) assert.throws(() => customBaseUrl(value));
});

test("store writes privately, updates atomically, and does not overwrite corrupt data", () => {
	const file = path.join(dir, "store-test.json");
	const store = createCustomConnectionStore(file);
	const entry = { id: "custom-12345678-1234-1234-1234-123456789abc", name: "Private endpoint", baseUrl: "https://example.test/v1", apiKey: "test-only", models: [complete] };
	store.save(entry);
	assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	store.save({ ...entry, name: "Renamed endpoint" });
	assert.equal(store.read().length, 1);
	assert.equal(store.read()[0]!.name, "Renamed endpoint");
	store.delete(entry.id);
	assert.deepEqual(store.read(), []);
	fs.writeFileSync(file, "corrupt");
	assert.throws(() => store.save(entry), /could not be read/);
	assert.equal(fs.readFileSync(file, "utf8"), "corrupt");
});

test("discovery detects rich catalogs, falls back safely, and never forwards redirects", async () => {
	const paths: string[] = [];
	let mode = "rich";
	const server = http.createServer((req, res) => {
		paths.push(req.url!);
		assert.equal(req.headers.authorization, "Bearer test-only");
		res.setHeader("content-type", "application/json");
		if (mode === "auth") { res.writeHead(401); res.end('{}'); return; }
		if (mode === "redirect") { res.writeHead(302, { location: "https://example.test/steal" }); res.end(); return; }
		if (mode === "fallback" && req.url!.includes("?")) { res.writeHead(400); res.end('{}'); return; }
		if (mode === "rich") res.end(JSON.stringify({ models: [{ slug: "remote-model", context_window: 128000, max_tokens: 8192, input_modalities: ["text"], supported_reasoning_levels: [] }] }));
		else res.end(JSON.stringify({ data: [{ id: "plain-model" }] }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const port = (server.address() as { port: number }).port;
		const body = { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "test-only" };
		const rich = await discoverCustomConnection(body);
		assert.equal(rich[0]!.maxTokens, 8192);
		assert.deepEqual(rich[0]!.supportedLevels, ["off"]);
		assert.deepEqual(paths, ["/v1/models?client_version=cpa"]);
		mode = "fallback"; paths.length = 0;
		assert.equal((await discoverCustomConnection(body))[0]!.id, "plain-model");
		assert.deepEqual(paths, ["/v1/models?client_version=cpa", "/v1/models"]);
		mode = "auth"; paths.length = 0;
		await assert.rejects(discoverCustomConnection(body), /401/);
		assert.equal(paths.length, 1);
		mode = "redirect";
		await assert.rejects(discoverCustomConnection(body), /Could not load/);
	} finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("saved connections feed the real catalog, settings validation, streaming, and deletion", async () => {
	let authorization: string | undefined;
	let payload: Record<string, unknown> | undefined;
	const server = http.createServer(async (req, res) => {
		authorization = req.headers.authorization;
		let raw = ""; for await (const chunk of req) raw += chunk;
		payload = JSON.parse(raw);
		assert.equal(req.url, "/v1/chat/completions");
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end('data: {"id":"test","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}\n\ndata: {"id":"test","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
		saveCustomConnection({ name: "My gateway", baseUrl, apiKey: "test-only", models: [complete] });
		const info = customConnections()[0]!;
		assert.equal("apiKey" in info, false);
		assert.equal(info.keyPresent, true);
		assert.equal(providerKeyList().some((p) => p.id === info.id), false);
		assert.equal(providerKeyPresent(info.id), true);
		const dto = modelCatalog().models.find((m) => m.provider === info.id)!;
		assert.equal(dto.connectionName, "My gateway");
		assert.equal(dto.pricingKnown, false);
		assert.deepEqual(dto.supportedLevels, ["off", "low", "high"]);
		assert.equal(catalogContextLimits().get(`${info.id}:test-model`), 128000);
		assert.deepEqual(validateChatSettings({ model: { provider: info.id, id: model.id } }), { ok: true });
		assert.equal(callCost({ inputTokens: 10, outputTokens: 5 }, `${info.id}:test-model`), null);
		const menu = renderToStaticMarkup(<ModelMenuList models={[dto]} effectiveId={model.id} effectiveProvider={info.id} onPick={() => {}} />);
		assert.match(menu, /My gateway \(custom\)/);
		assert.match(menu, /Unknown/);
		assert.doesNotMatch(menu, /\$0/);
		const engine = piEngineForSpec({ provider: info.id, id: model.id, thinkingLevel: "off" });
		const result = await engine.streamFn(engine.model, normalizeContext({ messages: [{ role: "user", content: "Hi", timestamp: Date.now() }] }), {}).result();
		assert.equal(result.stopReason, "stop", JSON.stringify(result));
		assert.equal(authorization, "Bearer test-only");
		assert.equal(payload?.model, model.id);
		assert.equal(JSON.stringify(payload).includes("custom-"), false);
		assert.throws(() => saveCustomConnection({ name: "Moved", baseUrl: "https://different.test/v1", models: [complete] }, info.id), /Re-enter/);
		saveCustomConnection({ name: "Renamed", baseUrl, models: [complete] }, info.id);
		assert.equal(customConnections()[0]!.name, "Renamed");
		assert.equal((await piModels().getAuth(info.id))?.auth.apiKey, "test-only");
		deleteCustomConnection(info.id);
		assert.equal(providerKeyPresent(info.id), false);
		assert.equal(piModels().getModel(info.id, model.id), undefined);
		assert.equal(modelCatalog().models.some((m) => m.provider === info.id), false);
	} finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("custom connections remain separate and have short neutral copy", () => {
	const html = renderToStaticMarkup(<CustomConnections />);
	assert.doesNotMatch(html, /Connect your own proxy or server|Tool calling required|Pricing unknown|Load models/);
	assert.match(html, /Add connection/);
	assert.doesNotMatch(html, /CLIProxyAPI|ProviderMenuList/);
});

test("incomplete model drafts persist without becoming runnable or acquiring defaults", () => {
	assert.deepEqual(validateCustomModelDrafts([]), []);
	assert.deepEqual(validateCustomModelDrafts([{ id: "manual" }]), [{ id: "manual" }]);
	assert.deepEqual(usableCustomModels([{ id: "manual" }, complete]), [complete]);
	assert.throws(() => validateCustomModelDrafts([{ id: "invalid", contextWindow: 0 }]), /limits/);
	assert.throws(() => validateCustomModelDrafts([{ id: "invalid", imageInput: "false" }]), /image/);
	const id = saveCustomConnection({ name: "Draft only", baseUrl: "https://example.invalid/v1", models: [{ id: "manual" }] });
	const info = customConnections().find((c) => c.id === id)!;
	assert.equal(info.ready, false);
	assert.equal(info.keyPresent, false);
	assert.deepEqual(info.models, [{ id: "manual" }]);
	assert.equal(providerKeyPresent(id), false);
	assert.equal(modelCatalog().models.some((m) => m.provider === id), false);
	assert.throws(() => piEngineForSpec({ provider: id, id: "manual" }), /no model/);
	deleteCustomConnection(id);
});

test("Save discovers models without a key; keyless inference sends no Authorization header", async () => {
	let mode = "rich";
	const requests: { url: string; auth: string | undefined }[] = [];
	const server = http.createServer(async (req, res) => {
		requests.push({ url: req.url!, auth: req.headers.authorization });
		if (req.url?.includes("/models")) {
			res.setHeader("content-type", "application/json");
			if (mode === "failure") { res.writeHead(401); res.end('{}'); return; }
			if (mode === "plain") { res.end(JSON.stringify({ data: [{ id: "incomplete" }] })); return; }
			res.end(JSON.stringify({ models: [{ slug: "keyless-model", context_window: 64000, max_tokens: 4096, input_modalities: ["text"], supported_reasoning_levels: [] }] })); return;
		}
		for await (const _chunk of req) { /* drain request */ }
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end('data: {"id":"test","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}\n\ndata: {"id":"test","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
		const reply = await saveAndDiscoverCustomConnection({ name: "Keyless", baseUrl: baseUrl.replace(/\/v1$/, ""), apiKey: "", models: [] });
		assert.deepEqual(reply, { ok: true });
		const info = customConnections().find((c) => c.name === "Keyless")!;
		assert.equal(info.keyPresent, false);
		assert.equal(info.baseUrl, baseUrl, "bare server URLs must normalize before discovery and inference");
		assert.equal(info.ready, true);
		assert.equal(providerKeyPresent(info.id), true);
		assert.equal(modelCatalog().providers.find((p) => p.id === info.id)?.keyPresent, true);
		const engine = piEngineForSpec({ provider: info.id, id: "keyless-model" });
		const result = await engine.streamFn(engine.model, normalizeContext({ messages: [{ role: "user", content: "Hi", timestamp: Date.now() }] }), {}).result();
		assert.equal(result.stopReason, "stop", JSON.stringify(result));
		assert.deepEqual(requests, [{ url: "/v1/models?client_version=cpa", auth: undefined }, { url: "/v1/chat/completions", auth: undefined }]);
		// A saved key can be retained, replaced, and explicitly removed.
		saveCustomConnection({ name: "Keyless", baseUrl, apiKey: "test-only", models: info.models }, info.id);
		saveCustomConnection({ name: "Keyless", baseUrl, models: info.models }, info.id);
		assert.equal(customConnections().find((c) => c.id === info.id)?.keyPresent, true);
		await saveAndDiscoverCustomConnection({ name: "Keyless", baseUrl, apiKey: "", models: info.models }, info.id);
		assert.equal(customConnections().find((c) => c.id === info.id)?.keyPresent, false);
		assert.equal(requests.at(-1)?.auth, undefined);
		deleteCustomConnection(info.id);

		mode = "plain";
		await saveAndDiscoverCustomConnection({ name: "Incomplete", baseUrl, models: [] });
		const partial = customConnections().find((c) => c.name === "Incomplete")!;
		assert.equal(partial.ready, false);
		assert.equal(partial.models[0]?.id, "incomplete");
		assert.equal(partial.models[0]?.contextWindow, undefined);
		deleteCustomConnection(partial.id);

		mode = "failure";
		const failure = await saveAndDiscoverCustomConnection({ name: "Failed discovery", baseUrl, models: [] });
		assert.equal(failure.ok, true);
		assert.deepEqual(failure, { ok: true }, "optional discovery failure must not produce a save warning");
		const failed = customConnections().find((c) => c.name === "Failed discovery")!;
		assert.deepEqual(failed.models, []);
		assert.equal(failed.ready, false);
		// Failed discovery does not discard manually configured models.
		await saveAndDiscoverCustomConnection({ name: failed.name, baseUrl, models: [complete] }, failed.id);
		assert.equal(customConnections().find((c) => c.id === failed.id)?.ready, true);
		deleteCustomConnection(failed.id);
	} finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
