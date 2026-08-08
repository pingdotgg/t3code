import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as customCertificates from "@distilled.cloud/cloudflare/custom-certificates";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const zoneName =
  process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

// Custom (BYO) edge certificates are a Business/Enterprise feature. On the
// testing account's zone every custom_certificates call fails with
// "Plan level does not allow custom certificates ..." (Cloudflare error
// code 1011), surfaced as the typed `PlanLevelNotAllowed` error. The full
// lifecycle test below is gated behind an entitled zone id supplied via env.
const entitledZoneId = process.env.CLOUDFLARE_TEST_CUSTOM_CERT_ZONE_ID;

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

// Checked-in self-signed PEM fixtures (CN=alchemy-test-2.us, 10y validity).
// The upload API accepts self-signed certificates — validation only requires
// that the key matches the certificate — keeping the test hermetic.
const readFixture = (name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fs.readFileString(
      path.join(import.meta.dirname, "fixtures", name),
    );
  });

// A freshly minted scoped token propagates eventually-consistently across
// Cloudflare's edge; ride out 403 blips on out-of-band verification calls.
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const getCertificate = (zoneId: string, customCertificateId: string) =>
  customCertificates.getCustomCertificate({ zoneId, customCertificateId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

test.provider(
  "surfaces the typed PlanLevelNotAllowed error on unentitled zones",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;
      const certificate = yield* readFixture("cert1.pem");
      const privateKey = yield* readFixture("key1.pem");

      yield* stack.destroy();

      // The standard testing zone is not on a Business/Enterprise plan —
      // the distilled call must fail with the typed entitlement tag.
      const error = yield* customCertificates
        .createCustomCertificate({
          zoneId,
          certificate,
          privateKey,
          type: "sni_custom",
        })
        .pipe(
          Effect.retry({
            while: (e) => e._tag === "Forbidden",
            schedule: forbiddenRetrySchedule,
            times: 8,
          }),
          Effect.flip,
        );
      expect(error._tag).toEqual("PlanLevelNotAllowed");

      yield* stack.destroy();
    }).pipe(logLevel),
);

// `list()` fans out over every zone in the account, paginates each zone's
// custom certificates, and skips plan-gated zones via the typed
// `PlanLevelNotAllowed`/`Forbidden` tags. On the testing account (no
// Business/Enterprise zones) every zone is skipped, so the call must still
// succeed and return a well-typed array (empty here) rather than throwing.
test.provider(
  "list enumerates custom certificates across zones",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const provider = yield* Provider.findProvider(
        Cloudflare.CustomCertificate.CustomCertificate,
      );
      const all = yield* provider.list();

      expect(Array.isArray(all)).toBe(true);
      // Every item carries the full read Attributes shape.
      for (const cert of all) {
        expect(typeof cert.certificateId).toBe("string");
        expect(typeof cert.zoneId).toBe("string");
      }

      // On an entitled zone, the certificate we deploy must appear in the
      // exhaustively-paginated result.
      if (entitledZoneId) {
        const cert1 = yield* readFixture("cert1.pem");
        const key1 = yield* readFixture("key1.pem");
        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.CustomCertificate.CustomCertificate(
              "ListEdgeCert",
              {
                zoneId: entitledZoneId,
                certificate: cert1,
                privateKey: Redacted.make(key1),
                type: "sni_custom",
                bundleMethod: "force",
              },
            );
          }),
        );
        const after = yield* provider.list();
        expect(
          after.some((c) => c.certificateId === deployed.certificateId),
        ).toBe(true);
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!entitledZoneId)(
  "uploads, rotates in place, replaces on type change, and deletes",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = entitledZoneId!;
      const cert1 = yield* readFixture("cert1.pem");
      const key1 = yield* readFixture("key1.pem");
      const cert2 = yield* readFixture("cert2.pem");
      const key2 = yield* readFixture("key2.pem");

      yield* stack.destroy();

      // Create — upload the first certificate/key pair.
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.CustomCertificate.CustomCertificate(
            "EdgeCert",
            {
              zoneId,
              certificate: cert1,
              privateKey: Redacted.make(key1),
              type: "sni_custom",
              bundleMethod: "force",
            },
          );
        }),
      );

      expect(created.certificateId).toBeDefined();
      expect(created.zoneId).toEqual(zoneId);
      expect(created.type).toEqual("sni_custom");
      expect(created.hosts).toContain("alchemy-test-2.us");
      expect(created.contentHash).toHaveLength(64);

      // Out-of-band verification via the distilled API.
      const live = yield* getCertificate(zoneId, created.certificateId);
      expect(live.id).toEqual(created.certificateId);

      // Rotate in place — a new cert/key pair PATCHes the same id.
      const rotated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.CustomCertificate.CustomCertificate(
            "EdgeCert",
            {
              zoneId,
              certificate: cert2,
              privateKey: Redacted.make(key2),
              type: "sni_custom",
              bundleMethod: "force",
            },
          );
        }),
      );
      expect(rotated.certificateId).toEqual(created.certificateId);
      expect(rotated.contentHash).not.toEqual(created.contentHash);
      // cert2 has a different validity window than cert1.
      expect(rotated.expiresOn).not.toEqual(created.expiresOn);

      // Changing the immutable `type` triggers a replacement.
      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.CustomCertificate.CustomCertificate(
            "EdgeCert",
            {
              zoneId,
              certificate: cert2,
              privateKey: Redacted.make(key2),
              type: "legacy_custom",
              bundleMethod: "force",
            },
          );
        }),
      );
      expect(replaced.certificateId).not.toEqual(rotated.certificateId);
      expect(replaced.type).toEqual("legacy_custom");

      yield* stack.destroy();

      // Destroy deleted the certificate — the typed NotFound tag confirms.
      const gone = yield* customCertificates
        .getCustomCertificate({
          zoneId,
          customCertificateId: replaced.certificateId,
        })
        .pipe(
          Effect.retry({
            while: (e) => e._tag === "Forbidden",
            schedule: forbiddenRetrySchedule,
            times: 8,
          }),
          Effect.flip,
        );
      expect(gone._tag).toEqual("CustomCertificateNotFound");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
