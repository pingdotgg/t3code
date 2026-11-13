// @effect-diagnostics nodeBuiltinImport:off -- fixtures and tests use Node builtins
import {
  extractCopilotSubagentUpdate,
  makeCopilotSubagentRouting,
  normalizeDevinSessionUpdate,
  normalizeDevinToolCall,
  extractDevinSubagentUpdate,
  makeAcpRegistryAdapterV2,
} from "@t3tools/provider-acp-registry/testing";
import { AcpRegistrySettings } from "@t3tools/provider-acp-registry/settings";
import { AcpRegistryCatalog } from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import { decodeAcpReplayTranscript, makeAcpReplayRuntime } from "./AcpAdapterV2.testkit.ts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DocumentText from "../../provider/DocumentText.ts";
import { assert, describe, it } from "@effect/vitest";
import {
  CheckpointId,
  EnvironmentId,
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
  type ProviderOptionDescriptor,
  type ProviderUserInputAnswers,
} from "@t3tools/contracts";
import { GrokSettings } from "@t3tools/provider-grok/settings";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { deriveBlockedOnThreadWait } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpProtocol from "effect-acp/protocol";
import type * as EffectAcpSchema from "effect-acp/compat";
import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import {
  ACP_EMPTY_OPTION_VALUE,
  ACP_SESSION_MODE_OPTION_ID,
  acpProviderOptionDescriptors,
} from "@t3tools/provider-acp/server/sessionConfig";
import {
  extractXAiAcpSubagentUpdate,
  makeGrokAdapterV2,
  makeXAiPromptCompletionRuntime,
  normalizeXAiAcpToolCallState,
  registerXAiBackgroundTaskTracking,
} from "@t3tools/provider-grok/testing";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { makeTurnInput } from "./AcpAdapterV2.testkit.ts";
import type * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import {
  AcpProviderCapabilitiesV2,
  acpPerTurnPromptUsage,
  acpScopedNativeId,
  acpPostSettleContinuationOfferEvidence,
  acpPostSettleWakeEvidence,
  acpToolCallDiffPatch,
  acpToolCallSnippetEdit,
  makeAcpAdapterV2,
  type AcpAdapterV2ExtensionContext,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
  type AcpAdapterV2SubagentUpdate,
} from "@t3tools/provider-acp/server/adapter";
import { appendUserInputAttachmentPaths } from "../../provider/userInputAttachments.ts";
import { makeGrokAcpAdapterFlavor } from "@t3tools/provider-grok/testing";
import {
  acpRegistryPromptFailure,
  registerMistralVibeAcpExtensions,
} from "@t3tools/provider-acp-registry/testing";

export const DEFAULT_GROK_SETTINGS = Schema.decodeSync(GrokSettings)({});

export const DROID_SETTINGS = Schema.decodeSync(AcpRegistrySettings)({ agentId: "factory-droid" });

