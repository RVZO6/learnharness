#!/usr/bin/env node
// A minimal stdio MCP server for tests/mcp.test.ts: newline-delimited
// JSON-RPC with two tools — `echo` (returns its text) and `fail` (an
// isError result). No dependencies, no network.
import * as readline from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

const tools = [
	{
		name: "echo",
		title: "Echo",
		description: "Return the text you send.",
		inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
	},
	{ name: "fail", description: "Always fails.", inputSchema: { type: "object" } },
];

readline.createInterface({ input: process.stdin }).on("line", (line) => {
	const msg = JSON.parse(line);
	if (msg.id === undefined) return; // notifications
	switch (msg.method) {
		case "initialize":
			return send({
				id: msg.id,
				result: {
					protocolVersion: msg.params.protocolVersion,
					capabilities: { tools: {} },
					serverInfo: { name: "fake", version: "1.0.0" },
				},
			});
		case "tools/list":
			return send({ id: msg.id, result: { tools } });
		case "tools/call":
			if (msg.params.name === "echo") {
				return send({ id: msg.id, result: { content: [{ type: "text", text: msg.params.arguments.text }] } });
			}
			return send({ id: msg.id, result: { content: [{ type: "text", text: "it broke" }], isError: true } });
		default:
			return send({ id: msg.id, error: { code: -32601, message: `no method ${msg.method}` } });
	}
});
