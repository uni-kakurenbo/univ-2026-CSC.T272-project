import type { RandomSource } from "@app/shared/random";
import type { Cell, TerrainCell, Vec2 } from "@app/shared/types";

import { addVec, directionDelta, movingDirections } from "./directions";

export interface DungeonConfig {
    height: number;
    width: number;
    wallProbability: number;
    maxInteriorWallComponentSize: number;
    minDuckSphinxDistance: number;
    minGoalDistance: number;
}

export interface DungeonSetup {
    map: Cell[][];
    duck: Vec2;
    sphinx: Vec2;
    goal: Vec2;
}

const defaultConfig: DungeonConfig = {
    height: 32,
    width: 32,
    wallProbability: 0.24,
    maxInteriorWallComponentSize: 8,
    minDuckSphinxDistance: 12,
    minGoalDistance: 16,
};

export function createDungeonSetup(
    rng: RandomSource,
    partial: Partial<DungeonConfig> = {}
): DungeonSetup {
    const config = { ...defaultConfig, ...partial };

    for (let mapAttempt = 0; mapAttempt < 400; mapAttempt++) {
        const map = generateMap(
            rng,
            config.height,
            config.width,
            config.wallProbability,
            config.maxInteriorWallComponentSize
        );
        const openCells = collectOpenCells(map);
        if (openCells.length < 3) continue;

        for (let spawnAttempt = 0; spawnAttempt < 250; spawnAttempt++) {
            const duck = rng.choice(openCells);
            const sphinx = rng.choice(openCells);
            if (same(duck, sphinx)) continue;

            const fromDuck = bfsDistances(map, duck);
            const duckSphinxDistance = getDistance(fromDuck, sphinx);
            if (!meetsMinimumDistance(duckSphinxDistance, config.minDuckSphinxDistance)) continue;

            const fromSphinx = bfsDistances(map, sphinx);
            const candidates = openCells.filter(cell => {
                if (same(cell, duck) || same(cell, sphinx)) return false;
                const duckGoalDistance = getDistance(fromDuck, cell);
                const sphinxGoalDistance = getDistance(fromSphinx, cell);
                return (
                    meetsMinimumDistance(duckGoalDistance, config.minGoalDistance) &&
                    meetsMinimumDistance(sphinxGoalDistance, config.minGoalDistance)
                );
            });
            if (candidates.length === 0) continue;

            const goal = rng.choice(candidates);
            const finalMap = map.map(row => [...row]);
            finalMap[goal[1]]![goal[0]] = 2;
            return { map: finalMap, duck, sphinx, goal };
        }
    }

    return createFallbackDungeon(config.height, config.width);
}

export function generateMap(
    rng: RandomSource,
    height: number,
    width: number,
    wallProbability: number,
    maxInteriorWallComponentSize = defaultConfig.maxInteriorWallComponentSize
): Cell[][] {
    const map: Cell[][] = Array.from({ length: height }, (_, y) =>
        Array.from({ length: width }, (_, x): Cell => (isBorder(x, y, width, height) ? 1 : 0))
    );
    const wallComponents = new WallComponents(width, height);

    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            if (!rng.chance(wallProbability)) continue;
            if (!wallComponents.tryAdd(x, y, maxInteriorWallComponentSize)) continue;
            map[y]![x] = 1;
        }
    }

    return map;
}

export function createFallbackDungeon(height: number, width: number): DungeonSetup {
    const map: Cell[][] = Array.from({ length: height }, (_, y) =>
        Array.from({ length: width }, (_, x): Cell =>
            x === 0 || y === 0 || x === width - 1 || y === height - 1 ? 1 : 0
        )
    );
    const duck: Vec2 = [1, 1];
    const sphinx: Vec2 = [Math.max(1, width - 2), Math.max(1, height - 2)];
    const goal: Vec2 = [Math.max(1, width - 2), 1];
    map[goal[1]]![goal[0]] = 2;
    return { map, duck, sphinx, goal };
}

export function inBounds(map: Cell[][], [x, y]: Vec2): boolean {
    return y >= 0 && y < map.length && x >= 0 && x < (map[0]?.length ?? 0);
}

export function isPassable(map: Cell[][], pos: Vec2): boolean {
    if (!inBounds(map, pos)) return false;
    return map[pos[1]]![pos[0]] !== 1;
}

export function applyDeterministicMove(
    map: Cell[][],
    pos: Vec2,
    direction: keyof typeof directionDelta
): Vec2 {
    const next = addVec(pos, directionDelta[direction]);
    return isPassable(map, next) ? next : pos;
}

export function bfsDistance(map: Cell[][], from: Vec2, to: Vec2): number {
    return getDistance(bfsDistances(map, from), to);
}

