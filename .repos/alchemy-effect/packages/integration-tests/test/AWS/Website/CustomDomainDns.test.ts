import { resolve4, resolveNs, Resolver } from "node:dns/promises";
import { fileURLToPath } from "node:url";
/**
 * Custom domains on AWS website composites through each DNS host `domain.dns`
 * can name — live deployments served over HTTPS:
 *
 * - `Cloudflare.DNS.Adapter()` on a `StaticSite` (canonical name + alias) and
 *   on a `Router` whose attached `StaticSite` binds an extra hostname onto the
 *   Router's record set.
 * - The Route 53 default (no `dns`): a plain-string domain under a Route 53
 *   zone delegated from the standing Cloudflare test zone; the zone is
 *   inferred.
 * - `Hetzner.DNS.Adapter({ zone })` on a subdomain delegated from the
 *   Cloudflare test zone to Hetzner's nameservers.
 *
 * Skipped under --fast: every test deploys (and deletes) a CloudFront
 * distribution and waits for ACM issuance — minutes each (speed doctrine).
 * The tests run concurrently.
 */
import * as AWS from "@alchemy.run/aws";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@alchemy.run/cloudflare/Zone/lookup";
import * as Hetzner from "@alchemy.run/hetzner";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as acm from "@distilled.cloud/aws/acm";
import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import { Region } from "@distilled.cloud/aws/Region";
import * as route53 from "@distilled.cloud/aws/route-53";
import * as dns from "@distilled.cloud/cloudflare/dns";
import * as zoneRrsets from "@distilled.cloud/hetzner/zone_rrsets";
import * as zones from "@distilled.cloud/hetzner/zones";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

const { test } = Test.make({
  providers: Layer.mergeAll(AWS.providers(), Cloudflare.providers(), Hetzner.providers()),
});

// Anchor the fixture to the repo root regardless of the runner's cwd.
const fixtureDir = fileURLToPath(
  new URL("../../../../../examples/aws-static-site/site", import.meta.url),
);

const ZONE = process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

const CF_SITE = `aws-site-cf.${ZONE}`;
const CF_SITE_ALIAS = `aws-site-cf-alias.${ZONE}`;
const ROUTER_HOST = `aws-site-router.${ZONE}`;
const ROUTER_DOCS_HOST = `aws-site-router-docs.${ZONE}`;
const R53_ZONE = `aws-site-r53.${ZONE}`;
const R53_SITE = `www.${R53_ZONE}`;
// Hetzner DNS only hosts registrable apex zones ("unsupported tld" for a
// subdomain zone), so the Hetzner zone is the apex itself and Cloudflare
// delegates just this subdomain to Hetzner's nameservers. Zone names are
// unique per Hetzner account: a concurrent suite owning the same apex zone
// makes this test's zone read as unowned.
const HZ_DELEGATED = `aws-site-hz.${ZONE}`;
const HZ_SITE = `www.${HZ_DELEGATED}`;

class NotYet extends Data.TaggedError("NotYet")<{ readonly what: string }> {}

const bare = (name: string) => name.replace(/\.$/, "").toLowerCase();

const cloudflareZoneId = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const zone = yield* findZoneByName({ accountId, name: ZONE });
  if (!zone) {
    return yield* Effect.die(new Error(`zone "${ZONE}" not found in account`));
  }
  return zone.id;
});

const listCloudflareRecords = (zoneId: string, name: string, type: "CNAME" | "NS") =>
  dns.listRecords.items({ zoneId, name: { exact: name }, type }).pipe(
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );

/** NS records in the Cloudflare zone delegating `name` to `nameServers`. */
const delegate = (zoneId: string, name: string, nameServers: readonly string[]) =>
  Effect.forEach(nameServers, (nameServer, index) =>
    Cloudflare.DNS.Record(`Delegation${index + 1}`, {
      zoneId,
      name,
      type: "NS",
      content: bare(nameServer),
    }),
  );

const cloudflareNameServers = Effect.tryPromise(() => resolveNs(ZONE)).pipe(Effect.orDie);

/**
 * Wait until every authoritative nameserver answers `name` acceptably, so
 * the first HTTPS request never resolves (and negatively caches) the
 * hostname before it exists.
 */
