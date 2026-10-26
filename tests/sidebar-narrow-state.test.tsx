import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

(globalThis as Record<string, unknown>).React = React;
const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window, document: dom.document, Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { userAgent: "Electron test" } });
const values = new Map<string, string>();
Object.assign(globalThis, { localStorage: {
	getItem: (key: string) => values.get(key) ?? null,
	setItem: (key: string, value: string) => { values.set(key, value); },
} });
const { SidebarProvider } = await import("../components/sidebar.tsx");
let root: Root | undefined;
let host: HTMLDivElement | undefined;
let expansions = 0;
function resize(width: number) {
	Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
	window.dispatchEvent(new window.Event("resize"));
}
async function mount(preference: "0" | "1", width: number) {
	values.set("lh:sidebar-open", preference);
	resize(width);
	expansions = 0;
	window.lh = { expandWindow: () => { expansions++; resize(1000); } };
	host = document.createElement("div"); document.body.append(host); root = createRoot(host);
	await act(async () => root!.render(<SidebarProvider><div>Page</div></SidebarProvider>));
}
async function clickOpen() {
	const button = document.querySelector<HTMLButtonElement>('button[aria-label="Open sidebar"]');
	assert.ok(button);
	await act(async () => button.click());
}
afterEach(async () => {
	if (root) await act(async () => root!.unmount());
	host?.remove(); root = undefined; host = undefined;
	values.clear(); delete window.lh;
});

test("opening from a manually closed narrow window persists open across a remount", async () => {
	await mount("0", 800);
	await clickOpen();
	assert.equal(expansions, 1);
	assert.equal(values.get("lh:sidebar-open"), "1");
	assert.ok(document.querySelector('button[aria-label="Close sidebar"]'));
	await act(async () => root!.render(<div>Navigation</div>));
	await act(async () => root!.render(<SidebarProvider><div>Page</div></SidebarProvider>));
	assert.ok(document.querySelector('button[aria-label="Close sidebar"]'));
});

test("opening an auto-closed narrow sidebar widens immediately instead of toggling the stored preference off", async () => {
	await mount("1", 800);
	await clickOpen();
	assert.equal(expansions, 1);
	assert.equal(values.get("lh:sidebar-open"), "1");
	assert.ok(document.querySelector('button[aria-label="Close sidebar"]'));
});

test("automatic narrowing does not overwrite the stored open preference", async () => {
	await mount("1", 1000);
	await act(async () => resize(800));
	assert.ok(document.querySelector('button[aria-label="Open sidebar"]'));
	assert.equal(values.get("lh:sidebar-open"), "1");
	await act(async () => resize(1000));
	assert.ok(document.querySelector('button[aria-label="Close sidebar"]'));
	assert.equal(expansions, 0);
});
