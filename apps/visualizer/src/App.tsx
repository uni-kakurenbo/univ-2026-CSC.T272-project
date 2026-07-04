import { useMemo, useState } from "react";

import type { Cell } from "@app/shared/types";

import { DungeonBoard } from "./components/DungeonBoard";
import { InfoPanel } from "./components/InfoPanel";
import { MatchControls } from "./components/MatchControls";
import { MatchHistoryPanel } from "./components/MatchHistoryPanel";
import { PlaybackControls } from "./components/PlaybackControls";
import { useMatchHistory } from "./hooks/useMatchHistory";
import { usePlayback } from "./hooks/usePlayback";
import { useViewerSocket } from "./hooks/useViewerSocket";

const MOVEMENT_HISTORY_LENGTH = 8;

export function App() {
    const {
        connected,
        arenaState,
        activeMatchCount,
        queuedMatchCount,
        maxConcurrentMatches,
        history: liveFrames,
    } = useViewerSocket();
    const matchHistory = useMatchHistory(arenaState);
    const selectedId = matchHistory.selectedMatch?.summary.id ?? null;
    const frames = matchHistory.selectedMatch?.frames ?? liveFrames;
    const playback = usePlayback(frames, selectedId === null, selectedId ?? "live");
    const [view, setView] = useState<"god" | "duck" | "sphinx">("god");
    const frame = playback.frame;
    const movementFrames = useMemo(() => {
        if (playback.viewIndex < 0) return [];
        const start = Math.max(0, playback.viewIndex - MOVEMENT_HISTORY_LENGTH + 1);
        return frames.slice(start, playback.viewIndex + 1);
    }, [frames, playback.viewIndex]);

    const board = useMemo((): Cell[][] | null => {
        if (!frame) return null;
        if (view === "duck") return frame.duckMemory;
        return frame.map;
    }, [frame, view]);

    return (
        <main className="app">
            <header className="hero">
                <div>
                    <p className="eyebrow">Arena</p>
                    <h1>ホイールダック2号 vs スフィンクス</h1>
                </div>
                <span className={connected ? "badge connected" : "badge"}>
                    {connected ? "Connected" : "Offline"}
                </span>
            </header>

            <section className="toolbar">
                {(["god", "duck", "sphinx"] as const).map(key => (
                    <button
                        className={view === key ? "active" : ""}
                        key={key}
                        onClick={() => setView(key)}
                    >
                        {key === "god"
                            ? "神の視点"
                            : key === "duck"
                              ? "二号視点"
                              : "スフィンクス視点"}
                    </button>
                ))}
                <MatchControls
                    activeMatchCount={activeMatchCount}
                    arenaState={arenaState}
                    maxConcurrentMatches={maxConcurrentMatches}
                    queuedMatchCount={queuedMatchCount}
                />
            </section>

            <section className="content">
                <MatchHistoryPanel
                    matches={matchHistory.matches}
                    stats={matchHistory.stats}
                    selectedId={selectedId}
                    loading={matchHistory.loading}
                    error={matchHistory.error}
                    onSelect={id => void matchHistory.selectMatch(id)}
                    onClear={() => void matchHistory.clearHistory()}
                    onLive={matchHistory.clearSelection}
                />
                <div className="viewer">
                    {selectedId && (
                        <div className="replay-banner">
                            過去の対戦を再生中
                            <button onClick={matchHistory.clearSelection}>ライブに戻る</button>
                        </div>
                    )}
                    {frame && board ? (
                        <>
                            <PlaybackControls playback={playback} />
                            <section className="layout">
                                <DungeonBoard
                                    frame={frame}
                                    board={board}
                                    movementFrames={movementFrames}
                                    view={view}
                                />
                                <InfoPanel frame={frame} />
                            </section>
                        </>
                    ) : (
                        <section className="empty">
                            サーバーとエージェントの接続待機中です。
                        </section>
                    )}
                </div>
            </section>
        </main>
    );
}
