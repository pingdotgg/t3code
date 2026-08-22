// @effect-diagnostics nodeBuiltinImport:off - node modules provide hashing and the shared-home guard.
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  parseAttachmentIdFromRelativePath,
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment,
} from "../src/attachmentStore.ts";
import * as NodeSqliteClient from "../src/persistence/NodeSqliteClient.ts";
import { ensureDevDbNotInUse } from "./migrate-dev-db.ts";

const THREAD_PROJECTION_TABLES = [
  "projection_threads",
  "projection_thread_messages",
  "projection_thread_activities",
  "projection_thread_sessions",
  "projection_turns",
  "projection_pending_approvals",
  "projection_thread_proposed_plans",
  "checkpoint_diff_blobs",
  "orchestration_v2_turn_item_positions",
] as const;

const SqliteValue = Schema.Union([
  Schema.Null,
  Schema.String,
  Schema.Number,
  Schema.Array(Schema.Number),
]);
const SqliteRow = Schema.Record(Schema.String, SqliteValue);
const ThreadProjectionTable = Schema.Struct({
  table: Schema.Literals(THREAD_PROJECTION_TABLES),
  columns: Schema.Array(Schema.String),
  rows: Schema.Array(SqliteRow),
});
const ThreadArchiveEvent = Schema.Struct({
  eventId: Schema.String,
  aggregateKind: Schema.String,
  streamId: Schema.String,
  streamVersion: Schema.Number,
  eventType: Schema.String,
  occurredAt: Schema.String,
  commandId: Schema.NullOr(Schema.String),
  causationEventId: Schema.NullOr(Schema.String),
  correlationId: Schema.NullOr(Schema.String),
  actorKind: Schema.String,
  payloadJson: Schema.String,
  metadataJson: Schema.String,
  applicationEventVersion: Schema.Literals([1, 2]),
});
const ThreadArchiveFile = Schema.Struct({
  fileName: Schema.String,
  sha256: Schema.String,
  dataBase64: Schema.String,
});

export const ThreadArchive = Schema.Struct({
  format: Schema.Literal("t3-thread-export"),
  version: Schema.Literal(1),
  exportedAt: Schema.String,
  thread: Schema.Struct({
    id: Schema.String,
    title: Schema.String,
    sourceProjectId: Schema.String,
    sourceWorkspaceRoot: Schema.String,
    orchestrationVersion: Schema.Literals([1, 2]),
  }),
  events: Schema.Array(ThreadArchiveEvent),
  projections: Schema.Array(ThreadProjectionTable),
  attachments: Schema.Array(ThreadArchiveFile),
  terminalLogs: Schema.Array(ThreadArchiveFile).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type ThreadArchive = typeof ThreadArchive.Type;
export const ThreadTransferState = Schema.Literals(["userdata", "dev"]);
export type ThreadTransferState = typeof ThreadTransferState.Type;

const decodeThreadArchive = Schema.decodeEffect(Schema.fromJsonString(ThreadArchive));
const encodeThreadArchive = Schema.encodeEffect(fromJsonStringPretty(ThreadArchive));
const decodeUnknownJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const encodeUnknownJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export class ThreadTransferError extends Schema.TaggedErrorClass<ThreadTransferError>()(
  "ThreadTransferError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `${this.operation}: ${this.detail}`;
  }
}

export interface ExportThreadInput {
  /** Workspace root, T3 base directory, or direct state directory. */
  readonly source: string;
  readonly state?: ThreadTransferState | undefined;
  readonly threadId: string;
  readonly output: string;
  readonly includeTerminalLogs?: boolean | undefined;
}

export interface ImportThreadInput {
  /** Workspace root, T3 base directory, or direct state directory. */
  readonly destination: string;
  readonly state?: ThreadTransferState | undefined;
  readonly archive: string;
  readonly targetProjectId?: string | undefined;
}

export interface ListThreadsInput {
  /** Workspace root, T3 base directory, or direct state directory. */
  readonly source: string;
  readonly state?: ThreadTransferState | undefined;
}

export const ListedThread = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  projectId: Schema.String,
  projectTitle: Schema.String,
  workspaceRoot: Schema.String,
  updatedAt: Schema.NullOr(Schema.String),
  orchestrationVersion: Schema.Literals([1, 2]),
});
export type ListedThread = typeof ListedThread.Type;

export interface ThreadTransferOptions {
  readonly sharedHome?: string | undefined;
}

