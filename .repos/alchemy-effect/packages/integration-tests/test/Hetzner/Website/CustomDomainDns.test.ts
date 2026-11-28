import { resolve4, resolveNs, Resolver } from "node:dns/promises";
/**
 * Custom domains on a Hetzner website, deployed for real: `domain.dns`
 * publishes the `A` record through another DNS host (Cloudflare, resolved
 * publicly), and the default path (no `dns`) keeps the `Hetzner.RecordSet`
 * in `zone`. Hetzner sites serve plain HTTP (no TLS).
 */
import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@alchemy.run/cloudflare/Zone/lookup";
import * as Hetzner from "@alchemy.run/hetzner";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as dns from "@distilled.cloud/cloudflare/dns";
import * as servers from "@distilled.cloud/hetzner/servers";
import * as zoneRrsets from "@distilled.cloud/hetzner/zone_rrsets";
import * as zones from "@distilled.cloud/hetzner/zones";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as pathe from "pathe";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(Hetzner.providers(), Cloudflare.providers()),
});

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const hasHetznerCreds = !!process.env.HCLOUD_TOKEN;

const ZONE = process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";
const CLOUDFLARE_HOST = `hz-dns.${ZONE}`;
/**
 * Hetzner DNS only hosts zones for registrable domains ("unsupported tld"
 * for any subdomain). A unique, non-delegated zone keeps this suite off the
 * shared `alchemy-test-2.us` apex zone; its records are queried from
 * Hetzner's authoritative name servers directly.
 */
const HETZNER_ZONE = "hz-dns-zone-alchemy-test.us";
const HETZNER_RECORD_NAME = "www";
const HETZNER_HOST = `${HETZNER_RECORD_NAME}.${HETZNER_ZONE}`;
/** Hetzner assigns three name servers to every primary zone. */
const HETZNER_NAME_SERVER_COUNT = 3;

const fixtureDir = pathe.resolve(
  import.meta.dirname,
  "../../Cloudflare/Website/staticsite-fixture",
);
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

const normalize = (name: string | undefined) => (name ?? "").replace(/\.$/, "").toLowerCase();

class NotPublished extends Data.TaggedError("NotPublished")<{
  readonly server: string;
  readonly name: string;
}> {}

const cloudflareZoneId = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const zone = yield* findZoneByName({ accountId, name: ZONE });
  if (!zone) {
    return yield* Effect.die(new Error(`zone "${ZONE}" not found in account`));
  }
  return zone.id;
});

const cloudflareRecords = (zoneId: string, name: string, type: "A") =>
  dns.listRecords.items({ zoneId, name: { exact: name }, type }).pipe(
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );

const waitUntilServerGone = (id: number) =>
  servers.getServer({ id }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const waitUntilZoneGone = (zoneId: number) =>
  zones.getZone({ id_or_name: String(zoneId) }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

/**
 * Wait until every authoritative name server answers `name` with the
 * `expected` A records, so the first HTTP request never resolves (and
 * negatively caches) the hostname before it exists.
 */
const waitForAuthoritativeA = (
  nameServers: readonly string[],
  name: string,
  expected: readonly string[],
) =>
  Effect.gen(function* () {
    const addresses = (yield* Effect.forEach(nameServers, (ns) =>
      Effect.tryPromise(() => resolve4(normalize(ns))).pipe(Effect.orDie),
    )).flat();
    yield* Effect.forEach(addresses, (server) =>
      Effect.gen(function* () {
        const resolver = yield* Effect.sync(() => {
          const r = new Resolver();
          r.setServers([server]);
          return r;
        });
        const answers = yield* Effect.tryPromise(() => resolver.resolve4(name)).pipe(
          Effect.orElseSucceed(() => [] as string[]),
        );
        if (!expected.every((ip) => answers.includes(ip))) {
          return yield* Effect.fail(new NotPublished({ server, name }));
        }
      }).pipe(Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 20 })),
    );
  });

const cloneSite = cloneFixture(fixtureDir, {
  prefix: "alchemy-hetzner-dns-",
  tempRoot,
  entries: ["src", "build.sh"],
});

const siteProps = (cwd: string) => ({
  cwd,
  command: "bash build.sh",
  outdir: "dist",
});

