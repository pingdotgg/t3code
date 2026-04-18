import type { OpenCodeSettings, ServerProvider } from "@t3tools/contracts";
import { Cause, Effect, Equal, Layer, Stream } from "effect";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
} from "../providerSnapshot.ts";
import { OpenCodeProvider } from "../Services/OpenCodeProvider.ts";
import {
  connectToOpenCodeServer,
  DEFAULT_OPENCODE_MODEL_CAPABILITIES,
  createOpenCodeSdkClient,
  flattenOpenCodeModels,
  getOpenCodeManagedProviderDescriptor,
  loadOpenCodeInventory,
  runOpenCodeCommand,
} from "../opencodeRuntime.ts";
import { resolveOpenCodeManagedUsageLimits } from "../openCodeUsageLimits.ts";
import { makeUnavailableUsageLimits } from "../providerUsageLimits.ts";

const PROVIDER = "opencode" as const;

class OpenCodeProbePromiseError extends Error {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.cause = cause;
    this.name = "OpenCodeProbePromiseError";
  }
}

function toOpenCodeProbeError(cause: unknown): OpenCodeProbePromiseError {
  return new OpenCodeProbePromiseError(cause);
}

function normalizedErrorMessage(cause: unknown): string | undefined {
  if (!(cause instanceof Error)) {
    return undefined;
  }

  const message = cause.message.trim();
  if (message.length === 0) {
    return undefined;
  }
  if (
    message === "An error occurred in Effect.tryPromise" ||
    message === "An error occurred in Effect.try"
  ) {
    return undefined;
  }
  return message;
}

function formatOpenCodeProbeError(input: {
  readonly cause: unknown;
  readonly isExternalServer: boolean;
  readonly serverUrl: string;
}): { readonly installed: boolean; readonly message: string } {
  const lower = input.cause instanceof Error ? input.cause.message.toLowerCase() : "";
  const detail = normalizedErrorMessage(input.cause);

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

  if (input.cause instanceof Error && isCommandMissingCause(input.cause)) {
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

const makePendingOpenCodeProvider = (openCodeSettings: OpenCodeSettings): ServerProvider => {
  const checkedAt = new Date().toISOString();
  const models = providerModelsFromSettings(
    [],
    PROVIDER,
    openCodeSettings.customModels,
    DEFAULT_OPENCODE_MODEL_CAPABILITIES,
  );
  const usageLimits = makeUnavailableUsageLimits({
    source: "opencodeManaged",
    checkedAt,
    reason: "Unable to fetch usage",
  });

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
        usageLimits,
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
      usageLimits,
    },
  });
};

export function checkOpenCodeProviderStatus(input: {
  readonly settings: OpenCodeSettings;
  readonly cwd: string;
}): Effect.Effect<ServerProvider> {
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
        usageLimits: makeUnavailableUsageLimits({
          source: "opencodeManaged",
          checkedAt,
          reason: "Unable to fetch usage",
        }),
      },
    });
  };

  return Effect.gen(function* () {
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
          usageLimits: makeUnavailableUsageLimits({
            source: "opencodeManaged",
            checkedAt,
            reason: "Unable to fetch usage",
          }),
        },
      });
    }

    let version: string | null = null;
    if (!isExternalServer) {
      const versionExit = yield* Effect.exit(
        Effect.tryPromise({
          try: () =>
            runOpenCodeCommand({
              binaryPath: input.settings.binaryPath,
              args: ["--version"],
            }),
          catch: toOpenCodeProbeError,
        }),
      );
      if (versionExit._tag === "Failure") {
        return fallback(Cause.squash(versionExit.cause));
      }
      version = parseGenericCliVersion(versionExit.value.stdout) ?? null;
    }

    const inventoryExit = yield* Effect.exit(
      Effect.acquireUseRelease(
        Effect.tryPromise({
          try: () =>
            connectToOpenCodeServer({
              binaryPath: input.settings.binaryPath,
              serverUrl: input.settings.serverUrl,
            }),
          catch: toOpenCodeProbeError,
        }),
        (server) =>
          Effect.tryPromise({
            try: async () => {
              const client = createOpenCodeSdkClient({
                baseUrl: server.url,
                directory: input.cwd,
                ...(isExternalServer && input.settings.serverPassword
                  ? { serverPassword: input.settings.serverPassword }
                  : {}),
              });
              return await loadOpenCodeInventory(client);
            },
            catch: toOpenCodeProbeError,
          }),
        (server) => Effect.sync(() => server.close()),
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
    const usageLimits =
      resolveOpenCodeManagedUsageLimits({
        checkedAt,
        inventory: inventoryExit.value,
      }) ??
      makeUnavailableUsageLimits({
        source: "opencodeManaged",
        checkedAt,
        reason: "Unable to fetch usage",
      });
    const connectedCount = inventoryExit.value.providerList.connected.length;
    const connectedManagedCount = inventoryExit.value.providerList.connected.filter(
      (providerId) => getOpenCodeManagedProviderDescriptor(providerId) !== undefined,
    ).length;
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
        usageLimits,
        message:
          connectedManagedCount > 0
            ? `${connectedManagedCount} OpenCode-managed provider${connectedManagedCount === 1 ? "" : "s"} connected through ${isExternalServer ? "the configured OpenCode server" : "OpenCode"}.`
            : connectedCount > 0
              ? `${connectedCount} upstream provider${connectedCount === 1 ? "" : "s"} connected through ${isExternalServer ? "the configured OpenCode server" : "OpenCode"}.`
              : isExternalServer
                ? "Connected to the configured OpenCode server, but it did not report any connected upstream providers."
                : "OpenCode is available, but it did not report any connected upstream providers.",
      },
    });
  });
}

export function makeOpenCodeProviderLive() {
  return Layer.effect(
    OpenCodeProvider,
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const serverConfig = yield* ServerConfig;

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
}

export const OpenCodeProviderLive = makeOpenCodeProviderLive();
