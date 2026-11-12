import { resolve4, resolveNs, Resolver } from "node:dns/promises";
import { fileURLToPath } from "node:url";
/**
 * `AWS.Lambda.Function` custom domains (`domain`): an API Gateway v2 HTTP
 * API front door, a regional ACM certificate, an API Gateway domain name +
 * API mapping per hostname, and alias records through the DNS host named
 * by `domain.dns`.
 *
 * The HTTPS-serving suites are skipped under --fast (ACM issuance
 * plus API Gateway domain activation take minutes — speed doctrine). The
 * invalid-domain and no-domain regressions are cheap and ungated.
 */
import * as AWS from "@alchemy.run/aws";
import { InvalidFunctionDomain } from "@alchemy.run/aws/Lambda/FunctionDomain";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@alchemy.run/cloudflare/Zone/lookup";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as agw2 from "@distilled.cloud/aws/apigatewayv2";
import * as lambda from "@distilled.cloud/aws/lambda";
import * as route53 from "@distilled.cloud/aws/route-53";
import * as dns from "@distilled.cloud/cloudflare/dns";
import * as Output from "alchemy/Output";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

const { test } = Test.make({
  providers: Layer.mergeAll(AWS.providers(), Cloudflare.providers()),
});

const handlerPath = fileURLToPath(new URL("./fixtures/domain-handler.ts", import.meta.url));
const BODY = "hello from a custom domain";

const zoneName = process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

/** Cloudflare-hosted hostnames (test 1). */
const CF_NAME = `fn-dns.${zoneName}`;
const CF_ALIAS = `fn-dns-alias.${zoneName}`;
/** Route 53 sub-zone delegated from the Cloudflare zone (test 2). */
const R53_ZONE = `fn-dns-r53.${zoneName}`;
const R53_NAME = `api.${R53_ZONE}`;

class DomainNotServing extends Data.TaggedError("DomainNotServing")<{
  readonly url: string;
  readonly status: number;
}> {}

class RecordNotPublished extends Data.TaggedError("RecordNotPublished")<{
  readonly name: string;
  readonly server: string;
}> {}

const trimDot = (name: string) => name.replace(/\.$/, "").toLowerCase();

const resolveCloudflareZoneId = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const zone = yield* findZoneByName({ accountId, name: zoneName });
  if (!zone) {
    return yield* Effect.die(new Error(`zone "${zoneName}" not found`));
  }
  return zone.id;
});

const listCloudflareRecords = (zoneId: string, name: string, type: "CNAME" | "NS") =>
  dns.listRecords.items({ zoneId, name: { exact: name }, type }).pipe(
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );

/** IPv4 addresses of the given nameserver hostnames. */
const nameServerIps = (nameServers: readonly string[]) =>
  Effect.forEach(nameServers, (ns) =>
    Effect.tryPromise(() => resolve4(trimDot(ns))).pipe(Effect.orDie),
  ).pipe(Effect.map((ips) => ips.flat()));

/**
 * Wait until every given authoritative nameserver answers `name` with
 * `accept`. Querying a recursive resolver first would negatively cache the
 * not-yet-published name, so the HTTPS check only starts once the record
 * is authoritative.
 */
const waitForAuthoritative = (
  servers: readonly string[],
  name: string,
  query: (resolver: Resolver) => Promise<string[]>,
  accept: (answers: string[]) => boolean,
) =>
  Effect.forEach(servers, (server) =>
    Effect.gen(function* () {
      const resolver = yield* Effect.sync(() => {
        const r = new Resolver();
        r.setServers([server]);
        return r;
      });
      const answers = yield* Effect.tryPromise(() => query(resolver)).pipe(
        Effect.orElseSucceed(() => [] as string[]),
      );
      if (!accept(answers)) {
        return yield* Effect.fail(new RecordNotPublished({ name, server }));
      }
    }).pipe(Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 20 })),
  );

