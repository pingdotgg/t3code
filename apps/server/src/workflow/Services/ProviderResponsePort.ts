import type { ApprovalRequestId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { WorkflowEventStoreError } from "./Errors.ts";

export type ProviderResponseKind = "request" | "user-input";

export interface ProviderResponseInput {
  readonly threadId: ThreadId;
  readonly requestId: ApprovalRequestId;
  readonly responseKind: ProviderResponseKind;
  readonly approved: boolean;
  readonly questionId?: string;
  readonly text?: string;
}

export interface ProviderResponsePortShape {
  readonly respond: (input: ProviderResponseInput) => Effect.Effect<void, WorkflowEventStoreError>;
}

export class ProviderResponsePort extends Context.Service<
  ProviderResponsePort,
  ProviderResponsePortShape
>()("t3/workflow/Services/ProviderResponsePort") {}
