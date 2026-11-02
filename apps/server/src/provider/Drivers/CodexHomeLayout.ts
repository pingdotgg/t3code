import { ProviderDriverKind, type CodexSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  materializeHomeOverlay,
  type HomeOverlayError,
  type OverlayAdopt,
  type OverlayPolicy,
} from "@t3tools/provider-core/server/homeOverlay";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";

export interface CodexHomeLayout {
  readonly mode: "direct" | "authOverlay";
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string | undefined;
  readonly continuationKey: string;
}

const KNOWN_SHARED_DIRECTORIES = new Set([
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
]);

// Finder maintains metadata separately for each directory, including shadow homes.
const SHADOW_LOCAL_ENTRY_NAMES = new Set(["log", "memories", "tmp", ".DS_Store"]);
// Shadow homes may create local runtime locks first; replace them with shared links because they guard shared state.
const REPLACEABLE_SHARED_RUNTIME_ENTRIES = new Map<string, OverlayAdopt>([
  ["mcp-oauth-locks", { _tag: "Replace" }],
  [
    "thread-writer-locks",
    {
      _tag: "Replace",
      // Codex deletes a thread lock on release, so one that is left may still guard a live
      // writer. Keep the local directory until a later setup finds none.
      defer: {
        when: (lockNames) =>
          lockNames.some((name) => name.endsWith(".lock") && name !== ".coordination.lock"),
        warning:
          "Codex shadow home still has thread writer locks; it will share them on a later setup.",
      },
    },
  ],
  [".sqlite-maintenance.lock", { _tag: "Replace" }],
]);

const CODEX_OVERLAY_POLICY: OverlayPolicy = {
  shared: (sharedNames) =>
    [
      ...new Set([
        ...KNOWN_SHARED_DIRECTORIES,
        ...sharedNames.filter((name) => !SHADOW_LOCAL_ENTRY_NAMES.has(name)),
      ]),
    ].map((name) => ({
      name,
      adopt: REPLACEABLE_SHARED_RUNTIME_ENTRIES.get(name) ?? { _tag: "Conflict" },
      ensureDirectory: KNOWN_SHARED_DIRECTORIES.has(name),
    })),
  mustBeReal: ["auth.json"],
  // auth.lock guards the shadow home's private auth.json.
  healIfLinked: ["auth.lock", "models_cache.json"],
  retired: [],
};

function resolveHomePath(path: Path.Path, home: string, value: string | undefined): string {
  const expanded =
    value && value.trim().length > 0 ? expandHomePath(value, home) : path.join(home, ".codex");
  return path.resolve(expanded);
}

export const resolveCodexHomeLayout = Effect.fn("resolveCodexHomeLayout")(function* (
  config: CodexSettings,
  environment: NodeJS.ProcessEnv = {},
): Effect.fn.Return<CodexHomeLayout, never, Path.Path> {
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const configuredHome =
    config.homePath.trim() ||
    (config.setupMode !== "managed" && environment.CODEX_HOME?.trim()
      ? environment.CODEX_HOME
      : "") ||
    "";
  const sharedHomePath = resolveHomePath(path, home, configuredHome);
  const shadowHomePath = config.shadowHomePath.trim();
  if (shadowHomePath.length === 0) {
    return {
      mode: "direct",
      sharedHomePath,
      effectiveHomePath: configuredHome.length > 0 ? sharedHomePath : undefined,
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
      "symlink",
      "stat",
      "link",
      "rename",
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

function toCodexShadowHomeError(error: HomeOverlayError): CodexShadowHomeError {
  const context = {
    sharedHomePath: error.sharedRoot,
    effectiveHomePath: error.accountDir,
  };
  switch (error._tag) {
    case "HomeOverlayFileSystemError":
      return new CodexShadowHomeFileSystemError({
        ...context,
        operation: error.operation,
        path: error.path,
        targetPath: error.targetPath,
        entryName: error.entryName,
        cause: error.cause,
      });
    case "HomeOverlayPathConflictError":
      return new CodexShadowHomePathConflictError(context);
    case "HomeOverlayEntryConflictError":
      return new CodexShadowHomeEntryConflictError({
        ...context,
        entryName: error.entryName,
        linkPath: error.linkPath,
        targetPath: error.targetPath,
      });
    case "HomeOverlayPrivateEntrySymlinkError":
      return new CodexShadowHomePrivateEntrySymlinkError({
        ...context,
        entryName: error.entryName,
        path: error.path,
      });
  }
}

export const materializeCodexShadowHome = Effect.fn("materializeCodexShadowHome")(function* (
  layout: CodexHomeLayout,
) {
  const effectiveHomePath = layout.effectiveHomePath;
  if (!effectiveHomePath) return;

  if (layout.mode === "direct") {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeDirectory(effectiveHomePath, { recursive: true }).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          new CodexShadowHomeFileSystemError({
            sharedHomePath: layout.sharedHomePath,
            effectiveHomePath,
            operation: "makeDirectory",
            path: effectiveHomePath,
            cause,
          }),
      }),
    );
  }

  yield* materializeHomeOverlay({
    sharedRoot: layout.sharedHomePath,
    accountDir: effectiveHomePath,
    policy: CODEX_OVERLAY_POLICY,
    active: true,
  }).pipe(Effect.mapError(toCodexShadowHomeError));
});

export function codexContinuationIdentity(layout: CodexHomeLayout) {
  return {
    driverKind: ProviderDriverKind.make("codex"),
    continuationKey: layout.continuationKey,
  };
}
