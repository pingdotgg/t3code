import * as AWS from "@/AWS";
import { ServiceLevelObjective } from "@/AWS/ApplicationSignals";
import * as Test from "@/Test/Alchemy";
import * as appsignals from "@distilled.cloud/aws/application-signals";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: prove the distilled error union carries the
// not-found tag this provider's read/delete paths depend on. Runs in every
// CI pass at near-zero cost.
test.provider(
  "getServiceLevelObjective on a bogus id fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        appsignals.getServiceLevelObjective({
          Id: "alchemy-nonexistent-slo-probe",
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

// A period-based SLI over an arbitrary CloudWatch metric (the metric does
// not need to exist for the SLO to be valid).
const sliConfig = (
  threshold: number,
): appsignals.ServiceLevelIndicatorConfig => ({
  SliMetricConfig: {
    MetricDataQueries: [
      {
        Id: "m1",
        MetricStat: {
          Metric: {
            Namespace: "Alchemy/Test",
            MetricName: "AppSignalsSloLatency",
            Dimensions: [{ Name: "Fixture", Value: "slo" }],
          },
          Period: 60,
          Stat: "Average",
        },
        ReturnData: true,
      },
    ],
  },
  MetricThreshold: threshold,
  ComparisonOperator: "LessThanOrEqualTo",
});

const goal = (attainmentGoal: number): appsignals.Goal => ({
  Interval: { RollingInterval: { DurationUnit: "DAY", Duration: 7 } },
  AttainmentGoal: attainmentGoal,
  WarningThreshold: 50,
});

// Deletion is synchronous but allow brief eventual consistency.
const assertSloGone = (id: string) =>
  appsignals.getServiceLevelObjective({ Id: id }).pipe(
    Effect.flatMap((r) =>
      Effect.fail(new Error(`slo '${r.Slo.Name}' still exists`)),
    ),
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
    Effect.retry({
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(10),
      ]),
    }),
  );

test.provider(
  "create, update in place, replace on rename, destroy SLO",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // CREATE — engine-generated deterministic name.
      const { slo } = yield* stack.deploy(
        Effect.gen(function* () {
          const slo = yield* ServiceLevelObjective("Slo", {
            description: "alchemy application-signals test slo",
            sliConfig: sliConfig(2000),
            goal: goal(99),
            tags: { fixture: "application-signals-slo" },
          });
          return { slo };
        }),
      );

      expect(slo.sloName).toBeDefined();
      expect(slo.sloArn).toContain(":slo/");
      expect(slo.evaluationType).toBe("PeriodBased");

      // Out-of-band verification via distilled.
      const observed = yield* appsignals
        .getServiceLevelObjective({ Id: slo.sloName })
        .pipe(Effect.map((r) => r.Slo));
      expect(observed.Arn).toBe(slo.sloArn);
      expect(observed.Description).toBe("alchemy application-signals test slo");
      expect(observed.Goal.AttainmentGoal).toBe(99);
      expect(observed.Sli?.MetricThreshold).toBe(2000);

      // Tags: user tag + internal Alchemy branding.
      const tags = yield* appsignals
        .listTagsForResource({ ResourceArn: slo.sloArn })
        .pipe(
          Effect.map((r) =>
            Object.fromEntries((r.Tags ?? []).map((t) => [t.Key, t.Value])),
          ),
        );
      expect(tags.fixture).toBe("application-signals-slo");
      expect(tags["alchemy::id"]).toBe("Slo");

      // UPDATE IN PLACE — new description, threshold, attainment, and tag.
      const { slo: updated } = yield* stack.deploy(
        Effect.gen(function* () {
          const slo = yield* ServiceLevelObjective("Slo", {
            description: "alchemy application-signals test slo (updated)",
            sliConfig: sliConfig(3000),
            goal: goal(99.5),
            tags: { fixture: "application-signals-slo", updated: "true" },
          });
          return { slo };
        }),
      );

      expect(updated.sloArn).toBe(slo.sloArn);
      const observedUpdated = yield* appsignals
        .getServiceLevelObjective({ Id: updated.sloName })
        .pipe(Effect.map((r) => r.Slo));
      expect(observedUpdated.Description).toBe(
        "alchemy application-signals test slo (updated)",
      );
      expect(observedUpdated.Goal.AttainmentGoal).toBe(99.5);
      expect(observedUpdated.Sli?.MetricThreshold).toBe(3000);
      const updatedTags = yield* appsignals
        .listTagsForResource({ ResourceArn: updated.sloArn })
        .pipe(
          Effect.map((r) =>
            Object.fromEntries((r.Tags ?? []).map((t) => [t.Key, t.Value])),
          ),
        );
      expect(updatedTags.updated).toBe("true");

      // REPLACE — an explicit name change replaces the SLO (no rename API).
      const { slo: replaced } = yield* stack.deploy(
        Effect.gen(function* () {
          const slo = yield* ServiceLevelObjective("Slo", {
            sloName: "alchemy-appsignals-slo-replaced",
            description: "alchemy application-signals test slo (replaced)",
            sliConfig: sliConfig(3000),
            goal: goal(99.5),
            tags: { fixture: "application-signals-slo" },
          });
          return { slo };
        }),
      );

      expect(replaced.sloName).toBe("alchemy-appsignals-slo-replaced");
      expect(replaced.sloArn).not.toBe(slo.sloArn);
      // The old SLO is deleted by the replacement.
      yield* assertSloGone(slo.sloName);

      // DESTROY — and verify the SLO is gone out-of-band.
      yield* stack.destroy();
      yield* assertSloGone(replaced.sloName);
    }),
  { timeout: 120_000 },
);
