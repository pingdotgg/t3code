import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { PiRpcError, PiRpcTimeoutError, setPiModel } from "./rpc.ts";

it.effect.each([
  new PiRpcTimeoutError({ operation: "get_available_models", timeoutMs: 30_000 }),
  new PiRpcError({ operation: "get_available_models", detail: "Discovery failed" }),
])("does not guess a model identity when discovery fails: $_tag", (failure) =>
  Effect.gen(function* () {
    let selected = false;
    const error = yield* setPiModel((record) => {
      if (record["type"] === "get_available_models") return Effect.fail(failure);
      selected = true;
      return Effect.succeed({});
    }, "demo=http://127.0.0.1:9/org/model").pipe(
      Effect.match({ onFailure: (error) => error, onSuccess: () => undefined }),
    );

    assert.strictEqual(error, failure);
    assert.isFalse(selected);
  }),
);

it.effect("rejects an invalid model catalog instead of guessing an identity", () =>
  Effect.gen(function* () {
    let selected = false;
    const error = yield* setPiModel((record) => {
      if (record["type"] !== "get_available_models") selected = true;
      return Effect.succeed({ models: null });
    }, "a/b/c").pipe(Effect.match({ onFailure: (error) => error, onSuccess: () => undefined }));

    assert.equal(error?._tag, "PiRpcError");
    assert.include(error?.message ?? "", "Invalid model catalog");
    assert.isFalse(selected);
  }),
);
