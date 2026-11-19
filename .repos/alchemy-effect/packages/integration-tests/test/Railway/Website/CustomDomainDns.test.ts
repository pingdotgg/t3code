import { resolve4, resolveNs, Resolver } from "node:dns/promises";
/**
 * `domain.dns` on Railway websites, deployed for real: a StaticSite whose
 * custom hostname is published through a DNS adapter (Cloudflare, and a
 * Route 53 zone delegated from the Cloudflare test zone). Asserts the
 * records land in the DNS host exactly as `Railway.CustomDomain.dnsRecords`
 * reports them, Railway verifies the hostname and serves HTTPS on it, and
 * destroy removes both the records and the Railway custom domain.
 *
 * `test/Railway` is excluded from the default `pnpm test` set; run it
 * explicitly.
 */
import * as AWS from "@alchemy.run/aws";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@alchemy.run/cloudflare/Zone/lookup";
import * as Railway from "@alchemy.run/railway";
import type { CustomDomainDnsRecord } from "@alchemy.run/railway/CustomDomain";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as route53 from "@distilled.cloud/aws/route-53";
import * as dns from "@distilled.cloud/cloudflare/dns";
import { Query } from "@distilled.cloud/core/query";
import { Railway as RailwayApi } from "@distilled.cloud/railway";
import * as Output from "alchemy/Output";
import { isResourceState, State } from "alchemy/State";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as pathe from "pathe";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { suitePartition } from "../suiteProject.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(Railway.providers(), Cloudflare.providers(), AWS.providers()),
});

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const ZONE = "alchemy-test-2.us";
const HOSTNAME = `rw-dns.${ZONE}`;
const R53_ZONE = `rw-dns-r53.${ZONE}`;
const R53_HOSTNAME = `www.${R53_ZONE}`;
const MARKER = "StaticSite fixture v1";

const fixtureDir = pathe.resolve(
  import.meta.dirname,
  "../../Cloudflare/Website/staticsite-fixture",
);
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

const tags = [
  "provider:railway",
  "provider:railway:customdomain",
  "provider:railway:website",
  "provider:cloudflare",
  "provider:cloudflare:dns",
  "live",
];

class RecordNotPublished extends Data.TaggedError("RecordNotPublished")<{
  readonly server: string;
  readonly name: string;
  readonly type: string;
}> {}

class DomainNotVerified extends Data.TaggedError("DomainNotVerified")<{
  readonly verified: boolean | null | undefined;
  readonly certificateStatus: string | undefined;
}> {}

class SiteNotServing extends Data.TaggedError("SiteNotServing")<{
  readonly status: number;
}> {}

interface PublishedRecord {
  name: string;
  type: string;
  value: string;
}

const trimDot = (value: string) => value.replace(/\.$/, "").toLowerCase();
const unquote = (value: string) => value.replace(/^"|"$/g, "");

const normalize = (records: ReadonlyArray<PublishedRecord>) =>
  records
    .map((record) => ({
      name: trimDot(record.name),
      type: record.type,
      value: record.type === "TXT" ? unquote(record.value) : trimDot(record.value),
    }))
    .sort((a, b) =>
      `${a.name}|${a.type}|${a.value}`.localeCompare(`${b.name}|${b.type}|${b.value}`),
    );

const underHostname = (name: string, hostname: string) =>
  trimDot(name) === hostname || trimDot(name).endsWith(`.${hostname}`);

const resolveZone = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const zone = yield* findZoneByName({ accountId, name: ZONE });
  if (!zone) {
    return yield* Effect.die(new Error(`zone "${ZONE}" not found`));
  }
  const nameServers = yield* Effect.tryPromise(() => resolveNs(ZONE)).pipe(Effect.orDie);
  return { id: zone.id, nameServers };
});

/** Every Cloudflare record at or below `hostname` (DNS-only records only). */
const cloudflareRecordsUnder = (zoneId: string, hostname: string) =>
  dns.listRecords.items({ zoneId, name: { endswith: hostname } }).pipe(
    Stream.runCollect,
    Effect.map((chunk) =>
      Array.from(chunk).filter((record) => underHostname(record.name, hostname)),
    ),
  );

