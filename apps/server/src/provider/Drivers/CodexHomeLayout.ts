import { ProviderDriverKind, type CodexSettings } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as PlatformError from "effect/PlatformError";

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
const SHADOW_CONFLICTS_DIRECTORY = ".t3-shadow-conflicts";
// Finder maintains metadata separately for each directory, including shadow homes.
const SHADOW_LOCAL_ENTRY_NAMES = new Set([
  "log",
  "memories",
  "tmp",
  ".DS_Store",
  SHADOW_CONFLICTS_DIRECTORY,
]);
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
    operation: Schema.Literals([
      "readLink",
      "makeDirectory",
      "readDirectory",
      "remove",
      "rename",
      "symlink",
    ]),
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

const SQLITE_SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;

function sqliteBaseName(entryName: string): string | undefined {
  const suffix = SQLITE_SIDECAR_SUFFIXES.find((candidate) => entryName.endsWith(candidate));
  const baseName = suffix === undefined ? entryName : entryName.slice(0, -suffix.length);
  return baseName.endsWith(".sqlite") ? baseName : undefined;
}

// Sidecars go first, so the base is the last thing to leave the shadow home.
function conflictGroupMembers(entryName: string): ReadonlyArray<string> {
  const baseName = sqliteBaseName(entryName);
  if (baseName === undefined) return [entryName];
  return [...SQLITE_SIDECAR_SUFFIXES.map((suffix) => baseName + suffix), baseName];
}

type ResolveConflictGroup = (
  entryName: string,
) => Effect.Effect<boolean, CodexShadowHomeError, Path.Path>;

// A SQLite base and its sidecars are one unit: move every real copy aside and link what the
// shared home has, or restore all of it, so a base never pairs with another database's journal.
const replaceConflictGroup = Effect.fn("CodexHomeLayout.replaceConflictGroup")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string;
  readonly entryName: string;
  readonly sharedEntryNames: ReadonlySet<string>;
  readonly backupDirectory: Effect.Effect<string, PlatformError.PlatformError>;
}): Effect.fn.Return<boolean, CodexShadowHomeError, Path.Path> {
  const path = yield* Path.Path;
  const inspected = yield* Effect.forEach(conflictGroupMembers(input.entryName), (name) =>
    readLinkState({
      ...input,
      entryName: name,
      linkPath: path.join(input.effectiveHomePath, name),
    }).pipe(Effect.map((state) => ({ name, state }))),
  ).pipe(Effect.result);
  if (inspected._tag === "Failure") {
    yield* Effect.logWarning(
      `Could not inspect Codex shadow home entry '${input.entryName}'; it stays local until a later setup.`,
      { entryName: input.entryName, cause: inspected.failure },
    );
    return false;
  }
  const members = inspected.success;
  const conflicts = members.filter((member) => member.state._tag === "NotSymlink");
  if (conflicts.length === 0) return true;
  const baseName = sqliteBaseName(input.entryName);
  const baseIsLocalOnly =
    baseName !== undefined &&
    !input.sharedEntryNames.has(baseName) &&
    conflicts.some((member) => member.name === baseName);
  if (baseIsLocalOnly) return false;

  const moved: Array<{
    readonly name: string;
    readonly path: string;
    readonly backupPath: string;
  }> = [];
  const linked: Array<string> = [];
  const replace = Effect.gen(function* () {
    for (const { name } of conflicts) {
      const memberPath = path.join(input.effectiveHomePath, name);
      const backupPath = path.join(yield* input.backupDirectory, name);
      yield* input.fileSystem.rename(memberPath, backupPath);
      moved.push({ name, path: memberPath, backupPath });
    }
    for (const { name, state } of members) {
      if (state._tag === "Symlink" || !input.sharedEntryNames.has(name)) continue;
      const link = path.join(input.effectiveHomePath, name);
      yield* input.fileSystem.symlink(path.join(input.sharedHomePath, name), link);
      linked.push(link);
    }
  });
  const fileSystemError = (
    operation: "remove" | "rename",
    failedPath: string,
    cause: PlatformError.PlatformError,
    entryName?: string,
    targetPath?: string,
  ) =>
    new CodexShadowHomeFileSystemError({
      sharedHomePath: input.sharedHomePath,
      effectiveHomePath: input.effectiveHomePath,
      operation,
      path: failedPath,
      ...(targetPath === undefined ? {} : { targetPath }),
      ...(entryName === undefined ? {} : { entryName }),
      cause,
    });
  const restore = Effect.gen(function* () {
    const failures: Array<CodexShadowHomeFileSystemError> = [];
    for (const link of [...linked].reverse()) {
      yield* input.fileSystem
        .remove(link)
        .pipe(
          Effect.catch((cause) =>
            Effect.sync(() => failures.push(fileSystemError("remove", link, cause))),
          ),
        );
    }
    for (const entry of [...moved].reverse()) {
      yield* input.fileSystem
        .rename(entry.backupPath, entry.path)
        .pipe(
          Effect.catch((cause) =>
            Effect.sync(() =>
              failures.push(
                fileSystemError("rename", entry.backupPath, cause, entry.name, entry.path),
              ),
            ),
          ),
        );
    }
    return failures;
  });

  // Interrupting between moves would skip the restore and split the family.
  return yield* replace.pipe(
    Effect.andThen(
      Effect.forEach(
        moved,
        (entry) =>
          Effect.logWarning(
            `Moved Codex shadow home entry '${entry.name}' to '${entry.backupPath}' so the shared copy can be linked.`,
            { entryName: entry.name, path: entry.path, backupPath: entry.backupPath },
          ),
        { discard: true },
      ),
    ),
    Effect.as(true),
    Effect.catch((cause) =>
      Effect.gen(function* () {
        const restoreFailures = yield* restore;
        const annotations = {
          entryName: input.entryName,
          path: path.join(input.effectiveHomePath, input.entryName),
          cause,
        };
        // A half-restored SQLite family is unsafe to open, so stop instead of starting Codex on it.
        if (restoreFailures.length > 0) {
          yield* Effect.logError(
            `Could not restore Codex shadow home entry '${input.entryName}' after a failed replacement.`,
            { ...annotations, restoreFailures },
          );
          return yield* restoreFailures[0]!;
        }
        yield* Effect.logWarning(
          `Could not replace Codex shadow home entry '${input.entryName}' with a shared link; it stays local until a later setup.`,
          annotations,
        );
        return false;
      }),
    ),
    Effect.uninterruptible,
  );
});

