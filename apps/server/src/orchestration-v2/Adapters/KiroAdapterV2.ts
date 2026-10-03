import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { resolveSelfInvocation, type SelfInvocation } from "@t3tools/shared/nodeRuntime";
import {
  KiroSettings,
  ProviderDriverKind,
  type OrchestrationV2ProviderCapabilities,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as EffectAcpErrors from "effect-acp/errors";

import * as ServerConfig from "../../config.ts";
import { makeAcpNativeLoggerFactory } from "../../provider/acp/AcpNativeLogging.ts";
import type * as AcpSessionRuntime from "../../provider/acp/AcpSessionRuntime.ts";
import {
  KIRO_AUTOPILOT_CONFIG_ID,
  KIRO_MODEL_CONFIG_ID,
  kiroApprovalOptions,
  kiroAutopilotValue,
  kiroPermissionDisposition,
  makeKiroAcpRuntime,
} from "../../provider/acp/KiroAcpSupport.ts";
import * as ProviderEventLoggers from "../../provider/Layers/ProviderEventLoggers.ts";
import { mergeProviderInstanceEnvironment } from "../../provider/ProviderInstanceEnvironment.ts";
import * as IdAllocator from "../IdAllocator.ts";
import { makeProviderFailure } from "../ProviderFailure.ts";
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

export const KIRO_PROVIDER = ProviderDriverKind.make("kiro");
const DEFAULT_KIRO_SETTINGS = Schema.decodeSync(KiroSettings)({});

const KiroProviderCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  sessions: {
    ...AcpProviderCapabilitiesV2.sessions,
    supportsModelSwitchInSession: true,
  },
  tools: {
    ...AcpProviderCapabilitiesV2.tools,
    supportsMcpTools: true,
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface KiroAdapterV2Options {
  readonly instanceId: Parameters<typeof makeAcpAdapterV2>[0]["instanceId"];
  readonly settings: KiroSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly crypto: Crypto.Crypto;
  readonly selfInvocation: SelfInvocation;
  readonly fileSystem: FileSystem.FileSystem;
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly serverConfig: ServerConfig.ServerConfig["Service"];
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
  /** Replaces the `kiro-cli` launch (replay tests). Kiro's session setup still applies. */
  readonly makeRuntime?: (
    input: AcpAdapterV2RuntimeInput,
  ) => Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError,
    Crypto.Crypto | Scope.Scope
  >;
  readonly assertComplete?: Effect.Effect<void, EffectAcpErrors.AcpError>;
}

/**
 * Kiro V3 selects models through its `model` session config option, and
 * `session/set_model` does not exist. "default" keeps the session's model.
 *
 * Kiro 2.27 leaves `model` out of the `session/new` result and advertises it
 * in a `config_option_update` a few milliseconds later, so a fresh session can
 * be configured before T3 has seen it; the write still goes to `model` then.
 * Kiro accepts any value at set time but fails the next `session/prompt` on
 * one its account cannot use (-32000 "The model '…' is not available",
 * `InvalidModelError`), so an unknown id never runs silently on another model.
 * Once the option is known, T3 refuses an unlisted model before prompting.
 */
const applyKiroModelSelection: NonNullable<AcpAdapterV2Flavor["applyModelSelection"]> = ({
  runtime,
  modelSelection,
}) =>
  Effect.gen(function* () {
    const modelOption = (yield* runtime.getConfigOptions).find(
      (option) => option.id === KIRO_MODEL_CONFIG_ID || option.category === "model",
    );
    const current = modelOption?.type === "select" ? modelOption.currentValue : undefined;
    const requested = modelSelection.model.trim();
    if (requested.length === 0 || requested === "default" || requested === current) {
      return current;
    }
    if (modelOption?.type === "select") {
      const offered = modelOption.options.flatMap((entry) =>
        "value" in entry ? [entry.value] : entry.options.map((choice) => choice.value),
      );
      if (!offered.includes(requested)) {
        return yield* EffectAcpErrors.AcpRequestError.invalidParams(
          `Kiro model '${requested}' is unavailable for this account. Select an available model.`,
        );
      }
    }
    yield* runtime.setConfigOption(modelOption?.id ?? KIRO_MODEL_CONFIG_ID, requested);
    return requested;
  });

const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

/**
 * Kiro's prompt errors carry a message meant for the user (live 2.27: -32000
 * "The model 'x' is not available. Please select a different model and try
 * again. (Request ID: …)"). Show it instead of the generic failure text;
 * makeProviderFailure bounds and redacts it.
 */
function kiroPromptFailure(cause: unknown) {
  return makeProviderFailure({
    cause,
    ...(isAcpRequestError(cause) ? { message: cause.errorMessage, code: String(cause.code) } : {}),
    class: "provider_error",
  });
}

function makeKiroAcpAdapterFlavor(options: KiroAdapterV2Options): AcpAdapterV2Flavor {
  const makeRuntime =
    options.makeRuntime ??
    ((input: AcpAdapterV2RuntimeInput) => {
      const { runtimePolicy: _runtimePolicy, processEnvironment, ...runtimeInput } = input;
      return makeKiroAcpRuntime({
        ...runtimeInput,
        childProcessSpawner: options.childProcessSpawner,
        settings: options.settings,
        environment: { ...options.environment, ...processEnvironment },
      });
    });
  return {
    driver: KIRO_PROVIDER,
    runtimeHarness: "Kiro",
    capabilities: KiroProviderCapabilitiesV2,
    makeRuntime,
    promptFailure: kiroPromptFailure,
    // See applyKiroModelSelection: `model` arrives after session/new.
    modelOptionArrivesLate: true,
    applyModelSelection: applyKiroModelSelection,
    // Kiro's own review step: with Autopilot off (Supervised) Kiro asks the
    // user to accept a turn's changes before it ends; on (Full access) it does
    // not. Its per-tool prompts come either way and T3's runtime policy
    // answers them. A runtime-mode change reopens the session, which applies
    // the option again.
    sessionConfigForPolicy: (policy) => [
      { id: KIRO_AUTOPILOT_CONFIG_ID, value: kiroAutopilotValue(policy) },
    ],
    permissionDisposition: kiroPermissionDisposition,
    approvalOptions: kiroApprovalOptions,
    // Kiro V3 advertises `promptCapabilities.image`; the shared adapter reads it.
    ...(options.assertComplete === undefined ? {} : { assertComplete: options.assertComplete }),
  };
}

export function makeKiroAdapterV2(options: KiroAdapterV2Options) {
  return makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: makeKiroAcpAdapterFlavor(options),
    crypto: options.crypto,
    fileSystem: options.fileSystem,
    idAllocator: options.idAllocator,
    serverConfig: options.serverConfig,
    selfInvocation: options.selfInvocation,
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
  });
}

export type KiroAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers
  | ServerConfig.ServerConfig;

export const KiroAdapterV2Driver: ProviderAdapterDriver<KiroSettings, KiroAdapterV2DriverEnv> = {
  driverKind: KIRO_PROVIDER,
  configSchema: KiroSettings,
  defaultConfig: (): KiroSettings => DEFAULT_KIRO_SETTINGS,
  create: Effect.fn("KiroAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<KiroSettings>) {
      const hostEnvironment = yield* HostProcessEnvironment;
      const providerEventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
      return makeKiroAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
        crypto: yield* Crypto.Crypto,
        fileSystem: yield* FileSystem.FileSystem,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        serverConfig: yield* ServerConfig.ServerConfig,
        selfInvocation: yield* resolveSelfInvocation(),
        nativeLogging: (threadId) =>
          makeNativeLogger({
            nativeEventLogger: providerEventLoggers.native,
            provider: KIRO_PROVIDER,
            threadId,
          }),
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: KIRO_PROVIDER,
              instanceId: input.instanceId,
              detail: "Failed to create Kiro ACP adapter.",
              cause,
            }),
        ),
      ),
  ),
};
