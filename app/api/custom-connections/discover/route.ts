import { CustomConnectionInputError, discoverCustomConnection } from "@/src/server";
export async function POST(req: Request) {
	let body: unknown;
	try { body = await req.json(); } catch { return Response.json({ error: "Invalid JSON." }, { status: 400 }); }
	try { return Response.json({ models: await discoverCustomConnection(body) }); }
	catch (error) { return Response.json({ error: error instanceof CustomConnectionInputError ? error.message : "Model discovery failed." }, { status: error instanceof CustomConnectionInputError ? 400 : 500 }); }
}
