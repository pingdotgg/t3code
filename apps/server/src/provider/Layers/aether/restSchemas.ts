/**
 * Aether REST wire schemas — parse-at-boundary shapes for the Aether task
 * API consumed by the AetherDriver's REST client.
 *
 * Every schema here is deliberately LOOSE (plain `Schema.Struct`, never
 * strict): the Aether server emits strict shapes, but this CLIENT must
 * tolerate additive fields from newer servers — cross-version skew is the
 * steady state for a vendored-contract client. Open-ended server enums
 * (delivery status, tool status, seam reason, agent type) decode as plain
 * strings for the same reason.
 *
 * Wire sources (aether repo, read-only reference):
 *   - task status union: apps/api/apitypes/tasks_read.go (TaskQueuedWire,
 *     TaskProcessingWire, TaskAwaitingInputWire, TaskErroredWire, and the
 *     decode-only TaskUnknownStatusWire forward-compat carrier)
 *   - timeline rows: tasks_read.go TaskTimelineMessage (user | assistant
 *     text | thinking | tool | seam)
 *   - conversation delta/page: tasks_read.go TaskConversationDeltaResponse /
 *     TaskConversationMessagesPageResponse
 *   - projects: apps/api/apitypes/projects.go Project / ProjectListResponse
 *
 * @module provider/Layers/aether/restSchemas
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

// ---------------------------------------------------------------------------
// Task status union
// ---------------------------------------------------------------------------

export const AetherTaskRunContext = Schema.Struct({
  workspace_id: Schema.String,
  started_at: Schema.String,
});
export type AetherTaskRunContext = typeof AetherTaskRunContext.Type;

/**
 * The awaiting_input payload union, discriminated on `kind`. The interactive
 * kinds carry the pending input's `tool_id` (the id the respond verb echoes
 * back) plus a loose `input` payload — parsing that payload into question/plan
 * shapes is the event mapper's job (build item 9), not the REST boundary's.
 *
 * `kind` is a growable server enum (apps/api/task/lifecycle.go
 * ParseAwaitingInputKind), so — like the task status — an unrecognized kind
 * decodes into an explicit `unknown-kind` carrier instead of failing the
 * whole task read.
 */
const AetherAwaitingInputMessage = Schema.Struct({ kind: Schema.Literal("message") });
const AetherAwaitingInputQuestions = Schema.Struct({
  kind: Schema.Literal("questions"),
  tool_id: Schema.String,
  input: Schema.Unknown,
});
const AetherAwaitingInputPlan = Schema.Struct({
  kind: Schema.Literal("plan"),
  tool_id: Schema.String,
  input: Schema.Unknown,
});

/**
 * Forward-compatibility carrier for awaiting-input kinds this build does not
 * recognize (the analogue of AetherTaskUnknownStatus). The raw wire kind is
 * preserved verbatim in `rawKind`. Consumers must treat this variant
 * explicitly (fail loudly / degrade), never as "message".
 */
export interface AetherAwaitingInputUnknownKind {
  readonly kind: "unknown-kind";
  readonly rawKind: string;
}

export type AetherAwaitingInput =
  | typeof AetherAwaitingInputMessage.Type
  | typeof AetherAwaitingInputQuestions.Type
  | typeof AetherAwaitingInputPlan.Type
  | AetherAwaitingInputUnknownKind;

const decodeKindProbe = Schema.decodeUnknownEffect(Schema.Struct({ kind: Schema.String }));
const decodeAwaitingInputMessage = Schema.decodeUnknownEffect(AetherAwaitingInputMessage);
const decodeAwaitingInputQuestions = Schema.decodeUnknownEffect(AetherAwaitingInputQuestions);
const decodeAwaitingInputPlan = Schema.decodeUnknownEffect(AetherAwaitingInputPlan);

/**
 * Decode the kind-discriminated awaiting_input union. Same shape as
 * `decodeAetherTask`: dispatch on the probed kind FIRST so a known kind with
 * a malformed payload fails loudly, and only a genuinely unrecognized kind
 * degrades into the `unknown-kind` carrier.
 */
