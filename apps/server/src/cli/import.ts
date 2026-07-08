import {
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  defaultInstanceIdForDriver,
  type IsoDateTime,
  MessageId,
  type ModelSelection,
  type OrchestrationReadModel,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { Argument, Command, Flag, GlobalFlag } from "effect/unstable/cli";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import {
  isNonConversationalTitle,
  parseClaudeTranscript,
  type ParsedClaudeSession,
} from "../import/claudeTranscript.ts";
import {
  buildOwnedSessionIdMap,
  detectForkCopy,
  isRalphSession,
  planThreadSync,
  type ResumeBindingView,
} from "../import/syncPlan.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer.ts";
import { layerConfig as SqlitePersistenceLayerLive } from "../persistence/Layers/Sqlite.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../persistence/Layers/ProviderSessionRuntime.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import { ProviderSessionDirectoryLive } from "../provider/Layers/ProviderSessionDirectory.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ServerSettings from "../serverSettings.ts";
import { expandHomePath } from "../os-jank.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

const CLAUDE_DRIVER_KIND = ProviderDriverKind.make("claudeAgent");
const CLAUDE_ADAPTER_KEY = "claudeAgent";

const decodeUnknownJsonStringExit = Schema.decodeUnknownExit(Schema.UnknownFromJsonString);

class ImportCommandError extends Data.TaggedError("ImportCommandError")<{
  readonly message: string;
}> {}

/**
 * Offline runtime for `t3 import`. Mirrors `ProjectCliRuntimeLive`
 * (orchestration engine + projection snapshot + sqlite + workspace paths)
 * and additionally provides the provider session directory (so we can seed
 * the resume binding) and server settings (so we can resolve the Claude
 * provider instance). `FileSystem`, `Path`, and `Crypto` are satisfied by the
 * ambient CLI runtime layer (NodeServices) provided in `bin.ts`.
 */
const ImportCliRuntimeLive = Layer.mergeAll(
  WorkspacePaths.layer,
  ServerSettings.layer.pipe(Layer.provide(ServerSecretStore.layer)),
  ProviderSessionDirectoryLive.pipe(Layer.provide(ProviderSessionRuntimeRepositoryLive)),
  OrchestrationLayerLive,
).pipe(
  Layer.provideMerge(RepositoryIdentityResolver.layer),
  Layer.provideMerge(SqlitePersistenceLayerLive),
);

const claudeModel = DEFAULT_MODEL_BY_PROVIDER[CLAUDE_DRIVER_KIND] ?? "claude-sonnet-5";

const claudeUuid = Crypto.Crypto.pipe(
  Effect.flatMap((crypto) => crypto.randomUUIDv4),
  Effect.mapError(() => new ImportCommandError({ message: "Failed to generate an identifier." })),
);

/**
 * Resolve the transcript file. The positional argument is either a path to a
 * `.jsonl` file or a Claude session id; for the latter we glob
 * `~/.claude/projects/*​/<id>.jsonl`.
 */
const resolveTranscript = Effect.fn("resolveTranscript")(function* (sessionArg: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const trimmed = sessionArg.trim();
  if (trimmed.length === 0) {
    return yield* new ImportCommandError({ message: "Session argument cannot be empty." });
  }

  // Treat the argument as a direct file path first.
  const asPathExists = yield* fs.exists(trimmed).pipe(Effect.orElseSucceed(() => false));
  if (asPathExists) {
    const content = yield* fs.readFileString(trimmed).pipe(
      Effect.mapError(
        (cause) =>
          new ImportCommandError({
            message: `Failed to read transcript '${trimmed}': ${String(cause)}.`,
          }),
      ),
    );
    const base = path.basename(trimmed);
    const sessionIdFromFilename = base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : base;
    return { content, sessionIdFromFilename };
  }

  // Otherwise treat the argument as a session id and search the Claude
  // projects directories: ~/.claude/projects/<encoded-cwd>/<id>.jsonl
  const projectsRoot = yield* expandHomePath("~/.claude/projects");
  const projectDirs = yield* fs
    .readDirectory(projectsRoot)
    .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));

  const fileName = `${trimmed}.jsonl`;
  for (const dir of projectDirs) {
    const candidate = path.join(projectsRoot, dir, fileName);
    const exists = yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false));
    if (exists) {
      const content = yield* fs.readFileString(candidate).pipe(
        Effect.mapError(
          (cause) =>
            new ImportCommandError({
              message: `Failed to read transcript '${candidate}': ${String(cause)}.`,
            }),
        ),
      );
      return { content, sessionIdFromFilename: trimmed };
    }
  }

  return yield* new ImportCommandError({
    message:
      `Could not find a Claude transcript for '${trimmed}'. Pass a path to a .jsonl file ` +
      `or a session id present under ${projectsRoot}/*/.`,
  });
});

