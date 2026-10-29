import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-migrate-"));
process.env.LH_DATA_DIR = dir;
process.env.LH_AUTH_FILE = path.join(dir, "auth.json");
process.env.LH_IGNORE_ENV_KEYS = "1";
const { customConnectionStore } = await import("../src/store/custom-connections.ts");
const { migrateCustomConnection } = await import("../src/server/migrate-custom-connection.ts");
const { readSettings, writeSettings } = await import("../src/store/settings.ts");
const { readCustomAuth } = await import("../src/store/auth.ts");
const id = "custom-00000000-0000-4000-8000-000000000001";

test("migrates one connection without deleting the original and preserves exact levels", () => {
 customConnectionStore.save({ id, name: "Proxy", baseUrl: "https://example.test/v1", apiKey: "secret", models: [{ id: "model", name: "Model", contextWindow: 8000, maxTokens: 500, imageInput: true, supportedLevels: ["off", "high"] }] });
 writeSettings({ version: 1, models: { strong: { model: { provider: id, id: "model" } } } });
 migrateCustomConnection();
 const settings = readSettings()!;
 assert.equal(settings.models?.strong?.model?.provider, "custom");
 assert.equal(settings.customProvider?.legacyProviderId, id);
 assert.deepEqual(settings.customProvider?.models?.[0]?.supportedLevels, ["off", "high"]);
 assert.equal(settings.customProvider?.models?.[0]?.context, 8000);
 assert.equal(readCustomAuth().fileKey(), "secret");
 assert.equal(customConnectionStore.read().length, 1);
 migrateCustomConnection();
 assert.equal(readCustomAuth().fileKey(), "secret");
});

test("a disconnect does not resurrect the legacy connection", () => {
 writeSettings({ version: 1 });
 migrateCustomConnection();
 assert.equal(readSettings()?.customProvider, undefined);
});

test("old chat model pins are mapped without rewriting chat files", async () => {
 const { chatStore } = await import("../src/store/chats.ts");
 fs.mkdirSync(path.join(dir, "chats"), { recursive: true });
 const file = path.join(dir, "chats", "old.json");
 const raw = JSON.stringify({ id: "old", settings: { model: { provider: id, id: "model" } }, messages: [] });
 fs.writeFileSync(file, raw);
 assert.equal(chatStore.getChat("old")?.settings?.model?.provider, "custom");
 assert.equal(fs.readFileSync(file, "utf8"), raw);
});

test("does not replace an environment-owned key with the old connection key", async () => {
 const { spawnSync } = await import("node:child_process");
 const home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-migrate-conflict-"));
 fs.writeFileSync(path.join(home, "custom-connections.json"), JSON.stringify([{ id, name: "Proxy", baseUrl: "https://example.test/v1", apiKey: "old-key", models: [] }]));
 const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", 'import("./src/server/stores.ts")'], {
  cwd: process.cwd(), encoding: "utf8", env: { PATH: process.env.PATH, HOME: home, NODE_ENV: "test", LH_DATA_DIR: home, LH_AUTH_FILE: path.join(home, "auth.json"), LH_IGNORE_ENV_KEYS: "0", CUSTOM_OPENAI_API_KEY: "different-key" },
 });
 assert.notEqual(child.status, 0);
 assert.match(child.stderr, /different custom endpoint environment key/);
 assert.equal(fs.existsSync(path.join(home, "settings.json")), false);
 assert.equal(fs.existsSync(path.join(home, "auth.json")), false);
});

test("recovers an interrupted migration after the auth write", async () => {
 const { spawnSync } = await import("node:child_process");
 const home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-migrate-recover-"));
 const baseUrl = "https://example.test/v1"; const nonce = "a".repeat(32);
 fs.writeFileSync(path.join(home, "custom-connections.json"), JSON.stringify([{ id, name: "Proxy", baseUrl, apiKey: "old-key", models: [] }]));
 fs.writeFileSync(path.join(home, "auth.json"), JSON.stringify({ CUSTOM_OPENAI_API_KEY: "old-key", __learnharness_custom_provider_binding: JSON.stringify({ version: 1, id: nonce, baseUrl, authMode: "apiKey", fileKeyBaseUrl: baseUrl }) }));
 const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", 'await import("./src/server/stores.ts")'], { cwd: process.cwd(), encoding: "utf8", env: { PATH: process.env.PATH, HOME: home, NODE_ENV: "test", LH_DATA_DIR: home, LH_AUTH_FILE: path.join(home, "auth.json") } });
 assert.equal(child.status, 0, child.stderr);
 const settings = JSON.parse(fs.readFileSync(path.join(home, "settings.json"), "utf8"));
 assert.equal(settings.customProvider.credentialBindingId, nonce);
 assert.ok(fs.existsSync(path.join(home, "custom-connections.migrated")));
});
