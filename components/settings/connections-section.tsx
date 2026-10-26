"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Hint } from "@/components/ui/hint";
import {
	applySetupFields,
	describeLaunch,
	humanizeToolName,
	parsePastedSetup,
	safeServerName,
	splitCommandLine,
	type McpServerConfig,
} from "@/src/core";
import { SettingsGroup, SettingsSection, Toggle } from "./controls";

/**
 * Settings → Connections: the learner's MCP servers (src/server/mcp.ts via
 * app/api/mcp). A manual setup
 * form lets the learner enter a local command or online connection.
 * Each tool reads as a plain "ability" with a reads / changes-things tag.
 * Existing local environment variables have explicit edit/remove actions.
 *
 * App-written labels use sentence case. Preserve service names, supplied
 * tool titles, acronyms, and variable keys.
 * Three views: the list, manual setup, and one connection.
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

type View = { kind: "list" } | { kind: "add" } | { kind: "detail"; name: string };

const LINK = "text-xs text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline disabled:opacity-40";
const CONNECTION_VIEW = "flex flex-col gap-2";
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
	if (s.state === "off") return "Off";
	if (s.state === "error") return "Couldn’t start";
	const on = s.tools.filter((t) => t.enabled).length;
	return on === s.tools.length ? `${on} abilit${on === 1 ? "y" : "ies"}` : `${on} of ${s.tools.length} abilities`;
}

/** Dialog-scoped list snapshot. Never persisted or shared between Settings dialogs. */
export interface ConnectionListCache { current: ServerStatus[] | null }

