import {
  EnvironmentId,
  ThreadId,
  VoiceBudDraftId,
  VoiceBudRecordingId,
  VoiceBudRequestId,
  type VoiceBudDraftTarget,
  type VoiceBudRecordingStartedEvent,
  type VoiceBudTranscriptionEvent,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { VoiceBudSessionRegistry } from "./VoiceBudSessionRegistry.ts";

const THREAD_A: VoiceBudDraftTarget = {
  _tag: "Thread",
  environmentId: EnvironmentId.make("environment-a"),
  threadId: ThreadId.make("thread-a"),
};
const THREAD_B: VoiceBudDraftTarget = {
  _tag: "Thread",
  environmentId: EnvironmentId.make("environment-b"),
  threadId: ThreadId.make("thread-b"),
};
const DRAFT_A: VoiceBudDraftTarget = {
  _tag: "Draft",
  draftId: VoiceBudDraftId.make("draft-a"),
};

const bindRecording = Effect.fn("test.bindVoiceBudRecording")(function* (
  registry: VoiceBudSessionRegistry,
  requestId: string,
  recordingId: string,
  target: VoiceBudDraftTarget,
) {
  const beginFiber = yield* registry
    .begin(VoiceBudRequestId.make(requestId), VoiceBudRecordingId.make(recordingId))
    .pipe(Effect.forkChild);
  yield* Effect.yieldNow;
  assert.isTrue(
    yield* registry.bind({
      requestId: VoiceBudRequestId.make(requestId),
      recordingId: VoiceBudRecordingId.make(recordingId),
      target,
    }),
  );
  assert.equal(yield* Fiber.join(beginFiber), "accepted");
});

describe("VoiceBudSessionRegistry", () => {
  it.effect("keeps delivery bound to the chat active when recording started", () =>
    Effect.gen(function* () {
      const started: VoiceBudRecordingStartedEvent[] = [];
      const transcriptions: VoiceBudTranscriptionEvent[] = [];
      const registry = new VoiceBudSessionRegistry({
        bindingTimeoutMs: 50,
        deliveryTimeoutMs: 50,
        onRecordingStarted: (event) => Effect.sync(() => started.push(event)).pipe(Effect.asVoid),
        onTranscription: (event) =>
          Effect.sync(() => transcriptions.push(event)).pipe(Effect.asVoid),
      });

      yield* bindRecording(registry, "start-1", "recording-1", THREAD_A);
      assert.lengthOf(started, 1);

      // A route switch changes the UI's active target, not this immutable binding.
      const currentRouteAfterSwitch = THREAD_B;
      assert.notDeepEqual(currentRouteAfterSwitch, THREAD_A);

      const completeFiber = yield* registry
        .complete(
          VoiceBudRequestId.make("complete-1"),
          VoiceBudRecordingId.make("recording-1"),
          "hello",
        )
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.deepEqual(transcriptions[0]?.target, THREAD_A);
      assert.isTrue(yield* registry.acknowledge(VoiceBudRequestId.make("complete-1"), true));
      assert.equal(yield* Fiber.join(completeFiber), "accepted");
    }),
  );

  it.effect("supports concurrent recordings with independent immutable destinations", () =>
    Effect.gen(function* () {
      const transcriptions: VoiceBudTranscriptionEvent[] = [];
      const registry = new VoiceBudSessionRegistry({
        bindingTimeoutMs: 50,
        deliveryTimeoutMs: 50,
        onRecordingStarted: () => Effect.void,
        onTranscription: (event) =>
          Effect.sync(() => transcriptions.push(event)).pipe(Effect.asVoid),
      });

      yield* bindRecording(registry, "start-a", "recording-a", THREAD_A);
      yield* bindRecording(registry, "start-b", "recording-b", DRAFT_A);

      const secondComplete = yield* registry
        .complete(
          VoiceBudRequestId.make("complete-b"),
          VoiceBudRecordingId.make("recording-b"),
          "second",
        )
        .pipe(Effect.forkChild);
      const firstComplete = yield* registry
        .complete(
          VoiceBudRequestId.make("complete-a"),
          VoiceBudRecordingId.make("recording-a"),
          "first",
        )
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.deepEqual(
        transcriptions.map((event) => event.target),
        [DRAFT_A, THREAD_A],
      );
      assert.isTrue(yield* registry.acknowledge(VoiceBudRequestId.make("complete-b"), true));
      assert.isTrue(yield* registry.acknowledge(VoiceBudRequestId.make("complete-a"), true));
      assert.deepEqual(
        [yield* Fiber.join(secondComplete), yield* Fiber.join(firstComplete)],
        ["accepted", "accepted"],
      );
    }),
  );

  it.effect("rejects duplicate starts, unknown completions, and duplicate in-flight delivery", () =>
    Effect.gen(function* () {
      const registry = new VoiceBudSessionRegistry({
        bindingTimeoutMs: 50,
        deliveryTimeoutMs: 50,
        onRecordingStarted: () => Effect.void,
        onTranscription: () => Effect.void,
      });
      yield* bindRecording(registry, "start", "recording", THREAD_A);

      assert.equal(
        yield* registry.begin(
          VoiceBudRequestId.make("start-duplicate"),
          VoiceBudRecordingId.make("recording"),
        ),
        "duplicate_recording",
      );
      assert.equal(
        yield* registry.complete(
          VoiceBudRequestId.make("unknown"),
          VoiceBudRecordingId.make("unknown"),
          "text",
        ),
        "unknown_recording",
      );

      const delivery = yield* registry
        .complete(VoiceBudRequestId.make("delivery"), VoiceBudRecordingId.make("recording"), "text")
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.equal(
        yield* registry.complete(
          VoiceBudRequestId.make("delivery-duplicate"),
          VoiceBudRecordingId.make("recording"),
          "text",
        ),
        "replay",
      );
      assert.isTrue(yield* registry.acknowledge(VoiceBudRequestId.make("delivery"), true));
      assert.equal(yield* Fiber.join(delivery), "accepted");
    }),
  );

  it.effect("consumes an ambiguous delivery so it cannot append twice", () =>
    Effect.gen(function* () {
      const registry = new VoiceBudSessionRegistry({
        bindingTimeoutMs: 50,
        deliveryTimeoutMs: 50,
        onRecordingStarted: () => Effect.void,
        onTranscription: () => Effect.void,
      });
      yield* bindRecording(registry, "start", "recording", THREAD_A);

      const delivery = yield* registry
        .complete(VoiceBudRequestId.make("delivery"), VoiceBudRecordingId.make("recording"), "text")
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(50);
      assert.equal(yield* Fiber.join(delivery), "delivery_ambiguous");
      assert.equal(
        yield* registry.complete(
          VoiceBudRequestId.make("delivery-retry"),
          VoiceBudRecordingId.make("recording"),
          "text",
        ),
        "unknown_recording",
      );
    }),
  );

  it.effect("cleans pending state when renderer notification fails", () =>
    Effect.gen(function* () {
      let failStartedNotification = true;
      const registry = new VoiceBudSessionRegistry({
        bindingTimeoutMs: 50,
        deliveryTimeoutMs: 50,
        onRecordingStarted: () =>
          failStartedNotification ? Effect.die(new Error("renderer unavailable")) : Effect.void,
        onTranscription: () => Effect.die(new Error("renderer unavailable")),
      });

      assert.equal(
        yield* registry.begin(
          VoiceBudRequestId.make("failed-start"),
          VoiceBudRecordingId.make("recording"),
        ),
        "renderer_unavailable",
      );
      failStartedNotification = false;
      yield* bindRecording(registry, "retry-start", "recording", THREAD_A);

      assert.equal(
        yield* registry.complete(
          VoiceBudRequestId.make("failed-delivery"),
          VoiceBudRecordingId.make("recording"),
          "text",
        ),
        "delivery_ambiguous",
      );
      assert.equal(
        yield* registry.complete(
          VoiceBudRequestId.make("delivery-retry"),
          VoiceBudRecordingId.make("recording"),
          "text",
        ),
        "unknown_recording",
      );
    }),
  );
});