/**
 * Resolve the Claude provider instance id to use for the imported thread and
 * its resume binding.
 */
const resolveClaudeInstanceId = Effect.fn("resolveClaudeInstanceId")(function* (
  explicitInstance: Option.Option<string>,
) {
  const settings = yield* ServerSettings.ServerSettingsService;
  const current = yield* settings.getSettings.pipe(
    Effect.mapError(
      (cause) =>
        new ImportCommandError({
          message: `Failed to read server settings: ${String(cause)}.`,
        }),
    ),
  );

  const claudeInstanceIds = Object.entries(current.providerInstances)
    .filter(([, config]) => config.driver === CLAUDE_DRIVER_KIND)
    .map(([id]) => ProviderInstanceId.make(id));

  if (Option.isSome(explicitInstance)) {
    const requested = ProviderInstanceId.make(explicitInstance.value.trim());
    const exists = claudeInstanceIds.some((id) => id === requested);
    // Accept the canonical default even if it is not materialized in
    // providerInstances (it is hydrated implicitly from legacy settings).
    if (!exists && requested !== defaultInstanceIdForDriver(CLAUDE_DRIVER_KIND)) {
      return yield* new ImportCommandError({
        message: `--instance '${requested}' is not a configured claudeAgent provider instance.`,
      });
    }
    return requested;
  }

  if (claudeInstanceIds.length === 1) {
    return claudeInstanceIds[0]!;
  }
  if (claudeInstanceIds.length === 0) {
    // Fall back to the canonical default; the registry hydrates this from
    // legacy `settings.providers.claudeAgent`.
    return defaultInstanceIdForDriver(CLAUDE_DRIVER_KIND);
  }

  return yield* new ImportCommandError({
    message:
      "Multiple claudeAgent provider instances are configured. " +
      `Pass --instance with one of: ${claudeInstanceIds.join(", ")}.`,
  });
});

/**
 * Deletion-tombstone source: every thread stream id that EVER received an
 * event, straight from the event log. The projection row for a deleted thread
 * normally survives with `deletedAt` set (and `planThreadSync` skips it), but
 * if the row is ever purged or a rebuild drops it, the projection alone would
 * make the session look never-imported and the sync would resurrect it. The
 * event log is append-only, so stream existence is a permanent tombstone.
 */
const loadEverExistingThreadStreamIds = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`
    SELECT DISTINCT stream_id AS streamId
    FROM orchestration_events
    WHERE aggregate_kind = 'thread'
  `.pipe(
    Effect.mapError(
      (cause) =>
        new ImportCommandError({
          message: `Failed to read thread streams from the event log: ${String(cause)}.`,
        }),
    ),
  );
  const ids = new Set<string>();
  for (const row of rows) {
    const value = (row as Record<string, unknown>)["streamId"];
    if (typeof value === "string") ids.add(value);
  }
  return ids as ReadonlySet<string>;
});

/**
 * Owned-session guard source: every resume binding in
 * `provider_session_runtime`, so the importer can skip transcripts whose
 * session id is already owned by another thread — see `buildOwnedSessionIdMap`
 * for why importing those would duplicate conversations T3 already has.
 */
const loadOwnedSessionIds = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`
    SELECT thread_id AS threadId, resume_cursor_json AS resumeCursorJson
    FROM provider_session_runtime
  `.pipe(
    Effect.mapError(
      (cause) =>
        new ImportCommandError({
          message: `Failed to read provider session bindings: ${String(cause)}.`,
        }),
    ),
  );
  const bindings: Array<ResumeBindingView> = [];
  for (const row of rows) {
    const record = row as Record<string, unknown>;
    const threadId = record["threadId"];
    if (typeof threadId !== "string") continue;
    const cursorJson = record["resumeCursorJson"];
    let resumeSessionId: string | null = null;
    if (typeof cursorJson === "string") {
      // An unparseable cursor owns nothing.
      const decoded = decodeUnknownJsonStringExit(cursorJson);
      const cursor = Exit.isSuccess(decoded) ? decoded.value : null;
      if (cursor !== null && typeof cursor === "object" && !Array.isArray(cursor)) {
        const { resume, sessionId } = cursor as { resume?: unknown; sessionId?: unknown };
        resumeSessionId =
          typeof resume === "string" ? resume : typeof sessionId === "string" ? sessionId : null;
      }
    }
    bindings.push({ threadId, resumeSessionId });
  }
  return buildOwnedSessionIdMap(bindings);
});

