import { CustomConnectionInputError, deleteCustomConnection, saveCustomConnection } from "@/src/server";
export const dynamic = "force-dynamic";
type Params = { params: Promise<{ id: string }> };
export async function PUT(req: Request, { params }: Params) {
	const { id } = await params;
	let body: unknown;
	try { body = await req.json(); } catch { return Response.json({ error: "Invalid JSON." }, { status: 400 }); }
	try { saveCustomConnection(body, id); return Response.json({ ok: true }); }
	catch (error) { return Response.json({ error: error instanceof CustomConnectionInputError ? error.message : "Connection could not be saved." }, { status: error instanceof CustomConnectionInputError ? 400 : 500 }); }
}
export async function DELETE(_req: Request, { params }: Params) {
	const { id } = await params;
	try { deleteCustomConnection(id); return Response.json({ ok: true }); }
	catch (error) { return Response.json({ error: error instanceof CustomConnectionInputError ? error.message : "Connection could not be deleted." }, { status: error instanceof CustomConnectionInputError ? 400 : 500 }); }
}
