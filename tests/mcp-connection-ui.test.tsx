import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { ConnectionsSection } from "../components/settings/connections-section.tsx";

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
async function mount() {
	globalThis.fetch = async () => Response.json({ servers: [] });
	host = document.createElement("div"); document.body.append(host); root = createRoot(host);
	await act(async () => root!.render(<ConnectionsSection />));
	await click(byTest("connections-add"));
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
	await click(byTest("connections-add"));
	assert(byTest("connections-manual-view"));
	await click(button("Cancel"));
	assert(byTest("connections-list"));
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