interface T3Location {
  readonly stateDir: string;
  readonly databasePath: string;
  readonly workspaceRoot: string | null;
}

type RawSqliteValue = null | string | number | bigint | Uint8Array;
type RawSqliteRow = Readonly<Record<string, RawSqliteValue>>;

interface RawEventRow extends RawSqliteRow {
  readonly eventId: string;
  readonly aggregateKind: string;
  readonly streamId: string;
  readonly streamVersion: number;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly commandId: string | null;
  readonly causationEventId: string | null;
  readonly correlationId: string | null;
  readonly actorKind: string;
  readonly payloadJson: string;
  readonly metadataJson: string;
  readonly applicationEventVersion: number;
}

interface ProjectRow extends RawSqliteRow {
  readonly projectId: string;
  readonly title: string;
  readonly workspaceRoot: string;
}

interface ListedThreadRow extends RawSqliteRow {
  readonly threadId: string;
  readonly projectId: string;
  readonly title: string;
  readonly updatedAt: string | null;
}

const transferError = (operation: string, detail: string, cause?: unknown): ThreadTransferError =>
  new ThreadTransferError({ operation, detail, ...(cause === undefined ? {} : { cause }) });

function normalizeSqliteValue(value: RawSqliteValue): typeof SqliteValue.Type {
  if (typeof value === "bigint") {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : value.toString();
  }
  return value instanceof Uint8Array ? Array.from(value) : value;
}

function normalizeSqliteRow(row: RawSqliteRow): typeof SqliteRow.Type {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, normalizeSqliteValue(value)]),
  );
}

function restoreSqliteValue(value: typeof SqliteValue.Type): null | string | number | Uint8Array {
  return value instanceof Array ? Uint8Array.from(value) : value;
}

const resolveT3Location = Effect.fn("resolveThreadTransferT3Location")(function* (
  input: string,
  state: ThreadTransferState = "userdata",
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.resolve(input);
  const directDatabase = path.join(root, "state.sqlite");
  if (yield* fs.exists(directDatabase)) {
    return {
      stateDir: root,
      databasePath: directDatabase,
      workspaceRoot: null,
    } satisfies T3Location;
  }
  const stateDir = path.join(root, state);
  const stateDatabase = path.join(stateDir, "state.sqlite");
  if (yield* fs.exists(stateDatabase)) {
    return {
      stateDir,
      databasePath: stateDatabase,
      workspaceRoot: null,
    } satisfies T3Location;
  }
  const nestedBaseDir = path.join(root, ".t3");
  const nestedStateDir = path.join(nestedBaseDir, state);
  const nestedDatabase = path.join(nestedStateDir, "state.sqlite");
  if (yield* fs.exists(nestedDatabase)) {
    return {
      stateDir: nestedStateDir,
      databasePath: nestedDatabase,
      workspaceRoot: root,
    } satisfies T3Location;
  }
  return yield* transferError(
    "resolve directory",
    `No T3 ${state} database found at '${directDatabase}', '${stateDatabase}', or '${nestedDatabase}'.`,
  );
});

