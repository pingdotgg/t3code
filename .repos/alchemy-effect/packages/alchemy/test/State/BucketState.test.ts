import { describe, expect, test } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { makeBucketState, type BucketObjects } from "@/State/BucketState.ts";

/** A bucket held in memory, with versioned conditional writes. */
const memoryObjects = (): BucketObjects => {
  const objects = new Map<string, { text: string; version: string }>();
  let next = 0;
  return {
    listKeys: (prefix) =>
      Effect.sync(() => [...objects.keys()].filter((key) => key.startsWith(prefix))),
    listChildren: () => Effect.succeed([]),
    read: (key) => Effect.sync(() => objects.get(key)),
    write: (key, text, condition) =>
      Effect.sync(() => {
        const existing = objects.get(key);
        if (condition && "ifAbsent" in condition && existing) return undefined;
        if (condition && "ifVersion" in condition && existing?.version !== condition.ifVersion) {
          return undefined;
        }
        const version = String(++next);
        objects.set(key, { text, version });
        return version;
      }),
    delete: (key, ifVersion) =>
      Effect.sync(() => {
        if (ifVersion === undefined || objects.get(key)?.version === ifVersion) objects.delete(key);
      }),
    deleteMany: (keys) => Effect.sync(() => keys.forEach((key) => objects.delete(key))),
  };
};

describe("BucketState lease", { tags: ["unit", "local"] }, () => {
  test("names an earlier open build in the same process as the holder", async () => {
    const objects = Effect.succeed(memoryObjects());
    const open = makeBucketState({ id: "memory", label: "memory", objects });
    const request = { stack: "app", stage: "prod" };

    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* open;
        const second = yield* open;
        yield* first.list(request);
        return yield* Effect.exit(second.list(request));
      }).pipe(Effect.scoped),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(String(Exit.isFailure(exit) ? exit.cause : "")).toContain(
      "another deploy holds the memory state lock 'app/prod': this process holds it",
    );
  });
});
