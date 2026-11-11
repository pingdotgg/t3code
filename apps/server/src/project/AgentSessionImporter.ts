import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  isRuntimeModeAbove,
  AgentSessionAdoptNotFoundError,
  AgentSessionAdoptUnavailableError,
  AgentSessionImportProjectChangedError,
  AgentSessionImportProjectNotFoundError,
  AgentSessionScanError,
  AgentSessionSource,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  TurnItemId,
  type AgentSessionAdoptInput,
  type AgentSessionAdoptResult,
  type AgentSessionImportInput,
  type AgentSessionImportResult,
  type AgentSessionListInput,
  type AgentSessionListResult,
  type AgentSessionListed,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
  type RuntimeMode,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectService from "./ProjectService.ts";

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
const isAgentSessionUnresumableSessionError = Schema.is(AgentSessionUnresumableSessionError);

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
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const ordinal = input.index + 1;
  const suffix = String(input.index).padStart(6, "0");
  const messageId = MessageId.make(`${input.threadId}:${suffix}`);
  const turnItemId = TurnItemId.make(
    `${IMPORT_EVENT_PREFIX}:turn-item:${input.threadId}:${suffix}`,
  );
  const at = dateTime(input.message.createdAt);
  const common = {
    id: turnItemId,
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
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
    creationSource: "server",
    id: messageId,
    threadId: input.threadId,
    runId: null,
    nodeId: null,
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
          creationSource: "server",
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
      id: EventId.make(`${IMPORT_EVENT_PREFIX}:message:${input.threadId}:${suffix}`),
      type: "message.updated",
      threadId: input.threadId,
      occurredAt: at,
      payload: message,
    },
    turnItemEvent(turnItem),
  ];
}

