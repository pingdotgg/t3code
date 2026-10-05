import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Cloudflare from "@/Cloudflare/index.ts";
import { WorkerVersionConfigError } from "@/Cloudflare/Workers/WorkerProvider.ts";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Test from "@/Test/Alchemy";
import * as rulesets from "@distilled.cloud/cloudflare/rulesets";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

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

const DnsResponse = Schema.Struct({
  Status: Schema.Number,
  Answer: Schema.optional(
    Schema.Array(Schema.Struct({ type: Schema.Number, data: Schema.String })),
  ),
});

// Use public DNS answers for the socket lookup too: the OS can retain a
// negative answer from an earlier delete even after public DNS has converged.
const domainClient = Effect.fn(function* (hostname: string) {
  const resolvers = ["https://1.1.1.1/dns-query", "https://dns.google/resolve"];
  let attempt = 0;
  const addresses = yield* Effect.suspend(() =>
    HttpClient.get(resolvers[attempt++ % resolvers.length], {
      headers: { accept: "application/dns-json" },
      urlParams: { name: hostname, type: "A" },
    }),
  ).pipe(
    Effect.flatMap(HttpClientResponse.schemaBodyJson(DnsResponse)),
    Effect.flatMap((response) => {
      const addresses = (response.Answer ?? [])
        .filter((answer) => answer.type === 1)
        .map((answer) => ({ address: answer.data, family: 4 }));
      return response.Status === 0 && addresses.length > 0
        ? Effect.succeed(addresses)
        : Effect.fail(new DnsNotReady({ hostname }));
    }),
    Effect.retry({
      while: (error) => error._tag === "DnsNotReady",
      schedule: Schedule.spaced("5 seconds"),
      times: 10,
    }),
    Effect.timeout("60 seconds"),
  );
  const agent = yield* NodeHttpClient.makeAgent({
    lookup: (requestedHost, options, callback) => {
      if (requestedHost !== hostname) {
        callback(new Error(`Unexpected domain lookup: ${requestedHost}`), "");
      } else if (options.all) {
        callback(null, addresses);
      } else {
        callback(null, addresses[0].address, 4);
      }
    },
  });
  // Keep the hostname in the URL so TLS certificate and SNI checks stay intact.
  return yield* NodeHttpClient.makeNodeHttp.pipe(
    Effect.provideService(NodeHttpClient.HttpAgent, agent),
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
  client: HttpClient.HttpClient,
  url: string,
  headers: Record<string, string>,
  check: (body: string) => boolean,
  retryDelay: Duration.Input = "1 second",
) {
  yield* client.get(url, { headers }).pipe(
    Effect.flatMap((response) =>
      response.text.pipe(
        Effect.flatMap((body) =>
          response.status === 200 && check(body)
            ? Effect.void
            : Effect.fail(
                new BodyMismatch({ url, body: `${response.status}: ${body}` }),
              ),
        ),
      ),
    ),
    Effect.timeout("5 seconds"),
    Effect.retry({
      schedule: Schedule.spaced(retryDelay),
      times: 10,
    }),
    Effect.timeout("60 seconds"),
  );
});

// These lifecycle tests mutate the same zone-level transform ruleset.
describe
  .skipIf(!!process.env.FAST)
  .sequential(
    "Cloudflare.Worker version affinity",
    { tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"] },
    () => {
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
            const client = yield* domainClient(host);
            yield* expectBody(
              client,
              `https://${host}`,
              { cookie: "session_id=alchemy-test-key" },
              (body) => body === "alchemy-test-key",
              "5 seconds",
            );
            yield* expectBody(
              client,
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
            expect(yield* listAffinityRules(zone.id, v3.workerName)).toEqual(
              [],
            );

            // Re-add, then destroy — teardown must remove the rules too.
            const v4 = yield* deploy({ cookie: "session_id" });
            expect(
              yield* listAffinityRules(zone.id, v4.workerName),
            ).toHaveLength(1);
            yield* stack.destroy();
            expect(yield* listAffinityRules(zone.id, v4.workerName)).toEqual(
              [],
            );
          }).pipe(logLevel),
        {
          tags: ["provider:cloudflare:ruleset", "provider:cloudflare:zone"],
          timeout: 600_000,
        },
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
                    version: {
                      traffic: 50,
                      affinity: { cookie: "session_id" },
                    },
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
            const rules = yield* listAffinityRules(
              zone.id,
              v1.parent.workerName,
            );
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
        {
          tags: ["provider:cloudflare:ruleset", "provider:cloudflare:zone"],
          timeout: 420_000,
        },
      );
    },
  );
