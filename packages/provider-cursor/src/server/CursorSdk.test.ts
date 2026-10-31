import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import * as CursorSdk from "./CursorSdk.ts";

vi.mock("./sdk.ts", () => ({ Agent: {}, createAgentPlatform: {}, SqliteLocalAgentStore: {} }));

// Shaped like the SDK's minified class: the constructor is not named after the error.
class o extends Error {
  override name = "WriteIterableClosedError";
}

// Calls the guard directly, with Vitest's own listener detached so the guard does not defer to it.
const rejectThroughGuard = (reason: unknown) =>
  Effect.gen(function* () {
    const others = process.listeners("unhandledRejection");
    yield* Layer.build(CursorSdk.layer);
    const guard = process.listeners("unhandledRejection").find((l) => !others.includes(l));
    assert.isDefined(guard);
    using exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    using _log = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const listener of others) process.off("unhandledRejection", listener);
    try {
      guard(reason, Promise.resolve());
    } finally {
      for (const listener of others) process.on("unhandledRejection", listener);
    }
    return exit.mock.calls;
  }).pipe(Effect.scoped);

describe("CursorSdk unhandled rejection guard", () => {
  it.effect("keeps the server running when the SDK writes to a closed stream", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* rejectThroughGuard(new o("WritableIterable is closed")), []);
    }),
  );

  it.effect("keeps the server running when the SDK aborts a stalled request", () =>
    Effect.gen(function* () {
      const stall = new DOMException("This operation was aborted", "AbortError");
      stall.stack = "AbortError: This operation was aborted\n    at Is.onStall (689.js:1:111536)";
      assert.deepStrictEqual(yield* rejectThroughGuard(stall), []);
    }),
  );

  it.effect("still exits on an abort that did not come from the stall detector", () =>
    Effect.gen(function* () {
      const abort = new DOMException("This operation was aborted", "AbortError");
      abort.stack = "AbortError: This operation was aborted\n    at somewhereElse (app.js:1:1)";
      assert.deepStrictEqual(yield* rejectThroughGuard(abort), [[1]]);
    }),
  );

  it.effect("still exits on an abort whose message merely mentions onStall", () =>
    Effect.gen(function* () {
      const abort = new DOMException("onStall was aborted", "AbortError");
      abort.stack = "AbortError: onStall was aborted\n    at somewhereElse (app.js:1:1)";
      assert.deepStrictEqual(yield* rejectThroughGuard(abort), [[1]]);
    }),
  );

  it.effect("still exits on other rejections", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* rejectThroughGuard(new Error("WritableIterable is closed")), [
        [1],
      ]);
    }),
  );
});