const decodeAetherAwaitingInput = (
  input: unknown,
): Effect.Effect<AetherAwaitingInput, Schema.SchemaError> =>
  Effect.gen(function* () {
    const probe = yield* decodeKindProbe(input);
    switch (probe.kind) {
      case "message":
        return yield* decodeAwaitingInputMessage(input);
      case "questions":
        return yield* decodeAwaitingInputQuestions(input);
      case "plan":
        return yield* decodeAwaitingInputPlan(input);
      default:
        return { kind: "unknown-kind" as const, rawKind: probe.kind };
    }
  });

/**
 * Status-independent task fields the driver actually consumes. The wire
 * carries far more (usage, PR surfaces, hardware, …) — all tolerated and
 * dropped here until a build item needs them.
 */
const aetherTaskBaseFields = {
  id: Schema.String,
  project_id: Schema.String,
  name: Schema.String,
  agent_type: Schema.String,
  model: Schema.String,
  interaction_mode: Schema.String,
  reasoning_effort: Schema.optional(Schema.NullOr(Schema.String)),
  last_error: Schema.optional(Schema.NullOr(Schema.String)),
  head_branch: Schema.optional(Schema.NullOr(Schema.String)),
  // Live-mutable remotely (Aether web toggles). The model-switch PUT is a
  // FULL settings replace, so the driver reads these back rather than
  // clobbering a remote flip with its create-time `false` (build item 11).
  auto_fix_ci: Schema.Boolean,
  auto_fix_pr_comments: Schema.Boolean,
  auto_rebase: Schema.Boolean,
  latest_sequence: Schema.Number,
} as const;

const AetherTaskBase = Schema.Struct(aetherTaskBaseFields);

const AetherTaskQueued = Schema.Struct({
  ...aetherTaskBaseFields,
  status: Schema.Literal("queued"),
  run_context: Schema.NullOr(AetherTaskRunContext),
});
export type AetherTaskQueued = typeof AetherTaskQueued.Type;

const AetherTaskProcessing = Schema.Struct({
  ...aetherTaskBaseFields,
  status: Schema.Literal("processing"),
  // Non-null by construction on this variant (tasks_read.go:474-479).
  run_context: AetherTaskRunContext,
});
export type AetherTaskProcessing = typeof AetherTaskProcessing.Type;

// `awaiting_input` decodes in a second pass through
// `decodeAetherAwaitingInput` (the envelope schema cannot express the
// kind-probe dispatch that yields the unknown-kind carrier).
const AetherTaskAwaitingInputEnvelope = Schema.Struct({
  ...aetherTaskBaseFields,
  status: Schema.Literal("awaiting_input"),
  // Nullable: a message-kind awaiting_input task can lack an execution
  // context when every queued message was cancelled before workspace
  // assignment (tasks_read.go:483-489).
  run_context: Schema.NullOr(AetherTaskRunContext),
  awaiting_input: Schema.Unknown,
});
export type AetherTaskAwaitingInput = Omit<
  typeof AetherTaskAwaitingInputEnvelope.Type,
  "awaiting_input"
> & { readonly awaiting_input: AetherAwaitingInput };

const AetherTaskErrored = Schema.Struct({
  ...aetherTaskBaseFields,
  status: Schema.Literal("errored"),
  run_context: Schema.NullOr(AetherTaskRunContext),
  error: Schema.String,
  completed_at: Schema.String,
});
export type AetherTaskErrored = typeof AetherTaskErrored.Type;

/**
 * Forward-compatibility carrier for statuses this build does not recognize
 * (mirrors TaskUnknownStatusWire, tasks_read.go:510-521). The literal
 * `"unknown-status"` tag keeps the union cleanly discriminated in TS — the
 * raw wire status is preserved verbatim in `rawStatus`. Consumers must treat
 * this variant explicitly (fail loudly / degrade), never as "pending".
 */
