import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import type { WSEvents } from "hono/ws";

import type {
    AgentConnection,
    ArenaState,
    EpisodeResult,
    PublicFrame,
    Role,
} from "@app/shared/types";

import { AgentSession } from "./agentSession";
import { GameLoop, type GameLoopOptions } from "./gameLoop";

interface RunnerAppOptions {
    matchId: string;
    game: Partial<GameLoopOptions>;
    emit: (event: RunnerEvent) => void;
    exit: (code: number) => void;
}

type RunnerEvent =
    | { type: "status"; matchId: string; state: ArenaState }
    | { type: "frame"; matchId: string; frame: PublicFrame }
    | {
          type: "result";
          matchId: string;
          id: string;
          startedAt: string;
          finishedAt: string;
          result: EpisodeResult;
          frames: PublicFrame[];
      }
    | { type: "error"; matchId: string; message: string };

export function createRunnerApp(options: RunnerAppOptions) {
    const sessions = new Map<Role, AgentSession>();
    const frames: PublicFrame[] = [];
    const startedAt = new Date().toISOString();
    let state: ArenaState = "waiting-for-agents";
    let finished = false;

    const emitStatus = () => options.emit({ type: "status", matchId: options.matchId, state });

    function agentSocketEvents(role: Role): WSEvents {
        return {
            onOpen(_evt, ws) {
                if (state !== "waiting-for-agents" || sessions.has(role)) {
                    ws.close(4400, `${role} cannot connect right now`);
                    return;
                }
                const connection: AgentConnection = {
                    role,
                    send: message => ws.send(message),
                    close: (code, reason) => ws.close(code, reason),
                };
                sessions.set(role, new AgentSession(connection));
                maybeStartGame();
            },
            onMessage(evt, ws) {
                try {
                    sessions
                        .get(role)
                        ?.receive(
                            typeof evt.data === "string"
                                ? evt.data
                                : new TextDecoder().decode(evt.data as ArrayBuffer)
                        );
                } catch (error) {
                    options.emit({
                        type: "error",
                        matchId: options.matchId,
                        message: `Protocol error from ${role}: ${String(error)}`,
                    });
                    ws.close(4400, "Unexpected or invalid action");
                    finishProcess(1);
                }
            },
            onClose() {
                if (!finished) {
                    options.emit({
                        type: "error",
                        matchId: options.matchId,
                        message: `${role} disconnected before the match completed.`,
                    });
                    finishProcess(1);
                }
            },
        };
    }

    function maybeStartGame(): void {
        const duck = sessions.get("DUCK");
        const sphinx = sessions.get("SPHINX");
        if (!duck || !sphinx || state === "running") return;

        state = "running";
        emitStatus();
        const loop = new GameLoop(
            {
                duck,
                sphinx,
                broadcast: frame => {
                    const matchFrame = { ...frame, matchId: options.matchId };
                    frames.push(matchFrame);
                    options.emit({ type: "frame", matchId: options.matchId, frame: matchFrame });
                },
                end: result => finishMatch(result),
            },
            options.game
        );
        loop.start().catch((error: unknown) => {
            options.emit({
                type: "error",
                matchId: options.matchId,
                message: `Game aborted: ${String(error)}`,
            });
            finishProcess(1);
        });
    }

    function finishMatch(result: EpisodeResult): void {
        finished = true;
        options.emit({
            type: "result",
            matchId: options.matchId,
            id: options.matchId,
            startedAt,
            finishedAt: new Date().toISOString(),
            result,
            frames,
        });
        finishProcess(0);
    }

    function finishProcess(code: number): void {
        if (finished && code !== 0) return;
        finished = true;
        for (const session of sessions.values()) {
            session.close(code === 0 ? 1000 : 1011, code === 0 ? "Game finished" : "Game aborted");
        }
        setTimeout(() => options.exit(code), 0);
    }

    const app = new Hono()
        .get("/health", c => c.json({ ok: true, matchId: options.matchId, state }))
        .get(
            "/ws/agent/duck",
            upgradeWebSocket(() => agentSocketEvents("DUCK"))
        )
        .get(
            "/ws/agent/sphinx",
            upgradeWebSocket(() => agentSocketEvents("SPHINX"))
        )
        .all("*", c => c.text("Wheelduck 2 vs Sphinx runner", 200));

    emitStatus();
    return app;
}

export type RunnerAppType = ReturnType<typeof createRunnerApp>;
