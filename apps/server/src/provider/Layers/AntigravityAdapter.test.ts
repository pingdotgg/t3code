import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AntigravitySettings,
  ApprovalRequestId,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as AcpErrors from "effect-acp/errors";
import type * as AcpSchema from "effect-acp/schema";

import { ServerConfig } from "../../config.ts";
import { ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE } from "../antigravityAuthSupport.ts";
import type { AcpSessionRuntimeEvent } from "../acp/AcpSessionRuntime.ts";
import { makeAntigravityAcpRuntime } from "../acp/AntigravityAcpSupport.ts";
import {
  mergeToolCallState,
  parseSessionUpdateEvent,
  type AcpToolCallState,
} from "../acp/AcpRuntimeModel.ts";
import { makeAntigravityAdapter, type AntigravityAdapterOptions } from "./AntigravityAdapter.ts";

const instanceId = ProviderInstanceId.make("antigravity-test");
const threadId = ThreadId.make("antigravity-thread");
const nativeSessionId = "b75db7e9-cd99-40e5-aa63-ac2b4674a6a9";
const nativeDefault = "gemini-test-low";
const nativeAlternative = "gemini-test-high";
const decodeSettings = Schema.decodeSync(AntigravitySettings);
const decodeRequestLog = Schema.decodeEffect(
  Schema.Array(
    Schema.fromJsonString(
      Schema.Struct({ method: Schema.String, params: Schema.optional(Schema.Unknown) }),
    ),
  ),
);

interface NativePrompt {
  readonly index: number;
  readonly content: ReadonlyArray<AcpSchema.ContentBlock>;
  readonly result: Deferred.Deferred<AcpSchema.PromptResponse, AcpErrors.AcpError>;
}

type Runtime = Effect.Success<ReturnType<AntigravityAdapterOptions["makeRuntime"]>>;

function nativeToolUpdate(
  update: Extract<
    AcpSchema.SessionNotification["update"],
    { sessionUpdate: "tool_call" | "tool_call_update" }
  >,
  previous?: AcpToolCallState,
) {
  const event = parseSessionUpdateEvent({ sessionId: nativeSessionId, update }).events.find(
    (event) => event._tag === "ToolCallUpdated",
  );
  if (!event) throw new Error("Expected a native tool update");
  return { ...event, toolCall: mergeToolCallState(previous, event.toolCall) };
}

