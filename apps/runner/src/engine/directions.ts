import type { Direction, Vec2 } from "@app/shared/types";

export const directions: Direction[] = ["UP", "DOWN", "LEFT", "RIGHT", "STAY", "OBSERVE"];
export const movingDirections: Direction[] = ["UP", "DOWN", "LEFT", "RIGHT"];

export const directionDelta: Record<Direction, Vec2> = {
    UP: [0, -1],
    DOWN: [0, 1],
    LEFT: [-1, 0],
    RIGHT: [1, 0],
    STAY: [0, 0],
    OBSERVE: [0, 0],
};

export const perpendicularDirections: Record<Direction, [Direction, Direction]> = {
    UP: ["LEFT", "RIGHT"],
    DOWN: ["RIGHT", "LEFT"],
    LEFT: ["DOWN", "UP"],
    RIGHT: ["UP", "DOWN"],
    STAY: ["STAY", "STAY"],
    OBSERVE: ["OBSERVE", "OBSERVE"],
};

export function addVec([x, y]: Vec2, [dx, dy]: Vec2): Vec2 {
    return [x + dx, y + dy];
}

export function samePos(a: Vec2, b: Vec2): boolean {
    return a[0] === b[0] && a[1] === b[1];
}
