import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  isRuntimeModeAbove,
  AgentSessionImportProjectChangedError,
  AgentSessionImportProjectNotFoundError,
  AgentSessionScanError,
  AgentSessionSource,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  RunId,
  ThreadId,
  TurnItemId,
  type AgentSessionImportInput,
  type AgentSessionImportResult,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type { ProviderAdapterV2HistoryTurn } from "@t3tools/provider-core/server/ProviderAdapter";
import { isActiveRun } from "../orchestration-v2/CommandPolicy.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectService from "./ProjectService.ts";

const isProjectionStoreThreadNotFoundError = Schema.is(
  ProjectionStore.ProjectionStoreThreadNotFoundError,
);

const IMPORT_EVENT_PREFIX = "agent-session-import:v2";
const CLAUDE_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class AgentSessionUnresumableSessionError extends Schema.TaggedError<AgentSessionUnresumableSessionError>()(
  "AgentSessionUnresumableSessionError",
  {
    source: AgentSessionSource,
    providerSessionId: Schema.String,
  },
) {
  override get message(): string {
    return `Session '${this.providerSessionId}' from '${this.source}' cannot be resumed.`;
  }
}

class AgentSessionThreadProjectConflictError extends Schema.TaggedError<AgentSessionThreadProjectConflictError>()(
  "AgentSessionThreadProjectConflictError",
  {
    threadId: ThreadId,
    expectedProjectId: ProjectId,
    actualProjectId: ProjectId,
  },
) {
  override get message(): string {
    return `Imported thread '${this.threadId}' belongs to project '${this.actualProjectId}', not '${this.expectedProjectId}'.`;
  }
}

class AgentSessionThreadModifiedError extends Schema.TaggedError<AgentSessionThreadModifiedError>()(
  "AgentSessionThreadModifiedError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return `Imported thread '${this.threadId}' already contains non-imported activity.`;
  }
}

// ACP imports read the history while holding the session-mutation lock, and an agent can
// leave session/resume or initialize unanswered. Longer than session/load's own deadline.
const NATIVE_HISTORY_READ_TIMEOUT = "2 minutes";
const CODEX_HISTORY_READ_TIMEOUT = "10 seconds";

/**
 * Whether a thread bound to a native session still lacks its native history.
 * Once a turn has run, the native session also holds that turn's messages, so
 * its history can no longer be imported as run-less items.
 */
export function isNativeHistoryPending(input: {
  readonly historyOrigin: OrchestrationV2AppThread["historyOrigin"];
  readonly hasRun: boolean;
}): boolean {
  return input.historyOrigin !== "v1_import" && !input.hasRun;
}

function dateTime(value: string): DateTime.Utc {
  return DateTime.makeUnsafe(value);
}

type HistoryMessage = Omit<AgentSessionScanner.AgentSessionThreadMessage, "role"> & {
  readonly role: AgentSessionScanner.AgentSessionThreadMessage["role"] | "reasoning";
};

