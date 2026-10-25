import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { QuestionDock } from "../components/question-dock.tsx";

(globalThis as Record<string, unknown>).React = React;
const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window, document: dom.document, Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
	getComputedStyle: () => ({ getPropertyValue: () => "", paddingTop: "0", paddingBottom: "0" }),
	requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
});
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(async () => {
	if (root) await act(async () => root!.unmount());
	host?.remove(); root = undefined; host = undefined;
});

for (const mode of ["single-select", "multi-select"] as const) {
	test(`${mode} Markdown controls do not nest buttons or select the answer`, async () => {
		host = document.createElement("div"); document.body.append(host); root = createRoot(host);
		await act(async () => root!.render(<QuestionDock toolName="ask_user_question" toolCallId="option-test" input={{ question: "Pick code", multiSelect: mode === "multi-select", options: [{ label: "```js\nconst answer = 42;\n```" }, { label: "Another answer" }] }} expanded onExpand={() => {}} onSubmit={() => {}} />));
		const row = host.querySelector<HTMLElement>('[data-kbdrow="0"]')!;
		assert.equal(row.tagName, "DIV");
		assert.equal(row.getAttribute("role"), mode === "multi-select" ? "checkbox" : "radio");
		assert.equal(row.getAttribute("tabindex"), "0");
		const copy = row.querySelector<HTMLButtonElement>('[data-testid="md-copy"]')!;
		assert(copy, "Markdown keeps its copy control");
		assert(!host.querySelector("button button"));
		await act(async () => copy.click());
		assert.equal(row.getAttribute("aria-checked"), "false");
		await act(async () => row.click());
		assert.equal(row.getAttribute("aria-checked"), "true");
		const key = (target: HTMLElement, value: string) => {
			const e = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
			Object.defineProperty(e, "key", { value });
			return act(async () => { target.dispatchEvent(e); });
		};
		await key(copy, "Enter");
		assert.equal(row.getAttribute("aria-checked"), "true");
		const another = host.querySelector<HTMLElement>('[data-kbdrow="1"]')!;
		await key(another, " ");
		assert.equal(another.getAttribute("aria-checked"), "true");
		await key(another, "Enter");
		assert.equal(another.getAttribute("aria-checked"), mode === "multi-select" ? "false" : "true");
		await key(row, "ArrowDown");
		const beforeCopyKey = row.getAttribute("aria-checked");
		await key(copy, " ");
		assert.equal(row.getAttribute("aria-checked"), beforeCopyKey, "Copy is independent even during keyboard row navigation");
		await key(row, " ");
		assert.equal(row.getAttribute("aria-checked"), mode === "multi-select" ? "false" : "true");
	});
}
