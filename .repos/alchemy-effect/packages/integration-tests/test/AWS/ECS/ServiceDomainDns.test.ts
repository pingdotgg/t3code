import { resolve4, resolveNs, Resolver } from "node:dns/promises";
/**
 * `AWS.ECS.Service` load-balancer custom domains, served live over HTTPS:
 *
 * - `domain.dns: Cloudflare.DNS.Adapter()` — ACM validated through
 *   Cloudflare, each name a Cloudflare CNAME to the ALB.
 * - the Route 53 default (no `dns`) on a Route 53 zone publicly delegated
 *   from the standing Cloudflare test zone — alias `A` + `AAAA` records.
 *
 * Skipped under --fast: an ALB, ACM issuance and a Fargate task
 * take minutes. Both tests share one ECS cluster (deployed once per file)
 * and the default VPC's per-AZ subnets.
 */
import * as AWS from "@alchemy.run/aws";
import { Cluster } from "@alchemy.run/aws/ECS/Cluster";
import { Service } from "@alchemy.run/aws/ECS/Service";
import { HostedZone } from "@alchemy.run/aws/Route53";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@alchemy.run/cloudflare/Zone/lookup";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as acm from "@distilled.cloud/aws/acm";
import * as ec2 from "@distilled.cloud/aws/ec2";
import * as elbv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import * as route53 from "@distilled.cloud/aws/route-53";
import * as dns from "@distilled.cloud/cloudflare/dns";
import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import { isResourceState, State } from "alchemy/State";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { getDefaultVpcNetwork } from "../DefaultVpc.ts";

const providers = Layer.mergeAll(AWS.providers(), Cloudflare.providers());
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers,
});

const zoneName = process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

// Cloudflare-hosted names.
const CF_NAME = `ecs-dns.${zoneName}`;
const CF_ALIAS = `www.ecs-dns.${zoneName}`;
// Route 53 zone delegated from the Cloudflare zone, and the served name.
const R53_ZONE = `ecs-dns-r53.${zoneName}`;
const R53_NAME = `api.${R53_ZONE}`;

/** Logical id prefix the service gives each domain name's records. */
const domainRecordId = (name: string) => `Domain-${name.replaceAll(/[^a-zA-Z0-9-]/g, "-")}`;

class DnsNotPublished extends Data.TaggedError("DnsNotPublished")<{
  readonly name: string;
  readonly server: string;
}> {}

class NotServing extends Data.TaggedError("NotServing")<{
  readonly url: string;
  readonly status: number;
}> {}

class RecordsStillPresent extends Data.TaggedError("RecordsStillPresent")<{
  readonly name: string;
  readonly count: number;
}> {}

const resolveCloudflareZoneId = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const zone = yield* findZoneByName({ accountId, name: zoneName });
  if (!zone) {
    return yield* Effect.die(new Error(`zone "${zoneName}" not found`));
  }
  return zone.id;
});

/** The default VPC and one default subnet per AZ (an ALB rejects two per AZ). */
const defaultNetwork = Effect.gen(function* () {
  const net = yield* getDefaultVpcNetwork;
  const subnets = yield* ec2
    .describeSubnets({
      Filters: [
        { Name: "vpc-id", Values: [net.vpcId] },
        { Name: "default-for-az", Values: ["true"] },
      ],
    })
    .pipe(Effect.map((r) => (r.Subnets ?? []).flatMap((s) => (s.SubnetId ? [s.SubnetId] : []))));
  return { vpcId: net.vpcId as string, subnets };
});

/** An echo server behind the service's ALB, answering `text` on `/`. */
const echoService = (text: string) =>
  Effect.gen(function* () {
    const network = yield* defaultNetwork;
    return {
      image: "hashicorp/http-echo",
      command: [`-text=${text}`],
      port: 5678,
      desiredCount: 1,
      vpcId: network.vpcId,
      subnets: network.subnets,
      // Default-VPC public subnets: the task pulls from ECR without a NAT.
      assignPublicIp: true,
    };
  });

/**
 * Wait until every authoritative nameserver answers `check` for `name`,
 * so the first HTTPS request never resolves (and negatively caches) the
 * name before it is published.
 */
