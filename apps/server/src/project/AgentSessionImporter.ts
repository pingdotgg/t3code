import {
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  AgentSessionImportProjectChangedError,
  AgentSessionImportProjectNotFoundError,
  AgentSessionSource,
  AgentSessionResumeError,
  type AgentSessionImportSource,
  type AgentSessionListInput,
  type AgentSessionAttachInput,
  AgentSessionScanError,
  isImportedAgentSessionMessageId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  type AgentSessionImportInput,
  type AgentSessionImportResult,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Option from "effect/Option";
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
    thread.autoSettleDisabledAt != null ||
    thread.titleRegeneration != null ||
    thread.linkedPullRequest != null ||
    thread.unsettledAt != null ||
    (importedHistoryPresent
      ? thread.settledOverride !== "settled"
      : thread.settledOverride !== null || thread.settledAt !== null)
  );
}

/** Persist one selected history with its original directory and provider identity. */
const importAgentThread = Effect.fn("importAgentThread")(function* ({
  projectId,
  workspaceRoot,
  worktreePath,
  branch,
  thread,
  source,
}: {
  projectId: ProjectId;
  workspaceRoot: string;
  worktreePath: string | null;
  branch: string | null;
  thread: AgentSessionScanner.AgentSessionThread;
  source: AgentSessionImportSource;
}) {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const crypto = yield* Crypto.Crypto;
  const threadId = ThreadId.make(`import:${thread.providerInstanceId}:${thread.providerSessionId}`);
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

  if (Option.isSome(existingThread) && existingThread.value.projectId !== projectId) {
    return yield* new AgentSessionThreadProjectConflictError({
      threadId,
      expectedProjectId: projectId,
      actualProjectId: existingThread.value.projectId,
    });
  }

  const importedHistoryPresent = Option.isSome(existingThread)
    ? hasImportedHistory(existingThread.value)
    : false;
  if (Option.isSome(existingThread) && importedHistoryPresent && Option.isSome(existingBinding)) {
    yield* directory.recordImportedTranscript({ threadId, source: source });
    return true;
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

  // Install the cursor before the thread becomes visible. A concurrent
  // real session can replace it, while insert-ignore keeps this import
  // from replacing that newer binding.
  if (Option.isNone(existingBinding)) {
    yield* directory.upsert(
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
      { onConflict: "ignore" },
    );
  }

  if (Option.isNone(existingThread)) {
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(yield* crypto.randomUUIDv4),
      threadId,
      projectId: projectId,
      title: thread.title,
      modelSelection: { instanceId: thread.providerInstanceId, model },
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch,
      worktreePath,
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

  yield* directory.recordImportedTranscript({ threadId, source: source });

  return true;
});

/** Import recent transcript text and persist the cursor needed to resume its provider session. */
export const importRecentAgentThreads = Effect.fn("importRecentAgentThreads")(function* (
  input: AgentSessionImportInput,
) {
  const scanner = yield* AgentSessionScanner.AgentSessionScanner;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
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
  );
  const importedThreadIds = new Set<ThreadId>();
  let importedCount = 0;
  let skippedCount = 0;

  yield* Stream.runForEach(threads, (outcome) =>
    Effect.gen(function* () {
      if (outcome._tag === "Skipped") {
        skippedCount += 1;
        return;
      }
      if (outcome._tag === "AlreadyImported" || outcome._tag === "Duplicate") {
        const threadId = ThreadId.make(
          `import:${outcome.source.providerInstanceId}:${outcome.source.providerSessionId}`,
        );
        if (outcome._tag === "AlreadyImported") {
          importedThreadIds.add(threadId);
          importedCount += 1;
        } else if (importedThreadIds.has(threadId)) {
          const recorded = yield* directory
            .recordImportedTranscript({ threadId, source: outcome.source })
            .pipe(Effect.result);
          if (recorded._tag === "Failure") {
            skippedCount += 1;
            yield* Effect.logWarning("Could not record an imported transcript copy", {
              threadId,
              cause: recorded.failure,
            });
          }
        }
        return;
      }
      const thread = outcome.thread;
      const threadId = ThreadId.make(
        `import:${thread.providerInstanceId}:${thread.providerSessionId}`,
      );
      const imported = yield* importAgentThread({
        projectId: input.projectId,
        workspaceRoot,
        worktreePath: null,
        branch: null,
        thread,
        source: outcome.source,
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not import an agent session", {
            provider: thread.source,
            sessionId: thread.providerSessionId,
            cause,
          }).pipe(Effect.as(false)),
        ),
      );

      if (imported) {
        importedThreadIds.add(threadId);
        importedCount += 1;
      } else {
        skippedCount += 1;
      }
    }),
  );

  return { importedCount, skippedCount } satisfies AgentSessionImportResult;
});

