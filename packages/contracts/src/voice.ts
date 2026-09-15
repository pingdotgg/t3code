import * as Schema from "effect/Schema";

import {
  CommandId,
  EnvironmentId,
  MessageId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
  TurnId,
} from "./baseSchemas.ts";
import { EnvironmentConnectionState, ThreadEnvMode } from "./environment.ts";
import { ModelSelection, OrchestrationSessionStatus } from "./orchestration.ts";
import { ServerProviderAvailability } from "./server.ts";

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

const makeVoiceId = <Brand extends string>(brand: Brand) =>
  TrimmedNonEmptyString.pipe(Schema.brand(brand));

/** Client-generated stable id for one voice-driven mutation request. Retries
    of the same intent reuse it; a changed destination gets a new one. T5
    derives command/thread/message ids deterministically from it. */
export const VoiceRequestId = makeVoiceId("VoiceRequestId");
export type VoiceRequestId = typeof VoiceRequestId.Type;

/** Live session id returned by the broker after the SDP exchange. The broker
    retains it for lifecycle, usage, and close accounting; clients treat it as
    an opaque handle. */
export const VoiceSessionId = makeVoiceId("VoiceSessionId");
export type VoiceSessionId = typeof VoiceSessionId.Type;

// ---------------------------------------------------------------------------
// Shared status and error shapes
// ---------------------------------------------------------------------------

/** Per-environment outcome status on every multi-environment result.
    `partial` means the environment answered some sub-operations but not all.
    A disconnected or errored environment is reported as such; it is never
    reported as "no matches". */
export const VoiceEnvironmentStatus = Schema.Literals(["ok", "disconnected", "error", "partial"]);
export type VoiceEnvironmentStatus = typeof VoiceEnvironmentStatus.Type;

export const VoiceToolErrorCode = Schema.Literals([
  // Session or token lacks a required scope (e.g. broker start without
  // orchestration:operate, or a read-only session attempting a mutation).
  "insufficient_scope",
  // Credentials invalid, expired, or revoked. Next call after revocation.
  "auth_invalid",
  // Environment is in the catalog but not currently reachable.
  "environment_unreachable",
  // Environment id has no entry in the client's local catalog.
  "environment_not_in_catalog",
  // Server-side project existence invariant failed (fabricated project id).
  "project_not_found",
  // Thread does not exist (or disappeared before open/read).
  "thread_not_found",
  // Requested provider instance is disabled/unavailable or model slug is not
  // in that instance's current catalog.
  "model_unavailable",
  // Query outside 2-200 characters or otherwise unusable as a search term.
  "query_invalid",
  // Multi-environment operation where at least one environment failed; the
  // per-environment results are still delivered alongside this code.
  "partial_failure",
  // Malformed input that no other code describes.
  "invalid_request",
]);
export type VoiceToolErrorCode = typeof VoiceToolErrorCode.Type;

/** The single error shape every voice tool may fail with. Tagged by `code`.
    Identity fields are populated when they identify the failing subject. */
export const VoiceToolError = Schema.Struct({
  code: VoiceToolErrorCode,
  message: TrimmedString,
  environmentId: Schema.optional(EnvironmentId),
  projectId: Schema.optional(ProjectId),
  threadId: Schema.optional(ThreadId),
  /** Model slug or provider instance id that failed validation. */
  model: Schema.optional(TrimmedString),
});
export type VoiceToolError = typeof VoiceToolError.Type;

/** One environment's slice of a multi-environment result. `error` is present
    whenever status is not "ok". */
export const VoiceEnvironmentOutcome = Schema.Struct({
  environmentId: EnvironmentId,
  status: VoiceEnvironmentStatus,
  error: Schema.optional(VoiceToolError),
});
export type VoiceEnvironmentOutcome = typeof VoiceEnvironmentOutcome.Type;

// ---------------------------------------------------------------------------
// Tool 1: voice.discoverEnvironments
// ---------------------------------------------------------------------------