export type AetherTaskUnknownStatus = typeof AetherTaskBase.Type & {
  readonly status: "unknown-status";
  readonly rawStatus: string;
};

export type AetherTask =
  | AetherTaskQueued
  | AetherTaskProcessing
  | AetherTaskAwaitingInput
  | AetherTaskErrored
  | AetherTaskUnknownStatus;

const decodeStatusProbe = Schema.decodeUnknownEffect(Schema.Struct({ status: Schema.String }));
const decodeQueued = Schema.decodeUnknownEffect(AetherTaskQueued);
const decodeProcessing = Schema.decodeUnknownEffect(AetherTaskProcessing);
const decodeAwaitingInputEnvelope = Schema.decodeUnknownEffect(AetherTaskAwaitingInputEnvelope);
const decodeErrored = Schema.decodeUnknownEffect(AetherTaskErrored);
const decodeBase = Schema.decodeUnknownEffect(AetherTaskBase);

/**
 * Decode the status-discriminated task union. Dispatching on the probed
 * status FIRST (instead of a schema union with a catch-all member) keeps the
 * failure mode honest: a known status with a malformed payload fails the
 * decode loudly instead of silently degrading into the unknown-status
 * carrier. Only a genuinely unrecognized status lands there.
 */
export const decodeAetherTask = (input: unknown): Effect.Effect<AetherTask, Schema.SchemaError> =>
  Effect.gen(function* () {
    const probe = yield* decodeStatusProbe(input);
    switch (probe.status) {
      case "queued":
        return yield* decodeQueued(input);
      case "processing":
        return yield* decodeProcessing(input);
      case "awaiting_input": {
        const envelope = yield* decodeAwaitingInputEnvelope(input);
        const awaitingInput = yield* decodeAetherAwaitingInput(envelope.awaiting_input);
        return { ...envelope, awaiting_input: awaitingInput };
      }
      case "errored":
        return yield* decodeErrored(input);
      default: {
        const base = yield* decodeBase(input);
        return { ...base, status: "unknown-status" as const, rawStatus: probe.status };
      }
    }
  });

// ---------------------------------------------------------------------------
// Conversation timeline rows
// ---------------------------------------------------------------------------

/**
 * A tool card row's payload. `input` is the opaque tool input map;
 * `display.label` is the server-rendered card label; `itemType` is the
 * Aether canonical item type (classified into t3's 7-value union via the
 * vendored `toolLifecycleItemTypeFromAether`).
 */
export const AetherTimelineTool = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  input: Schema.Record(Schema.String, Schema.Unknown),
  status: Schema.String,
  itemType: Schema.optional(Schema.String),
  provider: Schema.optional(Schema.String),
  display: Schema.Struct({ label: Schema.String }),
  result: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
});
export type AetherTimelineTool = typeof AetherTimelineTool.Type;

const AetherUserMessage = Schema.Struct({
  id: Schema.String,
  role: Schema.Literal("user"),
  content: Schema.String,
  deliveryStatus: Schema.String,
  processingStartedAt: Schema.optional(Schema.String),
  clientMessageId: Schema.optional(Schema.String),
  toolResponse: Schema.optional(Schema.Unknown),
  messageEvent: Schema.optional(Schema.Unknown),
  timestamp: Schema.String,
  sequence: Schema.Number,
});
export type AetherUserMessage = typeof AetherUserMessage.Type;

const aetherAssistantBaseFields = {
  id: Schema.String,
  role: Schema.Literal("assistant"),
  timestamp: Schema.String,
  sequence: Schema.Number,
} as const;

const AetherAssistantTextMessage = Schema.Struct({
  ...aetherAssistantBaseFields,
  variant: Schema.Literal("text"),
  content: Schema.String,
});
export type AetherAssistantTextMessage = typeof AetherAssistantTextMessage.Type;