/**
 * Index of every message id in the read model -> owning thread id. Imported
 * messages use transcript uuids as ids, so a fork-copy transcript's uuids
 * collide with the already-imported original (see `detectForkCopy`).
 */
function buildMessageOwnerIndex(snapshot: OrchestrationReadModel): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  for (const thread of snapshot.threads) {
    for (const message of thread.messages) {
      index.set(message.id, thread.id);
    }
  }
  return index;
}

/** Outcome of a create-or-incremental-update pass for one session. */
type SyncOutcome =
  | {
      readonly kind: "created";
      readonly threadId: ThreadId;
      readonly projectId: ProjectId;
      readonly workspaceRoot: string;
      readonly imported: number;
      readonly reusedProject: boolean;
    }
  | { readonly kind: "updated"; readonly threadId: ThreadId; readonly appended: number }
  | { readonly kind: "unchanged"; readonly threadId: ThreadId }
  | { readonly kind: "skipped-deleted"; readonly threadId: ThreadId }
  | { readonly kind: "skipped-forked"; readonly threadId: ThreadId; readonly reason: string }
  | { readonly kind: "skipped-owned"; readonly ownerThreadId: string }
  | {
      readonly kind: "skipped-copy";
      readonly ownerThreadId: string;
      readonly sharedRatio: number;
    };

/**
 * Create-or-incrementally-update the T3 thread mirroring a Claude session.
 *
 * Imported messages use the transcript entry uuid as their message id, so the
 * incremental pass appends exactly the transcript messages whose uuids are not
 * on the thread yet (command receipts additionally dedupe on replay).
 *
 * Fork-safety: if the thread has been continued inside T3 (provider turns, or
 * messages the transcript cannot explain), it is skipped permanently — see
 * `planThreadSync`.
 *
 * `projectOverlay` maps workspaceRoot -> ProjectId for projects created during
 * this process run (the snapshot is read once and not refreshed mid-batch).
 */
