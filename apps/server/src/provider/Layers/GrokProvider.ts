import {
  type GrokSettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderModel,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import { makeGrokAcpRuntime, resolveGrokAcpBaseModelId } from "../acp/GrokAcpSupport.ts";
import { parseAcpAvailableCommands } from "../acp/parseAcpAvailableCommands.ts";

const GROK_PRESENTATION = {
  displayName: "Grok",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: true,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const GROK_ACP_MODEL_DISCOVERY_TIMEOUT_MS = 15_000;
/**
 * Headroom so slash-command wait + returning from discovery finishes before the
 * outer Effect.timeoutOption(GROK_ACP_MODEL_DISCOVERY_TIMEOUT_MS) fires.
 */
const GROK_ACP_DISCOVERY_TIMEOUT_RESERVE_MS = 200;
/** Ideal max wait for available_commands_update after session/new (may be capped). */
const GROK_ACP_SLASH_COMMAND_WAIT_MS = 2_000;
/**
 * After an empty update, briefly watch for a follow-up non-empty "changed"
 * update without burning the full wait budget.
 */
const GROK_ACP_SLASH_EMPTY_SETTLE_MS = 250;
const GROK_ACP_SLASH_COMMAND_POLL_MS = 50;

interface GrokAcpDiscoveryResult {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
}

const GROK_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "grok-build",
    name: "Grok Build",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

export function buildInitialGrokProviderSnapshot(
  grokSettings: GrokSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = grokModelsFromSettings(grokSettings.customModels);

    if (!grokSettings.enabled) {
      return buildServerProvider({
        presentation: GROK_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Grok is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: GROK_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Grok CLI availability...",
      },
    });
  });
}

function grokModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = GROK_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

function buildGrokDiscoveredModelsFromSessionModelState(
  modelState: EffectAcpSchema.SessionModelState | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!modelState || modelState.availableModels.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  return modelState.availableModels
    .map((model): ServerProviderModel | undefined => {
      const slug = resolveGrokAcpBaseModelId(model.modelId);
      if (!slug || seen.has(slug)) {
        return undefined;
      }
      seen.add(slug);
      return {
        slug,
        name: model.name.trim() || slug,
        isCustom: false,
        capabilities: EMPTY_CAPABILITIES,
      };
    })
    .filter((model): model is ServerProviderModel => model !== undefined);
}

/**
 * Wait for ACP `available_commands_update` within `maxWaitMs` (remaining discovery budget).
 *
 * - Option.none = no notification yet → wait up to maxWaitMs
 * - Option.some([]) = empty → wait min(empty settle, maxWaitMs) for a non-empty follow-up
 * - Option.some(nonEmpty) = return immediately
 * - maxWaitMs <= 0 = return whatever is already on the ref (slash wait is non-fatal)
 */
const waitForGrokSlashCommands = (
  slashCommandsRef: Ref.Ref<Option.Option<ReadonlyArray<ServerProviderSlashCommand>>>,
  maxWaitMs: number,
) =>
  Effect.gen(function* () {
    const readCommands = Effect.map(Ref.get(slashCommandsRef), (commandsOpt) =>
      Option.isSome(commandsOpt) ? commandsOpt.value : [],
    );

    if (maxWaitMs <= 0) {
      return yield* readCommands;
    }

    const startedAt = yield* Clock.currentTimeMillis;
    const emptySettleMs = Math.min(GROK_ACP_SLASH_EMPTY_SETTLE_MS, maxWaitMs);
    let emptySeenAt: number | undefined;

    while (true) {
      const now = yield* Clock.currentTimeMillis;
      const elapsed = now - startedAt;
      const commandsOpt = yield* Ref.get(slashCommandsRef);

      if (Option.isSome(commandsOpt) && commandsOpt.value.length > 0) {
        return commandsOpt.value;
      }

      if (Option.isSome(commandsOpt) && commandsOpt.value.length === 0) {
        emptySeenAt ??= now;
        if (now - emptySeenAt >= emptySettleMs) {
          return commandsOpt.value;
        }
      }

      const remaining = maxWaitMs - elapsed;
      if (remaining <= 0) {
        return Option.isSome(commandsOpt) ? commandsOpt.value : [];
      }

      yield* Effect.sleep(Duration.millis(Math.min(GROK_ACP_SLASH_COMMAND_POLL_MS, remaining)));
    }
  });