const AetherAssistantThinkingMessage = Schema.Struct({
  ...aetherAssistantBaseFields,
  variant: Schema.Literal("thinking"),
  content: Schema.String,
  isStreaming: Schema.Boolean,
  duration: Schema.optional(Schema.Number),
});
export type AetherAssistantThinkingMessage = typeof AetherAssistantThinkingMessage.Type;

const AetherAssistantToolMessage = Schema.Struct({
  ...aetherAssistantBaseFields,
  variant: Schema.Literal("tool"),
  tool: AetherTimelineTool,
});
export type AetherAssistantToolMessage = typeof AetherAssistantToolMessage.Type;

// A seam is a divider, not a message: no content by design. The payload
// shape varies per reason (teleport, compaction, …) — kept loose here.
const AetherSeamMessage = Schema.Struct({
  ...aetherAssistantBaseFields,
  variant: Schema.Literal("seam"),
  seam: Schema.Struct({ reason: Schema.String }),
});
export type AetherSeamMessage = typeof AetherSeamMessage.Type;

export const AetherTimelineMessage = Schema.Union([
  AetherUserMessage,
  AetherAssistantTextMessage,
  AetherAssistantThinkingMessage,
  AetherAssistantToolMessage,
  AetherSeamMessage,
]);
export type AetherTimelineMessage = typeof AetherTimelineMessage.Type;

// ---------------------------------------------------------------------------
// Conversation responses
// ---------------------------------------------------------------------------

export const AetherActiveProcessingTurn = Schema.Struct({
  messageId: Schema.String,
  startedAt: Schema.String,
});
export type AetherActiveProcessingTurn = typeof AetherActiveProcessingTurn.Type;

// `task` decodes in a second pass through `decodeAetherTask` (the envelope
// schema cannot express the status-probe dispatch); `activity` stays opaque
// until the event mapper (build item 6) consumes it.
const aetherConversationBaseFields = {
  task: Schema.Unknown,
  messages: Schema.Array(AetherTimelineMessage),
  activity: Schema.Array(Schema.Unknown),
  activeProcessingTurn: Schema.NullOr(AetherActiveProcessingTurn),
  latestSequence: Schema.Number,
} as const;

export const AetherConversationMessagesPageEnvelope = Schema.Struct({
  ...aetherConversationBaseFields,
  oldestSequenceLoaded: Schema.NullOr(Schema.Number),
  oldestSortTimestampLoaded: Schema.NullOr(Schema.String),
  hasMoreOlder: Schema.Boolean,
});

export const AetherConversationDeltaEnvelope = Schema.Struct({
  ...aetherConversationBaseFields,
  removedMessageIds: Schema.Array(Schema.String),
  truncated: Schema.Boolean,
});

/** Messages page with the task union decoded. */
export type AetherConversationMessagesPage = Omit<
  typeof AetherConversationMessagesPageEnvelope.Type,
  "task"
> & { readonly task: AetherTask };

/** Conversation delta with the task union decoded. */
export type AetherConversationDelta = Omit<typeof AetherConversationDeltaEnvelope.Type, "task"> & {
  readonly task: AetherTask;
};

// ---------------------------------------------------------------------------
// Command responses
// ---------------------------------------------------------------------------

/** 202 body of `POST /tasks` — the server-generated task id and name. */
export const AetherCreateTaskResponse = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
});
export type AetherCreateTaskResponse = typeof AetherCreateTaskResponse.Type;

/**
 * 202 body of `POST /tasks/{id}/respond` — the created user message's id,
 * the same value that appears as `id` on the message's timeline row.
 */
export const AetherRespondToTaskResponse = Schema.Struct({
  message_id: Schema.String,
});
export type AetherRespondToTaskResponse = typeof AetherRespondToTaskResponse.Type;

// ---------------------------------------------------------------------------
// Workspace connect (state-discriminated union + 409 conflict union)
// ---------------------------------------------------------------------------

