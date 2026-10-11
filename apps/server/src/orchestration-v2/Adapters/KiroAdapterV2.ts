import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation, type SelfInvocation } from "@t3tools/shared/nodeRuntime";
import {
  KiroSettings,
  type ModelSelection,
  ProviderDriverKind,
  type OrchestrationV2ProviderCapabilities,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as EffectAcpErrors from "effect-acp/errors";

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
import {
  KIRO_AUTOPILOT_CONFIG_ID,
  KIRO_EFFORT_CONFIG_ID,
  KIRO_MODEL_CONFIG_ID,
  kiroApprovalOptions,
  kiroAutopilotValue,
  kiroPermissionDisposition,
  makeKiroAcpRuntime,
} from "../../provider/acp/KiroAcpSupport.ts";

export const KIRO_PROVIDER = ProviderDriverKind.make("kiro");
/** T3's slug for "Kiro default", and Kiro's documented default model id. */
const KIRO_DEFAULT_MODEL = "default";
const KIRO_FALLBACK_DEFAULT_MODEL = "auto";
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
  readonly selfInvocation: SelfInvocation;
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
  /**
   * Kiro's id for "Kiro default" (the provider snapshot's `--list-models`
   * default). Absent, it is `auto`.
   */
  readonly defaultModel?: Effect.Effect<string>;
  /** Replaces the `kiro-cli` launch (replay tests). Kiro's session setup still applies. */
  readonly makeRuntime?: (
    input: AcpAdapterV2RuntimeInput,
  ) => Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError,
    ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope
  >;
  readonly assertComplete?: Effect.Effect<void, EffectAcpErrors.AcpError>;
  readonly testHooks?: Parameters<typeof makeAcpAdapterV2>[0]["testHooks"];
}

/** Kiro's `model` option once it advertises one. */
const findKiroModelOption = (configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>) =>
  configOptions.find((option) => option.id === KIRO_MODEL_CONFIG_ID || option.category === "model");

/**
 * Kiro V3 selects models through its `model` session config option, and
 * `session/set_model` does not exist. "default" selects Kiro's own default
 * model (`auto` unless the account's model list names another), so choosing
 * it after a named model switches back. No write goes out when the session
 * already runs the model, or for "default" on a new session.
 *
 * Kiro 2.27 leaves `model` out of the `session/new` result and advertises it
 * in a `config_option_update` a few milliseconds later, so a fresh session can
 * be configured before T3 has seen it; the write still goes to `model` then.
 * Kiro accepts any value at set time but fails the next `session/prompt` on
 * one its account cannot use (-32000 "The model '…' is not available",
 * `InvalidModelError`), so an unknown id never runs silently on another model.
 * A model Kiro does not list is still written, so a custom model from the
 * provider settings reaches Kiro, which decides.
 */
const applyKiroModel = (
  runtime: AcpSessionRuntime.AcpSessionRuntime["Service"],
  modelSelection: ModelSelection,
  defaultModel: Effect.Effect<string>,
) =>
  Effect.gen(function* () {
    const modelOption = findKiroModelOption(yield* runtime.getConfigOptions);
    const current = modelOption?.type === "select" ? modelOption.currentValue : undefined;
    const selected = modelSelection.model.trim();
    const isDefault = selected.length === 0 || selected === KIRO_DEFAULT_MODEL;
    // Before Kiro advertises `model` the session is new, so it already runs
    // Kiro's default.
    if (isDefault && modelOption?.type !== "select") {
      return current;
    }
    const requested = isDefault ? yield* defaultModel : selected;
    if (requested === current) {
      return current;
    }
    yield* runtime.setConfigOption(modelOption?.id ?? KIRO_MODEL_CONFIG_ID, requested, {
      allowUnlistedValue: true,
    });
    return requested;
  });

/**
 * Bound on waiting for Kiro to advertise the model T3 just wrote. Kiro 2.27.0
 * sent it 40-90 ms after the write's result.
 */
