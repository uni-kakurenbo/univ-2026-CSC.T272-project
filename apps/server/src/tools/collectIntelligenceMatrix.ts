import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { IntelligenceMatrix, IntelligenceMatrixCell, StatusMessage } from "@app/shared/types";

import type { ConcurrencyUpdateResponse, MatrixStartResponse } from "../appType";

interface CollectOptions {
    serverUrl: string;
    duckLevels: number[];
    sphinxLevels: number[];
    trialsPerCell: number;
    seed?: number;
    concurrency?: number;
    matrixRunId?: string;
    output?: string;
    format: "json" | "csv";
    pollIntervalMs: number;
    timeoutMs: number;
}

interface CollectionResult {
    matrixRunId: string;
    submittedAt: string;
    collectedAt: string;
    request: {
        duckLevels: number[];
        sphinxLevels: number[];
        trialsPerCell: number;
        seed?: number;
    };
    accepted: number;
    expectedTotal: number;
    completedTotal: number;
    missingTotal: number;
    status: "complete" | "incomplete";
    incompleteReason?: string;
    matrix: IntelligenceMatrix;
}

interface MatrixWaitResult {
    matrix: IntelligenceMatrix;
    status: CollectionResult["status"];
    incompleteReason?: string;
}

const DEFAULT_LEVELS = range(0, 3);
const DEFAULT_SERVER_URL = "http://127.0.0.1:3000";
const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 0;
const DEFAULT_REQUEST_RETRIES = 8;
const DEFAULT_REQUEST_RETRY_DELAY_MS = 1000;

async function main() {
    const options = parseArgs(Bun.argv.slice(2));
    const submittedAt = new Date().toISOString();
    if (options.concurrency !== undefined) {
        await updateServerConcurrency(options);
    }

    const expectedTotal =
        options.duckLevels.length * options.sphinxLevels.length * options.trialsPerCell;
    const matrixRun = await resolveMatrixRun(options, expectedTotal);
    console.log(
        `${matrixRun.started ? "Started" : "Resuming"} matrix run ${matrixRun.matrixRunId}: ${
            matrixRun.accepted
        }/${expectedTotal} matches accepted.`
    );

    const waitResult = await waitForMatrix(matrixRun.matrixRunId, options);
    const completedTotal = countCompletedTrials(waitResult.matrix, options);
    const result: CollectionResult = {
        matrixRunId: matrixRun.matrixRunId,
        submittedAt,
        collectedAt: new Date().toISOString(),
        request: {
            duckLevels: options.duckLevels,
            sphinxLevels: options.sphinxLevels,
            trialsPerCell: options.trialsPerCell,
            ...(options.seed !== undefined && { seed: options.seed }),
        },
        accepted: matrixRun.accepted,
        expectedTotal,
        completedTotal,
        missingTotal: Math.max(expectedTotal - completedTotal, 0),
        status: waitResult.status,
        ...(waitResult.incompleteReason && { incompleteReason: waitResult.incompleteReason }),
        matrix: normalizeMatrix(waitResult.matrix, options),
    };

    const output = await writeResult(result, options);
    console.log(`Collected ${completedTotal}/${expectedTotal} matches.`);
    console.log(`Saved ${options.format.toUpperCase()} data to ${output}`);
    if (result.status === "incomplete") {
        console.error(`Matrix run incomplete: ${result.incompleteReason}`);
        process.exitCode = 1;
    }
}

async function resolveMatrixRun(
    options: CollectOptions,
    expectedTotal: number
): Promise<{ matrixRunId: string; accepted: number; started: boolean }> {
    if (options.matrixRunId) {
        return { matrixRunId: options.matrixRunId, accepted: expectedTotal, started: false };
    }

    const startResponse = await startMatrixRun(options);
    if (!startResponse.ok) {
        throw new Error(`Failed to start matrix run: ${startResponse.reason}`);
    }

    return {
        matrixRunId: startResponse.matrixRunId,
        accepted: startResponse.accepted,
        started: true,
    };
}

async function updateServerConcurrency(options: CollectOptions): Promise<void> {
    const response = await fetchJson<ConcurrencyUpdateResponse>(
        apiUrl(options.serverUrl, "/api/matches/concurrency"),
        {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ maxConcurrentMatches: options.concurrency }),
        },
        {
            retries: DEFAULT_REQUEST_RETRIES,
            retryDelayMs: DEFAULT_REQUEST_RETRY_DELAY_MS,
        }
    );
    if (!response.ok) {
        throw new Error(`Failed to update server concurrency: ${response.reason}`);
    }

    console.log(
        `Server concurrency set to ${response.status.maxConcurrentMatches ?? options.concurrency}.`
    );
}

