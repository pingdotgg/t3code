import {
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  TurnItemId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import {
  AgentSessionImportProjectChangedError,
  AgentSessionImportProjectNotFoundError,
  AgentSessionScanError,
  type AgentSessionImportInput,
  type AgentSessionImportResult,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { AgentSessionImportSources } from "../orchestration-v2/AgentSessionImportSources.ts";
import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";

/** Atomically publish imported history without attaching an unverified native session cursor. */
export const importAgentSession = Effect.fn("importAgentSession")(function* (
  projectId: ProjectId,
  source: AgentSessionScanner.AgentSessionThread,
) {
  const projections = yield* ProjectionStoreV2;
  const sink = yield* EventSinkV2;
  const threadId = ThreadId.make(`import:${source.providerInstanceId}:${source.providerSessionId}`);
  const existing = yield* projections.getThreadShell(threadId);
  if (existing !== null) {
    return (
      existing.projectId === projectId &&
      existing.deletedAt === null &&
      existing.archivedAt === null &&
      existing.historyOrigin === "v1_import"
    );
  }
  const createdAt = DateTime.makeUnsafe(source.createdAt);
  const updatedAt = DateTime.makeUnsafe(source.updatedAt);
  const model =
    source.model ??
    DEFAULT_MODEL_BY_PROVIDER[ProviderDriverKind.make(source.source)] ??
    DEFAULT_MODEL;
  const thread: OrchestrationV2AppThread = {
    createdBy: "system",
    creationSource: "server",
    id: threadId,
    projectId,
    title: source.title,
    providerInstanceId: source.providerInstanceId,
    modelSelection: { instanceId: source.providerInstanceId, model },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    linkedPullRequest: null,
    activeProviderThreadId: null,
    // V2's existing imported-history marker enables runless timeline items and
    // the first-turn portable context handoff for both migrated and CLI history.
    historyOrigin: "v1_import",
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
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
    lastVisitedAt: null,
    deletedAt: null,
  };
  const events: Array<OrchestrationV2DomainEvent> = [
    {
      id: EventId.make(`${threadId}:created`),
      type: "thread.created",
      threadId,
      providerInstanceId: source.providerInstanceId,
      occurredAt: createdAt,
      payload: thread,
    },
  ];
  for (const [index, message] of source.messages.entries()) {
    const messageId = MessageId.make(`${threadId}:${String(index).padStart(6, "0")}`);
    const at = DateTime.makeUnsafe(message.createdAt);
    events.push({
      id: EventId.make(`${messageId}:message`),
      type: "message.updated",
      threadId,
      occurredAt: at,
      payload: {
        createdBy: message.role === "user" ? "user" : "agent",
        creationSource: "server",
        id: messageId,
        threadId,
        runId: null,
        nodeId: null,
        role: message.role,
        text: message.text,
        attachments: [],
        streaming: false,
        createdAt: at,
        updatedAt: at,
      },
    });
    const base = {
      id: TurnItemId.make(`${messageId}:item`),
      threadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: index + 1,
      status: "completed" as const,
      title: null,
      startedAt: at,
      completedAt: at,
      updatedAt: at,
    };
    const item: OrchestrationV2TurnItem =
      message.role === "user"
        ? {
            ...base,
            type: "user_message",
            createdBy: "user",
            creationSource: "server",
            messageId,
            inputIntent: "turn_start",
            text: message.text,
            attachments: [],
          }
        : { ...base, type: "assistant_message", messageId, text: message.text, streaming: false };
    events.push({
      id: EventId.make(`${messageId}:item`),
      type: "turn-item.updated",
      threadId,
      occurredAt: at,
      payload: item,
    });
  }
  // The durable receipt deduplicates concurrent imports and keeps thread plus
  // full transcript in one transaction, including after an interrupted retry.
  yield* sink.commitCommand({
    commandId: CommandId.make(`${threadId}:history-import`),
    threadId,
    commandType: "agent-session.import",
    acceptedAt: yield* DateTime.now,
    events,
    effects: [],
  });
  const imported = yield* projections.getThreadShell(threadId);
  return (
    imported?.projectId === projectId && imported.deletedAt === null && imported.archivedAt === null
  );
});

export const importRecentAgentThreads = Effect.fn("importRecentAgentThreads")(function* (
  input: AgentSessionImportInput,
) {
  const scanner = yield* AgentSessionScanner.AgentSessionScanner;
  const sources = yield* AgentSessionImportSources;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const project = yield* snapshots
    .getProjectShellById(input.projectId)
    .pipe(
      Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
    );
  if (Option.isNone(project)) {
    return yield* new AgentSessionImportProjectNotFoundError({ projectId: input.projectId });
  }
  const workspaceRoot = project.value.workspaceRoot;
  if (
    input.expectedWorkspaceRoot !== undefined &&
    normalizeProjectPathForComparison(workspaceRoot) !==
      normalizeProjectPathForComparison(input.expectedWorkspaceRoot)
  ) {
    return yield* new AgentSessionImportProjectChangedError({ projectId: input.projectId });
  }
  const completedSources = yield* sources.list(input.projectId);
  const importedThreadIds = new Set<ThreadId>();
  let importedCount = 0;
  let skippedCount = 0;
  yield* Stream.runForEach(scanner.recentThreads(workspaceRoot, completedSources), (outcome) =>
    Effect.gen(function* () {
      if (outcome._tag === "AlreadyImported" || outcome._tag === "Duplicate") {
        const threadId = ThreadId.make(
          `import:${outcome.source.providerInstanceId}:${outcome.source.providerSessionId}`,
        );
        if (outcome._tag === "AlreadyImported") {
          importedThreadIds.add(threadId);
          importedCount += 1;
        } else if (importedThreadIds.has(threadId)) {
          yield* sources.record(threadId, outcome.source);
        }
        return;
      }
      if (outcome._tag === "Skipped") {
        skippedCount += 1;
        return;
      }
      const imported = yield* importAgentSession(input.projectId, outcome.thread).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not import an agent session", {
            provider: outcome.thread.source,
            sessionId: outcome.thread.providerSessionId,
            cause,
          }).pipe(Effect.as(false)),
        ),
      );
      if (imported) {
        const threadId = ThreadId.make(
          `import:${outcome.thread.providerInstanceId}:${outcome.thread.providerSessionId}`,
        );
        yield* sources.record(threadId, outcome.source);
        importedThreadIds.add(threadId);
        importedCount += 1;
      } else skippedCount += 1;
    }),
  );
  return { importedCount, skippedCount } satisfies AgentSessionImportResult;
});
