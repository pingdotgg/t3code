import { adopt } from "@/AdoptPolicy";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const zoneName =
  process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

const resolveZone = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const zone = yield* findZoneByName({ accountId, name: zoneName });
  if (!zone) {
    return yield* Effect.die(
      new Error(`zone "${zoneName}" not found in account`),
    );
  }
  return zone;
});

// Cloudflare has restricted Web3 gateways for new customers; on accounts
// without the entitlement, creation fails with the typed
// `Web3HostnameNotEntitled` error (Cloudflare code 10000-class "Web3
// gateways are not enabled"). The deploy+presence test is therefore gated
// behind a Web3-entitled account flag; the read-only list assertion below
// runs unconditionally.
const web3Entitled = !!process.env.CLOUDFLARE_TEST_WEB3;

// Read-only: `list()` enumerates Web3 hostnames across every zone via
// `listAllZones`. On a non-entitled account each per-zone list answers
// `Forbidden` and is skipped, so the result is a well-typed (possibly
// empty) array. This always runs and proves the enumeration shape.
test.provider("list returns a well-typed array of web3 hostnames", (stack) =>
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(Cloudflare.Web3.Hostname);
    const all = yield* provider.list();

    expect(Array.isArray(all)).toBe(true);
    for (const item of all) {
      expect(typeof item.hostnameId).toBe("string");
      expect(typeof item.zoneId).toBe("string");
      expect(typeof item.name).toBe("string");
    }

    // Keep the destroy bookend so the harness state stays clean.
    yield* stack.destroy();
  }).pipe(logLevel),
);

// Deploy a real Web3 hostname and assert `list()` surfaces it. Gated behind
// a Web3-entitled account (`CLOUDFLARE_TEST_WEB3=1`); on the default
// (non-entitled) testing account creation fails with the typed
// `Web3HostnameNotEntitled` error.
test.provider.skipIf(!web3Entitled)(
  "list surfaces a deployed web3 hostname (entitled account)",
  (stack) =>
    Effect.gen(function* () {
      const zone = yield* resolveZone;
      const name = `alchemy-web3-list.${zone.name}`;

      yield* stack.destroy();

      const hostname = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Web3.Hostname("ListHostname", {
            zoneId: zone.id,
            name,
            target: "ipfs_universal_path",
          }).pipe(adopt(true));
        }),
      );

      const provider = yield* Provider.findProvider(Cloudflare.Web3.Hostname);
      const all = yield* provider.list();

      expect(all.some((h) => h.hostnameId === hostname.hostnameId)).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