function messageEvents(input: {
  readonly threadId: ThreadId;
  readonly index: number;
  readonly message: HistoryMessage;
  readonly turn?: OrchestrationV2ProviderTurn;
  readonly run?: OrchestrationV2Run;
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const ordinal = input.index + 1;
  const suffix = String(input.index).padStart(6, "0");
  const messageKey = `${input.run?.id ?? input.threadId}:${suffix}`;
  const messageId = MessageId.make(messageKey);
  const turnItemId = TurnItemId.make(`${IMPORT_EVENT_PREFIX}:turn-item:${messageKey}`);
  const at = dateTime(input.message.createdAt);
  const common = {
    id: turnItemId,
    threadId: input.threadId,
    runId: input.run?.id ?? null,
    nodeId: input.turn?.nodeId ?? null,
    providerThreadId: input.turn?.providerThreadId ?? null,
    providerTurnId: input.turn?.id ?? null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
  };
  const turnItemEvent = (payload: OrchestrationV2TurnItem): OrchestrationV2DomainEvent => ({
    id: EventId.make(turnItemId),
    type: "turn-item.updated",
    threadId: input.threadId,
    occurredAt: at,
    payload,
  });
  if (input.message.role === "reasoning") {
    return [
      turnItemEvent({ ...common, type: "reasoning", text: input.message.text, streaming: false }),
    ];
  }
  const message: OrchestrationV2ConversationMessage = {
    createdBy: input.message.role === "user" ? "user" : "agent",
    creationSource: input.run === undefined ? "server" : "provider",
    id: messageId,
    threadId: input.threadId,
    runId: common.runId,
    nodeId: common.nodeId,
    role: input.message.role,
    text: input.message.text,
    attachments: [],
    streaming: false,
    createdAt: at,
    updatedAt: at,
  };
  const turnItem: OrchestrationV2TurnItem =
    input.message.role === "user"
      ? {
          ...common,
          createdBy: "user",
          creationSource: message.creationSource,
          type: "user_message",
          messageId,
          inputIntent: "turn_start",
          text: input.message.text,
          attachments: [],
        }
      : {
          ...common,
          type: "assistant_message",
          messageId,
          text: input.message.text,
          streaming: false,
        };
  return [
    {
      id: EventId.make(`${IMPORT_EVENT_PREFIX}:message:${messageKey}`),
      type: "message.updated",
      threadId: input.threadId,
      occurredAt: at,
      payload: message,
    },
    turnItemEvent(turnItem),
  ];
}

function externalTurnEvents(input: {
  readonly thread: OrchestrationV2AppThread;
  readonly owner: OrchestrationV2ProviderThread;
  readonly nativeThreadId: string;
  readonly nativeTurn: ProviderAdapterV2HistoryTurn;
  readonly indexOfUserMessage: number;
  readonly runOrdinal: number;
  readonly turnOrdinal: number;
  readonly ids: IdAllocator.IdAllocatorV2["Service"]["derive"];
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const { thread, owner, nativeTurn, ids } = input;
  const { id: threadId } = thread;
  const { id: providerThreadId, providerInstanceId, driver } = owner;
  const runId = RunId.make(`codex-history:${threadId}:${nativeTurn.id}`);
  const attemptId = ids.runAttempt({ runId, attemptOrdinal: 1 });
  const nodeId = ids.rootNode({ runId });
  const providerTurnId = ids.providerTurn({ driver, nativeTurnId: nativeTurn.id });
  const { startedAt, completedAt } = nativeTurn;
  const occurredAt = completedAt;
  const nodeEvent = { threadId, nodeId, runId, providerInstanceId, occurredAt };
  const turn: OrchestrationV2ProviderTurn = {
    id: providerTurnId,
    providerThreadId,
    nodeId,
    runAttemptId: attemptId,
    nativeTurnRef: { driver, nativeId: nativeTurn.id, strength: "strong" },
    nativeThreadRef: { driver, nativeId: input.nativeThreadId, strength: "strong" },
    ordinal: input.turnOrdinal,
    status: "completed",
    startedAt,
    completedAt,
  };
  const run: OrchestrationV2Run = {
    id: runId,
    threadId,
    ordinal: input.runOrdinal,
    providerInstanceId,
    modelSelection: { ...thread.modelSelection, instanceId: providerInstanceId },
    providerThreadId,
    userMessageId: MessageId.make(`${runId}:${String(input.indexOfUserMessage).padStart(6, "0")}`),
    rootNodeId: nodeId,
    activeAttemptId: attemptId,
    status: "completed",
    requestedAt: startedAt,
    startedAt,
    completedAt,
    checkpointId: null,
    contextHandoffId: null,
  };
  return [
    {
      ...nodeEvent,
      id: EventId.make(`${runId}:created`),
      type: "run.created",
      payload: run,
    },
    {
      ...nodeEvent,
      id: EventId.make(`${runId}:root`),
      type: "node.updated",
      payload: {
        id: nodeId,
        threadId,
        runId,
        parentNodeId: null,
        rootNodeId: nodeId,
        kind: "root_turn",
        status: "completed",
        countsForRun: true,
        providerThreadId,
        providerTurnId,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt,
        completedAt,
      },
    },
    {
      ...nodeEvent,
      id: EventId.make(`${runId}:attempt`),
      type: "run-attempt.created",
      payload: {
        id: attemptId,
        runId,
        attemptOrdinal: 1,
        rootNodeId: nodeId,
        providerInstanceId,
        providerThreadId,
        providerTurnId,
        nativeThreadId: input.nativeThreadId,
        reason: "initial",
        status: "completed",
        startedAt,
        completedAt,
      },
    },
    {
      ...nodeEvent,
      driver,
      id: EventId.make(`${runId}:provider-turn`),
      type: "provider-turn.updated",
      payload: turn,
    },
    ...nativeTurn.messages.flatMap((message, index) =>
      messageEvents({
        threadId,
        index,
        message: {
          ...message,
          createdAt: DateTime.formatIso(message.role === "user" ? startedAt : completedAt),
        },
        run,
        turn,
      }),
    ),
  ];
}

const make = Effect.gen(function* () {
  const scanner = yield* AgentSessionScanner.AgentSessionScanner;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectService.ProjectService;
  const eventSink = yield* EventSink.EventSinkV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
  const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
  const threadCommands = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const codexReaders = yield* Semaphore.make(2);
  const ceiling = settingsService.managedPolicy?.limits?.maxRuntimeMode;
  const importRecentAgentThreads = Effect.fn("importRecentAgentThreadsV2")(function* (
    input: AgentSessionImportInput,
  ) {
    const project = yield* projects.getById(input.projectId).pipe(
      Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(new AgentSessionImportProjectNotFoundError({ projectId: input.projectId })),
          onSome: Effect.succeed,
        }),
      ),
    );
    if (
      input.expectedWorkspaceRoot !== undefined &&
      normalizeProjectPathForComparison(project.workspaceRoot) !==
        normalizeProjectPathForComparison(input.expectedWorkspaceRoot)
    ) {
      return yield* new AgentSessionImportProjectChangedError({ projectId: input.projectId });
    }
    // Imports run in full access, except under a policy ceiling: then in the project's default,
    // which the policy keeps under it, so imported threads never sit above the ceiling.
    const runtimeMode =
      ceiling === undefined
        ? DEFAULT_RUNTIME_MODE
        : yield* settingsService.getSettings.pipe(
            Effect.mapError(
              (cause) => new AgentSessionScanError({ operation: "read-settings", cause }),
            ),
            Effect.map((settings) => {
              const mode = resolveProjectSettings(settings, input.projectId, project).settings
                .defaultRuntimeMode;
              return isRuntimeModeAbove(mode, ceiling) ? ceiling : mode;
            }),
          );
    const runtimeRows = yield* runtimes
      .list()
      .pipe(
        Effect.mapError(
          (cause) => new AgentSessionScanError({ operation: "read-projects", cause }),
        ),
      );
    // The thread's project owns its transcripts: a linked worktree import records the worktree as cwd.
    const completedSources = (yield* Effect.forEach(runtimeRows, (runtime) => {
      const imported = AgentSessionScanner.decodeImportedTranscriptPayload(
        runtime.runtimePayload,
      ).pipe(Option.flatMapNullishOr((payload) => payload.importedTranscripts));
      if (Option.isNone(imported) || imported.value.length === 0) return Effect.succeed([]);
      return orchestrator.getThreadRecords(runtime.threadId, []).pipe(
        Effect.map(({ thread }) => (thread.projectId === input.projectId ? imported.value : [])),
        Effect.catch((cause) =>
          isProjectionStoreThreadNotFoundError(cause.cause)
            ? Effect.succeed([])
            : Effect.fail(new AgentSessionScanError({ operation: "read-projects", cause })),
        ),
      );
    })).flat();
    const outcomes = scanner.recentThreads(project.workspaceRoot, completedSources);
    const importedThreadIds = new Set<ThreadId>();
    let importedCount = 0;
    let skippedCount = 0;

    yield* Stream.runForEach(outcomes, (outcome) =>
      Effect.gen(function* () {
        if (outcome._tag === "Skipped") {
          skippedCount += 1;
          return;
        }
        const source = outcome.source;
        const threadId = ThreadId.make(
          `import:${source.providerInstanceId}:${source.providerSessionId}`,
        );
        if (outcome._tag === "AlreadyImported") {
          importedThreadIds.add(threadId);
          return;
        }
        if (outcome._tag === "Duplicate") {
          if (importedThreadIds.has(threadId)) {
            yield* runtimes.recordImportedTranscript({ threadId, source }).pipe(Effect.ignore);
          }
          return;
        }

        const imported = yield* Effect.gen(function* () {
          const thread = outcome.thread;
          if (
            thread.source === "claudeAgent" &&
            !CLAUDE_SESSION_ID_PATTERN.test(thread.providerSessionId)
          ) {
            return yield* new AgentSessionUnresumableSessionError({
              source: thread.source,
              providerSessionId: thread.providerSessionId,
            });
          }
          const driver = ProviderDriverKind.make(thread.source);
          // Pi resumes by session file path; its session UUID only names the thread.
          const nativeThreadId =
            thread.source === "pi" ? source.filePath : thread.providerSessionId;
          const truncatedHistoryId = TurnItemId.make(
            `${IMPORT_EVENT_PREFIX}:history-truncated:${threadId}`,
          );
          const persistRuntime = runtimes.upsert(
            {
              threadId,
              providerName: driver,
              providerInstanceId: thread.providerInstanceId,
              adapterKey: driver,
              runtimeMode,
              status: "stopped",
              lastSeenAt: thread.updatedAt,
              resumeCursor:
                thread.source === "claudeAgent"
                  ? { threadId, resume: thread.providerSessionId }
                  : { threadId: nativeThreadId },
              runtimePayload: { cwd: outcome.worktree?.path ?? project.workspaceRoot },
            },
            { onConflict: "ignore" },
          );
          const existing = yield* orchestrator.getThreadRecords(threadId, ["messages"]).pipe(
            Effect.asSome,
            Effect.catchIf(
              (cause) => isProjectionStoreThreadNotFoundError(cause.cause),
              () => Effect.succeedNone,
            ),
          );
          if (Option.isSome(existing)) {
            const { thread: current, messages: stored } = existing.value;
            if (current.projectId !== input.projectId) {
              return yield* new AgentSessionThreadProjectConflictError({
                threadId,
                expectedProjectId: input.projectId,
                actualProjectId: current.projectId,
              });
            }
            if (current.historyOrigin !== "v1_import") {
              return yield* new AgentSessionThreadModifiedError({ threadId });
            }
            if (
              stored.some(
                (message, index) =>
                  message.role !== thread.messages[index]?.role ||
                  message.text !== thread.messages[index]?.text,
              )
            ) {
              return false;
            }
            const appended = thread.messages.slice(stored.length);
            if (appended.length > 0) {
              if (
                thread.source !== "codex" ||
                thread.omittedMessageCount > 0 ||
                stored.length === 0 ||
                current.deletedAt !== null ||
                stored.some((message) => message.runId !== null)
              ) {
                return false;
              }
              // Imported items are ordered before local runs, so only extend an intact import.
              const { runs, turnItems, providerThreads } = yield* orchestrator.getThreadRecords(
                threadId,
                ["runs", "turnItems", "providerThreads"],
                { turnItemTypes: ["system_notice"] },
              );
              const owner = providerThreads.find(
                (providerThread) =>
                  providerThread.id === current.activeProviderThreadId &&
                  providerThread.appThreadId === threadId &&
                  providerThread.driver === driver &&
                  providerThread.providerInstanceId === thread.providerInstanceId &&
                  providerThread.nativeThreadRef?.nativeId === nativeThreadId,
              );
              if (
                owner === undefined ||
                runs.length > 0 ||
                turnItems.some((item) => item.id === truncatedHistoryId)
              ) {
                return false;
              }
              const committed = yield* eventSink.write({
                unlessNativeThreadOwned: owner,
                events: appended.flatMap((message, index) =>
                  messageEvents({ threadId, index: stored.length + index, message }),
                ),
              });
              if (committed.length === 0) return false;
            }
            yield* persistRuntime;
            yield* runtimes.recordImportedTranscript({ threadId, source });
            importedThreadIds.add(threadId);
            return appended.length > 0 ? true : null;
          }

          const model = thread.model ?? DEFAULT_MODEL_BY_PROVIDER[driver] ?? DEFAULT_MODEL;
          const providerThreadId = idAllocator.derive.providerThread({
            driver,
            providerInstanceId: thread.providerInstanceId,
            nativeThreadId,
          });
          const createdAt = dateTime(thread.createdAt);
          const updatedAt = dateTime(thread.updatedAt);
          const appThread: OrchestrationV2AppThread = {
            createdBy: "system",
            creationSource: "server",
            id: threadId,
            projectId: input.projectId,
            title: thread.title.trim() === "" ? "Untitled thread" : thread.title,
            providerInstanceId: thread.providerInstanceId,
            modelSelection: { instanceId: thread.providerInstanceId, model },
            runtimeMode,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: outcome.worktree?.branch ?? null,
            worktreePath: outcome.worktree?.path ?? null,
            linkedPullRequest: null,
            branchPullRequest: null,
            activeProviderThreadId: providerThreadId,
            historyOrigin: "v1_import",
            lineage: {
              parentThreadId: null,
              relationshipToParent: null,
              rootThreadId: threadId,
            },
            forkedFrom: null,
            createdAt,
            updatedAt,
            archivedAt: null,
            settledOverride: "settled",
            settledAt: updatedAt,
            unsettledAt: null,
            snoozedUntil: null,
            snoozedAt: null,
            pinnedAt: null,
            pinOrderKey: null,
            activeOrderKey: null,
            lastVisitedAt: null,
            deletedAt: null,
          };
          const providerThread: OrchestrationV2ProviderThread = {
            id: providerThreadId,
            driver,
            providerInstanceId: thread.providerInstanceId,
            providerSessionId: null,
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef: {
              driver,
              nativeId: nativeThreadId,
              strength: "strong",
            },
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            pendingBackgroundTasks: [],
            createdAt,
            updatedAt,
          };

          const committed = yield* eventSink.write({
            unlessNativeThreadOwned: providerThread,
            events: [
              {
                id: EventId.make(`${IMPORT_EVENT_PREFIX}:thread:${threadId}:created`),
                type: "thread.created",
                threadId,
                providerInstanceId: thread.providerInstanceId,
                occurredAt: createdAt,
                payload: appThread,
              },
              ...(thread.omittedMessageCount > 0
                ? [
                    {
                      id: EventId.make(truncatedHistoryId),
                      type: "turn-item.updated" as const,
                      threadId,
                      occurredAt: createdAt,
                      payload: {
                        id: truncatedHistoryId,
                        threadId,
                        runId: null,
                        nodeId: null,
                        providerThreadId: null,
                        providerTurnId: null,
                        nativeItemRef: null,
                        parentItemId: null,
                        ordinal: 0,
                        status: "completed" as const,
                        title: null,
                        startedAt: createdAt,
                        completedAt: createdAt,
                        updatedAt: createdAt,
                        type: "system_notice" as const,
                        message: `${thread.omittedMessageCount} earlier ${thread.omittedMessageCount === 1 ? "message was" : "messages were"} not imported. This thread keeps the first user message and the most recent history. The original session transcript is unchanged.`,
                      },
                    },
                  ]
                : []),
              ...thread.messages.flatMap((message, index) =>
                messageEvents({ threadId, index, message }),
              ),
              {
                id: EventId.make(`${IMPORT_EVENT_PREFIX}:provider-thread:${providerThreadId}`),
                type: "provider-thread.updated",
                threadId,
                driver,
                providerInstanceId: thread.providerInstanceId,
                occurredAt: updatedAt,
                payload: providerThread,
              },
            ],
          });
          if (committed.length === 0) return null;
          yield* persistRuntime;
          yield* runtimes.recordImportedTranscript({ threadId, source });
          return true;
        }).pipe(
          (effect) => threadCommands.withLock(threadId, effect),
          Effect.catch((cause) =>
            Effect.logWarning("Could not import an agent session", {
              provider: outcome.thread.source,
              sessionId: outcome.thread.providerSessionId,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );
        if (imported === true) {
          importedThreadIds.add(threadId);
          importedCount += 1;
        } else if (imported === false) {
          skippedCount += 1;
        }
      }),
    );

    return { importedCount, skippedCount } satisfies AgentSessionImportResult;
  });

  /**
   * Loading a native session replays its history only into the adapter's own
   * snapshot, so copy that snapshot into the thread as run-less history. The
   * `v1_import` origin keeps it in forks and marks the import done, so a call
   * after a failed read repairs the thread and any later call does nothing.
   */
  const importNativeHistory = Effect.fn("importNativeHistoryV2")(function* (input: {
    readonly threadId: ThreadId;
    readonly workspaceRoot: string;
  }) {
    const pendingThread = Effect.map(
      orchestrator.getThreadRecords(input.threadId, ["providerThreads", "runs"]),
      (records) =>
        isNativeHistoryPending({
          historyOrigin: records.thread.historyOrigin,
          hasRun: records.runs.length > 0,
        })
          ? records
          : null,
    );
    // Thread commands write whole thread rows, so hold their lock from the
    // re-read through the write to keep both this marker and their changes.
    const commit = (messages: ReadonlyArray<HistoryMessage>) =>
      threadCommands.withLock(
        input.threadId,
        Effect.gen(function* () {
          const current = yield* pendingThread;
          if (current === null) return 0;
          yield* eventSink.write({
            events: [
              ...messages.flatMap((message, index) =>
                messageEvents({ threadId: input.threadId, index, message }),
              ),
              {
                id: EventId.make(`${IMPORT_EVENT_PREFIX}:thread:${input.threadId}:native-history`),
                type: "thread.metadata-updated",
                threadId: input.threadId,
                providerInstanceId: current.thread.providerInstanceId,
                occurredAt: yield* DateTime.now,
                payload: { ...current.thread, historyOrigin: "v1_import" },
              },
            ],
          });
          return messages.length;
        }),
      );
    const records = yield* pendingThread;
    if (records === null) return 0;
    const { thread, providerThreads } = records;
    const providerThread = providerThreads.find(
      (candidate) => candidate.appThreadId === input.threadId && candidate.nativeThreadRef !== null,
    );
    const nativeThreadId = providerThread?.nativeThreadRef?.nativeId;
    if (providerThread === undefined || nativeThreadId == null) return 0;
    const providerSessionId = yield* idAllocator.allocate.providerSession({
      providerInstanceId: providerThread.providerInstanceId,
      threadId: input.threadId,
    });
    // The registry admits this open against sign-in changes, like any other open.
    const adapter = yield* registry.get(thread.modelSelection.instanceId);
    const snapshot = yield* adapter
      .openSession({
        threadId: input.threadId,
        providerSessionId,
        modelSelection: thread.modelSelection,
        runtimePolicy: {
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          cwd: thread.worktreePath ?? input.workspaceRoot,
        },
        initialNativeThreadId: nativeThreadId,
        ...(providerThread.nativeMetadata?.itemIdentityVersion === undefined
          ? {}
          : {
              initialProviderItemIdentityVersion: providerThread.nativeMetadata.itemIdentityVersion,
            }),
      })
      .pipe(
        Effect.flatMap((session) => session.readThreadSnapshot({ providerThread })),
        Effect.timeout(NATIVE_HISTORY_READ_TIMEOUT),
        Effect.scoped,
      );
    const reasoningIds = new Set(snapshot.reasoningMessageIds);
    const messages = snapshot.messages.flatMap((message) =>
      (message.role === "user" || message.role === "assistant") && message.text.trim() !== ""
        ? [
            {
              role: reasoningIds.has(message.id) ? ("reasoning" as const) : message.role,
              text: message.text,
              createdAt: DateTime.formatIso(message.createdAt),
            },
          ]
        : [],
    );
    // Loading the session can take a while, and the thread is usable meanwhile.
    return yield* commit(messages);
  });

  const readCodexRefreshTarget = Effect.fn("AgentSessionImporter.readCodexRefreshTarget")(
    function* (threadId: ThreadId) {
      const { thread, providerThreads, runs, providerTurns } = yield* orchestrator.getThreadRecords(
        threadId,
        ["providerThreads", "runs", "providerTurns"],
      );
      const owner = providerThreads.find(
        (providerThread) =>
          providerThread.id === thread.activeProviderThreadId &&
          providerThread.appThreadId === threadId &&
          providerThread.ownerNodeId === null &&
          providerThread.driver === "codex" &&
          providerThread.nativeThreadRef?.strength === "strong",
      );
      if (
        owner === undefined ||
        owner.nativeThreadRef?.nativeId == null ||
        thread.deletedAt !== null ||
        thread.archivedAt !== null ||
        runs.some((run) => run.status === "queued" || isActiveRun(run))
      ) {
        return null;
      }
      const nativeId = owner.nativeThreadRef.nativeId;
      const runByAttempt = new Map(
        runs.flatMap((run) =>
          run.activeAttemptId === null || run.status === "rolled_back"
            ? []
            : [[run.activeAttemptId, run] as const],
        ),
      );
      const ownedTurns = providerTurns.filter((turn) => turn.providerThreadId === owner.id);
      const anchor = ownedTurns.findLast(
        (turn) =>
          turn.runAttemptId !== null &&
          runByAttempt.has(turn.runAttemptId) &&
          turn.nativeTurnRef?.strength === "strong" &&
          turn.nativeTurnRef.nativeId !== null &&
          (turn.nativeThreadRef === undefined || turn.nativeThreadRef.nativeId === nativeId),
      );
      const run = anchor?.runAttemptId == null ? undefined : runByAttempt.get(anchor.runAttemptId);
      if (anchor?.nativeTurnRef?.nativeId == null || run === undefined) return null;
      return {
        thread,
        owner,
        nativeId,
        anchor: anchor.nativeTurnRef.nativeId,
        modelSelection: run.modelSelection,
        runOrdinal: runs.at(-1)?.ordinal ?? 0,
        turnOrdinal: ownedTurns.at(-1)?.ordinal ?? 0,
        knownIds: new Set(ownedTurns.map((turn) => turn.nativeTurnRef?.nativeId)),
      };
    },
  );

  const refreshCodexHistory = Effect.fn("AgentSessionImporter.refreshCodexHistory")(
    function* ({ threadId }: { readonly threadId: ThreadId }) {
      const target = yield* readCodexRefreshTarget(threadId);
      if (target === null) return 0;
      const project = yield* projects.getById(target.thread.projectId);
      if (Option.isNone(project)) return 0;
      const cwd = target.thread.worktreePath ?? project.value.workspaceRoot;
      const adapter = yield* registry.get(target.owner.providerInstanceId);
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: target.owner.providerInstanceId,
        threadId,
      });
      const history = yield* adapter
        .openSession({
          threadId,
          providerSessionId,
          modelSelection: target.modelSelection,
          runtimePolicy: {
            runtimeMode: target.thread.runtimeMode,
            interactionMode: target.thread.interactionMode,
            cwd,
          },
          initialNativeThreadId: target.nativeId,
        })
        .pipe(
          Effect.flatMap(
            (session) =>
              session.readHistoryAfter?.({
                providerThread: target.owner,
                nativeTurnId: target.anchor,
              }) ?? Effect.succeed([]),
          ),
          Effect.scoped,
          codexReaders.withPermit,
          Effect.timeout(CODEX_HISTORY_READ_TIMEOUT),
        );
      const events: Array<OrchestrationV2DomainEvent> = [];
      let runOrdinal = target.runOrdinal;
      let turnOrdinal = target.turnOrdinal;
      for (const nativeTurn of history) {
        if (nativeTurn.status === "inProgress" || target.knownIds.has(nativeTurn.id)) break;
        if (nativeTurn.status !== "completed" || nativeTurn.id === "") continue;
        const indexOfUserMessage = nativeTurn.messages.findIndex(
          (message) => message.role === "user",
        );
        if (indexOfUserMessage < 0) continue;
        target.knownIds.add(nativeTurn.id);
        events.push(
          ...externalTurnEvents({
            thread: target.thread,
            owner: target.owner,
            nativeThreadId: target.nativeId,
            nativeTurn,
            indexOfUserMessage,
            runOrdinal: ++runOrdinal,
            turnOrdinal: ++turnOrdinal,
            ids: idAllocator.derive,
          }),
        );
      }
      if (events.length === 0) return 0;
      const stored = yield* eventSink.write({ unlessNativeThreadOwned: target.owner, events });
      return stored.length === 0 ? 0 : runOrdinal - target.runOrdinal;
    },
    (effect, { threadId }) =>
      // A send after returning to the thread must take its ordinal after the sync.
      threadCommands
        .withLock(threadId, effect)
        .pipe(
          Effect.catch((cause) =>
            Effect.logDebug("Could not refresh Codex history", { threadId, cause }).pipe(
              Effect.as(0),
            ),
          ),
        ),
  );

  return { importRecentAgentThreads, importNativeHistory, refreshCodexHistory };
});

type AgentSessionImporterShape = Effect.Success<typeof make>;

export class AgentSessionImporter extends Context.Service<
  AgentSessionImporter,
  AgentSessionImporterShape
>()("t3/project/AgentSessionImporter") {}

export const layer = Layer.effect(AgentSessionImporter, make);
