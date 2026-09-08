import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Cloudflare from "@/Cloudflare/index.ts";
import { WorkerVersionConfigError } from "@/Cloudflare/Workers/WorkerProvider.ts";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Test from "@/Test/Alchemy";
import * as rulesets from "@distilled.cloud/cloudflare/rulesets";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// The worker echoes the version-key header the transform rule sets, so a
// plain fetch proves the rule rewrote the request end-to-end.
const script = `export default { fetch(request) { return new Response(request.headers.get("Cloudflare-Workers-Version-Key") ?? "no-key"); } };`;

const zoneName =
  process.env.CLOUDFLARE_TEST_WORKER_DOMAIN_ZONE_NAME ??
  process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ??
  "alchemy-test-2.us";

// Deterministic per-run hostnames on the standing test zone (never derive
// names from Date.now()).
const suffix = process.env.PULL_REQUEST ?? process.env.USER ?? "local";

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

/**
 * Our affinity rules in the zone's late-transform phase entrypoint, as
 * `{ description, expression, value }` (value = the header-value
 * expression), sorted by description.
 */
const listAffinityRules = Effect.fn(function* (
  zoneId: string,
  scriptName: string,
) {
  const entrypoint = yield* rulesets
    .getPhasForZone({ zoneId, rulesetPhase: "http_request_late_transform" })
    .pipe(Effect.catch(() => Effect.succeed(undefined)));
  return (entrypoint?.rules ?? [])
    .flatMap((rule) => {
      if (
        !(rule.description ?? "").startsWith(
          `alchemy:worker:${scriptName}:affinity`,
        )
      ) {
        return [];
      }
      const headers =
        "actionParameters" in rule
          ? (
              rule.actionParameters as
                | { headers?: Record<string, unknown> | null }
                | null
                | undefined
            )?.headers
          : undefined;
      const header = headers?.["Cloudflare-Workers-Version-Key"] as
        | { expression?: unknown }
        | undefined;
      return [
        {
          description: rule.description as string,
          expression: rule.expression ?? "",
          value:
            typeof header?.expression === "string"
              ? header.expression
              : undefined,
        },
      ];
    })
    .sort((a, b) => a.description.localeCompare(b.description));
});

class DnsNotReady extends Data.TaggedError("DnsNotReady")<{
  hostname: string;
}> {}

/**
 * Wait until `hostname` resolves, querying over DNS-over-HTTPS. The system
 * resolver must not be asked before the record exists — an early lookup
 * negative-caches NXDOMAIN for the zone's SOA minimum TTL, poisoning every
 * later fetch in the test. Public DoH resolvers negative-cache too, so
 * each attempt alternates between two independent resolvers — a cached
 * pre-propagation NODATA answer on one can't stall the whole loop.
 */
const waitForDns = Effect.fn(function* (hostname: string) {
  const resolvers = ["1.1.1.1", "dns.google"];
  let attempt = 0;
  yield* Effect.tryPromise({
    try: async (signal) => {
      const resolver = resolvers[attempt++ % resolvers.length];
      const res = await fetch(
        `https://${resolver}/dns-query?name=${hostname}&type=AAAA`,
        { headers: { accept: "application/dns-json" }, signal },
      );
      const body = (await res.json()) as { Answer?: unknown[] };
      if (!body.Answer?.length) throw new Error("no answer");
    },
    catch: () => new DnsNotReady({ hostname }),
  }).pipe(
    Effect.retry({
      while: (e) => e._tag === "DnsNotReady",
      schedule: Schedule.spaced("5 seconds"),
      times: 60,
    }),
  );
});

class BodyMismatch extends Data.TaggedError("BodyMismatch")<{
  url: string;
  body: string;
}> {
  override get message() {
    return `unexpected body from ${this.url}: '${this.body}'`;
  }
}

/**
 * Fetch `url` (optionally with request headers) and assert the response
 * body satisfies `check`, retried through DNS/certificate/edge propagation
 * on a freshly attached custom domain.
 */
const expectBody = Effect.fn(function* (
  url: string,
  headers: Record<string, string>,
  check: (body: string) => boolean,
  options?: { times?: number },
) {
  yield* Effect.tryPromise({
    try: async (signal) => {
      const res = await fetch(url, { headers, signal });
      return await res.text();
    },
    catch: (cause) => new BodyMismatch({ url, body: String(cause) }),
  }).pipe(
    Effect.flatMap((body) =>
      check(body) ? Effect.void : Effect.fail(new BodyMismatch({ url, body })),
    ),
    Effect.retry({
      while: (e) => e._tag === "BodyMismatch",
      schedule: Schedule.spaced("5 seconds"),
      times: options?.times ?? 36,
    }),
  );
});

