import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import * as nodePty from "node-pty";

export interface PtyExitEvent {
  exitCode: number;
  signal: number | null;
}

export interface PtyProcess {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(callback: (data: string) => void): () => void;
  onExit(callback: (event: PtyExitEvent) => void): () => void;
}

export interface PtySpawnInput {
  shell: string;
  args?: string[];
  cwd: string;
  cols: number;
  rows: number;
  env: NodeJS.ProcessEnv;
}

export interface PtyAdapter {
  spawn(input: PtySpawnInput): PtyProcess;
}

const requireForNodePty = createRequire(import.meta.url);
let didEnsureSpawnHelperExecutable = false;

function resolveNodePtySpawnHelperPath(): string | null {
  try {
    const packageJsonPath = requireForNodePty.resolve("node-pty/package.json");
    const packageDir = path.dirname(packageJsonPath);
    const candidates = [
      path.join(packageDir, "build", "Release", "spawn-helper"),
      path.join(packageDir, "build", "Debug", "spawn-helper"),
      path.join(packageDir, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return null;
  } catch {
    return null;
  }
}

export function ensureNodePtySpawnHelperExecutable(explicitPath?: string): void {
  if (process.platform === "win32") return;
  if (!explicitPath && didEnsureSpawnHelperExecutable) return;

  const helperPath = explicitPath ?? resolveNodePtySpawnHelperPath();
  if (!helperPath) return;
  if (!explicitPath) {
    didEnsureSpawnHelperExecutable = true;
  }

  try {
    const stat = fs.statSync(helperPath);
    const mode = stat.mode & 0o777;
    if ((mode & 0o111) === 0) {
      fs.chmodSync(helperPath, mode | 0o111);
    }
  } catch {
    // Best effort only. If chmod fails, node-pty spawn will surface the real error.
  }
}

class NodePtyProcess implements PtyProcess {
  constructor(private readonly process: nodePty.IPty) {}

  get pid(): number {
    return this.process.pid;
  }

  write(data: string): void {
    this.process.write(data);
  }

  resize(cols: number, rows: number): void {
    this.process.resize(cols, rows);
  }

  kill(signal?: string): void {
    this.process.kill(signal);
  }

  onData(callback: (data: string) => void): () => void {
    const disposable = this.process.onData(callback);
    return () => {
      disposable.dispose();
    };
  }

  onExit(callback: (event: PtyExitEvent) => void): () => void {
    const disposable = this.process.onExit((event) => {
      callback({
        exitCode: event.exitCode,
        signal: event.signal ?? null,
      });
    });
    return () => {
      disposable.dispose();
    };
  }
}

export class NodePtyAdapter implements PtyAdapter {
  spawn(input: PtySpawnInput): PtyProcess {
    ensureNodePtySpawnHelperExecutable();
    const ptyProcess = nodePty.spawn(input.shell, input.args ?? [], {
      cwd: input.cwd,
      cols: input.cols,
      rows: input.rows,
      env: input.env,
      name: globalThis.process.platform === "win32" ? "xterm-color" : "xterm-256color",
    });
    return new NodePtyProcess(ptyProcess);
  }
}