const waitForCloudflareCname = (name: string, target: string) =>
  Effect.gen(function* () {
    const nameServers = yield* Effect.tryPromise(() => resolveNs(zoneName)).pipe(Effect.orDie);
    const servers = yield* nameServerIps(nameServers);
    yield* waitForAuthoritative(
      servers,
      name,
      (resolver) => resolver.resolveCname(name),
      (answers) => answers.some((a) => trimDot(a) === trimDot(target)),
    );
  });

/** GET `https://{host}/` until it answers 200, returning the body. */
const fetchBody = (host: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const url = `https://${host}/`;
    return yield* client.get(url).pipe(
      Effect.flatMap((res): Effect.Effect<string, unknown> =>
        res.status === 200
          ? res.text
          : Effect.fail(new DomainNotServing({ url, status: res.status })),
      ),
      Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 36 }),
    );
  });

/** Every HTTP API tagged as owned by the given stack + stage. */
const listStackApis = (stackName: string, stage: string) =>
  Effect.gen(function* () {
    const apis: agw2.Api[] = [];
    let nextToken: string | undefined;
    do {
      const page = yield* agw2.getApis({
        MaxResults: "500",
        ...(nextToken === undefined ? {} : { NextToken: nextToken }),
      });
      apis.push(...(page.Items ?? []));
      nextToken = page.NextToken;
    } while (nextToken !== undefined);
    return apis.filter(
      (api) => api.Tags?.["alchemy::stack"] === stackName && api.Tags?.["alchemy::stage"] === stage,
    );
  });

/** The API Gateway regional target of a custom domain name. */
const apiGatewayTarget = (domainName: string) =>
  agw2.getDomainName({ DomainName: domainName }).pipe(
    Effect.map((domain) => {
      const config = domain.DomainNameConfigurations?.[0];
      expect(config?.EndpointType).toBe("REGIONAL");
      expect(config?.ApiGatewayDomainName).toBeDefined();
      return {
        hostname: config!.ApiGatewayDomainName!,
        hostedZoneId: config!.HostedZoneId!,
      };
    }),
  );

/** Wait (bounded) until the API Gateway domain name is gone. */
const waitForApiDomainGone = (domainName: string) =>
  agw2.getDomainName({ DomainName: domainName }).pipe(
    Effect.map(() => false),
    Effect.catchTag("NotFoundException", () => Effect.succeed(true)),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (gone) => gone,
      times: 20,
    }),
  );

const liveTags = [
  "provider:aws",
  "provider:aws:acm",
  "provider:aws:apigatewayv2",
  "provider:aws:lambda",
  "provider:aws:route53",
  "provider:cloudflare",
  "provider:cloudflare:dns",
  "live",
];

