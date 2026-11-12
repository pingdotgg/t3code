// @effect-diagnostics-next-line nodeBuiltinImport:off - Exercise HTTP authentication with the real SDK.
import * as NodeHttp from "node:http";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as OpenCodeServerLedger from "./OpenCodeServerLedger.ts";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { OpencodeClient, ToolPart } from "@opencode-ai/sdk/v2";
import {
  CheckpointId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  MessageId,
  ThreadId,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type ProviderOptionSelection,
} from "@t3tools/contracts";
import { OpenCodeSettings } from "../settings.ts";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import type * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";

import {
  advanceOpenCodePromptAdmission,
  cancelOpenCodePromptAdmission,
  openCodeBoundaryAfterProviderTurn,
  openCodeChildPermissionRules,
  openCodePermissionRules,
  makeOpenCodeProtocolLogger,
  makeOpenCodeAdapterV2,
  OPENCODE_PROVIDER,
  reconcileOpenCodePromptAdmissionStatus,
} from "./adapter.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeOpenCodeSettings = Schema.decodeEffect(OpenCodeSettings);
const OPEN_CODE_TEST_SETTINGS = Schema.decodeSync(OpenCodeSettings)({
  serverUrl: "http://test.invalid",
});

function promiseGate<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function asyncEventStream() {
  const values: Array<{ value: unknown; handled: ReturnType<typeof promiseGate<void>> }> = [];
  const waiters: Array<(value: IteratorResult<unknown>) => void> = [];
  let previousHandled: ReturnType<typeof promiseGate<void>> | undefined;
  let closed = false;
  return {
    close() {
      closed = true;
      for (const waiter of waiters.splice(0)) waiter({ done: true, value: undefined });
    },
    push(value: unknown) {
      const handled = promiseGate<void>();
      const waiter = waiters.shift();
      if (waiter) {
        previousHandled = handled;
        waiter({ done: false, value });
      } else values.push({ value, handled });
      return handled.promise;
    },
    stream: {
      [Symbol.asyncIterator]() {
        return {
          next: () => {
            previousHandled?.resolve();
            if (closed) return Promise.resolve({ done: true as const, value: undefined });
            const entry = values.shift();
            if (entry !== undefined) {
              previousHandled = entry.handled;
              return Promise.resolve({ done: false as const, value: entry.value });
            }
            return new Promise<IteratorResult<unknown>>((resolve) => waiters.push(resolve));
          },
        };
      },
    },
  };
}

const OPENCODE_TEST_SETTINGS = Schema.decodeSync(OpenCodeSettings)({});

function runtimePolicy(
  runtimeMode: ProviderAdapter.ProviderAdapterV2RuntimePolicy["runtimeMode"],
  override: Partial<ProviderAdapter.ProviderAdapterV2RuntimePolicy> = {},
): ProviderAdapter.ProviderAdapterV2RuntimePolicy {
  return ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode,
    interactionMode: "default",
    cwd: null,
    ...override,
  });
}

function permissionAction(rules: ReturnType<typeof openCodePermissionRules>, permission: string) {
  return rules.findLast((rule) => rule.permission === "*" || rule.permission === permission)
    ?.action;
}

function providerTurn(input: {
  readonly id: string;
  readonly ordinal: number;
  readonly nativeId: string | null;
}): OrchestrationV2ProviderTurn {
  return {
    id: ProviderTurnId.make(input.id),
    providerThreadId: ProviderThreadId.make("provider-thread:opencode-test"),
    nodeId: NodeId.make(`node:${input.id}`),
    runAttemptId: null,
    nativeTurnRef:
      input.nativeId === null
        ? null
        : { driver: OPENCODE_PROVIDER, nativeId: input.nativeId, strength: "weak" },
    ordinal: input.ordinal,
    status: "completed",
    startedAt: null,
    completedAt: null,
  };
}

