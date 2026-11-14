import { ProviderDriverKind, type CodexSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as PlatformError from "effect/PlatformError";
import * as Option from "effect/Option";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";

export interface CodexHomeLayout {
  readonly mode: "direct" | "authOverlay";
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string | undefined;
  readonly continuationKey: string;
}

const KNOWN_SHARED_DIRECTORIES = [
  "sessions",
  "archived_sessions",
  "sqlite",
  "shell_snapshots",
  "worktrees",
  "skills",
  "plugins",
  "cache",
  "logs",
  "mcp-oauth-locks",
  "thread-writer-locks",
] as const;

// auth.lock guards the shadow home's private auth.json.
const PRIVATE_ENTRY_NAMES = new Set(["auth.json", "auth.lock", "models_cache.json"]);
// Finder maintains metadata separately for each directory, including shadow homes.
const SHADOW_LOCAL_ENTRY_NAMES = new Set(["log", "memories", "tmp", ".DS_Store"]);
const SQLITE_ENTRY_NAME = /\.sqlite(?:-(?:shm|wal|journal))?$/iu;
const SQLITE_DATABASE_ENTRY_NAME = /\.sqlite$/iu;
const SQLITE_DATA_SIDECAR_ENTRY_NAME = /^(.*\.sqlite)-(?:wal|journal)$/iu;
// Shadow homes may create local runtime locks first; replace them with shared links because they guard shared state.
const REPLACEABLE_SHARED_RUNTIME_ENTRIES = new Set([
  "mcp-oauth-locks",
  "thread-writer-locks",
  ".sqlite-maintenance.lock",
]);

function resolveHomePath(path: Path.Path, home: string, value: string | undefined): string {
  const expanded =
    value && value.trim().length > 0 ? expandHomePath(value, home) : path.join(home, ".codex");
  return path.resolve(expanded);
}

export const resolveCodexHomeLayout = Effect.fn("resolveCodexHomeLayout")(function* (
  config: CodexSettings,
): Effect.fn.Return<CodexHomeLayout, never, Path.Path> {
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const sharedHomePath = resolveHomePath(path, home, config.homePath);
  const shadowHomePath = config.shadowHomePath.trim();
  if (shadowHomePath.length === 0) {
    return {
      mode: "direct",
      sharedHomePath,
      effectiveHomePath: config.homePath.trim().length > 0 ? sharedHomePath : undefined,
      continuationKey: `codex:home:${sharedHomePath}`,
    };
  }

  const effectiveHomePath = path.resolve(expandHomePath(shadowHomePath, home));
  return {
    mode: "authOverlay",
    sharedHomePath,
    effectiveHomePath,
    continuationKey: `codex:home:${sharedHomePath}`,
  };
});

const CodexShadowHomeContext = {
  sharedHomePath: Schema.String,
  effectiveHomePath: Schema.String,
};

export class CodexShadowHomeFileSystemError extends Schema.TaggedError<CodexShadowHomeFileSystemError>()(
  "CodexShadowHomeFileSystemError",
  {
    ...CodexShadowHomeContext,
    operation: Schema.Literals(["readLink", "makeDirectory", "readDirectory", "remove", "symlink"]),
    path: Schema.String,
    targetPath: Schema.optional(Schema.String),
    entryName: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const target = this.targetPath === undefined ? "" : ` to '${this.targetPath}'`;
    return `Codex shadow home filesystem operation '${this.operation}' failed for '${this.path}'${target}.`;
  }
}

export class CodexShadowHomePathConflictError extends Schema.TaggedError<CodexShadowHomePathConflictError>()(
  "CodexShadowHomePathConflictError",
  CodexShadowHomeContext,
) {
  override get message(): string {
    return `Codex shadow home path '${this.effectiveHomePath}' must be different from the shared home path '${this.sharedHomePath}'.`;
  }
}

export class CodexShadowHomeEntryConflictError extends Schema.TaggedError<CodexShadowHomeEntryConflictError>()(
  "CodexShadowHomeEntryConflictError",
  {
    ...CodexShadowHomeContext,
    entryName: Schema.String,
    linkPath: Schema.String,
    targetPath: Schema.String,
  },
) {
  override get message(): string {
    return `Cannot create Codex shadow home entry '${this.entryName}' because '${this.linkPath}' already exists and is not a symlink.`;
  }
}

export class CodexShadowHomeSqliteConflictError extends Schema.TaggedError<CodexShadowHomeSqliteConflictError>()(
  "CodexShadowHomeSqliteConflictError",
  {
    ...CodexShadowHomeContext,
    entryName: Schema.String,
    /** Set when the shadow's own databases cannot be combined with this shared one on Windows. */
    sharedEntryName: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    if (this.sharedEntryName !== undefined) {
      return `Codex shadow home '${this.effectiveHomePath}' has its own SQLite database '${this.entryName}', while '${this.sharedEntryName}' belongs to the shared home '${this.sharedHomePath}'. On Windows Codex cannot use both without splitting a database from its WAL. Stop every Codex process using either home and back up both. Then either move the shadow's .sqlite files, with their -wal and -shm files, into the shared home to keep them, or move them out of the shadow home, and retry. T3 did not change any SQLite files.`;
    }
    return `Codex shadow home '${this.effectiveHomePath}' holds SQLite data in '${this.entryName}' that the shared home '${this.sharedHomePath}' may not have. Stop every Codex process using either home, back up both, then move that file out of the shadow home and retry. T3 did not change any SQLite files.`;
  }
}

export class CodexShadowHomePrivateEntrySymlinkError extends Schema.TaggedError<CodexShadowHomePrivateEntrySymlinkError>()(
  "CodexShadowHomePrivateEntrySymlinkError",
  {
    ...CodexShadowHomeContext,
    entryName: Schema.String,
    path: Schema.String,
  },
) {
  override get message(): string {
    return `Codex shadow home private entry '${this.entryName}' at '${this.path}' must be a real file, not a symlink.`;
  }
}

export const CodexShadowHomeError = Schema.Union([
  CodexShadowHomeFileSystemError,
  CodexShadowHomePathConflictError,
  CodexShadowHomeEntryConflictError,
  CodexShadowHomeSqliteConflictError,
  CodexShadowHomePrivateEntrySymlinkError,
]);
export type CodexShadowHomeError = typeof CodexShadowHomeError.Type;

type LinkState =
  | {
      readonly _tag: "Missing";
    }
  | {
      readonly _tag: "NotSymlink";
    }
  | {
      readonly _tag: "Symlink";
      readonly target: string;
    };

function isNotSymlinkError(error: PlatformError.PlatformError): boolean {
  const cause = error.reason.cause;
  return (
    error.reason._tag === "Unknown" &&
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "EINVAL"
  );
}

const readLinkState = Effect.fn("CodexHomeLayout.readLinkState")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string;
  readonly entryName: string;
  readonly linkPath: string;
}): Effect.fn.Return<LinkState, CodexShadowHomeError> {
  return yield* input.fileSystem.readLink(input.linkPath).pipe(
    Effect.map((target): LinkState => ({ _tag: "Symlink", target })),
    Effect.catchTags({
      PlatformError: (cause) => {
        if (cause.reason._tag === "NotFound") {
          return Effect.succeed<LinkState>({ _tag: "Missing" });
        }
        if (isNotSymlinkError(cause)) {
          return Effect.succeed<LinkState>({ _tag: "NotSymlink" });
        }
        return new CodexShadowHomeFileSystemError({
          sharedHomePath: input.sharedHomePath,
          effectiveHomePath: input.effectiveHomePath,
          operation: "readLink",
          path: input.linkPath,
          entryName: input.entryName,
          cause,
        });
      },
    }),
  );
});

