"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { Hint } from "@/components/ui/hint";
import {
	applySetupFields,
	describeLaunch,
	humanizeToolName,
	parsePastedSetup,
	safeServerName,
	setupFields,
	splitCommandLine,
	type McpServerConfig,
	type ParsedServer,
} from "@/src/core";
import { SettingsGroup, Toggle } from "./controls";

/**
 * Settings → Connections: the learner's MCP servers (src/server/mcp.ts via
 * app/api/mcp). Written for people who have never heard of MCP: one paste
 * box takes whatever an app's setup instructions give (a link, setup code,
 * or a command), a review step asks only for what is missing, and each
 * tool reads as a plain "ability" with a reads / changes-things tag.
 * Technical detail (the stored entry, the server's output) stays folded.
 *
 * Five views in one section: the list, add (paste), manual setup, review,
 * and one connection.
 */

interface ToolStatus {
	name: string;
	title: string;
	description: string;
	kind: "reads" | "changes" | "unknown";
	enabled: boolean;
}

interface ServerStatus {
	name: string;
	state: "connected" | "error" | "off";
	transport: "program" | "online";
	summary: string;
	error?: string;
	missing?: { name: string; url: string };
	details: string;
	tools: ToolStatus[];
	config: McpServerConfig;
	fields: { where: "env" | "header"; key: string; label: string; secret: boolean; value: string }[];
}

type View =
	| { kind: "list" }
	| { kind: "add" }
	| { kind: "manual" }
	| { kind: "review"; parsed: ParsedServer }
	| { kind: "detail"; name: string };

const LINK = "text-xs text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline disabled:opacity-40";
const LINK_SMALL = "text-[10px] text-muted-foreground/60 underline-offset-2 hover:text-foreground hover:underline";
const INPUT =
	"h-7 w-full min-w-0 rounded-sm border border-border bg-background px-1.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-muted-foreground/50";

async function api<T>(url: string, init?: RequestInit): Promise<T> {
	const res = await fetch(url, init);
	const body = (await res.json().catch(() => ({}))) as T & { error?: string };
	if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
	return body;
}

function displayName(name: string): string {
	return name.length ? name[0]!.toUpperCase() + name.slice(1).replace(/[-_]+/g, " ") : name;
}

function statusLine(s: ServerStatus): string {
	if (s.state === "off") return "off";
	if (s.state === "error") return "couldn’t start";
	const on = s.tools.filter((t) => t.enabled).length;
	return on === s.tools.length ? `${on} abilit${on === 1 ? "y" : "ies"}` : `${on} of ${s.tools.length} abilities`;
}

export function ConnectionsSection() {
	const [servers, setServers] = useState<ServerStatus[] | null>(null);
	const [view, setView] = useState<View>({ kind: "list" });
	const [loadError, setLoadError] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			setServers((await api<{ servers: ServerStatus[] }>("/api/mcp")).servers);
			setLoadError(null);
		} catch (e) {
			setLoadError(e instanceof Error ? e.message : "Could not load connections");
		}
	}, []);
	useEffect(() => {
		void load();
	}, [load]);

	const replace = (server: ServerStatus, oldName = server.name) =>
		setServers((list) => {
			const rest = (list ?? []).filter((s) => s.name !== oldName && s.name !== server.name);
			const at = (list ?? []).findIndex((s) => s.name === oldName);
			if (at === -1) return [...rest, server];
			rest.splice(Math.min(at, rest.length), 0, server);
			return rest;
		});

	if (view.kind === "add") {
		return (
			<AddView
				onBack={() => setView({ kind: "list" })}
				onParsed={(parsed) => setView({ kind: "review", parsed })}
				onManual={() => setView({ kind: "manual" })}
			/>
		);
	}
	if (view.kind === "manual") {
		return (
			<ManualView
				taken={new Set((servers ?? []).map((s) => s.name))}
				onBack={() => setView({ kind: "add" })}
				onCancel={() => setView({ kind: "list" })}
				onAdded={(server) => {
					replace(server);
					setView({ kind: "detail", name: server.name });
				}}
			/>
		);
	}
	if (view.kind === "review") {
		return (
			<ReviewView
				parsed={view.parsed}
				taken={new Set((servers ?? []).map((s) => s.name))}
				onBack={() => setView({ kind: "add" })}
				onCancel={() => setView({ kind: "list" })}
				onAdded={(server) => {
					replace(server);
					setView({ kind: "detail", name: server.name });
				}}
			/>
		);
	}
	if (view.kind === "detail") {
		const server = servers?.find((s) => s.name === view.name);
		if (server) {
			return (
				<DetailView
					server={server}
					onBack={() => setView({ kind: "list" })}
					onChange={(next, oldName) => {
						replace(next, oldName);
						if (next.name !== view.name) setView({ kind: "detail", name: next.name });
					}}
					onRemoved={() => {
						setServers((list) => (list ?? []).filter((s) => s.name !== view.name));
						setView({ kind: "list" });
					}}
				/>
			);
		}
	}

	return (
		<div data-testid="connections-list">
			{loadError && <p role="alert" className="px-1 text-xs text-red-500">{loadError}</p>}
			{servers === null && !loadError && <p className="px-1 text-xs text-muted-foreground/70">Loading connections…</p>}
			<div className="flex flex-col">
				{servers?.map((s) => (
					<ServerRow
						key={s.name}
						server={s}
						onOpen={() => setView({ kind: "detail", name: s.name })}
						onChange={(next) => replace(next)}
					/>
				))}
			</div>
			<button type="button" onClick={() => setView({ kind: "add" })} data-testid="connections-add" className="block text-xs text-foreground underline-offset-2 hover:underline">
				+ Add a connection
			</button>
		</div>
	);
}

