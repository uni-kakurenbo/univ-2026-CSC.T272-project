import type {
    ArenaState,
    MatchAgentConfig,
    MatchStartRequest,
    PublicFrame,
    StatusMessage,
} from "@app/shared/types";

import type { CompletedMatch, MatchHistory } from "./matchHistory";

export type StartResult =
    | { ok: true; accepted: number }
    | {
          ok: false;
          reason: "invalid-count" | "invalid-level" | "capacity-exceeded" | "runner-start-failed";
      };

interface QueuedMatchConfig {
    duckLevel: number;
    sphinxLevel: number;
    seed?: number;
    matrixRunId?: string;
    matrixTrial?: number;
}

export interface Broadcastable {
    send(message: string): void;
}

export interface MatchServerOptions {
    tMax: number;
    seed?: number;
    height: number;
    width: number;
    maxConcurrentMatches: number;
    maxQueuedMatches: number;
    duckExec: string;
    sphinxExec: string;
    runnerEntry: string;
    adaptorEntry: string;
    host: string;
    workspaceRoot: string;
}

type RunnerEvent =
    | { type: "ready"; matchId: string; port: number }
    | { type: "status"; matchId: string; state: ArenaState }
    | { type: "frame"; matchId: string; frame: PublicFrame }
    | ({ type: "result"; matchId: string } & CompletedMatch)
    | { type: "error"; matchId: string; message: string };

interface RunnerProcess {
    id: string;
    port: number;
    runner: Bun.Subprocess<"ignore", "pipe", "inherit">;
    adaptors: Bun.Subprocess<"ignore", "inherit", "inherit">[];
    agentConfig: MatchAgentConfig;
    readyCallback?: (port: number) => void;
    errorCallback?: (err: Error) => void;
}

export class MatchServer {
    private readonly viewers = new Set<Broadcastable>();
    private readonly runners = new Map<string, RunnerProcess>();
    private readonly matchStartQueue: QueuedMatchConfig[] = [];
    private pendingRunnerStarts = 0;
    private isDrainingQueue = false;
    private latestFrame: PublicFrame | undefined;

    constructor(
        private readonly options: MatchServerOptions,
        private readonly history: MatchHistory
    ) {}

    addViewer(ws: Broadcastable): void {
        this.viewers.add(ws);
        ws.send(JSON.stringify(this.statusMessage()));
        if (this.latestFrame) ws.send(JSON.stringify(this.latestFrame));
    }

    removeViewer(ws: Broadcastable): void {
        this.viewers.delete(ws);
    }

    status(): StatusMessage {
        return this.statusMessage();
    }

    setMaxConcurrentMatches(maxConcurrentMatches: number): StatusMessage | null {
        if (!Number.isInteger(maxConcurrentMatches) || maxConcurrentMatches < 1) return null;
        this.options.maxConcurrentMatches = maxConcurrentMatches;
        this.broadcastStatus();
        void this.drainQueue();
        return this.statusMessage();
    }

    async requestStart(request: MatchStartRequest | number = {}): Promise<StartResult> {
        const normalizedRequest = typeof request === "number" ? { count: request } : request;
        const count = normalizedRequest.count ?? 1;
        if (!Number.isInteger(count) || count < 1) {
            return { ok: false, reason: "invalid-count" };
        }

        const duckLevel = normalizedRequest.duckLevel ?? 3;
        const sphinxLevel = normalizedRequest.sphinxLevel ?? 3;
        if (!isIntelligenceLevel(duckLevel) || !isIntelligenceLevel(sphinxLevel)) {
            return { ok: false, reason: "invalid-level" };
        }

        if (this.matchStartQueue.length + count > this.options.maxQueuedMatches) {
            return { ok: false, reason: "capacity-exceeded" };
        }

        if (this.runners.size === 0 && this.matchStartQueue.length === 0)
            this.latestFrame = undefined;
        for (let i = 0; i < count; i++) {
            this.matchStartQueue.push({
                duckLevel,
                sphinxLevel,
                ...(normalizedRequest.seed !== undefined && { seed: normalizedRequest.seed + i }),
                ...(normalizedRequest.matrixRunId && {
                    matrixRunId: normalizedRequest.matrixRunId,
                }),
                ...(normalizedRequest.matrixTrial !== undefined && {
                    matrixTrial: normalizedRequest.matrixTrial + i,
                }),
            });
        }

        this.broadcastStatus();
        void this.drainQueue();
        return { ok: true, accepted: count };
    }

