import {
  ENVIRONMENT_MCP_DEFAULT_PROVIDER_LIMIT,
  ENVIRONMENT_MCP_MAX_DIAGNOSTIC_CHARACTERS,
  ENVIRONMENT_MCP_MAX_WRITING_INSTRUCTIONS,
  EnvironmentMcpFailure,
  type EnvironmentMcpPreferences,
  type EnvironmentMcpReadInput,
  type EnvironmentMcpReadResult,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

export class EnvironmentMcpService extends Context.Service<
  EnvironmentMcpService,
  {
    readonly read: (
      scope: McpInvocationScope,
      input: EnvironmentMcpReadInput,
    ) => Effect.Effect<EnvironmentMcpReadResult, EnvironmentMcpFailure>;
  }
>()("t3/mcp/EnvironmentMcpService") {}

const unavailable = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  code: EnvironmentMcpFailure["code"],
): Effect.Effect<A, EnvironmentMcpFailure, R> =>
  effect.pipe(
    Effect.catchCause(
      (cause): Effect.Effect<never, EnvironmentMcpFailure> =>
        Cause.hasInterrupts(cause)
          ? Effect.failCause(cause).pipe(Effect.orDie)
          : Effect.fail(new EnvironmentMcpFailure({ code })),
    ),
  );

const textWindow = (value: string, maximumCharacters: number) => {
  const characters = Array.from(value);
  return {
    text: characters.slice(0, maximumCharacters).join(""),
    characters: characters.length,
    maximumCharacters,
    truncated: characters.length > maximumCharacters,
  } as const;
};

export const presentEnvironmentPreferences = (
  settings: ServerSettings,
): EnvironmentMcpPreferences => ({
  defaultThreadEnvMode: settings.defaultThreadEnvMode,
  newWorktreesStartFromOrigin: settings.newWorktreesStartFromOrigin,
  enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
  backgroundActivity: {
    profile: settings.backgroundActivity.profile,
    baseProfile: settings.backgroundActivity.baseProfile ?? null,
  },
  sourceControlWritingStyle: {
    mode: settings.sourceControlWritingStyle.mode,
    customInstructions: textWindow(
      settings.sourceControlWritingStyle.customInstructions,
      ENVIRONMENT_MCP_MAX_WRITING_INSTRUCTIONS,
    ),
    followChangeRequestTemplates: settings.sourceControlWritingStyle.followChangeRequestTemplates,
  },
});

const providerHealth = (providers: ReadonlyArray<ServerProvider>) => {
  const count = (state: ServerProvider["status"]) =>
    providers.filter((provider) => provider.status === state).length;
  const unavailableCount = providers.filter(
    (provider) => provider.availability === "unavailable",
  ).length;
  const usable = providers.filter(
    (provider) =>
      provider.availability !== "unavailable" &&
      provider.enabled &&
      provider.installed &&
      (provider.status === "ready" || provider.status === "warning"),
  ).length;
  const status =
    providers.length === 0
      ? "empty"
      : usable === 0
        ? "unavailable"
        : providers.some(
              (provider) =>
                provider.status === "warning" ||
                provider.status === "error" ||
                provider.availability === "unavailable",
            )
          ? "degraded"
          : "healthy";
  return {
    status,
    total: providers.length,
    ready: count("ready"),
    warning: count("warning"),
    error: count("error"),
    disabled: count("disabled"),
    unavailable: unavailableCount,
    usable,
  } as const;
};

const make = Effect.gen(function* () {
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const providerRegistry = yield* ProviderRegistry;
  const settingsService = yield* ServerSettingsModule.ServerSettingsService;

  return EnvironmentMcpService.of({
    read: (scope, input) =>
      Effect.gen(function* () {
        if (!scope.capabilities.has("orchestration")) {
          return yield* new EnvironmentMcpFailure({ code: "capability_denied" });
        }
        const [descriptor, providers, settings] = yield* Effect.all([
          unavailable(environment.getDescriptor, "environment_unavailable"),
          unavailable(providerRegistry.getProviders, "provider_registry_unavailable"),
          unavailable(settingsService.getSettings, "settings_unavailable"),
        ]);
        if (descriptor.environmentId !== scope.environmentId) {
          return yield* new EnvironmentMcpFailure({ code: "environment_mismatch" });
        }

        const ordered = [...providers].sort((left, right) =>
          left.instanceId < right.instanceId ? -1 : left.instanceId > right.instanceId ? 1 : 0,
        );
        const cursor = input.providerCursor ?? 0;
        const limit = input.providerLimit ?? ENVIRONMENT_MCP_DEFAULT_PROVIDER_LIMIT;
        const page = ordered.slice(cursor, cursor + limit);
        const capabilities = descriptor.capabilities;
        return {
          identity: {
            environmentId: descriptor.environmentId,
            label: textWindow(descriptor.label, ENVIRONMENT_MCP_MAX_DIAGNOSTIC_CHARACTERS),
            platform: descriptor.platform,
            serverVersion: textWindow(
              descriptor.serverVersion,
              ENVIRONMENT_MCP_MAX_DIAGNOSTIC_CHARACTERS,
            ),
          },
          capabilities: {
            repositoryIdentity: capabilities.repositoryIdentity,
            connectionProbe: capabilities.connectionProbe ?? false,
            attachmentUploads: capabilities.attachmentUploads ?? false,
            fileAttachmentMaxUploadBytes: capabilities.fileAttachments?.maxUploadBytes ?? null,
            pullRequests: capabilities.pullRequests ?? false,
            threadSettlement: capabilities.threadSettlement ?? false,
            threadSnooze: capabilities.threadSnooze ?? false,
            environmentThemes: capabilities.environmentThemes ?? false,
            threadPinning: capabilities.threadPinning ?? false,
            threadPinReorder: capabilities.threadPinReorder ?? false,
            threadTitleRegeneration: capabilities.threadTitleRegeneration ?? false,
            threadVisitedTracking: capabilities.threadVisitedTracking ?? false,
            threadPullRequestLinking: capabilities.threadPullRequestLinking ?? false,
          },
          providerHealth: providerHealth(ordered),
          providers: page.map((provider) => ({
            instanceId: provider.instanceId,
            driver: provider.driver,
            displayName:
              provider.displayName === undefined
                ? null
                : textWindow(provider.displayName, ENVIRONMENT_MCP_MAX_DIAGNOSTIC_CHARACTERS),
            availability: provider.availability ?? "available",
            enabled: provider.enabled,
            installed: provider.installed,
            state: provider.status,
            authStatus: provider.auth.status,
            version:
              provider.version === null
                ? null
                : textWindow(provider.version, ENVIRONMENT_MCP_MAX_DIAGNOSTIC_CHARACTERS),
            checkedAt: provider.checkedAt,
            modelCount: provider.models.length,
            supportsInteractionMode: provider.showInteractionModeToggle ?? false,
            requiresNewThreadForModelChange: provider.requiresNewThreadForModelChange ?? false,
          })),
          providerNextCursor: cursor + page.length < ordered.length ? cursor + page.length : null,
          providerTotal: ordered.length,
          preferences: presentEnvironmentPreferences(settings),
          preferenceScope: "server_owned",
        };
      }),
  });
});

export const layer = Layer.effect(EnvironmentMcpService, make);
