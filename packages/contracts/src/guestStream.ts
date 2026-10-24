import * as Schema from "effect/Schema";

import {
  GuestShareId,
  IsoDateTime,
  MessageId,
  NodeId,
  NonNegativeInt,
  PlanId,
  PositiveInt,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnItemId,
} from "./baseSchemas.ts";
import { GuestMessageAttribution } from "./composerContext.ts";
import { ThreadGuestMessage } from "./guestShare.ts";
import {
  OrchestrationV2Actor,
  OrchestrationV2CreationSource,
  OrchestrationV2ProviderFailure,
  OrchestrationV2ProviderRetry,
  OrchestrationV2RunStatus,
  OrchestrationV2TurnItemStatus,
  OrchestrationV2UserMessageInputIntent,
} from "./orchestrationV2.ts";
import { ProviderRequestKind } from "./providerPolicy.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

/**
 * What the guest stream may carry. The server encodes every event with these schemas, so a key
 * not declared here never leaves it, and a `Schema.Null` or `Schema.Literal("")` field fails the
 * encode if the projector forgot to blank it. Each item member is a subset of the matching
 * `OrchestrationV2TurnItem` member, so the guest page feeds it to the real timeline.
 *
 * This lives apart from guestShare.ts because orchestrationV2.ts imports that file.
 */
const GuestTurnItemBaseFields = {
  id: TurnItemId,
  threadId: ThreadId,
  // The guest sees only items of runs it can see, so the run is always known.
  runId: RunId,
  nodeId: Schema.Null,
  providerThreadId: Schema.Null,
  providerTurnId: Schema.Null,
  nativeItemRef: Schema.Null,
  parentItemId: Schema.NullOr(TurnItemId),
  ordinal: NonNegativeInt,
  status: OrchestrationV2TurnItemStatus,
  // Providers build titles from tool arguments; rows fall back to the fields below.
  title: Schema.Null,
  startedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  completedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  updatedAt: Schema.DateTimeUtcFromString,
} as const;

/** The only tool output a guest gets: a published visual, which it loads from `GUEST_RENDER_ROUTE`. */
const GuestHtmlRenderOutput = Schema.Struct({
  htmlRender: Schema.Struct({
    attachmentId: TrimmedNonEmptyString,
    title: Schema.String,
    height: Schema.Number,
    heights: Schema.optional(Schema.Array(Schema.Tuple([Schema.Number, Schema.Number]))),
  }),
});

/**
 * The command and how it ended. Output never rides the stream: like the owner's timeline, a row
 * fetches it when expanded (`GUEST_ITEM_ROUTE`, `GUEST_COMMAND_OUTPUT_ROUTE`), so `outputOmitted`
 * says there is some.
 */
const GuestCommandExecutionFields = {
  ...GuestTurnItemBaseFields,
  type: Schema.Literal("command_execution"),
  input: Schema.String,
  outputIndicatesFailure: Schema.optional(Schema.Boolean),
  outputOmitted: Schema.optional(Schema.Boolean),
  exitCode: Schema.optional(Schema.Int),
} as const;

