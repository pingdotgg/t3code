import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { makeBoundedFileReader } from "./boundedFileRead.ts";

const deferred = () => {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("makeBoundedFileReader", () => {
  it.live("issues no further native reads while one is stuck past the timeout", () =>
    Effect.gen(function* () {
      const stuck = deferred();
      const paths: Array<string> = [];
      const readFile = makeBoundedFileReader((filePath) => {
        paths.push(filePath);
        return stuck.promise;
      }, "100 millis");

      const results = [];
      for (let attempt = 0; attempt < 6; attempt++) {
        results.push(yield* readFile(`/blocked/${attempt}`));
      }

      expect(results).toEqual(results.map(() => Option.none()));
      expect(paths).toEqual(["/blocked/0"]);
    }),
  );

  it.live("reads again once the stuck read returns", () =>
    Effect.gen(function* () {
      const stuck = deferred();
      let calls = 0;
      const readFile = makeBoundedFileReader((filePath) => {
        calls += 1;
        return calls === 1 ? stuck.promise : Promise.resolve(filePath);
      }, "100 millis");

      expect(yield* readFile("/blocked")).toEqual(Option.none());
      stuck.resolve("late");
      yield* Effect.promise(() => stuck.promise);
      yield* Effect.yieldNow;

      expect(yield* readFile("/next")).toEqual(Option.some("/next"));
      expect(calls).toBe(2);
    }),
  );

  it.live("serializes concurrent reads instead of dropping them", () =>
    Effect.gen(function* () {
      const first = deferred();
      const readFile = makeBoundedFileReader(
        (filePath) => (filePath === "/first" ? first.promise : Promise.resolve(filePath)),
        "1 second",
      );

      const results = yield* Effect.all(
        [
          readFile("/first"),
          readFile("/second"),
          Effect.sleep("20 millis").pipe(Effect.andThen(Effect.sync(() => first.resolve("one")))),
        ],
        { concurrency: "unbounded" },
      );

      expect(results.slice(0, 2)).toEqual([Option.some("one"), Option.some("/second")]);
    }),
  );

  it.live("reports a rejected read as none", () =>
    Effect.gen(function* () {
      const readFile = makeBoundedFileReader(
        () => Promise.reject(new Error("EACCES")),
        "100 millis",
      );
      expect(yield* readFile("/denied")).toEqual(Option.none());
    }),
  );
});
