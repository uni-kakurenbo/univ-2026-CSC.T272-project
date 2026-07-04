const MIN_DUCK_POSITION_STD_DEV = 0.5;
const MAX_DUCK_POSITION_STD_DEV = 3;
const DUCK_POSITION_STD_DEV_PER_CELL = 0.1;

export function duckPositionObservationStdDev(distance: number): number {
    if (!Number.isFinite(distance) || distance < 0) {
        throw new RangeError(`Distance must be a finite non-negative number: ${distance}`);
    }

    return Math.min(
        MAX_DUCK_POSITION_STD_DEV,
        MIN_DUCK_POSITION_STD_DEV + DUCK_POSITION_STD_DEV_PER_CELL * distance
    );
}
