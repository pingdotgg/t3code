import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { Effect, Layer, ServiceMap } from "effect";

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

export interface PtyAdapterShape {
  spawn(input: PtySpawnInput): PtyProcess;
}

export class PtyAdapter extends ServiceMap.Service<PtyAdapter, PtyAdapterShape>()(
  "terminal/PtyAdapter",
) {
  static readonly layer = () =>
    typeof Bun !== "undefined" ? BunPtyAdapterLive : NodePtyAdapterLive;
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
  constructor(private readonly process: import("node-pty").IPty) {}

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

class BunPtyProcess implements PtyProcess {
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyExitEvent) => void>();
  private readonly decoder = new TextDecoder();
  private didExit = false;

  constructor(private readonly process: Bun.Subprocess) {
    void this.process.exited
      .then((exitCode) => {
        this.emitExit({
          exitCode: Number.isInteger(exitCode) ? exitCode : 0,
          signal: typeof this.process.signalCode === "number" ? this.process.signalCode : null,
        });
      })
      .catch(() => {
        this.emitExit({ exitCode: 1, signal: null });
      });
  }

  get pid(): number {
    return this.process.pid;
  }

  write(data: string): void {
    if (!this.process.terminal) {
      throw new Error("Bun PTY terminal handle is unavailable");
    }
    this.process.terminal.write(data);
  }

  resize(cols: number, rows: number): void {
    if (!this.process.terminal?.resize) {
      throw new Error("Bun PTY resize is unavailable");
    }
    this.process.terminal.resize(cols, rows);
  }

  kill(signal?: string): void {
    if (!signal) {
      this.process.kill();
      return;
    }
    this.process.kill(signal as NodeJS.Signals);
  }

  onData(callback: (data: string) => void): () => void {
    this.dataListeners.add(callback);
    return () => {
      this.dataListeners.delete(callback);
    };
  }

  onExit(callback: (event: PtyExitEvent) => void): () => void {
    this.exitListeners.add(callback);
    return () => {
      this.exitListeners.delete(callback);
    };
  }

  emitData(data: Uint8Array): void {
    if (this.didExit) return;
    const text = this.decoder.decode(data, { stream: true });
    if (text.length === 0) return;
    for (const listener of this.dataListeners) {
      listener(text);
    }
  }

  private emitExit(event: PtyExitEvent): void {
    if (this.didExit) return;
    this.didExit = true;

    const remainder = this.decoder.decode();
    if (remainder.length > 0) {
      for (const listener of this.dataListeners) {
        listener(remainder);
      }
    }

    for (const listener of this.exitListeners) {
      listener(event);
    }
  }
}
export const NodePtyAdapterLive = Layer.effect(
  PtyAdapter,
  Effect.gen(function* () {
    const nodePty = yield* Effect.promise(() => import("node-pty"));
    return {
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
      },
    };
  }),
);

export const BunPtyAdapterLive = Layer.effect(
  PtyAdapter,
  Effect.gen(function* () {
    if (process.platform === "win32") {
      return yield* Effect.die("Bun PTY terminal support is unavailable on Windows.");
    }
    return {
      spawn(input: PtySpawnInput): PtyProcess {
        let processHandle: BunPtyProcess | null = null;
        const command = [input.shell, ...(input.args ?? [])];
        const subprocess = Bun.spawn(command, {
          cwd: input.cwd,
          env: input.env,
          terminal: {
            cols: input.cols,
            rows: input.rows,
            data: (_terminal, data) => {
              processHandle?.emitData(data);
            },
          },
        });
        processHandle = new BunPtyProcess(subprocess);
        return processHandle;
      },
    };
  }),
);
