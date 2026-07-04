import { Mulberry32, type RandomSource } from "@app/shared/random";
import type {
    AgentAction,
    AgentTelemetry,
    AgentTurnTrace,
    Cell,
    Direction,
    DuckObservation,
    EpisodeResult,
    GameStatus,
    MovementTrace,
    PublicFrame,
    Role,
    SensorReading,
    SphinxObservation,
    TargetEstimate,
    Vec2,
} from "@app/shared/types";

import { AgentSession } from "./agentSession";
import { addVec, directionDelta, perpendicularDirections, samePos } from "./engine/directions";
import {
    applyDeterministicMove,
    bfsDistance,
    computeFov,
    createDungeonSetup,
    createSphinxTerrainMap,
    createUnknownMap,
    isPassable,
    mergeFovIntoMemory,
} from "./engine/dungeon";
import { sampleDuckSensors } from "./engine/sensors";
import { duckPositionObservationStdDev } from "./engine/sphinxObservation";
import { parseDuckResponse, parseSphinxResponse } from "./protocol";

export interface GameLoopOptions {
    tMax: number;
    seed?: number;
    height: number;
    width: number;
    fovRadius: number;
}

export interface GameLoopDeps {
    duck: AgentSession;
    sphinx: AgentSession;
    broadcast: (frame: PublicFrame) => void;
    end: (result: EpisodeResult) => void | Promise<void>;
    rng?: RandomSource;
}

const defaultOptions: GameLoopOptions = {
    tMax: 100,
    height: 32,
    width: 32,
    fovRadius: 2,
};

export class GameLoop {
    private readonly options: GameLoopOptions;
    private readonly rng: RandomSource;
    private readonly map: Cell[][];
    private duckPos: Vec2;
    private sphinxPos: Vec2;
    private readonly goal: Vec2;
    private turn = 0;
    private status: GameStatus = "ACTIVE";
    private winner: Role | "DRAW" | null = null;
    private duckMemory: Cell[][];
    private duckSensors: SensorReading = { sound: 0, heat: 0, radio: -1, compass: "UNKNOWN" };
    private agentTurns: PublicFrame["agentTurns"] = { duck: null, sphinx: null };
    private sphinxObservedGoalDistance: number | null = null;

    constructor(
        private readonly deps: GameLoopDeps,
        options: Partial<GameLoopOptions> = {}
    ) {
        this.options = { ...defaultOptions, ...options };
        this.rng = deps.rng ?? new Mulberry32(this.options.seed);
        const setup = createDungeonSetup(this.rng, {
            height: this.options.height,
            width: this.options.width,
        });
        this.map = setup.map;
        this.duckPos = setup.duck;
        this.sphinxPos = setup.sphinx;
        this.goal = setup.goal;
        this.duckMemory = createUnknownMap(this.options.height, this.options.width, this.goal);
    }

    async start(): Promise<void> {
        this.deps.duck.sendInit({
            role: "DUCK",
            t_max: this.options.tMax,
            map_size: [this.options.height, this.options.width],
            goal: this.goal,
        });
        this.deps.sphinx.sendInit({
            role: "SPHINX",
            t_max: this.options.tMax,
            map_size: [this.options.height, this.options.width],
            full_map: createSphinxTerrainMap(this.map),
        });
        this.broadcast();

        while (this.status === "ACTIVE" && this.turn < this.options.tMax) {
            await this.runTurn();
        }

        if (this.status === "ACTIVE") {
            this.finish("DRAW", "DRAW");
            this.broadcast();
        }

        await this.deps.end(this.result());
    }

