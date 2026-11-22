import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "@effect/vitest";

import { relayObservabilityConfig, relayRateLimitConfig } from "./Config.ts";

const read = <A>(config: Config.Config<A>, env: Record<string, string>) =>
  config.pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))), Effect.result);

describe("deployment switches", () => {
  // A workflow passes an unset variable as "", which must keep the upstream default.
  it.effect.each([
    ["RELAY_OBSERVABILITY", relayObservabilityConfig, "axiom", "off"],
    ["RELAY_RATE_LIMIT", relayRateLimitConfig, "cloudflare", "off"],
  ] as const)("%s", ([name, config, fallback, other]) =>
    Effect.gen(function* () {
      const value = (env: Record<string, string>) => read<string>(config, env);
      expect(yield* value({})).toEqual(expect.objectContaining({ success: fallback }));
      expect(yield* value({ [name]: "" })).toEqual(expect.objectContaining({ success: fallback }));
      expect(yield* value({ [name]: ` ${other} ` })).toEqual(
        expect.objectContaining({ success: other }),
      );
      expect((yield* value({ [name]: "nope" }))._tag).toBe("Failure");
    }),
  );
});