const GuestTurnItemMembers = [
  Schema.Struct({
    ...GuestTurnItemBaseFields,
    type: Schema.Literal("user_message"),
    createdBy: OrchestrationV2Actor,
    creationSource: OrchestrationV2CreationSource,
    messageId: MessageId,
    inputIntent: OrchestrationV2UserMessageInputIntent,
    text: Schema.String,
    // Records carry terminal output, files, and other threads; only the guest attribution stays.
    context: Schema.optional(
      Schema.Struct({
        version: Schema.Literal(1),
        guest: Schema.optional(GuestMessageAttribution),
        records: Schema.Tuple([]),
      }),
    ),
    attachments: Schema.Tuple([]),
  }),
  Schema.Struct({
    ...GuestTurnItemBaseFields,
    type: Schema.Literal("assistant_message"),
    messageId: MessageId,
    text: Schema.String,
    streaming: Schema.Boolean,
  }),
  Schema.Struct({
    ...GuestTurnItemBaseFields,
    type: Schema.Literal("proposed_plan"),
    planId: PlanId,
    markdown: Schema.String,
    streaming: Schema.Boolean,
  }),
  Schema.Struct({
    ...GuestTurnItemBaseFields,
    type: Schema.Literal("user_input_request"),
    requestId: RuntimeRequestId,
    questions: Schema.Array(
      Schema.Struct({
        id: TrimmedNonEmptyString,
        header: TrimmedNonEmptyString,
        question: TrimmedNonEmptyString,
        options: Schema.Array(
          Schema.Struct({ label: TrimmedNonEmptyString, description: TrimmedNonEmptyString }),
        ),
        multiSelect: Schema.optional(Schema.Boolean),
      }),
    ),
  }),
  /** Paths are relative to the thread's workspace. Diffs are file content and never sent. */
  Schema.Struct({
    ...GuestTurnItemBaseFields,
    type: Schema.Literal("file_change"),
    fileName: TrimmedNonEmptyString,
    additions: Schema.optional(NonNegativeInt),
    deletions: Schema.optional(NonNegativeInt),
    changes: Schema.optional(
      Schema.Array(
        Schema.Struct({
          operation: TrimmedNonEmptyString,
          path: TrimmedNonEmptyString,
          oldPath: Schema.optional(TrimmedNonEmptyString),
        }),
      ),
    ),
  }),
  /** Matching file names; previews are file content. */
  Schema.Struct({
    ...GuestTurnItemBaseFields,
    type: Schema.Literal("file_search"),
    pattern: Schema.optional(Schema.String),
    results: Schema.optional(
      Schema.Array(
        Schema.Struct({
          fileName: TrimmedNonEmptyString,
          line: Schema.optional(PositiveInt),
          column: Schema.optional(PositiveInt),
        }),
      ),
    ),
  }),
  Schema.Struct({
    ...GuestTurnItemBaseFields,
    type: Schema.Literal("web_search"),
    patterns: Schema.optional(Schema.Array(Schema.String)),
    results: Schema.optional(
      Schema.Array(
        Schema.Struct({
          title: Schema.optional(Schema.String),
          url: Schema.optional(TrimmedNonEmptyString),
        }),
      ),
    ),
  }),
  /** Shows that the agent waits for the owner. The prompt and the choices stay with the owner. */
  Schema.Struct({
    ...GuestTurnItemBaseFields,
    type: Schema.Literal("approval_request"),
    requestId: RuntimeRequestId,
    requestKind: ProviderRequestKind,
  }),
  Schema.Struct({
    ...GuestTurnItemBaseFields,
    type: Schema.Literals(["run_interrupt_request", "run_interrupt_result", "system_notice"]),
    message: Schema.String,
  }),
  Schema.Struct({
    ...GuestTurnItemBaseFields,
    type: Schema.Literal("error"),
    failure: OrchestrationV2ProviderFailure,
    retry: Schema.optional(OrchestrationV2ProviderRetry),
  }),
  /** The summary can describe runs from before the guest's history window. */
  Schema.Struct({
    ...GuestTurnItemBaseFields,
    type: Schema.Literal("compaction"),
    driver: Schema.NullOr(ProviderDriverKind),
    beforeTokenCount: Schema.optional(NonNegativeInt),
    afterTokenCount: Schema.optional(NonNegativeInt),
  }),
  /** That a subagent ran and how it went. Its prompt, result, and thread stay with the owner. */
  Schema.Struct({
    ...GuestTurnItemBaseFields,
    type: Schema.Literal("subagent"),
    subagentId: NodeId,
    origin: Schema.Literals(["provider_native", "app_owned"]),
    driver: ProviderDriverKind,
    providerInstanceId: ProviderInstanceId,
    childThreadId: Schema.Null,
    prompt: Schema.Literal(""),
    result: Schema.Null,
  }),
  Schema.Struct({
    ...GuestTurnItemBaseFields,
    type: Schema.Literal("dynamic_tool"),
    toolName: Schema.NullOr(TrimmedNonEmptyString),
    input: Schema.Null,
    output: Schema.optional(GuestHtmlRenderOutput),
  }),
] as const;

export const GuestTurnItem = Schema.Union([
  ...GuestTurnItemMembers,
  Schema.Struct(GuestCommandExecutionFields),
]);
export type GuestTurnItem = typeof GuestTurnItem.Type;

/**
 * One item as an expanded row shows it: the stream's item, plus a command's output with paths
 * rewritten as in its command text.
 */
export const GuestTurnItemDetail = Schema.Union([
  ...GuestTurnItemMembers,
  Schema.Struct({ ...GuestCommandExecutionFields, output: Schema.optional(Schema.String) }),
]);
export type GuestTurnItemDetail = typeof GuestTurnItemDetail.Type;

export const GuestItemDetail = Schema.Struct({ item: GuestTurnItemDetail });
export type GuestItemDetail = typeof GuestItemDetail.Type;

/** A run the guest can see, trimmed to what the timeline needs for progress and folding. */
export const GuestRun = Schema.Struct({
  id: RunId,
  ordinal: PositiveInt,
  status: OrchestrationV2RunStatus,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  /** When the agent began working, for the elapsed time on the working row. */
  workStartedAt: IsoDateTime,
  /** The provider finished its reply; the run may still be capturing a checkpoint. */
  turnEnded: Schema.Boolean,
});
export type GuestRun = typeof GuestRun.Type;

/**
 * What the composer's model label shows; nothing else from the owner's provider settings. The
 * driver is null when the thread's provider is no longer configured.
 */
export const GuestThreadModel = Schema.Struct({
  driver: Schema.NullOr(ProviderDriverKind),
  name: TrimmedNonEmptyString,
  shortName: Schema.optional(TrimmedNonEmptyString),
  subProvider: Schema.optional(TrimmedNonEmptyString),
});
export type GuestThreadModel = typeof GuestThreadModel.Type;

export const GuestShareView = Schema.Struct({
  shareId: GuestShareId,
  title: Schema.String,
  guestName: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
  messages: Schema.Array(ThreadGuestMessage),
  model: GuestThreadModel,
});
export type GuestShareView = typeof GuestShareView.Type;

/**
 * A reconnect starts with a fresh `snapshot`. Later `item` and `run` events replace the item or
 * run with the same id, or add it at the end.
 */
export const GuestStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    view: GuestShareView,
    runs: Schema.Array(GuestRun),
    items: Schema.Array(GuestTurnItem),
  }),
  Schema.Struct({ type: Schema.Literal("item"), item: GuestTurnItem }),
  Schema.Struct({ type: Schema.Literal("run"), run: GuestRun }),
  Schema.Struct({ type: Schema.Literal("view"), view: GuestShareView }),
  Schema.Struct({ type: Schema.Literal("ended") }),
]);
export type GuestStreamEvent = typeof GuestStreamEvent.Type;
