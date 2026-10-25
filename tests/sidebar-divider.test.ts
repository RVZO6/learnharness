import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";

it("anchors the divider to the animated sidebar edge, not the fixed-width contents", () => {
	const source = readFileSync(new URL("../components/sidebar.tsx", import.meta.url), "utf8");
	const aside = source.match(/<aside\s+className=\{cn\("([^"]+)", open \? "w-72" : "w-0"\)\}/);
	assert.ok(aside, "sidebar retains its animated width");
	const classes = aside[1].split(" ");
	for (const name of ["sidebar-motion", "relative", "overflow-hidden", "duration-200", "after:absolute", "after:inset-y-0", "after:right-0", "after:border-r", "after:pointer-events-none"]) {
		assert.ok(classes.includes(name), `animated edge needs ${name}`);
	}
	const panel = source.match(/<div className="([^"]*\bh-full w-72\b[^"]*)"/);
	assert.ok(panel, "contents keep their fixed width");
	assert.ok(!panel[1].split(" ").includes("border-r"), "fixed contents must not retain a stationary divider");
});
