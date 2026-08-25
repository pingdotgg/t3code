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
import { CERT_5, CERT_6, KEY_5, KEY_6 } from "./fixtures/certs.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const zoneName =
  process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

// Deterministic per-test hostnames. Each test owns a disjoint subdomain so
// reruns never collide (never derive names from Date.now()/random).
const HOST_LIFECYCLE = `alchemy-aop-assoc.${zoneName}`;
const HOST_REPLACE_A = `alchemy-aop-assoc-replace-a.${zoneName}`;
const HOST_REPLACE_B = `alchemy-aop-assoc-replace-b.${zoneName}`;

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

// Read a hostname's association out-of-band; "never configured" (404 / code
// 1553) and "voided" (`enabled: null`) both read as undefined.
const getAssociation = (zoneId: string, hostname: string) =>
  originTls.getHostname({ zoneId, hostname }).pipe(
    Effect.map((assoc) =>
      assoc.enabled === null || assoc.enabled === undefined ? undefined : assoc,
    ),
    Effect.catchTag("HostnameAssociationNotFound", () =>
      Effect.succeed(undefined),
    ),
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

// Void any association left behind by interrupted runs so the test starts
// from a clean slate.
const voidAssociation = (zoneId: string, hostname: string) =>
  Effect.gen(function* () {
    const observed = yield* getAssociation(zoneId, hostname);
    if (!observed?.certId) return;
    yield* originTls
      .putHostname({
        zoneId,
        config: [{ hostname, certId: observed.certId, enabled: null }],
      })
      .pipe(
        // The pinned certificate may already be gone (code 1415); the
        // association is inert without it.
        Effect.catchTag("InvalidHostnameConfig", () => Effect.void),
      );
  });

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
              while: (e) =>
                e._tag === "CertificatePendingDeployment" ||
                e._tag === "HostnameCertificateInUse",
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

// Both certificates stay deployed across every step so updates/replacements
// only touch the association itself (replacing a resource while removing its
// old dependency in the same deploy is a known engine deadlock).
const program = (opts: {
  zoneId: string;
  hostname: string;
  cert: "5" | "6";
  enabled: boolean;
}) =>
  Effect.gen(function* () {
    const cert5 = yield* Cloudflare.OriginTlsClientAuth.HostnameCertificate(
      "AssocCert5",
      {
        zoneId: opts.zoneId,
        certificate: CERT_5,
        privateKey: Redacted.make(KEY_5),
      },
    );
    const cert6 = yield* Cloudflare.OriginTlsClientAuth.HostnameCertificate(
      "AssocCert6",
      {
        zoneId: opts.zoneId,
        certificate: CERT_6,
        privateKey: Redacted.make(KEY_6),
      },
    );
    const pinned = opts.cert === "6" ? cert6 : cert5;
    const association =
      yield* Cloudflare.OriginTlsClientAuth.HostnameAssociation("AopHost", {
        zoneId: opts.zoneId,
        hostname: opts.hostname,
        certId: pinned.certificateId,
        enabled: opts.enabled,
      });
    return { cert5, cert6, association };
  });

describe.skipIf(!!process.env.FAST)("HostnameAssociation", () => {
  // Hostname associations are keyed entirely by {zoneId, hostname} and
  // Cloudflare exposes no endpoint that enumerates which hostnames in a zone
  // have an AOP association, so `list()` is non-listable and returns []. This
  // read-only assertion always runs (no cert/hostname deploy required).
  test.provider("list returns [] for the non-listable association", (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const provider = yield* Provider.findProvider(
        Cloudflare.OriginTlsClientAuth.HostnameAssociation,
      );
      const all = yield* provider.list();
      expect(all).toEqual([]);

      yield* stack.destroy();
    }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.ignore)), logLevel),
  );

  test.provider(
    "associates a hostname, updates cert and enablement in place, voids on destroy",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();
        yield* voidAssociation(zoneId, HOST_LIFECYCLE);
        yield* purgeCertificates(zoneId, [CERT_5, CERT_6]);

        // Create — pin cert 5, enabled.
        const initial = yield* stack.deploy(
          program({
            zoneId,
            hostname: HOST_LIFECYCLE,
            cert: "5",
            enabled: true,
          }),
        );

        expect(initial.association.zoneId).toEqual(zoneId);
        expect(initial.association.hostname).toEqual(HOST_LIFECYCLE);
        expect(initial.association.certId).toEqual(initial.cert5.certificateId);
        expect(initial.association.enabled).toEqual(true);

        const observed = yield* getAssociation(zoneId, HOST_LIFECYCLE);
        expect(observed?.certId).toEqual(initial.cert5.certificateId);
        expect(observed?.enabled).toEqual(true);

        // Update in place — repin to cert 6 and disable enforcement.
        const updated = yield* stack.deploy(
          program({
            zoneId,
            hostname: HOST_LIFECYCLE,
            cert: "6",
            enabled: false,
          }),
        );

        expect(updated.association.hostname).toEqual(HOST_LIFECYCLE);
        expect(updated.association.certId).toEqual(updated.cert6.certificateId);
        expect(updated.association.enabled).toEqual(false);

        const reobserved = yield* getAssociation(zoneId, HOST_LIFECYCLE);
        expect(reobserved?.certId).toEqual(updated.cert6.certificateId);
        expect(reobserved?.enabled).toEqual(false);

        // Destroy — the association is voided (`enabled: null`).
        yield* stack.destroy();

        const gone = yield* getAssociation(zoneId, HOST_LIFECYCLE).pipe(
          Effect.flatMap((assoc) =>
            assoc === undefined
              ? Effect.void
              : Effect.fail({ _tag: "AssociationNotVoided" } as const),
          ),
          // Frequent, bounded spaced poll (~240s): voiding settles through
          // edge propagation asynchronously and can occasionally take well
          // past two minutes, so poll every 5s with a generous bound rather
          // than backing off exponentially (whose late gaps overshoot).
          Effect.retry({
            while: (e) => e._tag === "AssociationNotVoided",
            schedule: Schedule.spaced("5 seconds"),
            times: 48,
          }),
          Effect.map(() => true),
        );
        expect(gone).toEqual(true);
      }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.ignore)), logLevel),
    // Two sequential deploys, each uploading two hostname client-certificates
    // plus the association, on Cloudflare's per-zone-serialized client-cert
    // API. Under a full concurrent `./test/Cloudflare` run this zone's cert
    // mutations contend with the sibling Certificate/HostnameCertificate
    // suites (each create/delete bounded-retries the per-zone 409), then a
    // ~240s spaced void poll — give real headroom while staying bounded.
    { timeout: 420_000 },
  );

  test.provider(
    "replaces the association when the hostname changes",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();
        yield* voidAssociation(zoneId, HOST_REPLACE_A);
        yield* voidAssociation(zoneId, HOST_REPLACE_B);
        yield* purgeCertificates(zoneId, [CERT_5, CERT_6]);

        const initial = yield* stack.deploy(
          program({
            zoneId,
            hostname: HOST_REPLACE_A,
            cert: "5",
            enabled: true,
          }),
        );
        expect(initial.association.hostname).toEqual(HOST_REPLACE_A);

        // Changing the hostname is a replacement — the old hostname's
        // association is voided and the new hostname gets its own entry.
        const replaced = yield* stack.deploy(
          program({
            zoneId,
            hostname: HOST_REPLACE_B,
            cert: "5",
            enabled: true,
          }),
        );
        expect(replaced.association.hostname).toEqual(HOST_REPLACE_B);
        expect(replaced.association.certId).toEqual(
          replaced.cert5.certificateId,
        );

        const observedNew = yield* getAssociation(zoneId, HOST_REPLACE_B);
        expect(observedNew?.enabled).toEqual(true);

        // The old hostname's association must be voided by the replacement.
        const oldGone = yield* getAssociation(zoneId, HOST_REPLACE_A).pipe(
          Effect.flatMap((assoc) =>
            assoc === undefined
              ? Effect.void
              : Effect.fail({ _tag: "AssociationNotVoided" } as const),
          ),
          // Frequent, bounded spaced poll (~120s): voiding settles through
          // edge propagation asynchronously, so check every 5s rather than
          // backing off exponentially (whose late gaps overshoot the timeout).
          Effect.retry({
            while: (e) => e._tag === "AssociationNotVoided",
            schedule: Schedule.spaced("5 seconds"),
            times: 24,
          }),
          Effect.map(() => true),
        );
        expect(oldGone).toEqual(true);

        yield* stack.destroy();

        // Voiding is asynchronous (the void PUT settles through edge
        // propagation) — poll until the association reads as absent rather
        // than asserting on a single (potentially stale) read.
        const newGone = yield* getAssociation(zoneId, HOST_REPLACE_B).pipe(
          Effect.flatMap((assoc) =>
            assoc === undefined
              ? Effect.void
              : Effect.fail({ _tag: "AssociationNotVoided" } as const),
          ),
          // Frequent, bounded spaced poll (~120s): voiding settles through
          // edge propagation asynchronously, so check every 5s rather than
          // backing off exponentially (whose late gaps overshoot the timeout).
          Effect.retry({
            while: (e) => e._tag === "AssociationNotVoided",
            schedule: Schedule.spaced("5 seconds"),
            times: 24,
          }),
          Effect.map(() => true),
        );
        expect(newGone).toEqual(true);
      }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.ignore)), logLevel),
    // Same per-zone-serialized client-cert contention as the lifecycle case
    // above, plus two spaced void polls — give real headroom under load.
    { timeout: 300_000 },
  );
});
