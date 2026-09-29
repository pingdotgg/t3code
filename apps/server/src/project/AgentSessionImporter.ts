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
  importedAgentSessionThreadId,
  isImportedAgentSessionMessageId,
  isImportedAgentSessionThreadId,
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

/** Preserve storage failures as the scan error shared by the session RPCs. */
const readProjectsFailed = (cause: unknown) =>
  new AgentSessionScanError({ operation: "read-projects", cause });

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

/** Detect published import history independently of the later transcript-source record. */
function hasImportedHistory(thread: OrchestrationThread): boolean {
  return thread.messages.some((message) => isImportedAgentSessionMessageId(message.id));
}

/** Prevent an interrupted import from overwriting a thread that has since been used or changed. */
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

/** Persist one selected history with its original directory and provider identity. Returns its thread. */
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
  const threadId = importedAgentSessionThreadId(
    thread.providerInstanceId,
    thread.providerSessionId,
  );
  const provider = ProviderDriverKind.make(thread.source);
  const model = thread.model ?? DEFAULT_MODEL_BY_PROVIDER[provider] ?? DEFAULT_MODEL;
  const existingThread = yield* snapshots.getThreadDetailById(threadId);
  const existingBinding = yield* directory.getBinding(threadId);

  if (
    thread.source === "claudeAgent" &&
    !AgentSessionScanner.CLAUDE_SESSION_ID_PATTERN.test(thread.providerSessionId)
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
    return threadId;
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

  return threadId;
});

/** Resolve the persisted project root; callers cannot supply their own discovery scope. */
const readSessionProject = Effect.fn("readSessionProject")(function* (projectId: ProjectId) {
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const project = yield* snapshots
    .getProjectShellById(projectId)
    .pipe(Effect.mapError(readProjectsFailed));
  if (Option.isNone(project))
    return yield* new AgentSessionImportProjectNotFoundError({ projectId });
  return project.value;
});

/** Import recent transcript text and persist the cursor needed to resume its provider session. */
export const importRecentAgentThreads = Effect.fn("importRecentAgentThreads")(function* (
  input: AgentSessionImportInput,
) {
  const scanner = yield* AgentSessionScanner.AgentSessionScanner;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const project = yield* readSessionProject(input.projectId);
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
    .pipe(Effect.mapError(readProjectsFailed));
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
        const threadId = importedAgentSessionThreadId(
          outcome.source.providerInstanceId,
          outcome.source.providerSessionId,
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
      const threadId = yield* importAgentThread({
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
          }).pipe(Effect.as(null)),
        ),
      );

      if (threadId !== null) {
        importedThreadIds.add(threadId);
        importedCount += 1;
      } else {
        skippedCount += 1;
      }
    }),
  );

  return { importedCount, skippedCount } satisfies AgentSessionImportResult;
});

/** Extract the native session ID from a provider cursor, ignoring bindings without one. */
function bindingSessionId(
  binding: ProviderSessionDirectory.ProviderRuntimeBinding,
): string | undefined {
  if (!Predicate.isObject(binding.resumeCursor)) return undefined;
  const id =
    binding.provider === "claudeAgent"
      ? binding.resumeCursor.resume
      : binding.resumeCursor.threadId;
  return typeof id === "string" ? id : undefined;
}

/**
 * A T3 thread holding a native session. Open threads own it, archived threads
 * keep it until reopened, and an import that stopped before publishing its
 * history can be retried.
 */
interface SessionClaim {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly state: "open" | "archived" | "unfinishedImport";
}

/**
 * Claims keyed by `agentSessionKey`. Deleting a thread keeps its binding, but
 * releases the session so it can be resumed again.
 */
const readSessionClaims = Effect.gen(function* () {
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const bindings = yield* directory.listBindings();
  const threads = yield* snapshots.getProviderBoundThreads();
  const threadById = new Map(threads.map((thread) => [thread.threadId, thread]));
  const claims = new Map<string, Array<SessionClaim>>();
  for (const binding of bindings) {
    const sessionId = bindingSessionId(binding);
    const thread = threadById.get(binding.threadId);
    if (sessionId === undefined || thread === undefined || !binding.providerInstanceId) continue;
    const key = AgentSessionScanner.agentSessionKey(
      binding.provider,
      binding.providerInstanceId,
      sessionId,
    );
    const state = thread.archived
      ? "archived"
      : isImportedAgentSessionThreadId(thread.threadId) && !thread.importedHistory
        ? "unfinishedImport"
        : "open";
    claims.set(key, [
      ...(claims.get(key) ?? []),
      { threadId: thread.threadId, projectId: thread.projectId, state },
    ]);
  }
  return claims;
});

/**
 * List external sessions not held by a T3 thread. This project's unfinished
 * imports remain eligible so the user can retry them.
 */
export const listAgentSessions = Effect.fn("listAgentSessions")(function* (
  input: AgentSessionListInput,
) {
  const project = yield* readSessionProject(input.projectId);
  const scanner = yield* AgentSessionScanner.AgentSessionScanner;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const importedSources = yield* snapshots
    .getImportedAgentSessionSources(input.projectId)
    .pipe(Effect.mapError(readProjectsFailed));
  const excludedSessions = new Set(
    importedSources.map(({ source }) =>
      AgentSessionScanner.agentSessionKey(
        source.provider,
        source.providerInstanceId,
        source.providerSessionId,
      ),
    ),
  );
  const claims = yield* readSessionClaims.pipe(Effect.mapError(readProjectsFailed));
  // Only this project's unfinished imports stay listed, so they can be retried.
  for (const [key, holders] of claims)
    if (
      holders.some(
        (claim) => claim.state !== "unfinishedImport" || claim.projectId !== input.projectId,
      )
    )
      excludedSessions.add(key);
  return yield* scanner.listSessions(project.workspaceRoot, excludedSessions);
});

/** Attachment never starts a provider process or sends a prompt. */
export const attachAgentSession = Effect.fn("attachAgentSession")(function* (
  input: AgentSessionAttachInput,
) {
  const project = yield* readSessionProject(input.projectId);
  const scanner = yield* AgentSessionScanner.AgentSessionScanner;
  const selected = yield* scanner.readSession(
    project.workspaceRoot,
    input.providerInstanceId,
    input.sessionId,
  );
  const claims = yield* readSessionClaims.pipe(
    Effect.mapError(
      () =>
        new AgentSessionResumeError({
          message: "Could not check whether this session is already open.",
        }),
    ),
  );
  // Native T3 threads and imported threads share the provider's session identity.
  // An open thread wins even in another project: a second thread would fork the
  // same provider session.
  const holders =
    claims.get(
      AgentSessionScanner.agentSessionKey(
        selected.thread.source,
        input.providerInstanceId,
        input.sessionId,
      ),
    ) ?? [];
  const open = holders.find((claim) => claim.state === "open");
  if (open) return { threadId: open.threadId };
  if (holders.some((claim) => claim.state === "archived"))
    return yield* new AgentSessionResumeError({
      message:
        "This session already belongs to an archived T3 thread. Reopen that thread to continue.",
    });
  const threadId = yield* importAgentThread({
    projectId: input.projectId,
    workspaceRoot: selected.session.cwd,
    worktreePath: selected.isProjectRoot ? null : selected.session.cwd,
    branch: selected.session.branch,
    thread: { ...selected.thread, title: selected.session.title },
    source: selected.source,
  }).pipe(Effect.mapError((cause) => new AgentSessionResumeError({ message: cause.message })));
  return { threadId };
});
