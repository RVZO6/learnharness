import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { ConnectionsSection, type ConnectionListCache } from "../components/settings/connections-section.tsx";

(globalThis as Record<string, unknown>).React = React;
const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window, document: dom.document, Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
});
const originalFetch = globalThis.fetch;
let root: Root | undefined;
let host: HTMLDivElement | undefined;
const byTest = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((el) => el.textContent === text)!;
async function click(element: HTMLElement) { assert(element); await act(async () => element.click()); }
async function mount(servers: unknown[] = [], openAdd = true) {
	globalThis.fetch = async () => Response.json({ servers });
	host = document.createElement("div"); document.body.append(host); root = createRoot(host);
	await act(async () => root!.render(<ConnectionsSection />));
	if (openAdd) await click(byTest("connections-add"));
}
afterEach(async () => {
	if (root) await act(async () => root!.unmount());
	host?.remove(); root = undefined; host = undefined; globalThis.fetch = originalFetch;
});

test("Add opens the manual form directly; Back and Cancel return to the list", async () => {
	await mount();
	const manual = byTest("connections-manual-view");
	assert(manual);
	assert.equal(manual.querySelector("p")!.textContent, "Add a connection");
	assert(byTest("manual-command"));
	assert.equal(manual.lastElementChild, byTest("manual-connect").parentElement, "no empty warning slot follows the buttons before a connection is entered");
	assert(button("Program on this Mac"));
	assert(button("Online"));
	assert(!document.querySelector("textarea"));
	assert(!document.querySelector('[data-testid="connections-add-view"]'));
	assert(!document.querySelector('[data-testid="connections-review"]'));
	await click(button("← Connections"));
	assert(byTest("connections-list"));
	assert(!byTest("connections-manual-view"));
	await click(byTest("connections-add"));
	assert(byTest("connections-manual-view"));
	await click(button("Cancel"));
	assert(byTest("connections-list"));
	assert(!byTest("connections-manual-view"));
});

test("manual variants retain shared layout slots and hide inactive controls from interaction", async () => {
	await mount();
	const command = byTest("manual-command"), url = byTest("manual-url");
	const name = document.querySelector('[aria-label="Connection name"]');
	const connect = byTest("manual-connect");
	const program = command.closest('[aria-hidden]')!, online = url.closest('[aria-hidden]')!;
	assert.equal(program.getAttribute("aria-hidden"), "false");
	assert(online.hasAttribute("inert"));
	assert(online.classList.contains("invisible"));
	assert.equal(program.parentElement, online.parentElement);
	assert(program.classList.contains("row-start-1") && online.classList.contains("row-start-1"));
	await click(button("+ Add variable"));
	const variable = document.querySelector('[aria-label="Variable name"]');
	assert(variable);
	await click(button("Online"));
	assert.equal(program.getAttribute("aria-hidden"), "true");
	assert(program.hasAttribute("inert"));
	assert(program.classList.contains("invisible"));
	assert.equal(online.getAttribute("aria-hidden"), "false");
	assert(!online.hasAttribute("inert"));
	assert.equal(byTest("manual-command"), command);
	assert.equal(document.querySelector('[aria-label="Variable name"]'), variable);
	assert.equal(document.querySelector('[aria-label="Connection name"]'), name);
	assert.equal(byTest("manual-connect"), connect);
	await click(button("Program on this Mac"));
	assert(!program.hasAttribute("inert"));
	assert(online.hasAttribute("inert"));
});


test("Add connection aligns with connection labels and has a gap only for populated lists", async () => {
	await mount([], false);
	assert(byTest("connections-add").classList.contains("px-1"));
	assert(!byTest("connections-add").classList.contains("mt-2"));
	await act(async () => root!.unmount());
	host?.remove(); root = undefined; host = undefined;
	await mount([{ name: "canvas", state: "connected", transport: "program", summary: "", tools: [], config: { command: "canvas-mcp-server" }, fields: [], details: "" }], false);
	assert(byTest("connections-add").classList.contains("mt-2"));
	assert(byTest("connections-add").classList.contains("px-1"));
	assert(byTest("connection-canvas").firstElementChild!.classList.contains("px-1"));
});


