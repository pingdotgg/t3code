// @effect-diagnostics nodeBuiltinImport:off -- the SDK takes a Node ChildProcess for the CLI.
import { resolveSettings as resolveClaudeSettings } from "@anthropic-ai/claude-agent-sdk";
import type { Settings as ClaudeSdkSettings } from "@anthropic-ai/claude-agent-sdk";

import * as HostProcess from "@t3tools/shared/HostProcess";

import type { ModelSelection, ThreadId } from "@t3tools/contracts";

import * as Effect from "effect/Effect";

import * as FileSystem from "effect/FileSystem";

import * as Option from "effect/Option";

import * as Path from "effect/Path";

import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { discoverClaudeSkills } from "../../provider/Drivers/ClaudeSkills.ts";

import { compileClaudeModelSelection } from "../../claudeModelOptions.ts";

import * as ServerSettings from "../../serverSettings.ts";

import { resolveClaudeHomePath } from "../../provider/Drivers/ClaudeHome.ts";

import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  resolveClaudeCatalogContextWindowTokens,
  scopeClaudeModelCatalog,
} from "../../provider/ClaudeModelCatalog.ts";

import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type { ClaudeAdapterV2Options } from "./ClaudeAdapterV2.ts";
import { ClaudeBypassSettings } from "./ClaudeRuntimePolicy.ts";
import { claudeBypassAvailability } from "./ClaudeRuntimePolicy.ts";
import { claudeSdkBypassSettings } from "./ClaudeRuntimePolicy.ts";
import { claudeToolSearchOverride } from "./ClaudeQueryOptions.ts";
import { decodeClaudeBypassSettings } from "./ClaudeRuntimePolicy.ts";
import { decodeClaudeEnvSettings } from "./ClaudeRuntimePolicy.ts";
import { decodeClaudeLaunchArgBypassSettings } from "./ClaudeRuntimePolicy.ts";
import { decodeClaudePromptCacheTtl } from "./ClaudeRuntimePolicy.ts";
import { decodeClaudeSubagentCacheSettings } from "./ClaudeRuntimePolicy.ts";
import { readClaudeLaunchArgSettings } from "./ClaudeQueryLaunchArgs.ts";

