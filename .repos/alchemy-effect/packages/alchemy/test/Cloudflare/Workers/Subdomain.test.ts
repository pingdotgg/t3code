import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as workers from "@distilled.cloud/cloudflare/workers";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// IMPORTANT: the workers.dev subdomain is account-global state — renaming it
// changes the URL of EVERY deployed Worker on the account. This suite is
// strictly READ-ONLY: it only ever deploys the resource pinned to the name
// the account already has, so reconcile and destroy both observe "already
// converged" and never issue a PUT/DELETE.

// Freshly-minted scoped API tokens propagate eventually-consistently across
// Cloudflare's edge — ride out intermittent 403s on the test's own
// out-of-band calls by retrying the typed `Forbidden` error.
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const getLiveSubdomain = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  return yield* workers.getSubdomain({ accountId }).pipe(
    Effect.map((r) => r.subdomain),
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );
});

test.provider(
  "adopts the account's existing workers.dev subdomain without mutating it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Observe the account's live subdomain out-of-band. The test account
      // always has one registered (every workers.dev deployment relies on
      // it) — getSubdomain fails with the typed SubdomainNotFound otherwise,
      // which would rightly fail this test.
      const liveBefore = yield* getLiveSubdomain;
      expect(liveBefore.length).toBeGreaterThan(0);

      // Deploy pinned to the EXISTING name — reconcile observes
      // observed === news.subdomain and never issues a PUT.
      const sub = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Workers.Subdomain("Subdomain", {
            subdomain: liveBefore,
          });
        }),
      );

      expect(sub.subdomain).toEqual(liveBefore);
      // The pre-management name was captured for restore-on-destroy.
      expect(sub.initialSubdomain).toEqual(liveBefore);

      // Re-deploy unchanged — still converged, still no mutation.
      const again = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Workers.Subdomain("Subdomain", {
            subdomain: liveBefore,
          });
        }),
      );
      expect(again.subdomain).toEqual(liveBefore);
      expect(again.initialSubdomain).toEqual(liveBefore);

      // Destroy — observed already equals initialSubdomain, so restore is
      // a no-op and the account's subdomain is untouched.
      yield* stack.destroy();

      const liveAfter = yield* getLiveSubdomain;
      expect(liveAfter).toEqual(liveBefore);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// Canonical `list()` test (account-scoped singleton): the workers.dev
// subdomain is account-global with only a `get`, so `list()` returns a
// one-element array mirroring `read` when the account has a subdomain, or
// `[]` when it doesn't. The test account always has one registered, so we
// assert the result is a single element matching the live subdomain. This is
// strictly read-only and never mutates the account's subdomain.
test.provider(
  "list returns the account's workers.dev subdomain singleton",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const liveBefore = yield* getLiveSubdomain;
      expect(liveBefore.length).toBeGreaterThan(0);

      const provider = yield* Provider.findProvider(
        Cloudflare.Workers.Subdomain,
      );
      const all = yield* provider.list();

      expect(all.length).toEqual(1);
      expect(all[0].subdomain).toEqual(liveBefore);
      expect(all[0].initialSubdomain).toEqual(liveBefore);
      expect(typeof all[0].accountId).toEqual("string");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
