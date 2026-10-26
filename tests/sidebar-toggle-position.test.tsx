import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { SidebarProvider, SidebarToggle } from "../components/sidebar.tsx";

it("renders one fixed toggle outside the animated page layout, even with multiple headers", () => {
	const html = renderToStaticMarkup(
		<SidebarProvider><SidebarToggle /><SidebarToggle /></SidebarProvider>,
	);
	const { document } = parseHTML(html);
	const buttons = document.querySelectorAll('button[aria-label="Open sidebar"]');
	assert.equal(buttons.length, 1);
	const button = buttons[0];
	assert.ok(button);
	assert.equal(button.getAttribute("aria-expanded"), "false");
	const anchor = button.closest(".lh-sidebar-toggle");
	assert.ok(anchor);
	for (const name of ["fixed", "left-3", "top-3", "lh-no-drag"]) {
		assert.ok(anchor.classList.contains(name));
	}
	assert.ok(anchor.previousElementSibling?.classList.contains("h-dvh"), "toggle follows the page layout rather than sitting inside it");
	assert.equal(anchor.closest(".sidebar-motion"), null);
});

it("uses the same fixed anchor for open and closed states and clears native window controls", () => {
	const source = readFileSync(new URL("../components/sidebar.tsx", import.meta.url), "utf8");
	const fixedToggle = source.slice(source.indexOf("function FixedSidebarToggle()"), source.indexOf("function SessionStatus("));
	assert.match(fixedToggle, /const label = open \? "Close sidebar" : "Open sidebar"/);
	assert.match(fixedToggle, /className="lh-sidebar-toggle lh-no-drag fixed left-3 top-3 z-50"/);
	assert.match(fixedToggle, /onClick=\{toggle\}/);
	assert.doesNotMatch(fixedToggle, /sidebar-motion|transition-|translate-/);
	const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
	assert.match(css, /\.lh-electron\[data-lh-platform="darwin"\] \.lh-sidebar-toggle\s*\{\s*left: calc\(92px \/ var\(--lh-zoom\) \+ 12px\)/);
	assert.match(css, /padding-left: calc\(92px \/ var\(--lh-zoom\) \+ 60px\)/);
});
