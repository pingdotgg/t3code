import { adopt } from "@/AdoptPolicy";
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

// Email Security (Area 1) is an enterprise add-on AND domains can only be
// onboarded in the dashboard. The lifecycle test needs an entitled account
// plus an explicitly sacrificial onboarded domain named via env —
// **destroying the resource offboards the domain from Email Security**, so
// never point this at a production domain.
const sacrificialDomain = process.env.CLOUDFLARE_EMAIL_SECURITY_DOMAIN;

const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const findDomain = (accountId: string, domain: string) =>
  emailSecurity.listSettingDomains.items({ accountId, domain: [domain] }).pipe(
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk).find((d) => d.domain === domain)),
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

test.provider.skipIf(!sacrificialDomain)(
  "adopts an onboarded domain, patches settings in place, offboards on destroy",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const domainName = sacrificialDomain!;

      const baseline = yield* findDomain(accountId, domainName);
      expect(baseline).toBeDefined();

      yield* stack.destroy();

      // Adopt the onboarded domain — `read` reports it Unowned, so taking
      // it under management requires `adopt(true)`.
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Email.Domain("MailDomain", {
            domain: domainName,
            lookbackHops: 5,
          }).pipe(adopt(true));
        }),
      );
      expect(created.domainId).toEqual(baseline?.id);
      expect(created.domain).toEqual(domainName);
      expect(created.lookbackHops).toEqual(5);

      // Update settings in place — same physical domain.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Email.Domain("MailDomain", {
            domain: domainName,
            lookbackHops: 10,
            dropDispositions: ["MALICIOUS"],
          }).pipe(adopt(true));
        }),
      );
      expect(updated.domainId).toEqual(created.domainId);
      expect(updated.lookbackHops).toEqual(10);
      expect(updated.dropDispositions).toEqual(["MALICIOUS"]);

      // Out-of-band verification via the distilled API.
      const live = yield* findDomain(accountId, domainName);
      expect(live?.lookbackHops).toEqual(10);

      // DESTRUCTIVE: destroy offboards the domain from Email Security.
      yield* stack.destroy();

      const gone = yield* findDomain(accountId, domainName).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (d) => d === undefined,
          times: 10,
        }),
      );
      expect(gone).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// Read-only list assertion — safe to run on any account. Email Security is
// a paid add-on; on accounts without the entitlement the account-scoped
// list op rejects with EmailSecurityNotEntitled / Forbidden, which the
// provider's `list()` maps to a well-typed []. On entitled accounts every
// onboarded domain is returned in the exact `read` Attributes shape.
test.provider(
  "list enumerates Email Security domains (or [] when unentitled)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const provider = yield* Provider.findProvider(Cloudflare.Email.Domain);
      const all = yield* provider.list();
      expect(Array.isArray(all)).toBe(true);

      // When an entitled sacrificial domain is configured, it must appear in
      // the exhaustively-paginated result in the read Attributes shape.
      if (sacrificialDomain) {
        const { accountId } = yield* yield* CloudflareEnvironment;
        const baseline = yield* findDomain(accountId, sacrificialDomain);
        if (baseline) {
          expect(all.some((d) => d.domainId === baseline.id)).toBe(true);
        }
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
