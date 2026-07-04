import type { MatchHistoryStats, MatchSummary } from "@app/shared/types";

interface MatchHistoryPanelProps {
    matches: MatchSummary[];
    stats: MatchHistoryStats;
    selectedId: string | null;
    loading: boolean;
    error: string | null;
    onSelect: (id: string) => void;
    onLive: () => void;
    onClear: () => void;
}

export function MatchHistoryPanel({
    matches,
    stats,
    selectedId,
    loading,
    error,
    onSelect,
    onLive,
    onClear,
}: MatchHistoryPanelProps) {
    return (
        <aside className="history-panel">
            <div className="history-heading">
                <h2>対戦履歴</h2>
                <button
                    className={selectedId === null ? "active" : ""}
                    onClick={onLive}
                >
                    ライブ
                </button>
            </div>
            <dl className="history-stats">
                <div>
                    <dt>総試合</dt>
                    <dd>{stats.total}</dd>
                </div>
                <div>
                    <dt>二号勝率</dt>
                    <dd>{formatRate(stats.duckWinRate)}</dd>
                </div>
                <div>
                    <dt>スフィンクス勝率</dt>
                    <dd>{formatRate(stats.sphinxWinRate)}</dd>
                </div>
                <div>
                    <dt>引き分け</dt>
                    <dd>{formatRate(stats.drawRate)}</dd>
                </div>
            </dl>
            {matches.length > 0 && (
                <button
                    className="history-clear"
                    disabled={loading}
                    onClick={onClear}
                >
                    履歴を削除
                </button>
            )}
            {error && <p className="history-error">{error}</p>}
            {matches.length === 0 ? (
                <p className="history-empty">保存済みの対戦はありません。</p>
            ) : (
                <ol className="history-list">
                    {matches.map(match => (
                        <li key={match.id}>
                            <button
                                className={selectedId === match.id ? "active" : ""}
                                disabled={loading}
                                onClick={() => onSelect(match.id)}
                            >
                                <span>
                                    {match.winner === "DRAW" ? "引き分け" : `${match.winner} 勝利`}
                                </span>
                                <small>
                                    {formatDate(match.finishedAt)} · {match.turn}ターン
                                </small>
                            </button>
                        </li>
                    ))}
                </ol>
            )}
        </aside>
    );
}

function formatRate(value: number): string {
    return `${(value * 100).toFixed(1)}%`;
}

function formatDate(value: string): string {
    return new Intl.DateTimeFormat("ja-JP", {
        dateStyle: "short",
        timeStyle: "medium",
    }).format(new Date(value));
}
