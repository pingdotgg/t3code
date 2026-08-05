import { describe, expect, it } from "@effect/vitest";

import * as Effect from "effect/Effect";

import {
  makeProviderInstanceEnvironmentSource,
  mergeProviderInstanceEnvironment,
} from "./ProviderInstanceEnvironment.ts";

describe("mergeProviderInstanceEnvironment", () => {
  it("overrides inherited environment values and preserves empty strings", () => {
    expect(
      mergeProviderInstanceEnvironment(
        [
          { name: "OPENROUTER_API_KEY", value: "sk-or-test", sensitive: true },
          { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
        ],
        { ANTHROPIC_API_KEY: "inherited", PATH: "/bin" },
      ),
    ).toMatchObject({
      OPENROUTER_API_KEY: "sk-or-test",
      ANTHROPIC_API_KEY: "",
      PATH: "/bin",
    });
  });

  it.effect("refreshes inherited values in place while explicit overrides keep precedence", () =>
    Effect.gen(function* () {
      const baseEnv = { PATH: "C:\\baseline", PROFILE_VALUE: "host-before" };
      const source = makeProviderInstanceEnvironmentSource(
        [
          { name: "UNRELATED", value: "custom", sensitive: false },
          { name: "PROFILE_VALUE", value: "instance", sensitive: false },
        ],
        baseEnv,
      );
      const captured = source.environment;

      baseEnv.PATH = "C:\\profile";
      baseEnv.PROFILE_VALUE = "host-after";
      yield* source.refresh;

      expect(source.environment).toBe(captured);
      expect(captured).toMatchObject({
        PATH: "C:\\profile",
        PROFILE_VALUE: "instance",
        UNRELATED: "custom",
      });
    }),
  );
});
