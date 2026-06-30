import type { ThreadId, WorkflowStepUsage } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface StepUsageReaderShape {
  /**
   * Latest token-usage snapshot for a workflow dispatch thread, mapped to the
   * workflow usage shape. Undefined when the provider emitted no usage.
   * Never fails — usage is best-effort telemetry.
   */
  readonly read: (threadId: ThreadId) => Effect.Effect<WorkflowStepUsage | undefined>;
}

export class StepUsageReader extends Context.Service<StepUsageReader, StepUsageReaderShape>()(
  "t3/workflow/Services/StepUsageReader",
) {}