    private async drainQueue(): Promise<void> {
        if (this.isDrainingQueue) return;
        this.isDrainingQueue = true;
        try {
            while (this.matchStartQueue.length > 0 && this.availableRunnerSlots() > 0) {
                const matchConfig = this.matchStartQueue.shift();
                if (!matchConfig) break;
                this.pendingRunnerStarts++;
                void this.startRunner(matchConfig)
                    .catch(error => {
                        console.error("[Server] Failed to start queued runner:", error);
                    })
                    .finally(() => {
                        this.pendingRunnerStarts--;
                        this.broadcastStatus();
                        void this.drainQueue();
                    });
            }
        } finally {
            this.isDrainingQueue = false;
            this.broadcastStatus();
        }
    }

    private async startRunner(config: QueuedMatchConfig): Promise<void> {
        const id = crypto.randomUUID();
        const seed = config.seed ?? this.options.seed;
        const runner = Bun.spawn(
            [
                "bun",
                "run",
                this.options.runnerEntry,
                "--port",
                "0",
                "--host",
                this.options.host,
                "--match-id",
                id,
                "--t-max",
                String(this.options.tMax),
                "--height",
                String(this.options.height),
                "--width",
                String(this.options.width),
                ...(seed === undefined ? [] : ["--seed", String(seed)]),
            ],
            {
                cwd: this.options.workspaceRoot,
                stdin: "ignore",
                stdout: "pipe",
                stderr: "inherit",
            }
        );

        let process: RunnerProcess | undefined;
        try {
            const agentConfig: MatchAgentConfig = {
                duck: { level: config.duckLevel },
                sphinx: { level: config.sphinxLevel },
                ...(seed !== undefined && { seed }),
                ...(config.matrixRunId && { matrixRunId: config.matrixRunId }),
                ...(config.matrixTrial !== undefined && { matrixTrial: config.matrixTrial }),
            };
            process = { id, port: 0, runner, adaptors: [], agentConfig };
            this.runners.set(id, process);

            const readyPromise = new Promise<number>((resolve, reject) => {
                const timeout = setTimeout(
                    () => reject(new Error(`Runner did not become ready.`)),
                    5000
                );
                process!.readyCallback = (port: number) => {
                    clearTimeout(timeout);
                    resolve(port);
                };
                process!.errorCallback = (err: Error) => {
                    clearTimeout(timeout);
                    reject(err);
                };
            });

            void this.readRunnerEvents(process);
            runner.exited.then(code => {
                if (process?.errorCallback) {
                    process.errorCallback(
                        new Error(`Runner exited with code ${code} before becoming ready.`)
                    );
                }
                this.handleRunnerExit(id, code);
            });

            const port = await readyPromise;
            process.port = port;

            process.adaptors.push(
                this.spawnAdaptor("duck", this.options.duckExec, port, config.duckLevel),
                this.spawnAdaptor("sphinx", this.options.sphinxExec, port, config.sphinxLevel)
            );
            this.broadcastStatus();
        } catch (error) {
            if (process) this.stopRunner(id);
            throw error;
        }
    }

