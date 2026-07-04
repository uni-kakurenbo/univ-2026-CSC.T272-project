import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MatchAgentConfig } from "@app/shared/types";

import type { CompletedMatch } from "./matchHistory";
import { JsonMatchHistory, summarizeIntelligenceMatrix, summarizeMatches } from "./matchHistory";

const directories: string[] = [];

afterEach(async () => {
    await Promise.all(
        directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))
    );
});

describe("JsonMatchHistory", () => {
    test("saves, lists, and loads a completed match", async () => {
        const directory = await createDirectory();
        const history = new JsonMatchHistory(directory);
        const match = completedMatch();

        const saved = await history.save(match);

        expect(saved.summary.id).toBe(match.id);
        expect(saved.summary.frameCount).toBe(1);
        expect(await history.list()).toEqual([saved.summary]);
        expect(await history.find(match.id)).toEqual(saved);
    });

    test("persists agent intelligence metadata", async () => {
        const directory = await createDirectory();
        const history = new JsonMatchHistory(directory);
        const agentConfig: MatchAgentConfig = {
            duck: { level: 4 },
            sphinx: { level: 8 },
            seed: 123,
            matrixRunId: "matrix-1",
            matrixTrial: 2,
        };

        const saved = await history.save(completedMatch(undefined, agentConfig));

        expect(saved.summary.agentConfig).toEqual(agentConfig);
        expect((await history.list())[0]?.agentConfig).toEqual(agentConfig);
        expect((await history.find(saved.summary.id))?.summary.agentConfig).toEqual(agentConfig);
    });

    test("summarizes intelligence matrix cells", () => {
        const summaries = [
            completedMatch(
                { status: "WIN", winner: "DUCK" },
                { duck: { level: 1 }, sphinx: { level: 1 } }
            ),
            completedMatch(
                { status: "LOSE", winner: "SPHINX" },
                { duck: { level: 1 }, sphinx: { level: 1 } }
            ),
            completedMatch(
                { status: "WIN", winner: "DUCK" },
                { duck: { level: 2 }, sphinx: { level: 1 } }
            ),
            completedMatch(
                { status: "DRAW", winner: "DRAW" },
                { duck: { level: 2 }, sphinx: { level: 3 } }
            ),
        ].map(match => ({
            id: match.id,
            startedAt: match.startedAt,
            finishedAt: match.finishedAt,
            frameCount: match.frames.length,
            ...match.result,
            agentConfig: match.agentConfig,
        }));

        expect(summarizeIntelligenceMatrix(summaries)).toEqual({
            duckLevels: [1, 2],
            sphinxLevels: [1, 3],
            cells: [
                [
                    {
                        duckLevel: 1,
                        sphinxLevel: 1,
                        total: 2,
                        duckWins: 1,
                        sphinxWins: 1,
                        draws: 0,
                        duckWinRate: 0.5,
                        sphinxWinRate: 0.5,
                        drawRate: 0,
                    },
                    {
                        duckLevel: 1,
                        sphinxLevel: 3,
                        total: 0,
                        duckWins: 0,
                        sphinxWins: 0,
                        draws: 0,
                        duckWinRate: 0,
                        sphinxWinRate: 0,
                        drawRate: 0,
                    },
                ],
                [
                    {
                        duckLevel: 2,
                        sphinxLevel: 1,
                        total: 1,
                        duckWins: 1,
                        sphinxWins: 0,
                        draws: 0,
                        duckWinRate: 1,
                        sphinxWinRate: 0,
                        drawRate: 0,
                    },
                    {
                        duckLevel: 2,
                        sphinxLevel: 3,
                        total: 1,
                        duckWins: 0,
                        sphinxWins: 0,
                        draws: 1,
                        duckWinRate: 0,
                        sphinxWinRate: 0,
                        drawRate: 1,
                    },
                ],
            ],
        });
    });

    test("summarizes intelligence matrix cells for a single matrix run", () => {
        const summaries = [
            completedMatch(
                { status: "WIN", winner: "DUCK" },
                {
                    duck: { level: 1 },
                    sphinx: { level: 1 },
                    matrixRunId: "run-a",
                    matrixTrial: 0,
                }
            ),
            completedMatch(
                { status: "LOSE", winner: "SPHINX" },
                {
                    duck: { level: 1 },
                    sphinx: { level: 1 },
                    matrixRunId: "run-b",
                    matrixTrial: 0,
                }
            ),
        ].map(match => ({
            id: match.id,
            startedAt: match.startedAt,
            finishedAt: match.finishedAt,
            frameCount: match.frames.length,
            ...match.result,
            agentConfig: match.agentConfig,
        }));

        expect(summarizeIntelligenceMatrix(summaries, { matrixRunId: "run-a" })).toEqual({
            duckLevels: [1],
            sphinxLevels: [1],
            cells: [
                [
                    {
                        duckLevel: 1,
                        sphinxLevel: 1,
                        total: 1,
                        duckWins: 1,
                        sphinxWins: 0,
                        draws: 0,
                        duckWinRate: 1,
                        sphinxWinRate: 0,
                        drawRate: 0,
                    },
                ],
            ],
        });
    });

    test("summarizes and clears saved matches", async () => {
        const directory = await createDirectory();
        const history = new JsonMatchHistory(directory);
        await history.save(completedMatch({ winner: "DUCK", status: "WIN" }));
        await history.save(completedMatch({ winner: "SPHINX", status: "LOSE" }));
        await history.save(completedMatch({ winner: "DRAW", status: "DRAW" }));

        expect(await history.stats()).toEqual({
            total: 3,
            duckWins: 1,
            sphinxWins: 1,
            draws: 1,
            duckWinRate: 1 / 3,
            sphinxWinRate: 1 / 3,
            drawRate: 1 / 3,
        });
        expect(await history.clear()).toBe(3);
        expect(await history.list()).toEqual([]);
    });

    test("returns null for invalid and unknown ids", async () => {
        const history = new JsonMatchHistory(await createDirectory());

        expect(await history.find("../outside")).toBeNull();
        expect(await history.find(crypto.randomUUID())).toBeNull();
    });

    test("summarizes an empty match list", () => {
        expect(summarizeMatches([])).toEqual({
            total: 0,
            duckWins: 0,
            sphinxWins: 0,
            draws: 0,
            duckWinRate: 0,
            sphinxWinRate: 0,
            drawRate: 0,
        });
    });
});

async function createDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "match-history-"));
    directories.push(directory);
    return directory;
}

function completedMatch(
    result: Pick<CompletedMatch["result"], "status" | "winner"> = {
        status: "WIN",
        winner: "DUCK",
    },
    agentConfig?: MatchAgentConfig
): CompletedMatch {
    return {
        id: crypto.randomUUID(),
        startedAt: "2026-07-06T00:00:00.000Z",
        finishedAt: "2026-07-06T00:01:00.000Z",
        result: {
            status: result.status,
            winner: result.winner,
            turn: 1,
            duckScore: 998,
            sphinxScore: -998,
        },
        ...(agentConfig && { agentConfig }),
        frames: [
            {
                type: "frame",
                turn: 1,
                status: "WIN",
                winner: "DUCK",
                map: [[2]],
                duck: [0, 0],
                sphinx: [0, 0],
                goal: [0, 0],
                sensors: { sound: 0, heat: 0, radio: -1, compass: "UNKNOWN" },
                duckMemory: [[2]],
                agentTurns: {
                    duck: null,
                    sphinx: null,
                },
            },
        ],
    };
}
