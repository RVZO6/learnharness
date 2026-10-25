/**
 * MCP connection setup — pure and browser-safe. Shared by the Settings
 * "Connections" UI and the server (src/server/mcp.ts):
 *
 *  - the mcp.json entry shape (the `mcpServers` format other MCP clients use,
 *    plus our own `disabled` and per-tool `tools` overrides),
 *  - parsePastedSetup: turn whatever an app's instructions give the user —
 *    a link, a setup-code block, or a command — into connection entries,
 *  - the plain-language view of a tool (name, "reads" / "changes things",
 *    whether it starts on).
 */

export interface McpStdioConfig {
	command: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
}

export interface McpHttpConfig {
	url: string;
	headers?: Record<string, string>;
}

/** Fields of ours, ignored by other MCP clients that read the same shape. */
export interface McpEntryExtras {
	/** Off: the server is not started and the agent cannot see it. */
	disabled?: boolean;
	/** Per-tool overrides by tool name; absent = toolStartsOn(). */
	tools?: Record<string, boolean>;
}

export type McpServerConfig = (McpStdioConfig | McpHttpConfig) & McpEntryExtras;

export function isHttpConfig(config: McpServerConfig): config is McpHttpConfig & McpEntryExtras {
	return typeof (config as McpHttpConfig).url === "string";
}

// ─── Tools ────────────────────────────────────────────────────────────────

/** The MCP ToolAnnotations hints we read (all optional, all advisory). */
export interface McpToolHints {
	readOnlyHint?: boolean;
	destructiveHint?: boolean;
}

export type McpToolKind = "reads" | "changes" | "unknown";

/** "reads" only when the server says so; "changes" when it says the tool
 *  writes or deletes; most servers say nothing ("unknown"). */
export function mcpToolKind(hints: McpToolHints | undefined): McpToolKind {
	if (hints?.readOnlyHint === true) return "reads";
	if (hints?.readOnlyHint === false || hints?.destructiveHint === true) return "changes";
	return "unknown";
}

/** Tools that say they change things start off; the rest start on. */
export function toolStartsOn(hints: McpToolHints | undefined): boolean {
	return mcpToolKind(hints) !== "changes";
}

export function mcpToolEnabled(config: McpEntryExtras, tool: string, hints: McpToolHints | undefined): boolean {
	return config.tools?.[tool] ?? toolStartsOn(hints);
}

/** "list_course_modules" / "listCourseModules" → "List course modules". */
export function humanizeToolName(name: string): string {
	const words = name
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[_\-.]+/g, " ")
		.trim()
		.toLowerCase();
	return words ? words[0]!.toUpperCase() + words.slice(1) : name;
}

/** The first sentence of a tool or server description, for one-line rows. */
export function firstSentence(text: string | undefined, max = 120): string {
	if (!text) return "";
	const flat = text.replace(/\s+/g, " ").trim();
	const end = flat.search(/[.!?](\s|$)/);
	const sentence = end === -1 ? flat : flat.slice(0, end + 1);
	return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}

/** `mcp__<server>__<tool>` (src/server/mcp.ts) → the connection name, for
 *  transcript labels. Null for every non-MCP tool. */
export function mcpServerOfTool(toolName: string): string | null {
	const m = /^mcp__(.+?)__/.exec(toolName);
	return m ? m[1]! : null;
}

// ─── Setup values the user must give ──────────────────────────────────────

export interface McpSetupField {
	/** "env" values go to a stdio server; "header" values to an http one. */
	where: "env" | "header";
	key: string;
	/** "CANVAS_API_TOKEN" → "Canvas API token". */
	label: string;
	secret: boolean;
	value: string;
	/** Empty or an obvious placeholder ("<your-token>", "YOUR_KEY", "…"). */
	needsValue: boolean;
}

const SECRET_NAME = /(key|token|secret|password|passwd|auth|credential|bearer|cookie)/i;
const ACRONYMS = new Set(["api", "url", "id", "mcp", "lms", "oauth", "http", "https", "ssh", "pat", "uri", "dsn"]);

