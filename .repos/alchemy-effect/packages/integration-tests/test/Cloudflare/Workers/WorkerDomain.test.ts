import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@alchemy.run/cloudflare/Zone/lookup";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as rulesets from "@distilled.cloud/cloudflare/rulesets";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as Drift from "alchemy/Drift";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";
import { stageSuffix } from "../../names.ts";
import { waitForWorkerToBeDeleted } from "../Utils/Worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const main = pathe.resolve(import.meta.dirname, "fixtures/worker.ts");

const zoneName =
  process.env.CLOUDFLARE_TEST_WORKER_DOMAIN_ZONE_NAME ??
  process.env.CLOUDFLARE_TEST_R2_DOMAIN_ZONE_NAME ??
  "alchemy-test-2.us";

// Deterministic per-run hostnames on the standing test zone. Each rerun
// reuses the same hostnames (never derive names from Date.now()).
const domainSuffix = `alchemy-worker-domain-${stageSuffix()}`;

const DECLARED_HOSTNAME = `wd1-${domainSuffix}.${zoneName}`;
const OUT_OF_BAND_HOSTNAME = `wd2-${domainSuffix}.${zoneName}`;
const REDIRECT_NAME_A = `wd3-${domainSuffix}.${zoneName}`;
const REDIRECT_NAME_B = `wd4-${domainSuffix}.${zoneName}`;
const REDIRECT_FROM = `wd5-${domainSuffix}.${zoneName}`;
const ZONED_HOSTNAME = `wd6-${domainSuffix}.${zoneName}`;
const ZONED_DRIFT_HOSTNAME = `wd7-${domainSuffix}.${zoneName}`;

const resolveZoneId = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const zone = yield* findZoneByName({ accountId, name: zoneName });
  if (!zone) {
    return yield* Effect.die(new Error(`zone "${zoneName}" not found in account`));
  }
  return zone.id;
});

// Retry rate-limit blips on the tests' own out-of-band verification calls.
const transientRetrySchedule = Schedule.exponential("500 millis");

const listAttachments = (hostname: string) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;
    return yield* workers.listDomains({ accountId, hostname }).pipe(
      Effect.map((r) => (r.result ?? []).filter((d) => d.hostname === hostname)),
      Effect.retry({
        while: (e) => e._tag === "TooManyRequests",
        schedule: transientRetrySchedule,
        times: 8,
      }),
    );
  });

const findAttachment = (hostname: string) =>
  listAttachments(hostname).pipe(Effect.map((ds) => ds[0]));

// Detach every worker-domain attachment for the given hostnames — purge
// leftovers from interrupted runs so tests start from a clean slate.
const purgeDomains = (...hostnames: string[]) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;
    yield* Effect.forEach(hostnames, (hostname) =>
      listAttachments(hostname).pipe(
        Effect.flatMap(
          Effect.forEach((d) =>
            d.id
              ? workers
                  .deleteDomain({ accountId, domainId: d.id })
                  .pipe(Effect.catch(() => Effect.void))
              : Effect.void,
          ),
        ),
      ),
    );
  });

