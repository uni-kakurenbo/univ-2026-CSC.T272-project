import { describe, expect, test } from "bun:test";

import { parseDuckResponse, parseSphinxResponse } from "./protocol";

describe("agent response protocol", () => {
    test("keeps legacy action responses compatible", () => {
        expect(parseDuckResponse("ACTION: LEFT")).toEqual({
            action: { actions: ["LEFT"] },
        });
        expect(parseSphinxResponse("ACTION: RIGHT")).toEqual({
            action: { actions: ["RIGHT"] },
        });
    });

    test("parses an action envelope with telemetry", () => {
        const response = parseDuckResponse(
            JSON.stringify({
                action: "ACTION: RIGHT",
                telemetry: {
                    opponent: {
                        predictedPosition: [1, 0],
                        positionDistribution: [
                            [0.25, 0.75],
                            [0, 0],
                        ],
                        confidence: 0.6,
                    },
                },
            })
        );

        expect(response.action).toEqual({ actions: ["RIGHT"] });
        expect(response.telemetry?.opponent?.predictedPosition).toEqual([1, 0]);
    });

    test("rejects malformed telemetry", () => {
        expect(() =>
            parseDuckResponse(
                JSON.stringify({
                    action: "ACTION: STAY",
                    telemetry: {
                        opponent: {
                            predictedPosition: [0, 0],
                            positionDistribution: [[1.5]],
                            confidence: 0.5,
                        },
                    },
                })
            )
        ).toThrow("probability grid");
    });
});