async function startMatrixRun(options: CollectOptions): Promise<MatrixStartResponse> {
    return fetchJson<MatrixStartResponse>(
        apiUrl(options.serverUrl, "/api/matches/intelligence-matrix"),
        {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                duckLevels: options.duckLevels,
                sphinxLevels: options.sphinxLevels,
                trialsPerCell: options.trialsPerCell,
                ...(options.seed !== undefined && { seed: options.seed }),
            }),
        }
    );
}

async function waitForMatrix(
    matrixRunId: string,
    options: CollectOptions
): Promise<MatrixWaitResult> {
    const startedAt = Date.now();
    let previousCompleted = -1;
    let previousServerStatus = "";

    while (true) {
        const url = apiUrl(options.serverUrl, "/api/matches/intelligence-matrix");
        url.searchParams.set("matrixRunId", matrixRunId);
        const matrix = await fetchJson<IntelligenceMatrix>(url, undefined, {
            retries: DEFAULT_REQUEST_RETRIES,
            retryDelayMs: DEFAULT_REQUEST_RETRY_DELAY_MS,
        });
        const serverStatus = await fetchServerStatus(options);
        const completed = countCompletedTrials(matrix, options);
        const expected =
            options.duckLevels.length * options.sphinxLevels.length * options.trialsPerCell;
        const serverStatusText = `${serverStatus.state}:${serverStatus.activeMatchCount ?? 0}:${
            serverStatus.startingMatchCount ?? 0
        }:${serverStatus.queuedMatchCount ?? 0}`;

        if (completed !== previousCompleted || serverStatusText !== previousServerStatus) {
            console.log(
                `Progress: ${completed}/${expected} (server: ${serverStatus.state}, active=${
                    serverStatus.activeMatchCount ?? 0
                }, starting=${serverStatus.startingMatchCount ?? 0}, queued=${
                    serverStatus.queuedMatchCount ?? 0
                })`
            );
            previousCompleted = completed;
            previousServerStatus = serverStatusText;
        }
        if (isComplete(matrix, options)) return { matrix, status: "complete" };
        if (serverStatus.state === "idle") {
            return {
                matrix,
                status: "incomplete",
                incompleteReason:
                    "server became idle before all accepted matrix matches were saved",
            };
        }
        if (options.timeoutMs > 0 && Date.now() - startedAt > options.timeoutMs) {
            return {
                matrix,
                status: "incomplete",
                incompleteReason: `timed out waiting for matrix run ${matrixRunId}`,
            };
        }

        await Bun.sleep(options.pollIntervalMs);
    }
}

async function fetchServerStatus(options: CollectOptions): Promise<StatusMessage> {
    return fetchJson<StatusMessage>(apiUrl(options.serverUrl, "/api/matches/status"), undefined, {
        retries: DEFAULT_REQUEST_RETRIES,
        retryDelayMs: DEFAULT_REQUEST_RETRY_DELAY_MS,
    });
}

interface FetchJsonOptions {
    retries?: number;
    retryDelayMs?: number;
}

async function fetchJson<T>(
    url: URL,
    init?: RequestInit,
    options: FetchJsonOptions = {}
): Promise<T> {
    const retries = options.retries ?? 0;
    const retryDelayMs = options.retryDelayMs ?? DEFAULT_REQUEST_RETRY_DELAY_MS;
    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt++) {
        let response: Response;
        let body: string;
        try {
            response = await fetch(url, init);
            body = await response.text();
        } catch (error) {
            if (attempt >= retries) {
                throw new Error(`Could not reach ${url.toString()}: ${String(error)}`);
            }
            lastError = error;
            await retryAfterDelay(attempt, retries, retryDelayMs, lastError);
            continue;
        }

        if (!response.ok) {
            const error = new Error(
                `${init?.method ?? "GET"} ${url.toString()} failed: ${response.status} ${body}`
            );
            if (!shouldRetryStatus(response.status)) throw error;
            if (attempt >= retries) {
                throw error;
            }
            lastError = error;
            await retryAfterDelay(attempt, retries, retryDelayMs, lastError);
            continue;
        }

        return JSON.parse(body) as T;
    }

    throw new Error(`Could not reach ${url.toString()}: ${String(lastError)}`);
}

async function retryAfterDelay(
    attempt: number,
    retries: number,
    retryDelayMs: number,
    error: unknown
): Promise<void> {
    const nextDelayMs = retryDelayMs * (attempt + 1);
    console.warn(
        `Request failed, retrying in ${nextDelayMs}ms (${attempt + 1}/${retries}): ${String(error)}`
    );
    await Bun.sleep(nextDelayMs);
}

function shouldRetryStatus(status: number): boolean {
    return status === 429 || status >= 500;
}

