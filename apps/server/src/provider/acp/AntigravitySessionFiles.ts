// @effect-diagnostics nodeBuiltinImport:off -- node:sqlite reads and rewinds the native session database.
import * as NodeCrypto from "node:crypto";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { protoEntries, protoFields } from "./AntigravityChildWork.ts";
import { antigravityManagedPath, antigravityProfileRoot } from "./AntigravityProfilePaths.ts";

const isNativeSessionId = Schema.is(Schema.String.check(Schema.isUUID(4)));
const decodeSessionMetadata = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ cwd: Schema.String })),
);

// Field numbers from the runtime's TrajectoryMetadata proto in trajectory_metadata_blob.
const TRAJECTORY_WORKSPACES = 1;
const WORKSPACE_URI = 1;
const TRAJECTORY_SESSION_ID = 6;
const TRAJECTORY_WORKSPACE_URIS = 7;
const MAX_METADATA_BLOB_BYTES = 1024 * 1024;

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function decodeTrajectoryOwnership(blob: Uint8Array):
  | {
      readonly sessionId: string | undefined;
      readonly workspaceUris: ReadonlyArray<string>;
    }
  | undefined {
  try {
    let sessionId: string | undefined;
    const workspaceUris: Array<string> = [];
    for (const [field, value] of protoFields(blob)) {
      if (field === TRAJECTORY_SESSION_ID && sessionId === undefined) {
        const decoded = utf8Decoder.decode(value).trim();
        if (decoded.length > 0) sessionId = decoded;
      } else if (field === TRAJECTORY_WORKSPACES) {
        for (const [nestedField, nestedValue] of protoFields(value)) {
          if (nestedField !== WORKSPACE_URI) continue;
          const uri = utf8Decoder.decode(nestedValue).trim();
          if (uri.length > 0) workspaceUris.push(uri);
        }
      } else if (field === TRAJECTORY_WORKSPACE_URIS) {
        const uri = utf8Decoder.decode(value).trim();
        if (uri.length > 0) workspaceUris.push(uri);
      }
    }
    return { sessionId, workspaceUris };
  } catch {
    return undefined;
  }
}

async function readDatabaseWorkspacePaths(
  profileDirectory: string,
  sessionId: string,
): Promise<ReadonlyArray<string> | undefined> {
  const profileRoot = await antigravityProfileRoot(profileDirectory);
  if (profileRoot === undefined) return undefined;
  const databasePath = (
    await antigravityManagedPath(
      profileRoot,
      ["antigravity-acp", "conversations", `${sessionId}.db`],
      "file",
    )
  )?.path;
  if (databasePath === undefined) return undefined;

  let database: NodeSqlite.DatabaseSync | undefined;
  try {
    database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
    database.exec("PRAGMA busy_timeout = 100");
    const rows = database
      .prepare("SELECT data FROM trajectory_metadata_blob WHERE length(data) <= ? LIMIT 2")
      .all(MAX_METADATA_BLOB_BYTES);
    if (rows.length !== 1) return undefined;
    const row = rows[0];
    if (
      row === null ||
      typeof row !== "object" ||
      !("data" in row) ||
      !(row.data instanceof Uint8Array)
    ) {
      return undefined;
    }
    const metadata = decodeTrajectoryOwnership(row.data);
    if (
      metadata === undefined ||
      metadata.workspaceUris.length === 0 ||
      (metadata.sessionId !== undefined && metadata.sessionId !== sessionId)
    ) {
      return undefined;
    }
    return metadata.workspaceUris.map((uri) => NodeURL.fileURLToPath(uri));
  } catch {
    return undefined;
  } finally {
    database?.close();
  }
}

// The runtime may store the resolved path (macOS `/var` -> `/private/var`) or another drive-letter case.
const pathKey = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  target: string,
) {
  const resolved = yield* fs
    .realPath(target)
    .pipe(Effect.orElseSucceed(() => path.resolve(target)));
  return path.sep === "\\" ? resolved.toLowerCase() : resolved;
});