const waitForAuthoritative = (
  nameServers: readonly string[],
  name: string,
  query: (resolver: Resolver, name: string) => Promise<string[]>,
  accept: (answers: string[]) => boolean,
) =>
  Effect.gen(function* () {
    const servers = (yield* Effect.forEach(nameServers, (nameServer) =>
      Effect.tryPromise(() => resolve4(bare(nameServer))).pipe(Effect.orDie),
    )).flat();
    yield* Effect.forEach(
      servers,
      (server) =>
        Effect.gen(function* () {
          const resolver = yield* Effect.sync(() => {
            const r = new Resolver();
            r.setServers([server]);
            return r;
          });
          const answers = yield* Effect.tryPromise(() => query(resolver, name)).pipe(
            Effect.orElseSucceed(() => [] as string[]),
          );
          if (!accept(answers)) {
            return yield* new NotYet({ what: `${name} @ ${server}` });
          }
        }).pipe(Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 20 })),
      { discard: true },
    );
  });

const cnameTo =
  (target: string) =>
  (answers: string[]): boolean =>
    answers.some((answer) => bare(answer) === bare(target));

const queryCname = (resolver: Resolver, name: string) => resolver.resolveCname(name);

const queryA = (resolver: Resolver, name: string) => resolver.resolve4(name);

/** `https://{hostname}/` answers 200 — bounded through the edge rollout. */
const expectServesHttps = (hostname: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const status = yield* client.get(`https://${hostname}/`).pipe(
      Effect.flatMap((res): Effect.Effect<number, NotYet> =>
        res.status === 200
          ? Effect.succeed(res.status)
          : Effect.fail(new NotYet({ what: `https://${hostname}/ -> ${res.status}` })),
      ),
      Effect.retry({ schedule: Schedule.spaced("10 seconds"), times: 60 }),
    );
    expect(status).toBe(200);
  });

/** The distribution's viewer certificate, read from ACM. */
const viewerCertificateOf = (distributionId: string) =>
  Effect.gen(function* () {
    const { DistributionConfig } = yield* cloudfront.getDistributionConfig({
      Id: distributionId,
    });
    const certificateArn = DistributionConfig?.ViewerCertificate?.ACMCertificateArn;
    expect(certificateArn).toBeDefined();
    const { Certificate } = yield* acm
      .describeCertificate({ CertificateArn: certificateArn! })
      .pipe(Effect.provideService(Region, Effect.succeed("us-east-1" as const)));
    expect(Certificate).toBeDefined();
    return {
      certificate: Certificate!,
      aliases: DistributionConfig?.Aliases?.Items ?? [],
    };
  });

const expectRecordsGone = (zoneId: string, names: readonly string[], type: "CNAME" | "NS") =>
  Effect.forEach(names, (name) =>
    listCloudflareRecords(zoneId, name, type).pipe(
      Effect.map((records) => expect(records).toHaveLength(0)),
    ),
  );

