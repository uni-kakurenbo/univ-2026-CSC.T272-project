import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export {};

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const buildDir = resolve(workspaceRoot, "build");
await mkdir(buildDir, { recursive: true });

const extension = process.platform === "win32" ? ".exe" : "";
const compiler = await findCompiler();

if (!compiler) {
    console.error("No C++ compiler found. Install g++ or clang++ and retry.");
    process.exit(1);
}

await build(
    resolve(workspaceRoot, "apps/agents/duck/main.cpp"),
    `${buildDir}/duck-agent${extension}`
);
await build(
    resolve(workspaceRoot, "apps/agents/sphinx/main.cpp"),
    `${buildDir}/sphinx-agent${extension}`
);
console.log("Agents built successfully.");

async function build(source: string, output: string): Promise<void> {
    console.log(`[build] ${source} -> ${output}`);
    const linkerFlags = process.platform === "win32" ? ["-static"] : [];
    await Bun.$`${compiler} -std=gnu++26 -O2 -Wall -Wextra ${linkerFlags} ${source} -o ${output}`;
}

async function findCompiler(): Promise<string | undefined> {
    for (const candidate of ["g++", "clang++"]) {
        const proc = Bun.spawn([candidate, "--version"], {
            stdout: "pipe",
            stderr: "pipe",
        });
        const code = await proc.exited;
        if (code === 0) return candidate;
    }
    return undefined;
}