/** Every Route 53 record at or below `hostname`, excluding the zone's NS/SOA. */
const route53RecordsUnder = (hostedZoneId: string, hostname: string) =>
  route53.listResourceRecordSets({ HostedZoneId: hostedZoneId }).pipe(
    Effect.map((result) =>
      (result.ResourceRecordSets ?? [])
        .filter(
          (set) => set.Type !== "NS" && set.Type !== "SOA" && underHostname(set.Name, hostname),
        )
        .flatMap((set) =>
          (set.ResourceRecords ?? []).map((record) => ({
            name: set.Name,
            type: set.Type,
            value: record.Value,
          })),
        ),
    ),
  );

/**
 * The persisted Attributes of the website's `Railway.CustomDomain`
 * (`{siteId}/Domain`), i.e. what the resource reported on deploy.
 */
const customDomainAttrs = (
  stack: Test.ScratchStack,
  siteId: string,
): Effect.Effect<Railway.CustomDomain["Attributes"]> =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    const row = yield* state.get({
      stack: stack.name,
      stage: stack.stage,
      fqn: `${siteId}/Domain`,
    });
    if (!row || !isResourceState(row) || row.attr === undefined) {
      return yield* Effect.die(new Error(`no ${siteId}/Domain state row`));
    }
    return row.attr as Railway.CustomDomain["Attributes"];
  }).pipe(Effect.provide(stack.state), Effect.orDie);

const liveDomain = Query.fn((id: string, projectId: string) => {
  const domain = RailwayApi.customDomain({ id, projectId });
  return {
    id: domain.id,
    domain: domain.domain,
    deletedAt: domain.deletedAt,
    syncStatus: domain.syncStatus,
    status: {
      verified: domain.status.verified,
      certificateStatus: domain.status.certificateStatus,
      verificationDnsHost: domain.status.verificationDnsHost,
      verificationToken: domain.status.verificationToken,
      dnsRecords: domain.status.dnsRecords.pipe(
        Query.map((record) => ({
          fqdn: record.fqdn,
          zone: record.zone,
          recordType: record.recordType,
          requiredValue: record.requiredValue,
        })),
      ),
    },
  };
});

/**
 * Railway's raw `status.dnsRecords` (plus its ownership TXT) must each be
 * published: the mapping in `Railway.CustomDomain` qualifies zone-relative
 * `fqdn`s, so compare either form.
 */
const expectRailwayRecordsPublished = (
  live: Effect.Success<ReturnType<typeof liveDomain>>,
  published: ReadonlyArray<PublishedRecord>,
) => {
  const records = normalize(published);
  const has = (type: string, host: string, zone: string, value: string) =>
    records.some(
      (record) =>
        record.type === type &&
        record.value === (type === "TXT" ? unquote(value) : trimDot(value)) &&
        (record.name === trimDot(host) || record.name === `${trimDot(host)}.${trimDot(zone)}`),
    );
  const required = live.status.dnsRecords.filter((record) =>
    ["DNS_RECORD_TYPE_CNAME", "DNS_RECORD_TYPE_A", "DNS_RECORD_TYPE_TXT"].includes(
      record.recordType,
    ),
  );
  expect(required.length).toBeGreaterThan(0);
  for (const record of required) {
    expect(
      has(
        record.recordType.replace("DNS_RECORD_TYPE_", ""),
        record.fqdn,
        record.zone,
        record.requiredValue,
      ),
    ).toBe(true);
  }
  const host = live.status.verificationDnsHost;
  const token = live.status.verificationToken;
  if (host && token) {
    expect(has("TXT", host, required[0]?.zone ?? ZONE, token)).toBe(true);
  }
};

/**
 * Wait until every authoritative nameserver answers each record (local
 * resolvers negative-cache the hostname).
 */
const waitForAuthoritative = (
  nameServers: ReadonlyArray<string>,
  records: ReadonlyArray<CustomDomainDnsRecord>,
) =>
  Effect.gen(function* () {
    const servers = (yield* Effect.forEach(nameServers, (ns) =>
      Effect.tryPromise(() => resolve4(trimDot(ns))).pipe(Effect.orDie),
    )).flat();
    yield* Effect.forEach(servers, (server) =>
      Effect.forEach(records, (record) =>
        Effect.gen(function* () {
          const resolver = yield* Effect.sync(() => {
            const r = new Resolver();
            r.setServers([server]);
            return r;
          });
          const answers = yield* Effect.tryPromise(() =>
            record.type === "TXT"
              ? resolver
                  .resolveTxt(record.name)
                  .then((rows) => rows.map((chunks) => chunks.join("")))
              : record.type === "CNAME"
                ? resolver.resolveCname(record.name)
                : resolver.resolve4(record.name),
          ).pipe(Effect.orElseSucceed(() => [] as string[]));
          if (
            !answers.some(
              (answer) => trimDot(answer) === trimDot(record.value) || answer === record.value,
            )
          ) {
            return yield* Effect.fail(
              new RecordNotPublished({
                server,
                name: record.name,
                type: record.type,
              }),
            );
          }
        }).pipe(Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 20 })),
      ),
    );
  });

