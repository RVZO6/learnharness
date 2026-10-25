/**
 * MCP client tools (src/server/mcp.ts): config parsing, tool naming, and
 * the full connect → list → call path against a fake stdio server
 * (tests/fixtures/mcp/fake-server.mjs — local process, no network). Each
 * test writes its own config into a temp dir; closeMcp() resets the
 * globalThis cache between tests.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createFauxCore } from "@earendil-works/pi-ai";
import { closeMcp, mcpToolName, mcpTools, parseMcpConfig } from "../src/server/mcp.ts";
import { createTeacherAgent } from "../src/agent/teacher-agent.ts";
import type { PiEngine } from "../src/agent/models.ts";
import { toolActivityLabel } from "../src/core/pending.ts";

const FAKE_SERVER = path.join(import.meta.dirname, "fixtures", "mcp", "fake-server.mjs");
const fake = { command: process.execPath, args: [FAKE_SERVER] };

function writeConfig(config: unknown): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-mcp-"));
	const file = path.join(dir, "mcp.json");
	fs.writeFileSync(file, JSON.stringify(config));
	return file;
}

function fauxEngine(): PiEngine {
	const faux = createFauxCore({});
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

const text = (result: { content: Array<{ type: string; text?: string }> }) =>
	result.content.map((c) => c.text ?? "").join("");

afterEach(() => closeMcp());

describe("parseMcpConfig", () => {
	it("reads stdio and url entries; no mcpServers key = no servers", () => {
		const servers = parseMcpConfig(JSON.stringify({ mcpServers: { a: { command: "x" }, b: { url: "http://y" } } }));
		assert.deepEqual(Object.keys(servers), ["a", "b"]);
		assert.deepEqual(parseMcpConfig("{}"), {});
	});

	it("rejects an entry with neither command nor url, and bad JSON", () => {
		assert.throws(() => parseMcpConfig(JSON.stringify({ mcpServers: { a: { args: [] } } })), /"a" needs/);
		assert.throws(() => parseMcpConfig("{"));
	});
});

describe("mcpToolName", () => {
	it("prefixes, sanitizes to the provider charset, and caps at 64", () => {
		const taken = new Set<string>();
		assert.equal(mcpToolName("canvas", "get.course", taken), "mcp__canvas__get_course");
		assert.ok(mcpToolName("s", "t".repeat(100), taken).length <= 64);
	});

	it("dedupes names that collide after sanitizing", () => {
		const taken = new Set<string>();
		assert.equal(mcpToolName("s", "a.b", taken), "mcp__s__a_b");
		assert.equal(mcpToolName("s", "a/b", taken), "mcp__s__a_b_2");
	});
});

describe("mcpTools", () => {
	it("no config file = no tools", async () => {
		assert.deepEqual(await mcpTools(path.join(os.tmpdir(), "lh-mcp-absent", "mcp.json")), []);
	});

	it("connects, lists, and calls a stdio server's tools", async () => {
		const tools = await mcpTools(writeConfig({ mcpServers: { fake } }));
		assert.deepEqual(tools.map((t) => t.name), ["mcp__fake__echo", "mcp__fake__fail"]);

		const echo = tools[0]!;
		const ok = await echo.execute("call-1", { text: "hello" });
		assert.equal(text(ok), "hello");
		assert.notEqual((ok as { isError?: boolean }).isError, true);

		const failed = await tools[1]!.execute("call-2", {});
		assert.equal(text(failed), "it broke");
		assert.equal((failed as { isError?: boolean }).isError, true);
	});

	it("a server that fails to start drops only its own tools; disabled servers are skipped", async () => {
		const tools = await mcpTools(
			writeConfig({
				mcpServers: {
					broken: { command: path.join(os.tmpdir(), "lh-no-such-binary") },
					off: { ...fake, disabled: true },
					fake,
				},
			}),
		);
		assert.deepEqual(tools.map((t) => t.name), ["mcp__fake__echo", "mcp__fake__fail"]);
	});

	it("returns the cached set until the file changes, then reconnects", async () => {
		const file = writeConfig({ mcpServers: { fake } });
		const first = await mcpTools(file);
		assert.equal(await mcpTools(file), first);

		fs.writeFileSync(file, JSON.stringify({ mcpServers: { other: fake } }));
		fs.utimesSync(file, new Date(), new Date(Date.now() + 5_000));
		const second = await mcpTools(file);
		assert.deepEqual(second.map((t) => t.name), ["mcp__other__echo", "mcp__other__fail"]);
	});

	it("an invalid config logs and yields no tools", async () => {
		assert.deepEqual(await mcpTools(writeConfig({ mcpServers: [] })), []);
	});
});

describe("extraTools in the agent", () => {
	it("appends to the registry and adds the prompt note only when present", async () => {
		const tools = await mcpTools(writeConfig({ mcpServers: { fake } }));
		const withMcp = createTeacherAgent(undefined, { engine: fauxEngine(), extraTools: tools });
		const names = withMcp.state.tools.map((t) => t.name);
		assert.ok(names.includes("quiz") && names.includes("mcp__fake__echo"));
		assert.match(withMcp.state.systemPrompt, /## External tools/);

		const without = createTeacherAgent(undefined, { engine: fauxEngine() });
		assert.doesNotMatch(without.state.systemPrompt, /## External tools/);
	});

	it("labels a running MCP tool in the transcript", () => {
		assert.equal(toolActivityLabel("mcp__canvas__get_course"), "Using an external tool…");
	});
});
