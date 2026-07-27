import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as emailRouting from "@distilled.cloud/cloudflare/email-routing";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const zoneName =
  process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

const resolveZoneId = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const zone = yield* findZoneByName({ accountId, name: zoneName });
  if (!zone) {
    return yield* Effect.die(
      new Error(`zone "${zoneName}" not found in account`),
    );
  }
  return zone.id;
});

// The scoped API token the test harness mints propagates eventually-
// consistently across Cloudflare's edge — a fresh token intermittently 403s
// with "Unable to authenticate request". Ride out the blips on the test's
// own out-of-band calls by retrying the typed `Forbidden` error (part of
// the email-routing enable operation's error union via distilled patches).
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

// Email Routing must be enabled on the zone for rules to be created and
// visible to `list()`.
const enableRouting = (zoneId: string) =>
  emailRouting.enableEmailRouting({ zoneId, body: {} }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

describe.sequential("EmailRule", () => {
  // Canonical `list()` test (zone-scoped collection): email routing rules live
  // under `/zones/{id}/email/routing/rules` with no account-wide enumeration
  // API, so `list()` enumerates every zone via `listAllZones` and exhaustively
  // paginates each zone's rules (skipping zones without Email Routing enabled).
  // Deploy a rule on the standing test zone, then assert it appears in the
  // exhaustively-paginated result.
  test.provider(
    "list enumerates the deployed email rule across all zones",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();
        yield* enableRouting(zoneId);

        const rule = yield* stack.deploy(
          Effect.gen(function* () {
            const routing = yield* Cloudflare.Email.Routing("Routing", {
              zone: zoneName,
            });
            return yield* Cloudflare.Email.Rule("ListRule", {
              zone: { zoneId: routing.zoneId },
              name: "alchemy list test",
              matchers: [
                {
                  type: "literal",
                  field: "to",
                  value: "list@alchemy-test-2.us",
                },
              ],
              actions: [{ type: "drop" }],
            });
          }),
        );

        expect(rule.zoneId).toEqual(zoneId);
        expect(rule.ruleId).not.toEqual("");

        const provider = yield* Provider.findProvider(Cloudflare.Email.Rule);
        // The freshly-minted scoped token propagates eventually-consistently,
        // so the account-wide enumeration intermittently 401s (`Unauthorized`,
        // code 10000) or 403s (`Forbidden`). Both are transient here — ride
        // out the blip like every other out-of-band call in this suite.
        const all = yield* provider.list().pipe(
          Effect.retry({
            while: (e) => e._tag === "Forbidden" || e._tag === "Unauthorized",
            schedule: forbiddenRetrySchedule,
            times: 8,
          }),
        );

        const row = all.find((r) => r.ruleId === rule.ruleId);
        expect(row).toBeDefined();
        expect(row!.zoneId).toEqual(zoneId);
        expect(row!.name).toEqual("alchemy list test");
        expect(Array.isArray(row!.matchers)).toBe(true);
        expect(row!.actions).toEqual([{ type: "drop" }]);

        yield* stack.destroy();
      }).pipe(logLevel),
  );
});
