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





describe("OpenCodeAdapterV2", () => {
  it.effect("does not register a turn after the OpenCode event stream ends", () =>
    Effect.gen(function* () {
      const nativeEvents = asyncEventStream();
      let promptCalls = 0;
      const harness = yield* makeOpenCodeRuntimeHarness(
        "event-eof-start-race",
        "native-opencode-event-eof-start-race",
        {
          event: {
            subscribe: async (_input: unknown, options: { signal?: AbortSignal }) => {
              options.signal?.addEventListener("abort", () => nativeEvents.close(), { once: true });
              return { stream: nativeEvents.stream };
            },
          },
          session: {
            create: async () => ({
              data: {
                id: "native-opencode-event-eof-start-race",
                time: { created: 1, updated: 1 },
              },
            }),
            promptAsync: async () => {
              promptCalls += 1;
              return { data: true };
            },
          },
        },
      );
      const baseClock = yield* Clock.Clock;
      const startClockRead = yield* Deferred.make<void>();
      const releaseStartClockRead = yield* Deferred.make<void>();
      let blockNextClockRead = true;
      const blockingClock: Clock.Clock = {
        ...baseClock,
        currentTimeMillis: Effect.suspend(() => {
          if (!blockNextClockRead) return baseClock.currentTimeMillis;
          blockNextClockRead = false;
          return Deferred.succeed(startClockRead, undefined).pipe(
            Effect.andThen(Deferred.await(releaseStartClockRead)),
            Effect.andThen(baseClock.currentTimeMillis),
          );
        }),
      };
      const start = yield* harness
        .startTurn()
        .pipe(Effect.provideService(Clock.Clock, blockingClock), Effect.exit, Effect.forkScoped);
      yield* Deferred.await(startClockRead);

      const events = yield* harness.runtime.events.pipe(Stream.runCollect, Effect.forkScoped);
      nativeEvents.close();
      yield* Fiber.join(events);
      yield* Deferred.succeed(releaseStartClockRead, undefined);

      assert.isTrue(Exit.isFailure(yield* Fiber.join(start)));
      assert.equal(promptCalls, 0);
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
  );
  it("holds stale idle through prompt admission until the new user message is observed", () => {
    const admission = {
      admissionPending: true,
      admissionAccepted: false,
      admissionMessageObserved: false,
      idleDuringAdmission: false,
    };

    assert.equal(advanceOpenCodePromptAdmission(admission, "idle"), "hold");
    assert.equal(advanceOpenCodePromptAdmission(admission, "accepted"), "hold");
    assert.isTrue(admission.admissionPending);
    assert.equal(advanceOpenCodePromptAdmission(admission, "user-message"), "reconcile-idle");
    assert.isTrue(admission.admissionPending);
  });
  it("releases admission when an assistant completes under a provider-assigned message id", () => {
    const admission = {
      admissionPending: true,
      admissionAccepted: false,
      admissionMessageObserved: false,
      idleDuringAdmission: true,
    };

    assert.equal(advanceOpenCodePromptAdmission(admission, "assistant-completed"), "release");
    assert.isTrue(admission.admissionAccepted);
    assert.isTrue(admission.admissionMessageObserved);
    assert.isFalse(admission.admissionPending);
  });
  it("invalidates pending admission before aborting a turn", () => {
    const admission = {
      admissionGeneration: 4,
      admissionPending: true,
      admissionAccepted: false,
      admissionMessageObserved: false,
      idleDuringAdmission: false,
    };

    cancelOpenCodePromptAdmission(admission, 5);

    assert.equal(admission.admissionGeneration, 5);
    assert.isFalse(admission.admissionPending);
    assert.equal(advanceOpenCodePromptAdmission(admission, "accepted"), "release");
  });
  it.effect("keeps admission pending after a transient status failure", () =>
    Effect.gen(function* () {
      const admission = { admissionGeneration: 4, admissionPending: true };
      assert.equal(
        yield* reconcileOpenCodePromptAdmissionStatus(admission, 4, Effect.succeed("unknown")),
        "unknown",
      );
      assert.isTrue(admission.admissionPending);
      assert.equal(
        yield* reconcileOpenCodePromptAdmissionStatus(admission, 4, Effect.succeed("idle")),
        "idle",
      );
      assert.isFalse(admission.admissionPending);
    }),
  );
  it.effect("ignores a delayed status reply after steering starts a newer admission", () =>
    Effect.gen(function* () {
      const admission = { admissionGeneration: 4, admissionPending: true };
      const status = yield* Deferred.make<"idle" | "busy" | "unknown">();
      const fiber = yield* reconcileOpenCodePromptAdmissionStatus(
        admission,
        4,
        Deferred.await(status),
      ).pipe(Effect.forkChild({ startImmediately: true }));

      admission.admissionGeneration = 5;
      admission.admissionPending = true;
      yield* Deferred.succeed(status, "idle");

      assert.equal(yield* Fiber.join(fiber), "stale");
      assert.equal(admission.admissionGeneration, 5);
      assert.isTrue(admission.admissionPending);
    }),
  );
  it.effect("logs bounded structural protocol diagnostics without native payload values", () =>
    Effect.gen(function* () {
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const records: Array<unknown> = [];
      const nativeEventLogger: ProviderEventLoggers.EventNdjsonLogger = {
        filePath: "/tmp/provider-native.ndjson",
        write: (event) => Effect.sync(() => void records.push(event)),
        close: () => Effect.void,
      };
      const logProtocolEvent = makeOpenCodeProtocolLogger({
        nativeEventLogger,
        idAllocator,
        providerInstanceId: ProviderInstanceId.make("opencode-test"),
        providerSessionId: ProviderSessionId.make("provider-session-opencode-test"),
        threadId: ThreadId.make("thread-opencode-test"),
      });
      const secret = "secret-opencode-prompt";

      yield* logProtocolEvent({
        direction: "outgoing",
        messageKind: "request",
        method: "session.prompt",
        payload: { prompt: secret, nested: { token: secret } },
      });
      yield* logProtocolEvent({
        direction: "incoming",
        messageKind: "notification",
        method: "message.part.delta",
        payload: { type: "message.part.delta", properties: { delta: secret } },
      });

      assert.lengthOf(records, 1);
      const serialized = encodeUnknownJson(records);
      assert.notInclude(serialized, secret);
      assert.include(serialized, '"protocol":"opencode-sdk.sse"');
      assert.include(serialized, '"method":"session.prompt"');
      assert.include(serialized, '"fieldCount":2');
    }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer))),
  );
  it.effect("adopts the handed-over provider thread identity on session create", () =>
    Effect.gen(function* () {
      let createCount = 0;
      const createInputs: Array<unknown> = [];
      const fakeClient = {
        event: {
          subscribe: async (_input?: unknown, options?: { readonly signal?: AbortSignal }) => ({
            stream: {
              [Symbol.asyncIterator]: () => ({
                next: () =>
                  new Promise<IteratorResult<never>>((resolve) => {
                    const done = () => resolve({ done: true, value: undefined });
                    if (options?.signal?.aborted) return done();
                    options?.signal?.addEventListener("abort", done, { once: true });
                  }),
              }),
            },
          }),
        },
        session: {
          create: async (input: unknown) => {
            createCount += 1;
            createInputs.push(input);
            return { data: { id: `ses_native_${createCount}`, time: { created: 1, updated: 1 } } };
          },
        },
      } as unknown as OpencodeClient;
      const unused = (operation: string) => () => Effect.die(`${operation} is not used`);
      const runtime: OpenCodeRuntime.OpenCodeRuntime["Service"] = {
        startOpenCodeServerProcess: unused("startOpenCodeServerProcess"),
        connectToOpenCodeServer: () =>
          Effect.succeed({
            url: "test://opencode",
            version: "test",
            exitCode: null,
            external: true,
          }),
        runOpenCodeCommand: unused("runOpenCodeCommand"),
        createOpenCodeSdkClient: () => fakeClient,
        loadOpenCodeInventory: unused("loadOpenCodeInventory"),
        loadOpenCodeSkills: unused("loadOpenCodeSkills"),
      };
      const instanceId = ProviderInstanceId.make("opencode");
      const threadId = ThreadId.make("thread-opencode-adopt");
      const modelSelection = { instanceId, model: "default" };
      const adapter = yield* makeOpenCodeAdapterV2({
        instanceId,
        settings: OPENCODE_TEST_SETTINGS,
        environment: {},
      }).pipe(Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, runtime));
      const session = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-opencode-adopt"),
        modelSelection,
        runtimePolicy: runtimePolicy("full-access"),
      });
      const now = yield* DateTime.now;
      const placeholder: OrchestrationV2ProviderThread = {
        id: ProviderThreadId.make("thread:provider:opencode:native-thread:pending:run:adopt:1"),
        driver: OPENCODE_PROVIDER,
        providerInstanceId: instanceId,
        providerSessionId: null,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "not_loaded",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };
      const adopted = yield* session.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy: runtimePolicy("full-access"),
        existingProviderThread: placeholder,
      });
      assert.equal(adopted.id, placeholder.id);
      assert.equal(adopted.nativeThreadRef?.nativeId, "ses_native_1");
      const minted = yield* session.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy: runtimePolicy("full-access"),
      });
      assert.notEqual(minted.id, placeholder.id);
      assert.equal(minted.nativeThreadRef?.nativeId, "ses_native_2");
      for (const input of createInputs) {
        assert.notProperty(input, "title");
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          McpProviderSessions.layer,
          TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
        ),
      ),
    ),
  );
  it("maps runtime modes to safe OpenCode permission rules", () => {
    const approvalRequired = openCodePermissionRules(runtimePolicy("approval-required"));
    assert.equal(permissionAction(approvalRequired, "read"), "allow");
    assert.equal(permissionAction(approvalRequired, "edit"), "ask");
    assert.equal(permissionAction(approvalRequired, "bash"), "ask");
    assert.equal(permissionAction(approvalRequired, "doom_loop"), "ask");
    assert.equal(permissionAction(approvalRequired, "unknown_plugin_tool"), "ask");
    assert.equal(permissionAction(approvalRequired, "question"), "allow");

    const autoAcceptEdits = openCodePermissionRules(runtimePolicy("auto-accept-edits"));
    assert.equal(permissionAction(autoAcceptEdits, "edit"), "allow");
    assert.equal(permissionAction(autoAcceptEdits, "bash"), "ask");

    const fullAccess = openCodePermissionRules(runtimePolicy("full-access"));
    assert.equal(permissionAction(fullAccess, "bash"), "allow");
    assert.equal(permissionAction(fullAccess, "edit"), "allow");

    const granularApproval = openCodePermissionRules(
      runtimePolicy("full-access", {
        approvalPolicy: { granular: { request_permissions: true } },
      }),
    );
    assert.equal(permissionAction(granularApproval, "bash"), "ask");
    assert.equal(permissionAction(granularApproval, "read"), "allow");

    const approvalRequiredWorkspaceWrite = openCodePermissionRules(
      runtimePolicy("approval-required", {
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: ["/tmp/opencode-workspace"],
          networkAccess: false,
        },
      }),
    );
    assert.equal(permissionAction(approvalRequiredWorkspaceWrite, "edit"), "ask");
  });
  it("enforces non-interactive sandbox policy through OpenCode permissions", () => {
    const readOnly = openCodePermissionRules(
      runtimePolicy("full-access", {
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "readOnly",
          access: { type: "fullAccess" },
          networkAccess: false,
        },
      }),
    );
    assert.equal(permissionAction(readOnly, "read"), "allow");
    assert.equal(permissionAction(readOnly, "edit"), "deny");
    assert.equal(permissionAction(readOnly, "bash"), "deny");
    assert.equal(permissionAction(readOnly, "webfetch"), "deny");
    assert.equal(permissionAction(readOnly, "doom_loop"), "deny");
    assert.equal(permissionAction(readOnly, "unknown_plugin_tool"), "deny");
    assert.equal(permissionAction(readOnly, "external_directory"), "allow");

    const workspaceWrite = openCodePermissionRules(
      runtimePolicy("auto-accept-edits", {
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: ["/tmp/opencode-workspace"],
          networkAccess: true,
        },
      }),
    );
    assert.equal(permissionAction(workspaceWrite, "edit"), "allow");
    assert.equal(permissionAction(workspaceWrite, "bash"), "deny");
    assert.equal(permissionAction(workspaceWrite, "webfetch"), "allow");
    assert.deepInclude(workspaceWrite, {
      permission: "external_directory",
      pattern: "/tmp/opencode-workspace/*",
      action: "allow",
    });
  });
  it("preserves OpenCode's recursion guard on task-created child sessions", () => {
    const childRules = openCodeChildPermissionRules(runtimePolicy("full-access"), [
      { permission: "task", pattern: "*", action: "deny" },
    ]);

    assert.equal(permissionAction(childRules, "read"), "allow");
    assert.equal(permissionAction(childRules, "bash"), "allow");
    assert.equal(permissionAction(childRules, "task"), "deny");

    const approvalRequiredPolicy = runtimePolicy("approval-required");
    const parentRules = openCodePermissionRules(approvalRequiredPolicy);
    const childApprovalRules = openCodeChildPermissionRules(approvalRequiredPolicy, [
      ...parentRules.filter((rule) => rule.action === "deny"),
      { permission: "task", pattern: "*", action: "deny" },
    ]);
    assert.equal(permissionAction(childApprovalRules, "bash"), "ask");
    assert.equal(permissionAction(childApprovalRules, "task"), "deny");

    const fullAccessChildRules = openCodeChildPermissionRules(runtimePolicy("full-access"), [
      { permission: "task", pattern: "*", action: "deny" },
    ]);
    const reappliedRules = openCodeChildPermissionRules(
      approvalRequiredPolicy,
      fullAccessChildRules,
      openCodePermissionRules(runtimePolicy("full-access")),
    );
    assert.equal(permissionAction(reappliedRules, "bash"), "ask");
    assert.equal(permissionAction(reappliedRules, "task"), "deny");
  });
});

