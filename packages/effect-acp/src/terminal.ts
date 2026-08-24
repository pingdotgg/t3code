import type * as AcpSchema from "./_generated/schema.gen.ts";

/** Display state for an ACP v2 agent-owned terminal. */
export interface AcpTerminal {
  readonly terminalId: AcpSchema.TerminalId;
  readonly command?: string | null;
  readonly cwd?: AcpSchema.AbsolutePath | null;
  readonly output?: AcpSchema.TerminalOutput | null;
  readonly exitStatus?: AcpSchema.TerminalExitStatus | null;
}
