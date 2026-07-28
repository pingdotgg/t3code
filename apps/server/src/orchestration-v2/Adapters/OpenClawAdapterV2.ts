import {
  defaultInstanceIdForDriver,
  OpenClawSettings,
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
import { makeAcpNativeLoggerFactory } from "../../provider/acp/AcpNativeLogging.ts";
import * as AcpSessionRuntime from "../../provider/acp/AcpSessionRuntime.ts";
import { makeOpenClawRuntime } from "../../provider/acp/OpenClawSupport.ts";
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

export const OPENCLAW_PROVIDER = ProviderDriverKind.make("openclaw");
export const OPENCLAW_DRIVER_KIND = OPENCLAW_PROVIDER;
export const OPENCLAW_DEFAULT_INSTANCE_ID = defaultInstanceIdForDriver(OPENCLAW_DRIVER_KIND);

const DEFAULT_OPENCLAW_SETTINGS = Schema.decodeSync(OpenClawSettings)({});

export interface OpenClawAdapterV2Options {
  readonly instanceId: Parameters<typeof makeAcpAdapterV2>[0]["instanceId"];
  readonly settings: OpenClawSettings;
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

export function makeOpenClawAdapterV2(options: OpenClawAdapterV2Options) {
  return makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: {
      driver: OPENCLAW_PROVIDER,
      capabilities: AcpProviderCapabilitiesV2,
      makeRuntime:
        options.makeRuntime ??
        ((input) =>
          makeOpenClawRuntime({
            ...input,
            openClawSettings: options.settings,
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

export type OpenClawAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | IdAllocatorV2
  | ProviderEventLoggers
  | ServerConfig;

export const OpenClawAdapterV2Driver: ProviderAdapterDriver<
  OpenClawSettings,
  OpenClawAdapterV2DriverEnv
> = {
  driverKind: OPENCLAW_DRIVER_KIND,
  configSchema: OpenClawSettings,
  defaultConfig: (): OpenClawSettings => DEFAULT_OPENCLAW_SETTINGS,
  create: Effect.fn("OpenClawAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<OpenClawSettings>) {
      const hostEnvironment = yield* HostProcessEnvironment;
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const crypto = yield* Crypto.Crypto;
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocatorV2;
      const providerEventLoggers = yield* ProviderEventLoggers;
      const serverConfig = yield* ServerConfig;
      const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
      return makeOpenClawAdapterV2({
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
            provider: OPENCLAW_PROVIDER,
            threadId,
          }),
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: OPENCLAW_DRIVER_KIND,
              instanceId: input.instanceId,
              detail: "Failed to create OpenClaw ACP adapter.",
              cause,
            }),
        ),
      ),
  ),
};
