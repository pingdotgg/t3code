import {
  VoiceBudDraftId,
  VoiceBudRecordingId,
  VoiceBudRequestId,
  type VoiceBudRecordingStartedEvent,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { makeVoiceBudRegistryOperations } from "./VoiceBudBridge.ts";
import { VoiceBudSessionRegistry } from "./VoiceBudSessionRegistry.ts";

describe("VoiceBudBridge registry operations", () => {
  it.effect("preserves the registry receiver when binding through the bridge service", () =>
    Effect.gen(function* () {
      const started: VoiceBudRecordingStartedEvent[] = [];
      const registry = new VoiceBudSessionRegistry({
        bindingTimeoutMs: 50,
        onRecordingStarted: (event) => Effect.sync(() => started.push(event)).pipe(Effect.asVoid),
        onTranscription: () => Effect.void,
      });
      const operations = makeVoiceBudRegistryOperations(registry);
      const requestId = VoiceBudRequestId.make("request");
      const recordingId = VoiceBudRecordingId.make("recording");

      const beginFiber = yield* registry.begin(requestId, recordingId).pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      assert.lengthOf(started, 1);
      assert.isTrue(
        yield* operations.bindRecording({
          requestId,
          recordingId,
          target: {
            _tag: "Draft",
            draftId: VoiceBudDraftId.make("draft"),
          },
        }),
      );
      assert.equal(yield* Fiber.join(beginFiber), "accepted");
    }),
  );
});
