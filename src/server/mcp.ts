import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	McpClient,
	StdioTransport,
	StreamableHttpTransport,
	type McpTransport,
	type Tool,
} from "@earendil-works/pi-mcp";
import { MCP_CONFIG_FILE } from "../../config.ts";
import { storeMcpResult, type McpResultStorage } from "./mcp-results.ts";
import {
	firstSentence,
	isHttpConfig,
	mcpToolEnabled,
	mcpToolKind,
	setupFields,
	type McpServerConfig,
	type McpToolKind,
} from "../core/mcp-setup.ts";

/**
 * MCP client tools: every enabled tool of every enabled server in
 * MCP_CONFIG_FILE, wrapped as a pi AgentTool named `mcp__<server>__<tool>`.
 * The chat handler awaits mcpTools() per turn and hands the list to the
 * agent factories (AgentBuildOptions.extraTools) — the agent layer never
 * imports this. Settings → Connections reads mcpStatus() and edits the file
 * through the write functions below (app/api/mcp).
 *
 * Config shape (the one Claude Desktop, Cursor, and pi read, plus our
 * `disabled` and per-tool `tools` fields — src/core/mcp-setup.ts):
 *   { "mcpServers": {
 *       "canvas": { "command": "canvas-mcp", "args": [], "env": {} },
 *       "remote": { "url": "https://…/mcp", "headers": {} },
 *       "off":    { "command": "x", "disabled": true } } }
 *
 * Connections live on globalThis, NOT module state: Next dev compiles each
 * route as its own module instance (same reason as turn-liveness.ts), and a
 * second instance would spawn a second copy of every stdio server. The
 * file's mtime keys the cache. On a change, each server is reconciled on
 * its own: a server whose connection settings (command/args/env/url/…) are
 * unchanged keeps its live client, so turning one tool off restarts
 * nothing. One server failing to start drops only that server's tools — a
 * broken entry never blocks a lesson.
 */

const CONNECT_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 120_000;
const STDERR_KEEP = 4_000;
/** Providers allow at most 64 characters of [A-Za-z0-9_-] in a tool name. */
const MAX_TOOL_NAME = 64;

export type McpServerState = "connected" | "error" | "off";

/** What a server needs installed, from a spawn ENOENT on its command. */
export interface McpMissingProgram {
	name: string;
	url: string;
}

interface ServerRecord {
	name: string;
	config: McpServerConfig;
	/** JSON of the connection settings; equal key = keep the live client. */
	connectKey: string;
	state: McpServerState;
	client?: McpClient;
	tools: Tool[];
	instructions?: string;
	error?: string;
	missing?: McpMissingProgram;
	stderr: string;
	connectedAt?: string;
}

interface McpState {
	/** mtime of the config the records were built from (null = no file). */
	mtimeMs: number | null;
	records: Promise<ServerRecord[]>;
}

interface LhGlobal {
	__lhMcpV2?: McpState;
}

function lhGlobal(): LhGlobal {
	return globalThis as typeof globalThis & LhGlobal;
}

function configMtime(file: string): number | null {
	try {
		return fs.statSync(file).mtimeMs;
	} catch {
		return null;
	}
}

/** Parse the config file into named server entries. Throws on bad JSON or
 *  a bad shape — the caller logs and runs with no MCP tools. */
export function parseMcpConfig(text: string): Record<string, McpServerConfig> {
	const raw: unknown = JSON.parse(text);
	const servers = (raw as { mcpServers?: unknown } | null)?.mcpServers;
	if (servers === undefined) return {};
	if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
		throw new Error(`"mcpServers" must be an object`);
	}
	const out: Record<string, McpServerConfig> = {};
	for (const [name, entry] of Object.entries(servers)) {
		const e = entry as { command?: unknown; url?: unknown } | null;
		if (typeof e?.command === "string" || typeof e?.url === "string") out[name] = e as McpServerConfig;
		else throw new Error(`server "${name}" needs a "command" or a "url"`);
	}
	return out;
}