function ServerRow({ server: s, onOpen, onChange }: { server: ServerStatus; onOpen: () => void; onChange: (s: ServerStatus) => void }) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	async function run(init: RequestInit) {
		setBusy(true);
		setError(null);
		try {
			onChange((await api<{ server: ServerStatus }>(`/api/mcp/${encodeURIComponent(s.name)}`, init)).server);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed");
		}
		setBusy(false);
	}
	return (
		<div data-testid={`connection-${s.name}`}>
			<div className="flex items-center gap-3 rounded-sm px-1 py-1.5 transition-colors hover:bg-accent/50">
				<button type="button" onClick={onOpen} className="flex min-w-0 flex-1 cursor-pointer items-center justify-between gap-3 text-left">
					<span className="min-w-0">
						<span className="block font-ui text-xs text-foreground">{displayName(s.name)}</span>
						{s.summary && <span className="block truncate text-xs text-muted-foreground/70">{s.summary}</span>}
					</span>
					<span className={`shrink-0 font-mono text-[11px] ${s.state === "error" ? "text-red-500" : "text-muted-foreground"}`}>
						{busy ? "…" : statusLine(s)}
					</span>
				</button>
				<Toggle
					checked={s.state !== "off"}
					disabled={busy}
					label={`${s.name} connection`}
					onChange={(on) => void run({ method: "PATCH", body: JSON.stringify({ disabled: !on }) })}
				/>
			</div>
			{s.state === "error" && (
				<div className="px-1 pb-1.5 text-xs">
					<p className="text-red-500/90">{s.error}</p>
					<span className="mt-0.5 flex gap-3">
						{s.missing && (
							<a href={s.missing.url} target="_blank" rel="noreferrer" className={LINK}>
								Get {s.missing.name} ↗
							</a>
						)}
						<button type="button" disabled={busy} onClick={() => void run({ method: "POST" })} className={LINK}>
							Try again
						</button>
						<button type="button" onClick={onOpen} className={LINK}>
							Details
						</button>
					</span>
				</div>
			)}
			{error && <p role="alert" className="px-1 text-xs text-red-500">{error}</p>}
		</div>
	);
}

function BackLink({ onClick, label }: { onClick: () => void; label: string }) {
	return (
		<button type="button" onClick={onClick} className={`mb-1 self-start ${LINK}`}>
			← {label}
		</button>
	);
}