test("inline Add keeps existing connection rows and uses the Add action as the Back anchor", async () => {
	await mount([{ name: "canvas", state: "connected", transport: "program", summary: "", tools: [], config: { command: "canvas-mcp-server" }, fields: [], details: "" }], false);
	const row = byTest("connection-canvas");
	const anchor = byTest("connections-add");
	const anchorClass = anchor.className;
	await click(anchor);
	assert.equal(byTest("connection-canvas"), row, "existing connection rows must stay mounted");
	assert.equal(byTest("connections-add"), anchor, "Back must reuse the Add button node");
	assert.equal(anchor.className, anchorClass);
	assert.equal(anchor.textContent, "← Connections");
	assert.equal(anchor.getAttribute("aria-expanded"), "true");
	assert.equal(anchor.nextElementSibling?.id, "connection-add-form");
	assert(byTest("connections-manual-view"));
	assert.equal([...document.querySelectorAll("button")].filter((el) => el.textContent === "← Connections").length, 1);
	await click(anchor);
	assert.equal(byTest("connection-canvas"), row);
	assert.equal(byTest("connections-add"), anchor);
	assert.equal(anchor.textContent, "+ Add a connection");
	assert.equal(anchor.getAttribute("aria-expanded"), "false");
	assert(!document.querySelector("#connection-add-form"));
	await click(anchor);
	await click(button("Cancel"));
	assert.equal(byTest("connection-canvas"), row);
	assert.equal(byTest("connections-add"), anchor);
	assert(!document.querySelector("#connection-add-form"));
});


test("returning to Connections shows the retained list while a fresh request is pending", async () => {
	const cache: ConnectionListCache = { current: null };
	const canvas = { name: "canvas", state: "connected" as const, transport: "program" as const, summary: "", tools: [], config: { command: "canvas-mcp-server" }, fields: [], details: "" };
	globalThis.fetch = async () => Response.json({ servers: [canvas] });
	host = document.createElement("div"); document.body.append(host); root = createRoot(host);
	await act(async () => root!.render(<ConnectionsSection cache={cache} />));
	assert(byTest("connection-canvas"));
	assert.equal(cache.current?.[0]?.name, "canvas");
	await act(async () => root!.render(<div>Another settings screen</div>));
	let refresh!: (response: Response) => void;
	globalThis.fetch = () => new Promise<Response>((resolve) => { refresh = resolve; });
	await act(async () => root!.render(<ConnectionsSection cache={cache} />));
	assert(byTest("connection-canvas"), "return visits must show the list before the refresh resolves");
	assert(!document.body.textContent?.includes("Loading connections"));
	await act(async () => refresh(Response.json({ servers: [] })));
	assert(!byTest("connection-canvas"), "background refresh must still apply external changes");
	assert.deepEqual(cache.current, []);
});

test("a request completing after navigation cannot replace the retained connection list", async () => {
	const cache: ConnectionListCache = { current: [] };
	let refresh!: (response: Response) => void;
	globalThis.fetch = () => new Promise<Response>((resolve) => { refresh = resolve; });
	host = document.createElement("div"); document.body.append(host); root = createRoot(host);
	await act(async () => root!.render(<ConnectionsSection cache={cache} />));
	await act(async () => root!.render(<div>Another settings screen</div>));
	await act(async () => refresh(Response.json({ servers: [{ name: "late" }] })));
	assert.deepEqual(cache.current, []);
	assert.equal(document.body.textContent, "Another settings screen");
});

const serverFixture = (error = "It could not start.") => ({
	name: "canvas", state: "error", transport: "program", summary: "", error, details: "raw diagnostics",
	tools: [], config: { command: "canvas-mcp-server", env: { API_TOKEN: "••••1234", REGION: "ca" } },
	fields: [
		{ where: "env", key: "API_TOKEN", label: "API token", secret: true, value: "••••1234" },
		{ where: "env", key: "REGION", label: "Region", secret: false, value: "ca" },
	],
});
function labelled(label: string) {
	return [...document.querySelectorAll<HTMLElement>("[aria-label]")].find((element) => element.getAttribute("aria-label") === label)!;
}
async function enter(label: string, value: string) {
	const input = labelled(label) as HTMLInputElement;
	assert(input);
	// Linkedom does not implement React's native input change tracking.
	const propKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"))!;
	const props = (input as unknown as Record<string, { onChange: (event: { target: { value: string } }) => void }>)[propKey]!;
	await act(async () => props.onChange({ target: { value } }));
}

