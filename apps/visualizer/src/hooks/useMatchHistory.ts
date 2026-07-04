import { useCallback, useEffect, useState } from "react";

import type { ArenaState, MatchHistoryStats, MatchReplay, MatchSummary } from "@app/shared/types";

import { api } from "../api";

export interface MatchHistoryState {
    matches: MatchSummary[];
    stats: MatchHistoryStats;
    selectedMatch: MatchReplay | null;
    loading: boolean;
    error: string | null;
    selectMatch: (id: string) => Promise<void>;
    clearHistory: () => Promise<void>;
    clearSelection: () => void;
}

const emptyStats: MatchHistoryStats = {
    total: 0,
    duckWins: 0,
    sphinxWins: 0,
    draws: 0,
    duckWinRate: 0,
    sphinxWinRate: 0,
    drawRate: 0,
};

export function useMatchHistory(arenaState: ArenaState): MatchHistoryState {
    const [matches, setMatches] = useState<MatchSummary[]>([]);
    const [stats, setStats] = useState<MatchHistoryStats>(emptyStats);
    const [selectedMatch, setSelectedMatch] = useState<MatchReplay | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        try {
            const [matchesResponse, statsResponse] = await Promise.all([
                api.api.matches.$get(),
                api.api.matches.stats.$get(),
            ]);
            if (!matchesResponse.ok) throw new Error(`HTTP ${matchesResponse.status}`);
            if (!statsResponse.ok) throw new Error(`HTTP ${statsResponse.status}`);
            setMatches(await matchesResponse.json());
            setStats(await statsResponse.json());
            setError(null);
        } catch (refreshError) {
            console.error("[History] Failed to load matches:", refreshError);
            setError("対戦履歴を取得できませんでした。");
        }
    }, []);

    useEffect(() => {
        if (arenaState === "idle") void refresh();
    }, [arenaState, refresh]);

    async function selectMatch(id: string): Promise<void> {
        setLoading(true);
        setError(null);
        try {
            const response = await api.api.matches[":id"].$get({ param: { id } });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            setSelectedMatch(await response.json());
        } catch (selectionError) {
            console.error(`[History] Failed to load match ${id}:`, selectionError);
            setError("選択した対戦を読み込めませんでした。");
        } finally {
            setLoading(false);
        }
    }

    async function clearHistory(): Promise<void> {
        if (!confirm("保存済みの対戦履歴をすべて削除します。よろしいですか？")) return;
        setLoading(true);
        setError(null);
        try {
            const response = await api.api.matches.$delete();
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            setSelectedMatch(null);
            await refresh();
        } catch (clearError) {
            console.error("[History] Failed to clear match history:", clearError);
            setError("対戦履歴を削除できませんでした。");
        } finally {
            setLoading(false);
        }
    }

    return {
        matches,
        stats,
        selectedMatch,
        loading,
        error,
        selectMatch,
        clearHistory,
        clearSelection: () => setSelectedMatch(null),
    };
}
