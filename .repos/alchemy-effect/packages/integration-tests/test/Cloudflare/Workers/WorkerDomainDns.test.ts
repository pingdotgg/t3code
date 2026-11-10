import { resolve4, resolveNs, Resolver } from "node:dns/promises";
/**
 * `Cloudflare.Worker` `domain.dns`, deployed live:
 *
 * - a Cloudflare adapter keeps the native custom-domain path;
 * - invalid SaaS configurations die with `WorkerDomainDnsError` on deploy;
 * - an ungated Cloudflare for SaaS entitlement probe;
 * - the full Cloudflare for SaaS lifecycle (a Worker on a Route 53
 *   hostname), gated behind CLOUDFLARE_TEST_SAAS=1 because Cloudflare for
 *   SaaS is not provisioned on the test account (see the probe).
 */
import * as AWS from "@alchemy.run/aws";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@alchemy.run/cloudflare/Zone/lookup";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as route53 from "@distilled.cloud/aws/route-53";
import * as customHostnames from "@distilled.cloud/cloudflare/custom-hostnames";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as Output from "alchemy/Output";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as pathe from "pathe";
import { testName } from "../../names.ts";
import { expectUrlContains } from "../Utils/Http.ts";
import { waitForWorkerToBeDeleted } from "../Utils/Worker.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(Cloudflare.providers(), AWS.providers()),
});

const main = pathe.resolve(import.meta.dirname, "fixtures", "saas-worker.ts");
const MARKER = "worker-dns-ok";

const zoneName = process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

// Deterministic hostnames under this suite's `worker-dns` prefix.
const NATIVE_HOSTNAME = `${testName("worker-dns")}.${zoneName}`;
const INVALID_HOSTNAME = `${testName("worker-dns-invalid")}.${zoneName}`;
const PROBE_HOSTNAME = "worker-dns-probe.alchemy-saas-example.com";
const ORIGIN_NAME = `${testName("worker-dns-origin")}.${zoneName}`;
const R53_ZONE_NAME = `${testName("worker-dns-r53")}.${zoneName}`;
const SAAS_HOSTNAME = `app.${R53_ZONE_NAME}`;

const resolveZoneId = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const zone = yield* findZoneByName({ accountId, name: zoneName });
  if (!zone) {
    return yield* Effect.die(new Error(`zone "${zoneName}" not found in account`));
  }
  return zone.id;
});

// Rate-limit blips and freshly minted scoped tokens that 403 while they
// propagate.
const transientBlips = Schedule.exponential("500 millis");

class StillPresent extends Data.TaggedError("StillPresent")<{
  readonly what: string;
}> {}

class NotPublished extends Data.TaggedError("NotPublished")<{
  readonly server: string;
  readonly hostname: string;
}> {}

/** The Worker custom-domain attachments of `hostname`. */
const listAttachments = (hostname: string) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;
    return yield* workers.listDomains({ accountId, hostname }).pipe(
      Effect.map((r) => (r.result ?? []).filter((d) => d.hostname === hostname)),
      Effect.retry({
        while: (e) => e._tag === "TooManyRequests",
        schedule: transientBlips,
        times: 8,
      }),
    );
  });

const findCustomHostname = (zoneId: string, hostname: string) =>
  customHostnames.listCustomHostnames.items({ zoneId, hostname: { contain: hostname } }).pipe(
    Stream.filter((h) => h.hostname === hostname),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)[0]),
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: transientBlips,
      times: 8,
    }),
  );

const listWorkerRoutes = (zoneId: string, pattern: string) =>
  workers.listRoutes.items({ zoneId }).pipe(
    Stream.filter((route) => route.pattern === pattern),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );

/** Retry `check` (bounded) until it stops failing with `StillPresent`. */
const waitUntilGone = <E, R>(check: Effect.Effect<void, E, R>) =>
  check.pipe(
    Effect.retry({
      while: (e) => e instanceof StillPresent,
      schedule: Schedule.spaced("2 seconds"),
      times: 15,
    }),
  );

/**
 * Wait until every authoritative nameserver answers `lookup` for
 * `hostname`, so the first HTTPS request never resolves (and negatively
 * caches) the hostname before it exists.
 */
const waitForAuthoritative = (
  nameServers: readonly string[],
  hostname: string,
  lookup: (resolver: Resolver, hostname: string) => Promise<string[]>,
) =>
  Effect.gen(function* () {
    const servers = (yield* Effect.forEach(nameServers, (ns) =>
      Effect.tryPromise(() => resolve4(ns)).pipe(
        Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 10 }),
        Effect.orDie,
      ),
    )).flat();
    yield* Effect.forEach(servers, (server) =>
      Effect.gen(function* () {
        const resolver = yield* Effect.sync(() => {
          const r = new Resolver();
          r.setServers([server]);
          return r;
        });
        const answers = yield* Effect.tryPromise(() => lookup(resolver, hostname)).pipe(
          Effect.orElseSucceed(() => [] as string[]),
        );
        if (answers.length === 0) {
          return yield* Effect.fail(new NotPublished({ server, hostname }));
        }
      }).pipe(Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 30 })),
    );
  });