const readSessionProject = Effect.fn("readSessionProject")(function* (projectId: ProjectId) {
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const project = yield* snapshots
    .getProjectShellById(projectId)
    .pipe(
      Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
    );
  if (Option.isNone(project))
    return yield* new AgentSessionImportProjectNotFoundError({ projectId });
  return project.value;
});

export const listAgentSessions = Effect.fn("listAgentSessions")(function* (
  input: AgentSessionListInput,
) {
  const project = yield* readSessionProject(input.projectId);
  const scanner = yield* AgentSessionScanner.AgentSessionScanner;
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const bindings = yield* directory
    .listBindings()
    .pipe(
      Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
    );
  const excludedSessions = new Set<string>();
  const importedSources = yield* snapshots
    .getImportedAgentSessionSources(input.projectId)
    .pipe(
      Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
    );
  for (const { source } of importedSources)
    excludedSessions.add(
      `${source.provider}:${source.providerInstanceId}:${source.providerSessionId}`,
    );
  const unfinishedImports = new Map<string, ThreadId>();
  for (const binding of bindings) {
    if (!Predicate.isObject(binding.resumeCursor)) continue;
    const id =
      binding.provider === "claudeAgent"
        ? binding.resumeCursor.resume
        : binding.resumeCursor.threadId;
    if (typeof id !== "string") continue;
    const key = `${binding.provider}:${binding.providerInstanceId}:${id}`;
    if (excludedSessions.has(key)) continue;
    if (binding.threadId.startsWith("import:")) {
      unfinishedImports.set(key, binding.threadId);
      continue;
    }
    excludedSessions.add(key);
  }
  const result = yield* scanner.listSessions(project.workspaceRoot, excludedSessions);
  const sessions: Array<(typeof result.sessions)[number]> = [];
  for (const session of result.sessions) {
    const importedThreadId = unfinishedImports.get(
      `${session.provider}:${session.providerInstanceId}:${session.sessionId}`,
    );
    if (importedThreadId) {
      // A failed import can leave its cursor before publishing the history.
      // Completed imports normally have a recorded source. Inspect history only
      // for visible candidates whose import may have stopped before recording it.
      const thread = yield* snapshots
        .getThreadDetailById(importedThreadId)
        .pipe(
          Effect.mapError(
            (cause) => new AgentSessionScanError({ operation: "read-projects", cause }),
          ),
        );
      if (
        Option.isSome(thread) &&
        (thread.value.projectId !== input.projectId || hasImportedHistory(thread.value))
      )
        continue;
    }
    sessions.push(session);
  }
  return { ...result, sessions };
});

/** Attachment never starts a provider process or sends a prompt. */
export const attachAgentSession = Effect.fn("attachAgentSession")(function* (
  input: AgentSessionAttachInput,
) {
  const project = yield* readSessionProject(input.projectId);
  const scanner = yield* AgentSessionScanner.AgentSessionScanner;
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const selected = yield* scanner.readSession(
    project.workspaceRoot,
    input.providerInstanceId,
    input.sessionId,
  );
  const bindings = yield* directory.listBindings().pipe(
    Effect.mapError(
      () =>
        new AgentSessionResumeError({
          message: "Could not check whether this session is already open.",
        }),
    ),
  );
  // Native T3 threads and imported threads share the provider's session identity.
  for (const binding of bindings) {
    if (
      binding.provider !== selected.thread.source ||
      binding.providerInstanceId !== input.providerInstanceId ||
      !Predicate.isObject(binding.resumeCursor)
    )
      continue;
    const nativeId =
      binding.provider === "claudeAgent"
        ? binding.resumeCursor.resume
        : binding.resumeCursor.threadId;
    if (nativeId !== input.sessionId) continue;
    const existing = yield* snapshots
      .getThreadDetailById(binding.threadId)
      .pipe(
        Effect.mapError(
          () => new AgentSessionResumeError({ message: "Could not read the existing thread." }),
        ),
      );
    if (
      Option.isSome(existing) &&
      existing.value.deletedAt === null &&
      (!binding.threadId.startsWith("import:") || hasImportedHistory(existing.value))
    ) {
      if (existing.value.archivedAt !== null)
        return yield* new AgentSessionResumeError({
          message:
            "This session already belongs to an archived T3 thread. Reopen that thread to continue.",
        });
      return { threadId: binding.threadId };
    }
  }
  yield* importAgentThread({
    projectId: input.projectId,
    workspaceRoot: selected.session.cwd,
    worktreePath:
      normalizeProjectPathForComparison(selected.session.cwd) ===
      normalizeProjectPathForComparison(project.workspaceRoot)
        ? null
        : selected.session.cwd,
    branch: selected.session.branch,
    thread: { ...selected.thread, title: selected.session.title },
    source: selected.source,
  }).pipe(Effect.mapError((cause) => new AgentSessionResumeError({ message: cause.message })));
  return { threadId: ThreadId.make(`import:${input.providerInstanceId}:${input.sessionId}`) };
});
