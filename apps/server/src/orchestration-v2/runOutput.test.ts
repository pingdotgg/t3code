import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import { checkOutput, outputRequestProblem, rejectionText } from "./runOutput.ts";

const open = { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] };
const closed = { ...open, additionalProperties: false };

it.effect("a closed schema turns down a key it does not name, and an open one keeps it", () =>
  Effect.gen(function* () {
    const extra = '{"verdict":"merge","note":"kept"}';
    assert.deepStrictEqual(yield* checkOutput(open, extra), Result.succeed(JSON.parse(extra)));
    const rejected = yield* checkOutput(closed, extra);
    assert.isTrue(Result.isFailure(rejected));
    assert.isTrue(Result.isSuccess(yield* checkOutput(closed, '{"verdict":"merge"}')));
  }),
);

it.effect("a long rejection is cut without splitting an emoji", () =>
  Effect.gen(function* () {
    const rejected = yield* checkOutput(closed, `{"verdict":"merge","${"😀".repeat(1100)}":1}`);
    assert.isTrue(Result.isFailure(rejected));
    if (Result.isFailure(rejected)) {
      const text = rejectionText(rejected.failure);
      assert.isTrue(text.isWellFormed());
      assert.isTrue(text.endsWith("😀"));
    }
  }),
);

it("a command its provider runs itself cannot be asked for a result", () => {
  for (const text of ["/compact", "/goal Review the changes"]) {
    assert.include(outputRequestProblem(open, { text }) ?? "", "command");
  }
  assert.isNull(outputRequestProblem(open, { text: "Review the changes" }));
});