/** Die defects of a failed exit. */
const defectsOf = <A, E>(exit: Exit.Exit<A, E>): unknown[] =>
  Exit.isFailure(exit)
    ? exit.cause.reasons.flatMap((reason) => (reason._tag === "Die" ? [reason.defect] : []))
    : [];

const workerDomainDnsError = (exit: Exit.Exit<unknown, unknown>) =>
  defectsOf(exit).find(
    (defect): defect is Cloudflare.WorkerDomainDnsError =>
      defect instanceof Cloudflare.WorkerDomainDnsError,
  );

const tags = [
  "provider:cloudflare",
  "provider:cloudflare:workers",
  "provider:cloudflare:customhostname",
  "live",
];

describe("Cloudflare.Worker domain.dns", { tags }, () => {
  test.provider(
    "a Cloudflare adapter attaches a native custom domain that serves the Worker",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;
        yield* stack.destroy();

        const worker = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Worker("NativeDomainWorker", {
              main,
              domain: { name: NATIVE_HOSTNAME, dns: Cloudflare.DNS.Adapter() },
            });
          }),
        );

        // The native path: the hostname is the Worker's canonical URL and
        // domain output — a SaaS-served domain would keep workers.dev.
        expect(worker.url).toBe(`https://${NATIVE_HOSTNAME}`);
        expect(worker.domain).toEqual({
          name: NATIVE_HOSTNAME,
          aliases: [],
          redirects: [],
        });

        // Out-of-band: the custom domain is attached to the script.
        const attachments = yield* listAttachments(NATIVE_HOSTNAME);
        expect(attachments.map((d) => d.service)).toEqual([worker.workerName]);

        const nameServers = yield* Effect.tryPromise(() => resolveNs(zoneName)).pipe(Effect.orDie);
        yield* waitForAuthoritative(nameServers, NATIVE_HOSTNAME, (r, h) => r.resolve4(h));
        yield* expectUrlContains(`https://${NATIVE_HOSTNAME}/`, MARKER, {
          label: "native custom domain serves the worker",
          timeout: "180 seconds",
        });

        yield* stack.destroy();
        yield* waitUntilGone(
          listAttachments(NATIVE_HOSTNAME).pipe(
            Effect.flatMap((remaining) =>
              remaining.length === 0
                ? Effect.void
                : Effect.fail(new StillPresent({ what: `domain ${NATIVE_HOSTNAME}` })),
            ),
          ),
        );
        yield* waitForWorkerToBeDeleted(worker.workerName, accountId);
      }),
    { timeout: 300_000 },
  );

  test.provider(
    "`redirects` with a Route 53 adapter fails the deploy with WorkerDomainDnsError",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const zoneId = yield* resolveZoneId;

        const exit = yield* stack
          .deploy(
            Effect.gen(function* () {
              return yield* Cloudflare.Worker("RedirectsWorker", {
                main,
                domain: {
                  name: INVALID_HOSTNAME,
                  redirects: [`old-${INVALID_HOSTNAME}`],
                  zoneId,
                  cnameTarget: ORIGIN_NAME,
                  dns: AWS.Route53.Adapter(),
                },
              });
            }),
          )
          .pipe(Effect.exit);

        expect(Exit.isFailure(exit)).toBe(true);
        const error = workerDomainDnsError(exit);
        expect(error?.workerId).toBe("RedirectsWorker");
        expect(error?.message).toContain("domain.redirects");

        yield* stack.destroy();
      }),
    { timeout: 120_000 },
  );

  test.provider(
    "a missing `cnameTarget` fails the deploy with WorkerDomainDnsError",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const zoneId = yield* resolveZoneId;

        const exit = yield* stack
          .deploy(
            Effect.gen(function* () {
              return yield* Cloudflare.Worker("NoTargetWorker", {
                main,
                domain: {
                  name: INVALID_HOSTNAME,
                  zoneId,
                  dns: AWS.Route53.Adapter(),
                },
              });
            }),
          )
          .pipe(Effect.exit);

        expect(Exit.isFailure(exit)).toBe(true);
        const error = workerDomainDnsError(exit);
        expect(error?.workerId).toBe("NoTargetWorker");
        expect(error?.message).toContain("domain.cnameTarget");

        yield* stack.destroy();
      }),
    { timeout: 120_000 },
  );

  // Cloudflare for SaaS needs a one-time dashboard enablement (payment on
  // file). On a zone without it, creating a custom hostname is rejected
  // with the typed `SaasQuotaNotAllocated` (code 1404). On an entitled
  // zone the probe hostname is created and removed again.
  test.provider(
    "custom hostname creation on the test zone is typed (entitlement probe)",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const zoneId = yield* resolveZoneId;
        const created = yield* customHostnames
          .createCustomHostname({
            zoneId,
            hostname: PROBE_HOSTNAME,
            ssl: { method: "txt", type: "dv" },
          })
          .pipe(
            Effect.map((hostname) => ({ entitled: true, hostname }) as const),
            Effect.catchTag("SaasQuotaNotAllocated", (error) =>
              Effect.succeed({ entitled: false, error } as const),
            ),
          );
        yield* Effect.logInfo(
          created.entitled
            ? `Cloudflare for SaaS is enabled on ${zoneName}`
            : `Cloudflare for SaaS is not enabled on ${zoneName}: ${created.error.message}`,
        );
        if (!created.entitled) {
          expect(created.error._tag).toBe("SaasQuotaNotAllocated");
        } else {
          yield* customHostnames
            .deleteCustomHostname({
              zoneId,
              customHostnameId: created.hostname.id,
            })
            .pipe(Effect.catchTag("CustomHostnameNotFound", () => Effect.void));
          expect(yield* findCustomHostname(zoneId, PROBE_HOSTNAME)).toBe(undefined);
        }
        yield* stack.destroy();
      }),
    { timeout: 60_000 },
  );

  test.provider.skipIf(!process.env.CLOUDFLARE_TEST_SAAS)(
    "a Worker on a Route 53 hostname serves through Cloudflare for SaaS",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;
        yield* stack.destroy();
        const zoneId = yield* resolveZoneId;

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            // The SaaS zone's fallback origin: an originless proxied record.
            const origin = yield* Cloudflare.DNS.Record("SaasOrigin", {
              zoneId,
              name: ORIGIN_NAME,
              type: "AAAA",
              content: "100::",
              proxied: true,
            });
            const fallback = yield* Cloudflare.CustomHostname.FallbackOrigin("SaasFallback", {
              zoneId,
              origin: origin.name,
            });

            // A Route 53 zone publicly delegated from the Cloudflare zone:
            // the custom hostname's DNS host.
            const r53Zone = yield* AWS.Route53.HostedZone("R53Zone", {
              name: R53_ZONE_NAME,
              forceDestroy: true,
            });
            for (const index of [0, 1, 2, 3]) {
              yield* Cloudflare.DNS.Record(`R53Delegation${index}`, {
                zoneId,
                name: R53_ZONE_NAME,
                type: "NS",
                content: Output.map(r53Zone.nameServers, (nameServers) => nameServers[index]!),
              });
            }

            const worker = yield* Cloudflare.Worker("SaasWorker", {
              main,
              domain: {
                name: SAAS_HOSTNAME,
                zoneId,
                cnameTarget: fallback.origin,
                dns: AWS.Route53.Adapter({ hostedZoneId: r53Zone.id }),
              },
            });
            return {
              workerName: worker.workerName,
              hostedZoneId: r53Zone.id,
              nameServers: r53Zone.nameServers,
            };
          }),
        );

        // Out-of-band: the custom hostname and the SaaS-zone route exist.
        const customHostname = yield* findCustomHostname(zoneId, SAAS_HOSTNAME);
        expect(customHostname?.hostname).toBe(SAAS_HOSTNAME);
        const routes = yield* listWorkerRoutes(zoneId, `${SAAS_HOSTNAME}/*`);
        expect(routes.map((route) => route.script)).toEqual([deployed.workerName]);

        // Out-of-band: Route 53 publishes the CNAME to the fallback origin
        // and the ownership-verification TXT record.
        const { ResourceRecordSets = [] } = yield* route53.listResourceRecordSets({
          HostedZoneId: deployed.hostedZoneId,
        });
        const recordSet = (name: string, type: string) =>
          ResourceRecordSets.find((set) => set.Name === `${name}.` && set.Type === type);
        expect(
          recordSet(SAAS_HOSTNAME, "CNAME")?.ResourceRecords?.map((record) => record.Value),
        ).toEqual([ORIGIN_NAME]);
        expect(recordSet(`_cf-custom-hostname.${SAAS_HOSTNAME}`, "TXT")).toBeDefined();

        // Ownership + DCV complete asynchronously once Route 53 serves the
        // TXT records and the CNAME — bounded retry until it serves.
        yield* waitForAuthoritative(deployed.nameServers, SAAS_HOSTNAME, (r, h) =>
          r.resolveCname(h),
        );
        yield* expectUrlContains(`https://${SAAS_HOSTNAME}/`, MARKER, {
          label: "SaaS custom hostname serves the worker",
          timeout: "240 seconds",
        });

        yield* stack.destroy();
        yield* waitUntilGone(
          findCustomHostname(zoneId, SAAS_HOSTNAME).pipe(
            Effect.flatMap((remaining) =>
              remaining === undefined
                ? Effect.void
                : Effect.fail(new StillPresent({ what: `hostname ${SAAS_HOSTNAME}` })),
            ),
          ),
        );
        expect(yield* listWorkerRoutes(zoneId, `${SAAS_HOSTNAME}/*`)).toHaveLength(0);
        yield* waitUntilGone(
          route53.getHostedZone({ Id: deployed.hostedZoneId }).pipe(
            Effect.flatMap(() => Effect.fail(new StillPresent({ what: `zone ${R53_ZONE_NAME}` }))),
            Effect.catchTag("NoSuchHostedZone", () => Effect.void),
          ),
        );
        yield* waitForWorkerToBeDeleted(deployed.workerName, accountId);
      }),
    { timeout: 600_000 },
  );
});
