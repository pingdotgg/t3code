import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";

import { awaitDetachedSpawn } from "./windowsVerbatimSpawn.ts";

it.effect("reports a synchronous spawn exception as a failure", () =>
  Effect.gen(function* () {
    const error = new Error("invalid spawn options");
    const result = yield* awaitDetachedSpawn(() => {
      throw error;
    }).pipe(Effect.result);
    expect(result).toMatchObject({ _tag: "Failure", failure: error });
  }),
);