/** Call after the process closes. The unique temporary cwd proves which session we own. */
export const removeAntigravitySessionFiles = Effect.fn("removeAntigravitySessionFiles")(
  function* (input: {
    readonly profileDirectory: string;
    readonly sessionId: string | undefined;
    readonly cwd: string;
  }) {
    const { sessionId } = input;
    if (sessionId === undefined || !isNativeSessionId(sessionId)) {
      return;
    }
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const acpDirectory = path.join(input.profileDirectory, "antigravity-acp");
    const base = path.join(acpDirectory, "conversations", sessionId);

    if (yield* fs.exists(`${base}.meta`)) {
      const metadata = yield* fs
        .readFileString(`${base}.meta`)
        .pipe(Effect.flatMap(decodeSessionMetadata));
      if (metadata.cwd !== input.cwd) {
        return;
      }
    } else {
      // Antigravity CLI 1.5+ writes no `.meta` sidecar; workspace URIs live in the session DB.
      const workspacePaths = yield* Effect.promise(() =>
        readDatabaseWorkspacePaths(input.profileDirectory, sessionId),
      );
      if (workspacePaths === undefined || workspacePaths.length === 0) {
        return;
      }
      const cwdKey = yield* pathKey(fs, path, input.cwd);
      for (const workspacePath of workspacePaths) {
        if ((yield* pathKey(fs, path, workspacePath)) !== cwdKey) {
          return;
        }
      }
    }

    for (const suffix of [".db", ".db-wal", ".db-shm", ".db-journal", ".meta"]) {
      yield* fs.remove(`${base}${suffix}`, { force: true });
    }
    yield* fs.remove(path.join(acpDirectory, "brain", sessionId), {
      recursive: true,
      force: true,
    });
    yield* fs.remove(path.join(acpDirectory, "annotations", `${sessionId}.pbtxt`), {
      force: true,
    });
  },
  Effect.catch(() => Effect.logWarning("Could not remove temporary Antigravity session files.")),
);

const warnRuntimeTempLeftovers = Effect.logWarning(
  "Could not remove leftover Antigravity runtime temp files.",
);

/**
 * Sweep only private runtimes before launch; Windows does not protect live extracted data files from deletion.
 * Moves leftovers aside and returns their slow deletion (seconds on Windows) to run off the startup path.
 */
export const retireAntigravityRuntimeTempDirs = Effect.fn("retireAntigravityRuntimeTempDirs")(
  function* (tempDirectory: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = path.dirname(tempDirectory);
    const prefix = `${path.basename(tempDirectory)}.old-`;
    if (yield* fs.exists(tempDirectory)) {
      yield* fs.makeTempDirectory({ directory: parent, prefix }).pipe(
        Effect.flatMap((retired) => fs.rename(tempDirectory, path.join(retired, "runtime"))),
        Effect.catch(() => fs.remove(tempDirectory, { recursive: true, force: true })),
      );
    }
    const entries = yield* fs.readDirectory(parent).pipe(Effect.orElseSucceed(() => []));
    return Effect.forEach(
      entries.filter((entry) => entry.startsWith(prefix)),
      (entry) =>
        fs
          .remove(path.join(parent, entry), { recursive: true, force: true })
          .pipe(Effect.catch(() => warnRuntimeTempLeftovers)),
      { discard: true },
    );
  },
  Effect.catch(() => warnRuntimeTempLeftovers.pipe(Effect.as(Effect.void))),
);

// CORTEX_STEP_TYPE_USER_INPUT: a prompt, the first step of each native turn.
const USER_INPUT_STEP_TYPE = 14;
// Step metadata: when it was created, and its coordinates in the trajectory.
const STEP_CREATED_AT = 1;
const STEP_COORDINATES = 20;
const COORDINATE_GENERATION = 3;
// Executor metadata: the last step its run wrote.
const EXECUTOR_LAST_STEP = 3;
// The runtime splits each transcript log into chunks of this many bytes.
const TRANSCRIPT_CHUNK_BYTES = 100 * 1024;
const TRANSCRIPT_STEP_INDEX = /^\{"step_index":(\d+)/;

class AntigravitySessionRewindError extends Schema.TaggedError<AntigravitySessionRewindError>()(
  "AntigravitySessionRewindError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `Could not rewind the Antigravity session: ${this.detail}`;
  }
}

const field = (bytes: Uint8Array, number: number) =>
  protoEntries(bytes).find(([entry]) => entry === number)?.[1];
const varintField = (message: Uint8Array | number | undefined, number: number) => {
  const value = message instanceof Uint8Array ? field(message, number) : undefined;
  return typeof value === "number" ? value : 0;
};
const createdAtMillis = (metadata: Uint8Array) => {
  const timestamp = field(metadata, STEP_CREATED_AT);
  return varintField(timestamp, 1) * 1000 + varintField(timestamp, 2) / 1e6;
};

const indexedBlobs = (rows: ReadonlyArray<Record<string, NodeSqlite.SQLOutputValue>>) =>
  rows.flatMap(({ idx, data }) =>
    typeof idx === "number" && data instanceof Uint8Array ? [{ idx, data }] : [],
  );