const KIRO_MODEL_ADVERT_BOUND = "2 seconds";

/**
 * Sets the thread's reasoning effort (the snapshot's `reasoningEffort`
 * select) on Kiro's `effortLevel` option. Kiro advertises that option only
 * while a model with effort runs, starting at that model's default, and
 * ignores a write sent before it does. The `model` write's result can carry
 * it (kiro-cli 2.28 per kirodotdev/KiroCrew#17551), but on 2.27.0 a write
 * sent right after `session/new` usually gets a result without `model` or
 * `effortLevel`, and both follow in a `config_option_update`. So the level is
 * written once Kiro advertises the written model; that advert is the one that
 * says whether the model has effort. A model change starts Kiro at the new
 * model's default, so the level is written again then; the runtime skips a
 * write that matches the current level. A level the model does not offer is
 * not sent: Kiro would accept it and leave the level unchanged. A rejected
 * write, or no advert within the bound, leaves Kiro's level in place rather
 * than failing the turn.
 */
const applyKiroEffort = (
  runtime: AcpSessionRuntime.AcpSessionRuntime["Service"],
  modelSelection: ModelSelection,
  appliedModel: string | undefined,
) =>
  Effect.gen(function* () {
    const requested = getModelSelectionStringOptionValue(modelSelection, "reasoningEffort");
    if (requested === undefined) return;
    const advertised = yield* runtime.configOptionChanges.pipe(
      Stream.filter((configOptions) => {
        const modelOption = findKiroModelOption(configOptions);
        return (
          appliedModel === undefined ||
          (modelOption?.type === "select" && modelOption.currentValue === appliedModel)
        );
      }),
      Stream.runHead,
      Effect.timeoutOption(KIRO_MODEL_ADVERT_BOUND),
      Effect.map(Option.flatten),
    );
    if (Option.isNone(advertised)) {
      return yield* Effect.logWarning("Kiro did not advertise the model's reasoning effort", {
        model: appliedModel,
        value: requested,
      });
    }
    const effortOption = advertised.value.find((option) => option.id === KIRO_EFFORT_CONFIG_ID);
    if (effortOption?.type !== "select" || !selectValues(effortOption).includes(requested)) {
      return;
    }
    yield* runtime.setConfigOption(KIRO_EFFORT_CONFIG_ID, requested).pipe(
      Effect.catchTags({
        AcpRequestError: (error) =>
          Effect.logWarning("Kiro rejected the reasoning effort", {
            value: requested,
            detail: error.message,
          }),
      }),
    );
  });

const applyKiroModelSelection =
  (defaultModel: Effect.Effect<string>): NonNullable<AcpAdapterV2Flavor["applyModelSelection"]> =>
  ({ runtime, modelSelection }) =>
    applyKiroModel(runtime, modelSelection, defaultModel).pipe(
      Effect.tap((appliedModel) => applyKiroEffort(runtime, modelSelection, appliedModel)),
    );

function selectValues(
  option: Extract<EffectAcpSchema.SessionConfigOption, { readonly type: "select" }>,
): ReadonlyArray<string> {
  return option.options.flatMap((entry) =>
    "value" in entry ? [entry.value] : entry.options.map((choice) => choice.value),
  );
}

const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

/**
 * Evidence that Kiro has started the current prompt, after which Stop sends
 * `session/cancel`: its `session_info_update` with `_meta.kiro.kind: "turn_start"`,
 * or output only a running prompt produces (assistant text or thoughts, tool
 * calls, plans). The `user_message_id_assigned` echo and context usage do not
 * count: the echo arrives within milliseconds of `session/prompt`, and the
 * previous prompt's context usage can arrive after the next one went out.
 *
 * Kiro's ACP docs do not promise `turn_start`, so Stop also gives up waiting
 * after KIRO_CANCEL_HOLD_BOUND. Evidence: in the 2.27.0 recordings
 * (`turn_interrupt`, `message_steering`) a cancel sent right after the echo,
 * before `turn_start`, was honored. On 2.27.1 TinBane saw a cancel sent
 * 0-0.5 s after `session/prompt` dropped (the turn ran to completion) and one
 * at 1.5 s or later honored.
 */
