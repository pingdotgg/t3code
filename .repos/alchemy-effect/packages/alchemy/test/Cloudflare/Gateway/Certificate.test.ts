import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import type { CertificateAttributes } from "@/Cloudflare/Gateway/Certificate";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import { expect } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

// Cloudflare caps Zero Trust certificate *generation* at 3 per 24h per account
// and does NOT refund that rolling counter on delete (it is separate from the
// "10 active certificates" count limit), so neither `stack.destroy()` nor
// `bun nuke` can reclaim budget. The replacement test mints two certificates
// per run, so it exhausts the quota fastest — skip it by default. Set
// RUN_GATEWAY_CERT_TESTS=1 to run it against an account with fresh daily budget.
const runGatewayCertTests = !!process.env.RUN_GATEWAY_CERT_TESTS;

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Ride out 403 blips (`Forbidden`) while the harness-minted token
// propagates across Cloudflare's edge.
const getCertificate = (accountId: string, certificateId: string) =>
  zeroTrust.getGatewayCertificate({ accountId, certificateId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

// A deleted certificate surfaces as `GatewayCertificateNotFound`
// (Cloudflare code 2027, "Certificate not found in SSL store").
const expectGone = (accountId: string, certificateId: string) =>
  getCertificate(accountId, certificateId).pipe(
    Effect.flatMap(() =>
      Effect.fail({ _tag: "CertificateNotDeleted" } as const),
    ),
    Effect.catchTag("GatewayCertificateNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "CertificateNotDeleted",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

/**
 * Pull the typed {@link zeroTrust.GatewayCertificateQuotaReached} value out of
 * a Cause regardless of whether the engine raised it as a failure or a defect.
 */
const findQuotaError = (
  cause: Cause.Cause<unknown>,
): zeroTrust.GatewayCertificateQuotaReached | undefined =>
  cause.reasons
    .map((reason) =>
      Cause.isFailReason(reason)
        ? reason.error
        : Cause.isDieReason(reason)
          ? reason.defect
          : undefined,
    )
    .find(
      (value): value is zeroTrust.GatewayCertificateQuotaReached =>
        value instanceof zeroTrust.GatewayCertificateQuotaReached,
    );

/**
 * Deploy, but converge a `GatewayCertificateQuotaReached` failure (Cloudflare
 * caps gateway certificate creation at 3 per 24 hours per account) to
 * `undefined` so the calling test can skip its assertions gracefully instead
 * of failing on same-day reruns.
 */
const deployUnlessQuotaReached = (
  stack: Test.ScratchStack,
  eff: Effect.Effect<any, any, any>,
): Effect.Effect<CertificateAttributes | undefined, any, any> =>
  stack
    .deploy(eff)
    .pipe(
      Effect.catchCause(
        (
          cause,
        ): Effect.Effect<CertificateAttributes | undefined, any, never> =>
          findQuotaError(cause)
            ? Effect.succeed(undefined)
            : Effect.failCause(cause),
      ),
    );

const logQuotaSkip = (what: string) =>
  Effect.logWarning(
    `skipping ${what}: Cloudflare's 3-per-24h gateway certificate creation quota is exhausted (GatewayCertificateQuotaReached)`,
  );

test.provider(
  "create an activated certificate, deactivate in place, destroy",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const cert = yield* deployUnlessQuotaReached(
        stack,
        Cloudflare.Gateway.Certificate("InspectionCa", {
          validityPeriodDays: 30,
        }),
      );
      if (cert === undefined) {
        yield* logQuotaSkip("activate/deactivate assertions");
        yield* stack.destroy();
        return;
      }

      expect(cert.certificateId).toBeTruthy();
      expect(cert.accountId).toEqual(accountId);
      expect(cert.certificateType).toEqual("gateway_managed");
      expect(cert.certificate).toContain("BEGIN CERTIFICATE");
      expect(cert.fingerprint).toBeTruthy();
      // Activation settles within seconds; the provider waits for it.
      expect(cert.bindingStatus).toEqual("available");

      const live = yield* getCertificate(accountId, cert.certificateId);
      expect(live.bindingStatus).toEqual("available");
      expect(live.fingerprint).toEqual(cert.fingerprint);

      // Deactivate in place — same certificate, new binding status.
      const deactivated = yield* stack.deploy(
        Cloudflare.Gateway.Certificate("InspectionCa", {
          validityPeriodDays: 30,
          activate: false,
        }),
      );
      expect(deactivated.certificateId).toEqual(cert.certificateId);
      expect(deactivated.bindingStatus).toEqual("inactive");

      yield* stack.destroy();
      yield* expectGone(accountId, cert.certificateId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!runGatewayCertTests)(
  "changing the validity period replaces the certificate",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      // Keep both generations inactive so the test stays fast — no edge
      // activation round-trips.
      const first = yield* deployUnlessQuotaReached(
        stack,
        Cloudflare.Gateway.Certificate("ShortCa", {
          validityPeriodDays: 30,
          activate: false,
        }),
      );
      if (first === undefined) {
        yield* logQuotaSkip("replacement assertions");
        yield* stack.destroy();
        return;
      }
      expect(first.bindingStatus).toEqual("inactive");

      const second = yield* deployUnlessQuotaReached(
        stack,
        Cloudflare.Gateway.Certificate("ShortCa", {
          validityPeriodDays: 60,
          activate: false,
        }),
      );
      if (second === undefined) {
        yield* logQuotaSkip("replacement assertions (second generation)");
        yield* stack.destroy();
        return;
      }
      // The validity period is immutable — a new certificate is minted
      // and the old one deleted.
      expect(second.certificateId).not.toEqual(first.certificateId);
      yield* expectGone(accountId, first.certificateId);

      yield* stack.destroy();
      yield* expectGone(accountId, second.certificateId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "list enumerates the deployed gateway certificate",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const cert = yield* deployUnlessQuotaReached(
        stack,
        Cloudflare.Gateway.Certificate("ListCa", {
          validityPeriodDays: 30,
          activate: false,
        }),
      );

      const provider = yield* Provider.findProvider(
        Cloudflare.Gateway.Certificate,
      );
      const all = yield* provider.list();

      // Always a well-typed array of Attributes scoped to this account.
      expect(Array.isArray(all)).toBe(true);
      expect(all.every((c) => c.accountId === accountId)).toBe(true);

      if (cert === undefined) {
        // Same-day reruns can exhaust the 3-per-24h creation quota; the
        // read-only list assertion above still proves enumeration works.
        yield* logQuotaSkip("list presence assertion");
        yield* stack.destroy();
        return;
      }

      const found = all.find((c) => c.certificateId === cert.certificateId);
      expect(found).toBeDefined();
      expect(found?.accountId).toEqual(accountId);

      yield* stack.destroy();
      yield* expectGone(accountId, cert.certificateId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);
