import {
  AgentScope,
  ChildProcessSpawner,
  Deferred,
  Effect,
  EnvironmentId,
  FAKE_SESSION_FILE,
  Fiber,
  McpProviderSessions,
  PI_INSTANCE_ID,
  ProviderContinuationRequests,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  Queue,
  SESSION_ID,
  THREAD_ID,
  ThreadId,
  assert,
  describe,
  handoffBudget,
  it,
  layerTest,
  makeFakePi,
  modelSelection,
  openRuntime,
  runtimePolicy,
  startTurn,
} from "./adapter-fixtures.testkit.ts";

describe("PiAdapterV2", () => {
  it.effect.each([false, true])(
    "a user prompt takes the wake without premature settlement, native wake settled=%s",
    (settled) =>
      Effect.gen(function* () {
        const fake = yield* makeFakePi;
        const offers =
          yield* Queue.unbounded<ProviderContinuationRequests.ProviderContinuationRequest>();
        const { runtime, takeEvent } = yield* openRuntime(
          fake,
          "default",
          THREAD_ID,
          SESSION_ID,
          undefined,
          {
            offer: (request) => Queue.offer(offers, request).pipe(Effect.asVoid),
          },
        );
        const providerThread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });
        yield* fake.emit({ type: "agent_start" });
        const offer = yield* Queue.take(offers);
        if (settled) {
          yield* fake.emit({ type: "agent_settled" });
          yield* takeEvent(
            (event) =>
              event.type === "provider_session.updated" && event.providerSession.status === "ready",
          );
        }
        yield* startTurn(runtime, providerThread);
        const prompt = yield* fake.takeRequest("prompt");
        assert.equal(prompt["message"], "Hello pi");
        assert.equal(prompt["streamingBehavior"], "steer");
        yield* fake.emit({ type: "response", command: "prompt", success: true });
        yield* fake.emit({ type: "agent_start" });
        yield* fake.emit({
          type: "extension_ui_request",
          id: "owned-dialog",
          method: "confirm",
          title: "Continue?",
        });
        const dialog = yield* takeEvent((event) => event.type === "runtime_request.updated");
        assert.isTrue(dialog.type === "runtime_request.updated");
        if (dialog.type !== "runtime_request.updated") return;
        assert.isNotNull(dialog.runtimeRequest.providerTurnId);
        yield* offer.clearIfCurrent!();
        yield* runtime.respondToRuntimeRequest({
          requestId: dialog.runtimeRequest.id,
          decision: "accept",
        });
        const response = yield* fake.takeRequest("extension_ui_response");
        assert.isTrue(response["confirmed"]);
        yield* fake.emit({ type: "message_start", message: { role: "assistant" } });
        yield* fake.emit({
          type: "message_update",
          assistantMessageEvent: {
            type: "text_end",
            contentIndex: 0,
            content: "User prompt completed",
          },
        });
        yield* fake.emit({ type: "agent_settled" });
        const message = yield* takeEvent(
          (event) =>
            event.type === "message.updated" && event.message.text === "User prompt completed",
        );
        assert.isTrue(message.type === "message.updated" && message.message.runId !== null);
        yield* takeEvent((event) => event.type === "turn.terminal");
        let dispatched = false;
        yield* offer.dispatchIfCurrent!(
          Effect.sync(() => {
            dispatched = true;
          }),
        );
        assert.isFalse(dispatched);
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect.each([false, true])(
    "defers a wake's late settlement until the joined user prompt is acknowledged, aborted=%s",
    (aborted) =>
      Effect.gen(function* () {
        const fake = yield* makeFakePi;
        const offers =
          yield* Queue.unbounded<ProviderContinuationRequests.ProviderContinuationRequest>();
        const { runtime, takeEvent } = yield* openRuntime(
          fake,
          "default",
          THREAD_ID,
          SESSION_ID,
          undefined,
          {
            offer: (request) => Queue.offer(offers, request).pipe(Effect.asVoid),
          },
        );
        const providerThread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });
        yield* fake.emit({ type: "agent_start" });
        yield* Queue.take(offers);
        yield* startTurn(runtime, providerThread);
        yield* fake.takeRequest("prompt");
        yield* fake.emit({ type: "agent_settled", aborted });
        yield* fake.emit({
          type: "extension_ui_request",
          method: "notify",
          message: "Ordering barrier",
        });
        yield* takeEvent(
          (event) => event.type === "turn_item.updated" && event.turnItem.type === "system_notice",
        );
        assert.equal(runtime.providerSession.status, "running");
        fake.queueState({ isStreaming: true });
        yield* fake.emit({ type: "response", command: "prompt", success: true });
        yield* fake.takeRequest("get_state");
        yield* fake.emit({ type: "agent_start" });
        yield* fake.emit({ type: "agent_settled" });
        const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
        assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "completed");
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect.each([
    { aborted: false, resumes: false, expected: "completed" },
    { aborted: true, resumes: false, expected: "interrupted" },
    { aborted: true, resumes: true, expected: "completed" },
  ])(
    "settles a completed wake, aborted=$aborted, resumes=$resumes",
    ({ aborted, resumes, expected }) =>
      Effect.gen(function* () {
        const fake = yield* makeFakePi;
        const offers =
          yield* Queue.unbounded<ProviderContinuationRequests.ProviderContinuationRequest>();
        const { runtime, takeEvent } = yield* openRuntime(
          fake,
          "default",
          THREAD_ID,
          SESSION_ID,
          undefined,
          {
            offer: (request) => Queue.offer(offers, request).pipe(Effect.asVoid),
          },
        );
        const providerThread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });
        yield* fake.emit({ type: "agent_start" });
        yield* Queue.take(offers);
        yield* fake.emit({ type: "agent_settled", aborted });
        yield* takeEvent(
          (event) =>
            event.type === "provider_session.updated" && event.providerSession.status === "ready",
        );
        yield* startTurn(runtime, providerThread, "default", [], "/hello");
        yield* fake.takeRequest("prompt");
        if (resumes) yield* fake.emit({ type: "agent_start" });
        yield* fake.emit({ type: "response", command: "prompt", success: true });
        if (resumes) yield* fake.emit({ type: "agent_settled", aborted: false });
        const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
        assert.isTrue(terminal.type === "turn.terminal" && terminal.status === expected);
        yield* startTurn(
          runtime,
          providerThread,
          "default",
          [],
          "Stale continuation",
          undefined,
          2,
          THREAD_ID,
          true,
        );
        yield* takeEvent((event) => event.type === "turn.terminal");
        assert.equal(
          fake.allRequests().filter((request) => request["type"] === "prompt").length,
          1,
        );
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("keeps a pending wake on its thread and lets Stop retire its process", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const offers =
        yield* Queue.unbounded<ProviderContinuationRequests.ProviderContinuationRequest>();
      const { runtime, takeEvent } = yield* openRuntime(
        fake,
        "default",
        THREAD_ID,
        SESSION_ID,
        undefined,
        {
          offer: (request) => Queue.offer(offers, request).pipe(Effect.asVoid),
        },
      );
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* fake.emit({ type: "agent_start" });
      const offer = yield* Queue.take(offers);
      assert.isTrue(yield* runtime.hasPendingBackgroundWorkForThread!(providerThread));
      const otherThread = {
        ...providerThread,
        appThreadId: ThreadId.make("other-thread"),
        id: ProviderThreadId.make("other-provider-thread"),
      };
      assert.isFalse(yield* runtime.hasPendingBackgroundWorkForThread!(otherThread));
      const failure = yield* runtime
        .resumeThread({ providerThread: otherThread })
        .pipe(Effect.flip);
      assert.equal(failure._tag, "ProviderAdapterResumeThreadError");
      yield* runtime.interruptTurn({
        providerThread,
        providerTurnId: ProviderTurnId.make("settled-turn"),
        requestRuntimeRestart: true,
      });
      yield* takeEvent(
        (event) =>
          event.type === "provider_session.updated" && event.providerSession.status === "stopped",
      );
      assert.isFalse(yield* runtime.hasPendingBackgroundWork!);
      let dispatched = false;
      yield* offer.dispatchIfCurrent!(
        Effect.sync(() => {
          dispatched = true;
        }),
      );
      assert.isFalse(dispatched);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect.each(["archive", "stop", "transport death"] as const)(
    "retiring a wake by %s cancels visible dialogs and invalidates its offer",
    (retirement) =>
      Effect.gen(function* () {
        const fake = yield* makeFakePi;
        const offers =
          yield* Queue.unbounded<ProviderContinuationRequests.ProviderContinuationRequest>();
        const { runtime, takeEvent } = yield* openRuntime(
          fake,
          "default",
          THREAD_ID,
          SESSION_ID,
          undefined,
          {
            offer: (request) => Queue.offer(offers, request).pipe(Effect.asVoid),
          },
        );
        const providerThread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });
        yield* fake.emit({ type: "agent_start" });
        const offer = yield* Queue.take(offers);
        yield* fake.emit({
          type: "extension_ui_request",
          id: "wake-dialog",
          method: "confirm",
          title: "Continue background work?",
        });
        const dialog = yield* takeEvent((event) => event.type === "runtime_request.updated");
        assert.isTrue(dialog.type === "runtime_request.updated");
        if (dialog.type !== "runtime_request.updated") return;
        assert.isNull(dialog.runtimeRequest.providerTurnId);
        if (retirement === "archive") yield* offer.clearIfCurrent!();
        else if (retirement === "stop") {
          yield* runtime.interruptTurn({
            providerThread,
            providerTurnId: ProviderTurnId.make("settled-turn"),
            requestRuntimeRestart: true,
          });
        } else yield* fake.closeStdout;
        let requestCancelled = false;
        let nodeCancelled = false;
        let itemCancelled = false;
        yield* takeEvent((event) => {
          if (
            event.type === "runtime_request.updated" &&
            event.runtimeRequest.id === dialog.runtimeRequest.id
          )
            requestCancelled = event.runtimeRequest.status === "cancelled";
          if (event.type === "node.updated" && event.node.id === dialog.runtimeRequest.nodeId)
            nodeCancelled = event.node.status === "cancelled";
          if (
            event.type === "turn_item.updated" &&
            event.turnItem.nodeId === dialog.runtimeRequest.nodeId
          )
            itemCancelled = event.turnItem.status === "cancelled";
          return (
            event.type === "provider_session.updated" &&
            event.providerSession.status ===
              (retirement === "transport death" ? "error" : "stopped")
          );
        });
        assert.isTrue(requestCancelled, "Retired wake left a pending runtime request");
        assert.isTrue(nodeCancelled);
        assert.isTrue(itemCancelled);
        assert.isFalse(yield* runtime.hasPendingBackgroundWork!);
        let dispatched = false;
        yield* offer.dispatchIfCurrent!(
          Effect.sync(() => {
            dispatched = true;
          }),
        );
        assert.isFalse(dispatched);
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("stops provider-initiated work that has no T3 turn owner", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });

      yield* fake.emit({ type: "agent_start" });

      const sessionError = yield* takeEvent(
        (event) =>
          event.type === "provider_session.updated" && event.providerSession.status === "error",
      );
      assert.isTrue(
        sessionError.type === "provider_session.updated" &&
          sessionError.providerSession.lastError?.includes("invisible tool execution") === true,
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect.each(["session", "process"] as const)("cleans up detached work on Pi %s exit", (exit) =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      const scopeStopped = yield* Deferred.make<void>();
      let processReleased = false;
      const stopped: Array<{ unit: string; processReleased: boolean }> = [];
      yield* Effect.gen(function* () {
        yield* openRuntime({
          ...fake,
          spawner: ChildProcessSpawner.make((command) =>
            Effect.acquireRelease(
              fake.spawner
                .spawn(command)
                .pipe(
                  Effect.map((child) =>
                    ChildProcessSpawner.makeHandle({ ...child, exitCode: Deferred.await(exited) }),
                  ),
                ),
              () =>
                Effect.sync(() => {
                  processReleased = true;
                }),
            ),
          ),
        });
        assert.deepStrictEqual(stopped, []);
        if (exit === "process") {
          // Stdout stays open as it would for a child holding the inherited pipe.
          yield* Deferred.succeed(exited, ChildProcessSpawner.ExitCode(19));
          yield* Deferred.await(scopeStopped);
          assert.isFalse(processReleased);
        }
      }).pipe(
        Effect.scoped,
        Effect.provideService(AgentScope, {
          ...AgentScope.defaultValue(),
          wrap: ({ command, args }) =>
            Effect.succeed({ command, args, unit: "t3code-pi-test.scope" }),
          stop: (unit) =>
            Effect.sync(() => void stopped.push({ unit, processReleased })).pipe(
              Effect.andThen(Deferred.succeed(scopeStopped, undefined)),
              Effect.asVoid,
            ),
        }),
      );
      assert.deepStrictEqual(stopped, [
        { unit: "t3code-pi-test.scope", processReleased: exit === "session" },
      ]);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("gives notify and extension-error items distinct ids in each thread", () =>
    Effect.gen(function* () {
      const itemIds = new Set<string>();
      for (const [threadId, extensionPath] of [
        [THREAD_ID, "/ext/a.ts"],
        [ThreadId.make("thread-pi-test-2"), "/ext/a/index.ts"],
      ] as const) {
        const fake = yield* makeFakePi;
        const { runtime, takeEvent } = yield* openRuntime(fake, "default", threadId);
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });
        yield* startTurn(
          runtime,
          providerThread,
          "default",
          [],
          "Hello pi",
          undefined,
          1,
          threadId,
        );
        yield* fake.takeRequest("prompt");
        yield* fake.emit({
          type: "extension_ui_request",
          id: "ui-notify",
          method: "notify",
          message: "note",
        });
        yield* fake.emit({ type: "extension_error", extensionPath, error: "boom" });
        for (const prefix of ["notify:", "extension-error:"]) {
          const item = yield* takeEvent(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.nativeItemRef?.nativeId?.startsWith(prefix) === true,
          );
          if (item.type === "turn_item.updated") itemIds.add(item.turnItem.id);
          if (item.type === "turn_item.updated" && prefix === "extension-error:") {
            assert.equal(item.turnItem.title, "a");
          }
        }
      }
      assert.equal(itemIds.size, 4);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("injects the T3 MCP extension and bearer when a session exists", () =>
    Effect.gen(function* () {
      yield* (yield* McpProviderSessions.McpProviderSessions).set({
        environmentId: EnvironmentId.make("environment-pi-mcp"),
        threadId: THREAD_ID,
        providerSessionId: "mcp-session-pi",
        providerInstanceId: PI_INSTANCE_ID,
        endpoint: "http://127.0.0.1:43123/mcp",
        authorizationHeader: "Bearer secret-pi-token",
        browserToolsAvailable: true,
      });
      const fake = yield* makeFakePi;
      yield* openRuntime(fake);
      const spawn = fake.lastSpawn();
      assert.isTrue(spawn.args.includes("--extension"));
      const extensions = spawn.args.flatMap((arg, index) =>
        arg === "--extension" ? [spawn.args[index + 1]] : [],
      );
      assert.isFalse(spawn.args.includes("--no-extensions"));
      // A thread's long-lived process keeps Pi's startup model refresh unless the user opts out.
      assert.notInclude(spawn.args, "--offline");
      assert.isUndefined(spawn.env.PI_OFFLINE);
      assert.isTrue(extensions.some((path) => path?.endsWith("pi-t3-mcp-extension.ts")));
      assert.equal(spawn.env.T3_MCP_URL, "http://127.0.0.1:43123/mcp");
      assert.equal(spawn.env.T3_MCP_BEARER_TOKEN, "secret-pi-token");
      assert.equal(spawn.env.T3_PI_RUNTIME_MODE, "full-access");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("rejects a resume while a turn is active", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      const error = yield* runtime.resumeThread({ providerThread }).pipe(Effect.flip);
      assert.equal(error._tag, "ProviderAdapterResumeThreadError");
      assert.match(String(error.cause), /while a turn is active/);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("creates a distinct native session after a failed resume", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      fake.vetoNextSwitch();
      yield* runtime.resumeThread({ providerThread }).pipe(Effect.flip);
      const replacement = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
        existingProviderThread: { ...providerThread, nativeThreadRef: null },
      });
      assert.equal(replacement.id, providerThread.id);
      assert.notEqual(
        replacement.nativeThreadRef?.nativeId,
        providerThread.nativeThreadRef?.nativeId,
      );
      assert.equal(
        fake.allRequests().filter((request) => request.type === "new_session").length,
        1,
      );
      yield* startTurn(runtime, replacement, "default");
      yield* fake.takeRequest("prompt");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect.each(["veto", "same identity"] as const)(
    "rejects a replacement with %s",
    (invalidReplacement) =>
      Effect.gen(function* () {
        const fake = yield* makeFakePi;
        const { runtime } = yield* openRuntime(fake);
        const providerThread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });
        if (invalidReplacement === "veto") fake.vetoNextNewSession();
        else fake.queueState({ sessionFile: FAKE_SESSION_FILE });
        const error = yield* runtime
          .ensureThread({
            threadId: THREAD_ID,
            modelSelection: modelSelection("default"),
            runtimePolicy,
            existingProviderThread: { ...providerThread, nativeThreadRef: null },
          })
          .pipe(Effect.flip);
        assert.equal(error._tag, "ProviderAdapterEnsureThreadError");
        assert.match(
          String(error.cause),
          invalidReplacement === "veto" ? /cancelled/ : /distinct session/,
        );
        yield* startTurn(runtime, providerThread, "default").pipe(Effect.flip);
        assert.isFalse(fake.allRequests().some((request) => request.type === "prompt"));
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("retires an interrupted switch before accepting further requests", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      fake.deferNextLifecycle("switch_session");
      const resumed = yield* runtime.resumeThread({ providerThread }).pipe(Effect.forkChild);
      yield* fake.takeRequest("switch_session");
      yield* Fiber.interrupt(resumed);
      yield* takeEvent(
        (event) =>
          event.type === "provider_session.updated" && event.providerSession.status === "error",
      );
      yield* runtime
        .ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
          existingProviderThread: { ...providerThread, nativeThreadRef: null },
        })
        .pipe(Effect.flip);
      assert.isFalse(fake.allRequests().some((request) => request.type === "new_session"));
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("budgets legacy native history with Pi's selected model capacity", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      fake.queueState({
        sessionFile: FAKE_SESSION_FILE,
        model: { provider: "anthropic", id: "large", contextWindow: 1_000_000 },
      });
      fake.queueModels([{ provider: "anthropic", id: "small", contextWindow: 32_000 }]);
      const { runtime } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      const budget = (model: string) =>
        handoffBudget({
          tokenCap: 16_000,
          userText: "$handoff",
          attachments: [],
          providerThread,
          nativeContextEstimate: 307_543,
          modelContextWindow: runtime.getModelContextWindow?.(modelSelection(model)),
        });
      assert.equal(budget("default"), 16_000);
      assert.equal(budget("anthropic/large"), 16_000);
      assert.equal(runtime.getModelContextWindow?.(modelSelection("anthropic/small")), 32_000);
      assert.equal(budget("anthropic/small"), 0);
      assert.isUndefined(runtime.getModelContextWindow?.(modelSelection("anthropic/unknown")));
      assert.isUndefined(
        runtime.getModelContextWindow?.({
          instanceId: ProviderInstanceId.make("other-pi"),
          model: "anthropic/large",
        }),
      );
      fake.queueState({
        sessionFile: "/fake/replacement.jsonl",
        model: { provider: "anthropic", id: "small", contextWindow: 32_000 },
      });
      yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
        existingProviderThread: { ...providerThread, nativeThreadRef: null },
      });
      assert.equal(runtime.getModelContextWindow?.(modelSelection("default")), 32_000);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
});
