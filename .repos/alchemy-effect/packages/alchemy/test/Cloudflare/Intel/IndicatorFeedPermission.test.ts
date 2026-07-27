import * as Cloudflare from "@/Cloudflare";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// IndicatorFeedPermission is non-listable (pattern (e)): a grant is keyed by
// {feedId, accountTag} from the granting account's side, and Cloudflare
// exposes no provider-side API to enumerate a feed's grantees. The only
// related collection op (`listIndicatorFeedPermissions`, the
// `/permissions/view` endpoint) returns feeds the *calling* account can
// consume — feed metadata with no `accountTag` — which cannot reconstruct the
// `read` Attributes shape. So `list()` returns `[]` without any cloud call,
// which means this assertion runs cleanly even on the unentitled testing
// account (Intel feeds are a paid Cloudforce One add-on:
// `IndicatorFeedsNotEntitled`, HTTP 403, would gate any real feed lifecycle).
test.provider(
  "list returns [] for the non-listable IndicatorFeedPermission",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const provider = yield* Provider.findProvider(
        Cloudflare.Intel.IndicatorFeedPermission,
      );
      const all = yield* provider.list();
      expect(all).toEqual([]);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
