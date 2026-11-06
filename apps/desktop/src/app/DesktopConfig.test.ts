import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { DesktopConfig, layerTest } from "./DesktopConfig.ts";
import * as Option from "effect/Option";

it.effect("prefers OMINAX_HOME over T3LEARN_HOME", () =>
  DesktopConfig.pipe(
    Effect.provide(
      // The legacy variable remains accepted for installs that have not migrated yet.
      layerTest({
        OMINAX_HOME: "/new-home",
        T3LEARN_HOME: "/old-home",
      }),
    ),
    Effect.map((config) => assert.equal(Option.getOrNull(config.t3LearnHome), "/new-home")),
  ),
);

it.effect("uses T3LEARN_HOME when OMINAX_HOME is unset", () =>
  DesktopConfig.pipe(
    Effect.provide(layerTest({ T3LEARN_HOME: "/legacy-home" })),
    Effect.map((config) => assert.equal(Option.getOrNull(config.t3LearnHome), "/legacy-home")),
  ),
);
