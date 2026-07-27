import * as Cloudflare from "@/Cloudflare";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// A freshly minted scoped token propagates eventually-consistently across
// Cloudflare's edge — retry the typed `Forbidden` blips on out-of-band calls.
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const retryForbidden = <A, E extends { _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

// `list()` fans out over account BYOIP IP prefixes (the read-only catalog
// endpoint, available regardless of the BYOIP entitlement) and pages the BGP
// prefixes under each. On an account with no onboarded BYOIP prefixes the
// result is naturally an empty `BgpPrefixAttributes[]` — the exact
// shape `read` produces. This exercises the distilled wiring live on every run
// without requiring the BYOIP contract/entitlement.
test.provider("list enumerates BGP prefixes across BYOIP prefixes", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const provider = yield* Provider.findProvider(
      Cloudflare.Addressing.BgpPrefix,
    );
    const all = yield* retryForbidden(provider.list());

    expect(Array.isArray(all)).toBe(true);
    for (const p of all) {
      expect(typeof p.bgpPrefixId).toBe("string");
      expect(typeof p.prefixId).toBe("string");
      expect(typeof p.accountId).toBe("string");
      expect(typeof p.cidr).toBe("string");
      expect(typeof p.onDemand.advertised).toBe("boolean");
    }

    yield* stack.destroy();
  }).pipe(logLevel),
);
