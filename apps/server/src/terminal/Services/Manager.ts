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
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "@t3tools/contracts";
import { Effect, Schema, ServiceMap } from "effect";

export class TerminalCwdError extends Schema.TaggedErrorClass<TerminalCwdError>()(
  "TerminalCwdError",
  {
    cwd: Schema.String,
    reason: Schema.Literals(["notFound", "notDirectory", "statFailed"]),
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message() {
    if (this.reason === "notDirectory") {
      return `Terminal cwd is not a directory: ${this.cwd}`;
    }
    if (this.reason === "notFound") {
      return `Terminal cwd does not exist: ${this.cwd}`;
    }
    const causeMessage =
      this.cause && typeof this.cause === "object" && "message" in this.cause
        ? this.cause.message
        : undefined;
    return causeMessage
      ? `Failed to access terminal cwd: ${this.cwd} (${causeMessage})`
      : `Failed to access terminal cwd: ${this.cwd}`;
  }
}

export class TerminalHistoryError extends Schema.TaggedErrorClass<TerminalHistoryError>()(
  "TerminalHistoryError",
  {
    operation: Schema.Literals(["read", "truncate", "migrate"]),
    threadId: Schema.String,
    terminalId: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message() {
    return `Failed to ${this.operation} terminal history for thread: ${this.threadId}, terminal: ${this.terminalId}`;
  }
}

export class TerminalSessionLookupError extends Schema.TaggedErrorClass<TerminalSessionLookupError>()(
  "TerminalSessionLookupError",
  {
    threadId: Schema.String,
    terminalId: Schema.String,
  },
) {
  override get message() {
    return `Unknown terminal thread: ${this.threadId}, terminal: ${this.terminalId}`;
  }
}

export class TerminalNotRunningError extends Schema.TaggedErrorClass<TerminalNotRunningError>()(
  "TerminalNotRunningError",
  {
    threadId: Schema.String,
    terminalId: Schema.String,
  },
) {
  override get message() {
    return `Terminal is not running for thread: ${this.threadId}, terminal: ${this.terminalId}`;
  }
}

export const TerminalError = Schema.Union([
  TerminalCwdError,
  TerminalHistoryError,
  TerminalSessionLookupError,
  TerminalNotRunningError,
]);
export type TerminalError = typeof TerminalError.Type;

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
  readonly open: (
    input: TerminalOpenInput,
  ) => Effect.Effect<TerminalSessionSnapshot, TerminalError>;

  /**
   * Write input bytes to a terminal session.
   */
  readonly write: (input: TerminalWriteInput) => Effect.Effect<void, TerminalError>;

  /**
   * Resize the PTY backing a terminal session.
   */
  readonly resize: (input: TerminalResizeInput) => Effect.Effect<void, TerminalError>;

  /**
   * Clear terminal output history.
   */
  readonly clear: (input: TerminalClearInput) => Effect.Effect<void, TerminalError>;

  /**
   * Restart a terminal session in place.
   *
   * Always resets history before spawning the new process.
   */
  readonly restart: (
    input: TerminalRestartInput,
  ) => Effect.Effect<TerminalSessionSnapshot, TerminalError>;

  /**
   * Close an active terminal session.
   *
   * When `terminalId` is omitted, closes all sessions for the thread.
   */
  readonly close: (input: TerminalCloseInput) => Effect.Effect<void, TerminalError>;

  /**
   * Subscribe to terminal runtime events with a direct callback.
   *
   * Returns an unsubscribe function.
   */
  readonly subscribe: (
    listener: (event: TerminalEvent) => Effect.Effect<void>,
  ) => Effect.Effect<() => void>;
}

/**
 * TerminalManager - Service tag for terminal session orchestration.
 */
export class TerminalManager extends ServiceMap.Service<TerminalManager, TerminalManagerShape>()(
  "t3/terminal/Services/Manager/TerminalManager",
) {}