async function writeResult(result: CollectionResult, options: CollectOptions): Promise<string> {
    const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
    const output =
        options.output ??
        join(
            workspaceRoot,
            "data",
            "intelligence-matrix",
            `${result.matrixRunId}.${options.format}`
        );
    const content =
        options.format === "json"
            ? `${JSON.stringify(result, null, 2)}\n`
            : matrixToCsv(result.matrix);

    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, content);
    return output;
}

function matrixToCsv(matrix: IntelligenceMatrix): string {
    const rows = [
        [
            "duckLevel",
            "sphinxLevel",
            "total",
            "duckWins",
            "sphinxWins",
            "draws",
            "duckWinRate",
            "sphinxWinRate",
            "drawRate",
        ],
        ...matrix.cells
            .flat()
            .map(cell => [
                cell.duckLevel,
                cell.sphinxLevel,
                cell.total,
                cell.duckWins,
                cell.sphinxWins,
                cell.draws,
                cell.duckWinRate,
                cell.sphinxWinRate,
                cell.drawRate,
            ]),
    ];

    return `${rows.map(row => row.join(",")).join("\n")}\n`;
}

function normalizeMatrix(matrix: IntelligenceMatrix, options: CollectOptions): IntelligenceMatrix {
    const cellsByLevel = indexCells(matrix);
    return {
        duckLevels: options.duckLevels,
        sphinxLevels: options.sphinxLevels,
        cells: options.duckLevels.map(duckLevel =>
            options.sphinxLevels.map(
                sphinxLevel =>
                    cellsByLevel.get(cellKey(duckLevel, sphinxLevel)) ??
                    emptyCell(duckLevel, sphinxLevel)
            )
        ),
    };
}

function isComplete(matrix: IntelligenceMatrix, options: CollectOptions): boolean {
    const cellsByLevel = indexCells(matrix);
    return options.duckLevels.every(duckLevel =>
        options.sphinxLevels.every(
            sphinxLevel =>
                (cellsByLevel.get(cellKey(duckLevel, sphinxLevel))?.total ?? 0) >=
                options.trialsPerCell
        )
    );
}

function countCompletedTrials(matrix: IntelligenceMatrix, options: CollectOptions): number {
    const cellsByLevel = indexCells(matrix);
    return options.duckLevels.reduce(
        (sum, duckLevel) =>
            sum +
            options.sphinxLevels.reduce(
                (levelSum, sphinxLevel) =>
                    levelSum +
                    Math.min(
                        cellsByLevel.get(cellKey(duckLevel, sphinxLevel))?.total ?? 0,
                        options.trialsPerCell
                    ),
                0
            ),
        0
    );
}

function indexCells(matrix: IntelligenceMatrix): Map<string, IntelligenceMatrixCell> {
    return new Map(
        matrix.cells.flat().map(cell => [cellKey(cell.duckLevel, cell.sphinxLevel), cell])
    );
}

function emptyCell(duckLevel: number, sphinxLevel: number): IntelligenceMatrixCell {
    return {
        duckLevel,
        sphinxLevel,
        total: 0,
        duckWins: 0,
        sphinxWins: 0,
        draws: 0,
        duckWinRate: 0,
        sphinxWinRate: 0,
        drawRate: 0,
    };
}

function cellKey(duckLevel: number, sphinxLevel: number): string {
    return `${duckLevel}:${sphinxLevel}`;
}

function apiUrl(serverUrl: string, path: string): URL {
    return new URL(path, serverUrl.endsWith("/") ? serverUrl : `${serverUrl}/`);
}

function parseArgs(args: string[]): CollectOptions {
    const flags = readFlags(args);
    if (flags.has("help")) {
        printUsage();
        process.exit(0);
    }

    const output = flags.get("output");
    const format = parseFormat(flags.get("format"), output);
    return {
        serverUrl: flags.get("server") ?? DEFAULT_SERVER_URL,
        duckLevels: parseLevels(
            flags.get("duck-levels") ?? flags.get("duckLevels"),
            DEFAULT_LEVELS
        ),
        sphinxLevels: parseLevels(
            flags.get("sphinx-levels") ?? flags.get("sphinxLevels"),
            DEFAULT_LEVELS
        ),
        trialsPerCell: parsePositiveInteger(
            flags.get("trials-per-cell") ?? flags.get("trialsPerCell") ?? flags.get("count"),
            100,
            "trials-per-cell"
        ),
        seed: parseOptionalInteger(flags.get("seed"), "seed"),
        concurrency: parseOptionalPositiveInteger(
            flags.get("concurrency") ?? flags.get("max-concurrent-matches"),
            "concurrency"
        ),
        matrixRunId: parseOptionalNonEmptyString(
            flags.get("matrix-run-id") ?? flags.get("matrixRunId"),
            "matrix-run-id"
        ),
        output,
        format,
        pollIntervalMs: parsePositiveInteger(
            flags.get("poll-interval-ms") ?? flags.get("pollIntervalMs"),
            DEFAULT_POLL_INTERVAL_MS,
            "poll-interval-ms"
        ),
        timeoutMs: parseNonNegativeInteger(
            flags.get("timeout-ms") ?? flags.get("timeoutMs"),
            DEFAULT_TIMEOUT_MS,
            "timeout-ms"
        ),
    };
}