    private spawnAdaptor(
        role: "duck" | "sphinx",
        execCommand: string,
        runnerPort: number,
        intelligenceLevel: number
    ): Bun.Subprocess<"ignore", "inherit", "inherit"> {
        const url = `ws://${this.options.host}:${runnerPort}/ws/agent/${role}`;
        return Bun.spawn(
            ["bun", "run", this.options.adaptorEntry, "--url", url, "--exec", execCommand],
            {
                cwd: this.options.workspaceRoot,
                stdin: "ignore",
                stdout: "inherit",
                stderr: "inherit",
                env: {
                    ...Bun.env,
                    AGENT_INTELLIGENCE_LEVEL: String(intelligenceLevel),
                },
            }
        );
    }

    private async readRunnerEvents(process: RunnerProcess): Promise<void> {
        const reader = process.runner.stdout.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() ?? "";
            for (const line of lines) {
                this.handleRunnerLine(process.id, line);
            }
        }
        if (buffer.trim()) this.handleRunnerLine(process.id, buffer);
    }

    private handleRunnerLine(expectedMatchId: string, line: string): void {
        if (!line.trim()) return;
        let event: RunnerEvent;
        try {
            event = JSON.parse(line) as RunnerEvent;
        } catch (error) {
            console.error(`[Server] Ignoring non-JSON runner output: ${line}`, error);
            return;
        }
        if (event.matchId !== expectedMatchId) {
            console.error(`[Server] Ignoring runner event for unexpected match ${event.matchId}.`);
            return;
        }
        if (event.type === "ready") {
            const process = this.runners.get(expectedMatchId);
            if (process?.readyCallback) {
                process.readyCallback(event.port);
                process.readyCallback = undefined;
                process.errorCallback = undefined;
            }
            return;
        }
        if (event.type === "frame") {
            this.latestFrame = event.frame;
            this.broadcast(event.frame);
            return;
        }
        if (event.type === "result") {
            void this.finishMatch(event);
            return;
        }
        if (event.type === "error") {
            console.error(`[Runner ${event.matchId}] ${event.message}`);
        }
        this.broadcastStatus();
    }

    private async finishMatch(match: CompletedMatch): Promise<void> {
        const process = this.runners.get(match.id);
        try {
            const replay = await this.history.save({
                ...match,
                ...(process && { agentConfig: process.agentConfig }),
            });
            console.error(`[History] Saved match ${replay.summary.id}.`);
        } catch (error) {
            console.error("[History] Failed to save match:", error);
        } finally {
            this.stopRunner(match.id);
        }
    }

    private handleRunnerExit(matchId: string, code: number | null): void {
        if (!this.runners.has(matchId)) return;
        console.error(`[Server] Runner ${matchId} exited with code ${code}.`);
        this.stopRunner(matchId);
    }

    private stopRunner(matchId: string): void {
        const process = this.runners.get(matchId);
        if (!process) return;
        this.runners.delete(matchId);
        for (const adaptor of process.adaptors) {
            adaptor.kill();
        }
        process.runner.kill();
        this.broadcastStatus();
        void this.drainQueue();
    }

    private statusMessage(): StatusMessage {
        return {
            type: "status",
            state: this.state(),
            activeMatchCount: this.runners.size,
            startingMatchCount: this.pendingRunnerStarts,
            queuedMatchCount: this.matchStartQueue.length,
            maxConcurrentMatches: this.options.maxConcurrentMatches,
        };
    }

    private state(): ArenaState {
        return this.runners.size === 0 &&
            this.pendingRunnerStarts === 0 &&
            this.matchStartQueue.length === 0
            ? "idle"
            : "running";
    }

    private availableRunnerSlots(): number {
        return this.options.maxConcurrentMatches - this.runners.size - this.pendingRunnerStarts;
    }

    private broadcastStatus(): void {
        this.broadcast(this.statusMessage());
    }

    private broadcast(message: PublicFrame | StatusMessage): void {
        const payload = JSON.stringify(message);
        for (const viewer of this.viewers) viewer.send(payload);
    }
}

function isIntelligenceLevel(value: number): boolean {
    return Number.isInteger(value) && value >= 0 && value <= 3;
}
