import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import {
  relayHttpResponseBodyStream,
  type RelayHttpResponseBodyEvent,
} from "./httpResponseBody.ts";

describe("relay HTTP response body", () => {
  it.effect("ends normally only for an explicit end event", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<RelayHttpResponseBodyEvent>();
      yield* Queue.offer(queue, { type: "chunk", bytes: Uint8Array.of(1, 2, 3) });
      yield* Queue.offer(queue, { type: "end" });

      const chunks = yield* Stream.runCollect(relayHttpResponseBodyStream(queue));
      expect([...chunks].map((chunk) => [...chunk])).toEqual([[1, 2, 3]]);
    }),
  );

  it.effect("fails rather than returning a truncated success body after an abort", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<RelayHttpResponseBodyEvent>();
      yield* Queue.offer(queue, { type: "chunk", bytes: Uint8Array.of(1, 2, 3) });
      yield* Queue.offer(queue, { type: "abort", reason: "connector disconnected" });

      const exit = yield* Effect.exit(Stream.runCollect(relayHttpResponseBodyStream(queue)));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toMatch(/connector disconnected/u);
      }
    }),
  );
});