const makeHarness = Effect.fn("makeAntigravityAdapterHarness")(function* (options?: {
  readonly enabled?: boolean;
  readonly holdCancel?: boolean;
  readonly holdClose?: boolean;
  readonly holdDispatch?: boolean;
}) {
  const runtimeEvents = yield* Queue.unbounded<AcpSessionRuntimeEvent>();
  const canonicalEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const prompts = yield* Queue.unbounded<NativePrompt>();
  const cancellations = yield* Queue.unbounded<number>();
  const cancelRelease = yield* Deferred.make<void>();
  const closeStarted = yield* Deferred.make<void>();
  const closeRelease = yield* Deferred.make<void>();
  const dispatchStarted = yield* Deferred.make<void>();
  const dispatchRelease = yield* Deferred.make<void>();
  const seen: ProviderRuntimeEvent[] = [];
  const calls: string[] = [];
  const launches: Array<Parameters<AntigravityAdapterOptions["makeRuntime"]>[0]> = [];
  const stops: Array<Effect.Effect<void>> = [];
  const controls = { failModel: false, failAuth: false, authInvalidations: 0, closed: 0 };
  let currentModel = nativeDefault;
  let promptIndex = 0;
  let active: NativePrompt | undefined;
  const fileHandlers: {
    read?: Parameters<Runtime["handleReadTextFile"]>[0];
    write?: Parameters<Runtime["handleWriteTextFile"]>[0];
  } = {};
  let permissionHandler:
    | ((
        request: AcpSchema.RequestPermissionRequest,
      ) => Effect.Effect<AcpSchema.RequestPermissionResponse, AcpErrors.AcpError>)
    | undefined;

  const configOptions = (): ReadonlyArray<AcpSchema.SessionConfigOption> => [
    {
      id: "model",
      name: "Model",
      type: "select",
      category: "model",
      currentValue: currentModel,
      options: [
        { value: nativeDefault, name: "Gemini test low" },
        { value: nativeAlternative, name: "Gemini test high" },
      ],
    },
  ];
  const drainEvents = Effect.gen(function* () {
    const acknowledge = yield* Deferred.make<void>();
    yield* Queue.offer(runtimeEvents, { _tag: "EventStreamBarrier", acknowledge });
    yield* Deferred.await(acknowledge);
  });
  const emitNative = (event: AcpSessionRuntimeEvent) =>
    Queue.offer(runtimeEvents, event).pipe(Effect.asVoid);
  const runtime: Effect.Success<ReturnType<AntigravityAdapterOptions["makeRuntime"]>> = {
    handleRequestPermission: (handler) =>
      Effect.sync(() => {
        permissionHandler = handler;
      }),
    handleReadTextFile: (handler) =>
      Effect.sync(() => {
        fileHandlers.read = handler;
      }),
    handleWriteTextFile: (handler) =>
      Effect.sync(() => {
        fileHandlers.write = handler;
      }),
    start: () =>
      Effect.gen(function* () {
        if (controls.failAuth) {
          return yield* new AcpErrors.AcpTransportError({
            detail: ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE,
            cause: undefined,
          });
        }
        currentModel = nativeDefault;
        calls.push("start");
        yield* emitNative({
          _tag: "AvailableCommandsUpdated",
          availableCommands: [
            { name: "plan", description: "Create a plan" },
            { name: "logout", description: "Sign out" },
          ],
          rawPayload: {},
        });
        return {
          sessionId: nativeSessionId,
          initializeResult: {
            protocolVersion: 1,
            agentCapabilities: { sessionCapabilities: { resume: {} } },
          },
          sessionSetupResult: { sessionId: nativeSessionId, configOptions: configOptions() },
          modelConfigId: "model",
        };
      }),
    getConfigOptions: Effect.sync(configOptions),
    setModel: (model) =>
      Effect.gen(function* () {
        calls.push(`model:${model}`);
        if (controls.failModel) {
          controls.failModel = false;
          return yield* AcpErrors.AcpRequestError.invalidParams("Native model selection failed.");
        }
        currentModel = model;
      }),
    setMode: (mode) =>
      Effect.sync(() => {
        calls.push(`mode:${mode}`);
        return {};
      }),
    getEvents: () => Stream.fromQueue(runtimeEvents),
    drainEvents,
    prompt: (payload, promptOptions) =>
      Effect.gen(function* () {
        yield* Deferred.succeed(dispatchStarted, undefined);
        if (options?.holdDispatch) yield* Deferred.await(dispatchRelease);
        const prompt: NativePrompt = {
          index: ++promptIndex,
          content: payload.prompt,
          result: yield* Deferred.make<AcpSchema.PromptResponse, AcpErrors.AcpError>(),
        };
        active = prompt;
        calls.push(`prompt:${prompt.index}`);
        if (promptOptions?.dispatched) yield* Deferred.succeed(promptOptions.dispatched, undefined);
        yield* Queue.offer(prompts, prompt);
        return yield* Deferred.await(prompt.result).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (active === prompt) active = undefined;
            }),
          ),
        );
      }),
    cancel: Effect.gen(function* () {
      const prompt = active;
      if (!prompt) return;
      calls.push(`cancel:${prompt.index}`);
      yield* Queue.offer(cancellations, prompt.index);
      if (options?.holdCancel) yield* Deferred.await(cancelRelease);
      yield* Deferred.succeed(prompt.result, { stopReason: "cancelled" });
      yield* Deferred.await(prompt.result);
      yield* drainEvents;
      calls.push(`drained:${prompt.index}`);
    }),
  };
  const commandUpdates: Array<ReadonlyArray<AcpSchema.AvailableCommand>> = [];
  const adapter = yield* makeAntigravityAdapter(
    decodeSettings({ enabled: options?.enabled ?? true }),
    {
      instanceId,
      makeRuntime: (input) =>
        Effect.gen(function* () {
          launches.push(input);
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              yield* Deferred.succeed(closeStarted, undefined);
              if (options?.holdClose) yield* Deferred.await(closeRelease);
              controls.closed += 1;
            }),
          );
          return runtime;
        }),
      withProcess: (stop, task) =>
        Effect.suspend(() => {
          stops.push(stop);
          return task;
        }),
      onAvailableCommands: (commands) =>
        Effect.sync(() => {
          commandUpdates.push(commands);
        }),
      onAuthRequired: Effect.sync(() => {
        controls.authInvalidations += 1;
      }),
    },
  );
  yield* adapter.streamEvents.pipe(
    Stream.runForEach((event) =>
      Effect.sync(() => {
        seen.push(event);
      }).pipe(Effect.andThen(Queue.offer(canonicalEvents, event))),
    ),
    Effect.forkScoped({ startImmediately: true }),
  );
  yield* Effect.addFinalizer(() =>
    Effect.all([
      Deferred.succeed(cancelRelease, undefined),
      Deferred.succeed(closeRelease, undefined),
      Deferred.succeed(dispatchRelease, undefined),
    ]).pipe(Effect.asVoid),
  );
  const waitForEvent = Effect.fn("AntigravityAdapterTest.waitForEvent")(function* <
    T extends ProviderRuntimeEvent,
  >(predicate: (event: ProviderRuntimeEvent) => event is T) {
    while (true) {
      const event = yield* Queue.take(canonicalEvents);
      if (predicate(event)) return event;
    }
  });
  const invokePermission = (request: AcpSchema.RequestPermissionRequest) =>
    Effect.suspend(() =>
      permissionHandler
        ? permissionHandler(request)
        : Effect.die("Missing native permission handler"),
    );
  return {
    fileHandlers,
    adapter,
    calls,
    launches,
    commandUpdates,
    controls,
    seen,
    stops,
    waitForEvent,
    emitNative,
    invokePermission,
    closeStarted,
    closeRelease,
    cancelRelease,
    dispatchStarted,
    dispatchRelease,
    nextPrompt: Queue.take(prompts),
    nextCancellation: Queue.take(cancellations),
    drainEvents,
    hasActivePrompt: () => active !== undefined,
  };
});

const layer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-antigravity-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

