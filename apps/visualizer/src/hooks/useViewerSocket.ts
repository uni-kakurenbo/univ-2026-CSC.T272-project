import { useEffect, useRef, useState } from "react";

import type { ArenaState, PublicFrame, ViewerMessage } from "@app/shared/types";

import { api } from "../api";

export interface ViewerSocketState {
    connected: boolean;
    arenaState: ArenaState;
    activeMatchCount: number;
    queuedMatchCount: number;
    maxConcurrentMatches: number | null;
    history: PublicFrame[];
}

/**
 * Connects to /api/ws/view and buffers every frame received during this
 * session so the visualizer can rewind/step through it (see usePlayback).
 * The buffer is cleared whenever the server announces a new match is about
 * to start ("waiting-for-agents"), so old frames never bleed into the next.
 */
export function useViewerSocket(): ViewerSocketState {
    const [connected, setConnected] = useState(false);
    const [arenaState, setArenaState] = useState<ArenaState>("idle");
    const [activeMatchCount, setActiveMatchCount] = useState(0);
    const [queuedMatchCount, setQueuedMatchCount] = useState(0);
    const [maxConcurrentMatches, setMaxConcurrentMatches] = useState<number | null>(null);
    const [history, setHistory] = useState<PublicFrame[]>([]);
    const previousActiveMatchCount = useRef(0);
    const liveMatchId = useRef<string | null>(null);

    useEffect(() => {
        const ws = api.api.ws.view.$ws();
        ws.onopen = () => setConnected(true);
        ws.onclose = () => setConnected(false);
        ws.onmessage = event => {
            const message: ViewerMessage = JSON.parse(event.data);
            if (message.type === "status") {
                const nextActiveMatchCount = message.activeMatchCount ?? 0;
                setArenaState(message.state);
                setActiveMatchCount(nextActiveMatchCount);
                setQueuedMatchCount(message.queuedMatchCount ?? 0);
                setMaxConcurrentMatches(message.maxConcurrentMatches ?? null);
                if (previousActiveMatchCount.current === 0 && nextActiveMatchCount > 0) {
                    setHistory([]);
                    liveMatchId.current = null;
                }
                previousActiveMatchCount.current = nextActiveMatchCount;
                return;
            }
            liveMatchId.current ??= message.matchId ?? null;
            setHistory(prev => {
                const currentMatchId = liveMatchId.current ?? message.matchId ?? null;
                if (currentMatchId && message.matchId && message.matchId !== currentMatchId) {
                    return prev;
                }
                return [...prev, message];
            });
        };
        return () => ws.close();
    }, []);

    return {
        connected,
        arenaState,
        activeMatchCount,
        queuedMatchCount,
        maxConcurrentMatches,
        history,
    };
}
