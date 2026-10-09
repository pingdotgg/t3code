import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { resolveSelfInvocation, type SelfInvocation } from "@t3tools/shared/nodeRuntime";
import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type OrchestrationV2ProviderCapabilities,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/process";
import type * as EffectAcpErrors from "effect-acp/errors";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { makeAcpNativeLoggerFactory } from "@t3tools/provider-acp/server/nativeLogging";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/continuationRequests";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
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
import { ZCodeSettings } from "../settings.ts";
import {
  applyZCodeAcpModelSelection,
  makeZCodeAcpRuntime,
  normalizeZCodeSessionUpdate,
  zcodeApprovalOptions,
  zcodePermissionMode,
  zcodePromptFailure,
} from "./acpSupport.ts";
import type { ZCodeLiveState } from "./liveState.ts";

export const ZCODE_PROVIDER = ProviderDriverKind.make("zcode");
export const ZCODE_DEFAULT_INSTANCE_ID = defaultInstanceIdForDriver(ZCODE_PROVIDER);
const DEFAULT_ZCODE_SETTINGS = Schema.decodeSync(ZCodeSettings)({});

const ZCodeProviderCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  sessions: {
    ...AcpProviderCapabilitiesV2.sessions,
    supportsModelSwitchInSession: true,
    // ZCode switches its permission mode on the live session.
    supportsRuntimeModeSwitchInSession: true,
  },
  tools: {
    ...AcpProviderCapabilitiesV2.tools,
    supportsMcpTools: true,
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface ZCodeAdapterV2Options {
  readonly instanceId: Parameters<typeof makeAcpAdapterV2>[0]["instanceId"];
  readonly settings: ZCodeSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly selfInvocation: SelfInvocation;
  /** Publishes each live session's models and commands to the instance snapshot. */
  readonly liveState?: ZCodeLiveState;
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
  readonly continuationRequests?: Parameters<typeof makeAcpAdapterV2>[0]["continuationRequests"];
  readonly testHooks?: Parameters<typeof makeAcpAdapterV2>[0]["testHooks"];
  readonly makeRuntime?: (
    input: AcpAdapterV2RuntimeInput,
  ) => Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError,
    Crypto.Crypto | Scope.Scope
  >;
  readonly assertComplete?: Effect.Effect<void, EffectAcpErrors.AcpError>;
}

function makeZCodeAcpAdapterFlavor(
  options: ZCodeAdapterV2Options & {
    readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  },
): AcpAdapterV2Flavor {
  const liveState = options.liveState;
  return {
    driver: ZCODE_PROVIDER,
    runtimeHarness: "ZCode",
    capabilities: ZCodeProviderCapabilitiesV2,
    supportsCompaction: true,
    normalizeSessionUpdate: normalizeZCodeSessionUpdate,
    makeRuntime:
      options.makeRuntime ??
      (({ runtimePolicy, processEnvironment, ...input }) =>
        makeZCodeAcpRuntime({
          ...input,
          zcodeSettings: options.settings,
          environment: { ...options.environment, ...processEnvironment },
          childProcessSpawner: options.childProcessSpawner,
          runtimeMode: runtimePolicy.runtimeMode,
        })),
    applyModelSelection: ({ runtime, modelSelection }) =>
      applyZCodeAcpModelSelection({
        runtime,
        model: modelSelection.model,
        mapError: (cause) => cause,
      }),
    sessionModeForPolicy: (policy) => zcodePermissionMode(policy.runtimeMode),
    approvalOptions: zcodeApprovalOptions,
    promptFailure: (cause) => zcodePromptFailure(cause),
    ...(liveState === undefined
      ? {}
      : {
          onAvailableCommandsUpdate: liveState.publishCommands,
          onSessionConfigurationUpdate: liveState.publishConfiguration,
        }),
    ...(options.assertComplete === undefined ? {} : { assertComplete: options.assertComplete }),
  };
}

export const makeZCodeAdapterV2 = Effect.fn("makeZCodeAdapterV2")(function* (
  options: ZCodeAdapterV2Options,
) {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: makeZCodeAcpAdapterFlavor({ ...options, childProcessSpawner }),
    selfInvocation: options.selfInvocation,
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
    ...(options.continuationRequests === undefined
      ? {}
      : { continuationRequests: options.continuationRequests }),
    ...(options.testHooks === undefined ? {} : { testHooks: options.testHooks }),
  });
});

export type ZCodeAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers
  | ProviderHost.ProviderHost;

/** Builds an instance's adapter; the driver passes the instance's live state. */
export const createZCodeAdapterV2 = Effect.fn("ZCodeAdapterV2Driver.create")(
  function* (
    input: ProviderAdapterDriverCreateInput<ZCodeSettings> & {
      readonly liveState?: ZCodeLiveState;
    },
  ) {
    const hostEnvironment = yield* HostProcessEnvironment;
    const selfInvocation = yield* resolveSelfInvocation();
    const providerEventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
    const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
    const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
    return yield* makeZCodeAdapterV2({
      instanceId: input.instanceId,
      settings: { ...input.config, enabled: input.enabled },
      environment: mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
      selfInvocation,
      continuationRequests,
      ...(input.liveState === undefined ? {} : { liveState: input.liveState }),
      nativeLogging: (threadId) =>
        makeNativeLogger({
          nativeEventLogger: providerEventLoggers.native,
          provider: ZCODE_PROVIDER,
          threadId,
        }),
    });
  },
  (effect, input) =>
    effect.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterDriverCreateError({
            driver: ZCODE_PROVIDER,
            instanceId: input.instanceId,
            detail: "Failed to create ZCode ACP adapter.",
            cause,
          }),
      ),
    ),
);

export const ZCodeAdapterV2Driver: ProviderAdapterDriver<ZCodeSettings, ZCodeAdapterV2DriverEnv> = {
  driverKind: ZCODE_PROVIDER,
  configSchema: ZCodeSettings,
  defaultConfig: (): ZCodeSettings => DEFAULT_ZCODE_SETTINGS,
  create: (input) => createZCodeAdapterV2(input),
};