function AddView({ onBack, onParsed, onManual }: { onBack: () => void; onParsed: (p: ParsedServer) => void; onManual: () => void }) {
	const [text, setText] = useState("");
	const result = useMemo(() => parsePastedSetup(text), [text]);
	const servers = result.kind === "link" || result.kind === "code" || result.kind === "command" ? result.servers : [];
	const found =
		result.kind === "link"
			? "a link to an online connection"
			: result.kind === "command"
				? "a command that starts a program on this Mac"
				: result.kind === "code"
					? servers.length === 1
						? `setup code for one connection: ${servers[0]!.name}`
						: `setup code for ${servers.length} connections`
					: "";
	return (
		<div className="flex flex-col gap-2" data-testid="connections-add-view">
			<BackLink onClick={onBack} label="Connections" />
			<p className="font-prose text-(length:--lh-prose-size)">Add a connection</p>
			<p className="text-xs text-muted-foreground">Paste the setup from the app’s MCP instructions: a link, setup code, or a command.</p>
			<textarea
				value={text}
				onChange={(e) => setText(e.target.value)}
				placeholder="Paste the link, setup code, or command from the app’s instructions"
				aria-label="Connection setup"
				data-testid="connections-paste"
				autoFocus
				spellCheck={false}
				className="h-28 w-full resize-none rounded-sm border border-border bg-background p-2 font-mono text-xs leading-relaxed text-foreground outline-none placeholder:font-prose placeholder:text-sm placeholder:text-muted-foreground/60 focus:border-muted-foreground/50"
			/>
			<div className="min-h-5 text-xs" data-testid="connections-detect">
				{result.kind === "unknown" && <span className="text-muted-foreground">{result.reason}</span>}
				{servers.length === 1 && (
					<span className="text-muted-foreground">
						Found {found}.{" "}
						<button type="button" onClick={() => onParsed(servers[0]!)} className="text-foreground underline-offset-2 hover:underline">
							Continue →
						</button>
					</span>
				)}
				{servers.length > 1 && (
					<span className="text-muted-foreground">
						Found {found}. Add one at a time:{" "}
						{servers.map((s) => (
							<button key={s.name} type="button" onClick={() => onParsed(s)} className="mr-2 text-foreground underline-offset-2 hover:underline">
								{s.name} →
							</button>
						))}
					</span>
				)}
			</div>
			<button type="button" onClick={onManual} data-testid="connections-manual" className={`self-start ${LINK}`}>
				Set up manually instead
			</button>
		</div>
	);
}

