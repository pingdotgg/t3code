import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation, type SelfInvocation } from "@t3tools/shared/nodeRuntime";
import { type OrchestrationV2ProviderCapabilities } from "@t3tools/contracts";
import { FxSettings } from "../settings.ts";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";

import type * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { makeAcpNativeLoggerFactory } from "@t3tools/provider-acp/server/nativeLogging";
import {
  applyFxEffortDefault,
  applyFxModelSelection,
  FX_DRIVER_KIND,
  fxPermissionDisposition,
  fxSessionModeForPolicy,
  makeFxAcpRuntime,
  withFxSessionMode,
} from "./acpSupport.ts";
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
  type AcpAdapterV2SubagentUpdate,
} from "@t3tools/provider-acp/server/adapter";
import type { AcpToolCallState } from "@t3tools/provider-acp/server/runtimeModel";

export { FX_DRIVER_KIND } from "./acpSupport.ts";

const DEFAULT_FX_SETTINGS = Schema.decodeSync(FxSettings)({});

const FxProviderCapabilitiesV2 = {
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
  subagents: {
    ...AcpProviderCapabilitiesV2.subagents,
    supportsSubagents: true,
    emitsSubagentLifecycle: true,
  },
} satisfies OrchestrationV2ProviderCapabilities;

const FxSubagentRequest = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("run"),
    task: Schema.String,
    model: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    action: Schema.Literal("message"),
    agent: Schema.String,
    message: Schema.String,
    model: Schema.optionalKey(Schema.String),
  }),
]);
// fx 0.0.14 wraps the arguments in `request`; later fx sends them flat (vercel-labs/fx@df0878eb).
const decodeFxSubagentInput = Schema.decodeUnknownOption(
  Schema.Union([FxSubagentRequest, Schema.Struct({ request: FxSubagentRequest })]),
);
const decodeFxToolContent = Schema.decodeUnknownOption(
  Schema.Array(Schema.Struct({ content: Schema.Struct({ text: Schema.String }) })),
);
const decodeFxSubagentResult = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ ok: Schema.Boolean, result: Schema.NullOr(Schema.String) }),
  ),
);
const decodeJsonString = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.String));

/**
 * fx clips every tool result to 199 bytes, so a long sub-agent reply arrives
 * as cut-off `{"ok":…,"result":"…` JSON. Keeps the readable prefix and marks the cut.
 */
function fxSubagentOutcome(
  text: string,
): { readonly ok: boolean; readonly result: string | null } | undefined {
  const whole = decodeFxSubagentResult(text);
  if (Option.isSome(whole)) return whole.value;
  const clipped = /^\{"ok":(true|false),"result":"((?:[^"\\]|\\.)*)/.exec(text);
  if (clipped === null) return undefined;
  const prefix = decodeJsonString(`"${(clipped[2] ?? "").replace(/\\u[0-9a-fA-F]{0,3}$/, "")}"`);
  const cut = text[clipped[0].length] !== '"';
  return {
    ok: clipped[1] === "true",
    result: Option.isSome(prefix) ? `${prefix.value}${cut ? "…" : ""}` : null,
  };
}

/** fx streams no child frames over ACP, so each `subagent` call becomes a child thread holding its task and reply. */
function extractFxSubagentUpdate(tool: AcpToolCallState): AcpAdapterV2SubagentUpdate | undefined {
  if (tool.data.name !== "subagent") return undefined;
  const input = decodeFxSubagentInput(tool.data.rawInput);
  if (Option.isNone(input)) return undefined;
  const request = "request" in input.value ? input.value.request : input.value;
  const text = Option.getOrUndefined(decodeFxToolContent(tool.data.content))?.[0]?.content.text;
  const outcome = text === undefined ? undefined : fxSubagentOutcome(text);
  const status =
    tool.status === "completed"
      ? outcome?.ok === false
        ? "failed"
        : "completed"
      : tool.status === "failed"
        ? "failed"
        : "running";
  return {
    nativeTaskId: tool.toolCallId,
    childSessionId: null,
    prompt: request.action === "run" ? request.task : request.message,
    title: request.action === "message" ? request.agent : null,
    model: request.model ?? null,
    status,
    result: status === "running" ? null : (outcome?.result ?? text ?? null),
  };
}