export const VoiceDiscoveredEnvironment = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  connectionState: EnvironmentConnectionState,
  /** True when this is the client's primary environment. */
  isPrimary: Schema.Boolean,
  /** The environment descriptor advertised the `voiceLive` capability. */
  voiceLiveCapable: Schema.Boolean,
  /** Scopes this client's session holds on that environment (subset of
      AuthEnvironmentScope; determines what tools may do there). */
  scopes: Schema.Array(TrimmedString),
});
export type VoiceDiscoveredEnvironment = typeof VoiceDiscoveredEnvironment.Type;

export const VoiceDiscoverEnvironmentsInput = Schema.Struct({});
export type VoiceDiscoverEnvironmentsInput = typeof VoiceDiscoverEnvironmentsInput.Type;

export const VoiceDiscoverEnvironmentsOutput = Schema.Struct({
  environments: Schema.Array(VoiceDiscoveredEnvironment),
});
export type VoiceDiscoverEnvironmentsOutput = typeof VoiceDiscoverEnvironmentsOutput.Type;

// ---------------------------------------------------------------------------
// Tool 2: voice.discoverProjects
// ---------------------------------------------------------------------------

export const VoiceProjectSummary = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  defaultModelSelection: Schema.NullOr(ModelSelection),
  defaultThreadEnvMode: ThreadEnvMode,
});
export type VoiceProjectSummary = typeof VoiceProjectSummary.Type;

export const VoiceDiscoverProjectsInput = Schema.Struct({
  environmentId: EnvironmentId,
});
export type VoiceDiscoverProjectsInput = typeof VoiceDiscoverProjectsInput.Type;

export const VoiceDiscoverProjectsOutput = Schema.Struct({
  environment: VoiceEnvironmentOutcome,
  projects: Schema.Array(VoiceProjectSummary),
});
export type VoiceDiscoverProjectsOutput = typeof VoiceDiscoverProjectsOutput.Type;

// ---------------------------------------------------------------------------
// Tool 3: voice.listModels
// ---------------------------------------------------------------------------

export const VoiceModelOption = Schema.Struct({
  slug: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  isCustom: Schema.Boolean,
  isDefault: Schema.optional(Schema.Boolean),
});
export type VoiceModelOption = typeof VoiceModelOption.Type;

export const VoiceProviderSummary = Schema.Struct({
  instanceId: TrimmedNonEmptyString,
  driver: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  availability: ServerProviderAvailability,
  models: Schema.Array(VoiceModelOption),
});
export type VoiceProviderSummary = typeof VoiceProviderSummary.Type;

export const VoiceListModelsInput = Schema.Struct({
  environmentId: EnvironmentId,
});
export type VoiceListModelsInput = typeof VoiceListModelsInput.Type;

/** Only enabled, not-unavailable providers with their model options are
    returned; disabled or unavailable instances appear as errors, never as
    selectable options. */
export const VoiceListModelsOutput = Schema.Struct({
  environment: VoiceEnvironmentOutcome,
  providers: Schema.Array(VoiceProviderSummary),
});
export type VoiceListModelsOutput = typeof VoiceListModelsOutput.Type;

// ---------------------------------------------------------------------------
// Tool 4: voice.searchThreads
// ---------------------------------------------------------------------------

export const VoiceThreadSearchSource = Schema.Literals(["title", "message"]);
export type VoiceThreadSearchSource = typeof VoiceThreadSearchSource.Type;

export const VoiceThreadSearchMatch = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  /** Current thread title from the shell snapshot. */
  threadTitle: TrimmedString,
  /** How this match was found. A thread may appear once per source; the
      caller unions and dedupes by thread id. */
  source: VoiceThreadSearchSource,
  /** Message excerpt, at most 240 characters. Absent for title matches. */
  snippet: Schema.optional(Schema.String),
  messageCreatedAt: Schema.optional(Schema.String),
  updatedAt: Schema.optional(Schema.String),
  /** Client-side rank inputs, computed in the tool executor. 0..1 fraction of
      query terms found for this thread. No server ranking exists. */
  termCoverage: Schema.optional(Schema.Number),
  /** True when one or more query terms matched the title. */
  titleMatch: Schema.optional(Schema.Boolean),
  /** True when the match came from the archived shell snapshot. Archived
      message search is not available on this base. */
  archived: Schema.optional(Schema.Boolean),
});
export type VoiceThreadSearchMatch = typeof VoiceThreadSearchMatch.Type;