test("generic connection errors appear once in list and detail; technical details are removed", async () => {
	await mount([serverFixture()], false);
	assert.equal((document.body.textContent?.match(/couldn’t start/g) ?? []).length, 1);
	assert(!document.body.textContent?.includes("It could not start."));
	await click(button("Details"));
	assert.equal((document.body.textContent?.match(/couldn’t start/g) ?? []).length, 1);
	assert(!document.body.textContent?.includes("It could not start."));
	assert(!document.querySelector("details"));
	assert(!document.body.textContent?.includes("Technical details"));
	assert(!document.body.textContent?.includes("raw diagnostics"));
	assert(labelled("Edit API_TOKEN"));
	assert(labelled("Edit REGION"));
	assert(!document.body.textContent?.includes("Edit variables"));
});

test("specific connection failures remain visible", async () => {
	const message = "The service did not accept the access token. Check it, then try again.";
	await mount([serverFixture(message)], false);
	assert(document.body.textContent?.includes(message));
	await click(button("Details"));
	assert(document.body.textContent?.includes(message));
});

test("existing secret edits start blank and preserve the saved value when unchanged", async () => {
	const server = serverFixture();
	await mount([server], false);
	await click(button("Details"));
	await click(labelled("Edit API_TOKEN"));
	const input = labelled("Variable value") as HTMLInputElement;
	assert.equal(input.value, "");
	assert.equal(input.getAttribute("type"), "password");
	assert.equal(input.getAttribute("placeholder"), "Unchanged");
	let written: unknown;
	globalThis.fetch = async (_url, init) => { written = JSON.parse(String(init?.body)); return Response.json({ server }); };
	await click(button("Save"));
	assert.deepEqual(written, { values: {}, removeEnv: [] });
	assert(!labelled("Variable value"));
});

test("variables can be added even when a connection has no environment entries", async () => {
	const server = { ...serverFixture(), fields: [], config: { command: "canvas-mcp-server" } };
	await mount([server], false);
	await click(button("Details"));
	await click(button("+ Add variable"));
	await enter("Variable name", "NEW_TOKEN");
	await enter("Variable value", "new-private-value");
	let written: unknown;
	globalThis.fetch = async (_url, init) => { written = JSON.parse(String(init?.body)); return Response.json({ server }); };
	await click(button("Save"));
	assert.deepEqual(written, { values: { NEW_TOKEN: "new-private-value" }, removeEnv: [] });
	assert(!document.body.textContent?.includes("new-private-value"));
});

test("variable save failures preserve the draft; Cancel makes no request", async () => {
	await mount([serverFixture()], false);
	await click(button("Details"));
	await click(labelled("Edit REGION"));
	await enter("Variable value", "us");
	let requests = 0;
	globalThis.fetch = async () => { requests++; return Response.json({ error: "Save failed" }, { status: 500 }); };
	await click(button("Save"));
	assert.equal((labelled("Variable value") as HTMLInputElement).value, "us");
	assert(document.body.textContent?.includes("Save failed"));
	await click(button("Cancel"));
	assert.equal(requests, 1);
	assert(!labelled("Variable value"));
});

test("variable removal sends an explicit removal, not an empty replacement", async () => {
	const server = serverFixture();
	await mount([server], false);
	await click(button("Details"));
	let written: unknown;
	globalThis.fetch = async (_url, init) => {
		written = JSON.parse(String(init?.body));
		return Response.json({ server: { ...server, fields: server.fields.filter((field) => field.key !== "REGION") } });
	};
	await click(labelled("Remove REGION"));
	assert.deepEqual(written, { removeEnv: ["REGION"] });
	assert(!labelled("Edit REGION"));
	assert(labelled("Edit API_TOKEN"));
});

test("duplicate names and secret renames without a replacement do not submit", async () => {
	await mount([serverFixture()], false);
	await click(button("Details"));
	await click(labelled("Edit API_TOKEN"));
	let requests = 0;
	globalThis.fetch = async () => { requests++; return Response.json({}); };
	await enter("Variable name", "REGION");
	await click(button("Save"));
	assert(document.body.textContent?.includes("That variable already exists."));
	await enter("Variable name", "NEW_TOKEN");
	await click(button("Save"));
	assert(document.body.textContent?.includes("Enter a replacement value"));
	assert.equal(requests, 0);
});
