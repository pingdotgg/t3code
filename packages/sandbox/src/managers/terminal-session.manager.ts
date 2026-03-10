import { randomUUID } from "node:crypto";

import * as Effect from "effect/Effect";

import type { PlaygroundSession, TerminalServiceShape } from "../services/terminal";

export interface ManagedTerminalSnapshot {
  readonly terminalId: string;
  readonly sandboxId: string;
  readonly cwd: string;
  readonly sessionId: string;
  readonly status: "open" | "closed" | "error";
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OpenManagedTerminalOptions {
  readonly terminalId?: string;
  readonly sandboxId: string;
  readonly cwd: string;
  readonly cols?: number;
  readonly rows?: number;
}

export type TerminalManagerEvent =
  | {
      readonly type: "data";
      readonly terminalId: string;
      readonly chunk: Uint8Array;
    }
  | {
      readonly type: "lifecycle";
      readonly terminal: ManagedTerminalSnapshot;
    };

interface ManagedTerminalState {
  snapshot: ManagedTerminalSnapshot;
  session: PlaygroundSession;
}

function nowIso(): string {
  return new Date().toISOString();
}

export class TerminalSessionManager {
  private readonly sessions = new Map<string, ManagedTerminalState>();
  private readonly listeners = new Set<(event: TerminalManagerEvent) => void | Promise<void>>();

  constructor(private readonly terminalService: TerminalServiceShape) {}

  list(): readonly ManagedTerminalSnapshot[] {
    return [...this.sessions.values()].map((entry) => entry.snapshot);
  }

  get(terminalId: string): ManagedTerminalSnapshot | undefined {
    return this.sessions.get(terminalId)?.snapshot;
  }

  onEvent(listener: (event: TerminalManagerEvent) => void | Promise<void>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async open(options: OpenManagedTerminalOptions): Promise<ManagedTerminalSnapshot> {
    const terminalId = options.terminalId ?? randomUUID();
    const existing = this.sessions.get(terminalId);
    if (existing?.snapshot.status === "open") {
      return existing.snapshot;
    }

    let state: ManagedTerminalState | undefined;
    const createdAt = nowIso();
    const session = await Effect.runPromise(
      this.terminalService.openSandboxPtySession({
        sandboxId: options.sandboxId,
        cwd: options.cwd,
        cols: options.cols,
        rows: options.rows,
        deleteSandboxOnCleanup: false,
        onData: async (chunk) => {
          if (!state) {
            return;
          }

          await this.emit({
            type: "data",
            terminalId,
            chunk,
          });
        },
      }),
    );

    state = {
      snapshot: {
        terminalId,
        sandboxId: options.sandboxId,
        cwd: options.cwd,
        sessionId: session.sessionId,
        status: "open",
        createdAt,
        updatedAt: createdAt,
      },
      session,
    };

    this.sessions.set(terminalId, state);
    await this.emit({
      type: "lifecycle",
      terminal: state.snapshot,
    });

    void Effect.runPromise(session.wait).then(
      async (result) => {
        const status = result.exitCode === 0 ? "closed" : "error";
        await this.setStatus(terminalId, status);
      },
      async () => {
        await this.setStatus(terminalId, "error");
      },
    );

    return state.snapshot;
  }

  async write(terminalId: string, data: string): Promise<void> {
    const state = this.requireSession(terminalId);
    await Effect.runPromise(state.session.sendInput(data));
  }

  async resize(terminalId: string, cols: number, rows: number): Promise<void> {
    const state = this.requireSession(terminalId);
    await Effect.runPromise(state.session.resize(cols, rows));
  }

  async close(terminalId: string): Promise<void> {
    const state = this.requireSession(terminalId);
    await Effect.runPromise(state.session.cleanup);
    await this.setStatus(terminalId, "closed");
  }

  private requireSession(terminalId: string): ManagedTerminalState {
    const state = this.sessions.get(terminalId);
    if (!state) {
      throw new Error(`Terminal ${terminalId} was not found.`);
    }

    return state;
  }

  private async setStatus(
    terminalId: string,
    status: ManagedTerminalSnapshot["status"],
  ): Promise<void> {
    const state = this.sessions.get(terminalId);
    if (!state) {
      return;
    }

    state.snapshot = {
      ...state.snapshot,
      status,
      updatedAt: nowIso(),
    };

    await this.emit({
      type: "lifecycle",
      terminal: state.snapshot,
    });
  }

  private async emit(event: TerminalManagerEvent): Promise<void> {
    for (const listener of this.listeners) {
      await listener(event);
    }
  }
}
