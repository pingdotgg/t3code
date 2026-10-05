import * as ACME from "@/ACME";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Test from "@/Test/Alchemy";
import * as ZeroSsl from "@distilled.cloud/zerossl";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

/**
 * ZeroSSL has no staging environment, so this runs against production
 * with External Account Binding credentials minted from the REST access
 * key. Opt in with `ACME_TEST_ZEROSSL=1` (plus `ZERO_SSL_KEY`).
 */
const { test } = Test.make({
  providers: Layer.mergeAll(ACME.providers(), Cloudflare.providers()),
});

const enabled =
  process.env.ACME_TEST_ZEROSSL === "1" &&
  (process.env.ZERO_SSL_KEY !== undefined ||
    process.env.ZEROSSL_ACCESS_KEY !== undefined);

const zoneName =
  process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";
const NAME = `alchemy-acme-zerossl.${zoneName}`;

const resolveZoneId = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const zone = yield* findZoneByName({ accountId, name: zoneName });
  if (!zone) {
    return yield* Effect.die(new Error(`zone "${zoneName}" not found`));
  }
  return zone.id;
});

const mintEab = ZeroSsl.zerossl
  .generateEabCredentials({})
  .pipe(
    Effect.provide(
      Layer.mergeAll(ZeroSsl.CredentialsFromEnv, FetchHttpClient.layer),
    ),
  );

test.provider.skipIf(!enabled)(
  "issues from ZeroSSL with EAB credentials over Cloudflare DNS-01",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;
      const eab = yield* mintEab;
      expect(eab.success).toBe(true);
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const account = yield* ACME.Account("ZeroSSL", {
            ca: ACME.ZeroSSL,
            eab: {
              keyId: eab.eab_kid!,
              // Already `Redacted` — the SDK marks the field sensitive.
              hmacKey: eab.eab_hmac_key!,
            },
            termsOfServiceAgreed: true,
          });
          const cert = yield* ACME.Certificate("ZeroSSLCert", {
            account,
            identifiers: [NAME],
            solver: { type: "Cloudflare.DNS", zoneId },
          });
          return { account, cert };
        }),
      );

      expect(deployed.account.accountUrl).toContain("acme.zerossl.com");
      expect(deployed.cert.issuer).toContain("ZeroSSL");
      const parsed = yield* ACME.parseCertificate(deployed.cert.certificate);
      expect(parsed.dnsNames).toEqual([NAME]);

      yield* stack.destroy();
    }),
  {
    tags: [
      "provider:acme",
      "provider:acme:account",
      "provider:acme:certificate",
      "provider:cloudflare",
      "provider:cloudflare:zone",
      "provider:zerossl",
      "live",
    ],
    timeout: 300_000,
  },
);
