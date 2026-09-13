import * as Alchemist from "@/Alchemist";
import { describe, expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";

describe("Alchemist runtime", () => {
  test("provides every service required by the programmatic stack API", () => {
    const deploy = Effect.gen(function* () {
      const snapshot = yield* Alchemist.Stack.plan({
        operation: "deploy",
        target: { entrypoint: "./alchemy.run.ts", stage: "prod" },
      });
      yield* Alchemist.Stack.apply(snapshot);
    });
    const runnable: Effect.Effect<void, unknown, never> = deploy.pipe(
      Effect.provide(Alchemist.layer()),
      Effect.scoped,
    );

    expect(Effect.isEffect(runnable)).toBe(true);
  });

  test("infers apply output from an explicitly supplied stack module", () => {
    type Module = {
      readonly default: Effect.Effect<{
        readonly output: { readonly url: string };
      }>;
    };

    const deploy = Effect.gen(function* () {
      const snapshot = yield* Alchemist.Stack.plan<Module>({
        operation: "deploy",
        target: { entrypoint: "./alchemy.run.ts", stage: "prod" },
      });
      const output = yield* Alchemist.Stack.apply(snapshot);
      const url: string = output.url;
      return url;
    });

    expect(Effect.isEffect(deploy)).toBe(true);
  });
});
