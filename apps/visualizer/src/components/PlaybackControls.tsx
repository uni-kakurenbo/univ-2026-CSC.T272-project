import type { PlaybackState } from "../hooks/usePlayback";

const SPEED_OPTIONS = [0.5, 1, 2, 4, 8, 10];

export function PlaybackControls({ playback }: { playback: PlaybackState }) {
    const {
        viewIndex,
        frameCount,
        isLive,
        isRealtime,
        isPlaying,
        speed,
        play,
        pause,
        stepBackward,
        stepForward,
        seek,
        setSpeed,
    } = playback;

    const isPaused = frameCount === 0;
    const showPause = isLive || isPlaying;

    return (
        <section className="playback">
            <button
                onClick={stepBackward}
                disabled={isPaused}
            >
                ◀ コマ戻し
            </button>
            <button
                onClick={showPause ? pause : play}
                disabled={isPaused}
            >
                {showPause ? "一時停止" : "再生"}
            </button>
            <button
                onClick={stepForward}
                disabled={isPaused}
            >
                コマ送り ▶
            </button>
            <input
                type="range"
                min={0}
                max={Math.max(0, frameCount - 1)}
                value={Math.max(0, viewIndex)}
                disabled={isPaused}
                onChange={event => seek(Number(event.target.value))}
            />
            <span className="playback-turn">
                {isPaused ? "-" : `${viewIndex + 1} / ${frameCount}`}
                {isRealtime && isLive && " (LIVE)"}
            </span>
            <select
                value={speed}
                onChange={event => setSpeed(Number(event.target.value))}
            >
                {SPEED_OPTIONS.map(option => (
                    <option
                        key={option}
                        value={option}
                    >
                        {option}x
                    </option>
                ))}
            </select>
        </section>
    );
}
