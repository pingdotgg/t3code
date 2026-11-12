import { resolve4, resolveNs, Resolver } from "node:dns/promises";
/**
 * `domain.dns` on a Fly website, deployed for real: the DNS adapter
 * publishes the Fly Certificate's ACME challenge `CNAME` and the site's
 * `A` / `AAAA` records, Fly issues the certificate, and the custom hostname
 * serves over HTTPS.
 */
import * as AWS from "@alchemy.run/aws";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@alchemy.run/cloudflare/Zone/lookup";
import * as Fly from "@alchemy.run/fly";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as route53 from "@distilled.cloud/aws/route-53";
import * as dns from "@distilled.cloud/cloudflare/dns";
import * as machines from "@distilled.cloud/fly-io/machines";
import * as Output from "alchemy/Output";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { assertAppGone, getText } from "./fixtures/deployment.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(Fly.providers(), Cloudflare.providers(), AWS.providers()),
});

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const ZONE = process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";
const CLOUDFLARE_HOST = `fly-dns.${ZONE}`;
const ROUTE53_ZONE = `fly-dns-r53.${ZONE}`;
const ROUTE53_HOST = ROUTE53_ZONE;
/** Route 53 always assigns four name servers to a public hosted zone. */
const ROUTE53_NAME_SERVER_COUNT = 4;

const normalize = (name: string | null | undefined) =>
  (name ?? "").replace(/\.$/, "").toLowerCase();

class NotPublished extends Data.TaggedError("NotPublished")<{
  readonly server: string;
  readonly name: string;
}> {}

class CertificateNotIssued extends Data.TaggedError("CertificateNotIssued")<{
  readonly hostname: string;
  readonly status: string | undefined;
}> {}

const cloudflareZoneId = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const zone = yield* findZoneByName({ accountId, name: ZONE });
  if (!zone) {
    return yield* Effect.die(new Error(`zone "${ZONE}" not found in account`));
  }
  return zone.id;
});

const cloudflareRecords = (zoneId: string, name: string, type: "A" | "AAAA" | "CNAME" | "NS") =>
  dns.listRecords.items({ zoneId, name: { exact: name }, type }).pipe(
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );

const route53Records = (hostedZoneId: string) =>
  route53
    .listResourceRecordSets({ HostedZoneId: hostedZoneId, MaxItems: 100 })
    .pipe(Effect.map((response) => response.ResourceRecordSets ?? []));

