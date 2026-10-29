"use client";

import { useEffect, useState } from "react";
import { CURRENT_SETTINGS_VERSION, type AuthKeyStatus, type UserSettings } from "@/src/core";
import { refreshAppleStatus } from "@/components/apple-speech";
import type { ProviderKeyInfo } from "./keys-section";

export interface KeysSnapshot { keys: AuthKeyStatus[]; providers?: ProviderKeyInfo[] }
export interface Preloaded<T> {
	current: T | undefined;
	load: (force?: boolean) => Promise<T>;
	set: (value: T) => void;
}

/** In-memory only. A newer write or reload fences older responses. */
export function preloaded<T>(read: () => Promise<T>): Preloaded<T> {
	let generation = 0;
	let pending: Promise<T> | undefined;
	const cache: Preloaded<T> = {
		current: undefined,
		set(value) { generation++; cache.current = value; pending = undefined; },
		load(force = false) {
			if (pending && !force) return pending;
			const own = ++generation;
			const request: Promise<T> = read().then((value): T | Promise<T> => {
				if (generation === own) { cache.current = value; return value; }
				if (pending && pending !== request) return pending;
				return cache.current ?? value;
			}).finally(() => { if (pending === request) pending = undefined; });
			pending = request;
			return request;
		},
	};
	return cache;
}

async function json(url: string): Promise<unknown> {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`status ${response.status}`);
	return response.json();
}

export function createSettingsPreload() {
	return {
		settings: preloaded(async () => {
			const body = await json("/api/settings") as { settings: UserSettings | null };
			return body.settings ?? { version: CURRENT_SETTINGS_VERSION };
		}),
		keys: preloaded(async () => {
			const body = await json("/api/keys") as KeysSnapshot;
			if (!Array.isArray(body.keys)) throw new Error("Invalid keys response");
			return body;
		}),

	};
}

export type SettingsPreload = ReturnType<typeof createSettingsPreload>;

/** Start data needed by Providers when the app shell mounts. */
export function useSettingsPreload(): SettingsPreload {
	const [cache] = useState(createSettingsPreload);
	useEffect(() => {
		for (const resource of [cache.settings, cache.keys]) void resource.load().catch(() => {});
		void refreshAppleStatus();
	}, [cache]);
	return cache;
}
