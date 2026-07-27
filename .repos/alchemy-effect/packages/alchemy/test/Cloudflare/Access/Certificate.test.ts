import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import { CA_CERT_1, CA_CERT_2 } from "../MtlsCertificate/fixtures/certs.ts";

const { test } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// The standard testing account has an Access mTLS certificate quota of zero:
// `POST /accounts/{id}/access/certificates` fails with code 12130
// "maximum number of certificates has been reached" even though the account
// has no certificates. The full lifecycle is gated behind an entitled
// account supplied via env; the probe test always runs and pins the typed
// quota tag.
const entitled = !!process.env.CLOUDFLARE_TEST_ACCESS_MTLS;

test.provider.skipIf(entitled)(
  "unentitled accounts surface the typed AccessCertificateQuotaExceeded error",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      yield* stack.destroy();

      const error = yield* zeroTrust
        .createAccessCertificateForAccount({
          accountId,
          name: "alchemy-access-cert-quota-probe",
          certificate: CA_CERT_1,
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("AccessCertificateQuotaExceeded");

      // Reads on the same account succeed (and show no certificates),
      // proving the gate is on creation, not on the API token.
      const direct = yield* zeroTrust
        .getAccessCertificateForAccount({
          accountId,
          certificateId: "00000000-0000-0000-0000-000000000000",
        })
        .pipe(
          Effect.catchTag("AccessCertificateNotFound", () =>
            Effect.succeed(undefined),
          ),
        );
      expect(direct).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!entitled)(
  "create, update hostnames, replace on PEM change, destroy",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const cert = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Access.Certificate("BasicCert", {
            certificate: CA_CERT_1,
          });
        }),
      );

      expect(cert.certificateId).toBeDefined();
      expect(cert.accountId).toEqual(accountId);
      expect(cert.fingerprint).toBeDefined();
      expect(cert.associatedHostnames).toEqual([]);

      const actual = yield* zeroTrust.getAccessCertificateForAccount({
        accountId,
        certificateId: cert.certificateId,
      });
      expect(actual.id).toEqual(cert.certificateId);
      expect(actual.name).toEqual(cert.name);

      // Update — associate a hostname in place (same id).
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Access.Certificate("BasicCert", {
            certificate: CA_CERT_1,
            associatedHostnames: ["access-cert.alchemy-test-2.us"],
          });
        }),
      );
      expect(updated.certificateId).toEqual(cert.certificateId);
      expect(updated.associatedHostnames).toEqual([
        "access-cert.alchemy-test-2.us",
      ]);

      // Replace — a different PEM is immutable on the API, so the resource
      // is replaced with a new certificate id and fingerprint.
      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Access.Certificate("BasicCert", {
            certificate: CA_CERT_2,
          });
        }),
      );
      expect(replaced.certificateId).not.toEqual(cert.certificateId);
      expect(replaced.fingerprint).not.toEqual(cert.fingerprint);

      yield* stack.destroy();

      const afterDestroy = yield* zeroTrust
        .getAccessCertificateForAccount({
          accountId,
          certificateId: replaced.certificateId,
        })
        .pipe(
          Effect.catchTag("AccessCertificateNotFound", () =>
            Effect.succeed(undefined),
          ),
        );
      expect(afterDestroy?.id ?? undefined).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// Canonical `list()` test (account-scoped collection). Enumeration via
// `listAccessCertificatesForAccount` works on any account regardless of the
// create quota, so the probe (which only reads) always runs. On an entitled
// account we additionally deploy a certificate and assert it appears in the
// exhaustively-paginated result.
test.provider(
  "list enumerates account access certificates",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const provider = yield* Provider.findProvider(
        Cloudflare.Access.Certificate,
      );

      if (entitled) {
        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Access.Certificate("ListCert", {
              certificate: CA_CERT_1,
            });
          }),
        );

        const all = yield* provider.list();
        expect(
          all.some((c) => c.certificateId === deployed.certificateId),
        ).toBe(true);

        yield* stack.destroy();
      } else {
        // Unentitled accounts can't create certificates, but enumeration must
        // still succeed and return a typed array (empty when the account has
        // none) — proving the pagination path is wired correctly.
        const all = yield* provider.list();
        expect(Array.isArray(all)).toBe(true);
      }
    }).pipe(logLevel),
  { timeout: 120_000 },
);
