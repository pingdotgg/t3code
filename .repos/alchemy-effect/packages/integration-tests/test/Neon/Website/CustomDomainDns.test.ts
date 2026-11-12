import { resolve4, resolveNs, Resolver } from "node:dns/promises";
/**
 * `domain.dns` on Neon websites, deployed for real: a StaticSite whose
 * custom hostname is published through `Cloudflare.DNS.Adapter()`. Asserts
 * Cloudflare holds exactly one DNS-only CNAME to the CustomDomain's
 * `cnameTarget`, Neon activates the domain and serves HTTPS on it, and
 * destroy removes both the record and the Neon domain.
 */
import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@alchemy.run/cloudflare/Zone/lookup";
import * as Neon from "@alchemy.run/neon";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as dns from "@distilled.cloud/cloudflare/dns";
import * as Api from "@distilled.cloud/neon";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as pathe from "pathe";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(Neon.providers(), Cloudflare.providers()),
});

const ZONE = "alchemy-test-2.us";
const HOSTNAME = `neon-dns.${ZONE}`;
const MARKER = "StaticSite fixture v1";

const fixtureDir = pathe.resolve(
  import.meta.dirname,
  "../../Cloudflare/Website/staticsite-fixture",
);
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

class CnameNotPublished extends Data.TaggedError("CnameNotPublished")<{
  readonly server: string;
}> {}

class DomainNotActive extends Data.TaggedError("DomainNotActive")<{
  readonly status: string | undefined;
  readonly dnsStatus: string | undefined;
  readonly bindingStatus: string | undefined;
}> {}

class SiteNotServing extends Data.TaggedError("SiteNotServing")<{
  readonly status: number;
}> {}

const trimDot = (value: string) => value.replace(/\.$/, "").toLowerCase();

const resolveZoneId = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const zone = yield* findZoneByName({ accountId, name: ZONE });
  if (!zone) {
    return yield* Effect.die(new Error(`zone "${ZONE}" not found`));
  }
  return zone.id;
});

/** Every Cloudflare record at or below the hostname. */
const recordsUnder = (zoneId: string) =>
  dns.listRecords.items({ zoneId, name: { endswith: HOSTNAME } }).pipe(
    Stream.runCollect,
    Effect.map((chunk) =>
      Array.from(chunk).filter(
        (record) =>
          trimDot(record.name) === HOSTNAME || trimDot(record.name).endsWith(`.${HOSTNAME}`),
      ),
    ),
  );

/** Wait until every authoritative nameserver of the zone answers the CNAME. */
const waitForAuthoritativeCname = (target: string) =>
  Effect.gen(function* () {
    const nameServers = yield* Effect.tryPromise(() => resolveNs(ZONE)).pipe(Effect.orDie);
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
        const answers = yield* Effect.tryPromise(() => resolver.resolveCname(HOSTNAME)).pipe(
          Effect.orElseSucceed(() => [] as string[]),
        );
        if (!answers.some((answer) => trimDot(answer) === trimDot(target))) {
          return yield* Effect.fail(new CnameNotPublished({ server }));
        }
      }).pipe(Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 20 })),
    );
  });

const observeDomain = (fn: { projectId: string; branchId: string }) =>
  Api.listProjectBranchCustomDomains({
    project_id: fn.projectId,
    branch_id: fn.branchId,
  }).pipe(
    Effect.map(({ custom_domains }) => custom_domains.find((domain) => domain.domain === HOSTNAME)),
  );

test.provider(
  "Cloudflare DNS publishes a DNS-only CNAME to the Neon target; the hostname activates and serves HTTPS",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const zoneId = yield* resolveZoneId;
      const cwd = yield* cloneFixture(fixtureDir, {
        prefix: "alchemy-neon-dns-",
        tempRoot,
        entries: ["src", "build.sh"],
      });

      const site = yield* stack.deploy(
        Neon.Website.StaticSite("Site", {
          cwd,
          command: "bash build.sh",
          shell: true,
          outdir: "dist",
          domain: { name: HOSTNAME, dns: Cloudflare.DNS.Adapter() },
        }),
      );
      expect(site.url).toBe(`https://${HOSTNAME}`);
      const fn = site.function!;
      const domain = site.domain!;
      expect(domain.hostname).toBe(HOSTNAME);
      expect(domain.cnameTarget.length).toBeGreaterThan(0);

      // Exactly one record: a DNS-only CNAME to the CustomDomain's target.
      const records = yield* recordsUnder(zoneId);
      expect(
        records.map((record) => ({
          name: trimDot(record.name),
          type: record.type,
          content: trimDot(record.content ?? ""),
          proxied: record.proxied,
        })),
      ).toEqual([
        {
          name: HOSTNAME,
          type: "CNAME",
          content: trimDot(domain.cnameTarget),
          proxied: false,
        },
      ]);

      // Neon registered the hostname against the site's Function.
      const registered = yield* observeDomain(fn);
      expect(registered?.entity_type).toBe("function");
      expect(registered?.entity_id).toBe(fn.slug);
      expect(registered?.cname_target).toBe(domain.cnameTarget);

      yield* waitForAuthoritativeCname(domain.cnameTarget);

      const active = yield* observeDomain(fn).pipe(
        Effect.flatMap((live) =>
          live?.status === "active" && live.dns_status === "ok" && live.binding_status === "present"
            ? Effect.succeed(live)
            : Effect.fail(
                new DomainNotActive({
                  status: live?.status,
                  dnsStatus: live?.dns_status,
                  bindingStatus: live?.binding_status,
                }),
              ),
        ),
        Effect.tapError((error) => Effect.logInfo("Neon domain pending", error)),
        Effect.retry({
          while: (error) => error._tag === "DomainNotActive",
          schedule: Schedule.spaced("5 seconds"),
          times: 36,
        }),
      );
      expect(active.status).toBe("active");

      const client = yield* HttpClient.HttpClient;
      const body = yield* client.get(`https://${HOSTNAME}/`).pipe(
        Effect.flatMap(
          (res): Effect.Effect<string, HttpClientError.HttpClientError | SiteNotServing> =>
            res.status === 200 ? res.text : Effect.fail(new SiteNotServing({ status: res.status })),
        ),
        Effect.timeout("10 seconds"),
        Effect.tapError((error) =>
          Effect.logInfo(
            `https://${HOSTNAME} not serving yet: ${error._tag === "SiteNotServing" ? `HTTP ${error.status}` : error.message}`,
          ),
        ),
        Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 36 }),
      );
      expect(body).toContain(MARKER);

      yield* stack.destroy();

      expect(yield* recordsUnder(zoneId)).toEqual([]);
      // The site's implicit project (and with it the branch's domain) is gone.
      expect(
        yield* Api.getProject({ project_id: fn.projectId }).pipe(
          Effect.as("found" as const),
          Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
        ),
      ).toBe("gone");
    }),
  {
    tags: [
      "provider:neon",
      "provider:neon:customdomain",
      "provider:neon:website",
      "provider:cloudflare",
      "provider:cloudflare:dns",
      "live",
    ],
    timeout: 600_000,
  },
);
