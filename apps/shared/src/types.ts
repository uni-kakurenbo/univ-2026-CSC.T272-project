export type Role = "DUCK" | "SPHINX";
export type AgentRolePath = "duck" | "sphinx";
export type GameStatus = "ACTIVE" | "WIN" | "LOSE" | "DRAW";
export type Cell = -1 | 0 | 1 | 2;
export type TerrainCell = 0 | 1;
export type Direction = "UP" | "DOWN" | "LEFT" | "RIGHT" | "STAY" | "OBSERVE";
export type Vec2 = [x: number, y: number];

export interface SensorReading {
    sound: 0 | 1;
    heat: 0 | 1;
    radio: number;
    compass: Direction | "UNKNOWN";
}

export interface DuckInitPacket {
    role: "DUCK";
    t_max: number;
    map_size: [height: number, width: number];
    goal: Vec2;
}

export interface SphinxInitPacket {
    role: "SPHINX";
    t_max: number;
    map_size: [height: number, width: number];
    full_map: TerrainCell[][];
}

export type InitPacket = DuckInitPacket | SphinxInitPacket;

export interface ObservationBase {
    turn: number;
    role: Role;
    status: GameStatus;
}

export interface DuckObservation extends ObservationBase {
    role: "DUCK";
    pos: Vec2;
    sensors: SensorReading;
    fov: {
        radius: number;
        grid: Cell[][];
    };
    sphinx_pos?: Vec2;
}

export interface SphinxObservation extends ObservationBase {
    role: "SPHINX";
    pos: Vec2;
    duck_pos: Vec2;
    goal_distance?: number;
}

export type AgentObservation = DuckObservation | SphinxObservation;

export interface AgentAction {
    actions: Direction[];
}

export interface TargetEstimate {
    predictedPosition: Vec2;
    positionDistribution: number[][];
    confidence: number;
}

export interface AgentTelemetry {
    opponent?: TargetEstimate;
    goal?: TargetEstimate;
}

export interface AgentResponseEnvelope {
    action: string;
    telemetry?: AgentTelemetry;
}

export type MovementOutcome = "MOVED" | "SLIPPED" | "BLOCKED" | "STAY" | "NOT_EXECUTED";

export interface MovementTrace {
    requestedDirection: Direction;
    resolvedDirection: Direction;
    actualDirection: Direction;
    from: Vec2;
    to: Vec2;
    outcome: MovementOutcome;
}

export interface AgentTurnTrace {
    turn: number;
    movements: MovementTrace[];
    telemetry?: AgentTelemetry;
}

export interface AgentConnection {
    role: Role;
    send: (message: string) => void;
    close: (code?: number, reason?: string) => void;
}

export interface PublicFrame {
    type: "frame";
    matchId?: string;
    turn: number;
    status: GameStatus;
    winner: Role | "DRAW" | null;
    map: Cell[][];
    duck: Vec2;
    sphinx: Vec2;
    goal: Vec2;
    sensors: SensorReading;
    duckMemory: Cell[][];
    agentTurns: {
        duck: AgentTurnTrace | null;
        sphinx: AgentTurnTrace | null;
    };
}

export interface EpisodeResult {
    status: Exclude<GameStatus, "ACTIVE">;
    winner: Role | "DRAW";
    turn: number;
    duckScore: number;
    sphinxScore: number;
}

export interface AgentIntelligenceConfig {
    level: number;
}

export interface MatchAgentConfig {
    duck: AgentIntelligenceConfig;
    sphinx: AgentIntelligenceConfig;
    seed?: number;
    matrixRunId?: string;
    matrixTrial?: number;
}

export interface MatchStartRequest {
    count?: number;
    duckLevel?: number;
    sphinxLevel?: number;
    seed?: number;
    matrixRunId?: string;
    matrixTrial?: number;
}

export interface MatchSummary extends EpisodeResult {
    id: string;
    startedAt: string;
    finishedAt: string;
    frameCount: number;
    agentConfig?: MatchAgentConfig;
}

export interface MatchReplay {
    summary: MatchSummary;
    frames: PublicFrame[];
}

export interface MatchHistoryStats {
    total: number;
    duckWins: number;
    sphinxWins: number;
    draws: number;
    duckWinRate: number;
    sphinxWinRate: number;
    drawRate: number;
}

export interface IntelligenceMatrixCell extends MatchHistoryStats {
    duckLevel: number;
    sphinxLevel: number;
}

export interface IntelligenceMatrix {
    duckLevels: number[];
    sphinxLevels: number[];
    cells: IntelligenceMatrixCell[][];
}

export type ArenaState = "idle" | "waiting-for-agents" | "running";

export interface StatusMessage {
    type: "status";
    state: ArenaState;
    activeMatchCount?: number;
    startingMatchCount?: number;
    queuedMatchCount?: number;
    maxConcurrentMatches?: number;
}

export type ViewerMessage = PublicFrame | StatusMessage;

export interface OrchestratorStartMessage {
    type: "start";
    matchId?: string;
}
