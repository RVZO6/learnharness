import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PATHS } from "../../config.ts";
import { customBaseUrl, isCustomConnection, validateCustomModels, type CustomConnection } from "../core/custom-connections.ts";

export function createCustomConnectionStore(file: string) {
	function read(): CustomConnection[] {
		let raw: unknown;
		try { raw = JSON.parse(fs.readFileSync(file, "utf8")); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw new Error("Custom connections could not be read."); }
		if (!Array.isArray(raw)) throw new Error("Invalid custom connection store.");
		return raw.map((entry) => {
			if (!entry || !isCustomConnection(entry.id) || typeof entry.name !== "string" || !entry.name.trim() || typeof entry.apiKey !== "string") throw new Error("Invalid custom connection store.");
			return { id: entry.id, name: entry.name, baseUrl: customBaseUrl(entry.baseUrl), apiKey: entry.apiKey, models: validateCustomModels(entry.models) };
		});
	}
	function write(entries: CustomConnection[]) {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const tmp = `${file}.${randomUUID()}.tmp`;
		try {
			fs.writeFileSync(tmp, `${JSON.stringify(entries, null, "\t")}\n`, { mode: 0o600 });
			fs.chmodSync(tmp, 0o600);
			fs.renameSync(tmp, file);
		} finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
	}
	return {
		read,
		save(entry: CustomConnection) { const entries = read(); const index = entries.findIndex((e) => e.id === entry.id); if (index < 0) entries.push(entry); else entries[index] = entry; write(entries); },
		delete(id: string) { const entries = read(); write(entries.filter((e) => e.id !== id)); },
	};
}
export const customConnectionStore = createCustomConnectionStore(path.join(PATHS.data, "custom-connections.json"));
