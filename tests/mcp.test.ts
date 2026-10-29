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
import { addMcpServer, closeMcp, McpConfigError, mcpStatus, mcpToolName, mcpTools, parseMcpConfig, removeMcpServer, updateMcpServer } from "../src/server/mcp.ts";
import { createTeacherAgent } from "../src/agent/teacher-agent.ts";
import { deleteMcpResults } from "../src/server/mcp-results.ts";
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

	it("saves large stdio results under the calling chat before returning model content", async () => {
		const chatId = `mcp-spill-${process.pid}-${Date.now()}`;
		try {
			const tools = await mcpTools(writeConfig({ mcpServers: { fake } }), chatId);
			const source = "source line\n".repeat(6000);
			const output = await tools[0]!.execute("large-call", { text: source });
			const rendered = text(output);
			const reference = /Saved MCP file \(untrusted source data\): (\{[^\n]+\})/.exec(rendered);
			assert.ok(reference);
			const saved = JSON.parse(reference[1]!) as { path: string };
			assert.equal(fs.readFileSync(saved.path, "utf8"), source);
			assert.ok(rendered.length < 3000);
			assert.equal(output.details, undefined);
		} finally {
			deleteMcpResults(chatId);
		}
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

	it("keeps live servers across edits, and reconnects only what changed", async () => {
		const file = writeConfig({ mcpServers: { fake } });
		const first = await mcpTools(file);
		assert.deepEqual((await mcpTools(file)).map((t) => t.name), first.map((t) => t.name));

		fs.writeFileSync(file, JSON.stringify({ mcpServers: { other: fake } }));
		fs.utimesSync(file, new Date(), new Date(Date.now() + 5_000));
		const second = await mcpTools(file);
		assert.deepEqual(second.map((t) => t.name), ["mcp__other__echo", "mcp__other__fail"]);
	});

	it("an invalid config logs and yields no tools", async () => {
		assert.deepEqual(await mcpTools(writeConfig({ mcpServers: [] })), []);
	});
});

