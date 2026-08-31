// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  ApprovalRequestId,
  DroidSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import {
  droidApprovalOptions,
  droidTokenUsageSnapshot,
  forkDroidPromptConsumer,
  makeDroidAdapter,
  selectDroidPermissionOutcome,
  settleDroidNativeServerResponse,
} from "./DroidAdapter.ts";
import {
  DROID_SERVER_REQUEST_CONCURRENCY,
  DROID_SESSION_REQUEST_TIMEOUT_MS,
  DroidRpcError,
} from "../droid/DroidRpcClient.ts";

const decodeDroidSettings = Schema.decodeSync(DroidSettings);
const decodeUnknownJsonString = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeDroidPermissionResponse = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      error: Schema.optional(Schema.Unknown),
      selectedOption: Schema.optional(Schema.Unknown),
    }),
  ),
);
const permissionResponseCases = [
  { label: "accept", decision: "accept" },
  { label: "decline", decision: "decline" },
] as const;
const userInputResponseCases = [
  { label: "workspace", answers: { "1": "workspace" } },
  { label: "session", answers: { "1": "session" } },
] as const;

it.effect("starts the Droid prompt consumer before fork returns", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const started = yield* Deferred.make<void>();

    yield* forkDroidPromptConsumer(
      Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      scope,
    );

    assert.isTrue(yield* Deferred.isDone(started));
    yield* Scope.close(scope, Exit.void);
  }),
);

it("derives Droid approval capabilities without escalating one-shot approval", () => {
  const options = [
    { label: "Always allow", outcome: "proceed_always" },
    { label: "Cancel", outcome: "cancel" },
  ] as const;

  assert.deepEqual(droidApprovalOptions(options), [
    { decision: "acceptForSession", label: "Always allow" },
    { decision: "decline", label: "Cancel" },
  ]);
  assert.deepEqual(droidApprovalOptions([{ label: "Allow once", outcome: "proceed_once" }]), [
    { decision: "accept", label: "Allow once" },
  ]);
  assert.isUndefined(selectDroidPermissionOutcome(options, "accept"));
  assert.equal(selectDroidPermissionOutcome(options, "acceptForSession"), "proceed_always");
});

it.effect("uses one timeout budget for native Droid server responses", () =>
  Effect.gen(function* () {
    const nativeResponse = yield* Deferred.make<void, DroidRpcError>();
    const awaitResponse = yield* Deferred.await(nativeResponse).pipe(
      Effect.result,
      Effect.forkChild,
    );
    const settle = yield* settleDroidNativeServerResponse(
      "droid.request_permission",
      nativeResponse,
      (respond) =>
        Effect.sleep(Duration.millis(DROID_SESSION_REQUEST_TIMEOUT_MS + 1)).pipe(
          Effect.andThen(
            respond(Effect.sleep(Duration.millis(DROID_SESSION_REQUEST_TIMEOUT_MS - 1))),
          ),
        ),
    ).pipe(Effect.result, Effect.forkChild);

    yield* advanceTestClock(DROID_SESSION_REQUEST_TIMEOUT_MS + 1);
    assert.isUndefined(awaitResponse.pollUnsafe());
    yield* advanceTestClock(DROID_SESSION_REQUEST_TIMEOUT_MS - 1);

    assert.equal((yield* Fiber.join(settle))._tag, "Success");
    assert.equal((yield* Fiber.join(awaitResponse))._tag, "Success");
  }),
);

it.effect("preserves native Droid server response timeouts", () =>
  Effect.gen(function* () {
    const nativeResponse = yield* Deferred.make<void, DroidRpcError>();
    const settle = yield* settleDroidNativeServerResponse(
      "droid.ask_user",
      nativeResponse,
      (respond) => respond(Effect.never),
    ).pipe(Effect.result, Effect.forkChild);

    yield* advanceTestClock(DROID_SESSION_REQUEST_TIMEOUT_MS);

    const result = yield* Fiber.join(settle);
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.equal(result.failure.kind, "timeout");
      assert.equal(result.failure.method, "droid.ask_user");
    }
    const acknowledgement = yield* Deferred.await(nativeResponse).pipe(Effect.result);
    assert.equal(acknowledgement._tag, "Failure");
    if (acknowledgement._tag === "Failure") {
      assert.equal(acknowledgement.failure.kind, "timeout");
      assert.equal(acknowledgement.failure.method, "droid.ask_user");
    }
  }),
);

it.effect("settles native Droid acknowledgements when response preparation is interrupted", () =>
  Effect.gen(function* () {
    const nativeResponse = yield* Deferred.make<void, DroidRpcError>();
    const settle = yield* settleDroidNativeServerResponse(
      "droid.request_permission",
      nativeResponse,
      () => Effect.never,
    ).pipe(Effect.forkChild);

    yield* Effect.yieldNow;
    yield* Fiber.interrupt(settle);

    const acknowledgement = yield* Deferred.await(nativeResponse).pipe(Effect.result);
    assert.equal(acknowledgement._tag, "Failure");
    if (acknowledgement._tag === "Failure") {
      assert.equal(acknowledgement.failure.kind, "write");
      assert.equal(acknowledgement.failure.method, "droid.request_permission");
    }
  }),
);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/droid-mock-agent.ts");

const droidAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-droid-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

type DroidTestAdapter = Effect.Success<ReturnType<typeof makeDroidAdapter>>;
type DroidAdapterOptions = NonNullable<Parameters<typeof makeDroidAdapter>[1]>;
type DroidStartSessionInput = Parameters<DroidTestAdapter["startSession"]>[0];
type DroidSendTurnInput = Parameters<DroidTestAdapter["sendTurn"]>[0];

const makeDroidScenario = (
  mockEnv: Record<string, string> = {},
  adapterOptions?: DroidAdapterOptions,
) =>
  Effect.gen(function* () {
    const adapter = yield* makeDroidAdapter(decodeDroidSettings({ binaryPath: mockAgentPath }), {
      ...adapterOptions,
      environment: {
        ...adapterOptions?.environment,
        ...mockEnv,
        T3_DROID_MOCK_SCENARIO: mockEnv.T3_DROID_MOCK_SCENARIO ?? "default",
      },
    }).pipe(Effect.orDie);

    return { adapter };
  });

const startDroidSession = (
  adapter: DroidTestAdapter,
  threadId: ThreadId,
  runtimeMode: DroidStartSessionInput["runtimeMode"],
  options: Omit<DroidStartSessionInput, "threadId" | "provider" | "cwd" | "runtimeMode"> = {},
) =>
  adapter.startSession({
    threadId,
    provider: ProviderDriverKind.make("droid"),
    cwd: process.cwd(),
    runtimeMode,
    ...options,
  });

const sendDroidTurn = (
  adapter: DroidTestAdapter,
  threadId: ThreadId,
  input: string,
  options: Omit<DroidSendTurnInput, "threadId" | "input" | "attachments"> = {},
) => adapter.sendTurn({ threadId, input, attachments: [], ...options });

const eventsForThread = (events: ReadonlyArray<ProviderRuntimeEvent>, threadId: ThreadId) =>
  events.filter((event) => String(event.threadId) === String(threadId));

const eventsForTurn = (
  events: ReadonlyArray<ProviderRuntimeEvent>,
  threadId: ThreadId,
  turnId: TurnId,
) =>
  eventsForThread(events, threadId).filter(
    (event) => event.turnId !== undefined && String(event.turnId) === String(turnId),
  );

const eventsOfType = <Type extends ProviderRuntimeEvent["type"]>(
  events: ReadonlyArray<ProviderRuntimeEvent>,
  type: Type,
) =>
  events.filter(
    (event): event is Extract<ProviderRuntimeEvent, { type: Type }> => event.type === type,
  );

const assistantText = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
  eventsOfType(events, "content.delta")
    .filter((event) => event.payload.streamKind === "assistant_text")
    .map((event) => event.payload.delta)
    .join("");

const assertSingleTerminal = (
  events: ReadonlyArray<ProviderRuntimeEvent>,
  threadId: ThreadId,
  turnId: TurnId,
) => assert.lengthOf(eventsOfType(eventsForTurn(events, threadId, turnId), "turn.completed"), 1);

const collectDroidEvents = (adapter: DroidTestAdapter) =>
  Effect.gen(function* () {
    const events: ProviderRuntimeEvent[] = [];
    const waiters: Array<{
      readonly predicate: (event: ProviderRuntimeEvent) => boolean;
      readonly occurrence: number;
      readonly deferred: Deferred.Deferred<ProviderRuntimeEvent>;
    }> = [];
    yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.sync(() => {
        events.push(event);
        for (const waiter of waiters) {
          const matches = events.filter(waiter.predicate);
          if (matches.length >= waiter.occurrence) {
            Deferred.doneUnsafe(waiter.deferred, Effect.succeed(matches[waiter.occurrence - 1]!));
          }
        }
      }),
    ).pipe(Effect.forkScoped);

    const waitFor = <Event extends ProviderRuntimeEvent>(
      predicate: (event: ProviderRuntimeEvent) => event is Event,
      occurrence = 1,
    ): Effect.Effect<Event> =>
      Effect.suspend(() => {
        const existing = events.filter(predicate)[occurrence - 1];
        if (existing !== undefined) return Effect.succeed(existing);
        const deferred = Deferred.makeUnsafe<ProviderRuntimeEvent>();
        waiters.push({ predicate, occurrence, deferred });
        return Deferred.await(deferred) as Effect.Effect<Event>;
      });

    const waitForType = <Type extends ProviderRuntimeEvent["type"]>(
      threadId: ThreadId,
      type: Type,
      occurrence = 1,
    ) =>
      waitFor(
        (event): event is Extract<ProviderRuntimeEvent, { type: Type }> =>
          event.type === type && String(event.threadId) === String(threadId),
        occurrence,
      );

    return { events, waitFor, waitForType };
  });

const advanceTestClock = (ms: number) =>
  TestClock.adjust(`${ms} millis`).pipe(Effect.andThen(Effect.yieldNow));

async function waitForFile(filePath: string) {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const watcher = NodeFS.watch(NodePath.dirname(filePath), (_eventType, filename) => {
      if (String(filename) !== NodePath.basename(filePath)) return;
      void NodeFSP.access(filePath).then(finish, () => {});
    });
    const finish = () => {
      if (settled) return;
      settled = true;
      watcher.close();
      resolve();
    };
    watcher.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    void NodeFSP.access(filePath).then(finish, () => {});
  });
}

function isProcessAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

it("counts cache creation as processed spend but not live context", () => {
  const usage = {
    inputTokens: 20,
    outputTokens: 8,
    cacheCreationTokens: 6,
    cacheReadTokens: 4,
    thinkingTokens: 3,
  };
  assert.deepInclude(droidTokenUsageSnapshot(usage), {
    usedTokens: 32,
    totalProcessedTokens: 38,
  });
  assert.deepInclude(
    droidTokenUsageSnapshot(usage, {
      inputTokens: 7,
      cacheReadTokens: 2,
      outputTokens: 3,
    }),
    {
      usedTokens: 12,
      totalProcessedTokens: 38,
      lastUsedTokens: 12,
    },
  );
});

