import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as emailSecurity from "@distilled.cloud/cloudflare/email-security";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Email Security (Area 1) is an enterprise add-on — the standard testing
// account is not entitled (typed `EmailSecurityNotEntitled`), so the
// lifecycle test is gated behind an entitled account flagged via env.
const entitled = !!process.env.CLOUDFLARE_EMAIL_SECURITY;

const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const pattern = "alchemy-trusted.alchemy-test-2.us";

const findByPattern = (accountId: string) =>
  emailSecurity.listSettingTrustedDomains.items({ accountId, pattern }).pipe(
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk).find((p) => p.pattern === pattern)),
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

test.provider.skipIf(!entitled)(
  "create, update in place, destroy",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      // Trust a lookalike partner domain.
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Email.TrustedDomain("Trusted", {
            pattern,
            isSimilarity: true,
            comments: "v1",
          });
        }),
      );
      expect(created.trustedDomainId).toBeDefined();
      expect(created.accountId).toEqual(accountId);
      expect(created.pattern).toEqual(pattern);
      expect(created.isSimilarity).toEqual(true);
      expect(created.isRecent).toEqual(false);
      expect(created.isRegex).toEqual(false);
      expect(created.comments).toEqual("v1");

      // Out-of-band verification via the distilled API.
      const live = yield* findByPattern(accountId);
      expect(live?.id).toEqual(created.trustedDomainId);

      // Update mutable fields in place — same physical entry.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Email.TrustedDomain("Trusted", {
            pattern,
            isSimilarity: true,
            isRecent: true,
            comments: "v2",
          });
        }),
      );
      expect(updated.trustedDomainId).toEqual(created.trustedDomainId);
      expect(updated.isRecent).toEqual(true);
      expect(updated.comments).toEqual("v2");

      yield* stack.destroy();

      // The entry is gone after destroy.
      const gone = yield* findByPattern(accountId).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (p) => p === undefined,
          times: 10,
        }),
      );
      expect(gone).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// `list()` enumerates the account's trusted domains. On the standard testing
// account (not entitled) the typed `EmailSecurityNotEntitled` error is caught
// and the result is an empty array — so this assertion is meaningful without
// the add-on. On an entitled account it also asserts the deployed entry is
// present.
test.provider(
  "list enumerates trusted domains",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const provider = yield* Provider.findProvider(
        Cloudflare.Email.TrustedDomain,
      );

      if (!entitled) {
        // Unentitled account: typed entitlement error -> [].
        const all = yield* provider.list();
        expect(all).toEqual([]);
        return;
      }

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Email.TrustedDomain("ListTrusted", {
            pattern,
            isSimilarity: true,
          });
        }),
      );

      const all = yield* provider.list();
      expect(
        all.some((x) => x.trustedDomainId === deployed.trustedDomainId),
      ).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
