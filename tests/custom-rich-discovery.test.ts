import assert from "node:assert/strict";
import { test } from "node:test";
import { createModels, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { buildOpenAiCompatibleProvider, discoverModels } from "../src/server/custom-provider.ts";

test("discovers proxy model metadata and uses its exact reasoning levels", async () => {
 const original = globalThis.fetch; const urls: string[] = [];
 globalThis.fetch = async (input) => { urls.push(String(input)); return Response.json({ models: [{ slug: "example", display_name: "Example", context_window: 32000, max_output_tokens: 1000, input: ["text", "image"], supported_reasoning_levels: ["low", "high"] }, { id: "hidden", visibility: "hide" }] }); };
 try {
  const result = await discoverModels("https://example.test/v1");
  assert.ok(result.ok); assert.deepEqual(urls, ["https://example.test/v1/models?client_version=cpa"]);
  assert.deepEqual(result.models, [{ id: "example", name: "Example", context: 32000, maxTokens: 1000, image: true, supportedLevels: ["low", "high"] }]);
  const provider = buildOpenAiCompatibleProvider({ baseUrl: "https://example.test/v1", models: result.models });
  const registry = createModels(); registry.setProvider(provider);
  assert.deepEqual(getSupportedThinkingLevels(registry.getModel("custom", "example")!), ["low", "high"]);
 } finally { globalThis.fetch = original; }
});

test("falls back to the standard endpoint if the richer query is rejected", async () => {
 const original = globalThis.fetch; const urls: string[] = [];
 globalThis.fetch = async (input) => { urls.push(String(input)); return urls.length === 1 ? new Response(null, { status: 404 }) : Response.json({ data: [{ id: "standard" }] }); };
 try { const result = await discoverModels("https://example.test/v1"); assert.ok(result.ok); assert.deepEqual(result.models, [{ id: "standard" }]); assert.equal(urls.length, 2); }
 finally { globalThis.fetch = original; }
});

test("retains rich metadata beyond the old 500-model limit", async () => {
 const original = globalThis.fetch;
 globalThis.fetch = async () => Response.json({ models: Array.from({ length: 501 }, (_, n) => ({ id: `model-${n}`, context_window: 16000, supported_reasoning_levels: ["high"] })) });
 try {
  const result = await discoverModels("https://example.test/v1");
  assert.ok(result.ok); assert.equal(result.models.length, 501);
  assert.deepEqual(result.models.find((m) => m.id === "model-500")?.supportedLevels, ["high"]);
 } finally { globalThis.fetch = original; }
});
