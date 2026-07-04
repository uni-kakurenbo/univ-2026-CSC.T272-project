import { websocket } from "hono/bun";

import { createRunnerApp } from "./app";

const args = parseArgs(Bun.argv.slice(2));
const port = Number(args.port ?? 0);
const host = args.host ?? "127.0.0.1";
const matchId = args["match-id"] ?? crypto.randomUUID();
const tMax = Number(args["t-max"] ?? 100);
const seed = args.seed === undefined ? undefined : Number(args.seed);
const height = Number(args.height ?? 32);
const width = Number(args.width ?? 32);

if (Number.isNaN(port) || port < 0) {
    console.error("Usage: bun run apps/runner/src/main.ts --port <PORT> [--match-id <ID>]");
    process.exit(1);
}

const app = createRunnerApp({
    matchId,
    game: { tMax, seed, height, width },
    emit: event => {
        console.log(JSON.stringify(event));
    },
    exit: code => process.exit(code),
});

const server = Bun.serve({
    port,
    hostname: host,
    fetch: app.fetch,
    websocket,
});

console.log(JSON.stringify({ type: "ready", matchId, port: server.port }));
console.error(`[Runner] Match ${matchId} listening on ws://${host}:${server.port}`);

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