it.layer(layer)("AntigravityAdapter", (it) => {
  it.effect(
    "runs native auth, resume, models, commands, and streaming through the ACP transport",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crypto = yield* Crypto.Crypto;
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-antigravity-transport-",
        });
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        const requestLog = path.join(cwd, "requests.ndjson");
        const commands: string[] = [];
        const modelSelections: string[] = [];
        const observed: ProviderRuntimeEvent[] = [];
        const completed = yield* Deferred.make<void>();
        const adapter = yield* makeAntigravityAdapter(decodeSettings({ enabled: true }), {
          instanceId,
          withProcess: (_stop, task) => task,
          makeRuntime: (input) =>
            makeAntigravityAcpRuntime({
              ...input,
              childProcessSpawner,
              spawn: {
                command: process.execPath,
                args: [mockAgentPath],
                cwd: input.cwd,
                env: {
                  ...process.env,
                  T3_ACP_ANTIGRAVITY: "1",
                  T3_ACP_REQUEST_LOG_PATH: requestLog,
                },
                extendEnv: false,
              },
            }).pipe(Effect.provideService(Crypto.Crypto, crypto)),
          onAvailableCommands: (available) =>
            Effect.sync(() => {
              commands.push(...available.map((command) => command.name));
            }),
          onConfigOptionsUpdated: (configOptions) =>
            Effect.sync(() => {
              const model = configOptions.find((option) => option.category === "model");
              if (model?.type === "select") modelSelections.push(model.currentValue);
            }),
        });
        yield* adapter.streamEvents.pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              observed.push(event);
              if (event.type === "turn.completed") yield* Deferred.succeed(completed, undefined);
            }),
          ),
          Effect.forkScoped({ startImmediately: true }),
        );
        const original = yield* adapter.startSession({
          threadId,
          cwd,
          runtimeMode: "auto-accept-edits",
          modelSelection: { instanceId, model: nativeAlternative },
        });
        yield* adapter.stopSession(threadId);
        const resumed = yield* adapter.startSession({
          threadId,
          cwd,
          runtimeMode: "auto-accept-edits",
          modelSelection: { instanceId, model: nativeAlternative },
          resumeCursor: original.resumeCursor,
        });
        expect(resumed.model).toBe(nativeAlternative);
        yield* adapter.sendTurn({ threadId, input: "Reply with one short line." });
        yield* Deferred.await(completed);
        expect(commands).toEqual(["plan", "logout", "plan", "logout"]);
        expect(modelSelections.length).toBeGreaterThan(0);
        expect(modelSelections.every((model) => model === nativeAlternative)).toBe(true);
        expect(
          observed
            .filter((event) => event.type === "content.delta")
            .map((event) => event.payload.delta)
            .join(""),
        ).toBe("hello from mock");
        const lines = (yield* fileSystem.readFileString(requestLog)).trim().split("\n");
        const requests = yield* decodeRequestLog(lines);
        expect(
          requests
            .filter((request) => request.method === "authenticate")
            .map((request) => request.params),
        ).toEqual([{ methodId: "oauth-personal" }, { methodId: "oauth-personal" }]);
        expect(requests.some((request) => request.method === "session/resume")).toBe(true);
        expect(requests.some((request) => request.method === "session/load")).toBe(false);
        expect(
          requests
            .filter((request) => request.method === "session/set_config_option")
            .map((request) => request.params),
        ).toContainEqual({ sessionId: "mock-session-1", configId: "mode", value: "auto_edit" });
      }),
  );

  it.effect("reapplies the exact saved model and mode after a native resume", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const first = yield* h.adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "auto-accept-edits",
        modelSelection: { instanceId, model: nativeAlternative },
      });
      expect(first.model).toBe(nativeAlternative);
      yield* h.adapter.stopSession(threadId);
      const second = yield* h.adapter.startSession({
        threadId,
        cwd: "/tmp",
        runtimeMode: "auto-accept-edits",
        resumeCursor: first.resumeCursor,
        modelSelection: { instanceId, model: nativeAlternative },
      });
      expect(second.model).toBe(nativeAlternative);
      // The adapter resolves the cwd it was given through the host Path.
      expect(second.cwd).toBe((yield* Path.Path).resolve("/tmp"));
      expect(h.launches[1]?.resumeSessionId).toBe(nativeSessionId);
      expect(h.calls).toEqual([
        "start",
        `model:${nativeAlternative}`,
        "mode:auto_edit",
        "start",
        `model:${nativeAlternative}`,
        "mode:auto_edit",
      ]);
      expect(h.commandUpdates.at(-1)?.map((command) => command.name)).toEqual(["plan", "logout"]);
      expect(h.adapter.capabilities.supportsConversationRollback).toBe(false);
      const rollback = yield* h.adapter.rollbackThread(threadId, 1).pipe(Effect.exit);
      expect(Exit.isFailure(rollback)).toBe(true);
    }),
  );

  it.effect("keeps thoughts, native command results, and replies on the active turn", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const sending = yield* h.adapter
        .sendTurn({ threadId, input: "Read the file" })
        .pipe(Effect.forkChild);
      const prompt = yield* h.nextPrompt;
      yield* h.emitNative({ _tag: "ThoughtDelta", text: "I will read it.", rawPayload: {} });
      yield* h.emitNative({
        _tag: "ToolCallUpdated",
        toolCall: {
          toolCallId: "command-1",
          kind: "execute",
          status: "completed",
          data: {
            rawInput: { CommandLine: "cat probe.txt", Cwd: "/tmp" },
            rawOutput: { combinedOutput: "after\n", exitCode: 0 },
          },
        },
        rawPayload: {},
      });
      yield* h.emitNative({ _tag: "ContentDelta", text: "The file says after.", rawPayload: {} });
      yield* Deferred.succeed(prompt.result, { stopReason: "end_turn" });
      const result = yield* Fiber.join(sending);
      yield* h.waitForEvent((event) => event.type === "turn.completed");
      const deltas = h.seen.filter((event) => event.type === "content.delta");
      expect(deltas.map((event) => event.payload.streamKind)).toEqual([
        "reasoning_text",
        "assistant_text",
      ]);
      expect(deltas.every((event) => event.turnId === result.turnId)).toBe(true);
      const tool = h.seen.find(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "command_execution",
      );
      expect(tool?.type === "item.completed" ? tool.payload.data : undefined).toMatchObject({
        command: "cat probe.txt",
        cwd: "/tmp",
        item: { aggregatedOutput: "after\n", exitCode: 0 },
      });
    }),
  );

  it.effect("does not auto-approve a remaining native request in full access", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      const permission = yield* h
        .invokePermission({
          sessionId: nativeSessionId,
          toolCall: { toolCallId: "write-1", kind: "edit", title: "Write probe.txt" },
          options: [
            { optionId: "native:allow", name: "Allow", kind: "allow_once" },
            { optionId: "native:deny", name: "Deny", kind: "reject_once" },
          ],
        })
        .pipe(Effect.forkChild);
      const opened = yield* h.waitForEvent((event) => event.type === "request.opened");
      expect(h.calls).toContain("mode:yolo");
      expect(opened.payload.options).toEqual([
        { decision: "accept", label: "Allow once" },
        { decision: "decline", label: "Deny" },
        { decision: "cancel", label: "Cancel" },
      ]);
      expect(permission.pollUnsafe()).toBeUndefined();
      const always = yield* h.adapter
        .respondToRequest(threadId, ApprovalRequestId.make(opened.requestId!), "acceptAlways")
        .pipe(Effect.exit);
      expect(Exit.isFailure(always)).toBe(true);
      yield* h.adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(opened.requestId!),
        "decline",
      );
      expect(yield* Fiber.join(permission)).toEqual({
        outcome: { outcome: "selected", optionId: "native:deny" },
      });
    }),
  );

  it.effect("returns opaque native question choices and rejects ambiguous labels", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      const question = yield* h
        .invokePermission({
          sessionId: nativeSessionId,
          toolCall: { toolCallId: "interaction_opaque", title: "Which target?" },
          options: [
            { optionId: "choice:a", name: "Same label", kind: "allow_once" },
            { optionId: "choice:b", name: "Same label", kind: "allow_once" },
          ],
        })
        .pipe(Effect.forkChild);
      const opened = yield* h.waitForEvent((event) => event.type === "user-input.requested");
      expect(opened.payload.questions[0]?.allowCustomAnswer).toBe(false);
      expect(opened.payload.questions[0]?.options.map((option) => option.value)).toEqual([
        "choice:a",
        "choice:b",
      ]);
      const invalid = yield* h.adapter
        .respondToUserInput(threadId, ApprovalRequestId.make(opened.requestId!), {
          interaction_opaque: "Same label",
        })
        .pipe(Effect.exit);
      expect(Exit.isFailure(invalid)).toBe(true);
      expect(question.pollUnsafe()).toBeUndefined();
      yield* h.adapter.respondToUserInput(threadId, ApprovalRequestId.make(opened.requestId!), {
        interaction_opaque: "choice:b",
      });
      expect(yield* Fiber.join(question)).toEqual({
        outcome: { outcome: "selected", optionId: "choice:b" },
      });
    }),
  );

  it.effect("cancels native questions before waiting for the prompt to end", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const sending = yield* h.adapter
        .sendTurn({ threadId, input: "Ask a question" })
        .pipe(Effect.forkChild);
      yield* h.nextPrompt;
      const question = yield* h
        .invokePermission({
          sessionId: nativeSessionId,
          toolCall: { toolCallId: "interaction_cancel", title: "Continue?" },
          options: [{ optionId: "yes", name: "Yes", kind: "allow_once" }],
        })
        .pipe(Effect.forkChild);
      yield* h.waitForEvent((event) => event.type === "user-input.requested");
      yield* h.adapter.interruptTurn(threadId);
      expect(yield* Fiber.join(question)).toEqual({ outcome: { outcome: "cancelled" } });
      yield* Fiber.join(sending);
      const ended = yield* h.waitForEvent((event) => event.type === "turn.completed");
      expect(ended.payload.state).toBe("cancelled");
      expect(h.seen.some((event) => event.type === "user-input.resolved")).toBe(true);
    }),
  );

  it.effect("waits for native cancellation before a steer changes the model", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ holdCancel: true });
      yield* h.adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const first = yield* h.adapter
        .sendTurn({ threadId, input: "First prompt" })
        .pipe(Effect.forkChild);
      const initialPrompt = yield* h.nextPrompt;
      expect(initialPrompt.content).toEqual([
        { type: "text", text: "First prompt" },
        { type: "text", text: expect.stringContaining(`Antigravity harness, as ${nativeDefault}`) },
      ]);
      const marker = h.calls.length;
      const second = yield* h.adapter
        .sendTurn({
          threadId,
          input: "Steer the turn",
          modelSelection: { instanceId, model: nativeAlternative },
        })
        .pipe(Effect.forkChild);
      expect(yield* h.nextCancellation).toBe(1);
      expect(h.calls.slice(marker)).toEqual(["cancel:1"]);
      yield* h.emitNative({
        _tag: "ContentDelta",
        text: "The first prompt stopped.",
        rawPayload: {},
      });
      yield* Deferred.succeed(h.cancelRelease, undefined);
      const replacement = yield* h.nextPrompt;
      expect(replacement.content).toEqual([
        { type: "text", text: "Steer the turn" },
        {
          type: "text",
          text: expect.stringContaining(`Antigravity harness, as ${nativeAlternative}`),
        },
      ]);
      expect(h.calls.slice(marker)).toEqual([
        "cancel:1",
        "drained:1",
        `model:${nativeAlternative}`,
        "mode:default",
        "prompt:2",
      ]);
      yield* Deferred.succeed(replacement.result, { stopReason: "end_turn" });
      const [oldResult, newResult] = yield* Effect.all([Fiber.join(first), Fiber.join(second)]);
      expect(oldResult.turnId).toBe(newResult.turnId);
      yield* h.waitForEvent((event) => event.type === "turn.completed");
      expect(h.seen.filter((event) => event.type === "turn.completed")).toHaveLength(1);
      expect((yield* h.adapter.listSessions())[0]).toMatchObject({
        status: "ready",
        activeTurnId: undefined,
        model: nativeAlternative,
      });
    }),
  );

  it.effect("rejects an unavailable steer model without cancelling current work", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const first = yield* h.adapter
        .sendTurn({ threadId, input: "Keep working" })
        .pipe(Effect.forkChild);
      const prompt = yield* h.nextPrompt;
      const invalid = yield* h.adapter
        .sendTurn({
          threadId,
          input: "Change model",
          modelSelection: { instanceId, model: "not-in-this-account" },
        })
        .pipe(Effect.exit);
      expect(Exit.isFailure(invalid)).toBe(true);
      expect(h.calls.some((call) => call.startsWith("cancel:"))).toBe(false);
      expect(h.hasActivePrompt()).toBe(true);
      yield* Deferred.succeed(prompt.result, { stopReason: "end_turn" });
      yield* Fiber.join(first);
    }),
  );

  it.effect("settles a failed steer configuration and allows a later turn", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const first = yield* h.adapter.sendTurn({ threadId, input: "First" }).pipe(Effect.forkChild);
      yield* h.nextPrompt;
      h.controls.failModel = true;
      const failed = yield* h.adapter
        .sendTurn({
          threadId,
          input: "Replacement",
          modelSelection: { instanceId, model: nativeAlternative },
        })
        .pipe(Effect.exit);
      expect(Exit.isFailure(failed)).toBe(true);
      yield* Fiber.join(first);
      const ended = yield* h.waitForEvent((event) => event.type === "turn.completed");
      expect(ended.payload.state).toBe("failed");
      expect((yield* h.adapter.listSessions())[0]).toMatchObject({
        status: "error",
        activeTurnId: undefined,
      });
      const later = yield* h.adapter
        .sendTurn({ threadId, input: "Try again" })
        .pipe(Effect.forkChild);
      const prompt = yield* h.nextPrompt;
      yield* Deferred.succeed(prompt.result, { stopReason: "end_turn" });
      const recovered = yield* Fiber.join(later);
      expect(recovered.turnId).not.toBe(ended.turnId);
      expect((yield* h.adapter.listSessions())[0]?.status).toBe("ready");
    }),
  );

  it.effect("cancels the native prompt if its send caller is interrupted", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const sending = yield* h.adapter
        .sendTurn({ threadId, input: "Keep working" })
        .pipe(Effect.forkChild);
      yield* h.nextPrompt;
      yield* Fiber.interrupt(sending);
      const ended = yield* h.waitForEvent((event) => event.type === "turn.completed");
      expect(ended.payload.state).toBe("cancelled");
      expect(h.hasActivePrompt()).toBe(false);
      expect((yield* h.adapter.listSessions())[0]).toMatchObject({
        status: "ready",
        activeTurnId: undefined,
      });
    }),
  );

  it.effect("tracks native commands that survive a turn and clears terminal tasks", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const sending = yield* h.adapter
        .sendTurn({ threadId, input: "Start a watcher" })
        .pipe(Effect.forkChild);
      const prompt = yield* h.nextPrompt;
      yield* h.emitNative({
        _tag: "ToolCallUpdated",
        toolCall: {
          toolCallId: "watcher-1",
          kind: "execute",
          status: "inProgress",
          command: "watch files",
          data: {},
        },
        rawPayload: {},
      });
      yield* Deferred.succeed(prompt.result, { stopReason: "end_turn" });
      const turn = yield* Fiber.join(sending);
      const started = yield* h.waitForEvent((event) => event.type === "task.started");
      expect(started.payload.taskType).toBe("local_bash");
      expect(started.turnId).toBe(turn.turnId);
      yield* h.emitNative({
        _tag: "ToolCallUpdated",
        toolCall: { toolCallId: "watcher-1", kind: "execute", status: "completed", data: {} },
        rawPayload: {},
      });
      const ended = yield* h.waitForEvent((event) => event.type === "task.completed");
      expect(ended.payload.taskId).toBe(started.payload.taskId);
      expect(ended.payload.status).toBe("completed");
    }),
  );

  it.effect("keeps a launched batch active while child tools continue", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      const sending = yield* h.adapter
        .sendTurn({ threadId, input: "Run two readers in one batch" })
        .pipe(Effect.forkChild);
      const prompt = yield* h.nextPrompt;
      // ACP 1.1.1 capture: one launch call covers both children and returns
      // only its description before either child finishes.
      const started = nativeToolUpdate({
        sessionUpdate: "tool_call",
        toolCallId: `${nativeSessionId}:2`,
        title: "Running start_subagent",
        kind: "other",
        status: "in_progress",
        rawInput: {},
      });
      yield* h.emitNative(started);
      yield* h.waitForEvent((event) => event.type === "task.progress");
      yield* h.emitNative(
        nativeToolUpdate(
          {
            sessionUpdate: "tool_call_update",
            toolCallId: started.toolCall.toolCallId,
            status: "completed",
            rawOutput: "Launch subagents",
          },
          started.toolCall,
        ),
      );
      const launched = yield* h.waitForEvent((event) => event.type === "task.progress");
      expect(launched.payload).toMatchObject({
        taskId: started.toolCall.toolCallId,
        title: "Antigravity subagent batch",
        taskType: "subagent_batch",
        description: "Launch subagents",
        status: "running",
      });
      for (const child of ["alpha", "beta"]) {
        yield* h.emitNative(
          nativeToolUpdate({
            sessionUpdate: "tool_call",
            toolCallId: `${child}:1`,
            title: "Read file",
            kind: "read",
            status: "completed",
            rawOutput: "File contents",
          }),
        );
      }
      yield* h.drainEvents;
      expect(h.seen.filter((event) => event.type === "task.completed")).toHaveLength(0);
      expect(h.seen.filter((event) => event.type === "task.updated")).toHaveLength(0);
      yield* Deferred.succeed(prompt.result, { stopReason: "end_turn" });
      yield* Fiber.join(sending);
      yield* h.waitForEvent((event) => event.type === "turn.completed");
      expect(h.seen.filter((event) => event.type === "task.completed")).toHaveLength(0);
      expect(h.seen.find((event) => event.type === "task.updated")?.payload).toMatchObject({
        taskId: started.toolCall.toolCallId,
        status: "idle",
        description: "Turn ended. Individual agent status is unavailable.",
        timelineBypass: true,
      });
    }),
  );

  it.effect("waits for a replayed subagent's final status and result", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      // ACP history announces a completed tool first, even when its result failed.
      yield* h.emitNative(
        nativeToolUpdate({
          sessionUpdate: "tool_call",
          toolCallId: "replayed:4",
          title: "Running start_subagent",
          kind: "other",
          status: "completed",
          rawInput: "{}",
        }),
      );
      yield* h.emitNative(
        nativeToolUpdate({
          sessionUpdate: "tool_call_update",
          toolCallId: "replayed:4",
          status: "failed",
          rawOutput: "Review failed.",
        }),
      );
      const completed = yield* h.waitForEvent((event) => event.type === "task.completed");
      expect(completed.payload).toEqual({
        taskId: "replayed:4",
        taskType: "subagent_batch",
        toolUseId: "replayed:4",
        title: "Antigravity subagent batch",
        status: "failed",
        summary: "Review failed.",
      });
      expect(h.seen.filter((event) => event.type.startsWith("task."))).toHaveLength(1);
    }),
  );

  it.effect("keeps one-message launches active and ignores late updates after settlement", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      const first = yield* h.adapter
        .sendTurn({ threadId, input: "Start readers" })
        .pipe(Effect.forkChild);
      const firstPrompt = yield* h.nextPrompt;
      const launches = ["Launch readers", undefined].map((rawOutput, index) =>
        nativeToolUpdate({
          sessionUpdate: "tool_call",
          toolCallId: `old:${index}`,
          title: "Running start_subagent",
          kind: "other",
          status: "completed",
          rawInput: {},
          ...(rawOutput ? { rawOutput } : {}),
        }),
      );
      for (const launch of launches) yield* h.emitNative(launch);
      yield* h.drainEvents;
      expect(h.seen.filter((event) => event.type === "task.progress")).toHaveLength(2);
      expect(h.seen.filter((event) => event.type === "task.completed")).toHaveLength(0);
      yield* Deferred.succeed(firstPrompt.result, { stopReason: "end_turn" });
      yield* Fiber.join(first);
      yield* h.waitForEvent((event) => event.type === "turn.completed");
      const second = yield* h.adapter
        .sendTurn({ threadId, input: "Next task" })
        .pipe(Effect.forkChild);
      const secondPrompt = yield* h.nextPrompt;
      for (const launch of launches) {
        for (const status of ["in_progress", "completed", "failed"] as const) {
          yield* h.emitNative(
            nativeToolUpdate(
              {
                sessionUpdate: "tool_call_update",
                toolCallId: launch.toolCall.toolCallId,
                status,
                rawOutput: "Late update",
              },
              launch.toolCall,
            ),
          );
        }
      }
      yield* h.drainEvents;
      expect(h.seen.filter((event) => event.type === "task.progress")).toHaveLength(2);
      expect(h.seen.filter((event) => event.type === "task.updated")).toHaveLength(2);
      expect(h.seen.filter((event) => event.type === "task.completed")).toHaveLength(0);
      yield* Deferred.succeed(secondPrompt.result, { stopReason: "end_turn" });
      yield* Fiber.join(second);
    }),
  );

  it.effect("does not report a historical launch as running or completed work", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      const launch = nativeToolUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "history:2",
        title: "Running start_subagent",
        kind: "other",
        status: "completed",
        rawInput: {},
      });
      yield* h.emitNative(launch);
      yield* h.emitNative(
        nativeToolUpdate(
          {
            sessionUpdate: "tool_call_update",
            toolCallId: launch.toolCall.toolCallId,
            status: "completed",
            rawOutput: "Launch readers",
          },
          launch.toolCall,
        ),
      );
      yield* h.drainEvents;
      expect(h.seen.filter((event) => event.type.startsWith("task."))).toMatchObject([
        {
          type: "task.updated",
          payload: { status: "idle", timelineBypass: true },
        },
      ]);
    }),
  );

  it.effect("keeps MCP identity when later updates omit metadata", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const sending = yield* h.adapter
        .sendTurn({ threadId, input: "Run an MCP tool" })
        .pipe(Effect.forkChild);
      const prompt = yield* h.nextPrompt;
      const started = nativeToolUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "mcp-4",
        title: "Running start_subagent",
        kind: "other",
        status: "in_progress",
        rawInput: { arguments: {} },
        _meta: { is_mcp_tool_call: true },
      });
      yield* h.emitNative(started);
      for (const status of ["in_progress", "completed"] as const) {
        yield* h.emitNative(
          nativeToolUpdate(
            {
              sessionUpdate: "tool_call_update",
              toolCallId: "mcp-4",
              status,
              rawOutput: "MCP output.",
            },
            started.toolCall,
          ),
        );
      }
      yield* Deferred.succeed(prompt.result, { stopReason: "end_turn" });
      yield* Fiber.join(sending);
      yield* h.waitForEvent((event) => event.type === "turn.completed");
      expect(h.seen.filter((event) => event.type.startsWith("task."))).toHaveLength(0);
      expect(h.seen.filter((event) => event.type === "item.updated")).toHaveLength(2);
      expect(h.seen.filter((event) => event.type === "item.completed")).toHaveLength(1);
    }),
  );

  it.effect("shows pending subagents and closes a denied invocation", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* h.emitNative(
        nativeToolUpdate({
          sessionUpdate: "tool_call",
          toolCallId: "permission-1",
          title: "Run start_subagent?",
          kind: "other",
          status: "pending",
          rawInput: {},
        }),
      );
      const pending = yield* h.waitForEvent((event) => event.type === "task.progress");
      expect(pending.payload.status).toBe("pending");
      yield* h.emitNative(
        nativeToolUpdate({
          sessionUpdate: "tool_call_update",
          toolCallId: "permission-1",
          status: "failed",
        }),
      );
      const completed = yield* h.waitForEvent((event) => event.type === "task.completed");
      expect(completed.payload.status).toBe("failed");
    }),
  );

  for (const stop of ["cancel", "steer", "disconnect", "end_turn"] as const) {
    it.effect(`settles open subagent calls on ${stop}`, () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        yield* h.adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        });
        const sending = yield* h.adapter
          .sendTurn({ threadId, input: "Start a subagent" })
          .pipe(Effect.forkChild);
        const prompt = yield* h.nextPrompt;
        yield* h.emitNative(
          nativeToolUpdate({
            sessionUpdate: "tool_call",
            toolCallId: "trajectory:4",
            title: "Running start_subagent",
            kind: "other",
            status: "in_progress",
            rawInput: {},
          }),
        );
        yield* h.waitForEvent((event) => event.type === "task.progress");
        yield* h.emitNative(
          nativeToolUpdate({
            sessionUpdate: "tool_call_update",
            toolCallId: "trajectory:4",
            status: "completed",
            rawOutput: "Launch subagents",
          }),
        );
        yield* h.waitForEvent((event) => event.type === "task.progress");
        if (stop === "disconnect") {
          yield* h.emitNative({
            _tag: "ConnectionTerminated",
            error: new AcpErrors.AcpTransportError({ detail: "Process exited.", cause: undefined }),
          });
        } else if (stop === "cancel") {
          yield* h.adapter.interruptTurn(threadId);
        } else if (stop === "steer") {
          const steering = yield* h.adapter
            .sendTurn({ threadId, input: "Change direction" })
            .pipe(Effect.forkChild);
          const replacement = yield* h.nextPrompt;
          yield* Deferred.succeed(replacement.result, { stopReason: "end_turn" });
          yield* Fiber.join(steering);
        } else {
          yield* Deferred.succeed(prompt.result, { stopReason: "end_turn" });
        }
        const settled = yield* h.waitForEvent((event) => event.type === "task.updated");
        expect(settled.payload).toMatchObject({
          taskId: "trajectory:4",
          title: "Antigravity subagent batch",
          taskType: "subagent_batch",
          status:
            stop === "disconnect"
              ? "failed"
              : stop === "cancel" || stop === "steer"
                ? "cancelled"
                : "idle",
        });
        if (stop === "disconnect")
          yield* h.waitForEvent((event) => event.type === "session.exited");
        else yield* Fiber.join(sending);
      }),
    );
  }

  it.effect("retires a prompt cancelled before native dispatch", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ holdDispatch: true });
      yield* h.adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const sending = yield* h.adapter
        .sendTurn({ threadId, input: "Do not dispatch this prompt" })
        .pipe(Effect.forkChild);
      yield* Deferred.await(h.dispatchStarted);
      yield* Fiber.interrupt(sending);
      yield* Deferred.succeed(h.dispatchRelease, undefined);
      const cancelled = yield* h.waitForEvent((event) => event.type === "turn.completed");
      expect(cancelled.payload.state).toBe("cancelled");
      expect(h.calls.some((call) => call.startsWith("prompt:"))).toBe(false);
      expect(h.hasActivePrompt()).toBe(false);
      const later = yield* h.adapter
        .sendTurn({ threadId, input: "This prompt can run" })
        .pipe(Effect.forkChild);
      const prompt = yield* h.nextPrompt;
      yield* Deferred.succeed(prompt.result, { stopReason: "end_turn" });
      const result = yield* Fiber.join(later);
      expect(result.turnId).not.toBe(cancelled.turnId);
      expect(h.calls.filter((call) => call.startsWith("prompt:"))).toEqual(["prompt:1"]);
    }),
  );

  it.effect("awaits full process cleanup for concurrent stop requests", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ holdClose: true });
      yield* h.adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const stopping = yield* h.adapter.stopSession(threadId).pipe(Effect.forkChild);
      yield* Deferred.await(h.closeStarted);
      const registeredStop = h.stops[0];
      if (!registeredStop) return yield* Effect.die("Missing process cleanup registration");
      const signOutStop = yield* registeredStop.pipe(Effect.forkChild({ startImmediately: true }));
      expect(signOutStop.pollUnsafe()).toBeUndefined();
      yield* Deferred.succeed(h.closeRelease, undefined);
      yield* Effect.all([Fiber.join(stopping), Fiber.join(signOutStop)]);
      yield* h.waitForEvent((event) => event.type === "session.exited");
      expect(h.controls.closed).toBe(1);
      expect(h.seen.filter((event) => event.type === "session.exited")).toHaveLength(1);
      expect(yield* h.adapter.hasSession(threadId)).toBe(false);
    }),
  );

  it.effect("stops a session while its prompt is waiting to dispatch", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ holdDispatch: true });
      yield* h.adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const sending = yield* h.adapter
        .sendTurn({ threadId, input: "Do not dispatch after stop" })
        .pipe(Effect.forkChild);
      yield* Deferred.await(h.dispatchStarted);
      yield* h.adapter.stopSession(threadId);
      yield* Fiber.await(sending);
      yield* Deferred.succeed(h.dispatchRelease, undefined);
      expect(h.calls.some((call) => call.startsWith("prompt:"))).toBe(false);
      expect(h.controls.closed).toBe(1);
      expect(yield* h.adapter.hasSession(threadId)).toBe(false);
    }),
  );

  it.effect("propagates idle process exits and rejects stale session use", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* h.emitNative({
        _tag: "ConnectionTerminated",
        error: new AcpErrors.AcpTransportError({ detail: "Process exited.", cause: undefined }),
      });
      const exited = yield* h.waitForEvent((event) => event.type === "session.exited");
      expect(exited.payload.exitKind).toBe("error");
      expect(yield* h.adapter.hasSession(threadId)).toBe(false);
      expect(
        Exit.isFailure(yield* h.adapter.sendTurn({ threadId, input: "Hello" }).pipe(Effect.exit)),
      ).toBe(true);
    }),
  );

  it.effect("reports hidden login requests as sign-in required and clears account metadata", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.controls.failAuth = true;
      const started = yield* h.adapter
        .startSession({ threadId, cwd: process.cwd(), runtimeMode: "approval-required" })
        .pipe(Effect.exit);
      expect(Exit.isFailure(started)).toBe(true);
      expect(h.controls.authInvalidations).toBe(1);
      expect(h.controls.closed).toBe(1);
      expect(yield* h.adapter.hasSession(threadId)).toBe(false);
    }),
  );

  it.effect("serves client file reads and writes only inside the session roots", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const h = yield* makeHarness();
      const { attachmentsDir } = yield* ServerConfig;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-fs-" });
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-outside-" });
      yield* fs.writeFileString(path.join(cwd, "notes.txt"), "one\ntwo\nthree\n");
      yield* h.adapter.startSession({ threadId, cwd, runtimeMode: "approval-required" });
      expect(h.launches[0]?.clientFileSystem).toBe(true);
      expect(h.launches[0]?.additionalDirectories).toEqual([attachmentsDir]);
      const read = h.fileHandlers.read;
      const write = h.fileHandlers.write;
      if (!read || !write) return yield* Effect.die("File handlers were not registered.");

      const full = yield* read({ sessionId: nativeSessionId, path: path.join(cwd, "notes.txt") });
      expect(full.content).toBe("one\ntwo\nthree\n");
      const window = yield* read({
        sessionId: nativeSessionId,
        path: path.join(cwd, "notes.txt"),
        line: 2,
        limit: 1,
      });
      expect(window.content).toBe("two");

      yield* write({
        sessionId: nativeSessionId,
        path: path.join(cwd, "nested", "new.txt"),
        content: "created",
      });
      expect(yield* fs.readFileString(path.join(cwd, "nested", "new.txt"))).toBe("created");

      const escape = yield* write({
        sessionId: nativeSessionId,
        path: path.join(outside, "escape.txt"),
        content: "nope",
      }).pipe(Effect.flip);
      expect(escape._tag).toBe("AcpRequestError");
      expect(yield* fs.exists(path.join(outside, "escape.txt"))).toBe(false);
      const missing = yield* read({
        sessionId: nativeSessionId,
        path: path.join(cwd, "missing.txt"),
      }).pipe(Effect.flip);
      expect(missing._tag).toBe("AcpRequestError");
    }).pipe(Effect.scoped),
  );

  it.effect("does not launch a process for a disabled instance or invalid resume cursor", () =>
    Effect.gen(function* () {
      const disabled = yield* makeHarness({ enabled: false });
      const rejected = yield* disabled.adapter
        .startSession({ threadId, cwd: process.cwd(), runtimeMode: "approval-required" })
        .pipe(Effect.exit);
      expect(Exit.isFailure(rejected)).toBe(true);
      expect(disabled.launches).toHaveLength(0);
      const active = yield* makeHarness();
      const stale = yield* active.adapter
        .startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
          resumeCursor: { sessionId: nativeSessionId },
        })
        .pipe(Effect.exit);
      expect(Exit.isFailure(stale)).toBe(true);
      expect(active.launches).toHaveLength(0);
    }),
  );
});