const syncSession = Effect.fn("syncSession")(function* (input: {
  readonly session: ParsedClaudeSession;
  readonly instanceId: ProviderInstanceId;
  readonly snapshot: OrchestrationReadModel;
  /** Thread stream ids that ever existed in the event log (tombstones). */
  readonly everExistingThreadStreamIds: ReadonlySet<string>;
  /** Session ids owned by another thread's resume binding: sessionId -> threadId. */
  readonly ownedSessionIds: ReadonlyMap<string, string>;
  /** Already-imported message ids (transcript uuids) -> owning thread id. */
  readonly messageOwnerIndex: ReadonlyMap<string, string>;
  readonly projectOverlay?: Map<string, ProjectId>;
}) {
  const {
    session,
    instanceId,
    snapshot,
    everExistingThreadStreamIds,
    ownedSessionIds,
    messageOwnerIndex,
    projectOverlay,
  } = input;
  const path = yield* Path.Path;

  const cwd = session.cwd;
  if (cwd === null || cwd.trim().length === 0) {
    return yield* new ImportCommandError({
      message:
        "The transcript has no working directory (cwd); cannot create a project for the import.",
    });
  }
  const workspaceRoot = cwd.trim();

  if (session.sessionId.trim().length === 0) {
    return yield* new ImportCommandError({
      message: "The transcript has no session id and none could be derived from the filename.",
    });
  }
  const sessionId = session.sessionId.trim();

  // Owned-session guard: this transcript belongs to a session T3 itself
  // produced (a native thread's session, or the forkSession target of a
  // continued import). Importing it would duplicate an existing conversation.
  const ownerThreadId = ownedSessionIds.get(sessionId);
  if (ownerThreadId !== undefined) {
    return { kind: "skipped-owned", ownerThreadId } satisfies SyncOutcome;
  }

  const modelSelection: ModelSelection = {
    instanceId,
    model: claudeModel,
  };

  const nowIso = DateTime.formatIso(yield* DateTime.now);
  const projectCreatedAt: IsoDateTime = session.startedAt ?? nowIso;
  const threadCreatedAt: IsoDateTime = session.startedAt ?? nowIso;

  // Deterministic ids so re-import dedupes via command receipts.
  const threadId = ThreadId.make(`claude-import-${sessionId}`);

  const existingThread = snapshot.threads.find((thread) => thread.id === threadId);
  const plan = planThreadSync({
    session,
    existingThread: existingThread
      ? {
          deletedAt: existingThread.deletedAt,
          hasTurns: existingThread.latestTurn !== null,
          messages: existingThread.messages.map((message) => ({
            id: message.id,
            turnId: message.turnId,
          })),
        }
      : null,
    threadStreamEverExisted: everExistingThreadStreamIds.has(threadId),
  });

  if (plan.kind === "skip-deleted") {
    return { kind: "skipped-deleted", threadId } satisfies SyncOutcome;
  }
  if (plan.kind === "skip-forked") {
    return { kind: "skipped-forked", threadId, reason: plan.reason } satisfies SyncOutcome;
  }
  if (plan.kind === "unchanged") {
    return { kind: "unchanged", threadId } satisfies SyncOutcome;
  }

  // Fork-copy guard (creation only): a transcript whose messages largely
  // already live on another thread is a forkSession copy — importing it
  // would duplicate that thread's conversation.
  if (plan.kind === "create") {
    const copy = detectForkCopy({
      sessionMessages: session.messages,
      threadId,
      messageOwnerIndex,
    });
    if (copy !== null) {
      return {
        kind: "skipped-copy",
        ownerThreadId: copy.ownerThreadId,
        sharedRatio: copy.sharedRatio,
      } satisfies SyncOutcome;
    }
  }

  const engine = yield* OrchestrationEngineService;

  let projectId: ProjectId;
  let reusedProject = true;
  if (plan.kind === "create") {
    // 1. Project: dedupe by workspaceRoot against the snapshot, then against
    // projects created earlier in this run (the snapshot is not refreshed).
    const existingProject = snapshot.projects.find(
      (project) => project.deletedAt === null && project.workspaceRoot === workspaceRoot,
    );
    const overlayProjectId = projectOverlay?.get(workspaceRoot);
    if (existingProject) {
      projectId = existingProject.id;
    } else if (overlayProjectId !== undefined) {
      projectId = overlayProjectId;
    } else {
      reusedProject = false;
      projectId = ProjectId.make(yield* claudeUuid);
      const projectTitle = (() => {
        const base = path.basename(workspaceRoot).trim();
        if (base.length > 0) return base;
        const fromSession = session.title?.trim();
        return fromSession && fromSession.length > 0 ? fromSession : "project";
      })();
      yield* engine
        .dispatch({
          type: "project.create",
          commandId: CommandId.make(`import:${threadId}:project-create`),
          projectId,
          title: projectTitle,
          workspaceRoot,
          defaultModelSelection: modelSelection,
          createdAt: projectCreatedAt,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ImportCommandError({ message: `Failed to create project: ${String(cause)}.` }),
          ),
        );
      projectOverlay?.set(workspaceRoot, projectId);
    }

    // 2. Thread.
    const threadTitle = session.title?.trim();
    yield* engine
      .dispatch({
        type: "thread.create",
        commandId: CommandId.make(`import:${threadId}:thread-create`),
        threadId,
        projectId,
        title: threadTitle && threadTitle.length > 0 ? threadTitle : "Imported Claude session",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: session.gitBranch,
        worktreePath: null,
        createdAt: threadCreatedAt,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ImportCommandError({ message: `Failed to create thread: ${String(cause)}.` }),
        ),
      );
  } else {
    projectId = existingThread!.projectId;
  }

  // 3. Messages, chronological, backdated. On an incremental pass this is
  // only the transcript messages that are not on the thread yet.
  const messagesToImport = plan.kind === "create" ? plan.messages : plan.newMessages;
  let imported = 0;
  for (const message of messagesToImport) {
    const createdAt: IsoDateTime =
      message.timestamp.trim().length > 0 ? message.timestamp : threadCreatedAt;
    yield* engine
      .dispatch({
        type: "thread.message.import",
        commandId: CommandId.make(`import:${threadId}:msg:${message.uuid}`),
        threadId,
        messageId: MessageId.make(message.uuid),
        role: message.role,
        text: message.text,
        turnId: null,
        createdAt,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ImportCommandError({
              message: `Failed to import message ${message.uuid}: ${String(cause)}.`,
            }),
        ),
      );
    imported += 1;
  }

  // 4. Seed the resume binding. Resume is driven by this binding's
  // resumeCursor; providerInstanceId MUST equal the thread's modelSelection
  // instanceId. forkSession ensures continuing forks to a new transcript.
  const directory = yield* ProviderSessionDirectory;
  yield* directory
    .upsert({
      threadId,
      provider: CLAUDE_DRIVER_KIND,
      providerInstanceId: instanceId,
      adapterKey: CLAUDE_ADAPTER_KEY,
      runtimeMode: "full-access",
      status: "stopped",
      resumeCursor: { resume: sessionId, forkSession: true },
      runtimePayload: {
        cwd: workspaceRoot,
        model: claudeModel,
        activeTurnId: null,
        lastError: null,
        modelSelection,
      },
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new ImportCommandError({
            message: `Failed to seed resume binding: ${String(cause)}.`,
          }),
      ),
    );

  if (plan.kind === "append") {
    return { kind: "updated", threadId, appended: imported } satisfies SyncOutcome;
  }
  return {
    kind: "created",
    threadId,
    projectId,
    workspaceRoot,
    imported,
    reusedProject,
  } satisfies SyncOutcome;
});

