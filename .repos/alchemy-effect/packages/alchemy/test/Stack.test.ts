import * as Alchemy from "@/index.ts";
import { describe, expect, it } from "alchemy-test";
import type { ConfigError } from "effect/Config";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

// These tests are compile-time assertions: they verify that the
// `Alchemy.Stack` effect permits a `ConfigError` in its body without
// forcing the user to `Effect.orDie`. See
// https://github.com/alchemy-run/alchemy/issues/479
describe("Alchemy.Stack error channel", () => {
  it("allows ConfigError in the stack body", () => {
    // A stack body that reads from `effect/Config` fails with `ConfigError`.
    // Before #479 this required `Effect.orDie`; now it type-checks directly.
    const stack = Alchemy.Stack(
      "ConfigErrorStack",
      {
        providers: Layer.empty as any,
        state: Layer.empty as any,
      },
      Effect.gen(function* () {
        const value = yield* Config.string("SOME_CONFIG");
        return { value };
      }),
    );

    // The resulting effect surfaces `ConfigError` in its error channel rather
    // than `never` — the whole point of the change.
    type ErrorOf<T> = T extends Effect.Effect<any, infer E, any> ? E : never;
    const _assertError: ErrorOf<typeof stack> extends ConfigError
      ? true
      : false = true;
    expect(_assertError).toBe(true);
  });

  it("still accepts an infallible stack body", () => {
    const stack = Alchemy.Stack(
      "InfallibleStack",
      {
        providers: Layer.empty as any,
        state: Layer.empty as any,
      },
      Effect.succeed({ value: "ok" }),
    );

    expect(typeof stack).toBe("object");
  });
});
