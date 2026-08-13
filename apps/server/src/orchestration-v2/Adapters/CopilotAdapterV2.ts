import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import {
  CopilotSettings,
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type OrchestrationV2ProviderCapabilities,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpErrors from "effect-acp/errors";

import { ServerConfig } from "../../config.ts";
import { makeAcpNativeLoggerFactory } from "../../provider/acp/AcpNativeLogging.ts";
import {
  applyCopilotSessionConfiguration,
  makeCopilotAcpRuntime,
  resolveCopilotModeId,
  resolveCopilotModelId,
} from "../../provider/acp/CopilotAcpSupport.ts";
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
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
} from "./AcpAdapterV2.ts";

export const COPILOT_PROVIDER = ProviderDriverKind.make("copilot");
export const COPILOT_DRIVER_KIND = COPILOT_PROVIDER;
export const COPILOT_DEFAULT_INSTANCE_ID = defaultInstanceIdForDriver(COPILOT_DRIVER_KIND);

const DEFAULT_COPILOT_SETTINGS = Schema.decodeSync(CopilotSettings)({});

export const CopilotProviderCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  planning: {
    ...AcpProviderCapabilitiesV2.planning,
    emitsProposedPlan: false,
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface CopilotAdapterV2Options {
  readonly instanceId: Parameters<typeof makeAcpAdapterV2>[0]["instanceId"];
  readonly settings: CopilotSettings;
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

export function makeCopilotAcpAdapterFlavor(options: CopilotAdapterV2Options): AcpAdapterV2Flavor {
  return {
    driver: COPILOT_PROVIDER,
    capabilities: CopilotProviderCapabilitiesV2,
    resolveModelId: (selection) => resolveCopilotModelId(selection.model),
    makeRuntime:
      options.makeRuntime ??
      ((input) =>
        makeCopilotAcpRuntime({
          ...input,
          copilotSettings: options.settings,
          environment: options.environment,
          childProcessSpawner: options.childProcessSpawner,
        })),
    configureSession: ({ runtime, modelSelection, runtimePolicy }) =>
      Effect.gen(function* () {
        yield* applyCopilotSessionConfiguration({
          runtime,
          model: modelSelection.model,
          selections: modelSelection.options,
          mapError: ({ cause }) => cause,
        });
        const modeState = yield* runtime.getModeState;
        const modeId = resolveCopilotModeId({
          modeState,
          interactionMode: runtimePolicy.interactionMode,
          runtimeMode: runtimePolicy.runtimeMode,
        });
        if (modeId !== undefined && modeId !== modeState?.currentModeId) {
          yield* runtime.setMode(modeId);
        }
      }),
    ...(options.assertComplete === undefined ? {} : { assertComplete: options.assertComplete }),
  };
}

export function makeCopilotAdapterV2(options: CopilotAdapterV2Options) {
  return makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: makeCopilotAcpAdapterFlavor(options),
    crypto: options.crypto,
    fileSystem: options.fileSystem,
    idAllocator: options.idAllocator,
    serverConfig: options.serverConfig,
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
  });
}

export type CopilotAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | IdAllocatorV2
  | ProviderEventLoggers
  | ServerConfig;

export const CopilotAdapterV2Driver: ProviderAdapterDriver<
  CopilotSettings,
  CopilotAdapterV2DriverEnv
> = {
  driverKind: COPILOT_DRIVER_KIND,
  configSchema: CopilotSettings,
  defaultConfig: (): CopilotSettings => DEFAULT_COPILOT_SETTINGS,
  create: Effect.fn("CopilotAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<CopilotSettings>) {
      const hostEnvironment = yield* HostProcessEnvironment;
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const crypto = yield* Crypto.Crypto;
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocatorV2;
      const providerEventLoggers = yield* ProviderEventLoggers;
      const serverConfig = yield* ServerConfig;
      const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
      return makeCopilotAdapterV2({
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
            provider: COPILOT_PROVIDER,
            threadId,
          }),
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: COPILOT_DRIVER_KIND,
              instanceId: input.instanceId,
              detail: "Failed to create GitHub Copilot ACP adapter.",
              cause,
            }),
        ),
      ),
  ),
};
