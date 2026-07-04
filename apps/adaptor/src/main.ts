const args = parseArgs(Bun.argv.slice(2));
const requestedWsUrl = args.url ?? args.u;
const requestedExecCommand = args.exec ?? args.e;

if (!requestedWsUrl || !requestedExecCommand) {
    console.error("Usage: bun run apps/adaptor/src/main.ts --url <WS_URL> --exec <COMMAND_TO_RUN>");
    process.exit(1);
}

const wsUrl = requestedWsUrl;
const execCommand = requestedExecCommand;

console.log(`[Adapter] Connecting to ${wsUrl}...`);
const ws = new WebSocket(wsUrl);
let proc: AgentProcess | undefined;

ws.onopen = () => {
    console.log(`[Adapter] Connected. Spawning: ${execCommand}`);
    const spawned = Bun.spawn(splitCommand(execCommand), {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "inherit",
    }) as unknown as AgentProcess;
    proc = spawned;

    void pumpStdout(spawned, ws);

    spawned.exited.then((code: number | null) => {
        console.log(`[Adapter] Agent exited with code ${code}.`);
        if (ws.readyState === WebSocket.OPEN) ws.close(1000, "Agent exited");
        process.exit(code ?? 0);
    });
};

ws.onmessage = event => {
    if (!proc) return;
    const data = typeof event.data === "string" ? event.data : String(event.data);
    const payload = data.endsWith("\n") ? data : `${data}\n`;
    proc.stdin.write(payload);
    proc.stdin.flush();
};

ws.onerror = error => {
    console.error("[Adapter] WebSocket error:", error);
    process.exit(1);
};

ws.onclose = () => {
    console.log("[Adapter] WebSocket closed. Terminating agent.");
    proc?.kill();
    process.exit(0);
};

interface AgentProcess {
    stdin: Bun.FileSink;
    stdout: ReadableStream<Uint8Array>;
    exited: Promise<number | null>;
    kill: () => void;
}

async function pumpStdout(proc: AgentProcess, ws: WebSocket): Promise<void> {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed && ws.readyState === WebSocket.OPEN) {
                ws.send(trimmed);
            }
        }
    }
}

function parseArgs(argv: string[]): Record<string, string | undefined> {
    const parsed: Record<string, string | undefined> = {};
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i]!;
        if (!token.startsWith("--") && !token.startsWith("-")) continue;
        const key = token.replace(/^-+/, "");
        parsed[key] = argv[i + 1];
        i += 1;
    }
    return parsed;
}

function splitCommand(command: string): string[] {
    const matches = command.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
    return matches.map(part => part.replace(/^"|"$/g, ""));
}
