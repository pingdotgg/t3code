import {
  CommandId,
  type ApprovalRequestId,
  type MessageId,
  type ProjectId,
  type ProviderOptionSelections,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import type { AgentsCapability, ProjectionsReadCapability } from "@t3tools/plugin-sdk";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { DispatchId, StepRunId, TicketId } from "../../../contracts/workflow.ts";
import type { WorkflowEventStoreError } from "./Errors.ts";

export interface WorkflowDispatchRequest {
  readonly dispatchId: DispatchId;
  readonly ticketId: TicketId;
  readonly stepRunId: StepRunId;
  readonly threadId: ThreadId;
  readonly providerInstance: string;
  readonly model: string;
  readonly instruction: string;
  readonly worktreePath: string;
  readonly options?: ProviderOptionSelections | undefined;
  readonly projectId?: ProjectId | undefined;
  readonly threadTitle?: string | undefined;
  readonly runtimeMode?: RuntimeMode | undefined;
}

export type WorkflowDispatchTerminalResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error?: string | undefined }
  | {
      readonly ok: false;
      readonly awaitingUser: true;
      readonly waitingReason: string;
      readonly providerThreadId: ThreadId;
      readonly providerRequestId: ApprovalRequestId;
      readonly providerResponseKind: "request" | "user-input";
      readonly providerQuestionId?: string | undefined;
    };

export type WorkflowProviderResponseKind = "request" | "user-input";

export interface WorkflowProviderResponseInput {
  readonly threadId: ThreadId;
  readonly requestId: ApprovalRequestId;
  readonly responseKind: WorkflowProviderResponseKind;
  readonly approved: boolean;
  readonly questionId?: string | undefined;
  readonly text?: string | undefined;
}

export interface WorkflowPendingRequestLiveInput {
  readonly threadId: ThreadId;
  readonly requestId: ApprovalRequestId;
  readonly responseKind: WorkflowProviderResponseKind;
  readonly questionId?: string | undefined;
}

export interface WorkflowAgentPortShape {
  readonly ensureStarted: (
    req: WorkflowDispatchRequest,
  ) => Effect.Effect<{ readonly messageId: MessageId }, WorkflowEventStoreError>;
  readonly awaitTerminal: (
    dispatchId: DispatchId,
    threadId: ThreadId,
  ) => Effect.Effect<WorkflowDispatchTerminalResult, WorkflowEventStoreError>;
  readonly awaitStepTerminal: (
    stepRunId: StepRunId,
    threadId: ThreadId,
  ) => Effect.Effect<WorkflowDispatchTerminalResult, WorkflowEventStoreError>;
  readonly getDispatchForStep: (
    stepRunId: StepRunId,
  ) => Effect.Effect<
    { readonly threadId: ThreadId; readonly messageId: MessageId } | null,
    WorkflowEventStoreError
  >;
  readonly confirmStep: (stepRunId: StepRunId) => Effect.Effect<void, WorkflowEventStoreError>;
  readonly readCapturedOutput: (input: {
    readonly stepRunId: StepRunId;
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
  }) => Effect.Effect<unknown | undefined, WorkflowEventStoreError>;
  readonly respond: (
    input: WorkflowProviderResponseInput,
  ) => Effect.Effect<void, WorkflowEventStoreError>;
  readonly isPendingRequestLive: (
    input: WorkflowPendingRequestLiveInput,
  ) => Effect.Effect<boolean, WorkflowEventStoreError>;
  readonly cleanupSession: (threadId: ThreadId) => Effect.Effect<void>;
  readonly recoverPending: () => Effect.Effect<void, WorkflowEventStoreError>;
}

export class WorkflowAgentsCapability extends Context.Service<
  WorkflowAgentsCapability,
  AgentsCapability
>()(
  "@t3tools/fixture-workflow-boards/server/workflow/Services/WorkflowAgentPort/WorkflowAgentsCapability",
) {}

export class WorkflowProjectionsReadCapability extends Context.Service<
  WorkflowProjectionsReadCapability,
  ProjectionsReadCapability
>()(
  "@t3tools/fixture-workflow-boards/server/workflow/Services/WorkflowAgentPort/WorkflowProjectionsReadCapability",
) {}

export class WorkflowAgentPort extends Context.Service<WorkflowAgentPort, WorkflowAgentPortShape>()(
  "@t3tools/fixture-workflow-boards/server/workflow/Services/WorkflowAgentPort",
) {}

export const workflowDispatchCommandId = (dispatchId: DispatchId): CommandId =>
  CommandId.make(`workflow-agent-dispatch:${String(dispatchId)}`);
