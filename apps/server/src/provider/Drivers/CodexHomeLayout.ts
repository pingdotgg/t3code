// @effect-diagnostics-next-line nodeBuiltinImport:off - Effect's symlink has no type argument, and Windows needs a junction to link a directory without symlink privilege.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";

import { ProviderDriverKind, type CodexSettings } from "@t3tools/contracts";
import { isHostWindows } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as PlatformError from "effect/PlatformError";

import { expandHomePath } from "../../pathExpansion.ts";

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
] as const;

/**
 * Written into a shadow home when Windows refuses it a symlink. A marked home
 * links directories with junctions and keeps its files local: see `LinkMode`.
 */
const LOCAL_FILES_MARKER_NAME = ".t3-local-files";
const LOCAL_FILES_MARKER_TEXT =
  "Windows refused T3 Code a symlink in this Codex shadow home. Directories are linked to the Codex home with junctions. Top-level files that were not already linked stay local to this home.\n";

const PRIVATE_ENTRY_NAMES = new Set(["auth.json", "models_cache.json"]);
const SHADOW_LOCAL_ENTRY_NAMES = new Set(["log", "memories", "tmp", LOCAL_FILES_MARKER_NAME]);
const REPLACEABLE_SHARED_RUNTIME_DIRECTORIES = new Set(["mcp-oauth-locks"]);

function resolveHomePath(path: Path.Path, value: string | undefined): string {
  const expanded =
    value && value.trim().length > 0
      ? expandHomePath(value)
      : path.join(NodeOS.homedir(), ".codex");
  return path.resolve(expanded);
}

export const resolveCodexHomeLayout = Effect.fn("resolveCodexHomeLayout")(function* (
  config: CodexSettings,
): Effect.fn.Return<CodexHomeLayout, never, Path.Path> {
  const path = yield* Path.Path;
  const sharedHomePath = resolveHomePath(path, config.homePath);
  const shadowHomePath = config.shadowHomePath.trim();
  if (shadowHomePath.length === 0) {
    return {
      mode: "direct",
      sharedHomePath,
      effectiveHomePath: config.homePath.trim().length > 0 ? sharedHomePath : undefined,
      continuationKey: `codex:home:${sharedHomePath}`,
    };
  }

  const effectiveHomePath = path.resolve(expandHomePath(shadowHomePath));
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
      "symlink",
      "stat",
      "writeFile",
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

/**
 * How shared entries reach a shadow home. `junction` is the fallback for a
 * Windows process that may not create symlinks: directories are linked with
 * junctions, which need no privilege, and no file is linked, so Codex keeps
 * its own copy of each in the shadow home. File links made earlier stay.
 * The only unprivileged file link Windows has is a hard link, and that stops
 * tracking the shared file the first time either copy is replaced by rename,
 * which is how Codex rewrites `config.toml`.
 *
 * The fallback is recorded in the shadow home and kept. Codex creates its own
 * top-level files in a home that has none linked, and each of them would
 * conflict with the shared home if a later pass went back to symlinks because
 * Developer Mode had been switched on.
 */
type LinkMode = "symlink" | "junction";

function systemErrorCode(error: PlatformError.PlatformError): unknown {
  const cause = error.reason.cause;
  return typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined;
}

function isNotSymlinkError(error: PlatformError.PlatformError): boolean {
  return error.reason._tag === "Unknown" && systemErrorCode(error) === "EINVAL";
}

/** Windows refuses a symlink with EPERM, normally because the privilege is missing. */
function isSymlinkRefusedError(error: PlatformError.PlatformError): boolean {
  return systemErrorCode(error) === "EPERM";
}

/** The type `entryPath` resolves to, following links, or `undefined` when it resolves to nothing. */
const readEntryType = Effect.fn("CodexHomeLayout.readEntryType")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string;
  readonly entryPath: string;
}): Effect.fn.Return<FileSystem.File.Type | undefined, CodexShadowHomeError> {
  return yield* input.fileSystem.stat(input.entryPath).pipe(
    Effect.map((info): FileSystem.File.Type | undefined => info.type),
    Effect.catchTags({
      PlatformError: (cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.undefined
          : new CodexShadowHomeFileSystemError({
              sharedHomePath: input.sharedHomePath,
              effectiveHomePath: input.effectiveHomePath,
              operation: "stat",
              path: input.entryPath,
              cause,
            }),
    }),
  );
});

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

/**
 * Whether Windows has refused this shadow home a symlink before. Anything at
 * the marker path counts, which is exactly when `markLocalFiles` finds it taken.
 */
