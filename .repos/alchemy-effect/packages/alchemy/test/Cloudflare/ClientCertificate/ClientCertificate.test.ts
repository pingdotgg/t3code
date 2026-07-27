import { adopt } from "@/AdoptPolicy";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as clientCertificates from "@distilled.cloud/cloudflare/client-certificates";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { CSR_A, CSR_B } from "./fixtures/csr.ts";

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
// typed `Forbidden` error (part of every client-certificates operation's
// error union via distilled patches).
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const getCertificate = (zoneId: string, clientCertificateId: string) =>
  clientCertificates.getClientCertificate({ zoneId, clientCertificateId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

// DELETE revokes the certificate; revoked certificates stay listed on the
// zone forever, so "gone" means the certificate is revoking, not a 404.
// Revocation transits `pending_revocation` asynchronously and Cloudflare can
// linger there well past the test's budget before flipping to `revoked` —
// both states are the delete semantic (the certificate can no longer serve
// mTLS), so treat either as "gone" and poll the typed GET until it lands,
// bounded so the test fails fast instead of riding the vitest timeout.
const isRevoking = (status: string | null | undefined): boolean =>
  status === "revoked" || status === "pending_revocation";

const waitUntilRevoked = (zoneId: string, clientCertificateId: string) =>
  getCertificate(zoneId, clientCertificateId).pipe(
    // Frequent, bounded spaced poll (~90s): revocation settles through
    // `pending_revocation` asynchronously, so check every 3s rather than
    // backing off exponentially (whose late gaps would overshoot the
    // timeout). Bounded so a stuck revoke fails fast instead of riding the
    // vitest timeout.
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (cert) => isRevoking(cert.status),
      times: 30,
    }),
  );

test.provider(
  "create signs the CSR, destroy revokes the certificate",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();

      // adopt(true): revoked certificates stay listed forever and the
      // cold-read identity is (csr, validityDays), so an interrupted prior
      // run can leave a live certificate this deploy should converge onto.
      const cert = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.ClientCertificate.ClientCertificate(
            "CreateCert",
            {
              zoneId,
              csr: CSR_A,
              validityDays: 90,
            },
          ).pipe(adopt(true));
        }),
      );

      expect(cert.clientCertificateId).toBeDefined();
      expect(cert.zoneId).toEqual(zoneId);
      expect(cert.status).toEqual("active");
      expect(cert.validityDays).toEqual(90);
      expect(cert.certificate).toContain("-----BEGIN CERTIFICATE-----");
      expect(cert.commonName).toEqual(
        "alchemy-client-cert-a.alchemy-test-2.us",
      );
      expect(cert.organization).toEqual("Alchemy");
      expect(cert.country).toEqual("US");
      expect(cert.issuedOn).toBeDefined();
      expect(cert.expiresOn).toBeDefined();
      expect(cert.serialNumber).toBeDefined();
      expect(cert.fingerprintSha256).toBeDefined();

      // Out-of-band verification through the raw API.
      const live = yield* getCertificate(zoneId, cert.clientCertificateId);
      expect(live.id).toEqual(cert.clientCertificateId);
      expect(live.status).toEqual("active");
      expect(live.validityDays).toEqual(90);

      // Re-deploying the same props is a no-op — same physical certificate.
      const again = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.ClientCertificate.ClientCertificate(
            "CreateCert",
            {
              zoneId,
              csr: CSR_A,
              validityDays: 90,
            },
          ).pipe(adopt(true));
        }),
      );
      expect(again.clientCertificateId).toEqual(cert.clientCertificateId);

      yield* stack.destroy();

      // Destroy revokes — the certificate remains listed but transitions to
      // `revoked`, which this resource treats as deleted.
      const revoked = yield* waitUntilRevoked(zoneId, cert.clientCertificateId);
      expect(isRevoking(revoked.status)).toBe(true);
    }).pipe(logLevel),
  // Two deploys (issue + no-op re-deploy) on Cloudflare's per-zone-serialized
  // client-cert API plus a ~90s spaced revoke poll — under a full concurrent
  // `./test/Cloudflare` run this contends with sibling cert suites, so give
  // headroom while staying bounded.
  { timeout: 240_000 },
);

test.provider(
  "changing validityDays replaces — new id issued, old certificate revoked",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.ClientCertificate.ClientCertificate(
            "ReplaceCert",
            {
              zoneId,
              csr: CSR_B,
              validityDays: 30,
            },
          ).pipe(adopt(true));
        }),
      );
      expect(initial.status).toEqual("active");
      expect(initial.validityDays).toEqual(30);

      // validityDays is immutable — the API cannot re-sign, so the engine
      // replaces: a new certificate is issued and the old one is revoked.
      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.ClientCertificate.ClientCertificate(
            "ReplaceCert",
            {
              zoneId,
              csr: CSR_B,
              validityDays: 60,
            },
          ).pipe(adopt(true));
        }),
      );

      expect(replaced.clientCertificateId).not.toEqual(
        initial.clientCertificateId,
      );
      expect(replaced.status).toEqual("active");
      expect(replaced.validityDays).toEqual(60);

      // The outgoing certificate was revoked as part of the replacement.
      const oldCert = yield* waitUntilRevoked(
        zoneId,
        initial.clientCertificateId,
      );
      expect(isRevoking(oldCert.status)).toBe(true);

      // The replacement is live and untouched by the old one's revocation.
      const live = yield* getCertificate(zoneId, replaced.clientCertificateId);
      expect(live.status).toEqual("active");

      yield* stack.destroy();

      const revoked = yield* waitUntilRevoked(
        zoneId,
        replaced.clientCertificateId,
      );
      expect(isRevoking(revoked.status)).toBe(true);
    }).pipe(logLevel),
  // This is a REPLACEMENT: the second deploy issues a brand-new certificate
  // and revokes the old one, then the test runs TWO ~90s spaced revoke polls
  // (the outgoing cert after replace, the replacement after destroy) on top
  // of three serialized client-cert mutations. Under a full concurrent
  // `./test/Cloudflare` run this far exceeds the default 120s, so give real
  // headroom while every poll stays bounded.
  { timeout: 300_000 },
);

test.provider(
  "list enumerates client certificates across zones",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();

      const cert = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.ClientCertificate.ClientCertificate(
            "ListCert",
            {
              zoneId,
              csr: CSR_A,
              validityDays: 90,
            },
          ).pipe(adopt(true));
        }),
      );

      const provider = yield* Provider.findProvider(
        Cloudflare.ClientCertificate.ClientCertificate,
      );

      // A freshly-issued client certificate is eventually consistent in the
      // account-wide list fan-out — poll (bounded) until it shows up rather
      // than asserting on a single immediate snapshot.
      const found = yield* Effect.gen(function* () {
        const all = yield* provider.list();
        return all.find(
          (c) => c.clientCertificateId === cert.clientCertificateId,
        );
      }).pipe(
        Effect.flatMap((f) =>
          f === undefined
            ? Effect.fail("not-yet-listed" as const)
            : Effect.succeed(f),
        ),
        Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 20 }),
      );

      expect(found).toBeDefined();
      expect(found?.zoneId).toEqual(zoneId);
      expect(found?.status).not.toEqual("revoked");
    }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.ignore)), logLevel),
  // `list()` fans out over every zone in the account and exhaustively
  // paginates each, plus a deploy on the per-zone-serialized client-cert API
  // — give headroom under a full concurrent `./test/Cloudflare` run.
  { timeout: 180_000 },
);