function ReviewView({
	parsed,
	taken,
	onBack,
	onCancel,
	onAdded,
}: {
	parsed: ParsedServer;
	taken: Set<string>;
	onBack: () => void;
	onCancel: () => void;
	onAdded: (s: ServerStatus) => void;
}) {
	const fields = useMemo(() => setupFields(parsed.config), [parsed]);
	const [name, setName] = useState(() => {
		let n = parsed.name;
		for (let i = 2; taken.has(n); i++) n = `${parsed.name}-${i}`;
		return n;
	});
	const [values, setValues] = useState<Record<string, string>>(() =>
		Object.fromEntries(fields.map((f) => [f.key, f.needsValue ? "" : f.where === "header" && /^authorization$/i.test(f.key) ? f.value.replace(/^Bearer\s+/i, "") : f.value])),
	);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const missing = fields.filter((f) => !values[f.key]?.trim()).length;

	async function connect() {
		setBusy(true);
		setError(null);
		try {
			const config = applySetupFields(parsed.config, values);
			onAdded((await api<{ server: ServerStatus }>("/api/mcp", { method: "POST", body: JSON.stringify({ name, config }) })).server);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed");
			setBusy(false);
		}
	}

	return (
		<div className="flex flex-col gap-3" data-testid="connections-review">
			<BackLink onClick={onBack} label="Back" />
			<label className="flex items-center gap-2">
				<span className="shrink-0 font-ui text-xs text-muted-foreground">Name</span>
				<input
					value={name}
					onChange={(e) => setName(e.target.value.replace(/[^a-zA-Z0-9_-]/g, "-"))}
					aria-label="Connection name"
					className={`${INPUT} max-w-56`}
				/>
			</label>
			<LaunchWarning config={parsed.config} />
			{fields.length > 0 && (
				<SettingsGroup label={fields.length === 1 ? "It needs one thing from you" : `It needs ${fields.length} things from you`}>
					{fields.map((f) => (
						<label key={f.key} className="flex flex-col gap-1">
							<span className="flex items-baseline justify-between gap-2">
								<span className="font-prose text-(length:--lh-prose-size)">{f.label}</span>
								<span className="font-mono text-[10px] text-muted-foreground/60">{f.key}</span>
							</span>
							<input
								type={f.secret ? "password" : "text"}
								value={values[f.key] ?? ""}
								onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
								placeholder={f.secret ? "Paste it here" : ""}
								autoComplete="off"
								spellCheck={false}
								className={INPUT}
							/>
						</label>
					))}
					<p className="text-xs text-muted-foreground/70">These stay on this Mac, in LearnHarness’s data folder.</p>
				</SettingsGroup>
			)}
			<details className="group">
				<summary className="flex cursor-pointer list-none items-center gap-1 text-xs text-muted-foreground/70 [&::-webkit-details-marker]:hidden">
					<ChevronRight className="size-3 transition-transform group-open:rotate-90" />
					Setup code
				</summary>
				<pre className="mt-2 max-h-40 overflow-auto rounded-sm border border-border bg-background p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
					{JSON.stringify({ [name]: parsed.config }, null, 2)}
				</pre>
			</details>
			{error && <p role="alert" className="text-xs text-red-500">{error}</p>}
			<div className="flex items-center gap-4">
				<button
					type="button"
					onClick={() => void connect()}
					disabled={busy || missing > 0 || !name}
					data-testid="connections-connect"
					className="rounded-sm bg-foreground px-3 py-1 font-ui text-xs text-background disabled:opacity-40"
				>
					{busy ? "Connecting…" : "Connect"}
				</button>
				<button type="button" onClick={onCancel} disabled={busy} className={LINK}>
					Cancel
				</button>
				{missing > 0 && <span className="text-xs text-muted-foreground/70">{missing === 1 ? "Fill in the empty field." : `Fill in the ${missing} empty fields.`}</span>}
			</div>
		</div>
	);
}

function LaunchWarning({ config }: { config: McpServerConfig }) {
	const launch = describeLaunch(config);
	return (
		<div className="rounded-sm border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs leading-relaxed text-amber-200/90">
			{launch.kind === "program" ? (
				<>
					This runs a program on this Mac: <code className="font-mono text-foreground">{launch.what}</code>
					{launch.source ? `, downloaded from ${launch.source}` : ""}. It can do anything a program on this Mac can do. Add connections only from sources you trust.
				</>
			) : (
				<>
					This connects to <code className="font-mono text-foreground">{launch.what}</code>. What the teacher looks up there, and what it sends, leaves this Mac. Add connections only from services you trust.
				</>
			)}
		</div>
	);
}

type ManualKind = "program" | "online";

