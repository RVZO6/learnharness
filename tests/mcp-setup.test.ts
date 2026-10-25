/**
 * Paste parsing and the plain-language tool view (src/core/mcp-setup.ts):
 * the shapes real setup instructions use — Claude Desktop / Cursor JSON,
 * VS Code JSON, fragments, `claude mcp add`, bare commands, links. Pure.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	applySetupFields,
	describeLaunch,
	fieldLabel,
	humanizeToolName,
	mcpToolEnabled,
	mcpToolKind,
	parsePastedSetup,
	setupFields,
	splitCommandLine,
} from "../src/core/mcp-setup.ts";

const servers = (text: string) => {
	const r = parsePastedSetup(text);
	return "servers" in r ? r.servers : [];
};

describe("parsePastedSetup", () => {
	it("a link", () => {
		assert.deepEqual(parsePastedSetup("https://mcp.notion.com/mcp"), { kind: "link", servers: [{ name: "notion", config: { url: "https://mcp.notion.com/mcp" } }] });
	});

	it("Claude Desktop / Cursor setup code, with comments and trailing commas", () => {
		const r = parsePastedSetup(`{
			// from the README
			"mcpServers": {
				"canvas": { "command": "npx", "args": ["-y", "canvas-mcp"], "env": { "CANVAS_API_TOKEN": "<your-token>", }, },
			},
		}`);
		assert.equal(r.kind, "code");
		assert.deepEqual(servers(JSON.stringify({ mcpServers: { canvas: { command: "npx", args: ["-y", "canvas-mcp"] } } })), [
			{ name: "canvas", config: { command: "npx", args: ["-y", "canvas-mcp"] } },
		]);
	});

	it("VS Code's servers key, a fragment without braces, and a bare entry", () => {
		assert.equal(servers(`{"servers": {"zotero": {"command": "uvx", "args": ["zotero-mcp"]}}}`)[0]!.name, "zotero");
		assert.equal(servers(`"obsidian": {"command": "npx", "args": ["obsidian-mcp", "/vault"]},`)[0]!.name, "obsidian");
		assert.equal(servers(`{"command": "uvx", "args": ["mcp-server-fetch"]}`)[0]!.name, "fetch");
	});

	it("claude mcp add, for programs and links", () => {
		assert.deepEqual(servers("claude mcp add canvas -e CANVAS_API_TOKEN=abc -- npx -y canvas-mcp"), [
			{ name: "canvas", config: { command: "npx", args: ["-y", "canvas-mcp"], env: { CANVAS_API_TOKEN: "abc" } } },
		]);
		assert.deepEqual(servers("claude mcp add --transport http notion https://mcp.notion.com/mcp"), [
			{ name: "notion", config: { url: "https://mcp.notion.com/mcp" } },
		]);
	});

	it("a bare command with leading env assignments", () => {
		assert.deepEqual(servers("ZOTERO_API_KEY=xyz uvx zotero-mcp"), [
			{ name: "zotero", config: { command: "uvx", args: ["zotero-mcp"], env: { ZOTERO_API_KEY: "xyz" } } },
		]);
	});

	it("explains what it could not read", () => {
		assert.equal(parsePastedSetup("").kind, "empty");
		assert.equal(parsePastedSetup("{ broken").kind, "unknown");
		assert.equal(parsePastedSetup("open the settings page\nthen click add").kind, "unknown");
	});
});

describe("setup fields", () => {
	it("labels, secrets, and placeholders", () => {
		const fields = setupFields({ command: "npx", env: { CANVAS_API_TOKEN: "<your-token>", CANVAS_BASE_URL: "https://canvas.example.edu" } });
		assert.deepEqual(
			fields.map((f) => [f.label, f.secret, f.needsValue]),
			[["Canvas API token", true, true], ["Canvas base URL", false, false]],
		);
		assert.equal(fieldLabel("apiKey"), "API key");
	});

	it("a bearer header asks for the token only and keeps Bearer on save", () => {
		const config = { url: "https://x.example/mcp", headers: { Authorization: "Bearer YOUR_TOKEN" } };
		const [f] = setupFields(config);
		assert.equal(f!.label, "Access token");
		assert.equal(f!.needsValue, true);
		assert.deepEqual(applySetupFields(config, { Authorization: "abc" }), { url: "https://x.example/mcp", headers: { Authorization: "Bearer abc" } });
	});

	it("describes what connecting runs", () => {
		assert.deepEqual(describeLaunch({ command: "npx", args: ["-y", "canvas-mcp"] }), { kind: "program", what: "canvas-mcp", source: "npm" });
		assert.deepEqual(describeLaunch({ command: "uvx", args: ["zotero-mcp"] }), { kind: "program", what: "zotero-mcp", source: "PyPI" });
		assert.deepEqual(describeLaunch({ url: "https://mcp.notion.com/mcp" }), { kind: "online", what: "mcp.notion.com" });
	});
});

describe("tools", () => {
	it("kind and default from the MCP hints; overrides win", () => {
		assert.equal(mcpToolKind({ readOnlyHint: true }), "reads");
		assert.equal(mcpToolKind({ destructiveHint: true }), "changes");
		assert.equal(mcpToolKind(undefined), "unknown");
		assert.equal(mcpToolEnabled({}, "post", { readOnlyHint: false }), false);
		assert.equal(mcpToolEnabled({ tools: { post: true } }, "post", { readOnlyHint: false }), true);
		assert.equal(mcpToolEnabled({}, "list", undefined), true);
	});

	it("plain names", () => {
		assert.equal(humanizeToolName("list_course_modules"), "List course modules");
		assert.equal(humanizeToolName("getAssignments"), "Get assignments");
	});

	it("splits command lines like a shell", () => {
		assert.deepEqual(splitCommandLine(`npx -y "my server" --path='/a b'`), ["npx", "-y", "my server", "--path=/a b"]);
	});
});