/** Railway verifies ownership and issues the certificate. */
const waitUntilVerified = (customDomainId: string, projectId: string) =>
  liveDomain(customDomainId, projectId).pipe(
    Effect.flatMap((domain) =>
      domain.status.verified === true
        ? Effect.succeed(domain)
        : Effect.fail(
            new DomainNotVerified({
              verified: domain.status.verified,
              certificateStatus: domain.status.certificateStatus ?? undefined,
            }),
          ),
    ),
    Effect.tapError((error) => Effect.logInfo("Railway domain pending", error)),
    Effect.retry({
      while: (error) => error._tag === "DomainNotVerified",
      schedule: Schedule.spaced("10 seconds"),
      times: 30,
    }),
  );

const waitUntilServing = (hostname: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.get(`https://${hostname}/`).pipe(
      Effect.flatMap(
        (res): Effect.Effect<string, HttpClientError.HttpClientError | SiteNotServing> =>
          res.status === 200 ? res.text : Effect.fail(new SiteNotServing({ status: res.status })),
      ),
      Effect.timeout("10 seconds"),
      Effect.tapError((error) =>
        Effect.logInfo(
          `https://${hostname} not serving yet: ${error._tag === "SiteNotServing" ? `HTTP ${error.status}` : error.message}`,
        ),
      ),
      Effect.retry({ schedule: Schedule.spaced("10 seconds"), times: 30 }),
    );
  });

const readDomainDeletion = Query.fn((id: string, projectId: string) => {
  const domain = RailwayApi.customDomain({ id, projectId });
  return { deletedAt: domain.deletedAt, syncStatus: domain.syncStatus };
});

const waitUntilDomainGone = (customDomainId: string, projectId: string) =>
  readDomainDeletion(customDomainId, projectId).pipe(
    Effect.map((domain) =>
      domain.deletedAt != null || domain.syncStatus === "DELETED"
        ? ("gone" as const)
        : ("found" as const),
    ),
    Effect.catchTag("RailwayNotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 15,
    }),
  );

const cloneSite = cloneFixture(fixtureDir, {
  prefix: "alchemy-railway-dns-",
  tempRoot,
  entries: ["src", "build.sh"],
});