const hasLocalFilesMarker = Effect.fn("CodexHomeLayout.hasLocalFilesMarker")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string;
}): Effect.fn.Return<boolean, CodexShadowHomeError, Path.Path> {
  const path = yield* Path.Path;
  const state = yield* readLinkState({
    ...input,
    entryName: LOCAL_FILES_MARKER_NAME,
    linkPath: path.join(input.effectiveHomePath, LOCAL_FILES_MARKER_NAME),
  });
  return state._tag !== "Missing";
});

const markLocalFiles = Effect.fn("CodexHomeLayout.markLocalFiles")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string;
}): Effect.fn.Return<void, CodexShadowHomeError, Path.Path> {
  const path = yield* Path.Path;
  const markerPath = path.join(input.effectiveHomePath, LOCAL_FILES_MARKER_NAME);
  // Exclusive, so the write can never land on something already at that path.
  yield* input.fileSystem.writeFileString(markerPath, LOCAL_FILES_MARKER_TEXT, { flag: "wx" }).pipe(
    Effect.catchTags({
      PlatformError: (cause) =>
        cause.reason._tag === "AlreadyExists"
          ? Effect.void
          : new CodexShadowHomeFileSystemError({
              sharedHomePath: input.sharedHomePath,
              effectiveHomePath: input.effectiveHomePath,
              operation: "writeFile",
              path: markerPath,
              cause,
            }),
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

/**
 * Links one shared entry into the shadow home. Returns the link mode for the
 * entries after it, which is `junction` once Windows has refused a symlink.
 */
const ensureSymlink = Effect.fn("CodexHomeLayout.ensureSymlink")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string;
  readonly entryName: string;
  readonly linkMode: LinkMode;
}): Effect.fn.Return<LinkMode, CodexShadowHomeError, Path.Path> {
  const path = yield* Path.Path;
  const canFallBack = yield* isHostWindows;
  const target = path.join(input.sharedHomePath, input.entryName);
  const link = path.join(input.effectiveHomePath, input.entryName);
  const state = yield* readLinkState({
    ...input,
    linkPath: link,
  });

  const linkError = (cause: unknown) =>
    new CodexShadowHomeFileSystemError({
      sharedHomePath: input.sharedHomePath,
      effectiveHomePath: input.effectiveHomePath,
      operation: "symlink",
      path: link,
      targetPath: target,
      entryName: input.entryName,
      cause,
    });
  const targetIsDirectory = readEntryType({ ...input, entryPath: target }).pipe(
    Effect.map((type) => type === "Directory"),
  );
  // A junction only reaches a directory: aimed at a file it is created without
  // error and then cannot be opened. So a file gets no link, and neither does
  // an entry that disappeared after the shared home was listed.
  const createJunction = targetIsDirectory.pipe(
    Effect.flatMap((isDirectory) =>
      isDirectory
        ? Effect.tryPromise({
            try: () => NodeFSP.symlink(target, link, "junction"),
            catch: linkError,
          })
        : Effect.void,
    ),
    Effect.as("junction" as const),
  );
  const createSymlink = input.fileSystem.symlink(target, link).pipe(
    Effect.as("symlink" as const),
    Effect.catchTags({
      PlatformError: (cause) =>
        // The home is only marked once the fallback has worked for this entry.
        canFallBack && isSymlinkRefusedError(cause)
          ? createJunction.pipe(Effect.tap(() => markLocalFiles(input)))
          : linkError(cause),
    }),
  );
  const createLink = input.linkMode === "junction" ? createJunction : createSymlink;

  if (state._tag === "NotSymlink") {
    if (!REPLACEABLE_SHARED_RUNTIME_DIRECTORIES.has(input.entryName)) {
      // Junction mode never links a file, so one found here is no conflict.
      if (input.linkMode === "junction" && !(yield* targetIsDirectory)) {
        return input.linkMode;
      }
      return yield* new CodexShadowHomeEntryConflictError({
        sharedHomePath: input.sharedHomePath,
        effectiveHomePath: input.effectiveHomePath,
        entryName: input.entryName,
        linkPath: link,
        targetPath: target,
      });
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
    return yield* createLink;
  }
  return input.linkMode;
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

  let linkMode: LinkMode =
    (yield* isHostWindows) &&
    (yield* hasLocalFilesMarker({
      fileSystem,
      sharedHomePath: layout.sharedHomePath,
      effectiveHomePath,
    }))
      ? "junction"
      : "symlink";
  for (const entryName of entries) {
    if (PRIVATE_ENTRY_NAMES.has(entryName)) continue;
    linkMode = yield* ensureSymlink({
      fileSystem,
      sharedHomePath: layout.sharedHomePath,
      effectiveHomePath,
      entryName,
      linkMode,
    });
  }

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