    private async runTurn(): Promise<void> {
        this.agentTurns = { duck: null, sphinx: null };
        const distance = bfsDistance(this.map, this.duckPos, this.sphinxPos);
        this.duckSensors = sampleDuckSensors(distance, this.rng, this.duckPos, this.sphinxPos);

        const duckObservation = this.createDuckObservation("ACTIVE");
        const duckRawAction = await this.deps.duck.requestAction(duckObservation);
        const duckResponse = parseDuckResponse(duckRawAction);
        this.validateTelemetry(duckResponse.telemetry);
        this.agentTurns.duck = {
            turn: this.turn,
            movements: [this.applyDuckAction(duckResponse.action.actions[0]!)],
            ...(duckResponse.telemetry && { telemetry: duckResponse.telemetry }),
        };
        this.updateDuckMemory();
        if (samePos(this.duckPos, this.goal)) {
            this.finish("WIN", "DUCK");
            this.broadcast();
            return;
        }
        if (samePos(this.duckPos, this.sphinxPos)) {
            this.finish("LOSE", "SPHINX");
            this.broadcast();
            return;
        }

        const sphinxObservation = this.createSphinxObservation("ACTIVE");
        const sphinxRawAction = await this.deps.sphinx.requestAction(sphinxObservation);
        const sphinxResponse = parseSphinxResponse(sphinxRawAction);
        this.validateTelemetry(sphinxResponse.telemetry);
        this.agentTurns.sphinx = this.applySphinxAction(
            sphinxResponse.action,
            sphinxResponse.telemetry
        );
        if (this.status === "ACTIVE" && samePos(this.duckPos, this.sphinxPos)) {
            this.finish("LOSE", "SPHINX");
        }

        this.turn += 1;
        this.broadcast();
    }

    private applyDuckAction(direction: Direction): MovementTrace {
        const from = this.duckPos;
        const actual = this.sampleSlip(direction);
        this.duckPos = applyDeterministicMove(this.map, this.duckPos, actual);
        return this.createMovementTrace(direction, actual, from, this.duckPos);
    }

    private sampleSlip(direction: Direction): Direction {
        if (direction === "STAY") return "STAY";
        const roll = this.rng.next();
        if (roll < 0.8) return direction;
        if (roll < 0.85) return perpendicularDirections[direction][0];
        if (roll < 0.9) return perpendicularDirections[direction][1];
        return "STAY";
    }

    private applySphinxAction(
        action: AgentAction,
        telemetry: AgentTelemetry | undefined
    ): AgentTurnTrace {
        const trace: AgentTurnTrace = {
            turn: this.turn,
            movements: [],
            ...(telemetry && { telemetry }),
        };
        trace.movements.push(this.moveSphinx(action.actions[0]!));
        return trace;
    }

    private moveSphinx(direction: Direction): MovementTrace {
        const from = this.sphinxPos;
        if (direction === "OBSERVE") {
            const trueDistance =
                Math.abs(this.sphinxPos[0] - this.goal[0]) +
                Math.abs(this.sphinxPos[1] - this.goal[1]);
            const stdDev = duckPositionObservationStdDev(trueDistance);
            this.sphinxObservedGoalDistance = Math.max(
                0,
                Math.round(this.rng.normal(trueDistance, stdDev))
            );
            return this.createMovementTrace(direction, "STAY", from, this.sphinxPos);
        } else {
            this.sphinxObservedGoalDistance = null;
        }

        this.sphinxPos = applyDeterministicMove(this.map, this.sphinxPos, direction);
        if (samePos(this.duckPos, this.sphinxPos)) {
            this.finish("LOSE", "SPHINX");
        }
        return this.createMovementTrace(direction, direction, from, this.sphinxPos);
    }

    private createDuckObservation(status: GameStatus): DuckObservation {
        const fov = computeFov(this.map, this.duckPos, this.options.fovRadius);

        const observation: DuckObservation = {
            turn: this.turn,
            role: "DUCK",
            status,
            pos: this.duckPos,
            fov: {
                radius: this.options.fovRadius,
                grid: fov,
            },
            sensors: this.duckSensors,
        };

        const dx = this.sphinxPos[0] - this.duckPos[0];
        const dy = this.sphinxPos[1] - this.duckPos[1];
        if (Math.abs(dx) + Math.abs(dy) <= this.options.fovRadius) {
            observation.sphinx_pos = this.sphinxPos;
        }

        return observation;
    }

    private createSphinxObservation(status: GameStatus): SphinxObservation {
        const distance = bfsDistance(this.map, this.sphinxPos, this.duckPos);
        const stdDev = duckPositionObservationStdDev(distance);
        let noisyX = Math.round(this.rng.normal(this.duckPos[0], stdDev));
        let noisyY = Math.round(this.rng.normal(this.duckPos[1], stdDev));

        noisyX = Math.max(0, Math.min(this.options.width - 1, noisyX));
        noisyY = Math.max(0, Math.min(this.options.height - 1, noisyY));

        const obs: SphinxObservation = {
            turn: this.turn,
            role: "SPHINX",
            status,
            pos: this.sphinxPos,
            duck_pos: [noisyX, noisyY],
        };

        if (this.sphinxObservedGoalDistance !== null) {
            obs.goal_distance = this.sphinxObservedGoalDistance;
            this.sphinxObservedGoalDistance = null;
        }

        return obs;
    }

