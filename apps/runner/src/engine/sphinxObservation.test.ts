import { describe, expect, test } from "bun:test";

import { duckPositionObservationStdDev } from "./sphinxObservation";

describe("duckPositionObservationStdDev", () => {
    test("is more precise nearby and increases with path distance", () => {
        expect(duckPositionObservationStdDev(0)).toBe(0.5);
        expect(duckPositionObservationStdDev(10)).toBe(1.5);
        expect(duckPositionObservationStdDev(15)).toBe(2);
        expect(duckPositionObservationStdDev(20)).toBe(2.5);
    });

    test("caps the noise for distant positions", () => {
        expect(duckPositionObservationStdDev(100)).toBe(3);
    });

    test("rejects invalid distances", () => {
        expect(() => duckPositionObservationStdDev(Number.POSITIVE_INFINITY)).toThrow();
        expect(() => duckPositionObservationStdDev(-1)).toThrow();
    });
});
