import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { OrchestrationDispatchCommandError } from "./orchestrationDispatch.ts";

const decodeDispatchCommandError = Schema.decodeUnknownEffect(OrchestrationDispatchCommandError);

it.effect("decodes a dispatch error after its bootstrap thread was deleted", () =>
  Effect.gen(function* () {
    const error = yield* decodeDispatchCommandError({
      _tag: "OrchestrationDispatchCommandError",
      message: "Failed to create worktree.",
      bootstrapThreadDisposition: "deleted",
    });

    assert.strictEqual(error.bootstrapThreadDisposition, "deleted");
  }),
);

it.effect("decodes a dispatch error before its bootstrap thread was created", () =>
  Effect.gen(function* () {
    const error = yield* decodeDispatchCommandError({
      _tag: "OrchestrationDispatchCommandError",
      message: "A separate worktree requires a base commit.",
      bootstrapThreadDisposition: "not-created",
    });

    assert.strictEqual(error.bootstrapThreadDisposition, "not-created");
  }),
);