export function isPlaceholderValue(value: string): boolean {
	const v = value.trim();
	if (!v) return true;
	return (
		/^<.*>$/.test(v) ||
		/^\{\{.*\}\}$/.test(v) ||
		/^\$\{.*\}$/.test(v) ||
		/^(your|my)[-_ ]/i.test(v) ||
		/^(x{3,}|\.{3}|…|changeme|replace[-_ ]?me|todo|<redacted>)$/i.test(v) ||
		/(^|[-_ ])here$/i.test(v)
	);
}

export function fieldLabel(key: string): string {
	const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[_\-\s]+/).filter(Boolean);
	return words
		.map((w, i) => {
			const lower = w.toLowerCase();
			if (ACRONYMS.has(lower)) return lower.toUpperCase();
			return i === 0 ? lower[0]!.toUpperCase() + lower.slice(1) : lower;
		})
		.join(" ");
}

/** Every env var / header of a config as a form field, in config order. */
export function setupFields(config: McpServerConfig): McpSetupField[] {
	const entries = isHttpConfig(config)
		? Object.entries(config.headers ?? {}).map(([key, value]) => ({ where: "header" as const, key, value }))
		: Object.entries(config.env ?? {}).map(([key, value]) => ({ where: "env" as const, key, value }));
	return entries.map(({ where, key, value }) => {
		// "Authorization: Bearer <token>" — the secret is the part after Bearer.
		const bearer = where === "header" && /^authorization$/i.test(key) ? /^Bearer\s+(.*)$/i.exec(value) : null;
		const checked = bearer ? bearer[1]! : value;
		return {
			where,
			key,
			label: where === "header" && /^authorization$/i.test(key) ? "Access token" : fieldLabel(key),
			secret: SECRET_NAME.test(key),
			value,
			needsValue: isPlaceholderValue(checked),
		};
	});
}

/** Write field values back into a config (headers keep "Bearer " when the
 *  user typed only the token). */
export function applySetupFields(config: McpServerConfig, values: Record<string, string>): McpServerConfig {
	if (isHttpConfig(config)) {
		const headers = { ...config.headers };
		for (const [key, raw] of Object.entries(values)) {
			const value = raw.trim();
			headers[key] = /^authorization$/i.test(key) && value && !/^(bearer|basic)\s/i.test(value) ? `Bearer ${value}` : value;
		}
		return { ...config, headers };
	}
	const env = { ...config.env };
	for (const [key, value] of Object.entries(values)) env[key] = value.trim();
	return { ...config, env };
}

/** The plain-words description of what connecting does, for the review
 *  step's warning. */
export function describeLaunch(config: McpServerConfig): { kind: "program" | "online"; what: string; source?: string } {
	if (isHttpConfig(config)) {
		let host = config.url;
		try {
			host = new URL(config.url).host;
		} catch {
			/* shown as given */
		}
		return { kind: "online", what: host };
	}
	const base = config.command.split(/[\\/]/).pop() ?? config.command;
	const args = config.args ?? [];
	const pkg = args.find((a) => !a.startsWith("-"));
	if (base === "npx" || base === "bunx" || base === "pnpm" || base === "pnpx") return { kind: "program", what: pkg ?? base, source: "npm" };
	if (base === "uvx" || base === "pipx") return { kind: "program", what: pkg ?? base, source: "PyPI" };
	if (base === "docker") return { kind: "program", what: args.filter((a) => !a.startsWith("-")).pop() ?? "a Docker image", source: "Docker" };
	return { kind: "program", what: [config.command, ...args].join(" ") };
}

// ─── Parsing a paste ──────────────────────────────────────────────────────

export interface ParsedServer {
	name: string;
	config: McpServerConfig;
}

export type PasteResult =
	| { kind: "empty" }
	| { kind: "link" | "code" | "command"; servers: ParsedServer[] }
	| { kind: "unknown"; reason: string };

