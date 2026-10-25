/**
 * PATCH /api/mcp/:name — turn a connection or single tools on/off, change
 * setup values, rename. POST — "try again" (restart it). DELETE — remove.
 */
import { McpConfigError, removeMcpServer, retryMcpServer, updateMcpServer, type McpServerPatch } from "@/src/server";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ name: string }> };

export async function PATCH(req: Request, { params }: Params) {
	const { name } = await params;
	let patch: McpServerPatch;
	try {
		patch = await req.json();
	} catch {
		return Response.json({ error: "body must be JSON" }, { status: 400 });
	}
	try {
		const server = await updateMcpServer(name, patch);
		return server ? Response.json({ server }) : Response.json({ error: "not found" }, { status: 404 });
	} catch (err) {
		if (err instanceof McpConfigError) return Response.json({ error: err.message }, { status: 400 });
		throw err;
	}
}

export async function POST(_req: Request, { params }: Params) {
	const { name } = await params;
	const server = await retryMcpServer(name);
	return server ? Response.json({ server }) : Response.json({ error: "not found" }, { status: 404 });
}

export async function DELETE(_req: Request, { params }: Params) {
	const { name } = await params;
	await removeMcpServer(name);
	return Response.json({ ok: true });
}