const instanceFlag = Flag.string("instance").pipe(
  Flag.withDescription("claudeAgent provider instance id to attribute the imported thread to."),
  Flag.optional,
);

const importClaudeCommand = Command.make("claude", {
  ...projectLocationFlags,
  instance: instanceFlag,
  session: Argument.string("session").pipe(
    Argument.withDescription(
      "Path to a Claude transcript .jsonl file, or a Claude session id to locate under ~/.claude/projects.",
    ),
  ),
}).pipe(
  Command.withDescription(
    "Import an existing Claude Code conversation transcript as a resumable T3 thread.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveCliAuthConfig({ baseDir: flags.baseDir }, logLevel);
      const minimumLogLevel = config.logLevel;

      const transcript = yield* resolveTranscript(flags.session);
      const session = parseClaudeTranscript(transcript.content, {
        sessionIdFromFilename: transcript.sessionIdFromFilename,
      });

      const result = yield* Effect.gen(function* () {
        const instanceId = yield* resolveClaudeInstanceId(flags.instance);
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const snapshot = yield* snapshotQuery.getSnapshot().pipe(
          Effect.mapError(
            (cause) =>
              new ImportCommandError({
                message: `Failed to read orchestration snapshot: ${String(cause)}.`,
              }),
          ),
        );
        const everExistingThreadStreamIds = yield* loadEverExistingThreadStreamIds;
        const ownedSessionIds = yield* loadOwnedSessionIds;
        const messageOwnerIndex = buildMessageOwnerIndex(snapshot);
        return yield* syncSession({
          session,
          instanceId,
          snapshot,
          everExistingThreadStreamIds,
          ownedSessionIds,
          messageOwnerIndex,
        });
      }).pipe(
        Effect.provide(
          ImportCliRuntimeLive.pipe(
            Layer.provide(ServerConfig.layer(config)),
            Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
          ),
        ),
      );

      switch (result.kind) {
        case "created":
          yield* Console.log(
            [
              `Imported Claude session ${session.sessionId}.`,
              `  thread:   ${result.threadId}`,
              `  project:  ${result.projectId} (${result.reusedProject ? "reused" : "created"}) at ${result.workspaceRoot}`,
              `  messages: ${result.imported} imported`,
              `  resume:   wired (forkSession on — continuing forks a new Claude transcript)`,
            ].join("\n"),
          );
          break;
        case "updated":
          yield* Console.log(
            [
              `Updated Claude session ${session.sessionId}.`,
              `  thread:   ${result.threadId}`,
              `  messages: ${result.appended} appended`,
            ].join("\n"),
          );
          break;
        case "unchanged":
          yield* Console.log(
            `Claude session ${session.sessionId} is already up to date (thread ${result.threadId}); nothing to import.`,
          );
          break;
        case "skipped-deleted":
          yield* Console.log(
            `Skipped Claude session ${session.sessionId}: thread ${result.threadId} was deleted in T3.`,
          );
          break;
        case "skipped-forked":
          yield* Console.log(
            `Skipped Claude session ${session.sessionId}: thread ${result.threadId} was continued in T3 (${result.reason}). ` +
              `Incremental updates are permanently disabled for this thread to avoid corrupting it.`,
          );
          break;
        case "skipped-owned":
          yield* Console.log(
            `Skipped Claude session ${session.sessionId}: it already belongs to T3 thread ${result.ownerThreadId} ` +
              `(the session was produced by T3 itself; importing it would duplicate that conversation).`,
          );
          break;
        case "skipped-copy":
          yield* Console.log(
            `Skipped Claude session ${session.sessionId}: it is a fork copy of thread ${result.ownerThreadId} ` +
              `(${Math.round(result.sharedRatio * 100)}% of its messages are already on that thread).`,
          );
          break;
      }
    }),
  ),
);

