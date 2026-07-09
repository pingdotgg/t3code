/**
 * ClaudeSyntheroDriver — Synthero API routed through the Claude Code harness.
 *
 * This is intentionally a separate provider driver from the normal Claude
 * provider. It uses a dedicated Claude HOME by default and injects Synthero's
 * Anthropic-compatible endpoint/token into only this provider instance's
 * process environment, so the user's existing Claude login/setup is not
 * mutated or reused.
 *
 * IMPORTANT: API keys are user configuration. Never commit a real key here;
 * `authToken` defaults empty and falls back to provider-scoped
 * SYNTHERO_AUTH_TOKEN / ANTHROPIC_AUTH_TOKEN environment variables.
 *
 * @module provider/Drivers/ClaudeSyntheroDriver
 */
import {
  type ClaudeSettings,
  ClaudeSyntheroSettings,
  type ClaudeSyntheroSettings as ClaudeSyntheroSettingsType,
  ProviderDriverKind,
  type ProviderInstanceEnvironment,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeClaudeTextGeneration } from "../../textGeneration/ClaudeTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeClaudeAdapter } from "../Layers/ClaudeAdapter.ts";
import {
  checkClaudeProviderStatus,
  makePendingClaudeProvider,
  probeClaudeCapabilities,
  type ClaudeProviderIdentity,
} from "../Layers/ClaudeProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makePackageManagedProviderMaintenanceResolver,
  normalizeCommandPath,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import { makeClaudeContinuationGroupKey } from "./ClaudeHome.ts";

const DRIVER_KIND = ProviderDriverKind.make("claude-synthero");
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5);
const DEFAULT_SYNTHERO_BASE_URL = "https://api.synterolink.com";
const SYNTHERO_AUTH_TOKEN_ENV = "SYNTHERO_AUTH_TOKEN";
const ANTHROPIC_AUTH_TOKEN_ENV = "ANTHROPIC_AUTH_TOKEN";

const decodeClaudeSyntheroSettings = Schema.decodeSync(ClaudeSyntheroSettings);
const decodeClaudeSyntheroSettingsEffect = Schema.decodeUnknownEffect(ClaudeSyntheroSettings);

/**
 * Detect whether a resolved command path points at a natively-installed
 * Claude Code binary (as opposed to an npm/Homebrew-managed one), so the
 * maintenance resolver can pick the correct update strategy.
 *
 * @param commandPath - Resolved path to the `claude` executable.
 * @returns `true` when the path matches Claude's native install locations.
 */
function isClaudeNativeCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.endsWith("/.local/bin/claude") ||
    normalized.endsWith("/.local/bin/claude.exe") ||
    normalized.includes("/.local/share/claude/")
  );
}

const UPDATE = makePackageManagedProviderMaintenanceResolver({
  provider: DRIVER_KIND,
  npmPackageName: "@anthropic-ai/claude-code",
  homebrewFormula: "claude-code",
  nativeUpdate: {
    executable: "claude",
    args: ["update"],
    lockKey: "claude-native",
    isCommandPath: isClaudeNativeCommandPath,
  },
});

const CLAUDE_SYNTHERO_IDENTITY: ClaudeProviderIdentity = {
  provider: DRIVER_KIND,
  displayName: "Claude Synthero",
  showInteractionModeToggle: true,
  disabledMessage: "Claude Synthero is disabled in SergeCode settings.",
  uncheckedMessage: "Claude Synthero provider status has not been checked in this session yet.",
  commandMissingMessage: "Claude Synthero requires the Claude Code CLI (`claude`) to be installed.",
  healthCheckFailedMessage: "Failed to execute Claude Code health check for Claude Synthero.",
  timedOutMessage: "Claude Code is installed but timed out while checking Claude Synthero.",
  commandFailedMessage: "Claude Code is installed but failed to run for Claude Synthero.",
  authUnknownMessage:
    "Could not verify Claude Synthero authentication from Claude Code initialization.",
};

export type ClaudeSyntheroDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

