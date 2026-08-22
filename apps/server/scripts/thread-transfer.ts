// @effect-diagnostics nodeBuiltinImport:off - node modules provide hashing and the shared-home guard.
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import { OrchestrationEvent } from "@t3tools/contracts";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Flag } from "effect/unstable/cli";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { isSqlError } from "effect/unstable/sql/SqlError";

import {
  parseAttachmentIdFromRelativePath,
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment,
} from "../src/attachmentStore.ts";
import * as NodeSqliteClient from "../src/persistence/NodeSqliteClient.ts";
import { ensureDevDbNotInUse } from "./migrate-dev-db.ts";

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
});
type ThreadArchiveEvent = typeof ThreadArchiveEvent.Type;
const ThreadArchiveFile = Schema.Struct({
  fileName: Schema.String,
  sha256: Schema.String,
  dataBase64: Schema.String,
});

/**
 * One thread's canonical events plus the files that travel with it. Every
 * event belongs to the archived thread.
 */
export const ThreadArchive = Schema.Struct({
  format: Schema.Literal("t3-thread-export"),
  version: Schema.Literal(1),
  exportedAt: Schema.String,
  thread: Schema.Struct({
    id: Schema.String,
    title: Schema.String,
    sourceProjectId: Schema.String,
    sourceWorkspaceRoot: Schema.String,
  }),
  events: Schema.Array(ThreadArchiveEvent),
  attachments: Schema.Array(ThreadArchiveFile),
  terminalLogs: Schema.Array(ThreadArchiveFile).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type ThreadArchive = typeof ThreadArchive.Type;
export const ThreadTransferState = Schema.Literals(["userdata", "dev"]);
export type ThreadTransferState = typeof ThreadTransferState.Type;

/** CLI flags shared by the list, export, and import commands. */
export const threadTransferFlags = {
  directory: (name: "source" | "destination") =>
    Flag.string(name).pipe(
      Flag.withDescription("Workspace root, T3 base directory, or direct state directory."),
    ),
  state: Flag.choice("state", ThreadTransferState.literals).pipe(
    Flag.withDefault("userdata"),
    Flag.withDescription("State directory below the T3 base directory; defaults to userdata."),
  ),
};

const decodeThreadArchive = Schema.decodeEffect(Schema.fromJsonString(ThreadArchive));
const encodeThreadArchive = Schema.encodeEffect(fromJsonStringPretty(ThreadArchive));
const decodeUnknownJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const encodeUnknownJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeOrchestrationEvent = Schema.decodeUnknownEffect(OrchestrationEvent);
const hasProjectId = Schema.is(Schema.Struct({ projectId: Schema.String }));
const hasWorktreePath = Schema.is(Schema.Struct({ worktreePath: Schema.String }));

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
  /** Lets the import write the live `~/.t3/userdata` database; its server must be stopped. */
  readonly dangerousAllowT3Directory?: boolean | undefined;
}

export interface ListThreadsInput {
  /** Workspace root, T3 base directory, or direct state directory. */
  readonly source: string;
  readonly state?: ThreadTransferState | undefined;
}

export const ListedProject = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  workspaceRoot: Schema.String,
  updatedAt: Schema.NullOr(Schema.String),
});
export type ListedProject = typeof ListedProject.Type;

export const ListedThread = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  projectId: Schema.String,
  projectTitle: Schema.String,
  workspaceRoot: Schema.String,
  updatedAt: Schema.NullOr(Schema.String),
});
export type ListedThread = typeof ListedThread.Type;

/** The live projects of a state directory and the live threads across all its projects. */
export const ThreadListing = Schema.Struct({
  projects: Schema.Array(ListedProject),
  threads: Schema.Array(ListedThread),
});
export type ThreadListing = typeof ThreadListing.Type;

export interface ImportThreadOptions {
  readonly sharedHome?: string | undefined;
}

interface StateLocation {
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
}

interface ProjectRow extends RawSqliteRow {
  readonly projectId: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly updatedAt: string | null;
  readonly deletedAt: string | null;
}

