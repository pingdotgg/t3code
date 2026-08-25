import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as dns from "@distilled.cloud/cloudflare/dns";
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
// consistently across Cloudflare's edge — a fresh token intermittently 403s.
// Ride out the blips on the test's own out-of-band calls by retrying the
// typed `Forbidden` error (part of each op's error union via distilled
// patches).
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const getDnssec = (zoneId: string) =>
  dns.getDnssec({ zoneId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

/** Collapse the live five-state status into its desired-state family. */
const family = (status: string | null | undefined): "active" | "disabled" =>
  status === "active" || status === "pending" ? "active" : "disabled";

// Normalize the zone to a known baseline (DNSSEC off) so each run starts
// from the same cloud state regardless of what a previous (possibly
// interrupted) run left behind. Only deactivates when needed so re-runs
// don't trip "already disabled" API validation.
const normalizeDisabled = (zoneId: string) =>
  Effect.gen(function* () {
    const observed = yield* getDnssec(zoneId);
    if (family(observed.status) === "disabled") return;
    // DELETE /dnssec only clears records after signing is already off —
    // deactivation goes through PATCH status:"disabled".
    yield* dns.patchDnssec({ zoneId, status: "disabled" }).pipe(
      Effect.retry({
        while: (e) => e._tag === "Forbidden",
        schedule: forbiddenRetrySchedule,
        times: 8,
      }),
    );
    // Deactivation is eventually consistent — wait (bounded) for the zone
    // to leave the active family before deploying on top of it.
    yield* getDnssec(zoneId).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (o) => family(o.status) === "disabled",
        times: 15,
      }),
    );
  });

// Both cases mutate the same zone-level DNSSEC singleton with opposite desired states; run them serially so they don't corrupt each other's captured baseline under the global concurrent test config.
describe.sequential("Dnssec", () => {
  test.provider(
    "enables DNSSEC, captures the disabled baseline, destroy deactivates",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();
        yield* normalizeDisabled(zoneId);

        const dnssec = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.DNS.Dnssec("ZoneDnssec", { zoneId });
          }),
        );

        expect(dnssec.zoneId).toEqual(zoneId);
        // No DS record at the registrar, so the zone sits at `pending` —
        // that's the active family as far as Cloudflare's side goes.
        expect(family(dnssec.status)).toEqual("active");
        // The pre-management state was captured for restore-on-destroy.
        expect(dnssec.initialStatus).toEqual("disabled");
        // The DS record string is what users paste at their registrar.
        expect(dnssec.ds).toBeTypeOf("string");
        expect(dnssec.ds!.length).toBeGreaterThan(0);

        // Out-of-band verify via the SDK.
        const live = yield* getDnssec(zoneId);
        expect(family(live.status)).toEqual("active");

        yield* stack.destroy();

        // The zone was disabled before we managed it, so destroy deactivates.
        // Deactivation is eventually consistent — typed bounded wait.
        const restored = yield* getDnssec(zoneId).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            until: (o) => family(o.status) === "disabled",
            times: 15,
          }),
        );
        expect(family(restored.status)).toEqual("disabled");

        // Re-running destroy is idempotent (DNSSEC already off).
        yield* stack.destroy();
        const still = yield* getDnssec(zoneId);
        expect(family(still.status)).toEqual("disabled");
      }).pipe(logLevel),
    { timeout: 300_000 },
  );

  test.provider(
    "updates status in place — same zone singleton, no replacement",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();
        yield* normalizeDisabled(zoneId);

        const enabled = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.DNS.Dnssec("ZoneDnssec", {
              zoneId,
              status: "active",
            });
          }),
        );
        expect(family(enabled.status)).toEqual("active");
        expect(enabled.initialStatus).toEqual("disabled");

        // Flip the desired status in place — `zoneId` (the identity) is
        // unchanged, so this patches the same singleton rather than
        // replacing it.
        const disabled = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.DNS.Dnssec("ZoneDnssec", {
              zoneId,
              status: "disabled",
            });
          }),
        );
        expect(disabled.zoneId).toEqual(zoneId);
        expect(family(disabled.status)).toEqual("disabled");
        // The captured baseline survives the in-place update.
        expect(disabled.initialStatus).toEqual("disabled");

        const live = yield* getDnssec(zoneId);
        expect(family(live.status)).toEqual("disabled");

        // Destroy is a no-op here (baseline disabled, currently disabled).
        yield* stack.destroy();
        const after = yield* getDnssec(zoneId);
        expect(family(after.status)).toEqual("disabled");
      }).pipe(logLevel),
    { timeout: 300_000 },
  );

  // Canonical `list()` test (zone-scoped singleton): there is no account-wide
  // API for per-zone DNSSEC, so `list()` enumerates every zone via
  // `listAllZones` and reads each one's config, skipping disabled zones
  // (which `read` treats as "not created"). Enable DNSSEC on the test zone
  // so it appears in the result, assert it's present, then restore.
  test.provider(
    "list enumerates active DNSSEC across zones",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();
        yield* normalizeDisabled(zoneId);

        yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.DNS.Dnssec("ZoneDnssec", { zoneId });
          }),
        );

        const provider = yield* Provider.findProvider(Cloudflare.DNS.Dnssec);
        const all = yield* provider.list();

        expect(all.length).toBeGreaterThan(0);
        expect(all.some((d) => d.zoneId === zoneId)).toBe(true);

        yield* stack.destroy();
        // Restore the disabled baseline (eventually consistent).
        const restored = yield* getDnssec(zoneId).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            until: (o) => family(o.status) === "disabled",
            times: 15,
          }),
        );
        expect(family(restored.status)).toEqual("disabled");
      }).pipe(logLevel),
    { timeout: 300_000 },
  );
});
