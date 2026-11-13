// RPC method names, inputs, results, errors and the RPC schema table.
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";

import { OrchestrationMessageContext } from "./composerContext.ts";
import { withRecordIdTable } from "./orchestrationV2IdTable.ts";

import {
  CommandId,
  IsoDateTime,
  MessageId,
  NodeId,
  ForwardCompatibleUnion,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnItemId,
} from "./baseSchemas.ts";
import { ChatAttachment } from "./chatAttachment.ts";
import {
  OrchestrationSearchThreadsInput,
  OrchestrationSearchThreadsResult,
} from "./threadSearch.ts";
import { ModelSelection } from "./modelSelection.ts";
import {
  ProviderInteractionMode,
  RuntimeMode,
} from "./providerPolicy.ts";
import { OrchestrationProjectShell } from "./orchestrationProject.ts";

import {
  OrchestrationV2CreationSource,
} from "./orchestrationV2Base.ts";

import {
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
} from "./orchestrationV2Runs.ts";

import {
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2TurnItem,
  isUnknownTurnItem,
  projectedTurnItemArray,
} from "./orchestrationV2TurnItems.ts";

import {
  OrchestrationV2DomainEvent,
  OrchestrationV2OlderSettledCount,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadShell,
} from "./orchestrationV2Events.ts";

export const ORCHESTRATION_V2_WS_METHODS = {
  dispatchCommand: "orchestration.dispatchCommand",
  getTurnDiff: "orchestration.getTurnDiff",
  getFullThreadDiff: "orchestration.getFullThreadDiff",
  searchThreads: "orchestration.searchThreads",
  searchThread: "orchestration.searchThread",
  searchThreadStream: "orchestration.searchThreadStream",
  getArchivedShellSnapshot: "orchestration.getArchivedShellSnapshot",
  getThreadFamily: "orchestration.getThreadFamily",
  getWorktreeThreadIds: "orchestration.getWorktreeThreadIds",
  getOlderSettledThreads: "orchestration.getOlderSettledThreads",
  getThreadProjection: "orchestration.getThreadProjection",
  getWorkflowScript: "orchestration.getWorkflowScript",
  getNativeChildWork: "orchestration.getNativeChildWork",
  stopWorkflow: "orchestration.stopWorkflow",
  forceStopThread: "orchestration.forceStopThread",
  getTurnItem: "orchestration.getTurnItem",
  launchThread: "orchestration.launchThread",
  subscribeShell: "orchestration.subscribeShell",
  subscribeThread: "orchestration.subscribeThread",
  subscribeCommandOutput: "orchestration.subscribeCommandOutput",
} as const;

export const OrchestrationV2SubscribeCommandOutputInput = Schema.Struct({
  threadId: ThreadId,
  itemId: TurnItemId,
});

export type OrchestrationV2SubscribeCommandOutputInput =
  typeof OrchestrationV2SubscribeCommandOutputInput.Type;

/** Unpersisted stream for expanded rows: replace resets the bounded tail, append extends it, and running:false ends it.
 * Feed both through @t3tools/shared/terminalOutput appendTerminalOutput to preserve cursor and style escapes. */
export const OrchestrationV2CommandOutputFrame = Schema.Struct({
  kind: Schema.Literals(["replace", "append"]),
  text: Schema.String,
  /** Earlier output was dropped to keep the tail bounded. */
  truncated: Schema.Boolean,
  running: Schema.Boolean,
});

export type OrchestrationV2CommandOutputFrame = typeof OrchestrationV2CommandOutputFrame.Type;

