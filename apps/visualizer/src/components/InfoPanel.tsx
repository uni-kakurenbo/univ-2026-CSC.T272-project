import type { AgentTurnTrace, PublicFrame } from "@app/shared/types";

export function InfoPanel({ frame }: { frame: PublicFrame }) {
    return (
        <aside className="panel">
            <h2>Episode</h2>
            <dl>
                <dt>Turn</dt>
                <dd>{frame.turn}</dd>
                <dt>Status</dt>
                <dd>{frame.status}</dd>
                <dt>Winner</dt>
                <dd>{frame.winner ?? "-"}</dd>
            </dl>
            <h2>Sensors</h2>
            <pre>{JSON.stringify(frame.sensors, null, 2)}</pre>
            <h2>Agent decisions</h2>
            <AgentDecision
                name="二号"
                turn={frame.agentTurns?.duck ?? null}
            />
            <AgentDecision
                name="スフィンクス"
                turn={frame.agentTurns?.sphinx ?? null}
            />
        </aside>
    );
}

function AgentDecision({ name, turn }: { name: string; turn: AgentTurnTrace | null }) {
    if (!turn) {
        return (
            <section className="agent-decision">
                <h3>{name}</h3>
                <p className="muted">このフレームには行動データがありません。</p>
            </section>
        );
    }

    const estimate = turn.telemetry?.opponent;
    const goalEstimate = turn.telemetry?.goal;

    return (
        <section className="agent-decision">
            <h3>
                {name} <small>観測ターン {turn.turn}</small>
            </h3>
            <ol>
                {turn.movements.map((movement, index) => (
                    <li key={index}>
                        <strong>
                            {movement.requestedDirection} → {movement.actualDirection}
                        </strong>
                        <span>
                            物理解決: {movement.resolvedDirection} / [{movement.from.join(", ")}] →
                            [{movement.to.join(", ")}] / {movement.outcome}
                        </span>
                    </li>
                ))}
            </ol>
            {estimate && (
                <dl className="estimate">
                    <dt>相手位置予測</dt>
                    <dd>[{estimate.predictedPosition.join(", ")}]</dd>
                    <dt>確信度</dt>
                    <dd>{(estimate.confidence * 100).toFixed(1)}%</dd>
                </dl>
            )}
            {goalEstimate && (
                <dl
                    className="estimate"
                    style={{
                        borderColor: "rgba(251, 191, 36, 0.4)",
                        background: "rgba(180, 83, 9, 0.2)",
                    }}
                >
                    <dt style={{ color: "#fcd34d" }}>ゴール位置予測</dt>
                    <dd>[{goalEstimate.predictedPosition.join(", ")}]</dd>
                    <dt style={{ color: "#fcd34d" }}>確信度</dt>
                    <dd>{(goalEstimate.confidence * 100).toFixed(1)}%</dd>
                </dl>
            )}
            {!estimate && !goalEstimate && (
                <p className="muted">telemetry は提供されていません。</p>
            )}
        </section>
    );
}
