import { describe, expect, test } from "bun:test";

import { Mulberry32 } from "@app/shared/random";
import type { Cell } from "@app/shared/types";

import { bfsDistance, createDungeonSetup, createSphinxTerrainMap, generateMap } from "./dungeon";

describe("createSphinxTerrainMap", () => {
    test("preserves terrain while hiding the goal", () => {
        const map: Cell[][] = [
            [1, 1, 1],
            [1, 2, 0],
            [1, 1, 1],
        ];

        expect(createSphinxTerrainMap(map)).toEqual([
            [1, 1, 1],
            [1, 0, 0],
            [1, 1, 1],
        ]);
        expect(map[1]![1]).toBe(2);
    });
});

describe("createDungeonSetup", () => {
    test("places the duck, sphinx, and goal in the same connected component across seeds", () => {
        for (let seed = 0; seed < 20; seed++) {
            const setup = createDungeonSetup(new Mulberry32(seed));
            const positions = [setup.duck, setup.sphinx, setup.goal];

            for (let from = 0; from < positions.length; from++) {
                for (let to = from + 1; to < positions.length; to++) {
                    expect(bfsDistance(setup.map, positions[from]!, positions[to]!)).toBeFinite();
                }
            }
        }
    });
});

describe("generateMap", () => {
    test("encloses the dungeon with walls", () => {
        const map = generateMap(new Mulberry32(2026), 32, 32, 0.5);

        expect(map[0]!.every(cell => cell === 1)).toBe(true);
        expect(map.at(-1)!.every(cell => cell === 1)).toBe(true);
        expect(map.every(row => row[0] === 1 && row.at(-1) === 1)).toBe(true);
    });

    test("combines open rooms with branching corridors", () => {
        const map = generateMap(new Mulberry32(2026), 32, 32, 0.5);

        expect(hasOpenArea(map, 3)).toBe(true);
        expect(countJunctions(map)).toBeGreaterThanOrEqual(8);
    });

    test("keeps wall density balanced across seeds", () => {
        for (let seed = 0; seed < 20; seed++) {
            const map = generateMap(new Mulberry32(seed), 32, 32, 0.5);
            const wallDensity = map.flat().filter(cell => cell === 1).length / (32 * 32);
            expect(wallDensity).toBeGreaterThan(0.3);
            expect(wallDensity).toBeLessThan(0.65);
        }
    });

    test("contains both walls and passages in the interior", () => {
        const map = generateMap(new Mulberry32(2026), 32, 32, 0.5);
        const interior = map.slice(1, -1).flatMap(row => row.slice(1, -1));

        expect(interior).toContain(0);
        expect(interior).toContain(1);
    });

    test("limits the size of connected interior walls", () => {
        const maxWallComponentSize = 8;

        for (let seed = 0; seed < 20; seed++) {
            const map = generateMap(new Mulberry32(seed), 32, 32, 0.5, maxWallComponentSize);
            expect(findLargestInteriorWallComponent(map)).toBeLessThanOrEqual(maxWallComponentSize);
        }
    });

    test("treats diagonally touching interior walls as connected", () => {
        const map = generateMap(new Mulberry32(0), 5, 5, 1, 1);

        expect(findLargestInteriorWallComponent(map)).toBe(1);
    });

    test("is reproducible for the same seed", () => {
        expect(generateMap(new Mulberry32(42), 32, 32, 0.5)).toEqual(
            generateMap(new Mulberry32(42), 32, 32, 0.5)
        );
    });
});

function collectOpenCells(map: Cell[][]): [number, number][] {
    return map.flatMap((row, y) =>
        row.flatMap((cell, x): [number, number][] => (cell === 0 ? [[x, y]] : []))
    );
}

function hasOpenArea(map: Cell[][], size: number): boolean {
    for (let y = 0; y <= map.length - size; y++) {
        for (let x = 0; x <= (map[y]?.length ?? 0) - size; x++) {
            const areaIsOpen = map
                .slice(y, y + size)
                .every(row => row.slice(x, x + size).every(cell => cell === 0));
            if (areaIsOpen) return true;
        }
    }
    return false;
}

function countJunctions(map: Cell[][]): number {
    return collectOpenCells(map).filter(([x, y]) => {
        const neighbors = [map[y - 1]?.[x], map[y + 1]?.[x], map[y]?.[x - 1], map[y]?.[x + 1]];
        return neighbors.filter(cell => cell === 0).length >= 3;
    }).length;
}

function findLargestInteriorWallComponent(map: Cell[][]): number {
    const visited = new Set<string>();
    let largest = 0;

    for (let y = 1; y < map.length - 1; y++) {
        for (let x = 1; x < (map[y]?.length ?? 0) - 1; x++) {
            if (map[y]![x] !== 1 || visited.has(`${x},${y}`)) continue;

            const queue: [number, number][] = [[x, y]];
            visited.add(`${x},${y}`);
            for (let head = 0; head < queue.length; head++) {
                const [currentX, currentY] = queue[head]!;
                for (const [dx, dy] of [
                    [-1, -1],
                    [0, -1],
                    [1, -1],
                    [1, 0],
                    [1, 1],
                    [0, 1],
                    [-1, 1],
                    [-1, 0],
                ] as const) {
                    const nextX = currentX + dx;
                    const nextY = currentY + dy;
                    const key = `${nextX},${nextY}`;
                    if (
                        nextX <= 0 ||
                        nextY <= 0 ||
                        nextY >= map.length - 1 ||
                        nextX >= (map[nextY]?.length ?? 0) - 1 ||
                        map[nextY]![nextX] !== 1 ||
                        visited.has(key)
                    ) {
                        continue;
                    }
                    visited.add(key);
                    queue.push([nextX, nextY]);
                }
            }
            largest = Math.max(largest, queue.length);
        }
    }

    return largest;
}
