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

// `list()` enumerates delegations by fanning out over account-scoped BYOIP
// prefixes (the catalog `listPrefixes` endpoint is available regardless of the
// BYOIP entitlement and returns an empty array on accounts with no onboarded
// prefixes), then listing each prefix's delegations. The result is a
// well-typed `PrefixDelegationAttributes[]` — the exact shape `read`
// produces — and is empty on a non-BYOIP account.
test.provider("list enumerates prefix delegations (read-only)", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const provider = yield* Provider.findProvider(
      Cloudflare.Addressing.PrefixDelegation,
    );
    const all = yield* retryForbidden(provider.list());

    expect(Array.isArray(all)).toBe(true);
    for (const d of all) {
      expect(typeof d.delegationId).toBe("string");
      expect(typeof d.prefixId).toBe("string");
      expect(typeof d.accountId).toBe("string");
      expect(typeof d.cidr).toBe("string");
      expect(typeof d.delegatedAccountId).toBe("string");
    }

    yield* stack.destroy();
  }).pipe(logLevel),
);
