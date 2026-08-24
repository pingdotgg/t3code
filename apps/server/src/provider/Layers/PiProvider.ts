import {
  type ModelCapabilities,
  type PiAgentSettings,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { spawnPiRpcClient } from "../pi/PiRpcClient.ts";
import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

// Pi loads most of its CLI dependency graph before handling `--version` and
// starting RPC mode. Cold starts can exceed 15 seconds on Windows, especially
// while antivirus scanning is active, so these probes need a larger startup
// allowance than lightweight provider CLIs.
const VERSION_PROBE_TIMEOUT_MS = 30_000;
const MODEL_DISCOVERY_TIMEOUT_MS = 30_000;

const PI_PRESENTATION = {
  displayName: "Pi",
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: true,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });
const THINKING_LEVELS = [
  ["off", "Off"],
  ["minimal", "Minimal"],
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
  ["xhigh", "Extra High"],
] as const;
const THINKING_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "effort",
      label: "Thinking",
      type: "select",
      options: THINKING_LEVELS.map(([id, label]) =>
        id === "medium" ? { id, label, isDefault: true } : { id, label },
      ),
      currentValue: "medium",
    },
  ],
});

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function mapPiAvailableModels(
  data: unknown,
  customModels: ReadonlyArray<string> = [],
): ReadonlyArray<ServerProviderModel> {
  const record = asRecord(data);
  const rawModels = Array.isArray(record?.models) ? record.models : [];
  const seen = new Set<string>();
  const discovered: ServerProviderModel[] = [];

  for (const value of rawModels) {
    const model = asRecord(value);
    const provider = typeof model?.provider === "string" ? model.provider.trim() : "";
    const id = typeof model?.id === "string" ? model.id.trim() : "";
    if (!provider || !id) continue;
    const slug = `${provider}/${id}`;
    if (seen.has(slug)) continue;
    seen.add(slug);
    const name = typeof model?.name === "string" && model.name.trim() ? model.name.trim() : slug;
    discovered.push({
      slug,
      name,
      isCustom: false,
      capabilities: model?.reasoning === true ? THINKING_CAPABILITIES : EMPTY_CAPABILITIES,
    });
  }

  return providerModelsFromSettings(discovered, customModels, EMPTY_CAPABILITIES);
}

function fallbackModels(settings: PiAgentSettings): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings([], settings.customModels, EMPTY_CAPABILITIES);
}

export function buildInitialPiProviderSnapshot(
  settings: PiAgentSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: fallbackModels(settings),
      probe: settings.enabled
        ? {
            installed: true,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Checking Pi CLI availability...",
          }
        : {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Pi is disabled in T3 Code settings.",
          },
    });
  });
}

const runPiVersionCommand = (settings: PiAgentSettings, environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const binaryPath = settings.binaryPath || "pi";
    const resolved = yield* resolveSpawnCommand(binaryPath, ["--version"], {
      env: environment,
    });
    return yield* spawnAndCollect(
      binaryPath,
      ChildProcess.make(resolved.command, resolved.args, {
        env: environment,
        extendEnv: true,
        shell: resolved.shell,
      }),
    );
  });

const discoverPiModels = (settings: PiAgentSettings, cwd: string, environment: NodeJS.ProcessEnv) =>
  Effect.scoped(
    Effect.gen(function* () {
      const client = yield* spawnPiRpcClient({
        binaryPath: settings.binaryPath || "pi",
        cwd,
        env: environment,
      });
      const response = yield* client.request({ type: "get_available_models" });
      if (!response.success) return { models: fallbackModels(settings), hasConfiguredAuth: false };

      // Pi's get_available_models RPC only returns models whose provider has
      // configured auth. Keep that signal separate from T3's manually added
      // custom model slugs, which do not prove Pi has usable credentials.
      const availableModels = mapPiAvailableModels(response.data);
      return {
        models: providerModelsFromSettings(
          availableModels,
          settings.customModels,
          EMPTY_CAPABILITIES,
        ),
        hasConfiguredAuth: availableModels.length > 0,
      };
    }),
  );

export const checkPiProviderStatus = Effect.fn("checkPiProviderStatus")(function* (
  settings: PiAgentSettings,
  cwd: string,
  processEnvironment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const models = fallbackModels(settings);
  if (!settings.enabled) return yield* buildInitialPiProviderSnapshot(settings);

  const environment = {
    ...processEnvironment,
    ...(settings.homePath ? { PI_CODING_AGENT_DIR: settings.homePath } : {}),
  };
  const versionResult = yield* runPiVersionCommand(settings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );
  if (Result.isFailure(versionResult)) {
    const missing = isCommandMissingCause(versionResult.failure);
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: !missing,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: missing
          ? `Pi CLI (\`${settings.binaryPath || "pi"}\`) is not installed or not on PATH.`
          : "Failed to execute Pi CLI health check.",
      },
    });
  }
  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Pi CLI timed out while running `pi --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Pi CLI is installed but failed to run.",
      },
    });
  }

  const discovered = yield* discoverPiModels(settings, cwd, environment).pipe(
    Effect.timeoutOption(MODEL_DISCOVERY_TIMEOUT_MS),
    Effect.result,
  );
  if (Result.isFailure(discovered) || Option.isNone(discovered.success)) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: Result.isFailure(discovered)
          ? "Pi CLI is installed but RPC model discovery failed. Check server logs for details."
          : "Pi CLI RPC model discovery timed out.",
      },
    });
  }

  return buildServerProvider({
    presentation: PI_PRESENTATION,
    enabled: true,
    checkedAt,
    models: discovered.success.value.models,
    probe: {
      installed: true,
      version,
      status: discovered.success.value.hasConfiguredAuth ? "ready" : "error",
      auth: {
        status: discovered.success.value.hasConfiguredAuth ? "authenticated" : "unauthenticated",
      },
      ...(discovered.success.value.hasConfiguredAuth
        ? {}
        : {
            message:
              "Pi has no models with configured credentials. Configure a provider in Pi and try again.",
          }),
    },
  });
});
