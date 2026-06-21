/// <reference types="bun" />

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as PtyAdapter from "./PtyAdapter.ts";

export class BunPtyUnsupportedPlatformError extends Schema.TaggedErrorClass<BunPtyUnsupportedPlatformError>()(
  "BunPtyUnsupportedPlatformError",
  {
    platform: Schema.Literal("win32"),
  },
) {
  override get message(): string {
    return `Bun PTY terminal support is unavailable on ${this.platform}. Please use Node.js (e.g. by running \`npx t3\`) instead.`;
  }
}

export class BunPtyOperationUnavailableError extends Schema.TaggedErrorClass<BunPtyOperationUnavailableError>()(
  "BunPtyOperationUnavailableError",
  {
    operation: Schema.Literals(["write", "resize"]),
    pid: Schema.Number,
  },
) {
  override get message(): string {
    return `Bun PTY ${this.operation} is unavailable for process ${this.pid}.`;
  }
}

class BunPtyProcess implements PtyAdapter.PtyProcess {
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyAdapter.PtyExitEvent) => void>();
  private readonly decoder = new TextDecoder();
  private readonly process: Bun.Subprocess;
  private didExit = false;

  constructor(process: Bun.Subprocess) {
    this.process = process;
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
      throw new BunPtyOperationUnavailableError({ operation: "write", pid: this.pid });
    }
    this.process.terminal.write(data);
  }

  resize(cols: number, rows: number): void {
    if (!this.process.terminal?.resize) {
      throw new BunPtyOperationUnavailableError({ operation: "resize", pid: this.pid });
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

  onExit(callback: (event: PtyAdapter.PtyExitEvent) => void): () => void {
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

  private emitExit(event: PtyAdapter.PtyExitEvent): void {
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

export const make = Effect.fn("BunPtyAdapter.make")(function* () {
  const platform = yield* HostProcessPlatform;
  if (platform === "win32") {
    return yield* Effect.die(new BunPtyUnsupportedPlatformError({ platform }));
  }
  return PtyAdapter.PtyAdapter.of({
    spawn: (input) =>
      Effect.try({
        try: () => {
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
        catch: (cause) =>
          new PtyAdapter.PtySpawnError({
            adapter: "bun",
            shell: input.shell,
            cause,
          }),
      }),
  });
});

export const layer = Layer.effect(PtyAdapter.PtyAdapter, make());