const ensureSymlink = Effect.fn("CodexHomeLayout.ensureSymlink")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string;
  readonly entryName: string;
  readonly resolveConflictGroup: ResolveConflictGroup;
}): Effect.fn.Return<void, CodexShadowHomeError, Path.Path> {
  const path = yield* Path.Path;
  const target = path.join(input.sharedHomePath, input.entryName);
  const link = path.join(input.effectiveHomePath, input.entryName);
  // Resolve a SQLite family before linking any member of it.
  if (sqliteBaseName(input.entryName) !== undefined) {
    if (!(yield* input.resolveConflictGroup(input.entryName))) return;
  }
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
      yield* input.resolveConflictGroup(input.entryName);
      return;
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

export const materializeCodexShadowHome = Effect.fn("materializeCodexShadowHome")(function* (
  layout: CodexHomeLayout,
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
  // Created only when a conflict needs it; the random suffix keeps runs from colliding.
  const backupDirectory = yield* Effect.cached(
    Effect.gen(function* () {
      const conflictsPath = path.join(effectiveHomePath, SHADOW_CONFLICTS_DIRECTORY);
      yield* fileSystem.makeDirectory(conflictsPath, { recursive: true });
      const timestamp = DateTime.formatIso(yield* DateTime.now).replace(/[:.]/g, "-");
      return yield* fileSystem.makeTempDirectory({
        directory: conflictsPath,
        prefix: `${timestamp}-`,
      });
    }),
  );
  const sharedEntryNameSet = new Set(sharedEntryNames);
  const conflictGroupOutcomes = new Map<string, boolean>();
  const resolveConflictGroup: ResolveConflictGroup = (entryName) => {
    const groupKey = sqliteBaseName(entryName) ?? entryName;
    const outcome = conflictGroupOutcomes.get(groupKey);
    if (outcome !== undefined) return Effect.succeed(outcome);
    return replaceConflictGroup({
      fileSystem,
      sharedHomePath: layout.sharedHomePath,
      effectiveHomePath,
      entryName,
      sharedEntryNames: sharedEntryNameSet,
      backupDirectory,
    }).pipe(Effect.tap((result) => Effect.sync(() => conflictGroupOutcomes.set(groupKey, result))));
  };
  const entries = new Set<string>(KNOWN_SHARED_DIRECTORIES);
  for (const entryName of sharedEntryNames) {
    if (!PRIVATE_ENTRY_NAMES.has(entryName) && !SHADOW_LOCAL_ENTRY_NAMES.has(entryName)) {
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
        resolveConflictGroup,
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

export function codexContinuationIdentity(layout: CodexHomeLayout) {
  return {
    driverKind: ProviderDriverKind.make("codex"),
    continuationKey: layout.continuationKey,
  };
}
