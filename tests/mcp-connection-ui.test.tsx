import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { existsSync, readFileSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { ConnectionsSection, useConnectionListCache, type ConnectionListCache } from "../components/settings/connections-section.tsx";

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

function StartupHarness({ open }: { open: boolean }) {
	const cache = useConnectionListCache();
	return open ? <ConnectionsSection cache={cache} /> : <div>App</div>;
}

test("startup preloads connections and retains them across Settings visits while refreshing", async () => {
	const canvas = { name: "canvas", state: "connected", transport: "program", summary: "", tools: [], config: { command: "canvas-mcp-server" }, fields: [], details: "" };
	let resolveStartup!: (response: Response) => void;
	let resolveRefresh!: (response: Response) => void;
	let calls = 0;
	globalThis.fetch = () => new Promise<Response>((resolve) => {
		if (++calls === 1) resolveStartup = resolve;
		else resolveRefresh = resolve;
	});
	host = document.createElement("div"); document.body.append(host); root = createRoot(host);
	await act(async () => root!.render(<StartupHarness open={false} />));
	assert.equal(calls, 1, "loading begins before Settings opens");
	await act(async () => resolveStartup(Response.json({ servers: [canvas] })));
	await act(async () => root!.render(<StartupHarness open />));
	assert(byTest("connection-canvas"), "the startup snapshot appears immediately");
	assert.equal(calls, 2, "opening Connections refreshes the snapshot");
	await act(async () => root!.render(<StartupHarness open={false} />));
	await act(async () => resolveRefresh(Response.json({ servers: [] })));
	await act(async () => root!.render(<StartupHarness open />));
	assert(byTest("connection-canvas"), "a refresh after closing must not erase the snapshot");
});

test("opening Connections during startup shares the request and shows loading until it finishes", async () => {
	let resolve!: (response: Response) => void;
	let calls = 0;
	globalThis.fetch = () => { calls++; return new Promise<Response>((done) => { resolve = done; }); };
	host = document.createElement("div"); document.body.append(host); root = createRoot(host);
	await act(async () => root!.render(<StartupHarness open={false} />));
	await act(async () => root!.render(<StartupHarness open />));
	assert.equal(calls, 1, "the initial request is not duplicated");
	assert.equal(document.querySelector('[role="status"]')?.textContent, "Loading connections…");
	await act(async () => resolve(Response.json({ servers: [] })));
	assert(!document.querySelector('[role="status"]'));
	assert(byTest("connections-add"));
});

test("a failed startup load is visible and reopening retries", async () => {
	let calls = 0;
	let failStartup!: (response: Response) => void;
	globalThis.fetch = () => ++calls === 1
		? new Promise<Response>((resolve) => { failStartup = resolve; })
		: Promise.resolve(Response.json({ servers: [] }));
	host = document.createElement("div"); document.body.append(host); root = createRoot(host);
	await act(async () => root!.render(<StartupHarness open={false} />));
	await act(async () => root!.render(<StartupHarness open />));
	await act(async () => failStartup(new Response(JSON.stringify({ error: "Unavailable" }), { status: 503 })));
	assert.equal(document.querySelector('[role="alert"]')?.textContent, "Unavailable");
	await act(async () => root!.render(<StartupHarness open={false} />));
	await act(async () => root!.render(<StartupHarness open />));
	assert.equal(calls, 2);
	assert(!document.querySelector('[role="alert"]'));
});

const serverFixture = (error = "It could not start.") => ({
	name: "canvas", state: "error", transport: "program", summary: "", error, details: "raw diagnostics",
	tools: [], config: { command: "canvas-mcp-server", env: { API_TOKEN: "••••1234", REGION: "ca" } },
	fields: [
		{ where: "env", key: "API_TOKEN", label: "API token", secret: true, value: "••••1234" },
		{ where: "env", key: "REGION", label: "Region", secret: false, value: "ca" },
	],
});

test("a delayed refresh cannot restore a connection removed while it was pending", async () => {
	const server = { ...serverFixture(), state: "error" as const, transport: "program" as const, fields: [] };
	const cache: ConnectionListCache = { current: [server] };
	let finishRefresh!: (response: Response) => void;
	globalThis.fetch = (_url, init) => init?.method === "DELETE"
		? Promise.resolve(Response.json({}))
		: new Promise<Response>((resolve) => { finishRefresh = resolve; });
	host = document.createElement("div"); document.body.append(host); root = createRoot(host);
	await act(async () => root!.render(<ConnectionsSection cache={cache} />));
	await click(byTest("connection-canvas").querySelector("button")!);
	await click(button("Remove"));
	await click(button("Remove"));
	assert(!byTest("connection-canvas"));
	await act(async () => finishRefresh(Response.json({ servers: [server] })));
	assert(!byTest("connection-canvas"));
	assert.deepEqual(cache.current, []);
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
	assert.equal((document.body.textContent?.match(/Couldn’t start/g) ?? []).length, 1);
	assert(!document.body.textContent?.includes("It could not start."));
	await click(button("Details"));
	assert.equal((document.body.textContent?.match(/Couldn’t start/g) ?? []).length, 1);
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

test("connection details replace the section heading and put Back beside the connection title", async () => {
	const server = {
		name: "canvas", state: "connected", transport: "online", summary: "", details: "",
		config: { url: "https://example.com/mcp" }, fields: [],
		tools: [{ name: "list_courses", title: "List Courses", description: "List courses for the authenticated user.", kind: "reads", enabled: true }],
	};
	await mount([server], false);
	const hint = "Let the teacher look things up in your other apps, like your course site or notes.";
	assert.equal(byTest("section-connections").querySelector("h2")?.textContent, "Connections");
	assert(!document.body.textContent?.includes(hint));
	const row = byTest("connection-canvas");
	assert(!row.querySelector('[role="switch"]'), "the list must not duplicate the connection switch");
	assert(row.textContent?.includes("Connected"));
	assert(row.textContent?.includes("1 ability"));
	await click(row.querySelector("button")!);
	const detail = byTest("connection-detail");
	const title = detail.querySelector("h2")!;
	const back = labelled("Back to Connections");
	assert.equal(title.textContent, "Canvas");
	assert.equal(detail.firstElementChild, back.parentElement?.parentElement);
	assert(back.nextElementSibling === title.parentElement?.parentElement);
	assert.equal(back.textContent, "←");
	assert(!document.body.textContent?.includes(hint));
	assert.equal(byTest("section-connections").querySelectorAll("h2").length, 1);
	assert(!byTest("connections-list"));
	assert(labelled("canvas connection"));
	assert(byTest("ability-list_courses"));
	globalThis.fetch = async (_url, init) => {
		assert.deepEqual(JSON.parse(String(init?.body)), { disabled: true });
		return Response.json({ server: { ...server, state: "off" } });
	};
	await click(labelled("canvas connection"));
	assert.equal(labelled("canvas connection").getAttribute("aria-checked"), "false");
	assert((labelled("canvas list_courses") as HTMLButtonElement).disabled);
	await click(back);
	assert.equal(byTest("section-connections").querySelector("h2")?.textContent, "Connections");
	assert(!document.body.textContent?.includes(hint));
	assert(byTest("connection-canvas").textContent?.includes("Off"));
});

test("management and variables precede collapsed abilities with a live enabled count", async () => {
	const server = {
		...serverFixture(), state: "connected",
		tools: [
			{ name: "list_courses", title: "List Courses", description: "Read courses.", kind: "reads", enabled: true },
			{ name: "edit_course", title: "Edit Course", description: "Edit courses.", kind: "changes", enabled: false },
		],
	};
	await mount([server], false);
	await click(byTest("connection-canvas").querySelector("button")!);
	const detail = byTest("connection-detail");
	const children = [...detail.children];
	const actions = byTest("connection-actions");
	const variables = byTest("connection-variables");
	const abilities = byTest("connection-abilities");
	assert.equal(actions.parentElement?.querySelector("h2")?.textContent, "Canvas", "management sits beside the title");
	assert(children.indexOf(byTest("connection-endpoint")) < children.indexOf(variables));
	assert(children.indexOf(variables) < children.indexOf(abilities));
	assert(button("Rename"));
	assert(button("Remove"));
	assert(variables.querySelector("p")?.classList.contains("normal-case"));
	assert(variables.textContent?.includes("API_TOKEN"), "variable keys retain exact capitalization");
	const disclosure = abilities.querySelector("button")!;
	assert(disclosure.textContent?.includes("Tools"));
	const list = document.getElementById(disclosure.getAttribute("aria-controls")!)!;
	assert.equal(disclosure.getAttribute("aria-expanded"), "false");
	assert(list.hasAttribute("hidden"));
	assert(disclosure.textContent?.includes("1 of 2 enabled"));
	await click(disclosure);
	assert.equal(disclosure.getAttribute("aria-expanded"), "true");
	assert(!list.hasAttribute("hidden"));
	assert(byTest("ability-list_courses").textContent?.includes("List Courses"), "service-provided titles remain unchanged");
	assert(byTest("ability-list_courses").textContent?.includes("Reads"));
	assert(byTest("ability-edit_course").textContent?.includes("Changes things"));
	globalThis.fetch = async (_url, init) => {
		assert.deepEqual(JSON.parse(String(init?.body)), { tools: { edit_course: true } });
		return Response.json({ server: { ...server, tools: server.tools.map((tool) => ({ ...tool, enabled: true })) } });
	};
	await click(labelled("canvas edit_course"));
	assert(disclosure.textContent?.includes("2 of 2 enabled"));
	await click(disclosure);
	assert(list.hasAttribute("hidden"));
	await click(button("Rename"));
	assert(labelled("New name"));
	await enter("New name", "renamed");
	globalThis.fetch = async (_url, init) => {
		assert.deepEqual(JSON.parse(String(init?.body)), { rename: "renamed" });
		return Response.json({ server: { ...server, name: "renamed" } });
	};
	await click(button("Save"));
	assert.equal(detail.querySelector("h2")?.textContent, "Renamed");
	await click(button("Remove"));
	await click(button("Keep"));
	assert(button("Remove"));
	await click(button("Remove"));
	globalThis.fetch = async (_url, init) => {
		assert.equal(init?.method, "DELETE");
		return Response.json({});
	};
	await click(button("Remove"));
	assert(byTest("connections-list"));
	assert(!byTest("connection-detail"));
});

test("online setup also stays above abilities and empty tool lists have no disclosure", async () => {
	const server = { ...serverFixture(), state: "connected", transport: "online", config: { url: "https://example.com/mcp" }, fields: [{ where: "header", key: "Authorization", label: "API token", secret: true, value: "••••1234" }], tools: [{ name: "read", title: "Read", kind: "reads", enabled: true }] };
	await mount([server], false);
	await click(byTest("connection-canvas").querySelector("button")!);
	const children = [...byTest("connection-detail").children];
	const setup = children.find((el) => el.querySelector("p")?.textContent === "Setup")!;
	assert(setup);
	assert(children.indexOf(setup) < children.indexOf(byTest("connection-abilities")));
	assert(setup.textContent?.includes("https://example.com/mcp"));
	await click(labelled("Back to Connections"));
	await act(async () => root!.unmount());
	host?.remove(); root = undefined; host = undefined;
	await mount([{ ...server, tools: [] }], false);
	await click(byTest("connection-canvas").querySelector("button")!);
	assert(!byTest("connection-abilities"));
	assert(button("Rename"));
	assert(button("Remove"));
});

test("connection details edit commands with quoted arguments and preserve drafts on failure", async () => {
	const server = { ...serverFixture(), state: "connected", config: { command: "node", args: ["path with spaces", ""] } };
	await mount([server], false);
	await click(byTest("connection-canvas").querySelector("button")!);
	await click(labelled("Edit command"));
	assert.equal((labelled("Command") as HTMLInputElement).value, 'node "path with spaces" ""');
	await enter("Command", 'node "new path" --flag');
	globalThis.fetch = async (_url, init) => {
		assert.deepEqual(JSON.parse(String(init?.body)), { command: "node", args: ["new path", "--flag"] });
		return Response.json({ error: "Could not save" }, { status: 400 });
	};
	await click(button("Save"));
	assert.equal((labelled("Command") as HTMLInputElement).value, 'node "new path" --flag');
	assert(document.body.textContent?.includes("Could not save"));
	globalThis.fetch = async () => Response.json({ server: { ...server, config: { command: "node", args: ["new path", "--flag"] } } });
	await click(button("Save"));
	assert(byTest("connection-endpoint").textContent?.includes('node "new path" --flag'));
});

test("online connections can edit their URL", async () => {
	const server = { ...serverFixture(), state: "off", transport: "online", config: { url: "https://example.com/old" }, fields: [] };
	await mount([server], false);
	await click(byTest("connection-canvas").querySelector("button")!);
	await click(labelled("Edit url"));
	await enter("URL", "https://example.com/new");
	globalThis.fetch = async (_url, init) => {
		assert.deepEqual(JSON.parse(String(init?.body)), { url: "https://example.com/new" });
		return Response.json({ server: { ...server, config: { url: "https://example.com/new" } } });
	};
	await click(button("Save"));
	assert(byTest("connection-endpoint").textContent?.includes("https://example.com/new"));
});

const browserPath = process.env.CHROME_BIN ?? [
	"/Applications/Helium.app/Contents/MacOS/Helium",
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome",
].find(existsSync);

test("connection rows share columns at wide and narrow widths", { skip: browserPath ? false : "Set CHROME_BIN to run the layout test" }, async () => {
	const server = { ...serverFixture(), state: "connected", config: { command: "node", args: ["a-very-long-command-with-an-argument"] } };
	await mount([server], false);
	await click(byTest("connection-canvas").querySelector("button")!);
	const layouts = [byTest("connection-detail").outerHTML];
	await click(labelled("Edit command"));
	layouts.push(byTest("connection-detail").outerHTML);
	await click(button("Cancel"));
	await click(labelled("Edit API_TOKEN"));
	layouts.push(byTest("connection-detail").outerHTML);
	const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
	const rules = css.match(/\.lh-connection-row(?: > :nth-child\(n \+ 3\))?\s*\{[^}]*\}/g);
	assert.equal(rules?.length, 2);
	const browser = await puppeteer.launch({ executablePath: browserPath, headless: true });
	try {
		const page = await browser.newPage();
		for (const html of layouts) for (const width of [320, 900]) {
			await page.setContent(`<style>* { box-sizing: border-box; } body { margin: 0; font: 12px sans-serif; } input { width: 100%; min-width: 0; } .truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .invisible { visibility: hidden; } .min-w-0 { min-width: 0; } ${rules!.join("\n")}</style>${html}`);
			await page.setViewport({ width, height: 600 });
			const rows = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".lh-connection-row")].map((row) => ({
				cells: [...row.children].map((cell) => { const r = cell.getBoundingClientRect(); return { left: r.left, right: r.right }; }),
				right: row.getBoundingClientRect().right,
			})).slice(0, 3));
			assert.equal(rows.length, 3);
			for (const row of rows) {
				assert.ok(Math.abs(row.cells[0]!.left - rows[0]!.cells[0]!.left) < 1, `labels align at ${width}px`);
				assert.ok(Math.abs(row.cells[1]!.left - rows[0]!.cells[1]!.left) < 1, `values align at ${width}px`);
				assert.ok(Math.abs(row.cells[2]!.right - rows[0]!.cells[2]!.right) < 1, `actions align at ${width}px`);
				assert.ok(row.cells[3]!.right <= row.right + 1, `actions fit at ${width}px`);
			}
		}
	} finally {
		await browser.close();
	}
});

