import type {
  ModelCapabilities,
  OpenCodeSettings,
  ServerProvider,
  ServerProviderModel,
} from "@t3tools/contracts";
import { Cause, Data, Effect, Equal, Layer, Stream } from "effect";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  buildServerProvider,
  nonEmptyTrimmed,
  parseGenericCliVersion,
  providerModelsFromSettings,
} from "../providerSnapshot.ts";
import { compareCliVersions } from "../cliVersion.ts";
import { OpenCodeProvider } from "../Services/OpenCodeProvider.ts";
import {
  OpenCodeRuntime,
  openCodeRuntimeErrorDetail,
  type OpenCodeInventory,
} from "../opencodeRuntime.ts";
import type { Agent, ProviderListResponse } from "@opencode-ai/sdk/v2";

const PROVIDER = "opencode" as const;
const MINIMUM_OPENCODE_VERSION = "1.14.19";

class OpenCodeProbeError extends Data.TaggedError("OpenCodeProbeError")<{
  readonly cause: unknown;
  readonly detail: string;
}> {}

function normalizeProbeMessage(message: string): string | undefined {
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (
    trimmed === "An error occurred in Effect.tryPromise" ||
    trimmed === "An error occurred in Effect.try"
  ) {
    return undefined;
  }
  return trimmed;
}

function normalizedErrorMessage(cause: unknown): string | undefined {
  if (cause instanceof OpenCodeProbeError) {
    return normalizeProbeMessage(cause.detail);
  }

  if (!(cause instanceof Error)) {
    return undefined;
  }

  return normalizeProbeMessage(cause.message);
}

function formatOpenCodeProbeError(input: {
  readonly cause: unknown;
  readonly isExternalServer: boolean;
  readonly serverUrl: string;
}): { readonly installed: boolean; readonly message: string } {
  const detail = normalizedErrorMessage(input.cause);
  const lower = detail?.toLowerCase() ?? "";

  if (input.isExternalServer) {
    if (
      lower.includes("401") ||
      lower.includes("403") ||
      lower.includes("unauthorized") ||
      lower.includes("forbidden")
    ) {
      return {
        installed: true,
        message: "OpenCode server rejected authentication. Check the server URL and password.",
      };
    }

    if (
      lower.includes("econnrefused") ||
      lower.includes("enotfound") ||
      lower.includes("fetch failed") ||
      lower.includes("networkerror") ||
      lower.includes("timed out") ||
      lower.includes("timeout") ||
      lower.includes("socket hang up")
    ) {
      return {
        installed: true,
        message: `Couldn't reach the configured OpenCode server at ${input.serverUrl}. Check that the server is running and the URL is correct.`,
      };
    }

    return {
      installed: true,
      message: detail ?? "Failed to connect to the configured OpenCode server.",
    };
  }

  if (lower.includes("enoent") || lower.includes("notfound")) {
    return {
      installed: false,
      message: "OpenCode CLI (`opencode`) is not installed or not on PATH.",
    };
  }

  if (lower.includes("quarantine")) {
    return {
      installed: true,
      message:
        "macOS is blocking the OpenCode binary (quarantine). Run `xattr -d com.apple.quarantine $(which opencode)` to fix this.",
    };
  }

  if (lower.includes("invalid code signature") || lower.includes("corrupted")) {
    return {
      installed: true,
      message:
        "macOS killed the OpenCode process due to an invalid code signature. The binary may be corrupted — try reinstalling OpenCode.",
    };
  }

  return {
    installed: true,
    message: detail
      ? `Failed to execute OpenCode CLI health check: ${detail}`
      : "Failed to execute OpenCode CLI health check.",
  };
}

