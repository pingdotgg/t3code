/**
 * CloudTerminalConnector — the optional adapter capability for attaching an
 * interactive shell running INSIDE a provider's remote compute (not the local
 * machine). Only cloud providers implement it; the generic
 * `ProviderAdapterShape` carries it as an optional field so the terminal
 * router can ask "does this thread's provider offer a remote shell?".
 *
 * The contract is deliberately neutral (no provider-specific types leak into
 * the generic adapter shape): the connector opens a scoped, bidirectional
 * byte pipe to one remote PTY session and reports output/close through
 * callbacks. Provider-specific failures are mapped into the generic error
 * union below at the implementation boundary.
 *
 * @module provider/CloudTerminalConnector
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

/** The remote compute has no attachable session (e.g. torn down / never started). */
export class CloudTerminalUnavailableError extends Schema.TaggedErrorClass<CloudTerminalUnavailableError>()(
  "CloudTerminalUnavailableError",
  {
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `Cloud terminal is unavailable: ${this.reason}`;
  }
}

/** The connect handshake or socket upgrade to the remote PTY failed. */
export class CloudTerminalTransportError extends Schema.TaggedErrorClass<CloudTerminalTransportError>()(
  "CloudTerminalTransportError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Cloud terminal transport failed: ${this.detail}`;
  }
}

/** Writing to / resizing an attached session failed (usually a dropped socket). */
export class CloudTerminalWriteError extends Schema.TaggedErrorClass<CloudTerminalWriteError>()(
  "CloudTerminalWriteError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Cloud terminal write failed: ${this.detail}`;
  }
}

export type CloudTerminalConnectError = CloudTerminalUnavailableError | CloudTerminalTransportError;

/** A live handle to one attached remote PTY session; closed by its Scope. */
export interface CloudTerminalConnection {
  readonly write: (data: string) => Effect.Effect<void, CloudTerminalWriteError>;
  readonly resize: (cols: number, rows: number) => Effect.Effect<void, CloudTerminalWriteError>;
}

export interface CloudTerminalConnector {
  /**
   * Open a scoped connection to one remote PTY session. The session lives for
   * the duration of the caller's Scope — closing the Scope tears down the
   * remote shell and the socket. `onOutput` receives shell bytes; `onClosed`
   * fires exactly once when the shell exits or the socket drops.
   */
  readonly openConnection: (input: {
    /** The provider's opaque remote task/session reference for the thread. */
    readonly taskId: string;
    /** Client-chosen id, unique per remote PTY session on the connection. */
    readonly sessionId: string;
    readonly cols: number;
    readonly rows: number;
    readonly onOutput: (data: string) => void;
    readonly onClosed: (reason: string) => void;
  }) => Effect.Effect<CloudTerminalConnection, CloudTerminalConnectError, Scope.Scope>;
}