describe.skipIf(!!process.env.FAST)(
  "AWS.Website custom domain DNS (live)",
  {
    concurrent: true,
    tags: [
      "provider:aws",
      "provider:aws:acm",
      "provider:aws:cloudfront",
      "provider:aws:route53",
      "provider:aws:website",
      "provider:cloudflare",
      "provider:cloudflare:dns",
      "provider:hetzner",
      "live",
    ],
  },
  () => {
    test.provider(
      "StaticSite on Cloudflare DNS serves its name and alias over HTTPS",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const zoneId = yield* cloudflareZoneId;

          const site = yield* stack.deploy(
            Effect.gen(function* () {
              const site = yield* AWS.Website.StaticSite("Site", {
                path: fixtureDir,
                forceDestroy: true,
                domain: {
                  name: CF_SITE,
                  aliases: [CF_SITE_ALIAS],
                  dns: Cloudflare.DNS.Adapter(),
                },
              });
              return {
                urls: site.urls,
                distributionId: site.distribution!.distributionId,
                domainName: site.distribution!.domainName as unknown as string,
              };
            }),
          );
          expect(site.urls.slice(0, 2)).toEqual([`https://${CF_SITE}`, `https://${CF_SITE_ALIAS}`]);

          // Each hostname is a DNS-only CNAME to the distribution.
          for (const name of [CF_SITE, CF_SITE_ALIAS]) {
            const records = yield* listCloudflareRecords(zoneId, name, "CNAME");
            expect(records).toHaveLength(1);
            expect(bare(records[0]!.content!)).toBe(bare(site.domainName));
            expect(records[0]!.proxied).toBe(false);
          }

          // The certificate was validated through Cloudflare and is issued.
          const { certificate, aliases } = yield* viewerCertificateOf(site.distributionId);
          expect(aliases).toEqual(expect.arrayContaining([CF_SITE, CF_SITE_ALIAS]));
          expect(certificate.Status).toBe("ISSUED");
          expect(certificate.SubjectAlternativeNames).toEqual(
            expect.arrayContaining([CF_SITE, CF_SITE_ALIAS]),
          );
          const validation = (certificate.DomainValidationOptions ?? []).map(
            (option) => option.ResourceRecord,
          );
          expect(validation.length).toBeGreaterThan(0);
          for (const record of validation) {
            expect(record).toBeDefined();
            const published = yield* listCloudflareRecords(zoneId, bare(record!.Name), "CNAME");
            expect(published.map((r) => bare(r.content!))).toContain(bare(record!.Value));
          }

          const nameServers = yield* cloudflareNameServers;
          for (const name of [CF_SITE, CF_SITE_ALIAS]) {
            yield* waitForAuthoritative(nameServers, name, queryCname, cnameTo(site.domainName));
            yield* expectServesHttps(name);
          }

          yield* stack.destroy();
          yield* expectRecordsGone(zoneId, [CF_SITE, CF_SITE_ALIAS], "CNAME");
        }),
      { timeout: 2_400_000 },
    );

    test.provider(
      "Router on Cloudflare DNS serves an attached site's bound hostname over HTTPS",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const zoneId = yield* cloudflareZoneId;

          const deployed = yield* stack.deploy(
            Effect.gen(function* () {
              const router = yield* AWS.Website.Router("Router", {
                domain: { name: ROUTER_HOST, dns: Cloudflare.DNS.Adapter() },
              });
              // `domain: { name, router }` alone binds the hostname onto the
              // Router's distribution, certificate, and record set.
              const docs = yield* AWS.Website.StaticSite("Docs", {
                path: fixtureDir,
                forceDestroy: true,
                domain: { name: ROUTER_DOCS_HOST, router },
              });
              return {
                distributionId: router.distributionId as unknown as string,
                domainName: router.distribution.domainName as unknown as string,
                docsUrl: docs.url,
              };
            }),
          );
          expect(deployed.docsUrl).toBe(`https://${ROUTER_DOCS_HOST}`);

          // The Router's own hostname and the bound hostname are DNS-only
          // CNAMEs to the Router's distribution.
          for (const name of [ROUTER_HOST, ROUTER_DOCS_HOST]) {
            const records = yield* listCloudflareRecords(zoneId, name, "CNAME");
            expect(records).toHaveLength(1);
            expect(bare(records[0]!.content!)).toBe(bare(deployed.domainName));
            expect(records[0]!.proxied).toBe(false);
          }

          const { certificate, aliases } = yield* viewerCertificateOf(deployed.distributionId);
          expect(aliases).toEqual(expect.arrayContaining([ROUTER_HOST, ROUTER_DOCS_HOST]));
          expect(certificate.Status).toBe("ISSUED");
          expect(certificate.SubjectAlternativeNames).toContain(ROUTER_DOCS_HOST);

          yield* waitForAuthoritative(
            yield* cloudflareNameServers,
            ROUTER_DOCS_HOST,
            queryCname,
            cnameTo(deployed.domainName),
          );
          yield* expectServesHttps(ROUTER_DOCS_HOST);

          yield* stack.destroy();
          yield* expectRecordsGone(zoneId, [ROUTER_HOST, ROUTER_DOCS_HOST], "CNAME");
        }),
      { timeout: 2_400_000 },
    );

    test.provider(
      "StaticSite without `dns` infers a Route 53 zone and serves over HTTPS",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const cfZoneId = yield* cloudflareZoneId;

          const hostedZone = AWS.Route53.HostedZone("Zone", {
            name: R53_ZONE,
            forceDestroy: true,
          });
          // The zone must exist before the site's certificate and alias
          // record infer it at reconcile time.
          const { nameServers } = yield* stack.deploy(hostedZone);
          expect(nameServers).toHaveLength(4);

          const deployed = yield* stack.deploy(
            Effect.gen(function* () {
              const zone = yield* hostedZone;
              yield* delegate(cfZoneId, R53_ZONE, nameServers);
              const site = yield* AWS.Website.StaticSite("Site", {
                path: fixtureDir,
                forceDestroy: true,
                domain: R53_SITE,
              });
              return {
                hostedZoneId: zone.id,
                url: site.url,
                distributionId: site.distribution!.distributionId,
                domainName: site.distribution!.domainName as unknown as string,
              };
            }),
          );
          expect(deployed.url).toBe(`https://${R53_SITE}`);

          // Cloudflare delegates the subdomain to Route 53.
          const delegation = yield* listCloudflareRecords(cfZoneId, R53_ZONE, "NS");
          expect(delegation.map((r) => bare(r.content!)).sort()).toEqual(
            nameServers.map(bare).sort(),
          );

          // An `A` alias record at the distribution in the inferred zone.
          const { ResourceRecordSets } = yield* route53.listResourceRecordSets({
            HostedZoneId: deployed.hostedZoneId,
            StartRecordName: `${R53_SITE}.`,
            StartRecordType: "A",
            MaxItems: 1,
          });
          const alias = ResourceRecordSets?.[0];
          expect(alias?.Name).toBe(`${R53_SITE}.`);
          expect(alias?.Type).toBe("A");
          expect(bare(alias?.AliasTarget?.DNSName ?? "")).toBe(bare(deployed.domainName));

          const { certificate } = yield* viewerCertificateOf(deployed.distributionId);
          expect(certificate.Status).toBe("ISSUED");

          yield* waitForAuthoritative(
            nameServers,
            R53_SITE,
            queryA,
            (answers) => answers.length > 0,
          );
          yield* expectServesHttps(R53_SITE);

          yield* stack.destroy();
          const zoneGone = yield* route53.getHostedZone({ Id: deployed.hostedZoneId }).pipe(
            Effect.as(false),
            Effect.catchTag("NoSuchHostedZone", () => Effect.succeed(true)),
            Effect.repeat({
              schedule: Schedule.spaced("2 seconds"),
              until: (gone) => gone,
              times: 10,
            }),
          );
          expect(zoneGone).toBe(true);
          yield* expectRecordsGone(cfZoneId, [R53_ZONE], "NS");
        }),
      { timeout: 2_400_000 },
    );

    test.provider.skipIf(!process.env.HCLOUD_TOKEN)(
      "StaticSite on Hetzner DNS serves a delegated subdomain over HTTPS",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const cfZoneId = yield* cloudflareZoneId;

          const hetznerZone = Hetzner.Zone("Zone", { name: ZONE, ttl: 300 });
          const { assignedNameservers } = yield* stack.deploy(hetznerZone);
          expect(assignedNameservers.length).toBeGreaterThan(0);

          const deployed = yield* stack.deploy(
            Effect.gen(function* () {
              const zone = yield* hetznerZone;
              yield* delegate(cfZoneId, HZ_DELEGATED, assignedNameservers);
              const site = yield* AWS.Website.StaticSite("Site", {
                path: fixtureDir,
                forceDestroy: true,
                domain: { name: HZ_SITE, dns: Hetzner.DNS.Adapter({ zone }) },
              });
              return {
                zoneId: zone.zoneId,
                url: site.url,
                distributionId: site.distribution!.distributionId,
                domainName: site.distribution!.domainName as unknown as string,
              };
            }),
          );
          expect(deployed.url).toBe(`https://${HZ_SITE}`);

          // The hostname is a CNAME to the distribution in the Hetzner zone.
          const { rrset } = yield* zoneRrsets.getZoneRrset({
            id_or_name: String(deployed.zoneId),
            rr_name: HZ_SITE.slice(0, -(ZONE.length + 1)),
            rr_type: "CNAME",
          });
          expect(rrset.records.map((r) => bare(r.value))).toEqual([bare(deployed.domainName)]);

          const { certificate } = yield* viewerCertificateOf(deployed.distributionId);
          expect(certificate.Status).toBe("ISSUED");

          yield* waitForAuthoritative(
            assignedNameservers,
            HZ_SITE,
            queryCname,
            cnameTo(deployed.domainName),
          );
          yield* expectServesHttps(HZ_SITE);

          yield* stack.destroy();
          const zoneGone = yield* zones.getZone({ id_or_name: String(deployed.zoneId) }).pipe(
            Effect.as(false),
            Effect.catchTag("NotFound", () => Effect.succeed(true)),
            Effect.repeat({
              schedule: Schedule.spaced("2 seconds"),
              until: (gone) => gone,
              times: 10,
            }),
          );
          expect(zoneGone).toBe(true);
          yield* expectRecordsGone(cfZoneId, [HZ_DELEGATED], "NS");
        }),
      { timeout: 2_400_000 },
    );
  },
);