describe.skipIf(!!process.env.FAST)(
  "AWS.Lambda.Function domain (live, slow)",
  { tags: liveTags },
  () => {
    test.provider(
      "serves the Function on a Cloudflare-hosted domain and alias",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const cfZoneId = yield* resolveCloudflareZoneId;

          const deployed = yield* stack.deploy(
            Effect.gen(function* () {
              const fn = yield* AWS.Lambda.Function("DomainFn", {
                main: handlerPath,
                handler: "handler",
                functionUrl: false,
                domain: {
                  name: CF_NAME,
                  aliases: [CF_ALIAS],
                  dns: Cloudflare.DNS.Adapter({ zone: zoneName }),
                },
              });
              return { domainUrl: fn.domainUrl.as<string>() };
            }),
          );
          expect(deployed.domainUrl).toBe(`https://${CF_NAME}`);

          // Out-of-band: one HTTP API front door owned by this stack, and a
          // regional API Gateway domain name mapped to it per hostname.
          const apis = yield* listStackApis(stack.name, stack.stage);
          expect(apis).toHaveLength(1);
          const apiId = apis[0]!.ApiId!;

          for (const name of [CF_NAME, CF_ALIAS]) {
            const target = yield* apiGatewayTarget(name);
            const mappings = yield* agw2.getApiMappings({ DomainName: name });
            expect((mappings.Items ?? []).map((m) => m.ApiId)).toEqual([apiId]);

            // The Cloudflare CNAME points at the regional target, DNS-only.
            const cnames = yield* listCloudflareRecords(cfZoneId, name, "CNAME");
            expect(cnames).toHaveLength(1);
            expect(trimDot(cnames[0]!.content ?? "")).toBe(trimDot(target.hostname));
            expect(cnames[0]!.proxied).toBe(false);

            yield* waitForCloudflareCname(name, target.hostname);
            expect(yield* fetchBody(name)).toBe(BODY);
          }

          yield* stack.destroy();

          // Both API Gateway domains, their CNAMEs, and the API are gone.
          for (const name of [CF_NAME, CF_ALIAS]) {
            expect(yield* waitForApiDomainGone(name)).toBe(true);
            expect(yield* listCloudflareRecords(cfZoneId, name, "CNAME")).toHaveLength(0);
          }
          expect(yield* listStackApis(stack.name, stack.stage)).toHaveLength(0);
        }),
      { timeout: 900_000 },
    );

    test.provider(
      "a hostname string serves through a delegated Route 53 zone",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const cfZoneId = yield* resolveCloudflareZoneId;

          const program = (withFunction: boolean) =>
            Effect.gen(function* () {
              const zone = yield* AWS.Route53.HostedZone("Zone", {
                name: R53_ZONE,
                forceDestroy: true,
              });
              // Delegate the sub-zone from the Cloudflare test zone so ACM
              // validation and HTTPS resolve publicly. Public Route 53
              // zones always get exactly four nameservers.
              for (const index of [0, 1, 2, 3]) {
                yield* Cloudflare.DNS.Record(`Delegation${index}`, {
                  zoneId: cfZoneId,
                  name: R53_ZONE,
                  type: "NS",
                  content: Output.map(zone.nameServers, (servers: string[]) => servers[index]!),
                  ttl: 300,
                });
              }
              const out = {
                zoneId: zone.id.as<string>(),
                nameServers: zone.nameServers.as<string[]>(),
              };
              if (!withFunction) return { ...out, domainUrl: undefined };
              const fn = yield* AWS.Lambda.Function("R53Fn", {
                main: handlerPath,
                handler: "handler",
                functionUrl: false,
                domain: R53_NAME,
              });
              return { ...out, domainUrl: fn.domainUrl.as<string>() };
            });

          // The zone exists (and is delegated) BEFORE the Function: the
          // certificate and alias record infer the hosted zone at
          // reconcile time.
          yield* stack.deploy(program(false));
          const deployed = yield* stack.deploy(program(true));
          expect(deployed.domainUrl).toBe(`https://${R53_NAME}`);

          // Out-of-band: an `A` alias to the API Gateway regional target in
          // the delegated zone.
          const target = yield* apiGatewayTarget(R53_NAME);
          const recordSets = yield* route53.listResourceRecordSets({
            HostedZoneId: deployed.zoneId,
          });
          const aliases = (recordSets.ResourceRecordSets ?? []).filter(
            (record) => trimDot(record.Name) === R53_NAME && record.Type === "A",
          );
          expect(aliases).toHaveLength(1);
          expect(trimDot(aliases[0]!.AliasTarget?.DNSName ?? "")).toBe(trimDot(target.hostname));
          expect(aliases[0]!.AliasTarget?.HostedZoneId).toBe(target.hostedZoneId);

          // The delegation is live in Cloudflare.
          const delegation = yield* listCloudflareRecords(cfZoneId, R53_ZONE, "NS");
          expect(delegation.map((r) => trimDot(r.content ?? "")).sort()).toEqual(
            deployed.nameServers.map(trimDot).sort(),
          );

          // Route 53's own nameservers answer the alias before HTTPS.
          const servers = yield* nameServerIps(deployed.nameServers);
          yield* waitForAuthoritative(
            servers,
            R53_NAME,
            (resolver) => resolver.resolve4(R53_NAME),
            (answers) => answers.length > 0,
          );
          expect(yield* fetchBody(R53_NAME)).toBe(BODY);

          yield* stack.destroy();

          expect(yield* waitForApiDomainGone(R53_NAME)).toBe(true);
          const zoneGone = yield* route53.getHostedZone({ Id: deployed.zoneId }).pipe(
            Effect.map(() => false),
            Effect.catchTag("NoSuchHostedZone", () => Effect.succeed(true)),
          );
          expect(zoneGone).toBe(true);
          expect(yield* listCloudflareRecords(cfZoneId, R53_ZONE, "NS")).toHaveLength(0);
        }),
      { timeout: 900_000 },
    );
  },
);

