import {
  normalizeDevinSessionUpdate,
  normalizeDevinToolCall,
  extractDevinSubagentUpdate,
} from "./devinAcp.ts";
import { defaultInstanceIdForDriver, ProviderDriverKind } from "@t3tools/contracts";
import { AcpRegistrySettings } from "../settings.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation, type SelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";

import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import {
  normalizeAcpRegistryCommands,
  normalizeAcpRegistryLiveConfiguration,
  normalizeAcpRegistryWebUrl,
} from "./probe.ts";
import * as AcpRegistrySupport from "./AcpRegistrySupport.ts";
import * as AcpRegistryRuntimeCoordinator from "./AcpRegistryRuntimeCoordinator.ts";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { makeAcpNativeLoggerFactory } from "@t3tools/provider-acp/server/nativeLogging";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "@t3tools/provider-core/server/adapterDriver";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2ExtensionContext,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
} from "@t3tools/provider-acp/server/adapter";

export const ACP_REGISTRY_PROVIDER = ProviderDriverKind.make("acpRegistry");
export const ACP_REGISTRY_DEFAULT_INSTANCE_ID = defaultInstanceIdForDriver(ACP_REGISTRY_PROVIDER);

const DEFAULT_ACP_REGISTRY_SETTINGS = Schema.decodeSync(AcpRegistrySettings)({});
const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

export interface AcpRegistryAdapterV2Options {
  readonly instanceId: Parameters<typeof makeAcpAdapterV2>[0]["instanceId"];
  readonly settings: AcpRegistrySettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly selfInvocation: SelfInvocation;
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
  readonly makeRuntime?: (
    input: AcpAdapterV2RuntimeInput,
  ) => Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError,
    ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope
  >;
  readonly assertComplete?: Effect.Effect<void, EffectAcpErrors.AcpError>;
}

// ─── Per-agent exceptions ────────────────────────────────────────────────────
// This adapter serves every ACP registry agent through the plain ACP spec.
// Agent-specific behavior does not belong here: an agent that needs it gets a
// dedicated driver (as Grok and Antigravity have). The few exceptions below
// predate that rule and are small presentation hooks, not permission or tool
// behavior.
//
// Agents changing this file: do NOT add another `agentId === "..."` branch,
// agent table, or agent-specific hook without explicit approval from the
// maintainer in the conversation. Propose a dedicated driver instead.

// Mistral Vibe: its application error code for rate limits (not an ACP code).
const MISTRAL_VIBE_RATE_LIMITED = -31001;

const MistralVibeSessionRetrying = Schema.Struct({
  sessionId: Schema.String,
  category: Schema.Literals(["rate_limited", "server_error", "timed_out", "connection", "unknown"]),
  detail: Schema.String,
});

/** Mistral Vibe (v2.25.5) reports SDK backoff through this ACP extension. */
export function registerMistralVibeAcpExtensions(context: AcpAdapterV2ExtensionContext) {
  return context.runtime.handleExtNotification(
    "_session/retrying",
    MistralVibeSessionRetrying,
    (notice) =>
      context.reportProviderRetry({
        sessionId: notice.sessionId,
        failure: makeProviderFailure({
          message: notice.detail,
          class:
            notice.category === "rate_limited"
              ? "usage_limit"
              : notice.category === "unknown"
                ? "provider_error"
                : "transport_error",
          retryable: true,
        }),
      }),
  );
}
// ─── End per-agent exceptions (Devin's gates are marked in makeAcpRegistryAdapterV2) ───

export function acpRegistryPromptFailure(agentId: string, cause: unknown) {
  return makeProviderFailure({
    cause,
    ...(isAcpRequestError(cause)
      ? {
          message: cause.errorMessage,
          code: String(cause.code),
          class:
            // Per-agent exception: see the note above registerMistralVibeAcpExtensions.
            agentId === "mistral-vibe" && cause.code === MISTRAL_VIBE_RATE_LIMITED
              ? ("usage_limit" as const)
              : ("provider_error" as const),
        }
      : { class: "provider_error" as const }),
  });
}

function makeAcpRegistryRuntime(
  options: AcpRegistryAdapterV2Options,
  catalog: AcpRegistrySupport.AcpRegistryCatalog["Service"],
) {
  return (
    input: AcpAdapterV2RuntimeInput,
  ): Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError,
    ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope
  > =>
    Effect.gen(function* () {
      const { processEnvironment, ...runtimeInput } = input;
      const resolved = yield* catalog
        .resolve(options.settings, input.cwd, options.environment)
        .pipe(
          Effect.mapError(
            (cause) =>
              new EffectAcpErrors.AcpSpawnError({
                command: options.settings.agentId || ACP_REGISTRY_PROVIDER,
                cause,
              }),
          ),
        );
      const context = yield* Layer.build(
        AcpSessionRuntime.layer({
          ...runtimeInput,
          spawn:
            processEnvironment === undefined
              ? resolved.spawn
              : {
                  ...resolved.spawn,
                  env: { ...resolved.spawn.env, ...processEnvironment },
                },
          ...(options.settings.authMethodId ? { authMethodId: options.settings.authMethodId } : {}),
        }),
      );
      return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
        Effect.provide(context),
      );
    });
}