const projectsDirFlag = Flag.string("projects-dir").pipe(
  Flag.withDescription(
    "Directory containing Claude project transcript folders (defaults to ~/.claude/projects).",
  ),
  Flag.optional,
);

const includeRalphFlag = Flag.boolean("include-ralph").pipe(
  Flag.withDescription(
    "Also sync ralph harness transcripts (generator/evaluator/rescue agent runs), which are excluded by default.",
  ),
);

interface SyncCounters {
  created: number;
  updated: number;
  appended: number;
  unchanged: number;
  skippedForked: number;
  skippedRalph: number;
  skippedEmpty: number;
  skippedDeleted: number;
  skippedOwned: number;
  skippedWorktree: number;
  skippedCopy: number;
  failed: number;
  total: number;
}

const importSyncCommand = Command.make("sync", {
  ...projectLocationFlags,
  instance: instanceFlag,
  projectsDir: projectsDirFlag,
  includeRalph: includeRalphFlag,
}).pipe(
  Command.withDescription(
    "Scan every Claude transcript under the projects directory and create or incrementally update its T3 thread (single process, fork-safe).",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveCliAuthConfig({ baseDir: flags.baseDir }, logLevel);
      const minimumLogLevel = config.logLevel;

      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const projectsRoot = Option.isSome(flags.projectsDir)
        ? flags.projectsDir.value
        : yield* expandHomePath("~/.claude/projects");

      const worktreesRootPrefix = config.worktreesDir.endsWith(path.sep)
        ? config.worktreesDir
        : `${config.worktreesDir}${path.sep}`;

      const projectDirs = yield* fs
        .readDirectory(projectsRoot)
        .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));

      const transcriptPaths: Array<string> = [];
      for (const dir of projectDirs) {
        const dirPath = path.join(projectsRoot, dir);
        const entries = yield* fs
          .readDirectory(dirPath)
          .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
        for (const entry of entries) {
          if (entry.endsWith(".jsonl")) {
            transcriptPaths.push(path.join(dirPath, entry));
          }
        }
      }
      transcriptPaths.sort();

      const counters: SyncCounters = {
        created: 0,
        updated: 0,
        appended: 0,
        unchanged: 0,
        skippedForked: 0,
        skippedRalph: 0,
        skippedEmpty: 0,
        skippedDeleted: 0,
        skippedOwned: 0,
        skippedWorktree: 0,
        skippedCopy: 0,
        failed: 0,
        total: 0,
      };

      yield* Effect.gen(function* () {
        const instanceId = yield* resolveClaudeInstanceId(flags.instance);
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const snapshot = yield* snapshotQuery.getSnapshot().pipe(
          Effect.mapError(
            (cause) =>
              new ImportCommandError({
                message: `Failed to read orchestration snapshot: ${String(cause)}.`,
              }),
          ),
        );

        const everExistingThreadStreamIds = yield* loadEverExistingThreadStreamIds;
        const ownedSessionIds = yield* loadOwnedSessionIds;
        const messageOwnerIndex = buildMessageOwnerIndex(snapshot);
        const projectOverlay = new Map<string, ProjectId>();
        const seenSessionIds = new Set<string>();

        for (const transcriptPath of transcriptPaths) {
          counters.total += 1;
          const base = path.basename(transcriptPath);
          const sessionIdFromFilename = base.endsWith(".jsonl")
            ? base.slice(0, -".jsonl".length)
            : base;

          const content = yield* fs
            .readFileString(transcriptPath)
            .pipe(Effect.orElseSucceed(() => null));
          if (content === null) {
            counters.failed += 1;
            yield* Console.log(`failed sessionId=${sessionIdFromFilename} error=unreadable-file`);
            continue;
          }

          const session = parseClaudeTranscript(content, { sessionIdFromFilename });
          const sessionId = session.sessionId.trim();

          if (
            sessionId.length === 0 ||
            session.messages.length === 0 ||
            session.cwd === null ||
            session.cwd.trim().length === 0
          ) {
            counters.skippedEmpty += 1;
            yield* Console.log(`skipped-empty sessionId=${sessionIdFromFilename}`);
            continue;
          }

          if (seenSessionIds.has(sessionId)) {
            counters.skippedEmpty += 1;
            yield* Console.log(`skipped-duplicate sessionId=${sessionId} path=${transcriptPath}`);
            continue;
          }
          seenSessionIds.add(sessionId);

          // Sessions running inside a T3-managed worktree can only have been
          // spawned by T3 itself; importing them would duplicate native
          // threads. This also covers T3 sessions whose resume cursor has
          // moved past this session id (so the owned-session guard misses).
          const cwdTrimmed = session.cwd!.trim();
          if (cwdTrimmed === config.worktreesDir || cwdTrimmed.startsWith(worktreesRootPrefix)) {
            counters.skippedWorktree += 1;
            yield* Console.log(`skipped-worktree sessionId=${sessionId} cwd=${cwdTrimmed}`);
            continue;
          }

          if (!flags.includeRalph && isRalphSession(session)) {
            counters.skippedRalph += 1;
            yield* Console.log(`skipped-ralph sessionId=${sessionId}`);
            continue;
          }

          const outcome = yield* Effect.result(
            syncSession({
              session,
              instanceId,
              snapshot,
              everExistingThreadStreamIds,
              ownedSessionIds,
              messageOwnerIndex,
              projectOverlay,
            }),
          );

          if (Result.isFailure(outcome)) {
            counters.failed += 1;
            yield* Console.log(`failed sessionId=${sessionId} error=${outcome.failure.message}`);
            continue;
          }

          const result = outcome.success;
          switch (result.kind) {
            case "created":
              counters.created += 1;
              yield* Console.log(`created sessionId=${sessionId} messages=${result.imported}`);
              break;
            case "updated":
              counters.updated += 1;
              counters.appended += result.appended;
              yield* Console.log(`updated sessionId=${sessionId} appended=${result.appended}`);
              break;
            case "unchanged":
              counters.unchanged += 1;
              yield* Console.log(`unchanged sessionId=${sessionId}`);
              break;
            case "skipped-deleted":
              counters.skippedDeleted += 1;
              yield* Console.log(`skipped-deleted sessionId=${sessionId}`);
              break;
            case "skipped-forked":
              counters.skippedForked += 1;
              yield* Console.log(`skipped-forked sessionId=${sessionId} reason=${result.reason}`);
              break;
            case "skipped-owned":
              counters.skippedOwned += 1;
              yield* Console.log(
                `skipped-owned sessionId=${sessionId} ownerThreadId=${result.ownerThreadId}`,
              );
              break;
            case "skipped-copy":
              counters.skippedCopy += 1;
              yield* Console.log(
                `skipped-copy sessionId=${sessionId} ownerThreadId=${result.ownerThreadId} ` +
                  `shared=${Math.round(result.sharedRatio * 100)}%`,
              );
              break;
          }
        }
      }).pipe(
        Effect.provide(
          ImportCliRuntimeLive.pipe(
            Layer.provide(ServerConfig.layer(config)),
            Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
          ),
        ),
      );

      yield* Console.log(
        `summary created=${counters.created} updated=${counters.updated} appended=${counters.appended} ` +
          `unchanged=${counters.unchanged} skipped-forked=${counters.skippedForked} ` +
          `skipped-ralph=${counters.skippedRalph} skipped-empty=${counters.skippedEmpty} ` +
          `skipped-deleted=${counters.skippedDeleted} skipped-owned=${counters.skippedOwned} ` +
          `skipped-worktree=${counters.skippedWorktree} skipped-copy=${counters.skippedCopy} ` +
          `failed=${counters.failed} total=${counters.total}`,
      );
    }),
  ),
);