export const VoiceSearchThreadsInput = Schema.Struct({
  /** The spoken query phrase, trimmed. 2-200 characters. The tool executor
      splits it into distinctive terms client-side (at most four by default)
      and unions one bounded server search per term; this input stays the
      whole phrase. */
  query: TrimmedString.check(Schema.isMinLength(2), Schema.isMaxLength(200)),
  /** Restrict the search to these catalog environments. Absent searches all
      connected environments in the catalog. */
  environmentIds: Schema.optional(Schema.Array(EnvironmentId)),
  /** Default excludes archived threads. On request, archived shell titles are
      matched; archived message search has no server endpoint, so archived
      results are title-only. */
  includeArchived: Schema.optional(Schema.Boolean),
  /** Upper bound on matches kept per environment after unioning, default 20. */
  limitPerEnvironment: Schema.optional(NonNegativeInt),
});
export type VoiceSearchThreadsInput = typeof VoiceSearchThreadsInput.Type;

export const VoiceSearchThreadsOutput = Schema.Struct({
  perEnvironment: Schema.Array(
    Schema.Struct({
      environment: VoiceEnvironmentOutcome,
      matches: Schema.Array(VoiceThreadSearchMatch),
    }),
  ),
});
export type VoiceSearchThreadsOutput = typeof VoiceSearchThreadsOutput.Type;

// ---------------------------------------------------------------------------
// Tool 5: voice.readThread
// ---------------------------------------------------------------------------

export const VoiceThreadTurnExcerpt = Schema.Struct({
  turnId: Schema.optional(TurnId),
  createdAt: Schema.optional(Schema.String),
  /** User prompt text, truncated at 2000 characters. */
  userText: TrimmedString,
  /** Turn's final assistant text, truncated at 2000 characters. Null when the
      turn has no completed assistant message. */
  assistantText: Schema.NullOr(TrimmedString),
});
export type VoiceThreadTurnExcerpt = typeof VoiceThreadTurnExcerpt.Type;

export const VoiceThreadExcerpt = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: TrimmedString,
  createdAt: Schema.optional(Schema.String),
  updatedAt: Schema.optional(Schema.String),
  /** Latest session state, for "is this thread still running" answers. */
  sessionStatus: Schema.optional(OrchestrationSessionStatus),
  sessionLastError: Schema.optional(Schema.String),
  turns: Schema.Array(VoiceThreadTurnExcerpt),
  /** True when the requested window was truncated by turnLimit. */
  truncated: Schema.optional(Schema.Boolean),
});
export type VoiceThreadExcerpt = typeof VoiceThreadExcerpt.Type;

export const VoiceReadThreadInput = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  /** Bounded read window in turns, default 10, hard maximum 50. */
  turnLimit: Schema.optional(NonNegativeInt),
});
export type VoiceReadThreadInput = typeof VoiceReadThreadInput.Type;

export const VoiceReadThreadOutput = Schema.Struct({
  environment: VoiceEnvironmentOutcome,
  thread: Schema.optional(VoiceThreadExcerpt),
});
export type VoiceReadThreadOutput = typeof VoiceReadThreadOutput.Type;

// ---------------------------------------------------------------------------
// Tool 6: voice.readProject
// ---------------------------------------------------------------------------

export const VoiceProjectThreadRef = Schema.Struct({
  threadId: ThreadId,
  title: TrimmedString,
  updatedAt: Schema.optional(Schema.String),
  sessionStatus: Schema.optional(OrchestrationSessionStatus),
});
export type VoiceProjectThreadRef = typeof VoiceProjectThreadRef.Type;

export const VoiceReadProjectInput = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: ProjectId,
  /** Bounded recent-thread window, default 10, hard maximum 50. */
  threadLimit: Schema.optional(NonNegativeInt),
});
export type VoiceReadProjectInput = typeof VoiceReadProjectInput.Type;

