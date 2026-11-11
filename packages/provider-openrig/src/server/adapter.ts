import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation, type SelfInvocation } from "@t3tools/shared/nodeRuntime";
import { type OrchestrationV2ProviderCapabilities } from "@t3tools/contracts";
import { OpenRigSettings } from "../settings.ts";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";

import type * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { makeAcpNativeLoggerFactory } from "@t3tools/provider-acp/server/nativeLogging";
import { OPENRIG_DRIVER_KIND, makeOpenRigAcpRuntime } from "./acpSupport.ts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
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
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
} from "@t3tools/provider-acp/server/adapter";

const DEFAULT_OPENRIG_SETTINGS = Schema.decodeSync(OpenRigSettings)({});

/**
 * OpenRig speaks stock ACP via `rig acp serve`. Keep capabilities honest to the
 * shared ACP baseline; team steps and questions arrive as ordinary ACP updates.
 */
const OpenRigProviderCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  tools: {
    ...AcpProviderCapabilitiesV2.tools,
    supportsMcpTools: true,
  },
} satisfies OrchestrationV2ProviderCapabilities;

interface OpenRigAdapterV2Options {
  readonly instanceId: Parameters<typeof makeAcpAdapterV2>[0]["instanceId"];
  readonly settings: OpenRigSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly selfInvocation: SelfInvocation;
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
  /** Replaces the `rig acp serve` launch (replay tests). */
  readonly makeRuntime?: (
    input: AcpAdapterV2RuntimeInput,
  ) => Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError,
    ChildProcessSpawner.ChildProcessSpawner | SecureRandom.SecureRandom | Scope.Scope
  >;
  readonly assertComplete?: Effect.Effect<void, EffectAcpErrors.AcpError>;
}

function makeOpenRigAcpAdapterFlavor(options: OpenRigAdapterV2Options): AcpAdapterV2Flavor {
  const makeRuntime =
    options.makeRuntime ??
    (({ runtimePolicy: _runtimePolicy, processEnvironment, ...input }: AcpAdapterV2RuntimeInput) =>
      makeOpenRigAcpRuntime({
        ...input,
        settings: options.settings,
        environment: { ...options.environment, ...processEnvironment },
      }));
  return {
    driver: OPENRIG_DRIVER_KIND,
    runtimeHarness: "openrig",
    capabilities: OpenRigProviderCapabilitiesV2,
    makeRuntime,
    ...(options.assertComplete === undefined ? {} : { assertComplete: options.assertComplete }),
  };
}

const makeOpenRigAdapterV2 = Effect.fn("makeOpenRigAdapterV2")(function* (
  options: OpenRigAdapterV2Options,
) {
  return yield* makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: makeOpenRigAcpAdapterFlavor(options),
    selfInvocation: options.selfInvocation,
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
  });
});

export type OpenRigAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | SecureRandom.SecureRandom
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | Path.Path
  | McpProviderSessions.McpProviderSessions
  | ProviderEventLoggers.ProviderEventLoggers
  | ProviderHost.ProviderHost;

export const makeOpenRigAdapterV2Driver = (): ProviderAdapterDriver<
  OpenRigSettings,
  OpenRigAdapterV2DriverEnv
> => ({
  driverKind: OPENRIG_DRIVER_KIND,
  configSchema: OpenRigSettings,
  defaultConfig: (): OpenRigSettings => DEFAULT_OPENRIG_SETTINGS,
  create: Effect.fn("OpenRigAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<OpenRigSettings>) {
      const hostEnvironment = yield* HostProcess.Environment;
      const selfInvocation = yield* resolveSelfInvocation();
      const providerEventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
      return yield* makeOpenRigAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: yield* mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        selfInvocation,
        nativeLogging: (threadId) =>
          makeNativeLogger({
            nativeEventLogger: providerEventLoggers.native,
            provider: OPENRIG_DRIVER_KIND,
            threadId,
          }),
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: OPENRIG_DRIVER_KIND,
              instanceId: input.instanceId,
              detail: "Failed to create the OpenRig ACP adapter.",
              cause,
            }),
        ),
      ),
  ),
});
