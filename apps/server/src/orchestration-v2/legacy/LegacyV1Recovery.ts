// @effect-diagnostics nodeBuiltinImport:off -- SQLite's backup API creates consistent copies without opening either input read-write.
import * as NodeCrypto from "node:crypto";
import * as NodeSqlite from "node:sqlite";

import {
  ChatAttachment,
  CommandId,
  EventId,
  IsoDateTime,
  ModelSelection,
  OrchestrationMessageContext,
  OrchestrationV2AppThreadJson,
  ProjectId,
  ProjectIconOverride,
  ThreadEnvMode,
  ProjectScript,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqlitePersistence from "../../persistence/Layers/Sqlite.ts";
import * as EventSink from "../EventSink.ts";
import * as EventStore from "../EventStore.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as ProjectionMaintenance from "../ProjectionMaintenance.ts";
import * as LegacyImport from "./LegacyV1ThreadImporter.ts";

export class LegacyV1RecoveryError extends Schema.TaggedError<LegacyV1RecoveryError>()(
  "LegacyV1RecoveryError",
  { operation: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message() {
    return `V1 recovery failed: ${this.operation}. Neither input database has been modified.`;
  }
}

interface RecoveryInput {
  readonly source: string;
  readonly target: string;
  readonly output?: string;
}

interface RecoveryThread {
  readonly sourceThreadId: string;
  readonly targetThreadId: string;
  readonly title: string;
  readonly action: "import" | "append" | "copy";
  readonly reason: string;
  readonly messageCount: number;
}

interface RecoveryReport {
  readonly source: string;
  readonly target: string;
  readonly output: string | null;
  readonly threads: ReadonlyArray<RecoveryThread>;
  readonly importedProjects: number;
  readonly skippedDeletedThreads: number;
  readonly excludedReasoningMessages: number;
  readonly excludedOtherMessages: number;
  readonly warnings: ReadonlyArray<string>;
}

export class LegacyV1Recovery extends Context.Service<
  LegacyV1Recovery,
  {
    readonly recover: (
      input: RecoveryInput,
    ) => Effect.Effect<RecoveryReport, LegacyV1RecoveryError>;
  }
>()("t3/orchestration-v2/legacy/LegacyV1Recovery") {}

interface ProjectRow {
  readonly project_id: string;
  readonly title: string;
  readonly workspace_root: string;
  readonly scripts_json: string;
  readonly default_model_selection_json: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly deleted_at: string | null;
  readonly default_thread_env_mode: string | null;
  readonly auto_pull: number;
  readonly favicon_path: string | null;
  readonly project_icon_json: string | null;
}

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const decodeAttachments = Schema.decodeEffect(Schema.fromJsonString(Schema.Array(ChatAttachment)));
const decodeContext = Schema.decodeEffect(Schema.fromJsonString(OrchestrationMessageContext));
const decodeModelSelection = Schema.decodeEffect(Schema.fromJsonString(ModelSelection));
const decodeScripts = Schema.decodeEffect(Schema.fromJsonString(Schema.Array(ProjectScript)));
const decodeProjectIcon = Schema.decodeEffect(Schema.fromJsonString(ProjectIconOverride));
const decodeThreadEnvMode = Schema.decodeUnknownEffect(Schema.NullOr(ThreadEnvMode));
const decodeThread = Schema.decodeEffect(Schema.fromJsonString(OrchestrationV2AppThreadJson));
const decodeTimestamp = Schema.decodeEffect(IsoDateTime);
const isRecoveryError = Schema.is(LegacyV1RecoveryError);

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (Predicate.isObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalJson(value[key])]),
    );
  }
  return value;
}

function digest(value: unknown): string {
  return NodeCrypto.createHash("sha256")
    .update(encodeJson(canonicalJson(value)))
    .digest("hex");
}

function messageDigest(row: LegacyImport.LegacyMessageRow): string {
  return digest([
    row.role,
    row.text,
    decodeJson(row.attachments_json ?? "[]"),
    decodeJson(row.context_json ?? "null"),
    row.created_at,
  ]);
}

