import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { it } from "node:test";
import katex from "katex";
import puppeteer from "puppeteer-core";

it("Streamdown renders with the same KaTeX version as the global stylesheet", () => {
	const require = createRequire(import.meta.url);
	const mathRequire = createRequire(import.meta.resolve("@streamdown/math"));
	const rendererRequire = createRequire(mathRequire.resolve("rehype-katex"));
	assert.equal(rendererRequire("katex/package.json").version, require("katex/package.json").version);
});

const executablePath = process.env.CHROME_BIN ?? [
	"/Applications/Helium.app/Contents/MacOS/Helium",
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
	"/usr/bin/google-chrome",
].find(existsSync);

it("display math keeps integral limits inside its vertical scroll clip", {
	skip: executablePath ? false : "Set CHROME_BIN to run the browser layout test",
}, async () => {
	const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
	const rule = css.match(/\.katex-display\s*\{[^}]*\}/)?.[0];
	assert.ok(rule, "use the actual application display-math rule");
	// Embed fonts so the test needs neither a server nor network access.
	const katexRoot = new URL("../node_modules/katex/dist/", import.meta.url);
	const katexCss = readFileSync(new URL("katex.css", katexRoot), "utf8")
		.replace(/url\((fonts\/[^)]+)\)/g, (_, path: string) =>
			`url(data:font/woff2;base64,${readFileSync(new URL(path, katexRoot)).toString("base64")})`);
	const browser = await puppeteer.launch({ executablePath, headless: true });
	try {
		const page = await browser.newPage();
		await page.setContent(`<style>${katexCss}\n${rule}</style>${katex.renderToString(
			String.raw`F(x)=\int_1^{x^2}(t^3+2)\,dt.`, { displayMode: true },
		)}`);
		await page.evaluate(() => document.fonts.ready);
		for (const size of [16, 24, 32]) {
			await page.evaluate((value) => { document.body.style.fontSize = `${value}px`; }, size);
			const clipped = await page.evaluate(() => {
				const display = document.querySelector<HTMLElement>(".katex-display")!;
				const box = display.getBoundingClientRect();
				const walker = document.createTreeWalker(display.querySelector(".katex-html")!, NodeFilter.SHOW_TEXT);
				const outside: string[] = [];
				while (walker.nextNode()) {
					const range = document.createRange();
					range.selectNodeContents(walker.currentNode);
					const glyph = range.getBoundingClientRect();
					if (glyph.height && (glyph.top < box.top - 0.5 || glyph.bottom > box.bottom + 0.5)) {
						outside.push(walker.currentNode.textContent ?? "");
					}
				}
				return outside;
			});
			assert.deepEqual(clipped, [], `no clipped limits at ${size}px`);
		}
		await page.setViewport({ width: 220, height: 400 });
		assert.ok(await page.evaluate(() => {
			const display = document.querySelector<HTMLElement>(".katex-display")!;
			return getComputedStyle(display).overflowX === "auto" && display.scrollWidth > display.clientWidth;
		}), "wide equations retain horizontal scrolling");
	} finally {
		await browser.close();
	}
});