/** Deletes the steps from `cut` on, with the model calls and runs that produced them. */
function cutTrajectory(databasePath: string, before: number): number | undefined {
  const database = new NodeSqlite.DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    database.exec("BEGIN IMMEDIATE");
    try {
      const prompts = indexedBlobs(
        database
          .prepare("SELECT idx, metadata AS data FROM steps WHERE step_type = ? ORDER BY idx")
          .all(USER_INPUT_STEP_TYPE),
      );
      const cut = prompts.find((prompt) => createdAtMillis(prompt.data) >= before);
      if (cut === undefined) {
        database.exec("COMMIT");
        return undefined;
      }
      if (cut === prompts[0]) throw new Error("the session holds none of the kept turns");
      const generation = varintField(field(cut.data, STEP_COORDINATES), COORDINATE_GENERATION);
      database.prepare("DELETE FROM steps WHERE idx >= ?").run(cut.idx);
      database.prepare("DELETE FROM gen_metadata WHERE idx >= ?").run(generation);
      const runs = indexedBlobs(database.prepare("SELECT idx, data FROM executor_metadata").all());
      const dropRun = database.prepare("DELETE FROM executor_metadata WHERE idx = ?");
      for (const run of runs) {
        if (varintField(run.data, EXECUTOR_LAST_STEP) >= cut.idx) dropRun.run(run.idx);
      }
      // As the runtime's own rewind does: later steps start a new trajectory.
      database.prepare("UPDATE trajectory_meta SET trajectory_id = ?").run(NodeCrypto.randomUUID());
      database.exec("COMMIT");
      return cut.idx;
    } catch (cause) {
      database.exec("ROLLBACK");
      throw cause;
    }
  } finally {
    database.close();
  }
}

/** Drops what the runtime wrote beside the session for steps from `cut` on. */
const cutBrain = Effect.fnUntraced(function* (brain: string, cut: number) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const generated = path.join(brain, ".system_generated");
  const entries = (directory: string) =>
    fs.readDirectory(directory).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  const stepOf = (name: string) => Number(/^(?:step_)?(\d+)(?:_|$)/.exec(name)?.[1] ?? -1);
  for (const directory of [path.join(generated, "steps"), path.join(generated, "logs", "media")]) {
    for (const name of yield* entries(directory)) {
      if (stepOf(name) >= cut) yield* fs.remove(path.join(directory, name), { recursive: true });
    }
  }
  for (const name of ["transcript", "transcript_full"]) {
    const log = path.join(generated, "logs", `${name}.jsonl`);
    if (!(yield* fs.exists(log))) continue;
    const kept = (yield* fs.readFileString(log))
      .split(/(?<=\n)/)
      .filter((line) => Number(TRANSCRIPT_STEP_INDEX.exec(line)?.[1] ?? cut) < cut)
      .join("");
    const bytes = new TextEncoder().encode(kept);
    const chunks = path.join(generated, "logs", "chunks", name);
    yield* fs.writeFile(log, bytes);
    yield* fs.remove(chunks, { recursive: true, force: true });
    yield* fs.makeDirectory(chunks, { recursive: true });
    for (let start = 0; start < bytes.length; start += TRANSCRIPT_CHUNK_BYTES) {
      const chunk = String(start / TRANSCRIPT_CHUNK_BYTES).padStart(8, "0");
      yield* fs.writeFile(
        path.join(chunks, `${chunk}.jsonl`),
        bytes.subarray(start, start + TRANSCRIPT_CHUNK_BYTES),
      );
    }
  }
});

/**
 * Rewinds a stored session to the turns it held before `before`, as the runtime's own
 * `/rewind` does, so `session/load` resumes it with its native history.
 */
export const rewindAntigravitySession = Effect.fn("rewindAntigravitySession")(function* (input: {
  readonly profileDirectory: string;
  readonly sessionId: string;
  readonly before: DateTime.Utc;
}) {
  const { sessionId } = input;
  const fail = (detail: string, cause?: unknown) =>
    new AntigravitySessionRewindError({ detail, ...(cause === undefined ? {} : { cause }) });
  if (!isNativeSessionId(sessionId)) return yield* fail(`${sessionId} is not a native session id`);
  const profileRoot = yield* Effect.promise(() => antigravityProfileRoot(input.profileDirectory));
  const located = (segments: ReadonlyArray<string>, kind: "file" | "directory") =>
    profileRoot === undefined
      ? Effect.undefined
      : Effect.promise(() =>
          antigravityManagedPath(profileRoot, ["antigravity-acp", ...segments], kind),
        );
  const database = yield* located(["conversations", `${sessionId}.db`], "file");
  if (database === undefined) return yield* fail(`session ${sessionId} is not stored`);
  const cut = yield* Effect.try({
    try: () => cutTrajectory(database.path, DateTime.toEpochMillis(input.before)),
    catch: (cause) => fail(cause instanceof Error ? cause.message : "its database failed", cause),
  });
  if (cut === undefined) return;
  const brain = yield* located(["brain", sessionId], "directory");
  if (brain !== undefined) yield* cutBrain(brain.path, cut);
});
