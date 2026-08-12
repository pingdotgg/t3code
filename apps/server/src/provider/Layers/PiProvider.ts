import {
  type ModelCapabilities,
  type PiSettings,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess } from "effect/unstable/process";

import {
  makePiRpcTransport,
  type PiRpcResponse,
} from "../../orchestration-v2/Adapters/PiRpcTransport.ts";
import {
  buildSelectOptionDescriptor,
  buildServerProvider,
  detailFromResult,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const PI_PRESENTATION = {
  displayName: "Pi",
  badgeLabel: "Early Access",
  showInteractionModeToggle: true,
} as const;

const PI_MODEL_DISCOVERY_TIMEOUT_MS = 15_000;
const PI_VERSION_PROBE_TIMEOUT_MS = 15_000;

const PI_THINKING_LEVELS = [
  { value: "off", label: "Off" },
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium", isDefault: true as const },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra High" },
  { value: "max", label: "Max" },
];

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });

interface PiModelInfo {
  readonly id: string;
  readonly name?: string;
  readonly provider: string;
  readonly reasoning?: boolean;
}

export function splitPiModelSlug(slug: string): { provider: string; id: string } | undefined {
  const normalized = slug.trim();
  const separator = normalized.indexOf("/");
  if (separator <= 0 || separator >= normalized.length - 1) return undefined;
  return { provider: normalized.slice(0, separator), id: normalized.slice(separator + 1) };
}

export function piModelCapabilities(reasoning: boolean): ModelCapabilities {
  return createModelCapabilities({
    optionDescriptors: reasoning
      ? [
          buildSelectOptionDescriptor({
            id: "thinking",
            label: "Thinking",
            options: PI_THINKING_LEVELS,
          }),
        ]
      : [],
  });
}

function responseData(response: PiRpcResponse | undefined): Record<string, unknown> | undefined {
  if (response?.["success"] !== true) return undefined;
  const data = response["data"];
  return typeof data === "object" && data !== null && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : undefined;
}

function modelInfo(value: unknown): PiModelInfo | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const id = record["id"];
  const provider = record["provider"];
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    typeof provider !== "string" ||
    provider.length === 0
  ) {
    return undefined;
  }
  return {
    id,
    provider,
    ...(typeof record["name"] === "string" ? { name: record["name"] } : {}),
    ...(typeof record["reasoning"] === "boolean" ? { reasoning: record["reasoning"] } : {}),
  };
}

export function extractPiModels(response: PiRpcResponse | undefined): ReadonlyArray<PiModelInfo> {
  const models = responseData(response)?.["models"];
  if (!Array.isArray(models)) return [];
  return models.flatMap((value) => {
    const parsed = modelInfo(value);
    return parsed === undefined ? [] : [parsed];
  });
}

export function piModelInfoToServerModel(model: PiModelInfo): ServerProviderModel {
  return {
    slug: `${model.provider}/${model.id}`,
    name: model.name?.trim() || model.id,
    subProvider: model.provider,
    isCustom: false,
    capabilities: piModelCapabilities(model.reasoning === true),
  };
}

export const discoverPiModelsViaRpc = Effect.fn("discoverPiModelsViaRpc")(
  function* (settings: PiSettings, cwd: string, environment: NodeJS.ProcessEnv) {
    const transport = yield* makePiRpcTransport({
      command: settings.binaryPath || "pi",
      args: ["--mode", "rpc", "--no-session", ...tokenizeCliArgs(settings.launchArgs)],
      cwd,
      env: environment,
    });
    const response = yield* transport.request({ type: "get_available_models" }, 14_000);
    yield* transport.close;
    return extractPiModels(response).map(piModelInfoToServerModel);
  },
  Effect.scoped,
  Effect.timeoutOption(PI_MODEL_DISCOVERY_TIMEOUT_MS),
  Effect.map(Option.getOrElse(() => [] as ReadonlyArray<ServerProviderModel>)),
  Effect.catchCause((cause) =>
    Effect.logWarning("Pi model discovery failed", { cause }).pipe(
      Effect.as([] as ReadonlyArray<ServerProviderModel>),
    ),
  ),
);

const modelsFromSettings = (settings: PiSettings, discovered: ReadonlyArray<ServerProviderModel>) =>
  providerModelsFromSettings(discovered, settings.customModels, EMPTY_CAPABILITIES);

export const makePendingPiProvider = (settings: PiSettings): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: modelsFromSettings(settings, []),
      probe: settings.enabled
        ? {
            installed: true,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Checking Pi availability...",
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

export const checkPiProviderStatus = Effect.fn("checkPiProviderStatus")(function* (
  settings: PiSettings,
  cwd: string,
  environment: NodeJS.ProcessEnv,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = modelsFromSettings(settings, []);
  if (!settings.enabled) return yield* makePendingPiProvider(settings);

  const command = settings.binaryPath || "pi";
  const versionResult = yield* spawnAndCollect(
    command,
    ChildProcess.make(command, ["--version"], { env: environment, shell: false }),
  ).pipe(Effect.timeoutOption(PI_VERSION_PROBE_TIMEOUT_MS), Effect.result);

  if (Result.isFailure(versionResult)) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(versionResult.failure),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(versionResult.failure)
          ? "Pi CLI (`pi`) is not installed or not on PATH."
          : "Failed to execute Pi CLI health check.",
      },
    });
  }
  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Pi CLI timed out while running `pi --version`.",
      },
    });
  }

  const versionExit = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionExit.stdout}\n${versionExit.stderr}`);
  if (versionExit.code !== 0) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: detailFromResult(versionExit) ?? "Pi CLI returned an error during health check.",
      },
    });
  }

  const models = modelsFromSettings(
    settings,
    yield* discoverPiModelsViaRpc(settings, cwd, environment),
  );
  const authenticated = models.length > 0;
  return buildServerProvider({
    presentation: PI_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: true,
      version,
      status: authenticated ? "ready" : "warning",
      auth: { status: authenticated ? "authenticated" : "unknown", type: "pi" },
      ...(authenticated
        ? {}
        : {
            message:
              "Pi is installed but no models are available. Configure a provider or API key in ~/.pi/agent.",
          }),
    },
  });
});
