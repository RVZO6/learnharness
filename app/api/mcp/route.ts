/**
 * GET /api/mcp — Settings → Connections: every MCP connection in mcp.json
 * with its live state, tools, and setup values (secrets masked).
 * POST /api/mcp — add one: {name, config}; answers after the first connect
 * attempt, so the UI shows the real result.
 */
import { addMcpServer, mcpStatus, McpConfigError } from "@/src/server";
import type { McpServerConfig } from "@/src/core";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json({ servers: await mcpStatus() }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
	let body: { name?: unknown; config?: unknown };
	try {
		body = await req.json();
	} catch {
		return Response.json({ error: "body must be JSON" }, { status: 400 });
	}
	const config = body.config as McpServerConfig | undefined;
	if (typeof body.name !== "string" || !config || typeof config !== "object" || (typeof (config as { command?: unknown }).command !== "string" && typeof (config as { url?: unknown }).url !== "string")) {
		return Response.json({ error: "body must be {name, config: {command…} | {url…}}" }, { status: 400 });
	}
	try {
		return Response.json({ server: await addMcpServer(body.name, config) });
	} catch (err) {
		if (err instanceof McpConfigError) return Response.json({ error: err.message }, { status: 409 });
		throw err;
	}
}