const dryRunFlag = Flag.boolean("dry-run").pipe(
  Flag.withDescription("Print the planned title changes without dispatching any commands."),
);

const IMPORTED_THREAD_ID_PREFIX = "claude-import-";
const IMPORTED_THREAD_FALLBACK_TITLE = "Imported Claude session";

/** Small stable hash so re-running with the same computed title dedupes. */
function titleFingerprint(title: string): string {
  let hash = 5381;
  for (let i = 0; i < title.length; i += 1) {
    hash = ((hash << 5) + hash + title.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

const importRetitleCommand = Command.make("retitle", {
  ...projectLocationFlags,
  dryRun: dryRunFlag,
}).pipe(
  Command.withDescription(
    "Recompute titles for imported Claude threads whose current title is non-conversational " +
      "junk (slash-command receipts, local-command stdout, caveats, system reminders).",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveCliAuthConfig({ baseDir: flags.baseDir }, logLevel);
      const minimumLogLevel = config.logLevel;

      const counters = { junk: 0, retitled: 0, fallback: 0, missingTranscript: 0, failed: 0 };

      yield* Effect.gen(function* () {
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const snapshot = yield* snapshotQuery.getSnapshot().pipe(
          Effect.mapError(
            (cause) =>
              new ImportCommandError({
                message: `Failed to read orchestration snapshot: ${String(cause)}.`,
              }),
          ),
        );
        const engine = yield* OrchestrationEngineService;

        for (const thread of snapshot.threads) {
          if (!thread.id.startsWith(IMPORTED_THREAD_ID_PREFIX)) continue;
          if (thread.deletedAt !== null) continue;
          if (!isNonConversationalTitle(thread.title)) continue;
          counters.junk += 1;

          const sessionId = thread.id.slice(IMPORTED_THREAD_ID_PREFIX.length);
          const transcript = yield* Effect.result(resolveTranscript(sessionId));
          let newTitle: string;
          if (Result.isSuccess(transcript)) {
            const parsed = parseClaudeTranscript(transcript.success.content, {
              sessionIdFromFilename: sessionId,
            });
            const fromTranscript = parsed.title?.trim();
            newTitle =
              fromTranscript && fromTranscript.length > 0
                ? fromTranscript
                : IMPORTED_THREAD_FALLBACK_TITLE;
          } else {
            counters.missingTranscript += 1;
            newTitle = IMPORTED_THREAD_FALLBACK_TITLE;
          }
          if (newTitle === IMPORTED_THREAD_FALLBACK_TITLE) counters.fallback += 1;
          if (newTitle === thread.title) continue;

          const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();
          yield* Console.log(
            `retitle threadId=${thread.id}${flags.dryRun ? " (dry-run)" : ""}\n` +
              `  old: '${oneLine(thread.title)}'\n` +
              `  new: '${oneLine(newTitle)}'`,
          );
          if (flags.dryRun) continue;

          const outcome = yield* Effect.result(
            engine
              .dispatch({
                type: "thread.meta.update",
                commandId: CommandId.make(
                  `import:${thread.id}:retitle:${titleFingerprint(newTitle)}`,
                ),
                threadId: thread.id,
                title: newTitle,
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new ImportCommandError({
                      message: `Failed to retitle thread ${thread.id}: ${String(cause)}.`,
                    }),
                ),
              ),
          );
          if (Result.isFailure(outcome)) {
            counters.failed += 1;
            yield* Console.log(`failed threadId=${thread.id} error=${outcome.failure.message}`);
            continue;
          }
          counters.retitled += 1;
        }
      }).pipe(
        Effect.provide(
          ImportCliRuntimeLive.pipe(
            Layer.provide(ServerConfig.layer(config)),
            Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
          ),
        ),
      );

      yield* Console.log(
        `summary junk-titled=${counters.junk} retitled=${counters.retitled} ` +
          `fallback-titled=${counters.fallback} missing-transcript=${counters.missingTranscript} ` +
          `failed=${counters.failed}${flags.dryRun ? " (dry-run: nothing dispatched)" : ""}`,
      );
    }),
  ),
);

export const importCommand = Command.make("import").pipe(
  Command.withDescription("Import conversations from other coding agents into T3."),
  Command.withSubcommands([importClaudeCommand, importSyncCommand, importRetitleCommand]),
);
