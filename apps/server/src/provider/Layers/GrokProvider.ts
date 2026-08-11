import {
  type GrokSettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderModel,
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
import { discoverGrokSkills } from "../Drivers/GrokSkills.ts";
import { resolveGrokSlashCommands } from "../Drivers/GrokSlashCommands.ts";

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
/** Grok emits available_commands during session/new; allow a short settle window. */
const GROK_AVAILABLE_COMMANDS_WAIT_MS = 2_000;
const GROK_AVAILABLE_COMMANDS_POLL_MS = 50;

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

type GrokAcpDiscoveryResult = {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly availableCommands: ReadonlyArray<EffectAcpSchema.AvailableCommand>;
};

/**
 * Prefer the richer command snapshot: longer lists win (partial first
 * emissions lose to later fuller ones); equal length keeps the newer read so
 * description/hint enrichments for the same names still apply.
 */
function preferRicherAvailableCommands(
  current: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
  candidate: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
): ReadonlyArray<EffectAcpSchema.AvailableCommand> {
  if (candidate.length === 0) {
    return current;
  }
  if (candidate.length >= current.length) {
    return candidate;
  }
  return current;
}

/**
 * Poll for ACP available commands for the full GROK_AVAILABLE_COMMANDS_WAIT_MS
 * window (does not share the ACP start timeout budget).
 *
 * Grok may emit a partial `available_commands_update` during `session/new` and
 * a fuller list shortly after, so we never early-exit on the first non-empty
 * snapshot. We keep the richest list seen and always take a final read at the
 * end of the window so a late update in the last poll interval is not missed.
 */
const waitForGrokAvailableCommands = (
  getAvailableCommands: Effect.Effect<ReadonlyArray<EffectAcpSchema.AvailableCommand>>,
): Effect.Effect<ReadonlyArray<EffectAcpSchema.AvailableCommand>> =>
  Effect.gen(function* () {
    const poll = Duration.millis(GROK_AVAILABLE_COMMANDS_POLL_MS);
    // Monotonic deadline: wall clock can jump backward on NTP corrections and
    // would otherwise stretch this settle window unboundedly.
    const waitNanos = BigInt(GROK_AVAILABLE_COMMANDS_WAIT_MS) * 1_000_000n;
    const deadlineNanos = (yield* Clock.monotonicTimeNanos) + waitNanos;

    let best = yield* getAvailableCommands;

    while ((yield* Clock.monotonicTimeNanos) < deadlineNanos) {
      yield* Effect.sleep(poll);
      best = preferRicherAvailableCommands(best, yield* getAvailableCommands);
    }

    return preferRicherAvailableCommands(best, yield* getAvailableCommands);
  });

/**
 * Start ACP under the model-discovery timeout, then settle available commands
 * under a separate short budget so a slow-but-successful start cannot be
 * flipped into a timeout by the command wait.
 */
const discoverGrokModelsViaAcp = (
  grokSettings: GrokSettings,
  environment: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Effect.Effect<
  Option.Option<GrokAcpDiscoveryResult>,
  unknown,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acp = yield* makeGrokAcpRuntime({
      grokSettings,
      environment,
      childProcessSpawner,
      cwd,
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    const startedOption = yield* acp
      .start()
      .pipe(Effect.timeoutOption(GROK_ACP_MODEL_DISCOVERY_TIMEOUT_MS));
    if (Option.isNone(startedOption)) {
      return Option.none();
    }
    const started = startedOption.value;
    // Best-effort: never fails discovery if commands never arrive.
    const availableCommands = yield* waitForGrokAvailableCommands(acp.getAvailableCommands);
    return Option.some({
      models: buildGrokDiscoveredModelsFromSessionModelState(started.sessionSetupResult.models),
      availableCommands,
    } satisfies GrokAcpDiscoveryResult);
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
  cwd?: string,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = grokModelsFromSettings(grokSettings.customModels);
  const probeCwd = cwd && cwd.trim().length > 0 ? cwd : process.cwd();

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

  // Skills and ACP discovery are independent: skills still populate when ACP
  // fails, and slash commands fall back to invocable skills when needed.
  // ACP start has its own 15s budget; command settle is separate and best-effort.
  const [discoveryExit, skills] = yield* Effect.all(
    [
      discoverGrokModelsViaAcp(grokSettings, environment, probeCwd).pipe(Effect.exit),
      discoverGrokSkills(grokSettings, probeCwd, environment),
    ],
    { concurrency: "unbounded" },
  );

  if (Exit.isFailure(discoveryExit)) {
    yield* Effect.logWarning("Grok ACP model discovery failed", {
      errorTag: causeErrorTag(discoveryExit.cause),
    });
    const slashCommands = resolveGrokSlashCommands({
      availableCommands: [],
      skills,
    });
    return buildServerProvider({
      presentation: GROK_PRESENTATION,
      enabled: grokSettings.enabled,
      checkedAt,
      models: fallbackModels,
      skills,
      slashCommands,
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
    const slashCommands = resolveGrokSlashCommands({
      availableCommands: [],
      skills,
    });
    return buildServerProvider({
      presentation: GROK_PRESENTATION,
      enabled: grokSettings.enabled,
      checkedAt,
      models: fallbackModels,
      skills,
      slashCommands,
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
  const slashCommands = resolveGrokSlashCommands({
    availableCommands: discovery.availableCommands,
    skills,
  });

  return buildServerProvider({
    presentation: GROK_PRESENTATION,
    enabled: grokSettings.enabled,
    checkedAt,
    models,
    skills,
    slashCommands,
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
