import * as NodeOS from "node:os";

import { ProviderDriverKind, type CodexSettings } from "@t3tools/contracts";
import { Effect, FileSystem, Path, Schema } from "effect";
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
] as const;

const PRIVATE_ENTRY_NAMES = new Set(["auth.json", "models_cache.json"]);
const SHADOW_LOCAL_ENTRY_NAMES = new Set(["log", "memories", "tmp"]);

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

export class CodexShadowHomeError extends Schema.TaggedErrorClass<CodexShadowHomeError>()(
  "CodexShadowHomeError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

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

function toShadowHomeError(cause: unknown): CodexShadowHomeError {
  return Schema.is(CodexShadowHomeError)(cause)
    ? cause
    : new CodexShadowHomeError({
        detail: "Failed to materialize Codex shadow home.",
        cause,
      });
}

function normalizeShadowHomeError<A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, CodexShadowHomeError, R> {
  return effect.pipe(Effect.mapError(toShadowHomeError));
}

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

const readLinkState = Effect.fn("CodexHomeLayout.readLinkState")(function* (
  fileSystem: FileSystem.FileSystem,
  linkPath: string,
): Effect.fn.Return<LinkState, CodexShadowHomeError> {
  return yield* fileSystem.readLink(linkPath).pipe(
    Effect.map((target): LinkState => ({ _tag: "Symlink", target })),
    Effect.catch((error) => {
      if (error.reason._tag === "NotFound") {
        return Effect.succeed<LinkState>({ _tag: "Missing" });
      }
      if (isNotSymlinkError(error)) {
        return Effect.succeed<LinkState>({ _tag: "NotSymlink" });
      }
      return Effect.fail(toShadowHomeError(error));
    }),
  );
});

const removePrivateSymlink = Effect.fn("CodexHomeLayout.removePrivateSymlink")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly shadowPath: string;
  readonly entryName: string;
}): Effect.fn.Return<void, CodexShadowHomeError, Path.Path> {
  const path = yield* Path.Path;
  const privatePath = path.join(input.shadowPath, input.entryName);
  const state = yield* readLinkState(input.fileSystem, privatePath);
  if (state._tag === "Symlink") {
    yield* normalizeShadowHomeError(input.fileSystem.remove(privatePath));
  }
});

const ensureSymlink = Effect.fn("CodexHomeLayout.ensureSymlink")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly shadowPath: string;
  readonly sharedPath: string;
  readonly entryName: string;
}): Effect.fn.Return<void, CodexShadowHomeError, Path.Path> {
  const path = yield* Path.Path;
  const target = path.join(input.sharedPath, input.entryName);
  const link = path.join(input.shadowPath, input.entryName);
  const state = yield* readLinkState(input.fileSystem, link);

  if (state._tag === "NotSymlink") {
    return yield* new CodexShadowHomeError({
      detail: `Cannot create Codex shadow home because '${link}' already exists and is not a symlink.`,
    });
  }

  if (state._tag === "Missing") {
    return yield* normalizeShadowHomeError(input.fileSystem.symlink(target, link));
  }

  const resolvedExisting = path.resolve(path.dirname(link), state.target);
  if (resolvedExisting !== target) {
    yield* normalizeShadowHomeError(input.fileSystem.remove(link));
    yield* normalizeShadowHomeError(input.fileSystem.symlink(target, link));
  }
});

const ensureShadowAuthIsPrivate = Effect.fn("CodexHomeLayout.ensureShadowAuthIsPrivate")(function* (
  fileSystem: FileSystem.FileSystem,
  shadowPath: string,
): Effect.fn.Return<void, CodexShadowHomeError, Path.Path> {
  const path = yield* Path.Path;
  const authPath = path.join(shadowPath, "auth.json");
  const state = yield* readLinkState(fileSystem, authPath);
  if (state._tag === "Symlink") {
    return yield* new CodexShadowHomeError({
      detail: `Codex shadow auth file '${authPath}' must be a real file, not a symlink.`,
    });
  }
});

export const materializeCodexShadowHome = Effect.fn("materializeCodexShadowHome")(function* (
  layout: CodexHomeLayout,
) {
  if (layout.mode !== "authOverlay") return;
  const effectiveHomePath = layout.effectiveHomePath;
  if (!effectiveHomePath) return;
  if (layout.sharedHomePath === effectiveHomePath) {
    return yield* new CodexShadowHomeError({
      detail: "Codex shadow home path must be different from the shared home path.",
    });
  }

  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  yield* normalizeShadowHomeError(
    Effect.all(
      [
        fileSystem.makeDirectory(layout.sharedHomePath, { recursive: true }),
        fileSystem.makeDirectory(effectiveHomePath, { recursive: true }),
        ...KNOWN_SHARED_DIRECTORIES.map((directory) =>
          fileSystem.makeDirectory(path.join(layout.sharedHomePath, directory), {
            recursive: true,
          }),
        ),
      ],
      { concurrency: "unbounded" },
    ),
  );

  const sharedEntryNames = yield* normalizeShadowHomeError(
    fileSystem.readDirectory(layout.sharedHomePath),
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
            shadowPath: effectiveHomePath,
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
        shadowPath: effectiveHomePath,
        sharedPath: layout.sharedHomePath,
        entryName,
      });
    },
    { discard: true },
  );

  yield* ensureShadowAuthIsPrivate(fileSystem, effectiveHomePath);
});

export function codexContinuationIdentity(layout: CodexHomeLayout) {
  return {
    driverKind: ProviderDriverKind.make("codex"),
    continuationKey: layout.continuationKey,
  };
}