const waitForAuthoritative = (
  nameServers: readonly string[],
  name: string,
  check: (resolver: Resolver) => Promise<boolean>,
) =>
  Effect.gen(function* () {
    const servers = (yield* Effect.forEach(nameServers, (ns) =>
      Effect.tryPromise(() => resolve4(ns)).pipe(Effect.orDie),
    )).flat();
    yield* Effect.forEach(servers, (server) =>
      Effect.gen(function* () {
        const resolver = yield* Effect.sync(() => {
          const r = new Resolver();
          r.setServers([server]);
          return r;
        });
        const published = yield* Effect.tryPromise(() => check(resolver)).pipe(
          Effect.orElseSucceed(() => false),
        );
        if (!published) {
          return yield* Effect.fail(new DnsNotPublished({ name, server }));
        }
      }).pipe(Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 40 })),
    );
  });

/** GET `https://{name}/` until it answers 200 with `text` (bounded). */
const expectServes = (name: string, text: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const url = `https://${name}/`;
    // ALB provisioning, Fargate start and health checks — the happy path
    // exits on the first 200.
    const body = yield* client.get(url).pipe(
      Effect.flatMap((res): Effect.Effect<string, unknown> =>
        res.status === 200 ? res.text : Effect.fail(new NotServing({ url, status: res.status })),
      ),
      Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 84 }),
    );
    expect(body).toContain(text);
  });

const albDnsName = (loadBalancerArn: string) =>
  elbv2
    .describeLoadBalancers({ LoadBalancerArns: [loadBalancerArn] })
    .pipe(
      Effect.map((r) => (r.LoadBalancers?.[0]?.DNSName ?? "").replace(/\.$/, "").toLowerCase()),
    );

const loadBalancerGone = (loadBalancerArn: string) =>
  elbv2.describeLoadBalancers({ LoadBalancerArns: [loadBalancerArn] }).pipe(
    Effect.map((r) => (r.LoadBalancers ?? []).length === 0),
    Effect.catchTag("LoadBalancerNotFoundException", () => Effect.succeed(true)),
  );

/** The HTTPS listener's certificate: ISSUED, for `names`, in `region`. */
const expectIssuedCertificate = (
  loadBalancerArn: string,
  names: readonly string[],
  region: string,
) =>
  Effect.gen(function* () {
    const listeners = yield* elbv2.describeListeners({
      LoadBalancerArn: loadBalancerArn,
    });
    const https = (listeners.Listeners ?? []).find((l) => l.Port === 443);
    expect(https?.Protocol).toBe("HTTPS");
    const certificateArn = https?.Certificates?.[0]?.CertificateArn;
    expect(certificateArn).toBeDefined();
    expect(certificateArn!.split(":")[3]).toBe(region);
    const { Certificate } = yield* acm.describeCertificate({
      CertificateArn: certificateArn!,
    });
    expect(Certificate?.Status).toBe("ISSUED");
    expect(Certificate?.DomainName).toBe(names[0]);
    expect([...(Certificate?.SubjectAlternativeNames ?? [])].sort()).toEqual([...names].sort());
  });

/** Persisted state rows of the scratch stack, keyed by FQN. */
const stateRows = (stack: Test.ScratchStack) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    const fqns = yield* state.list({ stack: stack.name, stage: stack.stage });
    const rows = yield* Effect.forEach(fqns, (fqn) =>
      state
        .get({ stack: stack.name, stage: stack.stage, fqn })
        .pipe(Effect.map((row) => [fqn, row] as const)),
    );
    return new Map(
      rows.flatMap(([fqn, row]) =>
        isResourceState(row) ? [[fqn, row.resourceType] as const] : [],
      ),
    );
  });

// One cluster for the whole file.
const ClusterStack = Alchemy.Stack(
  "EcsDnsCluster",
  { providers: AWS.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const cluster = yield* Cluster("Cluster", {
      clusterName: "alchemy-test-ecs-dns",
    });
    return { clusterArn: cluster.clusterArn };
  }),
);