export const VoiceReadProjectOutput = Schema.Struct({
  environment: VoiceEnvironmentOutcome,
  project: Schema.optional(VoiceProjectSummary),
  recentThreads: Schema.Array(VoiceProjectThreadRef),
});
export type VoiceReadProjectOutput = typeof VoiceReadProjectOutput.Type;

// ---------------------------------------------------------------------------
// Tool 7: voice.openThread
// ---------------------------------------------------------------------------

export const VoiceOpenThreadInput = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
});
export type VoiceOpenThreadInput = typeof VoiceOpenThreadInput.Type;

export const VoiceOpenThreadOutput = Schema.Struct({
  environment: VoiceEnvironmentOutcome,
  /** True only after the attached UI's router reports the destination route
      as current. Acknowledgment reads the resulting route; it is never
      assumed from the navigation call alone. */
  acknowledged: Schema.Boolean,
  /** The route the UI actually landed on. Equals the requested destination on
      success; differs (or `acknowledged` is false) when the missing-thread
      redirect fired. */
  destination: Schema.optional(
    Schema.Struct({
      environmentId: EnvironmentId,
      threadId: ThreadId,
    }),
  ),
});
export type VoiceOpenThreadOutput = typeof VoiceOpenThreadOutput.Type;

// ---------------------------------------------------------------------------
// Tool 8: voice.startThread
// ---------------------------------------------------------------------------

export const VoiceStartThreadInput = Schema.Struct({
  /** Stable request id. Replays with the same id and same destination are
      deduplicated downstream and return the original outcome. */
  requestId: VoiceRequestId,
  environmentId: EnvironmentId,
  projectId: ProjectId,
  /** The user's task text; becomes the first user message. */
  task: TrimmedString.check(Schema.isMinLength(1), Schema.isMaxLength(8000)),
  /** Explicit model choice. Validated against the environment's current
      ServerProvider catalog before dispatch. */
  modelSelection: ModelSelection,
  /** Optional thread title. Defaults to a prefix of the task text. */
  title: Schema.optional(TrimmedNonEmptyString),
  /** Spoken, explicit override only. Never defaulted here: the created thread
      uses the normal T3 runtime default unless the user explicitly asks. */
  runtimeMode: Schema.optional(TrimmedNonEmptyString),
});
export type VoiceStartThreadInput = typeof VoiceStartThreadInput.Type;

export const VoiceStartedThreadSession = Schema.Struct({
  status: OrchestrationSessionStatus,
  lastError: Schema.NullOr(TrimmedString),
});
export type VoiceStartedThreadSession = typeof VoiceStartedThreadSession.Type;

export const VoiceStartThreadOutput = Schema.Struct({
  requestId: VoiceRequestId,
  environment: VoiceEnvironmentOutcome,
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  /** Event sequence returned by the dispatch receipt. */
  dispatchSequence: NonNegativeInt,
  /** Read-back of the thread's session after dispatch. Present once the
      read-back completed; a fast terminal success reports its final status
      here, a running worker reports `starting`/`running`. Thread existence
      alone is never reported as successful execution. A read-back whose
      session state is identical to the pre-dispatch state describes the
      previous turn (the new turn's session-set is only projected when the
      provider reactor picks it up); continueThread reports such a follow-up
      as `starting` instead of echoing a stale terminal status or error. */
  session: Schema.optional(VoiceStartedThreadSession),
});
export type VoiceStartThreadOutput = typeof VoiceStartThreadOutput.Type;

/** Sends a follow-up to an existing thread. Never bootstraps a new thread or
 * changes its model, runtime, title, project or workspace. */
export const VoiceContinueThreadInput = Schema.Struct({
  requestId: VoiceRequestId,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  task: TrimmedString.check(Schema.isMinLength(1), Schema.isMaxLength(8000)),
});
export type VoiceContinueThreadInput = typeof VoiceContinueThreadInput.Type;

// ---------------------------------------------------------------------------
// Tool 9: voice.observeThread
// ---------------------------------------------------------------------------

export const VoiceObserveThreadInput = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  /** Resume cursor: report progress after this event sequence. Mirrors
      subscribeThread's afterSequence semantics. */
  afterSequence: Schema.optional(NonNegativeInt),
});
export type VoiceObserveThreadInput = typeof VoiceObserveThreadInput.Type;