it.layer(droidAdapterTestLayer)("DroidAdapterLive", (it) => {
  it.effect("maps a Droid turn to ordered reasoning, assistant, usage, and completion events", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-turn-lifecycle");
      const { adapter } = yield* makeDroidScenario();
      const { events: runtimeEvents, waitForType } = yield* collectDroidEvents(adapter);
      const session = yield* startDroidSession(adapter, threadId, "full-access", {
        modelSelection: {
          instanceId: ProviderInstanceId.make("droid"),
          model: "mock-deep",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      });
      assert.equal(session.provider, "droid");
      assert.equal(session.model, "mock-deep");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 2,
        sessionId: "mock-session-1",
        turnIds: [],
      });
      const sentTurn = yield* sendDroidTurn(adapter, threadId, "hello droid");
      const terminal = yield* waitForType(threadId, "turn.completed");
      const threadEvents = eventsForThread(runtimeEvents, threadId);
      const turnEvents = threadEvents.filter(
        (event) => event.turnId !== undefined && String(event.turnId) === String(sentTurn.turnId),
      );
      assert.deepEqual(
        turnEvents.map((event) => event.type),
        [
          "turn.started",
          "item.started",
          "content.delta",
          "item.completed",
          "item.started",
          "content.delta",
          "content.delta",
          "item.completed",
          "turn.completed",
        ],
      );
      const contentDeltas = turnEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "content.delta" }> =>
          event.type === "content.delta",
      );
      assert.deepEqual(
        contentDeltas.map((event) => [event.payload.streamKind, event.payload.delta]),
        [
          ["reasoning_text", "Mock thinking"],
          ["assistant_text", "hello from "],
          ["assistant_text", "droid mock"],
        ],
      );
      assert.isTrue(contentDeltas.every((event) => event.raw === undefined));
      const startedItems = turnEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "item.started" }> =>
          event.type === "item.started",
      );
      assert.deepEqual(
        startedItems.map((event) => event.payload.itemType),
        ["reasoning", "assistant_message"],
      );
      assert.equal(terminal.payload.state, "completed");
      assert.equal(terminal.payload.stopReason, "completed");
      const usage = threadEvents.find(
        (event): event is Extract<ProviderRuntimeEvent, { type: "thread.token-usage.updated" }> =>
          event.type === "thread.token-usage.updated",
      );
      assert.lengthOf(
        threadEvents.filter((event) => event.type === "thread.token-usage.updated"),
        1,
      );
      assert.deepEqual(usage?.payload.usage, {
        usedTokens: 12,
        totalProcessedTokens: 33,
        inputTokens: 20,
        cachedInputTokens: 4,
        outputTokens: 8,
        reasoningOutputTokens: 3,
        lastUsedTokens: 12,
        lastInputTokens: 7,
        lastCachedInputTokens: 2,
        lastOutputTokens: 3,
        compactsAutomatically: true,
      });
      assert.isTrue(
        threadEvents.findIndex((event) => event === usage) <
          threadEvents.findIndex((event) => event === terminal),
      );
    }),
  );

  it.effect("emits terminal usage when no usage notification arrived", () =>
    Effect.gen(function* () {
      const { adapter } = yield* makeDroidScenario({ T3_DROID_MOCK_SCENARIO: "omit-usage" });
      const threadId = ThreadId.make("droid-usage-terminal-fallback");
      const { events: runtimeEvents, waitForType } = yield* collectDroidEvents(adapter);
      yield* startDroidSession(adapter, threadId, "full-access");
      yield* sendDroidTurn(adapter, threadId, "fallback usage");
      yield* waitForType(threadId, "turn.completed");
      assert.lengthOf(
        eventsForThread(runtimeEvents, threadId).filter(
          (event) => event.type === "thread.token-usage.updated",
        ),
        1,
      );
    }),
  );

  it.effect("restarts the same Droid thread after session teardown", () =>
    Effect.gen(function* () {
      const { adapter } = yield* makeDroidScenario();
      const threadId = ThreadId.make("droid-thread-lock-reaped");
      yield* startDroidSession(adapter, threadId, "full-access");
      yield* adapter.stopSession(threadId);
      const replacement = yield* startDroidSession(adapter, threadId, "full-access");
      assert.equal(replacement.status, "ready");
    }),
  );

  it.effect("waits for every same-thread start before stopAll returns", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-concurrent-start-stop-all");
      const coordinationDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "droid-start-race-")),
      );
      const { adapter } = yield* makeDroidScenario({
        T3_DROID_MOCK_SCENARIO: "start-race",
        T3_DROID_MOCK_START_RACE_DIR: coordinationDir,
      });
      const { events: runtimeEvents } = yield* collectDroidEvents(adapter);
      yield* startDroidSession(adapter, threadId, "full-access");
      const heldTurn = yield* sendDroidTurn(adapter, threadId, "mock hold thread lock").pipe(
        Effect.forkChild,
      );
      yield* Effect.promise(() => waitForFile(NodePath.join(coordinationDir, "thread-lock-held")));
      const invalidStart = yield* adapter
        .startSession({
          threadId,
          provider: ProviderDriverKind.make("claude"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        })
        .pipe(Effect.flip, Effect.forkChild);
      const replacementStart = yield* startDroidSession(adapter, threadId, "full-access").pipe(
        Effect.forkChild,
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(coordinationDir, "release-thread-lock"), ""),
      );
      const invalidStartError = yield* Fiber.join(invalidStart);
      assert.equal(invalidStartError._tag, "ProviderAdapterValidationError");
      yield* Effect.promise(() =>
        waitForFile(NodePath.join(coordinationDir, "replacement-init-started")),
      );
      const stopAllCompleted = yield* Deferred.make<void>();
      const firstStopAllFiber = yield* adapter.stopAll().pipe(
        Effect.tap(() => Deferred.succeed(stopAllCompleted, undefined)),
        Effect.forkChild,
      );
      const overlappingStopAllCompleted = yield* Deferred.make<void>();
      const overlappingStopAllFiber = yield* adapter.stopAll().pipe(
        Effect.tap(() => Deferred.succeed(overlappingStopAllCompleted, undefined)),
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      assert.isFalse(
        yield* Deferred.isDone(stopAllCompleted),
        "stopAll returned while a same-thread start was still initializing",
      );
      assert.isFalse(
        yield* Deferred.isDone(overlappingStopAllCompleted),
        "an overlapping stopAll must share the active sweep instead of reopening the start gate",
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(coordinationDir, "release-replacement-init"), ""),
      );
      yield* Fiber.join(replacementStart);
      yield* Fiber.join(firstStopAllFiber);
      yield* Fiber.join(overlappingStopAllFiber);
      const sentTurn = yield* Fiber.join(heldTurn);
      assert.isFalse(yield* adapter.hasSession(threadId));
      const threadEvents = eventsForThread(runtimeEvents, threadId);
      assert.lengthOf(
        threadEvents.filter(
          (event) =>
            event.type === "turn.completed" &&
            event.turnId !== undefined &&
            String(event.turnId) === String(sentTurn.turnId),
        ),
        1,
        "the queued start/stop race must settle the turn it actually opened exactly once",
      );
      assert.isTrue(
        threadEvents
          .filter((event) => event.type === "turn.completed")
          .every(
            (event) =>
              event.turnId !== undefined && String(event.turnId) === String(sentTurn.turnId),
          ),
        "the queued start/stop race must not settle a replacement turn",
      );
      const processFiles = yield* Effect.promise(() => NodeFSP.readdir(coordinationDir));
      const processIds = processFiles
        .filter((file) => file.startsWith("pid-"))
        .map((file) => Number(file.slice("pid-".length)));
      assert.lengthOf(processIds, 2, "the initial and replacement Droid processes were tracked");
      assert.includeMembers(
        processFiles,
        processIds.map((processId) => `exit-${processId}`),
        "stopAll must wait for every tracked Droid process to exit",
      );
      for (const processId of processIds) {
        assert.isFalse(
          isProcessAlive(processId),
          `Droid process ${processId} is still running after stopAll`,
        );
      }
      const restarted = yield* startDroidSession(adapter, threadId, "full-access");
      assert.equal(restarted.status, "ready");
    }),
  );

  it.effect("rejects a session that reaches its thread lock after stopAll begins", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-start-after-stop-all");
      const coordinationDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "droid-start-after-stop-all-")),
      );
      const { adapter } = yield* makeDroidScenario({
        T3_DROID_MOCK_SCENARIO: "start-race",
        T3_DROID_MOCK_START_RACE_DIR: coordinationDir,
      });
      yield* startDroidSession(adapter, threadId, "full-access");
      const heldTurn = yield* sendDroidTurn(adapter, threadId, "hold the thread lock").pipe(
        Effect.forkChild,
      );
      yield* Effect.promise(() => waitForFile(NodePath.join(coordinationDir, "thread-lock-held")));
      const start = yield* startDroidSession(adapter, threadId, "full-access").pipe(
        Effect.result,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      const stopAll = yield* adapter.stopAll().pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(coordinationDir, "release-thread-lock"), ""),
      );
      yield* Fiber.join(heldTurn);
      const startResult = yield* Fiber.join(start);
      yield* Fiber.join(stopAll);
      assert.equal(startResult._tag, "Failure");
      if (startResult._tag === "Failure") {
        assert.equal(startResult.failure._tag, "ProviderAdapterValidationError");
      }
      assert.isFalse(yield* adapter.hasSession(threadId));
      yield* Effect.promise(() => NodeFSP.rm(coordinationDir, { recursive: true, force: true }));
    }),
  );

  it.effect("closes incomplete streamed and tool items before terminal settlement", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-incomplete-items");
      const { adapter } = yield* makeDroidScenario({
        T3_DROID_MOCK_SCENARIO: "incomplete-items",
      });
      const { events: runtimeEvents, waitForType } = yield* collectDroidEvents(adapter);
      yield* startDroidSession(adapter, threadId, "full-access");
      const sentTurn = yield* sendDroidTurn(adapter, threadId, "mock incomplete items");
      const terminal = yield* waitForType(threadId, "turn.completed");
      const turnEvents = eventsForThread(runtimeEvents, threadId).filter(
        (event) => event.turnId !== undefined && String(event.turnId) === String(sentTurn.turnId),
      );
      const terminalIndex = turnEvents.findIndex((event) => event === terminal);
      const started = turnEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "item.started" }> =>
          event.type === "item.started",
      );
      const completed = turnEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "item.completed" }> =>
          event.type === "item.completed",
      );
      assert.deepEqual(
        started.map((event) => [String(event.itemId), event.payload.itemType]),
        [
          [`reasoning:assistant-${String(sentTurn.turnId)}`, "reasoning"],
          [`msg:assistant-${String(sentTurn.turnId)}`, "assistant_message"],
          [`incomplete-tool-${String(sentTurn.turnId)}`, "command_execution"],
        ],
      );
      assert.deepEqual(
        completed.map((event) => [String(event.itemId), event.payload.itemType]),
        started.map((event) => [String(event.itemId), event.payload.itemType]),
      );
      assert.isTrue(
        completed.every(
          (event) => turnEvents.findIndex((candidate) => candidate === event) < terminalIndex,
        ),
      );
    }),
  );

  it.effect("keeps tool-use names isolated between concurrent Droid sessions", () =>
    Effect.gen(function* () {
      const firstThreadId = ThreadId.make("droid-shared-tool-first");
      const secondThreadId = ThreadId.make("droid-shared-tool-second");
      const coordinationDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "droid-shared-tool-")),
      );
      const { adapter } = yield* makeDroidScenario({
        T3_DROID_MOCK_SCENARIO: "shared-tool-isolation",
        T3_DROID_MOCK_COORDINATION_DIR: coordinationDir,
      });
      const { events: runtimeEvents, waitFor, waitForType } = yield* collectDroidEvents(adapter);
      yield* startDroidSession(adapter, firstThreadId, "full-access");
      yield* startDroidSession(adapter, secondThreadId, "full-access");
      yield* sendDroidTurn(adapter, firstThreadId, "mock delayed shared tool");
      yield* waitFor(
        (event): event is Extract<ProviderRuntimeEvent, { type: "item.started" }> =>
          event.type === "item.started" &&
          String(event.threadId) === String(firstThreadId) &&
          String(event.itemId) === "shared-tool-use",
      );
      yield* sendDroidTurn(adapter, secondThreadId, "mock shared tool execute");
      yield* waitForType(secondThreadId, "turn.completed");
      yield* sendDroidTurn(adapter, firstThreadId, "mock release shared tool");
      yield* waitForType(firstThreadId, "turn.completed");
      const firstToolCompleted = eventsForThread(runtimeEvents, firstThreadId).find(
        (event): event is Extract<ProviderRuntimeEvent, { type: "item.completed" }> =>
          event.type === "item.completed" && String(event.itemId) === "shared-tool-use",
      );
      assert.equal(firstToolCompleted?.payload.itemType, "dynamic_tool_call");
      assert.equal(firstToolCompleted?.payload.title, "Read");
    }),
  );

  it.effect("round-trips an approved Droid permission and completes the turn", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-permission-approved");
      const { adapter } = yield* makeDroidScenario({ T3_DROID_MOCK_SCENARIO: "permission" });
      const { events: runtimeEvents, waitForType } = yield* collectDroidEvents(adapter);
      yield* startDroidSession(adapter, threadId, "approval-required");
      const sentTurn = yield* sendDroidTurn(adapter, threadId, "run the approved command");
      const opened = yield* waitForType(threadId, "request.opened");
      assert.equal(String(opened.turnId), String(sentTurn.turnId));
      assert.equal(opened.payload.requestType, "exec_command_approval");
      assert.deepEqual(opened.payload.options, [
        { decision: "accept", label: "Allow once" },
        { decision: "decline", label: "Deny" },
      ]);
      assert.equal(opened.payload.detail, "echo mock");
      assert.deepInclude(opened.payload.args, {
        toolUses: [
          {
            toolUse: {
              type: "tool_use",
              id: `permission-tool-${String(sentTurn.turnId)}`,
              input: { command: "echo mock" },
              name: "Execute",
            },
            confirmationType: "exec",
            details: {
              type: "exec",
              fullCommand: "echo mock",
              command: "echo",
              impactLevel: "low",
              riskLevelReason: "The mock command only prints text.",
            },
          },
        ],
        options: [
          { label: "Allow once", value: "proceed_once" },
          { label: "Deny", value: "cancel" },
        ],
      });
      assert.equal(opened.raw?.method, "droid.request_permission");
      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(String(opened.requestId)),
        "accept",
      );
      const terminal = yield* waitForType(threadId, "turn.completed");
      const resolved = eventsForThread(runtimeEvents, threadId).find(
        (event): event is Extract<ProviderRuntimeEvent, { type: "request.resolved" }> =>
          event.type === "request.resolved" && String(event.requestId) === String(opened.requestId),
      );
      assert.equal(resolved?.payload.requestType, "exec_command_approval");
      assert.equal(resolved?.payload.decision, "accept");
      assert.equal(terminal.payload.state, "completed");
      assert.equal(terminal.payload.stopReason, "completed");
    }),
  );

  it.effect("rejects Droid permissions with no supported decision before opening a request", () =>
    Effect.forEach(["empty", "unknown"] as const, (permissionOptionsMode) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make(`droid-permission-${permissionOptionsMode}`);
        const { adapter } = yield* makeDroidScenario({
          T3_DROID_MOCK_SCENARIO: `permission-${permissionOptionsMode}-options`,
        });
        const { waitFor } = yield* collectDroidEvents(adapter);
        yield* startDroidSession(adapter, threadId, "approval-required");
        yield* sendDroidTurn(
          adapter,
          threadId,
          `reject ${permissionOptionsMode} permission options`,
        );
        const outcome = yield* waitFor(
          (
            event,
          ): event is Extract<
            ProviderRuntimeEvent,
            { type: "request.opened" | "turn.completed" }
          > =>
            String(event.threadId) === String(threadId) &&
            (event.type === "request.opened" || event.type === "turn.completed"),
        );
        assert.equal(outcome.type, "turn.completed");
        if (outcome.type === "turn.completed") {
          assert.equal(outcome.payload.state, "failed");
        }
      }),
    ).pipe(Effect.asVoid),
  );

  it.effect("interrupts an accept-only Droid permission without sending cancel", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-permission-accept-only-interrupt");
      const coordinationDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "droid-permission-accept-only-")),
      );
      const permissionResponseFile = NodePath.join(coordinationDir, "permission-response.json");
      const { adapter } = yield* makeDroidScenario({
        T3_DROID_MOCK_SCENARIO: "permission-accept-only",
        T3_DROID_MOCK_PERMISSION_RESPONSE_FILE: permissionResponseFile,
      });
      const { waitForType } = yield* collectDroidEvents(adapter);
      yield* startDroidSession(adapter, threadId, "approval-required");
      const sentTurn = yield* sendDroidTurn(
        adapter,
        threadId,
        "interrupt the accept-only permission",
      );
      const opened = yield* waitForType(threadId, "request.opened");
      assert.deepEqual(opened.payload.options, [{ decision: "accept", label: "Allow once" }]);
      yield* adapter.interruptTurn(threadId, sentTurn.turnId);
      const terminal = yield* waitForType(threadId, "turn.completed");
      const resolved = yield* waitForType(threadId, "request.resolved");
      yield* Effect.promise(() => waitForFile(permissionResponseFile));
      const permissionResponse = decodeDroidPermissionResponse(
        yield* Effect.promise(() => NodeFSP.readFile(permissionResponseFile, "utf8")),
      );
      const lateResponse = yield* adapter
        .respondToRequest(threadId, ApprovalRequestId.make(String(opened.requestId)), "accept")
        .pipe(Effect.flip);
      assert.equal(terminal.payload.state, "cancelled");
      assert.isUndefined(resolved.payload.decision);
      assert.isString(permissionResponse.error);
      assert.notEqual(permissionResponse.selectedOption, "cancel");
      assert.equal(lateResponse._tag, "ProviderAdapterRequestError");
      yield* Effect.promise(() => NodeFSP.rm(coordinationDir, { recursive: true, force: true }));
    }),
  );

  it.effect("retires a parked Droid permission before stopping its session scope", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-permission-stop-drain");
      const { adapter } = yield* makeDroidScenario({
        T3_DROID_MOCK_SCENARIO: "park-hitl",
      });
      const { events: runtimeEvents, waitForType } = yield* collectDroidEvents(adapter);
      yield* startDroidSession(adapter, threadId, "approval-required");
      yield* sendDroidTurn(adapter, threadId, "park permission for stop");
      const opened = yield* waitForType(threadId, "request.opened");
      yield* adapter.stopSession(threadId);
      const exited = yield* waitForType(threadId, "session.exited");
      const threadEvents = eventsForThread(runtimeEvents, threadId);
      const resolved = threadEvents.find(
        (event): event is Extract<ProviderRuntimeEvent, { type: "request.resolved" }> =>
          event.type === "request.resolved" && String(event.requestId) === String(opened.requestId),
      );
      assert.isDefined(resolved);
      assert.isUndefined(resolved?.payload.decision);
      assert.isBelow(threadEvents.indexOf(resolved!), threadEvents.indexOf(exited));
    }),
  );

  it.effect("does not open a Droid permission that registers after interruption", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-permission-registration-interrupt");
      const coordinationDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "droid-permission-registration-")),
      );
      const permissionResponseFile = NodePath.join(coordinationDir, "permission-response.json");
      const requestRegistrationEntered = yield* Deferred.make<void>();
      const allowRequestRegistration = yield* Deferred.make<void>();
      const nativeEventLogger = {
        filePath: NodePath.join(coordinationDir, "native.ndjson"),
        write: () =>
          Deferred.succeed(requestRegistrationEntered, undefined).pipe(
            Effect.andThen(Deferred.await(allowRequestRegistration)),
          ),
        close: () => Effect.void,
      } satisfies NonNullable<DroidAdapterOptions["nativeEventLogger"]>;
      const { adapter } = yield* makeDroidScenario(
        {
          T3_DROID_MOCK_SCENARIO: "permission",
          T3_DROID_MOCK_PERMISSION_RESPONSE_FILE: permissionResponseFile,
        },
        { nativeEventLogger },
      );
      const { events: runtimeEvents, waitForType } = yield* collectDroidEvents(adapter);
      yield* startDroidSession(adapter, threadId, "approval-required");
      const sentTurn = yield* sendDroidTurn(
        adapter,
        threadId,
        "interrupt before permission registration",
      );
      yield* Deferred.await(requestRegistrationEntered);
      yield* adapter.interruptTurn(threadId, sentTurn.turnId);
      yield* Deferred.succeed(allowRequestRegistration, undefined);
      yield* waitForType(threadId, "turn.completed");
      yield* Effect.promise(() => waitForFile(permissionResponseFile));
      const permissionResponse = decodeDroidPermissionResponse(
        yield* Effect.promise(() => NodeFSP.readFile(permissionResponseFile, "utf8")),
      );
      assert.lengthOf(
        eventsForThread(runtimeEvents, threadId).filter((event) => event.type === "request.opened"),
        0,
      );
      assert.isString(permissionResponse.error);
      yield* Effect.promise(() => NodeFSP.rm(coordinationDir, { recursive: true, force: true }));
    }),
  );

  it.effect("rejects a concurrent duplicate Droid permission response", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-permission-response-race");
      const { adapter } = yield* makeDroidScenario({ T3_DROID_MOCK_SCENARIO: "permission" });
      const { waitForType } = yield* collectDroidEvents(adapter);
      yield* startDroidSession(adapter, threadId, "approval-required");
      yield* sendDroidTurn(adapter, threadId, "race permission responses");
      const opened = yield* waitForType(threadId, "request.opened");
      const requestId = ApprovalRequestId.make(String(opened.requestId));
      const outcomes = yield* Effect.all(
        permissionResponseCases.map(({ label, decision }) =>
          adapter.respondToRequest(threadId, requestId, decision).pipe(
            Effect.match({
              onFailure: (error) => ({ _tag: "Failure" as const, label, error }),
              onSuccess: () => ({ _tag: "Success" as const, label, decision }),
            }),
          ),
        ),
        { concurrency: "unbounded" },
      );
      const successes = outcomes.filter((outcome) => outcome._tag === "Success");
      const failures = outcomes.filter((outcome) => outcome._tag === "Failure");
      assert.lengthOf(successes, 1, "exactly one concurrent approval response should succeed");
      assert.lengthOf(failures, 1, "the duplicate approval response should fail");
      const duplicateFailure = failures[0];
      assert.equal(duplicateFailure?.error._tag, "ProviderAdapterRequestError");
      if (duplicateFailure?.error._tag === "ProviderAdapterRequestError") {
        assert.include(duplicateFailure.error.detail, "Unknown pending approval request");
      }
      const resolved = yield* waitForType(threadId, "request.resolved");
      const appliedDecision = successes[0]?.decision;
      assert.isDefined(appliedDecision);
      assert.equal(resolved.payload.decision, appliedDecision);
    }),
  );

  it.effect("bounds concurrent Droid permission handlers while responses are withheld", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-permission-handler-bound");
      const coordinationDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "droid-permission-handler-bound-")),
      );
      const floodReadyFile = NodePath.join(coordinationDir, "flood-ready");
      const { adapter } = yield* makeDroidScenario({
        T3_DROID_MOCK_SCENARIO: "permission-flood",
        T3_DROID_MOCK_PERMISSION_FLOOD_COUNT: "24",
        T3_DROID_MOCK_PERMISSION_FLOOD_READY_FILE: floodReadyFile,
      });
      const { events, waitForType } = yield* collectDroidEvents(adapter);
      yield* startDroidSession(adapter, threadId, "approval-required");
      yield* sendDroidTurn(adapter, threadId, "flood permission requests");
      yield* Effect.promise(() => waitForFile(floodReadyFile));
      yield* waitForType(threadId, "request.opened");
      assert.isAtMost(eventsOfType(eventsForThread(events, threadId), "request.opened").length, 16);
      yield* Effect.promise(() => NodeFSP.rm(coordinationDir, { recursive: true, force: true }));
    }),
  );

  it.effect("retires saturated Droid permission handlers without waiting on native responses", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-permission-saturated-retirement");
      const coordinationDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "droid-permission-retirement-")),
      );
      const floodReadyFile = NodePath.join(coordinationDir, "flood-ready");
      const { adapter } = yield* makeDroidScenario({
        T3_DROID_MOCK_SCENARIO: "permission-flood-retirement",
        T3_DROID_MOCK_PERMISSION_FLOOD_COUNT: "24",
        T3_DROID_MOCK_PERMISSION_FLOOD_READY_FILE: floodReadyFile,
        T3_DROID_MOCK_COORDINATION_DIR: coordinationDir,
      });
      const { waitForType } = yield* collectDroidEvents(adapter);
      yield* startDroidSession(adapter, threadId, "approval-required");
      const turn = yield* sendDroidTurn(adapter, threadId, "retire saturated permission requests");
      yield* Effect.promise(() => waitForFile(floodReadyFile));
      yield* waitForType(threadId, "request.opened", 16);
      const interrupted = yield* adapter
        .interruptTurn(threadId, turn.turnId)
        .pipe(Effect.timeoutOption("1 second"), Effect.forkChild);
      yield* waitForType(threadId, "request.resolved", 16);
      yield* Effect.yieldNow;
      yield* advanceTestClock(1_000);
      assert.isTrue(Option.isSome(yield* Fiber.join(interrupted)));
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(coordinationDir, "release-native-responses"), ""),
      );
      yield* adapter.stopSession(threadId);
      yield* waitForType(threadId, "session.exited");
      yield* Effect.promise(() => NodeFSP.rm(coordinationDir, { recursive: true, force: true }));
    }),
  );

  it.effect("rejects a queued sessionless request from the previous turn", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-sessionless-request-turn-boundary");
      const coordinationDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "droid-sessionless-request-boundary-")),
      );
      const floodReadyFile = NodePath.join(coordinationDir, "flood-ready");
      const staleRejectedFile = NodePath.join(coordinationDir, "stale-request-rejected");
      const firstQueuedRequestIndex = DROID_SERVER_REQUEST_CONCURRENCY;
      const floodCount = firstQueuedRequestIndex + 1;
      const { adapter } = yield* makeDroidScenario({
        T3_DROID_MOCK_SCENARIO: "permission-flood-turn-boundary",
        T3_DROID_MOCK_PERMISSION_FLOOD_COUNT: String(floodCount),
        T3_DROID_MOCK_PERMISSION_FLOOD_READY_FILE: floodReadyFile,
        T3_DROID_MOCK_PERMISSION_FLOOD_PROBE_INDEX: String(firstQueuedRequestIndex),
        T3_DROID_MOCK_COORDINATION_DIR: coordinationDir,
      });
      const { events, waitForType } = yield* collectDroidEvents(adapter);
      yield* startDroidSession(adapter, threadId, "approval-required");
      const firstTurn = yield* sendDroidTurn(adapter, threadId, "queue old permission requests");
      yield* Effect.promise(() => waitForFile(floodReadyFile));
      const lastOpenedOnFirstTurn = yield* waitForType(
        threadId,
        "request.opened",
        DROID_SERVER_REQUEST_CONCURRENCY,
      );
      assert.equal(String(lastOpenedOnFirstTurn.turnId), String(firstTurn.turnId));
      const firstTerminal = yield* waitForType(threadId, "turn.completed");
      assert.equal(String(firstTerminal.turnId), String(firstTurn.turnId));

      const replacementTurn = yield* sendDroidTurn(adapter, threadId, "start a replacement turn");
      const firstOpened = eventsOfType(
        eventsForTurn(events, threadId, firstTurn.turnId),
        "request.opened",
      )[0];
      assert.isDefined(firstOpened);
      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(String(firstOpened.requestId)),
        "accept",
      );

      const staleOutcome = yield* Effect.race(
        Effect.promise(() => waitForFile(staleRejectedFile)).pipe(Effect.as("rejected" as const)),
        waitForType(threadId, "request.opened", floodCount).pipe(
          Effect.map((event) =>
            String(event.turnId) === String(replacementTurn.turnId)
              ? ("opened-on-replacement" as const)
              : ("opened-elsewhere" as const),
          ),
        ),
      );
      assert.equal(staleOutcome, "rejected");
      assert.isEmpty(
        eventsOfType(eventsForTurn(events, threadId, replacementTurn.turnId), "request.opened"),
      );

      yield* adapter.stopSession(threadId);
      yield* waitForType(threadId, "session.exited");
      yield* Effect.promise(() => NodeFSP.rm(coordinationDir, { recursive: true, force: true }));
    }),
  );

  it.effect("round-trips a denied Droid permission as a cancelled turn", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-permission-denied");
      const { adapter } = yield* makeDroidScenario({ T3_DROID_MOCK_SCENARIO: "permission" });
      const { waitForType } = yield* collectDroidEvents(adapter);
      yield* startDroidSession(adapter, threadId, "approval-required");
      yield* sendDroidTurn(adapter, threadId, "deny the command");
      const opened = yield* waitForType(threadId, "request.opened");
      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(String(opened.requestId)),
        "decline",
      );
      const resolved = yield* waitForType(threadId, "request.resolved");
      const terminal = yield* waitForType(threadId, "turn.completed");
      assert.equal(String(resolved.requestId), String(opened.requestId));
      assert.equal(resolved.payload.decision, "decline");
      assert.equal(terminal.payload.state, "cancelled");
      assert.equal(terminal.payload.stopReason, "permission_rejected");
    }),
  );

  it.effect("round-trips Droid ask_user answers and completes the turn", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-ask-user");
      const { adapter } = yield* makeDroidScenario({ T3_DROID_MOCK_SCENARIO: "ask-user" });
      const { waitForType } = yield* collectDroidEvents(adapter);
      yield* startDroidSession(adapter, threadId, "full-access");
      const sentTurn = yield* sendDroidTurn(adapter, threadId, "ask for scope");
      const requestedEvent = yield* waitForType(threadId, "user-input.requested");
      assert.equal(String(requestedEvent.turnId), String(sentTurn.turnId));
      assert.deepEqual(requestedEvent.payload.questions, [
        {
          id: "1",
          header: "Scope",
          question: "Which scope?",
          options: [
            { label: "workspace", description: "workspace" },
            { label: "session", description: "session" },
          ],
          multiSelect: false,
        },
      ]);
      assert.equal(requestedEvent.raw?.method, "droid.ask_user");
      yield* adapter.respondToUserInput(
        threadId,
        ApprovalRequestId.make(String(requestedEvent.requestId)),
        { "1": "workspace" },
      );
      const resolvedEvent = yield* waitForType(threadId, "user-input.resolved");
      const terminal = yield* waitForType(threadId, "turn.completed");
      assert.equal(String(resolvedEvent.requestId), String(requestedEvent.requestId));
      assert.deepEqual(resolvedEvent.payload.answers, { "1": "workspace" });
      assert.equal(terminal.payload.state, "completed");
    }),
  );

  it.effect("rejects a concurrent duplicate Droid user-input response", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-user-input-response-race");
      const { adapter } = yield* makeDroidScenario({ T3_DROID_MOCK_SCENARIO: "ask-user" });
      const { waitForType } = yield* collectDroidEvents(adapter);
      yield* startDroidSession(adapter, threadId, "full-access");
      yield* sendDroidTurn(adapter, threadId, "race user input responses");
      const requestedEvent = yield* waitForType(threadId, "user-input.requested");
      const requestId = ApprovalRequestId.make(String(requestedEvent.requestId));
      const outcomes = yield* Effect.all(
        userInputResponseCases.map(({ label, answers }) =>
          adapter.respondToUserInput(threadId, requestId, answers).pipe(
            Effect.match({
              onFailure: (error) => ({ _tag: "Failure" as const, label, error }),
              onSuccess: () => ({ _tag: "Success" as const, label, answers }),
            }),
          ),
        ),
        { concurrency: "unbounded" },
      );
      const successes = outcomes.filter((outcome) => outcome._tag === "Success");
      const failures = outcomes.filter((outcome) => outcome._tag === "Failure");
      assert.lengthOf(successes, 1, "exactly one concurrent user-input response should succeed");
      assert.lengthOf(failures, 1, "the duplicate user-input response should fail");
      const duplicateFailure = failures[0];
      assert.equal(duplicateFailure?.error._tag, "ProviderAdapterRequestError");
      if (duplicateFailure?.error._tag === "ProviderAdapterRequestError") {
        assert.include(duplicateFailure.error.detail, "Unknown pending user-input request");
      }
      const resolvedEvent = yield* waitForType(threadId, "user-input.resolved");
      const appliedAnswers = successes[0]?.answers;
      assert.isDefined(appliedAnswers);
      assert.deepEqual(resolvedEvent.payload.answers, appliedAnswers);
    }),
  );

  it.effect("interrupts a hanging Droid turn once and drops its late terminal notification", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-interrupt");
      const { adapter } = yield* makeDroidScenario({
        T3_DROID_MOCK_SCENARIO: "hang-turn",
      });
      const { events: runtimeEvents, waitFor, waitForType } = yield* collectDroidEvents(adapter);
      yield* startDroidSession(adapter, threadId, "full-access");
      const sentTurn = yield* sendDroidTurn(adapter, threadId, "hang until interrupted");
      yield* waitFor(
        (event): event is Extract<ProviderRuntimeEvent, { type: "item.completed" }> =>
          event.type === "item.completed" &&
          event.payload.itemType === "assistant_message" &&
          String(event.threadId) === String(threadId),
      );
      yield* adapter.interruptTurn(threadId, sentTurn.turnId);
      const terminal = yield* waitForType(threadId, "turn.completed");
      const threadEvents = eventsForThread(runtimeEvents, threadId);
      assert.equal(String(terminal.turnId), String(sentTurn.turnId));
      assert.equal(terminal.payload.state, "cancelled");
      assert.equal(terminal.payload.stopReason, "cancelled");
      assert.lengthOf(
        threadEvents.filter(
          (event) =>
            event.type === "turn.completed" &&
            event.turnId !== undefined &&
            String(event.turnId) === String(sentTurn.turnId),
        ),
        1,
      );
      const terminalIndex = threadEvents.findIndex((event) => event === terminal);
      const turnOutputTypes = new Set(["content.delta", "item.started", "item.completed"]);
      assert.deepEqual(
        threadEvents
          .slice(terminalIndex + 1)
          .filter(
            (event) =>
              event.turnId !== undefined &&
              String(event.turnId) === String(sentTurn.turnId) &&
              turnOutputTypes.has(event.type),
          ),
        [],
      );
    }),
  );

  it.effect("starts and completes a retry after interrupting a hung Droid turn", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-interrupt-retry");
      const { adapter } = yield* makeDroidScenario({
        T3_DROID_MOCK_SCENARIO: "hang-first-turn",
      });
      const { events: runtimeEvents, waitForType } = yield* collectDroidEvents(adapter);
      yield* startDroidSession(adapter, threadId, "full-access");
      const interruptedTurn = yield* sendDroidTurn(adapter, threadId, "mock hang this turn");
      yield* adapter.interruptTurn(threadId, interruptedTurn.turnId);
      const interruptedTerminal = yield* waitForType(threadId, "turn.completed");
      const retryTurn = yield* sendDroidTurn(adapter, threadId, "retry after interrupt");
      const retryTerminal = yield* waitForType(threadId, "turn.completed", 2);
      assert.equal(String(interruptedTerminal.turnId), String(interruptedTurn.turnId));
      assert.equal(interruptedTerminal.payload.state, "cancelled");
      assert.equal(String(retryTerminal.turnId), String(retryTurn.turnId));
      assert.equal(retryTerminal.payload.state, "completed");
      assert.lengthOf(
        eventsForThread(runtimeEvents, threadId).filter((event) => event.type === "turn.completed"),
        2,
      );
    }),
  );

  it.effect("drops a late physical terminal without mutating its replacement turn", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-late-physical-terminal");
      const { adapter } = yield* makeDroidScenario({
        T3_DROID_MOCK_SCENARIO: "late-terminal",
      });
      const { events: runtimeEvents, waitForType } = yield* collectDroidEvents(adapter);
      yield* startDroidSession(adapter, threadId, "full-access");
      const firstTurn = yield* sendDroidTurn(adapter, threadId, "first physical run");
      yield* adapter.interruptTurn(threadId, firstTurn.turnId);
      const firstTerminal = yield* waitForType(threadId, "turn.completed");
      const replacementTurn = yield* sendDroidTurn(adapter, threadId, "replacement physical run");
      const replacementTerminal = yield* waitForType(threadId, "turn.completed", 2);
      const replacementEvents = eventsForThread(runtimeEvents, threadId).filter(
        (event) =>
          event.turnId !== undefined && String(event.turnId) === String(replacementTurn.turnId),
      );
      const replacementText = replacementEvents
        .filter(
          (event): event is Extract<ProviderRuntimeEvent, { type: "content.delta" }> =>
            event.type === "content.delta" && event.payload.streamKind === "assistant_text",
        )
        .map((event) => event.payload.delta)
        .join("");
      const usageEvents = eventsForThread(runtimeEvents, threadId).filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "thread.token-usage.updated" }> =>
          event.type === "thread.token-usage.updated",
      );
      assert.equal(firstTerminal.payload.state, "cancelled");
      assert.equal(String(replacementTerminal.turnId), String(replacementTurn.turnId));
      assert.equal(replacementTerminal.payload.state, "completed");
      assert.equal(replacementText, "replacement output");
      assert.lengthOf(
        replacementEvents.filter((event) => event.type === "turn.completed"),
        1,
      );
      assert.isFalse(
        usageEvents.some((event) => event.payload.usage.inputTokens === 900),
        "late run A usage must not be published as replacement run B usage",
      );
    }),
  );

  it.effect("does not reuse a prior turn's last-call usage fallback", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-last-call-usage-reset");
      const { adapter } = yield* makeDroidScenario({
        T3_DROID_MOCK_SCENARIO: "usage-reset",
      });
      const { events, waitForType } = yield* collectDroidEvents(adapter);
      yield* startDroidSession(adapter, threadId, "full-access");
      yield* sendDroidTurn(adapter, threadId, "usage turn one");
      yield* waitForType(threadId, "turn.completed");
      yield* sendDroidTurn(adapter, threadId, "usage turn two");
      yield* waitForType(threadId, "turn.completed", 2);
      const usageEvents = eventsForThread(events, threadId).filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "thread.token-usage.updated" }> =>
          event.type === "thread.token-usage.updated",
      );
      assert.deepEqual(
        usageEvents.map((event) => event.payload.usage.usedTokens),
        [99, 32],
      );
      assert.isUndefined(usageEvents.at(-1)?.payload.usage.lastUsedTokens);
    }),
  );

  it.effect("holds the interrupt barrier for its correlated terminal notification", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-interrupt-terminal-barrier");
      const coordinationDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "droid-interrupt-terminal-barrier-")),
      );
      const { adapter } = yield* makeDroidScenario({
        T3_DROID_MOCK_SCENARIO: "interrupt-late-terminal-order",
        T3_DROID_MOCK_INTERRUPT_ORDER_DIR: coordinationDir,
      });
      const { waitForType } = yield* collectDroidEvents(adapter);
      yield* startDroidSession(adapter, threadId, "full-access");
      const firstTurn = yield* sendDroidTurn(adapter, threadId, "first interrupted run");
      yield* adapter.interruptTurn(threadId, firstTurn.turnId);
      const firstTerminal = yield* waitForType(threadId, "turn.completed");
      yield* Effect.promise(() =>
        waitForFile(NodePath.join(coordinationDir, "interrupt-1-received")),
      );
      const secondTurnFiber = yield* sendDroidTurn(
        adapter,
        threadId,
        "second interrupted run",
      ).pipe(Effect.forkChild);
      const secondTurnBeforeFirstTerminal = yield* Fiber.join(secondTurnFiber).pipe(
        Effect.timeoutOption("1 second"),
        Effect.forkChild,
      );
      yield* advanceTestClock(1_000);
      assert.isTrue(Option.isNone(yield* Fiber.join(secondTurnBeforeFirstTerminal)));
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(coordinationDir, "release-interrupt-1"), ""),
      );
      const secondTurn = yield* Fiber.join(secondTurnFiber);
      yield* adapter.interruptTurn(threadId, secondTurn.turnId);
      const secondTerminal = yield* waitForType(threadId, "turn.completed", 2);
      yield* Effect.promise(() =>
        waitForFile(NodePath.join(coordinationDir, "interrupt-2-received")),
      );
      yield* waitForType(threadId, "thread.metadata.updated");
      const thirdTurnFiber = yield* sendDroidTurn(
        adapter,
        threadId,
        "replacement after both interrupts",
      ).pipe(Effect.forkChild);
      const thirdTurnBeforeSecondTerminal = yield* Fiber.join(thirdTurnFiber).pipe(
        Effect.timeoutOption("1 second"),
        Effect.forkChild,
      );
      yield* advanceTestClock(1_000);
      assert.isTrue(Option.isNone(yield* Fiber.join(thirdTurnBeforeSecondTerminal)));
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(coordinationDir, "release-interrupt-2"), ""),
      );
      const thirdTurn = yield* Fiber.join(thirdTurnFiber);
      const thirdTerminal = yield* waitForType(threadId, "turn.completed", 3);
      assert.equal(firstTerminal.payload.state, "cancelled");
      assert.equal(secondTerminal.payload.state, "cancelled");
      assert.equal(String(thirdTerminal.turnId), String(thirdTurn.turnId));
      assert.equal(thirdTerminal.payload.state, "completed");
      yield* Effect.promise(() => NodeFSP.rm(coordinationDir, { recursive: true, force: true }));
    }),
  );

  it.effect("loads a known Droid resume cursor into a ready session", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-resume-known");
      const { adapter } = yield* makeDroidScenario();
      const { waitForType } = yield* collectDroidEvents(adapter);
      const session = yield* startDroidSession(adapter, threadId, "full-access", {
        resumeCursor: { schemaVersion: 2, sessionId: "mock-session-known", turnIds: [] },
      });
      const started = yield* waitForType(threadId, "session.started");
      assert.equal(session.status, "ready");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 2,
        sessionId: "mock-session-known",
        turnIds: [],
      });
      assert.equal(started.payload.resume, true);
    }),
  );

  it.effect("resets a resumed spec session before sending a normal turn", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-resume-spec-reset");
      const { adapter } = yield* makeDroidScenario({
        T3_DROID_MOCK_SCENARIO: "load-spec-mode-report",
      });
      const { events: runtimeEvents, waitForType } = yield* collectDroidEvents(adapter);
      yield* startDroidSession(adapter, threadId, "full-access", {
        resumeCursor: { schemaVersion: 2, sessionId: "mock-session-known", turnIds: [] },
      });
      const sentTurn = yield* sendDroidTurn(adapter, threadId, "mock report interaction mode");
      yield* waitForType(threadId, "turn.completed");
      const assistantText = eventsForThread(runtimeEvents, threadId)
        .filter(
          (event): event is Extract<ProviderRuntimeEvent, { type: "content.delta" }> =>
            event.type === "content.delta" &&
            event.turnId !== undefined &&
            String(event.turnId) === String(sentTurn.turnId) &&
            event.payload.streamKind === "assistant_text",
        )
        .map((event) => event.payload.delta)
        .join("");
      assert.equal(assistantText, "auto");
    }),
  );

  it.effect("uses one bounded Droid load path for resume and rollback", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-canonical-load-path");
      const requestLogDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "droid-load-path-")),
      );
      const requestLogPath = NodePath.join(requestLogDir, "requests.ndjson");
      const { adapter } = yield* makeDroidScenario({
        T3_DROID_MOCK_REQUEST_LOG: requestLogPath,
      });
      yield* startDroidSession(adapter, threadId, "full-access", {
        resumeCursor: {
          schemaVersion: 2,
          sessionId: "mock-session-known",
          turnIds: [],
        },
      });
      yield* adapter.stopSession(threadId);
      const { waitForType } = yield* collectDroidEvents(adapter);
      yield* startDroidSession(adapter, threadId, "full-access");
      yield* sendDroidTurn(adapter, threadId, "turn before canonical rollback load");
      yield* waitForType(threadId, "turn.completed");
      yield* adapter.rollbackThread(threadId, 1);
      const requests = (yield* Effect.promise(() => NodeFSP.readFile(requestLogPath, "utf8")))
        .split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            decodeUnknownJsonString(line) as {
              readonly method: string;
              readonly params: Record<string, unknown>;
            },
        );
      const loads = requests.filter((request) => request.method === "droid.load_session");
      const settingsUpdates = requests.filter(
        (request) => request.method === "droid.update_session_settings",
      );
      assert.deepEqual(
        loads.map((request) => request.params.messageLimit),
        [1, 1],
      );
      assert.deepEqual(
        loads.map((request) => request.params.sessionId),
        ["mock-session-known", "mock-session-rewound"],
      );
      assert.lengthOf(settingsUpdates, 2);
      assert.isTrue(
        settingsUpdates.every(
          (request) =>
            request.params.autonomyLevel === "high" && request.params.interactionMode === "auto",
        ),
      );
      yield* Effect.promise(() => NodeFSP.rm(requestLogDir, { recursive: true, force: true }));
    }),
  );

  it.effect("rejects an unknown Droid resume cursor with a typed process error", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-resume-unknown");
      const { adapter } = yield* makeDroidScenario();
      const error = yield* Effect.flip(
        startDroidSession(adapter, threadId, "full-access", {
          resumeCursor: { schemaVersion: 2, sessionId: "mock-session-missing", turnIds: [] },
        }),
      );
      assert.equal(error._tag, "ProviderAdapterProcessError");
      if (error._tag === "ProviderAdapterProcessError") {
        assert.equal(error.detail, "Droid session request 'droid.load_session' failed.");
        assert.include(String(error.cause), "Mock session not found");
      }
      assert.isFalse(yield* adapter.hasSession(threadId));
    }),
  );

  it.effect("fails resume when approval-required settings cannot be reasserted", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-resume-settings-failure");
      const { adapter } = yield* makeDroidScenario({
        T3_DROID_MOCK_SCENARIO: "fail-update-settings",
      });
      const error = yield* Effect.flip(
        startDroidSession(adapter, threadId, "approval-required", {
          resumeCursor: { schemaVersion: 2, sessionId: "mock-session-known", turnIds: [] },
        }),
      );
      assert.equal(error._tag, "ProviderAdapterProcessError");
      if (error._tag === "ProviderAdapterProcessError") {
        assert.equal(error.detail, "Droid session request 'droid.update_session_settings' failed.");
        assert.include(String(error.cause), "Mock settings update failure");
      }
      assert.isFalse(yield* adapter.hasSession(threadId));
    }),
  );

  it.effect("surfaces Droid initialization failure as a typed process error", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-init-failure");
      const { adapter } = yield* makeDroidScenario({ T3_DROID_MOCK_SCENARIO: "fail-init" });
      const error = yield* Effect.flip(startDroidSession(adapter, threadId, "full-access"));
      assert.equal(error._tag, "ProviderAdapterProcessError");
      if (error._tag === "ProviderAdapterProcessError") {
        assert.equal(error.detail, "Droid session request 'droid.initialize_session' failed.");
        assert.include(String(error.cause), "Mock initialization failure");
      }
      assert.isFalse(yield* adapter.hasSession(threadId));
    }),
  );

  it.effect("fails the active turn and emits session.exited when Droid dies", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-process-death");
      const { adapter } = yield* makeDroidScenario({ T3_DROID_MOCK_SCENARIO: "exit-mid-turn" });
      const { events: runtimeEvents, waitForType } = yield* collectDroidEvents(adapter);
      yield* startDroidSession(adapter, threadId, "full-access");
      const sentTurn = yield* sendDroidTurn(adapter, threadId, "exit during this turn");
      const exited = yield* waitForType(threadId, "session.exited");
      const failedTurn = eventsForThread(runtimeEvents, threadId).find(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed" &&
          event.turnId !== undefined &&
          String(event.turnId) === String(sentTurn.turnId),
      );
      assert.equal(failedTurn?.payload.state, "failed");
      assert.include(failedTurn?.payload.errorMessage ?? "", "Droid exited unexpectedly");
      assert.equal(exited.payload.exitKind, "error");
      assert.isFalse(yield* adapter.hasSession(threadId));
    }),
  );

  it.effect("publishes a parked Droid request resolution before process-exit teardown", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-process-exit-hitl-drain");
      const coordinationDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "droid-process-hitl-")),
      );
      const { adapter } = yield* makeDroidScenario({
        T3_DROID_MOCK_SCENARIO: "exit-hitl",
        T3_DROID_MOCK_COORDINATION_DIR: coordinationDir,
      });
      const { events: runtimeEvents, waitForType } = yield* collectDroidEvents(adapter);
      yield* startDroidSession(adapter, threadId, "approval-required");
      yield* sendDroidTurn(adapter, threadId, "park permission before exit");
      const opened = yield* waitForType(threadId, "request.opened");
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(coordinationDir, "release-exit"), ""),
      );
      const exited = yield* waitForType(threadId, "session.exited");
      const threadEvents = eventsForThread(runtimeEvents, threadId);
      const resolved = threadEvents.find(
        (event): event is Extract<ProviderRuntimeEvent, { type: "request.resolved" }> =>
          event.type === "request.resolved" && String(event.requestId) === String(opened.requestId),
      );
      assert.isDefined(resolved);
      assert.isUndefined(resolved?.payload.decision);
      assert.equal(exited.payload.exitKind, "error");
      assert.isBelow(threadEvents.indexOf(resolved!), threadEvents.indexOf(exited));
      yield* Effect.promise(() => NodeFSP.rm(coordinationDir, { recursive: true, force: true }));
    }),
  );

  it.effect("rolls back a turn by forking the Droid session and re-anchoring on the fork", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-rollback");
      const { adapter } = yield* makeDroidScenario();
      const { waitForType } = yield* collectDroidEvents(adapter);
      yield* startDroidSession(adapter, threadId, "full-access");
      yield* sendDroidTurn(adapter, threadId, "first turn to roll back");
      yield* waitForType(threadId, "turn.completed");
      const snapshot = yield* adapter.rollbackThread(threadId, 1);
      assert.deepEqual(snapshot.turns, []);
      // The live process re-anchored on the fork: the resume cursor points at
      // the rewound session and the session still takes turns.
      const nextTurn = yield* sendDroidTurn(adapter, threadId, "turn after the rewind");
      assert.deepStrictEqual(nextTurn.resumeCursor, {
        schemaVersion: 2,
        sessionId: "mock-session-rewound",
        turnIds: [nextTurn.turnId],
      });
      yield* waitForType(threadId, "turn.completed", 2);
    }),
  );

  it.effect("invalidates a session when loading a rewind fork fails", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-rollback-load-invalidation");
      const { adapter } = yield* makeDroidScenario({
        T3_DROID_MOCK_SCENARIO: "fail-update-settings",
      });
      const { waitForType } = yield* collectDroidEvents(adapter);
      yield* startDroidSession(adapter, threadId, "full-access");
      yield* sendDroidTurn(adapter, threadId, "turn before failed rewind load");
      yield* waitForType(threadId, "turn.completed");

      const result = yield* adapter.rollbackThread(threadId, 1).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "ProviderAdapterSessionInvalidatedError");
      }
      yield* waitForType(threadId, "session.exited");
      assert.isFalse(yield* adapter.hasSession(threadId));
    }),
  );

  it.effect("drops a pre-rewind session straggler after re-anchoring on the fork", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-rewind-straggler");
      const { adapter } = yield* makeDroidScenario();
      const { events: runtimeEvents, waitForType } = yield* collectDroidEvents(adapter);
      yield* startDroidSession(adapter, threadId, "full-access");
      yield* sendDroidTurn(adapter, threadId, "turn before straggler rewind");
      yield* waitForType(threadId, "turn.completed");
      yield* adapter.rollbackThread(threadId, 1);
      const nextTurn = yield* sendDroidTurn(adapter, threadId, "turn after straggler rewind");
      const terminal = yield* waitForType(threadId, "turn.completed", 2);
      const nextTurnEvents = eventsForThread(runtimeEvents, threadId).filter(
        (event) => event.turnId !== undefined && String(event.turnId) === String(nextTurn.turnId),
      );
      assert.equal(terminal.payload.state, "completed");
      assert.notInclude(
        nextTurnEvents
          .filter(
            (event): event is Extract<ProviderRuntimeEvent, { type: "content.delta" }> =>
              event.type === "content.delta",
          )
          .map((event) => event.payload.delta)
          .join(""),
        "stale pre-rewind output",
      );
      assert.lengthOf(
        nextTurnEvents.filter((event) => event.type === "turn.completed"),
        1,
      );
    }),
  );

  it.effect("lets interrupt cancellation win a queued completed-terminal race", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-interrupt-completion-race");
      const { adapter } = yield* makeDroidScenario({
        T3_DROID_MOCK_SCENARIO: "interrupt-race",
      });
      const { events: runtimeEvents, waitFor, waitForType } = yield* collectDroidEvents(adapter);
      yield* startDroidSession(adapter, threadId, "full-access");
      const sentTurn = yield* sendDroidTurn(adapter, threadId, "race completion against interrupt");
      yield* waitFor(
        (event): event is Extract<ProviderRuntimeEvent, { type: "item.completed" }> =>
          event.type === "item.completed" &&
          event.payload.itemType === "assistant_message" &&
          String(event.threadId) === String(threadId),
      );
      yield* adapter.interruptTurn(threadId, sentTurn.turnId);
      const terminal = yield* waitForType(threadId, "turn.completed");
      assert.equal(terminal.payload.state, "cancelled");
      assert.lengthOf(
        eventsForThread(runtimeEvents, threadId).filter(
          (event) =>
            event.type === "turn.completed" &&
            event.turnId !== undefined &&
            String(event.turnId) === String(sentTurn.turnId),
        ),
        1,
      );
    }),
  );

  it.effect("invalidates a session when updating settings times out", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-settings-timeout-invalidation");
      const coordinationDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "droid-settings-timeout-")),
      );
      const { adapter } = yield* makeDroidScenario({
        T3_DROID_MOCK_SCENARIO: "hang-update-settings",
        T3_DROID_MOCK_COORDINATION_DIR: coordinationDir,
      });
      const { waitForType } = yield* collectDroidEvents(adapter);
      yield* startDroidSession(adapter, threadId, "full-access");
      const send = yield* sendDroidTurn(adapter, threadId, "time out the settings update", {
        interactionMode: "plan",
      }).pipe(Effect.result, Effect.forkChild);
      yield* Effect.promise(() =>
        waitForFile(NodePath.join(coordinationDir, "settings-requested")),
      );
      yield* advanceTestClock(DROID_SESSION_REQUEST_TIMEOUT_MS);
      const result = yield* Fiber.join(send);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "ProviderAdapterSessionInvalidatedError");
      }
      yield* waitForType(threadId, "session.exited");
      assert.isFalse(yield* adapter.hasSession(threadId));
      yield* Effect.promise(() => NodeFSP.rm(coordinationDir, { recursive: true, force: true }));
    }),
  );

  it.effect("invalidates a session when add_user_message fails after dispatch", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-add-message-invalidation");
      const { adapter } = yield* makeDroidScenario({
        T3_DROID_MOCK_SCENARIO: "fail-add-user-message",
      });
      const { events, waitForType } = yield* collectDroidEvents(adapter);
      yield* startDroidSession(adapter, threadId, "full-access");
      const result = yield* sendDroidTurn(adapter, threadId, "reject this message").pipe(
        Effect.result,
      );
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "ProviderAdapterSessionInvalidatedError");
      }
      const terminal = yield* waitForType(threadId, "turn.completed");
      yield* waitForType(threadId, "session.exited");
      assert.equal(terminal.payload.state, "failed");
      assert.lengthOf(eventsOfType(eventsForThread(events, threadId), "turn.completed"), 1);
      assert.isFalse(yield* adapter.hasSession(threadId));
    }),
  );

  it.effect("invalidates the session and releases waiters when interrupt RPC fails", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-interrupt-failure-invalidation");
      const { adapter } = yield* makeDroidScenario({
        T3_DROID_MOCK_SCENARIO: "fail-interrupt",
      });
      const { waitFor, waitForType } = yield* collectDroidEvents(adapter);
      yield* startDroidSession(adapter, threadId, "full-access");
      const turn = yield* sendDroidTurn(adapter, threadId, "fail this interrupt");
      yield* waitFor(
        (event): event is Extract<ProviderRuntimeEvent, { type: "item.completed" }> =>
          event.type === "item.completed" &&
          event.payload.itemType === "assistant_message" &&
          String(event.threadId) === String(threadId),
      );
      const result = yield* adapter.interruptTurn(threadId, turn.turnId).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "ProviderAdapterSessionInvalidatedError");
      }
      const terminal = yield* waitForType(threadId, "turn.completed");
      yield* waitForType(threadId, "session.exited");
      assert.equal(terminal.payload.state, "cancelled");
      assert.isFalse(yield* adapter.hasSession(threadId));
    }),
  );

  it.effect("adopts a spec-handoff successor after streaming it into the plan turn", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-spec-handoff");
      const settingsLogDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "droid-spec-handoff-settings-")),
      );
      const settingsLogPath = NodePath.join(settingsLogDir, "settings.ndjson");
      const { adapter } = yield* makeDroidScenario({
        T3_DROID_MOCK_SCENARIO: "spec-handoff",
        T3_DROID_MOCK_SETTINGS_LOG: settingsLogPath,
      });
      const { events: runtimeEvents, waitForType } = yield* collectDroidEvents(adapter);
      yield* startDroidSession(adapter, threadId, "full-access");
      const sentTurn = yield* sendDroidTurn(adapter, threadId, "mock spec handoff", {
        interactionMode: "plan",
      });
      const opened = yield* waitForType(threadId, "request.opened");
      assert.equal(opened.payload.requestType, "plan_approval");
      assert.deepEqual(opened.payload.options, [
        { decision: "accept", label: "Implement" },
        { decision: "decline", label: "Cancel" },
      ]);
      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(String(opened.requestId)),
        "accept",
      );
      const terminal = yield* waitForType(threadId, "turn.completed");
      const sessions = yield* adapter.listSessions();
      const successorText = eventsForThread(runtimeEvents, threadId)
        .filter(
          (event): event is Extract<ProviderRuntimeEvent, { type: "content.delta" }> =>
            event.type === "content.delta" &&
            event.turnId !== undefined &&
            String(event.turnId) === String(sentTurn.turnId) &&
            event.payload.streamKind === "assistant_text",
        )
        .map((event) => event.payload.delta)
        .join("");
      assert.include(successorText, "implementation successor");
      assert.equal(terminal.payload.state, "completed");
      assert.equal(terminal.payload.stopReason, "spec_handoff");
      assert.deepStrictEqual(sessions[0]?.resumeCursor, {
        schemaVersion: 2,
        sessionId: "mock-session-spec-successor",
        turnIds: [sentTurn.turnId],
      });
      // Droid offered only the new-session variant here, so the adapter's
      // generic first-proceed selection picks it and the successor machinery
      // engages.
      const outcomeLog = (yield* Effect.promise(() => NodeFSP.readFile(settingsLogPath, "utf8")))
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      assert.deepEqual(outcomeLog.at(-1), {
        exitSpecModeSelectedOption: "proceed_new_session_high",
        resultingAutonomyLevel: "high",
      });
    }),
  );

  it.effect("accepts a permission request from an approved spec successor", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-spec-successor-permission");
      const { adapter } = yield* makeDroidScenario({
        T3_DROID_MOCK_SCENARIO: "spec-successor-permission",
      });
      const { events, waitForType } = yield* collectDroidEvents(adapter);
      yield* startDroidSession(adapter, threadId, "full-access");
      const turn = yield* sendDroidTurn(adapter, threadId, "approve the spec successor", {
        interactionMode: "plan",
      });
      const planApproval = yield* waitForType(threadId, "request.opened");
      assert.equal(planApproval.payload.requestType, "plan_approval");
      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(String(planApproval.requestId)),
        "accept",
      );
      const successorApproval = yield* waitForType(threadId, "request.opened", 2);
      assert.equal(successorApproval.payload.requestType, "exec_command_approval");
      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(String(successorApproval.requestId)),
        "accept",
      );
      const terminal = yield* waitForType(threadId, "turn.completed");
      assert.equal(terminal.payload.state, "completed");
      assert.include(
        assistantText(eventsForTurn(events, threadId, turn.turnId)),
        "approved successor",
      );
    }),
  );

  it.effect("carries the thread's runtime mode into an approved spec implementation", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-spec-autonomy-handoff");
      const settingsLogDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "droid-spec-autonomy-settings-")),
      );
      const settingsLogPath = NodePath.join(settingsLogDir, "settings.ndjson");
      const { adapter } = yield* makeDroidScenario({
        T3_DROID_MOCK_SCENARIO: "spec-autonomy-handoff",
        T3_DROID_MOCK_SETTINGS_LOG: settingsLogPath,
      });
      const { waitForType } = yield* collectDroidEvents(adapter);
      yield* startDroidSession(adapter, threadId, "full-access");
      yield* sendDroidTurn(adapter, threadId, "mock spec autonomy handoff", {
        interactionMode: "plan",
      });
      const opened = yield* waitForType(threadId, "request.opened");
      assert.equal(opened.payload.requestType, "plan_approval");
      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(String(opened.requestId)),
        "accept",
      );
      const terminal = yield* waitForType(threadId, "turn.completed");
      assert.equal(terminal.payload.state, "completed");
      // Droid derives the implementation autonomy from the selected
      // exit_spec_mode outcome. A full-access thread must answer with the
      // high-autonomy variant, or the implementation prompts for every edit
      // (repro'd live on droid 0.202.0 with the generic proceed_once).
      const outcomeLog = (yield* Effect.promise(() => NodeFSP.readFile(settingsLogPath, "utf8")))
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      assert.deepEqual(outcomeLog.at(-1), {
        exitSpecModeSelectedOption: "proceed_auto_run_high",
        resultingAutonomyLevel: "high",
      });
    }),
  );

  it.effect("does not arm the spec-handoff claim window from a late approval", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-late-spec-approval");
      const settleDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "droid-late-spec-approval-")),
      );
      const settleFile = NodePath.join(settleDir, "settle");
      const { adapter } = yield* makeDroidScenario({
        T3_DROID_MOCK_SCENARIO: "late-spec-approval",
        T3_DROID_MOCK_LATE_SPEC_SETTLE_FILE: settleFile,
      });
      const { events: runtimeEvents, waitForType } = yield* collectDroidEvents(adapter);
      yield* startDroidSession(adapter, threadId, "full-access");
      const specTurn = yield* sendDroidTurn(adapter, threadId, "mock late spec approval", {
        interactionMode: "plan",
      });
      const opened = yield* waitForType(threadId, "request.opened");
      // Release the mock's settle: the spec turn completes while the approval
      // is still pending.
      yield* Effect.promise(() => NodeFSP.writeFile(settleFile, ""));
      yield* waitForType(threadId, "turn.completed");
      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(String(opened.requestId)),
        "accept",
      );
      // A stale arm from the late approval would let the NEXT plan turn adopt
      // a foreign successor envelope without any approval of its own.
      const foreignTurn = yield* sendDroidTurn(adapter, threadId, "mock foreign spec envelope", {
        interactionMode: "plan",
      });
      yield* waitForType(threadId, "turn.completed", 2);
      const sessions = yield* adapter.listSessions();
      const threadText = eventsForThread(runtimeEvents, threadId)
        .filter(
          (event): event is Extract<ProviderRuntimeEvent, { type: "content.delta" }> =>
            event.type === "content.delta" && event.payload.streamKind === "assistant_text",
        )
        .map((event) => event.payload.delta)
        .join("");
      assert.notInclude(threadText, "late implementation successor");
      assert.notInclude(threadText, "unapproved implementation successor");
      assert.deepStrictEqual(sessions[0]?.resumeCursor, {
        schemaVersion: 2,
        sessionId: "mock-session-1",
        turnIds: [specTurn.turnId, foreignTurn.turnId],
      });
    }),
  );

  it.effect("rejects a foreign spec envelope without an approved handoff", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-unapproved-spec-envelope");
      const { adapter } = yield* makeDroidScenario({
        T3_DROID_MOCK_SCENARIO: "foreign-spec-envelope",
      });
      const { events: runtimeEvents, waitForType } = yield* collectDroidEvents(adapter);
      yield* startDroidSession(adapter, threadId, "full-access");
      const sentTurn = yield* sendDroidTurn(adapter, threadId, "mock foreign spec envelope", {
        interactionMode: "plan",
      });
      const terminal = yield* waitForType(threadId, "turn.completed");
      const sessions = yield* adapter.listSessions();
      const text = assistantText(eventsForTurn(runtimeEvents, threadId, sentTurn.turnId));
      assert.notInclude(text, "unapproved implementation successor");
      assert.include(text, "hello from droid mock");
      assert.equal(terminal.payload.state, "completed");
      assert.deepStrictEqual(sessions[0]?.resumeCursor, {
        schemaVersion: 2,
        sessionId: "mock-session-1",
        turnIds: [sentTurn.turnId],
      });
    }),
  );

  it.effect("settles an unknown Droid terminal reason exactly once", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-future-terminal-reason");
      const { adapter } = yield* makeDroidScenario({
        T3_DROID_MOCK_SCENARIO: "future-terminal-reason",
      });
      const { events: runtimeEvents, waitForType } = yield* collectDroidEvents(adapter);
      yield* startDroidSession(adapter, threadId, "full-access");
      const sentTurn = yield* sendDroidTurn(adapter, threadId, "mock future terminal reason");
      const terminal = yield* waitForType(threadId, "turn.completed");
      assert.equal(terminal.payload.state, "failed");
      assert.equal(
        terminal.payload.state === "failed" ? terminal.payload.errorMessage : undefined,
        "Droid turn ended with reason 'future_terminal_reason'.",
      );
      assertSingleTerminal(runtimeEvents, threadId, sentTurn.turnId);
    }),
  );

  it.effect("applies the selected model to Droid's separate spec-mode slots", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-spec-model");
      const { adapter } = yield* makeDroidScenario({
        T3_DROID_MOCK_SCENARIO: "report-selected-model",
      });
      const { events: runtimeEvents, waitForType } = yield* collectDroidEvents(adapter);
      yield* startDroidSession(adapter, threadId, "full-access");
      const sentTurn = yield* sendDroidTurn(adapter, threadId, "mock report selected model", {
        interactionMode: "plan",
        modelSelection: {
          instanceId: ProviderInstanceId.make("droid"),
          model: "mock-deep",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      });
      yield* waitForType(threadId, "turn.completed");
      const turnEvents = eventsForTurn(runtimeEvents, threadId, sentTurn.turnId);
      const started = turnEvents.find(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.started" }> =>
          event.type === "turn.started",
      );
      assert.deepEqual(started?.payload, { model: "mock-deep", effort: "high" });
      assert.equal(assistantText(turnEvents), "mock-deep:high");
    }),
  );

  it.effect("treats compaction as a no-op and reports the last-call context meter", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-compaction");
      const { adapter } = yield* makeDroidScenario({
        T3_DROID_MOCK_SCENARIO: "compaction",
      });
      const { events: runtimeEvents, waitForType } = yield* collectDroidEvents(adapter);
      yield* startDroidSession(adapter, threadId, "full-access");
      const sentTurn = yield* sendDroidTurn(adapter, threadId, "mock compaction");
      const terminal = yield* waitForType(threadId, "turn.completed");
      const threadEvents = eventsForThread(runtimeEvents, threadId);
      const compactedUsage = eventsOfType(threadEvents, "thread.token-usage.updated").find(
        (event) => event.payload.usage.lastUsedTokens === 8,
      );
      assert.equal(terminal.payload.state, "completed");
      assertSingleTerminal(runtimeEvents, threadId, sentTurn.turnId);
      assert.deepInclude(compactedUsage?.payload.usage, {
        usedTokens: 8,
        totalProcessedTokens: 33,
        lastUsedTokens: 8,
        lastInputTokens: 5,
        lastCachedInputTokens: 1,
        lastOutputTokens: 2,
        compactsAutomatically: true,
      });
    }),
  );

  it.effect("maps child sessions to tasks without leaking child deltas into the main turn", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-child-session");
      const { adapter } = yield* makeDroidScenario({
        T3_DROID_MOCK_SCENARIO: "child-session",
      });
      const { events: runtimeEvents, waitForType } = yield* collectDroidEvents(adapter);
      yield* startDroidSession(adapter, threadId, "full-access");
      const sentTurn = yield* sendDroidTurn(adapter, threadId, "mock child session");
      yield* waitForType(threadId, "turn.completed");
      const threadEvents = eventsForThread(runtimeEvents, threadId);
      assert.lengthOf(eventsOfType(threadEvents, "task.started"), 1);
      assert.lengthOf(eventsOfType(threadEvents, "task.completed"), 1);
      const progress = eventsOfType(threadEvents, "tool.progress");
      assert.lengthOf(progress, 1);
      assert.equal(String(progress[0]?.payload.taskId), "mock-session-child");
      assert.equal(progress[0]?.payload.toolUseId, `child-task-${String(sentTurn.turnId)}`);
      assert.equal(progress[0]?.payload.toolName, "Task");
      assert.equal(progress[0]?.payload.summary, "Inspecting delegated files");
      assert.notInclude(
        eventsOfType(threadEvents, "content.delta")
          .map((event) => event.payload.delta)
          .join(""),
        "child-only output",
      );
    }),
  );

  it.effect("settles an uncorrelated Droid child with its owning logical turn", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-uncorrelated-child-turn");
      const { adapter } = yield* makeDroidScenario({
        T3_DROID_MOCK_SCENARIO: "hanging-child-session",
      });
      const { events: runtimeEvents, waitForType } = yield* collectDroidEvents(adapter);
      yield* startDroidSession(adapter, threadId, "full-access");
      const turn = yield* sendDroidTurn(adapter, threadId, "start uncorrelated child");
      const started = yield* waitForType(threadId, "task.started");
      yield* adapter.interruptTurn(threadId, turn.turnId);
      const terminal = yield* waitForType(threadId, "turn.completed");
      const threadEvents = eventsForThread(runtimeEvents, threadId);
      const completed = threadEvents.find(
        (event): event is Extract<ProviderRuntimeEvent, { type: "task.completed" }> =>
          event.type === "task.completed" &&
          String(event.payload.taskId) === String(started.payload.taskId),
      );
      assert.isDefined(completed);
      assert.equal(String(completed?.turnId), String(turn.turnId));
      assert.equal(completed?.payload.status, "stopped");
      assert.isBelow(threadEvents.indexOf(completed!), threadEvents.indexOf(terminal));
    }),
  );

  it.effect("stops open Droid child tasks before an explicit session exit", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-child-session-stop");
      const { adapter } = yield* makeDroidScenario({
        T3_DROID_MOCK_SCENARIO: "hanging-child-session",
      });
      const { events: runtimeEvents, waitForType } = yield* collectDroidEvents(adapter);
      yield* startDroidSession(adapter, threadId, "full-access");
      yield* sendDroidTurn(adapter, threadId, "mock hanging child session");
      const started = yield* waitForType(threadId, "task.started");
      yield* adapter.stopSession(threadId);
      const exited = yield* waitForType(threadId, "session.exited");
      const threadEvents = eventsForThread(runtimeEvents, threadId);
      const taskCompleted = threadEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "task.completed" }> =>
          event.type === "task.completed" &&
          String(event.payload.taskId) === String(started.payload.taskId),
      );
      assert.lengthOf(taskCompleted, 1, "stopping the session should settle its open child task");
      assert.equal(taskCompleted[0]?.payload.status, "stopped");
      assert.isBelow(threadEvents.indexOf(taskCompleted[0]!), threadEvents.indexOf(exited));
    }),
  );

  it.effect("stops open Droid child tasks before an unexpected process exit", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-child-session-process-exit");
      const { adapter } = yield* makeDroidScenario({
        T3_DROID_MOCK_SCENARIO: "child-session-exit",
      });
      const { events: runtimeEvents, waitForType } = yield* collectDroidEvents(adapter);
      yield* startDroidSession(adapter, threadId, "full-access");
      yield* sendDroidTurn(adapter, threadId, "mock child session then exit");
      const started = yield* waitForType(threadId, "task.started");
      const exited = yield* waitForType(threadId, "session.exited");
      const threadEvents = eventsForThread(runtimeEvents, threadId);
      const taskCompleted = threadEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "task.completed" }> =>
          event.type === "task.completed" &&
          String(event.payload.taskId) === String(started.payload.taskId),
      );
      assert.lengthOf(
        taskCompleted,
        1,
        "unexpected process exit should settle its open child task",
      );
      assert.equal(taskCompleted[0]?.payload.status, "stopped");
      assert.isBelow(threadEvents.indexOf(taskCompleted[0]!), threadEvents.indexOf(exited));
    }),
  );

  it.effect("drops Droid tool progress without an owning subagent session", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-taskless-tool-progress");
      const { adapter } = yield* makeDroidScenario({
        T3_DROID_MOCK_SCENARIO: "taskless-progress",
      });
      const { events: runtimeEvents, waitForType } = yield* collectDroidEvents(adapter);
      yield* startDroidSession(adapter, threadId, "full-access");
      yield* sendDroidTurn(adapter, threadId, "mock taskless progress");
      yield* waitForType(threadId, "turn.completed");
      assert.lengthOf(
        eventsForThread(runtimeEvents, threadId).filter((event) => event.type === "tool.progress"),
        0,
      );
    }),
  );

  it.effect("restores durable Droid history before rollback after resume", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-resumed-rollback");
      const { adapter } = yield* makeDroidScenario();
      const persistedTurnIds = [
        TurnId.make("persisted-turn-1"),
        TurnId.make("persisted-turn-2"),
        TurnId.make("persisted-turn-3"),
      ];
      const persistedAnchor = TurnId.make("persisted-anchor");
      yield* startDroidSession(adapter, threadId, "full-access", {
        resumeCursor: {
          schemaVersion: 2,
          sessionId: "mock-session-known",
          turnIds: [...persistedTurnIds, persistedAnchor],
        },
      });
      const snapshot = yield* adapter.rollbackThread(threadId, 1);
      assert.deepEqual(
        snapshot.turns.map((turn) => turn.id),
        persistedTurnIds,
      );
      assert.deepStrictEqual(snapshot.resumeCursor, {
        schemaVersion: 2,
        sessionId: "mock-session-rewound",
        turnIds: persistedTurnIds,
      });
    }),
  );

  it.effect("rolls back the first turn completed after resuming a Droid session", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-resumed-turn-rollback");
      const { adapter } = yield* makeDroidScenario();
      const persistedTurnIds = [
        TurnId.make("persisted-turn-1"),
        TurnId.make("persisted-turn-2"),
        TurnId.make("persisted-turn-3"),
      ];
      const { waitForType } = yield* collectDroidEvents(adapter);
      yield* startDroidSession(adapter, threadId, "full-access", {
        resumeCursor: {
          schemaVersion: 2,
          sessionId: "mock-session-known",
          turnIds: persistedTurnIds,
        },
      });
      yield* sendDroidTurn(adapter, threadId, "turn after restart");
      yield* waitForType(threadId, "turn.completed");
      const snapshot = yield* adapter.rollbackThread(threadId, 1);
      assert.deepEqual(
        snapshot.turns.map((turn) => turn.id),
        persistedTurnIds,
      );
      assert.deepStrictEqual(snapshot.resumeCursor, {
        schemaVersion: 2,
        sessionId: "mock-session-rewound",
        turnIds: persistedTurnIds,
      });
    }),
  );

  it.effect("settles a coalesced steering turn exactly once", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-steering-coalesced");
      const { adapter } = yield* makeDroidScenario({
        T3_DROID_MOCK_SCENARIO: "steering-coalesced",
      });
      const { events: runtimeEvents, waitFor, waitForType } = yield* collectDroidEvents(adapter);
      yield* startDroidSession(adapter, threadId, "full-access");
      const openingTurn = yield* sendDroidTurn(adapter, threadId, "mock steering original");
      yield* waitFor(
        (event): event is Extract<ProviderRuntimeEvent, { type: "item.started" }> =>
          event.type === "item.started" &&
          event.payload.itemType === "command_execution" &&
          String(event.threadId) === String(threadId),
      );
      const steeredTurn = yield* sendDroidTurn(adapter, threadId, "mock steering coalesced");
      const terminal = yield* waitForType(threadId, "turn.completed");
      assert.equal(String(steeredTurn.turnId), String(openingTurn.turnId));
      assert.equal(terminal.payload.state, "completed");
      assertSingleTerminal(runtimeEvents, threadId, openingTurn.turnId);
    }),
  );

  it.effect("keeps a steered turn open when the queued message runs separately", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-steering-separate");
      const { adapter } = yield* makeDroidScenario({
        T3_DROID_MOCK_SCENARIO: "steering-separate",
      });
      const { events: runtimeEvents, waitFor, waitForType } = yield* collectDroidEvents(adapter);
      const commandStarted = (
        event: ProviderRuntimeEvent,
      ): event is Extract<ProviderRuntimeEvent, { type: "item.started" }> =>
        event.type === "item.started" &&
        event.payload.itemType === "command_execution" &&
        String(event.threadId) === String(threadId);
      yield* startDroidSession(adapter, threadId, "full-access");
      const openingTurn = yield* sendDroidTurn(adapter, threadId, "mock steering original");
      yield* waitFor(commandStarted);
      const steeredTurn = yield* sendDroidTurn(adapter, threadId, "mock steering separate");
      yield* waitFor(commandStarted, 2);
      assert.lengthOf(
        eventsOfType(eventsForThread(runtimeEvents, threadId), "turn.completed"),
        0,
        "the first physical terminal must not settle while the queued run is still active",
      );
      yield* adapter.interruptTurn(threadId, openingTurn.turnId);
      const terminal = yield* waitForType(threadId, "turn.completed");
      assert.equal(String(steeredTurn.turnId), String(openingTurn.turnId));
      assert.equal(terminal.payload.state, "cancelled");
      assertSingleTerminal(runtimeEvents, threadId, openingTurn.turnId);
    }),
  );

  it.effect("ignores unknown Droid notifications and still completes the turn", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-unknown-notification");
      const { adapter } = yield* makeDroidScenario({
        T3_DROID_MOCK_SCENARIO: "unknown-notification",
      });
      const { events: runtimeEvents, waitForType } = yield* collectDroidEvents(adapter);
      yield* startDroidSession(adapter, threadId, "full-access");
      yield* sendDroidTurn(adapter, threadId, "tolerate future notifications");
      const terminal = yield* waitForType(threadId, "turn.completed");
      assert.equal(
        assistantText(eventsForThread(runtimeEvents, threadId)),
        "hello from droid mock",
      );
      assert.equal(terminal.payload.state, "completed");
    }),
  );
});
