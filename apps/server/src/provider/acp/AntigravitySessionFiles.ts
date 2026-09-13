import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const isNativeSessionId = Schema.is(Schema.String.check(Schema.isUUID(4)));
const decodeSessionMetadata = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ cwd: Schema.String })),
);

/** Call after the process closes. The unique temporary cwd proves which session we own. */
export const removeAntigravitySessionFiles = Effect.fn("removeAntigravitySessionFiles")(
  function* (input: {
    readonly profileDirectory: string;
    readonly sessionId: string | undefined;
    readonly cwd: string;
  }) {
    if (input.sessionId === undefined || !isNativeSessionId(input.sessionId)) {
      return;
    }
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const acpDirectory = path.join(input.profileDirectory, "antigravity-acp");
    const base = path.join(acpDirectory, "conversations", input.sessionId);
    if (!(yield* fs.exists(`${base}.meta`))) {
      return;
    }
    const metadata = yield* fs
      .readFileString(`${base}.meta`)
      .pipe(Effect.flatMap(decodeSessionMetadata));
    if (metadata.cwd !== input.cwd) {
      return;
    }
    for (const suffix of [".db", ".db-wal", ".db-shm", ".db-journal", ".meta"]) {
      yield* fs.remove(`${base}${suffix}`, { force: true });
    }
    yield* fs.remove(path.join(acpDirectory, "brain", input.sessionId), {
      recursive: true,
      force: true,
    });

    // Best-effort cleanup of any unlocked temporary unpack directories left by PyInstaller
    const tmpDirectory = path.join(acpDirectory, "tmp");
    if (yield* fs.exists(tmpDirectory)) {
      const entries = yield* fs.readDirectory(tmpDirectory).pipe(Effect.orElseSucceed(() => []));
      for (const entry of entries) {
        if (entry.startsWith("_MEI")) {
          yield* fs
            .remove(path.join(tmpDirectory, entry), { recursive: true, force: true })
            .pipe(Effect.ignore);
        }
      }
    }
  },
  Effect.catch(() => Effect.logWarning("Could not remove temporary Antigravity session files.")),
);

/** Sweeps orphaned PyInstaller unpack directories from prior runs. */
export const cleanOrphanedAntigravityTempDirs = Effect.fn("cleanOrphanedAntigravityTempDirs")(
  function* (profileDirectory?: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    // 1. Clean profile-isolated tmp directory if provided
    if (profileDirectory) {
      const acpTmp = path.join(profileDirectory, "antigravity-acp", "tmp");
      if (yield* fs.exists(acpTmp)) {
        const entries = yield* fs.readDirectory(acpTmp).pipe(Effect.orElseSucceed(() => []));
        for (const entry of entries) {
          if (entry.startsWith("_MEI")) {
            yield* fs
              .remove(path.join(acpTmp, entry), { recursive: true, force: true })
              .pipe(Effect.ignore);
          }
        }
      }
    }

    // 2. Clean orphaned _MEI folders in system temp directory left by previous Antigravity probes on Windows
    // On Unix, concurrent processes can have their files deleted without file locking protection,
    // so system temp sweeping is restricted to Windows where active files are lock-protected.
    if (process.platform === "win32") {
      const systemTemp = process.env.TEMP || process.env.TMP;
      if (systemTemp && (yield* fs.exists(systemTemp))) {
        const entries = yield* fs.readDirectory(systemTemp).pipe(Effect.orElseSucceed(() => []));
        for (const entry of entries) {
          if (entry.startsWith("_MEI")) {
            const fullPath = path.join(systemTemp, entry);
            const hasGoogle3 = yield* fs
              .exists(path.join(fullPath, "google3"))
              .pipe(Effect.orElseSucceed(() => false));
            const hasGoogle =
              hasGoogle3 ||
              (yield* fs
                .exists(path.join(fullPath, "google"))
                .pipe(Effect.orElseSucceed(() => false)));
            if (hasGoogle) {
              yield* fs.remove(fullPath, { recursive: true, force: true }).pipe(Effect.ignore);
            }
          }
        }
      }
    }
  },
);
