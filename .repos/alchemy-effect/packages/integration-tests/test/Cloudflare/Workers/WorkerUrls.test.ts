import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { WorkerDomainConfigError } from "@alchemy.run/cloudflare/Workers/WorkerProvider";
import { findZoneByName } from "@alchemy.run/cloudflare/Zone/lookup";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as rulesets from "@distilled.cloud/cloudflare/rulesets";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { stageSuffix } from "../../names.ts";
import { expectUrlContains, waitForDns } from "../Utils/Http.ts";
import { waitForWorkerToBeDeleted } from "../Utils/Worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const script = (marker: string) =>
  `export default { fetch() { return new Response("${marker}"); } };`;

class RedirectNotReady extends Data.TaggedError("RedirectNotReady")<{
  url: string;
  detail: string;
}> {}

/**
 * Fetch `from` without following redirects and assert a 301 whose
 * `location` matches `expectedLocation` exactly (path + query preserved).
 * Retried through DNS/certificate propagation on a freshly attached
 * custom domain.
 */
const expectRedirect = Effect.fn(function* (from: string, expectedLocation: string) {
  const location = yield* Effect.tryPromise({
    try: async (signal) => {
      const res = await fetch(from, { redirect: "manual", signal });
      if (res.status !== 301) {
        throw new Error(`expected 301, got ${res.status}`);
      }
      return res.headers.get("location") ?? "";
    },
    catch: (cause) => new RedirectNotReady({ url: from, detail: String(cause) }),
  }).pipe(
    Effect.flatMap((location) =>
      location === expectedLocation
        ? Effect.succeed(location)
        : Effect.fail(
            new RedirectNotReady({
              url: from,
              detail: `location was '${location}', expected '${expectedLocation}'`,
            }),
          ),
    ),
    Effect.retry({
      while: (e) => e._tag === "RedirectNotReady",
      schedule: Schedule.spaced("5 seconds"),
      times: 48,
    }),
  );
  expect(location).toEqual(expectedLocation);
});

/** Our redirect rules in the zone's dynamic-redirect phase entrypoint. */
const listWorkerRedirectRules = Effect.fn(function* (zoneId: string, scriptName: string) {
  const entrypoint = yield* rulesets
    .getPhasForZone({ zoneId, rulesetPhase: "http_request_dynamic_redirect" })
    .pipe(Effect.catchTag("RulesetNotFound", () => Effect.succeed(undefined)));
  return (entrypoint?.rules ?? []).flatMap((rule) =>
    (rule.description ?? "").startsWith(`alchemy:worker:${scriptName}:redirect:`)
      ? [rule.description as string]
      : [],
  );
});

