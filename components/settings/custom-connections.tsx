"use client";

import { useEffect, useState, type ReactNode } from "react";
import { CUSTOM_THINKING_LEVELS, validateCustomModels, validateCustomModelDrafts, type CustomConnectionInfo, type CustomModelDraft } from "@/src/core";
import { notifySettingsSaved } from "@/components/settings-signal";

const inputClass = "h-8 w-full min-w-0 rounded-sm border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-muted-foreground";
const technicalInputClass = `${inputClass} font-mono [font-variant-ligatures:none]`;
const actionClass = "text-xs text-muted-foreground hover:text-foreground disabled:opacity-40";

async function request(url: string, method = "GET", body?: unknown) {
	const response = await fetch(url, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
	const result = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(result.error ?? "Connection request failed.");
	return result;
}

function ModelDetails({ model, children }: { model: CustomModelDraft; children: ReactNode }) {
	const [expanded, setExpanded] = useState(() => {
		try { validateCustomModels([model]); return false; } catch { return true; }
	});
	return <details open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)} className="border-t border-border pt-3" data-testid="custom-model-details">
		<summary className="cursor-pointer text-xs text-foreground">{model.name ?? (model.id || "New model")} <span className="text-muted-foreground">· Model settings</span></summary>
		<div className="mt-2 flex flex-col gap-2">{children}</div>
	</details>;
}

function ConnectionEditor({ connection, onSaved, onCancel }: { connection?: CustomConnectionInfo; onSaved: () => Promise<void>; onCancel: () => void }) {
	const [name, setName] = useState(connection?.name ?? "");
	const [baseUrl, setBaseUrl] = useState(connection?.baseUrl ?? "");
	const [apiKey, setApiKey] = useState<string | undefined>(connection ? undefined : "");
	const [models, setModels] = useState<CustomModelDraft[]>(connection?.models ?? []);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const payload = { id: connection?.id, name, baseUrl, apiKey, models };
	async function perform(action: () => Promise<void>) {
		if (busy) return;
		setBusy(true); setError(null);
		try { await action(); } catch (error) { setError(error instanceof Error ? error.message : "Connection request failed."); }
		finally { setBusy(false); }
	}
	function patch(index: number, value: Partial<CustomModelDraft>) { setModels((entries) => entries.map((m, i) => i === index ? { ...m, ...value } : m)); }

	return <form data-testid="custom-connection-editor" className="flex flex-col gap-3 rounded-sm border border-border p-3" onSubmit={(event) => {
		event.preventDefault();
		void perform(async () => {
			validateCustomModelDrafts(models);
			await request(`/api/custom-connections${connection ? `/${connection.id}` : ""}`, connection ? "PUT" : "POST", payload);
			await onSaved();
		});
	}}>
		<fieldset disabled={busy} className="flex min-w-0 flex-col gap-3">
			<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
				<label className="flex flex-col gap-1 text-xs">Name<input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} autoFocus /></label>
				<div className="flex flex-col gap-1">
					<label className="flex flex-col gap-1 text-xs">API key (optional)<input className={technicalInputClass} type="password" autoComplete="new-password" value={apiKey ?? ""} onChange={(e) => setApiKey(e.target.value)} placeholder={connection?.keyPresent && apiKey === undefined ? "Unchanged" : ""} /></label>
					{connection?.keyPresent && apiKey === undefined && <button type="button" className={`${actionClass} self-start`} onClick={() => setApiKey("")}>Remove key</button>}
				</div>
			</div>
			<label className="flex flex-col gap-1 text-xs">Base URL<input className={technicalInputClass} type="url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com/v1" required /></label>
			<button type="button" className={`${actionClass} self-start`} onClick={() => setModels((entries) => [...entries, { id: "" }])}>Add model manually</button>
			{models.map((model, index) => <ModelDetails key={index} model={model}>
				<div className="flex items-end gap-2"><label className="flex min-w-0 flex-1 flex-col gap-1 text-xs">Model ID<input className={technicalInputClass} value={model.id} required onChange={(e) => patch(index, { id: e.target.value })} /></label><button type="button" className={`${actionClass} pb-2`} aria-label={`Remove model ${model.id || index + 1}`} onClick={() => setModels((entries) => entries.filter((_, i) => i !== index))}>Remove</button></div>
				<div className="grid grid-cols-2 gap-2">
					<label className="flex flex-col gap-1 text-xs">Context tokens<input className={inputClass} type="number" min={1} step={1} value={model.contextWindow ?? ""} onChange={(e) => patch(index, { contextWindow: e.target.value ? Number(e.target.value) : undefined })} /></label>
					<label className="flex flex-col gap-1 text-xs">Max output tokens<input className={inputClass} type="number" min={1} step={1} value={model.maxTokens ?? ""} onChange={(e) => patch(index, { maxTokens: e.target.value ? Number(e.target.value) : undefined })} /></label>
				</div>
				<label className="flex flex-col gap-1 text-xs">Image input<select className={inputClass} value={model.imageInput === undefined ? "" : String(model.imageInput)} onChange={(e) => patch(index, { imageInput: e.target.value === "" ? undefined : e.target.value === "true" })}><option value="">Select support…</option><option value="false">Not supported</option><option value="true">Supported</option></select></label>
				<fieldset className="flex flex-wrap gap-x-3 gap-y-1"><legend className="mb-1 text-xs">Reasoning levels</legend>{CUSTOM_THINKING_LEVELS.map((level) => <label key={level} className="flex items-center gap-1 text-xs"><input type="checkbox" checked={model.supportedLevels?.includes(level) ?? false} onChange={(e) => patch(index, { supportedLevels: e.target.checked ? [...(model.supportedLevels ?? []), level] : model.supportedLevels?.filter((l) => l !== level) })} />{level}</label>)}</fieldset>
			</ModelDetails>)}
			<div className="flex items-center gap-3">
				<button type="submit" className="text-xs text-foreground disabled:opacity-40">Save connection</button>
				<button type="button" className={actionClass} onClick={onCancel}>Cancel</button>
				{connection && <button type="button" className={`${actionClass} ml-auto hover:text-red-500`} onClick={() => void perform(async () => { await request(`/api/custom-connections/${connection.id}`, "DELETE"); await onSaved(); })}>Delete connection</button>}
			</div>
		</fieldset>
		{busy && <p role="status" className="text-xs text-muted-foreground">Working…</p>}
		{error && <p role="alert" className="text-xs text-red-500">{error}</p>}
	</form>;
}

