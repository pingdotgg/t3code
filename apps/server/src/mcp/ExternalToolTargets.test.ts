import { expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import { readTargets } from "./ExternalToolTargets.ts";

it.effect(
  "disables malformed or insecure target configuration and accepts fixed secure endpoints",
  () =>
    Effect.gen(function* () {
      for (const raw of [
        JSON.stringify({
          sample: { endpoint: "https://example.com/tool#fragment", operations: ["run"] },
        }),
        JSON.stringify({
          sample: { endpoint: "https://example.com/tool?token=value", operations: ["run"] },
        }),
        "",
        "{",
        "[]",
        JSON.stringify({ sample: { endpoint: "http://remote.example/tool", operations: ["run"] } }),
        JSON.stringify({
          sample: { endpoint: "https://user:password@example.com", operations: ["run"] },
        }),
      ])
        expect(
          yield* readTargets.pipe(
            Effect.provide(
              ConfigProvider.layer(
                ConfigProvider.fromEnv({ env: { T3CODE_EXTERNAL_TOOL_TARGETS: raw } }),
              ),
            ),
          ),
        ).toEqual({});
      for (const endpoint of [
        "https://example.com/tool",
        "http://127.0.0.1/tool",
        "http://[::1]/tool",
      ])
        expect(
          yield* readTargets.pipe(
            Effect.provide(
              ConfigProvider.layer(
                ConfigProvider.fromEnv({
                  env: {
                    T3CODE_EXTERNAL_TOOL_TARGETS: JSON.stringify({
                      sample: { endpoint, operations: ["run"] },
                    }),
                  },
                }),
              ),
            ),
          ),
        ).toEqual({ sample: { endpoint, operations: ["run"] } });
      expect(
        yield* readTargets.pipe(
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
        ),
      ).toEqual({});
    }),
);
