import * as Effect from "effect/Effect";

import type * as AcpSchema from "./_generated/schema.gen.ts";
import type * as AcpError from "./errors.ts";

export interface AcpTerminal {
  readonly sessionId: string;
  readonly terminalId: string;
  /** Reads buffered output from the terminal.
   * Spec: https://agentclientprotocol.com/protocol/schema#terminal/output
   */
  readonly output: Effect.Effect<AcpSchema.TerminalOutputResponse, AcpError.AcpError>;
  /** Waits for terminal exit and returns the exit result.
   * Spec: https://agentclientprotocol.com/protocol/schema#terminal/wait_for_exit
   */
  readonly waitForExit: Effect.Effect<AcpSchema.WaitForTerminalExitResponse, AcpError.AcpError>;
  /** Terminates the terminal process.
   * Spec: https://agentclientprotocol.com/protocol/schema#terminal/kill
   */
  readonly kill: Effect.Effect<AcpSchema.KillTerminalResponse, AcpError.AcpError>;
  /** Releases the terminal handle from the ACP session.
   * Spec: https://agentclientprotocol.com/protocol/schema#terminal/release
   */
  readonly release: Effect.Effect<AcpSchema.ReleaseTerminalResponse, AcpError.AcpError>;
}
