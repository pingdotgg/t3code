import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as acm from "@distilled.cloud/cloudflare/acm";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const zoneName =
  process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

// The custom origin trust store requires the Advanced Certificate Manager
// add-on (~$10/mo per zone). On the standard testing zone every call —
// including list/get — fails with the typed
// `AdvancedCertificateManagerRequired` (code 1450) error. The full CRUD
// lifecycle is gated behind an entitled zone id supplied via env.
const entitledZoneId = process.env.CLOUDFLARE_TEST_ACM_ZONE_ID;

// Checked-in, deterministic self-signed root CA fixtures (no key material).
const ROOT_CA_PEM = pathe.resolve(import.meta.dirname, "fixtures/root-ca.pem");
const ROOT_CA_2_PEM = pathe.resolve(
  import.meta.dirname,
  "fixtures/root-ca-2.pem",
);

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

// Freshly-minted scoped API tokens propagate eventually-consistently across
// Cloudflare's edge — ride out intermittent 403s via the typed `Forbidden`
// tag in each acm operation's error union.
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

/** Out-of-band read; "gone" (typed) maps to undefined. */
const getTrustStore = (zoneId: string, id: string) =>
  acm.getCustomTrustStore({ zoneId, customOriginTrustStoreId: id }).pipe(
    Effect.map((cert): acm.GetCustomTrustStoreResponse | undefined => cert),
    Effect.catchTag(
      ["CustomTrustStoreNotFound", "InvalidObjectIdentifier"],
      () => Effect.succeed(undefined),
    ),
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

test.provider(
  "surfaces the typed AdvancedCertificateManagerRequired error on unentitled zones",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;
      const fs = yield* FileSystem.FileSystem;
      const certificate = yield* fs.readFileString(ROOT_CA_PEM);

      yield* stack.destroy();

      // The standard testing zone lacks the ACM add-on — uploading a trust
      // store certificate must fail with the typed entitlement tag (1450).
      const error = yield* acm
        .createCustomTrustStore({ zoneId, certificate })
        .pipe(
          Effect.retry({
            while: (e) => e._tag === "Forbidden",
            schedule: forbiddenRetrySchedule,
            times: 8,
          }),
          Effect.flip,
        );
      expect(error._tag).toEqual("AdvancedCertificateManagerRequired");

      yield* stack.destroy();
    }).pipe(logLevel),
);

// Canonical `list()` test (zone-scoped collection): `list()` enumerates
// every zone via `listAllZones` and lists the trust store certificates in
// each, paginating exhaustively. Zones lacking the ACM add-on reject the
// route with the typed `AdvancedCertificateManagerRequired` tag, which
// `list()` skips. On a standard testing account (no entitled zones) the
// result is empty — assert the enumeration itself succeeds (an array) and
// surfaces no untyped errors.
test.provider(
  "list enumerates trust store certificates across zones",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const provider = yield* Provider.findProvider(
        Cloudflare.Acm.CustomTrustStore,
      );
      const all = yield* provider.list();

      expect(Array.isArray(all)).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
);

// On an entitled zone, `list()` must contain the deployed certificate.
test.provider.skipIf(!entitledZoneId)(
  "list includes the deployed trust store certificate on an entitled zone",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = entitledZoneId!;
      const fs = yield* FileSystem.FileSystem;
      const certificate = yield* fs.readFileString(ROOT_CA_PEM);

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Acm.CustomTrustStore("RootCa", {
            zoneId,
            certificate,
          });
        }),
      );

      const provider = yield* Provider.findProvider(
        Cloudflare.Acm.CustomTrustStore,
      );
      const all = yield* provider.list();

      expect(all.some((c) => c.id === created.id && c.zoneId === zoneId)).toBe(
        true,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!entitledZoneId)(
  "uploads a root CA, replaces it on certificate change, and deletes it",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = entitledZoneId!;
      const fs = yield* FileSystem.FileSystem;
      const certificate = yield* fs.readFileString(ROOT_CA_PEM);
      const certificate2 = yield* fs.readFileString(ROOT_CA_2_PEM);

      yield* stack.destroy();

      // Create.
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Acm.CustomTrustStore("RootCa", {
            zoneId,
            certificate,
          });
        }),
      );
      expect(created.zoneId).toEqual(zoneId);
      expect(created.id).toBeTruthy();
      expect(created.issuer).toContain("Alchemy ACM Test Root CA 1");

      // Out-of-band verification.
      const live = yield* getTrustStore(zoneId, created.id);
      expect(live).toBeDefined();

      // Changing the certificate replaces the resource — there is no
      // update API, so a new certificate id must be issued.
      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Acm.CustomTrustStore("RootCa", {
            zoneId,
            certificate: certificate2,
          });
        }),
      );
      expect(replaced.id).not.toEqual(created.id);
      expect(replaced.issuer).toContain("Alchemy ACM Test Root CA 2");

      // Destroy, then wait until the certificate is actually gone
      // (deletion is async: pending_deletion -> deleted).
      yield* stack.destroy();
      const gone = yield* getTrustStore(zoneId, replaced.id).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (cert) =>
            cert === undefined ||
            cert.status === "pending_deletion" ||
            cert.status === "deleted",
          times: 30,
        }),
      );
      expect(
        gone === undefined ||
          gone.status === "pending_deletion" ||
          gone.status === "deleted",
      ).toBe(true);
    }).pipe(logLevel),
  { timeout: 120_000 },
);
