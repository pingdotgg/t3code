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

const DEFAULT_GROK_SETTINGS = Schema.decodeSync(GrokSettings)({});
const DROID_SETTINGS = Schema.decodeSync(AcpRegistrySettings)({ agentId: "factory-droid" });
const OPENCODE_SETTINGS = Schema.decodeSync(AcpRegistrySettings)({
  source: "local",
  commandPath: "/usr/local/bin/opencode",
  commandArgs: ["acp"],
});

const layerHost = TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer));

const layerTest = Layer.mergeAll(
  DocumentText.layer.pipe(Layer.provide(NodeServices.layer)),
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  layerHost,
);
const ACP_TEST_DRIVER = ProviderDriverKind.make("acp-test");
const decodeUnknownJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

describe("acpPerTurnPromptUsage", () => {
  it("maps a per-turn sample straight onto TurnTokenUsage", () => {
    assert.deepEqual(
      acpPerTurnPromptUsage(
        {
          inputTokens: 2453,
          outputTokens: 4,
          totalTokens: 2457,
          cachedReadTokens: 512,
          cachedWriteTokens: 32,
          thoughtTokens: 3,
        },
        false,
        "completed",
      ),
      {
        usageScope: "main_agent",
        usageStatus: "complete",
        hasSubagents: false,
        inputTokens: 2453,
        outputTokens: 4,
        cachedInputTokens: 512,
        cacheCreationTokens: 32,
        reasoningTokens: 3,
      },
    );
  });

  it("clamps subsets that exceed their parents and drops unset counters", () => {
    assert.deepEqual(
      acpPerTurnPromptUsage(
        {
          inputTokens: 100,
          outputTokens: 10,
          totalTokens: 110,
          cachedReadTokens: 150,
          cachedWriteTokens: 120,
          thoughtTokens: 30,
        },
        false,
        "completed",
      ),
      {
        usageScope: "main_agent",
        usageStatus: "complete",
        hasSubagents: false,
        inputTokens: 100,
        outputTokens: 10,
        cachedInputTokens: 100,
        cacheCreationTokens: 0,
        reasoningTokens: 10,
      },
    );
    assert.deepEqual(
      acpPerTurnPromptUsage(
        { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
        false,
        "completed",
      ),
      {
        usageScope: "main_agent",
        usageStatus: "complete",
        hasSubagents: false,
        inputTokens: 100,
        outputTokens: 10,
      },
    );
  });

  it("caps cache writes at the input left over after cache reads", () => {
    // Each counter fits under input alone, but together they exceed it.
    assert.deepEqual(
      acpPerTurnPromptUsage(
        {
          inputTokens: 100,
          outputTokens: 10,
          totalTokens: 110,
          cachedReadTokens: 80,
          cachedWriteTokens: 80,
        },
        false,
        "completed",
      ),
      {
        usageScope: "main_agent",
        usageStatus: "complete",
        hasSubagents: false,
        inputTokens: 100,
        outputTokens: 10,
        cachedInputTokens: 80,
        cacheCreationTokens: 20,
      },
    );
  });

  it("marks present usage partial on a non-completed terminal and missing usage unavailable", () => {
    assert.deepEqual(
      acpPerTurnPromptUsage(
        { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
        true,
        "interrupted",
      ),
      {
        usageScope: "main_agent",
        usageStatus: "partial",
        hasSubagents: true,
        inputTokens: 100,
        outputTokens: 10,
      },
    );
    assert.deepEqual(acpPerTurnPromptUsage(undefined, false, "completed"), {
      usageScope: "main_agent",
      usageStatus: "unavailable",
      hasSubagents: false,
    });
  });
});

describe("acpToolCallDiffPatch", () => {
  it("builds per-file patches from ACP hunks and recorded old/new text", () => {
    for (const operation of ["add", "delete"]) {
      const text = operation === "add" ? "@@ -0,0 +1 @@\n+content\n" : "@@ -1 +0,0 @@\n-content\n";
      assert.equal(
        acpToolCallDiffPatch([
          {
            type: "diff",
            changes: [{ operation, path: "/repo/a.ts" }],
            patch: { format: "git_patch", text },
          },
        ]),
        [
          'diff --git "a//repo/a.ts" "b//repo/a.ts"',
          operation === "add" ? "--- /dev/null" : '--- "a//repo/a.ts"',
          operation === "delete" ? "+++ /dev/null" : '+++ "b//repo/a.ts"',
          text,
        ].join("\n"),
      );
    }
    assert.equal(
      acpToolCallDiffPatch([
        { type: "diff", path: "/repo/new.txt", oldText: null, newText: "hello\n" },
        { type: "diff", path: "/repo/a.ts", oldText: "a\nb\nc\n", newText: "a\nB\nc\n" },
        { type: "diff", path: "/repo/same.ts", oldText: "x\n", newText: "x\n" },
      ]),
      [
        "--- /dev/null",
        "+++ /repo/new.txt",
        "@@ -0,0 +1,1 @@",
        "+hello",
        "",
        "--- /repo/a.ts",
        "+++ /repo/a.ts",
        "@@ -1,3 +1,3 @@",
        " a",
        "-b",
        "+B",
        " c",
        "",
      ].join("\n"),
    );
  });
});

function makeMockRuntime(input: {
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

function rawProtocolMethod(event: EffectAcpProtocol.AcpProtocolLogEvent): string | undefined {
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

function rawProtocolRequest(
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

function rawProtocolRequestParam(
  event: EffectAcpProtocol.AcpProtocolLogEvent,
  key: string,
): unknown {
  const params = rawProtocolRequest(event)?.params;
  return typeof params === "object" && params !== null ? Reflect.get(params, key) : undefined;
}

function rawProtocolPromptTextBlocks(
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

const pollProtocolMethods = (events: Queue.Queue<EffectAcpProtocol.AcpProtocolLogEvent>) =>
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

const makeInstructionCompactionHarness = Effect.fnUntraced(function* (
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

function assertReinjectedInstructions(
  blocks: Array<{ type: "text"; text: string }>,
  request: string,
) {
  const text = blocks[0]?.text ?? "";
  assert.include(text, "T3 Code interaction mode: Default");
  assert.include(text, "## T3 Code browser");
  assert.include(text, "T3 Code orchestration");
  assert.include(text, `<user_request>\n${request}\n</user_request>`);
}

describe("AcpAdapterV2", () => {
  it.live("reports per-turn usage unavailable on a continuation turn that never prompts", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const instanceId = ProviderInstanceId.make("acp-test-usage-continuation");
      const threadId = ThreadId.make("thread-acp-usage-continuation");
      let promptOrdinal = 0;
      const promptUsages = [
        { inputTokens: 60, outputTokens: 15, totalTokens: 75 },
        { inputTokens: 130, outputTokens: 30, totalTokens: 160 },
      ];
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        continuationRequests: { offer: () => Effect.void },
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          reportsPerTurnPromptUsage: true,
          enablePostSettleContinuation: true,
          makeRuntime: makeMockRuntime({
            childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
            mockAgentPath: yield* path.fromFileUrl(
              new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
            ),
            wrapRuntime: (runtime) => ({
              ...runtime,
              prompt: () => {
                promptOrdinal += 1;
                const usage = promptUsages[promptOrdinal - 1];
                if (usage === undefined) return Effect.die("Unexpected prompt");
                return Effect.succeed({ stopReason: "end_turn" as const, usage });
              },
            }),
          }),
        },
      });
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-usage-continuation"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      const completedUsage = (ordinal: number) =>
        Effect.gen(function* () {
          yield* runtime.startTurn(
            makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now, ordinal }),
          );
          const events = Array.from(
            yield* runtime.events.pipe(
              Stream.takeUntil((event) => event.type === "turn.terminal"),
              Stream.runCollect,
            ),
          );
          const completed = events.find(
            (event) =>
              event.type === "provider_turn.updated" && event.providerTurn.status === "completed",
          );
          return completed?.type === "provider_turn.updated"
            ? completed.providerTurn.turnTokenUsage
            : null;
        });
      assert.deepEqual(yield* completedUsage(1), {
        usageScope: "main_agent",
        usageStatus: "complete",
        hasSubagents: false,
        inputTokens: 60,
        outputTokens: 15,
      });
      // Continuation attach: drains wake traffic and finalizes without ever
      // dispatching session/prompt, so it must report unavailable usage.
      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          now,
          ordinal: 2,
          messageCreatedBy: "agent",
          messageCreationSource: "provider",
          messageText: "Background task completed.",
        }),
      );
      const continuationEvents = Array.from(
        yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        ),
      );
      const continuation = continuationEvents.find(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "completed",
      );
      assert.deepEqual(
        continuation?.type === "provider_turn.updated"
          ? continuation.providerTurn.turnTokenUsage
          : null,
        { usageScope: "main_agent", usageStatus: "unavailable", hasSubagents: false },
      );
      // The continuation must not disturb the next real prompt's sample.
      assert.deepEqual(yield* completedUsage(3), {
        usageScope: "main_agent",
        usageStatus: "complete",
        hasSubagents: false,
        inputTokens: 130,
        outputTokens: 30,
      });
      assert.equal(promptOrdinal, 2, "continuation turn must not dispatch session/prompt");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
  it.live("retains returned usage when Stop finalizes before the prompt callback", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const instanceId = ProviderInstanceId.make("acp-test-prompt-usage-stop");
      const threadId = ThreadId.make("thread-acp-prompt-usage-stop");
      const wireSettled = yield* Deferred.make<void>();
      const releaseCompletion = yield* Deferred.make<void>();
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        testHooks: {
          afterPromptWireSettled: () =>
            Deferred.succeed(wireSettled, undefined).pipe(
              Effect.andThen(Deferred.await(releaseCompletion)),
            ),
        },
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          reportsPerTurnPromptUsage: true,
          preserveRuntimeOnSettledInterrupt: true,
          makeRuntime: makeMockRuntime({
            childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
            mockAgentPath: yield* path.fromFileUrl(
              new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
            ),
            wrapRuntime: (runtime) => ({
              ...runtime,
              prompt: () =>
                Effect.succeed({
                  stopReason: "end_turn" as const,
                  usage: { inputTokens: 60, outputTokens: 15, totalTokens: 75 },
                }),
            }),
          }),
        },
      });
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-prompt-usage-stop"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          now: yield* DateTime.now,
        }),
      );
      yield* Deferred.await(wireSettled);
      const providerTurnId = idAllocator.derive.providerTurn({
        driver: ACP_TEST_DRIVER,
        nativeTurnId: acpScopedNativeId(instanceId, "mock-session-1:turn:1"),
      });
      yield* runtime.interruptTurn({ providerThread, providerTurnId });
      const completed = Array.from(
        yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        ),
      ).find(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "interrupted",
      );
      assert.deepEqual(
        completed?.type === "provider_turn.updated" ? completed.providerTurn.turnTokenUsage : null,
        {
          usageScope: "main_agent",
          usageStatus: "partial",
          hasSubagents: false,
          inputTokens: 60,
          outputTokens: 15,
        },
      );
      yield* Deferred.succeed(releaseCompletion, undefined);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live("drops a late prompt response that lands after the turn finalized", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const instanceId = ProviderInstanceId.make("acp-test-prompt-usage-late");
      const threadId = ThreadId.make("thread-acp-prompt-usage-late");
      const dispatched = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const wireSettled = yield* Deferred.make<void>();
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        testHooks: {
          afterPromptWireSettled: () =>
            Deferred.succeed(wireSettled, undefined).pipe(Effect.asVoid),
        },
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          reportsPerTurnPromptUsage: true,
          terminateRuntimeProcessGroupOnInterrupt: true,
          makeRuntime: makeMockRuntime({
            childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
            mockAgentPath: yield* path.fromFileUrl(
              new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
            ),
            ownDetachedProcessGroup: true,
            processGroupTerminationGrace: 0,
            wrapRuntime: (runtime) => ({
              ...runtime,
              // The response only leaves the agent after the turn has been
              // force stopped and finalized: teardown does not interrupt this fiber.
              prompt: () =>
                Deferred.succeed(dispatched, undefined).pipe(
                  Effect.andThen(Deferred.await(gate)),
                  Effect.andThen(
                    Effect.succeed({
                      stopReason: "cancelled" as const,
                      usage: { inputTokens: 60, outputTokens: 15, totalTokens: 75 },
                    }),
                  ),
                ),
            }),
          }),
        },
      });
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-prompt-usage-late"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      let stopCollector = false;
      const events: Array<Record<string, unknown>> = [];
      const usageRecorded = yield* Deferred.make<void>();
      const collector = yield* Stream.runForEach(
        runtime.events.pipe(Stream.takeUntil(() => stopCollector)),
        (event) =>
          Effect.suspend(() => {
            const record = event as Record<string, unknown>;
            events.push(record);
            return record.type === "provider_turn.updated" &&
              (record.providerTurn as Record<string, unknown>).turnTokenUsage !== undefined
              ? Deferred.succeed(usageRecorded, undefined)
              : Effect.void;
          }),
      ).pipe(Effect.forkScoped);
      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          now: yield* DateTime.now,
          messageText: "Say hi.",
        }),
      );
      yield* Deferred.await(dispatched);
      const providerTurnId = idAllocator.derive.providerTurn({
        driver: ACP_TEST_DRIVER,
        nativeTurnId: acpScopedNativeId(instanceId, "mock-session-1:turn:1"),
      });
      // Force stop finalizes the turn without waiting for the gated prompt response.
      yield* runtime.interruptTurn({
        providerThread,
        providerTurnId,
        requestRuntimeRestart: true,
      });
      yield* Deferred.await(usageRecorded);
      const usageAt = () => {
        const turns = events.filter(
          (event) =>
            event.type === "provider_turn.updated" &&
            (event.providerTurn as Record<string, unknown>).turnTokenUsage !== undefined,
        );
        const last = turns[turns.length - 1] as
          | { providerTurn: Record<string, unknown> }
          | undefined;
        return last?.providerTurn.turnTokenUsage as Record<string, unknown>;
      };
      assert.deepEqual(usageAt(), {
        usageScope: "main_agent",
        usageStatus: "unavailable",
        hasSubagents: false,
      });
      // The response lands now; the finalized turn must not adopt its counters.
      yield* Deferred.succeed(gate, undefined);
      yield* Deferred.await(wireSettled);
      assert.deepEqual(usageAt(), {
        usageScope: "main_agent",
        usageStatus: "unavailable",
        hasSubagents: false,
      });
      stopCollector = true;
      yield* Fiber.interrupt(collector);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live("passes per-turn usage samples through", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const instanceId = ProviderInstanceId.make("acp-test-per-turn-usage");
      const threadId = ThreadId.make("thread-acp-per-turn-usage");
      let promptOrdinal = 0;
      // Fixture shaped after the live glm-acp-agent probe: three sequential
      // prompts whose inputTokens grow by tens, not by a context per turn.
      // GLM never sends cachedWriteTokens; those values are added here to
      // exercise the clamp path.
      const promptUsages = [
        {
          inputTokens: 2432,
          outputTokens: 3,
          totalTokens: 2435,
          cachedReadTokens: 1024,
          cachedWriteTokens: 64,
          thoughtTokens: 2,
        },
        {
          inputTokens: 2453,
          outputTokens: 4,
          totalTokens: 2457,
          cachedReadTokens: 1045,
          cachedWriteTokens: 85,
          thoughtTokens: 3,
        },
        {
          inputTokens: 2475,
          outputTokens: 25,
          totalTokens: 2500,
          cachedReadTokens: 1067,
          cachedWriteTokens: 107,
          thoughtTokens: 20,
        },
      ];
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          reportsPerTurnPromptUsage: true,
          makeRuntime: makeMockRuntime({
            childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
            mockAgentPath: yield* path.fromFileUrl(
              new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
            ),
            wrapRuntime: (runtime) => ({
              ...runtime,
              prompt: () => {
                const usage = promptUsages[promptOrdinal++];
                if (usage === undefined) return Effect.die("Unexpected prompt");
                return Effect.succeed({ stopReason: "end_turn" as const, usage });
              },
            }),
          }),
        },
      });
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-per-turn-usage"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      for (const [index, sample] of promptUsages.entries()) {
        yield* runtime.startTurn(
          makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            runtimePolicy,
            now,
            ordinal: index + 1,
          }),
        );
        const events = Array.from(
          yield* runtime.events.pipe(
            Stream.takeUntil((event) => event.type === "turn.terminal"),
            Stream.runCollect,
          ),
        );
        const completed = events.find(
          (event) =>
            event.type === "provider_turn.updated" && event.providerTurn.status === "completed",
        );
        // Per-turn: each response's own sample maps straight onto its turn.
        assert.deepEqual(
          completed?.type === "provider_turn.updated"
            ? completed.providerTurn.turnTokenUsage
            : null,
          {
            usageScope: "main_agent",
            usageStatus: "complete",
            hasSubagents: false,
            inputTokens: sample.inputTokens,
            outputTokens: sample.outputTokens,
            cachedInputTokens: sample.cachedReadTokens,
            cacheCreationTokens: sample.cachedWriteTokens,
            reasoningTokens: sample.thoughtTokens,
          },
        );
      }
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live("clamps per-turn subsets that exceed their parent counters", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const instanceId = ProviderInstanceId.make("acp-test-per-turn-clamp");
      const threadId = ThreadId.make("thread-acp-per-turn-clamp");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          reportsPerTurnPromptUsage: true,
          makeRuntime: makeMockRuntime({
            childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
            mockAgentPath: yield* path.fromFileUrl(
              new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
            ),
            wrapRuntime: (runtime) => ({
              ...runtime,
              prompt: () =>
                Effect.succeed({
                  stopReason: "end_turn" as const,
                  usage: {
                    inputTokens: 100,
                    outputTokens: 10,
                    totalTokens: 110,
                    cachedReadTokens: 150,
                    cachedWriteTokens: 120,
                    thoughtTokens: 30,
                  },
                }),
            }),
          }),
        },
      });
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-per-turn-clamp"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          now: yield* DateTime.now,
        }),
      );
      const events = Array.from(
        yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        ),
      );
      const completed = events.find(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "completed",
      );
      // TurnTokenUsage contract: input includes cache read + write and
      // reasoning is a subset of output. Reads clamp to input, writes clamp
      // to what reads leave of it (100 - 100 = 0 here).
      assert.deepEqual(
        completed?.type === "provider_turn.updated" ? completed.providerTurn.turnTokenUsage : null,
        {
          usageScope: "main_agent",
          usageStatus: "complete",
          hasSubagents: false,
          inputTokens: 100,
          outputTokens: 10,
          cachedInputTokens: 100,
          cacheCreationTokens: 0,
          reasoningTokens: 10,
        },
      );
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live("reports per-turn usage unavailable when the agent omits usage", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const instanceId = ProviderInstanceId.make("acp-test-per-turn-missing");
      const threadId = ThreadId.make("thread-acp-per-turn-missing");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          reportsPerTurnPromptUsage: true,
          makeRuntime: makeMockRuntime({
            childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
            mockAgentPath: yield* path.fromFileUrl(
              new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
            ),
            wrapRuntime: (runtime) => ({
              ...runtime,
              prompt: () => Effect.succeed({ stopReason: "end_turn" as const }),
            }),
          }),
        },
      });
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-per-turn-missing"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          now: yield* DateTime.now,
        }),
      );
      const events = Array.from(
        yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        ),
      );
      const completed = events.find(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "completed",
      );
      assert.deepEqual(
        completed?.type === "provider_turn.updated" ? completed.providerTurn.turnTokenUsage : null,
        { usageScope: "main_agent", usageStatus: "unavailable", hasSubagents: false },
      );
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live("keeps usage unavailable for undeclared agents even when they report usage", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const instanceId = ProviderInstanceId.make("acp-test-usage-undeclared");
      const threadId = ThreadId.make("thread-acp-usage-undeclared");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime: makeMockRuntime({
            childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
            mockAgentPath: yield* path.fromFileUrl(
              new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
            ),
            wrapRuntime: (runtime) => ({
              ...runtime,
              prompt: () =>
                Effect.succeed({
                  stopReason: "end_turn" as const,
                  usage: { inputTokens: 60, outputTokens: 15, totalTokens: 75 },
                }),
            }),
          }),
        },
      });
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-usage-undeclared"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      for (const ordinal of [1, 2]) {
        yield* runtime.startTurn(
          makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now, ordinal }),
        );
        const events = Array.from(
          yield* runtime.events.pipe(
            Stream.takeUntil((event) => event.type === "turn.terminal"),
            Stream.runCollect,
          ),
        );
        const completed = events.find(
          (event) =>
            event.type === "provider_turn.updated" && event.providerTurn.status === "completed",
        );
        // Usage semantics are unverified for an undeclared agent, so its
        // counters are never trusted, on any turn.
        assert.deepEqual(
          completed?.type === "provider_turn.updated"
            ? completed.providerTurn.turnTokenUsage
            : null,
          { usageScope: "main_agent", usageStatus: "unavailable", hasSubagents: false },
        );
      }
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live.each(["details", "none"] as const)(
    "fails the turn on an ACP v2 idle error with %s, settles its open tool, and accepts the next prompt",
    (details) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const instanceId = ProviderInstanceId.make(`idle-error-${details}`);
        const threadId = ThreadId.make(`thread-idle-error-${details}`);
        const childSessionId = "mock-child-session-idle-error";
        const adapter = yield* makeAcpAdapterV2({
          instanceId,
          selfInvocation: yield* resolveSelfInvocation(),
          flavor: {
            driver: ACP_TEST_DRIVER,
            capabilities: AcpProviderCapabilitiesV2,
            extractBackgroundTaskId: (toolCall) =>
              toolCall.toolCallId === "tool-call-idle-error-monitor"
                ? "idle-error-monitor"
                : undefined,
            extractSubagentUpdate: (toolCall) =>
              toolCall.toolCallId === "tool-call-idle-error-subagent"
                ? {
                    nativeTaskId: "task-idle-error",
                    prompt: "child work",
                    title: "child work",
                    model: null,
                    status: toolCall.status === "completed" ? "completed" : "running",
                    childSessionId,
                    result: null,
                    suppressNormalTool: true,
                  }
                : undefined,
            makeRuntime: makeMockRuntime({
              childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
              mockAgentPath: yield* path.fromFileUrl(
                new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
              ),
              environment: { T3_ACP_IDLE_ERROR: details },
            }),
          },
        });
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const modelSelection = { instanceId, model: "default" } as const;
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make(`session-idle-error-${details}`),
          modelSelection,
          runtimePolicy,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const runTurn = (ordinal: number) =>
          Effect.gen(function* () {
            yield* runtime.startTurn(
              makeTurnInput({
                threadId,
                providerThread,
                instanceId,
                runtimePolicy,
                now: yield* DateTime.now,
                ordinal,
              }),
            );
            return yield* runtime.events.pipe(
              Stream.takeUntil((event) => event.type === "turn.terminal"),
              Stream.runCollect,
            );
          });

        const failedEvents = yield* runTurn(1);
        const failed = failedEvents.at(-1);
        assert.equal(failed?.type, "turn.terminal");
        if (failed?.type !== "turn.terminal" || failed.status !== "failed") {
          return assert.fail("expected a failed terminal");
        }
        assert.isTrue(
          failed.childTurnsContinue,
          "the run keeps ingesting work that outlives the failed prompt",
        );
        const lateSubagent = yield* runtime.events.pipe(
          Stream.filter(
            (event) => event.type === "subagent.updated" && event.subagent.status === "completed",
          ),
          Stream.runHead,
          Effect.timeoutOption("2 seconds"),
        );
        assert.isTrue(
          Option.isSome(lateSubagent) && Option.isSome(lateSubagent.value),
          "a subagent finishing after the failed prompt still reports to the run",
        );
        assert.deepEqual(
          failed.failure,
          details === "details"
            ? {
                class: "provider_error",
                message: "Missing Authentication header",
                code: "-32000",
                retryable: null,
              }
            : {
                class: "provider_error",
                message: "Provider turn failed.",
                code: null,
                retryable: null,
              },
        );
        const toolItems = (nativeId: string) =>
          failedEvents.flatMap((event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.nativeItemRef?.nativeId === nativeId
              ? [event.turnItem]
              : [],
          );
        const toolStatuses = toolItems("tool-call-idle-error-1").map((item) => item.status);
        assert.include(toolStatuses, "running");
        assert.equal(toolStatuses.at(-1), "failed");
        assert.deepEqual(
          toolItems("tool-call-idle-error-monitor").map((item) => item.status),
          ["running"],
          "a background monitor outlives the failed turn and keeps its running row",
        );
        const childItems = toolItems("task-idle-error:tool:tool-call-idle-error-child");
        assert.deepEqual(
          childItems.map((item) => item.status),
          ["running"],
          "a child-session tool keeps running in its own thread",
        );
        assert.isTrue(childItems.every((item) => item.threadId !== threadId));
        assert.isEmpty(
          toolItems("tool-call-idle-error-child"),
          "the failed turn must not reproject the child tool as a root tool",
        );

        const nextEvents = yield* runTurn(2);
        const next = nextEvents.at(-1);
        assert.equal(next?.type === "turn.terminal" ? next.status : undefined, "completed");
      }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  // Droid 0.243.0 and OpenCode 2.1 pair each choice with an optional free-form companion field.
  const droidChoice = {
    type: "string",
    title: "Format",
    description: "Which reply format?",
    oneOf: [
      { const: "option_0", title: "JSON" },
      { const: "option_1", title: "Plain text" },
      { const: "other", title: "Other answer" },
    ],
  };
  const droidSchema = {
    type: "object",
    properties: {
      question_1: droidChoice,
      question_1_other: { type: "string" },
      question_2: { ...droidChoice, title: "Alternative" },
      question_2_other: { type: "string" },
    },
    required: ["question_1", "question_2"],
  };
  const droidQuestions = ["question_1", "question_2"].map((id, index) => ({
    id,
    header: index === 0 ? "Format" : "Alternative",
    question: "Which reply format?",
    options: [
      { label: "JSON", description: "JSON", value: "option_0" },
      { label: "Plain text", description: "Plain text", value: "option_1" },
    ],
  }));

  // OpenCode 2.1 pairs each qN choice with a qN_custom free-form companion.
  const openCodeSchema = {
    type: "object",
    properties: {
      q0: {
        type: "string",
        title: "Color preference",
        description: "Which color do you prefer?",
        oneOf: [
          { const: "red", title: "Red", description: "Choose the color red" },
          { const: "blue", title: "Blue" },
        ],
        default: "red",
      },
      q0_custom: {
        type: "string",
        title: "Color preference (other)",
        description: "Type your own answer",
        minLength: 1,
      },
    },
  };
  const openCodeQuestions = [
    {
      id: "q0",
      header: "Color preference",
      question: "Which color do you prefer?",
      options: [
        { label: "Red", description: "Choose the color red", value: "red" },
        { label: "Blue", description: "Blue", value: "blue" },
      ],
      allowCustomAnswer: true,
    },
  ];

  // regression: #20417 Droid AskUser answers were sent as a cancel
  it.live.each([
    {
      scenario: "preserves selected IDs and encodes custom answers",
      schema: droidSchema,
      questions: droidQuestions,
      answers: { question_1: "option_1", question_2: "Markdown" },
      result: {
        action: "accept",
        content: { question_1: "option_1", question_2: "other", question_2_other: "Markdown" },
      },
    },
    {
      scenario: "preserves selected labels and attachment paths in custom answers",
      schema: droidSchema,
      questions: droidQuestions,
      withAttachments: true,
      answers: {
        question_1: "option_1",
        question_2: "option_1\n\nAttached notes: keep this custom text",
      },
      result: (directory: string) => ({
        action: "accept",
        content: {
          question_1: "other",
          question_1_other: `Plain text\n\nAttached image "shot.png": ${JSON.stringify(NodePath.join(directory, "droid-shot.png"))}\nAttached file "spec.txt": ${JSON.stringify(NodePath.join(directory, "droid-spec.txt"))}`,
          question_2: "other",
          question_2_other: "option_1\n\nAttached notes: keep this custom text",
        },
      }),
    },
    {
      scenario: "cancels without accepting answers",
      schema: droidSchema,
      questions: droidQuestions,
      answers: undefined,
      result: { action: "cancel" },
    },
    {
      scenario: "falls back for an unrelated form",
      schema: { type: "object", properties: { name: { type: "string" } } },
      questions: [{ id: "name", header: "Question 1", question: "Your answer?", options: [] }],
      answers: { name: "Ada" },
      result: { action: "accept", content: { name: "Ada" } },
    },
    {
      scenario: "OpenCode keeps the selected option and hides the custom companion",
      settings: OPENCODE_SETTINGS,
      schema: openCodeSchema,
      questions: openCodeQuestions,
      answers: { q0: "blue" },
      result: { action: "accept", content: { q0: "blue" } },
    },
    {
      scenario: "OpenCode sends a typed answer to the custom companion",
      settings: OPENCODE_SETTINGS,
      schema: openCodeSchema,
      questions: openCodeQuestions,
      answers: { q0: "green" },
      result: { action: "accept", content: { q0_custom: "green" } },
    },
    {
      scenario: "OpenCode multi-select keeps values and custom text",
      settings: OPENCODE_SETTINGS,
      schema: {
        ...openCodeSchema,
        properties: {
          q0: {
            type: "array",
            title: "Color preference",
            description: "Which color do you prefer?",
            items: { anyOf: openCodeSchema.properties.q0.oneOf },
          },
          q0_custom: { type: "string", description: "Add your own answer" },
        },
      },
      questions: openCodeQuestions.map((question) => ({ ...question, multiSelect: true })),
      answers: { q0: ["blue", "green"] },
      result: { action: "accept", content: { q0: ["blue"], q0_custom: "green" } },
    },
    {
      scenario: "OpenCode cancels without accepting answers",
      settings: OPENCODE_SETTINGS,
      schema: openCodeSchema,
      questions: openCodeQuestions,
      answers: undefined,
      result: { action: "cancel" },
    },
    {
      scenario: "OpenCode falls back for an unrelated form",
      settings: OPENCODE_SETTINGS,
      schema: { type: "object", properties: { name: { type: "string" } } },
      questions: [{ id: "name", header: "Question 1", question: "Your answer?", options: [] }],
      answers: { name: "Ada" },
      result: { action: "accept", content: { name: "Ada" } },
    },
  ])("Registry elicitation $scenario", (fixture) => {
    const { schema, questions, answers, result } = fixture;
    const withAttachments = "withAttachments" in fixture && fixture.withAttachments;
    const settings = "settings" in fixture ? fixture.settings : DROID_SETTINGS;
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-registry-form-" });
      const statusPath = path.join(directory, "status.json");
      const expectedResult = typeof result === "function" ? result(directory) : result;
      let preparedAnswers: ProviderUserInputAnswers | undefined = answers;
      if (withAttachments && answers !== undefined) {
        yield* fileSystem.writeFileString(path.join(directory, "droid-shot.png"), "image");
        yield* fileSystem.writeFileString(path.join(directory, "droid-spec.txt"), "spec");
        preparedAnswers = yield* appendUserInputAttachmentPaths({
          answers,
          attachmentsDir: directory,
          attachmentsByQuestionId: {
            question_1: [
              {
                type: "image",
                id: "droid-shot",
                name: "shot.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
              {
                type: "file",
                id: "droid-spec",
                name: "spec.txt",
                mimeType: "text/plain",
                sizeBytes: 4,
              },
            ],
          },
        });
      }
      const driver = ProviderDriverKind.make("acpRegistry");
      const transcript = yield* decodeAcpReplayTranscript(
        {
          provider: driver,
          protocol: "acp.ndjson-jsonrpc",
          version: "1",
          scenario: "droid-form",
          entries: [
            {
              type: "expect_outbound",
              frame: { kind: "request", method: "initialize", params: "<any>" },
            },
            {
              type: "emit_inbound",
              frame: {
                kind: "response",
                method: "initialize",
                result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] },
              },
            },
            {
              type: "expect_outbound",
              frame: { kind: "request", method: "session/new", params: "<any>" },
            },
            {
              type: "emit_inbound",
              frame: {
                kind: "response",
                method: "session/new",
                result: { sessionId: "droid-session" },
              },
            },
            {
              type: "expect_outbound",
              frame: { kind: "request", method: "session/prompt", params: "<any>" },
            },
            {
              type: "emit_inbound",
              frame: {
                kind: "request",
                method: "elicitation/create",
                params: {
                  mode: "form",
                  sessionId: "droid-session",
                  message: "Your answer?",
                  requestedSchema: schema,
                },
              },
            },
            {
              type: "expect_outbound",
              frame: {
                kind: "response",
                method: "elicitation/create",
                result: expectedResult,
              },
            },
            {
              type: "emit_inbound",
              frame: {
                kind: "response",
                method: "session/prompt",
                result: { stopReason: "end_turn" },
              },
            },
            { type: "runtime_exit", status: "success" },
          ],
        },
        driver,
      );
      const instanceId = ProviderInstanceId.make("droid-form-test");
      const adapter = yield* makeAcpRegistryAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        settings,
        environment: {},
        makeRuntime: makeAcpReplayRuntime({
          transcript,
          statusPath,
          fileSystem,
          scriptPath: yield* path.fromFileUrl(
            new URL("../../../scripts/acp-replay-agent.ts", import.meta.url),
          ),
          childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
        }),
      }).pipe(
        Effect.provide(
          Layer.mock(AcpRegistryCatalog)({ resolve: () => Effect.die("runtime is injected") }),
        ),
      );
      const threadId = ThreadId.make("registry-form-thread");
      const modelSelection = { instanceId, model: "default" } as const;
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: directory,
      });
      const runtime = yield* adapter.openSession({
        threadId,
        modelSelection,
        runtimePolicy,
        providerSessionId: ProviderSessionId.make("droid-form-session"),
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          now: yield* DateTime.now,
        }),
      );
      const item = Option.getOrThrow(
        yield* runtime.events.pipe(
          Stream.filter(
            (event) =>
              event.type === "turn_item.updated" && event.turnItem.type === "user_input_request",
          ),
          Stream.runHead,
        ),
      );
      if (item.type !== "turn_item.updated" || item.turnItem.type !== "user_input_request")
        return yield* Effect.die("Expected a user input question");
      assert.deepEqual(item.turnItem.questions, questions);
      yield* runtime.respondToRuntimeRequest({
        requestId: item.turnItem.requestId,
        ...(preparedAnswers === undefined ? {} : { answers: preparedAnswers }),
      });
      const terminal = yield* runtime.events.pipe(
        Stream.filter((event) => event.type === "turn.terminal"),
        Stream.runHead,
      );
      assert.equal(Option.getOrThrow(terminal).status, "completed");
    }).pipe(Effect.provide(layerTest), Effect.scoped);
  });

  it.live.each(["failed", "recovered", "cancelled"] as const)(
    "projects Mistral retry notices and their %s outcome",
    (outcome) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const instanceId = ProviderInstanceId.make(`vibe-retry-${outcome}`);
        const threadId = ThreadId.make(`thread-vibe-retry-${outcome}`);
        const adapter = yield* makeAcpAdapterV2({
          instanceId,
          selfInvocation: yield* resolveSelfInvocation(),
          flavor: {
            driver: ProviderDriverKind.make("acpRegistry"),
            capabilities: AcpProviderCapabilitiesV2,
            registerExtensions: registerMistralVibeAcpExtensions,
            promptFailure: (cause) => acpRegistryPromptFailure("mistral-vibe", cause),
            makeRuntime: makeMockRuntime({
              childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
              mockAgentPath: yield* path.fromFileUrl(
                new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
              ),
              environment: { T3_ACP_VIBE_RETRY_OUTCOME: outcome },
            }),
          },
        });
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const modelSelection = { instanceId, model: "default" } as const;
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make(`session-vibe-retry-${outcome}`),
          modelSelection,
          runtimePolicy,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        yield* runtime.startTurn(
          makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            runtimePolicy,
            now: yield* DateTime.now,
          }),
        );
        const events = yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        const retries = events.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "error"
            ? [event.turnItem]
            : [],
        );
        const running = retries.filter((item) => item.status === "running");
        assert.deepEqual(
          running.map((item) => item.retry?.attempt),
          [1, 2],
        );
        assert.equal(new Set(retries.map((item) => item.id)).size, 1);
        assert.include(running[0]!.failure.message, "Rate limit reached");
        assert.notInclude(running[0]!.failure.message, "private-key");
        const terminal = events.find((event) => event.type === "turn.terminal");
        assert.isDefined(terminal);
        if (terminal?.type !== "turn.terminal") return yield* Effect.die("Missing terminal");
        if (outcome === "failed") {
          assert.equal(terminal.status, "failed");
          assert.equal(terminal.failure?.class, "usage_limit");
          assert.include(terminal.failure?.message ?? "", "Rate limit exceeded for mistral");
          if (terminal.status === "failed") assert.equal(terminal.retry?.attempt, 2);
        } else if (outcome === "cancelled") {
          assert.equal(terminal.status, "cancelled");
          assert.equal(retries.at(-1)?.status, "cancelled");
          assert.equal(retries.at(-1)?.title, "Provider retry stopped");
        } else {
          assert.equal(terminal.status, "completed");
          assert.equal(retries.at(-1)?.status, "completed");
          assert.equal(retries.at(-1)?.title, "Provider recovered");
        }
      }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live("refreshes ACP prompt instructions when the interaction mode changes", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const protocolEvents = yield* Queue.unbounded<EffectAcpProtocol.AcpProtocolLogEvent>();
      const instanceId = ProviderInstanceId.make("acp-test-instruction-transitions");
      const threadId = ThreadId.make("thread-acp-instruction-transitions");
      yield* (yield* McpProviderSessions.McpProviderSessions).set({
        environmentId: EnvironmentId.make("environment-acp-instruction-transitions"),
        threadId,
        providerSessionId: "mcp-session-acp-instruction-transitions",
        providerInstanceId: instanceId,
        endpoint: "http://127.0.0.1:43123/mcp",
        authorizationHeader: "Bearer instruction-transition-token",
        browserToolsAvailable: false,
      });
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            protocolEvents,
          }),
        },
        selfInvocation,
      });
      const policy = (interactionMode: "default" | "plan") =>
        ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode,
          cwd: process.cwd(),
        });
      const defaultPolicy = policy("default");
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-instruction-transitions"),
        modelSelection,
        runtimePolicy: defaultPolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy: defaultPolicy,
      });
      const now = yield* DateTime.now;
      const runTurn = Effect.fnUntraced(function* (
        ordinal: number,
        runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
        messageText: string,
      ) {
        yield* runtime.startTurn(
          makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            runtimePolicy,
            now,
            ordinal,
            messageText,
          }),
        );
        yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runDrain,
        );
        const methods: Array<string> = [];
        while (true) {
          const event = yield* Queue.take(protocolEvents);
          if (event.direction !== "outgoing") continue;
          const method = rawProtocolMethod(event);
          if (method === undefined) continue;
          methods.push(method);
          if (method === "session/prompt") {
            const promptBlocks = rawProtocolPromptTextBlocks(event);
            return {
              methods,
              prompt: promptBlocks.map((block) => block.text).join("\n"),
              textBlockCount: promptBlocks.length,
            };
          }
        }
      });

      const command = yield* runTurn(0, defaultPolicy, "/compact");
      assert.isTrue(command.prompt.startsWith("/compact"));
      assert.notInclude(command.prompt, "<t3_code_instructions>");
      assert.equal(command.textBlockCount, 1);
      const whitespaceCommand = yield* runTurn(1, defaultPolicy, "  /repro-skill");
      assert.equal(whitespaceCommand.prompt, "  /repro-skill");
      assert.equal(whitespaceCommand.textBlockCount, 1);
      assert.notInclude(whitespaceCommand.prompt, "<t3_code_instructions>");
      const firstDefault = yield* runTurn(2, defaultPolicy, "First default request.");
      assert.equal(firstDefault.textBlockCount, 2);
      assert.include(firstDefault.prompt, "T3 Code interaction mode: Default");
      assert.include(firstDefault.prompt, "## T3 Code browser");
      assert.include(firstDefault.prompt, "T3 Code orchestration");
      assert.notInclude(
        firstDefault.methods,
        "session/set_config_option",
        "Build should preserve the agent's advertised mode default",
      );
      assert.include(
        (yield* runTurn(3, defaultPolicy, "Second default request.")).prompt,
        "Second default request.",
      );

      const planPolicy = policy("plan");
      const firstPlan = yield* runTurn(4, planPolicy, "Plan this change.");
      assert.include(firstPlan.prompt, "T3 Code interaction mode: Plan");
      assert.include(firstPlan.methods, "session/set_config_option");
      assert.include(
        (yield* runTurn(5, planPolicy, "Continue planning.")).prompt,
        "Continue planning.",
      );
      const restoredBuild = yield* runTurn(6, defaultPolicy, "Implement the change.");
      assert.include(restoredBuild.prompt, "T3 Code interaction mode: Default");
      assert.include(
        restoredBuild.methods,
        "session/set_config_option",
        "Build should restore the native mode that T3 temporarily replaced for Plan",
      );
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live(
    "reinjects ACP instructions after protocol compaction, including during reinjection",
    () =>
      Effect.gen(function* () {
        const runTurn = yield* makeInstructionCompactionHarness({
          T3_ACP_COMPACTION_PROMPT_ORDINALS: "2,4",
        });
        yield* runTurn("Start work.");
        yield* runTurn("Continue until context compacts.");
        assert.deepEqual(yield* runTurn("  /repro-skill"), [
          { type: "text", text: "  /repro-skill" },
        ]);
        assertReinjectedInstructions(
          yield* runTurn("Continue after compaction."),
          "Continue after compaction.",
        );
        assertReinjectedInstructions(
          yield* runTurn("Continue after the second compaction."),
          "Continue after the second compaction.",
        );
        assert.equal((yield* runTurn("Finish work."))[0]?.text, "Finish work.");
      }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live(
    "reinjects ACP instructions after successful native compact, but not failed compact",
    () =>
      Effect.gen(function* () {
        const runTurn = yield* makeInstructionCompactionHarness({
          T3_ACP_FAIL_PROMPT_ORDINAL: "2",
        });
        yield* runTurn("Start work.");
        assert.deepEqual(yield* runTurn("/compact", "failed"), [
          { type: "text", text: "/compact" },
        ]);
        assert.equal(
          (yield* runTurn("Continue after failure."))[0]?.text,
          "Continue after failure.",
        );
        assert.deepEqual(yield* runTurn("/compact"), [{ type: "text", text: "/compact" }]);
        assert.deepEqual(yield* runTurn("/repro-skill"), [{ type: "text", text: "/repro-skill" }]);
        assertReinjectedInstructions(yield* runTurn("Continue work."), "Continue work.");
        assert.equal((yield* runTurn("Finish work."))[0]?.text, "Finish work.");
      }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live("reapplies a selection after a switch away from it failed partway", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const protocolEvents = yield* Queue.unbounded<EffectAcpProtocol.AcpProtocolLogEvent>();
      const instanceId = ProviderInstanceId.make("acp-test-partial-selection-reapply");
      const threadId = ThreadId.make("thread-acp-partial-selection-reapply");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            protocolEvents,
            environment: { T3_ACP_FAIL_SET_MODE_CONFIG_OPTION: "1" },
          }),
        },
        selfInvocation: yield* resolveSelfInvocation(),
      });
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const selectionA = { instanceId, model: "composer-2" } as const;
      const selectionB = {
        instanceId,
        model: "composer-2[fast=true]",
        options: [{ id: ACP_SESSION_MODE_OPTION_ID, value: "code" }],
      } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-partial-selection"),
        modelSelection: selectionA,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection: selectionA,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      const turnInput = (ordinal: number, modelSelection: ModelSelection) =>
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          now,
          ordinal,
          modelSelection,
        });

      const switchToB = yield* Effect.exit(runtime.startTurn(turnInput(1, selectionB)));
      assert.isTrue(Exit.isFailure(switchToB), "the agent rejected B's mode step");
      yield* Queue.clear(protocolEvents);

      yield* runtime.startTurn(turnInput(2, selectionA));
      yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runDrain,
      );
      const modelSetsBeforePrompt: Array<unknown> = [];
      while (true) {
        const event = yield* Queue.take(protocolEvents);
        if (event.direction !== "outgoing") continue;
        const method = rawProtocolMethod(event);
        if (method === "session/prompt") break;
        if (
          method === "session/set_config_option" &&
          rawProtocolRequestParam(event, "configId") === "model"
        ) {
          modelSetsBeforePrompt.push(rawProtocolRequestParam(event, "value"));
        }
      }
      assert.deepEqual(
        modelSetsBeforePrompt,
        ["composer-2"],
        "the native model was left on B, so the turn on A must set it back first",
      );
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  // regression: #21499 turns blocked only on T3 thread waits must show as waiting
  it.effect.each(["agent_message_chunk"] as const)(
    "keeps named ACP %s open while deriving thread wait execution state",
    (sessionUpdate) =>
      Effect.gen(function* () {
        type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
        let handler: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
        const instanceId = ProviderInstanceId.make("acp-named-stream-wait");
        const path = yield* Path.Path;
        const adapter = yield* makeAcpAdapterV2({
          instanceId,
          selfInvocation: yield* resolveSelfInvocation(),
          flavor: {
            driver: ACP_TEST_DRIVER,
            capabilities: AcpProviderCapabilitiesV2,
            makeRuntime: makeMockRuntime({
              childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
              mockAgentPath: yield* path.fromFileUrl(
                new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
              ),
              wrapRuntime: (runtime) => ({
                ...runtime,
                handleSessionUpdate: (next) =>
                  Effect.sync(() => {
                    handler = next;
                  }).pipe(Effect.andThen(runtime.handleSessionUpdate(next))),
                prompt: () =>
                  Effect.gen(function* () {
                    assert.isDefined(handler);
                    const updates = [
                      {
                        sessionUpdate,
                        messageId: "named-stream",
                        content: { type: "text", text: "Waiting for the child result" },
                      },
                      {
                        sessionUpdate: "tool_call",
                        toolCallId: "wait",
                        title: "Wait for the child",
                        status: "in_progress",
                        rawInput: {
                          server: "t3-code",
                          tool: "t3_thread_wait",
                          arguments: { threadId: "child" },
                        },
                        _meta: { is_mcp_tool_call: true },
                      },
                      {
                        sessionUpdate: "tool_call",
                        toolCallId: "command",
                        kind: "execute",
                        title: "Run command",
                        status: "in_progress",
                        rawInput: { command: "pwd" },
                      },
                      {
                        sessionUpdate: "tool_call_update",
                        toolCallId: "command",
                        status: "completed",
                      },
                      {
                        sessionUpdate: "tool_call_update",
                        toolCallId: "wait",
                        status: "completed",
                      },
                    ] satisfies Array<EffectAcpSchema.SessionUpdate>;
                    for (const update of updates)
                      yield* handler!({ sessionId: "mock-session-1", update });
                    return { stopReason: "end_turn" as const };
                  }),
              }),
            }),
          },
        });
        const threadId = ThreadId.make("thread-acp-named-stream-wait");
        const modelSelection = { instanceId, model: "default" };
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("session-acp-named-stream-wait"),
          modelSelection,
          runtimePolicy,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const input = makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          now: yield* DateTime.now,
        });
        yield* runtime.startTurn(input);
        const events = yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        const retained = new Map<string, OrchestrationV2TurnItem>();
        const states: Array<boolean> = [];
        for (const event of events) {
          if (event.type !== "turn_item.updated") continue;
          const item = event.turnItem;
          retained.set(item.id, item);
          if (item.type !== "dynamic_tool" && item.type !== "command_execution") continue;
          const streams = [...retained.values()].filter(
            (entry) => entry.type === "assistant_message" || entry.type === "reasoning",
          );
          assert.deepEqual(
            streams.map((entry) => [entry.type, entry.status]),
            [
              [
                sessionUpdate === "agent_message_chunk" ? "assistant_message" : "reasoning",
                "running",
              ],
            ],
          );
          states.push(
            deriveBlockedOnThreadWait({
              activeRun: { id: input.runId, status: "running" },
              turnItems: [...retained.values()],
            }),
          );
        }
        assert.deepEqual(states, [true, false, true, false]);
      }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("starts a new replay message after ACP v2 plan boundaries", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      let sessionUpdateHandler: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
      const instanceId = ProviderInstanceId.make("acp-test-v2-plan-replay-boundary");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            wrapRuntime: (runtime) => ({
              ...runtime,
              handleSessionUpdate: (handler) =>
                Effect.sync(() => {
                  sessionUpdateHandler = handler;
                }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
            }),
          }),
        },
        selfInvocation,
      });
      const threadId = ThreadId.make("thread-acp-v2-plan-replay-boundary");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-v2-plan-replay-boundary"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      assert.isDefined(sessionUpdateHandler);

      yield* sessionUpdateHandler!({
        sessionId: "mock-session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "before plan" },
        },
      });
      yield* sessionUpdateHandler!({
        sessionId: "mock-session-1",
        update: {
          sessionUpdate: "plan_update",
          plan: {
            type: "items",
            planId: "plan-1",
            entries: [{ content: "Continue", priority: "medium", status: "in_progress" }],
          },
        },
      });
      yield* sessionUpdateHandler!({
        sessionId: "mock-session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "after plan" },
        },
      });

      const snapshot = yield* runtime.readThreadSnapshot({ providerThread });
      assert.deepEqual(
        snapshot.messages.map((message) => message.text),
        ["before plan", "after plan"],
      );
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("persists a bounded subset of streamed root and child tool updates", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      type Runtime = AcpSessionRuntime.AcpSessionRuntime["Service"];
      let handler: Parameters<Runtime["handleSessionUpdate"]>[0] | undefined;
      // Devin resends the growing file without status on each update.
      const file = `${"x = 1\n".repeat(800)}END_OF_FILE\n`;
      const chunks = 200;
      const streamedWrite = (
        toolCallId: string,
        parentAgentId?: string,
      ): Array<EffectAcpSchema.SessionUpdate> => {
        const meta =
          parentAgentId === undefined ? {} : { "cognition.ai/subagent_context": { parentAgentId } };
        const write = (text: string, status?: "completed") => ({
          sessionUpdate: "tool_call_update" as const,
          toolCallId,
          title: "Writing ./audit.py",
          ...(status === undefined ? {} : { status }),
          content: [
            { type: "diff" as const, path: "/repo/audit.py", oldText: null, newText: text },
          ],
          rawInput: { file_path: "/repo/audit.py", content: text },
          _meta: meta,
        });
        return [
          {
            sessionUpdate: "tool_call",
            toolCallId,
            title: "Writing …",
            kind: "edit",
            status: "pending",
            _meta: meta,
          },
          ...Array.from({ length: chunks }, (_, index) =>
            write(file.slice(0, Math.ceil((file.length * (index + 1)) / chunks))),
          ),
          write(file, "completed"),
        ];
      };
      const instanceId = ProviderInstanceId.make("devin-streamed-write");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          normalizeSessionUpdate: normalizeDevinSessionUpdate,
          normalizeToolCall: normalizeDevinToolCall,
          extractSubagentUpdate: extractDevinSubagentUpdate,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            wrapRuntime: (runtime) => ({
              ...runtime,
              handleSessionUpdate: (next) =>
                Effect.sync(() => {
                  handler = next;
                }).pipe(Effect.andThen(runtime.handleSessionUpdate(next))),
              prompt: () =>
                Effect.gen(function* () {
                  const updates = [
                    {
                      sessionUpdate: "tool_call_update",
                      toolCallId: "child-a",
                      status: "in_progress",
                      _meta: {
                        "cognition.ai/subagent_started": {
                          agentId: "child-a",
                          title: "Write audit script",
                          task: "Write audit.py.",
                        },
                      },
                    },
                    ...streamedWrite("root-write"),
                    ...streamedWrite("child-write", "child-a"),
                    ...Array.from({ length: 5 }, (_, index) => ({
                      sessionUpdate: "tool_call_update" as const,
                      toolCallId: "ticker",
                      title: "Watch ticks",
                      kind: "execute" as const,
                      status: "in_progress" as const,
                      rawOutput: `tick ${index + 1}`,
                    })),
                    ...Array.from({ length: 5 }, (_, index) => ({
                      sessionUpdate: "tool_call_update" as const,
                      toolCallId: "text-ticker",
                      title: "Watch ticks",
                      kind: "execute" as const,
                      status: "in_progress" as const,
                      rawOutput: { type: "Text", text: `tock ${index + 1}` },
                    })),
                    {
                      sessionUpdate: "tool_call_update",
                      toolCallId: "child-a",
                      status: "completed",
                      _meta: {
                        "cognition.ai/subagent_completed": {
                          agentId: "child-a",
                          success: true,
                          summary: "Wrote audit.py",
                        },
                      },
                    },
                  ] satisfies Array<EffectAcpSchema.SessionUpdate>;
                  for (const update of updates)
                    yield* handler!({ sessionId: "mock-session-1", update });
                  return { stopReason: "end_turn" as const };
                }),
            }),
          }),
        },
      });
      const threadId = ThreadId.make("devin-streamed-write");
      const modelSelection = { instanceId, model: "default" };
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("devin-streamed-write-session"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          now: yield* DateTime.now,
        }),
      );
      const items = Array.from(
        yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        ),
      ).flatMap((event) => (event.type === "turn_item.updated" ? [event.turnItem] : []));
      for (const toolCallId of ["root-write", "child-write"]) {
        const writes = items.filter((item) => item.nativeItemRef?.nativeId?.endsWith(toolCallId));
        assert.isAtLeast(writes.length, chunks / 10, toolCallId);
        assert.isAtMost(writes.length, chunks / 5, toolCallId);
        assert.equal(writes.at(-1)?.status, "completed", toolCallId);
        assert.include(JSON.stringify(writes.at(-1)), "END_OF_FILE", toolCallId);
      }
      for (const [toolCallId, word] of [
        ["ticker", "tick"],
        ["text-ticker", "tock"],
      ] as const) {
        const ticks = items.filter((item) => item.nativeItemRef?.nativeId?.endsWith(toolCallId));
        for (let tick = 1; tick <= 5; tick++) {
          assert.isTrue(
            ticks.some((item) => JSON.stringify(item).includes(`${word} ${tick}`)),
            `${word} ${tick} must persist`,
          );
        }
      }
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("keeps Devin parent paragraphs intact while projecting native child work", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      type Runtime = AcpSessionRuntime.AcpSessionRuntime["Service"];
      let handler: Parameters<Runtime["handleSessionUpdate"]>[0] | undefined;
      let createTerminal: Parameters<Runtime["handleCreateTerminal"]>[0] | undefined;
      const instanceId = ProviderInstanceId.make("devin-replay");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        clientTerminals: { shellCommands: true },
        selfInvocation: yield* resolveSelfInvocation(),
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          normalizeSessionUpdate: normalizeDevinSessionUpdate,
          normalizeToolCall: normalizeDevinToolCall,
          extractSubagentUpdate: extractDevinSubagentUpdate,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            wrapRuntime: (runtime) => ({
              ...runtime,
              handleSessionUpdate: (next) =>
                Effect.sync(() => {
                  handler = next;
                }).pipe(Effect.andThen(runtime.handleSessionUpdate(next))),
              handleCreateTerminal: (next) =>
                Effect.sync(() => {
                  createTerminal = next;
                }).pipe(Effect.andThen(runtime.handleCreateTerminal(next))),
              prompt: () =>
                Effect.gen(function* () {
                  assert.isDefined(handler);
                  assert.isDefined(createTerminal);
                  const fallbackTerminal = yield* createTerminal(
                    { sessionId: "mock-session-1", command: "true acp-mcp-call task_status {}" },
                    { requestId: "child-mcp-terminal", method: "terminal/create" },
                  );
                  const updates = [
                    {
                      sessionUpdate: "tool_call_update",
                      toolCallId: "child-a",
                      status: "in_progress",
                      _meta: {
                        "cognition.ai/subagent_started": {
                          agentId: "child-a",
                          title: "Map orchestration",
                          task: "Run pwd, then reply ONE.",
                          model: " \t ",
                        },
                      },
                    },
                    {
                      sessionUpdate: "tool_call_update",
                      toolCallId: "child-a",
                      status: "in_progress",
                      _meta: {
                        "cognition.ai/subagent_started": {
                          agentId: "child-a",
                          title: "Map orchestration",
                          task: "Run pwd, then reply ONE.",
                          model: "SWE-1.7 Medium",
                          depth: 1,
                          isBackground: true,
                        },
                      },
                    },
                    {
                      sessionUpdate: "agent_message_chunk",
                      content: { type: "text", text: "Map orchestration (command" },
                      _meta: { "cognition.ai/streamingMessageId": "parent-message" },
                    },
                    {
                      sessionUpdate: "tool_call_update",
                      toolCallId: "parent-tool",
                      status: "completed",
                      title: "Parent tool finished",
                    },
                    {
                      sessionUpdate: "tool_call",
                      toolCallId: "child-pwd",
                      title: "Tool",
                      kind: "execute",
                      status: "in_progress",
                      rawInput: { command: "pwd" },
                      _meta: {
                        "cognition.ai/inferenceToolName": "exec",
                        "cognition.ai/subagent_context": { parentAgentId: "child-a" },
                      },
                    },
                    {
                      sessionUpdate: "tool_call",
                      toolCallId: "child-weather",
                      title: "Check weather",
                      status: "completed",
                      rawInput: { server: "weather", tool: "get_weather", city: "Berlin" },
                      rawOutput: {
                        result: {
                          _meta: {
                            source: { name: "Weather", logoUrl: "https://example.com/weather.png" },
                          },
                          content: [{ type: "text", text: "Sunny" }],
                        },
                      },
                      _meta: {
                        is_mcp_tool_call: true,
                        "cognition.ai/subagent_context": { parentAgentId: "child-a" },
                      },
                    },
                    {
                      sessionUpdate: "tool_call",
                      toolCallId: "child-mcp-fallback",
                      title: "Ran command",
                      kind: "execute",
                      status: "completed",
                      content: [{ type: "terminal", terminalId: fallbackTerminal.terminalId }],
                      _meta: { "cognition.ai/subagent_context": { parentAgentId: "child-a" } },
                    },
                    {
                      sessionUpdate: "tool_call",
                      toolCallId: "parent-weather",
                      title: "Check weather",
                      status: "completed",
                      rawInput: { server: "weather", tool: "get_weather", city: "Berlin" },
                      rawOutput: {
                        _meta: {
                          source: { name: "Weather", logoUrl: "https://example.com/weather.png" },
                        },
                        content: [{ type: "text", text: "Sunny" }],
                      },
                      _meta: { is_mcp_tool_call: true },
                    },
                    {
                      sessionUpdate: "agent_message_chunk",
                      content: { type: "text", text: " → decider → event)." },
                      _meta: { "cognition.ai/streamingMessageId": "parent-message" },
                    },
                    {
                      sessionUpdate: "tool_call_update",
                      toolCallId: "child-pwd",
                      status: "completed",
                      rawOutput: "probe-workspace",
                      _meta: { "cognition.ai/subagent_context": { parentAgentId: "child-a" } },
                    },
                    {
                      sessionUpdate: "agent_message_chunk",
                      content: { type: "text", text: "Checking the code." },
                      _meta: {
                        "cognition.ai/streamingMessageId": "child-progress",
                        "cognition.ai/subagent_context": { parentAgentId: "child-a" },
                      },
                    },
                    {
                      sessionUpdate: "agent_message_chunk",
                      content: { type: "text", text: "ONE" },
                      _meta: {
                        "cognition.ai/streamingMessageId": "child-result",
                        "cognition.ai/subagent_context": { parentAgentId: "child-a" },
                      },
                    },
                    {
                      sessionUpdate: "tool_call",
                      toolCallId: "child-later",
                      title: "Later tool",
                      status: "completed",
                      _meta: { "cognition.ai/subagent_context": { parentAgentId: "child-a" } },
                    },
                    {
                      sessionUpdate: "tool_call_update",
                      toolCallId: "child-a",
                      status: "completed",
                      _meta: {
                        "cognition.ai/subagent_completed": {
                          agentId: "child-a",
                          success: true,
                          summary: "Final report: ONE",
                          depth: 1,
                        },
                      },
                    },
                  ] satisfies Array<EffectAcpSchema.SessionUpdate>;
                  for (const update of updates)
                    yield* handler!({ sessionId: "mock-session-1", update });
                  return { stopReason: "end_turn" as const };
                }),
            }),
          }),
        },
      });
      const threadId = ThreadId.make("devin-replay-parent");
      const modelSelection = { instanceId, model: "default" };
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("devin-replay-session"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          now: yield* DateTime.now,
        }),
      );
      const events = Array.from(
        yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        ),
      );
      const items = events.flatMap((event) =>
        event.type === "turn_item.updated" ? [event.turnItem] : [],
      );
      const parentMessages = items.filter(
        (item) => item.threadId === threadId && item.type === "assistant_message",
      );
      assert.equal(new Set(parentMessages.map((item) => item.id)).size, 1);
      const lastParent = parentMessages.at(-1);
      assert.equal(
        lastParent?.type === "assistant_message" ? lastParent.text : undefined,
        "Map orchestration (command → decider → event).",
      );
      const tasks = events.flatMap((event) =>
        event.type === "subagent.updated" ? [event.subagent] : [],
      );
      const task = tasks.at(-1);
      assert.isNull(tasks[0]?.model);
      const childThread = events.find(
        (event) =>
          event.type === "app_thread.created" && event.appThread.id === task?.childThreadId,
      );
      assert.equal(
        childThread?.type === "app_thread.created"
          ? childThread.appThread.modelSelection.model
          : undefined,
        modelSelection.model,
      );
      assert.equal(task?.model, "SWE-1.7 Medium");
      assert.equal(task?.status, "completed");
      assert.equal(task?.result, "Final report: ONE");
      const childMessages = new Map(
        items.flatMap((item) =>
          item.threadId === task?.childThreadId && item.type === "assistant_message"
            ? [[item.id, item.text] as const]
            : [],
        ),
      );
      assert.deepEqual([...childMessages.values()], ["Checking the code.", "ONE"]);
      assert.equal(task?.prompt, "Run pwd, then reply ONE.");
      assert.isTrue(
        items.some(
          (item) =>
            item.threadId === task?.childThreadId &&
            item.type === "dynamic_tool" &&
            item.toolName === "t3-code.task_status",
        ),
      );
      const childMcp = items.find(
        (item) =>
          item.threadId === task?.childThreadId &&
          item.type === "dynamic_tool" &&
          item.toolName === "weather.get_weather",
      );
      const parentMcp = items.find(
        (item) =>
          item.threadId === threadId &&
          item.type === "dynamic_tool" &&
          item.toolName === "weather.get_weather",
      );
      for (const item of [parentMcp, childMcp]) {
        assert.equal(item?.title, "get weather");
        assert.deepEqual(item?.toolSource, {
          key: "mcp:weather",
          name: "Weather",
          kind: "integration",
          icon: { _tag: "themed-logo", logoUrl: "https://example.com/weather.png" },
        });
        assert.deepEqual(item?.toolIcon, item?.toolSource?.icon);
      }
      assert.isTrue(
        items.some(
          (item) =>
            item.threadId === task?.childThreadId &&
            item.type === "user_message" &&
            item.text === task.prompt,
        ),
      );
      assert.isTrue(
        items.some(
          (item) =>
            item.threadId === task?.childThreadId &&
            item.type === "dynamic_tool" &&
            item.status === "completed" &&
            item.output === "probe-workspace",
        ),
      );
      const childAnswers = items.filter(
        (item) => item.threadId === task?.childThreadId && item.type === "assistant_message",
      );
      assert.equal(new Set(childAnswers.map((item) => item.ordinal)).size, 2);
      const parentTools = items.filter(
        (item) => item.threadId === threadId && item.type === "dynamic_tool",
      );
      assert.equal(parentTools.length, 2);
      assert.equal(parentTools[0]?.title, "Parent tool finished");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("routes interleaved Copilot subagent output into subagent threads", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      type Runtime = AcpSessionRuntime.AcpSessionRuntime["Service"];
      let handler: Parameters<Runtime["handleSessionUpdate"]>[0] | undefined;
      let sessionEvent:
        | ((event: unknown) => Effect.Effect<void, EffectAcpErrors.AcpError>)
        | undefined;
      const routing = makeCopilotSubagentRouting();
      const instanceId = ProviderInstanceId.make("copilot-replay");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          registerExtensions: routing.registerExtensions,
          normalizeSessionUpdate: routing.normalizeSessionUpdate,
          extractSubagentUpdate: extractCopilotSubagentUpdate,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            wrapRuntime: (runtime) => ({
              ...runtime,
              handleSessionUpdate: (next) =>
                Effect.sync(() => {
                  handler = next;
                }).pipe(Effect.andThen(runtime.handleSessionUpdate(next))),
              handleExtNotification: (method, payload, next) =>
                Effect.sync(() => {
                  if (method === "github.com/copilot/sessionEvent") {
                    sessionEvent = next as typeof sessionEvent;
                  }
                }).pipe(Effect.andThen(runtime.handleExtNotification(method, payload, next))),
              prompt: () =>
                Effect.gen(function* () {
                  assert.isDefined(handler);
                  assert.isDefined(sessionEvent);
                  const sessionId = "mock-session-1";
                  const raw = (type: string, data: object, agentId?: string) =>
                    sessionEvent!({ sessionId, type, data, ...(agentId ? { agentId } : {}) });
                  const update = (next: EffectAcpSchema.SessionUpdate) =>
                    handler!({ sessionId, update: next });
                  // Copilot sends each chunk's raw delta just before the chunk.
                  const chunk = (text: string, task?: string) =>
                    raw("assistant.message_delta", {
                      deltaContent: text,
                      ...(task ? { parentToolCallId: task } : {}),
                    }).pipe(
                      Effect.andThen(
                        update({
                          sessionUpdate: "agent_message_chunk",
                          content: { type: "text", text },
                        }),
                      ),
                    );
                  const launch = (toolCallId: string, description: string, mode: string) =>
                    update({
                      sessionUpdate: "tool_call",
                      toolCallId,
                      title: description,
                      kind: "other",
                      status: "pending",
                      rawInput: {
                        description,
                        prompt: `${description}.`,
                        agent_type: "explore",
                        mode,
                      },
                    });
                  yield* chunk("Launching ");
                  yield* launch("task-a", "Describe a.txt", "sync");
                  yield* launch("task-b", "Describe b.txt", "sync");
                  yield* launch("task-bg", "List directory", "background");
                  yield* raw("subagent.started", { toolCallId: "task-a" }, "agent-a");
                  yield* raw("subagent.started", { toolCallId: "task-b" }, "agent-b");
                  yield* raw("subagent.started", { toolCallId: "task-bg" }, "agent-bg");
                  yield* update({
                    sessionUpdate: "tool_call_update",
                    toolCallId: "task-bg",
                    status: "completed",
                    rawOutput: { content: "Agent started in background with agent_id: agent-bg." },
                  });
                  yield* update({
                    sessionUpdate: "tool_call",
                    toolCallId: "view-a",
                    title: "Viewing a.txt",
                    kind: "read",
                    status: "completed",
                    rawInput: { path: "a.txt" },
                    _meta: { "github.com/copilot": { agentId: "agent-a" } },
                  });
                  yield* chunk("`a.txt` says", "task-a");
                  yield* chunk("`b.txt` has", "task-b");
                  yield* chunk(" hello.", "task-a");
                  yield* chunk("a.txt b.txt", "task-bg");
                  yield* chunk(" three lines.", "task-b");
                  for (const [task, agent, text] of [
                    ["task-a", "agent-a", "`a.txt` says hello."],
                    ["task-b", "agent-b", "`b.txt` has three lines."],
                  ] as const) {
                    yield* update({
                      sessionUpdate: "tool_call_update",
                      toolCallId: task,
                      status: "completed",
                      rawOutput: { content: text },
                    });
                    yield* raw("subagent.completed", { toolCallId: task }, agent);
                  }
                  yield* raw("subagent.completed", { toolCallId: "task-bg" }, "agent-bg");
                  yield* chunk("all done.");
                  return { stopReason: "end_turn" as const };
                }),
            }),
          }),
        },
      });
      const threadId = ThreadId.make("copilot-replay-parent");
      const modelSelection = { instanceId, model: "default" };
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("copilot-replay-session"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          now: yield* DateTime.now,
        }),
      );
      const events = Array.from(
        yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        ),
      );
      const items = events.flatMap((event) =>
        event.type === "turn_item.updated" ? [event.turnItem] : [],
      );
      const lastText = (thread: string | null | undefined) =>
        new Map(
          items.flatMap((item) =>
            item.threadId === thread && item.type === "assistant_message"
              ? [[item.id, item.text] as const]
              : [],
          ),
        );
      assert.deepEqual([...lastText(threadId).values()].join(""), "Launching all done.");
      const tasks = new Map(
        events.flatMap((event) =>
          event.type === "subagent.updated"
            ? [[event.subagent.nativeTaskRef?.nativeId, event.subagent] as const]
            : [],
        ),
      );
      const outputs = Object.fromEntries(
        [...tasks].map(([id, task]) => [
          id,
          [task.status, [...lastText(task.childThreadId).values()].join("")],
        ]),
      );
      assert.deepEqual(outputs, {
        "task-a": ["completed", "`a.txt` says hello."],
        "task-b": ["completed", "`b.txt` has three lines."],
        "task-bg": ["completed", "a.txt b.txt"],
      });
      assert.isTrue(
        items.some(
          (item) =>
            item.threadId === tasks.get("task-a")?.childThreadId &&
            item.type === "dynamic_tool" &&
            item.title === "Read a.txt",
        ),
      );
      assert.isFalse(
        items.some((item) => item.threadId === threadId && item.type === "dynamic_tool"),
      );
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("advertises ACP session notices and shows them as system notices", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const protocolEvents = yield* Queue.unbounded<EffectAcpProtocol.AcpProtocolLogEvent>();
      const instanceId = ProviderInstanceId.make("acp-test-notice");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            protocolEvents,
            environment: { T3_ACP_EMIT_NOTICE: "1" },
          }),
        },
        selfInvocation,
      });
      const threadId = ThreadId.make("thread-acp-notice");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-notice"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* runtime.startTurn(
        makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now, ordinal: 1 }),
      );
      const items = Array.from(
        yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        ),
      ).flatMap((event) => (event.type === "turn_item.updated" ? [event.turnItem] : []));

      const initialize = Array.from(yield* Queue.takeAll(protocolEvents)).find(
        (event) => event.direction === "outgoing" && rawProtocolMethod(event) === "initialize",
      );
      assert.deepEqual(
        initialize === undefined
          ? undefined
          : Reflect.get(
              Object(rawProtocolRequestParam(initialize, "clientCapabilities")),
              "session",
            ),
        { notices: {} },
      );
      const title =
        "skill discovery warning: candidate was skipped because its metadata is invalid";
      assert.deepEqual(
        items.flatMap((item) => (item.type === "system_notice" ? [item.message] : [])),
        [title],
      );
      const replies = new Map(
        items.flatMap((item) => (item.type === "assistant_message" ? [[item.id, item.text]] : [])),
      );
      assert.deepEqual(
        [...replies.values()],
        ["before the notice, after the notice"],
        "a notice neither joins the reply nor splits it",
      );
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("projects ACP v2 fidelity updates into first-class orchestration items", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      let sessionUpdateHandler: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
      const instanceId = ProviderInstanceId.make("acp-test-v2-fidelity");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            environment: { T3_ACP_EMIT_V2_FIDELITY: "1" },
            wrapRuntime: (runtime) => ({
              ...runtime,
              handleSessionUpdate: (handler) =>
                Effect.sync(() => {
                  sessionUpdateHandler = handler;
                }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
            }),
          }),
        },
        selfInvocation,
      });
      const threadId = ThreadId.make("thread-acp-v2-fidelity");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-v2-fidelity"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          now,
          ordinal: 1,
        }),
      );
      const events = Array.from(
        yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        ),
      );
      const plans = events.flatMap((event) => (event.type === "plan.updated" ? [event.plan] : []));
      const planA = plans.filter((plan) => plan.kind === "proposed_plan");
      const planB = plans.find((plan) => plan.kind === "todo_list");
      assert.equal(planA.length, 2);
      assert.equal(planA[0]?.id, planA[1]?.id);
      assert.equal(planA[1]?.status, "superseded");
      assert.isDefined(planB);
      assert.notEqual(planA[0]?.id, planB?.id);

      const items = events.flatMap((event) =>
        event.type === "turn_item.updated" ? [event.turnItem] : [],
      );
      assert.isFalse(
        items.some((item) => item.type === "user_message" && item.text === "stale user text"),
        "the active ACP prompt echo must not create a second user message",
      );
      assert.isTrue(items.some((item) => item.type === "user_message" && item.text.length === 0));
      assert.equal(
        items.filter((item) => item.type === "assistant_message").at(-1)?.text,
        "authoritative answer",
      );
      assert.isTrue(
        items.some((item) => item.type === "reasoning" && item.text === "final thought"),
      );
      assert.deepInclude(
        items.flatMap((item) =>
          item.type === "command_execution" ? [{ input: item.input, output: item.output }] : [],
        ),
        { input: "printf proof", output: "proof" },
      );
      assert.deepInclude(
        items.flatMap((item) =>
          item.type === "command_execution" ? [{ input: item.input, output: item.output }] : [],
        ),
        { input: "cat probe.txt", output: "after\n" },
      );
      assert.isTrue(
        items.some((item) => item.title === "Action required" && item.status === "waiting"),
      );
      assert.isTrue(
        items.some(
          (item) =>
            item.type === "file_change" &&
            item.changes?.[0]?.operation === "move" &&
            item.changes[0]?.oldPath === "/workspace/old.ts",
        ),
      );
      const read = items.find((item) => item.type === "dynamic_tool" && item.toolName === "Read");
      assert.deepEqual(
        read?.type === "dynamic_tool" ? { title: read.title, input: read.input } : null,
        { title: "Read src/env.ts", input: { path: "src/env.ts" } },
      );
      const search = items.find((item) => item.type === "file_search");
      assert.deepEqual(
        search?.type === "file_search" ? { title: search.title, pattern: search.pattern } : null,
        { title: "Searched TODO in web", pattern: "apps/web" },
      );
      const webItem = (nativeId: string, status: string) => {
        const item = items.findLast(
          (candidate) =>
            candidate.type === "web_search" &&
            candidate.status === status &&
            candidate.nativeItemRef?.nativeId?.endsWith(nativeId) === true,
        );
        return item?.type === "web_search"
          ? { title: item.title, patterns: item.patterns, results: item.results }
          : null;
      };
      assert.deepEqual(webItem("grok-x-search", "running"), {
        title: "X search",
        patterns: undefined,
        results: undefined,
      });
      assert.deepEqual(webItem("grok-x-search", "completed"), {
        title: "X search: conversation_id:42",
        patterns: ["conversation_id:42"],
        results: undefined,
      });
      assert.deepEqual(webItem("grok-web-search", "completed"), {
        title: "Web search: t3 code",
        patterns: ["t3 code"],
        results: [{ url: "https://t3.codes" }, { url: "https://github.com/pingdotgg/t3code" }],
      });
      assert.deepEqual(webItem("grok-web-fetch", "completed")?.results, [
        { url: "https://t3.codes", snippet: "T3 Code page" },
      ]);
      const completedCompaction = items.find(
        (item) =>
          item.type === "compaction" &&
          item.status === "completed" &&
          item.summary === "Retained decisions.",
      );
      assert.isDefined(completedCompaction);
      assert.notProperty(completedCompaction!, "afterTokenCount");

      assert.isDefined(sessionUpdateHandler);
      yield* sessionUpdateHandler!({
        sessionId: "mock-session-1",
        update: {
          sessionUpdate: "agent_message",
          messageId: "late-authoritative-message",
          content: [{ type: "text", text: "late authoritative text" }],
        },
      });
      yield* sessionUpdateHandler!({
        sessionId: "mock-session-1",
        update: {
          sessionUpdate: "agent_message",
          messageId: "late-authoritative-message",
        },
      });
      const afterOmittedPatch = yield* runtime.readThreadSnapshot({ providerThread });
      assert.isTrue(
        afterOmittedPatch.messages.some((message) => message.text === "late authoritative text"),
        "omitted late message content must preserve the authoritative text",
      );
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live(
    "loads the persisted ACP session during startup without creating a throwaway session",
    () =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const path = yield* Path.Path;
        const selfInvocation = yield* resolveSelfInvocation();
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        const protocolEvents = yield* Queue.unbounded<EffectAcpProtocol.AcpProtocolLogEvent>();
        const instanceId = ProviderInstanceId.make("acp-test-eager-resume");
        const adapter = yield* makeAcpAdapterV2({
          instanceId,
          flavor: {
            driver: ACP_TEST_DRIVER,
            capabilities: AcpProviderCapabilitiesV2,
            makeRuntime: makeMockRuntime({
              childProcessSpawner,
              mockAgentPath,
              protocolEvents,
            }),
          },
          selfInvocation,
        });
        const threadId = ThreadId.make("thread-acp-eager-resume");
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const modelSelection = { instanceId, model: "default" } as const;
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-acp-eager-resume"),
          modelSelection,
          runtimePolicy,
          initialNativeThreadId: "persisted-session",
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });

        assert.equal(providerThread.nativeThreadRef?.nativeId, "persisted-session");
        assert.isNull(providerThread.nativeMetadata);
        const startupMethods = yield* pollProtocolMethods(protocolEvents);
        assert.include(startupMethods, "session/resume");
        assert.notInclude(startupMethods, "session/new");

        yield* runtime.resumeThread({ providerThread, modelSelection, runtimePolicy });
        assert.notInclude(yield* pollProtocolMethods(protocolEvents), "session/resume");
        const now = yield* DateTime.now;
        yield* runtime.startTurn(
          makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            runtimePolicy,
            now,
            ordinal: 1,
          }),
        );
        const terminal = Array.from(
          yield* runtime.events.pipe(
            Stream.takeUntil((event) => event.type === "turn.terminal"),
            Stream.runCollect,
          ),
        ).find((event) => event.type === "turn.terminal");
        assert.equal(
          terminal?.providerTurnId,
          idAllocator.derive.providerTurn({
            driver: ACP_TEST_DRIVER,
            nativeTurnId: "persisted-session:turn:1",
          }),
        );
      }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live("creates a fresh ACP identity when recovering an exhausted target", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const protocolEvents = yield* Queue.unbounded<EffectAcpProtocol.AcpProtocolLogEvent>();
      const instanceId = ProviderInstanceId.make("acp-test-exhausted-target");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            protocolEvents,
            wrapRuntime: (runtime, ordinal) => ({
              ...runtime,
              start: () =>
                runtime.start().pipe(
                  Effect.map((started) => ({
                    ...started,
                    sessionId: `mock-recovery-session-${ordinal}`,
                  })),
                ),
            }),
          }),
        },
        selfInvocation,
      });
      const threadId = ThreadId.make("thread-acp-exhausted-target");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-exhausted-target"),
        modelSelection,
        runtimePolicy,
      });
      const original = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread: original,
          instanceId,
          runtimePolicy,
          now: yield* DateTime.now,
          ordinal: 1,
        }),
      );
      yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runDrain,
      );
      const replacement = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
        existingProviderThread: { ...original, nativeThreadRef: null },
        forceNewNativeThread: true,
      });
      assert.notEqual(replacement.nativeThreadRef?.nativeId, original.nativeThreadRef?.nativeId);
      assert.equal(replacement.id, original.id);
      assert.equal(replacement.nativeMetadata?.itemIdentityVersion, 2);
      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread: replacement,
          instanceId,
          runtimePolicy,
          now: yield* DateTime.now,
          ordinal: 2,
        }),
      );
      const events = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
      );
      assert.isTrue(
        events.some((event) => event.type === "turn.terminal" && event.status === "completed"),
      );
      const methods = yield* pollProtocolMethods(protocolEvents);
      assert.equal(methods.filter((method) => method === "session/new").length, 2);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live("preserves new-session fallback when an eager ACP session load is stale", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const path = yield* Path.Path;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const protocolEvents = yield* Queue.unbounded<EffectAcpProtocol.AcpProtocolLogEvent>();
      const instanceId = ProviderInstanceId.make("acp-test-stale-eager-resume");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            protocolEvents,
            environment: (runtimeOrdinal) =>
              runtimeOrdinal === 1 ? { T3_ACP_FAIL_LOAD_SESSION: "1" } : {},
          }),
        },
        selfInvocation,
      });
      const threadId = ThreadId.make("thread-acp-stale-eager-resume");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-stale-eager-resume"),
        modelSelection,
        runtimePolicy,
        initialNativeThreadId: "stale-session",
      });
      const replacementThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const staleThread: OrchestrationV2ProviderThread = {
        ...replacementThread,
        nativeMetadata: null,
        nativeThreadRef: {
          driver: ACP_TEST_DRIVER,
          nativeId: "stale-session",
          strength: "strong",
        },
      };

      const startupMethods = yield* pollProtocolMethods(protocolEvents);
      assert.equal(startupMethods.filter((method) => method === "session/resume").length, 1);
      assert.equal(startupMethods.filter((method) => method === "session/new").length, 1);

      const resumeError = yield* runtime
        .resumeThread({ providerThread: staleThread, modelSelection, runtimePolicy })
        .pipe(Effect.flip);
      assert.equal(resumeError._tag, "ProviderAdapterResumeThreadError");
      assert.notInclude(yield* pollProtocolMethods(protocolEvents), "session/resume");
      assert.notEqual(replacementThread.nativeThreadRef?.nativeId, "stale-session");
      const preservedReplacement = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      assert.equal(preservedReplacement.nativeMetadata?.itemIdentityVersion, 2);
      const now = yield* DateTime.now;
      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread: preservedReplacement,
          instanceId,
          runtimePolicy,
          now,
          ordinal: 1,
        }),
      );
      const terminal = Array.from(
        yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        ),
      ).find((event) => event.type === "turn.terminal");
      assert.equal(
        terminal?.providerTurnId,
        idAllocator.derive.providerTurn({
          driver: ACP_TEST_DRIVER,
          nativeTurnId: acpScopedNativeId(
            instanceId,
            `${preservedReplacement.nativeThreadRef?.nativeId}:turn:1`,
          ),
        }),
      );
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live("replaces an unexpectedly terminated ACP runtime before the next turn", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const runtimeInputs: AcpAdapterV2RuntimeInput[] = [];
      let runtimeOrdinalSeen = 0;
      const baseMakeRuntime = makeMockRuntime({
        childProcessSpawner,
        mockAgentPath,
        environment: (runtimeOrdinal) => {
          runtimeOrdinalSeen = runtimeOrdinal;
          return {};
        },
      });
      const instanceId = ProviderInstanceId.make("acp-test-unexpected-termination");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime: (runtimeInput) =>
            Effect.sync(() => {
              runtimeInputs.push(runtimeInput);
            }).pipe(Effect.andThen(baseMakeRuntime(runtimeInput))),
        },
        selfInvocation,
      });
      const threadId = ThreadId.make("thread-acp-unexpected-termination");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-unexpected-termination"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      assert.equal(runtimeOrdinalSeen, 1);
      yield* runtimeInputs[0]!.onTermination!(
        new EffectAcpErrors.AcpTransportError({
          detail: "Injected unexpected writer termination",
          cause: "test",
        }),
      );

      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          now: yield* DateTime.now,
        }),
      );
      yield* runtime.events.pipe(
        Stream.filter((event) => event.type === "turn.terminal"),
        Stream.runHead,
      );
      assert.equal(runtimeOrdinalSeen, 2);
      assert.lengthOf(runtimeInputs, 2);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live("does not poll the process ledger while a cgroup lease owns teardown", () =>
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) !== "linux") return;
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      // A directory stands in for cgroupfs: the join wrapper appends the agent
      // PID to cgroup.procs and stays in this process's cgroup, which is the
      // cgroup the lease reports.
      const leasePath = yield* fileSystem.makeTempDirectoryScoped();
      const procsPath = path.join(leasePath, "cgroup.procs");
      yield* fileSystem.writeFileString(procsPath, "");
      const relativePath = AcpSessionRuntime.parseUnifiedCgroupPath(
        NodeFS.readFileSync("/proc/self/cgroup", "utf8"),
      );
      // No unified cgroup on this host means no lease is possible, so there is
      // nothing for this test to exercise.
      if (relativePath === undefined) return;
      const processTree = AcpSessionRuntime.makePosixProcessTreeController("linux");
      const leasePids = () =>
        NodeFS.readFileSync(procsPath, "utf8").split(/\s+/).filter(Boolean).map(Number);
      const isLive = (pid: number) => {
        const identity = processTree.identity(pid);
        return identity !== undefined && !AcpSessionRuntime.posixProcessIsZombie(identity);
      };
      let leaseExists = true;
      const linuxCgroupController: AcpSessionRuntime.AcpLinuxCgroupController = {
        create: () => ({
          contains: (pid) => leasePids().includes(pid),
          exists: () => leaseExists,
          path: leasePath,
          relativePath,
          kill: () => {
            for (const pid of leasePids().filter(isLive)) process.kill(pid, "SIGKILL");
          },
          populated: () => leasePids().some(isLive),
          remove: () => {
            leaseExists = false;
          },
        }),
      };
      let childListReads = 0;
      const posixProcessTreeController: AcpSessionRuntime.AcpPosixProcessTreeController = {
        ...processTree,
        childPidsOf: (pid) => {
          childListReads += 1;
          return processTree.childPidsOf(pid);
        },
      };
      const instanceId = ProviderInstanceId.make("acp-test-cgroup-ledger-idle");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            linuxCgroupController,
            posixProcessTreeController,
            mockAgentPath,
            ownDescendantProcessGroups: true,
            ownDetachedProcessGroup: true,
          }),
        },
        selfInvocation,
      });
      const threadId = ThreadId.make("thread-acp-cgroup-ledger-idle");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const sessionScope = yield* Scope.fork(yield* Scope.Scope);
      const runtime = yield* adapter
        .openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-acp-cgroup-ledger-idle"),
          modelSelection,
          runtimePolicy,
        })
        .pipe(Effect.provideService(Scope.Scope, sessionScope));
      yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
      // The agent's children are listed once, to capture the root it may
      // signal at teardown, and never again while the session is open.
      assert.equal(childListReads, 1);

      const agentPid = leasePids()[0];
      assert.isDefined(agentPid);
      yield* Scope.close(sessionScope, Exit.void);
      assert.isFalse(isLive(agentPid!), "closing the session must still tear the agent down");
      assert.isFalse(leaseExists, "closing the session must remove the lease");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("negotiates and executes optional native session forks through the ACP runtime", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const protocolEvents = yield* Queue.bounded<EffectAcpProtocol.AcpProtocolLogEvent>(256);
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      let createTerminal: Parameters<RuntimeService["handleCreateTerminal"]>[0] | undefined;
      let readTerminalOutput: Parameters<RuntimeService["handleTerminalOutput"]>[0] | undefined;
      let waitForTerminalExit:
        | Parameters<RuntimeService["handleTerminalWaitForExit"]>[0]
        | undefined;
      const makeRuntime = makeMockRuntime({
        childProcessSpawner,
        mockAgentPath,
        protocolEvents,
        wrapRuntime: (runtime) => ({
          ...runtime,
          handleCreateTerminal: (handler) =>
            Effect.sync(() => {
              createTerminal = handler;
            }).pipe(Effect.andThen(runtime.handleCreateTerminal(handler))),
          handleTerminalOutput: (handler) =>
            Effect.sync(() => {
              readTerminalOutput = handler;
            }).pipe(Effect.andThen(runtime.handleTerminalOutput(handler))),
          handleTerminalWaitForExit: (handler) =>
            Effect.sync(() => {
              waitForTerminalExit = handler;
            }).pipe(Effect.andThen(runtime.handleTerminalWaitForExit(handler))),
        }),
      });

      const instanceId = ProviderInstanceId.make("acp-test");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime,
        },
        selfInvocation,
        clientTerminals: {},
      });
      const sourceThreadId = ThreadId.make("thread-acp-native-fork-source");
      const targetThreadId = ThreadId.make("thread-acp-native-fork-target");
      yield* (yield* McpProviderSessions.McpProviderSessions).set({
        environmentId: EnvironmentId.make("environment-acp-native-fork-source"),
        threadId: sourceThreadId,
        providerSessionId: "mcp-session-acp-native-fork-source",
        providerInstanceId: instanceId,
        endpoint: "http://127.0.0.1:43123/mcp",
        authorizationHeader: "Bearer source-thread-token",
        browserToolsAvailable: true,
      });
      yield* (yield* McpProviderSessions.McpProviderSessions).set({
        environmentId: EnvironmentId.make("environment-acp-native-fork"),
        threadId: targetThreadId,
        providerSessionId: "mcp-session-acp-native-fork",
        providerInstanceId: instanceId,
        endpoint: "http://127.0.0.1:43123/mcp",
        authorizationHeader: "Bearer target-thread-token",
        browserToolsAvailable: true,
      });
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId: sourceThreadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-native-fork"),
        modelSelection,
        runtimePolicy,
      });

      assert.isTrue(runtime.providerSession.capabilities.threads.canForkThread);
      assert.isTrue(runtime.providerSession.capabilities.threads.canReadThreadSnapshot);
      assert.isTrue(runtime.providerSession.capabilities.sessions.supportsModelSwitchInSession);
      assert.isFalse(
        runtime.providerSession.capabilities.sessions.supportsRuntimeModeSwitchInSession,
      );

      const sourceProviderThread = yield* runtime.ensureThread({
        threadId: sourceThreadId,
        modelSelection,
        runtimePolicy,
      });
      const forkedProviderThread = yield* runtime.forkThread({
        sourceProviderThread,
        targetThreadId,
      });
      const forkRequestEvent = Option.getOrThrow(
        yield* Stream.fromQueue(protocolEvents).pipe(
          Stream.filter(
            (event) =>
              event.direction === "outgoing" && rawProtocolMethod(event) === "session/fork",
          ),
          Stream.runHead,
        ),
      );
      const forkRequest = Option.getOrThrow(
        Option.fromNullishOr(rawProtocolRequest(forkRequestEvent)),
      );

      assert.equal(sourceProviderThread.nativeThreadRef?.nativeId, "mock-session-1");
      assert.equal(forkedProviderThread.nativeThreadRef?.nativeId, "mock-session-1-fork");
      assert.equal(forkedProviderThread.appThreadId, targetThreadId);
      assert.equal(forkedProviderThread.forkedFrom?.providerThreadId, sourceProviderThread.id);
      assert.deepEqual(forkRequest.params, {
        sessionId: "mock-session-1",
        cwd: process.cwd(),
        mcpServers: [
          {
            type: "stdio",
            name: "t3-code",
            command: process.execPath,
            args: [
              process.argv[1] === undefined ? "t3" : NodePath.resolve(process.argv[1]),
              "acp-mcp-bridge",
            ],
            env: [
              { name: "ELECTRON_RUN_AS_NODE", value: "1" },
              { name: "T3_ACP_MCP_ENDPOINT", value: "http://127.0.0.1:43123/mcp" },
              { name: "T3_ACP_MCP_AUTHORIZATION", value: "Bearer target-thread-token" },
            ],
          },
        ],
      });
      yield* runtime.ensureThread({
        threadId: sourceThreadId,
        modelSelection,
        runtimePolicy,
      });
      if (
        createTerminal === undefined ||
        readTerminalOutput === undefined ||
        waitForTerminalExit === undefined
      ) {
        return yield* Effect.die("ACP runtime must register terminal handlers");
      }
      const unknownTerminal = yield* createTerminal(
        {
          sessionId: "mock-child-session-without-credential-scope",
          command: process.execPath,
          args: ["-e", "process.stdout.write(process.env.T3_ACP_MCP_AUTHORIZATION ?? '')"],
        },
        { requestId: "test-unknown-terminal-create", method: "terminal/create" },
      );
      yield* waitForTerminalExit(
        {
          sessionId: "mock-child-session-without-credential-scope",
          terminalId: unknownTerminal.terminalId,
        },
        { requestId: "test-unknown-terminal-wait", method: "terminal/wait_for_exit" },
      );
      const unknownTerminalOutput = yield* readTerminalOutput(
        {
          sessionId: "mock-child-session-without-credential-scope",
          terminalId: unknownTerminal.terminalId,
        },
        { requestId: "test-unknown-terminal-output", method: "terminal/output" },
      );
      assert.equal(unknownTerminalOutput.output, "");

      const terminal = yield* createTerminal(
        {
          sessionId: "mock-session-1-fork",
          command: process.execPath,
          args: ["-e", "process.stdout.write(process.env.T3_ACP_MCP_AUTHORIZATION ?? '')"],
        },
        { requestId: "test-terminal-create", method: "terminal/create" },
      );
      yield* waitForTerminalExit(
        {
          sessionId: "mock-session-1-fork",
          terminalId: terminal.terminalId,
        },
        { requestId: "test-terminal-wait", method: "terminal/wait_for_exit" },
      );
      const terminalOutput = yield* readTerminalOutput(
        {
          sessionId: "mock-session-1-fork",
          terminalId: terminal.terminalId,
        },
        { requestId: "test-terminal-output", method: "terminal/output" },
      );
      assert.equal(terminalOutput.output, "Bearer target-thread-token");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect(
    "answers fs requests method-not-found when the flavor does not opt into client fs",
    () =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const selfInvocation = yield* resolveSelfInvocation();
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        const workspace = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-no-client-fs-",
        });
        const probePath = path.join(workspace, "planted.txt");
        const probeLogPath = path.join(workspace, "fs-probe.jsonl");
        const protocolEvents = yield* Queue.unbounded<EffectAcpProtocol.AcpProtocolLogEvent>();
        const instanceId = ProviderInstanceId.make("acp-test-no-client-fs");
        const adapter = yield* makeAcpAdapterV2({
          instanceId,
          flavor: {
            driver: ACP_TEST_DRIVER,
            capabilities: AcpProviderCapabilitiesV2,
            makeRuntime: makeMockRuntime({
              childProcessSpawner,
              mockAgentPath,
              protocolEvents,
              environment: {
                T3_ACP_CLIENT_FS_PROBE_PATH: probePath,
                T3_ACP_CLIENT_FS_PROBE_LOG_PATH: probeLogPath,
              },
            }),
          },
          selfInvocation,
        });
        const threadId = ThreadId.make("thread-acp-no-client-fs");
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: workspace,
        });
        const modelSelection = { instanceId, model: "default" } as const;
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-acp-no-client-fs"),
          modelSelection,
          runtimePolicy,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        yield* runtime.startTurn(
          makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            runtimePolicy,
            now: yield* DateTime.now,
          }),
        );
        yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runDrain,
        );

        const initialize = Option.getOrThrow(
          yield* Stream.fromQueue(protocolEvents).pipe(
            Stream.filter(
              (event) =>
                event.direction === "outgoing" && rawProtocolMethod(event) === "initialize",
            ),
            Stream.runHead,
          ),
        );
        assert.deepInclude(
          (rawProtocolRequest(initialize)?.params as { clientCapabilities?: unknown })
            ?.clientCapabilities,
          { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        );
        const outcomes = (yield* fileSystem.readFileString(probeLogPath))
          .trim()
          .split("\n")
          .map((line) => Option.getOrThrow(decodeUnknownJson(line)));
        assert.deepEqual(outcomes, [
          { method: "fs/write_text_file", errorCode: -32601 },
          { method: "fs/read_text_file", errorCode: -32601 },
        ]);
        assert.isFalse(yield* fileSystem.exists(probePath));
      }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("does not turn an unknown permission approval into an execute grant", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      let requestPermission: Parameters<RuntimeService["handleRequestPermission"]>[0] | undefined;
      let createTerminal: Parameters<RuntimeService["handleCreateTerminal"]>[0] | undefined;
      let runtimeInput: AcpAdapterV2RuntimeInput | undefined;
      const makeRuntime = makeMockRuntime({
        childProcessSpawner,
        mockAgentPath,
        environment: { T3_ACP_HANG_PROMPT_FOREVER: "1" },
        wrapRuntime: (runtime) => ({
          ...runtime,
          handleRequestPermission: (handler) =>
            Effect.sync(() => {
              requestPermission = handler;
            }).pipe(Effect.andThen(runtime.handleRequestPermission(handler))),
          handleCreateTerminal: (handler) =>
            Effect.sync(() => {
              createTerminal = handler;
            }).pipe(Effect.andThen(runtime.handleCreateTerminal(handler))),
        }),
      });
      const instanceId = ProviderInstanceId.make("acp-test-unknown-permission-grant");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          interruptPromptOnCancel: true,
          makeRuntime: (input) =>
            Effect.sync(() => {
              runtimeInput = input;
            }).pipe(Effect.andThen(makeRuntime(input))),
        },
        selfInvocation,
        clientTerminals: {},
      });
      const threadId = ThreadId.make("thread-acp-unknown-permission-grant");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-unknown-permission-grant"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const turnFiber = yield* runtime
        .startTurn(
          makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            runtimePolicy,
            now: yield* DateTime.now,
          }),
        )
        .pipe(Effect.forkScoped);
      if (requestPermission === undefined || createTerminal === undefined) {
        return yield* Effect.die("ACP runtime must register permission and terminal handlers");
      }

      const permissionFiber = yield* requestPermission(
        {
          sessionId: "mock-session-1",
          toolCall: {
            toolCallId: "unknown-permission-tool",
            title: "Unknown permission kind",
          },
          options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
        },
        { requestId: "unknown-permission-request", method: "session/request_permission" },
      ).pipe(Effect.forkScoped);
      const pending = Option.getOrThrow(
        yield* runtime.events.pipe(
          Stream.filter(
            (event) =>
              event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
          ),
          Stream.runHead,
        ),
      );
      if (
        pending.type !== "runtime_request.updated" ||
        pending.runtimeRequest.providerTurnId === null
      ) {
        return yield* Effect.die("Expected an unknown ACP permission request");
      }
      const responseFiber = yield* runtime
        .respondToRuntimeRequest({ requestId: pending.runtimeRequest.id, decision: "accept" })
        .pipe(Effect.forkScoped);
      assert.equal((yield* Fiber.join(permissionFiber)).outcome.outcome, "selected");
      if (runtimeInput?.onOutgoingResponse === undefined) {
        return yield* Effect.die("ACP runtime must expose native response acknowledgements");
      }
      yield* runtimeInput.onOutgoingResponse("unknown-permission-request");
      yield* Fiber.join(responseFiber);

      const terminalExit = yield* createTerminal(
        {
          sessionId: "mock-session-1",
          command: process.execPath,
          args: ["-e", "process.stdout.write('unexpected')"],
        },
        { requestId: "unknown-permission-terminal", method: "terminal/create" },
      ).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(terminalExit));

      yield* runtime.interruptTurn({
        providerThread,
        providerTurnId: pending.runtimeRequest.providerTurnId,
      });
      yield* Fiber.join(turnFiber);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect.each([
    {
      label: "grants an ID-only execute approval its tracked command",
      kind: "execute",
      granted: true,
    },
    {
      label: "does not grant execution to an ID-only approval of another tool",
      kind: "other",
      granted: false,
    },
  ] as const)("$label", ({ kind, granted }) =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      let requestPermission: Parameters<RuntimeService["handleRequestPermission"]>[0] | undefined;
      let createTerminal: Parameters<RuntimeService["handleCreateTerminal"]>[0] | undefined;
      let runtimeInput: AcpAdapterV2RuntimeInput | undefined;
      const makeRuntime = makeMockRuntime({
        childProcessSpawner,
        mockAgentPath,
        environment: { T3_ACP_EMIT_TRACKED_TOOL_CALL_KIND_THEN_HANG: kind },
        wrapRuntime: (runtime) => ({
          ...runtime,
          handleRequestPermission: (handler) =>
            Effect.sync(() => {
              requestPermission = handler;
            }).pipe(Effect.andThen(runtime.handleRequestPermission(handler))),
          handleCreateTerminal: (handler) =>
            Effect.sync(() => {
              createTerminal = handler;
            }).pipe(Effect.andThen(runtime.handleCreateTerminal(handler))),
        }),
      });
      const instanceId = ProviderInstanceId.make("acp-test-id-only-permission");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          interruptPromptOnCancel: true,
          makeRuntime: (input) =>
            Effect.sync(() => {
              runtimeInput = input;
            }).pipe(Effect.andThen(makeRuntime(input))),
        },
        selfInvocation,
        clientTerminals: {},
      });
      const threadId = ThreadId.make("thread-acp-id-only-permission");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-id-only-permission"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const turnFiber = yield* runtime
        .startTurn(
          makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            runtimePolicy,
            now: yield* DateTime.now,
          }),
        )
        .pipe(Effect.forkScoped);
      if (requestPermission === undefined || createTerminal === undefined) {
        return yield* Effect.die("ACP runtime must register permission and terminal handlers");
      }
      yield* runtime.events.pipe(
        Stream.filter(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.nativeItemRef?.nativeId === "tracked-tool-call",
        ),
        Stream.runHead,
      );

      const permissionFiber = yield* requestPermission(
        {
          sessionId: "mock-session-1",
          toolCall: { toolCallId: "tracked-tool-call" },
          options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
        },
        { requestId: "id-only-permission-request", method: "session/request_permission" },
      ).pipe(Effect.forkScoped);
      const approvalEvent = Option.getOrThrow(
        yield* runtime.events.pipe(
          Stream.filter(
            (event) =>
              event.type === "turn_item.updated" && event.turnItem.type === "approval_request",
          ),
          Stream.runHead,
        ),
      );
      if (
        approvalEvent.type !== "turn_item.updated" ||
        approvalEvent.turnItem.type !== "approval_request" ||
        approvalEvent.turnItem.providerTurnId === null
      ) {
        return yield* Effect.die("Expected an ACP approval request");
      }
      const approval = approvalEvent.turnItem;
      const providerTurnId = approvalEvent.turnItem.providerTurnId;
      const responseFiber = yield* runtime
        .respondToRuntimeRequest({ requestId: approval.requestId, decision: "accept" })
        .pipe(Effect.forkScoped);
      assert.equal((yield* Fiber.join(permissionFiber)).outcome.outcome, "selected");
      if (runtimeInput?.onOutgoingResponse === undefined) {
        return yield* Effect.die("ACP runtime must expose native response acknowledgements");
      }
      yield* runtimeInput.onOutgoingResponse("id-only-permission-request");
      yield* Fiber.join(responseFiber);

      const terminalExit = yield* createTerminal(
        {
          sessionId: "mock-session-1",
          command: process.execPath,
          args: ["-e", ""],
        },
        { requestId: "id-only-permission-terminal", method: "terminal/create" },
      ).pipe(Effect.exit);
      assert.deepEqual(
        { prompt: approval.prompt, terminalCreated: Exit.isSuccess(terminalExit) },
        { prompt: "git status", terminalCreated: granted },
      );

      yield* runtime.interruptTurn({ providerThread, providerTurnId });
      yield* Fiber.join(turnFiber);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("replaces the ACP session and clears conversation state on rollback", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const path = yield* Path.Path;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const instanceId = ProviderInstanceId.make("acp-test-rollback-session");
      const rollbackThreadId = ThreadId.make("thread-acp-rollback-session-target");
      yield* (yield* McpProviderSessions.McpProviderSessions).set({
        environmentId: EnvironmentId.make("environment-acp-rollback-session-target"),
        threadId: rollbackThreadId,
        providerSessionId: "mcp-session-acp-rollback-session-target",
        providerInstanceId: instanceId,
        endpoint: "http://127.0.0.1:43124/mcp",
        authorizationHeader: "Bearer rollback-target-token",
        browserToolsAvailable: false,
      });
      const runtimeInputs: Array<AcpAdapterV2RuntimeInput> = [];
      const makeRuntime = makeMockRuntime({
        childProcessSpawner,
        mockAgentPath,
        environment: { T3_ACP_PROMPT_DELAY_MS: "100" },
      });
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime: (runtimeInput) =>
            Effect.sync(() => runtimeInputs.push(runtimeInput)).pipe(
              Effect.andThen(makeRuntime(runtimeInput)),
            ),
        },
        selfInvocation,
      });
      const threadId = ThreadId.make("thread-acp-rollback-session");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-rollback-session"),
        modelSelection,
        runtimePolicy,
      });
      assert.isTrue(runtime.providerSession.capabilities.threads.canRollbackThread);
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      yield* runtime.events.pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped,
      );
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const firstSessionId = providerThread.nativeThreadRef?.nativeId;
      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          now: yield* DateTime.now,
        }),
      );
      const activeRollback = yield* runtime
        .rollbackThread({
          providerThread,
          providerThreadTurns: [],
          target: {
            type: "thread_start",
            checkpointId: CheckpointId.make("checkpoint-acp-active-rollback"),
            appRunOrdinal: 0,
          },
        })
        .pipe(Effect.result);
      assert.equal(activeRollback._tag, "Failure");
      if (activeRollback._tag === "Failure") {
        assert.include(String(activeRollback.failure.cause), "while turn");
      }
      const firstProviderTurnId = idAllocator.derive.providerTurn({
        driver: ACP_TEST_DRIVER,
        nativeTurnId: acpScopedNativeId(instanceId, `${firstSessionId}:turn:1`),
      });
      while (true) {
        const event = yield* Queue.take(events);
        if (event.type === "turn.terminal" && event.providerTurnId === firstProviderTurnId) break;
      }
      const snapshotBeforeRollback = yield* runtime.readThreadSnapshot({ providerThread });

      const rolledBack = yield* runtime.rollbackThread({
        providerThread: { ...providerThread, appThreadId: rollbackThreadId },
        providerThreadTurns: snapshotBeforeRollback.providerTurns,
        target: {
          type: "thread_start",
          checkpointId: CheckpointId.make("checkpoint-acp-rollback-session"),
          appRunOrdinal: 0,
        },
      });
      assert.isString(rolledBack.providerThread.nativeThreadRef?.nativeId);
      assert.deepEqual(rolledBack.providerTurns, []);
      assert.equal(
        runtimeInputs[1]?.processEnvironment?.T3_ACP_MCP_AUTHORIZATION,
        "Bearer rollback-target-token",
      );
      const replacementMcpServer = runtimeInputs[1]?.mcpServers[0];
      const replacementMcpEnvironment =
        replacementMcpServer !== undefined &&
        "env" in replacementMcpServer &&
        Array.isArray(replacementMcpServer.env)
          ? replacementMcpServer.env
          : undefined;
      assert.equal(
        replacementMcpEnvironment?.find((variable) => variable.name === "T3_ACP_MCP_AUTHORIZATION")
          ?.value,
        "Bearer rollback-target-token",
      );
      const snapshotAfterRollback = yield* runtime.readThreadSnapshot({
        providerThread: rolledBack.providerThread,
      });
      assert.deepEqual(snapshotAfterRollback.providerTurns, []);
      assert.deepEqual(snapshotAfterRollback.messages, []);

      yield* runtime.startTurn(
        makeTurnInput({
          threadId: rollbackThreadId,
          providerThread: rolledBack.providerThread,
          instanceId,
          runtimePolicy,
          now: yield* DateTime.now,
          ordinal: 2,
        }),
      );
      const secondProviderTurnId = idAllocator.derive.providerTurn({
        driver: ACP_TEST_DRIVER,
        nativeTurnId: acpScopedNativeId(
          instanceId,
          `${rolledBack.providerThread.nativeThreadRef?.nativeId}:turn:2`,
        ),
      });
      let secondStatus: string | null = null;
      while (secondStatus === null) {
        const event = yield* Queue.take(events);
        if (event.type === "turn.terminal" && event.providerTurnId === secondProviderTurnId) {
          secondStatus = event.status;
        }
      }
      assert.equal(secondStatus, "completed");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("quarantines callbacks from a failed rollback replacement before retrying", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      const sessionUpdateHandlers: Array<
        Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined
      > = [];
      const backgroundMutationHandlers: Array<
        AcpAdapterV2ExtensionContext["applyBackgroundTaskMutation"] | undefined
      > = [];
      const availableCommandUpdates: Array<ReadonlyArray<EffectAcpSchema.AvailableCommand>> = [];
      let registeredExtensionOrdinal = 0;
      let runtimeOrdinalSeen = 0;
      const makeRuntime = makeMockRuntime({
        childProcessSpawner,
        mockAgentPath,
        wrapRuntime: (runtime, runtimeOrdinal) => {
          runtimeOrdinalSeen = runtimeOrdinal;
          return {
            ...runtime,
            handleSessionUpdate: (handler) =>
              Effect.sync(() => {
                sessionUpdateHandlers[runtimeOrdinal - 1] = handler;
              }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
            ...(runtimeOrdinal === 2
              ? {
                  start: () =>
                    Effect.fail(
                      new EffectAcpErrors.AcpTransportError({
                        detail: "Forced first rollback replacement failure",
                        cause: "test",
                      }),
                    ),
                }
              : runtimeOrdinal === 3
                ? {
                    start: () =>
                      Effect.suspend(() => {
                        const stagedSessionUpdate = sessionUpdateHandlers[2];
                        if (stagedSessionUpdate === undefined) {
                          return Effect.die("replacement startup must buffer session updates");
                        }
                        return stagedSessionUpdate({
                          sessionId: "mock-session-3",
                          update: {
                            sessionUpdate: "available_commands_update",
                            availableCommands: [
                              {
                                name: "staged-command",
                                description: "published while the replacement starts",
                              },
                            ],
                          },
                        }).pipe(Effect.andThen(runtime.start()));
                      }),
                  }
                : {}),
          };
        },
      });
      const instanceId = ProviderInstanceId.make("acp-test-rollback-retry-generation");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          enablePostSettleContinuation: true,
          onAvailableCommandsUpdate: (commands) =>
            Effect.sync(() => {
              availableCommandUpdates.push(commands);
            }),
          registerExtensions: (context) =>
            Effect.sync(() => {
              backgroundMutationHandlers[registeredExtensionOrdinal] =
                context.applyBackgroundTaskMutation;
              registeredExtensionOrdinal += 1;
            }),
          makeRuntime,
        },
        selfInvocation,
        continuationRequests: { offer: () => Effect.void },
      });
      const threadId = ThreadId.make("thread-acp-rollback-retry-generation");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-rollback-retry-generation"),
        modelSelection,
        runtimePolicy,
      });
      if (runtime.hasPendingBackgroundWork === undefined) {
        return yield* Effect.die("ACP runtime must expose background work state");
      }
      const hasPendingBackgroundWork = runtime.hasPendingBackgroundWork;
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      yield* runtime.events.pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped,
      );
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });

      yield* runtime.rollbackThread({
        providerThread,
        providerThreadTurns: [],
        target: {
          type: "thread_start",
          checkpointId: CheckpointId.make("checkpoint-acp-rollback-retry-generation"),
          appRunOrdinal: 0,
        },
      });

      assert.equal(runtimeOrdinalSeen, 3);
      assert.deepEqual(
        availableCommandUpdates.map((commands) => commands.map((command) => command.name)),
        [["staged-command"]],
      );
      const failedReplacementHandler = sessionUpdateHandlers[1];
      const failedBackgroundMutationHandler = backgroundMutationHandlers[1];
      assert.isDefined(failedReplacementHandler);
      assert.isDefined(failedBackgroundMutationHandler);
      while (Option.isSome(yield* Queue.poll(events))) {}
      yield* failedReplacementHandler!({
        sessionId: "failed-replacement-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "stale failed replacement callback" },
        },
      });
      assert.isTrue(Option.isNone(yield* Queue.poll(events)));
      yield* failedBackgroundMutationHandler!({
        sessionId: "mock-session-3",
        taskId: "stale-failed-replacement-task",
        status: "running",
      });
      assert.isFalse(yield* hasPendingBackgroundWork);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live("settles a Grok background command that completed before an ACP v2 idle error", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const instanceId = ProviderInstanceId.make("grok-idle-error-background");
      const adapter = yield* makeGrokAdapterV2({
        instanceId,
        settings: DEFAULT_GROK_SETTINGS,
        environment: {},
        hostPlatform: yield* HostProcess.Platform,
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: (input) =>
          makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            environment: { T3_ACP_IDLE_ERROR: "grok-background" },
          })(input).pipe(Effect.flatMap(makeXAiPromptCompletionRuntime)),
      });
      const threadId = ThreadId.make("grok-idle-error-background");
      const modelSelection = { instanceId, model: "default" } as const;
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("grok-idle-error-background"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          now: yield* DateTime.now,
        }),
      );
      const events = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
      );
      const terminal = events.at(-1);
      assert.equal(terminal?.type === "turn.terminal" ? terminal.status : undefined, "failed");
      const command = events.findLast(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.nativeItemRef?.nativeId === "call-idle-error-background",
      );
      assert.equal(
        command?.type === "turn_item.updated" ? command.turnItem.status : undefined,
        "completed",
      );
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  // Oracle: Grok incident frames. Command completion must release the turn even
  // when the CLI keeps the prompt RPC and process alive. Command polls stay visible.
  it.live(
    "completes a structured Grok background command from poll with an unanswered prompt RPC",
    () =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const path = yield* Path.Path;
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        const instanceId = ProviderInstanceId.make("grok-background-completion");
        const adapter = yield* makeGrokAdapterV2({
          instanceId,
          settings: DEFAULT_GROK_SETTINGS,
          environment: {},
          hostPlatform: yield* HostProcess.Platform,
          selfInvocation: yield* resolveSelfInvocation(),
          makeRuntime: (input) =>
            makeMockRuntime({
              childProcessSpawner,
              mockAgentPath,
              environment: { T3_ACP_GROK_BACKGROUND_TASK_COMPLETION: "poll" },
            })(input).pipe(Effect.flatMap(makeXAiPromptCompletionRuntime)),
        });
        const threadId = ThreadId.make("grok-background-completion");
        const modelSelection = { instanceId, model: "default" } as const;
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("grok-background-completion"),
          modelSelection,
          runtimePolicy,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        yield* runtime.events.pipe(
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkScoped,
        );
        yield* runtime.startTurn(
          makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            runtimePolicy,
            now: yield* DateTime.now,
          }),
        );
        const observed = yield* Stream.fromQueue(events).pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        const allEvents = [...observed];
        let next = yield* Queue.poll(events);
        while (Option.isSome(next)) {
          allEvents.push(next.value);
          next = yield* Queue.poll(events);
        }
        const terminals = allEvents.filter((event) => event.type === "turn.terminal");
        assert.deepEqual(
          terminals.map((event) => event.status),
          ["completed"],
        );
        const items = allEvents.flatMap((event) =>
          event.type === "turn_item.updated" ? [event.turnItem] : [],
        );
        assert.isFalse(items.some((item) => item.type === "subagent"));
        const command = items.findLast(
          (item) => item.nativeItemRef?.nativeId === "call-fb9d0000-0000-0000-0000-000000000026-29",
        );
        assert.equal(command?.type, "command_execution");
        assert.equal(command?.status, "completed");
        assert.isTrue(
          items.some((item) => item.nativeItemRef?.nativeId === "call-background-poll"),
          "command TaskOutput must retain its normal tool frame",
        );
      }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  // Grok expands only a leading `/name`, so a picked leading `$name`
  // must reach it in that form; anything else keeps the user's text.
  it.live.each([
    { text: "$deploy ship it", sent: "/deploy ship it", native: true },
    { text: "ship $deploy", sent: "ship $deploy", native: false },
    { text: "$other ship it", sent: "$other ship it", native: false },
  ])("Grok sends $text with a picked skill as $sent", ({ text, sent, native }) =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const hostPlatform = yield* HostProcess.Platform;
      // Stands in for `grok inspect --json`, the catalog behind the `$` picker.
      const catalog = { skills: [{ name: "deploy", source: { path: "/s/deploy/SKILL.md" } }] };
      const grokPath = writeFakeCli({
        directory: yield* fileSystem.makeTempDirectoryScoped(),
        name: "grok",
        source: `process.stdout.write(${JSON.stringify(`${JSON.stringify(catalog)}\n`)});\n`,
        platform: hostPlatform,
      });
      const protocolEvents = yield* Queue.unbounded<EffectAcpProtocol.AcpProtocolLogEvent>();
      const instanceId = ProviderInstanceId.make("grok-skill-mention");
      const adapter = yield* makeGrokAdapterV2({
        instanceId,
        settings: { ...DEFAULT_GROK_SETTINGS, binaryPath: grokPath },
        // The fake CLI needs `node` on its PATH.
        environment: { ...process.env },
        hostPlatform,
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: (input) =>
          makeMockRuntime({ childProcessSpawner, mockAgentPath, protocolEvents })(input).pipe(
            Effect.flatMap(makeXAiPromptCompletionRuntime),
          ),
      });
      const threadId = ThreadId.make("grok-skill-mention");
      const modelSelection = { instanceId, model: "default" } as const;
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("grok-skill-mention"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          now: yield* DateTime.now,
          messageText: text,
        }),
      );
      const prompt = yield* Stream.fromQueue(protocolEvents).pipe(
        Stream.filter(
          (event) =>
            event.direction === "outgoing" && rawProtocolMethod(event) === "session/prompt",
        ),
        Stream.runHead,
      );
      const blocks = rawProtocolPromptTextBlocks(Option.getOrThrow(prompt));
      if (native) {
        // Same shape as a typed native command: one bare text block, no T3 instructions.
        assert.deepEqual(blocks, [{ type: "text", text: sent }]);
      } else {
        assert.isTrue(blocks.some((block) => block.text.includes(sent)));
        assert.isFalse(blocks.some((block) => block.text.trimStart().startsWith("/")));
      }
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  // Command completion must release the turn even when the CLI keeps the prompt RPC and process
  // alive. Kill calls stay visible.
  it.live.each([
    { shape: "output_only", expectedCommand: { type: "command_execution", status: "completed" } },
    { shape: "variant_only", expectedCommand: { type: "command_execution", status: "completed" } },
    { shape: "killed", expectedCommand: { type: "command_execution", status: "completed" } },
    {
      shape: "already_exited",
      expectedCommand: { type: "command_execution", status: "completed" },
    },
    {
      shape: "known_failure",
      expectedCommand: { type: "command_execution", status: "failed", output: "known failure\n" },
    },
  ] as const)(
    "completes a Grok KillTask command ($shape) and preserves any known result",
    ({ shape, expectedCommand }) =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const path = yield* Path.Path;
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        const instanceId = ProviderInstanceId.make("grok-kill-completion");
        const adapter = yield* makeGrokAdapterV2({
          instanceId,
          settings: DEFAULT_GROK_SETTINGS,
          environment: {},
          hostPlatform: yield* HostProcess.Platform,
          selfInvocation: yield* resolveSelfInvocation(),
          makeRuntime: (input) =>
            makeMockRuntime({
              childProcessSpawner,
              mockAgentPath,
              environment: { T3_ACP_GROK_KILL_TASK_SHAPE: shape },
            })(input).pipe(Effect.flatMap(makeXAiPromptCompletionRuntime)),
        });
        const threadId = ThreadId.make("grok-kill-completion");
        const modelSelection = { instanceId, model: "default" } as const;
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("grok-kill-completion"),
          modelSelection,
          runtimePolicy,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        yield* runtime.events.pipe(
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkScoped,
        );
        yield* runtime.startTurn(
          makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            runtimePolicy,
            now: yield* DateTime.now,
          }),
        );
        const observed = yield* Stream.fromQueue(events).pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        const allEvents = [...observed];
        let next = yield* Queue.poll(events);
        while (Option.isSome(next)) {
          allEvents.push(next.value);
          next = yield* Queue.poll(events);
        }
        const terminals = allEvents.filter((event) => event.type === "turn.terminal");
        assert.deepEqual(
          terminals.map((event) => event.status),
          ["completed"],
        );
        const items = allEvents.flatMap((event) =>
          event.type === "turn_item.updated" ? [event.turnItem] : [],
        );
        assert.isFalse(items.some((item) => item.type === "subagent"));
        const command = items.findLast(
          (item) => item.nativeItemRef?.nativeId === "kill-target-command",
        );
        assert.deepInclude(command, expectedCommand);
        assert.isTrue(
          items.some((item) => item.nativeItemRef?.nativeId === "kill-command"),
          "KillTask must retain its normal tool frame",
        );
      }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("keeps an agent's empty-valued default choice selectable", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const protocolEvents = yield* Queue.bounded<EffectAcpProtocol.AcpProtocolLogEvent>(256);
      const instanceId = ProviderInstanceId.make("acp-test");
      let agentDescriptor: ProviderOptionDescriptor | undefined;
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            environment: { T3_ACP_EMIT_EMPTY_DEFAULT_AGENT_OPTION: "1" },
            protocolEvents,
          }),
          onSessionConfigurationUpdate: (configOptions, modeState) =>
            Effect.sync(() => {
              agentDescriptor = acpProviderOptionDescriptors({ configOptions, modeState }).find(
                (descriptor) => descriptor.id === "agent",
              );
            }),
        },
        selfInvocation,
      });
      const threadId = ThreadId.make("thread-acp-empty-default-agent");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const customAgentSelection = {
        instanceId,
        model: "default",
        options: [{ id: "agent", value: "example" }],
      } satisfies ModelSelection;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-empty-default-agent"),
        modelSelection: customAgentSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection: customAgentSelection,
        runtimePolicy,
      });
      assert.deepEqual(agentDescriptor, {
        id: "agent",
        label: "Agent",
        type: "select",
        options: [
          { id: ACP_EMPTY_OPTION_VALUE, label: "Copilot" },
          { id: "example", label: "example" },
        ],
        currentValue: "example",
      });

      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          modelSelection: {
            instanceId,
            model: "default",
            options: [{ id: "agent", value: ACP_EMPTY_OPTION_VALUE }],
          },
          now: yield* DateTime.now,
        }),
      );
      yield* runtime.events.pipe(
        Stream.filter((event) => event.type === "turn.terminal"),
        Stream.runHead,
      );

      assert.equal(
        agentDescriptor?.type === "select" ? agentDescriptor.currentValue : undefined,
        ACP_EMPTY_OPTION_VALUE,
      );
      const sentAgentValues = Array.from(yield* Queue.takeAll(protocolEvents))
        .filter(
          (event) =>
            event.direction === "outgoing" &&
            rawProtocolMethod(event) === "session/set_config_option" &&
            rawProtocolRequestParam(event, "configId") === "agent",
        )
        .map((event) => rawProtocolRequestParam(event, "value"));
      assert.deepEqual(sentAgentValues, ["example", ""]);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live("terminalizes an empty successful foreground Bash tool when the turn completes", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const path = yield* Path.Path;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const protocolEvents = yield* Queue.bounded<EffectAcpProtocol.AcpProtocolLogEvent>(256);
      const instanceId = ProviderInstanceId.make("acp-test");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            environment: (runtimeOrdinal) =>
              runtimeOrdinal === 1 ? { T3_ACP_EMIT_EMPTY_SUCCESSFUL_BASH_THEN_HANG: "1" } : {},
            ownDetachedProcessGroup: true,
            protocolEvents,
          }),
          normalizeToolCall: normalizeXAiAcpToolCallState,
          restartRuntimeAfterInterrupt: true,
          terminateRuntimeProcessGroupOnInterrupt: true,
        },
        selfInvocation,
      });
      const threadId = ThreadId.make("thread-acp-empty-successful-bash");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-empty-successful-bash"),
        modelSelection,
        runtimePolicy,
      });
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      yield* runtime.events.pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped,
      );
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* runtime.startTurn(
        makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now }),
      );

      const statuses: string[] = [];
      let runningStartedAt: DateTime.Utc | null = null;
      let completedStartedAt: DateTime.Utc | null = null;
      let completedAt: DateTime.Utc | null = null;
      let completedInput: string | null = null;
      let completedOutput: string | null | undefined;
      let completedExitCode: number | null | undefined;
      let runningProjectedExitCode: number | undefined = undefined;
      let terminal = false;
      while (!terminal) {
        const event = yield* Queue.take(events);
        if (
          event.type === "turn_item.updated" &&
          event.turnItem.nativeItemRef?.nativeId === "tool-call-empty-success-1"
        ) {
          statuses.push(event.turnItem.status);
          if (event.turnItem.status === "running") {
            runningStartedAt ??= event.turnItem.startedAt;
            if (event.turnItem.type === "command_execution") {
              runningProjectedExitCode = event.turnItem.exitCode;
            }
          }
          if (event.turnItem.status === "completed") {
            completedStartedAt = event.turnItem.startedAt;
            completedAt = event.turnItem.completedAt;
            if (event.turnItem.type === "command_execution") {
              completedInput = event.turnItem.input;
              completedOutput = event.turnItem.output;
              completedExitCode = event.turnItem.exitCode;
            }
          }
        }
        if (event.type === "turn.terminal") terminal = true;
      }

      assert.deepEqual(statuses, ["running", "running", "completed"]);
      assert.deepEqual(completedStartedAt, runningStartedAt);
      assert.isNotNull(completedAt);
      assert.equal(completedInput, "true");
      assert.equal(completedOutput, undefined);
      assert.equal(
        runningProjectedExitCode,
        undefined,
        "mid-stream exit_code must not project until the tool is terminal",
      );
      assert.equal(completedExitCode, 0);

      yield* Queue.takeAll(protocolEvents);
      yield* runtime
        .startTurn(
          makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now, ordinal: 2 }),
        )
        .pipe(Effect.forkScoped);
      yield* Stream.fromQueue(protocolEvents).pipe(
        Stream.filter(
          (event) =>
            event.direction === "outgoing" && rawProtocolMethod(event) === "session/prompt",
        ),
        Stream.runHead,
      );
      const secondProviderTurnId = idAllocator.derive.providerTurn({
        driver: ACP_TEST_DRIVER,
        nativeTurnId: acpScopedNativeId(instanceId, "mock-session-1:turn:2"),
      });
      yield* runtime.interruptTurn({
        providerThread,
        providerTurnId: secondProviderTurnId,
        requestRuntimeRestart: true,
      });
      yield* runtime.startTurn(
        makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now, ordinal: 3 }),
      );
      const loadAfterRestart = yield* Stream.fromQueue(protocolEvents).pipe(
        Stream.filter(
          (event) =>
            event.direction === "outgoing" && rawProtocolMethod(event) === "session/resume",
        ),
        Stream.runHead,
      );
      assert.isTrue(Option.isSome(loadAfterRestart));
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("drains native ACP cancellation before admitting the next prompt", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const selfInvocation = yield* resolveSelfInvocation();
      const protocolEvents = yield* Queue.unbounded<EffectAcpProtocol.AcpProtocolLogEvent>();
      const native: { current?: AcpSessionRuntime.AcpSessionRuntime["Service"] } = {};
      const instanceId = ProviderInstanceId.make("acp-native-cancel");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath: yield* path.fromFileUrl(
              new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
            ),
            environment: { T3_ACP_COMPLETE_FIRST_PROMPT_ON_CANCEL: "1" },
            protocolEvents,
            cancelBehavior: "wait-for-prompt",
            wrapRuntime: (runtime) => {
              native.current = runtime;
              return runtime;
            },
          }),
        },
        selfInvocation,
      });
      const threadId = ThreadId.make("thread-acp-native-cancel");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("session-acp-native-cancel"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* runtime.startTurn(
        makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now }),
      );
      const started = Option.getOrThrow(
        yield* runtime.events.pipe(
          Stream.filter(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.nativeItemRef?.nativeId === "native-cancel-tool",
          ),
          Stream.runHead,
        ),
      );
      if (
        started.type !== "turn_item.updated" ||
        started.turnItem.providerTurnId === null ||
        native.current === undefined
      ) {
        return yield* Effect.die("Expected the native cancellable command");
      }
      const providerTurnId = started.turnItem.providerTurnId;
      const interrupt = yield* runtime
        .interruptTurn({ providerThread, providerTurnId })
        .pipe(Effect.forkScoped);
      yield* Stream.fromQueue(protocolEvents).pipe(
        Stream.filter(
          (event) =>
            event.direction === "incoming" &&
            typeof event.payload === "string" &&
            event.payload.includes("native-cancel-received"),
        ),
        Stream.runHead,
      );
      yield* native.current.request("_test/finish-cancel", {});
      yield* Fiber.join(interrupt);
      const terminal = Option.getOrThrow(
        yield* runtime.events.pipe(
          Stream.filter(
            (event) => event.type === "turn.terminal" && event.providerTurnId === providerTurnId,
          ),
          Stream.runHead,
        ),
      );
      assert.equal(terminal.type === "turn.terminal" && terminal.status, "interrupted");
      yield* runtime.startTurn(
        makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now, ordinal: 2 }),
      );
      const nextTerminal = Option.getOrThrow(
        yield* runtime.events.pipe(
          Stream.filter(
            (event) => event.type === "turn.terminal" && event.providerTurnId !== providerTurnId,
          ),
          Stream.runHead,
        ),
      );
      assert.equal(nextTerminal.type === "turn.terminal" && nextTerminal.status, "completed");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("cancels pending permission requests while interrupting an ACP turn", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const releaseCancel = yield* Deferred.make<void>();
      const instanceId = ProviderInstanceId.make("acp-test");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            environment: { T3_ACP_EMIT_TOOL_CALLS: "1" },
            wrapCancel: (cancel) => Deferred.await(releaseCancel).pipe(Effect.andThen(cancel)),
          }),
        },
        selfInvocation,
      });
      const threadId = ThreadId.make("thread-acp-cancel-permission");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-cancel-permission"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* runtime.startTurn(
        makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now }),
      );

      const pendingRequest = Option.getOrThrow(
        yield* runtime.events.pipe(
          Stream.filter(
            (event) =>
              event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
          ),
          Stream.runHead,
        ),
      );
      if (
        pendingRequest.type !== "runtime_request.updated" ||
        pendingRequest.runtimeRequest.providerTurnId === null
      ) {
        return yield* Effect.die("Expected a pending ACP permission request with a provider turn");
      }

      const interruptFiber = yield* runtime
        .interruptTurn({
          providerThread,
          providerTurnId: pendingRequest.runtimeRequest.providerTurnId,
        })
        .pipe(Effect.forkScoped);

      const cancelledRequest = Option.getOrThrow(
        yield* runtime.events.pipe(
          Stream.filter(
            (event) =>
              event.type === "runtime_request.updated" &&
              event.runtimeRequest.id === pendingRequest.runtimeRequest.id &&
              event.runtimeRequest.status === "cancelled",
          ),
          Stream.runHead,
        ),
      );
      assert.equal(cancelledRequest.type, "runtime_request.updated");
      yield* Deferred.succeed(releaseCancel, undefined);
      yield* Fiber.join(interruptFiber);
      const terminal = Option.getOrThrow(
        yield* runtime.events.pipe(
          Stream.filter((event) => event.type === "turn.terminal"),
          Stream.runHead,
        ),
      );
      assert.equal(terminal.type, "turn.terminal");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live("keeps hard teardown excluded until a permission response is enqueued", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const responseEnqueued = yield* Deferred.make<void>();
      const releaseResponseAcknowledgement = yield* Deferred.make<void>();
      const instanceId = ProviderInstanceId.make("acp-test");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            environment: { T3_ACP_EMIT_TOOL_CALLS: "1" },
            wrapOutgoingResponse: (onOutgoingResponse) => (requestId) =>
              Deferred.succeed(responseEnqueued, undefined).pipe(
                Effect.andThen(Deferred.await(releaseResponseAcknowledgement)),
                Effect.andThen(onOutgoingResponse(requestId)),
              ),
          }),
        },
        selfInvocation,
      });
      const threadId = ThreadId.make("thread-acp-response-wins-permission");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-response-wins-permission"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          now: yield* DateTime.now,
        }),
      );
      const pending = Option.getOrThrow(
        yield* runtime.events.pipe(
          Stream.filter(
            (event) =>
              event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
          ),
          Stream.runHead,
        ),
      );
      if (
        pending.type !== "runtime_request.updated" ||
        pending.runtimeRequest.providerTurnId === null
      ) {
        return yield* Effect.die("Expected a pending permission request");
      }
      const responseFiber = yield* runtime
        .respondToRuntimeRequest({ requestId: pending.runtimeRequest.id, decision: "accept" })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(responseEnqueued);
      const interruptFiber = yield* runtime
        .interruptTurn({
          providerThread,
          providerTurnId: pending.runtimeRequest.providerTurnId,
          requestRuntimeRestart: true,
        })
        .pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      assert.isUndefined(responseFiber.pollUnsafe());
      assert.isUndefined(interruptFiber.pollUnsafe());

      yield* Deferred.succeed(releaseResponseAcknowledgement, undefined);
      yield* Fiber.join(responseFiber);
      yield* Fiber.join(interruptFiber);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live("auto-approves tagged MCP elicitations under full-access policy", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const instanceId = ProviderInstanceId.make("acp-test-mcp-approval-elicitation");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            environment: { T3_ACP_EMIT_MCP_TOOL_APPROVAL_ELICITATION: "1" },
          }),
        },
        selfInvocation,
      });
      const threadId = ThreadId.make("thread-acp-mcp-approval-elicitation");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-mcp-approval-elicitation"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          now: yield* DateTime.now,
        }),
      );
      const events = Array.from(
        yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        ),
      );

      assert.isFalse(events.some((event) => event.type === "runtime_request.updated"));
      assert.isTrue(events.some((event) => event.type === "turn.terminal"));
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live("fails a held native response acknowledgement before normal session close", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const responseWritten = yield* Deferred.make<void>();
      const releaseResponseAcknowledgement = yield* Deferred.make<void>();
      const responseLifecycle: Array<string> = [];
      const responseFailed = yield* Deferred.make<void>();
      const instanceId = ProviderInstanceId.make("acp-test-normal-close-held-response");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            environment: { T3_ACP_EMIT_TOOL_CALLS: "1" },
            wrapOutgoingResponse: (onOutgoingResponse) => (requestId) =>
              Deferred.succeed(responseWritten, undefined).pipe(
                Effect.andThen(Deferred.await(releaseResponseAcknowledgement)),
                Effect.andThen(onOutgoingResponse(requestId)),
              ),
          }),
        },
        selfInvocation,
        testHooks: {
          onNativeResponseLifecycle: (event) =>
            Effect.sync(() => {
              responseLifecycle.push(event.type);
              if (event.type === "failed") Deferred.doneUnsafe(responseFailed, Effect.void);
            }),
        },
      });
      const threadId = ThreadId.make("thread-acp-normal-close-held-response");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const sessionScope = yield* Scope.make();
      const runtime = yield* adapter
        .openSession({
          threadId,
          providerSessionId: ProviderSessionId.make(
            "provider-session-acp-normal-close-held-response",
          ),
          modelSelection,
          runtimePolicy,
        })
        .pipe(Effect.provideService(Scope.Scope, sessionScope));
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          now: yield* DateTime.now,
        }),
      );
      const pending = Option.getOrThrow(
        yield* runtime.events.pipe(
          Stream.filter(
            (event) =>
              event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
          ),
          Stream.runHead,
        ),
      );
      if (pending.type !== "runtime_request.updated") {
        return yield* Effect.die("Expected a pending permission request");
      }
      const responseFiber = yield* runtime
        .respondToRuntimeRequest({ requestId: pending.runtimeRequest.id, decision: "accept" })
        .pipe(Effect.exit, Effect.forkScoped);
      yield* Deferred.await(responseWritten);

      const closeFiber = yield* Scope.close(sessionScope, Exit.void).pipe(Effect.forkScoped);
      yield* Deferred.await(responseFailed);
      const responseExit = yield* Fiber.join(responseFiber);
      if (Exit.isSuccess(responseExit)) {
        assert.fail("normal close must fail a response whose transport acknowledgement is held");
      }
      assert.include(Cause.pretty(responseExit.cause), "ACP session transport closed");
      assert.include(responseLifecycle, "removed");
      assert.include(responseLifecycle, "failed");
      yield* Deferred.succeed(releaseResponseAcknowledgement, undefined);
      yield* Fiber.join(closeFiber);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live("treats a second hard Stop as success when the turn is already gone", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const path = yield* Path.Path;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const protocolEvents = yield* Queue.bounded<EffectAcpProtocol.AcpProtocolLogEvent>(256);
      const instanceId = ProviderInstanceId.make("acp-test");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          interruptPromptOnCancel: false,
          restartRuntimeAfterInterrupt: true,
          terminateRuntimeProcessGroupOnInterrupt: true,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            ownDetachedProcessGroup: true,
            environment: { T3_ACP_HANG_PROMPT_FOREVER: "1" },
            protocolEvents,
          }),
        },
        selfInvocation,
      });
      const threadId = ThreadId.make("thread-acp-double-stop");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-double-stop"),
        modelSelection,
        runtimePolicy,
      });
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      yield* runtime.events.pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped,
      );
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* runtime
        .startTurn(makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now }))
        .pipe(Effect.forkScoped);
      yield* Stream.fromQueue(protocolEvents).pipe(
        Stream.filter(
          (event) =>
            event.direction === "outgoing" && rawProtocolMethod(event) === "session/prompt",
        ),
        Stream.runHead,
      );
      const providerTurnId = idAllocator.derive.providerTurn({
        driver: ACP_TEST_DRIVER,
        nativeTurnId: acpScopedNativeId(instanceId, "mock-session-1:turn:1"),
      });
      yield* runtime.interruptTurn({
        providerThread,
        providerTurnId,
        requestRuntimeRestart: true,
      });
      const second = yield* Effect.exit(
        runtime.interruptTurn({
          providerThread,
          providerTurnId,
          requestRuntimeRestart: true,
        }),
      );
      assert.isTrue(Exit.isSuccess(second), "duplicate hard Stop must be idempotent");
      let terminal: string | null = null;
      while (terminal === null) {
        const event = yield* Queue.take(events);
        if (event.type === "turn.terminal" && event.providerTurnId === providerTurnId) {
          terminal = event.status;
        }
      }
      assert.equal(terminal, "interrupted");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("finalizes a settled turn held open for background work when interrupted", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const path = yield* Path.Path;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const instanceId = ProviderInstanceId.make("acp-test");
      const promptSettled = yield* Deferred.make<void>();
      const adapter = yield* makeAcpAdapterV2({
        testHooks: {
          afterPromptSettledWithBackgroundWork: () =>
            Deferred.succeed(promptSettled, undefined).pipe(Effect.asVoid),
        },
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          deferFinalizeForBackgroundWork: true,
          extractSubagentUpdate: (toolCall) =>
            toolCall.toolCallId === "tool-call-generic-1"
              ? {
                  nativeTaskId: "task-generic-1",
                  prompt: "background subagent",
                  title: "background subagent",
                  model: null,
                  status: "running",
                  childSessionId: null,
                  result: null,
                }
              : undefined,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            environment: { T3_ACP_EMIT_GENERIC_TOOL_PLACEHOLDERS: "1" },
          }),
        },
        selfInvocation,
      });
      const threadId = ThreadId.make("thread-acp-interrupt-background-hold");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-interrupt-background"),
        modelSelection,
        runtimePolicy,
      });
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      yield* runtime.events.pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped,
      );
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* runtime.startTurn(
        makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now }),
      );
      yield* Deferred.await(promptSettled);

      const providerTurnId = idAllocator.derive.providerTurn({
        driver: ACP_TEST_DRIVER,
        nativeTurnId: acpScopedNativeId(instanceId, "mock-session-1:turn:1"),
      });
      yield* runtime.interruptTurn({ providerThread, providerTurnId });

      let terminalStatus: string | null = null;
      while (terminalStatus === null) {
        const event = yield* Queue.take(events);
        if (event.type === "turn.terminal" && event.providerTurnId === providerTurnId) {
          terminalStatus = event.status;
        }
      }
      assert.equal(terminalStatus, "interrupted");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect(
    "carries a live subagent lineage across an interrupt so the next turn can complete it",
    () =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const path = yield* Path.Path;
        const selfInvocation = yield* resolveSelfInvocation();
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        const instanceId = ProviderInstanceId.make("acp-test");
        let subagentPhase: "spawn" | "complete" = "spawn";
        const promptSettled = yield* Deferred.make<void>();
        const adapter = yield* makeAcpAdapterV2({
          testHooks: {
            afterPromptSettledWithBackgroundWork: () =>
              Deferred.succeed(promptSettled, undefined).pipe(Effect.asVoid),
          },
          instanceId,
          flavor: {
            driver: ACP_TEST_DRIVER,
            capabilities: AcpProviderCapabilitiesV2,
            deferFinalizeForBackgroundWork: true,
            extractSubagentUpdate: (toolCall) =>
              toolCall.toolCallId !== "tool-call-generic-1"
                ? undefined
                : subagentPhase === "spawn"
                  ? {
                      nativeTaskId: "task-generic-1",
                      prompt: "background subagent",
                      title: "background subagent",
                      model: null,
                      status: "running",
                      childSessionId: null,
                      result: null,
                    }
                  : {
                      nativeTaskId: "task-generic-1",
                      prompt: "",
                      title: null,
                      model: null,
                      status: "completed",
                      childSessionId: null,
                      result: "SUB_DONE",
                    },
            makeRuntime: makeMockRuntime({
              childProcessSpawner,
              mockAgentPath,
              environment: { T3_ACP_EMIT_GENERIC_TOOL_PLACEHOLDERS: "1" },
            }),
          },
          selfInvocation,
        });
        const threadId = ThreadId.make("thread-acp-subagent-carryover");
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const modelSelection = { instanceId, model: "default" } as const;
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-acp-subagent-carryover"),
          modelSelection,
          runtimePolicy,
        });
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        yield* runtime.events.pipe(
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkScoped,
        );
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        yield* runtime.startTurn(
          makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now }),
        );
        yield* Deferred.await(promptSettled);

        const firstProviderTurnId = idAllocator.derive.providerTurn({
          driver: ACP_TEST_DRIVER,
          nativeTurnId: acpScopedNativeId(instanceId, "mock-session-1:turn:1"),
        });
        yield* runtime.interruptTurn({ providerThread, providerTurnId: firstProviderTurnId });

        let subagentTurnItemId: string | null = null;
        let firstTerminalStatus: string | null = null;
        while (firstTerminalStatus === null) {
          const event = yield* Queue.take(events);
          if (event.type === "turn_item.updated" && event.turnItem.type === "subagent") {
            subagentTurnItemId = event.turnItem.id;
          }
          if (event.type === "turn.terminal" && event.providerTurnId === firstProviderTurnId) {
            firstTerminalStatus = event.status;
          }
        }
        assert.equal(firstTerminalStatus, "interrupted");
        assert.notEqual(subagentTurnItemId, null);

        subagentPhase = "complete";
        const secondNow = yield* DateTime.now;
        yield* runtime.startTurn(
          makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            runtimePolicy,
            now: secondNow,
            ordinal: 2,
          }),
        );
        const secondProviderTurnId = idAllocator.derive.providerTurn({
          driver: ACP_TEST_DRIVER,
          nativeTurnId: acpScopedNativeId(instanceId, "mock-session-1:turn:2"),
        });
        let carriedItemStatus: string | null = null;
        let secondTerminalStatus: string | null = null;
        while (secondTerminalStatus === null) {
          const event = yield* Queue.take(events);
          if (
            event.type === "turn_item.updated" &&
            event.turnItem.type === "subagent" &&
            event.turnItem.id === subagentTurnItemId
          ) {
            carriedItemStatus = event.turnItem.status;
          }
          if (event.type === "turn.terminal" && event.providerTurnId === secondProviderTurnId) {
            secondTerminalStatus = event.status;
          }
        }
        assert.equal(carriedItemStatus, "completed");
        assert.equal(secondTerminalStatus, "completed");
      }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect(
    "projects a child terminal in the completed-root finalization window exactly once",
    () =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const path = yield* Path.Path;
        const selfInvocation = yield* resolveSelfInvocation();
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        const baseClock = yield* Clock.Clock;
        const finalizationClockRead = yield* Deferred.make<void>();
        const releaseFinalizationClockRead = yield* Deferred.make<void>();
        let blockNextClockRead = false;
        const blockingClock: Clock.Clock = {
          ...baseClock,
          currentTimeMillis: Effect.suspend(() => {
            if (!blockNextClockRead) return baseClock.currentTimeMillis;
            blockNextClockRead = false;
            return Deferred.succeed(finalizationClockRead, undefined).pipe(
              Effect.andThen(Deferred.await(releaseFinalizationClockRead)),
              Effect.andThen(baseClock.currentTimeMillis),
            );
          }),
        };
        yield* Effect.gen(function* () {
          const instanceId = ProviderInstanceId.make("acp-test");
          const firstChildSessionId = "mock-child-session-finalize-window-first";
          const secondChildSessionId = "mock-child-session-finalize-window-second";
          let firstSubagentStatus: "running" | "completed" = "running";
          let secondSubagentStatus: "waiting" | "completed" = "waiting";
          type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
          let sessionUpdateHandler:
            | Parameters<RuntimeService["handleSessionUpdate"]>[0]
            | undefined;
          const promptSettled = yield* Deferred.make<void>();
          const adapter = yield* makeAcpAdapterV2({
            testHooks: {
              afterPromptSettledWithBackgroundWork: () =>
                Deferred.succeed(promptSettled, undefined).pipe(Effect.asVoid),
            },
            instanceId,
            flavor: {
              driver: ACP_TEST_DRIVER,
              capabilities: AcpProviderCapabilitiesV2,
              deferFinalizeForBackgroundWork: true,
              enablePostSettleContinuation: true,
              extractSubagentUpdate: (toolCall) => {
                if (toolCall.toolCallId === "tool-call-generic-1") {
                  return {
                    nativeTaskId: "task-finalize-window-first",
                    prompt: "first background subagent",
                    title: "first background subagent",
                    model: null,
                    status: firstSubagentStatus,
                    childSessionId: firstChildSessionId,
                    result: firstSubagentStatus === "completed" ? "FIRST_DONE" : null,
                    suppressNormalTool: true,
                  };
                }
                if (toolCall.toolCallId === "tool-call-generic-2") {
                  return {
                    nativeTaskId: "task-finalize-window-second",
                    prompt: "second background subagent",
                    title: "second background subagent",
                    model: null,
                    status: secondSubagentStatus,
                    childSessionId: secondChildSessionId,
                    result: secondSubagentStatus === "completed" ? "SECOND_DONE" : null,
                    suppressNormalTool: true,
                  } as AcpAdapterV2SubagentUpdate;
                }
                return undefined;
              },
              makeRuntime: makeMockRuntime({
                childProcessSpawner,
                mockAgentPath,
                environment: { T3_ACP_EMIT_GENERIC_TOOL_PLACEHOLDERS: "1" },
                wrapRuntime: (runtime) => ({
                  ...runtime,
                  handleSessionUpdate: (handler) =>
                    Effect.sync(() => {
                      sessionUpdateHandler = handler;
                    }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
                }),
              }),
            },
            selfInvocation,
            continuationRequests: { offer: () => Effect.void },
          });
          const threadId = ThreadId.make("thread-acp-subagent-finalize-window");
          const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: process.cwd(),
          });
          const modelSelection = { instanceId, model: "default" } as const;
          const runtime = yield* adapter.openSession({
            threadId,
            providerSessionId: ProviderSessionId.make(
              "provider-session-acp-subagent-finalize-window",
            ),
            modelSelection,
            runtimePolicy,
          });
          if (runtime.hasPendingBackgroundWork === undefined) {
            return yield* Effect.die(
              "ACP runtime must expose hasPendingBackgroundWork when post-settle continuation is enabled.",
            );
          }
          const hasPendingBackgroundWork = runtime.hasPendingBackgroundWork;
          const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
          yield* runtime.events.pipe(
            Stream.runForEach((event) => Queue.offer(events, event)),
            Effect.forkScoped,
          );
          const providerThread = yield* runtime.ensureThread({
            threadId,
            modelSelection,
            runtimePolicy,
          });
          const now = yield* DateTime.now;
          yield* runtime.startTurn(
            makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now }),
          );
          yield* Deferred.await(promptSettled);
          yield* TestClock.adjust("1 second");
          assert.isDefined(sessionUpdateHandler, "session update handler must be wired");

          firstSubagentStatus = "completed";
          yield* sessionUpdateHandler!({
            sessionId: "mock-session-1",
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "tool-call-generic-1",
              title: "first background subagent",
              kind: "other",
              status: "completed",
              rawOutput: { content: "FIRST_DONE" },
            },
          }).pipe(Effect.provideService(Clock.Clock, blockingClock));
          for (let attempt = 0; attempt < 10; attempt += 1) {
            yield* Effect.yieldNow;
          }

          yield* sessionUpdateHandler!({
            sessionId: "mock-session-1",
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "tool-call-generic-2",
              title: "second background subagent",
              kind: "other",
              status: "in_progress",
              rawOutput: {},
            },
          });
          assert.isTrue(yield* hasPendingBackgroundWork);

          while (Option.isSome(yield* Queue.poll(events))) {}

          blockNextClockRead = true;
          const adjustFiber = yield* TestClock.adjust("3 seconds").pipe(Effect.forkScoped);
          yield* Deferred.await(finalizationClockRead);
          secondSubagentStatus = "completed";
          yield* sessionUpdateHandler!({
            sessionId: secondChildSessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "tool-call-generic-2",
              title: "second background subagent",
              kind: "other",
              status: "completed",
              rawOutput: { content: "SECOND_DONE" },
            },
          });
          yield* Deferred.succeed(releaseFinalizationClockRead, undefined);
          yield* Fiber.join(adjustFiber);
          yield* Effect.yieldNow;
          yield* Effect.yieldNow;

          const providerTurnId = idAllocator.derive.providerTurn({
            driver: ACP_TEST_DRIVER,
            nativeTurnId: acpScopedNativeId(instanceId, "mock-session-1:turn:1"),
          });
          let completedSubagentUpdates = 0;
          let rootTerminalStatus: string | null = null;
          let polled = yield* Queue.poll(events);
          while (Option.isSome(polled)) {
            const event = polled.value;
            if (
              event.type === "turn_item.updated" &&
              event.turnItem.type === "subagent" &&
              event.turnItem.nativeItemRef?.nativeId === "task-finalize-window-second" &&
              event.turnItem.status === "completed"
            ) {
              completedSubagentUpdates += 1;
            }
            if (event.type === "turn.terminal" && event.providerTurnId === providerTurnId) {
              rootTerminalStatus = event.status;
            }
            polled = yield* Queue.poll(events);
          }
          assert.equal(rootTerminalStatus, "completed");
          assert.equal(completedSubagentUpdates, 1);
          assert.isFalse(
            yield* hasPendingBackgroundWork,
            "finalize-window terminal must clear the carryover pin",
          );
        }).pipe(Effect.provideService(Clock.Clock, blockingClock));
      }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("projects completed-root carryover eagerly and drain cannot resurrect it", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const path = yield* Path.Path;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const protocolEvents = yield* Queue.bounded<EffectAcpProtocol.AcpProtocolLogEvent>(256);
      const continuationRequests: Array<ProviderContinuationRequests.ProviderContinuationRequest> =
        [];
      const instanceId = ProviderInstanceId.make("acp-test");
      const childSessionId = "019f44a6-4820-7402-925d-bc862ee711dd";
      let subagentPhase: "spawn" | "complete" = "spawn";
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      let sessionUpdateHandler: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          enablePostSettleContinuation: true,
          normalizeToolCall: normalizeXAiAcpToolCallState,
          extractSubagentUpdate: (toolCall) =>
            extractXAiAcpSubagentUpdate(toolCall) ??
            (toolCall.toolCallId !== "tool-call-generic-1"
              ? undefined
              : subagentPhase === "spawn"
                ? {
                    nativeTaskId: "task-generic-1",
                    prompt: "background subagent",
                    title: "background subagent",
                    model: null,
                    status: "running",
                    childSessionId,
                    result: null,
                  }
                : {
                    nativeTaskId: "task-generic-1",
                    prompt: "",
                    title: null,
                    model: null,
                    status: "completed",
                    childSessionId,
                    result: "SUB_DONE",
                  }),
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            environment: { T3_ACP_EMIT_GENERIC_TOOL_PLACEHOLDERS: "1" },
            protocolEvents,
            wrapRuntime: (runtime) => ({
              ...runtime,
              handleSessionUpdate: (handler) =>
                Effect.sync(() => {
                  sessionUpdateHandler = handler;
                }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
            }),
          }),
        },
        selfInvocation,
        continuationRequests: {
          offer: (request) =>
            Effect.sync(() => {
              continuationRequests.push(request);
            }),
        },
      });
      const threadId = ThreadId.make("thread-acp-completed-root-eager-carryover");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make(
          "provider-session-acp-completed-root-eager-carryover",
        ),
        modelSelection,
        runtimePolicy,
      });
      if (runtime.hasPendingBackgroundWork === undefined) {
        return yield* Effect.die(
          "ACP runtime must expose hasPendingBackgroundWork when post-settle continuation is enabled.",
        );
      }
      const hasPendingBackgroundWork = runtime.hasPendingBackgroundWork;
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      yield* runtime.events.pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped,
      );
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* runtime.startTurn(
        makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now }),
      );
      yield* Stream.fromQueue(protocolEvents).pipe(
        Stream.filter(
          (event) =>
            event.direction === "incoming" &&
            event.stage === "raw" &&
            typeof event.payload === "string" &&
            event.payload.includes('"stopReason"'),
        ),
        Stream.runHead,
      );
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* TestClock.adjust("1 second");

      const firstProviderTurnId = idAllocator.derive.providerTurn({
        driver: ACP_TEST_DRIVER,
        nativeTurnId: acpScopedNativeId(instanceId, "mock-session-1:turn:1"),
      });
      let firstTerminalStatus: string | null = null;
      while (firstTerminalStatus === null) {
        const event = yield* Queue.take(events);
        if (event.type === "turn.terminal" && event.providerTurnId === firstProviderTurnId) {
          firstTerminalStatus = event.status;
        }
      }
      assert.equal(firstTerminalStatus, "completed");
      assert.isTrue(yield* hasPendingBackgroundWork);
      assert.isDefined(sessionUpdateHandler, "session update handler must be wired");

      // Grok reports spawn ACKs as completed tools with running subagents and non-empty prompts.
      yield* sessionUpdateHandler!({
        sessionId: "mock-session-1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tool-call-generic-1",
          title: "spawn_subagent",
          kind: "other",
          status: "completed",
          rawInput: {
            description: "background subagent",
            prompt: "background subagent",
            subagent_type: "general-purpose",
          },
          rawOutput: {
            type: "Text",
            text: [
              "Subagent started in background.",
              `subagent_id: ${childSessionId}`,
              "type: general-purpose",
              "description: background subagent",
              "",
              `Use get_command_or_subagent_output with task_ids=["${childSessionId}"] and timeout_ms to wait for results.`,
            ].join("\n"),
          },
        },
      });

      subagentPhase = "complete";
      yield* sessionUpdateHandler!({
        sessionId: childSessionId,
        update: {
          sessionUpdate: "tool_call_update" as const,
          toolCallId: "tool-call-generic-1",
          title: "background subagent",
          kind: "other" as const,
          status: "completed" as const,
          rawOutput: { content: "SUB_DONE" },
        },
      });
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      let eagerCompletedUpdates = 0;
      let eagerRunningUpdates = 0;
      let polled = yield* Queue.poll(events);
      while (Option.isSome(polled)) {
        const event = polled.value;
        if (event.type === "turn_item.updated" && event.turnItem.type === "subagent") {
          if (event.turnItem.status === "completed") eagerCompletedUpdates += 1;
          if (event.turnItem.status === "running") eagerRunningUpdates += 1;
        }
        polled = yield* Queue.poll(events);
      }
      assert.equal(eagerCompletedUpdates, 1, "completed root must project before any attach");
      assert.equal(eagerRunningUpdates, 0);
      assert.lengthOf(continuationRequests, 1);
      assert.isTrue(yield* hasPendingBackgroundWork, "buffered spawn ACK still requires a drain");

      const continuationNow = yield* DateTime.now;
      const continuationInput = makeTurnInput({
        threadId,
        providerThread,
        instanceId,
        runtimePolicy,
        now: continuationNow,
        ordinal: 2,
        messageCreatedBy: "agent",
        messageCreationSource: "provider",
        messageText: "Background task completed.",
      });
      yield* runtime.startTurn(continuationInput);
      yield* Effect.yieldNow;
      let replayedLineages = 0;
      let replayedSubagentUpdates = 0;
      let replayedTurnItems = 0;
      polled = yield* Queue.poll(events);
      while (Option.isSome(polled)) {
        const event = polled.value;
        if (event.type === "app_thread.created") {
          replayedLineages += 1;
        }
        if (event.type === "subagent.updated" && event.subagent.runId === continuationInput.runId) {
          replayedSubagentUpdates += 1;
        }
        if (
          event.type === "turn_item.updated" &&
          event.turnItem.runId === continuationInput.runId
        ) {
          replayedTurnItems += 1;
        }
        polled = yield* Queue.poll(events);
      }
      assert.equal(replayedLineages, 0, "buffered spawn ACK must not create a second lineage");
      assert.equal(
        replayedSubagentUpdates,
        0,
        "buffered spawn ACK must not re-open the terminal subagent",
      );
      assert.equal(
        replayedTurnItems,
        0,
        "buffered spawn ACK must not create a continuation-owned turn item",
      );
      assert.isFalse(yield* hasPendingBackgroundWork);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect(
    "user attach flushes a deferred terminal but leaves wake traffic for its continuation",
    () =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const path = yield* Path.Path;
        const selfInvocation = yield* resolveSelfInvocation();
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        const continuationRequests: Array<ProviderContinuationRequests.ProviderContinuationRequest> =
          [];
        const bufferedAssistantText = "BUFFERED_WAKE_AFTER_USER_ATTACH";
        const instanceId = ProviderInstanceId.make("acp-test");
        let subagentPhase: "spawn" | "complete" = "spawn";
        type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
        let sessionUpdateHandler: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
        const promptSettled = yield* Deferred.make<void>();
        const adapter = yield* makeAcpAdapterV2({
          testHooks: {
            afterPromptSettledWithBackgroundWork: () =>
              Deferred.succeed(promptSettled, undefined).pipe(Effect.asVoid),
          },
          instanceId,
          flavor: {
            driver: ACP_TEST_DRIVER,
            capabilities: AcpProviderCapabilitiesV2,
            deferFinalizeForBackgroundWork: true,
            enablePostSettleContinuation: true,
            extractSubagentUpdate: (toolCall) =>
              toolCall.toolCallId !== "tool-call-generic-1"
                ? undefined
                : subagentPhase === "spawn"
                  ? {
                      nativeTaskId: "task-generic-1",
                      prompt: "background subagent",
                      title: "background subagent",
                      model: null,
                      status: "running",
                      childSessionId: null,
                      result: null,
                    }
                  : {
                      nativeTaskId: "task-generic-1",
                      prompt: "",
                      title: null,
                      model: null,
                      status: "completed",
                      childSessionId: null,
                      result: "SUB_DONE",
                    },
            makeRuntime: makeMockRuntime({
              childProcessSpawner,
              mockAgentPath,
              environment: { T3_ACP_EMIT_GENERIC_TOOL_PLACEHOLDERS: "1" },
              wrapRuntime: (runtime) => ({
                ...runtime,
                handleSessionUpdate: (handler) =>
                  Effect.sync(() => {
                    sessionUpdateHandler = handler;
                  }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
              }),
            }),
          },
          selfInvocation,
          continuationRequests: {
            offer: (request) =>
              Effect.sync(() => {
                continuationRequests.push(request);
              }),
          },
        });
        const threadId = ThreadId.make("thread-acp-carryover-root-session-continuation");
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const modelSelection = { instanceId, model: "default" } as const;
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make(
            "provider-session-acp-carryover-root-session-continuation",
          ),
          modelSelection,
          runtimePolicy,
        });
        if (runtime.hasPendingBackgroundWork === undefined) {
          return yield* Effect.die(
            "ACP runtime must expose hasPendingBackgroundWork when post-settle continuation is enabled.",
          );
        }
        const hasPendingBackgroundWork = runtime.hasPendingBackgroundWork;
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        yield* runtime.events.pipe(
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkScoped,
        );
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        yield* runtime.startTurn(
          makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now }),
        );
        yield* Deferred.await(promptSettled);

        const firstProviderTurnId = idAllocator.derive.providerTurn({
          driver: ACP_TEST_DRIVER,
          nativeTurnId: acpScopedNativeId(instanceId, "mock-session-1:turn:1"),
        });
        yield* runtime.interruptTurn({ providerThread, providerTurnId: firstProviderTurnId });

        let firstTerminalStatus: string | null = null;
        while (firstTerminalStatus === null) {
          const event = yield* Queue.take(events);
          if (event.type === "turn.terminal" && event.providerTurnId === firstProviderTurnId) {
            firstTerminalStatus = event.status;
          }
        }
        assert.equal(firstTerminalStatus, "interrupted");
        assert.isTrue(
          yield* hasPendingBackgroundWork,
          "carryover live subagent must pin hasPendingBackgroundWork after root settle",
        );
        const refusedReplacement = yield* runtime
          .ensureThread({
            threadId,
            modelSelection,
            runtimePolicy,
            existingProviderThread: { ...providerThread, nativeThreadRef: null },
            forceNewNativeThread: true,
          })
          .pipe(Effect.flip);
        assert.equal(refusedReplacement._tag, "ProviderAdapterEnsureThreadError");
        const preserved = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
        assert.equal(preserved.nativeThreadRef?.nativeId, providerThread.nativeThreadRef?.nativeId);
        assert.isTrue(yield* hasPendingBackgroundWork);
        assert.isDefined(sessionUpdateHandler, "session update handler must be wired");

        subagentPhase = "complete";
        yield* sessionUpdateHandler!({
          sessionId: "mock-session-1",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tool-call-generic-1",
            title: "background subagent",
            kind: "other",
            status: "completed",
            rawOutput: { content: "SUB_DONE" },
          },
        });
        yield* sessionUpdateHandler!({
          sessionId: "mock-session-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: bufferedAssistantText },
          },
        });
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;

        let completedBeforeDrain = 0;
        let polled = yield* Queue.poll(events);
        while (Option.isSome(polled)) {
          const event = polled.value;
          if (
            event.type === "turn_item.updated" &&
            event.turnItem.type === "subagent" &&
            event.turnItem.status === "completed"
          ) {
            completedBeforeDrain += 1;
          }
          polled = yield* Queue.poll(events);
        }
        assert.equal(
          completedBeforeDrain,
          0,
          "interrupted root-session terminal must wait for an observable attach",
        );
        assert.lengthOf(
          continuationRequests,
          1,
          "root-session post-settle subagent terminal must offer a continuation",
        );
        assert.isTrue(
          yield* hasPendingBackgroundWork,
          "interrupted unprojected terminal must pin hasPendingBackgroundWork until attach",
        );

        const userTurnNow = yield* DateTime.now;
        yield* runtime.startTurn(
          makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            runtimePolicy,
            now: userTurnNow,
            ordinal: 2,
            messageText: "What finished while the prior turn was settling?",
          }),
        );
        yield* TestClock.adjust("3 seconds");
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;

        const userProviderTurnId = idAllocator.derive.providerTurn({
          driver: ACP_TEST_DRIVER,
          nativeTurnId: acpScopedNativeId(instanceId, "mock-session-1:turn:2"),
        });
        let userTurnTerminal: string | null = null;
        let completedSubagentTurnItems = 0;
        let bufferedTextSeenInUserTurn = false;
        while (userTurnTerminal === null) {
          const event = yield* Queue.take(events);
          if (
            event.type === "turn_item.updated" &&
            event.turnItem.type === "subagent" &&
            event.turnItem.status === "completed"
          ) {
            completedSubagentTurnItems += 1;
          }
          if (
            event.type === "message.updated" &&
            event.message.role === "assistant" &&
            event.message.text.includes(bufferedAssistantText)
          ) {
            bufferedTextSeenInUserTurn = true;
          }
          if (event.type === "turn.terminal" && event.providerTurnId === userProviderTurnId) {
            userTurnTerminal = event.status;
          }
        }
        assert.equal(userTurnTerminal, "completed");
        assert.equal(
          completedSubagentTurnItems,
          1,
          "user attach must project the deferred terminal subagent turn item once",
        );
        assert.isFalse(bufferedTextSeenInUserTurn, "user attach must not drain wake traffic");
        assert.isTrue(
          yield* hasPendingBackgroundWork,
          "wake traffic must remain pinned for the already-dispatched continuation",
        );

        const continuationNow = yield* DateTime.now;
        yield* runtime.startTurn(
          makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            runtimePolicy,
            now: continuationNow,
            ordinal: 3,
            messageCreatedBy: "agent",
            messageCreationSource: "provider",
            messageText: "Background task completed.",
          }),
        );
        yield* TestClock.adjust("3 seconds");
        const continuationProviderTurnId = idAllocator.derive.providerTurn({
          driver: ACP_TEST_DRIVER,
          nativeTurnId: acpScopedNativeId(instanceId, "mock-session-1:turn:3"),
        });
        let continuationTerminal: string | null = null;
        let bufferedTextSeenInContinuation = false;
        while (continuationTerminal === null) {
          const event = yield* Queue.take(events);
          if (
            event.type === "message.updated" &&
            event.message.role === "assistant" &&
            event.message.text.includes(bufferedAssistantText)
          ) {
            bufferedTextSeenInContinuation = true;
          }
          if (
            event.type === "turn.terminal" &&
            event.providerTurnId === continuationProviderTurnId
          ) {
            continuationTerminal = event.status;
          }
        }
        assert.equal(continuationTerminal, "completed");
        assert.isTrue(
          bufferedTextSeenInContinuation,
          "queued continuation must drain the wake content after the user run",
        );
        assert.isFalse(yield* hasPendingBackgroundWork);
      }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect(
    "preserveRuntimeOnSettledInterrupt keeps the process alive and carries subagents through a settled steering interrupt",
    () =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const path = yield* Path.Path;
        const selfInvocation = yield* resolveSelfInvocation();
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        const instanceId = ProviderInstanceId.make("acp-test");
        let subagentPhase: "spawn" | "complete" = "spawn";
        let cancelCalled = false;
        let runtimeOrdinalSeen = 0;
        const promptSettled = yield* Deferred.make<void>();
        const adapter = yield* makeAcpAdapterV2({
          testHooks: {
            afterPromptSettledWithBackgroundWork: () =>
              Deferred.succeed(promptSettled, undefined).pipe(Effect.asVoid),
          },
          instanceId,
          flavor: {
            driver: ACP_TEST_DRIVER,
            capabilities: AcpProviderCapabilitiesV2,
            deferFinalizeForBackgroundWork: true,
            restartRuntimeAfterInterrupt: true,
            restartRuntimeOnEveryInterrupt: true,
            terminateRuntimeProcessGroupOnInterrupt: true,
            preserveRuntimeOnSettledInterrupt: true,
            extractSubagentUpdate: (toolCall) =>
              toolCall.toolCallId !== "tool-call-generic-1"
                ? undefined
                : subagentPhase === "spawn"
                  ? {
                      nativeTaskId: "task-generic-1",
                      prompt: "background subagent",
                      title: "background subagent",
                      model: null,
                      status: "running",
                      childSessionId: null,
                      result: null,
                    }
                  : {
                      nativeTaskId: "task-generic-1",
                      prompt: "",
                      title: null,
                      model: null,
                      status: "completed",
                      childSessionId: null,
                      result: "SUB_DONE",
                    },
            makeRuntime: makeMockRuntime({
              childProcessSpawner,
              mockAgentPath,
              environment: (runtimeOrdinal) => {
                runtimeOrdinalSeen = Math.max(runtimeOrdinalSeen, runtimeOrdinal);
                return { T3_ACP_EMIT_GENERIC_TOOL_PLACEHOLDERS: "1" };
              },
              wrapCancel: (cancel) =>
                Effect.sync(() => {
                  cancelCalled = true;
                }).pipe(Effect.andThen(cancel)),
            }),
          },
          selfInvocation,
        });
        const threadId = ThreadId.make("thread-acp-settled-soft-steer");
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const modelSelection = { instanceId, model: "default" } as const;
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-acp-settled-soft-steer"),
          modelSelection,
          runtimePolicy,
        });
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        yield* runtime.events.pipe(
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkScoped,
        );
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        yield* runtime.startTurn(
          makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now }),
        );
        yield* Deferred.await(promptSettled);

        const firstProviderTurnId = idAllocator.derive.providerTurn({
          driver: ACP_TEST_DRIVER,
          nativeTurnId: acpScopedNativeId(instanceId, "mock-session-1:turn:1"),
        });
        yield* runtime.interruptTurn({ providerThread, providerTurnId: firstProviderTurnId });
        assert.isFalse(
          cancelCalled,
          "settled soft steer must not send session/cancel (the real Grok CLI kills background subagents on cancel)",
        );

        let subagentTurnItemId: string | null = null;
        let firstTerminalStatus: string | null = null;
        while (firstTerminalStatus === null) {
          const event = yield* Queue.take(events);
          if (event.type === "turn_item.updated" && event.turnItem.type === "subagent") {
            subagentTurnItemId = event.turnItem.id;
          }
          if (event.type === "turn.terminal" && event.providerTurnId === firstProviderTurnId) {
            firstTerminalStatus = event.status;
          }
        }
        assert.equal(firstTerminalStatus, "interrupted");
        assert.notEqual(subagentTurnItemId, null);

        subagentPhase = "complete";
        const secondNow = yield* DateTime.now;
        yield* runtime.startTurn(
          makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            runtimePolicy,
            now: secondNow,
            ordinal: 2,
          }),
        );
        const secondProviderTurnId = idAllocator.derive.providerTurn({
          driver: ACP_TEST_DRIVER,
          nativeTurnId: acpScopedNativeId(instanceId, "mock-session-1:turn:2"),
        });
        let carriedItemStatus: string | null = null;
        let secondTerminalStatus: string | null = null;
        while (secondTerminalStatus === null) {
          const event = yield* Queue.take(events);
          if (
            event.type === "turn_item.updated" &&
            event.turnItem.type === "subagent" &&
            event.turnItem.id === subagentTurnItemId
          ) {
            carriedItemStatus = event.turnItem.status;
          }
          if (event.type === "turn.terminal" && event.providerTurnId === secondProviderTurnId) {
            secondTerminalStatus = event.status;
          }
        }
        assert.equal(carriedItemStatus, "completed");
        assert.equal(secondTerminalStatus, "completed");
        assert.equal(
          runtimeOrdinalSeen,
          1,
          "settled soft steer must not respawn the ACP runtime process",
        );
      }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live("preserveRuntimeOnSettledInterrupt does not soften a mid-prompt steering interrupt", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const path = yield* Path.Path;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const protocolEvents = yield* Queue.bounded<EffectAcpProtocol.AcpProtocolLogEvent>(256);
      const instanceId = ProviderInstanceId.make("acp-test");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          restartRuntimeAfterInterrupt: true,
          restartRuntimeOnEveryInterrupt: true,
          terminateRuntimeProcessGroupOnInterrupt: true,
          preserveRuntimeOnSettledInterrupt: true,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            environment: { T3_ACP_HANG_PROMPT_FOREVER: "1" },
            protocolEvents,
          }),
        },
        selfInvocation,
      });
      const threadId = ThreadId.make("thread-acp-unsettled-steer-stays-hard");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make(
          "provider-session-acp-unsettled-steer-stays-hard",
        ),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* runtime
        .startTurn(
          makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now, ordinal: 1 }),
        )
        .pipe(Effect.forkScoped);
      yield* Stream.fromQueue(protocolEvents).pipe(
        Stream.filter(
          (event) =>
            event.direction === "outgoing" && rawProtocolMethod(event) === "session/prompt",
        ),
        Stream.runHead,
      );
      const providerTurnId = idAllocator.derive.providerTurn({
        driver: ACP_TEST_DRIVER,
        nativeTurnId: acpScopedNativeId(instanceId, "mock-session-1:turn:1"),
      });
      const interruptExit = yield* runtime
        .interruptTurn({ providerThread, providerTurnId })
        .pipe(Effect.exit);
      if (Exit.isSuccess(interruptExit)) {
        assert.fail("mid-prompt steering interrupt must still take the hard teardown path");
      }
      assert.include(Cause.pretty(interruptExit.cause), "session is poisoned");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live("direct Stop quarantine drops late background task mutations from the stopped run", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const path = yield* Path.Path;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const protocolEvents = yield* Queue.bounded<EffectAcpProtocol.AcpProtocolLogEvent>(256);
      const instanceId = ProviderInstanceId.make("acp-test");
      const capturedMutation: {
        current:
          | ((mutation: {
              readonly sessionId: string;
              readonly taskId: string;
              readonly status: "running" | "completed" | "failed";
            }) => Effect.Effect<void>)
          | null;
      } = { current: null };
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          enablePostSettleContinuation: true,
          restartRuntimeAfterInterrupt: true,
          terminateRuntimeProcessGroupOnInterrupt: true,
          preserveRuntimeOnSettledInterrupt: true,
          registerExtensions: (context) =>
            Effect.sync(() => {
              capturedMutation.current = context.applyBackgroundTaskMutation;
            }),
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            environment: { T3_ACP_HANG_PROMPT_FOREVER: "1" },
            ownDetachedProcessGroup: true,
            protocolEvents,
          }),
        },
        selfInvocation,
        continuationRequests: { offer: () => Effect.void },
      });
      const threadId = ThreadId.make("thread-acp-stop-quarantine-late-task");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-stop-quarantine-late-task"),
        modelSelection,
        runtimePolicy,
      });
      if (runtime.hasPendingBackgroundWork === undefined) {
        return yield* Effect.die(
          "ACP runtime must expose hasPendingBackgroundWork when post-settle continuation is enabled.",
        );
      }
      const hasPendingBackgroundWork = runtime.hasPendingBackgroundWork;
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      yield* runtime.events.pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped,
      );
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* runtime
        .startTurn(
          makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now, ordinal: 1 }),
        )
        .pipe(Effect.forkScoped);
      yield* Stream.fromQueue(protocolEvents).pipe(
        Stream.filter(
          (event) =>
            event.direction === "outgoing" && rawProtocolMethod(event) === "session/prompt",
        ),
        Stream.runHead,
      );
      const applyMutation = capturedMutation.current;
      if (applyMutation === null) {
        return yield* Effect.die("registerExtensions must capture applyBackgroundTaskMutation");
      }
      yield* applyMutation({
        sessionId: "mock-session-1",
        taskId: "task-pre-stop",
        status: "running",
      });
      assert.isTrue(
        yield* hasPendingBackgroundWork,
        "a running background task mutation on the root session must track before Stop",
      );
      yield* applyMutation({
        sessionId: "mock-session-1",
        taskId: "task-pre-stop",
        status: "completed",
      });
      assert.isFalse(
        yield* hasPendingBackgroundWork,
        "a completed background task mutation must clear pending background work",
      );

      const providerTurnId = idAllocator.derive.providerTurn({
        driver: ACP_TEST_DRIVER,
        nativeTurnId: acpScopedNativeId(instanceId, "mock-session-1:turn:1"),
      });
      yield* runtime.interruptTurn({ providerThread, providerTurnId, requestRuntimeRestart: true });
      let terminalStatus: string | null = null;
      while (terminalStatus === null) {
        const event = yield* Queue.take(events);
        if (event.type === "turn.terminal" && event.providerTurnId === providerTurnId) {
          terminalStatus = event.status;
        }
      }
      assert.equal(terminalStatus, "interrupted");

      yield* applyMutation({
        sessionId: "mock-session-1",
        taskId: "task-late-after-stop",
        status: "running",
      });
      assert.isFalse(
        yield* hasPendingBackgroundWork,
        "direct Stop quarantine must drop residual background task mutations from the stopped run",
      );
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect(
    "does not pin hasPendingBackgroundWork when a late TaskOutput re-reports an in-turn-handled task",
    () =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const path = yield* Path.Path;
        const selfInvocation = yield* resolveSelfInvocation();
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        const protocolEvents = yield* Queue.bounded<EffectAcpProtocol.AcpProtocolLogEvent>(256);
        const continuationRequests: Array<ProviderContinuationRequests.ProviderContinuationRequest> =
          [];
        const instanceId = ProviderInstanceId.make("acp-test");
        const adapter = yield* makeAcpAdapterV2({
          instanceId,
          flavor: {
            driver: ACP_TEST_DRIVER,
            capabilities: AcpProviderCapabilitiesV2,
            enablePostSettleContinuation: true,
            extractBackgroundTaskId: (toolCall) =>
              toolCall.toolCallId === "tool-call-monitor-1" ? "task-monitor-1" : undefined,
            extractBackgroundTaskCompletion: (toolCall) =>
              toolCall.toolCallId === "tool-call-fetch-1"
                ? [
                    {
                      taskId: "task-monitor-1",
                      status: toolCall.status === "completed" ? "completed" : "running",
                      appendOutput: toolCall.status === "completed" ? "MONITOR_LISTING_TOKEN" : "",
                    },
                  ]
                : [],
            makeRuntime: makeMockRuntime({
              childProcessSpawner,
              mockAgentPath,
              environment: {
                T3_ACP_EMIT_IN_TURN_TASKOUTPUT_THEN_LATE_DUPLICATE: "1",
              },
              protocolEvents,
            }),
          },
          selfInvocation,
          continuationRequests: {
            offer: (request) =>
              Effect.sync(() => {
                continuationRequests.push(request);
              }),
          },
        });
        const threadId = ThreadId.make("thread-acp-already-handled-wake-pin");
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const modelSelection = { instanceId, model: "default" } as const;
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make(
            "provider-session-acp-already-handled-wake-pin",
          ),
          modelSelection,
          runtimePolicy,
        });
        if (runtime.hasPendingBackgroundWork === undefined) {
          return yield* Effect.die(
            "ACP runtime must expose hasPendingBackgroundWork when post-settle continuation is enabled.",
          );
        }
        const hasPendingBackgroundWork = runtime.hasPendingBackgroundWork;
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        yield* runtime.events.pipe(
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkScoped,
        );
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        yield* runtime.startTurn(
          makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now }),
        );
        const providerTurnId = idAllocator.derive.providerTurn({
          driver: ACP_TEST_DRIVER,
          nativeTurnId: acpScopedNativeId(instanceId, "mock-session-1:turn:1"),
        });

        let terminalStatus: string | null = null;
        while (terminalStatus === null) {
          const event = yield* Queue.take(events);
          if (event.type === "turn.terminal" && event.providerTurnId === providerTurnId) {
            terminalStatus = event.status;
          }
        }
        assert.equal(terminalStatus, "completed");

        yield* Stream.fromQueue(protocolEvents).pipe(
          Stream.filter(
            (event) =>
              event.direction === "incoming" &&
              event.stage === "raw" &&
              typeof event.payload === "string" &&
              event.payload.includes("MONITOR_LISTING_TOKEN_LATE"),
          ),
          Stream.runHead,
        );
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;

        assert.lengthOf(
          continuationRequests,
          0,
          "already-handled late TaskOutput must not open a continuation run",
        );
        assert.isFalse(
          yield* hasPendingBackgroundWork,
          "wake buffer must not stay non-empty and pin idle release after an already-handled re-report",
        );
      }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("keeps a buffered continuation current when a user turn starts before dispatch", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const path = yield* Path.Path;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const continuationRequests: Array<ProviderContinuationRequests.ProviderContinuationRequest> =
        [];
      const userPromptStarted = yield* Deferred.make<void>();
      const releaseUserPrompt = yield* Deferred.make<void>();
      const bufferedAssistantText = "BUFFERED_WAKE_QUEUED_AFTER_USER";
      let promptOrdinal = 0;
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      let sessionUpdateHandler: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
      const instanceId = ProviderInstanceId.make("acp-test");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          deferFinalizeForBackgroundWork: true,
          enablePostSettleContinuation: true,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            wrapRuntime: (runtime) => ({
              ...runtime,
              handleSessionUpdate: (handler) =>
                Effect.sync(() => {
                  sessionUpdateHandler = handler;
                }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
              prompt: (payload) =>
                Effect.gen(function* () {
                  promptOrdinal += 1;
                  const currentPromptOrdinal = promptOrdinal;
                  const result = yield* runtime.prompt(payload);
                  if (currentPromptOrdinal === 2) {
                    yield* Deferred.succeed(userPromptStarted, undefined);
                    yield* Deferred.await(releaseUserPrompt);
                  }
                  return result;
                }),
            }),
          }),
        },
        selfInvocation,
        continuationRequests: {
          offer: (request) =>
            Effect.sync(() => {
              continuationRequests.push(request);
            }),
        },
      });
      const threadId = ThreadId.make("thread-acp-buffered-continuation-user-race");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make(
          "provider-session-acp-buffered-continuation-user-race",
        ),
        modelSelection,
        runtimePolicy,
      });
      if (runtime.hasPendingBackgroundWork === undefined) {
        return yield* Effect.die(
          "ACP runtime must expose hasPendingBackgroundWork when post-settle continuation is enabled.",
        );
      }
      const hasPendingBackgroundWork = runtime.hasPendingBackgroundWork;
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      yield* runtime.events.pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped,
      );
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          now: yield* DateTime.now,
        }),
      );
      const firstProviderTurnId = idAllocator.derive.providerTurn({
        driver: ACP_TEST_DRIVER,
        nativeTurnId: acpScopedNativeId(instanceId, "mock-session-1:turn:1"),
      });
      let firstTerminalStatus: string | null = null;
      while (firstTerminalStatus === null) {
        const event = yield* Queue.take(events);
        if (event.type === "turn.terminal" && event.providerTurnId === firstProviderTurnId) {
          firstTerminalStatus = event.status;
        }
      }
      assert.equal(firstTerminalStatus, "completed");
      assert.isDefined(sessionUpdateHandler, "session update handler must be wired");

      yield* sessionUpdateHandler!({
        sessionId: "mock-session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: bufferedAssistantText },
        },
      });
      assert.lengthOf(continuationRequests, 1);
      const continuationRequest = continuationRequests[0]!;
      assert.isDefined(continuationRequest.dispatchIfCurrent);

      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          now: yield* DateTime.now,
          ordinal: 2,
          messageText: "User turn won the continuation dispatch race.",
        }),
      );
      yield* Deferred.await(userPromptStarted);
      let continuationDispatched = false;
      const dispatchOutcome = yield* continuationRequest.dispatchIfCurrent!(
        Effect.sync(() => {
          continuationDispatched = true;
        }),
      );
      assert.isTrue(
        Option.isSome(dispatchOutcome),
        "queue_after_active dispatch must remain current while the user run is active",
      );
      assert.isTrue(continuationDispatched);
      yield* Deferred.succeed(releaseUserPrompt, undefined);

      const userProviderTurnId = idAllocator.derive.providerTurn({
        driver: ACP_TEST_DRIVER,
        nativeTurnId: acpScopedNativeId(instanceId, "mock-session-1:turn:2"),
      });
      let userTerminalStatus: string | null = null;
      while (userTerminalStatus === null) {
        const event = yield* Queue.take(events);
        if (event.type === "turn.terminal" && event.providerTurnId === userProviderTurnId) {
          userTerminalStatus = event.status;
        }
      }
      assert.equal(userTerminalStatus, "completed");
      assert.isTrue(
        yield* hasPendingBackgroundWork,
        "the queued continuation must retain ownership of its buffered wake traffic",
      );

      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          now: yield* DateTime.now,
          ordinal: 3,
          messageCreatedBy: "agent",
          messageCreationSource: "provider",
          messageText: "Background task completed.",
        }),
      );
      yield* TestClock.adjust("3 seconds");
      const continuationProviderTurnId = idAllocator.derive.providerTurn({
        driver: ACP_TEST_DRIVER,
        nativeTurnId: acpScopedNativeId(instanceId, "mock-session-1:turn:3"),
      });
      let continuationTerminalStatus: string | null = null;
      let bufferedTextSeen = false;
      while (continuationTerminalStatus === null) {
        const event = yield* Queue.take(events);
        if (
          event.type === "message.updated" &&
          event.message.role === "assistant" &&
          event.message.text.includes(bufferedAssistantText)
        ) {
          bufferedTextSeen = true;
        }
        if (event.type === "turn.terminal" && event.providerTurnId === continuationProviderTurnId) {
          continuationTerminalStatus = event.status;
        }
      }
      assert.equal(continuationTerminalStatus, "completed");
      assert.isTrue(bufferedTextSeen, "continuation must drain the wake buffer after the user run");
      assert.isFalse(yield* hasPendingBackgroundWork);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect(
    "staggered pre-settle completion keeps midTurn marks until last background task ends post-finalize",
    () =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const path = yield* Path.Path;
        const selfInvocation = yield* resolveSelfInvocation();
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        const protocolEvents = yield* Queue.bounded<EffectAcpProtocol.AcpProtocolLogEvent>(256);
        const continuationRequests: Array<ProviderContinuationRequests.ProviderContinuationRequest> =
          [];
        type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
        let sessionUpdateHandler: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
        const promptGate = yield* Deferred.make<EffectAcpSchema.PromptResponse>();
        const capturedMutation: {
          current:
            | ((mutation: {
                readonly sessionId: string;
                readonly taskId: string;
                readonly status: "running" | "completed" | "failed";
              }) => Effect.Effect<void>)
            | null;
        } = { current: null };
        const instanceId = ProviderInstanceId.make("acp-test");
        const adapter = yield* makeAcpAdapterV2({
          instanceId,
          flavor: {
            driver: ACP_TEST_DRIVER,
            capabilities: AcpProviderCapabilitiesV2,
            enablePostSettleContinuation: true,
            extractBackgroundTaskId: (toolCall) => {
              if (toolCall.toolCallId === "tool-call-monitor-a") return "task-monitor-a";
              if (toolCall.toolCallId === "tool-call-monitor-b") return "task-monitor-b";
              return undefined;
            },
            extractBackgroundToolMutation: (text) => {
              if (text.includes('Monitor "task-monitor-a" ended')) {
                return [{ taskId: "task-monitor-a", status: "completed", appendOutput: "" }];
              }
              if (text.includes('Monitor "task-monitor-b" ended')) {
                return [{ taskId: "task-monitor-b", status: "completed", appendOutput: "" }];
              }
              return [];
            },
            registerExtensions: (context) =>
              Effect.sync(() => {
                capturedMutation.current = context.applyBackgroundTaskMutation;
              }),
            makeRuntime: makeMockRuntime({
              childProcessSpawner,
              mockAgentPath,
              environment: { T3_ACP_HANG_PROMPT_FOREVER: "1" },
              protocolEvents,
              wrapRuntime: (runtime) => ({
                ...runtime,
                handleSessionUpdate: (handler) =>
                  Effect.sync(() => {
                    sessionUpdateHandler = handler;
                  }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
                prompt: () => Deferred.await(promptGate),
              }),
            }),
          },
          selfInvocation,
          continuationRequests: {
            offer: (request) =>
              Effect.sync(() => {
                continuationRequests.push(request);
              }),
          },
        });
        const threadId = ThreadId.make("thread-acp-staggered-midturn-keep-until-last");
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const modelSelection = { instanceId, model: "default" } as const;
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make(
            "provider-session-acp-staggered-midturn-keep-until-last",
          ),
          modelSelection,
          runtimePolicy,
        });
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        yield* runtime.events.pipe(
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkScoped,
        );
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        yield* runtime
          .startTurn(
            makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now, ordinal: 1 }),
          )
          .pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        assert.isDefined(sessionUpdateHandler);
        const applyMutation = capturedMutation.current;
        if (applyMutation === null) {
          return yield* Effect.die("registerExtensions must capture applyBackgroundTaskMutation");
        }

        for (const [toolCallId, title] of [
          ["tool-call-monitor-a", "Monitor: staggered A"],
          ["tool-call-monitor-b", "Monitor: staggered B"],
        ] as const) {
          yield* sessionUpdateHandler!({
            sessionId: "mock-session-1",
            update: {
              sessionUpdate: "tool_call",
              toolCallId,
              title,
              kind: "execute",
              status: "pending",
              rawInput: {},
            },
          });
          yield* sessionUpdateHandler!({
            sessionId: "mock-session-1",
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId,
              status: "in_progress",
            },
          });
        }
        yield* applyMutation({
          sessionId: "mock-session-1",
          taskId: "task-monitor-a",
          status: "running",
        });
        yield* applyMutation({
          sessionId: "mock-session-1",
          taskId: "task-monitor-b",
          status: "running",
        });
        yield* applyMutation({
          sessionId: "mock-session-1",
          taskId: "task-monitor-a",
          status: "completed",
        });
        assert.lengthOf(
          continuationRequests,
          0,
          "pre-settle unhandled completion must not offer while the turn is active",
        );

        yield* Deferred.succeed(promptGate, { stopReason: "end_turn" });
        const providerTurnId = idAllocator.derive.providerTurn({
          driver: ACP_TEST_DRIVER,
          nativeTurnId: acpScopedNativeId(instanceId, "mock-session-1:turn:1"),
        });
        let terminalStatus: string | null = null;
        while (terminalStatus === null) {
          const event = yield* Queue.take(events);
          if (event.type === "turn.terminal" && event.providerTurnId === providerTurnId) {
            terminalStatus = event.status;
          }
        }
        assert.equal(terminalStatus, "completed");
        assert.lengthOf(
          continuationRequests,
          0,
          "finalize must not offer while B is still running",
        );

        const bEndNotice = {
          sessionId: "mock-session-1",
          update: {
            sessionUpdate: "user_message_chunk" as const,
            content: {
              type: "text" as const,
              text: 'Monitor "task-monitor-b" ended: [monitor ended: exit 0]',
            },
          },
        };
        assert.isFalse(
          acpPostSettleWakeEvidence(bEndNotice, {
            extractBackgroundToolMutation: (text) =>
              text.includes('Monitor "task-monitor-b" ended')
                ? [{ taskId: "task-monitor-b", status: "completed", appendOutput: "" }]
                : [],
          }),
          "mutation-only end-notice must not count as post-settle wake evidence",
        );
        yield* sessionUpdateHandler!(bEndNotice);
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        assert.lengthOf(
          continuationRequests,
          1,
          "exactly one continuation when the last running task ends post-finalize with kept midTurn marks",
        );
      }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect(
    "two-turn in-turn monitors never open a wake run or retain turn-1 injected-turn ack chatter",
    () =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const path = yield* Path.Path;
        const selfInvocation = yield* resolveSelfInvocation();
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        const protocolEvents = yield* Queue.bounded<EffectAcpProtocol.AcpProtocolLogEvent>(256);
        const continuationRequests: Array<ProviderContinuationRequests.ProviderContinuationRequest> =
          [];
        type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
        let sessionUpdateHandler: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
        const promptGates: Array<Deferred.Deferred<EffectAcpSchema.PromptResponse, never>> = [];
        const promptStarted = yield* Queue.unbounded<void>();
        const capturedMutation: {
          current:
            | ((mutation: {
                readonly sessionId: string;
                readonly taskId: string;
                readonly status: "running" | "completed" | "failed";
              }) => Effect.Effect<void>)
            | null;
        } = { current: null };
        const instanceId = ProviderInstanceId.make("acp-test");
        const adapter = yield* makeAcpAdapterV2({
          instanceId,
          flavor: {
            driver: ACP_TEST_DRIVER,
            capabilities: AcpProviderCapabilitiesV2,
            enablePostSettleContinuation: true,
            extractBackgroundTaskId: (toolCall) => {
              if (toolCall.toolCallId === "tool-call-monitor-1") return "task-monitor-1";
              if (toolCall.toolCallId === "tool-call-monitor-2") return "task-monitor-2";
              return undefined;
            },
            extractBackgroundToolMutation: (text) => {
              if (text.includes('Monitor "task-monitor-1" ended')) {
                return [{ taskId: "task-monitor-1", status: "completed", appendOutput: "" }];
              }
              if (text.includes('Monitor "task-monitor-2" ended')) {
                return [{ taskId: "task-monitor-2", status: "completed", appendOutput: "" }];
              }
              return [];
            },
            extractBackgroundTaskCompletion: (toolCall) => {
              if (toolCall.toolCallId === "tool-call-fetch-1") {
                return [
                  {
                    taskId: "task-monitor-1",
                    status: toolCall.status === "completed" ? "completed" : "running",
                    appendOutput: toolCall.status === "completed" ? "MONITOR_LISTING_TOKEN" : "",
                  },
                ];
              }
              if (toolCall.toolCallId === "tool-call-fetch-2") {
                return [
                  {
                    taskId: "task-monitor-2",
                    status: toolCall.status === "completed" ? "completed" : "running",
                    appendOutput: toolCall.status === "completed" ? "MONITOR_LISTING_TOKEN_2" : "",
                  },
                ];
              }
              return [];
            },
            registerExtensions: (context) =>
              Effect.sync(() => {
                capturedMutation.current = context.applyBackgroundTaskMutation;
              }),
            makeRuntime: makeMockRuntime({
              childProcessSpawner,
              mockAgentPath,
              environment: { T3_ACP_HANG_PROMPT_FOREVER: "1" },
              protocolEvents,
              wrapRuntime: (runtime) => ({
                ...runtime,
                handleSessionUpdate: (handler) =>
                  Effect.sync(() => {
                    sessionUpdateHandler = handler;
                  }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
                prompt: () =>
                  Effect.gen(function* () {
                    const gate = yield* Deferred.make<EffectAcpSchema.PromptResponse>();
                    promptGates.push(gate);
                    yield* Queue.offer(promptStarted, undefined);
                    return yield* Deferred.await(gate);
                  }),
              }),
            }),
          },
          selfInvocation,
          continuationRequests: {
            offer: (request) =>
              Effect.sync(() => {
                continuationRequests.push(request);
              }),
          },
        });
        const threadId = ThreadId.make("thread-acp-multiturn-in-turn-monitor-no-wake");
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const modelSelection = { instanceId, model: "default" } as const;
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make(
            "provider-session-acp-multiturn-in-turn-monitor-no-wake",
          ),
          modelSelection,
          runtimePolicy,
        });
        if (runtime.hasPendingBackgroundWork === undefined) {
          return yield* Effect.die(
            "ACP runtime must expose hasPendingBackgroundWork when post-settle continuation is enabled.",
          );
        }
        const hasPendingBackgroundWork = runtime.hasPendingBackgroundWork;
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        yield* runtime.events.pipe(
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkScoped,
        );
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        yield* runtime
          .startTurn(
            makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now, ordinal: 1 }),
          )
          .pipe(Effect.forkScoped);
        yield* Queue.take(promptStarted);
        assert.isDefined(sessionUpdateHandler, "session update handler must be wired");
        const applyMutation = capturedMutation.current;
        if (applyMutation === null) {
          return yield* Effect.die("registerExtensions must capture applyBackgroundTaskMutation");
        }

        yield* sessionUpdateHandler!({
          sessionId: "mock-session-1",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tool-call-monitor-1",
            title: "Monitor: first turn",
            kind: "execute",
            status: "pending",
            rawInput: {},
          },
        });
        yield* sessionUpdateHandler!({
          sessionId: "mock-session-1",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tool-call-monitor-1",
            status: "in_progress",
          },
        });
        yield* applyMutation({
          sessionId: "mock-session-1",
          taskId: "task-monitor-1",
          status: "running",
        });
        yield* sessionUpdateHandler!({
          sessionId: "mock-session-1",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tool-call-fetch-1",
            title: "get_command_or_subagent_output",
            kind: "other",
            status: "pending",
            rawInput: { task_id: "task-monitor-1" },
          },
        });
        yield* sessionUpdateHandler!({
          sessionId: "mock-session-1",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tool-call-fetch-1",
            status: "completed",
            rawOutput: { output: "MONITOR_LISTING_TOKEN" },
          },
        });
        yield* sessionUpdateHandler!({
          sessionId: "mock-session-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Monitor listing ready in-turn." },
          },
        });
        yield* applyMutation({
          sessionId: "mock-session-1",
          taskId: "task-monitor-1",
          status: "completed",
        });
        assert.lengthOf(continuationRequests, 0);

        yield* Deferred.succeed(promptGates[0]!, { stopReason: "end_turn" });
        const firstProviderTurnId = idAllocator.derive.providerTurn({
          driver: ACP_TEST_DRIVER,
          nativeTurnId: acpScopedNativeId(instanceId, "mock-session-1:turn:1"),
        });
        let firstTerminal: string | null = null;
        while (firstTerminal === null) {
          const event = yield* Queue.take(events);
          if (event.type === "turn.terminal" && event.providerTurnId === firstProviderTurnId) {
            firstTerminal = event.status;
          }
        }
        assert.equal(firstTerminal, "completed");

        yield* sessionUpdateHandler!({
          sessionId: "mock-session-1",
          update: {
            sessionUpdate: "user_message_chunk",
            content: {
              type: "text",
              text: '<monitor-event taskId="task-monitor-1">Monitor "task-monitor-1" ended</monitor-event>',
            },
          },
        });
        yield* sessionUpdateHandler!({
          sessionId: "mock-session-1",
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: {
              type: "text",
              text: "That monitor event is the same run I already summarized.",
            },
          },
        });
        yield* sessionUpdateHandler!({
          sessionId: "mock-session-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "That monitor event is the same run I already summarized above.",
            },
          },
        });
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        assert.lengthOf(
          continuationRequests,
          0,
          "turn-1 injected-turn acks must not open a continuation",
        );
        assert.isFalse(
          yield* hasPendingBackgroundWork,
          "turn-1 injected-turn ack chatter must not remain as wake buffer evidence",
        );

        yield* runtime
          .startTurn(
            makeTurnInput({
              threadId,
              providerThread,
              instanceId,
              runtimePolicy,
              now: yield* DateTime.now,
              ordinal: 2,
            }),
          )
          .pipe(Effect.forkScoped);
        yield* Queue.take(promptStarted);
        if (sessionUpdateHandler === undefined || capturedMutation.current === null) {
          return yield* Effect.die("extensions and session handler must be wired for turn 2");
        }

        yield* sessionUpdateHandler({
          sessionId: "mock-session-1",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tool-call-monitor-2",
            title: "Monitor: second turn",
            kind: "execute",
            status: "pending",
            rawInput: {},
          },
        });
        yield* sessionUpdateHandler({
          sessionId: "mock-session-1",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tool-call-monitor-2",
            status: "in_progress",
          },
        });
        yield* capturedMutation.current({
          sessionId: "mock-session-1",
          taskId: "task-monitor-2",
          status: "running",
        });
        yield* sessionUpdateHandler({
          sessionId: "mock-session-1",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tool-call-fetch-2",
            title: "get_command_or_subagent_output",
            kind: "other",
            status: "pending",
            rawInput: { task_id: "task-monitor-2" },
          },
        });
        yield* sessionUpdateHandler({
          sessionId: "mock-session-1",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tool-call-fetch-2",
            status: "completed",
            rawOutput: { output: "MONITOR_LISTING_TOKEN_2" },
          },
        });
        yield* sessionUpdateHandler({
          sessionId: "mock-session-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Second monitor listing ready in-turn." },
          },
        });
        yield* capturedMutation.current({
          sessionId: "mock-session-1",
          taskId: "task-monitor-2",
          status: "completed",
        });
        assert.lengthOf(
          continuationRequests,
          0,
          "mid-turn task_completed for an in-turn-handled monitor must not open a wake run",
        );

        yield* Deferred.succeed(promptGates[1]!, { stopReason: "end_turn" });
        const secondProviderTurnId = idAllocator.derive.providerTurn({
          driver: ACP_TEST_DRIVER,
          nativeTurnId: acpScopedNativeId(instanceId, "mock-session-1:turn:2"),
        });
        let secondTerminal: string | null = null;
        while (secondTerminal === null) {
          const event = yield* Queue.take(events);
          if (event.type === "turn.terminal" && event.providerTurnId === secondProviderTurnId) {
            secondTerminal = event.status;
          }
        }
        assert.equal(secondTerminal, "completed");
        assert.lengthOf(
          continuationRequests,
          0,
          "no continuation must be offered across the multiturn in-turn monitor sequence",
        );
        assert.isFalse(
          yield* hasPendingBackgroundWork,
          "wake buffer must not retain turn-1 or turn-2 in-turn-handled ack residue",
        );
      }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("a wake names work that ended while the previous wake was queued", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const path = yield* Path.Path;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const continuationRequests: Array<ProviderContinuationRequests.ProviderContinuationRequest> =
        [];
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      let sessionUpdateHandler: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
      let applyMutation: AcpAdapterV2ExtensionContext["applyBackgroundTaskMutation"] | undefined;
      const promptGate = yield* Deferred.make<EffectAcpSchema.PromptResponse>();
      const instanceId = ProviderInstanceId.make("acp-test");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          enablePostSettleContinuation: true,
          deferFinalizeForBackgroundWork: true,
          registerExtensions: (context) =>
            Effect.sync(() => {
              applyMutation = context.applyBackgroundTaskMutation;
            }),
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            environment: { T3_ACP_HANG_PROMPT_FOREVER: "1" },
            wrapRuntime: (runtime) => ({
              ...runtime,
              handleSessionUpdate: (handler) =>
                Effect.sync(() => {
                  sessionUpdateHandler = handler;
                }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
              prompt: () => Deferred.await(promptGate),
            }),
          }),
        },
        selfInvocation,
        continuationRequests: {
          offer: (request) =>
            Effect.sync(() => {
              continuationRequests.push(request);
            }),
        },
      });
      const threadId = ThreadId.make("thread-acp-wake-report-while-queued");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-wake-report-while-queued"),
        modelSelection,
        runtimePolicy,
      });
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      yield* runtime.events.pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped,
      );
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const awaitTerminal = (ordinal: number) =>
        Effect.gen(function* () {
          const providerTurnId = idAllocator.derive.providerTurn({
            driver: ACP_TEST_DRIVER,
            nativeTurnId: acpScopedNativeId(instanceId, `mock-session-1:turn:${ordinal}`),
          });
          while (true) {
            const event = yield* Queue.take(events);
            if (event.type === "turn.terminal" && event.providerTurnId === providerTurnId) {
              return event.status;
            }
          }
        });
      yield* runtime
        .startTurn(
          makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            runtimePolicy,
            now: yield* DateTime.now,
          }),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.succeed(promptGate, { stopReason: "end_turn" });
      assert.equal(yield* awaitTerminal(1), "completed");
      if (applyMutation === undefined || sessionUpdateHandler === undefined) {
        return yield* Effect.die("extensions and session handler must be wired");
      }
      const endCommand = (taskId: string, label: string) =>
        applyMutation!({
          sessionId: "mock-session-1",
          taskId,
          status: "completed",
          report: { kind: "command", label },
        });
      const agentText = (text: string) =>
        sessionUpdateHandler!({
          sessionId: "mock-session-1",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
        });

      yield* endCommand("task-a", "sleep a");
      yield* agentText("A_DONE");
      assert.lengthOf(continuationRequests, 1);
      assert.equal(continuationRequests[0]?.notification?.summary, 'Command "sleep a" finished');
      yield* endCommand("task-b", "sleep b");
      assert.lengthOf(continuationRequests, 1);

      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          now: yield* DateTime.now,
          ordinal: 2,
          messageCreatedBy: "agent",
          messageCreationSource: "provider",
          messageText: "Background task completed.",
        }),
      );
      yield* TestClock.adjust("3 seconds");
      assert.equal(yield* awaitTerminal(2), "completed");

      yield* agentText("B_DONE");
      assert.lengthOf(continuationRequests, 2);
      assert.deepEqual(continuationRequests[1]?.notification, {
        source: { kind: "command" },
        outcome: "completed",
        summary: 'Command "sleep b" finished',
      });
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect.each([
    { status: "completed" as const, exitCode: 0 },
    { status: "failed" as const, exitCode: 1 },
  ])(
    "retains early Grok $status command completion across sparse notifications and replayed ACKs",
    ({ status, exitCode }) =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const path = yield* Path.Path;
        const selfInvocation = yield* resolveSelfInvocation();
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
        let sessionUpdateHandler: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
        let taskCompleted:
          | ((payload: unknown) => Effect.Effect<void, EffectAcpErrors.AcpError>)
          | undefined;
        const promptStarted = yield* Deferred.make<void>();
        const promptGate = yield* Deferred.make<EffectAcpSchema.PromptResponse>();
        const promptHeld = yield* Deferred.make<void>();
        const finalizeScheduled = yield* Deferred.make<Duration.Input>();
        const continuationOffered = yield* Deferred.make<void>();
        const continuationRequests: Array<ProviderContinuationRequests.ProviderContinuationRequest> =
          [];
        const instanceId = ProviderInstanceId.make("acp-test");
        const grokFlavor = makeGrokAcpAdapterFlavor(
          {
            instanceId,
            settings: DEFAULT_GROK_SETTINGS,
            environment: {},
            hostPlatform: yield* HostProcess.Platform,
            selfInvocation,
          },
          yield* HostProcess.HomeDirectory,
        );
        const adapter = yield* makeAcpAdapterV2({
          instanceId,
          selfInvocation,
          testHooks: {
            afterPromptSettledWithBackgroundWork: () =>
              Deferred.succeed(promptHeld, undefined).pipe(Effect.asVoid),
            onDeferredFinalizeScheduled: (debounce) =>
              Deferred.succeed(finalizeScheduled, debounce).pipe(Effect.asVoid),
          },
          flavor: {
            driver: ACP_TEST_DRIVER,
            capabilities: AcpProviderCapabilitiesV2,
            enablePostSettleContinuation: true,
            deferFinalizeForBackgroundWork: true,
            normalizeToolCall: grokFlavor.normalizeToolCall!,
            extractBackgroundTaskId: grokFlavor.extractBackgroundTaskId!,
            isBackgroundCommandTool: grokFlavor.isBackgroundCommandTool!,
            registerExtensions: ({ runtime, applyBackgroundTaskMutation }) =>
              registerXAiBackgroundTaskTracking(runtime, applyBackgroundTaskMutation),
            makeRuntime: makeMockRuntime({
              childProcessSpawner,
              mockAgentPath,
              wrapRuntime: (runtime) => ({
                ...runtime,
                handleSessionUpdate: (handler) =>
                  Effect.sync(() => {
                    sessionUpdateHandler = handler;
                  }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
                handleExtNotification: (method, schema, handler) =>
                  Effect.sync(() => {
                    if (method === "x.ai/task_completed") {
                      taskCompleted = (payload) =>
                        handler(Schema.decodeUnknownSync(schema)(payload));
                    }
                  }).pipe(Effect.andThen(runtime.handleExtNotification(method, schema, handler))),
                prompt: () =>
                  Deferred.succeed(promptStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(promptGate)),
                  ),
              }),
            }),
          },
          continuationRequests: {
            offer: (request) =>
              Effect.sync(() => continuationRequests.push(request)).pipe(
                Effect.andThen(Deferred.succeed(continuationOffered, undefined)),
                Effect.asVoid,
              ),
          },
        });
        const threadId = ThreadId.make("thread-acp-early-command");
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const modelSelection = { instanceId, model: "default" } as const;
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-acp-early-command"),
          modelSelection,
          runtimePolicy,
        });
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        yield* runtime.events.pipe(
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkScoped,
        );
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        yield* runtime
          .startTurn(
            makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now, ordinal: 1 }),
          )
          .pipe(Effect.forkScoped);
        yield* Deferred.await(promptStarted);
        assert.isDefined(sessionUpdateHandler);
        assert.isDefined(taskCompleted);
        const update = (update: EffectAcpSchema.SessionUpdate) =>
          sessionUpdateHandler!({ sessionId: "mock-session-1", update });
        const complete = (taskId: string, snapshot?: { output?: string; exit_code?: number }) =>
          taskCompleted!({
            sessionId: "mock-session-1",
            update: { sessionUpdate: "task_completed", task_id: taskId, task_snapshot: snapshot },
          });
        for (const taskId of ["early", "blocker"]) {
          yield* update({
            sessionUpdate: "tool_call",
            toolCallId: taskId,
            title: `Run ${taskId}`,
            kind: "execute",
            status: "completed",
            rawInput: { command: `echo ${taskId}` },
            rawOutput: { type: "BackgroundTaskStarted", task_id: taskId },
          });
        }
        // Progress removes the ACK carrying the task identity before a reportless completion.
        yield* update({
          sessionUpdate: "tool_call_update",
          toolCallId: "early",
          status: "in_progress",
          rawOutput: { type: "Text", text: "Command progress" },
        });
        yield* complete("early", { exit_code: exitCode, output: "EARLY_BG_DONE\n" });
        // The real decoder treats this exit-code-free duplicate as completed, even after failure.
        yield* complete("early");
        assert.lengthOf(continuationRequests, 0);

        let backgroundItem: ProviderAdapter.ProviderAdapterV2Event | undefined;
        let checkpoint = 0;
        const assertCommand = Effect.fnUntraced(function* (expectedStatus: string, output: string) {
          const title = `Checkpoint ${++checkpoint}`;
          // A later tool event fences the emitted updates without waiting for a terminal that may never come.
          yield* update({ sessionUpdate: "tool_call_update", toolCallId: "blocker", title });
          while (true) {
            const event = yield* Queue.take(events);
            if (event.type !== "turn_item.updated") continue;
            if (event.turnItem.nativeItemRef?.nativeId === "early") backgroundItem = event;
            if (
              event.turnItem.nativeItemRef?.nativeId === "blocker" &&
              event.turnItem.title === title
            )
              break;
          }
          assert.equal(backgroundItem?.type, "turn_item.updated");
          if (backgroundItem?.type !== "turn_item.updated") return;
          assert.equal(backgroundItem.turnItem.status, expectedStatus);
          assert.equal(backgroundItem.turnItem.type, "command_execution");
          if (backgroundItem.turnItem.type === "command_execution") {
            assert.equal(backgroundItem.turnItem.output ?? "", output);
          }
        });
        yield* Deferred.succeed(promptGate, { stopReason: "end_turn" });
        yield* Deferred.await(promptHeld);
        yield* assertCommand(status, "EARLY_BG_DONE\n");
        assert.lengthOf(continuationRequests, 0, "the other command still holds the root open");

        const replayAck = () =>
          update({
            sessionUpdate: "tool_call_update",
            toolCallId: "early",
            status: "completed",
            rawOutput: { type: "BackgroundTaskStarted", task_id: "early" },
          });
        yield* replayAck();
        yield* assertCommand(status, "EARLY_BG_DONE\n");
        // Sparse ACP updates must retain the command result after projection replaces the ACK.
        for (const sparseStatus of ["completed", "in_progress"] as const) {
          yield* update({
            sessionUpdate: "tool_call_update",
            toolCallId: "early",
            status: sparseStatus,
          });
          yield* assertCommand(status, "EARLY_BG_DONE\n");
        }
        if (status === "completed") {
          for (const output of ["", "UPDATED_OUTPUT\n"]) {
            yield* complete("early", { output });
            yield* replayAck();
            yield* assertCommand(status, output);
          }
        }
        yield* complete("blocker", { exit_code: 0, output: "BLOCKER_DONE\n" });
        yield* TestClock.adjust(yield* Deferred.await(finalizeScheduled));
        while (true) {
          const event = yield* Queue.take(events);
          if (event.type !== "turn.terminal") continue;
          assert.equal(event.status, "completed");
          break;
        }
        yield* Deferred.await(continuationOffered);
        yield* complete("early");
        yield* complete("blocker");
        assert.lengthOf(
          continuationRequests,
          1,
          "duplicate completions must not offer another continuation",
        );
      }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live("durably poisons start and resume when required hard teardown is unavailable", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const path = yield* Path.Path;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const protocolEvents = yield* Queue.bounded<EffectAcpProtocol.AcpProtocolLogEvent>(256);
      const instanceId = ProviderInstanceId.make("acp-test");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          restartRuntimeAfterInterrupt: true,
          terminateRuntimeProcessGroupOnInterrupt: true,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            environment: { T3_ACP_HANG_PROMPT_FOREVER: "1" },
            protocolEvents,
          }),
        },
        selfInvocation,
      });
      const threadId = ThreadId.make("thread-acp-missing-hard-teardown");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-missing-hard-teardown"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* runtime
        .startTurn(
          makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now, ordinal: 1 }),
        )
        .pipe(Effect.forkScoped);
      yield* Stream.fromQueue(protocolEvents).pipe(
        Stream.filter(
          (event) =>
            event.direction === "outgoing" && rawProtocolMethod(event) === "session/prompt",
        ),
        Stream.runHead,
      );
      const providerTurnId = idAllocator.derive.providerTurn({
        driver: ACP_TEST_DRIVER,
        nativeTurnId: acpScopedNativeId(instanceId, "mock-session-1:turn:1"),
      });
      const interruptExit = yield* runtime
        .interruptTurn({ providerThread, providerTurnId, requestRuntimeRestart: true })
        .pipe(Effect.exit);
      if (Exit.isSuccess(interruptExit)) assert.fail("missing hard teardown must fail interrupt");
      assert.include(Cause.pretty(interruptExit.cause), "session is poisoned");

      const startExit = yield* runtime
        .startTurn(
          makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now, ordinal: 2 }),
        )
        .pipe(Effect.exit);
      if (Exit.isSuccess(startExit)) assert.fail("poisoned session must reject startTurn");
      assert.include(Cause.pretty(startExit.cause), "session is poisoned");
      const resumeExit = yield* runtime
        .resumeThread({ providerThread, modelSelection, runtimePolicy })
        .pipe(Effect.exit);
      if (Exit.isSuccess(resumeExit)) assert.fail("poisoned session must reject resumeThread");
      assert.include(Cause.pretty(resumeExit.cause), "session is poisoned");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live("holds concurrent startTurn behind successful hard teardown and reloads once", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const path = yield* Path.Path;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const protocolEvents = yield* Queue.bounded<EffectAcpProtocol.AcpProtocolLogEvent>(256);
      const teardownStarted = yield* Deferred.make<void>();
      const releaseTeardown = yield* Deferred.make<void>();
      let runtimeOrdinalSeen = 0;
      const instanceId = ProviderInstanceId.make("acp-test");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          interruptPromptOnCancel: true,
          restartRuntimeAfterInterrupt: true,
          terminateRuntimeProcessGroupOnInterrupt: true,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            ownDetachedProcessGroup: true,
            processGroupPlatform: "win32",
            windowsProcessTreeTerminator: () =>
              Deferred.succeed(teardownStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseTeardown)),
              ),
            environment: (runtimeOrdinal) => {
              runtimeOrdinalSeen = runtimeOrdinal;
              return runtimeOrdinal === 1 ? { T3_ACP_HANG_PROMPT_FOREVER: "1" } : {};
            },
            protocolEvents,
          }),
        },
        selfInvocation,
      });
      const threadId = ThreadId.make("thread-acp-concurrent-hard-teardown");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-concurrent-hard-teardown"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* runtime
        .startTurn(
          makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now, ordinal: 1 }),
        )
        .pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      const providerTurnId = idAllocator.derive.providerTurn({
        driver: ACP_TEST_DRIVER,
        nativeTurnId: acpScopedNativeId(instanceId, "mock-session-1:turn:1"),
      });
      yield* pollProtocolMethods(protocolEvents);
      const interruptFiber = yield* runtime
        .interruptTurn({ providerThread, providerTurnId, requestRuntimeRestart: true })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(teardownStarted);
      const startFiber = yield* runtime
        .startTurn(
          makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now, ordinal: 2 }),
        )
        .pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      assert.isUndefined(startFiber.pollUnsafe());
      assert.equal(runtimeOrdinalSeen, 1);
      const methodsDuringTeardown = yield* pollProtocolMethods(protocolEvents);
      assert.notInclude(methodsDuringTeardown, "session/resume");
      assert.notInclude(methodsDuringTeardown, "session/prompt");

      yield* Deferred.succeed(releaseTeardown, undefined);
      yield* Fiber.join(interruptFiber);
      yield* Fiber.join(startFiber);
      assert.equal(runtimeOrdinalSeen, 2);
      const replacementMethods = yield* pollProtocolMethods(protocolEvents);
      assert.equal(replacementMethods.filter((method) => method === "session/resume").length, 1);
      if (!replacementMethods.includes("session/prompt")) {
        yield* Stream.fromQueue(protocolEvents).pipe(
          Stream.filter(
            (event) =>
              event.direction === "outgoing" && rawProtocolMethod(event) === "session/prompt",
          ),
          Stream.runHead,
        );
      }
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live("lets a caller abandon Stop while hard teardown stalls, and finishes the teardown", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const path = yield* Path.Path;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const protocolEvents = yield* Queue.bounded<EffectAcpProtocol.AcpProtocolLogEvent>(256);
      const teardownStarted = yield* Deferred.make<void>();
      const releaseTeardown = yield* Deferred.make<void>();
      let runtimeOrdinalSeen = 0;
      const instanceId = ProviderInstanceId.make("acp-test");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          interruptPromptOnCancel: true,
          restartRuntimeAfterInterrupt: true,
          terminateRuntimeProcessGroupOnInterrupt: true,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            ownDetachedProcessGroup: true,
            processGroupPlatform: "win32",
            windowsProcessTreeTerminator: () =>
              Deferred.succeed(teardownStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseTeardown)),
              ),
            environment: (runtimeOrdinal) => {
              runtimeOrdinalSeen = runtimeOrdinal;
              return runtimeOrdinal === 1 ? { T3_ACP_HANG_PROMPT_FOREVER: "1" } : {};
            },
            protocolEvents,
          }),
        },
        selfInvocation,
      });
      const threadId = ThreadId.make("thread-acp-abandoned-hard-teardown");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-abandoned-hard-teardown"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* runtime
        .startTurn(
          makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now, ordinal: 1 }),
        )
        .pipe(Effect.forkScoped);
      const providerTurnId = idAllocator.derive.providerTurn({
        driver: ACP_TEST_DRIVER,
        nativeTurnId: acpScopedNativeId(instanceId, "mock-session-1:turn:1"),
      });
      yield* pollProtocolMethods(protocolEvents);
      const interruptFiber = yield* runtime
        .interruptTurn({ providerThread, providerTurnId, requestRuntimeRestart: true })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(teardownStarted);

      // The session manager's Stop timeout interrupts this call; it must not wait for teardown.
      yield* Fiber.interrupt(interruptFiber);

      const startFiber = yield* runtime
        .startTurn(
          makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now, ordinal: 2 }),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.succeed(releaseTeardown, undefined);
      yield* Fiber.join(startFiber);
      assert.equal(runtimeOrdinalSeen, 2);
      const replacementMethods = yield* pollProtocolMethods(protocolEvents);
      assert.equal(replacementMethods.filter((method) => method === "session/resume").length, 1);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect(
    "direct Stop on a deferred subagent hold terminalizes the subagent and does not carry it forward",
    () =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const path = yield* Path.Path;
        const selfInvocation = yield* resolveSelfInvocation();
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        const instanceId = ProviderInstanceId.make("acp-test");
        let subagentPhase: "spawn" | "complete" = "spawn";
        const promptSettled = yield* Deferred.make<void>();
        const adapter = yield* makeAcpAdapterV2({
          testHooks: {
            afterPromptSettledWithBackgroundWork: () =>
              Deferred.succeed(promptSettled, undefined).pipe(Effect.asVoid),
          },
          instanceId,
          flavor: {
            driver: ACP_TEST_DRIVER,
            capabilities: AcpProviderCapabilitiesV2,
            deferFinalizeForBackgroundWork: true,
            restartRuntimeAfterInterrupt: true,
            extractSubagentUpdate: (toolCall) =>
              toolCall.toolCallId !== "tool-call-generic-1"
                ? undefined
                : subagentPhase === "spawn"
                  ? {
                      nativeTaskId: "task-generic-1",
                      prompt: "background subagent",
                      title: "background subagent",
                      model: null,
                      status: "running",
                      childSessionId: null,
                      result: null,
                    }
                  : {
                      nativeTaskId: "task-generic-1",
                      prompt: "",
                      title: null,
                      model: null,
                      status: "completed",
                      childSessionId: null,
                      result: "SUB_DONE",
                    },
            makeRuntime: makeMockRuntime({
              childProcessSpawner,
              mockAgentPath,
              environment: { T3_ACP_EMIT_GENERIC_TOOL_PLACEHOLDERS: "1" },
            }),
          },
          selfInvocation,
        });
        const threadId = ThreadId.make("thread-acp-direct-stop-subagent-hold");
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const modelSelection = { instanceId, model: "default" } as const;
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make(
            "provider-session-acp-direct-stop-subagent-hold",
          ),
          modelSelection,
          runtimePolicy,
        });
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        yield* runtime.events.pipe(
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkScoped,
        );
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        yield* runtime.startTurn(
          makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now }),
        );
        yield* Deferred.await(promptSettled);

        const firstProviderTurnId = idAllocator.derive.providerTurn({
          driver: ACP_TEST_DRIVER,
          nativeTurnId: acpScopedNativeId(instanceId, "mock-session-1:turn:1"),
        });
        yield* runtime.interruptTurn({
          providerThread,
          providerTurnId: firstProviderTurnId,
          requestRuntimeRestart: true,
        });

        let subagentStatus: string | null = null;
        let firstTerminalStatus: string | null = null;
        while (firstTerminalStatus === null) {
          const event = yield* Queue.take(events);
          if (event.type === "turn_item.updated" && event.turnItem.type === "subagent") {
            subagentStatus = event.turnItem.status;
          }
          if (event.type === "turn.terminal" && event.providerTurnId === firstProviderTurnId) {
            firstTerminalStatus = event.status;
          }
        }
        assert.equal(firstTerminalStatus, "interrupted");
        assert.equal(subagentStatus, "interrupted");

        subagentPhase = "complete";
        const secondNow = yield* DateTime.now;
        yield* runtime.startTurn(
          makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            runtimePolicy,
            now: secondNow,
            ordinal: 2,
          }),
        );
        const secondProviderTurnId = idAllocator.derive.providerTurn({
          driver: ACP_TEST_DRIVER,
          nativeTurnId: acpScopedNativeId(instanceId, "mock-session-1:turn:2"),
        });
        let carriedCompleted = false;
        let secondTerminalStatus: string | null = null;
        while (secondTerminalStatus === null) {
          const event = yield* Queue.take(events);
          if (
            event.type === "turn_item.updated" &&
            event.turnItem.type === "subagent" &&
            event.turnItem.status === "completed"
          ) {
            carriedCompleted = true;
          }
          if (event.type === "turn.terminal" && event.providerTurnId === secondProviderTurnId) {
            secondTerminalStatus = event.status;
          }
        }
        assert.equal(secondTerminalStatus, "completed");
        assert.isFalse(
          carriedCompleted,
          "Direct Stop must not carry a stopped subagent into the follow-up run",
        );
      }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});

describe("acpPostSettleContinuationOfferEvidence", () => {
  const sessionId = "session-wake-offer";

  it("does not offer on a normalized monitor start ACK despite raw completed status", () => {
    const monitorStartAck = {
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-monitor",
        title: "Tool",
        status: "completed",
        kind: "other",
        content: [],
        locations: [],
        rawInput: { variant: "Monitor", description: "stream test" },
        rawOutput: {
          type: "Monitor",
          taskId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          timeoutMs: 60000,
        },
      },
    } as const;
    assert.isTrue(acpPostSettleContinuationOfferEvidence(monitorStartAck));
    assert.isFalse(
      acpPostSettleContinuationOfferEvidence(monitorStartAck, {
        normalizeToolCall: normalizeXAiAcpToolCallState,
      }),
    );
  });
});