describe
  .skipIf(!!process.env.FAST)
  .concurrent("Cloudflare.Worker version affinity", () => {
    test.provider(
      "affinity rules converge across sources and clean up on destroy",
      (stack) =>
        Effect.gen(function* () {
          const zone = yield* resolveZone;
          const host = `wa-b-${suffix}.${zoneName}`;
          const routeHost = `*.wa-rt-${suffix}.${zoneName}`;

          yield* stack.destroy();

          const deploy = (
            affinity: Cloudflare.WorkerVersionAffinity | undefined,
          ) =>
            stack.deploy(
              Effect.gen(function* () {
                return yield* Cloudflare.Worker("AffinityWorker", {
                  script,
                  workersDev: false,
                  domain: host,
                  routes: [{ pattern: `${routeHost}/*` }],
                  version: { traffic: 50, affinity },
                });
              }),
            );

          // Sticky by session cookie, falling back to sticky IP: one rule
          // per condition, scoped to this Worker's hostnames in the zone.
          const v1 = yield* deploy({ cookie: "session_id", ip: true });
          expect(v1.affinityZoneIds).toEqual([zone.id]);
          const prefix = `alchemy:worker:${v1.workerName}:affinity`;
          const hostExpr = `(http.host eq "${host}" or http.host wildcard "${routeHost}")`;
          expect(yield* listAffinityRules(zone.id, v1.workerName)).toEqual([
            {
              description: `${prefix}:ip`,
              expression: `${hostExpr} and not (len(http.request.cookies["session_id"]) > 0)`,
              value: "to_string(ip.src)",
            },
            {
              description: `${prefix}:key`,
              expression: `${hostExpr} and len(http.request.cookies["session_id"]) > 0`,
              value: `http.request.cookies["session_id"][0]`,
            },
          ]);

          // The rule rewrites live zone traffic: the worker echoes the
          // version-key header, so a request carrying the cookie echoes the
          // cookie value and a bare request echoes the client IP.
          yield* waitForDns(host);
          // First fetch pays DNS + edge-certificate propagation on the fresh
          // custom domain — give it a longer budget than the follow-ups.
          yield* expectBody(
            `https://${host}`,
            { cookie: "session_id=alchemy-test-key" },
            (body) => body === "alchemy-test-key",
            { times: 60 },
          );
          yield* expectBody(
            `https://${host}`,
            {},
            (body) => body !== "no-key" && /^[0-9a-fA-F.:]+$/.test(body),
          );

          // Switching the source converges in place: the header rule
          // replaces the cookie rule and the IP fallback goes away.
          const v2 = yield* deploy({ header: "X-User-Id" });
          expect(v2.affinityZoneIds).toEqual([zone.id]);
          expect(yield* listAffinityRules(zone.id, v2.workerName)).toEqual([
            {
              description: `${prefix}:key`,
              expression: `${hostExpr} and len(http.request.headers["x-user-id"]) > 0`,
              value: `http.request.headers["x-user-id"][0]`,
            },
          ]);

          // Removing affinity removes the rules while the rollout continues.
          const v3 = yield* deploy(undefined);
          expect(v3.affinityZoneIds).toBeUndefined();
          expect(yield* listAffinityRules(zone.id, v3.workerName)).toEqual([]);

          // Re-add, then destroy — teardown must remove the rules too.
          const v4 = yield* deploy({ cookie: "session_id" });
          expect(yield* listAffinityRules(zone.id, v4.workerName)).toHaveLength(
            1,
          );
          yield* stack.destroy();
          expect(yield* listAffinityRules(zone.id, v4.workerName)).toEqual([]);
        }).pipe(logLevel),
      { timeout: 600_000 },
    );

    test.provider(
      "rejects affinity on a workers.dev-only worker",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const error = yield* stack
            .deploy(
              Effect.gen(function* () {
                return yield* Cloudflare.Worker("DevOnlyAffinity", {
                  script,
                  version: { traffic: 50, affinity: { cookie: "session_id" } },
                });
              }),
            )
            .pipe(Effect.flip);

          expect(error).toBeInstanceOf(WorkerVersionConfigError);
          expect(String(error)).toContain("zone Transform Rule");

          yield* stack.destroy();
        }).pipe(logLevel),
      { timeout: 180_000 },
    );

    test.provider(
      "a canary version worker pins users on the parent's zone",
      (stack) =>
        Effect.gen(function* () {
          const zone = yield* resolveZone;
          const host = `wa-p-${suffix}.${zoneName}`;

          yield* stack.destroy();

          const parentWorker = (marker: string) =>
            Cloudflare.Worker("AffinityParent", {
              script: `export default { fetch() { return new Response("${marker}"); } };`,
              workersDev: false,
              domain: host,
            });

          // Parent + canary in one stack: the canary carries the affinity,
          // and the rule lands on the parent's zone under the parent's name.
          const v1 = yield* stack.deploy(
            Effect.gen(function* () {
              const parent = yield* parentWorker("parent-v1");
              const canary = yield* Cloudflare.Worker("AffinityCanary", {
                script,
                version: {
                  parent,
                  traffic: 25,
                  affinity: { cookie: "session_id" },
                },
              });
              return { parent, canary };
            }),
          );
          expect(v1.canary.affinityZoneIds).toEqual([zone.id]);
          const rules = yield* listAffinityRules(zone.id, v1.parent.workerName);
          expect(rules).toHaveLength(1);
          expect(rules[0].description).toEqual(
            `alchemy:worker:${v1.parent.workerName}:affinity:key`,
          );
          expect(rules[0].expression).toEqual(
            `http.host eq "${host}" and len(http.request.cookies["session_id"]) > 0`,
          );

          // Releasing the canary deletes the version resource — its delete
          // must also clear the rules it owned on the parent's zone.
          const v2 = yield* stack.deploy(
            Effect.gen(function* () {
              const parent = yield* parentWorker("parent-v1");
              return { parent };
            }),
          );
          expect(
            yield* listAffinityRules(zone.id, v2.parent.workerName),
          ).toEqual([]);

          yield* stack.destroy();
        }).pipe(logLevel),
      { timeout: 420_000 },
    );
  });
