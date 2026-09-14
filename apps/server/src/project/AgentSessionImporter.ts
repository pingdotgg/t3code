import {
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  AgentSessionImportProjectChangedError,
  AgentSessionImportProjectNotFoundError,
  AgentSessionSource,
  AgentSessionScanError,
  isImportedAgentSessionMessageId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  type AgentSessionImportInput,
  type AgentSessionImportResult,
  type AgentSessionImportSelection,
  type AgentSessionPreviewInput,
  type AgentSessionPreviewResult,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderSessionDirectory from "../provider/Services/ProviderSessionDirectory.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";

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
    return `Imported thread '${this.threadId}' changed before its history import completed.`;
  }
}

function hasImportedHistory(thread: OrchestrationThread): boolean {
  return thread.messages.some((message) => isImportedAgentSessionMessageId(message.id));
}

function sessionKey(
  session: Pick<AgentSessionImportSelection, "providerInstanceId" | "providerSessionId">,
) {
  return `${session.providerInstanceId}\0${session.providerSessionId}`;
}

/** Read native ownership once for the batch; publication also uses the atomic reservation guard. */
const readNativeSessions = Effect.fn("readNativeAgentSessions")(function* () {
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const bindings = yield* directory
    .listBindings()
    .pipe(
      Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
    );
  const sessions = new Set<string>();
  for (const binding of bindings) {
    if (binding.threadId.startsWith("import:") || !Predicate.isObject(binding.resumeCursor))
      continue;
    const id =
      binding.provider === "claudeAgent"
        ? binding.resumeCursor.resume
        : binding.provider === "codex"
          ? binding.resumeCursor.threadId
          : undefined;
    if (typeof id === "string" && binding.providerInstanceId !== undefined) {
      sessions.add(
        sessionKey({ providerInstanceId: binding.providerInstanceId, providerSessionId: id }),
      );
    }
  }
  return sessions;
});

/** Preview bounded history without creating projects, bindings, or threads. */
export const previewAgentThreads = Effect.fn("previewAgentThreads")(function* (
  input: AgentSessionPreviewInput,
) {
  const scanner = yield* AgentSessionScanner.AgentSessionScanner;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const nativeSessions = yield* readNativeSessions();
  // Completed files must not consume the preview budget on the next review.
  const completedSources = yield* Effect.gen(function* () {
    const projects = yield* snapshots.getProjectShells();
    const project = projects.find(
      (candidate) =>
        normalizeProjectPathForComparison(candidate.workspaceRoot) ===
        normalizeProjectPathForComparison(input.workspaceRoot),
    );
    return project === undefined ? [] : yield* snapshots.getImportedAgentSessionSources(project.id);
  }).pipe(
    Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
  );
  const result: {
    sessions: Array<AgentSessionPreviewResult["sessions"][number]>;
    alreadyImportedCount: number;
    excludedCount: number;
    failedCount: number;
    deferredCount: number;
  } = { sessions: [], alreadyImportedCount: 0, excludedCount: 0, failedCount: 0, deferredCount: 0 };
  yield* Stream.runForEach(
    scanner.recentThreads(
      input.workspaceRoot,
      completedSources.map((entry) => entry.source),
    ),
    (outcome) =>
      Effect.gen(function* () {
        if (outcome._tag === "Skipped") {
          if (outcome.reason === "deferred") result.deferredCount += 1;
          else result.failedCount += 1;
          return;
        }
        if (outcome._tag === "Excluded") {
          result.excludedCount += 1;
          return;
        }
        if (outcome._tag === "Duplicate") return;
        if (outcome._tag === "AlreadyImported" || nativeSessions.has(sessionKey(outcome.source))) {
          result.alreadyImportedCount += 1;
          return;
        }
        const existing = yield* snapshots
          .getThreadDetailById(
            ThreadId.make(
              `import:${outcome.source.providerInstanceId}:${outcome.source.providerSessionId}`,
            ),
          )
          .pipe(
            Effect.mapError(
              (cause) => new AgentSessionScanError({ operation: "read-projects", cause }),
            ),
          );
        if (
          Option.isSome(existing) &&
          (hasImportedHistory(existing.value) || hasImportBlockingActivity(existing.value, false))
        ) {
          result.alreadyImportedCount += 1;
          return;
        }
        result.sessions.push({
          providerInstanceId: outcome.source.providerInstanceId,
          providerSessionId: outcome.source.providerSessionId,
          revision: AgentSessionScanner.agentSessionTranscriptRevision(outcome.source),
          title: outcome.thread.title,
          createdAt: outcome.thread.createdAt,
          messageCount: outcome.thread.messages.length,
        });
      }),
  );
  return result satisfies AgentSessionPreviewResult;
});

