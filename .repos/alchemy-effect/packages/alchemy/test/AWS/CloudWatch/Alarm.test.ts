import * as AWS from "@/AWS";
import { Alarm } from "@/AWS/CloudWatch/Alarm.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Canonical `list()` test (AWS account/region-scoped collection): deploy a real
// CloudWatch metric alarm, resolve the provider from context via the typed
// `findProvider` helper, call `list()`, and assert the deployed alarm appears in
// the exhaustively-paginated `describeAlarms` result (filtered to MetricAlarm).
test.provider(
  "list enumerates the deployed alarm",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const alarm = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Alarm("ListAlarm", {
            MetricName: "Errors",
            Namespace: "AWS/Lambda",
            Statistic: "Sum",
            Period: 60,
            EvaluationPeriods: 1,
            Threshold: 1,
            ComparisonOperator: "GreaterThanOrEqualToThreshold",
          });
        }),
      );

      expect(alarm.alarmArn).toBeDefined();

      const provider = yield* Provider.findProvider(Alarm);
      const all = yield* provider.list();

      expect(all.some((a) => a.alarmArn === alarm.alarmArn)).toBe(true);

      yield* stack.destroy();

      // Out-of-band assert-gone: describeAlarms by name returns an empty
      // collection once the alarm is deleted.
      const gone = yield* cloudwatch.describeAlarms({
        AlarmNames: [alarm.alarmName],
        AlarmTypes: ["MetricAlarm"],
      });
      expect(gone.MetricAlarms ?? []).toEqual([]);
    }),
  { timeout: 120_000 },
);