const tableExists = Effect.fn("threadTransferTableExists")(function* (table: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count
    FROM sqlite_master
    WHERE type = 'table' AND name = ${table}`;
  return Number(rows[0]?.count ?? 0) > 0;
});

const tableColumns = Effect.fn("threadTransferTableColumns")(function* (table: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql.unsafe<{ readonly name: string }>(`PRAGMA table_info("${table}")`)
    .unprepared;
  return rows.map((row) => row.name);
});

const readProjectIdFromPayload = Effect.fn("readThreadTransferProjectId")(function* (
  payloadJson: string,
) {
  const payload = yield* decodeUnknownJson(payloadJson).pipe(
    Effect.mapError((cause) => transferError("read thread", "Invalid event payload JSON.", cause)),
  );
  if (
    Predicate.isObject(payload) &&
    Predicate.hasProperty(payload, "projectId") &&
    typeof payload.projectId === "string"
  ) {
    return payload.projectId;
  }
  return null;
});

const rewriteEventProject = Effect.fn("rewriteThreadTransferEventProject")(function* (
  payloadJson: string,
  sourceProjectId: string,
  targetProjectId: string,
) {
  const payload = yield* decodeUnknownJson(payloadJson).pipe(
    Effect.mapError((cause) =>
      transferError("import thread", "Invalid event payload JSON.", cause),
    ),
  );
  if (
    !Predicate.isObject(payload) ||
    !Predicate.hasProperty(payload, "projectId") ||
    payload.projectId !== sourceProjectId
  ) {
    return payloadJson;
  }
  return yield* encodeUnknownJson({ ...payload, projectId: targetProjectId }).pipe(
    Effect.mapError((cause) =>
      transferError("import thread", "Could not encode event JSON.", cause),
    ),
  );
});

function isAttachmentForThread(fileName: string, threadId: string): boolean {
  const segment = toSafeThreadAttachmentSegment(threadId);
  if (segment === null) return false;
  const attachmentId = parseAttachmentIdFromRelativePath(fileName);
  return attachmentId !== null && parseThreadSegmentFromAttachmentId(attachmentId) === segment;
}

const loadAttachments = Effect.fn("loadThreadTransferAttachments")(function* (
  location: T3Location,
  threadId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const attachmentsDir = path.join(location.stateDir, "attachments");
  if (!(yield* fs.exists(attachmentsDir))) return [];
  const names = (yield* fs.readDirectory(attachmentsDir))
    .filter((name) => isAttachmentForThread(name, threadId))
    .sort();
  return yield* Effect.forEach(names, (fileName) =>
    Effect.gen(function* () {
      const data = yield* fs.readFile(path.join(attachmentsDir, fileName));
      return {
        fileName,
        sha256: NodeCrypto.createHash("sha256").update(data).digest("hex"),
        dataBase64: Buffer.from(data).toString("base64"),
      };
    }),
  );
});

function isTerminalLogForThread(fileName: string, threadId: string): boolean {
  const safeThreadId = `terminal_${Encoding.encodeBase64Url(threadId)}`;
  const legacyThreadId = threadId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return (
    fileName === `${safeThreadId}.log` ||
    fileName === `${legacyThreadId}.log` ||
    (fileName.startsWith(`${safeThreadId}_`) && fileName.endsWith(".log"))
  );
}

const loadTerminalLogs = Effect.fn("loadThreadTransferTerminalLogs")(function* (
  location: T3Location,
  threadId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const logsDir = path.join(location.stateDir, "logs", "terminals");
  if (!(yield* fs.exists(logsDir))) return [];
  const names = (yield* fs.readDirectory(logsDir))
    .filter((name) => isTerminalLogForThread(name, threadId))
    .sort();
  return yield* Effect.forEach(names, (fileName) =>
    Effect.gen(function* () {
      const data = yield* fs.readFile(path.join(logsDir, fileName));
      return {
        fileName,
        sha256: NodeCrypto.createHash("sha256").update(data).digest("hex"),
        dataBase64: Buffer.from(data).toString("base64"),
      };
    }),
  );
});

const loadProjectionTables = Effect.fn("loadThreadTransferProjectionTables")(function* (
  threadId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const tables: Array<typeof ThreadProjectionTable.Type> = [];
  for (const table of THREAD_PROJECTION_TABLES) {
    if (!(yield* tableExists(table))) continue;
    const columns = yield* tableColumns(table);
    if (!columns.includes("thread_id")) continue;
    const rows = yield* sql.unsafe<RawSqliteRow>(`SELECT * FROM "${table}" WHERE thread_id = ?`, [
      threadId,
    ]).unprepared;
    if (rows.length > 0) {
      tables.push({ table, columns, rows: rows.map(normalizeSqliteRow) });
    }
  }
  return tables;
});

const loadListedThreads = Effect.fn("loadListedThreads")(function* (
  table: "projection_threads" | "orchestration_v2_projection_threads",
  orchestrationVersion: 1 | 2,
) {
  const sql = yield* SqlClient.SqlClient;
  if (!(yield* tableExists(table))) return [];
  const columns = yield* tableColumns(table);
  if (
    !columns.includes("thread_id") ||
    !columns.includes("project_id") ||
    !columns.includes("title")
  ) {
    return [];
  }
  const updatedAt = columns.includes("updated_at") ? "updated_at" : "NULL";
  const where = columns.includes("deleted_at") ? "WHERE deleted_at IS NULL" : "";
  const rows = yield* sql.unsafe<ListedThreadRow>(
    `SELECT
      thread_id AS threadId,
      project_id AS projectId,
      title,
      ${updatedAt} AS updatedAt
    FROM "${table}"
    ${where}`,
  ).unprepared;
  return rows.map((row) => ({ ...row, orchestrationVersion }));
});

export const listThreads = Effect.fn("listThreads")(function* (input: ListThreadsInput) {
  const location = yield* resolveT3Location(input.source, input.state);
  return yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projects = yield* sql<ProjectRow>`
      SELECT project_id AS "projectId", title, workspace_root AS "workspaceRoot"
      FROM projection_projects`;
    const projectsById = new Map(projects.map((project) => [project.projectId, project]));
    const [v2Threads, v1Threads] = yield* Effect.all([
      loadListedThreads("orchestration_v2_projection_threads", 2),
      loadListedThreads("projection_threads", 1),
    ]);
    const v2Ids = new Set(v2Threads.map((thread) => thread.threadId));
    return [...v2Threads, ...v1Threads.filter((thread) => !v2Ids.has(thread.threadId))]
      .map((thread): ListedThread => {
        const project = projectsById.get(thread.projectId);
        return {
          id: thread.threadId,
          title: thread.title,
          projectId: thread.projectId,
          projectTitle: project?.title ?? thread.projectId,
          workspaceRoot: project?.workspaceRoot ?? "",
          updatedAt: thread.updatedAt,
          orchestrationVersion: thread.orchestrationVersion,
        };
      })
      .sort((left, right) => {
        const updated = (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "");
        return updated !== 0 ? updated : left.id.localeCompare(right.id);
      });
  }).pipe(
    Effect.provide(NodeSqliteClient.layer({ filename: location.databasePath, readonly: true })),
    Effect.mapError((cause) =>
      Schema.is(ThreadTransferError)(cause)
        ? cause
        : transferError("list threads", `Could not read '${location.databasePath}'.`, cause),
    ),
  );
});

const loadArchive = Effect.fn("loadThreadTransferArchive")(function* (filePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolved = path.resolve(filePath);
  const source = yield* fs
    .readFileString(resolved)
    .pipe(
      Effect.mapError((cause) =>
        transferError("read archive", `Could not read '${resolved}'.`, cause),
      ),
    );
  return yield* decodeThreadArchive(source).pipe(
    Effect.mapError((cause) =>
      transferError("read archive", `'${resolved}' is not a T3 thread archive.`, cause),
    ),
  );
});

export const exportThread = Effect.fn("exportThread")(function* (input: ExportThreadInput) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const location = yield* resolveT3Location(input.source, input.state);
  const output = path.resolve(input.output);
  if (yield* fs.exists(output)) {
    return yield* transferError("export thread", `Output '${output}' already exists.`);
  }

  const archive = yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    if (!(yield* tableExists("orchestration_events"))) {
      return yield* transferError("export thread", "The source has no orchestration event log.");
    }
    const eventColumns = yield* tableColumns("orchestration_events");
    const versionExpression = eventColumns.includes("application_event_version")
      ? "COALESCE(application_event_version, 1)"
      : "1";
    const rawEvents = yield* sql.unsafe<RawEventRow>(
      `SELECT
          event_id AS eventId,
          aggregate_kind AS aggregateKind,
          stream_id AS streamId,
          stream_version AS streamVersion,
          event_type AS eventType,
          occurred_at AS occurredAt,
          command_id AS commandId,
          causation_event_id AS causationEventId,
          correlation_id AS correlationId,
          actor_kind AS actorKind,
          payload_json AS payloadJson,
          metadata_json AS metadataJson,
          ${versionExpression} AS applicationEventVersion
        FROM orchestration_events
        WHERE aggregate_kind = 'thread' AND stream_id = ?
        ORDER BY sequence`,
      [input.threadId],
    ).unprepared;
    if (rawEvents.length === 0) {
      return yield* transferError(
        "export thread",
        `Thread '${input.threadId}' has no canonical events.`,
      );
    }
    const orchestrationVersion = rawEvents.some(
      (event) => Number(event.applicationEventVersion) === 2,
    )
      ? 2
      : 1;
    const selectedEvents = rawEvents.filter(
      (event) => Number(event.applicationEventVersion) === orchestrationVersion,
    );
    const projectionTable =
      orchestrationVersion === 2 && (yield* tableExists("orchestration_v2_projection_threads"))
        ? "orchestration_v2_projection_threads"
        : "projection_threads";
    const projectionRows = yield* sql.unsafe<{
      readonly projectId: string;
      readonly title: string;
    }>(`SELECT project_id AS projectId, title FROM "${projectionTable}" WHERE thread_id = ?`, [
      input.threadId,
    ]).unprepared;
    const createdEvent = selectedEvents.find(
      (event) => event.eventType === "ThreadCreated" || event.eventType === "thread.created",
    );
    const eventProjectId =
      createdEvent === undefined ? null : yield* readProjectIdFromPayload(createdEvent.payloadJson);
    const sourceProjectId = projectionRows[0]?.projectId ?? eventProjectId;
    if (sourceProjectId === null) {
      return yield* transferError(
        "export thread",
        `Could not resolve the project for thread '${input.threadId}'.`,
      );
    }
    const projectRows = yield* sql<ProjectRow>`
      SELECT project_id AS "projectId", title, workspace_root AS "workspaceRoot"
      FROM projection_projects
      WHERE project_id = ${sourceProjectId}`;
    const project = projectRows[0];
    if (project === undefined) {
      return yield* transferError(
        "export thread",
        `Project '${sourceProjectId}' is missing from the source database.`,
      );
    }
    const exportedAt = DateTime.formatIso(yield* DateTime.now);
    return {
      format: "t3-thread-export",
      version: 1,
      exportedAt,
      thread: {
        id: input.threadId,
        title: projectionRows[0]?.title ?? input.threadId,
        sourceProjectId,
        sourceWorkspaceRoot: project.workspaceRoot,
        orchestrationVersion,
      },
      events: selectedEvents.map((event) => ({
        eventId: event.eventId,
        aggregateKind: event.aggregateKind,
        streamId: event.streamId,
        streamVersion: Number(event.streamVersion),
        eventType: event.eventType,
        occurredAt: event.occurredAt,
        commandId: event.commandId,
        causationEventId: event.causationEventId,
        correlationId: event.correlationId,
        actorKind: event.actorKind,
        payloadJson: event.payloadJson,
        metadataJson: event.metadataJson,
        applicationEventVersion: orchestrationVersion,
      })),
      projections: yield* loadProjectionTables(input.threadId),
      attachments: yield* loadAttachments(location, input.threadId),
      terminalLogs:
        input.includeTerminalLogs === true ? yield* loadTerminalLogs(location, input.threadId) : [],
    } satisfies ThreadArchive;
  }).pipe(
    Effect.provide(NodeSqliteClient.layer({ filename: location.databasePath, readonly: true })),
    Effect.mapError((cause) =>
      Schema.is(ThreadTransferError)(cause)
        ? cause
        : transferError("export thread", `Could not read '${location.databasePath}'.`, cause),
    ),
  );

  const encoded = yield* encodeThreadArchive(archive).pipe(
    Effect.mapError((cause) => transferError("export thread", "Could not encode archive.", cause)),
  );
  yield* fs.makeDirectory(path.dirname(output), { recursive: true });
  yield* fs
    .writeFileString(output, encoded)
    .pipe(
      Effect.mapError((cause) =>
        transferError("export thread", `Could not write '${output}'.`, cause),
      ),
    );
  yield* fs.chmod(output, 0o600);
  return {
    output,
    threadId: archive.thread.id,
    title: archive.thread.title,
    orchestrationVersion: archive.thread.orchestrationVersion,
    eventCount: archive.events.length,
    attachmentCount: archive.attachments.length,
    terminalLogCount: archive.terminalLogs.length,
  } as const;
});

const resolveTargetProject = Effect.fn("resolveThreadTransferTargetProject")(function* (
  workspaceRoot: string | null,
  explicitProjectId: string | undefined,
) {
  const sql = yield* SqlClient.SqlClient;
  const path = yield* Path.Path;
  const projects = yield* sql<ProjectRow>`
    SELECT project_id AS "projectId", title, workspace_root AS "workspaceRoot"
    FROM projection_projects
    WHERE deleted_at IS NULL
    ORDER BY updated_at DESC`;
  if (explicitProjectId !== undefined) {
    const project = projects.find((candidate) => candidate.projectId === explicitProjectId);
    if (project !== undefined) return project;
    return yield* transferError(
      "import thread",
      `Target project '${explicitProjectId}' does not exist in the destination.`,
    );
  }
  if (workspaceRoot !== null) {
    const normalizedRoot = path.resolve(workspaceRoot);
    const project = projects.find(
      (candidate) => path.resolve(candidate.workspaceRoot) === normalizedRoot,
    );
    if (project !== undefined) return project;
  }
  if (projects.length === 1) return projects[0]!;
  return yield* transferError(
    "import thread",
    "Could not infer the target project. Pass --target-project-id.",
  );
});

const writeArchiveFiles = Effect.fn("writeThreadTransferFiles")(function* (
  location: T3Location,
  directory: ReadonlyArray<string>,
  files: ThreadArchive["attachments"],
  kind: "Attachment" | "Terminal log",
  isAllowedName: (fileName: string) => boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const destinationDir = path.join(location.stateDir, ...directory);
  const pending: Array<{ readonly path: string; readonly data: Uint8Array }> = [];
  for (const file of files) {
    if (path.basename(file.fileName) !== file.fileName) {
      return yield* transferError("import thread", `${kind} name '${file.fileName}' is not safe.`);
    }
    if (!isAllowedName(file.fileName)) {
      return yield* transferError(
        "import thread",
        `${kind} '${file.fileName}' does not belong to this thread.`,
      );
    }
    const data = Uint8Array.from(Buffer.from(file.dataBase64, "base64"));
    const hash = NodeCrypto.createHash("sha256").update(data).digest("hex");
    if (hash !== file.sha256) {
      return yield* transferError(
        "import thread",
        `${kind} '${file.fileName}' failed its checksum.`,
      );
    }
    const destination = path.join(destinationDir, file.fileName);
    if (yield* fs.exists(destination)) {
      const existing = yield* fs.readFile(destination);
      const existingHash = NodeCrypto.createHash("sha256").update(existing).digest("hex");
      if (existingHash !== hash) {
        return yield* transferError(
          "import thread",
          `${kind} '${file.fileName}' already exists with different contents.`,
        );
      }
      continue;
    }
    pending.push({ path: destination, data });
  }
  if (pending.length > 0) yield* fs.makeDirectory(destinationDir, { recursive: true });
  for (const entry of pending) {
    yield* fs.writeFile(entry.path, entry.data);
    yield* fs.chmod(entry.path, 0o600);
  }
  return pending.map((entry) => entry.path);
});

const insertProjectionTables = Effect.fn("insertThreadTransferProjectionTables")(function* (
  archive: ThreadArchive,
  targetProjectId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  for (const projection of archive.projections) {
    if (!(yield* tableExists(projection.table))) continue;
    const destinationColumns = new Set(yield* tableColumns(projection.table));
    const columns = projection.columns.filter((column) => destinationColumns.has(column));
    if (!columns.includes("thread_id")) continue;
    const identifiers = columns.map((column) => `"${column.replaceAll('"', '""')}"`).join(", ");
    const placeholders = columns.map(() => "?").join(", ");
    for (const row of projection.rows) {
      const params = columns.map((column) => {
        if (projection.table === "projection_threads" && column === "project_id") {
          return targetProjectId;
        }
        return restoreSqliteValue(row[column] ?? null);
      });
      yield* sql.unsafe(
        `INSERT INTO "${projection.table}" (${identifiers}) VALUES (${placeholders})`,
        params,
      ).unprepared;
    }
  }
});