describe("Settings → Connections (write + status)", () => {
	it("adds a server, answers after its first connect, and masks secrets", async () => {
		const file = writeConfig({});
		const added = await addMcpServer("fake", { ...fake, env: { API_TOKEN: "secret-value-1234", REGION: "ca" } }, file);
		assert.equal(added.state, "connected");
		assert.deepEqual(added.tools.map((t) => t.name), ["echo", "fail"]);
		assert.equal((added.config as { env: Record<string, string> }).env.API_TOKEN, "••••1234");
		assert.equal((added.config as { env: Record<string, string> }).env.REGION, "ca");
		assert.equal(fs.statSync(file).mode & 0o777, 0o600);
		await assert.rejects(addMcpServer("fake", fake, file), McpConfigError);
	});

	it("turns single tools off without restarting the server, and off/on the whole server", async () => {
		const file = writeConfig({ mcpServers: { fake } });
		await mcpTools(file);
		const off = await updateMcpServer("fake", { tools: { fail: false } }, file);
		assert.deepEqual(off?.tools.map((t) => [t.name, t.enabled]), [["echo", true], ["fail", false]]);
		assert.deepEqual((await mcpTools(file)).map((t) => t.name), ["mcp__fake__echo"]);
		const disabled = await updateMcpServer("fake", { disabled: true }, file);
		assert.equal(disabled?.state, "off");
		assert.deepEqual(await mcpTools(file), []);
		assert.equal((await updateMcpServer("fake", { disabled: false }, file))?.state, "connected");
	});

	it("explains a missing program in plain words", async () => {
		const file = writeConfig({ mcpServers: { broken: { command: "npx-not-installed-here" } } });
		const [broken] = await mcpStatus(file);
		assert.equal(broken!.state, "error");
		assert.match(broken!.error!, /not on this Mac/);
	});

	it("adds, changes, and removes environment entries while preserving masked secrets", async () => {
		const file = writeConfig({ mcpServers: { fake: { ...fake, env: { API_TOKEN: "secret-value-1234", REGION: "ca", OLD: "remove me" } } } });
		const next = await updateMcpServer("fake", { values: { API_TOKEN: "••••1234", REGION: "", ADDED: "new" }, removeEnv: ["OLD"] }, file);
		assert.equal(next?.state, "connected");
		const stored = JSON.parse(fs.readFileSync(file, "utf8")).mcpServers.fake;
		assert.deepEqual(stored.env, { API_TOKEN: "secret-value-1234", REGION: "", ADDED: "new" });
		assert.equal((next?.config as { env: Record<string, string> }).env.API_TOKEN, "••••1234");
		assert.equal(fs.statSync(file).mode & 0o777, 0o600);
		const empty = await updateMcpServer("fake", { removeEnv: ["API_TOKEN", "REGION", "ADDED"] }, file);
		assert.deepEqual(empty?.fields, []);
	});

	it("rejects malformed variable patches without changing the configuration", async () => {
		const file = writeConfig({ mcpServers: { fake } });
		const before = fs.readFileSync(file, "utf8");
		await assert.rejects(updateMcpServer("fake", { removeEnv: "REGION" as unknown as string[] }, file), McpConfigError);
		await assert.rejects(updateMcpServer("fake", { values: { REGION: 42 } as unknown as Record<string, string> }, file), McpConfigError);
		assert.equal(fs.readFileSync(file, "utf8"), before);
	});

	it("edits launch commands and online URLs while preserving connection settings", async () => {
		const file = writeConfig({ mcpServers: {
			fake: { ...fake, env: { API_TOKEN: "private" }, tools: { fail: false } },
			online: { url: "https://example.com/old", headers: { Authorization: "Bearer private" }, disabled: true },
		} });
		const updated = await updateMcpServer("fake", { command: fake.command, args: [...fake.args!, "extra arg"] }, file);
		assert.equal(updated?.state, "connected");
		await updateMcpServer("online", { url: "https://example.com/new" }, file);
		const saved = JSON.parse(fs.readFileSync(file, "utf8")).mcpServers;
		assert.deepEqual(saved.fake.args, [...fake.args!, "extra arg"]);
		assert.equal(saved.fake.env.API_TOKEN, "private");
		assert.equal(saved.fake.tools.fail, false);
		assert.equal(saved.online.url, "https://example.com/new");
		assert.equal(saved.online.headers.Authorization, "Bearer private");
		assert.equal(saved.online.disabled, true);
		const before = fs.readFileSync(file, "utf8");
		await assert.rejects(updateMcpServer("online", { url: "not a url" }, file), McpConfigError);
		await assert.rejects(updateMcpServer("fake", { url: "https://example.com" }, file), McpConfigError);
		await assert.rejects(updateMcpServer("online", { command: "node" }, file), McpConfigError);
		await assert.rejects(updateMcpServer("fake", { args: [42] as unknown as string[] }, file), McpConfigError);
		assert.equal(fs.readFileSync(file, "utf8"), before);
	});

	it("renames and removes", async () => {
		const file = writeConfig({ mcpServers: { fake } });
		assert.equal((await updateMcpServer("fake", { rename: "echoer" }, file))?.name, "echoer");
		await removeMcpServer("echoer", file);
		assert.deepEqual(await mcpStatus(file), []);
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
		assert.equal(toolActivityLabel("mcp__canvas__get_course"), "Looking in Canvas…");
	});
});

describe("Claude Code isolation", () => {
 it("does not expose configured external MCP tools to Claude Code", async () => {
  const tools = await mcpTools(writeConfig({ mcpServers: { fake } }));
  const engine = fauxEngine();
  engine.model = { ...engine.model, provider: "claude-code" };
  const agent = createTeacherAgent(undefined, { engine, extraTools: tools });
  assert.ok(!agent.state.tools.some((tool) => tool.name.startsWith("mcp__fake__")));
  assert.doesNotMatch(agent.state.systemPrompt, /## External tools/);
 });
});