const readHomeEntries = (
  fileSystem: FileSystem.FileSystem,
  layout: CodexHomeLayout,
  effectiveHomePath: string,
  directory: string,
) =>
  fileSystem.readDirectory(directory).pipe(
    Effect.catchTags({
      PlatformError: (cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeed<Array<string>>([])
          : new CodexShadowHomeFileSystemError({
              sharedHomePath: layout.sharedHomePath,
              effectiveHomePath,
              operation: "readDirectory",
              path: directory,
              cause,
            }),
    }),
  );

/**
 * Codex opens its SQLite databases from `CODEX_SQLITE_HOME`. Windows SQLite derives `-wal`/`-shm`
 * from the path it was given, so a database reached through a shadow-home link gets its own WAL.
 * Point every shadow at the shared home instead; legacy links left in the shadow become inert.
 * POSIX SQLite opens a link by its target's path, so only there may a shadow link shared ones.
 */
export const codexHomeEnvironment = Effect.fn("CodexHomeLayout.codexHomeEnvironment")(function* (
  layout: CodexHomeLayout,
  environment: NodeJS.ProcessEnv,
) {
  const effectiveHomePath = layout.effectiveHomePath;
  if (layout.mode !== "authOverlay" || !effectiveHomePath) return environment;
  const override = environment.CODEX_SQLITE_HOME?.trim();
  if (override) return { ...environment, CODEX_SQLITE_HOME: override };

  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const regularDatabases = new Set<string>();
  const linkedDatabases: Array<string> = [];
  const sidecarsWithData: Array<{ readonly entryName: string; readonly databaseName: string }> = [];
  for (const entryName of yield* readHomeEntries(
    fileSystem,
    layout,
    effectiveHomePath,
    effectiveHomePath,
  )) {
    if (!SQLITE_ENTRY_NAME.test(entryName)) continue;
    const linkPath = path.join(effectiveHomePath, entryName);
    const state = yield* readLinkState({
      fileSystem,
      sharedHomePath: layout.sharedHomePath,
      effectiveHomePath,
      entryName,
      linkPath,
    });
    if (state._tag === "Symlink" && SQLITE_DATABASE_ENTRY_NAME.test(entryName)) {
      linkedDatabases.push(entryName.toLowerCase());
    }
    if (state._tag !== "NotSymlink") continue;
    if (SQLITE_DATABASE_ENTRY_NAME.test(entryName)) {
      regularDatabases.add(entryName.toLowerCase());
      continue;
    }
    // `-shm` is a rebuildable index and an empty WAL or journal holds nothing to lose.
    const sidecar = SQLITE_DATA_SIDECAR_ENTRY_NAME.exec(entryName);
    if (!sidecar?.[1]) continue;
    const info = yield* fileSystem.stat(linkPath).pipe(Effect.option);
    if (Option.isSome(info) && Number(info.value.size) > 0) {
      sidecarsWithData.push({ entryName, databaseName: sidecar[1].toLowerCase() });
    }
  }

  // A WAL or journal beside a linked or missing database may hold writes the shared copy lacks.
  const stranded = sidecarsWithData.find((sidecar) => !regularDatabases.has(sidecar.databaseName));
  if (stranded) {
    return yield* new CodexShadowHomeSqliteConflictError({
      sharedHomePath: layout.sharedHomePath,
      effectiveHomePath,
      entryName: stranded.entryName,
    });
  }
  if (regularDatabases.size === 0) {
    return { ...environment, CODEX_SQLITE_HOME: layout.sharedHomePath };
  }
  const sharedDatabases = (yield* readHomeEntries(
    fileSystem,
    layout,
    effectiveHomePath,
    layout.sharedHomePath,
  ))
    .filter((entry) => SQLITE_DATABASE_ENTRY_NAME.test(entry))
    .map((entry) => entry.toLowerCase());
  // Only the same database diverging in both homes is ambiguous, as for other shadow entries.
  const conflict = sharedDatabases.find((entry) => regularDatabases.has(entry));
  if (conflict) {
    return yield* new CodexShadowHomeSqliteConflictError({
      sharedHomePath: layout.sharedHomePath,
      effectiveHomePath,
      entryName: conflict,
    });
  }
  // A legacy link counts even when its shared database is gone, since Codex would recreate it.
  const [sharedDatabase] = [...sharedDatabases, ...linkedDatabases].toSorted();
  const [privateDatabase] = [...regularDatabases].toSorted();
  // Linking the shared databases in would give each Windows connection its own WAL.
  if (sharedDatabase && privateDatabase && (yield* HostProcess.isWindows)) {
    return yield* new CodexShadowHomeSqliteConflictError({
      sharedHomePath: layout.sharedHomePath,
      effectiveHomePath,
      entryName: privateDatabase,
      sharedEntryName: sharedDatabase,
    });
  }
  // Neither home holds every database, so the shadow keeps its own and links the shared ones.
  return { ...environment, CODEX_SQLITE_HOME: effectiveHomePath };
});

const removePrivateSymlink = Effect.fn("CodexHomeLayout.removePrivateSymlink")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string;
  readonly entryName: string;
}): Effect.fn.Return<void, CodexShadowHomeError, Path.Path> {
  const path = yield* Path.Path;
  const privatePath = path.join(input.effectiveHomePath, input.entryName);
  const state = yield* readLinkState({
    ...input,
    linkPath: privatePath,
  });
  if (state._tag === "Symlink") {
    yield* input.fileSystem.remove(privatePath).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          new CodexShadowHomeFileSystemError({
            sharedHomePath: input.sharedHomePath,
            effectiveHomePath: input.effectiveHomePath,
            operation: "remove",
            path: privatePath,
            entryName: input.entryName,
            cause,
          }),
      }),
    );
  }
});

