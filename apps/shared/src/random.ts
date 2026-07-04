export interface RandomSource {
    next(): number;
    int(maxExclusive: number): number;
    choice<T>(items: readonly T[]): T;
    chance(probability: number): boolean;
    normal(mean?: number, stdDev?: number): number;
}

export class Mulberry32 implements RandomSource {
    private state: number;

    constructor(seed = Date.now()) {
        this.state = seed >>> 0;
    }

    next(): number {
        let t = (this.state += 0x6d2b79f5);
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    int(maxExclusive: number): number {
        return Math.floor(this.next() * maxExclusive);
    }

    choice<T>(items: readonly T[]): T {
        if (items.length === 0) {
            throw new Error("Cannot choose from an empty array.");
        }
        return items[this.int(items.length)]!;
    }

    chance(probability: number): boolean {
        return this.next() < probability;
    }

    normal(mean: number = 0, stdDev: number = 1): number {
        const u1 = 1.0 - this.next(); // (0, 1]
        const u2 = 1.0 - this.next(); // (0, 1]
        const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
        return z0 * stdDev + mean;
    }
}
