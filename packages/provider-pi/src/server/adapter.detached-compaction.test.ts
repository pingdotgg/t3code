import {
  Effect,
  Fiber,
  PI_COMPACTING_PROMPT_ERROR,
  RunId,
  THREAD_ID,
  assert,
  describe,
  it,
  layerTest,
  makeFakePi,
  modelSelection,
  openRuntime,
  runtimePolicy,
  startTurn,
} from "./adapter-fixtures.testkit.ts";

describe("PiAdapterV2", () => {
  it.effect("delivers a turn-start prompt sent during detached compaction once it ends", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({ type: "agent_settled" });
      yield* fake.takeRequest("get_state");
      const first = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(first.type === "turn.terminal" && first.status === "completed");

      fake.setCompacting(true);
      yield* fake.emit({ type: "compaction_start", reason: "manual" });
      // The dialog proves the pump observed compaction_start before the prompt.
      yield* fake.emit({
        type: "extension_ui_request",
        id: "detached-compaction-dialog",
        method: "confirm",
        title: "Continue?",
      });
      yield* takeEvent((event) => event.type === "runtime_request.updated");
      yield* startTurn(
        runtime,
        providerThread,
        "default",
        [],
        "Sent during compaction",
        undefined,
        2,
      );
      // Writes go out in order, so this round trip flushes any prompt sent before it.
      yield* runtime.readThreadSnapshot({ providerThread });
      fake.setCompacting(false);
      const compactionEnded = fake.allRequests().length;
      assert.isFalse(
        fake
          .allRequests()
          .some(
            (request) =>
              request["type"] === "prompt" && request["message"] === "Sent during compaction",
          ),
      );
      yield* fake.emit({
        type: "compaction_end",
        reason: "manual",
        result: { summary: "smaller", tokensBefore: 10_000, estimatedTokensAfter: 2_000 },
        aborted: false,
        willRetry: false,
      });
      const delivered = yield* fake.takeRequest("prompt");
      assert.equal(delivered["message"], "Sent during compaction");
      yield* fake.emit({ type: "agent_start" });
      fake.queueState({ isStreaming: false, isCompacting: false, pendingMessageCount: 0 });
      yield* fake.emit({ type: "agent_settled" });
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.equal(
        fake
          .allRequests()
          .slice(compactionEnded)
          .filter(
            (request) =>
              request["type"] === "prompt" && request["message"] === "Sent during compaction",
          ).length,
        1,
      );
      assert.isTrue(
        terminal.type === "turn.terminal" && terminal.status === "completed",
        `turn ended ${terminal.type === "turn.terminal" ? terminal.status : terminal.type}`,
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect.each([
    { error: PI_COMPACTING_PROMPT_ERROR, retried: true },
    { error: "Model unavailable", retried: false },
  ])(
    "retries a prompt Pi rejected because compaction started first, retried=$retried",
    ({ error, retried }) =>
      Effect.gen(function* () {
        const fake = yield* makeFakePi;
        const { runtime, takeEvent } = yield* openRuntime(fake);
        const providerThread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });
        yield* startTurn(runtime, providerThread);
        yield* fake.takeRequest("prompt");
        yield* fake.emit({ type: "response", command: "prompt", success: true });
        yield* fake.emit({ type: "agent_start" });
        yield* fake.emit({ type: "agent_settled" });
        yield* fake.takeRequest("get_state");
        yield* takeEvent((event) => event.type === "turn.terminal");

        yield* startTurn(runtime, providerThread, "default", [], "Raced compaction", undefined, 2);
        yield* fake.takeRequest("prompt");
        yield* fake.emit({ type: "compaction_start", reason: "manual" });
        yield* fake.emit({
          type: "response",
          command: "prompt",
          success: false,
          error,
        });
        if (!retried) {
          const failed = yield* takeEvent((event) => event.type === "turn.terminal");
          assert.isTrue(
            failed.type === "turn.terminal" &&
              failed.status === "failed" &&
              failed.failure.message === error,
          );
          return;
        }
        const compactionEnded = fake.allRequests().length;
        yield* fake.emit({ type: "compaction_end", result: null, aborted: true });
        const retriedPrompt = yield* fake.takeRequest("prompt");
        assert.equal(retriedPrompt["message"], "Raced compaction");
        yield* fake.emit({ type: "agent_start" });
        yield* fake.emit({ type: "agent_settled" });
        const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
        assert.isTrue(
          terminal.type === "turn.terminal" && terminal.status === "completed",
          `turn ended ${terminal.type === "turn.terminal" ? terminal.status : terminal.type}`,
        );
        assert.equal(
          fake
            .allRequests()
            .slice(compactionEnded)
            .filter((request) => request["type"] === "prompt").length,
          1,
        );
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect.each([{ restart: false }, { restart: true }])(
    "restarts Pi when Stop interrupts a prompt held for detached compaction, restart=$restart",
    ({ restart }) =>
      Effect.gen(function* () {
        const fake = yield* makeFakePi;
        const { runtime, takeEvent } = yield* openRuntime(fake);
        const providerThread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });
        yield* startTurn(runtime, providerThread);
        yield* fake.takeRequest("prompt");
        yield* fake.emit({ type: "agent_start" });
        yield* fake.emit({ type: "agent_settled" });
        yield* fake.takeRequest("get_state");
        yield* takeEvent((event) => event.type === "turn.terminal");

        fake.setCompacting(true);
        yield* fake.emit({ type: "compaction_start", reason: "manual" });
        // The dialog proves the pump observed compaction_start before the prompt.
        yield* fake.emit({
          type: "extension_ui_request",
          id: "held-prompt-dialog",
          method: "confirm",
          title: "Continue?",
        });
        yield* takeEvent((event) => event.type === "runtime_request.updated");
        yield* startTurn(runtime, providerThread, "default", [], "Held prompt", undefined, 2);
        // Writes go out in order, so this round trip flushes any prompt sent before it.
        yield* runtime.readThreadSnapshot({ providerThread });
        assert.isFalse(
          fake
            .allRequests()
            .some(
              (request) => request["type"] === "prompt" && request["message"] === "Held prompt",
            ),
        );
        const running = yield* takeEvent(
          (event) =>
            event.type === "provider_turn.updated" &&
            event.providerTurn.status === "running" &&
            event.providerTurn.ordinal === 2,
        );
        const providerTurnId =
          running.type === "provider_turn.updated" ? running.providerTurn.id : undefined;
        assert.isDefined(providerTurnId);

        const interruptedAt = fake.allRequests().length;
        if (restart) {
          fake.deferNextLifecycle("abort");
          const stop = yield* Effect.forkChild(
            runtime.interruptTurn({
              providerThread,
              providerTurnId: providerTurnId!,
              requestRuntimeRestart: true,
            }),
          );
          const abort = yield* fake.takeRequest("abort");
          // The abort ends compaction before Pi exits; the stopped turn's prompt stays held.
          fake.setCompacting(false);
          yield* fake.emit({
            type: "compaction_end",
            reason: "manual",
            result: null,
            aborted: true,
          });
          yield* fake.emit({
            type: "extension_ui_request",
            id: "after-compaction-dialog",
            method: "confirm",
            title: "Continue?",
          });
          yield* takeEvent((event) => event.type === "runtime_request.updated");
          yield* fake.emit({ type: "response", id: abort["id"], command: "abort", success: true });
          yield* Fiber.join(stop);
        } else {
          yield* runtime.interruptTurn({ providerThread, providerTurnId: providerTurnId! });
          assert.isFalse(fake.allRequests().some((request) => request["type"] === "abort"));
        }
        yield* fake.closeStdout;
        const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
        assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "interrupted");
        assert.isFalse(
          fake
            .allRequests()
            .slice(interruptedAt)
            .some((request) => request["type"] === "prompt"),
        );
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("delivers a steer sent during in-turn compaction once it ends", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      const running = yield* takeEvent(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "running",
      );
      const providerTurnId =
        running.type === "provider_turn.updated" ? running.providerTurn.id : undefined;
      assert.isDefined(providerTurnId);
      yield* fake.emit({ type: "agent_start" });
      fake.queueState({ isStreaming: false, isCompacting: true, pendingMessageCount: 0 });
      yield* fake.emit({ type: "agent_settled" });
      yield* fake.takeRequest("get_state");
      fake.setCompacting(true);
      yield* fake.emit({ type: "compaction_start", reason: "manual" });
      yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction",
      );

      yield* runtime.steerTurn({
        threadId: THREAD_ID,
        runId: RunId.make("run:thread-pi-test:1"),
        providerThread,
        providerTurnId: providerTurnId!,
        message: {
          messageId: "message:thread-pi-test:steer-during-compaction" as never,
          text: "Steer during compaction",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
      });
      fake.setCompacting(false);
      const compactionEnded = fake.allRequests().length;
      yield* fake.emit({
        type: "compaction_end",
        reason: "manual",
        result: { summary: "smaller", tokensBefore: 10_000, estimatedTokensAfter: 2_000 },
        aborted: false,
        willRetry: false,
      });
      const delivered = yield* fake.takeRequest("prompt");
      assert.equal(delivered["message"], "Steer during compaction");
      yield* fake.emit({ type: "agent_start" });
      fake.queueState({ isStreaming: false, isCompacting: false, pendingMessageCount: 0 });
      yield* fake.emit({ type: "agent_settled" });
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.equal(
        fake
          .allRequests()
          .slice(compactionEnded)
          .filter(
            (request) =>
              request["type"] === "prompt" && request["message"] === "Steer during compaction",
          ).length,
        1,
      );
      assert.isTrue(
        terminal.type === "turn.terminal" && terminal.status === "completed",
        `turn ended ${terminal.type === "turn.terminal" ? terminal.status : terminal.type}`,
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("keeps working after a settle probe fails before detached compaction", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });

      fake.failNextState();
      yield* fake.emit({ type: "agent_settled" });
      yield* fake.takeRequest("get_state");
      yield* fake.emit({ type: "compaction_start", reason: "manual" });
      yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction",
      );

      fake.queueState({ isStreaming: false, isCompacting: false, pendingMessageCount: 0 });
      yield* fake.emit({
        type: "compaction_end",
        reason: "manual",
        result: { summary: "smaller", tokensBefore: 10_000, estimatedTokensAfter: 2_000 },
        aborted: false,
        willRetry: false,
      });
      yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "compaction" &&
          event.turnItem.status === "completed",
      );
      yield* fake.takeRequest("get_state");
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "completed");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("restarts Pi when Stop interrupts detached compaction", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      const running = yield* takeEvent(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "running",
      );
      assert.equal(running.type, "provider_turn.updated");
      const providerTurnId =
        running.type === "provider_turn.updated" ? running.providerTurn.id : undefined;
      assert.isDefined(providerTurnId);
      yield* fake.emit({ type: "agent_start" });

      fake.queueState({ isStreaming: false, isCompacting: true, pendingMessageCount: 0 });
      yield* fake.emit({ type: "agent_settled" });
      yield* fake.takeRequest("get_state");
      yield* fake.emit({ type: "compaction_start", reason: "manual" });
      yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction",
      );

      yield* runtime.interruptTurn({ providerThread, providerTurnId: providerTurnId! });
      assert.isFalse(fake.allRequests().some((request) => request["type"] === "abort"));
      yield* fake.closeStdout;
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "interrupted");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("ignores an idle snapshot made stale by a steer", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      const running = yield* takeEvent(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "running",
      );
      assert.equal(running.type, "provider_turn.updated");
      const providerTurnId =
        running.type === "provider_turn.updated" ? running.providerTurn.id : undefined;
      assert.isDefined(providerTurnId);
      yield* fake.emit({ type: "agent_start" });

      fake.deferNextState();
      yield* fake.emit({ type: "agent_settled" });
      yield* fake.takeRequest("get_state");
      yield* runtime.steerTurn({
        threadId: THREAD_ID,
        runId: RunId.make("run:thread-pi-test:1"),
        providerThread,
        providerTurnId: providerTurnId!,
        message: {
          messageId: "message:thread-pi-test:late-steer" as never,
          text: "Continue after settlement",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
      });
      yield* fake.takeRequest("prompt");
      yield* fake.resolveDeferredState({
        isStreaming: false,
        isCompacting: false,
        pendingMessageCount: 0,
      });

      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({ type: "message_start", message: { role: "assistant" } });
      yield* fake.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "Recovered" },
      });
      yield* fake.emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Recovered" }],
          stopReason: "stop",
        },
      });
      const assistantItem = yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "assistant_message" &&
          event.turnItem.streaming === false,
      );
      assert.isTrue(
        assistantItem.type === "turn_item.updated" &&
          assistantItem.turnItem.type === "assistant_message" &&
          assistantItem.turnItem.text === "Recovered",
      );

      fake.queueState({ isStreaming: false, isCompacting: false, pendingMessageCount: 0 });
      yield* fake.emit({ type: "agent_settled" });
      yield* fake.takeRequest("get_state");
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "completed");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
});
