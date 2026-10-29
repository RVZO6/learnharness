import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { KeysSection } from "../components/settings/keys-section.tsx";
import { preloaded, useSettingsPreload } from "../components/settings/settings-preload.ts";

(globalThis as Record<string, unknown>).React = React;
const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
const originalFetch = globalThis.fetch;
let root: Root | undefined;
let host: HTMLDivElement | undefined;
function deferred<T>() {
 let resolve!: (value: T) => void;
 const promise = new Promise<T>((done) => { resolve = done; });
 return { promise, resolve };
}
afterEach(async () => {
 if (root) await act(async () => root!.unmount());
 host?.remove(); root = undefined; host = undefined; globalThis.fetch = originalFetch;
});

function Harness({ open }: { open: boolean }) {
 const preload = useSettingsPreload();
 return open ? <KeysSection preload={preload} /> : <div>App</div>;
}

test("provider data loads at startup and stays visible during navigation refresh", async () => {
 const calls: string[] = [];
 const pendingKeys = deferred<Response>();
 let refresh = false;
 globalThis.fetch = async (input) => {
  const url = String(input); calls.push(url);
  if (url === "/api/keys") return refresh ? pendingKeys.promise : Response.json({ keys: [], providers: [] });
  return Response.json({ settings: { version: 1 } });
 };
 host = document.createElement("div"); document.body.append(host); root = createRoot(host);
 await act(async () => root!.render(<Harness open={false} />));
 assert(calls.includes("/api/keys") && calls.includes("/api/settings"));
 refresh = true;
 await act(async () => root!.render(<Harness open />));
 assert(document.querySelector('[data-testid="group-provider-keys"]'));
 assert(!document.body.textContent?.includes("Loading keys"));
 await act(async () => root!.render(<Harness open={false} />));
 await act(async () => { pendingKeys.resolve(Response.json({ keys: [], providers: [] })); });
 await act(async () => root!.render(<Harness open />));
 assert(document.querySelector('[data-testid="group-provider-keys"]'));
});

test("a late preload cannot replace a newer write", async () => {
 const old = deferred<string>();
 const cache = preloaded(() => old.promise);
 const request = cache.load();
 cache.set("new");
 old.resolve("old");
 assert.equal(await request, "new");
 assert.equal(cache.current, "new");
});

test("a forced refresh supersedes an older pending read", async () => {
 const old = deferred<string>(); const fresh = deferred<string>();
 let calls = 0;
 const cache = preloaded(() => ++calls === 1 ? old.promise : fresh.promise);
 const earlier = cache.load(); const later = cache.load(true);
 old.resolve("old"); fresh.resolve("new");
 assert.equal(await earlier, "new"); assert.equal(await later, "new");
 assert.equal(cache.current, "new");
});