// `POST /workspaces/{id}/connect` 200 body — a oneOf discriminated on
// `state` (apps/api/apitypes/workspaces.go ConnectWorkspaceResponse):
// `transport` belongs to running, `retry_after_ms` to connecting.
const AetherConnectRunning = Schema.Struct({
  state: Schema.Literal("running"),
  transport: Schema.Struct({
    websocket_path: Schema.String,
    preview_token: Schema.String,
  }),
});
const AetherConnectConnecting = Schema.Struct({
  state: Schema.Literal("connecting"),
  retry_after_ms: Schema.Number,
});

// The three kinds of connect 409, discriminated by what the client should DO
// (apitypes RegisterWorkspaceConnectConflictSchema): `transitional` — ask
// again after retry_after_ms; `startable` — a connect with start=true would
// actually start the workspace; `not_connectable` — nothing the client does
// will change it.
const AetherConnectConflictTransitional = Schema.Struct({
  kind: Schema.Literal("transitional"),
  error: Schema.String,
  retry_after_ms: Schema.Number,
});
const AetherConnectConflictStartable = Schema.Struct({
  kind: Schema.Literal("startable"),
  error: Schema.String,
});
const AetherConnectConflictNotConnectable = Schema.Struct({
  kind: Schema.Literal("not_connectable"),
  error: Schema.String,
  display_state: Schema.String,
});

export type AetherWorkspaceConnectConflict =
  | typeof AetherConnectConflictTransitional.Type
  | typeof AetherConnectConflictStartable.Type
  | typeof AetherConnectConflictNotConnectable.Type;

/**
 * The decoded connect outcome. The 409 conflict union is DATA, not an error:
 * a suspended workspace answering a passive attach is an expected state the
 * caller must branch on (durable-only mode), never an exception path.
 */
export type AetherWorkspaceConnectOutcome =
  | typeof AetherConnectRunning.Type
  | typeof AetherConnectConnecting.Type
  | { readonly state: "conflict"; readonly conflict: AetherWorkspaceConnectConflict };

const decodeStateProbe = Schema.decodeUnknownEffect(Schema.Struct({ state: Schema.String }));
const decodeConnectRunning = Schema.decodeUnknownEffect(AetherConnectRunning);
const decodeConnectConnecting = Schema.decodeUnknownEffect(AetherConnectConnecting);

/** Decode the 200 connect union. An unknown state fails loudly. */
export const decodeAetherConnectResponse = (
  input: unknown,
): Effect.Effect<AetherWorkspaceConnectOutcome, Schema.SchemaError> =>
  Effect.gen(function* () {
    const probe = yield* decodeStateProbe(input);
    switch (probe.state) {
      case "running":
        return yield* decodeConnectRunning(input);
      case "connecting":
        return yield* decodeConnectConnecting(input);
      default:
        // Unlike the growable task-status enum, connect states are the two
        // halves of one handshake — a third one means this client cannot
        // know whether a socket exists, so it must fail, not guess.
        return yield* decodeConnectRunning(input);
    }
  });

const decodeConflictKindProbe = Schema.decodeUnknownEffect(Schema.Struct({ kind: Schema.String }));
const decodeConflictTransitional = Schema.decodeUnknownEffect(AetherConnectConflictTransitional);
const decodeConflictStartable = Schema.decodeUnknownEffect(AetherConnectConflictStartable);
const decodeConflictNotConnectable = Schema.decodeUnknownEffect(
  AetherConnectConflictNotConnectable,
);

/** Decode the 409 conflict union. An unknown kind fails loudly. */
export const decodeAetherConnectConflict = (
  input: unknown,
): Effect.Effect<AetherWorkspaceConnectConflict, Schema.SchemaError> =>
  Effect.gen(function* () {
    const probe = yield* decodeConflictKindProbe(input);
    switch (probe.kind) {
      case "transitional":
        return yield* decodeConflictTransitional(input);
      case "startable":
        return yield* decodeConflictStartable(input);
      case "not_connectable":
        return yield* decodeConflictNotConnectable(input);
      default:
        // The kind IS the client's next move; an unknown one is undecidable.
        return yield* decodeConflictTransitional(input);
    }
  });

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export const AetherProjectTaskDefaults = Schema.Struct({
  agent_type: Schema.String,
  model: Schema.String,
  interaction_mode: Schema.String,
  reasoning_effort: Schema.optional(Schema.NullOr(Schema.String)),
});
export type AetherProjectTaskDefaults = typeof AetherProjectTaskDefaults.Type;