/** `mcp__<server>__<tool>`, sanitized to the provider charset and length;
 *  `taken` dedupes names that collide after sanitizing/truncation. */
export function mcpToolName(server: string, tool: string, taken: Set<string>): string {
	const base = `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, MAX_TOOL_NAME);
	let name = base;
	for (let i = 2; taken.has(name); i++) {
		const suffix = `_${i}`;
		name = base.slice(0, MAX_TOOL_NAME - suffix.length) + suffix;
	}
	taken.add(name);
	return name;
}

/** Wrap one MCP tool as a pi AgentTool. MCP reports tool failures inside
 *  the result (isError), not as a protocol error; both reach the model as
 *  an error result it can react to. */
export function wrapMcpTool(client: McpClient, server: string, tool: Tool, name: string, storage: McpResultStorage = {}): AgentTool<any> {
	return {
		name,
		label: `${server}: ${tool.title ?? tool.name}`,
		description: `[MCP server "${server}"] ${tool.description ?? tool.name}`,
		// Providers require an object schema, and some reject one without `properties`.
		parameters: Type.Unsafe({ ...tool.inputSchema, type: "object", properties: tool.inputSchema.properties ?? {} }),
		execute: async (_toolCallId, params, signal) => {
			const result = await client.callTool(tool.name, (params ?? {}) as Record<string, unknown>, {
				signal,
				timeoutMs: CALL_TIMEOUT_MS,
			});
			signal?.throwIfAborted();
			return { ...storeMcpResult(result, storage), details: undefined };
		},
	};
}

function connectKey(config: McpServerConfig): string {
	if (isHttpConfig(config)) return JSON.stringify({ url: config.url, headers: config.headers ?? {} });
	return JSON.stringify({ command: config.command, args: config.args ?? [], env: config.env ?? {}, cwd: config.cwd ?? "" });
}

/** A GUI-launched app inherits a minimal PATH (/usr/bin:/bin:…), so npx,
 *  uvx, and docker from Homebrew or a version manager are not found.
 *  Append the usual install locations after whatever PATH we have. */
function launchPath(): string {
	const home = os.homedir();
	const extra = [
		"/opt/homebrew/bin",
		"/usr/local/bin",
		path.join(home, ".local", "bin"),
		path.join(home, ".cargo", "bin"),
		path.join(home, ".volta", "bin"),
		path.join(home, ".bun", "bin"),
		path.join(home, ".local", "share", "mise", "shims"),
		path.join(home, ".asdf", "shims"),
	];
	const parts = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
	for (const dir of extra) if (!parts.includes(dir)) parts.push(dir);
	return parts.join(path.delimiter);
}

const PROGRAMS: Record<string, McpMissingProgram> = {
	node: { name: "Node.js", url: "https://nodejs.org/en/download" },
	uv: { name: "uv", url: "https://docs.astral.sh/uv/getting-started/installation/" },
	docker: { name: "Docker", url: "https://www.docker.com/products/docker-desktop/" },
	python: { name: "Python", url: "https://www.python.org/downloads/" },
	bun: { name: "Bun", url: "https://bun.sh" },
};

function missingProgram(command: string): McpMissingProgram | undefined {
	const base = path.basename(command);
	if (/^(npx|npm|node|pnpm|pnpx|yarn)$/.test(base)) return PROGRAMS.node;
	if (/^(uvx|uv)$/.test(base)) return PROGRAMS.uv;
	if (/^docker$/.test(base)) return PROGRAMS.docker;
	if (/^(python3?|pipx|pip3?)$/.test(base)) return PROGRAMS.python;
	if (/^(bun|bunx)$/.test(base)) return PROGRAMS.bun;
	return undefined;
}

function transportFor(record: ServerRecord): McpTransport {
	const { config, name } = record;
	if (isHttpConfig(config)) return new StreamableHttpTransport({ url: config.url, headers: config.headers });
	return new StdioTransport({
		command: config.command,
		args: config.args,
		env: { PATH: launchPath(), ...config.env },
		cwd: config.cwd,
		onStderr: (chunk) => {
			record.stderr = (record.stderr + chunk).slice(-STDERR_KEEP);
			console.error(`[mcp ${name}] ${chunk.trimEnd()}`);
		},
	});
}

/** The plain sentence a failure shows in Settings; the raw message and the
 *  server's stderr stay available under "details". */
function explainFailure(err: unknown, record: ServerRecord): string {
	const e = err as { code?: string; status?: number; message?: string };
	if (e?.code === "ENOENT" && !isHttpConfig(record.config)) {
		record.missing = missingProgram(record.config.command);
		return record.missing
			? `This connection needs ${record.missing.name}, a free program it runs on. Install it, then try again.`
			: `The program “${record.config.command}” is not on this Mac.`;
	}
	if (e?.status === 401 || e?.status === 403 || /\b(401|403|unauthori[sz]ed|forbidden)\b/i.test(e?.message ?? "")) {
		return "The service did not accept the access token. Check it, then try again.";
	}
	if (/timed? ?out/i.test(e?.message ?? "")) return "It did not answer in time.";
	if (/ENOTFOUND|ECONNREFUSED|fetch failed/i.test(e?.message ?? "")) return "The service could not be reached.";
	return "It could not start.";
}

async function connect(record: ServerRecord): Promise<ServerRecord> {
	if (record.config.disabled) return { ...record, state: "off", tools: [] };
	const client = new McpClient({ name: "learnharness", version: "1.0.0" });
	record.client = client;
	try {
		await client.connect(transportFor(record));
		record.tools = await client.listTools({ timeoutMs: CONNECT_TIMEOUT_MS });
		record.instructions = client.instructions;
		record.state = "connected";
		record.connectedAt = new Date().toISOString();
		delete record.error;
		delete record.missing;
	} catch (err) {
		console.error(`[mcp ${record.name}] failed to start:`, err);
		record.state = "error";
		record.error = explainFailure(err, record);
		record.stderr = `${(err as Error)?.message ?? String(err)}\n${record.stderr}`.slice(0, STDERR_KEEP);
		record.tools = [];
		delete record.client;
		void client.close().catch(() => {});
	}
	return record;
}

function newRecord(name: string, config: McpServerConfig): ServerRecord {
	return { name, config, connectKey: connectKey(config), state: "off", tools: [], stderr: "" };
}

/** Reconcile live records with a freshly read config: keep a live client
 *  when its connection settings are unchanged, start the rest, close the
 *  ones that went away or were turned off. */
async function reconcile(previous: ServerRecord[], servers: Record<string, McpServerConfig>): Promise<ServerRecord[]> {
	const byName = new Map(previous.map((r) => [r.name, r]));
	const next = await Promise.all(
		Object.entries(servers).map(async ([name, config]) => {
			const old = byName.get(name);
			byName.delete(name);
			const key = connectKey(config);
			if (old && old.connectKey === key && old.state === "connected" && !config.disabled) {
				return { ...old, config };
			}
			if (old?.client) void old.client.close().catch(() => {});
			return connect(newRecord(name, config));
		}),
	);
	for (const gone of byName.values()) if (gone.client) void gone.client.close().catch(() => {});
	return next;
}

function readConfigFile(file: string): Record<string, McpServerConfig> {
	try {
		return parseMcpConfig(fs.readFileSync(file, "utf-8"));
	} catch (err) {
		if ((err as { code?: string }).code !== "ENOENT") console.error(`[mcp] ignoring ${file}:`, err);
		return {};
	}
}

/** The current records — reconciled on first use and after every config
 *  change; otherwise cached. Never throws. */
function records(file: string = MCP_CONFIG_FILE): Promise<ServerRecord[]> {
	const g = lhGlobal();
	const mtimeMs = configMtime(file);
	const current = g.__lhMcpV2;
	if (current && current.mtimeMs === mtimeMs) return current.records;
	const previous = current?.records ?? Promise.resolve([]);
	const next = previous.then((prev) => reconcile(prev, mtimeMs === null ? {} : readConfigFile(file)));
	g.__lhMcpV2 = { mtimeMs, records: next };
	return next;
}

/** The agent's MCP tool set: enabled tools of connected servers. */
export async function mcpTools(file: string = MCP_CONFIG_FILE, chatId?: string): Promise<AgentTool<any>[]> {
	const taken = new Set<string>();
	// Name assignment runs in config order, so dedupe suffixes are stable.
	return (await records(file)).flatMap((r) =>
		r.state !== "connected" || !r.client
			? []
			: r.tools
					.filter((tool) => mcpToolEnabled(r.config, tool.name, tool.annotations))
					.map((tool) => wrapMcpTool(r.client!, r.name, tool, mcpToolName(r.name, tool.name, taken), { chatId })),
	);
}

// ─── Settings → Connections ───────────────────────────────────────────────

export interface McpToolStatus {
	name: string;
	title: string;
	description: string;
	kind: McpToolKind;
	enabled: boolean;
}

export interface McpServerStatus {
	name: string;
	state: McpServerState;
	transport: "program" | "online";
	/** The server's own one-line summary (its MCP instructions), if any. */
	summary: string;
	error?: string;
	missing?: McpMissingProgram;
	details: string;
	tools: McpToolStatus[];
	/** The entry as stored, secrets masked — "technical details". */
	config: McpServerConfig;
	/** Setup values (env/headers), secrets masked, for "change" forms. */
	fields: { where: "env" | "header"; key: string; label: string; secret: boolean; value: string }[];
	connectedAt?: string;
}

function mask(value: string): string {
	if (!value) return "";
	return value.length <= 4 ? "••••" : `••••${value.slice(-4)}`;
}

function maskedConfig(config: McpServerConfig): McpServerConfig {
	const fields = setupFields(config);
	const secret = new Set(fields.filter((f) => f.secret).map((f) => f.key));
	if (isHttpConfig(config)) {
		const headers = Object.fromEntries(Object.entries(config.headers ?? {}).map(([k, v]) => [k, secret.has(k) ? mask(v) : v]));
		return { ...config, ...(config.headers ? { headers } : {}) };
	}
	const env = Object.fromEntries(Object.entries(config.env ?? {}).map(([k, v]) => [k, secret.has(k) ? mask(v) : v]));
	return { ...config, ...(config.env ? { env } : {}) };
}

function statusOf(r: ServerRecord): McpServerStatus {
	return {
		name: r.name,
		state: r.state,
		transport: isHttpConfig(r.config) ? "online" : "program",
		summary: firstSentence(r.instructions),
		...(r.error ? { error: r.error } : {}),
		...(r.missing ? { missing: r.missing } : {}),
		details: r.stderr.trim(),
		tools: r.tools.map((t) => ({
			name: t.name,
			title: t.title ?? t.annotations?.title ?? "",
			description: firstSentence(t.description, 160),
			kind: mcpToolKind(t.annotations),
			enabled: mcpToolEnabled(r.config, t.name, t.annotations),
		})),
		config: maskedConfig(r.config),
		fields: setupFields(r.config).map(({ where, key, label, secret, value }) => ({
			where,
			key,
			label,
			secret,
			value: secret ? mask(value) : value,
		})),
		...(r.connectedAt ? { connectedAt: r.connectedAt } : {}),
	};
}

export async function mcpStatus(file: string = MCP_CONFIG_FILE): Promise<McpServerStatus[]> {
	return (await records(file)).map(statusOf);
}

function readRawConfig(file: string): Record<string, unknown> {
	try {
		const raw: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
		return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
	} catch (err) {
		if ((err as { code?: string }).code === "ENOENT") return {};
		throw err;
	}
}

/** Atomic write, owner-only (the file holds access tokens). Unknown
 *  top-level keys and unknown entry fields are preserved. */
function writeRawConfig(file: string, raw: Record<string, unknown>): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, `${JSON.stringify(raw, null, "\t")}\n`, { mode: 0o600 });
	fs.renameSync(tmp, file);
}

function editServers(file: string, edit: (servers: Record<string, McpServerConfig>) => void): void {
	const raw = readRawConfig(file);
	const servers = { ...((raw.mcpServers as Record<string, McpServerConfig> | undefined) ?? {}) };
	edit(servers);
	writeRawConfig(file, { ...raw, mcpServers: servers });
}

export class McpConfigError extends Error {}

/** Add a connection, then wait for its first connect so the caller can
 *  show the real result. */
export async function addMcpServer(name: string, config: McpServerConfig, file: string = MCP_CONFIG_FILE): Promise<McpServerStatus> {
	if (!/^[a-z0-9_-]{1,40}$/i.test(name)) throw new McpConfigError("Use letters, numbers, - and _ for the name.");
	editServers(file, (servers) => {
		if (servers[name]) throw new McpConfigError(`A connection named “${name}” already exists.`);
		servers[name] = config;
	});
	return (await mcpStatus(file)).find((s) => s.name === name)!;
}

export interface McpServerPatch {
	disabled?: boolean;
	tools?: Record<string, boolean>;
	/** Setup values by env/header key; masked values ("••••…") are ignored. */
	values?: Record<string, string>;
	rename?: string;
}

export async function updateMcpServer(name: string, patch: McpServerPatch, file: string = MCP_CONFIG_FILE): Promise<McpServerStatus | null> {
	let finalName = name;
	editServers(file, (servers) => {
		const entry = servers[name];
		if (!entry) throw new McpConfigError(`No connection named “${name}”.`);
		let next: McpServerConfig = { ...entry };
		if (patch.disabled !== undefined) {
			if (patch.disabled) next.disabled = true;
			else delete next.disabled;
		}
		if (patch.tools) next.tools = { ...entry.tools, ...patch.tools };
		if (patch.values) {
			const real = Object.fromEntries(Object.entries(patch.values).filter(([, v]) => !v.startsWith("••••")));
			if (isHttpConfig(next)) next = { ...next, headers: { ...next.headers, ...real } };
			else next = { ...next, env: { ...next.env, ...real } };
		}
		if (patch.rename && patch.rename !== name) {
			if (!/^[a-z0-9_-]{1,40}$/i.test(patch.rename)) throw new McpConfigError("Use letters, numbers, - and _ for the name.");
			if (servers[patch.rename]) throw new McpConfigError(`A connection named “${patch.rename}” already exists.`);
			delete servers[name];
			finalName = patch.rename;
		}
		servers[finalName] = next;
	});
	return (await mcpStatus(file)).find((s) => s.name === finalName) ?? null;
}

export async function removeMcpServer(name: string, file: string = MCP_CONFIG_FILE): Promise<void> {
	editServers(file, (servers) => {
		delete servers[name];
	});
	await records(file);
}

/** "Try again": restart one server even though its settings did not change. */
export async function retryMcpServer(name: string, file: string = MCP_CONFIG_FILE): Promise<McpServerStatus | null> {
	const g = lhGlobal();
	const list = await records(file);
	const record = list.find((r) => r.name === name);
	if (!record) return null;
	if (record.client) void record.client.close().catch(() => {});
	const fresh = await connect(newRecord(record.name, record.config));
	const next = list.map((r) => (r.name === name ? fresh : r));
	g.__lhMcpV2 = { mtimeMs: configMtime(file), records: Promise.resolve(next) };
	return statusOf(fresh);
}

/** Close every live client (tests). */
export async function closeMcp(): Promise<void> {
	const g = lhGlobal();
	const current = g.__lhMcpV2;
	if (!current) return;
	g.__lhMcpV2 = undefined;
	await Promise.all((await current.records).map((r) => r.client?.close().catch(() => {})));
}