// #942: an omitted `domain` prop must leave live attachments alone —
// including hostnames attached outside Alchemy — while `domain: null` is the
// explicit detach-all. The gate keys on declared intent (props), never on
// domains persisted in state, so state written by older providers that
// observed listDomains unconditionally cannot re-arm the destructive path.
test.provider(
  "omitted domain preserves live attachments; null detaches all",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();
      yield* purgeDomains(DECLARED_HOSTNAME, OUT_OF_BAND_HOSTNAME);

      let workerName: string | undefined;

      yield* Effect.gen(function* () {
        // Create — one declared custom domain.
        const worker = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Worker("DomainWorker", {
              main,
              workersDev: false,
              compatibility: { date: "2024-01-01" },
              domain: DECLARED_HOSTNAME,
            });
          }),
        );
        workerName = worker.workerName;

        expect(worker.urls).toEqual([`https://${DECLARED_HOSTNAME}`]);
        expect(worker.domain).toEqual({
          name: DECLARED_HOSTNAME,
          aliases: [],
          redirects: [],
        });
        const declared = yield* findAttachment(DECLARED_HOSTNAME);
        expect(declared?.service).toEqual(worker.workerName);

        // Attach a second hostname to the same script out-of-band — the
        // reconciler never recorded it, so it is unmanaged drift.
        yield* workers
          .putDomain({
            accountId,
            hostname: OUT_OF_BAND_HOSTNAME,
            service: worker.workerName,
            zoneId,
          })
          .pipe(
            // Same eventual-consistency window as the provider's own
            // attachDomain: PUT domains right after putScript can race the
            // script registry and return WorkerNotFound.
            Effect.retry({
              while: (e): boolean => e._tag === "WorkerNotFound" || e._tag === "TooManyRequests",
              schedule: transientRetrySchedule,
              times: 8,
            }),
          );

        // Update with `domain` omitted (compat date bump forces the
        // update): both attachments must survive — omission unmanages the
        // surface, it does not mean "detach everything".
        const unmanaged = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Worker("DomainWorker", {
              main,
              workersDev: false,
              compatibility: { date: "2024-01-02" },
            });
          }),
        );

        expect((yield* findAttachment(DECLARED_HOSTNAME))?.service).toEqual(worker.workerName);
        expect((yield* findAttachment(OUT_OF_BAND_HOSTNAME))?.service).toEqual(worker.workerName);
        // Previously-observed custom domains carry forward in state so
        // subsequent reads keep observing them.
        expect(unmanaged.domain?.name).toEqual(DECLARED_HOSTNAME);
        expect(unmanaged.urls).toContain(`https://${DECLARED_HOSTNAME}`);

        // The unmanaged surface must also converge: the custom domains
        // carried forward in state must not diff dirty against the omitted
        // `domain` prop — an identical program plans as a noop.
        const settled = yield* stack.plan(
          Effect.gen(function* () {
            return yield* Cloudflare.Worker("DomainWorker", {
              main,
              workersDev: false,
              compatibility: { date: "2024-01-02" },
            });
          }),
        );
        const settledAction = (Object.values(settled.resources) as any[]).find(
          (node: any) => node.resource.LogicalId === "DomainWorker",
        )?.action;
        expect(settledAction).toBe("noop");

        // `domain: null` is the explicit detach-all.
        const detached = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Worker("DomainWorker", {
              main,
              workersDev: false,
              compatibility: { date: "2024-01-02" },
              domain: null,
            });
          }),
        );

        expect(detached.domain).toBeUndefined();
        expect(detached.urls).toHaveLength(0);
        expect(yield* findAttachment(DECLARED_HOSTNAME)).toBeUndefined();
        expect(yield* findAttachment(OUT_OF_BAND_HOSTNAME)).toBeUndefined();
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* stack.destroy().pipe(Effect.ignore);
            yield* purgeDomains(DECLARED_HOSTNAME, OUT_OF_BAND_HOSTNAME).pipe(Effect.ignore);
            if (workerName) {
              yield* waitForWorkerToBeDeleted(workerName, accountId).pipe(Effect.ignore);
            }
          }),
        ),
      );
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:worker", "provider:cloudflare:zone", "live"],
    timeout: 300_000,
  },
);

test.provider(
  "a domain with zoneName does not drift until a hostname is attached out-of-band",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const zoneId = yield* resolveZoneId;
      const detectDrift = () => Drift.detect(stack).pipe(Effect.provide(stack.state));

      yield* stack.destroy();
      yield* purgeDomains(ZONED_HOSTNAME, ZONED_DRIFT_HOSTNAME);

      let workerName: string | undefined;

      yield* Effect.gen(function* () {
        const worker = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Worker("ZonedDomainWorker", {
              main,
              workersDev: false,
              compatibility: { date: "2024-01-01" },
              domain: { name: ZONED_HOSTNAME, zoneName },
            });
          }),
        );
        workerName = worker.workerName;
        expect(worker.domain).toEqual({
          name: ZONED_HOSTNAME,
          aliases: [],
          redirects: [],
          zone: zoneName,
        });

        // `read` keeps the resolved zone while the declared hostname is
        // attached, so an unchanged Worker is not reported as drifted.
        const unchanged = yield* detectDrift();
        expect(unchanged.resources.ZonedDomainWorker?.action).toBe("unchanged");

        // A hostname attached outside Alchemy is still real drift.
        yield* workers
          .putDomain({
            accountId,
            hostname: ZONED_DRIFT_HOSTNAME,
            service: worker.workerName,
            zoneId,
          })
          .pipe(
            Effect.retry({
              while: (e): boolean => e._tag === "WorkerNotFound" || e._tag === "TooManyRequests",
              schedule: transientRetrySchedule,
              times: 8,
            }),
          );
        const changed = yield* detectDrift();
        expect(changed.resources.ZonedDomainWorker?.action).toBe("drifted");
        expect(changed.resources.ZonedDomainWorker?.attr.domain).toEqual({
          name: ZONED_HOSTNAME,
          aliases: [ZONED_DRIFT_HOSTNAME],
          redirects: [],
          zone: zoneName,
        });
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* stack.destroy().pipe(Effect.ignore);
            yield* purgeDomains(ZONED_HOSTNAME, ZONED_DRIFT_HOSTNAME).pipe(Effect.ignore);
            if (workerName) {
              yield* waitForWorkerToBeDeleted(workerName, accountId).pipe(Effect.ignore);
            }
          }),
        ),
      );
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:worker", "provider:cloudflare:zone", "live"],
    timeout: 300_000,
  },
);