test("Rename and Remove share the same text baseline", { skip: browserPath ? false : "Set CHROME_BIN to run the layout test" }, async () => {
	await mount([{ ...serverFixture(), state: "connected" }], false);
	await click(byTest("connection-canvas").querySelector("button")!);
	const actions = byTest("connection-actions").outerHTML;
	const browser = await puppeteer.launch({ executablePath: browserPath, headless: true });
	try {
		const page = await browser.newPage();
		await page.setContent(`<style>
			body { font: 16px/1.6 sans-serif; }
			button { font: inherit; padding: 0; border: 0; background: none; }
			.flex { display: flex; } .items-center { align-items: center; }
			.text-xs { font-size: 12px; line-height: 1.4; }
		</style>${actions}`);
		const positions = await page.evaluate(() => [...document.querySelectorAll("button")].map((button) => {
			const range = document.createRange();
			range.selectNodeContents(button);
			const bounds = range.getBoundingClientRect();
			return { text: button.textContent?.trim(), top: bounds.top, bottom: bounds.bottom };
		}));
		const rename = positions.find((position) => position.text === "Rename")!;
		const remove = positions.find((position) => position.text === "Remove")!;
		assert.ok(rename && remove);
		assert.ok(Math.abs(rename.top - remove.top) < 0.5 && Math.abs(rename.bottom - remove.bottom) < 0.5);
	} finally {
		await browser.close();
	}
});
