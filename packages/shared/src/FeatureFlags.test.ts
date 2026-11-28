import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as FeatureFlags from "./FeatureFlags.ts";

it.effect("resolves HYAKKI_FEATURE_FLAGS lists", () =>
  Effect.gen(function* () {
    const cases: ReadonlyArray<
      readonly [string | undefined, Partial<FeatureFlags.FeatureFlagValues>]
    > = [
      [undefined, {}],
      [
        "secret_providers=false,tanstack_source=false",
        { secretProviders: false, tanstackSource: false },
      ],
      [" tanstack_source , secret_providers=1 ", { tanstackSource: true, secretProviders: true }],
      [
        "tanstack_source=0,github_app_client_id=Iv23=x",
        { tanstackSource: false, githubAppClientId: Option.some("Iv23=x") },
      ],
      ["tanstack_source,typo_flag", { tanstackSource: true }],
      ["tanstack_source,secret_providers=maybe", {}],
    ];
    for (const [list, expected] of cases) {
      assert.deepStrictEqual(yield* FeatureFlags.resolve(list), {
        secretProviders: true,
        tanstackSource: true,
        githubAppClientId: Option.none(),
        ...expected,
      });
    }
  }),
);