describe.skipIf(!!process.env.FAST)(
  "AWS.ECS.Service custom domain DNS (live)",
  {
    tags: [
      "provider:aws",
      "provider:aws:acm",
      "provider:aws:ecs",
      "provider:aws:elbv2",
      "provider:aws:route53",
      "provider:cloudflare",
      "provider:cloudflare:dns",
      "live",
    ],
  },
  () => {
    const shared = beforeAll(deploy(ClusterStack));
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(ClusterStack), {
      timeout: 300_000,
    });

    test.provider(
      "Cloudflare DNS: ACM validated through Cloudflare, both names CNAME to the ALB and serve HTTPS",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const { clusterArn } = yield* shared;
          const zoneId = yield* resolveCloudflareZoneId;
          const base = yield* echoService("ecs-dns-cloudflare");

          const deployed = yield* stack.deploy(
            Effect.gen(function* () {
              const service = yield* Service("CfSvc", {
                ...base,
                cluster: clusterArn,
                loadBalancer: {
                  domain: {
                    name: CF_NAME,
                    aliases: [CF_ALIAS],
                    dns: Cloudflare.DNS.Adapter(),
                  },
                },
              });
              return {
                url: service.url.as<string>(),
                serviceArn: service.serviceArn.as<string>(),
                loadBalancerArn: service.loadBalancerArn.as<string>(),
              };
            }),
          );
          expect(deployed.url).toBe(`https://${CF_NAME}`);

          // Each name is a DNS-only Cloudflare CNAME to the ALB.
          const albDns = yield* albDnsName(deployed.loadBalancerArn);
          expect(albDns).not.toBe("");
          const listCnames = (name: string) =>
            dns.listRecords.items({ zoneId, name: { exact: name }, type: "CNAME" }).pipe(
              Stream.runCollect,
              Effect.map((chunk) => Array.from(chunk)),
            );
          for (const name of [CF_NAME, CF_ALIAS]) {
            const cnames = yield* listCnames(name);
            expect(cnames).toHaveLength(1);
            expect(cnames[0]!.content?.toLowerCase()).toBe(albDns);
            expect(cnames[0]!.proxied).toBe(false);
          }
          const rows = yield* stateRows(stack);
          for (const name of [CF_NAME, CF_ALIAS]) {
            expect(rows.get(`CfSvc/${domainRecordId(name)}-CNAME`)).toBe("Cloudflare.DNS.Records");
          }

          // The certificate is issued in the service's region.
          yield* expectIssuedCertificate(
            deployed.loadBalancerArn,
            [CF_NAME, CF_ALIAS],
            deployed.serviceArn.split(":")[3]!,
          );

          // HTTPS 200 on both names through the ALB.
          const cloudflareNs = yield* Effect.tryPromise(() => resolveNs(zoneName)).pipe(
            Effect.orDie,
          );
          for (const name of [CF_NAME, CF_ALIAS]) {
            yield* waitForAuthoritative(cloudflareNs, name, (resolver) =>
              resolver
                .resolveCname(name)
                .then((answers) =>
                  answers.some((a) => a.replace(/\.$/, "").toLowerCase() === albDns),
                ),
            );
            yield* expectServes(name, "ecs-dns-cloudflare");
          }

          // Destroy removes the ALB and both CNAMEs.
          yield* stack.destroy();
          expect(yield* loadBalancerGone(deployed.loadBalancerArn)).toBe(true);
          for (const name of [CF_NAME, CF_ALIAS]) {
            yield* listCnames(name).pipe(
              Effect.flatMap((cnames) =>
                cnames.length === 0
                  ? Effect.void
                  : Effect.fail(new RecordsStillPresent({ name, count: cnames.length })),
              ),
              Effect.retry({
                schedule: Schedule.spaced("2 seconds"),
                times: 10,
              }),
            );
          }
        }),
      { timeout: 1_200_000 },
    );

    test.provider(
      "Route 53 default: alias A + AAAA records in a delegated zone serve HTTPS",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const { clusterArn } = yield* shared;
          const cloudflareZoneId = yield* resolveCloudflareZoneId;
          const base = yield* echoService("ecs-dns-route53");

          const program = (includeService: boolean) =>
            Effect.gen(function* () {
              // ACM's validation CNAME is retained in the zone by design
              // (reused across certificates), so the zone is never empty.
              const zone = yield* HostedZone("Zone", {
                name: R53_ZONE,
                forceDestroy: true,
              });
              // Delegate the sub-zone publicly. One NS record: several
              // `Cloudflare.DNS.Record`s sharing (name, type) would adopt
              // each other's record instead of creating siblings.
              yield* Cloudflare.DNS.Record("Delegation", {
                zoneId: cloudflareZoneId,
                name: R53_ZONE,
                type: "NS",
                content: Output.map(zone.nameServers, (ns) => ns[0]!),
                ttl: 60,
              });
              const outputs = {
                zoneId: zone.id.as<string>(),
                nameServers: zone.nameServers.as<string[]>(),
              };
              if (!includeService) {
                return { ...outputs, service: undefined };
              }
              // No `dns`: the Route 53 default, whose zone lookup runs while
              // the program is built — so the zone is deployed first.
              const service = yield* Service("R53Svc", {
                ...base,
                cluster: clusterArn,
                loadBalancer: { domain: { name: R53_NAME } },
              });
              return {
                ...outputs,
                service: {
                  url: service.url.as<string>(),
                  serviceArn: service.serviceArn.as<string>(),
                  loadBalancerArn: service.loadBalancerArn.as<string>(),
                },
              };
            });

          yield* stack.deploy(program(false));
          const deployed = yield* stack.deploy(program(true));
          const service = deployed.service!;
          const hostedZoneId = deployed.zoneId.replace(/^\/hostedzone\//, "");
          expect(service.url).toBe(`https://${R53_NAME}`);

          // Out-of-band: alias A + AAAA records to the ALB.
          const albDns = yield* albDnsName(service.loadBalancerArn);
          const recordSets = yield* route53.listResourceRecordSets({
            HostedZoneId: hostedZoneId,
          });
          const aliases = (recordSets.ResourceRecordSets ?? []).filter(
            (record) => record.Name === `${R53_NAME}.` && record.AliasTarget,
          );
          expect(aliases.map((r) => r.Type).sort()).toEqual(["A", "AAAA"]);
          for (const record of aliases) {
            // Route 53 may prefix ELB alias targets with `dualstack.`.
            expect(record.AliasTarget!.DNSName!.replace(/\.$/, "").toLowerCase()).toMatch(
              new RegExp(`^(dualstack\\.)?${albDns.replaceAll(".", "\\.")}$`),
            );
          }
          // The logical ids predate DNS adapters: `Domain-{name}-A/AAAA`.
          const rows = yield* stateRows(stack);
          for (const type of ["A", "AAAA"]) {
            expect(rows.get(`R53Svc/${domainRecordId(R53_NAME)}-${type}`)).toBe(
              "AWS.Route53.Record",
            );
          }

          yield* expectIssuedCertificate(
            service.loadBalancerArn,
            [R53_NAME],
            service.serviceArn.split(":")[3]!,
          );

          // HTTPS 200 through the delegation.
          yield* waitForAuthoritative(deployed.nameServers, R53_NAME, (resolver) =>
            resolver.resolve4(R53_NAME).then((ips) => ips.length > 0),
          );
          yield* expectServes(R53_NAME, "ecs-dns-route53");

          // Destroy removes the zone (and its records) and the delegation.
          yield* stack.destroy();
          expect(yield* loadBalancerGone(service.loadBalancerArn)).toBe(true);
          const zoneGone = yield* route53.getHostedZone({ Id: hostedZoneId }).pipe(
            Effect.map(() => false),
            Effect.catchTag("NoSuchHostedZone", () => Effect.succeed(true)),
          );
          expect(zoneGone).toBe(true);
          const delegation = yield* dns.listRecords
            .items({
              zoneId: cloudflareZoneId,
              name: { exact: R53_ZONE },
              type: "NS",
            })
            .pipe(
              Stream.runCollect,
              Effect.map((chunk) => Array.from(chunk)),
            );
          expect(delegation).toHaveLength(0);
        }),
      { timeout: 1_200_000 },
    );
  },
);
