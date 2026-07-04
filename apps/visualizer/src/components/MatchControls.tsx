import { useState } from "react";

import type { ArenaState } from "@app/shared/types";

import { api } from "../api";

const LABELS: Record<ArenaState, string> = {
    idle: "試合を実行",
    "waiting-for-agents": "エージェント接続待ち...",
    running: "試合を追加",
};

export function MatchControls({
    arenaState,
    activeMatchCount,
    queuedMatchCount,
    maxConcurrentMatches,
}: {
    arenaState: ArenaState;
    activeMatchCount: number;
    queuedMatchCount: number;
    maxConcurrentMatches: number | null;
}) {
    const [error, setError] = useState<string | null>(null);
    const [count, setCount] = useState(1);

    async function handleClick(): Promise<void> {
        setError(null);
        try {
            const response = await api.api.matches.$post({ json: { count } });
            if (!response.ok) {
                const body = await response.json().catch(() => null);
                setError(
                    `試合を開始できませんでした (${response.status}${body?.reason ? `: ${body.reason}` : ""})`
                );
            }
        } catch (error) {
            console.error("[MatchControls] Failed to start match:", error);
            setError("サーバーに接続できませんでした。");
        }
    }

    return (
        <div className="match-controls">
            <label className="match-count">
                <span>実行数</span>
                <input
                    max={64}
                    min={1}
                    type="number"
                    value={count}
                    onChange={event => setCount(clampCount(Number(event.target.value)))}
                />
            </label>
            <button
                className="match-start"
                disabled={arenaState === "waiting-for-agents"}
                onClick={handleClick}
            >
                {formatStartLabel({
                    arenaState,
                    activeMatchCount,
                    queuedMatchCount,
                    maxConcurrentMatches,
                })}
            </button>
            {error && <span className="match-error">{error}</span>}
        </div>
    );
}

function clampCount(value: number): number {
    if (!Number.isFinite(value)) return 1;
    return Math.max(1, Math.min(64, Math.trunc(value)));
}

function formatStartLabel({
    arenaState,
    activeMatchCount,
    queuedMatchCount,
    maxConcurrentMatches,
}: {
    arenaState: ArenaState;
    activeMatchCount: number;
    queuedMatchCount: number;
    maxConcurrentMatches: number | null;
}): string {
    const label = LABELS[arenaState];
    if (activeMatchCount === 0 && queuedMatchCount === 0) return label;

    const capacity = maxConcurrentMatches === null ? "" : ` / 上限${maxConcurrentMatches}`;
    const queued = queuedMatchCount === 0 ? "" : ` / ${queuedMatchCount}件待機中`;
    return `${label} (${activeMatchCount}件実行中${queued}${capacity})`;
}