const discoverGrokModelsViaAcp = (
  grokSettings: GrokSettings,
  environment: NodeJS.ProcessEnv = process.env,
  /**
   * Workspace root for `session/new`. Must match live Grok threads so project-local
   * skills (`.agents/skills`, `.grok/skills`, etc.) match the composer menu.
   */
  cwd: string = process.cwd(),
) =>
  Effect.gen(function* () {
    // Wall clock for the whole discovery effect so slash wait cannot overrun the
    // outer GROK_ACP_MODEL_DISCOVERY_TIMEOUT_MS and discard already-found models.
    const discoveryStartedAt = yield* Clock.currentTimeMillis;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acp = yield* makeGrokAcpRuntime({
      grokSettings,
      environment,
      childProcessSpawner,
      cwd,
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });

    // Collect ACP available_commands_update (skills + builtins) for the composer.
    // Register before start so we do not miss the post-session/new notification.
    // Option.none = not yet received; Option.some(list) = notification seen (list may be empty).
    const slashCommandsRef = yield* Ref.make(
      Option.none<ReadonlyArray<ServerProviderSlashCommand>>(),
    );
    yield* acp.handleSessionUpdate((notification) => {
      const update = notification.update;
      if (update.sessionUpdate !== "available_commands_update") {
        return Effect.void;
      }
      return Ref.set(
        slashCommandsRef,
        Option.some(parseAcpAvailableCommands(update.availableCommands)),
      );
    });

    const started = yield* acp.start();
    const models = buildGrokDiscoveredModelsFromSessionModelState(
      started.sessionSetupResult.models,
    );

    // Slash discovery is best-effort: cap wait by remaining outer budget so a slow
    // acp.start() never turns a successful model discovery into a timeout failure.
    const now = yield* Clock.currentTimeMillis;
    const remainingDiscoveryMs = Math.max(
      0,
      GROK_ACP_MODEL_DISCOVERY_TIMEOUT_MS -
        (now - discoveryStartedAt) -
        GROK_ACP_DISCOVERY_TIMEOUT_RESERVE_MS,
    );
    const slashWaitMs = Math.min(GROK_ACP_SLASH_COMMAND_WAIT_MS, remainingDiscoveryMs);

    const slashCommandsOpt = yield* Ref.get(slashCommandsRef);
    const slashCommands =
      Option.isSome(slashCommandsOpt) && slashCommandsOpt.value.length > 0
        ? slashCommandsOpt.value
        : yield* waitForGrokSlashCommands(slashCommandsRef, slashWaitMs);

    return { models, slashCommands } satisfies GrokAcpDiscoveryResult;
  }).pipe(Effect.scoped);

const runGrokVersionCommand = (
  grokSettings: GrokSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const command = grokSettings.binaryPath || "grok";
    const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], {
      env: environment,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

export const checkGrokProviderStatus = Effect.fn("checkGrokProviderStatus")(function* (
  grokSettings: GrokSettings,
  environment: NodeJS.ProcessEnv = process.env,
  /**
   * Server workspace cwd from `ServerConfig` (not `process.cwd()`). Used for ACP
   * skill/command discovery so the slash menu matches live Grok threads.
   */
  cwd: string = process.cwd(),
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = grokModelsFromSettings(grokSettings.customModels);

  if (!grokSettings.enabled) {
    return buildServerProvider({
      presentation: GROK_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Grok is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runGrokVersionCommand(grokSettings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Grok CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: GROK_PRESENTATION,
      enabled: grokSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Grok CLI (`grok`) is not installed or not on PATH."
          : "Failed to execute Grok CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: GROK_PRESENTATION,
      enabled: grokSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Grok CLI is installed but timed out while running `grok --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Grok CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: GROK_PRESENTATION,
      enabled: grokSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Grok CLI is installed but failed to run.",
      },
    });
  }

  const discoveryExit = yield* discoverGrokModelsViaAcp(grokSettings, environment, cwd).pipe(
    Effect.timeoutOption(GROK_ACP_MODEL_DISCOVERY_TIMEOUT_MS),
    Effect.exit,
  );
  if (Exit.isFailure(discoveryExit)) {
    yield* Effect.logWarning("Grok ACP model discovery failed", {
      errorTag: causeErrorTag(discoveryExit.cause),
    });
    return buildServerProvider({
      presentation: GROK_PRESENTATION,
      enabled: grokSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Grok CLI is installed but ACP startup failed. Check server logs for details.",
      },
    });
  }
  if (Option.isNone(discoveryExit.value)) {
    yield* Effect.logWarning(
      `Grok ACP model discovery timed out after ${GROK_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.`,
    );
    return buildServerProvider({
      presentation: GROK_PRESENTATION,
      enabled: grokSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `Grok CLI is installed but ACP startup timed out after ${GROK_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.`,
      },
    });
  }
  const discovery = discoveryExit.value.value;
  const models =
    discovery.models.length > 0
      ? grokModelsFromSettings(grokSettings.customModels, discovery.models)
      : fallbackModels;

  return buildServerProvider({
    presentation: GROK_PRESENTATION,
    enabled: grokSettings.enabled,
    checkedAt,
    models,
    slashCommands: discovery.slashCommands,
    probe: {
      installed: true,
      version,
      status: "ready",
      auth: { status: "unknown" },
    },
  });
});

export const enrichGrokSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Grok version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
