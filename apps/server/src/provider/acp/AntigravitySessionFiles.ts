import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
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
  },
  Effect.catch(() => Effect.logWarning("Could not remove temporary Antigravity session files.")),
);

/**
 * Removes every per-process runtime temp directory under an instance's root.
 * Call once when the driver starts, before it launches any process, so a
 * previous server that was killed mid-session cannot leave unpacked runtimes
 * behind. Only T3-owned directories are touched. The system temp directory
 * belongs to other programs and Windows does not lock data files, so sweeping
 * it could gut a live extraction.
 */
export const removeAntigravityRuntimeTempDirs = Effect.fn("removeAntigravityRuntimeTempDirs")(
  function* (tempDirectory: string) {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(tempDirectory, { recursive: true, force: true });
  },
  Effect.catch(() =>
    Effect.logWarning("Could not remove leftover Antigravity runtime temp files."),
  ),
);

/** Markers unique to an Antigravity PyInstaller unpack. Never treat `google3` alone as enough. */
const ANTIGRAVITY_MEI_MARKERS = [
  ["agy_acp_licenses.txt"],
  ["localharness"],
  ["google3", "third_party", "jetski_prod", "localharness"],
] as const;

/** Live unpacks stay recent. Pre-#12008 probe leftovers are days old. */
export const ANTIGRAVITY_LEGACY_SYSTEM_TEMP_MIN_AGE_MS = 2 * 24 * 60 * 60 * 1000;

/** Windows host TEMP/TMP only. Empty or duplicate values are dropped. */
export const resolveAntigravityLegacySystemTempDirectories = (
  environment: NodeJS.ProcessEnv,
): ReadonlyArray<string> => {
  const directories: string[] = [];
  const seen = new Set<string>();
  for (const value of [environment.TEMP, environment.TMP]) {
    if (value === undefined || value === "") continue;
    if (seen.has(value)) continue;
    seen.add(value);
    directories.push(value);
  }
  return directories;
};

/**
 * Reclaims T3-created `%TEMP%\_MEI*` leftovers from the pre-#12008 health
 * probe. Call once on driver start with an injected directory. Only stale
 * `_MEI*` dirs that contain Antigravity markers are removed. Unmarked dirs,
 * dirs at or under the two-day cutoff, and dirs that fail with a lock are
 * left alone. The real system temp is never listed from tests.
 */
export const cleanOrphanedAntigravitySystemTempDirs = Effect.fn(
  "cleanOrphanedAntigravitySystemTempDirs",
)(
  function* (input: {
    readonly systemTempDirectory: string;
    readonly nowMs?: number;
    readonly minAgeMs?: number;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (input.systemTempDirectory === "" || !(yield* fs.exists(input.systemTempDirectory))) {
      return;
    }
    const nowMs = input.nowMs ?? (yield* Clock.currentTimeMillis);
    const minAgeMs = input.minAgeMs ?? ANTIGRAVITY_LEGACY_SYSTEM_TEMP_MIN_AGE_MS;
    const entries = yield* fs
      .readDirectory(input.systemTempDirectory)
      .pipe(Effect.orElseSucceed(() => []));
    for (const entry of entries) {
      if (!entry.startsWith("_MEI")) continue;
      const directory = path.join(input.systemTempDirectory, entry);
      const stats = yield* fs.stat(directory).pipe(Effect.option);
      if (Option.isNone(stats) || stats.value.type !== "Directory") continue;
      const modifiedAt = Option.match(stats.value.mtime, {
        onNone: () => Option.getOrUndefined(stats.value.birthtime),
        onSome: (mtime) => mtime,
      });
      if (modifiedAt === undefined || nowMs - modifiedAt.getTime() <= minAgeMs) continue;
      const marked = yield* hasAntigravityMeiMarker(directory);
      if (!marked) continue;
      yield* fs.remove(directory, { recursive: true, force: true }).pipe(Effect.ignore);
    }
  },
  Effect.catch(() => Effect.logWarning("Could not remove leftover Antigravity system temp files.")),
);

const hasAntigravityMeiMarker = Effect.fnUntraced(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const marker of ANTIGRAVITY_MEI_MARKERS) {
    if (yield* fs.exists(path.join(directory, ...marker))) {
      return true;
    }
  }
  return false;
});