const ensureSymlink = Effect.fn("CodexHomeLayout.ensureSymlink")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string;
  readonly entryName: string;
}): Effect.fn.Return<void, CodexShadowHomeError, Path.Path> {
  const path = yield* Path.Path;
  const target = path.join(input.sharedHomePath, input.entryName);
  const link = path.join(input.effectiveHomePath, input.entryName);
  const state = yield* readLinkState({
    ...input,
    linkPath: link,
  });

  const createLink = input.fileSystem.symlink(target, link).pipe(
    Effect.catchTags({
      PlatformError: (cause) =>
        new CodexShadowHomeFileSystemError({
          sharedHomePath: input.sharedHomePath,
          effectiveHomePath: input.effectiveHomePath,
          operation: "symlink",
          path: link,
          targetPath: target,
          entryName: input.entryName,
          cause,
        }),
    }),
  );

  if (state._tag === "NotSymlink") {
    if (!REPLACEABLE_SHARED_RUNTIME_ENTRIES.has(input.entryName)) {
      return yield* new CodexShadowHomeEntryConflictError({
        sharedHomePath: input.sharedHomePath,
        effectiveHomePath: input.effectiveHomePath,
        entryName: input.entryName,
        linkPath: link,
        targetPath: target,
      });
    }

    if (input.entryName === "thread-writer-locks") {
      const lockNames = yield* input.fileSystem.readDirectory(link).pipe(
        Effect.catchTags({
          PlatformError: (cause) =>
            new CodexShadowHomeFileSystemError({
              sharedHomePath: input.sharedHomePath,
              effectiveHomePath: input.effectiveHomePath,
              operation: "readDirectory",
              path: link,
              entryName: input.entryName,
              cause,
            }),
        }),
      );
      // Codex deletes a thread lock on release, so one that is left may still guard a live
      // writer. Keep the local directory until a later setup finds none.
      if (lockNames.some((name) => name.endsWith(".lock") && name !== ".coordination.lock")) {
        return yield* Effect.logWarning(
          "Codex shadow home still has thread writer locks; it will share them on a later setup.",
          { path: link },
        );
      }
    }

    yield* input.fileSystem.remove(link, { recursive: true }).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          new CodexShadowHomeFileSystemError({
            sharedHomePath: input.sharedHomePath,
            effectiveHomePath: input.effectiveHomePath,
            operation: "remove",
            path: link,
            entryName: input.entryName,
            cause,
          }),
      }),
    );
    return yield* createLink;
  }

  if (state._tag === "Missing") {
    return yield* createLink;
  }

  const resolvedExisting = path.resolve(path.dirname(link), state.target);
  if (resolvedExisting !== target) {
    yield* input.fileSystem.remove(link).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          new CodexShadowHomeFileSystemError({
            sharedHomePath: input.sharedHomePath,
            effectiveHomePath: input.effectiveHomePath,
            operation: "remove",
            path: link,
            entryName: input.entryName,
            cause,
          }),
      }),
    );
    yield* createLink;
  }
});