const assertHostedZoneGone = (hostedZoneId: string) =>
  route53.getHostedZone({ Id: hostedZoneId }).pipe(
    Effect.as(false),
    Effect.catchTag("NoSuchHostedZone", () => Effect.succeed(true)),
    Effect.repeat({
      until: (gone) => gone,
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
    Effect.tap((gone) => Effect.sync(() => expect(gone).toBe(true))),
  );

/**
 * Wait until every authoritative name server answers `name` with the
 * `expected` A records, so the first HTTPS request never resolves (and
 * negatively caches) the hostname before it exists.
 */
const waitForAuthoritativeA = (
  nameServers: readonly string[],
  name: string,
  expected: readonly string[],
) =>
  Effect.gen(function* () {
    const servers = (yield* Effect.forEach(nameServers, (ns) =>
      Effect.tryPromise(() => resolve4(normalize(ns))).pipe(Effect.orDie),
    )).flat();
    yield* Effect.forEach(servers, (server) =>
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

/**
 * Fly issues the ACME certificate once its challenge `CNAME` resolves;
 * `checkAppCertificate` re-runs validation on each poll.
 */
const waitForIssuedCertificate = (appName: string, hostname: string) =>
  machines.checkAppCertificate({ app_name: appName, hostname }).pipe(
    Effect.flatMap((checked) =>
      (checked.certificates ?? []).some(
        (certificate) => certificate.source === "fly" && certificate.status === "active",
      )
        ? Effect.succeed(checked)
        : Effect.fail(new CertificateNotIssued({ hostname, status: checked.status })),
    ),
    Effect.retry({
      while: (error) => error._tag === "CertificateNotIssued",
      schedule: Schedule.spaced("10 seconds"),
      times: 30,
    }),
  );

const serveOverHttps = (hostname: string) =>
  getText(`https://${hostname}/`).pipe(
    Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
  );

const cloneSite = Effect.gen(function* () {
  const path = yield* Path.Path;
  return yield* cloneFixture(
    path.resolve(import.meta.dirname, "../../Cloudflare/Website/staticsite-fixture"),
    {
      prefix: "alchemy-fly-dns-",
      tempRoot: path.resolve(import.meta.dirname, "../../../.tmp"),
      entries: ["src", "build.sh"],
    },
  );
});

const siteProps = (path: string) => ({
  path,
  build: { command: "bash build.sh", output: "dist" },
  memo: { include: ["src/**", "build.sh"] },
});

const tags = [
  "provider:fly",
  "provider:fly:certificate",
  "provider:fly:website",
  "provider:cloudflare",
  "provider:cloudflare:dns",
  "live",
];

test.provider(
  "Cloudflare DNS: ACME challenge CNAME + A/AAAA published, certificate issued, HTTPS 200, records removed on destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const zoneId = yield* cloudflareZoneId;
      const cwd = yield* cloneSite;

      yield* Effect.gen(function* () {
        const { site } = yield* stack.deploy(
          Effect.gen(function* () {
            const site = yield* Fly.Website.StaticSite("Site", {
              ...siteProps(cwd),
              domain: {
                name: CLOUDFLARE_HOST,
                dns: Cloudflare.DNS.Adapter(),
              },
            });
            return { site };
          }),
        );
        const appName = site.app!.appName;
        expect(site.url).toBe(`https://${CLOUDFLARE_HOST}`);
        const requirements = site.certificate!.dnsRequirements;
        const challenge = requirements?.acmeChallenge;
        expect(challenge?.target).toEqual(expect.any(String));
        const ip = site.ip!.ip;

        // The ACME challenge CNAME Fly lists, DNS-only.
        const [cname] = yield* cloudflareRecords(
          zoneId,
          `_acme-challenge.${CLOUDFLARE_HOST}`,
          "CNAME",
        );
        expect(normalize(cname?.content)).toBe(normalize(challenge!.target));
        expect(cname?.proxied).toBe(false);

        // A at the shared IPv4, AAAA at every IPv6 Fly lists.
        const a = yield* cloudflareRecords(zoneId, CLOUDFLARE_HOST, "A");
        expect(a.map((record) => record.content)).toEqual([ip]);
        const aaaa = yield* cloudflareRecords(zoneId, CLOUDFLARE_HOST, "AAAA");
        expect(aaaa.map((record) => record.content).sort()).toEqual(
          [...(requirements?.aaaa ?? [])].sort(),
        );

        yield* waitForIssuedCertificate(appName, CLOUDFLARE_HOST);

        const nameServers = yield* Effect.tryPromise(() => resolveNs(ZONE)).pipe(Effect.orDie);
        yield* waitForAuthoritativeA(nameServers, CLOUDFLARE_HOST, [ip]);
        expect(yield* serveOverHttps(CLOUDFLARE_HOST)).toContain("StaticSite fixture v1");

        yield* stack.destroy();
        expect(
          yield* cloudflareRecords(zoneId, `_acme-challenge.${CLOUDFLARE_HOST}`, "CNAME"),
        ).toEqual([]);
        expect(yield* cloudflareRecords(zoneId, CLOUDFLARE_HOST, "A")).toEqual([]);
        expect(yield* cloudflareRecords(zoneId, CLOUDFLARE_HOST, "AAAA")).toEqual([]);
        yield* assertAppGone(appName);
      }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.orDie)));
    }).pipe(logLevel),
  // Image build + Machine boot + ACME issuance through public DNS.
  { tags, timeout: 900_000 },
);

test.provider(
  "Route 53 DNS: records published in a delegated hosted zone, certificate issued, HTTPS 200",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const zoneId = yield* cloudflareZoneId;
      const cwd = yield* cloneSite;

      yield* Effect.gen(function* () {
        const { site, zone } = yield* stack.deploy(
          Effect.gen(function* () {
            const zone = yield* AWS.Route53.HostedZone("Zone", {
              name: ROUTE53_ZONE,
              forceDestroy: true,
            });
            // Delegate the hosted zone from the Cloudflare zone.
            for (let index = 0; index < ROUTE53_NAME_SERVER_COUNT; index++) {
              yield* Cloudflare.DNS.Record(`Delegation${index}`, {
                zoneId,
                name: ROUTE53_ZONE,
                type: "NS",
                content: Output.map(zone.nameServers, (nameServers) => nameServers[index]!),
              });
            }
            const site = yield* Fly.Website.StaticSite("Site", {
              ...siteProps(cwd),
              domain: {
                name: ROUTE53_HOST,
                dns: AWS.Route53.Adapter({ hostedZoneId: zone.id }),
              },
            });
            return { site, zone };
          }),
        );
        const appName = site.app!.appName;
        expect(site.url).toBe(`https://${ROUTE53_HOST}`);
        expect(zone.nameServers).toHaveLength(ROUTE53_NAME_SERVER_COUNT);
        const requirements = site.certificate!.dnsRequirements;
        const challenge = requirements?.acmeChallenge;
        expect(challenge?.target).toEqual(expect.any(String));
        const ip = site.ip!.ip;

        // The delegation is live in Cloudflare.
        const delegation = yield* cloudflareRecords(zoneId, ROUTE53_ZONE, "NS");
        expect(delegation.map((record) => normalize(record.content)).sort()).toEqual(
          zone.nameServers.map(normalize).sort(),
        );

        // The records live in Route 53, not Cloudflare.
        const sets = yield* route53Records(zone.id);
        const find = (name: string, type: string) =>
          sets.find((set) => normalize(set.Name) === name && set.Type === type);
        expect(
          find(`_acme-challenge.${ROUTE53_HOST}`, "CNAME")?.ResourceRecords?.map((record) =>
            normalize(record.Value),
          ),
        ).toEqual([normalize(challenge!.target)]);
        expect(find(ROUTE53_HOST, "A")?.ResourceRecords?.map((record) => record.Value)).toEqual([
          ip,
        ]);
        expect(yield* cloudflareRecords(zoneId, ROUTE53_HOST, "A")).toEqual([]);

        yield* waitForIssuedCertificate(appName, ROUTE53_HOST);

        yield* waitForAuthoritativeA(zone.nameServers, ROUTE53_HOST, [ip]);
        expect(yield* serveOverHttps(ROUTE53_HOST)).toContain("StaticSite fixture v1");

        yield* stack.destroy();
        yield* assertHostedZoneGone(zone.id);
        expect(yield* cloudflareRecords(zoneId, ROUTE53_ZONE, "NS")).toEqual([]);
        yield* assertAppGone(appName);
      }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.orDie)));
    }).pipe(logLevel),
  // Image build + Machine boot + ACME issuance through a delegated zone.
  { tags: [...tags, "provider:aws", "provider:aws:route53"], timeout: 900_000 },
);
