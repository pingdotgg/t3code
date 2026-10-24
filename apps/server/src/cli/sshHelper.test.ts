import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as TestClock from "effect/testing/TestClock";

import { updateRemaining } from "./sshHelper.ts";

describe("SSH update marker helper", () => {
  it.effect.each([
    ["fresh", '{"startedAt":0,"expiresAt":60000}', 0, "60000"],
    ["partly elapsed", '{"startedAt":0,"expiresAt":60000}', 8000, "52000"],
    ["shorter lifetime", '{"startedAt":0,"expiresAt":1000}', 0, "1000"],
    ["expired", '{"startedAt":0,"expiresAt":60000}', 60000, ""],
    ["future", '{"startedAt":1000,"expiresAt":61000}', 0, ""],
    ["long host TTL", '{"startedAt":0,"expiresAt":600000}', 0, "60000"],
    ["reversed", '{"startedAt":1000,"expiresAt":0}', 0, ""],
    ["numeric strings", '{"startedAt":"0","expiresAt":"60000"}', 0, ""],
    ["fractional", '{"startedAt":0,"expiresAt":1.5}', 0, "1.5"],
    ["missing fields", "{}", 0, ""],
    ["expired missing start", '{"expiresAt":0}', 0, ""],
    ["malformed", "not json", 0, ""],
  ] as const)("%s", ([name, contents, now, expected]) =>
    Effect.gen(function* () {
      let removed = false;
      yield* TestClock.setTime(now);
      const remaining = yield* updateRemaining("/marker").pipe(
        Effect.provide(
          FileSystem.layerNoop({
            readFileString: () => Effect.succeed(contents),
            remove: () =>
              Effect.sync(() => {
                removed = true;
              }),
          }),
        ),
      );
      assert.equal(remaining, expected);
      assert.equal(removed, ["expired", "reversed", "expired missing start"].includes(name));
    }),
  );
  it.effect("missing marker and failed cleanup allow launch", () =>
    updateRemaining("/missing").pipe(
      Effect.provide(FileSystem.layerNoop({})),
      Effect.tap((remaining) => Effect.sync(() => assert.equal(remaining, ""))),
    ),
  );
});