/** Separate from the built-in provider picker, including during first-time setup. */
export function CustomConnections() {
	const [connections, setConnections] = useState<CustomConnectionInfo[]>([]);
	const [editing, setEditing] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	async function reload() { const result = await request("/api/custom-connections"); setConnections(result.connections); }
	async function saved() {
		setEditing(null);
		notifySettingsSaved("keys"); notifySettingsSaved("models");
		try { await reload(); setError(null); } catch { setError("Custom connections could not be loaded."); }
	}

	useEffect(() => {
		let cancelled = false;
		request("/api/custom-connections").then((result) => { if (!cancelled) setConnections(result.connections); }).catch(() => { if (!cancelled) setError("Custom connections could not be loaded."); }).finally(() => { if (!cancelled) setLoading(false); });
		return () => { cancelled = true; };
	}, []);
	return <div className="flex flex-col gap-2" data-testid="custom-connections">
		{loading && <p className="text-xs text-muted-foreground">Loading…</p>}
		{error && <p role="alert" className="text-xs text-red-500">{error} <button className={actionClass} type="button" onClick={() => { void reload().then(() => setError(null)).catch(() => setError("Custom connections could not be loaded.")); }}>Retry</button></p>}
		{connections.map((connection) => <div key={connection.id}>
			{editing !== connection.id && <button type="button" disabled={editing !== null} onClick={() => { setEditing(connection.id); }} className="flex w-full items-center justify-between gap-3 rounded-sm px-1 py-1.5 text-left text-xs hover:bg-accent"><span className="truncate">{connection.name}</span><span className="shrink-0 text-muted-foreground">Custom · {connection.models.length} {connection.models.length === 1 ? "model" : "models"}{!connection.ready ? " · Needs details" : ""}</span></button>}
			{editing === connection.id && <ConnectionEditor connection={connection} onCancel={() => setEditing(null)} onSaved={saved} />}
		</div>)}
		{editing === "new" ? <ConnectionEditor onCancel={() => setEditing(null)} onSaved={saved} /> : <button type="button" className={`${actionClass} self-start px-1 py-1.5`} disabled={loading || !!error || editing !== null} onClick={() => { setEditing("new"); }}>+ Add connection</button>}
	</div>;
}