export interface FxAdapterV2Options {
  readonly instanceId: Parameters<typeof makeAcpAdapterV2>[0]["instanceId"];
  readonly settings: FxSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly selfInvocation: SelfInvocation;
  /** fx's id for "Default", the model the provider snapshot read from `fx status`. */
  readonly defaultModel?: Effect.Effect<string | undefined>;
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
  readonly testHooks?: Parameters<typeof makeAcpAdapterV2>[0]["testHooks"];
  /** Replaces the `fx acp` launch (replay tests). fx's session setup still applies. */
  readonly makeRuntime?: (
    input: AcpAdapterV2RuntimeInput,
  ) => Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError,
    ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope
  >;
  readonly assertComplete?: Effect.Effect<void, EffectAcpErrors.AcpError>;
}

function makeFxAcpAdapterFlavor(options: FxAdapterV2Options): AcpAdapterV2Flavor {
  const makeRuntime =
    options.makeRuntime ??
    (({ runtimePolicy: _runtimePolicy, processEnvironment, ...input }: AcpAdapterV2RuntimeInput) =>
      makeFxAcpRuntime({
        ...input,
        fxSettings: options.settings,
        environment: { ...options.environment, ...processEnvironment },
      }));
  return {
    driver: FX_DRIVER_KIND,
    runtimeHarness: "fx",
    capabilities: FxProviderCapabilitiesV2,
    makeRuntime: (input) => makeRuntime(input).pipe(Effect.map(withFxSessionMode)),
    applyModelSelection: ({ runtime, modelSelection }) =>
      applyFxModelSelection(runtime, modelSelection, options.defaultModel).pipe(
        Effect.tap(() => applyFxEffortDefault(runtime, modelSelection)),
      ),
    sessionModeForPolicy: fxSessionModeForPolicy,
    permissionDisposition: fxPermissionDisposition,
    extractSubagentUpdate: extractFxSubagentUpdate,
    ...(options.assertComplete === undefined ? {} : { assertComplete: options.assertComplete }),
  };
}

export const makeFxAdapterV2 = Effect.fn("makeFxAdapterV2")(function* (
  options: FxAdapterV2Options,
) {
  return yield* makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: makeFxAcpAdapterFlavor(options),
    selfInvocation: options.selfInvocation,
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
    ...(options.testHooks === undefined ? {} : { testHooks: options.testHooks }),
  });
});

export type FxAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | Path.Path
  | McpProviderSessions.McpProviderSessions
  | ProviderEventLoggers.ProviderEventLoggers
  | ProviderHost.ProviderHost;

/** `defaultModel` reads fx's id for "Default" from the provider snapshot. */
export const makeFxAdapterV2Driver = (
  defaultModel: Effect.Effect<string | undefined>,
): ProviderAdapterDriver<FxSettings, FxAdapterV2DriverEnv> => ({
  driverKind: FX_DRIVER_KIND,
  configSchema: FxSettings,
  defaultConfig: (): FxSettings => DEFAULT_FX_SETTINGS,
  create: Effect.fn("FxAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<FxSettings>) {
      const hostEnvironment = yield* HostProcess.Environment;
      const selfInvocation = yield* resolveSelfInvocation();
      const providerEventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
      return yield* makeFxAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: yield* mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        selfInvocation,
        defaultModel,
        nativeLogging: (threadId) =>
          makeNativeLogger({
            nativeEventLogger: providerEventLoggers.native,
            provider: FX_DRIVER_KIND,
            threadId,
          }),
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: FX_DRIVER_KIND,
              instanceId: input.instanceId,
              detail: "Failed to create the fx ACP adapter.",
              cause,
            }),
        ),
      ),
  ),
});
