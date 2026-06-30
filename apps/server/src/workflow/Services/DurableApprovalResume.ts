import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { WorkflowEventStoreError } from "./Errors.ts";

export interface DurableApprovalResumeShape {
  readonly resume: () => Effect.Effect<void, WorkflowEventStoreError>;
}

export class DurableApprovalResume extends Context.Service<
  DurableApprovalResume,
  DurableApprovalResumeShape
>()("t3/workflow/Services/DurableApprovalResume") {}
