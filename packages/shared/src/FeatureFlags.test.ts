import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as FeatureFlags from "./FeatureFlags.ts";

it.effect("resolves T3CODE_FEATURE_FLAGS lists", () =>
  Effect.gen(function* () {
    const cases: ReadonlyArray<
      readonly [string | undefined, Partial<FeatureFlags.FeatureFlagValues>]
    > = [
      [undefined, {}],
      [" tanstack_source , secret_providers=1 ", { tanstackSource: true, secretProviders: true }],
      [
        "tanstack_source=0,github_app_client_id=Iv23=x",
        { githubAppClientId: Option.some("Iv23=x") },
      ],
      ["tanstack_source,typo_flag", { tanstackSource: true }],
      // One bad value turns every flag off rather than failing startup.
      ["tanstack_source,secret_providers=maybe", {}],
    ];
    for (const [list, expected] of cases) {
      assert.deepStrictEqual(yield* FeatureFlags.resolve(list), {
        secretProviders: false,
        tanstackSource: false,
        githubAppClientId: Option.none(),
        ...expected,
      });
    }
  }),
);