/** The `InvalidFunctionDomain` defect a failed deploy died with. */
const invalidDomainDefect = (exit: Exit.Exit<unknown, unknown>) => {
  if (!Exit.isFailure(exit)) return undefined;
  const reason = exit.cause.reasons.find(
    (r) => Cause.isDieReason(r) && r.defect instanceof InvalidFunctionDomain,
  );
  return reason && Cause.isDieReason(reason) ? (reason.defect as InvalidFunctionDomain) : undefined;
};

describe(
  "AWS.Lambda.Function domain (live)",
  { tags: ["provider:aws", "provider:aws:lambda", "live"] },
  () => {
    test.provider(
      "an empty or duplicate hostname fails the deploy with InvalidFunctionDomain",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const empty = yield* stack
            .deploy(
              AWS.Lambda.Function("InvalidFn", {
                main: handlerPath,
                handler: "handler",
                domain: "",
              }),
            )
            .pipe(Effect.exit);
          const emptyDefect = invalidDomainDefect(empty);
          expect(emptyDefect?.functionId).toBe("InvalidFn");
          expect(emptyDefect?.message).toContain("non-empty hostnames");

          const duplicate = yield* stack
            .deploy(
              AWS.Lambda.Function("InvalidFn", {
                main: handlerPath,
                handler: "handler",
                domain: { name: CF_NAME, aliases: [CF_NAME] },
              }),
            )
            .pipe(Effect.exit);
          const duplicateDefect = invalidDomainDefect(duplicate);
          expect(duplicateDefect?.functionId).toBe("InvalidFn");
          expect(duplicateDefect?.message).toContain("more than once");

          // Construction died before any plan: nothing was deployed.
          expect(yield* listStackApis(stack.name, stack.stage)).toHaveLength(0);

          yield* stack.destroy();
        }),
      { timeout: 120_000 },
    );

    test.provider(
      "a Function without `domain` composes no API Gateway front door",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const deployed = yield* stack.deploy(
            Effect.gen(function* () {
              const fn = yield* AWS.Lambda.Function("PlainFn", {
                main: handlerPath,
                handler: "handler",
              });
              return {
                functionName: fn.functionName.as<string>(),
                domainUrl: fn.domainUrl,
              };
            }),
          );
          expect(deployed.domainUrl).toBeUndefined();

          // The Function exists; no HTTP API (and so no API Gateway domain
          // or mapping) was composed for this stack.
          const live = yield* lambda.getFunction({
            FunctionName: deployed.functionName,
          });
          expect(live.Configuration?.FunctionName).toBe(deployed.functionName);
          expect(yield* listStackApis(stack.name, stack.stage)).toHaveLength(0);

          yield* stack.destroy();

          const gone = yield* lambda.getFunction({ FunctionName: deployed.functionName }).pipe(
            Effect.map(() => false),
            Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(true)),
          );
          expect(gone).toBe(true);
        }),
      { timeout: 180_000 },
    );
  },
);