export class OrchestrationV2CommandOutputError extends Schema.TaggedError<OrchestrationV2CommandOutputError>()(
  "OrchestrationV2CommandOutputError",
  {
    threadId: ThreadId,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const OrchestrationV2ArchivedShellSnapshot = Schema.Struct({
  schemaVersion: PositiveInt,
  snapshotSequence: NonNegativeInt,
  projects: Schema.Array(OrchestrationProjectShell),
  threads: Schema.Array(OrchestrationV2ThreadShell),
});

export type OrchestrationV2ArchivedShellSnapshot = typeof OrchestrationV2ArchivedShellSnapshot.Type;

export const OrchestrationV2ThreadLaunchInput = Schema.Struct({
  commandId: CommandId,
  creationSource: Schema.optional(OrchestrationV2CreationSource),
  threadId: Schema.optional(ThreadId),
  reuseExistingThread: Schema.optional(Schema.Boolean),
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  generateTitle: Schema.optional(Schema.Boolean),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy,
  initialMessage: Schema.optional(
    Schema.Struct({
      messageId: Schema.optional(MessageId),
      text: Schema.String,
      context: Schema.optional(OrchestrationMessageContext),
      attachments: Schema.Array(ChatAttachment),
    }),
  ),
});

export type OrchestrationV2ThreadLaunchInput = typeof OrchestrationV2ThreadLaunchInput.Type;

export const OrchestrationV2ThreadLaunchResult = Schema.Struct({
  threadId: ThreadId,
  projection: OrchestrationV2ThreadProjection,
  resumed: Schema.Boolean,
  /** The initial message's commit sequence. Older servers omit it. */
  sequence: Schema.optionalKey(NonNegativeInt),
});

export type OrchestrationV2ThreadLaunchResult = typeof OrchestrationV2ThreadLaunchResult.Type;

export const OrchestrationV2DispatchCommandResult = Schema.Struct({
  sequence: NonNegativeInt,
});

export type OrchestrationV2DispatchCommandResult = typeof OrchestrationV2DispatchCommandResult.Type;

export const OrchestrationV2GetThreadProjectionInput = Schema.Struct({
  threadId: ThreadId,
});

export type OrchestrationV2GetThreadProjectionInput =
  typeof OrchestrationV2GetThreadProjectionInput.Type;

export const OrchestrationV2SubscribeShellInput = Schema.Struct({
  afterSequence: Schema.optionalKey(NonNegativeInt),
  requestCompletionMarker: Schema.optionalKey(Schema.Boolean),
  /**
   * Snapshots leave out idle subagent children; read them with `getThreadFamily`. Send only to
   * servers that advertise `shellThreadFamilies`.
   */
  omitIdleSubagents: Schema.optionalKey(Schema.Boolean),
  /**
   * Snapshots leave out older settled threads and count them in `olderSettled`; read them with
   * `getOlderSettledThreads`. Send only to servers that advertise `shellOlderSettled`.
   */
  omitOlderSettled: Schema.optionalKey(Schema.Boolean),
});

export type OrchestrationV2SubscribeShellInput = typeof OrchestrationV2SubscribeShellInput.Type;

export const OrchestrationV2GetThreadFamilyInput = Schema.Struct({
  threadId: ThreadId,
});

export type OrchestrationV2GetThreadFamilyInput = typeof OrchestrationV2GetThreadFamilyInput.Type;

/**
 * The active threads that share the requested thread's `lineage.rootThreadId`: the root, its
 * forks, and their whole subagent trees, in any run state. An unknown thread has an empty family;
 * a deleted one still names its root.
 */
export const OrchestrationV2ThreadFamily = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  threads: Schema.Array(OrchestrationV2ThreadShell),
});

export type OrchestrationV2ThreadFamily = typeof OrchestrationV2ThreadFamily.Type;

export const OrchestrationV2GetWorktreeThreadIdsInput = Schema.Struct({
  worktreePath: TrimmedNonEmptyString,
});

export type OrchestrationV2GetWorktreeThreadIdsInput =
  typeof OrchestrationV2GetWorktreeThreadIdsInput.Type;

/**
 * The client's thread search. With `olderSettledBefore`, the result also carries the rows of the
 * best matching threads settled before it, which shells that omit older settled threads leave out:
 * title, branch, pull request and project matches (in `projectIds` when given), then message hits.
 * Send the extra keys only to servers that advertise `shellOlderSettled`.
 */
export const OrchestrationV2SearchThreadsInput = Schema.Struct({
  ...OrchestrationSearchThreadsInput.fields,
  olderSettledBefore: Schema.optionalKey(IsoDateTime),
  projectIds: Schema.optionalKey(Schema.Array(ProjectId)),
  /** The client's name for this environment, which its own ranking also matches. */
  environmentLabel: Schema.optionalKey(Schema.String),
  /** Skips message search, for pickers that match titles only. */
  titlesOnly: Schema.optionalKey(Schema.Boolean),
});

export type OrchestrationV2SearchThreadsInput = typeof OrchestrationV2SearchThreadsInput.Type;

export const OrchestrationV2SearchThreadsResult = Schema.Struct({
  ...OrchestrationSearchThreadsResult.fields,
  snapshotSequence: Schema.optionalKey(NonNegativeInt),
  threads: Schema.optionalKey(Schema.Array(OrchestrationV2ThreadShell)),
});

export type OrchestrationV2SearchThreadsResult = typeof OrchestrationV2SearchThreadsResult.Type;

