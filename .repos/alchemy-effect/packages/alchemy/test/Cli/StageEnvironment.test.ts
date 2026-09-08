import { stage } from "@/Cli/commands/_shared.ts";
import { PlatformServices } from "@/Util/PlatformServices.ts";
import { describe, expect, test } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const TestEnv = Layer.mergeAll(
  PlatformServices,
  ConfigProvider.layer(
    ConfigProvider.fromEnv({ env: { STAGE: "production", USER: "name" } }),
  ),
);

describe("STAGE environment variable", () => {
  test.effect("takes precedence over the user default", () =>
    Effect.gen(function* () {
      const [, selected] = yield* stage.parse({ arguments: [], flags: {} });

      expect(selected).toBe("production");
    }).pipe(Effect.provide(TestEnv)),
  );

  test.effect("yields to an explicit --stage flag", () =>
    Effect.gen(function* () {
      const [, selected] = yield* stage.parse({
        arguments: [],
        flags: { stage: ["preview"] },
      });

      expect(selected).toBe("preview");
    }).pipe(Effect.provide(TestEnv)),
  );
});
