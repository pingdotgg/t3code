import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation, type SelfInvocation } from "@t3tools/shared/nodeRuntime";
import { readCustomModelEntries } from "@t3tools/shared/model";
import { VibeSettings } from "../settings.ts";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { makeAcpNativeLoggerFactory } from "@t3tools/provider-acp/server/nativeLogging";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import type * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "@t3tools/provider-core/server/adapterDriver";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2RuntimeInput,
} from "@t3tools/provider-acp/server/adapter";
import {
  makeVibeAcpRuntime,
  registerVibeAcpExtensions,
  VIBE_DRIVER_KIND,
  vibePromptFailure,
  vibeRuntimeModeForSessionMode,
  vibeSessionModeForPolicy,
} from "./acpSupport.ts";

const DEFAULT_VIBE_SETTINGS = Schema.decodeSync(VibeSettings)({});

interface VibeAdapterV2Options {
  readonly instanceId: Parameters<typeof makeAcpAdapterV2>[0]["instanceId"];
  readonly settings: VibeSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly selfInvocation: SelfInvocation;
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
}

const makeVibeAdapterV2 = Effect.fn("makeVibeAdapterV2")(function* (options: VibeAdapterV2Options) {
  return yield* makeAcpAdapterV2({
    instanceId: options.instanceId,
    selfInvocation: options.selfInvocation,
    flavor: {
      driver: VIBE_DRIVER_KIND,
      runtimeHarness: "vibe",
      capabilities: AcpProviderCapabilitiesV2,
      customModels: readCustomModelEntries(options.settings.customModels).map(
        (entry) => entry.slug,
      ),
      makeRuntime: ({
        runtimePolicy: _runtimePolicy,
        processEnvironment,
        ...input
      }: AcpAdapterV2RuntimeInput) =>
        makeVibeAcpRuntime({
          ...input,
          settings: options.settings,
          environment: { ...options.environment, ...processEnvironment },
        }),
      sessionModeForPolicy: vibeSessionModeForPolicy,
      runtimeModeForSessionMode: vibeRuntimeModeForSessionMode,
      registerExtensions: registerVibeAcpExtensions,
      promptFailure: vibePromptFailure,
    },
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
  });
});

export type VibeAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | SecureRandom.SecureRandom
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | Path.Path
  | McpProviderSessions.McpProviderSessions
  | ProviderEventLoggers.ProviderEventLoggers
  | ProviderHost.ProviderHost;

export const VibeAdapterV2Driver: ProviderAdapterDriver<VibeSettings, VibeAdapterV2DriverEnv> = {
  driverKind: VIBE_DRIVER_KIND,
  configSchema: VibeSettings,
  defaultConfig: (): VibeSettings => DEFAULT_VIBE_SETTINGS,
  create: Effect.fn("VibeAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<VibeSettings>) {
      const hostEnvironment = yield* HostProcess.Environment;
      const providerEventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
      return yield* makeVibeAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: yield* mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        selfInvocation: yield* resolveSelfInvocation(),
        nativeLogging: (threadId) =>
          makeNativeLogger({
            nativeEventLogger: providerEventLoggers.native,
            provider: VIBE_DRIVER_KIND,
            threadId,
          }),
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: VIBE_DRIVER_KIND,
              instanceId: input.instanceId,
              detail: "Failed to create the Mistral Vibe ACP adapter.",
              cause,
            }),
        ),
      ),
  ),
};
