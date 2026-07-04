import type { Context, Next } from "hono";
import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { cors } from "hono/cors";

import type {
    IntelligenceMatrix,
    MatchHistoryStats,
    MatchReplay,
    MatchStartRequest,
    MatchSummary,
    StatusMessage,
} from "@app/shared/types";

interface MatchHistoryReader {
    list(): Promise<MatchSummary[]>;
    stats(): Promise<MatchHistoryStats>;
    intelligenceMatrix(matrixRunId?: string): Promise<IntelligenceMatrix>;
    find(id: string): Promise<MatchReplay | null>;
    clear(): Promise<number>;
}

interface ServerArena {
    status(): StatusMessage;
    setMaxConcurrentMatches(maxConcurrentMatches: number): StatusMessage | null;
    requestStart(request?: MatchStartRequest | number): Promise<
        | { ok: true; accepted: number }
        | {
              ok: false;
              reason:
                  "invalid-count" | "invalid-level" | "capacity-exceeded" | "runner-start-failed";
          }
    >;
    addViewer(viewer: { send(message: string): void }): void;
    removeViewer(viewer: { send(message: string): void }): void;
}

export interface ServerAppOptions {
    /** Origins allowed to call the HTTP API / open WebSocket connections. */
    allowedOrigins: ReadonlySet<string>;
    history: MatchHistoryReader;
}

/** Builds the Hono app that fronts the Server process. */
export function createServerApp(arena: ServerArena, options: ServerAppOptions) {
    const { allowedOrigins, history } = options;

    function isOriginAllowed(origin: string | undefined): boolean {
        return !origin || allowedOrigins.has(origin);
    }

    function rejectDisallowedOrigin(c: Context, next: Next) {
        if (!isOriginAllowed(c.req.header("origin"))) {
            return c.text("Origin not allowed", 403);
        }
        return next();
    }

    const app = new Hono()
        .basePath("/api")
        .use(
            "*",
            cors({
                origin: origin => (allowedOrigins.has(origin) ? origin : undefined),
            })
        )
        .post("/matches", async c => {
            const body = await c.req.json().catch((): unknown => ({}));
            const result = await arena.requestStart(parseMatchStartRequest(body));
            if (result.ok) return c.json({ ok: true, accepted: result.accepted }, 202);
            if (
                result.reason === "invalid-count" ||
                result.reason === "invalid-level" ||
                result.reason === "capacity-exceeded"
            ) {
                return c.json({ ok: false, reason: result.reason }, 409);
            }
            return c.json({ ok: false, reason: result.reason }, 500);
        })
        .post("/matches/intelligence-matrix", async c => {
            const body = await c.req.json().catch((): unknown => ({}));
            const matrix = parseMatrixStartRequests(body);
            if (!matrix) {
                return c.json({ ok: false, reason: "invalid-matrix" }, 409);
            }

            let accepted = 0;
            for (const request of matrix.requests) {
                const result = await arena.requestStart(request);
                if (!result.ok) return c.json({ ok: false, reason: result.reason, accepted }, 409);
                accepted += result.accepted;
            }
            return c.json({ ok: true, accepted, matrixRunId: matrix.matrixRunId }, 202);
        })
        .get("/matches", async c => c.json(await history.list()))
        .delete("/matches", async c => c.json({ deleted: await history.clear() }))
        .get("/matches/stats", async c => c.json(await history.stats()))
        .get("/matches/intelligence-matrix", async c =>
            c.json(await history.intelligenceMatrix(readNonEmptyString(c.req.query("matrixRunId"))))
        )
        .get("/matches/status", c => c.json(arena.status()))
        .put("/matches/concurrency", async c => {
            const body = await c.req.json().catch((): unknown => ({}));
            const status = isRecord(body)
                ? arena.setMaxConcurrentMatches(readNumber(body, "maxConcurrentMatches") ?? 0)
                : null;
            return status
                ? c.json({ ok: true, status })
                : c.json({ ok: false, reason: "invalid-concurrency" }, 409);
        })
        .get("/matches/:id", async c => {
            const match = await history.find(c.req.param("id"));
            return match ? c.json(match) : c.json({ error: "Match not found" }, 404);
        })
        .get("/health", c => c.json({ ok: true }))
        .get(
            "/ws/view",
            rejectDisallowedOrigin,
            upgradeWebSocket(() => ({
                onOpen(_evt, ws) {
                    arena.addViewer(ws.raw);
                },
                onClose(_evt, ws) {
                    arena.removeViewer(ws.raw);
                },
            }))
        )
        .all("*", c => c.text("Wheelduck 2 vs Sphinx game server", 200));

    return app;
}

function parseMatchStartRequest(body: unknown): MatchStartRequest {
    if (!isRecord(body)) return {};
    return {
        ...(readNumber(body, "count") !== undefined && { count: readNumber(body, "count") }),
        ...(readNumber(body, "duckLevel") !== undefined && {
            duckLevel: readNumber(body, "duckLevel"),
        }),
        ...(readNumber(body, "sphinxLevel") !== undefined && {
            sphinxLevel: readNumber(body, "sphinxLevel"),
        }),
        ...(readNumber(body, "seed") !== undefined && { seed: readNumber(body, "seed") }),
    };
}

function parseMatrixStartRequests(
    body: unknown
): { matrixRunId: string; requests: MatchStartRequest[] } | null {
    if (!isRecord(body)) return null;

    const duckLevels = readNumberArray(body, "duckLevels");
    const sphinxLevels = readNumberArray(body, "sphinxLevels");
    const trialsPerCell = readNumber(body, "trialsPerCell") ?? readNumber(body, "count") ?? 1;
    const baseSeed = readNumber(body, "seed");
    if (
        duckLevels.length === 0 ||
        sphinxLevels.length === 0 ||
        !Number.isInteger(trialsPerCell) ||
        trialsPerCell < 1
    ) {
        return null;
    }

    const matrixRunId = crypto.randomUUID();
    const requests: MatchStartRequest[] = [];
    let trialOffset = 0;
    for (const duckLevel of duckLevels) {
        for (const sphinxLevel of sphinxLevels) {
            requests.push({
                count: trialsPerCell,
                duckLevel,
                sphinxLevel,
                matrixRunId,
                matrixTrial: trialOffset,
                ...(baseSeed !== undefined && { seed: baseSeed + trialOffset }),
            });
            trialOffset += trialsPerCell;
        }
    }
    return { matrixRunId, requests };
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
    const value = record[key];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readNumberArray(record: Record<string, unknown>, key: string): number[] {
    const value = record[key];
    if (!Array.isArray(value)) return [];
    return value.filter(
        (item): item is number => typeof item === "number" && Number.isFinite(item)
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function readNonEmptyString(value: string | undefined): string | undefined {
    return value && value.trim().length > 0 ? value : undefined;
}

export type AppType = ReturnType<typeof createServerApp>;
