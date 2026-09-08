import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Test from "@/Test/Alchemy";
import * as emailRouting from "@distilled.cloud/cloudflare/email-routing";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import RuleTargetWorker from "./fixtures/rule-target-worker.ts";
import { emailRoutingScoped } from "./scope.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const zoneName =
  process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

const resolveZoneId = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const zone = yield* findZoneByName({ accountId, name: zoneName });
  if (!zone) {
    return yield* Effect.die(
      new Error(`zone "${zoneName}" not found in account`),
    );
  }
  return zone.id;
});

// The scoped API token the test harness mints propagates eventually-
// consistently across Cloudflare's edge — a fresh token intermittently 403s.
const enableRouting = (zoneId: string) =>
  emailRouting.enableEmailRouting({ zoneId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

describe.sequential.skipIf(!emailRoutingScoped)(
  "Email.Rule -> Worker in one apply",
  () => {
    // Coverage for the shape reported in #1348: a Worker plus a routing
    // resource whose `{ type: "worker", value: [scriptName] }` action names
    // it, both created in the same apply, into a stage that did not exist.
    //
    // NOTE: this is a smoke test, NOT the regression guard for #1348. It was
    // confirmed to still pass with the provider's retry removed — by us and
    // independently by the reporter, who mutated the retry away and got three
    // green runs. The Worker provider pre-creates a stub script before the
    // rule is created (see "pre-creating" in a deploy log), so by the time
    // Cloudflare validates the action the name already resolves.
    //
    // The retry itself is guarded deterministically in `retry.test.ts`, which
    // injects the failure and does fail when the retry is removed. The error
    // is real and typed (`WorkerScriptNotFound`, Cloudflare code 2016,
    // observed live on both createRule and putRuleCatchAll).
    test.provider(
      "first deploy of a fresh stage creates the rule targeting the worker",
      (stack) =>
        Effect.gen(function* () {
          const zoneId = yield* resolveZoneId;

          // A never-before-deployed stage is the precondition — start from a
          // torn-down stack so the Worker really is created in this apply.
          yield* stack.destroy();
          yield* enableRouting(zoneId);

          const { rule, workerName } = yield* stack.deploy(
            Effect.gen(function* () {
              const routing = yield* Cloudflare.Email.Routing("Routing", {
                zone: zoneName,
              });
              const worker = yield* RuleTargetWorker;
              const rule = yield* Cloudflare.Email.Rule("WorkerRule", {
                zone: { zoneId: routing.zoneId },
                name: "alchemy worker-target test",
                matchers: [
                  {
                    type: "literal",
                    field: "to",
                    value: `worker-target@${zoneName}`,
                  },
                ],
                actions: [{ type: "worker", value: [worker.workerName] }],
              });
              return { rule, workerName: worker.workerName };
            }),
          );

          expect(rule.ruleId).not.toEqual("");
          expect(rule.zoneId).toEqual(zoneId);
          expect(rule.actions).toEqual([
            { type: "worker", value: [workerName] },
          ]);

          // Verify out-of-band that Cloudflare really stored the worker action.
          const live = yield* emailRouting
            .getRule({ zoneId, ruleIdentifier: rule.ruleId })
            .pipe(
              Effect.retry({
                while: (e) => e._tag === "Forbidden",
                schedule: Schedule.exponential("500 millis"),
                times: 8,
              }),
            );
          expect(live.actions?.[0]?.type).toEqual("worker");
          expect(live.actions?.[0]?.value).toEqual([workerName]);

          yield* stack.destroy();
        }).pipe(logLevel),
      { timeout: 180_000 },
    );

    // The catch-all rule takes a `worker` action through a different endpoint
    // (`/rules/catch_all`) and hits the same validation window.
    test.provider(
      "catch-all pointed at a Worker created in the same apply",
      (stack) =>
        Effect.gen(function* () {
          const zoneId = yield* resolveZoneId;

          yield* stack.destroy();
          yield* enableRouting(zoneId);

          const { catchAll, workerName } = yield* stack.deploy(
            Effect.gen(function* () {
              const routing = yield* Cloudflare.Email.Routing("Routing", {
                zone: zoneName,
              });
              const worker = yield* RuleTargetWorker;
              const catchAll = yield* Cloudflare.Email.CatchAll("CatchAll", {
                zone: { zoneId: routing.zoneId },
                name: "alchemy worker-target catch-all",
                actions: [{ type: "worker", value: [worker.workerName] }],
              });
              return { catchAll, workerName: worker.workerName };
            }),
          );

          expect(catchAll.zoneId).toEqual(zoneId);
          expect(catchAll.actions).toEqual([
            { type: "worker", value: [workerName] },
          ]);

          yield* stack.destroy();
        }).pipe(logLevel),
      { timeout: 180_000 },
    );
  },
);