function hasImportBlockingActivity(
  thread: OrchestrationThread,
  importedHistoryPresent: boolean,
): boolean {
  return (
    thread.archivedAt !== null ||
    thread.deletedAt !== null ||
    thread.latestTurn !== null ||
    thread.session !== null ||
    thread.messages.some((message) => !isImportedAgentSessionMessageId(message.id)) ||
    thread.proposedPlans.length > 0 ||
    thread.activities.length > 0 ||
    thread.checkpoints.length > 0 ||
    thread.snoozedUntil != null ||
    thread.snoozedAt != null ||
    thread.pinnedAt != null ||
    thread.pinOrderKey != null ||
    thread.titleRegeneration != null ||
    thread.linkedPullRequest != null ||
    thread.unsettledAt != null ||
    (importedHistoryPresent
      ? thread.settledOverride !== "settled"
      : thread.settledOverride !== null || thread.settledAt !== null)
  );
}

/** Import recent transcript text and persist the cursor needed to resume its provider session. */
export const importRecentAgentThreads = Effect.fn("importRecentAgentThreads")(function* (
  input: AgentSessionImportInput,
) {
  const scanner = yield* AgentSessionScanner.AgentSessionScanner;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const crypto = yield* Crypto.Crypto;
  const project = yield* snapshots.getProjectShellById(input.projectId).pipe(
    Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(new AgentSessionImportProjectNotFoundError({ projectId: input.projectId })),
        onSome: Effect.succeed,
      }),
    ),
  );
  const workspaceRoot = project.workspaceRoot;
  if (
    input.expectedWorkspaceRoot !== undefined &&
    normalizeProjectPathForComparison(workspaceRoot) !==
      normalizeProjectPathForComparison(input.expectedWorkspaceRoot)
  ) {
    return yield* new AgentSessionImportProjectChangedError({ projectId: input.projectId });
  }
  const completedSources = yield* snapshots
    .getImportedAgentSessionSources(input.projectId)
    .pipe(
      Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
    );
  const threads = scanner.recentThreads(
    workspaceRoot,
    completedSources.map((entry) => entry.source),
    input.selection,
  );
  const importedThreadIds = new Set<ThreadId>();
  const nativeSessions = yield* readNativeSessions();
  const selection =
    input.selection === undefined
      ? undefined
      : new Map(input.selection.map((session) => [sessionKey(session), session.revision]));
  const pendingSelection = new Set(selection?.keys());
  let importedCount = 0;
  let alreadyImportedCount = 0;
  let excludedCount = 0;
  let failedCount = 0;
  let deferredCount = 0;

  yield* Stream.runForEach(threads, (outcome) =>
    Effect.gen(function* () {
      if (outcome._tag === "Skipped") {
        if (outcome.reason === "deferred") deferredCount += 1;
        else if (selection === undefined) failedCount += 1;
        return;
      }
      if (outcome._tag === "Excluded") {
        if (selection === undefined) {
          excludedCount += 1;
        } else if (outcome.source !== undefined) {
          const key = sessionKey(outcome.source);
          if (
            selection.get(key) ===
            AgentSessionScanner.agentSessionTranscriptRevision(outcome.source)
          ) {
            pendingSelection.delete(key);
            excludedCount += 1;
          }
        }
        return;
      }
      if (selection !== undefined) {
        const key = sessionKey(outcome.source);
        if (
          selection.get(key) !== AgentSessionScanner.agentSessionTranscriptRevision(outcome.source)
        )
          return;
        pendingSelection.delete(key);
      }
      if (outcome._tag === "AlreadyImported" || outcome._tag === "Duplicate") {
        const threadId = ThreadId.make(
          `import:${outcome.source.providerInstanceId}:${outcome.source.providerSessionId}`,
        );
        if (outcome._tag === "AlreadyImported") {
          importedThreadIds.add(threadId);
          alreadyImportedCount += 1;
        } else if (importedThreadIds.has(threadId)) {
          const recorded = yield* directory
            .recordImportedTranscript({ threadId, source: outcome.source })
            .pipe(Effect.result);
          if (recorded._tag === "Failure") {
            failedCount += 1;
            yield* Effect.logWarning("Could not record an imported transcript copy", {
              threadId,
              cause: recorded.failure,
            });
          }
        }
        return;
      }
      const thread = outcome.thread;
      if (nativeSessions.has(sessionKey(thread))) {
        alreadyImportedCount += 1;
        return;
      }
      const threadId = ThreadId.make(
        `import:${thread.providerInstanceId}:${thread.providerSessionId}`,
      );
      const imported = yield* Effect.gen(function* () {
        const provider = ProviderDriverKind.make(thread.source);
        const model = thread.model ?? DEFAULT_MODEL_BY_PROVIDER[provider] ?? DEFAULT_MODEL;
        const existingThread = yield* snapshots.getThreadDetailById(threadId);
        const existingBinding = yield* directory.getBinding(threadId);

        if (
          thread.source === "claudeAgent" &&
          !CLAUDE_SESSION_ID_PATTERN.test(thread.providerSessionId)
        ) {
          return yield* new AgentSessionUnresumableSessionError({
            source: thread.source,
            providerSessionId: thread.providerSessionId,
          });
        }

        if (Option.isSome(existingThread) && existingThread.value.projectId !== input.projectId) {
          return yield* new AgentSessionThreadProjectConflictError({
            threadId,
            expectedProjectId: input.projectId,
            actualProjectId: existingThread.value.projectId,
          });
        }

        const importedHistoryPresent = Option.isSome(existingThread)
          ? hasImportedHistory(existingThread.value)
          : false;
        if (
          Option.isSome(existingThread) &&
          importedHistoryPresent &&
          Option.isSome(existingBinding)
        ) {
          yield* directory.recordImportedTranscript({ threadId, source: outcome.source });
          return "alreadyImported" as const;
        }

        if (
          Option.isSome(existingThread) &&
          hasImportBlockingActivity(existingThread.value, importedHistoryPresent)
        ) {
          return yield* new AgentSessionThreadModifiedError({ threadId });
        }

        if (
          Option.isSome(existingBinding) &&
          (existingBinding.value.provider !== provider ||
            existingBinding.value.providerInstanceId !== thread.providerInstanceId ||
            existingBinding.value.status !== "stopped")
        ) {
          return yield* new AgentSessionThreadModifiedError({ threadId });
        }

        // Check native ownership even when retrying an old reservation, without
        // replacing a binding that a real session may have updated.
        const reserved = yield* directory.upsert(
          {
            threadId,
            provider,
            providerInstanceId: thread.providerInstanceId,
            status: "stopped",
            runtimeMode: DEFAULT_RUNTIME_MODE,
            resumeCursor:
              thread.source === "codex"
                ? { threadId: thread.providerSessionId }
                : { threadId, resume: thread.providerSessionId },
            runtimePayload: { cwd: workspaceRoot },
          },
          { onConflict: "ignore", unlessNativeSessionId: thread.providerSessionId },
        );
        if (!reserved) return "alreadyImported" as const;

        if (Option.isNone(existingThread)) {
          yield* engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make(yield* crypto.randomUUIDv4),
            threadId,
            projectId: input.projectId,
            title: thread.title,
            modelSelection: { instanceId: thread.providerInstanceId, model },
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: null,
            worktreePath: null,
            createdAt: thread.createdAt,
            historyImport: true,
          });
        }

        if (!importedHistoryPresent) {
          yield* engine.dispatch({
            type: "thread.history.import",
            commandId: CommandId.make(yield* crypto.randomUUIDv4),
            threadId,
            messages: thread.messages.map((message, index) => ({
              messageId: MessageId.make(`${threadId}:${String(index).padStart(6, "0")}`),
              role: message.role,
              text: message.text,
              createdAt: message.createdAt,
            })),
          });
        }

        yield* directory.recordImportedTranscript({ threadId, source: outcome.source });

        return Option.isNone(existingThread) ? ("imported" as const) : ("alreadyImported" as const);
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not import an agent session", {
            provider: thread.source,
            sessionId: thread.providerSessionId,
            cause,
          }).pipe(Effect.as("failed" as const)),
        ),
      );

      if (imported !== "failed") {
        importedThreadIds.add(threadId);
        if (imported === "imported") importedCount += 1;
        else alreadyImportedCount += 1;
      } else {
        failedCount += 1;
      }
    }),
  );

  // Missing revisions changed or disappeared after preview. Deferred selected files may retry.
  failedCount += Math.max(0, pendingSelection.size - deferredCount);
  return {
    importedCount,
    skippedCount: failedCount + deferredCount,
    alreadyImportedCount,
    excludedCount,
    failedCount,
    deferredCount,
  } satisfies AgentSessionImportResult;
});
