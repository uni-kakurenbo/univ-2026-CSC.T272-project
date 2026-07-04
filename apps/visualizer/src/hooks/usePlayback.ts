import { useEffect, useState } from "react";

import type { PublicFrame } from "@app/shared/types";

const BASE_INTERVAL_MS = 300;

export interface PlaybackState {
    frame: PublicFrame | null;
    viewIndex: number;
    frameCount: number;
    isLive: boolean;
    isRealtime: boolean;
    isPlaying: boolean;
    speed: number;
    play: () => void;
    pause: () => void;
    stepForward: () => void;
    stepBackward: () => void;
    seek: (index: number) => void;
    setSpeed: (speed: number) => void;
}

/**
 * Turns a growing frame history into a video-like timeline: by default it
 * tracks the newest ("live") frame, but pausing/stepping/seeking freezes the
 * view at any earlier frame without losing newly arriving ones. Pressing
 * play afterwards steps forward through the buffer at the chosen speed and
 * rejoins live once it catches up to the newest frame.
 */
export function usePlayback(
    history: PublicFrame[],
    isRealtime = true,
    sourceId = "live"
): PlaybackState {
    const [viewIndex, setViewIndex] = useState(-1);
    const [isPlaying, setIsPlaying] = useState(false);
    const [speed, setSpeed] = useState(1);

    const lastIndex = history.length - 1;
    const isLive = viewIndex === -1 || viewIndex >= lastIndex;

    useEffect(() => {
        setViewIndex(-1);
        setIsPlaying(false);
    }, [sourceId]);

    useEffect(() => {
        if (isLive) setViewIndex(lastIndex);
    }, [isLive, lastIndex]);

    useEffect(() => {
        if (isLive) setIsPlaying(false);
    }, [isLive]);

    useEffect(() => {
        if (!isPlaying || isLive) return;
        const id = setInterval(() => {
            setViewIndex(current => Math.min(current + 1, lastIndex));
        }, BASE_INTERVAL_MS / speed);
        return () => clearInterval(id);
    }, [isPlaying, isLive, speed, lastIndex]);

    function resolveCurrent(): number {
        return viewIndex === -1 ? lastIndex : viewIndex;
    }

    function pause(): void {
        setIsPlaying(false);
        setViewIndex(resolveCurrent());
    }

    function play(): void {
        if (isLive) return;
        setIsPlaying(true);
    }

    function stepBackward(): void {
        setIsPlaying(false);
        setViewIndex(Math.max(0, resolveCurrent() - 1));
    }

    function stepForward(): void {
        setIsPlaying(false);
        setViewIndex(Math.min(lastIndex, resolveCurrent() + 1));
    }

    function seek(index: number): void {
        setIsPlaying(false);
        setViewIndex(Math.max(0, Math.min(lastIndex, index)));
    }

    const frame = history.length === 0 ? null : (history[resolveCurrent()] ?? null);

    return {
        frame,
        viewIndex: resolveCurrent(),
        frameCount: history.length,
        isLive,
        isRealtime,
        isPlaying,
        speed,
        play,
        pause,
        stepForward,
        stepBackward,
        seek,
        setSpeed,
    };
}