const ensureShadowAuthIsPrivate = Effect.fn("CodexHomeLayout.ensureShadowAuthIsPrivate")(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly sharedHomePath: string;
    readonly effectiveHomePath: string;
  }): Effect.fn.Return<void, CodexShadowHomeError, Path.Path> {
    const path = yield* Path.Path;
    const entryName = "auth.json";
    const authPath = path.join(input.effectiveHomePath, entryName);
    const state = yield* readLinkState({
      ...input,
      entryName,
      linkPath: authPath,
    });
    if (state._tag === "Symlink") {
      return yield* new CodexShadowHomePrivateEntrySymlinkError({
        sharedHomePath: input.sharedHomePath,
        effectiveHomePath: input.effectiveHomePath,
        entryName,
        path: authPath,
      });
    }
  },
);

const materializeShadowHome = Effect.fn("CodexHomeLayout.materialize")(function* (
  layout: CodexHomeLayout,
  linkSharedDatabases: boolean,
) {
  if (layout.mode !== "authOverlay") return;
  const effectiveHomePath = layout.effectiveHomePath;
  if (!effectiveHomePath) return;
  if (layout.sharedHomePath === effectiveHomePath) {
    return yield* new CodexShadowHomePathConflictError({
      sharedHomePath: layout.sharedHomePath,
      effectiveHomePath,
    });
  }

  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const makeDirectory = (directoryPath: string) =>
    fileSystem.makeDirectory(directoryPath, { recursive: true }).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          new CodexShadowHomeFileSystemError({
            sharedHomePath: layout.sharedHomePath,
            effectiveHomePath,
            operation: "makeDirectory",
            path: directoryPath,
            cause,
          }),
      }),
    );

  yield* Effect.all(
    [
      makeDirectory(layout.sharedHomePath),
      makeDirectory(effectiveHomePath),
      ...KNOWN_SHARED_DIRECTORIES.map((directory) =>
        makeDirectory(path.join(layout.sharedHomePath, directory)),
      ),
    ],
    { concurrency: "unbounded" },
  );

  const sharedEntryNames = yield* fileSystem.readDirectory(layout.sharedHomePath).pipe(
    Effect.catchTags({
      PlatformError: (cause) =>
        new CodexShadowHomeFileSystemError({
          sharedHomePath: layout.sharedHomePath,
          effectiveHomePath,
          operation: "readDirectory",
          path: layout.sharedHomePath,
          cause,
        }),
    }),
  );
  const entries = new Set<string>(KNOWN_SHARED_DIRECTORIES);
  for (const entryName of sharedEntryNames) {
    if (
      !PRIVATE_ENTRY_NAMES.has(entryName) &&
      !SHADOW_LOCAL_ENTRY_NAMES.has(entryName) &&
      (!SQLITE_ENTRY_NAME.test(entryName) ||
        (linkSharedDatabases && SQLITE_DATABASE_ENTRY_NAME.test(entryName)))
    ) {
      entries.add(entryName);
    }
  }

  yield* Effect.forEach(
    PRIVATE_ENTRY_NAMES,
    (entryName) =>
      entryName === "auth.json"
        ? Effect.void
        : removePrivateSymlink({
            fileSystem,
            sharedHomePath: layout.sharedHomePath,
            effectiveHomePath,
            entryName,
          }),
    { discard: true },
  );

  yield* Effect.forEach(
    entries,
    (entryName) => {
      if (PRIVATE_ENTRY_NAMES.has(entryName)) {
        return Effect.void;
      }
      return ensureSymlink({
        fileSystem,
        sharedHomePath: layout.sharedHomePath,
        effectiveHomePath,
        entryName,
      });
    },
    { discard: true },
  );

  yield* ensureShadowAuthIsPrivate({
    fileSystem,
    sharedHomePath: layout.sharedHomePath,
    effectiveHomePath,
  });
});

/** Prepares the shadow home and returns the environment Codex must launch with. */
export const materializeCodexShadowHome = Effect.fn("materializeCodexShadowHome")(function* (
  layout: CodexHomeLayout,
  environment: NodeJS.ProcessEnv,
) {
  // Refuse a stranded SQLite layout before touching the shadow home.
  const launchEnvironment = yield* codexHomeEnvironment(layout, environment);
  // Windows never links a database, even one the shared home gained after the check above.
  yield* materializeShadowHome(
    layout,
    !environment.CODEX_SQLITE_HOME?.trim() &&
      launchEnvironment.CODEX_SQLITE_HOME === layout.effectiveHomePath &&
      !(yield* HostProcess.isWindows),
  );
  return launchEnvironment;
});

export function codexContinuationIdentity(layout: CodexHomeLayout) {
  return {
    driverKind: ProviderDriverKind.make("codex"),
    continuationKey: layout.continuationKey,
  };
}