/**
 * Read a provider-scoped environment variable by name from a provider
 * instance environment list, trimming surrounding whitespace.
 *
 * @param environment - Provider instance environment variables.
 * @param name - Environment variable name to look up.
 * @returns The trimmed value, or `undefined` when the variable is absent.
 */
function resolveProviderScopedEnv(
  environment: ProviderInstanceEnvironment,
  name: string,
): string | undefined {
  return environment.find((variable) => variable.name === name)?.value.trim();
}

/**
 * Resolve the effective Synthero auth token for a Claude Synthero instance.
 *
 * Resolution order: the explicit `authToken` setting, then a provider-scoped
 * `SYNTHERO_AUTH_TOKEN` / `ANTHROPIC_AUTH_TOKEN`, then a process-level
 * `SYNTHERO_AUTH_TOKEN`. Returns an empty string when the provider is
 * disabled or no token is configured, so a real key is never hardcoded.
 *
 * @param settings - Synthero settings subset carrying `authToken`/`enabled`.
 * @param providerEnvironment - Provider-scoped environment variables.
 * @param processEnv - Process environment used as the final fallback.
 * @returns The resolved token, or an empty string when none is available.
 */
export function resolveClaudeSyntheroAuthToken(
  settings: Pick<ClaudeSyntheroSettingsType, "authToken" | "enabled">,
  providerEnvironment: ProviderInstanceEnvironment,
  processEnv: NodeJS.ProcessEnv,
): string {
  if (!settings.enabled) return "";
  const configured = settings.authToken.trim();
  if (configured.length > 0) return configured;

  const providerScoped =
    resolveProviderScopedEnv(providerEnvironment, SYNTHERO_AUTH_TOKEN_ENV) ??
    resolveProviderScopedEnv(providerEnvironment, ANTHROPIC_AUTH_TOKEN_ENV);
  if (providerScoped && providerScoped.length > 0) return providerScoped;

  return processEnv[SYNTHERO_AUTH_TOKEN_ENV]?.trim() ?? "";
}

/**
 * Resolve the Synthero base URL for a Claude Synthero instance, falling back
 * to the default Anthropic-compatible endpoint when unset.
 *
 * @param settings - Synthero settings subset carrying `baseURL`.
 * @returns The configured base URL, or the Synthero default.
 */
function resolveClaudeSyntheroBaseURL(settings: Pick<ClaudeSyntheroSettingsType, "baseURL">) {
  const configured = settings.baseURL.trim();
  return configured.length > 0 ? configured : DEFAULT_SYNTHERO_BASE_URL;
}

/**
 * Project Synthero settings onto the base {@link ClaudeSettings} shape so the
 * shared Claude adapter, provider probe, and text generation can be reused
 * without knowing about Synthero-specific fields.
 *
 * @param config - The full Claude Synthero settings.
 * @returns Equivalent base Claude settings for the shared Claude runtime.
 */
function toClaudeSettings(config: ClaudeSyntheroSettingsType): ClaudeSettings {
  return {
    enabled: config.enabled,
    binaryPath: config.binaryPath,
    homePath: config.homePath,
    customModels: config.customModels,
    launchArgs: config.launchArgs,
  } satisfies ClaudeSettings;
}

/**
 * Resolve the latest Claude Synthero settings for this instance from the
 * current server settings snapshot.
 *
 * `ProviderInstanceRegistry` rebuilds instances when configs change, but
 * `makeManagedServerProvider` can also apply settings streams in-place. This
 * helper keeps provider status refreshes from using the token/base URL that
 * happened to be captured when `create()` originally ran.
 *
 * @param input.settings - Current server settings snapshot.
 * @param input.instanceId - Provider instance id for this materialized driver.
 * @param input.fallbackConfig - Last known-good config to use if an in-flight
 * provider instance config cannot be decoded.
 * @returns The latest effective Claude Synthero settings for this instance.
 */
