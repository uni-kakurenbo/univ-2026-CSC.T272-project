import { mkdir, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

import type {
    EpisodeResult,
    IntelligenceMatrix,
    IntelligenceMatrixCell,
    MatchAgentConfig,
    MatchHistoryStats,
    MatchReplay,
    MatchSummary,
    PublicFrame,
} from "@app/shared/types";

export interface CompletedMatch {
    id: string;
    startedAt: string;
    finishedAt: string;
    result: EpisodeResult;
    frames: PublicFrame[];
    agentConfig?: MatchAgentConfig;
}

export interface MatchHistory {
    save(match: CompletedMatch): Promise<MatchReplay>;
    list(): Promise<MatchSummary[]>;
    stats(): Promise<MatchHistoryStats>;
    intelligenceMatrix(matrixRunId?: string): Promise<IntelligenceMatrix>;
    find(id: string): Promise<MatchReplay | null>;
    clear(): Promise<number>;
}

export class JsonMatchHistory implements MatchHistory {
    constructor(private readonly directory: string) {}

    async save(match: CompletedMatch): Promise<MatchReplay> {
        await mkdir(this.directory, { recursive: true });
        const replay = toReplay(match);
        const destination = this.pathFor(match.id);
        const temporary = `${destination}.${crypto.randomUUID()}.tmp`;

        await Bun.write(temporary, `${JSON.stringify(replay)}\n`);
        await rename(temporary, destination);
        return replay;
    }

    async list(): Promise<MatchSummary[]> {
        await mkdir(this.directory, { recursive: true });
        const entries = await readdir(this.directory, { withFileTypes: true });
        const summaries = await Promise.all(
            entries
                .filter(entry => entry.isFile() && entry.name.endsWith(".json"))
                .map(async entry => {
                    try {
                        return (await this.read(join(this.directory, entry.name))).summary;
                    } catch (error) {
                        console.error(`[History] Ignoring invalid match log ${entry.name}:`, error);
                        return null;
                    }
                })
        );

        return summaries
            .filter((summary): summary is MatchSummary => summary !== null)
            .sort((a, b) => b.finishedAt.localeCompare(a.finishedAt));
    }

    async find(id: string): Promise<MatchReplay | null> {
        if (!isMatchId(id)) return null;
        const file = Bun.file(this.pathFor(id));
        if (!(await file.exists())) return null;
        return this.read(file.name ?? this.pathFor(id));
    }

    async stats(): Promise<MatchHistoryStats> {
        return summarizeMatches(await this.list());
    }

    async intelligenceMatrix(matrixRunId?: string): Promise<IntelligenceMatrix> {
        return summarizeIntelligenceMatrix(await this.list(), { matrixRunId });
    }

    async clear(): Promise<number> {
        await mkdir(this.directory, { recursive: true });
        const entries = await readdir(this.directory, { withFileTypes: true });
        const targets = entries.filter(entry => entry.isFile() && entry.name.endsWith(".json"));
        await Promise.all(targets.map(entry => unlink(join(this.directory, entry.name))));
        return targets.length;
    }

    private pathFor(id: string): string {
        return join(this.directory, `${id}.json`);
    }

    private async read(path: string): Promise<MatchReplay> {
        return (await Bun.file(path).json()) as MatchReplay;
    }
}

function isMatchId(value: string): boolean {
    return /^[0-9a-f-]{36}$/i.test(value);
}

export function summarizeMatches(matches: readonly MatchSummary[]): MatchHistoryStats {
    const total = matches.length;
    const duckWins = matches.filter(match => match.winner === "DUCK").length;
    const sphinxWins = matches.filter(match => match.winner === "SPHINX").length;
    const draws = matches.filter(match => match.winner === "DRAW").length;

    return {
        total,
        duckWins,
        sphinxWins,
        draws,
        duckWinRate: rate(duckWins, total),
        sphinxWinRate: rate(sphinxWins, total),
        drawRate: rate(draws, total),
    };
}

export function summarizeIntelligenceMatrix(
    matches: readonly MatchSummary[],
    options: { matrixRunId?: string } = {}
): IntelligenceMatrix {
    const matchesWithLevels = matches
        .filter(hasAgentConfig)
        .filter(
            match =>
                options.matrixRunId === undefined ||
                match.agentConfig.matrixRunId === options.matrixRunId
        );
    const duckLevels = uniqueSorted(matchesWithLevels.map(match => match.agentConfig.duck.level));
    const sphinxLevels = uniqueSorted(
        matchesWithLevels.map(match => match.agentConfig.sphinx.level)
    );

    const cells = duckLevels.map(duckLevel =>
        sphinxLevels.map<IntelligenceMatrixCell>(sphinxLevel => {
            const matching = matchesWithLevels.filter(
                match =>
                    match.agentConfig.duck.level === duckLevel &&
                    match.agentConfig.sphinx.level === sphinxLevel
            );
            return { duckLevel, sphinxLevel, ...summarizeMatches(matching) };
        })
    );

    return { duckLevels, sphinxLevels, cells };
}

function hasAgentConfig(
    match: MatchSummary
): match is MatchSummary & { agentConfig: MatchAgentConfig } {
    return match.agentConfig !== undefined;
}

function uniqueSorted(values: readonly number[]): number[] {
    return [...new Set(values)].sort((a, b) => a - b);
}

function rate(count: number, total: number): number {
    return total === 0 ? 0 : count / total;
}

function toReplay(match: CompletedMatch): MatchReplay {
    return {
        summary: {
            id: match.id,
            startedAt: match.startedAt,
            finishedAt: match.finishedAt,
            frameCount: match.frames.length,
            ...match.result,
            ...(match.agentConfig && { agentConfig: match.agentConfig }),
        },
        frames: match.frames,
    };
}
