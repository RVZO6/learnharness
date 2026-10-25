import * as fs from "node:fs";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	McpClient,
	StdioTransport,
	StreamableHttpTransport,
	toLlmContent,
	type McpTransport,
	type Tool,
} from "@earendil-works/pi-mcp";
import { MCP_CONFIG_FILE } from "../../config.ts";

/**
 * MCP client tools: every tool of every server in MCP_CONFIG_FILE, wrapped
 * as a pi AgentTool named `mcp__<server>__<tool>`. The chat handler awaits
 * mcpTools() per turn and hands the list to the agent factories
 * (AgentBuildOptions.extraTools) — the agent layer never imports this.
 *
 * Config shape (the one Claude Desktop, Cursor, and pi read):
 *   { "mcpServers": {
 *       "canvas": { "command": "canvas-mcp", "args": [], "env": {} },
 *       "remote": { "url": "https://…/mcp", "headers": {} },
 *       "off":    { "command": "x", "disabled": true } } }
 *
 * Connections live on globalThis, NOT module state: Next dev compiles each
 * route as its own module instance (same reason as turn-liveness.ts), and a
 * second instance would spawn a second copy of every stdio server. The
 * file's mtime keys the cache: an edit closes the old clients and connects
 * the new set on the next turn. One server failing to start logs and drops
 * only that server's tools — a broken entry never blocks a lesson.
 */

const CONNECT_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 120_000;
/** Providers allow at most 64 characters of [A-Za-z0-9_-] in a tool name. */
const MAX_TOOL_NAME = 64;

interface StdioServerConfig {
	command: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	disabled?: boolean;
}

interface HttpServerConfig {
	url: string;
	headers?: Record<string, string>;
	disabled?: boolean;
}

type ServerConfig = StdioServerConfig | HttpServerConfig;

interface McpState {
	/** mtime of the config the live clients were built from (null = no file). */
	mtimeMs: number | null;
	clients: McpClient[];
	tools: Promise<AgentTool<any>[]>;
}

interface LhGlobal {
	__lhMcp?: McpState;
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
export function parseMcpConfig(text: string): Record<string, ServerConfig> {
	const raw: unknown = JSON.parse(text);
	const servers = (raw as { mcpServers?: unknown } | null)?.mcpServers;
	if (servers === undefined) return {};
	if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
		throw new Error(`"mcpServers" must be an object`);
	}
	const out: Record<string, ServerConfig> = {};
	for (const [name, entry] of Object.entries(servers)) {
		const e = entry as Partial<StdioServerConfig & HttpServerConfig> | null;
		if (typeof e?.command === "string" || typeof e?.url === "string") out[name] = e as ServerConfig;
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
export function wrapMcpTool(client: McpClient, server: string, tool: Tool, name: string): AgentTool<any> {
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
			return { content: toLlmContent(result), details: undefined, isError: result.isError === true };
		},
	};
}

function transportFor(config: ServerConfig, server: string): McpTransport {
	if ("url" in config) return new StreamableHttpTransport({ url: config.url, headers: config.headers });
	return new StdioTransport({
		command: config.command,
		args: config.args,
		env: config.env,
		cwd: config.cwd,
		onStderr: (chunk) => console.error(`[mcp ${server}] ${chunk.trimEnd()}`),
	});
}

async function connectAll(
	servers: Record<string, ServerConfig>,
	clients: McpClient[],
): Promise<AgentTool<any>[]> {
	const taken = new Set<string>();
	const perServer = await Promise.all(
		Object.entries(servers)
			.filter(([, config]) => !config.disabled)
			.map(async ([server, config]) => {
				const client = new McpClient({ name: "learnharness", version: "1.0.0" });
				clients.push(client);
				try {
					await client.connect(transportFor(config, server));
					const tools = await client.listTools({ timeoutMs: CONNECT_TIMEOUT_MS });
					return { server, client, tools };
				} catch (err) {
					console.error(`[mcp ${server}] failed to start:`, err);
					void client.close().catch(() => {});
					return { server, client, tools: [] as Tool[] };
				}
			}),
	);
	// Name assignment runs in config order AFTER the parallel connects, so
	// the dedupe suffixes are stable across restarts.
	return perServer.flatMap(({ server, client, tools }) =>
		tools.map((tool) => wrapMcpTool(client, server, tool, mcpToolName(server, tool.name, taken))),
	);
}

/** The current MCP tool set — connects on first use and after every config
 *  edit; otherwise returns the cached set. Never throws. */
export function mcpTools(file: string = MCP_CONFIG_FILE): Promise<AgentTool<any>[]> {
	const g = lhGlobal();
	const mtimeMs = configMtime(file);
	const current = g.__lhMcp;
	if (current && current.mtimeMs === mtimeMs) return current.tools;

	for (const client of current?.clients ?? []) void client.close().catch(() => {});
	const clients: McpClient[] = [];
	let tools: Promise<AgentTool<any>[]>;
	if (mtimeMs === null) {
		tools = Promise.resolve([]);
	} else {
		try {
			tools = connectAll(parseMcpConfig(fs.readFileSync(file, "utf-8")), clients);
		} catch (err) {
			console.error(`[mcp] ignoring ${file}:`, err);
			tools = Promise.resolve([]);
		}
	}
	g.__lhMcp = { mtimeMs, clients, tools };
	return tools;
}

/** Close every live client (tests; a config edit closes them itself). */
export async function closeMcp(): Promise<void> {
	const g = lhGlobal();
	const current = g.__lhMcp;
	if (!current) return;
	g.__lhMcp = undefined;
	await Promise.all(current.clients.map((c) => c.close().catch(() => {})));
}
