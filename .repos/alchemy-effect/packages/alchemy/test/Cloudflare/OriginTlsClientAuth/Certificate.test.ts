import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as originTls from "@distilled.cloud/cloudflare/origin-tls-client-auth";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import {
  CERT_1,
  CERT_2,
  CERT_7,
  KEY_1,
  KEY_2,
  KEY_7,
} from "./fixtures/certs.ts";

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
// each operation's error union via distilled patches).
//
// CAPPED at 3s: a bare `Schedule.exponential("500 millis")` reaches a 64s
// single delay by the 8th retry (~127s total), so a token blip would sleep
// for over a minute between attempts and blow the test budget even though the
// blip itself clears in seconds. Capping keeps the cadence steady.
const forbiddenRetrySchedule = Schedule.min([
  Schedule.exponential("500 millis"),
  Schedule.spaced("3 seconds"),
]);

const getCertificate = (zoneId: string, certificateId: string) =>
  originTls.getOriginTlsClientAuth({ zoneId, certificateId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

// Cloudflare keeps deleted zone client certificates readable by id as
// `pending_deletion` / `deleted` tombstones (and excludes them from list),
// so "gone" means tombstoned or 404.
const waitForGone = (zoneId: string, certificateId: string) =>
  getCertificate(zoneId, certificateId).pipe(
    Effect.flatMap((cert) =>
      cert.status === "pending_deletion" || cert.status === "deleted"
        ? Effect.void
        : Effect.fail({ _tag: "CertificateNotDeleted" } as const),
    ),
    Effect.catchTag("CertificateNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "CertificateNotDeleted",
      // STEADY 3s cadence, bounded ~60s. The previous
      // `Schedule.exponential("500 millis")` (capped only by `recurs(10)`)
      // ramped to 64s/128s/256s single delays — so once a tombstone lagged a
      // little, the poll would *sleep* far past the deadline before noticing
      // the cert was already gone. That overshoot — not genuinely-slow CF —
      // was what blew the test budget. A fixed interval detects the tombstone
      // within one poll of it actually happening.
      schedule: Schedule.max([
        Schedule.spaced("3 seconds"),
        Schedule.recurs(45),
      ]),
    }),
  );

// Purge any live zone client certificates left behind by interrupted runs so
// each test starts from a clean slate (the zone-level cert store is only
// exercised by this suite).
const purgeCertificates = (zoneId: string) =>
  Effect.gen(function* () {
    const list = yield* originTls.listOriginTlsClientAuths({ zoneId }).pipe(
      Effect.retry({
        while: (e) => e._tag === "Forbidden",
        schedule: forbiddenRetrySchedule,
        times: 8,
      }),
    );
    yield* Effect.forEach(
      (list.result ?? []).filter(
        (c) =>
          c.id && c.status !== "deleted" && c.status !== "pending_deletion",
      ),
      (c) =>
        originTls
          .deleteOriginTlsClientAuth({ zoneId, certificateId: c.id! })
          .pipe(
            // A leftover cert still propagating its initial deployment rejects
            // the delete with code 1434 (pending deployment); ride it out so
            // the purge actually clears the slate instead of cascading. A
            // delete racing a sibling per-zone mutation is rejected with HTTP
            // 409 (`ZoneClientCertConflict`) — retry that too.
            Effect.retry({
              while: (e) =>
                e._tag === "CertificatePendingDeployment" ||
                e._tag === "ZoneClientCertConflict",
              schedule: Schedule.spaced("5 seconds"),
              times: 12,
            }),
            // Deletion is idempotent: a cert that flipped into (or past)
            // deletion between the list and this call answers HTTP 400
            // "Certificate is already deleted." — both mean it is gone.
            Effect.catchTag(
              ["CertificateNotFound", "CertificateAlreadyDeleted"],
              () => Effect.void,
            ),
          ),
    );
  });

// The zone client-certificate store dedups by PEM content and the upload /
// delete lifecycle is eventually consistent, so two cases uploading the same
// `CERT_1` concurrently churn each other (collisions + stale list views).
// Run the cases one at a time so each owns its certificate content.
describe.sequential("Certificate", () => {
  test.provider(
    "uploads and deletes a zone client certificate",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();
        yield* purgeCertificates(zoneId);

        const cert = yield* stack.deploy(
          Cloudflare.OriginTlsClientAuth.Certificate("AopCert", {
            zoneId,
            certificate: CERT_1,
            privateKey: Redacted.make(KEY_1),
          }),
        );

        expect(cert.certificateId).toBeDefined();
        expect(cert.zoneId).toEqual(zoneId);
        expect(cert.status).toBeDefined();
        expect(cert.expiresOn).toBeDefined();
        expect(cert.issuer).toContain("Alchemy AOP Test Cert 1");

        const actual = yield* getCertificate(zoneId, cert.certificateId);
        expect(actual.id).toEqual(cert.certificateId);
        expect(actual.status).not.toEqual("deleted");
        expect(actual.status).not.toEqual("pending_deletion");

        yield* stack.destroy();

        yield* waitForGone(zoneId, cert.certificateId);
      }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.ignore)), logLevel),
    { timeout: 200_000 },
  );

  test.provider(
    "replaces the certificate when the PEM changes",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();
        yield* purgeCertificates(zoneId);

        const original = yield* stack.deploy(
          Cloudflare.OriginTlsClientAuth.Certificate("ReplaceCert", {
            zoneId,
            certificate: CERT_1,
            privateKey: Redacted.make(KEY_1),
          }),
        );

        const replaced = yield* stack.deploy(
          Cloudflare.OriginTlsClientAuth.Certificate("ReplaceCert", {
            zoneId,
            certificate: CERT_2,
            privateKey: Redacted.make(KEY_2),
          }),
        );

        expect(replaced.certificateId).toBeDefined();
        expect(replaced.certificateId).not.toEqual(original.certificateId);
        expect(replaced.issuer).toContain("Alchemy AOP Test Cert 2");

        // The old certificate must be gone after the replacement completes.
        yield* waitForGone(zoneId, original.certificateId);

        const actual = yield* getCertificate(zoneId, replaced.certificateId);
        expect(actual.id).toEqual(replaced.certificateId);

        yield* stack.destroy();

        yield* waitForGone(zoneId, replaced.certificateId);
      }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.ignore)), logLevel),
    { timeout: 200_000 },
  );

  // Canonical `list()` test (zone-scoped collection): `list()` fans out over
  // every zone via `listAllZones` and enumerates the per-zone certificate store,
  // hydrating each into the same `read` Attributes shape. Deploy a certificate
  // to the standing test zone and assert it appears in the exhaustive result.
  test.provider(
    "list enumerates the deployed zone client certificate",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();
        yield* purgeCertificates(zoneId);

        const cert = yield* stack.deploy(
          Cloudflare.OriginTlsClientAuth.Certificate("ListCert", {
            zoneId,
            // Dedicated PEM (see fixtures/certs.ts): keeps this certificate out
            // of the upload/delete churn the sibling tests put CERT_1 through,
            // so it appears in the eventually-consistent list promptly.
            certificate: CERT_7,
            privateKey: Redacted.make(KEY_7),
          }),
        );

        const provider = yield* Provider.findProvider(
          Cloudflare.OriginTlsClientAuth.Certificate,
        );
        // A freshly uploaded certificate can lag the zone list endpoint by tens
        // of seconds — especially when the same PEM was recently deleted and
        // re-created (the sibling tests churn CERT_1), so the list endpoint
        // keeps serving the stale "gone" view for a while. Poll list() until it
        // appears, bounded to ~60s, rather than asserting on a single read.
        const found = yield* provider.list().pipe(
          Effect.map((all) =>
            all.find((c) => c.certificateId === cert.certificateId),
          ),
          Effect.flatMap((match) =>
            match
              ? Effect.succeed(match)
              : Effect.fail({ _tag: "CertificateNotListed" } as const),
          ),
          Effect.retry({
            while: (e) => e._tag === "CertificateNotListed",
            schedule: Schedule.spaced("3 seconds"),
            times: 20,
          }),
        );
        expect(found.zoneId).toEqual(zoneId);

        yield* stack.destroy();

        yield* waitForGone(zoneId, cert.certificateId);
      }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.ignore)), logLevel),
    // With the poll backoffs now CAPPED (steady cadence, see
    // `waitForGone`/`forbiddenRetrySchedule`), this test's three sequential
    // eventual-consistency waits are each bounded to ~60s — the list-appear
    // poll, the destroy's pending-deployment delete retry, and `waitForGone` —
    // for a deterministic worst case of ~200s. The timeout matches that bound;
    // 120s was below the legitimate maximum (the acute flake was the old
    // uncapped exponential sleeping past the deadline, now fixed).
    { timeout: 240_000 },
  );
});