    private updateDuckMemory(): void {
        const fov = computeFov(this.map, this.duckPos, this.options.fovRadius);
        this.duckMemory = mergeFovIntoMemory(
            this.duckMemory,
            this.duckPos,
            this.options.fovRadius,
            fov
        );
    }

    private finish(duckStatus: Exclude<GameStatus, "ACTIVE">, winner: Role | "DRAW"): void {
        this.status = duckStatus;
        this.winner = winner;
    }

    private validateTelemetry(telemetry: AgentTelemetry | undefined): void {
        if (!telemetry) return;

        const checkTarget = (target?: TargetEstimate) => {
            if (!target) return;
            const distribution = target.positionDistribution;
            if (
                distribution.length !== this.options.height ||
                distribution.some(row => row.length !== this.options.width)
            ) {
                throw new Error("Agent telemetry distribution dimensions do not match the map.");
            }
            const [x, y] = target.predictedPosition;
            if (x < 0 || x >= this.options.width || y < 0 || y >= this.options.height) {
                throw new Error("Agent telemetry predicted position is outside the map.");
            }
        };

        checkTarget(telemetry.opponent);
        checkTarget(telemetry.goal);
    }

    private createMovementTrace(
        requestedDirection: Direction,
        resolvedDirection: Direction,
        from: Vec2,
        to: Vec2
    ): MovementTrace {
        const moved = !samePos(from, to);
        const outcome =
            resolvedDirection === "STAY"
                ? "STAY"
                : !moved
                  ? "BLOCKED"
                  : requestedDirection === resolvedDirection
                    ? "MOVED"
                    : "SLIPPED";
        return {
            requestedDirection,
            resolvedDirection,
            actualDirection: moved ? resolvedDirection : "STAY",
            from,
            to,
            outcome,
        };
    }

    private createNotExecutedTrace(requestedDirection: Direction, position: Vec2): MovementTrace {
        return {
            requestedDirection,
            resolvedDirection: "STAY",
            actualDirection: "STAY",
            from: position,
            to: position,
            outcome: "NOT_EXECUTED",
        };
    }

    private broadcast(): void {
        this.updateDuckMemory();
        this.deps.broadcast({
            type: "frame",
            turn: this.turn,
            status: this.status,
            winner: this.winner,
            map: this.map,
            duck: this.duckPos,
            sphinx: this.sphinxPos,
            goal: this.goal,
            sensors: this.duckSensors,
            duckMemory: this.duckMemory,
            agentTurns: this.agentTurns,
        });
    }

    private result(): EpisodeResult {
        const finalStatus = this.status === "ACTIVE" ? "DRAW" : this.status;
        const winner = this.winner ?? "DRAW";
        const duckWin = winner === "DUCK";
        const sphinxWin = winner === "SPHINX";
        return {
            status: finalStatus,
            winner,
            turn: this.turn,
            duckScore: duckWin ? 1000 - 2 * this.turn : sphinxWin ? -1000 + 2 * this.turn : -300,
            sphinxScore: sphinxWin ? 1000 - 2 * this.turn : duckWin ? -1000 + 2 * this.turn : -300,
        };
    }
}

export function bestDirectionToward(map: Cell[][], from: Vec2, to: Vec2): Direction {
    const candidates: Direction[] = ["UP", "DOWN", "LEFT", "RIGHT", "STAY"];
    let best: Direction = "STAY";
    let bestScore = Number.POSITIVE_INFINITY;
    for (const direction of candidates) {
        const next = addVec(from, directionDelta[direction]);
        if (!isPassable(map, next)) continue;
        const score = Math.abs(next[0] - to[0]) + Math.abs(next[1] - to[1]);
        if (score < bestScore) {
            best = direction;
            bestScore = score;
        }
    }
    return best;
}
