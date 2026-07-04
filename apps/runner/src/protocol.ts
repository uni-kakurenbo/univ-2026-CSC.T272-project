import type {
    AgentAction,
    AgentResponseEnvelope,
    AgentTelemetry,
    Direction,
    TargetEstimate,
} from "@app/shared/types";

export interface ParsedAgentResponse {
    action: AgentAction;
    telemetry?: AgentTelemetry;
}

export function parseDuckResponse(input: string): ParsedAgentResponse {
    const response = parseResponseEnvelope(input);
    return { action: parseDuckAction(response.action), telemetry: response.telemetry };
}

export function parseSphinxResponse(input: string): ParsedAgentResponse {
    const response = parseResponseEnvelope(input);
    return { action: parseSphinxAction(response.action), telemetry: response.telemetry };
}

export function parseDuckAction(input: string): AgentAction {
    const match = input.trim().match(/^ACTION:\s*(UP|DOWN|LEFT|RIGHT|STAY|OBSERVE)$/);
    if (!match) throw new Error(`Invalid DUCK action: ${input}`);
    return { actions: [match[1] as Direction] };
}

export function parseSphinxAction(input: string): AgentAction {
    const match = input.trim().match(/^ACTION:\s*(UP|DOWN|LEFT|RIGHT|STAY|OBSERVE)$/);
    if (!match) throw new Error(`Invalid SPHINX action: ${input}`);
    return { actions: [match[1] as Direction] };
}

function parseResponseEnvelope(input: string): AgentResponseEnvelope {
    const trimmed = input.trim();
    if (!trimmed.startsWith("{")) return { action: trimmed };

    let value: unknown;
    try {
        value = JSON.parse(trimmed);
    } catch {
        throw new Error("Invalid agent response JSON.");
    }
    if (!isRecord(value) || typeof value.action !== "string") {
        throw new Error("Agent response envelope requires an action string.");
    }
    if (value.telemetry === undefined) return { action: value.action };
    return {
        action: value.action,
        telemetry: parseTelemetry(value.telemetry),
    };
}

function parseTargetEstimate(value: unknown): TargetEstimate {
    if (!isRecord(value)) {
        throw new Error("Target estimate must be an object.");
    }
    const predictedPosition = value.predictedPosition;
    const positionDistribution = value.positionDistribution;
    const confidence = value.confidence;

    if (
        !Array.isArray(predictedPosition) ||
        predictedPosition.length !== 2 ||
        !predictedPosition.every(Number.isInteger)
    ) {
        throw new Error("Telemetry predictedPosition must be an integer [x, y].");
    }
    if (
        !Array.isArray(positionDistribution) ||
        positionDistribution.length === 0 ||
        !positionDistribution.every(
            row =>
                Array.isArray(row) &&
                row.length > 0 &&
                row.every(probability => isProbability(probability))
        )
    ) {
        throw new Error("Telemetry positionDistribution must be a probability grid.");
    }
    const width = positionDistribution[0]!.length;
    if (!positionDistribution.every(row => row.length === width)) {
        throw new Error("Telemetry positionDistribution must be rectangular.");
    }
    if (!isProbability(confidence)) {
        throw new Error("Telemetry confidence must be between 0 and 1.");
    }
    const totalProbability = positionDistribution
        .flat()
        .reduce((total, probability) => total + probability, 0);
    if (Math.abs(totalProbability - 1) > 0.001) {
        throw new Error("Telemetry positionDistribution must sum to 1.");
    }

    return {
        predictedPosition: predictedPosition as [number, number],
        positionDistribution: positionDistribution as number[][],
        confidence,
    };
}

function parseTelemetry(value: unknown): AgentTelemetry {
    if (!isRecord(value)) {
        throw new Error("Agent telemetry must be an object.");
    }
    const telemetry: AgentTelemetry = {};
    if (value.opponent !== undefined) {
        telemetry.opponent = parseTargetEstimate(value.opponent);
    }
    if (value.goal !== undefined) {
        telemetry.goal = parseTargetEstimate(value.goal);
    }
    return telemetry;
}

function isProbability(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