describe.concurrent(
  "Cloudflare.Worker urls & domain",
  { tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"] },
  () => {
    test.provider(
      "rejects a hostname playing more than one role",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const error = yield* stack
            .deploy(
              Effect.gen(function* () {
                return yield* Cloudflare.Worker("OverlapWorker", {
                  script: script("overlap"),
                  domain: { name: "app.example.com", aliases: ["app.example.com"] },
                });
              }),
            )
            .pipe(Effect.flip);

          expect(error).toBeInstanceOf(WorkerDomainConfigError);
          expect(String(error)).toContain("one role");

          yield* stack.destroy();
        }).pipe(logLevel),
      { timeout: 120_000 },
    );

    const customDomainZone =
      process.env.CLOUDFLARE_TEST_WORKER_DOMAIN_ZONE_NAME ?? "alchemy-test-2.us";
    test.provider(
      "redirect hostnames 301 to the canonical name and stay out of urls",
      (stack) =>
        Effect.gen(function* () {
          const { accountId } = yield* yield* CloudflareEnvironment;
          const suffix = stageSuffix();
          const mainHost = `alchemy-rdr-a-${suffix}.${customDomainZone}`;
          const oldHost = `alchemy-rdr-b-${suffix}.${customDomainZone}`;
          const aliasHost = `alchemy-rdr-c-${suffix}.${customDomainZone}`;

          yield* stack.destroy();

          const deploy = (domain: { name: string; aliases?: string[]; redirects?: string[] }) =>
            stack.deploy(
              Effect.gen(function* () {
                return yield* Cloudflare.Worker("RedirectWorker", {
                  script: script("redirect-target"),
                  domain,
                });
              }),
            );

          const worker = yield* deploy({
            name: mainHost,
            aliases: [aliasHost],
            redirects: [oldHost],
          });

          // All three roles resolve into the domain output; the redirect
          // hostname serves nothing, so it must not appear in `urls`.
          expect(worker.domain).toEqual({
            name: mainHost,
            aliases: [aliasHost],
            redirects: [oldHost],
          });
          expect(worker.url).toEqual(`https://${mainHost}`);
          expect(worker.urls.slice(0, 2)).toEqual([`https://${mainHost}`, `https://${aliasHost}`]);
          expect(worker.urls.some((u) => u.includes(oldHost))).toBe(false);
          // workers.dev stays on by default and ranks after the domain.
          expect(worker.urls[worker.urls.length - 1]).toMatch(/\.workers\.dev$/);

          // Our tagged rule exists in the zone's shared entrypoint — one for
          // the redirect host, none for the alias (aliases serve, not 301).
          const zone = yield* findZoneByName({ accountId, name: customDomainZone! });
          expect(zone).toBeDefined();
          expect(yield* listWorkerRedirectRules(zone!.id, worker.workerName)).toEqual([
            `alchemy:worker:${worker.workerName}:redirect:${oldHost}`,
          ]);

          // The canonical domain AND the alias serve the Worker; the
          // redirect host 301s with path and query preserved — and never
          // invokes the Worker. Confirm DNS on the authoritative nameservers
          // before the first fetch (see waitForDns in ../Utils/Http.ts).
          yield* waitForDns(mainHost);
          yield* waitForDns(aliasHost);
          yield* waitForDns(oldHost);
          yield* expectUrlContains(worker.url!, "redirect-target", {
            label: "canonical domain serves the worker",
            timeout: "120 seconds",
          });
          yield* expectUrlContains(`https://${aliasHost}`, "redirect-target", {
            label: "alias serves the worker",
            timeout: "120 seconds",
          });
          yield* expectRedirect(`https://${oldHost}/hello?x=1`, `https://${mainHost}/hello?x=1`);

          // Removing the redirect cleans our rule and detaches nothing else.
          const updated = yield* deploy({ name: mainHost });
          expect(updated.domain).toEqual({ name: mainHost, aliases: [], redirects: [] });
          expect(yield* listWorkerRedirectRules(zone!.id, updated.workerName)).toEqual([]);

          // Re-add, then destroy — teardown must remove the rule too.
          const readded = yield* deploy({ name: mainHost, redirects: [oldHost] });
          expect(yield* listWorkerRedirectRules(zone!.id, readded.workerName)).toHaveLength(1);
          yield* stack.destroy();
          expect(yield* listWorkerRedirectRules(zone!.id, readded.workerName)).toEqual([]);
          yield* waitForWorkerToBeDeleted(readded.workerName, accountId);
        }).pipe(logLevel),
      { tags: ["provider:cloudflare:ruleset", "provider:cloudflare:zone"], timeout: 540_000 },
    );

    test.provider(
      "domain string shorthand resolves to { name }",
      (stack) =>
        Effect.gen(function* () {
          const suffix = stageSuffix();
          const host = `alchemy-shorthand-${suffix}.${customDomainZone}`;

          yield* stack.destroy();

          const worker = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* Cloudflare.Worker("ShorthandWorker", {
                script: script("shorthand"),
                domain: host,
                workersDev: false,
              });
            }),
          );

          expect(worker.domain).toEqual({ name: host, aliases: [], redirects: [] });
          expect(worker.url).toEqual(`https://${host}`);
          expect(worker.urls).toEqual([`https://${host}`]);

          yield* stack.destroy();
        }).pipe(logLevel),
      { timeout: 240_000 },
    );
  },
);
