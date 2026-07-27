import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import { isResourceState, State, type ResourceState } from "@/State";
import * as Test from "@/Test/Alchemy";
import * as originTls from "@distilled.cloud/cloudflare/origin-tls-client-auth";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import {
  CERT_2,
  CERT_3,
  CERT_4,
  CERT_8,
  CERT_9,
  KEY_2,
  KEY_3,
  KEY_4,
  KEY_8,
  KEY_9,
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
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const getCertificate = (zoneId: string, certificateId: string) =>
  originTls.getHostnameCertificate({ zoneId, certificateId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

// Re-uploading a PEM that collides with a not-yet-cleared tombstone (a prior
// run's `pending_deletion` cert for the same PEM) resurrects it under the same
// id, and the certificate can briefly read back as `pending_deletion` before
// transitioning to a live status. Poll until it settles, bounded.
const waitForLive = (zoneId: string, certificateId: string) =>
  getCertificate(zoneId, certificateId).pipe(
    Effect.flatMap((cert) =>
      cert.status !== "pending_deletion" && cert.status !== "deleted"
        ? Effect.succeed(cert)
        : Effect.fail({ _tag: "CertificateNotLive" } as const),
    ),
    Effect.retry({
      while: (e) => e._tag === "CertificateNotLive",
      schedule: Schedule.max([
        Schedule.spaced("3 seconds"),
        Schedule.recurs(15),
      ]),
    }),
  );

// Cloudflare keeps deleted hostname client certificates readable by id as
// `pending_deletion` / `deleted` tombstones, so "gone" means tombstoned or
// 404.
const waitForGone = (zoneId: string, certificateId: string) =>
  getCertificate(zoneId, certificateId).pipe(
    Effect.flatMap((cert) =>
      cert.status === "pending_deletion" || cert.status === "deleted"
        ? Effect.void
        : Effect.fail({ _tag: "CertificateNotDeleted" } as const),
    ),
    Effect.catchTag("HostnameCertificateNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "CertificateNotDeleted",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

// Purge any live hostname client certificates with this suite's fixture PEMs
// left behind by interrupted runs. Filtering by PEM content keeps the purge
// scoped to this file — other suites in the directory own other fixtures.
const purgeCertificates = (zoneId: string, pems: string[]) =>
  Effect.gen(function* () {
    const list = yield* originTls.listHostnameCertificates({ zoneId }).pipe(
      Effect.retry({
        while: (e) => e._tag === "Forbidden",
        schedule: forbiddenRetrySchedule,
        times: 8,
      }),
    );
    const targets = pems.map((p) => p.trim());
    yield* Effect.forEach(
      list.result.filter(
        (c) =>
          c.id &&
          c.status !== "deleted" &&
          c.status !== "pending_deletion" &&
          targets.includes((c.certificate ?? "").trim()),
      ),
      (c) =>
        originTls
          .deleteHostnameCertificate({ zoneId, certificateId: c.id! })
          .pipe(
            Effect.retry({
              while: (e) => e._tag === "CertificatePendingDeployment",
              schedule: Schedule.spaced("5 seconds"),
              times: 10,
            }),
            Effect.catchTag(
              ["HostnameCertificateNotFound", "CertificatePendingDeletion"],
              () => Effect.void,
            ),
          ),
    );
  });

test.provider(
  "uploads and deletes a hostname client certificate",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      // Dedicated PEM (CERT_9): the sibling "replaces" test churns CERT_3
      // concurrently under the global concurrent config, and its
      // `pending_deletion` tombstone for CERT_3 would otherwise collide here
      // (a re-upload resurrects the half-deleted cert, which never goes live).
      yield* stack.destroy();
      yield* purgeCertificates(zoneId, [CERT_9]);

      const cert = yield* stack.deploy(
        Cloudflare.OriginTlsClientAuth.HostnameCertificate("AopHostCert", {
          zoneId,
          certificate: CERT_9,
          privateKey: Redacted.make(KEY_9),
        }),
      );

      expect(cert.certificateId).toBeDefined();
      expect(cert.zoneId).toEqual(zoneId);
      expect(cert.status).toBeDefined();
      expect(cert.issuer).toContain("Alchemy AOP Test Cert 9");

      const actual = yield* waitForLive(zoneId, cert.certificateId);
      expect(actual.id).toEqual(cert.certificateId);
      expect(actual.status).not.toEqual("deleted");
      expect(actual.status).not.toEqual("pending_deletion");

      yield* stack.destroy();

      yield* waitForGone(zoneId, cert.certificateId);
    }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.ignore)), logLevel),
  { timeout: 120_000 },
);

test.provider(
  "replaces the hostname certificate when the PEM changes",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();
      yield* purgeCertificates(zoneId, [CERT_3, CERT_4]);

      const original = yield* stack.deploy(
        Cloudflare.OriginTlsClientAuth.HostnameCertificate("ReplaceHostCert", {
          zoneId,
          certificate: CERT_3,
          privateKey: Redacted.make(KEY_3),
        }),
      );

      const replaced = yield* stack.deploy(
        Cloudflare.OriginTlsClientAuth.HostnameCertificate("ReplaceHostCert", {
          zoneId,
          certificate: CERT_4,
          privateKey: Redacted.make(KEY_4),
        }),
      );

      expect(replaced.certificateId).toBeDefined();
      expect(replaced.certificateId).not.toEqual(original.certificateId);
      expect(replaced.issuer).toContain("Alchemy AOP Test Cert 4");

      // The old certificate must be gone after the replacement completes.
      yield* waitForGone(zoneId, original.certificateId);

      const actual = yield* getCertificate(zoneId, replaced.certificateId);
      expect(actual.id).toEqual(replaced.certificateId);

      yield* stack.destroy();

      yield* waitForGone(zoneId, replaced.certificateId);
    }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.ignore)), logLevel),
  { timeout: 120_000 },
);