function importedThreadId(input: {
  readonly providerInstanceId: string;
  readonly providerSessionId: string;
}) {
  return ThreadId.make(`import:${input.providerInstanceId}:${input.providerSessionId}`);
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
  const ceiling = settingsService.managedPolicy?.limits?.maxRuntimeMode;

  const requireProject = Effect.fn("AgentSessionImporter.requireProject")(function* (
    projectId: ProjectId,
    expectedWorkspaceRoot?: string,
  ) {
    const project = yield* projects.getById(projectId).pipe(
      Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new AgentSessionImportProjectNotFoundError({ projectId })),
          onSome: Effect.succeed,
        }),
      ),
    );
    if (
      expectedWorkspaceRoot !== undefined &&
      normalizeProjectPathForComparison(project.workspaceRoot) !==
        normalizeProjectPathForComparison(expectedWorkspaceRoot)
    ) {
      return yield* new AgentSessionImportProjectChangedError({ projectId });
    }
    return project;
  });

  const resolveImportRuntimeMode = Effect.fn("AgentSessionImporter.resolveImportRuntimeMode")(
    function* (projectId: ProjectId, project: Parameters<typeof resolveProjectSettings>[2]) {
      // Imports run in full access, except under a policy ceiling: then in the project's default,
      // which the policy keeps under it, so imported threads never sit above the ceiling.
      if (ceiling === undefined) return DEFAULT_RUNTIME_MODE;
      return yield* settingsService.getSettings.pipe(
        Effect.mapError(
          (cause) => new AgentSessionScanError({ operation: "read-settings", cause }),
        ),
        Effect.map((settings) => {
          const mode = resolveProjectSettings(settings, projectId, project).settings
            .defaultRuntimeMode;
          return isRuntimeModeAbove(mode, ceiling) ? ceiling : mode;
        }),
      );
    },
  );

  const completedSourcesFor = Effect.fn("AgentSessionImporter.completedSourcesFor")(function* (
    workspaceRoot: string,
  ) {
    const runtimeRows = yield* runtimes
      .list()
      .pipe(
        Effect.mapError(
          (cause) => new AgentSessionScanError({ operation: "read-projects", cause }),
        ),
      );
    return runtimeRows.flatMap((runtime) => {
      const payload = AgentSessionScanner.decodeImportedTranscriptPayload(runtime.runtimePayload);
      if (
        Option.isNone(payload) ||
        payload.value.cwd === undefined ||
        normalizeProjectPathForComparison(payload.value.cwd) !==
          normalizeProjectPathForComparison(workspaceRoot)
      ) {
        return [];
      }
      return payload.value.importedTranscripts ?? [];
    });
  });

  const importOneThread = Effect.fn("AgentSessionImporter.importOneThread")(function* (input: {
    readonly projectId: ProjectId;
    readonly workspaceRoot: string;
    readonly runtimeMode: RuntimeMode;
    readonly outcome: Extract<AgentSessionScanner.AgentSessionRecentThread, { _tag: "Importable" }>;
    readonly title?: string | undefined;
  }) {
    const { source, thread } = input.outcome;
    const threadId = importedThreadId(source);
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
    const nativeThreadId = thread.source === "pi" ? source.filePath : thread.providerSessionId;
    const persistRuntime = runtimes.upsert(
      {
        threadId,
        providerName: driver,
        providerInstanceId: thread.providerInstanceId,
        adapterKey: driver,
        runtimeMode: input.runtimeMode,
        status: "stopped",
        lastSeenAt: thread.updatedAt,
        resumeCursor:
          thread.source === "claudeAgent"
            ? { threadId, resume: thread.providerSessionId }
            : { threadId: nativeThreadId },
        runtimePayload: { cwd: input.workspaceRoot },
      },
      { onConflict: "ignore" },
    );
    const existing = yield* Effect.option(orchestrator.getThreadRecords(threadId, []));
    if (Option.isSome(existing)) {
      if (existing.value.thread.projectId !== input.projectId) {
        return yield* new AgentSessionThreadProjectConflictError({
          threadId,
          expectedProjectId: input.projectId,
          actualProjectId: existing.value.thread.projectId,
        });
      }
      if (existing.value.thread.historyOrigin !== "v1_import") {
        return yield* new AgentSessionThreadModifiedError({ threadId });
      }
      yield* persistRuntime;
      yield* runtimes.recordImportedTranscript({ threadId, source });
      return { threadId, status: "already_present" as const };
    }

    const model = thread.model ?? DEFAULT_MODEL_BY_PROVIDER[driver] ?? DEFAULT_MODEL;
    const providerThreadId = idAllocator.derive.providerThread({
      driver,
      providerInstanceId: thread.providerInstanceId,
      nativeThreadId,
    });
    const createdAt = dateTime(thread.createdAt);
    const updatedAt = dateTime(thread.updatedAt);
    const title =
      input.title?.trim() || (thread.title.trim() === "" ? "Untitled thread" : thread.title);
    const appThread: OrchestrationV2AppThread = {
      createdBy: "system",
      creationSource: "server",
      id: threadId,
      projectId: input.projectId,
      title,
      providerInstanceId: thread.providerInstanceId,
      modelSelection: { instanceId: thread.providerInstanceId, model },
      runtimeMode: input.runtimeMode,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: null,
      worktreePath: null,
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
                id: EventId.make(`${IMPORT_EVENT_PREFIX}:history-truncated:${threadId}`),
                type: "turn-item.updated" as const,
                threadId,
                occurredAt: createdAt,
                payload: {
                  id: TurnItemId.make(`${IMPORT_EVENT_PREFIX}:history-truncated:${threadId}`),
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
        ...thread.messages.flatMap((message, index) => messageEvents({ threadId, index, message })),
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
    return { threadId, status: "created" as const };
  });

  const importRecentAgentThreads = Effect.fn("importRecentAgentThreadsV2")(function* (
    input: AgentSessionImportInput,
  ) {
    const project = yield* requireProject(input.projectId, input.expectedWorkspaceRoot);
    const runtimeMode = yield* resolveImportRuntimeMode(input.projectId, project);
    const completedSources = yield* completedSourcesFor(project.workspaceRoot);
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
        const threadId = importedThreadId(source);
        if (outcome._tag === "AlreadyImported") {
          importedThreadIds.add(threadId);
          importedCount += 1;
          return;
        }
        if (outcome._tag === "Duplicate") {
          if (importedThreadIds.has(threadId)) {
            yield* runtimes.recordImportedTranscript({ threadId, source }).pipe(Effect.ignore);
          }
          return;
        }

        const imported = yield* importOneThread({
          projectId: input.projectId,
          workspaceRoot: project.workspaceRoot,
          runtimeMode,
          outcome,
        }).pipe(
          // null: another thread already owns the native session.
          Effect.map((result) => (result === null ? null : true)),
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

  const listSessions = Effect.fn("AgentSessionImporter.listSessions")(function* (
    input: AgentSessionListInput,
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
    const provider = input.provider ?? "claudeAgent";
    // Skip completedSources so list keeps titles; adoption status comes from the thread id.
    const outcomes = yield* scanner
      .recentThreads(project.workspaceRoot, [], { refresh: true })
      .pipe(Stream.runCollect);
    const sessions: Array<AgentSessionListed> = [];
    for (const outcome of outcomes) {
      if (outcome._tag !== "Importable") continue;
      if (outcome.thread.source !== provider) continue;
      const threadId = importedThreadId(outcome.source);
      const existing = yield* Effect.option(orchestrator.getThreadRecords(threadId, []));
      sessions.push({
        provider,
        providerInstanceId: outcome.source.providerInstanceId,
        providerSessionId: outcome.source.providerSessionId,
        title:
          outcome.thread.title.trim() === ""
            ? outcome.source.providerSessionId
            : outcome.thread.title,
        model: outcome.thread.model,
        updatedAt: outcome.thread.updatedAt,
        filePath: outcome.source.filePath,
        importedThreadId: Option.isSome(existing) ? threadId : null,
      });
    }
    sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return { sessions: sessions.slice(0, 256) } satisfies AgentSessionListResult;
  });

  const adoptSession = Effect.fn("AgentSessionImporter.adoptSession")(function* (
    input: AgentSessionAdoptInput,
  ) {
    const project = yield* requireProject(input.projectId, input.expectedWorkspaceRoot);
    const runtimeMode = yield* resolveImportRuntimeMode(input.projectId, project);
    const threadId = importedThreadId({
      providerInstanceId: input.providerInstanceId,
      providerSessionId: input.providerSessionId,
    });
    const existing = yield* Effect.option(orchestrator.getThreadRecords(threadId, []));
    if (Option.isSome(existing)) {
      if (existing.value.thread.projectId !== input.projectId) {
        return yield* new AgentSessionAdoptUnavailableError({
          provider: input.provider,
          providerSessionId: input.providerSessionId,
          reason: "import_failed",
        });
      }
      return { threadId, adopted: false } satisfies AgentSessionAdoptResult;
    }

    const outcomes = yield* scanner
      .recentThreads(project.workspaceRoot, [], { refresh: true })
      .pipe(Stream.runCollect);
    const match = outcomes.find(
      (outcome): outcome is Extract<typeof outcome, { _tag: "Importable" }> =>
        outcome._tag === "Importable" &&
        outcome.thread.source === input.provider &&
        outcome.source.providerInstanceId === input.providerInstanceId &&
        outcome.source.providerSessionId === input.providerSessionId,
    );
    if (match === undefined) {
      return yield* new AgentSessionAdoptNotFoundError({
        projectId: input.projectId,
        provider: input.provider,
        providerSessionId: input.providerSessionId,
      });
    }

    const result = yield* importOneThread({
      projectId: input.projectId,
      workspaceRoot: project.workspaceRoot,
      runtimeMode,
      outcome: match,
      title: input.title,
    }).pipe(
      Effect.mapError((cause) => {
        const reason = isAgentSessionUnresumableSessionError(cause)
          ? "unresumable"
          : "import_failed";
        return new AgentSessionAdoptUnavailableError({
          provider: input.provider,
          providerSessionId: input.providerSessionId,
          reason,
        });
      }),
      Effect.tapError((error) =>
        Effect.logWarning("Could not adopt an agent session", {
          provider: input.provider,
          sessionId: input.providerSessionId,
          reason: error.reason,
        }),
      ),
    );
    if (result === null) {
      return yield* new AgentSessionAdoptUnavailableError({
        provider: input.provider,
        providerSessionId: input.providerSessionId,
        reason: "owned",
      });
    }
    return {
      threadId: result.threadId,
      adopted: result.status === "created",
    } satisfies AgentSessionAdoptResult;
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

  return { importRecentAgentThreads, listSessions, adoptSession, importNativeHistory };
});

type AgentSessionImporterShape = Effect.Success<typeof make>;

export class AgentSessionImporter extends Context.Service<
  AgentSessionImporter,
  AgentSessionImporterShape
>()("t3/project/AgentSessionImporter") {}

export const layer = Layer.effect(AgentSessionImporter, make);
