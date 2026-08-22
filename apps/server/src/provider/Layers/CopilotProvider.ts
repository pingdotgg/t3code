import {
  type CopilotSettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderModel,
  type ServerProviderSkill,
} from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
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
import type { AcpAvailableCommand } from "../acp/AcpRuntimeModel.ts";
import { makeCopilotAcpRuntime, resolveCopilotBaseModelId } from "../acp/CopilotAcpSupport.ts";

const COPILOT_PRESENTATION = {
  displayName: "GitHub Copilot",
  badgeLabel: "Preview",
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: true,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const COPILOT_ACP_DISCOVERY_TIMEOUT_MS = 25_000;
const COPILOT_ACP_COMMANDS_WAIT = Duration.seconds(8);

export function buildInitialCopilotProviderSnapshot(
  copilotSettings: CopilotSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = copilotModelsFromSettings(copilotSettings.customModels);

    if (!copilotSettings.enabled) {
      return buildServerProvider({
        presentation: COPILOT_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "GitHub Copilot is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking GitHub Copilot CLI availability...",
      },
    });
  });
}

function copilotModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = [],
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

function buildCopilotDiscoveredModelsFromSessionModelState(
  modelState: EffectAcpSchema.SessionModelState | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!modelState || modelState.availableModels.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  return modelState.availableModels
    .map((model): ServerProviderModel | undefined => {
      const slug = resolveCopilotBaseModelId(model.modelId);
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
 * Maps ACP `available_commands_update` entries onto the shared skill shape.
 *
 * ponytail: Copilot skills are slash commands over ACP, so `path` carries the
 * invocation (`/name`) rather than a file path. Swap to real paths when
 * upstream exposes skill files.
 */
export function copilotSkillsFromCommands(
  commands: ReadonlyArray<AcpAvailableCommand>,
): ReadonlyArray<ServerProviderSkill> {
  return commands.map((command) => ({
    name: command.name,
    ...(command.description ? { description: command.description } : {}),
    path: `/${command.name}`,
    scope: "agent",
    enabled: true,
  }));
}

interface CopilotAcpDiscovery {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly commands: ReadonlyArray<AcpAvailableCommand>;
}

export const discoverCopilotViaAcp = (
  copilotSettings: CopilotSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acp = yield* makeCopilotAcpRuntime({
      copilotSettings,
      environment,
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    const started = yield* acp.start();
    const models = buildCopilotDiscoveredModelsFromSessionModelState(
      started.sessionSetupResult.models,
    );
    const commandsDeferred = yield* Deferred.make<ReadonlyArray<AcpAvailableCommand>>();
    const commandsConsumer = yield* Stream.runDrain(
      Stream.mapEffect(acp.getEvents(), (event) =>
        event._tag === "AvailableCommandsChanged"
          ? Deferred.succeed(commandsDeferred, event.commands).pipe(Effect.asVoid)
          : Effect.void,
      ),
    ).pipe(Effect.forkScoped);
    const commandsUpdate = yield* Deferred.await(commandsDeferred).pipe(
      Effect.timeoutOption(COPILOT_ACP_COMMANDS_WAIT),
    );
    yield* Fiber.interrupt(commandsConsumer);
    return {
      models,
      commands: Option.getOrElse(commandsUpdate, () => []),
    } satisfies CopilotAcpDiscovery;
  }).pipe(Effect.scoped);

const runCopilotVersionCommand = (
  copilotSettings: CopilotSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const command = copilotSettings.binaryPath || "copilot";
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

export const checkCopilotProviderStatus = Effect.fn("checkCopilotProviderStatus")(function* (
  copilotSettings: CopilotSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = copilotModelsFromSettings(copilotSettings.customModels);

  if (!copilotSettings.enabled) {
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "GitHub Copilot is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runCopilotVersionCommand(copilotSettings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("GitHub Copilot CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: copilotSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "GitHub Copilot CLI (`copilot`) is not installed or not on PATH."
          : "Failed to execute GitHub Copilot CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: copilotSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "GitHub Copilot CLI is installed but timed out while running `copilot --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("GitHub Copilot CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: copilotSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "GitHub Copilot CLI is installed but failed to run.",
      },
    });
  }

  const discoveryExit = yield* discoverCopilotViaAcp(copilotSettings, environment).pipe(
    Effect.timeoutOption(COPILOT_ACP_DISCOVERY_TIMEOUT_MS),
    Effect.exit,
  );
  if (Exit.isFailure(discoveryExit)) {
    yield* Effect.logWarning("GitHub Copilot ACP discovery failed", {
      errorTag: causeErrorTag(discoveryExit.cause),
    });
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: copilotSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message:
          "GitHub Copilot CLI is installed but ACP startup failed. Check server logs for details.",
      },
    });
  }
  if (Option.isNone(discoveryExit.value)) {
    yield* Effect.logWarning(
      `GitHub Copilot ACP discovery timed out after ${COPILOT_ACP_DISCOVERY_TIMEOUT_MS}ms.`,
    );
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: copilotSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `GitHub Copilot CLI is installed but ACP startup timed out after ${COPILOT_ACP_DISCOVERY_TIMEOUT_MS}ms.`,
      },
    });
  }
  const discovered = discoveryExit.value.value;
  const models =
    discovered.models.length > 0
      ? copilotModelsFromSettings(copilotSettings.customModels, discovered.models)
      : fallbackModels;
  const skills = copilotSkillsFromCommands(discovered.commands);

  return buildServerProvider({
    presentation: COPILOT_PRESENTATION,
    enabled: copilotSettings.enabled,
    checkedAt,
    models,
    skills,
    probe: {
      installed: true,
      version,
      status: "ready",
      auth: { status: "unknown" },
    },
  });
});

export const enrichCopilotSnapshot = (input: {
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
      Effect.logWarning("GitHub Copilot version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
