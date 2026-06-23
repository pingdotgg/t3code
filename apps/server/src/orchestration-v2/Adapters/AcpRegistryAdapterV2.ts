import {
  AcpRegistrySettings,
  defaultInstanceIdForDriver,
  ProviderDriverKind,
} from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as EffectAcpErrors from "effect-acp/errors";

import { ServerConfig } from "../../config.ts";
import {
  makeAcpRegistryResolver,
  type AcpRegistryResolverShape,
} from "../../provider/acp/AcpRegistrySupport.ts";
import * as AcpSessionRuntime from "../../provider/acp/AcpSessionRuntime.ts";
import { makeAcpNativeLoggerFactory } from "../../provider/acp/AcpNativeLogging.ts";
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
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
} from "./AcpAdapterV2.ts";

export const ACP_REGISTRY_PROVIDER = ProviderDriverKind.make("acpRegistry");
export const ACP_REGISTRY_DRIVER_KIND = ACP_REGISTRY_PROVIDER;
export const ACP_REGISTRY_DEFAULT_INSTANCE_ID =
  defaultInstanceIdForDriver(ACP_REGISTRY_DRIVER_KIND);

const DEFAULT_ACP_REGISTRY_SETTINGS = Schema.decodeSync(AcpRegistrySettings)({});

export interface AcpRegistryAdapterV2Options {
  readonly instanceId: Parameters<typeof makeAcpAdapterV2>[0]["instanceId"];
  readonly settings: AcpRegistrySettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly fileSystem: FileSystem.FileSystem;
  readonly idAllocator: IdAllocatorV2["Service"];
  readonly resolver: AcpRegistryResolverShape;
  readonly serverConfig: ServerConfig["Service"];
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
  readonly makeRuntime?: (
    input: AcpAdapterV2RuntimeInput,
  ) => Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError,
    Scope.Scope
  >;
  readonly assertComplete?: Effect.Effect<void, EffectAcpErrors.AcpError>;
}

function makeAcpRegistryRuntime(options: AcpRegistryAdapterV2Options) {
  return (
    input: AcpAdapterV2RuntimeInput,
  ): Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError,
    Scope.Scope
  > =>
    Effect.gen(function* () {
      const resolved = yield* options.resolver
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
          ...input,
          spawn: resolved.spawn,
          ...(options.settings.authMethodId ? { authMethodId: options.settings.authMethodId } : {}),
        }).pipe(
          Layer.provide(
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, options.childProcessSpawner),
          ),
        ),
      );
      return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
        Effect.provide(context),
      );
    });
}

export function makeAcpRegistryAdapterV2(options: AcpRegistryAdapterV2Options) {
  const flavor: AcpAdapterV2Flavor = {
    driver: ACP_REGISTRY_PROVIDER,
    capabilities: AcpProviderCapabilitiesV2,
    makeRuntime: options.makeRuntime ?? makeAcpRegistryRuntime(options),
    ...(options.assertComplete === undefined ? {} : { assertComplete: options.assertComplete }),
  };
  return makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor,
    fileSystem: options.fileSystem,
    idAllocator: options.idAllocator,
    serverConfig: options.serverConfig,
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
  });
}

export type AcpRegistryAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | IdAllocatorV2
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig;

export const AcpRegistryAdapterV2Driver: ProviderAdapterDriver<
  AcpRegistrySettings,
  AcpRegistryAdapterV2DriverEnv
> = {
  driverKind: ACP_REGISTRY_DRIVER_KIND,
  configSchema: AcpRegistrySettings,
  defaultConfig: (): AcpRegistrySettings => DEFAULT_ACP_REGISTRY_SETTINGS,
  create: Effect.fn("AcpRegistryAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<AcpRegistrySettings>) {
      const hostEnvironment = yield* HostProcessEnvironment;
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocatorV2;
      const providerEventLoggers = yield* ProviderEventLoggers;
      const serverConfig = yield* ServerConfig;
      const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
      const resolver = yield* makeAcpRegistryResolver({
        cacheDir: serverConfig.providerStatusCacheDir,
      });
      return makeAcpRegistryAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        childProcessSpawner,
        fileSystem,
        idAllocator,
        resolver,
        serverConfig,
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
              driver: ACP_REGISTRY_DRIVER_KIND,
              instanceId: input.instanceId,
              detail: "Failed to create ACP Registry adapter.",
              cause,
            }),
        ),
      ),
  ),
};
