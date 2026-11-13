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

import {
  layerTest,
  ACP_TEST_DRIVER,
  decodeUnknownJson,
  makeMockRuntime,
  rawProtocolMethod,
  rawProtocolRequest,
  sessionId,
} from "./AcpAdapterV2-fixtures.testkit.ts";

describe("AcpAdapterV2", () => {
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
  it.effect.each([
    {
      label: "answers Always allow with the agent's allow-always option",
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
      optionId: "allow-always",
    },
    {
      label: "answers Always allow with allow-once when the agent offers no allow-always option",
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
      optionId: "allow-once",
    },
  ] as const)("$label", ({ options, optionId }) =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      let requestPermission: Parameters<RuntimeService["handleRequestPermission"]>[0] | undefined;
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
        }),
      });
      const instanceId = ProviderInstanceId.make("acp-test-always-allow");
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
      const threadId = ThreadId.make("thread-acp-always-allow");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-always-allow"),
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
      if (requestPermission === undefined) {
        return yield* Effect.die("ACP runtime must register a permission handler");
      }

      const permissionFiber = yield* requestPermission(
        {
          sessionId: "mock-session-1",
          toolCall: { toolCallId: "always-allow-tool", title: "Run tests", kind: "execute" },
          options,
        },
        { requestId: "always-allow-request", method: "session/request_permission" },
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
        return yield* Effect.die("Expected an ACP approval request");
      }
      const responseFiber = yield* runtime
        .respondToRuntimeRequest({
          requestId: pending.runtimeRequest.id,
          decision: "acceptForSession",
        })
        .pipe(Effect.forkScoped);
      const { outcome } = yield* Fiber.join(permissionFiber);
      if (runtimeInput?.onOutgoingResponse === undefined) {
        return yield* Effect.die("ACP runtime must expose native response acknowledgements");
      }
      yield* runtimeInput.onOutgoingResponse("always-allow-request");
      yield* Fiber.join(responseFiber);

      yield* runtime.interruptTurn({
        providerThread,
        providerTurnId: pending.runtimeRequest.providerTurnId,
      });
      yield* Fiber.join(turnFiber);
      assert.deepEqual(outcome, { outcome: "selected", optionId });
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});
