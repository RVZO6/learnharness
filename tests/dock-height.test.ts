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
		assert.match(dock, /<DockScrollArea className="[^\n]+overscroll-y-contain/);
	}
});


it("overlays the scrollbar in the existing margin without changing content spacing", () => {
	const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
	assert.ok(!css.includes(".lh-dock-scroll-area"), "remove the native gutter and padding overrides");
	const source = readFileSync(new URL("../components/dock-scroll-area.tsx", import.meta.url), "utf8");
	assert.match(source, /ScrollArea\.Scrollbar/);
	assert.match(source, /style=\{\{ right: 5, width: 6, top: 12, bottom: 12 \}\}/);
	assert.match(source, /type="scroll"/, "hide when scrolling ends, not only when the pointer leaves");
	assert.doesNotMatch(source.slice(source.indexOf("return (")), /(?:padding|margin|scrollbar-gutter)/);
	for (const file of ["question-dock.tsx", "practice-dock.tsx"]) {
		const dock = readFileSync(new URL("../components/" + file, import.meta.url), "utf8");
		assert.match(dock, /<DockScrollArea className="[^"\n]+px-4/);
	}
	assert.equal(5 + 6 / 2, 16 / 2, "thumb is centered in the existing margin");
});


it("fades the overlay out before Radix removes it", () => {
	const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
	assert.match(css, /\.lh-dock-scrollbar\[data-state="hidden"\]\s*\{\s*animation: lh-dock-scrollbar-out 150ms ease-out;/);
	assert.match(css, /@keyframes lh-dock-scrollbar-out\s*\{\s*from \{ opacity: 1; \}\s*to \{ opacity: 0; \}/);
	const source = readFileSync(new URL("../components/dock-scroll-area.tsx", import.meta.url), "utf8");
	assert.match(source, /className="lh-dock-scrollbar/);
});
