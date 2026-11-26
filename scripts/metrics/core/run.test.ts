import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";

import { runAbRounds } from "./run.ts";

describe("runAbRounds", () => {
  effectIt.effect("keeps the runs that finished when a later run fails", () =>
    Effect.gen(function* () {
      const files: Record<0 | 1, ReadonlyArray<string>> = { 0: [], 1: [] };
      const failure = yield* Effect.flip(
        runAbRounds({
          rounds: 3,
          outDir: "out",
          runSide: (side) => (side === 0 ? Effect.succeed("a1") : Effect.fail("b crashed")),
          save: (side, runs) => Effect.sync(() => (files[side] = [...runs])),
        }),
      );
      expect(failure).toBe("b crashed");
      expect(files).toEqual({ 0: ["a1"], 1: [] });
    }),
  );
});
