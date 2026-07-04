import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { MatchReplay, PublicFrame } from "@app/shared/types";

async function main() {
    const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
    const historyDir = Bun.env.MATCH_HISTORY_DIR ?? join(workspaceRoot, "data/matches");
    let files: string[];
    try {
        files = await readdir(historyDir);
    } catch {
        console.log("No match history directory found.");
        return;
    }

    const jsonFiles = files.filter(f => f.endsWith(".json"));
    if (jsonFiles.length === 0) {
        console.log("No match history found.");
        return;
    }

    let latestFile = "";
    let latestTime = 0;

    for (const file of jsonFiles) {
        const stat = await Bun.file(join(historyDir, file)).stat();
        if (stat.mtimeMs > latestTime) {
            latestTime = stat.mtimeMs;
            latestFile = file;
        }
    }

    console.log(`Loading latest match: ${latestFile}\n`);
    const replayFile = Bun.file(join(historyDir, latestFile));
    const replay: MatchReplay = await replayFile.json();

    const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

    for (let i = 0; i < replay.frames.length; i++) {
        const frame = replay.frames[i];
        console.clear();
        console.log(`Match ID: ${replay.summary.id}`);
        console.log(`Status: ${replay.summary.status}, Winner: ${replay.summary.winner}`);
        console.log(`--- Turn ${frame.turn} / ${replay.summary.frameCount - 1} ---`);
        printFrame(frame);

        const sphinxTurn = frame.agentTurns?.sphinx;
        if (sphinxTurn?.telemetry?.goal) {
            console.log(`\n[Sphinx Telemetry]`);
            console.log(
                `Goal Predicted: [${sphinxTurn.telemetry.goal.predictedPosition.join(", ")}]`
            );
            console.log(
                `Goal Confidence: ${(sphinxTurn.telemetry.goal.confidence * 100).toFixed(1)}%`
            );
        }

        if (sphinxTurn?.telemetry?.opponent) {
            console.log(
                `Opponent Predicted: [${sphinxTurn.telemetry.opponent.predictedPosition.join(", ")}]`
            );
            console.log(
                `Opponent Confidence: ${(sphinxTurn.telemetry.opponent.confidence * 100).toFixed(1)}%`
            );
        }

        if (i < replay.frames.length - 1) {
            await delay(400);
        }
    }
    console.log("\nReplay finished.");
}

function printFrame(frame: PublicFrame) {
    const map = frame.map;
    const height = map.length;
    const width = map[0].length;

    for (let y = 0; y < height; y++) {
        let rowStr = "";
        for (let x = 0; x < width; x++) {
            const cell = map[y][x];
            let char = cell === 1 ? "██" : cell === -1 ? "  " : "..";

            const isDuck = frame.duck[0] === x && frame.duck[1] === y;
            const isSphinx = frame.sphinx[0] === x && frame.sphinx[1] === y;
            const isGoal = frame.goal[0] === x && frame.goal[1] === y;

            if (isDuck && isSphinx) char = "💥";
            else if (isSphinx) char = "🦁";
            else if (isDuck) char = "🦆";
            else if (isGoal) char = "🚩";

            rowStr += char;
        }
        console.log(rowStr);
    }
}

main().catch(console.error);
