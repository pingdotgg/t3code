import {
  type AcpRegistrySettings,
  featuredAgentById,
  parseAcpLaunchArgs,
  ProviderDriverKind,
  type ModelCapabilities,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  buildGenericAcpSpawnInput,
  makeGenericAcpRuntime,
  resolveGenericAcpModelId,
} from "../acp/GenericAcpSupport.ts";
import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const DRIVER_KIND = ProviderDriverKind.make("acpRegistry");
const ACP_PRESENTATION = {
  displayName: "ACP",
  badgeLabel: "ACP",
  showInteractionModeToggle: true,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});
const DEFAULT_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "default",
    name: "Default",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];
const VERSION_PROBE_TIMEOUT_MS = 4_000;
const ACP_MODEL_DISCOVERY_TIMEOUT_MS = 15_000;

function installHintForSettings(settings: AcpRegistrySettings): string {
  return (
    featuredAgentById(settings.catalogId)?.installHint ??
    "Install an ACP-speaking CLI and set its command."
  );
}

function presentationFor(settings: AcpRegistrySettings) {
  return {
    ...ACP_PRESENTATION,
    displayName: featuredAgentById(settings.catalogId)?.label ?? ACP_PRESENTATION.displayName,
  };
}

function modelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(DEFAULT_MODELS, customModels ?? [], EMPTY_CAPABILITIES);
}

function modelsFromSessionSetup(
  modelState: EffectAcpSchema.SessionModelState | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!modelState || modelState.availableModels.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  return modelState.availableModels
    .map((model): ServerProviderModel | undefined => {
      const slug = resolveGenericAcpModelId(model.modelId, DRIVER_KIND);
      if (!slug || seen.has(slug)) return undefined;
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

export function buildInitialAcpRegistryProviderSnapshot(
  settings: AcpRegistrySettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = modelsFromSettings(settings.customModels);
    const command = settings.command.trim();
    const enabled = settings.enabled && command.length > 0;

    if (!settings.enabled) {
      return buildServerProvider({
        presentation: presentationFor(settings),
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "This ACP instance is disabled.",
        },
      });
    }

    return buildServerProvider({
      presentation: presentationFor(settings),
      enabled,
      checkedAt,
      models,
      probe: {
        installed: enabled,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: enabled
          ? "Checking ACP agent availability..."
          : `Configure a launch command. ${installHintForSettings(settings)}`,
      },
    });
  });
}

const discoverModelsViaAcp = (settings: AcpRegistrySettings, environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acp = yield* makeGenericAcpRuntime({
      spawn: buildGenericAcpSpawnInput(
        {
          command: settings.command.trim(),
          args: parseAcpLaunchArgs(settings.launchArgs),
        },
        process.cwd(),
        environment,
      ),
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
      ...(settings.authMethodId.trim() ? { authMethodId: settings.authMethodId.trim() } : {}),
    });
    const started = yield* acp.start();
    return modelsFromSessionSetup(started.sessionSetupResult.models);
  }).pipe(Effect.scoped);

const runVersionCommand = (settings: AcpRegistrySettings, environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const command = settings.command.trim();
    const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

export const checkAcpRegistryProviderStatus = Effect.fn("checkAcpRegistryProviderStatus")(
  function* (
    settings: AcpRegistrySettings,
    environment: NodeJS.ProcessEnv = process.env,
  ): Effect.fn.Return<
    ServerProviderDraft,
    never,
    ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
  > {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const fallbackModels = modelsFromSettings(settings.customModels);
    const presentation = presentationFor(settings);
    const command = settings.command.trim();

    if (!settings.enabled || command.length === 0) {
      return buildServerProvider({
        presentation,
        enabled: false,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message:
            command.length === 0
              ? `Configure a launch command. ${installHintForSettings(settings)}`
              : "This ACP instance is disabled.",
        },
      });
    }

    const versionResult = yield* runVersionCommand(settings, environment).pipe(
      Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(versionResult) && isCommandMissingCause(versionResult.failure)) {
      return buildServerProvider({
        presentation,
        enabled: true,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: false,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: `${command} is not installed or not on PATH. ${installHintForSettings(settings)}`,
        },
      });
    }

    const version =
      Result.isSuccess(versionResult) && Option.isSome(versionResult.success)
        ? parseGenericCliVersion(
            `${versionResult.success.value.stdout}\n${versionResult.success.value.stderr}`,
          )
        : null;

    const discovered = yield* discoverModelsViaAcp(settings, environment).pipe(
      Effect.timeoutOption(ACP_MODEL_DISCOVERY_TIMEOUT_MS),
      Effect.option,
    );
    const discoveredModels =
      discovered._tag === "Some" && discovered.value._tag === "Some" ? discovered.value.value : [];
    const models =
      discoveredModels.length > 0
        ? providerModelsFromSettings(discoveredModels, settings.customModels, EMPTY_CAPABILITIES)
        : fallbackModels;

    return buildServerProvider({
      presentation,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version,
        status: "ready",
        auth: { status: "unknown" },
        message:
          discoveredModels.length > 0
            ? "ACP session ready."
            : "ACP command found. Models will load when a session starts.",
      },
    });
  },
);