/** Where a page of older settled threads starts: below this settle time, then after this id. */
export const OrchestrationV2OlderSettledCursor = Schema.Struct({
  settledAt: IsoDateTime,
  threadId: Schema.optionalKey(ThreadId),
});

export type OrchestrationV2OlderSettledCursor = typeof OrchestrationV2OlderSettledCursor.Type;

export const OrchestrationV2GetOlderSettledThreadsInput = Schema.Struct({
  before: OrchestrationV2OlderSettledCursor,
  /** Every project when absent. */
  projectIds: Schema.optionalKey(Schema.Array(ProjectId)),
  /** 0 reads only the counts. */
  limit: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 50 })),
});

export type OrchestrationV2GetOlderSettledThreadsInput =
  typeof OrchestrationV2GetOlderSettledThreadsInput.Type;

/**
 * Older settled threads below the cursor, newest settle first (`settledAt` desc, then id asc). A
 * `limit: 0` read fills `counts` instead: the older settled threads below the cursor per project,
 * as `OrchestrationV2OlderSettledThreads.counts` count them. A cursor without an id is strict.
 */
export const OrchestrationV2OlderSettledThreadsPage = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  threads: Schema.Array(OrchestrationV2ThreadShell),
  counts: Schema.Array(OrchestrationV2OlderSettledCount),
});

export type OrchestrationV2OlderSettledThreadsPage =
  typeof OrchestrationV2OlderSettledThreadsPage.Type;

/** Active threads on a worktree path, including subagent children a shell may leave out. */
export const OrchestrationV2WorktreeThreadIds = Schema.Struct({
  threadIds: Schema.Array(ThreadId),
});

export type OrchestrationV2WorktreeThreadIds = typeof OrchestrationV2WorktreeThreadIds.Type;

export const OrchestrationV2SubscribeThreadInput = Schema.Struct({
  threadId: ThreadId,
  afterSequence: Schema.optionalKey(NonNegativeInt),
  requestCompletionMarker: Schema.optionalKey(Schema.Boolean),
  acceptBoundedSnapshot: Schema.optionalKey(Schema.Boolean),
  acceptDeferredWork: Schema.optionalKey(Schema.Boolean),
  acceptCompactTurnItems: Schema.optionalKey(Schema.Boolean),
  /** The client restores `*Omitted` bodies from records it already holds. */
  acceptDedupedBodies: Schema.optionalKey(Schema.Boolean),
  acceptCompactIds: Schema.optionalKey(Schema.Boolean),
});

export type OrchestrationV2SubscribeThreadInput = typeof OrchestrationV2SubscribeThreadInput.Type;

/**
 * Server-side only: set it on a response for a client that opted in, and the
 * `withRecordIdTable` codec sends that response with an ID table.
 */
const IdTableMarker = Schema.optionalKey(Schema.Literal(true));

export const OrchestrationV2ThreadDetailSnapshot = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  projection: OrchestrationV2ThreadProjection,
  /** With hasMoreHistory/cursor, this projection is a bounded window, not a complete timeline. */
  historyCursor: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  hasMoreHistory: Schema.optionalKey(Schema.Boolean),
  latestLocalTurnOrdinal: Schema.optionalKey(Schema.NullOr(NonNegativeInt)),
});

export type OrchestrationV2ThreadDetailSnapshot = typeof OrchestrationV2ThreadDetailSnapshot.Type;

/** Keep historyCursor opaque; resume events with afterSequence = snapshotSequence. */
export const OrchestrationV2ThreadBoundedSnapshot = withRecordIdTable(
  Schema.Struct({
    snapshotSequence: NonNegativeInt,
    projection: OrchestrationV2ThreadProjection,
    historyCursor: Schema.NullOr(TrimmedNonEmptyString),
    hasMoreHistory: Schema.Boolean,
    latestLocalTurnOrdinal: Schema.NullOr(NonNegativeInt),
    /**
     * Set only for clients that opted in: `projection.turnItems` omits the items
     * of local visible rows, which lead the full list. Clients must restore them
     * with `boundedSnapshotProjection` before using the projection.
     */
    turnItemsOmitLocalVisible: Schema.optionalKey(Schema.Literal(true)),
    idTable: IdTableMarker,
  }),
  () => "projection",
);

export type OrchestrationV2ThreadBoundedSnapshot = typeof OrchestrationV2ThreadBoundedSnapshot.Type;