export const VoiceObserveThreadOutput = Schema.Struct({
  environment: VoiceEnvironmentOutcome,
  threadId: ThreadId,
  /** Event sequence this observation is current as of. */
  sequence: NonNegativeInt,
  session: VoiceStartedThreadSession,
  /** Identity of the in-flight or latest completed turn, when known. Research
      delivery is keyed by (threadId, turnId), never by session status
      repetition alone. */
  turnId: Schema.optional(TurnId),
  running: Schema.Boolean,
});
export type VoiceObserveThreadOutput = typeof VoiceObserveThreadOutput.Type;

// ---------------------------------------------------------------------------
// Tool 10: voice.listControls / Tool 11: voice.clickControl (client-local UI)
// ---------------------------------------------------------------------------

/** Activatable control roles the client-local enumeration recognizes.
    Anything without one of these roles (plain divs, decorative images) is
    unsupported and never listed; the supported/unsupported mapping is
    documented in docs/user/voice-controls.md. */
export const VoiceUiControlRole = Schema.Literals([
  "button",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "switch",
  "checkbox",
  "radio",
  "option",
]);
export type VoiceUiControlRole = typeof VoiceUiControlRole.Type;

export const VoiceUiControlState = Schema.Literals(["enabled", "disabled", "hidden"]);
export type VoiceUiControlState = typeof VoiceUiControlState.Type;

export const VoiceUiControl = Schema.Struct({
  /** Opaque, per-element id assigned by the attached client, stable for the
      session while the element stays attached. Resolution re-finds the exact
      element at click time; a collected or detached element is reported
      stale. Names and occurrence describe context and never address a
      click, so a surviving same-named control is never retargeted. */
  controlId: TrimmedNonEmptyString,
  role: VoiceUiControlRole,
  /** Accessible name; empty when the control exposes none. */
  name: TrimmedString,
  state: VoiceUiControlState,
  /** 1-based position among the currently attached controls sharing the
      role and accessible name (DOM order). Context for disambiguation in
      speech; the controlId remains the only click address. */
  occurrence: NonNegativeInt,
  /** True when another currently attached control shares the role and
      accessible name; use occurrence to say which one. */
  ambiguous: Schema.optional(Schema.Boolean),
});
export type VoiceUiControl = typeof VoiceUiControl.Type;

export const VoiceListControlsInput = Schema.Struct({
  /** Case-insensitive substring filter over accessible names. Absent lists
      everything. */
  query: Schema.optional(TrimmedString.check(Schema.isMaxLength(120))),
  /** Hidden controls are excluded by default; include them on an explicit
      spoken request. Disabled controls are always listed with their state. */
  includeHidden: Schema.optional(Schema.Boolean),
  /** Upper bound on returned controls, default 60, hard maximum 200. */
  limit: Schema.optional(NonNegativeInt),
});
export type VoiceListControlsInput = typeof VoiceListControlsInput.Type;

export const VoiceListControlsOutput = Schema.Struct({
  controls: Schema.Array(VoiceUiControl),
  /** True when more matching controls exist beyond the limit. */
  truncated: Schema.optional(Schema.Boolean),
  /** Present only when the attached client exposes no UI control source.
      Execution is client-local: a client that cannot see a UI refuses here
      instead of pretending to enumerate. */
  error: Schema.optional(VoiceToolError),
});
export type VoiceListControlsOutput = typeof VoiceListControlsOutput.Type;

export const VoiceClickControlInput = Schema.Struct({
  controlId: TrimmedNonEmptyString,
});
export type VoiceClickControlInput = typeof VoiceClickControlInput.Type;

/** Activation states. "activated" is dispatch-level evidence: the id resolved
    to a visible, enabled control that received a real activation (pointer and
    click sequence). Every other state is an explicit refusal; a click result
    is success only when state is "activated". */
export const VoiceClickControlState = Schema.Literals([
  "activated",
  "disabled",
  "hidden",
  "not_found",
  "ambiguous",
  "unsupported",
]);
export type VoiceClickControlState = typeof VoiceClickControlState.Type;

