import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { decodePostHogSse } from "./PostHogSse.ts";

const encoder = new TextEncoder();

describe("decodePostHogSse", () => {
  it.effect("reassembles chunked frames and preserves stream control events", () =>
    Effect.gen(function* () {
      const events = yield* Stream.make(
        encoder.encode('id: 41\nevent: message\ndata: {"type":"not'),
        encoder.encode('ification"}\n\nevent: end\ndata: {"type":"rotated"}\n\n'),
        encoder.encode('event: stream-end\ndata: {"status":"complete"}'),
      ).pipe(decodePostHogSse, Stream.runCollect);

      assert.deepStrictEqual(Array.from(events), [
        { event: "message", id: "41", data: { type: "notification" } },
        { event: "end", data: { type: "rotated" } },
        { event: "stream-end", data: { status: "complete" } },
      ]);
    }),
  );
});