/** A connection name that survives tool naming (mcp__<name>__…). */
export function safeServerName(raw: string): string {
	const name = raw
		.trim()
		.toLowerCase()
		.replace(/^@[^/]+\//, "")
		.replace(/[-_]?mcp([-_]?server)?$/, "")
		.replace(/^mcp[-_]?(server[-_]?)?/, "")
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return name || "connection";
}

function nameFromUrl(url: string): string {
	try {
		const u = new URL(url);
		const parts = u.hostname.split(".").filter((p) => !["www", "mcp", "api", "com", "net", "org", "io", "app", "dev", "ai"].includes(p));
		return safeServerName(parts[0] ?? u.hostname);
	} catch {
		return "connection";
	}
}

function nameFromCommand(command: string, args: string[]): string {
	const pkg = args.find((a) => !a.startsWith("-") && !/^(run|exec|dlx|x|--)$/.test(a));
	const raw = pkg ?? command;
	return safeServerName((raw.replace(/@[\d^~][^/]*$/, "").split("/").pop() ?? raw).replace(/\.(?:[cm]?js|ts|py|sh)$/i, ""));
}

/** Shell-like word split: quotes and backslash escapes, no expansion. */
export function splitCommandLine(line: string): string[] {
	const out: string[] = [];
	let cur = "";
	let quote: '"' | "'" | null = null;
	let has = false;
	for (let i = 0; i < line.length; i++) {
		const c = line[i]!;
		if (quote) {
			if (c === quote) quote = null;
			else if (c === "\\" && quote === '"' && i + 1 < line.length) cur += line[++i];
			else cur += c;
		} else if (c === '"' || c === "'") {
			quote = c;
			has = true;
		} else if (c === "\\" && i + 1 < line.length) {
			cur += line[++i];
			has = true;
		} else if (/\s/.test(c)) {
			if (has || cur) out.push(cur);
			cur = "";
			has = false;
		} else {
			cur += c;
			has = true;
		}
	}
	if (has || cur) out.push(cur);
	return out;
}

/** Lenient JSON for pasted snippets: comments, trailing commas, and a
 *  fragment without the outer braces ("canvas": { … }). */
function parseLooseJson(text: string): unknown {
	const cleaned = text
		.replace(/^\s*\/\/.*$/gm, "")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/,\s*([}\]])/g, "$1")
		.trim();
	try {
		return JSON.parse(cleaned);
	} catch {
		return JSON.parse(`{${cleaned.replace(/,\s*$/, "")}}`);
	}
}

function asEntry(value: unknown): McpServerConfig | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const v = value as Record<string, unknown>;
	const strings = (r: unknown) =>
		r && typeof r === "object" && !Array.isArray(r)
			? Object.fromEntries(Object.entries(r as Record<string, unknown>).map(([k, x]) => [k, String(x ?? "")]))
			: undefined;
	if (typeof v.url === "string" || typeof v.serverUrl === "string") {
		const headers = strings(v.headers);
		return { url: (v.url ?? v.serverUrl) as string, ...(headers ? { headers } : {}) };
	}
	if (typeof v.command === "string") {
		// Some docs write the whole command line in "command".
		const words = Array.isArray(v.args) ? [v.command] : splitCommandLine(v.command);
		const args = Array.isArray(v.args) ? v.args.map(String) : words.slice(1);
		const env = strings(v.env);
		return {
			command: words[0] ?? v.command,
			...(args.length ? { args } : {}),
			...(env ? { env } : {}),
			...(typeof v.cwd === "string" ? { cwd: v.cwd } : {}),
		};
	}
	return null;
}

function parseCode(text: string): ParsedServer[] {
	const raw = parseLooseJson(text) as Record<string, unknown>;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
	// Claude Desktop / Cursor: mcpServers; VS Code: servers (also under "mcp").
	const container =
		(raw.mcpServers as Record<string, unknown>) ??
		(raw.servers as Record<string, unknown>) ??
		((raw.mcp as Record<string, unknown> | undefined)?.servers as Record<string, unknown>);
	const single = asEntry(raw);
	if (single) {
		const name = isHttpConfig(single) ? nameFromUrl(single.url) : nameFromCommand(single.command, single.args ?? []);
		return [{ name, config: single }];
	}
	const source = container && typeof container === "object" ? container : raw;
	return Object.entries(source).flatMap(([name, value]) => {
		const config = asEntry(value);
		return config ? [{ name: safeServerName(name), config }] : [];
	});
}