export const OrchestrationV2ThreadHistoryPage = withRecordIdTable(
  Schema.Struct({
    snapshotSequence: NonNegativeInt,
    items: projectedTurnItemArray(
      OrchestrationV2ProjectedTurnItem,
      OrchestrationV2ProjectedTurnItem.mapFields((fields) => ({
        ...fields,
        item: ForwardCompatibleUnion(OrchestrationV2TurnItem.members, "type"),
      })),
    ),
    nextCursor: Schema.NullOr(TrimmedNonEmptyString),
    hasMoreHistory: Schema.Boolean,
    idTable: IdTableMarker,
  }),
  () => null,
);

export type OrchestrationV2ThreadHistoryPage = typeof OrchestrationV2ThreadHistoryPage.Type;

const knownDomainEventTypes: ReadonlySet<string> = new Set(
  OrchestrationV2DomainEvent.members.flatMap((member) => {
    const type = member.fields.type;
    return "literals" in type ? type.literals : [type.literal];
  }),
);

export function isKnownOrchestrationV2EventType(type: string): boolean {
  return knownDomainEventTypes.has(type);
}

// Skip unknown event or turn-item types while advancing the resume cursor.
const OrchestrationV2UnknownThreadStreamEvent = Schema.Struct({
  kind: Schema.Literal("event"),
  sequence: NonNegativeInt,
  event: Schema.Struct({
    type: Schema.String,
    payload: Schema.optional(Schema.Unknown),
  }).check(
    Schema.makeFilter(
      (event) =>
        !knownDomainEventTypes.has(event.type) ||
        (event.type === "turn-item.updated" && isUnknownTurnItem(event.payload)) ||
        "A known event type must decode in full.",
    ),
  ),
}).pipe(
  Schema.decodeTo(
    Schema.Struct({
      kind: Schema.Literal("unknown-event"),
      sequence: NonNegativeInt,
      eventType: Schema.String,
    }),
    {
      decode: SchemaGetter.transform((item) => ({
        kind: "unknown-event" as const,
        sequence: item.sequence,
        eventType: item.event.type,
      })),
      encode: SchemaGetter.forbidden(() => "Servers never send unknown thread events."),
    },
  ),
);

export const OrchestrationV2ThreadStreamItem = withRecordIdTable(
  Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("synchronized"),
    }),
    Schema.Struct({
      kind: Schema.Literal("snapshot"),
      snapshotSequence: NonNegativeInt,
      projection: OrchestrationV2ThreadProjection,
      historyCursor: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
      hasMoreHistory: Schema.optionalKey(Schema.Boolean),
      latestLocalTurnOrdinal: Schema.optionalKey(Schema.NullOr(NonNegativeInt)),
      turnItemsOmitLocalVisible: Schema.optionalKey(Schema.Literal(true)),
      idTable: IdTableMarker,
    }),
    Schema.Struct({
      kind: Schema.Literal("event"),
      sequence: NonNegativeInt,
      event: OrchestrationV2DomainEvent,
    }),
    OrchestrationV2UnknownThreadStreamEvent,
  ]),
  (item) => (item.kind === "snapshot" ? "projection" : undefined),
);

export type OrchestrationV2ThreadStreamItem = typeof OrchestrationV2ThreadStreamItem.Type;