export const makeAcpRegistryAdapterV2 = Effect.fn("makeAcpRegistryAdapterV2")(function* (
  options: AcpRegistryAdapterV2Options,
) {
  const catalog = yield* AcpRegistrySupport.AcpRegistryCatalog;
  const runtimeCoordinator = Option.getOrUndefined(
    yield* Effect.serviceOption(AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator),
  );
  const registryAgentId = options.settings.source === "local" ? "" : options.settings.agentId;
  const startupKey =
    options.settings.source === "local" ? `local:${options.instanceId}` : registryAgentId;
  const isDevin = registryAgentId === "devin";
  const flavor: AcpAdapterV2Flavor = {
    driver: ACP_REGISTRY_PROVIDER,
    capabilities: AcpProviderCapabilitiesV2,
    promptFailure: (cause) => acpRegistryPromptFailure(registryAgentId, cause),
    // Per-agent exceptions (Mistral Vibe, Devin): see the note above
    // registerMistralVibeAcpExtensions before adding any more.
    ...(registryAgentId === "mistral-vibe"
      ? { registerExtensions: registerMistralVibeAcpExtensions }
      : {}),
    ...(isDevin
      ? {
          clientCapabilitiesMeta: {
            "cognition.ai/subagentSupport": true,
            "cognition.ai/messageGrouping": true,
          },
          normalizeSessionUpdate: normalizeDevinSessionUpdate,
          normalizeToolCall: normalizeDevinToolCall,
          extractSubagentUpdate: extractDevinSubagentUpdate,
        }
      : {}),
    makeRuntime: options.makeRuntime ?? makeAcpRegistryRuntime(options, catalog),
    ...(runtimeCoordinator === undefined
      ? {}
      : {
          onAvailableCommandsUpdate: (commands) =>
            runtimeCoordinator.publishAvailableCommands(
              options.instanceId,
              normalizeAcpRegistryCommands(commands),
            ),
          onSessionConfigurationUpdate: (configOptions, modeState) =>
            runtimeCoordinator.publishLiveConfiguration(
              options.instanceId,
              normalizeAcpRegistryLiveConfiguration(configOptions, modeState),
            ),
          onUrlElicitation: ({ elicitationId, url, message }) => {
            const normalizedUrl = normalizeAcpRegistryWebUrl(url);
            if (normalizedUrl === undefined || elicitationId.trim().length === 0) {
              return Effect.succeed(false);
            }
            return runtimeCoordinator.requestUrlAuthentication(options.instanceId, {
              elicitationId: elicitationId.trim().slice(0, 256),
              url: normalizedUrl,
              message: message.trim().slice(0, 1_024),
            });
          },
          withRuntimeStartup: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            runtimeCoordinator.withForegroundStartup(startupKey, effect),
        }),
    ...(options.assertComplete === undefined ? {} : { assertComplete: options.assertComplete }),
  };
  return yield* makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor,
    selfInvocation: options.selfInvocation,
    // Per-agent exception (see the note above registerMistralVibeAcpExtensions):
    // Devin runs commands through client terminals and has no ask mode over
    // ACP to fall back on. Every other registry agent runs its own.
    ...(isDevin
      ? {
          clientTerminals: {
            environment: options.environment,
            shellCommands: true,
          },
        }
      : {}),
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
  });
});

export type AcpRegistryAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | AcpRegistrySupport.AcpRegistryCatalog
  | IdAllocator.IdAllocatorV2
  | Path.Path
  | McpProviderSessions.McpProviderSessions
  | ProviderEventLoggers.ProviderEventLoggers
  | ProviderHost.ProviderHost;

export const AcpRegistryAdapterV2Driver: ProviderAdapterDriver<
  AcpRegistrySettings,
  AcpRegistryAdapterV2DriverEnv
> = {
  driverKind: ACP_REGISTRY_PROVIDER,
  configSchema: AcpRegistrySettings,
  defaultConfig: (): AcpRegistrySettings => DEFAULT_ACP_REGISTRY_SETTINGS,
  create: Effect.fn("AcpRegistryAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<AcpRegistrySettings>) {
      const hostEnvironment = yield* HostProcess.Environment;
      const selfInvocation = yield* resolveSelfInvocation();
      const providerEventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
      return yield* makeAcpRegistryAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: yield* mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        selfInvocation,
        nativeLogging: (threadId) =>
          makeNativeLogger({
            nativeEventLogger: providerEventLoggers.native,
            provider: ACP_REGISTRY_PROVIDER,
            threadId,
          }),
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: ACP_REGISTRY_PROVIDER,
              instanceId: input.instanceId,
              detail: "Failed to create ACP Registry adapter.",
              cause,
            }),
        ),
      ),
  ),
};
