import type { StepRunId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { WorkflowEventStoreError } from "./Errors.ts";

export interface ScriptCancelHandle {
  readonly scriptThreadId: ThreadId;
  readonly terminalId: string;
}

export interface ScriptCancelRegistryShape {
  readonly register: (stepRunId: StepRunId, handle: ScriptCancelHandle) => Effect.Effect<void>;
  readonly unregister: (stepRunId: StepRunId) => Effect.Effect<void>;
  readonly cancel: (stepRunId: StepRunId) => Effect.Effect<void, WorkflowEventStoreError>;
}

export class ScriptCancelRegistry extends Context.Service<
  ScriptCancelRegistry,
  ScriptCancelRegistryShape
>()("t3/workflow/Services/ScriptCancelRegistry") {}