export class OrchestrationV2DispatchCommandError extends Schema.TaggedError<OrchestrationV2DispatchCommandError>()(
  "OrchestrationV2DispatchCommandError",
  {
    commandId: CommandId,
    commandType: Schema.String,
    message: Schema.String,
    detail: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class OrchestrationV2GetThreadProjectionError extends Schema.TaggedError<OrchestrationV2GetThreadProjectionError>()(
  "OrchestrationV2GetThreadProjectionError",
  {
    threadId: ThreadId,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class OrchestrationV2GetShellSnapshotError extends Schema.TaggedError<OrchestrationV2GetShellSnapshotError>()(
  "OrchestrationV2GetShellSnapshotError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class OrchestrationV2ThreadLaunchError extends Schema.TaggedError<OrchestrationV2ThreadLaunchError>()(
  "OrchestrationV2ThreadLaunchError",
  {
    commandId: CommandId,
    projectId: ProjectId,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const OrchestrationV2StopWorkflowInput = Schema.Struct({
  threadId: ThreadId,
  subagentId: NodeId,
});

export type OrchestrationV2StopWorkflowInput = typeof OrchestrationV2StopWorkflowInput.Type;

export class OrchestrationV2StopWorkflowError extends Schema.TaggedError<OrchestrationV2StopWorkflowError>()(
  "OrchestrationV2StopWorkflowError",
  {
    threadId: ThreadId,
    subagentId: NodeId,
    reason: Schema.Literals(["not-running", "unsupported", "unavailable", "stop-failed"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not-running":
        return "This workflow is no longer running.";
      case "unsupported":
        return "This provider cannot stop a workflow.";
      case "unavailable":
        return "This workflow has no live provider task.";
      case "stop-failed":
        return "Failed to stop the workflow.";
    }
  }
}

export const OrchestrationV2ForceStopThreadInput = Schema.Struct({
  threadId: ThreadId,
  /** The run the user saw ignore Stop; Force stop refuses once a newer run has started. */
  runId: Schema.optionalKey(RunId),
});

export type OrchestrationV2ForceStopThreadInput = typeof OrchestrationV2ForceStopThreadInput.Type;

export const OrchestrationV2ForceStopThreadResult = Schema.Struct({
  /**
   * `killed`: the thread's own agent processes were killed. `released`: its provider session
   * was torn down, which kills the agent's process group. `releasing`: that teardown has not
   * finished yet and continues on the server. `shared`: the agent process also works for
   * `sharedWithThreadIds`, so only this thread's turn was ended.
   */
  outcome: Schema.Literals(["killed", "released", "releasing", "shared"]),
  sharedWithThreadIds: Schema.Array(ThreadId),
});

export type OrchestrationV2ForceStopThreadResult = typeof OrchestrationV2ForceStopThreadResult.Type;

export class OrchestrationV2ForceStopThreadError extends Schema.TaggedError<OrchestrationV2ForceStopThreadError>()(
  "OrchestrationV2ForceStopThreadError",
  {
    threadId: ThreadId,
    /** `superseded`: a newer run started since the user asked; nothing was stopped. */
    reason: Schema.optional(Schema.Literal("superseded")),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason === "superseded"
      ? "A new turn started, so nothing was force stopped."
      : "Failed to force stop the agent.";
  }
}

export const OrchestrationV2GetWorkflowScriptInput = Schema.Struct({
  threadId: ThreadId,
  scriptPath: TrimmedNonEmptyString,
});

export type OrchestrationV2GetWorkflowScriptInput =
  typeof OrchestrationV2GetWorkflowScriptInput.Type;

export const OrchestrationV2GetWorkflowScriptResult = Schema.Struct({
  scriptPath: TrimmedNonEmptyString,
  contents: Schema.String,
  truncated: Schema.Boolean,
});

export type OrchestrationV2GetWorkflowScriptResult =
  typeof OrchestrationV2GetWorkflowScriptResult.Type;

/** Names a provider-native subagent's child thread. */
export const OrchestrationV2GetNativeChildWorkInput = Schema.Struct({
  threadId: ThreadId,
});

export type OrchestrationV2GetNativeChildWorkInput =
  typeof OrchestrationV2GetNativeChildWorkInput.Type;

export const OrchestrationV2NativeChildStep = Schema.Struct({
  index: NonNegativeInt,
  type: Schema.String,
  status: Schema.NullOr(Schema.String),
  text: Schema.NullOr(Schema.String),
  toolCalls: Schema.Array(Schema.Struct({ name: Schema.String, input: Schema.String })),
});

export type OrchestrationV2NativeChildStep = typeof OrchestrationV2NativeChildStep.Type;

/** Read-only: native children cannot take messages. */
export const OrchestrationV2NativeChildWork = Schema.Struct({
  conversationId: TrimmedNonEmptyString,
  role: Schema.String,
  prompt: Schema.String,
  /** Null when the provider has no readable transcript for this child. */
  steps: Schema.NullOr(Schema.Array(OrchestrationV2NativeChildStep)),
  /** Earlier steps were left out to keep the read bounded. */
  truncated: Schema.Boolean,
});

export type OrchestrationV2NativeChildWork = typeof OrchestrationV2NativeChildWork.Type;

/** Empty when the provider's records do not prove which children the subagent launched. */
export const OrchestrationV2GetNativeChildWorkResult = Schema.Struct({
  children: Schema.Array(OrchestrationV2NativeChildWork),
});

export type OrchestrationV2GetNativeChildWorkResult =
  typeof OrchestrationV2GetNativeChildWorkResult.Type;

export class OrchestrationV2GetNativeChildWorkError extends Schema.TaggedError<OrchestrationV2GetNativeChildWorkError>()(
  "OrchestrationV2GetNativeChildWorkError",
  {
    threadId: ThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return "Failed to read the subagent's work.";
  }
}

const WORKFLOW_FILE_ERROR_MESSAGES = {
  "invalid-path": "Workflow files must be absolute paths with the expected extension.",
  "root-unavailable": "Workflow file root unavailable.",
  "not-found": "Workflow file not found.",
  "outside-root": "Path is outside the workflow files root.",
  "wrong-extension": "Resolved file has the wrong extension.",
  "not-regular-file": "Workflow file is not a regular file.",
  "changed-during-read": "Workflow file changed between resolution and open.",
  "read-failed": "Workflow file read failed.",
} as const;

export class OrchestrationWorkflowFileError extends Schema.TaggedError<OrchestrationWorkflowFileError>()(
  "OrchestrationWorkflowFileError",
  {
    reason: Schema.Literals([
      "invalid-path",
      "root-unavailable",
      "not-found",
      "outside-root",
      "wrong-extension",
      "not-regular-file",
      "changed-during-read",
      "read-failed",
    ]),
    path: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return WORKFLOW_FILE_ERROR_MESSAGES[this.reason];
  }
}

export const OrchestrationV2GetTurnItemInput = Schema.Struct({
  threadId: ThreadId,
  itemId: TurnItemId,
  revision: Schema.optional(Schema.String),
});

export type OrchestrationV2GetTurnItemInput = typeof OrchestrationV2GetTurnItemInput.Type;

export const OrchestrationV2GetTurnItemResult = Schema.Struct({
  item: Schema.NullOr(OrchestrationV2TurnItem),
});

export type OrchestrationV2GetTurnItemResult = typeof OrchestrationV2GetTurnItemResult.Type;

const WORKFLOW_SCRIPT_ERROR_MESSAGES = {
  "invalid-path": "Workflow scripts must be absolute .js paths.",
  "root-unavailable": "Script root unavailable.",
  "not-found": "Script not found.",
  "outside-root": "Script path is outside the workflow scripts root.",
  "not-js": "Resolved script is not a .js file.",
  "not-regular-file": "Script is not a regular file.",
  "changed-during-read": "Script changed between resolution and open.",
  "read-failed": "Script read failed.",
} as const;

export class OrchestrationGetWorkflowScriptError extends Schema.TaggedError<OrchestrationGetWorkflowScriptError>()(
  "OrchestrationGetWorkflowScriptError",
  {
    reason: Schema.Literals([
      "invalid-path",
      "root-unavailable",
      "not-found",
      "outside-root",
      "not-js",
      "not-regular-file",
      "changed-during-read",
      "read-failed",
    ]),
    scriptPath: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return WORKFLOW_SCRIPT_ERROR_MESSAGES[this.reason];
  }
}

export const OrchestrationV2SearchThreadInput = Schema.Struct({
  threadId: ThreadId,
  skills: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        name: Schema.String.check(Schema.isMaxLength(200)),
        displayName: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
      }),
    ).check(Schema.isMaxLength(1_000)),
  ),
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  index: Schema.optionalKey(NonNegativeInt),
  offset: Schema.optionalKey(Schema.Int),
  start: Schema.optionalKey(
    Schema.Struct({ entryId: TrimmedNonEmptyString, occurrence: NonNegativeInt }),
  ),
});

export type OrchestrationV2SearchThreadInput = typeof OrchestrationV2SearchThreadInput.Type;

const OrchestrationV2ThreadFindMatch = Schema.Struct({
  entryId: TrimmedNonEmptyString,
  runId: Schema.NullOr(RunId),
  occurrence: NonNegativeInt,
});

export const OrchestrationV2SearchThreadResult = Schema.Struct({
  complete: Schema.optionalKey(Schema.Boolean),
  snapshotSequence: NonNegativeInt,
  totalMatches: NonNegativeInt,
  activeIndex: NonNegativeInt,
  match: Schema.NullOr(OrchestrationV2ThreadFindMatch),
  navigation: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        entryId: TrimmedNonEmptyString,
        runId: Schema.NullOr(RunId),
        startIndex: NonNegativeInt,
        count: NonNegativeInt,
      }),
    ).check(Schema.isMaxLength(17)),
  ),
});

export type OrchestrationV2SearchThreadResult = typeof OrchestrationV2SearchThreadResult.Type;

export class OrchestrationV2SearchThreadError extends Schema.TaggedError<OrchestrationV2SearchThreadError>()(
  "OrchestrationV2SearchThreadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not search this thread. Please retry.";
  }
}
