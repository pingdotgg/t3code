import * as AWS from "@/AWS";
import { AnomalyMonitor } from "@/AWS/CostExplorer/AnomalyMonitor.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { Region as AwsRegion } from "@distilled.cloud/aws/Region";
import * as ce from "@distilled.cloud/aws/cost-explorer";
import * as sts from "@distilled.cloud/aws/sts";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Cost Explorer is served exclusively from us-east-1.
const pin = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(AwsRegion, Effect.succeed("us-east-1")));

const monitorName = "alchemy-test-anomaly-monitor";

// getAnomalyMonitors returns an empty list (NOT an error) for an unknown ARN,
// so absence is `AnomalyMonitors[0] === undefined`.
const getMonitor = (monitorArn: string) =>
  pin(ce.getAnomalyMonitors({ MonitorArnList: [monitorArn] })).pipe(
    Effect.map((r) => r.AnomalyMonitors[0]),
    Effect.catchTag("UnknownMonitorException", () => Effect.succeed(undefined)),
  );

// Typed wait-until-gone: deletion is synchronous but tolerate a short
// eventual-consistency window.
const assertMonitorGone = (monitorArn: string) =>
  Effect.gen(function* () {
    const found = yield* getMonitor(monitorArn);
    if (found !== undefined) {
      return yield* Effect.fail(
        new Error(`monitor '${monitorArn}' still exists`),
      );
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(5)]),
    }),
  );

// Ungated typed-error probe: prove the distilled error union carries the
// not-found tag this provider's delete path depends on. (GetAnomalyMonitors
// succeeds with an empty list for unknown ARNs — delete is the op that
// raises the typed tag.)
test.provider(
  "deleteAnomalyMonitor on a nonexistent monitor ARN fails with UnknownMonitorException",
  () =>
    Effect.gen(function* () {
      // The ARN must carry the caller's account — a foreign account ARN is
      // rejected earlier with AccessDeniedException.
      const identity = yield* sts.getCallerIdentity({});
      const error = yield* Effect.flip(
        pin(
          ce.deleteAnomalyMonitor({
            MonitorArn: `arn:aws:ce::${identity.Account}:anomalymonitor/00000000-0000-0000-0000-000000000000`,
          }),
        ),
      );
      expect(error._tag).toBe("UnknownMonitorException");
    }),
  { timeout: 60_000 },
);

test.provider(
  "lifecycle: create CUSTOM monitor with explicit name, rename in place, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // CUSTOM avoids the one-DIMENSIONAL-SERVICE-monitor-per-account quota.
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const monitor = yield* AnomalyMonitor("Monitor", {
            monitorName,
            monitorType: "CUSTOM",
            monitorSpecification: {
              Tags: { Key: "CostCenter", Values: ["alchemy-test"] },
            },
            tags: { fixture: "cost-explorer-anomaly-monitor" },
          });
          return { monitorArn: monitor.monitorArn };
        }),
      );

      // Out-of-band verification via distilled.
      const created = yield* getMonitor(deployed.monitorArn);
      expect(created?.MonitorName).toBe(monitorName);
      expect(created?.MonitorType).toBe("CUSTOM");
      const tags = yield* pin(
        ce.listTagsForResource({ ResourceArn: deployed.monitorArn }),
      );
      const tagRecord = Object.fromEntries(
        (tags.ResourceTags ?? []).map((t) => [t.Key, t.Value]),
      );
      expect(tagRecord.fixture).toBe("cost-explorer-anomaly-monitor");
      expect(tagRecord["alchemy::id"]).toBe("Monitor");

      // Canonical list() coverage.
      const provider = yield* Provider.findProvider(AnomalyMonitor);
      const all = yield* provider.list();
      expect(all.some((m) => m.monitorArn === deployed.monitorArn)).toBe(true);

      // Rename — the name is mutable in place; the ARN must be stable.
      const renamed = yield* stack.deploy(
        Effect.gen(function* () {
          const monitor = yield* AnomalyMonitor("Monitor", {
            monitorName: `${monitorName}-renamed`,
            monitorType: "CUSTOM",
            monitorSpecification: {
              Tags: { Key: "CostCenter", Values: ["alchemy-test"] },
            },
            tags: { fixture: "cost-explorer-anomaly-monitor" },
          });
          return { monitorArn: monitor.monitorArn };
        }),
      );
      expect(renamed.monitorArn).toBe(deployed.monitorArn);
      const afterRename = yield* getMonitor(deployed.monitorArn);
      expect(afterRename?.MonitorName).toBe(`${monitorName}-renamed`);

      // Destroy — the monitor is gone.
      yield* stack.destroy();
      yield* assertMonitorGone(deployed.monitorArn);
    }),
  { timeout: 120_000 },
);

// Monitor names are unique per account and the specification is create-only,
// so replacement coverage uses the engine-generated physical name (a new
// instance ID yields a new name, letting create-before-delete succeed).
test.provider(
  "replacement: changing the monitor specification replaces the monitor",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const makeMonitor = (costCenter: string) =>
        Effect.gen(function* () {
          const monitor = yield* AnomalyMonitor("ReplaceMonitor", {
            monitorType: "CUSTOM",
            monitorSpecification: {
              Tags: { Key: "CostCenter", Values: [costCenter] },
            },
          });
          return { monitorArn: monitor.monitorArn };
        });

      const deployed = yield* stack.deploy(makeMonitor("alchemy-replace-1"));
      const created = yield* getMonitor(deployed.monitorArn);
      expect(created?.MonitorType).toBe("CUSTOM");

      // Change the specification — create-only, must replace (new ARN).
      const replaced = yield* stack.deploy(makeMonitor("alchemy-replace-2"));
      expect(replaced.monitorArn).not.toBe(deployed.monitorArn);
      yield* assertMonitorGone(deployed.monitorArn);
      const after = yield* getMonitor(replaced.monitorArn);
      expect(after?.MonitorSpecification?.Tags?.Values).toEqual([
        "alchemy-replace-2",
      ]);

      // Destroy — the replacement monitor is gone.
      yield* stack.destroy();
      yield* assertMonitorGone(replaced.monitorArn);
    }),
  { timeout: 120_000 },
);
