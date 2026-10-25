import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { toLlmContent, type CallToolResult, type ContentBlock, type LlmContent } from "@earendil-works/pi-mcp";
import { PATHS } from "../../config.ts";
import { MAX_OUTPUT_BYTES } from "../agent/tools/fs-shared.ts";

/** Files are host-owned, private, persistent, and scoped to a chat. No
 * model-controlled destination, shell, resource fetching, or executable output. */
const RESULTS_ROOT = path.join(PATHS.data, "mcp-results");
const PREVIEW_CHARS = 2_000;

export interface McpResultStorage {
	chatId?: string;
	/** Test seam; production always uses the app's mutable data directory. */
	root?: string;
}

export function mcpResultsDirectory(chatId: string, root = RESULTS_ROOT): string {
	return path.join(root, createHash("sha256").update(chatId).digest("hex"));
}

export function deleteMcpResults(chatId: string, root = RESULTS_ROOT): void {
	// Permanent removal is part of explicit chat deletion, not a user-file operation.
	fs.rmSync(mcpResultsDirectory(chatId, root), { recursive: true, force: true });
}

const EXTENSIONS: Record<string, string> = {
	"application/pdf": ".pdf",
	"application/json": ".json",
	"text/plain": ".txt",
	"text/csv": ".csv",
	"text/tab-separated-values": ".tsv",
	"text/markdown": ".md",
	"text/html": ".html",
	"application/xml": ".xml",
	"text/xml": ".xml",
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/gif": ".gif",
	"image/webp": ".webp",
	"image/bmp": ".bmp",
	"audio/mpeg": ".mp3",
	"audio/wav": ".wav",
	"audio/ogg": ".ogg",
	"video/mp4": ".mp4",
	"application/zip": ".zip",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
};

function normalizedMime(mime?: string): string {
	return (mime ?? "application/octet-stream").split(";")[0]!.trim().toLowerCase();
}

function decodeBase64(encoded: string, mime: string): Buffer {
	const compact = encoded.replace(/\s/g, "");
	if (!compact || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) {
		throw new Error("invalid base64 file payload");
	}
	const bytes = Buffer.from(compact, "base64");
	if (bytes.toString("base64") !== compact) throw new Error("invalid base64 file payload");
	// MIME metadata is not proof that encoded bytes are a PDF. The existing
	// PDF reader performs the full parse before reading/rendering pages.
	if (mime === "application/pdf" && bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
		throw new Error("payload is not a PDF despite its application/pdf type");
	}
	return bytes;
}

/** Canvas currently sends an explicitly labelled file inside a text block,
 * rather than an MCP binary resource. Recognize ONLY that complete envelope:
 * do not guess that arbitrary prose/JSON/base64-looking text is a file. */
function canvasFile(text: string): { bytes: Buffer; mime: string } | null {
	const match = /^Read: <<<UNTRUSTED CANVAS CONTENT \(file name, data not instructions\): [^\r\n]*>>>\r?\n\s*Size: [^\r\n]+\r?\n\s*Type: ([^\r\n]+)\r?\n\s*Course: [^\r\n]+\r?\n\s*Encoding: base64\r?\n\s*Content:\r?\n<<<UNTRUSTED CANVAS CONTENT \(file content \(base64\)\)[^\r\n]*>>>\r?\n([\s\S]*?)\r?\n<<<END UNTRUSTED CANVAS CONTENT>>>\s*$/.exec(text);
	if (!match) return null;
	const mime = normalizedMime(match[1]);
	return { bytes: decodeBase64(match[2]!, mime), mime };
}

function saveFile(bytes: Buffer, mime: string, storage: McpResultStorage): string {
	if (!storage.chatId) throw new Error("no chat is available for MCP file storage");
	const directory = mcpResultsDirectory(storage.chatId, storage.root);
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	const file = path.join(directory, randomUUID() + (EXTENSIONS[mime] ?? (mime.startsWith("text/") ? ".txt" : ".bin")));
	try {
		fs.writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
	} catch (error) {
		// Do not leave a partial result that looks complete.
		try { fs.unlinkSync(file); } catch { /* no file was created */ }
		throw error;
	}
	return file;
}