test.provider(
  "recovers a creating-state row whose Output-valued certificate was lost (#736)",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      // Dedicated PEM (CERT_2): the other hostname-certificate tests own
      // CERT_3/4/8/9; CERT_2 is otherwise only used by the *zone-level*
      // Certificate suite, which is a separate Cloudflare collection.
      yield* stack.destroy();
      yield* purgeCertificates(zoneId, [CERT_2]);

      const deployCert = () =>
        stack.deploy(
          Cloudflare.OriginTlsClientAuth.HostnameCertificate("WedgedHostCert", {
            zoneId,
            certificate: CERT_2,
            privateKey: Redacted.make(KEY_2),
          }),
        );

      const created = yield* deployCert();
      expect(created.certificateId).toBeDefined();

      // Rewrite the persisted row into the wedged shape an interrupted deploy
      // leaves behind when `certificate` was Output-valued: `creating`, no
      // attributes, and the certificate lost in the round-trip (#736).
      const state = yield* yield* State;
      const stage = "test"; // scratch stacks default to the "test" stage
      const fqns = yield* state.list({ stack: stack.name, stage });
      const rows = yield* Effect.forEach(fqns, (fqn) =>
        state
          .get({ stack: stack.name, stage, fqn })
          .pipe(Effect.map((row) => ({ fqn, row }))),
      );
      const wedged = rows.find(
        (r): r is { fqn: string; row: ResourceState } =>
          isResourceState(r.row) &&
          r.row.resourceType ===
            "Cloudflare.OriginTlsClientAuth.HostnameCertificate",
      );
      if (!wedged) {
        return yield* Effect.die(
          new Error("no HostnameCertificate state row found after deploy"),
        );
      }
      yield* state.set({
        stack: stack.name,
        stage,
        fqn: wedged.fqn,
        value: {
          ...wedged.row,
          status: "creating",
          attr: undefined,
          props: { ...wedged.row.props, certificate: undefined },
        },
      });

      // `read` cannot content-match without `olds.certificate`, so planning
      // falls through to `diff` with the junk olds. Before the fix this
      // crashed with `TypeError: undefined is not an object (evaluating
      // 'pem.trim')` in normalizePem; after it, diff falls through and
      // reconcile re-adopts the live certificate by PEM content.
      const recovered = yield* deployCert();
      expect(recovered.certificateId).toEqual(created.certificateId);

      yield* stack.destroy();

      yield* waitForGone(zoneId, recovered.certificateId);
    }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.ignore)), logLevel),
  { timeout: 120_000 },
);

test.provider(
  "list enumerates the deployed hostname certificate",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();
      yield* purgeCertificates(zoneId, [CERT_8]);

      const cert = yield* stack.deploy(
        Cloudflare.OriginTlsClientAuth.HostnameCertificate("ListHostCert", {
          zoneId,
          // Dedicated PEM (see fixtures/certs.ts): keeps this certificate out
          // of the upload/delete churn the sibling tests put CERT_3 through,
          // so it appears in the eventually-consistent list promptly.
          certificate: CERT_8,
          privateKey: Redacted.make(KEY_8),
        }),
      );

      const provider = yield* Provider.findProvider(
        Cloudflare.OriginTlsClientAuth.HostnameCertificate,
      );
      // A freshly uploaded certificate can lag the zone list endpoint by
      // tens of seconds — especially when the same PEM was recently deleted
      // and re-created (the prior suites churn CERT_3), so the list endpoint
      // keeps serving the stale "gone" view for a while. Poll list() until it
      // appears, bounded to ~60s.
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
  { timeout: 120_000 },
);
