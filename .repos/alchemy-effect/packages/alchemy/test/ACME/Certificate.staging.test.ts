import * as ACME from "@/ACME";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Test from "@/Test/Alchemy";
import * as dns from "@distilled.cloud/cloudflare/dns";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";

/**
 * The real DNS-01 path: Let's Encrypt staging validates `_acme-challenge`
 * TXT records that `Cloudflare.DNS.AcmeSolver` publishes in the standing
 * test zone. Staging has generous limits; the chain is untrusted but the
 * flow is production's.
 */
const { test } = Test.make({
  providers: Layer.mergeAll(ACME.providers(), Cloudflare.providers()),
});

const zoneName =
  process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";
const NAME = `alchemy-acme-staging.${zoneName}`;

const resolveZoneId = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const zone = yield* findZoneByName({ accountId, name: zoneName });
  if (!zone) {
    return yield* Effect.die(new Error(`zone "${zoneName}" not found`));
  }
  return zone.id;
});

const challengeRecords = (zoneId: string) =>
  dns.listRecords
    .items({ zoneId, name: { exact: `_acme-challenge.${NAME}` }, type: "TXT" })
    .pipe(
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
    );

test.provider(
  "issues a wildcard from Let's Encrypt staging over Cloudflare DNS-01",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const account = yield* ACME.Account("Staging", {
            ca: ACME.LetsEncryptStaging,
            contact: ["mailto:ops@alchemy.run"],
            termsOfServiceAgreed: true,
          });
          const cert = yield* ACME.Certificate("StagingWildcard", {
            account,
            identifiers: [`*.${NAME}`, NAME],
            solver: { type: "Cloudflare.DNS", zoneId },
          });
          return { account, cert };
        }),
      );

      expect(deployed.account.accountUrl).toContain(
        "acme-staging-v02.api.letsencrypt.org",
      );
      expect(deployed.cert.issuer).toContain("STAGING");
      const parsed = yield* ACME.parseCertificate(deployed.cert.certificate);
      expect([...parsed.dnsNames].sort()).toEqual([`*.${NAME}`, NAME].sort());
      const now = yield* Effect.sync(() => Date.now());
      expect(Date.parse(deployed.cert.notAfter)).toBeGreaterThan(now);
      expect(Redacted.value(deployed.cert.privateKey)).toContain(
        "BEGIN PRIVATE KEY",
      );

      // The solver's finalizer removed every challenge record.
      expect(yield* challengeRecords(zoneId)).toEqual([]);

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
    timeout: 240_000,
  },
);
