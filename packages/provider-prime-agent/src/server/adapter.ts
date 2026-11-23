import { type OrchestrationV2ProviderCapabilities, ProviderDriverKind } from "@t3tools/contracts";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
} from "@t3tools/provider-acp/server/adapter";
import { makeAcpNativeLoggerFactory } from "@t3tools/provider-acp/server/nativeLogging";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "@t3tools/provider-core/server/adapterDriver";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import type * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import type * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import type * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation, type SelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { PrimeAgentSettings } from "../settings.ts";
import {
  makePrimeAgentAcpRuntime,
  PRIME_AGENT_OWNED_OPTION_IDS,
  primeAgentApprovalOptions,
  primeAgentPermissionDisposition,
  primeAgentRequiresSessionRestart,
} from "./acpSupport.ts";

const PRIME_AGENT_PROVIDER = ProviderDriverKind.make("primeAgent");
const DEFAULT_PRIME_AGENT_SETTINGS = Schema.decodeSync(PrimeAgentSettings)({});
const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

const PrimeAgentProviderCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  sessions: {
    ...AcpProviderCapabilitiesV2.sessions,
    // Startup flags (--provider/--model/--thinking/RLM_MAX_DEPTH) trigger restart_session + --resume.
    supportsModelSwitchInSession: false,
    supportsRuntimeModeSwitchInSession: false,
  },
  threads: {
    ...AcpProviderCapabilitiesV2.threads,
    canForkThread: false,
    canForkFromTurn: false,
  },
  tools: {
    ...AcpProviderCapabilitiesV2.tools,
    supportsMcpTools: true,
  },
  subagents: {
    ...AcpProviderCapabilitiesV2.subagents,
    supportsSubagents: true,
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface PrimeAgentAdapterV2Options {
  readonly instanceId: Parameters<typeof makeAcpAdapterV2>[0]["instanceId"];
  readonly settings: PrimeAgentSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly selfInvocation: SelfInvocation;
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
  readonly makeRuntime?: (
    input: AcpAdapterV2RuntimeInput,
  ) => Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError,
    ChildProcessSpawner.ChildProcessSpawner | SecureRandom.SecureRandom | Scope.Scope
  >;
  readonly assertComplete?: Effect.Effect<void, EffectAcpErrors.AcpError>;
  readonly testHooks?: Parameters<typeof makeAcpAdapterV2>[0]["testHooks"];
}

function primeAgentPromptFailure(cause: unknown) {
  return makeProviderFailure({
    cause,
    ...(isAcpRequestError(cause) ? { message: cause.errorMessage, code: String(cause.code) } : {}),
    class: "provider_error",
  });
}

function makePrimeAgentAcpAdapterFlavor(options: PrimeAgentAdapterV2Options): AcpAdapterV2Flavor {
  const makeRuntime =
    options.makeRuntime ??
    ((input: AcpAdapterV2RuntimeInput) => {
      const { runtimePolicy: _runtimePolicy, processEnvironment, ...runtimeInput } = input;
      return makePrimeAgentAcpRuntime({
        ...runtimeInput,
        settings: options.settings,
        environment: { ...options.environment, ...processEnvironment },
      });
    });

  return {
    driver: PRIME_AGENT_PROVIDER,
    runtimeHarness: "Prime Agent",
    capabilities: PrimeAgentProviderCapabilitiesV2,
    planSelectionTransition: ({ current, target }) =>
      primeAgentRequiresSessionRestart(current, target, options.settings, options.environment)
        ? { type: "restart_session" }
        : { type: "apply_on_next_turn" },
    makeRuntime,
    promptFailure: primeAgentPromptFailure,
    // Startup flags already applied model/thinking/RLM depth; skip ACP setConfigOption for them.
    ownedModelOptionIds: [...PRIME_AGENT_OWNED_OPTION_IDS],
    applyModelSelection: ({ modelSelection }) => Effect.succeed(modelSelection.model),
    permissionDisposition: primeAgentPermissionDisposition,
    approvalOptions: primeAgentApprovalOptions,
    compactViaAdvertisedCommand: true,
    terminateRuntimeProcessGroupOnInterrupt: true,
    resumeMethod: "cli-flag",
    ...(options.assertComplete === undefined ? {} : { assertComplete: options.assertComplete }),
  };
}

export const makePrimeAgentAdapterV2 = Effect.fn("makePrimeAgentAdapterV2")(function* (
  options: PrimeAgentAdapterV2Options,
) {
  return yield* makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: makePrimeAgentAcpAdapterFlavor(options),
    selfInvocation: options.selfInvocation,
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
    ...(options.testHooks === undefined ? {} : { testHooks: options.testHooks }),
  });
});

export type PrimeAgentAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | SecureRandom.SecureRandom
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | Path.Path
  | McpProviderSessions.McpProviderSessions
  | ProviderEventLoggers.ProviderEventLoggers
  | ProviderHost.ProviderHost;

export const makePrimeAgentAdapterV2Driver = (): ProviderAdapterDriver<
  PrimeAgentSettings,
  PrimeAgentAdapterV2DriverEnv
> => ({
  driverKind: PRIME_AGENT_PROVIDER,
  configSchema: PrimeAgentSettings,
  defaultConfig: (): PrimeAgentSettings => DEFAULT_PRIME_AGENT_SETTINGS,
  create: Effect.fn("PrimeAgentAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<PrimeAgentSettings>) {
      const hostEnvironment = yield* HostProcess.Environment;
      const selfInvocation = yield* resolveSelfInvocation();
      const providerEventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
      return yield* makePrimeAgentAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: yield* mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        selfInvocation,
        nativeLogging: (threadId) =>
          makeNativeLogger({
            nativeEventLogger: providerEventLoggers.native,
            provider: PRIME_AGENT_PROVIDER,
            threadId,
          }),
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: PRIME_AGENT_PROVIDER,
              instanceId: input.instanceId,
              detail: "Failed to create Prime Agent ACP adapter.",
              cause,
            }),
        ),
      ),
  ),
});