export const importThread = Effect.fn("importThread")(function* (
  input: ImportThreadInput,
  options: ThreadTransferOptions = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const location = yield* resolveT3Location(input.destination, input.state);
  const sharedHome = path.resolve(options.sharedHome ?? path.join(NodeOS.homedir(), ".t3"));
  const sharedDatabase = path.join(sharedHome, "userdata", "state.sqlite");
  const [canonicalDatabase, canonicalSharedDatabase] = yield* Effect.all([
    fs.realPath(location.databasePath).pipe(Effect.orElseSucceed(() => location.databasePath)),
    fs.realPath(sharedDatabase).pipe(Effect.orElseSucceed(() => sharedDatabase)),
  ]);
  if (canonicalDatabase === canonicalSharedDatabase) {
    return yield* transferError(
      "import thread",
      "Refusing to mutate the shared ~/.t3 database. Choose an isolated destination.",
    );
  }
  yield* ensureDevDbNotInUse(location.databasePath).pipe(
    Effect.mapError((cause) => transferError("import thread", cause.message, cause)),
  );
  const archive = yield* loadArchive(input.archive);

  return yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe("PRAGMA busy_timeout = 5000").unprepared;
    const targetProject = yield* resolveTargetProject(
      location.workspaceRoot,
      input.targetProjectId,
    );
    const existingEvents = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count
      FROM orchestration_events
      WHERE aggregate_kind = 'thread' AND stream_id = ${archive.thread.id}`;
    const hasV1Projection = (yield* tableExists("projection_threads"))
      ? Number(
          (yield* sql<{ readonly count: number }>`
              SELECT COUNT(*) AS count FROM projection_threads
              WHERE thread_id = ${archive.thread.id}`)[0]?.count ?? 0,
        ) > 0
      : false;
    const hasV2Projection = (yield* tableExists("orchestration_v2_projection_threads"))
      ? Number(
          (yield* sql.unsafe<{ readonly count: number }>(
            "SELECT COUNT(*) AS count FROM orchestration_v2_projection_threads WHERE thread_id = ?",
            [archive.thread.id],
          ))[0]?.count ?? 0,
        ) > 0
      : false;
    if (Number(existingEvents[0]?.count ?? 0) > 0 || hasV1Projection || hasV2Projection) {
      return yield* transferError(
        "import thread",
        `Thread '${archive.thread.id}' already exists in the destination.`,
      );
    }
    const eventColumns = yield* tableColumns("orchestration_events");
    const supportsEventVersion = eventColumns.includes("application_event_version");
    if (archive.thread.orchestrationVersion === 2 && !supportsEventVersion) {
      return yield* transferError(
        "import thread",
        "The destination schema does not support Orchestrator v2 events.",
      );
    }

    const timestamp = DateTime.formatIso(yield* DateTime.now).replaceAll(":", "-");
    const backup = `${location.databasePath}.backup-thread-import-${timestamp}`;
    yield* sql`VACUUM INTO ${backup}`;
    yield* fs.chmod(backup, 0o600);
    const writtenFiles = yield* Effect.all([
      writeArchiveFiles(location, ["attachments"], archive.attachments, "Attachment", (fileName) =>
        isAttachmentForThread(fileName, archive.thread.id),
      ),
      writeArchiveFiles(
        location,
        ["logs", "terminals"],
        archive.terminalLogs,
        "Terminal log",
        (fileName) => isTerminalLogForThread(fileName, archive.thread.id),
      ),
    ]).pipe(Effect.map(([attachments, terminalLogs]) => [...attachments, ...terminalLogs]));
    const cleanupFiles = Effect.forEach(
      writtenFiles,
      (filePath) => fs.remove(filePath).pipe(Effect.orElseSucceed(() => undefined)),
      { discard: true },
    );

    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* insertProjectionTables(archive, targetProject.projectId);
          for (const event of archive.events) {
            const payloadJson = yield* rewriteEventProject(
              event.payloadJson,
              archive.thread.sourceProjectId,
              targetProject.projectId,
            );
            const columns = [
              "event_id",
              "aggregate_kind",
              "stream_id",
              "stream_version",
              "event_type",
              "occurred_at",
              "command_id",
              "causation_event_id",
              "correlation_id",
              "actor_kind",
              "payload_json",
              "metadata_json",
              ...(supportsEventVersion ? ["application_event_version"] : []),
            ];
            const params: ReadonlyArray<unknown> = [
              event.eventId,
              event.aggregateKind,
              event.streamId,
              event.streamVersion,
              event.eventType,
              event.occurredAt,
              event.commandId,
              event.causationEventId,
              event.correlationId,
              event.actorKind,
              payloadJson,
              event.metadataJson,
              ...(supportsEventVersion ? [event.applicationEventVersion] : []),
            ];
            yield* sql.unsafe(
              `INSERT INTO orchestration_events (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
              params,
            ).unprepared;
          }
        }),
      )
      .pipe(Effect.tapError(() => cleanupFiles));

    return {
      database: location.databasePath,
      backup,
      threadId: archive.thread.id,
      title: archive.thread.title,
      targetProjectId: targetProject.projectId,
      targetProjectTitle: targetProject.title,
      orchestrationVersion: archive.thread.orchestrationVersion,
      eventCount: archive.events.length,
      attachmentCount: archive.attachments.length,
      terminalLogCount: archive.terminalLogs.length,
    } as const;
  }).pipe(
    Effect.provide(NodeSqliteClient.layer({ filename: location.databasePath })),
    Effect.mapError((cause) =>
      Schema.is(ThreadTransferError)(cause)
        ? cause
        : transferError("import thread", `Could not update '${location.databasePath}'.`, cause),
    ),
  );
});
