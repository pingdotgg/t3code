import {
  defaultInstanceIdForDriver,
  HermesAcpSettings,
  type OrchestrationV2ProviderCapabilities,
  ProviderDriverKind,
} from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpErrors from "effect-acp/errors";

import { ServerConfig } from "../../config.ts";
import { makeHermesAcpRuntime } from "../../provider/acp/HermesAcpSupport.ts";
import { makeAcpNativeLoggerFactory } from "../../provider/acp/AcpNativeLogging.ts";
import * as AcpSessionRuntime from "../../provider/acp/AcpSessionRuntime.ts";
import { ProviderEventLoggers } from "../../provider/Layers/ProviderEventLoggers.ts";
import { mergeProviderInstanceEnvironment } from "../../provider/ProviderInstanceEnvironment.ts";
import { IdAllocatorV2 } from "../IdAllocator.ts";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "../ProviderAdapterDriver.ts";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2RuntimeInput,
} from "./AcpAdapterV2.ts";

export const HERMES_ACP_PROVIDER = ProviderDriverKind.make("hermesAcp");
export const HERMES_ACP_DRIVER_KIND = HERMES_ACP_PROVIDER;
export const HERMES_ACP_DEFAULT_INSTANCE_ID = defaultInstanceIdForDriver(HERMES_ACP_DRIVER_KIND);

const DEFAULT_HERMES_ACP_SETTINGS = Schema.decodeSync(HermesAcpSettings)({});

/**
 * Hermes 0.19 accepts HTTP MCP servers (including headers) in session/new,
 * session/load, session/resume, and session/fork, but its initialize response
 * omits ACP mcpCapabilities. Keep this compatibility assertion isolated to
 * Hermes instead of weakening negotiation for every ACP provider.
 */
export const HermesAcpProviderCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  tools: {
    ...AcpProviderCapabilitiesV2.tools,
    supportsMcpTools: true,
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface HermesAcpAdapterV2Options {
  readonly instanceId: Parameters<typeof makeAcpAdapterV2>[0]["instanceId"];
  readonly settings: HermesAcpSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly crypto: Crypto.Crypto;
  readonly fileSystem: FileSystem.FileSystem;
  readonly idAllocator: IdAllocatorV2["Service"];
  readonly serverConfig: ServerConfig["Service"];
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
  readonly makeRuntime?: (
    input: AcpAdapterV2RuntimeInput,
  ) => Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError,
    Crypto.Crypto | Scope.Scope
  >;
  readonly assertComplete?: Effect.Effect<void, EffectAcpErrors.AcpError>;
}

export function makeHermesAcpAdapterV2(options: HermesAcpAdapterV2Options) {
  return makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: {
      driver: HERMES_ACP_PROVIDER,
      capabilities: HermesAcpProviderCapabilitiesV2,
      supportsImagePrompts: true,
      makeRuntime:
        options.makeRuntime ??
        ((input) =>
          makeHermesAcpRuntime({
            ...input,
            hermesSettings: options.settings,
            environment: options.environment,
            childProcessSpawner: options.childProcessSpawner,
          })),
      ...(options.assertComplete === undefined ? {} : { assertComplete: options.assertComplete }),
    },
    crypto: options.crypto,
    fileSystem: options.fileSystem,
    idAllocator: options.idAllocator,
    serverConfig: options.serverConfig,
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
  });
}

export type HermesAcpAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | IdAllocatorV2
  | ProviderEventLoggers
  | ServerConfig;

export const HermesAcpAdapterV2Driver: ProviderAdapterDriver<
  HermesAcpSettings,
  HermesAcpAdapterV2DriverEnv
> = {
  driverKind: HERMES_ACP_DRIVER_KIND,
  configSchema: HermesAcpSettings,
  defaultConfig: (): HermesAcpSettings => DEFAULT_HERMES_ACP_SETTINGS,
  create: Effect.fn("HermesAcpAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<HermesAcpSettings>) {
      const hostEnvironment = yield* HostProcessEnvironment;
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const crypto = yield* Crypto.Crypto;
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocatorV2;
      const providerEventLoggers = yield* ProviderEventLoggers;
      const serverConfig = yield* ServerConfig;
      const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
      return makeHermesAcpAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        childProcessSpawner,
        crypto,
        fileSystem,
        idAllocator,
        serverConfig,
        nativeLogging: (threadId) =>
          makeNativeLogger({
            nativeEventLogger: providerEventLoggers.native,
            provider: HERMES_ACP_PROVIDER,
            threadId,
          }),
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: HERMES_ACP_DRIVER_KIND,
              instanceId: input.instanceId,
              detail: "Failed to create Hermes in Code ACP adapter.",
              cause,
            }),
        ),
      ),
  ),
};