export function resolveCurrentClaudeSyntheroSettings(input: {
  readonly settings: ServerSettings;
  readonly instanceId: ProviderInstanceId;
  readonly fallbackConfig: ClaudeSyntheroSettingsType;
}): Effect.Effect<ClaudeSyntheroSettingsType> {
  const providerInstance = input.settings.providerInstances[input.instanceId];
  if (providerInstance?.driver === DRIVER_KIND) {
    return decodeClaudeSyntheroSettingsEffect(providerInstance.config ?? {}).pipe(
      Effect.map(
        (decoded) =>
          ({
            ...decoded,
            enabled: providerInstance.enabled ?? decoded.enabled,
          }) satisfies ClaudeSyntheroSettingsType,
      ),
      Effect.orElseSucceed(() => input.fallbackConfig),
    );
  }

  return Effect.succeed(input.settings.providers["claude-synthero"]);
}

/**
 * Build the process environment for a Claude Synthero session.
 *
 * Starts from `baseEnv` with any inherited normal-Claude `ANTHROPIC_AUTH_TOKEN`
 * removed, then layers Synthero's Anthropic-compatible endpoint, the resolved
 * Synthero auth token (only when present), and the Claude Code privacy flags.
 * This keeps the user's normal Claude login/setup isolated from Synthero.
 *
 * @param input.settings - The effective Claude Synthero settings.
 * @param input.providerEnvironment - Provider-scoped environment variables.
 * @param input.baseEnv - Base process environment to derive from.
 * @returns A process environment scoped to this Synthero instance.
 */