export const VoiceClickControlOutput = Schema.Struct({
  controlId: TrimmedNonEmptyString,
  state: VoiceClickControlState,
  /** Accessible name of the control the id resolved to, when found. */
  name: Schema.optional(TrimmedString),
  role: Schema.optional(VoiceUiControlRole),
  message: Schema.optional(TrimmedString),
});
export type VoiceClickControlOutput = typeof VoiceClickControlOutput.Type;

// ---------------------------------------------------------------------------
// Broker wire contracts (client <-> apps/server voice route)
// ---------------------------------------------------------------------------

/** Client → broker request to mint one Live session. The broker holds the
    environment-owned OpenAI key and proxies the SDP exchange; no client
    secret or ephemeral key is ever issued to the browser. */
export const VoiceBrokerSessionRequest = Schema.Struct({
  /** Opt-in command experiment. Existing clients retain managed delegation. */
  clientDelegation: Schema.optional(Schema.Boolean),
  transport: Schema.Struct({
    type: Schema.Literal("webrtc"),
    /** Preserve the SDP bytes, including its terminating CRLF. */
    sdp: Schema.String.check(Schema.isPattern(/\S/)),
  }),
});
export type VoiceBrokerSessionRequest = typeof VoiceBrokerSessionRequest.Type;

export const VoiceBackendRequest = Schema.Struct({
  sessionId: VoiceSessionId,
  input: Schema.Array(Schema.Unknown).check(Schema.isMaxLength(200)),
});
export type VoiceBackendRequest = typeof VoiceBackendRequest.Type;

export const VoiceBackendResult = Schema.Struct({
  output: Schema.Array(Schema.Unknown),
  status: Schema.String,
});
export type VoiceBackendResult = typeof VoiceBackendResult.Type;

export const VoiceBrokerSessionCreated = Schema.Struct({
  sessionId: VoiceSessionId,
  /** The Live answer SDP to hand to the browser's RTCPeerConnection. */
  sdp: Schema.String.check(Schema.isPattern(/\S/)),
});
export type VoiceBrokerSessionCreated = typeof VoiceBrokerSessionCreated.Type;

export const VoiceBrokerSessionCloseInput = Schema.Struct({
  sessionId: VoiceSessionId,
});
export type VoiceBrokerSessionCloseInput = typeof VoiceBrokerSessionCloseInput.Type;

export const VoiceBrokerSessionCloseResult = Schema.Struct({
  closed: Schema.Boolean,
});
export type VoiceBrokerSessionCloseResult = typeof VoiceBrokerSessionCloseResult.Type;

/** Usage as reported by the Live session (`session.usage.updated` deltas and
    the final `session.closed` payload). Field names follow the Live payloads;
    the broker records what OpenAI returned, and unknown numeric fields are
    tolerated by the passthrough record. */
export const VoiceSessionUsage = Schema.Struct({
  sessionId: VoiceSessionId,
  recordedAt: Schema.String,
  usage: Schema.Record(Schema.String, Schema.Number),
});
export type VoiceSessionUsage = typeof VoiceSessionUsage.Type;

// ---------------------------------------------------------------------------
// Live session config (assembled by the broker into the minted session)
// ---------------------------------------------------------------------------

/** The broker always delegates task work to a small backend model through
    managed Responses delegation; modes are never mixed. */
export const VoiceDelegationConfig = Schema.Struct({
  type: Schema.Literal("responses"),
  /** Configurable small backend model the delegation runs on. */
  model: TrimmedNonEmptyString,
  /** Backend instructions. Absent uses the broker's built-in default. */
  instructions: Schema.optional(TrimmedString),
});
export type VoiceDelegationConfig = typeof VoiceDelegationConfig.Type;

/** Function definitions the broker advertises to the Live session. Names come
    from the frozen tool registry; descriptions are concise because execution
    stays client-owned — the model-visible list grants no authority. */
export const VoiceBrokerToolDefinition = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: TrimmedString,
});
export type VoiceBrokerToolDefinition = typeof VoiceBrokerToolDefinition.Type;

