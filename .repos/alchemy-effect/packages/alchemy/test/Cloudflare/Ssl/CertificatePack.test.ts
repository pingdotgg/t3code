import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as ssl from "@distilled.cloud/cloudflare/ssl";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const zoneName =
  process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

// Ordering an advanced certificate pack requires the Advanced Certificate
// Manager subscription ($10/mo add-on per zone). The standard testing zone
// does not carry it, so the full lifecycle test below is gated behind a
// zone name supplied via env whose zone has ACM purchased.
const acmZoneName = process.env.CLOUDFLARE_TEST_ACM_ZONE_NAME;

const resolveZoneId = (name: string) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;
    const zone = yield* findZoneByName({ accountId, name });
    if (!zone) {
      return yield* Effect.die(new Error(`zone "${name}" not found`));
    }
    return zone.id;
  });

// A freshly minted scoped API token propagates eventually-consistently
// across Cloudflare's edge — retry the typed `Forbidden` blips on the
// test's own out-of-band calls.
const transientRetrySchedule = Schedule.exponential("500 millis");

const getPack = (zoneId: string, certificatePackId: string) =>
  ssl.getCertificatePack({ zoneId, certificatePackId }).pipe(
    Effect.map((pack): ssl.GetCertificatePackResponse | undefined => pack),
    Effect.catchTag("CertificatePackNotFound", () => Effect.succeed(undefined)),
    Effect.retry({
      while: (e) => e._tag === "Forbidden" || e._tag === "TooManyRequests",
      schedule: transientRetrySchedule,
      times: 8,
    }),
  );

test.provider(
  "surfaces the typed AdvancedCertificateManagerRequired error on unentitled zones",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId(zoneName);

      yield* stack.destroy();

      // The standard testing zone lacks the ACM subscription — ordering
      // must fail with the typed entitlement tag (Cloudflare code 1450).
      const result = yield* ssl
        .createCertificatePack({
          zoneId,
          type: "advanced",
          certificateAuthority: "google",
          hosts: [zoneName, `acm-probe.${zoneName}`],
          validationMethod: "txt",
          validityDays: 90,
        })
        .pipe(
          Effect.retry({
            while: (e) =>
              e._tag === "Forbidden" || e._tag === "TooManyRequests",
            schedule: transientRetrySchedule,
            times: 8,
          }),
          Effect.result,
        );

      if (Result.isSuccess(result)) {
        // Safety net: should the account ever become entitled, clean up
        // the accidental order so the probe stays side-effect free.
        yield* ssl
          .deleteCertificatePack({
            zoneId,
            certificatePackId: result.success.id,
          })
          .pipe(Effect.catchTag("CertificatePackNotFound", () => Effect.void));
      }
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toEqual(
          "AdvancedCertificateManagerRequired",
        );
      }

      yield* stack.destroy();
    }).pipe(logLevel),
);

test.provider(
  "list enumerates advanced certificate packs across zones",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // list() fans out over every zone in the account and returns the
      // exact `read` Attributes shape for each advanced pack. The standard
      // testing zone has no ACM subscription (so no advanced packs), but
      // list() must still return a well-typed, exhaustively-paginated array.
      const provider = yield* Provider.findProvider(
        Cloudflare.Ssl.CertificatePack,
      );
      const all = yield* provider.list();

      expect(Array.isArray(all)).toBe(true);
      for (const pack of all) {
        expect(typeof pack.certificatePackId).toBe("string");
        expect(typeof pack.zoneId).toBe("string");
        expect(Array.isArray(pack.hosts)).toBe(true);
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!acmZoneName)(
  "list includes a deployed advanced certificate pack",
  (stack) =>
    Effect.gen(function* () {
      const name = acmZoneName!;
      const zoneId = yield* resolveZoneId(name);
      const hosts = [name, `acmlist.${name}`];

      yield* stack.destroy();

      const pack = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Ssl.CertificatePack("ListPack", {
            zoneId,
            certificateAuthority: "google",
            hosts,
            validationMethod: "txt",
            validityDays: 90,
          });
        }),
      );

      const provider = yield* Provider.findProvider(
        Cloudflare.Ssl.CertificatePack,
      );
      const all = yield* provider.list();

      expect(
        all.some((p) => p.certificatePackId === pack.certificatePackId),
      ).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!acmZoneName)(
  "orders a pack, updates validation method in place, and deletes it",
  (stack) =>
    Effect.gen(function* () {
      const name = acmZoneName!;
      const zoneId = yield* resolveZoneId(name);
      const hosts = [name, `acmtest.${name}`];

      yield* stack.destroy();

      // Create — order the advanced pack. Issuance is async: the
      // resource returns as soon as the order is placed.
      const pack = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Ssl.CertificatePack("Pack", {
            zoneId,
            certificateAuthority: "google",
            hosts,
            validationMethod: "txt",
            validityDays: 90,
          });
        }),
      );

      expect(pack.zoneId).toEqual(zoneId);
      expect(pack.certificatePackId).toBeTruthy();
      expect([...pack.hosts].sort()).toEqual([...hosts].sort());
      expect(pack.certificateAuthority).toEqual("google");

      // Out-of-band verify via the distilled API.
      const live = yield* getPack(zoneId, pack.certificatePackId);
      expect(live?.id).toEqual(pack.certificatePackId);
      expect(live?.type).toEqual("advanced");

      // Update in place — validationMethod is mutable via the SSL
      // verification API; the pack id must not change.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Ssl.CertificatePack("Pack", {
            zoneId,
            certificateAuthority: "google",
            hosts,
            validationMethod: "http",
            validityDays: 90,
          });
        }),
      );
      expect(updated.certificatePackId).toEqual(pack.certificatePackId);

      yield* stack.destroy();

      // Wait until the pack is actually gone (deletion is async — the
      // pack may linger briefly in `pending_deletion`).
      const gone = yield* getPack(zoneId, pack.certificatePackId).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("3 seconds"),
          until: (p) => p === undefined || p.status === "deleted",
          times: 20,
        }),
      );
      expect(gone === undefined || gone.status === "deleted").toBe(true);
    }).pipe(logLevel),
  { timeout: 120_000 },
);
