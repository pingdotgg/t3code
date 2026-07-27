import * as AWS from "@/AWS";
import { LogGroup } from "@/AWS/Logs/LogGroup.ts";
import { MetricFilter } from "@/AWS/Logs/MetricFilter.ts";
import * as Test from "@/Test/Alchemy";
import * as logs from "@distilled.cloud/aws/cloudwatch-logs";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const describeMetricFilter = Effect.fn(function* (
  logGroupName: string,
  filterName: string,
) {
  const described = yield* logs
    .describeMetricFilters({ logGroupName, filterNamePrefix: filterName })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed({ metricFilters: [] }),
      ),
    );
  return (described.metricFilters ?? []).find(
    (filter) => filter.filterName === filterName,
  );
});

class MetricFilterStillExists extends Data.TaggedError(
  "MetricFilterStillExists",
)<{ readonly filterName: string }> {}

const assertMetricFilterDeleted = (logGroupName: string, filterName: string) =>
  describeMetricFilter(logGroupName, filterName).pipe(
    Effect.flatMap((filter) =>
      filter === undefined
        ? Effect.void
        : Effect.fail(new MetricFilterStillExists({ filterName })),
    ),
    Effect.retry({
      while: (e) => e._tag === "MetricFilterStillExists",
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
    }),
  );

test.provider(
  "create, update pattern and transformations, replace on rename, delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const logGroup = yield* LogGroup("MetricFilterLogGroup", {
            retention: "1 day",
          });
          return yield* MetricFilter("ErrorCount", {
            logGroupName: logGroup.logGroupName,
            filterPattern: "?ERROR",
            metricTransformations: [
              {
                metricName: "AlchemyTestErrorCount",
                metricNamespace: "AlchemyTest",
                metricValue: "1",
              },
            ],
          });
        }),
      );

      expect(created.filterName).toBeDefined();
      expect(created.filterPattern).toBe("?ERROR");

      // out-of-band verification via distilled
      const observedCreated = yield* describeMetricFilter(
        created.logGroupName,
        created.filterName,
      );
      expect(observedCreated?.filterPattern).toBe("?ERROR");
      expect(observedCreated?.metricTransformations?.[0]?.metricName).toBe(
        "AlchemyTestErrorCount",
      );

      // update pattern + transformation in place (same filter name)
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const logGroup = yield* LogGroup("MetricFilterLogGroup", {
            retention: "1 day",
          });
          return yield* MetricFilter("ErrorCount", {
            logGroupName: logGroup.logGroupName,
            filterPattern: "?ERROR ?Error",
            metricTransformations: [
              {
                metricName: "AlchemyTestErrorCount",
                metricNamespace: "AlchemyTest",
                metricValue: "1",
                defaultValue: 0,
              },
            ],
          });
        }),
      );
      expect(updated.filterName).toBe(created.filterName);

      const observedUpdated = yield* describeMetricFilter(
        updated.logGroupName,
        updated.filterName,
      );
      expect(observedUpdated?.filterPattern).toBe("?ERROR ?Error");
      expect(observedUpdated?.metricTransformations?.[0]?.defaultValue).toBe(0);

      // explicit filterName triggers a replacement
      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          const logGroup = yield* LogGroup("MetricFilterLogGroup", {
            retention: "1 day",
          });
          return yield* MetricFilter("ErrorCount", {
            logGroupName: logGroup.logGroupName,
            filterName: "alchemy-test-error-count-renamed",
            filterPattern: "?ERROR ?Error",
            metricTransformations: [
              {
                metricName: "AlchemyTestErrorCount",
                metricNamespace: "AlchemyTest",
                metricValue: "1",
                defaultValue: 0,
              },
            ],
          });
        }),
      );
      expect(replaced.filterName).toBe("alchemy-test-error-count-renamed");
      expect(
        yield* describeMetricFilter(replaced.logGroupName, replaced.filterName),
      ).toBeDefined();
      yield* assertMetricFilterDeleted(
        created.logGroupName,
        created.filterName,
      );

      yield* stack.destroy();
      yield* assertMetricFilterDeleted(
        replaced.logGroupName,
        replaced.filterName,
      );
    }).pipe(Effect.onError(() => stack.destroy().pipe(Effect.ignore))),
  { timeout: 120_000 },
);