/** `claude mcp add [opts] <name> <url>` / `claude mcp add [opts] <name> -- <cmd> …`
 *  and `codex mcp add <name> -- <cmd> …`: the most common one-liners in
 *  setup docs. */
function parseAgentCliAdd(words: string[]): ParsedServer | null {
	const at = words.findIndex((w, i) => w === "add" && words[i - 1] === "mcp");
	if (at === -1 || !/^(claude|codex|gemini)$/.test(words[0] ?? "")) return null;
	const env: Record<string, string> = {};
	const headers: Record<string, string> = {};
	let transport = "";
	let name = "";
	let i = at + 1;
	const rest: string[] = [];
	for (; i < words.length; i++) {
		const w = words[i]!;
		if (w === "--") {
			rest.push(...words.slice(i + 1));
			break;
		}
		if (w === "-e" || w === "--env") {
			const [k, ...v] = (words[++i] ?? "").split("=");
			if (k) env[k] = v.join("=");
		} else if (w === "-H" || w === "--header") {
			const [k, ...v] = (words[++i] ?? "").split(":");
			if (k) headers[k.trim()] = v.join(":").trim();
		} else if (w === "-t" || w === "--transport") transport = words[++i] ?? "";
		else if (w === "-s" || w === "--scope") i++;
		else if (w.startsWith("-")) continue;
		else if (!name) name = w;
		else rest.push(w);
	}
	if (!name || rest.length === 0) return null;
	if (/^https?:\/\//.test(rest[0]!) || transport === "http" || transport === "sse") {
		return { name: safeServerName(name), config: { url: rest[0]!, ...(Object.keys(headers).length ? { headers } : {}) } };
	}
	return {
		name: safeServerName(name),
		config: { command: rest[0]!, ...(rest.length > 1 ? { args: rest.slice(1) } : {}), ...(Object.keys(env).length ? { env } : {}) },
	};
}

function parseCommand(line: string): ParsedServer | null {
	const words = splitCommandLine(line.replace(/\\\n/g, " "));
	const viaCli = parseAgentCliAdd(words);
	if (viaCli) return viaCli;
	const env: Record<string, string> = {};
	while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) {
		const [k, ...v] = words.shift()!.split("=");
		env[k!] = v.join("=");
	}
	if (words[0] === "env") words.shift();
	const command = words[0];
	if (!command || !/^[\w./@~-]+$/.test(command)) return null;
	const args = words.slice(1);
	return {
		name: nameFromCommand(command, args),
		config: { command, ...(args.length ? { args } : {}), ...(Object.keys(env).length ? { env } : {}) },
	};
}

export function parsePastedSetup(text: string): PasteResult {
	const t = text.trim().replace(/^```[a-z]*\n?|```$/g, "").trim();
	if (!t) return { kind: "empty" };
	if (/^https?:\/\/\S+$/.test(t)) return { kind: "link", servers: [{ name: nameFromUrl(t), config: { url: t } }] };
	if (/^[{"]/.test(t)) {
		try {
			const servers = parseCode(t);
			if (servers.length) return { kind: "code", servers };
			return { kind: "unknown", reason: "The setup code has no connection in it (no \"command\" or \"url\")." };
		} catch {
			return { kind: "unknown", reason: "The setup code looks incomplete. Copy the whole block, including the first and last brace." };
		}
	}
	if (!t.includes("\n") || /\\\n/.test(t)) {
		const parsed = parseCommand(t);
		if (parsed) return { kind: "command", servers: [parsed] };
	}
	return { kind: "unknown", reason: "Paste the link, setup code, or command exactly as the instructions show it." };
}
