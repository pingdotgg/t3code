import { Context, Schema } from "effect";
import type { Effect } from "effect";

function describeTerminalInspectorCause(cause: unknown): string | null {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  if (typeof cause === "string" && cause.length > 0) {
    return cause;
  }
  if (cause === undefined || cause === null) {
    return null;
  }
  return String(cause);
}

export class TerminalProcessInspectionError extends Schema.TaggedErrorClass<TerminalProcessInspectionError>()(
  "TerminalProcessInspectionError",
  {
    operation: Schema.String,
    terminalPid: Schema.Int,
    command: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    const cause = describeTerminalInspectorCause(this.cause);
    return `${this.operation} failed for terminal pid ${this.terminalPid} (${this.command}): ${this.detail}${
      cause ? ` Cause: ${cause}` : ""
    }`;
  }
}

export interface TerminalSubprocessActivity {
  hasRunningSubprocess: boolean;
  runningPorts: number[];
}

export type TerminalSubprocessInspector = (
  terminalPid: number,
) => Effect.Effect<TerminalSubprocessActivity, TerminalProcessInspectionError>;

export interface TerminalProcessInspectorShape {
  readonly inspect: (
    terminalPid: number,
  ) => Effect.Effect<TerminalSubprocessActivity, TerminalProcessInspectionError>;
}

export class TerminalProcessInspector extends Context.Service<
  TerminalProcessInspector,
  TerminalProcessInspectorShape
>()("t3/process/Services/TerminalProcessInspector") {}
