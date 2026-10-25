import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { dockScrollHeight } from "../components/dock-height.ts";

describe("dock scroll height", () => {
	it("subtracts all fixed controls and keeps the complete dock below the header", () => {
		const cap = dockScrollHeight(900, 1100, 800);
		assert.equal(cap, 568);
		assert.equal(cap + (1100 - 800), 900 - 32);
	});
	it("does not count the question's current height twice", () => {
		assert.equal(dockScrollHeight(900, 1100, 800), dockScrollHeight(900, 700, 400));
	});
	it("reduces the cap when the thinking field or other controls grow", () => {
		assert.equal(dockScrollHeight(900, 800, 600) - dockScrollHeight(900, 880, 600), 80);
	});
	it("tracks a smaller viewport without a minimum-height overflow", () => {
		assert.equal(dockScrollHeight(400, 800, 600), 168);
		assert.equal(dockScrollHeight(200, 800, 600), 0);
	});
	it("ignores hidden-content measurements that would imply negative chrome", () => {
		assert.equal(dockScrollHeight(900, 50, 700), 868);
	});
	it("rounds down to avoid a fractional-pixel overflow", () => {
		assert.equal(dockScrollHeight(900.5, 700, 400), 568);
	});
});

it("applies the fitted cap before the shell's opening animation, without a second height state", () => {
	const source = readFileSync(new URL("../components/chat.tsx", import.meta.url), "utf8");
	assert.ok(source.includes('block.style.setProperty("--dock-max-h", String(height) + "px")'));
	assert.ok(!source.includes("setDockMaxH"));
	assert.ok(source.indexOf('block.style.setProperty("--dock-max-h"') < source.indexOf('el.animate([{ height:'));
	assert.ok(source.includes('if (!area || !expanded) return;'), "folding must not restore an oversized cap");
});

it("measures natural inner content rather than a partially animated shell", () => {
	const source = readFileSync(new URL("../components/chat.tsx", import.meta.url), "utf8");
	assert.ok(source.includes('content.offsetHeight + (shell.offsetHeight - shell.clientHeight)'));
	assert.ok(source.includes('pendingRef.current && !expandedRef.current'), "only a folded dock holds its old reserve");
});


it("contains reading-area edge gestures instead of forwarding them to the transcript", () => {
	const source = readFileSync(new URL("../components/chat.tsx", import.meta.url), "utf8");
	const boundary = source.indexOf('if (n.hasAttribute("data-dock-scroll-area")) return;');
	assert.ok(boundary > 0);
	assert.ok(boundary < source.indexOf('if (n instanceof HTMLElement && canScroll(n, e.deltaY))'));
	for (const file of ["question-dock.tsx", "practice-dock.tsx"]) {
		const dock = readFileSync(new URL("../components/" + file, import.meta.url), "utf8");
		assert.match(dock, /data-dock-scroll-area=""[^\n]+overscroll-y-contain/);
	}
});


it("centers the dock scrollbar in the existing card gutter without shifting option edges", () => {
	const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
	assert.match(css, /\.lh-dock-scroll-area\s*\{[^}]*margin-right: 4px;[^}]*padding-right: 4px;[^}]*scrollbar-gutter: stable;[^}]*scrollbar-width: auto;/);
	assert.match(css, /\.lh-dock-scroll-area::-webkit-scrollbar\s*\{[^}]*width: 8px;/);
	for (const file of ["question-dock.tsx", "practice-dock.tsx"]) {
		assert.match(readFileSync(new URL("../components/" + file, import.meta.url), "utf8"), /data-dock-scroll-area=""[^\n]+lh-dock-scroll-area/);
	}
	assert.equal(4 + 8 + 4, 16, "card inset is unchanged");
	assert.equal(4 + 8 / 2, 16 / 2, "thumb is centered in the gap");
});
