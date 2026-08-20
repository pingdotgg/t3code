import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  ProgramAttemptId,
  ProgramAttemptRequestId,
  ProjectId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import {
  OrchestrationV2ProviderFailure,
  OrchestrationV2RunStatus,
  PreparedWorktreeCheckout,
} from "./orchestrationV2.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

export const ProgramAttemptProviderPolicy = Schema.Struct({
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
});
export type ProgramAttemptProviderPolicy = typeof ProgramAttemptProviderPolicy.Type;

export const ProgramAttemptLaunchInput = Schema.Struct({
  attemptId: ProgramAttemptId,
  requestId: ProgramAttemptRequestId,
  programId: Schema.optional(TrimmedNonEmptyString),
  taskId: Schema.optional(TrimmedNonEmptyString),
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  checkout: PreparedWorktreeCheckout,
  providerPolicy: ProgramAttemptProviderPolicy,
});
export type ProgramAttemptLaunchInput = typeof ProgramAttemptLaunchInput.Type;

export const ProgramAttemptIdentityInput = Schema.Struct({
  attemptId: ProgramAttemptId,
});
export type ProgramAttemptIdentityInput = typeof ProgramAttemptIdentityInput.Type;

export const ProgramAttemptThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type ProgramAttemptThreadInput = typeof ProgramAttemptThreadInput.Type;

export const ProgramAttemptEffectInput = Schema.Struct({
  attemptId: ProgramAttemptId,
  requestId: ProgramAttemptRequestId,
});
export type ProgramAttemptEffectInput = typeof ProgramAttemptEffectInput.Type;

export const ProgramAttemptCancelInput = Schema.Struct({
  ...ProgramAttemptEffectInput.fields,
  reason: Schema.optional(TrimmedNonEmptyString),
});
export type ProgramAttemptCancelInput = typeof ProgramAttemptCancelInput.Type;

export const ProgramAttemptTerminalResult = Schema.Struct({
  status: Schema.Literals(["completed", "interrupted", "failed", "cancelled", "rolled_back"]),
  output: Schema.NullOr(Schema.String),
  failure: Schema.NullOr(OrchestrationV2ProviderFailure),
  completedAt: Schema.NullOr(IsoDateTime),
});
export type ProgramAttemptTerminalResult = typeof ProgramAttemptTerminalResult.Type;

export const ProgramAttemptSnapshot = Schema.Struct({
  attemptId: ProgramAttemptId,
  programId: Schema.NullOr(TrimmedNonEmptyString),
  taskId: Schema.NullOr(TrimmedNonEmptyString),
  title: TrimmedNonEmptyString,
  checkout: PreparedWorktreeCheckout,
  projectId: ProjectId,
  threadId: ThreadId,
  runId: RunId,
  state: Schema.Literals(["preparing", "active", "terminal"]),
  runStatus: OrchestrationV2RunStatus,
  terminalResult: Schema.NullOr(ProgramAttemptTerminalResult),
  terminalAcknowledged: Schema.Boolean,
});
export type ProgramAttemptSnapshot = typeof ProgramAttemptSnapshot.Type;