export const layerHost = TestProviderHost.layer().pipe(
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

export const layerTest = Layer.mergeAll(
  DocumentText.layer.pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  NodeServices.layer,
  NodeCrypto.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  layerHost,
);

export const ACP_TEST_DRIVER = ProviderDriverKind.make("acp-test");

export const decodeUnknownJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

export function makeMockRuntime(input: {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly mockAgentPath: string;
  readonly environment?:
    | Readonly<Record<string, string>>
    | ((runtimeOrdinal: number) => Readonly<Record<string, string>>);
  readonly protocolEvents?: Queue.Queue<EffectAcpProtocol.AcpProtocolLogEvent>;
  readonly cancelBehavior?: AcpSessionRuntime.AcpSessionRuntimeOptions["cancelBehavior"];
  readonly ownDescendantProcessGroups?: boolean;
  readonly ownDetachedProcessGroup?: boolean;
  readonly processGroupPlatform?: NodeJS.Platform;
  readonly processGroupTerminationGrace?: Duration.Input;
  readonly linuxCgroupController?: AcpSessionRuntime.AcpSessionRuntimeOptions["linuxCgroupController"];
  readonly posixProcessTreeController?: AcpSessionRuntime.AcpSessionRuntimeOptions["posixProcessTreeController"];
  readonly windowsProcessTreeTerminator?: AcpSessionRuntime.AcpSessionRuntimeOptions["windowsProcessTreeTerminator"];
  readonly wrapCancel?: (
    cancel: AcpSessionRuntime.AcpSessionRuntime["Service"]["cancel"],
  ) => AcpSessionRuntime.AcpSessionRuntime["Service"]["cancel"];
  readonly wrapOutgoingResponse?: (
    onOutgoingResponse: NonNullable<AcpAdapterV2RuntimeInput["onOutgoingResponse"]>,
  ) => NonNullable<AcpAdapterV2RuntimeInput["onOutgoingResponse"]>;
  readonly wrapRuntime?: (
    runtime: AcpSessionRuntime.AcpSessionRuntime["Service"],
    runtimeOrdinal: number,
  ) => AcpSessionRuntime.AcpSessionRuntime["Service"];
}): AcpAdapterV2Flavor["makeRuntime"] {
  let runtimeOrdinal = 0;
  return (runtimeInput) =>
    Effect.gen(function* () {
      runtimeOrdinal += 1;
      const protocolEvents = input.protocolEvents;
      const protocolLogging =
        protocolEvents === undefined
          ? runtimeInput.protocolLogging
          : {
              ...runtimeInput.protocolLogging,
              logIncoming: true,
              logOutgoing: true,
              logger: (event: EffectAcpProtocol.AcpProtocolLogEvent) =>
                Queue.offer(protocolEvents, event).pipe(
                  Effect.andThen(runtimeInput.protocolLogging.logger?.(event) ?? Effect.void),
                  Effect.asVoid,
                ),
            };
      const context = yield* Layer.build(
        AcpSessionRuntime.layer({
          ...runtimeInput,
          ...(input.cancelBehavior === undefined ? {} : { cancelBehavior: input.cancelBehavior }),
          ...(input.ownDetachedProcessGroup === undefined
            ? {}
            : { ownDetachedProcessGroup: input.ownDetachedProcessGroup }),
          ...(input.ownDescendantProcessGroups === undefined
            ? {}
            : { ownDescendantProcessGroups: input.ownDescendantProcessGroups }),
          ...(input.ownDetachedProcessGroup === true
            ? { processGroupPlatform: input.processGroupPlatform ?? "linux" }
            : {}),
          ...(input.processGroupTerminationGrace === undefined
            ? {}
            : { processGroupTerminationGrace: input.processGroupTerminationGrace }),
          ...(input.linuxCgroupController === undefined
            ? {}
            : { linuxCgroupController: input.linuxCgroupController }),
          ...(input.posixProcessTreeController === undefined
            ? {}
            : { posixProcessTreeController: input.posixProcessTreeController }),
          ...(input.windowsProcessTreeTerminator === undefined
            ? {}
            : { windowsProcessTreeTerminator: input.windowsProcessTreeTerminator }),
          protocolLogging,
          spawn: {
            command: process.execPath,
            args: [input.mockAgentPath],
            cwd: runtimeInput.cwd,
            env: {
              T3_ACP_SESSION_LIFECYCLE: "1",
              ...(typeof input.environment === "function"
                ? input.environment(runtimeOrdinal)
                : input.environment),
            },
          },
          authMethodId: "test",
          ...(input.wrapOutgoingResponse === undefined ||
          runtimeInput.onOutgoingResponse === undefined
            ? {}
            : {
                onOutgoingResponse: input.wrapOutgoingResponse(runtimeInput.onOutgoingResponse),
              }),
        }).pipe(
          Layer.provide(
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
          ),
        ),
      );
      const runtime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
        Effect.provide(context),
      );
      const wrapped = {
        ...runtime,
        ...(input.wrapCancel === undefined ? {} : { cancel: input.wrapCancel(runtime.cancel) }),
      };
      return input.wrapRuntime?.(wrapped, runtimeOrdinal) ?? wrapped;
    });
}

export function rawProtocolMethod(event: EffectAcpProtocol.AcpProtocolLogEvent): string | undefined {
  if (event.stage !== "raw" || typeof event.payload !== "string") return undefined;
  for (const line of event.payload.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const decoded = Option.getOrUndefined(decodeUnknownJson(trimmed));
    if (typeof decoded === "object" && decoded !== null && "method" in decoded) {
      const method = (decoded as { readonly method?: unknown }).method;
      if (typeof method === "string") return method;
    }
  }
  return undefined;
}

export function rawProtocolRequest(
  event: EffectAcpProtocol.AcpProtocolLogEvent,
): { readonly method?: unknown; readonly params?: unknown } | undefined {
  if (event.stage !== "raw" || typeof event.payload !== "string") return undefined;
  for (const line of event.payload.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const decoded = Option.getOrUndefined(decodeUnknownJson(trimmed));
    if (typeof decoded === "object" && decoded !== null && "method" in decoded) {
      return decoded;
    }
  }
  return undefined;
}

export function rawProtocolRequestParam(
  event: EffectAcpProtocol.AcpProtocolLogEvent,
  key: string,
): unknown {
  const params = rawProtocolRequest(event)?.params;
  return typeof params === "object" && params !== null ? Reflect.get(params, key) : undefined;
}

export function rawProtocolPromptTextBlocks(
  event: EffectAcpProtocol.AcpProtocolLogEvent,
): Array<{ type: "text"; text: string }> {
  const prompt = rawProtocolRequestParam(event, "prompt");
  if (!Array.isArray(prompt)) return [];
  return prompt.flatMap((block) =>
    typeof block === "object" &&
    block !== null &&
    Reflect.get(block, "type") === "text" &&
    typeof Reflect.get(block, "text") === "string"
      ? [{ type: "text" as const, text: Reflect.get(block, "text") as string }]
      : [],
  );
}

