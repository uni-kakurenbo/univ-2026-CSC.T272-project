import { describe, expect, test } from "bun:test";

import type {
    AgentObservation,
    Direction,
    InitPacket,
    PublicFrame,
    SphinxInitPacket,
    SphinxObservation,
} from "@app/shared/types";

import type { AgentSession } from "./agentSession";
import { GameLoop } from "./gameLoop";

const directionDeltas: Record<Exclude<Direction, "STAY" | "OBSERVE">, [number, number]> = {
    UP: [0, -1],
    DOWN: [0, 1],
    LEFT: [-1, 0],
    RIGHT: [1, 0],
};

class StubAgentSession {
    private initPacket?: InitPacket;

    constructor(
        private readonly selectAction: (
            observation: AgentObservation,
            initPacket: InitPacket
        ) => Direction
    ) {}

    sendInit(packet: InitPacket): void {
        this.initPacket = packet;
    }

    requestAction(observation: AgentObservation): Promise<string> {
        if (!this.initPacket) throw new Error("Agent was not initialized.");
        return Promise.resolve(`ACTION: ${this.selectAction(observation, this.initPacket)}`);
    }
}

describe("GameLoop", () => {
    test("moves the sphinx in its requested direction without slipping", async () => {
        const frames: PublicFrame[] = [];
        const duck = new StubAgentSession(() => "STAY");
        const sphinx = new StubAgentSession((observation, initPacket) =>
            selectPassableSphinxDirection(
                observation as SphinxObservation,
                initPacket as SphinxInitPacket
            )
        );
        const loop = new GameLoop(
            {
                duck: duck as unknown as AgentSession,
                sphinx: sphinx as unknown as AgentSession,
                broadcast: frame => frames.push(frame),
                end: () => {},
            },
            { seed: 2026, tMax: 1 }
        );

        await loop.start();

        const movement = frames.find(frame => frame.agentTurns.sphinx)?.agentTurns.sphinx
            ?.movements[0];
        expect(movement).toBeDefined();
        expect(movement?.resolvedDirection).toBe(movement?.requestedDirection);
        expect(movement?.actualDirection).toBe(movement?.requestedDirection);
        expect(movement?.outcome).toBe("MOVED");
    });
});

function selectPassableSphinxDirection(
    observation: SphinxObservation,
    initPacket: SphinxInitPacket
): Direction {
    for (const [direction, [dx, dy]] of Object.entries(directionDeltas) as [
        Exclude<Direction, "STAY" | "OBSERVE">,
        [number, number],
    ][]) {
        const x = observation.pos[0] + dx;
        const y = observation.pos[1] + dy;
        if (initPacket.full_map[y]?.[x] === 0) return direction;
    }
    throw new Error("Generated sphinx position has no passable neighboring cell.");
}
