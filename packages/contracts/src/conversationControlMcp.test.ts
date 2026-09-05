import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { ConversationConfigureInput } from "./conversationControlMcp.ts";

const decodeConfigureInput = Schema.decodeUnknownEffect(ConversationConfigureInput);

it.effect("keeps omitted and explicitly empty model options distinct", () =>
  Effect.gen(function* () {
    const preserved = yield* decodeConfigureInput({ model: "gpt-5.6-sol" });
    const cleared = yield* decodeConfigureInput({ options: [] });

    expect(preserved.options).toBeUndefined();
    expect(cleared.options).toEqual([]);
  }),
);

it.effect("rejects empty updates and malformed Unicode request keys", () =>
  Effect.gen(function* () {
    const empty = yield* Effect.result(decodeConfigureInput({}));
    const malformed = yield* Effect.result(
      decodeConfigureInput({ runtimeMode: "approval-required", clientRequestId: "retry-\ud800" }),
    );

    expect(Result.isFailure(empty)).toBe(true);
    expect(Result.isFailure(malformed)).toBe(true);
  }),
);
