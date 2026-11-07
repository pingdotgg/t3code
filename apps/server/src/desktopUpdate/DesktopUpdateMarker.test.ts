import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as DesktopUpdateMarker from "./DesktopUpdateMarker.ts";

const remainingWait = (fileSystem: Partial<FileSystem.FileSystem>) =>
  DesktopUpdateMarker.DesktopUpdateMarker.use((marker) => marker.remainingWait("/marker")).pipe(
    Effect.provide(DesktopUpdateMarker.layer.pipe(Layer.provide(FileSystem.layerNoop(fileSystem)))),
  );

describe("DesktopUpdateMarker", () => {
  it.effect.each([
    ["fresh", '{"startedAt":0,"expiresAt":60000}', 0, Option.some(60000)],
    ["partly elapsed", '{"startedAt":0,"expiresAt":60000}', 8000, Option.some(52000)],
    ["shorter lifetime", '{"startedAt":0,"expiresAt":1000}', 0, Option.some(1000)],
    ["expired", '{"startedAt":0,"expiresAt":60000}', 60000, Option.none()],
    ["future", '{"startedAt":1000,"expiresAt":61000}', 0, Option.none()],
    ["long host TTL", '{"startedAt":0,"expiresAt":600000}', 0, Option.some(60000)],
    ["reversed", '{"startedAt":1000,"expiresAt":0}', 0, Option.none()],
    ["numeric strings", '{"startedAt":"0","expiresAt":"60000"}', 0, Option.none()],
    ["fractional", '{"startedAt":0,"expiresAt":1.5}', 0, Option.some(1.5)],
    ["missing fields", "{}", 0, Option.none()],
    ["expired missing start", '{"expiresAt":0}', 0, Option.none()],
    ["malformed", "not json", 0, Option.none()],
  ] as const)("%s", ([name, contents, now, expected]) =>
    Effect.gen(function* () {
      let removed = false;
      yield* TestClock.setTime(now);
      const remaining = yield* remainingWait({
        readFileString: () => Effect.succeed(contents),
        remove: () =>
          Effect.sync(() => {
            removed = true;
          }),
      });
      assert.deepStrictEqual(remaining, expected);
      assert.isFalse(removed, `${name}: the launcher must never delete the shared marker`);
    }),
  );

  it.effect("honours a marker published while it is being read", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(0);
      const remaining = yield* remainingWait({
        readFileString: () =>
          TestClock.adjust(1000).pipe(Effect.as('{"startedAt":1000,"expiresAt":61000}')),
      });
      assert.deepStrictEqual(remaining, Option.some(60000));
    }),
  );

  it.effect("missing marker and failed cleanup allow launch", () =>
    Effect.gen(function* () {
      assert.isTrue(Option.isNone(yield* remainingWait({})));
    }),
  );
});