function readFlags(args: string[]): Map<string, string | undefined> {
    const flags = new Map<string, string | undefined>();
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);

        const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
        const nextArg = args[i + 1];
        if (inlineValue !== undefined) {
            flags.set(rawKey, inlineValue);
        } else if (nextArg && !nextArg.startsWith("--")) {
            flags.set(rawKey, nextArg);
            i++;
        } else {
            flags.set(rawKey, undefined);
        }
    }
    return flags;
}

function parseLevels(value: string | undefined, fallback: number[]): number[] {
    if (!value) return fallback;

    const levels = value
        .split(",")
        .flatMap(part => {
            const rangeMatch = /^(\d+)-(\d+)$/.exec(part.trim());
            if (!rangeMatch) return [parseStrictInteger(part.trim(), "level")];

            const start = parseStrictInteger(rangeMatch[1], "level range start");
            const end = parseStrictInteger(rangeMatch[2], "level range end");
            if (start > end) throw new Error(`Invalid level range: ${part}`);
            return range(start, end);
        })
        .filter(level => {
            if (level < 0 || level > 3) throw new Error(`Level must be between 0 and 3: ${level}`);
            return true;
        });

    if (levels.length === 0) throw new Error("At least one level is required.");
    return [...new Set(levels)].sort((a, b) => a - b);
}

function parseFormat(value: string | undefined, output: string | undefined): "json" | "csv" {
    const inferred = output?.endsWith(".csv") ? "csv" : undefined;
    const format = value ?? inferred ?? "json";
    if (format !== "json" && format !== "csv") throw new Error("--format must be json or csv.");
    return format;
}

function parseOptionalInteger(value: string | undefined, label: string): number | undefined {
    return value === undefined ? undefined : parseStrictInteger(value, label);
}

function parseOptionalNonEmptyString(value: string | undefined, label: string): string | undefined {
    if (value === undefined) return undefined;
    const trimmed = value.trim();
    if (trimmed.length === 0) throw new Error(`--${label} must not be empty.`);
    return trimmed;
}

function parseOptionalPositiveInteger(
    value: string | undefined,
    label: string
): number | undefined {
    if (value === undefined) return undefined;
    const parsed = parseStrictInteger(value, label);
    if (parsed < 1) throw new Error(`--${label} must be at least 1.`);
    return parsed;
}

function parsePositiveInteger(value: string | undefined, fallback: number, label: string): number {
    const parsed = value === undefined ? fallback : parseStrictInteger(value, label);
    if (parsed < 1) throw new Error(`--${label} must be at least 1.`);
    return parsed;
}

function parseNonNegativeInteger(
    value: string | undefined,
    fallback: number,
    label: string
): number {
    const parsed = value === undefined ? fallback : parseStrictInteger(value, label);
    if (parsed < 0) throw new Error(`--${label} must be 0 or greater.`);
    return parsed;
}

function parseStrictInteger(value: string, label: string): number {
    if (!/^-?\d+$/.test(value)) throw new Error(`Invalid ${label}: ${value}`);
    return Number(value);
}

function range(start: number, end: number): number[] {
    return Array.from({ length: end - start + 1 }, (_, i) => start + i);
}

function printUsage() {
    console.log(`Usage:
  bun run collect:intelligence-matrix -- [options]

Options:
  --server <url>              Server URL. Default: http://127.0.0.1:3000
  --duck-levels <levels>      Comma list or range. Default: 0-3
  --sphinx-levels <levels>    Comma list or range. Default: 0-3
  --trials-per-cell <count>   Matches per level pair. Default: 100
  --seed <number>             Base seed for reproducible runs.
  --concurrency <count>       Server-side parallel match count.
  --matrix-run-id <id>        Resume polling an existing matrix run without submitting matches.
  --output <path>             Output path. Default: data/intelligence-matrix/<run-id>.<format>
  --format <json|csv>         Output format. Default: json, or csv when output ends with .csv
  --poll-interval-ms <ms>     Poll interval. Default: 2000
  --timeout-ms <ms>           Timeout, 0 disables it. Default: 0
`);
}

main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