function titleCaseSlug(value: string): string {
  return value
    .split(/[-_/]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function inferDefaultVariant(
  providerID: string,
  variants: ReadonlyArray<string>,
): string | undefined {
  if (variants.length === 1) {
    return variants[0];
  }
  if (providerID === "anthropic" || providerID.startsWith("google")) {
    return variants.includes("high") ? "high" : undefined;
  }
  if (providerID === "openai" || providerID === "opencode") {
    return variants.includes("medium") ? "medium" : variants.includes("high") ? "high" : undefined;
  }
  return undefined;
}

function inferDefaultAgent(agents: ReadonlyArray<Agent>): string | undefined {
  return agents.find((agent) => agent.name === "build")?.name ?? agents[0]?.name ?? undefined;
}

const DEFAULT_OPENCODE_MODEL_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

function openCodeCapabilitiesForModel(input: {
  readonly providerID: string;
  readonly model: ProviderListResponse["all"][number]["models"][string];
  readonly agents: ReadonlyArray<Agent>;
}): ModelCapabilities {
  const variantValues = Object.keys(input.model.variants ?? {});
  const defaultVariant = inferDefaultVariant(input.providerID, variantValues);
  const variantOptions: ModelCapabilities["variantOptions"] = variantValues.map((value) =>
    Object.assign(
      { value, label: titleCaseSlug(value) },
      defaultVariant === value ? { isDefault: true } : {},
    ),
  );
  const primaryAgents = input.agents.filter(
    (agent) => !agent.hidden && (agent.mode === "primary" || agent.mode === "all"),
  );
  const defaultAgent = inferDefaultAgent(primaryAgents);
  const agentOptions: ModelCapabilities["agentOptions"] = primaryAgents.map((agent) =>
    Object.assign(
      { value: agent.name, label: titleCaseSlug(agent.name) },
      defaultAgent === agent.name ? { isDefault: true } : {},
    ),
  );
  return {
    ...DEFAULT_OPENCODE_MODEL_CAPABILITIES,
    ...(variantOptions.length > 0 ? { variantOptions } : {}),
    ...(agentOptions.length > 0 ? { agentOptions } : {}),
  };
}

function flattenOpenCodeModels(input: OpenCodeInventory): ReadonlyArray<ServerProviderModel> {
  const connected = new Set(input.providerList.connected);
  const models: Array<ServerProviderModel> = [];

  for (const provider of input.providerList.all) {
    if (!connected.has(provider.id)) {
      continue;
    }

    for (const model of Object.values(provider.models)) {
      const name = nonEmptyTrimmed(model.name);
      if (!name) {
        continue;
      }

      const subProvider = nonEmptyTrimmed(provider.name);
      models.push({
        slug: `${provider.id}/${model.id}`,
        name,
        ...(subProvider ? { subProvider } : {}),
        isCustom: false,
        capabilities: openCodeCapabilitiesForModel({
          providerID: provider.id,
          model,
          agents: input.agents,
        }),
      });
    }
  }

  return models.toSorted((left, right) => left.name.localeCompare(right.name));
}

const makePendingOpenCodeProvider = (openCodeSettings: OpenCodeSettings): ServerProvider => {
  const checkedAt = new Date().toISOString();
  const models = providerModelsFromSettings(
    [],
    PROVIDER,
    openCodeSettings.customModels,
    DEFAULT_OPENCODE_MODEL_CAPABILITIES,
  );

  if (!openCodeSettings.enabled) {
    return buildServerProvider({
      provider: PROVIDER,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message:
          openCodeSettings.serverUrl.trim().length > 0
            ? "OpenCode is disabled in T3 Code settings. A server URL is configured."
            : "OpenCode is disabled in T3 Code settings.",
      },
    });
  }

  return buildServerProvider({
    provider: PROVIDER,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "OpenCode provider status has not been checked in this session yet.",
    },
  });
};