const tags = [
  "provider:hetzner",
  "provider:hetzner:service",
  "provider:hetzner:website",
  "provider:cloudflare",
  "provider:cloudflare:dns",
  "live",
];

test.provider.skipIf(!hasHetznerCreds)(
  "Cloudflare DNS (no zone): A record at the Server IPv4, HTTP 200 on the hostname, removed on destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const zoneId = yield* cloudflareZoneId;
      const cwd = yield* cloneSite;

      yield* Effect.gen(function* () {
        const { site } = yield* stack.deploy(
          Effect.gen(function* () {
            const site = yield* Hetzner.Website.StaticSite("Site", {
              ...siteProps(cwd),
              domain: {
                name: CLOUDFLARE_HOST,
                dns: Cloudflare.DNS.Adapter(),
              },
            });
            return { site };
          }),
        );
        const ipv4 = site.server!.ipv4!;
        const url = site.url!;
        expect(url).toMatch(new RegExp(`^http://${CLOUDFLARE_HOST.replaceAll(".", "\\.")}:\\d+$`));

        const a = yield* cloudflareRecords(zoneId, CLOUDFLARE_HOST, "A");
        expect(a.map((record) => record.content)).toEqual([ipv4]);
        expect(a[0]?.proxied).toBe(false);

        const nameServers = yield* Effect.tryPromise(() => resolveNs(ZONE)).pipe(Effect.orDie);
        yield* waitForAuthoritativeA(nameServers, CLOUDFLARE_HOST, [ipv4]);
        yield* expectUrlContains(`${url}/`, "StaticSite fixture v1", {
          timeout: "120 seconds",
          label: "hetzner site on cloudflare dns",
        });

        const serverId = site.server!.serverId;
        yield* stack.destroy();
        expect(yield* cloudflareRecords(zoneId, CLOUDFLARE_HOST, "A")).toEqual([]);
        expect(yield* waitUntilServerGone(serverId)).toEqual("gone");
      }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.orDie)));
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);

test.provider.skipIf(!hasHetznerCreds)(
  "default path (no dns): the A RecordSet in a Hetzner.Zone points the hostname at the Server",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const cwd = yield* cloneSite;

      yield* Effect.gen(function* () {
        const { site, zone } = yield* stack.deploy(
          Effect.gen(function* () {
            const zone = yield* Hetzner.Zone("Zone", {
              name: HETZNER_ZONE,
              ttl: 300,
            });
            const site = yield* Hetzner.Website.StaticSite("Site", {
              ...siteProps(cwd),
              domain: HETZNER_HOST,
              zone,
            });
            return { site, zone };
          }),
        );
        expect(zone.assignedNameservers).toHaveLength(HETZNER_NAME_SERVER_COUNT);
        const ipv4 = site.server!.ipv4!;
        const url = site.url!;
        const port = new URL(url).port;
        expect(url).toBe(`http://${HETZNER_HOST}:${port}`);

        // The unchanged default: an A RecordSet in the Hetzner zone.
        const { rrset } = yield* zoneRrsets.getZoneRrset({
          id_or_name: String(zone.zoneId),
          rr_name: HETZNER_RECORD_NAME,
          rr_type: "A",
        });
        expect(rrset.records.map((record) => record.value)).toEqual([ipv4]);

        // Hetzner's name servers serve it (the zone is not delegated).
        yield* waitForAuthoritativeA(zone.assignedNameservers, HETZNER_HOST, [ipv4]);
        yield* expectUrlContains(`http://${ipv4}:${port}/`, "StaticSite fixture v1", {
          headers: { host: `${HETZNER_HOST}:${port}` },
          timeout: "120 seconds",
          label: "hetzner site on hetzner zone",
        });

        const serverId = site.server!.serverId;
        yield* stack.destroy();
        expect(yield* waitUntilZoneGone(zone.zoneId)).toEqual("gone");
        expect(yield* waitUntilServerGone(serverId)).toEqual("gone");
      }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.orDie)));
    }).pipe(logLevel),
  {
    tags: [
      "provider:hetzner",
      "provider:hetzner:recordset",
      "provider:hetzner:service",
      "provider:hetzner:website",
      "provider:hetzner:zone",
      "live",
    ],
    timeout: 600_000,
  },
);
