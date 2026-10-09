import * as ACME from "@/ACME";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Test from "@/Test/Alchemy";
import { Jose } from "@distilled.cloud/acme";
import * as acme from "@distilled.cloud/acme/acme";
import * as dns from "@distilled.cloud/cloudflare/dns";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

const { test } = Test.make({
  providers: Layer.mergeAll(ACME.providers(), Cloudflare.providers()),
});
const ca = ACME.LetsEncryptStaging;
const zoneName =
  process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";
const name = `alchemy-acme-lifecycle.${zoneName}`;
const resolveZone = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const zone = yield* findZoneByName({ accountId, name: zoneName });
  if (!zone) return yield* Effect.fail(new Error(`zone ${zoneName} not found`));
  return zone.id;
});

test.provider(
  "keeps an unchanged certificate, renews, persists revocation settings and cleans DNS",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const zoneId = yield* resolveZone;
      const program = (extra: Partial<ACME.CertificateProps> = {}) =>
        Effect.gen(function* () {
          const account = yield* ACME.Account("Account", {
            ca,
            termsOfServiceAgreed: true,
          });
          const cert = yield* ACME.Certificate("Certificate", {
            account,
            identifiers: [name],
            solver: Cloudflare.DNS.AcmeSolver({ zoneId }),
            ...extra,
          });
          return { account, cert };
        });
      const first = yield* stack.deploy(program());
      const parsed = yield* ACME.parseCertificate(first.cert.certificate);
      expect(parsed.dnsNames).toEqual([name]);
      expect(first.cert.serial).toBe(parsed.serial);
      expect(first.cert.issuer).toContain("STAGING");
      expect(ACME.splitPemChain(first.cert.chain).length).toBeGreaterThan(1);
      expect(Redacted.isRedacted(first.cert.privateKey)).toBe(true);
      const unchanged = yield* stack.deploy(program());
      expect(unchanged.cert.serial).toBe(first.cert.serial);
      const renewed = yield* stack.deploy(program({ renewBefore: "365 days" }));
      expect(renewed.cert.serial).not.toBe(first.cert.serial);
      const configured = yield* stack.deploy(program({ revokeOnDelete: true }));
      expect(configured.cert.serial).toBe(renewed.cert.serial);
      const records = yield* dns.listRecords
        .items({
          zoneId,
          name: { exact: `_acme-challenge.${name}` },
          type: "TXT",
        })
        .pipe(Stream.runCollect);
      expect(records).toEqual([]);
      yield* stack.destroy();
      const certificateKey = yield* ACME.privateKeyToJwk(
        configured.cert.privateKey,
      );
      const revokedAgain = yield* acme
        .revokeCertificate({
          certificate: Jose.base64url(
            ACME.fromPem(configured.cert.certificate),
          ),
        })
        .pipe(
          Effect.provide(ACME.accountLayer({ ca, accountKey: certificateKey })),
          Effect.result,
        );
      expect(Result.isFailure(revokedAgain)).toBe(true);
      if (Result.isFailure(revokedAgain))
        expect(revokedAgain.failure._tag).toBe("AcmeAlreadyRevoked");
    }),
  {
    tags: [
      "provider:acme",
      "provider:acme:account",
      "provider:acme:certificate",
      "provider:cloudflare",
      "provider:cloudflare:dns",
      "provider:cloudflare:zone",
      "live",
    ],
    timeout: 180_000,
  },
);

test.provider(
  "changing the account replaces the certificate while retaining both accounts",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const zoneId = yield* resolveZone;
      const program = (second: boolean) =>
        Effect.gen(function* () {
          const firstAccount = yield* ACME.Account("First", {
            ca,
            termsOfServiceAgreed: true,
          });
          const secondAccount = yield* ACME.Account("Second", {
            ca,
            termsOfServiceAgreed: true,
          });
          return yield* ACME.Certificate("Certificate", {
            account: second ? secondAccount : firstAccount,
            identifiers: [`alchemy-acme-account-switch.${zoneName}`],
            solver: Cloudflare.DNS.AcmeSolver({ zoneId }),
            revokeOnDelete: true,
          });
        });
      const first = yield* stack.deploy(program(false));
      const second = yield* stack.deploy(program(true));
      expect(second.serial).not.toBe(first.serial);
      expect(second.accountUrl).not.toBe(first.accountUrl);
      yield* stack.destroy();
    }),
  {
    tags: [
      "provider:acme",
      "provider:acme:account",
      "provider:acme:certificate",
      "provider:cloudflare",
      "provider:cloudflare:dns",
      "provider:cloudflare:zone",
      "live",
    ],
    timeout: 180_000,
  },
);

test.provider(
  "fails with a typed error when no DNS solver is registered",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const result = yield* stack
        .deploy(
          Effect.gen(function* () {
            const account = yield* ACME.Account("Account", {
              ca,
              termsOfServiceAgreed: true,
            });
            return yield* ACME.Certificate("Certificate", {
              account,
              identifiers: [`alchemy-acme-unsolvable.${zoneName}`],
              solver: { type: "Nope.DNS" },
            });
          }),
        )
        .pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      expect(JSON.stringify(result)).toContain("ACME.DnsSolverNotRegistered");
      yield* stack.destroy();
    }),
  {
    tags: [
      "provider:acme",
      "provider:acme:account",
      "provider:acme:certificate",
      "provider:cloudflare",
      "live",
    ],
    timeout: 60_000,
  },
);