export const OpenCodeProviderLive = Layer.effect(
  OpenCodeProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const serverConfig = yield* ServerConfig;
    const openCodeRuntime = yield* OpenCodeRuntime;

    const checkOpenCodeProviderStatus = Effect.fn("checkOpenCodeProviderStatus")(function* (input: {
      readonly settings: OpenCodeSettings;
      readonly cwd: string;
    }): Effect.fn.Return<ServerProvider, never> {
      const checkedAt = new Date().toISOString();
      const customModels = input.settings.customModels;
      const isExternalServer = input.settings.serverUrl.trim().length > 0;

      const fallback = (cause: unknown, version: string | null = null) => {
        const failure = formatOpenCodeProbeError({
          cause,
          isExternalServer,
          serverUrl: input.settings.serverUrl,
        });
        return buildServerProvider({
          provider: PROVIDER,
          enabled: input.settings.enabled,
          checkedAt,
          models: providerModelsFromSettings(
            [],
            PROVIDER,
            customModels,
            DEFAULT_OPENCODE_MODEL_CAPABILITIES,
          ),
          probe: {
            installed: failure.installed,
            version,
            status: "error",
            auth: { status: "unknown" },
            message: failure.message,
          },
        });
      };

      if (!input.settings.enabled) {
        return buildServerProvider({
          provider: PROVIDER,
          enabled: false,
          checkedAt,
          models: providerModelsFromSettings(
            [],
            PROVIDER,
            customModels,
            DEFAULT_OPENCODE_MODEL_CAPABILITIES,
          ),
          probe: {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: isExternalServer
              ? "OpenCode is disabled in T3 Code settings. A server URL is configured."
              : "OpenCode is disabled in T3 Code settings.",
          },
        });
      }

      let version: string | null = null;
      if (!isExternalServer) {
        const versionExit = yield* Effect.exit(
          openCodeRuntime
            .runOpenCodeCommand({
              binaryPath: input.settings.binaryPath,
              args: ["--version"],
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new OpenCodeProbeError({ cause, detail: openCodeRuntimeErrorDetail(cause) }),
              ),
            ),
        );
        if (versionExit._tag === "Failure") {
          return fallback(Cause.squash(versionExit.cause));
        }
        version = parseGenericCliVersion(versionExit.value.stdout) ?? null;

        if (!version) {
          return fallback(
            new Error(
              `Unable to determine OpenCode version from \`opencode --version\` output. T3 Code requires OpenCode v${MINIMUM_OPENCODE_VERSION} or newer.`,
            ),
            null,
          );
        }
        if (compareCliVersions(version, MINIMUM_OPENCODE_VERSION) < 0) {
          return buildServerProvider({
            provider: PROVIDER,
            enabled: input.settings.enabled,
            checkedAt,
            models: providerModelsFromSettings(
              [],
              PROVIDER,
              customModels,
              DEFAULT_OPENCODE_MODEL_CAPABILITIES,
            ),
            probe: {
              installed: true,
              version,
              status: "error",
              auth: { status: "unknown" },
              message: `OpenCode v${version} is too old. Upgrade to v${MINIMUM_OPENCODE_VERSION} or newer.`,
            },
          });
        }
      }

      const inventoryExit = yield* Effect.exit(
        Effect.scoped(
          Effect.gen(function* () {
            const server = yield* openCodeRuntime
              .connectToOpenCodeServer({
                binaryPath: input.settings.binaryPath,
                serverUrl: input.settings.serverUrl,
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new OpenCodeProbeError({ cause, detail: openCodeRuntimeErrorDetail(cause) }),
                ),
              );
            return yield* openCodeRuntime
              .loadOpenCodeInventory(
                openCodeRuntime.createOpenCodeSdkClient({
                  baseUrl: server.url,
                  directory: input.cwd,
                  ...(isExternalServer && input.settings.serverPassword
                    ? { serverPassword: input.settings.serverPassword }
                    : {}),
                }),
              )
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new OpenCodeProbeError({ cause, detail: openCodeRuntimeErrorDetail(cause) }),
                ),
              );
          }),
        ),
      );
      if (inventoryExit._tag === "Failure") {
        return fallback(Cause.squash(inventoryExit.cause), version);
      }

      const models = providerModelsFromSettings(
        flattenOpenCodeModels(inventoryExit.value),
        PROVIDER,
        customModels,
        DEFAULT_OPENCODE_MODEL_CAPABILITIES,
      );
      const connectedCount = inventoryExit.value.providerList.connected.length;
      return buildServerProvider({
        provider: PROVIDER,
        enabled: true,
        checkedAt,
        models,
        probe: {
          installed: true,
          version,
          status: connectedCount > 0 ? "ready" : "warning",
          auth: {
            status: connectedCount > 0 ? "authenticated" : "unknown",
            type: "opencode",
          },
          message:
            connectedCount > 0
              ? `${connectedCount} upstream provider${connectedCount === 1 ? "" : "s"} connected through ${isExternalServer ? "the configured OpenCode server" : "OpenCode"}.`
              : isExternalServer
                ? "Connected to the configured OpenCode server, but it did not report any connected upstream providers."
                : "OpenCode is available, but it did not report any connected upstream providers.",
        },
      });
    });

    const getProviderSettings = serverSettings.getSettings.pipe(
      Effect.map((settings) => settings.providers.opencode),
    );

    return yield* makeManagedServerProvider<OpenCodeSettings>({
      getSettings: getProviderSettings.pipe(Effect.orDie),
      streamSettings: serverSettings.streamChanges.pipe(
        Stream.map((settings) => settings.providers.opencode),
      ),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      initialSnapshot: makePendingOpenCodeProvider,
      checkProvider: getProviderSettings.pipe(
        Effect.flatMap((settings) =>
          checkOpenCodeProviderStatus({
            settings,
            cwd: serverConfig.cwd,
          }),
        ),
      ),
    });
  }),
);