export const makeClaudeAdapterEnv = Effect.fn("ClaudeAdapterEnv.make")(function* (
  adapterOptions: ClaudeAdapterV2Options,
) {
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const serverSettings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
  const { attachmentsDir, fileSystem, path, random, idAllocator, queryRunner } = adapterOptions;
  const subagentModelCatalog = scopeClaudeModelCatalog(
    BUNDLED_CLAUDE_MODEL_CATALOG,
    adapterOptions.settings.customModels,
  );
  // Results report the window Claude Code compacts against; outside the catalog it is the only source.
  const reportedContextWindows = new Map<string, number>();
  const claudeContextWindow = (modelSelection: ModelSelection): number | null =>
    resolveClaudeCatalogContextWindowTokens(BUNDLED_CLAUDE_MODEL_CATALOG, modelSelection) ??
    reportedContextWindows.get(compileClaudeModelSelection(modelSelection).apiModelId) ??
    null;
  const continuationRequests = adapterOptions.continuationRequests ?? {
    offer: () => Effect.void,
  };
  const homePath = yield* resolveClaudeHomePath(
    adapterOptions.settings,
    adapterOptions.environment,
  ).pipe(Effect.provideService(Path.Path, path));
  const hostEnvironment = yield* HostProcess.Environment;
  const hostPlatform = yield* HostProcess.Platform;
  const customHome =
    adapterOptions.settings.homePath.trim().length > 0 ||
    adapterOptions.environment.CLAUDE_CONFIG_DIR !== hostEnvironment.CLAUDE_CONFIG_DIR;
  const announcedBypassDowngrades = new Set<ThreadId>();
  const readBypassSettings = (filePath: string) =>
    fileSystem.readFileString(filePath).pipe(
      Effect.flatMap(decodeClaudeBypassSettings),
      Effect.catchReason("PlatformError", "NotFound", () =>
        Effect.succeed({} as typeof ClaudeBypassSettings.Type),
      ),
    );
  const resolveBypassAvailability = Effect.fn("ClaudeAdapterV2.resolveBypassAvailability")(
    function* (cwd: string | null) {
      // resolveSettings does not initialize remote-cache eligibility in the SDK host.
      // Keep the payload intact so the SDK also honors managedSourcesBehavior.
      const remote = yield* readBypassSettings(path.join(homePath, "remote-settings.json"));
      const home = customHome
        ? yield* readBypassSettings(path.join(homePath, "settings.json"))
        : {};
      const resolved = yield* Effect.tryPromise(() =>
        resolveClaudeSettings({
          ...(cwd === null ? {} : { cwd }),
          settingSources: customHome ? ["project", "local"] : ["user", "project", "local"],
          serverManagedSettings: claudeSdkBypassSettings(remote),
        }),
      );
      const launchArgSettings = yield* readClaudeLaunchArgSettings({
        settings: adapterOptions.settings,
        cwd,
        fileSystem,
        path,
      });
      const launch = yield* decodeClaudeLaunchArgBypassSettings(launchArgSettings ?? {});
      const sources = [resolved.effective, home, remote, launch].map(claudeBypassAvailability);
      return {
        bypassDisabled: sources.some((source) => source.bypassDisabled),
        autoDisabled: sources.some((source) => source.autoDisabled),
      };
    },
  );

  // Claude Code's own subagent TTL setting, in its precedence order. Unset or unreadable means
  // Anthropic's default applies.
  const resolveSubagentPromptCacheTtl = Effect.fn("ClaudeAdapterV2.resolveSubagentPromptCacheTtl")(
    function* (cwd: string | null) {
      const fromEnvironment = decodeClaudePromptCacheTtl(
        adapterOptions.environment.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL,
      );
      if (Option.isSome(fromEnvironment)) return fromEnvironment.value;
      const resolved = yield* Effect.tryPromise(() =>
        resolveClaudeSettings({
          ...(cwd === null ? {} : { cwd }),
          settingSources: customHome ? ["project", "local"] : ["user", "project", "local"],
        }),
      ).pipe(Effect.orElseSucceed(() => undefined));
      const home = customHome
        ? yield* fileSystem.readFileString(path.join(homePath, "settings.json")).pipe(
            Effect.flatMap(decodeClaudeSubagentCacheSettings),
            Effect.orElseSucceed(() => ({ subagentPromptCacheTtl: undefined })),
          )
        : undefined;
      return resolved?.effective.subagentPromptCacheTtl ?? home?.subagentPromptCacheTtl;
    },
  );

  const readToolSearchSetting = (filePath: string) =>
    fileSystem.readFileString(filePath).pipe(
      Effect.flatMap(decodeClaudeEnvSettings),
      Effect.map((settings) => {
        const value = settings.env?.ENABLE_TOOL_SEARCH;
        return typeof value === "string" ? value : undefined;
      }),
      Effect.orElseSucceed(() => undefined),
    );
  // A worktree's .git file points at <main>/.git/worktrees/<name>, whose commondir leads back to
  // <main>/.git. A bare repository has no main checkout, so its worktree keeps its own file.
  const mainCheckoutRoot = (checkout: string) =>
    fileSystem.readFileString(path.join(checkout, ".git")).pipe(
      Effect.flatMap((pointer) => {
        const gitDir = /^gitdir:\s*(.+)$/m.exec(pointer)?.[1]?.trim();
        if (gitDir === undefined) return Effect.succeed(checkout);
        const worktreeGitDir = path.resolve(checkout, gitDir);
        return fileSystem.readFileString(path.join(worktreeGitDir, "commondir")).pipe(
          Effect.map((commonDir) => {
            const common = path.resolve(worktreeGitDir, commonDir.trim());
            return path.basename(common) === ".git" ? path.dirname(common) : checkout;
          }),
        );
      }),
      Effect.orElseSucceed(() => checkout),
    );
  // Claude Code keeps .claude/settings.local.json at the repository root, or in cwd outside a
  // repository, on Windows, or when the root is home. Its owner check is skipped: missing it only
  // leaves tool search on, Claude Code's default.
  const localSettingsDirectory = Effect.fn("ClaudeAdapterV2.localSettingsDirectory")(function* (
    cwd: string,
  ) {
    if ((yield* HostProcess.Platform) === "win32") return cwd;
    for (let directory = cwd; ; directory = path.dirname(directory)) {
      const isCheckout = yield* fileSystem
        .exists(path.join(directory, ".git"))
        .pipe(Effect.orElseSucceed(() => false));
      if (isCheckout) {
        const root = yield* mainCheckoutRoot(directory);
        return root === (yield* HostProcess.HomeDirectory) ? cwd : root;
      }
      if (path.dirname(directory) === directory) return cwd;
    }
  });
  // Settings env beats the process env, --settings over local over project over user, and a local
  // file an older Claude Code left in cwd applies under the root one. resolveSettings reads local
  // from cwd only.
  const resolveToolSearchOverride = Effect.fn("ClaudeAdapterV2.resolveToolSearchOverride")(
    function* (cwd: string | null, launchArgSettings: ClaudeSdkSettings | undefined) {
      const launchValue = launchArgSettings?.env?.ENABLE_TOOL_SEARCH;
      if (typeof launchValue === "string") return claudeToolSearchOverride(launchValue);
      const localDirectory = cwd === null ? null : yield* localSettingsDirectory(cwd);
      const settingsFiles = [
        ...(cwd === null || localDirectory === null
          ? []
          : [
              path.join(localDirectory, ".claude", "settings.local.json"),
              ...(localDirectory === cwd ? [] : [path.join(cwd, ".claude", "settings.local.json")]),
              path.join(cwd, ".claude", "settings.json"),
            ]),
        path.join(homePath, "settings.json"),
      ];
      for (const settingsFile of settingsFiles) {
        const value = yield* readToolSearchSetting(settingsFile);
        if (value !== undefined) return claudeToolSearchOverride(value);
      }
      return claudeToolSearchOverride(adapterOptions.environment.ENABLE_TOOL_SEARCH);
    },
  );

  const userInvocableSkills = (cwd: string | null) =>
    discoverClaudeSkills(
      adapterOptions.settings,
      cwd ?? undefined,
      adapterOptions.environment,
    ).pipe(
      Effect.map(
        (skills) =>
          new Map(
            skills
              .filter((skill) => skill.enabled && skill.userInvocable !== false)
              .map((skill) => [skill.name, skill]),
          ),
      ),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
  return {
    adapterOptions,
    attachmentsDir,
    fileSystem,
    path,
    random,
    idAllocator,
    queryRunner,
    mcpSessions,
    spawner,
    serverSettings,
    subagentModelCatalog,
    reportedContextWindows,
    claudeContextWindow,
    continuationRequests,
    homePath,
    hostEnvironment,
    hostPlatform,
    customHome,
    announcedBypassDowngrades,
    readBypassSettings,
    resolveBypassAvailability,
    resolveSubagentPromptCacheTtl,
    readToolSearchSetting,
    mainCheckoutRoot,
    localSettingsDirectory,
    resolveToolSearchOverride,
    userInvocableSkills,
  };
});

export type ClaudeAdapterEnv = Effect.Success<ReturnType<typeof makeClaudeAdapterEnv>>;