function isKiroPromptActivity(update: EffectAcpSchema.SessionUpdate): boolean {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
    case "agent_message":
    case "agent_thought_chunk":
    case "agent_thought":
    case "tool_call":
    case "tool_call_update":
    case "tool_call_content_chunk":
    case "plan_update":
      return true;
    case "session_info_update": {
      const kiro = update._meta?.kiro;
      return (
        typeof kiro === "object" && kiro !== null && "kind" in kiro && kiro.kind === "turn_start"
      );
    }
    default:
      return false;
  }
}

/** Past TinBane's dropped 0-0.5 s window and his honored 1.5 s cancel. */
const KIRO_CANCEL_HOLD_BOUND = "2 seconds";

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
    applyModelSelection: applyKiroModelSelection(
      options.defaultModel ?? Effect.succeed(KIRO_FALLBACK_DEFAULT_MODEL),
    ),
    ownedModelOptionIds: ["reasoningEffort"],
    // Kiro's own review step: with Autopilot off (Supervised) Kiro asks the
    // user to accept a turn's changes before it ends; on (Full access) it does
    // not. Its per-tool prompts come either way and T3's runtime policy
    // answers them. A runtime-mode change reopens the session, which applies
    // the option again.
    sessionConfigForPolicy: (policy) => [
      { id: KIRO_AUTOPILOT_CONFIG_ID, value: kiroAutopilotValue(policy) },
    ],
    // See isKiroPromptActivity: Kiro 2.27.1 can drop a cancel sent just after
    // `session/prompt` and run the turn to completion.
    cancelAfterPromptStarts: { isStart: isKiroPromptActivity, bound: KIRO_CANCEL_HOLD_BOUND },
    permissionDisposition: kiroPermissionDisposition,
    approvalOptions: kiroApprovalOptions,
    // Kiro V3 advertises `promptCapabilities.image`; the shared adapter reads it.
    ...(options.assertComplete === undefined ? {} : { assertComplete: options.assertComplete }),
  };
}

export const makeKiroAdapterV2 = Effect.fn("makeKiroAdapterV2")(function* (
  options: KiroAdapterV2Options,
) {
  return yield* makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: makeKiroAcpAdapterFlavor(options),
    selfInvocation: options.selfInvocation,
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
    ...(options.testHooks === undefined ? {} : { testHooks: options.testHooks }),
  });
});

export type KiroAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | Path.Path
  | McpProviderSessions.McpProviderSessions
  | ProviderEventLoggers.ProviderEventLoggers
  | ProviderHost.ProviderHost;

/**
 * `defaultModel` reads Kiro's id for "Kiro default" from the provider
 * snapshot; without one (the bare V2 adapter registry) it is `auto`.
 */
export const makeKiroAdapterV2Driver = (
  defaultModel?: Effect.Effect<string>,
): ProviderAdapterDriver<KiroSettings, KiroAdapterV2DriverEnv> => ({
  driverKind: KIRO_PROVIDER,
  configSchema: KiroSettings,
  defaultConfig: (): KiroSettings => DEFAULT_KIRO_SETTINGS,
  create: Effect.fn("KiroAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<KiroSettings>) {
      const hostEnvironment = yield* HostProcess.Environment;
      const selfInvocation = yield* resolveSelfInvocation();
      const providerEventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
      return yield* makeKiroAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: yield* mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        selfInvocation,
        ...(defaultModel === undefined ? {} : { defaultModel }),
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
});

export const KiroAdapterV2Driver = makeKiroAdapterV2Driver();