// Sequential: concurrent Railway builds in the shared suite project can
// outlast the Service's bounded deploy wait.
describe.sequential("Railway.Website domain.dns (live)", () => {
  test.provider(
    "Cloudflare DNS publishes Railway's records; the hostname verifies and serves HTTPS",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const zone = yield* resolveZone;
        const cwd = yield* cloneSite;

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const { project, environment } = yield* suitePartition;
            const site = yield* Railway.Website.StaticSite("Site", {
              project,
              environment,
              cwd,
              command: "bash build.sh",
              shell: true,
              outdir: "dist",
              domain: { name: HOSTNAME, dns: Cloudflare.DNS.Adapter() },
            });
            return { site, environment };
          }),
        );
        expect(deployed.site.url).toBe(`https://${HOSTNAME}`);

        const attrs = yield* customDomainAttrs(stack, "Site");
        expect(attrs.domain).toBe(HOSTNAME);
        expect(attrs.serviceId).toBe(deployed.site.service!.serviceId);
        expect(attrs.dnsRecords.length).toBeGreaterThan(0);
        expect(
          attrs.dnsRecords.some(
            (record) => record.type === "CNAME" && trimDot(record.name) === HOSTNAME,
          ),
        ).toBe(true);
        expect(attrs.dnsRecords.some((record) => record.type === "TXT")).toBe(true);

        // Cloudflare holds exactly the records the CustomDomain reports, DNS-only.
        const published = yield* cloudflareRecordsUnder(zone.id, HOSTNAME);
        expect(
          normalize(
            published.map((record) => ({
              name: record.name,
              type: record.type,
              value: record.content ?? "",
            })),
          ),
        ).toEqual(normalize(attrs.dnsRecords));
        expect(published.every((record) => record.proxied !== true)).toBe(true);

        // ...and those are the records Railway's live API requires.
        const live = yield* liveDomain(attrs.customDomainId, attrs.projectId);
        expectRailwayRecordsPublished(
          live,
          published.map((record) => ({
            name: record.name,
            type: record.type,
            value: record.content ?? "",
          })),
        );

        yield* waitForAuthoritative(zone.nameServers, attrs.dnsRecords);
        const verified = yield* waitUntilVerified(attrs.customDomainId, attrs.projectId);
        expect(verified.status.verified).toBe(true);
        expect(yield* waitUntilServing(HOSTNAME)).toContain(MARKER);

        yield* stack.destroy();

        expect(yield* cloudflareRecordsUnder(zone.id, HOSTNAME)).toEqual([]);
        expect(yield* waitUntilDomainGone(attrs.customDomainId, attrs.projectId)).toBe("gone");
      }).pipe(logLevel),
    { tags, timeout: 900_000 },
  );

  test.provider(
    "Route 53 (delegated from Cloudflare) publishes Railway's records; the hostname verifies and serves HTTPS",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const zone = yield* resolveZone;
        const cwd = yield* cloneSite;

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const hostedZone = yield* AWS.Route53.HostedZone("Zone", {
              name: R53_ZONE,
              forceDestroy: true,
            });
            // Delegate the sub-zone from the Cloudflare test zone.
            yield* Effect.forEach([0, 1, 2, 3], (index) =>
              Cloudflare.DNS.Record(`Delegation${index}`, {
                zoneId: zone.id,
                name: R53_ZONE,
                type: "NS",
                content: Output.map(
                  hostedZone.nameServers,
                  (servers) => servers[index]!,
                ) as unknown as string,
                ttl: 300,
              }),
            );
            const { project, environment } = yield* suitePartition;
            const site = yield* Railway.Website.StaticSite("Site", {
              project,
              environment,
              cwd,
              command: "bash build.sh",
              shell: true,
              outdir: "dist",
              domain: {
                name: R53_HOSTNAME,
                dns: AWS.Route53.Adapter({ hostedZoneId: hostedZone.id }),
              },
            });
            return { site, hostedZone };
          }),
        );
        expect(deployed.site.url).toBe(`https://${R53_HOSTNAME}`);
        const hostedZoneId = deployed.hostedZone.id;
        const nameServers = deployed.hostedZone.nameServers;

        const attrs = yield* customDomainAttrs(stack, "Site");
        expect(attrs.domain).toBe(R53_HOSTNAME);

        // Route 53 holds exactly the records the CustomDomain reports.
        const published = yield* route53RecordsUnder(hostedZoneId, R53_HOSTNAME);
        expect(normalize(published)).toEqual(normalize(attrs.dnsRecords));
        expectRailwayRecordsPublished(
          yield* liveDomain(attrs.customDomainId, attrs.projectId),
          published,
        );

        // Cloudflare delegates the sub-zone to exactly its Route 53 nameservers.
        const delegation = yield* dns.listRecords
          .items({ zoneId: zone.id, name: { exact: R53_ZONE }, type: "NS" })
          .pipe(Stream.runCollect);
        expect(
          Array.from(delegation)
            .map((record) => trimDot(record.content ?? ""))
            .sort(),
        ).toEqual(nameServers.map(trimDot).sort());

        yield* waitForAuthoritative(nameServers, attrs.dnsRecords);
        const verified = yield* waitUntilVerified(attrs.customDomainId, attrs.projectId);
        expect(verified.status.verified).toBe(true);
        expect(yield* waitUntilServing(R53_HOSTNAME)).toContain(MARKER);

        yield* stack.destroy();

        expect(
          yield* route53.getHostedZone({ Id: hostedZoneId }).pipe(
            Effect.as("found" as const),
            Effect.catchTag("NoSuchHostedZone", () => Effect.succeed("gone" as const)),
          ),
        ).toBe("gone");
        const remaining = yield* dns.listRecords
          .items({ zoneId: zone.id, name: { exact: R53_ZONE }, type: "NS" })
          .pipe(Stream.runCollect);
        expect(Array.from(remaining)).toEqual([]);
        expect(yield* waitUntilDomainGone(attrs.customDomainId, attrs.projectId)).toBe("gone");
      }).pipe(logLevel),
    {
      tags: [...tags, "provider:aws", "provider:aws:route53"],
      timeout: 900_000,
    },
  );
});