export const AetherProject = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  repo_url: Schema.optional(Schema.NullOr(Schema.String)),
  default_branch: Schema.optional(Schema.NullOr(Schema.String)),
  task_defaults: AetherProjectTaskDefaults,
});
export type AetherProject = typeof AetherProject.Type;

export const AetherProjectListResponse = Schema.Struct({
  projects: Schema.Array(AetherProject),
});
export type AetherProjectListResponse = typeof AetherProjectListResponse.Type;

// ---------------------------------------------------------------------------
// Request bodies (encode side — plain types, huma validates server-side)
// ---------------------------------------------------------------------------

export interface AetherPromptAttachment {
  readonly filename: string;
  readonly mediaType: string;
  readonly data: string;
}

export interface AetherPromptContext {
  readonly files?: ReadonlyArray<{
    readonly path: string;
    readonly include: boolean;
    readonly selection?: { readonly startLine: number; readonly endLine: number };
  }>;
  readonly attachments?: ReadonlyArray<AetherPromptAttachment>;
}

export interface AetherCreateTaskRequest {
  readonly project_id: string;
  readonly prompt: string;
  readonly base_branch?: string;
  readonly context?: AetherPromptContext;
  readonly agent_type: string;
  readonly model: string;
  readonly interaction_mode: string;
  readonly reasoning_effort?: string | null;
  readonly auto_fix_ci: boolean;
  readonly auto_fix_pr_comments: boolean;
  readonly auto_rebase: boolean;
}

/**
 * The tool-response union, discriminated on `tool_name`. The server validates
 * each variant strictly (required fields + additionalProperties:false on
 * `data` — apitypes/tasks.go askUserToolResponseSchema /
 * proposePlanToolResponseSchema), so the encode types mirror the oneOf
 * exactly: an ask_user without `answers`, a propose_plan without `approved`,
 * or a cross-variant field mix is unrepresentable.
 */
export interface AetherAskUserToolResponse {
  readonly tool_name: "ask_user";
  readonly data: {
    readonly answers: Readonly<Record<string, ReadonlyArray<number>>>;
    readonly customAnswers?: Readonly<Record<string, string>>;
  };
}

export interface AetherProposePlanToolResponse {
  readonly tool_name: "propose_plan";
  readonly data: {
    readonly approved: boolean;
    readonly feedback?: string;
  };
}

export type AetherTaskToolResponse = AetherAskUserToolResponse | AetherProposePlanToolResponse;

export interface AetherRespondToTaskRequest {
  readonly message: string;
  readonly context?: AetherPromptContext;
  readonly interaction_mode?: string;
  readonly reasoning_effort?: string;
  readonly tool_response?: AetherTaskToolResponse;
  /** Idempotency key: a retry after a lost 202 resolves to the original row. */
  readonly client_message_id?: string;
}

/**
 * `PUT /tasks/{id}` is a FULL REPLACE: every settings field is required and
 * `reasoning_effort` is required-but-nullable (a null always means an
 * explicit null, unlike create where the field is also optional) —
 * apps/api/apitypes/tasks.go UpdateTaskRequest.
 */
export interface AetherUpdateTaskRequest {
  readonly agent_type: string;
  readonly model: string;
  readonly interaction_mode: string;
  readonly reasoning_effort: string | null;
  readonly auto_fix_ci: boolean;
  readonly auto_fix_pr_comments: boolean;
  readonly auto_rebase: boolean;
}
