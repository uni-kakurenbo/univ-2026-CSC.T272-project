import type { AgentTurnTrace, Cell, PublicFrame, Role, Vec2 } from "@app/shared/types";

const CELL_SIZE = 32;
const CELL_GAP = 3;
const CURRENT_MOVEMENT_OPACITY = 0.64;
const OLDEST_MOVEMENT_OPACITY = 0.14;

export function DungeonBoard({
    frame,
    board,
    movementFrames = [frame],
    view,
}: {
    frame: PublicFrame;
    board: Cell[][];
    movementFrames?: PublicFrame[];
    view: "god" | "duck" | "sphinx";
}) {
    const selectedTurn =
        view === "duck"
            ? frame.agentTurns?.duck
            : view === "sphinx"
              ? frame.agentTurns?.sphinx
              : null;
    const opponentHeat = selectedTurn?.telemetry?.opponent?.positionDistribution ?? null;
    const opponentPredicted = selectedTurn?.telemetry?.opponent?.predictedPosition ?? null;
    const oppMaxProbability = opponentHeat ? Math.max(...opponentHeat.flat(), 0) : 0;

    const goalHeat = selectedTurn?.telemetry?.goal?.positionDistribution ?? null;
    const goalPredicted = selectedTurn?.telemetry?.goal?.predictedPosition ?? null;
    const goalMaxProbability = goalHeat ? Math.max(...goalHeat.flat(), 0) : 0;
    const movements = movementOverlays(movementFrames.length > 0 ? movementFrames : [frame]);
    const boardWidth = board[0]?.length
        ? board[0].length * CELL_SIZE + Math.max(0, board[0].length - 1) * CELL_GAP
        : 0;
    const boardHeight = board.length
        ? board.length * CELL_SIZE + Math.max(0, board.length - 1) * CELL_GAP
        : 0;

    return (
        <div
            className="board"
            style={{
                gridTemplateColumns: `repeat(${board[0]?.length ?? 0}, ${CELL_SIZE}px)`,
            }}
        >
            <svg
                aria-hidden="true"
                className="movement-layer"
                height={boardHeight}
                viewBox={`0 0 ${boardWidth} ${boardHeight}`}
                width={boardWidth}
            >
                {movements.map(movement => (
                    <MovementTraceOverlay
                        key={`${movement.role}-${movement.step}`}
                        movement={movement}
                    />
                ))}
            </svg>
            {board.map((row, y) =>
                row.map((cell, x) => {
                    const pos: Vec2 = [x, y];
                    const visibleCell = view === "sphinx" && cell === 2 ? 0 : cell;
                    const isDuck = same(pos, frame.duck);
                    const isSphinx = same(pos, frame.sphinx);
                    const isGoal = same(pos, frame.goal);
                    const probability = opponentHeat?.[y]?.[x] ?? 0;
                    const opacity =
                        oppMaxProbability > 0
                            ? Math.min(0.88, (probability / oppMaxProbability) * 0.88)
                            : 0;

                    const goalProbability = goalHeat?.[y]?.[x] ?? 0;
                    const goalOpacity =
                        goalMaxProbability > 0
                            ? Math.min(0.88, (goalProbability / goalMaxProbability) * 0.88)
                            : 0;
                    const showsOpponentHeat = opponentHeat !== null && visibleCell !== 1;
                    const showsGoalHeat = goalHeat !== null && visibleCell !== 1;

                    return (
                        <div
                            className={`cell cell-${visibleCell}`}
                            key={`${x}-${y}`}
                        >
                            {showsOpponentHeat && (
                                <span
                                    className={view === "duck" ? "heat danger" : "heat belief"}
                                    style={{ opacity }}
                                />
                            )}
                            {showsGoalHeat && (
                                <span
                                    className="heat goal-belief"
                                    style={{ opacity: goalOpacity }}
                                />
                            )}
                            {(showsOpponentHeat || showsGoalHeat) && (
                                <span
                                    className="heat-tooltip"
                                    role="tooltip"
                                >
                                    <strong>
                                        ({x}, {y})
                                    </strong>
                                    {showsOpponentHeat && (
                                        <span>推定相手位置: {formatProbability(probability)}</span>
                                    )}
                                    {showsGoalHeat && (
                                        <span>
                                            予測ゴール: {formatProbability(goalProbability)}
                                        </span>
                                    )}
                                </span>
                            )}
                            {opponentPredicted && same(pos, opponentPredicted) && (
                                <span
                                    className="prediction"
                                    title="予測された相手位置"
                                >
                                    P
                                </span>
                            )}
                            {goalPredicted && same(pos, goalPredicted) && (
                                <span
                                    className="prediction prediction-goal"
                                    title="予測されたゴール位置"
                                >
                                    P
                                </span>
                            )}
                            {isGoal && <span className="token goal">G</span>}
                            {isDuck && <span className="token duck">D</span>}
                            {isSphinx && <span className="token sphinx">S</span>}
                        </div>
                    );
                })
            )}
        </div>
    );
}

type MovementOverlay = ReturnType<typeof movementOverlays>[number];

function MovementTraceOverlay({ movement }: { movement: MovementOverlay }) {
    const from = cellCenter(movement.from);
    const to = cellCenter(movement.to);
    const isStay = same(movement.from, movement.to);
    const className = `movement-trace movement-trace-${movement.role.toLowerCase()} movement-trace-${movement.outcome.toLowerCase()}`;
    const title = `${movement.role} step ${movement.step + 1}: request ${movement.requestedDirection}, resolved ${movement.resolvedDirection}, moved ${movement.actualDirection}`;
    const opacity = movementOpacity(movement.age, movement.historyLength);

    if (isStay) {
        return null;
    }

    const start = {
        x: from.x,
        y: from.y,
    };
    const end = {
        x: to.x,
        y: to.y,
    };
    const path = `M ${start.x} ${start.y} L ${end.x} ${end.y}`;

    return (
        <g
            className={className}
            style={{ opacity }}
        >
            <title>{title}</title>
            <path
                className="movement-line"
                d={path}
            />
        </g>
    );
}

function movementOverlays(frames: PublicFrame[]) {
    const historyLength = frames.length;

    return frames.flatMap((frame, frameIndex) => {
        const turns: [Role, AgentTurnTrace | null][] = [
            ["DUCK", frame.agentTurns?.duck ?? null],
            ["SPHINX", frame.agentTurns?.sphinx ?? null],
        ];
        const age = historyLength - frameIndex - 1;

        return turns.flatMap(([role, turn]) =>
            (turn?.movements ?? []).map((movement, step) => ({
                role,
                step,
                age,
                historyLength,
                ...movement,
            }))
        );
    });
}

function movementOpacity(age: number, historyLength: number): number {
    if (historyLength <= 1) return CURRENT_MOVEMENT_OPACITY;

    const progress = age / (historyLength - 1);
    return (
        CURRENT_MOVEMENT_OPACITY - (CURRENT_MOVEMENT_OPACITY - OLDEST_MOVEMENT_OPACITY) * progress
    );
}

function cellCenter([x, y]: Vec2): { x: number; y: number } {
    const stride = CELL_SIZE + CELL_GAP;
    return {
        x: x * stride + CELL_SIZE / 2,
        y: y * stride + CELL_SIZE / 2,
    };
}

function same(a: Vec2, b: Vec2): boolean {
    return a[0] === b[0] && a[1] === b[1];
}

function formatProbability(probability: number): string {
    return `${(probability * 100).toFixed(2)}%`;
}
