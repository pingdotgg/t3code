import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { makeState, runPromise, test, WEB } from "./t3.ts";

test("A blank workflow signal id is refused before the CLI opens a T3 home", WEB, async () => {
  const { stderr, entries } = await runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-unused-home-" });
      const { stderr } = yield* makeState(home).cli(
        ["workflow", "signal", "{}", "--run", "r", "--wait", "w", "--id", ""],
        [1],
      );
      return { stderr, entries: yield* fs.readDirectory(home) };
    }).pipe(Effect.scoped),
  );
  expect(stderr.trim()).toBe("--id cannot be blank.");
  expect(entries).toEqual([]);
});
