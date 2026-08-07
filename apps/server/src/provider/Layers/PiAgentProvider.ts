import {
  type ModelCapabilities,
  type PiAgentSettings,
  type ServerProviderModel,
  ThreadId,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildSelectOptionDescriptor,
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { makePiAgentSessionRuntime, type PiAvailableModel } from "./PiAgentSessionRuntime.ts";

const PI_PRESENTATION = {
  displayName: "Pi",
  showInteractionModeToggle: false,
  // Pi switches models in-session via set_model, so a new thread is not
  // required for a model change.
  requiresNewThreadForModelChange: false,
} as const;

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const MODEL_PROBE_TIMEOUT_MS = 10_000;

/**
 * Static catalog used when the RPC model probe (`get_available_models`)
 * cannot be completed. Custom models from settings are always appended on
 * top.
 */
const PI_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "anthropic/claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    isCustom: false,
    capabilities: piModelCapabilities(true),
  },
  {
    slug: "anthropic/claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    isCustom: false,
    capabilities: piModelCapabilities(false),
  },
  {
    slug: "openai/gpt-5",
    name: "GPT-5",
    isCustom: false,
    capabilities: piModelCapabilities(true),
  },
];

function piModelCapabilities(reasoning: boolean): ModelCapabilities {
  return createModelCapabilities({
    optionDescriptors: [
      buildSelectOptionDescriptor({
        id: "reasoningEffort",
        label: "Reasoning",
        options: [
          { value: "off", label: "Off" },
          { value: "minimal", label: "Minimal" },
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium", isDefault: true },
          { value: "high", label: "High" },
          { value: "xhigh", label: "Extra High" },
          { value: "max", label: "Max" },
        ],
      }),
    ],
  });
}

function piModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = PI_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], piModelCapabilities(true));
}

export function buildInitialPiAgentProviderSnapshot(
  piSettings: PiAgentSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = piModelsFromSettings(piSettings.customModels);

    if (!piSettings.enabled) {
      return buildServerProvider({
        presentation: PI_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Pi is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Pi CLI availability...",
      },
    });
  });
}

const runPiVersionCommand = (
  piSettings: PiAgentSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const command = piSettings.binaryPath || "pi";
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

/**
 * Probe pi's model catalog over the verified RPC surface: spawn
 * `pi --mode rpc` (the same transport sessions use) and ask for
 * `get_available_models`. The runtime owns the process; closing the scope
 * kills it. Best-effort — the caller falls back to the static catalog on
 * any failure, matching the adapter's posture that a catalog RPC failure
 * must not fail session start.
 */
const probePiAvailableModels = (
  piSettings: PiAgentSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const runtime = yield* makePiAgentSessionRuntime({
      threadId: ThreadId.make(yield* crypto.randomUUIDv4),
      binaryPath: piSettings.binaryPath || "pi",
      ...(piSettings.homePath?.trim() ? { homePath: piSettings.homePath.trim() } : {}),
      ...(piSettings.launchArgs?.trim() ? { launchArgs: piSettings.launchArgs } : {}),
      environment,
      cwd: process.cwd(),
      runtimeMode: "full-access",
      clientName: "t3-code-provider-probe",
    });
    return yield* runtime.getAvailableModels();
  }).pipe(Effect.scoped);

/**
 * Map RPC catalog entries to provider models. T3 slugs are `provider/id`
 * (pi resolves bare ids against its configured providers, so entries
 * without a provider stay bare). Verified against pi 0.83.0.
 */
export function piDiscoveredModelsFromAvailableModels(
  availableModels: ReadonlyArray<PiAvailableModel>,
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  return availableModels
    .map((model): ServerProviderModel | undefined => {
      const id = model.id.trim();
      if (!id) {
        return undefined;
      }
      const provider = model.provider?.trim();
      const slug = provider ? `${provider}/${id}` : id;
      if (seen.has(slug)) {
        return undefined;
      }
      seen.add(slug);
      return {
        slug,
        name: model.name?.trim() || slug,
        isCustom: false,
        capabilities: piModelCapabilities(true),
      };
    })
    .filter((model): model is ServerProviderModel => model !== undefined);
}

export const checkPiAgentProviderStatus = Effect.fn("checkPiAgentProviderStatus")(function* (
  piSettings: PiAgentSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = piModelsFromSettings(piSettings.customModels);

  if (!piSettings.enabled) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Pi is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runPiVersionCommand(piSettings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Pi CLI health check failed.", { errorTag: error._tag });
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Pi CLI (`pi`) is not installed or not on PATH."
          : "Failed to execute Pi CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Pi CLI is installed but timed out while running `pi --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Pi CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Pi CLI is installed but failed to run.",
      },
    });
  }

  // Model discovery over RPC is best-effort; a failed or slow probe falls
  // back to the static catalog and never degrades the provider status.
  const modelsResult = yield* probePiAvailableModels(piSettings, environment).pipe(
    Effect.timeoutOption(MODEL_PROBE_TIMEOUT_MS),
    Effect.result,
  );
  let discoveredModels: ReadonlyArray<ServerProviderModel> = [];
  if (Result.isFailure(modelsResult)) {
    yield* Effect.logWarning("Pi RPC model probe failed; using static catalog.", {
      errorTag: modelsResult.failure._tag,
    });
  } else if (Option.isNone(modelsResult.success)) {
    yield* Effect.logWarning(
      `Pi RPC model probe timed out after ${MODEL_PROBE_TIMEOUT_MS}ms; using static catalog.`,
    );
  } else {
    discoveredModels = piDiscoveredModelsFromAvailableModels(modelsResult.success.value);
  }
  const models =
    discoveredModels.length > 0
      ? piModelsFromSettings(piSettings.customModels, discoveredModels)
      : fallbackModels;

  return buildServerProvider({
    presentation: PI_PRESENTATION,
    enabled: piSettings.enabled,
    checkedAt,
    models,
    probe: {
      installed: true,
      version,
      status: "ready",
      auth: { status: "unknown" },
    },
  });
});
