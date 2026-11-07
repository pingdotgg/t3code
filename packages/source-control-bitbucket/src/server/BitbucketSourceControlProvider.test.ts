import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as BitbucketApi from "./BitbucketApi.ts";
import * as BitbucketSourceControlProvider from "./BitbucketSourceControlProvider.ts";

it.effect(
  "looks up a branch's pull requests a full page at a time, past forks' same-named branches",
  () =>
    Effect.gen(function* () {
      const provider = yield* BitbucketSourceControlProvider.make;
      assert.deepStrictEqual(
        provider.headBranchProbe?.({
          headSelectors: ["octocat:feature", "feature"],
          state: "open",
        }),
        { headSelectors: ["feature"], limit: 50 },
      );
    }).pipe(Effect.provide(Layer.mock(BitbucketApi.BitbucketApi)({}))),
);
