import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { ConversationForkInput, ConversationTransferListInput } from "./conversationTransferMcp.ts";

const decodeFork = Schema.decodeUnknownEffect(ConversationForkInput);
const decodeList = Schema.decodeUnknownEffect(ConversationTransferListInput);

it.effect("requires an explicit stable fork source and a well-formed retry key", () =>
  Effect.gen(function* () {
    const valid = yield* decodeFork({
      sourcePoint: { type: "run", runId: "run:completed" },
      clientRequestId: "fork-completed-run",
    });
    const missingPoint = yield* Effect.result(
      decodeFork({ clientRequestId: "fork-without-point" }),
    );
    const malformedKey = yield* Effect.result(
      decodeFork({ sourcePoint: { type: "latest_stable" }, clientRequestId: "fork-\ud800" }),
    );

    expect(valid.sourcePoint).toEqual({ type: "run", runId: "run:completed" });
    expect(Result.isFailure(missingPoint)).toBe(true);
    expect(Result.isFailure(malformedKey)).toBe(true);
  }),
);

it.effect("bounds transfer result pages", () =>
  Effect.gen(function* () {
    const valid = yield* decodeList({ limit: 100 });
    const tooLarge = yield* Effect.result(decodeList({ limit: 101 }));

    expect(valid.limit).toBe(100);
    expect(Result.isFailure(tooLarge)).toBe(true);
  }),
);
