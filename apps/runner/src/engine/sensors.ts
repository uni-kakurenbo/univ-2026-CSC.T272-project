import type { RandomSource } from "@app/shared/random";
import type { Direction, SensorReading, Vec2 } from "@app/shared/types";

export function sampleDuckSensors(
    distance: number,
    rng: RandomSource,
    duckPos: Vec2,
    sphinxPos: Vec2
): SensorReading {
    let compass: Direction | "UNKNOWN" = "UNKNOWN";
    if (distance > 0 && distance < 1000000) {
        const dx = sphinxPos[0] - duckPos[0];
        const dy = sphinxPos[1] - duckPos[1];

        const dist = Math.hypot(dx, dy);
        const nx = dx / dist;
        const ny = dy / dist;

        const k = 2.0;
        const baseline = 0.5;
        const wRight = Math.exp(k * nx) + baseline;
        const wLeft = Math.exp(k * -nx) + baseline;
        const wDown = Math.exp(k * ny) + baseline;
        const wUp = Math.exp(k * -ny) + baseline;

        const totalWeight = wRight + wLeft + wDown + wUp;
        const roll = rng.next() * totalWeight;

        if (roll < wRight) {
            compass = "RIGHT";
        } else if (roll < wRight + wLeft) {
            compass = "LEFT";
        } else if (roll < wRight + wLeft + wDown) {
            compass = "DOWN";
        } else {
            compass = "UP";
        }
    }

    let radio = -1;
    if (distance >= 0 && distance < 1000000) {
        radio = Math.max(0, distance + rng.normal(0, 2.0 + distance * 0.1));
    }

    return {
        sound: bit(rng, duckSound(distance)),
        heat: bit(rng, Math.max(0, 1.0 - 0.35 * distance)),
        radio,
        compass,
    };
}

function duckSound(distance: number): number {
    if (distance === 1) return 0.95;
    if (distance === 2) return 0.7;
    if (distance === 3) return 0.2;
    return 0;
}

function bit(rng: RandomSource, probability: number): 0 | 1 {
    return rng.chance(clamp(probability)) ? 1 : 0;
}

function clamp(value: number): number {
    return Math.max(0, Math.min(1, value));
}