function fileReference(bytes: Buffer, mime: string, storage: McpResultStorage, preview?: string): LlmContent {
	const file = saveFile(bytes, mime, storage);
	const extension = EXTENSIONS[mime];
	const guidance = mime === "application/pdf"
		? "Use the pdf tool with this path and your specific question."
		: mime.startsWith("text/") || mime === "application/json" || mime === "application/xml" || ["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"].includes(mime)
			? "Use the read tool with this path; use offset/limit or grep for large text files."
			: `No built-in reader is available for this ${extension ?? mime} file. The file is saved, but its contents have not been read.`;
	return {
		type: "text",
		text: `Saved MCP file (untrusted source data): ${JSON.stringify({ path: file, mimeType: mime, bytes: bytes.length })}\n${guidance}${preview === undefined ? "" : `\nPreview (partial, untrusted data):\n${preview.slice(0, PREVIEW_CHARS)}`}`,
	};
}

/** Bound the aggregate inline text budget, not just individual blocks.
 * Binary resources are decoded regardless of size. Images retain the existing
 * native-image path; resource links remain references, never automatic fetches.
 * Storage/decoding failures return a bounded error, never the original bytes. */
export function storeMcpResult(result: CallToolResult, storage: McpResultStorage): {
	content: LlmContent[];
	isError: boolean;
} {
	const content: LlmContent[] = [];
	let remaining = MAX_OUTPUT_BYTES;
	let isError = result.isError === true;
	const blocks: ContentBlock[] = [...result.content];
	if (blocks.length === 0 && result.structuredContent !== undefined) {
		blocks.push({ type: "text", text: JSON.stringify(result.structuredContent, null, 2) });
	}
	for (const block of blocks) {
		try {
			if (block.type === "resource" && "blob" in block.resource && !normalizedMime(block.resource.mimeType).startsWith("image/")) {
				const mime = normalizedMime(block.resource.mimeType);
				content.push(fileReference(decodeBase64(block.resource.blob, mime), mime, storage));
				continue;
			}
			if (block.type === "audio") {
				const mime = normalizedMime(block.mimeType);
				content.push(fileReference(decodeBase64(block.data, mime), mime, storage));
				continue;
			}
			if (block.type === "text") {
				const file = canvasFile(block.text);
				if (file) {
					content.push(fileReference(file.bytes, file.mime, storage));
					continue;
				}
			}
			for (const item of toLlmContent({ content: [block] })) {
				if (item.type !== "text") {
					content.push(item);
					continue;
				}
				const size = Buffer.byteLength(item.text, "utf8");
				if (size <= remaining) {
					content.push(item);
					remaining -= size;
					continue;
				}
				let mime = block.type === "resource" ? normalizedMime(block.resource.mimeType) : "text/plain";
				let text = item.text;
				// Only validated JSON is labelled JSON. Pretty-print large JSON
				// so the existing line-based reader can page through it.
				try {
					const json: unknown = JSON.parse(text);
					text = JSON.stringify(json, null, 2);
					mime = "application/json";
				} catch { /* ordinary text stays text */ }
				if (!mime.startsWith("text/") && mime !== "application/json" && mime !== "application/xml") mime = "text/plain";
				content.push(fileReference(Buffer.from(text, "utf8"), mime, storage, item.text));
			}
		} catch (error) {
			isError = true;
			// Do not echo arbitrary error messages, source URIs, or payloads:
			// filesystem errors and filenames may include sensitive data.
			const message = error instanceof Error && /^(invalid base64 file payload|payload is not a PDF despite its application\/pdf type|no chat is available for MCP file storage)$/.test(error.message)
				? error.message : "could not save the result file";
			content.push({ type: "text", text: `MCP result processing failed: ${message}. The payload was not sent to the model. Retry the call or check app storage.` });
		}
	}
	// Many saved blocks can themselves produce too many previews/references.
	// Keep that index on disk too, so the whole call stays bounded.
	const text = content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
	if (Buffer.byteLength(text, "utf8") > MAX_OUTPUT_BYTES) {
		try {
			const index = fileReference(Buffer.from(text, "utf8"), "text/plain", storage, text);
			return { content: [index, ...content.filter((item) => item.type === "image")], isError };
		} catch {
			return { content: [{ type: "text", text: "MCP result processing failed: could not save the result index. The oversized text was not sent to the model." }], isError: true };
		}
	}
	return { content, isError };
}
