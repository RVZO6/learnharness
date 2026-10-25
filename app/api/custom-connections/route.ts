import { CustomConnectionInputError, customConnections, saveCustomConnection } from "@/src/server";
export const dynamic = "force-dynamic";
export async function GET() {
	try { return Response.json({ connections: customConnections() }); }
	catch { return Response.json({ error: "Custom connections could not be loaded." }, { status: 500 }); }
}
export async function POST(req: Request) {
	let body: unknown;
	try { body = await req.json(); } catch { return Response.json({ error: "Invalid JSON." }, { status: 400 }); }
	try { saveCustomConnection(body); return Response.json({ ok: true }); }
	catch (error) { return Response.json({ error: error instanceof CustomConnectionInputError ? error.message : "Connection could not be saved." }, { status: error instanceof CustomConnectionInputError ? 400 : 500 }); }
}