export function ConnectionsSection({ cache }: { cache?: ConnectionListCache } = {}) {
	const [servers, setServers] = useState<ServerStatus[] | null>(() => cache?.current ?? null);
	const [view, setView] = useState<View>({ kind: "list" });
	const [loadError, setLoadError] = useState<string | null>(null);

	useEffect(() => {
		if (cache) cache.current = servers;
	}, [cache, servers]);

	useEffect(() => {
		let cancelled = false;
		void api<{ servers: ServerStatus[] }>("/api/mcp").then((body) => {
			if (cancelled) return;
			setServers(body.servers);
			setLoadError(null);
		}).catch((e) => {
			if (!cancelled) setLoadError(e instanceof Error ? e.message : "Could not load connections");
		});
		return () => { cancelled = true; };
	}, []);

	const replace = (server: ServerStatus, oldName = server.name) =>
		setServers((list) => {
			const rest = (list ?? []).filter((s) => s.name !== oldName && s.name !== server.name);
			const at = (list ?? []).findIndex((s) => s.name === oldName);
			if (at === -1) return [...rest, server];
			rest.splice(Math.min(at, rest.length), 0, server);
			return rest;
		});

	if (view.kind === "detail") {
		const server = servers?.find((s) => s.name === view.name);
		if (server) {
			return (
				<section className="px-6 py-5" data-testid="section-connections">
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
				</section>
			);
		}
	}

	return (
		<SettingsSection title="Connections" hint="Let the teacher look things up in your other apps, like your course site or notes." testid="section-connections">
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
				<button type="button" onClick={() => setView({ kind: view.kind === "add" ? "list" : "add" })} aria-expanded={view.kind === "add"} aria-controls="connection-add-form" data-testid="connections-add" className={`block px-1 text-xs text-foreground underline-offset-2 hover:underline${servers?.length ? " mt-2" : ""}`}>
					{view.kind === "add" ? "← Connections" : "+ Add a connection"}
				</button>
				{view.kind === "add" && (
					<div id="connection-add-form" className="mt-2 px-1">
						<ManualView
							taken={new Set((servers ?? []).map((s) => s.name))}
							onCancel={() => setView({ kind: "list" })}
							onAdded={(server) => {
								replace(server);
								setView({ kind: "detail", name: server.name });
							}}
						/>
					</div>
				)}
			</div>
		</SettingsSection>
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
					<span className="flex shrink-0 flex-wrap items-center justify-end gap-x-3 gap-y-1 font-mono text-[11px] text-muted-foreground">
						{s.state === "connected" && <span>Connected</span>}
						<span className={s.state === "error" ? "text-red-500" : undefined}>{busy ? "…" : statusLine(s)}</span>
						<span aria-hidden="true">→</span>
					</span>
				</button>
			</div>
			{s.state === "error" && (
				<div className="px-1 pb-1.5 text-xs">
					{s.error && s.error !== "It could not start." && <p className="text-red-500/90">{s.error}</p>}
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

/** Overlap both variants so hidden fields still reserve their natural size.
 * Inactive controls are not exposed to focus or assistive technology. */
function ManualSlot({ kind, program, online }: { kind: ManualKind; program: ReactNode; online: ReactNode }) {
	return (
		<div className="grid">
			<div className={`col-start-1 row-start-1 min-w-0 ${kind !== "program" ? "invisible" : ""}`} inert={kind !== "program"} aria-hidden={kind !== "program"}>
				{program}
			</div>
			<div className={`col-start-1 row-start-1 min-w-0 ${kind !== "online" ? "invisible" : ""}`} inert={kind !== "online"} aria-hidden={kind !== "online"}>
				{online}
			</div>
		</div>
	);
}

function ManualView({
	taken,
	onCancel,
	onAdded,
}: {
	taken: Set<string>;
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

	const commandInput = useRef<HTMLInputElement>(null);
	const urlInput = useRef<HTMLInputElement>(null);
	useEffect(() => {
		(kind === "program" ? commandInput : urlInput).current?.focus();
	}, [kind]);

	const onlineConfig = useMemo<McpServerConfig | null>(() => {
		if (!/^https?:\/\/\S+$/.test(url.trim())) return null;
		return { url: url.trim(), ...(token.trim() ? { headers: { Authorization: `Bearer ${token.trim()}` } } : {}) };
	}, [url, token]);
	const programConfig = useMemo<McpServerConfig | null>(() => {
		const words = splitCommandLine(command.trim());
		if (!words[0]) return null;
		const env = Object.fromEntries(vars.filter((v) => v.key.trim()).map((v) => [v.key.trim(), v.value]));
		return { command: words[0], ...(words.length > 1 ? { args: words.slice(1) } : {}), ...(Object.keys(env).length ? { env } : {}) };
	}, [command, vars]);
	const config = kind === "program" ? programConfig : onlineConfig;

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
		<div className={CONNECTION_VIEW} data-testid="connections-manual-view">
			<p className="font-prose text-(length:--lh-prose-size)">Add a connection</p>
			<div className="flex gap-1">
				{tab("program", "Program on this Mac")}
				{tab("online", "Online")}
			</div>

			<ManualSlot
				kind={kind}
				program={
					<label className="flex flex-col gap-1">
						<span className="font-ui text-xs text-foreground">Command</span>
						<input
							value={command}
							onChange={(e) => setCommand(e.target.value)}
							placeholder="npx -y some-mcp-server"
							spellCheck={false}
							ref={commandInput}
							data-testid="manual-command"
							className={INPUT}
						/>
						<span className="text-xs text-muted-foreground/70">The program and its arguments, as you would type them in Terminal.</span>
					</label>
				}
				online={
					<label className="flex flex-col gap-1">
						<span className="font-ui text-xs text-foreground">Link</span>
						<input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/mcp" spellCheck={false} ref={urlInput} data-testid="manual-url" className={INPUT} />
					</label>
				}
			/>
			<ManualSlot
				kind={kind}
				program={
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
				}
				online={
					<label className="flex flex-col gap-1">
						<span className="font-ui text-xs text-foreground">
							Access token <span className="text-muted-foreground/60">(if the service gave you one)</span>
						</span>
						<input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" spellCheck={false} className={INPUT} />
					</label>
				}
			/>

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
			{config && <LaunchWarning config={config} />}
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
	const [abilitiesExpanded, setAbilitiesExpanded] = useState(false);
	const url = `/api/mcp/${encodeURIComponent(s.name)}`;

	async function run(init: RequestInit) {
		setBusy(true);
		setError(null);
		try {
			onChange((await api<{ server: ServerStatus }>(url, init)).server, s.name);
			return true;
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed");
			return false;
		} finally {
			setBusy(false);
		}
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
			<div className="flex items-center justify-between gap-3">
				<div className="flex min-w-0 items-center gap-3">
					<button type="button" onClick={onBack} aria-label="Back to Connections" className={`shrink-0 ${LINK}`}>←</button>
					<div className="min-w-0">
						<h2 className="font-prose text-(length:--lh-prose-size)">{displayName(s.name)}</h2>
						{s.summary && <span className="block text-xs text-muted-foreground/70">{s.summary}</span>}
					</div>
				</div>
				<span className="flex shrink-0 items-center gap-3">
					<span className={`font-mono text-[11px] ${s.state === "error" ? "text-red-500" : "text-muted-foreground"}`}>
						{busy ? "…" : s.state === "connected" ? "Connected" : s.state === "off" ? "Off" : "Couldn’t start"}
					</span>
					<Toggle checked={s.state !== "off"} disabled={busy} label={`${s.name} connection`} onChange={(on) => void patch({ disabled: !on })} />
				</span>
			</div>

			<div className="flex flex-wrap items-center gap-4" data-testid="connection-actions">
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
							<button type="button" onClick={() => setConfirmRemove(true)} className={`${LINK} hover:text-red-500`}>
								Remove connection
							</button>
						</Hint>
					)}
				</span>
			</div>

			{s.state === "error" && (
				<div className="text-xs">
					{s.error && s.error !== "It could not start." && <p className="text-red-500/90">{s.error}</p>}
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

			{s.transport === "program" && <VariablesEditor key={s.name} server={s} busy={busy} onSave={patch} />}

			{s.transport === "online" && s.fields.length > 0 && (
				<SettingsGroup label="Setup" headingClassName="normal-case tracking-normal">
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

			{s.tools.length > 0 && (
				<div className="mt-5 border-t border-border/60 pt-4" data-testid="connection-abilities">
					<button type="button" aria-expanded={abilitiesExpanded} aria-controls="connection-abilities-list" onClick={() => setAbilitiesExpanded((expanded) => !expanded)} className="flex w-full items-center justify-between gap-3 text-left text-xs text-muted-foreground hover:text-foreground">
						<span className="flex items-center gap-2"><span aria-hidden="true">{abilitiesExpanded ? "▾" : "▸"}</span>Tools</span>
						<span>{s.tools.filter((t) => t.enabled).length} of {s.tools.length} enabled</span>
					</button>
					<div id="connection-abilities-list" hidden={!abilitiesExpanded} className="mt-2 flex flex-col gap-2">
						{s.tools.map((t) => (
							<div key={t.name} className="flex items-center justify-between gap-3 py-0.5" data-testid={`ability-${t.name}`}>
								<span className="min-w-0">
									<span className="block font-prose text-(length:--lh-prose-size)">{t.title || humanizeToolName(t.name)}</span>
									{t.description && <span className="block text-xs text-muted-foreground/70">{t.description}</span>}
								</span>
								<span className="flex shrink-0 items-center gap-2">
									{t.kind === "reads" && <span className="font-mono text-[10px] text-muted-foreground/60">Reads</span>}
									{t.kind === "changes" && <span className="font-mono text-[10px] text-amber-400/80">Changes things</span>}
									<Toggle checked={t.enabled} disabled={busy || s.state === "off"} label={`${s.name} ${t.name}`} onChange={(on) => void patch({ tools: { [t.name]: on } })} />
								</span>
							</div>
						))}
						{anyChanges && <p className="text-xs text-muted-foreground/70">Abilities that change things start off.</p>}
				</div>
				</div>
			)}


			{error && <p role="alert" className="text-xs text-red-500">{error}</p>}

		</div>
	);
}

function VariablesEditor({ server, busy, onSave }: {
	server: ServerStatus;
	busy: boolean;
	onSave: (patch: object) => Promise<boolean>;
}) {
	const [editing, setEditing] = useState<string | null>(null);
	const [name, setName] = useState("");
	const [value, setValue] = useState("");
	const [changed, setChanged] = useState(false);
	const [validation, setValidation] = useState<string | null>(null);
	const fields = server.fields.filter((field) => field.where === "env");
	const original = fields.find((field) => field.key === editing);
	const begin = (field?: ServerStatus["fields"][number]) => {
		setEditing(field?.key ?? "");
		setName(field?.key ?? "");
		setValue(field && !field.secret ? field.value : "");
		setChanged(false);
		setValidation(null);
	};
	async function save() {
		if (editing === null || busy) return;
		const key = name.trim();
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
			setValidation("Use a variable name with letters, numbers, and underscores; start with a letter or underscore.");
			return;
		}
		if (key !== editing && fields.some((field) => field.key === key)) {
			setValidation("That variable already exists.");
			return;
		}
		if (original?.secret && key !== editing && !changed) {
			setValidation("Enter a replacement value to rename this secret.");
			return;
		}
		setValidation(null);
		const values = original?.secret && !changed ? {} : { [key]: value };
		const removeEnv = original && key !== editing ? [editing] : [];
		if (await onSave({ values, removeEnv })) setEditing(null);
	}
	const form = (
		<div className="flex flex-col gap-2">
			<div className="flex items-center gap-2">
				<input aria-label="Variable name" value={name} disabled={busy} onChange={(event) => setName(event.target.value)}
					placeholder="NAME" spellCheck={false} className={INPUT + " max-w-48"} />
				<input aria-label="Variable value" type={original?.secret || /(key|token|secret|password|passwd|auth|credential|bearer|cookie)/i.test(name) ? "password" : "text"}
					value={value} disabled={busy} onChange={(event) => { setValue(event.target.value); setChanged(true); }}
					placeholder={original?.secret && !changed ? "Unchanged" : "value"} autoComplete="off" spellCheck={false} className={INPUT} />
				<button type="button" disabled={busy} onClick={() => void save()} className={LINK}>Save</button>
				<button type="button" disabled={busy} onClick={() => { setEditing(null); setValidation(null); }} className={LINK}>Cancel</button>
			</div>
			{validation && <p role="alert" className="text-xs text-red-500">{validation}</p>}
		</div>
	);
	return (
		<SettingsGroup label="Variables" headingClassName="normal-case tracking-normal" testid="connection-variables">
			{fields.map((field) => editing === field.key ? <div key={field.key}>{form}</div> : (
				<div key={field.key} className="flex items-center gap-3">
					<span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{field.key}</span>
					<span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">{field.value || "empty"}</span>
					<button type="button" disabled={busy} aria-label={"Edit " + field.key} onClick={() => begin(field)} className={LINK}>Edit</button>
					<button type="button" disabled={busy} aria-label={"Remove " + field.key} onClick={() => void onSave({ removeEnv: [field.key] })} className={LINK}>Remove</button>
				</div>
			))}
			{editing === "" ? form : <button type="button" disabled={busy} onClick={() => begin()} className={"self-start " + LINK}>+ Add variable</button>}
		</SettingsGroup>
	);
}

/** A single setup value as the PATCH `values` map (headers keep "Bearer "). */
function applyOne(s: ServerStatus, key: string, value: string): Record<string, string> {
	const next = applySetupFields(s.config, { [key]: value });
	const bag = "headers" in next ? next.headers : (next as { env?: Record<string, string> }).env;
	return { [key]: bag?.[key] ?? value };
}
