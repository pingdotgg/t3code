import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import type * as Effect from "effect/Effect";

import type { WorkflowEventStoreError } from "./Errors.ts";

export type ScriptCommandOutcome = "exited" | "timeout" | "cancelled";

export interface ScriptCommandRunInput {
  readonly scriptThreadId: ThreadId;
  readonly terminalId: string;
  readonly cwd: string;
  readonly run: string;
  readonly timeout: Duration.Input;
}

export interface ScriptCommandResult {
  readonly exitCode: number | null;
  readonly signal: number | null;
  readonly outcome: ScriptCommandOutcome;
}

export interface ScriptCommandRunnerShape {
  readonly run: (
    input: ScriptCommandRunInput,
  ) => Effect.Effect<ScriptCommandResult, WorkflowEventStoreError>;
}

export class ScriptCommandRunner extends Context.Service<
  ScriptCommandRunner,
  ScriptCommandRunnerShape
>()("t3/workflow/Services/ScriptCommandRunner") {}