const makeOpenCodeRuntimeHarness = Effect.fn("makeOpenCodeRuntimeHarness")(function* (
  suffix: string,
  nativeSessionId: string,
  client: object,
  host: Partial<ProviderHost.ProviderHost["Service"]> = {},
  turnSettings: {
    readonly options?: ReadonlyArray<ProviderOptionSelection>;
    readonly interactionMode?: ProviderAdapter.ProviderAdapterV2RuntimePolicy["interactionMode"];
  } = {},
) {
  const instanceId = ProviderInstanceId.make(`opencode-${suffix}`);
  const threadId = ThreadId.make(`thread-opencode-${suffix}`);
  const modelSelection = {
    instanceId,
    model: "anthropic/claude-sonnet",
    options: turnSettings.options ?? [],
  };
  const policy = runtimePolicy("full-access", {
    cwd: "/workspace",
    interactionMode: turnSettings.interactionMode ?? "default",
  });
  const adapter = yield* makeOpenCodeAdapterV2({
    instanceId,
    settings: OPEN_CODE_TEST_SETTINGS,
    environment: {},
  }).pipe(
    Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, {
      connectToOpenCodeServer: () => Effect.succeed({ url: "http://test.invalid", external: true }),
      createOpenCodeSdkClient: () => client,
    } as unknown as OpenCodeRuntime.OpenCodeRuntime["Service"]),
    Effect.provideService(ProviderHost.ProviderHost, {
      paths: { cwd: "/workspace" },
      resolveAttachmentPath: () => null,
      ...host,
    } as unknown as ProviderHost.ProviderHost["Service"]),
  );
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make(`session-opencode-${suffix}`),
    modelSelection,
    runtimePolicy: policy,
  });
  const providerThread = yield* runtime.ensureThread({
    threadId,
    modelSelection,
    runtimePolicy: policy,
  });
  const now = yield* DateTime.now;
  const startTurn = (
    text = "hello",
    startProviderThread: OrchestrationV2ProviderThread = providerThread,
    turnPolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy = policy,
  ) =>
    runtime.startTurn({
      appThread: {
        id: threadId,
        projectId: ProjectId.make(`project-opencode-${suffix}`),
        title: suffix,
        providerInstanceId: modelSelection.instanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: policy.interactionMode,
        branch: null,
        worktreePath: null,
        activeProviderThreadId: providerThread.id,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdBy: "user",
        creationSource: "web",
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
      threadId,
      runId: RunId.make(`run-opencode-${suffix}`),
      runOrdinal: 1,
      providerTurnOrdinal: 1,
      attemptId: RunAttemptId.make(`attempt-opencode-${suffix}`),
      rootNodeId: NodeId.make(`node-opencode-${suffix}`),
      providerThread: startProviderThread,
      message: {
        createdBy: "user",
        creationSource: "web",
        messageId: MessageId.make(`message-opencode-${suffix}`),
        text,
        attachments: [],
      },
      modelSelection,
      runtimePolicy: turnPolicy,
    });
  return {
    nativeSessionId,
    now,
    policy,
    providerThread,
    runId: RunId.make(`run-opencode-${suffix}`),
    runtime,
    startTurn,
    threadId,
  };
});





it.effect.each([false, true])(
  "OpenCode rewind forks history and validates the retained boundary, invalid=%s",
  (invalid) =>
    Effect.gen(function* () {
      const events = asyncEventStream();
      const nativeSessionId = "rewind-source";
      const forkId = "rewind-fork";
      const calls: string[] = [];
      const removed = {
        info: { id: "first-user", sessionID: nativeSessionId, role: "user", time: { created: 1 } },
        parts: [],
      };
      const harness = yield* makeOpenCodeRuntimeHarness("rewind-fork", nativeSessionId, {
        event: {
          subscribe: async (_input: unknown, options: { signal?: AbortSignal }) => {
            options.signal?.addEventListener("abort", () => events.close(), { once: true });
            return { stream: events.stream };
          },
        },
        session: {
          create: async () => ({ data: { id: nativeSessionId, time: { created: 1, updated: 1 } } }),
          get: async ({ sessionID }: { sessionID: string }) => ({
            data: { id: sessionID, time: { created: 1, updated: 2 } },
          }),
          messages: async ({ sessionID }: { sessionID: string }) => ({
            data: sessionID === nativeSessionId || invalid ? [removed] : [],
          }),
          fork: async ({ sessionID, messageID }: { sessionID: string; messageID: string }) => {
            assert.equal(sessionID, nativeSessionId);
            assert.equal(messageID, "first-user");
            calls.push("fork");
            return { data: { id: forkId, time: { created: 1, updated: 2 } } };
          },
          update: async () => {
            calls.push("permissions");
            return { data: {} };
          },
          revert: async () => {
            throw new Error("Native revert would change workspace files");
          },
        },
      });
      const effect = harness.runtime.rollbackThread({
        providerThread: harness.providerThread,
        target: {
          type: "thread_start",
          checkpointId: CheckpointId.make("rewind-checkpoint"),
          appRunOrdinal: 0,
        },
        providerThreadTurns: [],
      });
      if (invalid) {
        const error = yield* effect.pipe(Effect.flip);
        assert.equal(error._tag, "ProviderAdapterRollbackThreadError");
        assert.deepEqual(calls, ["fork"]);
      } else {
        const result = yield* effect;
        assert.equal(result.providerThread.nativeThreadRef?.nativeId, forkId);
        assert.equal(result.messages.length, 0);
        assert.deepEqual(calls, ["fork", "permissions"]);
      }
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
);