/**
 * The redirect-target expression of every redirect rule this Worker owns
 * in the zone's dynamic-redirect phase, keyed by the redirected hostname.
 */
const listRedirectTargets = Effect.fn(function* (zoneId: string, scriptName: string) {
  const prefix = `alchemy:worker:${scriptName}:redirect:`;
  const entrypoint = yield* rulesets
    .getPhasForZone({ zoneId, rulesetPhase: "http_request_dynamic_redirect" })
    .pipe(Effect.catchTag("RulesetNotFound", () => Effect.succeed(undefined)));
  return Object.fromEntries(
    (entrypoint?.rules ?? []).flatMap((rule) => {
      const description = rule.description ?? "";
      if (!description.startsWith(prefix)) return [];
      const fromValue =
        "actionParameters" in rule
          ? (
              rule.actionParameters as
                | { fromValue?: { targetUrl?: { expression?: unknown } | null } | null }
                | null
                | undefined
            )?.fromValue
          : undefined;
      return [[description.slice(prefix.length), fromValue?.targetUrl?.expression]];
    }),
  );
});

// #2759: renaming the canonical `name` keeps every redirect rule's
// description and match expression, so a convergence check on those alone
// skipped the PUT and the redirects kept pointing at the old host.
test.provider(
  "changing the canonical name retargets domain redirects",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();
      yield* purgeDomains(REDIRECT_NAME_A, REDIRECT_NAME_B, REDIRECT_FROM);

      let workerName: string | undefined;

      const deploy = (name: string) =>
        stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Worker("RedirectWorker", {
              main,
              workersDev: false,
              compatibility: { date: "2024-01-01" },
              domain: { name, redirects: [REDIRECT_FROM] },
            });
          }),
        );

      yield* Effect.gen(function* () {
        const worker = yield* deploy(REDIRECT_NAME_A);
        workerName = worker.workerName;
        expect(worker.domain).toEqual({
          name: REDIRECT_NAME_A,
          aliases: [],
          redirects: [REDIRECT_FROM],
        });
        expect(yield* listRedirectTargets(zoneId, worker.workerName)).toEqual({
          [REDIRECT_FROM]: `concat("https://${REDIRECT_NAME_A}", http.request.uri.path)`,
        });

        // Same redirect hostname, new canonical name: the rule must follow.
        const renamed = yield* deploy(REDIRECT_NAME_B);
        expect(renamed.domain?.name).toEqual(REDIRECT_NAME_B);
        expect(yield* listRedirectTargets(zoneId, worker.workerName)).toEqual({
          [REDIRECT_FROM]: `concat("https://${REDIRECT_NAME_B}", http.request.uri.path)`,
        });

        yield* stack.destroy();
        expect(yield* listRedirectTargets(zoneId, worker.workerName)).toEqual({});
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* stack.destroy().pipe(Effect.ignore);
            yield* purgeDomains(REDIRECT_NAME_A, REDIRECT_NAME_B, REDIRECT_FROM).pipe(
              Effect.ignore,
            );
            if (workerName) {
              yield* waitForWorkerToBeDeleted(workerName, accountId).pipe(Effect.ignore);
            }
          }),
        ),
      );
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:worker", "provider:cloudflare:zone", "live"],
    timeout: 300_000,
  },
);