export function makeClaudeSyntheroEnvironment(input: {
  readonly settings: ClaudeSyntheroSettingsType;
  readonly providerEnvironment: ProviderInstanceEnvironment;
  readonly baseEnv: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const { ANTHROPIC_AUTH_TOKEN: _normalClaudeAuthToken, ...baseEnvWithoutClaudeAuth } =
    input.baseEnv;
  const authToken = resolveClaudeSyntheroAuthToken(
    input.settings,
    input.providerEnvironment,
    input.baseEnv,
  );
  return {
    ...baseEnvWithoutClaudeAuth,
    ANTHROPIC_BASE_URL: resolveClaudeSyntheroBaseURL(input.settings),
    ...(authToken.length > 0 ? { ANTHROPIC_AUTH_TOKEN: authToken } : {}),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
  };
}

/**
 * Build a pending provider snapshot flagged as needing authentication, used
 * when Claude Synthero is enabled but no auth token could be resolved.
 *
 * @param config - The effective Claude Synthero settings.
 * @returns A draft snapshot in an unauthenticated error state when enabled.
 */
function makeMissingAuthProvider(
  config: ClaudeSyntheroSettingsType,
): Effect.Effect<ServerProviderDraft> {
  return makePendingClaudeProvider(toClaudeSettings(config), CLAUDE_SYNTHERO_IDENTITY).pipe(
    Effect.map((pending) =>
      config.enabled
        ? {
            ...pending,
            installed: true,
            status: "error" as const,
            auth: { status: "unauthenticated" as const, type: DRIVER_KIND },
            message:
              "Claude Synthero auth token is missing. Add it in provider settings or set SYNTHERO_AUTH_TOKEN in the provider environment.",
          }
        : pending,
    ),
  );
}

/**
 * Curried snapshot transformer that stamps a provider draft with the
 * Claude Synthero driver kind plus the instance-specific id, display name,
 * accent color, and continuation group key.
 *
 * @param input.instanceId - The provider instance id to stamp.
 * @param input.displayName - Optional instance display name override.
 * @param input.accentColor - Optional instance accent color.
 * @param input.continuationGroupKey - Continuation grouping key for the instance.
 * @returns A function mapping a {@link ServerProviderDraft} to a stamped {@link ServerProvider}.
 */
const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

/**
 * Provider driver for Claude Synthero.
 *
 * Reuses the shared Claude adapter, provider probe, and text generation while
 * running under the `claude-synthero` driver kind with a Synthero-scoped
 * environment. `create` materializes one instance: it builds the isolated
 * process environment, resolves the auth token, wires the snapshot/adapter/
 * text-generation closures, and reports a missing-auth snapshot when enabled
 * without a token.
 */
export const ClaudeSyntheroDriver: ProviderDriver<
  ClaudeSyntheroSettingsType,
  ClaudeSyntheroDriverEnv
> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Claude Synthero",
    supportsMultipleInstances: true,
  },
  configSchema: ClaudeSyntheroSettings,
  defaultConfig: (): ClaudeSyntheroSettingsType => decodeClaudeSyntheroSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const httpClient = yield* HttpClient.HttpClient;
      const serverSettings = yield* ServerSettingsService;
      const eventLoggers = yield* ProviderEventLoggers;
      const baseEnv = mergeProviderInstanceEnvironment(environment);
      const effectiveConfig = { ...config, enabled } satisfies ClaudeSyntheroSettingsType;
      const claudeSettings = toClaudeSettings(effectiveConfig);
      const processEnv = makeClaudeSyntheroEnvironment({
        settings: effectiveConfig,
        providerEnvironment: environment,
        baseEnv,
      });
      const fallbackContinuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
        binaryPath: effectiveConfig.binaryPath,
        env: processEnv,
      });
      const continuationGroupKey = yield* makeClaudeContinuationGroupKey(claudeSettings);
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey,
      });

      const adapter = yield* makeClaudeAdapter(claudeSettings, {
        instanceId,
        driverKind: DRIVER_KIND,
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
      });
      const textGeneration = yield* makeClaudeTextGeneration(claudeSettings, processEnv);

      const currentSnapshotSettings = serverSettings.getSettings.pipe(
        Effect.flatMap((settings) =>
          resolveCurrentClaudeSyntheroSettings({
            settings,
            instanceId,
            fallbackConfig: effectiveConfig,
          }).pipe(
            Effect.map(
              (provider) =>
                ({
                  provider,
                  enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
                }) satisfies ProviderSnapshotSettings<ClaudeSyntheroSettingsType>,
            ),
          ),
        ),
      );
      const streamSnapshotSettings = serverSettings.streamChanges.pipe(
        Stream.mapEffect((settings) =>
          resolveCurrentClaudeSyntheroSettings({
            settings,
            instanceId,
            fallbackConfig: effectiveConfig,
          }).pipe(
            Effect.map(
              (provider) =>
                ({
                  provider,
                  enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
                }) satisfies ProviderSnapshotSettings<ClaudeSyntheroSettingsType>,
            ),
          ),
        ),
      );

      const checkProvider = currentSnapshotSettings.pipe(
        Effect.flatMap((settings) => {
          const currentConfig = settings.provider;
          const currentClaudeSettings = toClaudeSettings(currentConfig);
          const currentProcessEnv = makeClaudeSyntheroEnvironment({
            settings: currentConfig,
            providerEnvironment: environment,
            baseEnv,
          });
          const currentAuthToken = resolveClaudeSyntheroAuthToken(
            currentConfig,
            environment,
            baseEnv,
          );
          return currentAuthToken.length === 0 && currentConfig.enabled
            ? makeMissingAuthProvider(currentConfig)
            : checkClaudeProviderStatus(
                currentClaudeSettings,
                () =>
                  probeClaudeCapabilities(currentClaudeSettings, currentProcessEnv).pipe(
                    Effect.provideService(Path.Path, path),
                  ),
                currentProcessEnv,
                CLAUDE_SYNTHERO_IDENTITY,
              );
        }),
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(Path.Path, path),
      );

      const snapshot = yield* makeManagedServerProvider<
        ProviderSnapshotSettings<ClaudeSyntheroSettingsType>
      >({
        maintenanceCapabilities,
        getSettings: currentSnapshotSettings,
        streamSettings: streamSnapshotSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          makePendingClaudeProvider(
            toClaudeSettings(settings.provider),
            CLAUDE_SYNTHERO_IDENTITY,
          ).pipe(Effect.map(stampIdentity)),
        checkProvider,
        enrichSnapshot: ({ settings, snapshot, publishSnapshot }) =>
          enrichProviderSnapshotWithVersionAdvisory(snapshot, maintenanceCapabilities, {
            enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
          }).pipe(
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
          ),
        refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Claude Synthero snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity: {
          ...fallbackContinuationIdentity,
          continuationKey: continuationGroupKey,
        },
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
