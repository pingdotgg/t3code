/**
 * The part of the Orchestrator V2 MCP contract (#2829) that runs on the
 * current orchestration engine: `create_threads` and `orchestrator_capabilities`.
 * Names and shapes match V2, so an agent sees one contract before and after
 * V2 lands. V2 replaces this file with its full version.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  ProviderOptionDescriptor,
  ProviderOptionSelection,
  ProviderOptionSelectionValue,
} from "./model.ts";
import { ProviderInteractionMode, RuntimeMode } from "./orchestration.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

const OrchestratorMcpPrompt = TrimmedNonEmptyString.check(Schema.isMaxLength(120_000)).annotate({
  description: "Complete task or message text for the target agent.",
});
const OrchestratorMcpTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(512)).annotate({
  description: "Optional concise display title.",
});
const OrchestratorMcpClientRequestId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(256),
).annotate({ description: "Stable idempotency key to reuse when retrying this mutation." });

/**
 * Shorthand `{ id: value }` record form for target model options. Unlike the
 * legacy-tolerant `ProviderOptionSelections` persistence schema, this decodes
 * strictly: a value that is not a string or boolean fails the request rather
 * than being silently dropped.
 */
const OrchestratorMcpTargetOptionsFromRecord = Schema.Record(
  Schema.String,
  ProviderOptionSelectionValue,
).pipe(
  Schema.decodeTo(
    Schema.Array(ProviderOptionSelection),
    SchemaTransformation.transformEffect({
      decode: (record) =>
        Effect.succeed(Object.entries(record).map(([id, value]) => ({ id, value }))),
      encode: (selections: ReadonlyArray<ProviderOptionSelection>) =>
        Effect.succeed(
          Object.fromEntries(selections.map((selection) => [selection.id, selection.value])),
        ),
    }),
  ),
);

const OrchestratorMcpTargetOptions = Schema.Union([
  Schema.Array(ProviderOptionSelection),
  OrchestratorMcpTargetOptionsFromRecord,
]);

const OrchestratorMcpTarget = Schema.Struct({
  providerInstanceId: Schema.optional(
    ProviderInstanceId.annotate({
      description: "Configured provider instance id from orchestrator_capabilities.",
    }),
  ),
  driverKind: Schema.optional(
    ProviderDriverKind.annotate({
      description: "Provider driver kind; prefer providerInstanceId when available.",
    }),
  ),
  model: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Model id advertised for the selected provider instance.",
    }),
  ),
  /**
   * Model option selections for the new thread (for example reasoning
   * effort). Accepts the canonical `[{ id, value }]` array or the shorthand
   * `{ id: value }` record; valid ids come from the option descriptors
   * advertised by orchestrator_capabilities. When omitted, options inherit
   * from the parent only when the new thread runs the parent's provider and model.
   */
  options: Schema.optional(
    OrchestratorMcpTargetOptions.annotate({
      description: "Model option selections advertised by orchestrator_capabilities.",
    }),
  ),
});
export type OrchestratorMcpTarget = typeof OrchestratorMcpTarget.Type;

const OrchestratorMcpRuntimeMode = Schema.Union([Schema.Literal("inherit"), RuntimeMode]);
export type OrchestratorMcpRuntimeMode = typeof OrchestratorMcpRuntimeMode.Type;

const OrchestratorMcpInteractionMode = Schema.Union([
  Schema.Literal("inherit"),
  ProviderInteractionMode,
]);
export type OrchestratorMcpInteractionMode = typeof OrchestratorMcpInteractionMode.Type;

const OrchestratorMcpCreateThreadRequest = Schema.Struct({
  prompt: Schema.optional(OrchestratorMcpPrompt),
  title: Schema.optional(OrchestratorMcpTitle),
  target: Schema.optional(OrchestratorMcpTarget),
  runtimeMode: Schema.optional(OrchestratorMcpRuntimeMode),
  interactionMode: Schema.optional(OrchestratorMcpInteractionMode),
});

export const ORCHESTRATOR_MCP_MAX_BATCH_THREADS = 20;

export const OrchestratorMcpCreateThreadsInput = Schema.Struct({
  threads: Schema.Array(OrchestratorMcpCreateThreadRequest).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(ORCHESTRATOR_MCP_MAX_BATCH_THREADS),
  ),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
});
export type OrchestratorMcpCreateThreadsInput = typeof OrchestratorMcpCreateThreadsInput.Type;

/** A subset of V2's status union: this engine has no runs, queues, or rollbacks. */
const OrchestratorMcpCreatedThreadStatus = Schema.Literals([
  "idle",
  "starting",
  "running",
  "completed",
  "failed",
  "interrupted",
]);
export type OrchestratorMcpCreatedThreadStatus = typeof OrchestratorMcpCreatedThreadStatus.Type;

const OrchestratorMcpCreatedThread = Schema.Struct({
  threadId: ThreadId,
  status: OrchestratorMcpCreatedThreadStatus,
  title: Schema.String,
  providerInstanceId: ProviderInstanceId,
  model: Schema.String,
});
export type OrchestratorMcpCreatedThread = typeof OrchestratorMcpCreatedThread.Type;

export const OrchestratorMcpCreateThreadsResult = Schema.Struct({
  threads: Schema.Array(OrchestratorMcpCreatedThread),
});
export type OrchestratorMcpCreateThreadsResult = typeof OrchestratorMcpCreateThreadsResult.Type;

const OrchestratorMcpProviderCapability = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  driverKind: ProviderDriverKind,
  displayName: Schema.NullOr(Schema.String),
  models: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      label: Schema.NullOr(Schema.String),
      /** Model options a target may select (for example reasoning effort). */
      options: Schema.optional(Schema.Array(ProviderOptionDescriptor)),
    }),
  ),
  canRunChildTask: Schema.Boolean,
  canRunCrossProviderChildTask: Schema.Boolean,
  constraints: Schema.Array(Schema.String),
});

export const OrchestratorMcpCapabilitiesResult = Schema.Struct({
  parentThreadId: ThreadId,
  inheritedProviderInstanceId: ProviderInstanceId,
  inheritedModel: Schema.String,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  providers: Schema.Array(OrchestratorMcpProviderCapability),
  features: Schema.Struct({
    appOwnedSubagents: Schema.Boolean,
    asyncPolling: Schema.Boolean,
    cancellation: Schema.Boolean,
    batchThreadCreation: Schema.Boolean,
    threadManagement: Schema.Boolean,
    incrementalThreadRead: Schema.Boolean,
    scheduledTasks: Schema.Boolean,
    maxBatchThreads: Schema.Number,
  }),
});
export type OrchestratorMcpCapabilitiesResult = typeof OrchestratorMcpCapabilitiesResult.Type;

export class OrchestratorMcpFailure extends Schema.TaggedError<OrchestratorMcpFailure>()(
  "OrchestratorMcpFailure",
  {
    code: Schema.Literals([
      "capability_denied",
      "provider_unavailable",
      "model_unavailable",
      "runtime_mode_escalation_denied",
      "interaction_mode_escalation_denied",
      "thread_not_found",
      "invalid_request",
      "orchestration_error",
    ]),
    message: Schema.String,
  },
) {}
