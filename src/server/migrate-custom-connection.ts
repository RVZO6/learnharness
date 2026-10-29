/** Migrate the former single saved connection without deleting its source file. */
import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import { randomBytes } from "node:crypto";
import { customConnectionStore } from "../store/custom-connections.ts";
import { readSettings, writeSettings } from "../store/settings.ts";
import { readCustomAuth } from "../store/auth.ts";
import { persistCustomAuth } from "./custom-provider-auth.ts";
import { CUSTOM_PROVIDER } from "../core/auth-keys.ts";
import { authEnvRecord } from "../core/auth-env.ts";
import { customBindingMatches } from "../core/custom-provider-auth.ts";

function markMigration(file: string, provider: string): void {
 const tmp = `${file}.${randomBytes(8).toString("hex")}.tmp`;
 try { fs.writeFileSync(tmp, JSON.stringify({ provider }), { mode: 0o600 }); fs.renameSync(tmp, file); }
 finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}

export function migrateCustomConnection(): void {
 const marker = path.join(PATHS.data, "custom-connections.migrated");
 if (fs.existsSync(marker)) return;
 const entries = customConnectionStore.read();
 if (entries.length === 0) return;
 const settings = readSettings() ?? { version: 1 };
 if (settings.customProvider?.baseUrl) {
  if (entries.length === 1 && settings.customProvider.legacyProviderId === entries[0]!.id) {
   const existing = readCustomAuth();
   if (!customBindingMatches(settings.customProvider, existing.binding) || (entries[0]!.apiKey && existing.fileKey() !== entries[0]!.apiKey)) throw new Error("Incomplete custom connection migration requires credential review.");
   markMigration(marker, entries[0]!.id);
   return;
  }
  throw new Error("Existing custom endpoint configuration prevents automatic migration of the old connection.");
 }
 if (entries.length !== 1) throw new Error("Cannot migrate multiple custom connections to one endpoint.");
 const connection = entries[0]!;
 const oldAuth = readCustomAuth();
 const mode = connection.apiKey ? "apiKey" : "keyless";
 const recoverable = oldAuth.binding?.baseUrl === connection.baseUrl && oldAuth.binding.authMode === mode && (oldAuth.fileKey() ?? "") === connection.apiKey && (!connection.apiKey || oldAuth.binding.fileKeyBaseUrl === connection.baseUrl);
 if ((oldAuth.binding || oldAuth.fileKey()) && !recoverable) throw new Error("Cannot overwrite existing custom endpoint credentials during migration.");
 if (connection.apiKey && process.env.LH_IGNORE_ENV_KEYS !== "1" && authEnvRecord().realEnv.has(CUSTOM_PROVIDER.envVar) && process.env[CUSTOM_PROVIDER.envVar] !== connection.apiKey) throw new Error("Cannot migrate while a different custom endpoint environment key is configured.");
 const id = recoverable ? oldAuth.binding!.id : randomBytes(16).toString("hex");
 const updated = structuredClone(settings);
 for (const slot of Object.values(updated.models ?? {})) if (slot?.model?.provider === connection.id) slot.model.provider = CUSTOM_PROVIDER.id;
 for (const role of Object.values(updated.agent?.models ?? {})) if (role?.model?.provider === connection.id) role.model.provider = CUSTOM_PROVIDER.id;
 updated.customProvider = {
  credentialBindingId: id, authMode: mode, baseUrl: connection.baseUrl,
  legacyProviderId: connection.id,
  models: connection.models.map((m) => ({ id: m.id, ...(m.name ? { name: m.name } : {}), ...(m.contextWindow ? { context: m.contextWindow } : {}), ...(m.maxTokens ? { maxTokens: m.maxTokens } : {}), ...(m.imageInput ? { image: true } : {}), ...(m.supportedLevels ? { supportedLevels: m.supportedLevels } : {}) })),
  manualModels: connection.models.map((m) => m.id),
 };
 try {
  persistCustomAuth({ version: 1, id, authMode: mode, baseUrl: connection.baseUrl, ...(connection.apiKey ? { fileKeyBaseUrl: connection.baseUrl } : {}) }, connection.apiKey || undefined);
  writeSettings(updated);
  markMigration(marker, connection.id);
 } catch (error) {
  persistCustomAuth(oldAuth.binding, oldAuth.fileKey());
  writeSettings(settings);
  throw error;
 }
}