export const pollProtocolMethods = (events: Queue.Queue<EffectAcpProtocol.AcpProtocolLogEvent>) =>
  Effect.gen(function* () {
    const methods: string[] = [];
    let polled = 0;
    let event = yield* Queue.poll(events);
    while (Option.isSome(event) && polled < 256) {
      polled += 1;
      const method = rawProtocolMethod(event.value);
      if (method !== undefined) methods.push(method);
      event = yield* Queue.poll(events);
    }
    return methods;
  });

export const makeInstructionCompactionHarness = Effect.fnUntraced(function* (
  environment: Readonly<Record<string, string>>,
) {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const path = yield* Path.Path;
  const selfInvocation = yield* resolveSelfInvocation();
  const mockAgentPath = yield* path.fromFileUrl(
    new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
  );
  const protocolEvents = yield* Queue.unbounded<EffectAcpProtocol.AcpProtocolLogEvent>();
  const instanceId = ProviderInstanceId.make("acp-test-instruction-compaction");
  const threadId = ThreadId.make("thread-acp-instruction-compaction");
  yield* (yield* McpProviderSessions.McpProviderSessions).set({
    environmentId: EnvironmentId.make("environment-acp-instruction-compaction"),
    threadId,
    providerSessionId: "mcp-session-acp-instruction-compaction",
    providerInstanceId: instanceId,
    endpoint: "http://127.0.0.1:43123/mcp",
    authorizationHeader: "Bearer instruction-compaction-token",
    browserToolsAvailable: true,
  });
  const adapter = yield* makeAcpAdapterV2({
    instanceId,
    flavor: {
      driver: ACP_TEST_DRIVER,
      capabilities: AcpProviderCapabilitiesV2,
      supportsCompaction: true,
      makeRuntime: makeMockRuntime({
        childProcessSpawner,
        mockAgentPath,
        protocolEvents,
        environment,
        wrapRuntime: (runtime) => ({
          ...runtime,
          // Make compaction during prompt completion deterministic at the adapter boundary.
          prompt: (payload, options) =>
            runtime.prompt(payload, options).pipe(Effect.tap(() => runtime.drainEvents)),
        }),
      }),
    },
    selfInvocation,
  });
  const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: "full-access",
    interactionMode: "default",
    cwd: process.cwd(),
  });
  const modelSelection = { instanceId, model: "default" } as const;
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("provider-session-acp-instruction-compaction"),
    modelSelection,
    runtimePolicy,
  });
  const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
  const now = yield* DateTime.now;
  let ordinal = 0;
  return Effect.fnUntraced(function* (messageText: string, expectedStatus = "completed") {
    yield* runtime.startTurn(
      makeTurnInput({
        threadId,
        providerThread,
        instanceId,
        runtimePolicy,
        now,
        ordinal: ++ordinal,
        messageText,
      }),
    );
    const terminal = yield* runtime.events.pipe(
      Stream.filter((event) => event.type === "turn.terminal"),
      Stream.runHead,
    );
    assert.equal(Option.getOrThrow(terminal).status, expectedStatus);
    while (true) {
      const event = yield* Queue.take(protocolEvents);
      if (event.direction === "outgoing" && rawProtocolMethod(event) === "session/prompt") {
        return rawProtocolPromptTextBlocks(event);
      }
    }
  });
});

export function assertReinjectedInstructions(
  blocks: Array<{ type: "text"; text: string }>,
  request: string,
) {
  const text = blocks[0]?.text ?? "";
  assert.include(text, "T3 Code interaction mode: Default");
  assert.include(text, "## T3 Code browser");
  assert.include(text, "T3 Code orchestration");
  assert.include(text, `<user_request>\n${request}\n</user_request>`);
}

export const droidChoice = {
  type: "string",
  title: "Format",
  description: "Which reply format?",
  oneOf: [
    { const: "option_0", title: "JSON" },
    { const: "option_1", title: "Plain text" },
    { const: "other", title: "Other answer" },
  ],
};

export const droidSchema = {
  type: "object",
  properties: {
    question_1: droidChoice,
    question_1_other: { type: "string" },
    question_2: { ...droidChoice, title: "Alternative" },
    question_2_other: { type: "string" },
  },
  required: ["question_1", "question_2"],
};

export const droidQuestions = ["question_1", "question_2"].map((id, index) => ({
  id,
  header: index === 0 ? "Format" : "Alternative",
  question: "Which reply format?",
  options: [
    { label: "JSON", description: "JSON", value: "option_0" },
    { label: "Plain text", description: "Plain text", value: "option_1" },
  ],
}));

// regression: #20417 Droid AskUser answers were sent as a cancel

export const sessionId = "session-wake-offer";
