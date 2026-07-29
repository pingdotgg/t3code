import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { OPENCODE_PROVIDER } from "./OpenCodeAdapterV2.ts";
import {
  OPENCODE_SDK_REPLAY_PROTOCOL,
  OpenCodeReplayController,
} from "./OpenCodeAdapterV2.testkit.ts";

describe("OpenCodeAdapterV2 replay testkit", () => {
  it.effect("stops an event stream when abort races with listener registration", () =>
    Effect.gen(function* () {
      let aborted = false;
      const signal = {
        get aborted() {
          return aborted;
        },
        addEventListener: () => {
          aborted = true;
        },
        removeEventListener: () => {},
      } as unknown as AbortSignal;
      const controller = new OpenCodeReplayController({
        provider: OPENCODE_PROVIDER,
        protocol: OPENCODE_SDK_REPLAY_PROTOCOL,
        version: "test",
        scenario: "abort-during-listener-registration",
        entries: [],
      });
      const iterator = controller.events(signal)[Symbol.asyncIterator]();

      const result = yield* Effect.promise(() => iterator.next()).pipe(
        Effect.timeout("100 millis"),
      );

      assert.isTrue(result.done);
    }),
  );
});
