import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@alchemy.run/cloudflare/Zone/lookup";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as emailRouting from "@distilled.cloud/cloudflare/email-routing";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { EMAIL_ROUTING_ZONE, emailRoutingScoped } from "./scope.ts";
const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const zoneName = process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

const resolveZoneId = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const zone = yield* findZoneByName({ accountId, name: zoneName });
  if (!zone) {
    return yield* Effect.die(new Error(`zone "${zoneName}" not found in account`));
  }
  return zone.id;
});

// The scoped API token the test harness mints propagates eventually-
// consistently across Cloudflare's edge — a fresh token intermittently 403s.
// Ride out the blips on the test's own out-of-band calls by retrying the
// typed `Forbidden` error (part of each email-routing operation's error union
// via distilled patches).
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const getEmailRouting = (zoneId: string) =>
  emailRouting.getEmailRouting({ zoneId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

const setEnabled = (zoneId: string, enabled: boolean) =>
  (enabled
    ? emailRouting.enableEmailRouting({ zoneId })
    : emailRouting.disableEmailRouting({ zoneId })
  ).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

describe.sequential.skipIf(!emailRoutingScoped)(
  "EmailRouting",
  {
    tags: ["provider:cloudflare", "provider:cloudflare:email", "provider:cloudflare:zone", "live"],
  },
  () => {
    // Canonical `list()` test (zone-scoped singleton): there is no account-wide
    // API for these per-zone settings, so `list()` enumerates every zone via
    // `listAllZones` and reads the singleton in each. Assert the result is
    // non-empty and contains the standing test zone. Capture-and-restore the
    // zone's `enabled` state so the run leaves no residue.
    test.provider(
      "list enumerates email routing across all zones",
      (stack) =>
        Effect.gen(function* () {
          const zoneId = yield* resolveZoneId;

          yield* stack.destroy();

          // Capture the pre-test enabled state to restore at the end.
          const before = yield* getEmailRouting(zoneId);

          const provider = yield* Provider.findProvider(Cloudflare.Email.Routing);
          const all = yield* provider.list();

          expect(all.length).toBeGreaterThan(0);
          const entry = all.find((r) => r.zoneId === zoneId);
          expect(entry).toBeDefined();
          expect(entry!.name).toEqual(zoneName);

          // Restore the captured state.
          yield* setEnabled(zoneId, before.enabled);

          yield* stack.destroy();
        }).pipe(logLevel),
      { exclusive: EMAIL_ROUTING_ZONE },
    );

    // Subaddressing is a zone setting beside `enabled`: deploy it on, then
    // off, checking the live setting each time. Destroying the stack
    // disables routing on the zone, so capture-and-restore both settings.
    test.provider(
      "subaddressing converges in place",
      (stack) =>
        Effect.gen(function* () {
          const zoneId = yield* resolveZoneId;
          yield* stack.destroy();
          const before = yield* getEmailRouting(zoneId);

          const routing = (subaddressing?: boolean) =>
            Effect.gen(function* () {
              return yield* Cloudflare.Email.Routing("Routing", { zone: zoneId, subaddressing });
            });

          const on = yield* stack.deploy(routing(true));
          expect(on.subaddressing).toEqual(true);
          expect((yield* getEmailRouting(zoneId)).supportSubaddress).toEqual(true);

          // Unchanged, or omitted (keep the zone's setting), plans no update.
          expect((yield* stack.plan(routing(true))).resources.Routing?.action).toBe("noop");
          expect((yield* stack.plan(routing())).resources.Routing?.action).toBe("noop");
          expect((yield* stack.plan(routing(false))).resources.Routing?.action).toBe("update");

          const off = yield* stack.deploy(routing(false));
          expect(off.subaddressing).toEqual(false);
          expect((yield* getEmailRouting(zoneId)).supportSubaddress).toEqual(false);

          yield* stack.destroy();
          yield* setEnabled(zoneId, before.enabled);
          yield* emailRouting
            .edit({ zoneId, supportSubaddress: before.supportSubaddress ?? false })
            .pipe(
              Effect.retry({
                while: (e) => e._tag === "Forbidden",
                schedule: forbiddenRetrySchedule,
                times: 8,
              }),
            );
        }).pipe(logLevel),
      { exclusive: EMAIL_ROUTING_ZONE },
    );
  },
);
