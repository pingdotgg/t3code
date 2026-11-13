import {
  ChatAttachmentId,
  CheckpointId,
  Effect,
  Fiber,
  FileSystem,
  NodeId,
  PI_PROVIDER,
  ProviderAdapter,
  ProviderContinuationRequests,
  ProviderHost,
  ProviderTurnId,
  Queue,
  SESSION_ID,
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
  type ChatAttachment,
} from "./adapter-fixtures.testkit.ts";

describe("PiAdapterV2", () => {
  it.effect("keeps native image bytes and the saved path in the prompt", () =>
    Effect.gen(function* () {
      const host = yield* ProviderHost.ProviderHost;
      const fileSystem = yield* FileSystem.FileSystem;
      const attachment: ChatAttachment = {
        id: ChatAttachmentId.make("image"),
        type: "image",
        name: "image.png",
        mimeType: "image/png",
        sizeBytes: 3,
      };
      const path = host.resolveAttachmentPath(attachment)!;
      yield* fileSystem.writeFile(path, new Uint8Array([1, 2, 3]));
      const fake = yield* makeFakePi;
      const { runtime } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread, "default", [attachment]);
      const prompt = yield* fake.takeRequest("prompt");
      assert.include(String(prompt["message"]), path);
      assert.deepEqual(prompt["images"], [{ type: "image", data: "AQID", mimeType: "image/png" }]);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("lists unavailable attachments alongside resolvable files in the native prompt", () =>
    Effect.gen(function* () {
      const host = yield* ProviderHost.ProviderHost;
      const fake = yield* makeFakePi;
      const { runtime } = yield* openRuntime(fake).pipe(
        Effect.provideService(ProviderHost.ProviderHost, {
          ...host,
          resolveAttachmentPath: (attachment) =>
            attachment.id === "available" ? host.resolveAttachmentPath(attachment) : null,
        }),
      );
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      const attachments: ReadonlyArray<ChatAttachment> = [
        {
          id: ChatAttachmentId.make("available"),
          type: "file",
          name: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: 1,
        },
        {
          id: ChatAttachmentId.make("missing-file"),
          type: "file",
          name: "missing.txt",
          mimeType: "text/plain",
          sizeBytes: 1,
        },
        {
          id: ChatAttachmentId.make("missing-image"),
          type: "image",
          name: "missing.png",
          mimeType: "image/png",
          sizeBytes: 1,
        },
        {
          id: ChatAttachmentId.make("missing-future"),
          type: "future",
          name: "future.bin",
          mimeType: "application/octet-stream",
          sizeBytes: 1,
        },
      ];
      yield* startTurn(runtime, providerThread, "default", attachments);
      const prompt = yield* fake.takeRequest("prompt");
      assert.isString(prompt["message"]);
      const message = String(prompt["message"]);
      assert.include(message, host.resolveAttachmentPath(attachments[0]!)!);
      for (const attachment of attachments.slice(1)) {
        assert.include(message, attachment.name);
        assert.include(message, attachment.id);
      }
      assert.equal((message.match(/unavailable/g) ?? []).length, 3);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect.each([false, true])(
    "completes a resumed user turn before native wake events arrive, Pi streaming=%s",
    (streaming) =>
      Effect.gen(function* () {
        const fake = yield* makeFakePi;
        const { runtime, takeEvent } = yield* openRuntime(fake);
        const providerThread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });
        fake.setStreaming(streaming);
        yield* runtime.resumeThread({ providerThread });
        yield* startTurn(runtime, providerThread);
        yield* fake.takeRequest("prompt");
        yield* fake.emit({ type: "agent_start" });
        yield* fake.emit({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Resumed prompt completed" }],
            stopReason: "stop",
          },
        });
        fake.queueState({ isStreaming: false });
        yield* fake.emit({ type: "agent_settled" });
        const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
        assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "completed");
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect.each([false, true])(
    "serializes rollback fork hooks with native wake ownership, wake=%s",
    (nativeWake) =>
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
        fake.deferNextLifecycle("fork");
        const rollingBack = yield* runtime
          .rollbackThread({
            providerThread,
            target: {
              type: "thread_start",
              checkpointId: CheckpointId.make("checkpoint-start"),
              appRunOrdinal: 0,
            },
            providerThreadTurns: [
              {
                id: ProviderTurnId.make("previous-turn"),
                providerThreadId: providerThread.id,
                nodeId: NodeId.make("previous-node"),
                runAttemptId: null,
                nativeTurnRef: {
                  driver: PI_PROVIDER,
                  nativeId: "user-before-wake",
                  strength: "strong",
                },
                ordinal: 1,
                status: "completed",
                startedAt: providerThread.createdAt,
                completedAt: providerThread.createdAt,
              },
            ],
          })
          .pipe(Effect.result, Effect.forkScoped);
        const fork = yield* fake.takeRequest("fork");
        const overlappingTurn = yield* startTurn(runtime, providerThread).pipe(Effect.result);
        assert.equal(overlappingTurn._tag, "Failure");
        const overlappingRegistration = yield* runtime
          .ensureThread({
            threadId: THREAD_ID,
            modelSelection: modelSelection("default"),
            runtimePolicy,
          })
          .pipe(Effect.result);
        assert.equal(overlappingRegistration._tag, "Failure");
        yield* fake.emit({
          type: "extension_ui_request",
          id: "fork-hook-dialog",
          method: "confirm",
          title: "Restore this branch?",
        });
        const forkDialog = yield* takeEvent((event) => event.type === "runtime_request.updated");
        assert.isTrue(forkDialog.type === "runtime_request.updated");
        if (forkDialog.type !== "runtime_request.updated") return;
        assert.isNull(forkDialog.runtimeRequest.providerTurnId);
        yield* runtime.respondToRuntimeRequest({
          requestId: forkDialog.runtimeRequest.id,
          decision: "accept",
        });
        yield* fake.takeRequest("extension_ui_response");
        if (nativeWake) {
          yield* fake.emit({ type: "agent_start" });
          yield* fake.emit({ type: "message_start", message: { role: "assistant" } });
          yield* fake.emit({
            type: "message_update",
            assistantMessageEvent: {
              type: "text_end",
              contentIndex: 0,
              content: "Discarded branch wake output",
            },
          });
          yield* fake.emit({ type: "agent_settled" });
          const retired = yield* takeEvent(
            (event) =>
              event.type === "provider_session.updated" &&
              event.providerSession.status === "stopped",
          ).pipe(Effect.as(true), Effect.raceFirst(Queue.take(offers).pipe(Effect.as(false))));
          assert.isTrue(retired, "Pi offered native work while rollback was changing its binding");
          const result = yield* Fiber.join(rollingBack);
          assert.equal(result._tag, "Failure");
          assert.isFalse(yield* runtime.hasPendingBackgroundWork!);
          const staleTurn = yield* startTurn(
            runtime,
            providerThread,
            "default",
            [],
            "Synthetic wake",
            undefined,
            1,
            THREAD_ID,
            true,
          ).pipe(Effect.result);
          assert.equal(staleTurn._tag, "Failure");
          assert.isFalse(fake.allRequests().some((request) => request["type"] === "prompt"));
          return;
        }
        fake.queueState({ sessionFile: "/fake/rolled-back-session.jsonl" });
        yield* fake.emit({
          type: "response",
          id: fork["id"],
          command: "fork",
          success: true,
          data: { cancelled: false },
        });
        const result = yield* Fiber.join(rollingBack);
        assert.equal(result._tag, "Success");
        if (result._tag !== "Success") return;
        assert.equal(
          result.success.providerThread.nativeThreadRef?.nativeId,
          "/fake/rolled-back-session.jsonl",
        );
        yield* startTurn(runtime, result.success.providerThread);
        const prompt = yield* fake.takeRequest("prompt");
        assert.equal(prompt["message"], "Hello pi");
        yield* fake.emit({ type: "response", command: "prompt", success: true });
        yield* fake.emit({ type: "agent_start" });
        yield* fake.emit({ type: "agent_settled" });
        const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
        assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "completed");
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect.each([false, true])(
    "retains native wake ownership and delivers a joining prompt held through compaction, aborted=%s",
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
        yield* fake.takeRequest("get_state");
        yield* fake.emit({ type: "agent_start" });
        yield* Queue.take(offers);
        yield* fake.emit({ type: "agent_settled" });
        yield* fake.emit({ type: "compaction_start", reason: "manual" });
        yield* startTurn(runtime, providerThread);
        yield* fake.emit({
          type: "extension_ui_request",
          id: "native-compaction-dialog",
          method: "confirm",
          title: "Continue native work?",
        });
        const dialog = yield* takeEvent((event) => event.type === "runtime_request.updated");
        assert.isTrue(dialog.type === "runtime_request.updated");
        if (dialog.type !== "runtime_request.updated") return;
        assert.isNotNull(dialog.runtimeRequest.providerTurnId);
        yield* runtime.respondToRuntimeRequest({
          requestId: dialog.runtimeRequest.id,
          decision: "accept",
        });
        yield* fake.takeRequest("extension_ui_response");
        assert.isFalse(fake.allRequests().some((request) => request["type"] === "prompt"));
        yield* fake.emit(
          aborted
            ? { type: "compaction_end", result: null, aborted: true }
            : {
                type: "compaction_end",
                result: { summary: "Native compaction finished" },
                willRetry: true,
              },
        );
        const prompt = yield* fake.takeRequest("prompt");
        assert.equal(prompt["message"], "Hello pi");
        fake.queueState({ isStreaming: true });
        yield* fake.emit({ type: "response", command: "prompt", success: true });
        yield* fake.takeRequest("get_state");
        yield* fake.emit({ type: "agent_start" });
        yield* fake.emit({ type: "message_start", message: { role: "assistant" } });
        yield* fake.emit({
          type: "message_update",
          assistantMessageEvent: {
            type: "text_end",
            contentIndex: 0,
            content: "Native work completed",
          },
        });
        const message = yield* takeEvent((event) => event.type === "message.updated");
        assert.isTrue(message.type === "message.updated" && message.message.runId !== null);
        yield* fake.emit({ type: "agent_settled" });
        const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
        assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "completed");
        assert.equal(
          fake.allRequests().filter((request) => request["type"] === "prompt").length,
          1,
        );
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("rejects rollback while native wake output is awaiting ownership", () =>
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
      yield* fake.emit({ type: "message_start", message: { role: "assistant" } });
      yield* fake.emit({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_end",
          contentIndex: 0,
          content: "Current branch wake output",
        },
      });
      yield* fake.emit({ type: "agent_settled" });
      yield* takeEvent(
        (event) =>
          event.type === "provider_session.updated" && event.providerSession.status === "ready",
      );
      const rolledBack = yield* runtime
        .rollbackThread({
          providerThread,
          target: {
            type: "thread_start",
            checkpointId: CheckpointId.make("checkpoint-start"),
            appRunOrdinal: 0,
          },
          providerThreadTurns: [
            {
              id: ProviderTurnId.make("previous-turn"),
              providerThreadId: providerThread.id,
              nodeId: NodeId.make("previous-node"),
              runAttemptId: null,
              nativeTurnRef: {
                driver: PI_PROVIDER,
                nativeId: "user-before-wake",
                strength: "strong",
              },
              ordinal: 1,
              status: "completed",
              startedAt: providerThread.createdAt,
              completedAt: providerThread.createdAt,
            },
          ],
        })
        .pipe(Effect.result);
      assert.equal(
        rolledBack._tag,
        "Failure",
        "Rollback changed the native session while its wake was still buffered",
      );
      assert.isFalse(fake.allRequests().some((request) => request["type"] === "fork"));
      assert.isTrue(yield* runtime.hasPendingBackgroundWork!);
      yield* startTurn(
        runtime,
        providerThread,
        "default",
        [],
        "Synthetic wake",
        undefined,
        1,
        THREAD_ID,
        true,
      );
      const message = yield* takeEvent((event) => event.type === "message.updated");
      assert.equal(
        message.type === "message.updated" && message.message.text,
        "Current branch wake output",
      );
      yield* takeEvent((event) => event.type === "turn.terminal");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("answers model-selection dialogs before a user turn claims a native wake", () =>
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
        { offer: (request) => Queue.offer(offers, request).pipe(Effect.asVoid) },
      );
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* fake.emit({ type: "agent_start" });
      yield* Queue.take(offers);
      const requests: Array<
        Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "runtime_request.updated" }>
      > = [];
      fake.deferNextModelSelection();
      const starting = yield* startTurn(
        runtime,
        providerThread,
        "default",
        [],
        "Continue the review",
        modelSelection("xai/grok-4.6"),
      ).pipe(Effect.forkScoped);
      const modelRequest = yield* fake.takeRequest("set_model");
      yield* fake.emit({
        type: "extension_ui_request",
        id: "model-selection-dialog",
        method: "confirm",
        title: "Use this model?",
      });
      yield* fake.emit({ type: "agent_settled" });
      yield* takeEvent((event) => {
        if (event.type === "runtime_request.updated") requests.push(event);
        return (
          event.type === "provider_session.updated" && event.providerSession.status === "ready"
        );
      });
      const dialog = requests[0]?.runtimeRequest;
      assert.isDefined(dialog, "Pi buffered the dialog needed to finish model selection");
      assert.equal(requests[0]?.threadId, THREAD_ID);
      assert.isNull(dialog!.providerTurnId);
      yield* runtime.respondToRuntimeRequest({ requestId: dialog!.id, decision: "accept" });
      const response = yield* fake.takeRequest("extension_ui_response");
      assert.equal(response["id"], "model-selection-dialog");
      assert.isTrue(response["confirmed"]);
      yield* fake.emit({
        type: "response",
        id: modelRequest["id"],
        command: "set_model",
        success: true,
        data: { provider: "xai", id: "grok-4.6" },
      });
      yield* Fiber.join(starting);
      const prompt = yield* fake.takeRequest("prompt");
      assert.equal(prompt["message"], "Continue the review");
      assert.equal(prompt["streamingBehavior"], "steer");
      const resolved = yield* takeEvent(
        (event) =>
          event.type === "runtime_request.updated" && event.runtimeRequest.id === dialog!.id,
      );
      assert.isTrue(
        resolved.type === "runtime_request.updated" &&
          resolved.runtimeRequest.status === "resolved",
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("adopts a completed native wake without sending a synthetic prompt", () =>
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
      const offer = yield* Queue.take(offers).pipe(
        Effect.raceFirst(
          takeEvent(
            (event) =>
              event.type === "provider_session.updated" && event.providerSession.status === "error",
          ).pipe(
            Effect.andThen(Effect.sync(() => assert.fail("Pi killed a routable native wake"))),
          ),
        ),
      );
      assert.equal(offer.threadId, THREAD_ID);
      assert.equal(offer.providerThreadId, providerThread.id);
      assert.equal(offer.delivery, "adapter_buffered");
      assert.isTrue(yield* runtime.hasPendingBackgroundWork!);
      let dispatchCommitted = false;
      yield* offer.dispatchIfCurrent!(
        Effect.sync(() => {
          dispatchCommitted = true;
        }),
      );
      assert.isTrue(dispatchCommitted);
      assert.isTrue(yield* runtime.hasPendingBackgroundWork!);
      yield* fake.emit({ type: "message_start", message: { role: "assistant" } });
      yield* fake.emit({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "Background review finished",
        },
      });
      yield* fake.emit({ type: "message_end", message: { role: "assistant" } });
      yield* fake.emit({ type: "agent_settled" });
      yield* takeEvent(
        (event) =>
          event.type === "provider_session.updated" && event.providerSession.status === "ready",
      );
      assert.isTrue(yield* runtime.hasPendingBackgroundWork!);
      yield* startTurn(
        runtime,
        providerThread,
        "default",
        [],
        "Synthetic wake",
        undefined,
        1,
        THREAD_ID,
        true,
      );
      const message = yield* takeEvent((event) => event.type === "message.updated");
      assert.equal(
        message.type === "message.updated" && message.message.text,
        "Background review finished",
      );
      yield* takeEvent((event) => event.type === "turn.terminal");
      assert.equal(fake.allRequests().filter((request) => request["type"] === "prompt").length, 0);
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
});