interface ListedThreadRow extends RawSqliteRow {
  readonly threadId: string;
  readonly projectId: string;
  readonly title: string;
  readonly updatedAt: string | null;
}

const transferError = (operation: string, detail: string, cause?: unknown): ThreadTransferError =>
  new ThreadTransferError({ operation, detail, ...(cause === undefined ? {} : { cause }) });

/** Runs `effect` against the state database, reporting SQL failures as `operation` errors. */
const withThreadDatabase =
  (location: StateLocation, operation: string, access: "read" | "update") =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(SqlClient.SafeIntegers, access === "read"),
      Effect.provide(
        NodeSqliteClient.layer({ filename: location.databasePath, readonly: access === "read" }),
      ),
      Effect.mapError((cause) =>
        isSqlError(cause)
          ? transferError(operation, `Could not ${access} '${location.databasePath}'.`, cause)
          : cause,
      ),
    );

/** Accepts a state directory, a T3 base directory, or a workspace root holding `.t3/`. */
const resolveStateLocation = Effect.fn("resolveThreadTransferStateLocation")(function* (
  directory: string,
  state: ThreadTransferState = "userdata",
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.resolve(directory);
  const candidates = [
    { stateDir: root, workspaceRoot: null },
    { stateDir: path.join(root, state), workspaceRoot: null },
    { stateDir: path.join(root, ".t3", state), workspaceRoot: root },
  ].map(
    (candidate): StateLocation => ({
      ...candidate,
      databasePath: path.join(candidate.stateDir, "state.sqlite"),
    }),
  );
  for (const candidate of candidates) {
    const exists = yield* fs.exists(candidate.databasePath).pipe(Effect.orElseSucceed(() => false));
    if (exists) return candidate;
  }
  const [direct, base, nested] = candidates.map((candidate) => `'${candidate.databasePath}'`);
  return yield* transferError(
    "resolve directory",
    `No T3 ${state} database found at ${direct}, ${base}, or ${nested}.`,
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

const readProjectIdFromPayload = Effect.fn("readThreadTransferProjectIdFromPayload")(function* (
  payloadJson: string,
) {
  const payload = yield* decodeUnknownJson(payloadJson).pipe(
    Effect.mapError((cause) => transferError("read thread", "Invalid event payload JSON.", cause)),
  );
  return hasProjectId(payload) ? payload.projectId : null;
});

interface ImportRewrite {
  readonly sourceProjectId: string;
  readonly targetProjectId: string;
  /** Worktree paths cleared because they do not exist on the destination. */
  readonly droppedWorktreePaths: Set<string>;
}

/**
 * Rewrites the destination-specific fields of an event payload: the project
 * id (so the thread lands in the target project) and any worktree path that
 * does not exist on the destination. A worktree belongs to the source
 * checkout, so a missing path is cleared and the thread falls back to the
 * project workspace root; existing paths are kept so same-machine moves stay
 * put. Other payloads pass through untouched.
 */
const rewriteEventPayload = Effect.fn("rewriteThreadTransferEventPayload")(function* (
  payloadJson: string,
  rewrite: ImportRewrite,
) {
  const fs = yield* FileSystem.FileSystem;
  const payload = yield* decodeUnknownJson(payloadJson).pipe(
    Effect.mapError((cause) =>
      transferError("import thread", "Invalid event payload JSON.", cause),
    ),
  );
  let next: Record<string, unknown> | null = null;
  if (hasProjectId(payload) && payload.projectId === rewrite.sourceProjectId) {
    next = { ...payload, projectId: rewrite.targetProjectId };
  }
  if (hasWorktreePath(payload)) {
    const exists = yield* fs.exists(payload.worktreePath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      rewrite.droppedWorktreePaths.add(payload.worktreePath);
      next = { ...(next ?? payload), worktreePath: null };
    }
  }
  if (next === null) return payloadJson;
  return yield* encodeUnknownJson(next).pipe(
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

/** Mirrors the ownership rule of `deleteAllHistoryForThread` in `src/terminal/Manager.ts`. */
function isTerminalLogForThread(fileName: string, threadId: string): boolean {
  const safeThreadId = `terminal_${Encoding.encodeBase64Url(threadId)}`;
  const legacyThreadId = threadId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return (
    fileName === `${safeThreadId}.log` ||
    fileName === `${legacyThreadId}.log` ||
    fileName.startsWith(`${safeThreadId}_`)
  );
}

/** A per-thread file family that lives below the state directory and travels with the archive. */
interface ThreadFileKind {
  readonly label: "Attachment" | "Terminal log";
  readonly directory: ReadonlyArray<string>;
  readonly belongsToThread: (fileName: string, threadId: string) => boolean;
}

const ATTACHMENTS: ThreadFileKind = {
  label: "Attachment",
  directory: ["attachments"],
  belongsToThread: isAttachmentForThread,
};

const TERMINAL_LOGS: ThreadFileKind = {
  label: "Terminal log",
  directory: ["logs", "terminals"],
  belongsToThread: isTerminalLogForThread,
};

const sha256Hex = (data: Uint8Array) => NodeCrypto.createHash("sha256").update(data).digest("hex");

const loadThreadFiles = Effect.fn("loadThreadTransferFiles")(function* (
  location: StateLocation,
  kind: ThreadFileKind,
  threadId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(location.stateDir, ...kind.directory);
  if (!(yield* fs.exists(directory))) return [];
  const names = (yield* fs.readDirectory(directory))
    .filter((name) => kind.belongsToThread(name, threadId))
    .sort();
  return yield* Effect.forEach(names, (fileName) =>
    Effect.gen(function* () {
      const data = yield* fs.readFile(path.join(directory, fileName));
      return {
        fileName,
        sha256: sha256Hex(data),
        dataBase64: Buffer.from(data).toString("base64"),
      };
    }),
  );
});

export const listThreads = Effect.fn("listThreads")(function* (input: ListThreadsInput) {
  const location = yield* resolveStateLocation(input.source, input.state);
  return yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projects = yield* sql<ProjectRow>`
      SELECT
        project_id AS "projectId",
        title,
        workspace_root AS "workspaceRoot",
        updated_at AS "updatedAt",
        deleted_at AS "deletedAt"
      FROM projection_projects`;
    const projectsById = new Map(projects.map((project) => [project.projectId, project]));
    const threads = yield* sql<ListedThreadRow>`
      SELECT thread_id AS "threadId", project_id AS "projectId", title, updated_at AS "updatedAt"
      FROM projection_threads
      WHERE deleted_at IS NULL`;
    const listing: ThreadListing = {
      projects: projects
        .filter((project) => project.deletedAt === null)
        .map((project) => ({
          id: project.projectId,
          title: project.title,
          workspaceRoot: project.workspaceRoot,
          updatedAt: project.updatedAt,
        }))
        .sort((left, right) => left.workspaceRoot.localeCompare(right.workspaceRoot)),
      threads: threads
        .map((thread): ListedThread => {
          const project = projectsById.get(thread.projectId);
          return {
            id: thread.threadId,
            title: thread.title,
            projectId: thread.projectId,
            projectTitle: project?.title ?? thread.projectId,
            workspaceRoot: project?.workspaceRoot ?? "",
            updatedAt: thread.updatedAt,
          };
        })
        .sort((left, right) => {
          const updated = (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "");
          return updated !== 0 ? updated : left.id.localeCompare(right.id);
        }),
    };
    return listing;
  }).pipe(withThreadDatabase(location, "list threads", "read"));
});

/** Every archived event must belong to the archived thread and be unique in its stream. */
const validateArchiveEvents = (archive: ThreadArchive): ThreadTransferError | null => {
  if (archive.events.length === 0) {
    return transferError("read archive", `Thread '${archive.thread.id}' has no events.`);
  }
  const eventIds = new Set<string>();
  const streamVersions = new Set<number>();
  for (const event of archive.events) {
    if (event.aggregateKind !== "thread" || event.streamId !== archive.thread.id) {
      return transferError(
        "read archive",
        `Event '${event.eventId}' does not belong to thread '${archive.thread.id}'.`,
      );
    }
    if (eventIds.has(event.eventId) || streamVersions.has(event.streamVersion)) {
      return transferError(
        "read archive",
        `Event '${event.eventId}' repeats an event id or stream version.`,
      );
    }
    eventIds.add(event.eventId);
    streamVersions.add(event.streamVersion);
  }
  return null;
};

const loadArchive = Effect.fn("loadThreadTransferArchive")(function* (filePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolved = path.resolve(filePath);
  const contents = yield* fs
    .readFileString(resolved)
    .pipe(
      Effect.mapError((cause) =>
        transferError("read archive", `Could not read '${resolved}'.`, cause),
      ),
    );
  const archive = yield* decodeThreadArchive(contents).pipe(
    Effect.mapError((cause) =>
      transferError("read archive", `'${resolved}' is not a T3 thread archive.`, cause),
    ),
  );
  const invalid = validateArchiveEvents(archive);
  return invalid === null ? archive : yield* invalid;
});

/** Reads one thread's events and files from the source into an archive. */
const buildThreadArchive = Effect.fn("buildThreadTransferArchive")(function* (
  location: StateLocation,
  input: ExportThreadInput,
) {
  const sql = yield* SqlClient.SqlClient;
  if (!(yield* tableExists("orchestration_events"))) {
    return yield* transferError("export thread", "The source has no orchestration event log.");
  }
  const rawEvents = yield* sql<RawEventRow>`
    SELECT
      event_id AS "eventId",
      aggregate_kind AS "aggregateKind",
      stream_id AS "streamId",
      stream_version AS "streamVersion",
      event_type AS "eventType",
      occurred_at AS "occurredAt",
      command_id AS "commandId",
      causation_event_id AS "causationEventId",
      correlation_id AS "correlationId",
      actor_kind AS "actorKind",
      payload_json AS "payloadJson",
      metadata_json AS "metadataJson"
    FROM orchestration_events
    WHERE aggregate_kind = 'thread' AND stream_id = ${input.threadId}
    ORDER BY sequence`;
  if (rawEvents.length === 0) {
    return yield* transferError(
      "export thread",
      `Thread '${input.threadId}' has no canonical events.`,
    );
  }
  const threadRows = yield* sql<{ readonly projectId: string; readonly title: string }>`
    SELECT project_id AS "projectId", title
    FROM projection_threads
    WHERE thread_id = ${input.threadId}`;
  const createdEvent = rawEvents.find((event) => event.eventType === "thread.created");
  const eventProjectId =
    createdEvent === undefined ? null : yield* readProjectIdFromPayload(createdEvent.payloadJson);
  const sourceProjectId = threadRows[0]?.projectId ?? eventProjectId;
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
      title: threadRows[0]?.title ?? input.threadId,
      sourceProjectId,
      sourceWorkspaceRoot: project.workspaceRoot,
    },
    events: rawEvents.map((event) => ({
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
    })),
    attachments: yield* loadThreadFiles(location, ATTACHMENTS, input.threadId),
    terminalLogs:
      input.includeTerminalLogs === true
        ? yield* loadThreadFiles(location, TERMINAL_LOGS, input.threadId)
        : [],
  } satisfies ThreadArchive;
});

export const exportThread = Effect.fn("exportThread")(function* (input: ExportThreadInput) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const location = yield* resolveStateLocation(input.source, input.state);
  const output = path.resolve(input.output);
  if (yield* fs.exists(output)) {
    return yield* transferError("export thread", `Output '${output}' already exists.`);
  }

  const archive = yield* buildThreadArchive(location, input).pipe(
    withThreadDatabase(location, "export thread", "read"),
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

/** Validates one archive file family and returns the files that still need writing. */
const stageArchiveFiles = Effect.fn("stageThreadTransferArchiveFiles")(function* (
  location: StateLocation,
  kind: ThreadFileKind,
  files: ThreadArchive["attachments"],
  threadId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const destinationDir = path.join(location.stateDir, ...kind.directory);
  const pending: Array<{ readonly path: string; readonly data: Uint8Array }> = [];
  for (const file of files) {
    if (path.basename(file.fileName) !== file.fileName) {
      return yield* transferError(
        "import thread",
        `${kind.label} name '${file.fileName}' is not safe.`,
      );
    }
    if (!kind.belongsToThread(file.fileName, threadId)) {
      return yield* transferError(
        "import thread",
        `${kind.label} '${file.fileName}' does not belong to this thread.`,
      );
    }
    const data = Uint8Array.from(Buffer.from(file.dataBase64, "base64"));
    const hash = sha256Hex(data);
    if (hash !== file.sha256) {
      return yield* transferError(
        "import thread",
        `${kind.label} '${file.fileName}' failed its checksum.`,
      );
    }
    const destination = path.join(destinationDir, file.fileName);
    if (yield* fs.exists(destination)) {
      const existing = yield* fs.readFile(destination);
      const existingHash = sha256Hex(existing);
      if (existingHash !== hash) {
        return yield* transferError(
          "import thread",
          `${kind.label} '${file.fileName}' already exists with different contents.`,
        );
      }
      continue;
    }
    pending.push({ path: destination, data });
  }
  return pending;
});

/** The archive's events with their payloads rewritten for the destination. */
const prepareEvents = Effect.fn("prepareThreadTransferEvents")(function* (
  archive: ThreadArchive,
  rewrite: ImportRewrite,
) {
  return yield* Effect.forEach(archive.events, (event) =>
    rewriteEventPayload(event.payloadJson, rewrite).pipe(
      Effect.map((payloadJson): ThreadArchiveEvent => ({ ...event, payloadJson })),
    ),
  );
});

/**
 * The destination server decodes every event against its orchestration
 * contract at startup and refuses to start on one it cannot read, so an
 * archive from a differently-versioned source is rejected here, before any
 * write.
 */
const ensureEventsDecode = Effect.fn("ensureThreadTransferEventsDecode")(function* (
  events: ReadonlyArray<ThreadArchiveEvent>,
) {
  for (const event of events) {
    yield* Effect.all([
      decodeUnknownJson(event.payloadJson),
      decodeUnknownJson(event.metadataJson),
    ]).pipe(
      Effect.flatMap(([payload, metadata]) =>
        decodeOrchestrationEvent({
          sequence: 0,
          eventId: event.eventId,
          aggregateKind: event.aggregateKind,
          aggregateId: event.streamId,
          type: event.eventType,
          occurredAt: event.occurredAt,
          commandId: event.commandId,
          causationEventId: event.causationEventId,
          correlationId: event.correlationId,
          payload,
          metadata,
        }),
      ),
      Effect.mapError((cause) =>
        transferError(
          "import thread",
          `Event '${event.eventId}' (${event.eventType}) does not match this checkout's orchestration contract. Run the import from the destination's checkout.`,
          cause,
        ),
      ),
    );
  }
});

const insertEvents = Effect.fn("insertThreadTransferEvents")(function* (
  events: ReadonlyArray<ThreadArchiveEvent>,
) {
  const sql = yield* SqlClient.SqlClient;
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
  ];
  const insertSql = `INSERT INTO orchestration_events (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;
  for (const event of events) {
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
      event.payloadJson,
      event.metadataJson,
    ];
    yield* sql.unsafe(insertSql, params).unprepared;
  }
});

export const importThread = Effect.fn("importThread")(function* (
  input: ImportThreadInput,
  options: ImportThreadOptions = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const location = yield* resolveStateLocation(input.destination, input.state);
  const sharedHome = path.resolve(options.sharedHome ?? path.join(NodeOS.homedir(), ".t3"));
  const sharedDatabase = path.join(sharedHome, "userdata", "state.sqlite");
  const [canonicalDatabase, canonicalSharedDatabase] = yield* Effect.all([
    fs.realPath(location.databasePath).pipe(Effect.orElseSucceed(() => location.databasePath)),
    fs.realPath(sharedDatabase).pipe(Effect.orElseSucceed(() => sharedDatabase)),
  ]);
  if (canonicalDatabase === canonicalSharedDatabase && input.dangerousAllowT3Directory !== true) {
    return yield* transferError(
      "import thread",
      "Refusing to mutate the shared ~/.t3/userdata database. Choose an isolated destination or pass --dangerous-allow-t3-directory.",
    );
  }
  yield* ensureDevDbNotInUse(location.databasePath).pipe(
    Effect.mapError((cause) => transferError("import thread", cause.message, cause)),
  );
  const archive = yield* loadArchive(input.archive);

  return yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe("PRAGMA busy_timeout = 5000").unprepared;
    yield* sql.unsafe("PRAGMA foreign_keys = ON").unprepared;
    const targetProject = yield* resolveTargetProject(
      location.workspaceRoot,
      input.targetProjectId,
    );
    const existingEvents = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count
      FROM orchestration_events
      WHERE aggregate_kind = 'thread' AND stream_id = ${archive.thread.id}`;
    const existingThreads = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count
      FROM projection_threads
      WHERE thread_id = ${archive.thread.id}`;
    if (Number(existingEvents[0]?.count ?? 0) > 0 || Number(existingThreads[0]?.count ?? 0) > 0) {
      return yield* transferError(
        "import thread",
        `Thread '${archive.thread.id}' already exists in the destination.`,
      );
    }

    const pendingFiles = [
      ...(yield* stageArchiveFiles(location, ATTACHMENTS, archive.attachments, archive.thread.id)),
      ...(yield* stageArchiveFiles(
        location,
        TERMINAL_LOGS,
        archive.terminalLogs,
        archive.thread.id,
      )),
    ];
    const rewrite: ImportRewrite = {
      sourceProjectId: archive.thread.sourceProjectId,
      targetProjectId: targetProject.projectId,
      droppedWorktreePaths: new Set(),
    };
    const events = yield* prepareEvents(archive, rewrite);
    yield* ensureEventsDecode(events);

    const timestamp = DateTime.formatIso(yield* DateTime.now).replaceAll(":", "-");
    const backupPath = `${location.databasePath}.backup-thread-import-${timestamp}`;
    yield* sql`VACUUM INTO ${backupPath}`;
    yield* fs.chmod(backupPath, 0o600);

    const writtenFiles: Array<string> = [];
    yield* Effect.gen(function* () {
      for (const file of pendingFiles) {
        yield* fs.makeDirectory(path.dirname(file.path), { recursive: true });
        yield* fs.writeFile(file.path, file.data);
        writtenFiles.push(file.path);
        yield* fs.chmod(file.path, 0o600);
      }
      // Only events are written. The destination server derives the thread's
      // read model from them on its next start, when the projectors replay
      // every event above their recorded sequence. Copying projection rows as
      // well would make that replay append onto already-complete rows.
      yield* sql.withTransaction(insertEvents(events));
    }).pipe(
      Effect.onError(() =>
        Effect.forEach(
          writtenFiles,
          (filePath) => fs.remove(filePath).pipe(Effect.orElseSucceed(() => undefined)),
          { discard: true },
        ),
      ),
    );

    return {
      database: location.databasePath,
      backup: backupPath,
      threadId: archive.thread.id,
      title: archive.thread.title,
      targetProjectId: targetProject.projectId,
      targetProjectTitle: targetProject.title,
      eventCount: events.length,
      attachmentCount: archive.attachments.length,
      terminalLogCount: archive.terminalLogs.length,
      droppedWorktreePaths: [...rewrite.droppedWorktreePaths],
    } as const;
  }).pipe(withThreadDatabase(location, "import thread", "update"));
});
