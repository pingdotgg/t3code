/**
 * TerminalManager - Terminal session orchestration service interface.
 *
 * Owns terminal lifecycle operations, output fanout, and session state
 * transitions for thread-scoped terminals.
 *
 * @module TerminalManager
 */
import {
  TerminalClearInput,
  TerminalCloseInput,
  TerminalEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalSessionSnapshot,
  TerminalSessionStatus,
  TerminalWriteInput,
} from "@t3tools/contracts";
import { PtyProcess } from "./PTY";
import { Effect, ServiceMap } from "effect";

export interface TerminalSessionState {
  threadId: string;
  terminalId: string;
  cwd: string;
  status: TerminalSessionStatus;
  pid: number | null;
  history: string;
  exitCode: number | null;
  exitSignal: number | null;
  updatedAt: string;
  cols: number;
  rows: number;
  process: PtyProcess | null;
  unsubscribeData: (() => void) | null;
  unsubscribeExit: (() => void) | null;
  hasRunningSubprocess: boolean;
  runtimeEnv: Record<string, string> | null;
}

export interface ShellCandidate {
  shell: string;
  args?: string[];
}

export interface TerminalStartInput extends TerminalOpenInput {
  cols: number;
  rows: number;
}

/**
 * TerminalManagerShape - Service API for terminal session lifecycle operations.
 */
export interface TerminalManagerShape {
  /**
   * Open or attach to a terminal session.
   *
   * Reuses an existing session for the same thread/terminal id and restores
   * persisted history on first open.
   */
  readonly open: (input: TerminalOpenInput) => Effect.Effect<TerminalSessionSnapshot, unknown>;

  /**
   * Write input bytes to a terminal session.
   */
  readonly write: (input: TerminalWriteInput) => Effect.Effect<void, unknown>;

  /**
   * Resize the PTY backing a terminal session.
   */
  readonly resize: (input: TerminalResizeInput) => Effect.Effect<void, unknown>;

  /**
   * Clear terminal output history.
   */
  readonly clear: (input: TerminalClearInput) => Effect.Effect<void, unknown>;

  /**
   * Restart a terminal session in place.
   *
   * Always resets history before spawning the new process.
   */
  readonly restart: (input: TerminalOpenInput) => Effect.Effect<TerminalSessionSnapshot, unknown>;

  /**
   * Close an active terminal session.
   *
   * When `terminalId` is omitted, closes all sessions for the thread.
   */
  readonly close: (input: TerminalCloseInput) => Effect.Effect<void, unknown>;

  /**
   * Subscribe to terminal runtime events.
   */
  readonly subscribe: (listener: (event: TerminalEvent) => void) => Effect.Effect<() => void>;

  /**
   * Dispose all managed terminal resources.
   */
  readonly dispose: () => Effect.Effect<void>;
}

/**
 * TerminalManager - Service tag for terminal session orchestration.
 */
export class TerminalManager extends ServiceMap.Service<TerminalManager, TerminalManagerShape>()(
  "terminal/TerminalManager",
) {}