export function bfsDistances(map: Cell[][], start: Vec2): number[][] {
    const height = map.length;
    const width = map[0]?.length ?? 0;
    const distance = Array.from({ length: height }, () =>
        Array.from({ length: width }, () => Number.POSITIVE_INFINITY)
    );
    if (!isPassable(map, start)) return distance;

    const queue: Vec2[] = [start];
    distance[start[1]]![start[0]] = 0;
    for (let head = 0; head < queue.length; head++) {
        const current = queue[head]!;
        const nextDistance = distance[current[1]]![current[0]] + 1;
        for (const direction of movingDirections) {
            const next = addVec(current, directionDelta[direction]);
            if (!isPassable(map, next)) continue;
            if (distance[next[1]]![next[0]] <= nextDistance) continue;
            distance[next[1]]![next[0]] = nextDistance;
            queue.push(next);
        }
    }
    return distance;
}

export function getDistance(distances: number[][], [x, y]: Vec2): number {
    return distances[y]?.[x] ?? Number.POSITIVE_INFINITY;
}

export function computeFov(map: Cell[][], center: Vec2, radius: number): Cell[][] {
    const size = radius * 2 + 1;
    return Array.from({ length: size }, (_, row) =>
        Array.from({ length: size }, (_, col): Cell => {
            const dx = col - radius;
            const dy = row - radius;
            if (Math.abs(dx) + Math.abs(dy) > radius) return -1;
            const pos: Vec2 = [center[0] + dx, center[1] + dy];
            return inBounds(map, pos) ? map[pos[1]]![pos[0]] : -1;
        })
    );
}

export function createUnknownMap(height: number, width: number, goal: Vec2): Cell[][] {
    const memory = Array.from({ length: height }, () =>
        Array.from({ length: width }, (): Cell => -1)
    );
    memory[goal[1]]![goal[0]] = 2;
    return memory;
}

export function createSphinxTerrainMap(map: Cell[][]): TerrainCell[][] {
    return map.map(row => row.map(cell => (cell === 1 ? 1 : 0)));
}

export function mergeFovIntoMemory(
    memory: Cell[][],
    center: Vec2,
    radius: number,
    fov: Cell[][]
): Cell[][] {
    const next = memory.map(row => [...row]);
    for (let row = 0; row < fov.length; row++) {
        for (let col = 0; col < (fov[row]?.length ?? 0); col++) {
            const value = fov[row]![col]!;
            if (value === -1) continue;
            const x = center[0] + col - radius;
            const y = center[1] + row - radius;
            if (y >= 0 && y < next.length && x >= 0 && x < (next[0]?.length ?? 0)) {
                next[y]![x] = value;
            }
        }
    }
    return next;
}

function collectOpenCells(map: Cell[][]): Vec2[] {
    const cells: Vec2[] = [];
    for (let y = 0; y < map.length; y++) {
        for (let x = 0; x < (map[y]?.length ?? 0); x++) {
            if (map[y]![x] === 0) cells.push([x, y]);
        }
    }
    return cells;
}

function same(a: Vec2, b: Vec2): boolean {
    return a[0] === b[0] && a[1] === b[1];
}

function meetsMinimumDistance(distance: number, minimum: number): boolean {
    return Number.isFinite(distance) && distance >= minimum;
}

function isBorder(x: number, y: number, width: number, height: number): boolean {
    return x === 0 || y === 0 || x === width - 1 || y === height - 1;
}

class WallComponents {
    private readonly parents: number[];
    private readonly sizes: number[];

    constructor(
        private readonly width: number,
        height: number
    ) {
        const cellCount = width * height;
        this.parents = Array.from({ length: cellCount }, () => -1);
        this.sizes = Array.from({ length: cellCount }, () => 0);
    }

    tryAdd(x: number, y: number, maxSize: number): boolean {
        const index = this.index(x, y);
        const neighborRoots = new Set<number>();

        for (const neighbor of [
            this.index(x - 1, y),
            this.index(x - 1, y - 1),
            this.index(x, y - 1),
            this.index(x + 1, y - 1),
        ]) {
            if (this.parents[neighbor] !== -1) neighborRoots.add(this.find(neighbor));
        }

        const mergedSize =
            1 + [...neighborRoots].reduce((size, root) => size + this.sizes[root]!, 0);
        if (mergedSize > maxSize) return false;

        this.parents[index] = index;
        this.sizes[index] = 1;
        for (const root of neighborRoots) this.union(index, root);
        return true;
    }

    private find(index: number): number {
        const parent = this.parents[index]!;
        if (parent === index) return index;
        return (this.parents[index] = this.find(parent));
    }

    private union(a: number, b: number): void {
        const rootA = this.find(a);
        const rootB = this.find(b);
        if (rootA === rootB) return;

        this.parents[rootB] = rootA;
        this.sizes[rootA] = this.sizes[rootA]! + this.sizes[rootB]!;
    }

    private index(x: number, y: number): number {
        return y * this.width + x;
    }
}
