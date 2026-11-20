import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation, type SelfInvocation } from "@t3tools/shared/nodeRuntime";
import {
  type OrchestrationV2ProviderCapabilities,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { SparrowSettings } from "../settings.ts";
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
import {
  applySparrowModelSelection,
  makeSparrowAcpRuntime,
  SPARROW_CLIENT_CAPABILITIES_META,
  SPARROW_DRIVER_KIND,
  SPARROW_EXTENSION_METHOD,
  SPARROW_PERMISSION_MODE_CONFIG_ID,
  sparrowApprovalOptions,
  sparrowPermissionDisposition,
  sparrowPermissionModeForPolicy,
  SPARROW_THOUGHT_LEVEL_CONFIG_ID,
} from "./acpSupport.ts";

export { SPARROW_DRIVER_KIND } from "./acpSupport.ts";

const DEFAULT_SPARROW_SETTINGS = Schema.decodeSync(SparrowSettings)({});

const SparrowProviderCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  sessions: {
    ...AcpProviderCapabilitiesV2.sessions,
    supportsModelSwitchInSession: true,
  },
  threads: {
    ...AcpProviderCapabilitiesV2.threads,
    canReadThreadSnapshot: true,
  },
  tools: {
    ...AcpProviderCapabilitiesV2.tools,
    supportsMcpTools: true,
  },
  checkpointing: {
    ...AcpProviderCapabilitiesV2.checkpointing,
    providerCanReadConversationSnapshot: true,
  },
} satisfies OrchestrationV2ProviderCapabilities;

const sparrowCompactSession: NonNullable<AcpAdapterV2Flavor["compactSession"]> = {
  supported: (initializeResult) => {
    const meta = initializeResult.agentCapabilities?._meta;
    return typeof meta === "object" && meta !== null && "sparrow/session" in meta;
  },
  compact: (runtime, sessionId) =>
    runtime
      .request(SPARROW_EXTENSION_METHOD, {
        sessionId,
        action: { type: "compact" },
      })
      .pipe(Effect.asVoid),
};

export interface SparrowAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly settings: SparrowSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly selfInvocation: SelfInvocation;
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
  readonly testHooks?: Parameters<typeof makeAcpAdapterV2>[0]["testHooks"];
  readonly makeRuntime?: (
    input: AcpAdapterV2RuntimeInput,
  ) => Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError,
    ChildProcessSpawner.ChildProcessSpawner | SecureRandom.SecureRandom | Scope.Scope
  >;
  readonly assertComplete?: AcpAdapterV2Flavor["assertComplete"];
}

function makeSparrowAcpAdapterFlavor(options: SparrowAdapterV2Options): AcpAdapterV2Flavor {
  const makeRuntime =
    options.makeRuntime ??
    (({ runtimePolicy: _runtimePolicy, processEnvironment, ...input }: AcpAdapterV2RuntimeInput) =>
      makeSparrowAcpRuntime({
        ...input,
        settings: options.settings,
        environment: { ...options.environment, ...processEnvironment },
      }));

  return {
    driver: SPARROW_DRIVER_KIND,
    runtimeHarness: "sparrow",
    capabilities: SparrowProviderCapabilitiesV2,
    clientCapabilitiesMeta: SPARROW_CLIENT_CAPABILITIES_META,
    mcpOverHttp: true,
    makeRuntime,
    applyModelSelection: applySparrowModelSelection,
    ownedModelOptionIds: [SPARROW_THOUGHT_LEVEL_CONFIG_ID, SPARROW_PERMISSION_MODE_CONFIG_ID],
    sessionConfigForPolicy: (policy) => [
      {
        id: SPARROW_PERMISSION_MODE_CONFIG_ID,
        value: sparrowPermissionModeForPolicy(policy),
      },
    ],
    permissionDisposition: sparrowPermissionDisposition,
    approvalOptions: sparrowApprovalOptions,
    compactSession: sparrowCompactSession,
    ...(options.assertComplete === undefined ? {} : { assertComplete: options.assertComplete }),
  };
}

export const makeSparrowAdapterV2 = Effect.fn("makeSparrowAdapterV2")(function* (
  options: SparrowAdapterV2Options,
) {
  return yield* makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: makeSparrowAcpAdapterFlavor(options),
    selfInvocation: options.selfInvocation,
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
    ...(options.testHooks === undefined ? {} : { testHooks: options.testHooks }),
  });
});

export type SparrowAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | SecureRandom.SecureRandom
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | Path.Path
  | McpProviderSessions.McpProviderSessions
  | ProviderEventLoggers.ProviderEventLoggers
  | ProviderHost.ProviderHost;

export const makeSparrowAdapterV2Driver = (): ProviderAdapterDriver<
  SparrowSettings,
  SparrowAdapterV2DriverEnv
> => ({
  driverKind: SPARROW_DRIVER_KIND,
  configSchema: SparrowSettings,
  defaultConfig: (): SparrowSettings => DEFAULT_SPARROW_SETTINGS,
  create: Effect.fn("SparrowAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<SparrowSettings>) {
      const hostEnvironment = yield* HostProcess.Environment;
      const selfInvocation = yield* resolveSelfInvocation();
      const providerEventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
      return yield* makeSparrowAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: yield* mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        selfInvocation,
        nativeLogging: (threadId) =>
          makeNativeLogger({
            nativeEventLogger: providerEventLoggers.native,
            provider: SPARROW_DRIVER_KIND,
            threadId,
          }),
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: SPARROW_DRIVER_KIND,
              instanceId: input.instanceId,
              detail: "Failed to create the Sparrow ACP adapter.",
              cause,
            }),
        ),
      ),
  ),
});