const recoveryStores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer);
const recoveryRuntime = Layer.mergeAll(
  EventSink.layer.pipe(Layer.provide(recoveryStores)),
  ProjectionMaintenance.layer.pipe(Layer.provide(recoveryStores)),
);

const recoverSnapshot = Effect.fn("LegacyV1Recovery.recoverSnapshot")(function* (
  input: RecoveryInput,
  sourceSnapshot: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const sink = yield* EventSink.EventSinkV2;
  const now = DateTime.formatIso(yield* DateTime.now);
  // This attachment is an isolated snapshot, never a live database.
  yield* sql`ATTACH DATABASE ${sourceSnapshot} AS recovery_v1`;
  const version = yield* sql<{ migration_id: number }>`
    SELECT MAX(migration_id) AS migration_id FROM recovery_v1.effect_sql_migrations
  `;
  if ((version[0]?.migration_id ?? 0) < 54) {
    return yield* new LegacyV1RecoveryError({
      operation: "source requires Stable schema 54 or newer",
    });
  }
  const sourceThreads = yield* sql<LegacyImport.LegacyThreadRow>`
    SELECT thread.*,
      (SELECT json_group_array(json_object('host', pr.host, 'repository', pr.repository,
        'number', pr.number, 'url', pr.url, 'source', pr.source, 'linkedAt', pr.linked_at,
        'snapshot', json(pr.snapshot_json), 'stack', json(pr.stack_json)))
       FROM recovery_v1.projection_thread_pull_requests pr
       WHERE pr.thread_id = thread.thread_id) AS pull_requests_json
    FROM recovery_v1.projection_threads thread ORDER BY thread.created_at, thread.thread_id
  `;
  const projects = yield* sql<ProjectRow>`SELECT * FROM recovery_v1.projection_projects`;
  const targetProjects = yield* sql<ProjectRow>`SELECT * FROM projection_projects`;
  const targetProjectMap = new Map(targetProjects.map((row) => [row.project_id, row]));
  const targetThreads = yield* sql<{
    thread_id: string;
    deleted_at: string | null;
    created_at: string;
    payload_json: string;
  }>`
    SELECT thread_id, deleted_at, created_at, payload_json FROM orchestration_v2_projection_threads
  `;
  const targetThreadMap = new Map(targetThreads.map((row) => [row.thread_id, row]));
  const completed = new Set(
    (yield* sql<{ thread_id: string }>`
    SELECT thread_id FROM orchestration_v2_legacy_imports WHERE transcript_imported_at IS NOT NULL
  `).map((row) => row.thread_id),
  );
  const nativeConversationThreads = new Set(
    (yield* sql<{ stream_id: string }>`
    SELECT DISTINCT stream_id FROM orchestration_events
    WHERE application_event_version = 2 AND aggregate_kind = 'thread'
      AND event_id NOT LIKE 'migration:v1:%' AND event_id NOT LIKE 'recovery:v1:%'
      AND (event_type IN ('message.updated', 'turn-item.updated') OR event_type LIKE 'run.%')
  `).map((row) => row.stream_id),
  );
  const messages = yield* sql<LegacyImport.LegacyMessageRow>`
    SELECT *, ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY created_at, message_id) AS ordinal
    FROM recovery_v1.projection_thread_messages WHERE role IN ('user', 'assistant')
    ORDER BY thread_id, created_at, message_id
  `;
  const baselineMessages = yield* sql<LegacyImport.LegacyMessageRow>`
    SELECT * FROM projection_thread_messages WHERE role IN ('user', 'assistant')
  `;
  const targetMessages = yield* sql<LegacyImport.LegacyMessageRow>`
    SELECT message_id, thread_id, role, created_at,
      json_extract(payload_json, '$.text') AS text,
      json_extract(payload_json, '$.attachments') AS attachments_json,
      json_extract(payload_json, '$.context') AS context_json
    FROM orchestration_v2_projection_messages
  `;
  const baseline = new Map(baselineMessages.map((row) => [row.message_id, messageDigest(row)]));
  const current = new Map(
    targetMessages.map((row) => [
      row.message_id,
      {
        threadId: row.thread_id,
        digest: messageDigest(row),
      },
    ]),
  );
  const sourceByThread = new Map<string, LegacyImport.LegacyMessageRow[]>();
  for (const message of messages) {
    const list = sourceByThread.get(message.thread_id) ?? [];
    list.push(message);
    sourceByThread.set(message.thread_id, list);
  }
  const ledgerExists = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'orchestration_v2_v1_recoveries'
  `;
  const recoveries =
    ledgerExists.length === 0
      ? []
      : yield* sql<{ recovery_key: string; source_thread_id: string; target_thread_id: string }>`
    SELECT recovery_key, source_thread_id, target_thread_id FROM orchestration_v2_v1_recoveries
    ORDER BY recovered_at DESC
  `;
  const recovered = new Set(recoveries.map((row) => row.recovery_key));
  const messagesByTarget = new Map<string, LegacyImport.LegacyMessageRow[]>();
  for (const message of targetMessages) {
    const list = messagesByTarget.get(message.thread_id) ?? [];
    list.push(message);
    messagesByTarget.set(message.thread_id, list);
  }
  const excluded = yield* sql<{ role: string; count: number }>`
    SELECT role, COUNT(*) AS count FROM recovery_v1.projection_thread_messages
    WHERE role NOT IN ('user', 'assistant') GROUP BY role
  `;
  const warnings = new Set<string>();
  const operations: Array<{
    row: LegacyImport.LegacyThreadRow;
    messages: LegacyImport.LegacyMessageRow[];
    key: string;
    report: RecoveryThread;
  }> = [];
  let skippedDeletedThreads = 0;
  for (const row of sourceThreads) {
    if (row.deleted_at !== null) {
      skippedDeletedThreads++;
      continue;
    }
    const sourceMessages = sourceByThread.get(row.thread_id) ?? [];
    const key = digest([
      row.thread_id,
      row.project_id,
      row.created_at,
      sourceMessages.map((message) => [message.message_id, messageDigest(message)]),
    ]);
    if (recovered.has(key)) continue;
    const target = targetThreadMap.get(row.thread_id);
    const missing = sourceMessages.filter((message) => {
      const original = baseline.get(message.message_id);
      const present = current.get(message.message_id);
      const hash = messageDigest(message);
      if (present?.threadId === row.thread_id && present.digest === hash) return false;
      // V2 may have edited/removed a baseline message. An unchanged V1 copy is not new work.
      if (target && original === hash && completed.has(row.thread_id)) return false;
      return true;
    });
    if (target && missing.length === 0) continue;
    const changedExisting = sourceMessages.some((message) => {
      const present = current.get(message.message_id);
      return (
        (present !== undefined &&
          (present.threadId !== row.thread_id || present.digest !== messageDigest(message))) ||
        (target !== undefined &&
          baseline.has(message.message_id) &&
          completed.has(row.thread_id) &&
          present === undefined)
      );
    });
    const project = targetProjectMap.get(row.project_id);
    const sourceProject = projects.find((candidate) => candidate.project_id === row.project_id);
    if (!sourceProject)
      return yield* new LegacyV1RecoveryError({
        operation: "missing source project",
      });
    if (project?.deleted_at !== null && project !== undefined) {
      warnings.add(`Skipped thread ${row.thread_id}: its v2 project is deleted.`);
      continue;
    }
    if (project && project.workspace_root !== sourceProject.workspace_root) {
      return yield* new LegacyV1RecoveryError({
        operation: "project identity collision",
      });
    }
    const conflict =
      changedExisting ||
      (target !== undefined &&
        (target.deleted_at !== null ||
          target.created_at !== row.created_at ||
          nativeConversationThreads.has(row.thread_id)));
    let action: RecoveryThread["action"] = conflict
      ? "copy"
      : target === undefined
        ? "import"
        : "append";
    let targetThreadId = action === "copy" ? `recovery-v1-${key}` : row.thread_id;
    let selected = action === "append" ? missing : sourceMessages;
    if (conflict) {
      // Reuse an earlier copy only while every recovered message still matches Stable.
      // Native continuations, edits and deletions keep that copy independent.
      for (const prior of recoveries) {
        if (prior.source_thread_id !== row.thread_id || prior.target_thread_id === row.thread_id)
          continue;
        const copy = targetThreadMap.get(prior.target_thread_id);
        if (
          !copy ||
          copy.deleted_at !== null ||
          copy.created_at !== row.created_at ||
          nativeConversationThreads.has(copy.thread_id)
        )
          continue;
        const prefix = `recovery:v1:message:${copy.thread_id.slice("recovery-v1-".length)}:`;
        const mapped = sourceMessages.map((message) => ({
          ...message,
          thread_id: copy.thread_id,
          message_id: `${prefix}${message.message_id}`,
        }));
        const sourceDigests = new Map(
          mapped.map((message) => [message.message_id, messageDigest(message)]),
        );
        if (
          !(messagesByTarget.get(copy.thread_id) ?? []).every(
            (message) => sourceDigests.get(message.message_id) === messageDigest(message),
          )
        )
          continue;
        action = "append";
        targetThreadId = copy.thread_id;
        selected = mapped.filter((message) => !current.has(message.message_id));
        break;
      }
    }
    if (action === "append" && selected.length === 0) continue;
    if (action === "copy" && targetThreadMap.has(targetThreadId)) {
      return yield* new LegacyV1RecoveryError({
        operation: "recovered thread identity collision",
      });
    }
    for (const message of selected) {
      // The legacy converter tolerates invalid attachment JSON; recovery must not silently drop it.
      yield* decodeAttachments(message.attachments_json ?? "[]");
      if (message.context_json) yield* decodeContext(message.context_json);
    }
    operations.push({
      row,
      messages: selected,
      key,
      report: {
        sourceThreadId: row.thread_id,
        targetThreadId,
        title: row.title,
        action,
        reason:
          action === "copy"
            ? "Conflicting history, deletion state, or message/thread identity"
            : action === "import"
              ? "Thread absent from V2"
              : "Additional V1 transcript",
        messageCount: selected.length,
      },
    });
  }
  const neededProjects = new Set(operations.map((op) => op.row.project_id));
  const newProjects = projects.filter(
    (row) => neededProjects.has(row.project_id) && !targetProjectMap.has(row.project_id),
  );
  for (const project of newProjects) {
    if (project.deleted_at !== null)
      return yield* new LegacyV1RecoveryError({
        operation: "source project is deleted",
      });
    if (
      targetProjects.some(
        (row) => row.workspace_root === project.workspace_root && row.deleted_at === null,
      )
    ) {
      return yield* new LegacyV1RecoveryError({
        operation: "workspace already belongs to a different V2 project",
      });
    }
  }
  warnings.add(
    "Only user/assistant transcripts are imported; reasoning, tool activity, plans and checkpoints remain in the V1 database.",
  );
  warnings.add(
    "Attachment references and workspace paths retain their original locations; keep the original T3 home and assets.",
  );
  const report: RecoveryReport = {
    source: input.source,
    target: input.target,
    output: input.output ?? null,
    threads: operations.map((op) => op.report),
    importedProjects: newProjects.length,
    skippedDeletedThreads,
    excludedReasoningMessages: excluded.find((row) => row.role === "reasoning")?.count ?? 0,
    excludedOtherMessages: excluded
      .filter((row) => row.role !== "reasoning")
      .reduce((n, row) => n + row.count, 0),
    warnings: [...warnings],
  };
  if (input.output === undefined) {
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    if (!(yield* maintenance.verify).valid)
      return yield* new LegacyV1RecoveryError({ operation: "V2 projection verification failed" });
    return report;
  }
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`CREATE TABLE IF NOT EXISTS orchestration_v2_v1_recoveries (
      recovery_key TEXT PRIMARY KEY, source_thread_id TEXT NOT NULL,
      target_thread_id TEXT NOT NULL, recovered_at TEXT NOT NULL
    )`;
      for (const project of newProjects) {
        const projectId = ProjectId.make(project.project_id);
        const commandId = CommandId.make(`recovery:v1:project:${projectId}`);
        yield* sink.commitProjectCommand({
          commandId,
          projectId,
          commandType: "project.create",
          acceptedAt: DateTime.makeUnsafe(now),
          event: {
            eventId: EventId.make(`recovery:v1:project:${projectId}`),
            aggregateKind: "project",
            aggregateId: projectId,
            type: "project.created",
            occurredAt: now,
            commandId,
            causationEventId: null,
            correlationId: commandId,
            metadata: {},
            payload: {
              projectId,
              title: project.title,
              workspaceRoot: project.workspace_root,
              defaultModelSelection:
                project.default_model_selection_json === null
                  ? null
                  : yield* decodeModelSelection(project.default_model_selection_json),
              defaultThreadEnvMode: yield* decodeThreadEnvMode(project.default_thread_env_mode),
              faviconPath: project.favicon_path,
              projectIcon:
                project.project_icon_json === null
                  ? null
                  : yield* decodeProjectIcon(project.project_icon_json),
              scripts: yield* decodeScripts(project.scripts_json),
              createdAt: yield* decodeTimestamp(project.created_at),
              updatedAt: yield* decodeTimestamp(project.updated_at),
            },
          },
        });
        if (project.auto_pull === 1) {
          const autoPullCommandId = CommandId.make(`recovery:v1:project:${projectId}:auto-pull`);
          yield* sink.commitProjectCommand({
            commandId: autoPullCommandId,
            projectId,
            commandType: "project.meta.update",
            acceptedAt: DateTime.makeUnsafe(now),
            event: {
              eventId: EventId.make(`recovery:v1:project:${projectId}:auto-pull`),
              aggregateKind: "project",
              aggregateId: projectId,
              type: "project.meta-updated",
              occurredAt: now,
              commandId: autoPullCommandId,
              causationEventId: null,
              correlationId: autoPullCommandId,
              metadata: {},
              payload: { projectId, autoPull: true, updatedAt: project.updated_at },
            },
          });
        }
      }
      for (const operation of operations) {
        const { row, key } = operation;
        const threadId = ThreadId.make(operation.report.targetThreadId);
        const thread =
          operation.report.action === "append"
            ? yield* decodeThread(targetThreadMap.get(threadId)!.payload_json)
            : LegacyImport.importedThread(row);
        const imported = {
          ...thread,
          id: threadId,
          updatedAt: DateTime.makeUnsafe(
            [DateTime.formatIso(thread.updatedAt), row.updated_at].sort().at(-1)!,
          ),
          ...(operation.report.action === "copy"
            ? {
                title: `${thread.title} (recovered from Stable)`,
                lineage: { ...thread.lineage, rootThreadId: threadId },
                // A copy must never share a live worktree with the original conversation.
                branch: null,
                worktreePath: null,
                activeOrderKey: null,
              }
            : {}),
        };
        if (operation.report.action !== "append") {
          yield* sink.write({
            events: [
              {
                id: EventId.make(`recovery:v1:thread:${key}:created`),
                type: "thread.created",
                threadId,
                providerInstanceId: imported.providerInstanceId,
                occurredAt: imported.createdAt,
                payload: imported,
              },
            ],
          });
        }
        let nextOrdinal = (yield* sql<{ ordinal: number }>`
          SELECT COALESCE(MAX(ordinal), 0) AS ordinal FROM orchestration_v2_turn_item_positions
          WHERE thread_id = ${threadId}
        `)[0]!.ordinal;
        for (let offset = 0; offset < operation.messages.length; offset += 50) {
          const batch = operation.messages.slice(offset, offset + 50);
          const events: OrchestrationV2DomainEvent[] = [];
          for (const message of batch) {
            const copied =
              operation.report.action === "copy"
                ? {
                    ...message,
                    thread_id: threadId,
                    message_id: `recovery:v1:message:${key}:${message.message_id}`,
                  }
                : message;
            // Append after existing positions even if Stable's timestamps sort earlier.
            // Persist the same ordinal in the event so projection rebuilds retain it.
            const positioned = { ...copied, ordinal: ++nextOrdinal };
            // Keep importer IDs so pending hydration cannot duplicate these messages.
            const converted = LegacyImport.messageEvents(positioned);
            for (const event of converted) events.push(event);
            yield* sql`INSERT INTO orchestration_v2_turn_item_positions (thread_id, turn_item_id, ordinal)
            VALUES (${threadId}, ${`migration:v1:turn-item:${positioned.message_id}`}, ${positioned.ordinal})
            ON CONFLICT(thread_id, turn_item_id) DO NOTHING`;
          }
          yield* sink.write({ events });
        }
        // Historical messages otherwise move the thread's activity timestamp backwards.
        // Restore its metadata after importing, preserving V2 choices and the newest activity time.
        yield* sink.write({
          events: [
            {
              id: EventId.make(`recovery:v1:thread:${key}:metadata`),
              type: "thread.metadata-updated",
              threadId,
              providerInstanceId: imported.providerInstanceId,
              occurredAt: imported.updatedAt,
              payload: imported,
            },
          ],
        });
        if (operation.report.action === "append" && threadId === row.thread_id) {
          yield* sql`UPDATE orchestration_v2_legacy_imports SET transcript_imported_at = ${now},
          imported_message_count = ${(sourceByThread.get(row.thread_id) ?? []).length},
          last_error = NULL WHERE thread_id = ${threadId}`;
        }
        yield* sql`INSERT INTO orchestration_v2_v1_recoveries
        (recovery_key, source_thread_id, target_thread_id, recovered_at)
        VALUES (${key}, ${row.thread_id}, ${threadId}, ${now})`;
      }
    }),
  );
  const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
  if (!(yield* maintenance.verify).valid)
    return yield* new LegacyV1RecoveryError({
      operation: "recovered projection verification failed",
    });
  return report;
});

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const recover = Effect.fn("LegacyV1Recovery.recover")(
    function* (input: RecoveryInput) {
      const source = path.resolve(input.source);
      const target = path.resolve(input.target);
      const output = input.output === undefined ? undefined : path.resolve(input.output);
      if (source === target || output === source || output === target) {
        return yield* new LegacyV1RecoveryError({
          operation: "source, target and output must be different files",
        });
      }
      if (output !== undefined && (yield* fs.exists(output))) {
        return yield* new LegacyV1RecoveryError({ operation: "output already exists" });
      }
      const directory = yield* fs.makeTempDirectoryScoped({
        ...(output === undefined ? {} : { directory: path.dirname(output) }),
        prefix: ".t3-recovery-",
      });
      const sourceSnapshot = path.join(directory, "source.sqlite");
      const targetSnapshot = path.join(directory, "target.sqlite");
      for (const [original, snapshot] of [
        [source, sourceSnapshot],
        [target, targetSnapshot],
      ]) {
        yield* Effect.tryPromise(async () => {
          const db = new NodeSqlite.DatabaseSync(original!, { readOnly: true });
          try {
            await NodeSqlite.backup(db, snapshot!);
          } finally {
            db.close();
          }
        });
      }
      const report = yield* recoverSnapshot(
        { source, target, ...(output === undefined ? {} : { output }) },
        sourceSnapshot,
      ).pipe(
        Effect.provide(
          recoveryRuntime.pipe(
            Layer.provideMerge(SqlitePersistence.makeSqlitePersistenceLive(targetSnapshot)),
          ),
        ),
        Effect.scoped,
      );
      yield* Effect.try(() => {
        const db = new NodeSqlite.DatabaseSync(targetSnapshot);
        try {
          db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;");
          const check = db.prepare("PRAGMA quick_check").all();
          if (check.length !== 1 || Object.values(check[0]!)[0] !== "ok")
            throw new Error("SQLite quick_check failed");
        } finally {
          db.close();
        }
      });
      if (output !== undefined) {
        // Exclusive hard-link publication cannot replace an existing file, even in a race.
        // All SQL connections have closed, so the output has no dependent WAL file.
        yield* fs.link(targetSnapshot, output);
      }
      return report;
    },
    Effect.scoped,
    Effect.catchDefect(
      (cause) =>
        new LegacyV1RecoveryError({ operation: "decode or validate recovery data", cause }),
    ),
    Effect.mapError((cause) =>
      isRecoveryError(cause)
        ? cause
        : new LegacyV1RecoveryError({ operation: "snapshot, import or validation", cause }),
    ),
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
  );
  return LegacyV1Recovery.of({ recover });
});

export const layer = Layer.effect(LegacyV1Recovery, make);
