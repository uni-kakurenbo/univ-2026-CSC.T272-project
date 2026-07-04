import { hc } from "hono/client";

import type { ApiClient } from "@app/server/app-type";

const SERVER_PORT = 3000;
const SERVER_ORIGIN = resolveServerOrigin();

/**
 * Typed Hono RPC client for the game server. Covers both the HTTP API
 * (`.$get()`/`.$post()`) and the WebSocket endpoints (`.$ws()`) — a renamed
 * or removed server route fails to compile here instead of only failing at
 * request time.
 */
export const api = hc(SERVER_ORIGIN) as unknown as ApiClient;

function resolveServerOrigin(): string {
    const configuredOrigin = import.meta.env.VITE_SERVER_ORIGIN?.trim();
    if (configuredOrigin) return normalizeHttpOrigin(configuredOrigin);

    const protocol = location.protocol === "https:" ? "https:" : "http:";
    return `${protocol}//${location.hostname}:${SERVER_PORT}`;
}

function normalizeHttpOrigin(origin: string): string {
    const url = new URL(origin, location.origin);
    if (url.protocol === "ws:") url.protocol = "http:";
    if (url.protocol === "wss:") url.protocol = "https:";
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error(`Unsupported VITE_SERVER_ORIGIN protocol: ${url.protocol}`);
    }
    return url.origin;
}