function ManualView({
	taken,
	onBack,
	onCancel,
	onAdded,
}: {
	taken: Set<string>;
	onBack: () => void;
	onCancel: () => void;
	onAdded: (s: ServerStatus) => void;
}) {
	const [kind, setKind] = useState<ManualKind>("program");
	const [name, setName] = useState("");
	const [nameEdited, setNameEdited] = useState(false);
	const [command, setCommand] = useState("");
	const [vars, setVars] = useState<{ key: string; value: string }[]>([]);
	const [url, setUrl] = useState("");
	const [token, setToken] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const config = useMemo<McpServerConfig | null>(() => {
		if (kind === "online") {
			if (!/^https?:\/\/\S+$/.test(url.trim())) return null;
			return { url: url.trim(), ...(token.trim() ? { headers: { Authorization: `Bearer ${token.trim()}` } } : {}) };
		}
		const words = splitCommandLine(command.trim());
		if (!words[0]) return null;
		const env = Object.fromEntries(vars.filter((v) => v.key.trim()).map((v) => [v.key.trim(), v.value]));
		return { command: words[0], ...(words.length > 1 ? { args: words.slice(1) } : {}), ...(Object.keys(env).length ? { env } : {}) };
	}, [kind, command, vars, url, token]);

	// The name follows the command or link until the user types their own.
	const suggested = useMemo(() => {
		const parsed = config ? parsePastedSetup(kind === "online" ? url : command) : null;
		const base = parsed && "servers" in parsed ? parsed.servers[0]!.name : safeServerName(kind === "online" ? url : command);
		let n = base;
		for (let i = 2; taken.has(n); i++) n = `${base}-${i}`;
		return n;
	}, [config, kind, url, command, taken]);
	const finalName = nameEdited ? name : config ? suggested : "";

	async function connect() {
		if (!config) return;
		setBusy(true);
		setError(null);
		try {
			onAdded((await api<{ server: ServerStatus }>("/api/mcp", { method: "POST", body: JSON.stringify({ name: finalName, config }) })).server);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed");
			setBusy(false);
		}
	}

	const tab = (k: ManualKind, label: string) => (
		<button
			type="button"
			onClick={() => setKind(k)}
			aria-pressed={kind === k}
			className={`rounded-sm px-2 py-1 font-ui text-xs transition-colors ${kind === k ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`}
		>
			{label}
		</button>
	);

	return (
		<div className="flex flex-col gap-3" data-testid="connections-manual-view">
			<BackLink onClick={onBack} label="Back" />
			<p className="font-prose text-(length:--lh-prose-size)">Set up manually</p>
			<div className="flex gap-1">
				{tab("program", "Program on this Mac")}
				{tab("online", "Online")}
			</div>

			{kind === "program" ? (
				<>
					<label className="flex flex-col gap-1">
						<span className="font-ui text-xs text-foreground">Command</span>
						<input
							value={command}
							onChange={(e) => setCommand(e.target.value)}
							placeholder="npx -y some-mcp-server"
							spellCheck={false}
							autoFocus
							data-testid="manual-command"
							className={INPUT}
						/>
						<span className="text-xs text-muted-foreground/70">The program and its arguments, as you would type them in Terminal.</span>
					</label>
					<div className="flex flex-col gap-1">
						<span className="font-ui text-xs text-foreground">Variables</span>
						{vars.map((v, i) => (
							<div key={i} className="flex items-center gap-2">
								<input
									value={v.key}
									onChange={(e) => setVars((all) => all.map((x, j) => (j === i ? { ...x, key: e.target.value.replace(/\s/g, "_") } : x)))}
									placeholder="NAME"
									aria-label="Variable name"
									spellCheck={false}
									className={`${INPUT} max-w-48`}
								/>
								<input
									type={/(key|token|secret|password)/i.test(v.key) ? "password" : "text"}
									value={v.value}
									onChange={(e) => setVars((all) => all.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
									placeholder="value"
									aria-label="Variable value"
									autoComplete="off"
									spellCheck={false}
									className={INPUT}
								/>
								<button type="button" onClick={() => setVars((all) => all.filter((_, j) => j !== i))} aria-label="Remove variable" className={`shrink-0 ${LINK}`}>
									×
								</button>
							</div>
						))}
						<button type="button" onClick={() => setVars((all) => [...all, { key: "", value: "" }])} className={`self-start ${LINK}`}>
							+ Add variable
						</button>
					</div>
				</>
			) : (
				<>
					<label className="flex flex-col gap-1">
						<span className="font-ui text-xs text-foreground">Link</span>
						<input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/mcp" spellCheck={false} autoFocus data-testid="manual-url" className={INPUT} />
					</label>
					<label className="flex flex-col gap-1">
						<span className="font-ui text-xs text-foreground">
							Access token <span className="text-muted-foreground/60">(if the service gave you one)</span>
						</span>
						<input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" spellCheck={false} className={INPUT} />
					</label>
				</>
			)}

			<label className="flex items-center gap-2">
				<span className="shrink-0 font-ui text-xs text-muted-foreground">Name</span>
				<input
					value={finalName}
					onChange={(e) => {
						setNameEdited(true);
						setName(e.target.value.replace(/[^a-zA-Z0-9_-]/g, "-"));
					}}
					aria-label="Connection name"
					className={`${INPUT} max-w-56`}
				/>
			</label>

			{config && <LaunchWarning config={config} />}
			{error && <p role="alert" className="text-xs text-red-500">{error}</p>}
			<div className="flex items-center gap-4">
				<button
					type="button"
					onClick={() => void connect()}
					disabled={busy || !config || !finalName}
					data-testid="manual-connect"
					className="rounded-sm bg-foreground px-3 py-1 font-ui text-xs text-background disabled:opacity-40"
				>
					{busy ? "Connecting…" : "Connect"}
				</button>
				<button type="button" onClick={onCancel} disabled={busy} className={LINK}>
					Cancel
				</button>
			</div>
		</div>
	);
}

function DetailView({
	server: s,
	onBack,
	onChange,
	onRemoved,
}: {
	server: ServerStatus;
	onBack: () => void;
	onChange: (s: ServerStatus, oldName: string) => void;
	onRemoved: () => void;
}) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [editing, setEditing] = useState<string | null>(null);
	const [draft, setDraft] = useState("");
	const [confirmRemove, setConfirmRemove] = useState(false);
	const url = `/api/mcp/${encodeURIComponent(s.name)}`;

	async function run(init: RequestInit) {
		setBusy(true);
		setError(null);
		try {
			onChange((await api<{ server: ServerStatus }>(url, init)).server, s.name);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed");
		}
		setBusy(false);
	}
	const patch = (body: object) => run({ method: "PATCH", body: JSON.stringify(body) });

	async function remove() {
		setBusy(true);
		try {
			await api(url, { method: "DELETE" });
			onRemoved();
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed");
			setBusy(false);
		}
	}

	const anyChanges = s.tools.some((t) => t.kind === "changes");

	return (
		<div className="flex flex-col gap-3" data-testid="connection-detail">
			<BackLink onClick={onBack} label="Connections" />
			<div className="flex items-center justify-between gap-3">
				<span className="min-w-0">
					<span className="block font-prose text-(length:--lh-prose-size)">{displayName(s.name)}</span>
					{s.summary && <span className="block text-xs text-muted-foreground/70">{s.summary}</span>}
				</span>
				<span className="flex shrink-0 items-center gap-3">
					<span className={`font-mono text-[11px] ${s.state === "error" ? "text-red-500" : "text-muted-foreground"}`}>
						{busy ? "…" : s.state === "connected" ? "connected" : s.state === "off" ? "off" : "couldn’t start"}
					</span>
					<Toggle checked={s.state !== "off"} disabled={busy} label={`${s.name} connection`} onChange={(on) => void patch({ disabled: !on })} />
				</span>
			</div>

			{s.state === "error" && (
				<div className="text-xs">
					<p className="text-red-500/90">{s.error}</p>
					<span className="mt-0.5 flex gap-3">
						{s.missing && (
							<a href={s.missing.url} target="_blank" rel="noreferrer" className={LINK}>
								Get {s.missing.name} ↗
							</a>
						)}
						<button type="button" disabled={busy} onClick={() => void run({ method: "POST" })} className={LINK}>
							Try again
						</button>
					</span>
				</div>
			)}

			{s.tools.length > 0 && (
				<SettingsGroup label="What the teacher can do">
					{s.tools.map((t) => (
						<div key={t.name} className="flex items-center justify-between gap-3 py-0.5" data-testid={`ability-${t.name}`}>
							<span className="min-w-0">
								<span className="block font-prose text-(length:--lh-prose-size)">{t.title || humanizeToolName(t.name)}</span>
								{t.description && <span className="block text-xs text-muted-foreground/70">{t.description}</span>}
							</span>
							<span className="flex shrink-0 items-center gap-2">
								{t.kind === "reads" && <span className="font-mono text-[10px] text-muted-foreground/60">reads</span>}
								{t.kind === "changes" && <span className="font-mono text-[10px] text-amber-400/80">changes things</span>}
								<Toggle checked={t.enabled} disabled={busy || s.state === "off"} label={`${s.name} ${t.name}`} onChange={(on) => void patch({ tools: { [t.name]: on } })} />
							</span>
						</div>
					))}
					{anyChanges && <p className="text-xs text-muted-foreground/70">Abilities that change things start off.</p>}
				</SettingsGroup>
			)}

			{s.fields.length > 0 && (
				<SettingsGroup label="Setup">
					{s.fields.map((f) =>
						editing === f.key ? (
							<div key={f.key} className="flex items-center gap-2">
								<span className="shrink-0 font-ui text-xs text-foreground">{f.label}</span>
								<input
									type={f.secret ? "password" : "text"}
									value={draft}
									onChange={(e) => setDraft(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === "Enter" && draft.trim()) {
											void patch({ values: applyOne(s, f.key, draft) }).then(() => setEditing(null));
										}
										if (e.key === "Escape") setEditing(null);
									}}
									autoFocus
									spellCheck={false}
									className={INPUT}
								/>
								<button type="button" disabled={busy || !draft.trim()} onClick={() => void patch({ values: applyOne(s, f.key, draft) }).then(() => setEditing(null))} className="shrink-0 text-xs text-foreground underline-offset-2 hover:underline disabled:text-muted-foreground/40">
									Save
								</button>
								<button type="button" onClick={() => setEditing(null)} className={`shrink-0 ${LINK}`}>
									Cancel
								</button>
							</div>
						) : (
							<button
								key={f.key}
								type="button"
								onClick={() => {
									setEditing(f.key);
									setDraft(f.secret ? "" : f.value);
								}}
								className="flex items-center justify-between gap-3 rounded-sm px-1 py-1.5 text-left transition-colors hover:bg-accent/50"
							>
								<span className="font-ui text-xs text-foreground">{f.label}</span>
								<span className="truncate font-mono text-[11px] text-muted-foreground">{f.value || "not set"}</span>
							</button>
						),
					)}
				</SettingsGroup>
			)}

			<details className="group">
				<summary className="flex cursor-pointer list-none items-center gap-1 text-xs text-muted-foreground/70 [&::-webkit-details-marker]:hidden">
					<ChevronRight className="size-3 transition-transform group-open:rotate-90" />
					Technical details
				</summary>
				<pre className="mt-2 max-h-48 overflow-auto rounded-sm border border-border bg-background p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
					{JSON.stringify({ [s.name]: s.config }, null, 2)}
					{s.details ? `\n\n${s.details}` : ""}
				</pre>
			</details>

			{error && <p role="alert" className="text-xs text-red-500">{error}</p>}

			<div className="flex items-center gap-4 border-t border-border/60 pt-3">
				{editing === "__name" ? (
					<span className="flex items-center gap-2">
						<input
							value={draft}
							onChange={(e) => setDraft(e.target.value.replace(/[^a-zA-Z0-9_-]/g, "-"))}
							onKeyDown={(e) => {
								if (e.key === "Enter" && draft) void patch({ rename: draft }).then(() => setEditing(null));
								if (e.key === "Escape") setEditing(null);
							}}
							autoFocus
							aria-label="New name"
							className={`${INPUT} max-w-48`}
						/>
						<button type="button" disabled={busy || !draft} onClick={() => void patch({ rename: draft }).then(() => setEditing(null))} className="text-xs text-foreground underline-offset-2 hover:underline">
							Save
						</button>
					</span>
				) : (
					<button
						type="button"
						onClick={() => {
							setEditing("__name");
							setDraft(s.name);
						}}
						className={LINK}
					>
						Rename
					</button>
				)}
				<span className="ml-auto">
					{confirmRemove ? (
						<span className="flex items-center gap-3 text-xs">
							<span className="text-muted-foreground">Remove {displayName(s.name)}?</span>
							<button type="button" disabled={busy} onClick={() => void remove()} className="text-red-500 underline-offset-2 hover:underline">
								Remove
							</button>
							<button type="button" onClick={() => setConfirmRemove(false)} className={LINK}>
								Keep
							</button>
						</span>
					) : (
						<Hint label="Removes it from LearnHarness only" side="top">
							<button type="button" onClick={() => setConfirmRemove(true)} className={`${LINK_SMALL} hover:text-red-500`}>
								remove connection
							</button>
						</Hint>
					)}
				</span>
			</div>
		</div>
	);
}

/** A single setup value as the PATCH `values` map (headers keep "Bearer "). */
function applyOne(s: ServerStatus, key: string, value: string): Record<string, string> {
	const next = applySetupFields(s.config, { [key]: value });
	const bag = "headers" in next ? next.headers : (next as { env?: Record<string, string> }).env;
	return { [key]: bag?.[key] ?? value };
}