/** Everything the broker assembles into the minted Live session. The Live
    model and delegation settings are broker configuration (server secret
    store), never client-supplied. */
export const VoiceBrokerSessionConfig = Schema.Struct({
  /** The GPT Live speech model. */
  model: TrimmedNonEmptyString,
  instructions: Schema.optional(TrimmedString),
  delegation: VoiceDelegationConfig,
  tools: Schema.Array(VoiceBrokerToolDefinition),
});
export type VoiceBrokerSessionConfig = typeof VoiceBrokerSessionConfig.Type;

// ---------------------------------------------------------------------------
// Timing marks (emitted by T3's live client; measured by T7)
// ---------------------------------------------------------------------------

export const VoiceTimingMark = Schema.Literals([
  /** Annotated recorded-input endpoint for the utterance. This is the
      end-of-utterance baseline; transcript fragment timing is not
      authoritative. */
  "utterance_end",
  "session_delegation_created",
  "function_call_received",
  "tool_done",
  "function_call_output_sent",
  "first_output_transcript_delta",
  "navigation_acknowledged",
  "first_useful_speech",
]);
export type VoiceTimingMark = typeof VoiceTimingMark.Type;

export const VoiceTimingMarkRecord = Schema.Struct({
  mark: VoiceTimingMark,
  /** Epoch milliseconds when the mark fired. */
  atMs: Schema.Number,
  sessionId: Schema.optional(VoiceSessionId),
  detail: Schema.optional(TrimmedString),
  /** How the mark was measured. "annotated-input" means the annotated
      recorded-input endpoint supplied the timing; "unavailable" means the
      current client could not observe it and the mark records absence, never
      a fabricated time. Absent means measured directly by the client clock. */
  source: Schema.optional(Schema.Literals(["annotated-input", "unavailable"])),
});
export type VoiceTimingMarkRecord = typeof VoiceTimingMarkRecord.Type;

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

/** The frozen voice tool set. Each entry pairs the tool's input and output
    wire schemas; every tool may fail with VoiceToolError. */
export const VoiceToolSchemas = {
  discoverEnvironments: {
    input: VoiceDiscoverEnvironmentsInput,
    output: VoiceDiscoverEnvironmentsOutput,
  },
  discoverProjects: {
    input: VoiceDiscoverProjectsInput,
    output: VoiceDiscoverProjectsOutput,
  },
  listModels: {
    input: VoiceListModelsInput,
    output: VoiceListModelsOutput,
  },
  searchThreads: {
    input: VoiceSearchThreadsInput,
    output: VoiceSearchThreadsOutput,
  },
  readThread: {
    input: VoiceReadThreadInput,
    output: VoiceReadThreadOutput,
  },
  readProject: {
    input: VoiceReadProjectInput,
    output: VoiceReadProjectOutput,
  },
  openThread: {
    input: VoiceOpenThreadInput,
    output: VoiceOpenThreadOutput,
  },
  startThread: {
    input: VoiceStartThreadInput,
    output: VoiceStartThreadOutput,
  },
  continueThread: {
    input: VoiceContinueThreadInput,
    output: VoiceStartThreadOutput,
  },
  observeThread: {
    input: VoiceObserveThreadInput,
    output: VoiceObserveThreadOutput,
  },
  listControls: {
    input: VoiceListControlsInput,
    output: VoiceListControlsOutput,
  },
  clickControl: {
    input: VoiceClickControlInput,
    output: VoiceClickControlOutput,
  },
} as const;

export type VoiceToolName = keyof typeof VoiceToolSchemas;

/** API keys are write-only. Omitting apiKey preserves it; null removes it. */
export const VoiceSettingsUpdate = Schema.Struct({
  apiKey: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  liveModel: TrimmedNonEmptyString,
  backendModel: TrimmedNonEmptyString,
});
export type VoiceSettingsUpdate = typeof VoiceSettingsUpdate.Type;
export const VoiceSettings = Schema.Struct({
  keyConfigured: Schema.Boolean,
  liveModel: TrimmedNonEmptyString,
  backendModel: TrimmedNonEmptyString,
});
export type VoiceSettings = typeof VoiceSettings.Type;
