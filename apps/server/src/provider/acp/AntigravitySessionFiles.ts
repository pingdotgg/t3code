// @effect-diagnostics nodeBuiltinImport:off -- node:sqlite reads the native session database read-only.
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { protoFields } from "./AntigravityChildWork.ts";
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
