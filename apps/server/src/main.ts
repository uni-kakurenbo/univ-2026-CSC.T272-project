import { cpus } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { websocket } from "hono/bun";

import { createServerApp } from "./app";
import { JsonMatchHistory } from "./matchHistory";
import { MatchServer } from "./matchServer";

const args = parseArgs(Bun.argv.slice(2));
const port = Number(args.port ?? 3000);
const tMax = Number(args["t-max"] ?? 100);
const seed = args.seed === undefined ? undefined : Number(args.seed);
const height = Number(args.height ?? 32);
const width = Number(args.width ?? 32);
const maxConcurrentMatches = positiveIntegerOption(
    args["max-concurrent-matches"],
    defaultMaxConcurrentMatches()
);
const maxQueuedMatches = positiveIntegerOption(args["max-queued-matches"], 65535);
const historyDirectory = Bun.env.MATCH_HISTORY_DIR ?? "./data/matches";
const host = Bun.env.HOST ?? "127.0.0.1";
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const duckExec = args["duck-exec"] ?? defaultAgentPath("duck");
const sphinxExec = args["sphinx-exec"] ?? defaultAgentPath("sphinx");
const runnerEntry = resolve(workspaceRoot, args["runner-entry"] ?? "apps/runner/src/main.ts");
const adaptorEntry = resolve(workspaceRoot, args["adaptor-entry"] ?? "apps/adaptor/src/main.ts");

const history = new JsonMatchHistory(historyDirectory);
const matchServer = new MatchServer(
    {
        tMax,
        seed,
        height,
        width,
        maxConcurrentMatches,
        maxQueuedMatches,
        duckExec,
        sphinxExec,
        runnerEntry,
        adaptorEntry,
        host,
        workspaceRoot,
    },
    history
);

const allowedOrigins = new Set(
    (Bun.env.ALLOWED_ORIGINS ?? "http://localhost:5173,http://localhost:8080")
        .split(",")
        .map(origin => origin.trim())
        .filter(Boolean)
);

const app = createServerApp(matchServer, { allowedOrigins, history });

const server = Bun.serve({
    port,
    hostname: host,
    fetch: app.fetch,
    websocket,
});

console.log(`[Server] Listening on ws://localhost:${server.port}`);
console.log(`[Server] Viewer endpoint: /api/ws/view`);
console.log(`[Server] Match history: ${historyDirectory}`);
console.log(`[Server] Max concurrent matches: ${maxConcurrentMatches}`);
console.log(`[Server] Max queued matches: ${maxQueuedMatches}`);
console.log(`[Server] Duck agent: ${duckExec}`);
console.log(`[Server] Sphinx agent: ${sphinxExec}`);
console.log(`[Server] Runner entry: ${runnerEntry}`);
console.log(`[Server] Adaptor entry: ${adaptorEntry}`);

function defaultMaxConcurrentMatches(): number {
    return Math.max(1, Math.floor(cpus().length + 2));
}

function positiveIntegerOption(value: string | undefined, fallback: number): number {
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) return fallback;
    return parsed;
}

function defaultAgentPath(role: "duck" | "sphinx"): string {
    const extension = process.platform === "win32" ? ".exe" : "";
    return resolve(workspaceRoot, `build/${role}-agent${extension}`);
}

function parseArgs(argv: string[]): Record<string, string | undefined> {
    const parsed: Record<string, string | undefined> = {};
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i]!;
        if (!token.startsWith("--")) continue;
        const key = token.slice(2);
        const next = argv[i + 1];
        if (!next || next.startsWith("--")) {
            parsed[key] = "true";
        } else {
            parsed[key] = next;
            i += 1;
        }
    }
    return parsed;
}
