import * as AWS from "@/AWS";
import { Alarm, CompositeAlarm } from "@/AWS/CloudWatch";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Output from "@/Output";

const { test } = Test.make({ providers: AWS.providers() });

// list() enumerates every CompositeAlarm in the account/region via
// `describeAlarms` (AlarmTypes filtered to CompositeAlarm). We deploy a real
// composite alarm (referencing a real metric alarm so the rule validates),
// resolve the provider from context via the typed `findProvider`, call
// `list()`, and assert the deployed alarm appears in the exhaustively
// paginated result.
test.provider("list enumerates the deployed composite alarm", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const deployed = yield* stack.deploy(
      Effect.gen(function* () {
        const metric = yield* Alarm("ListMetricAlarm", {
          name: "alchemy-test-composite-list-metric",
          MetricName: "Errors",
          Namespace: "AWS/Lambda",
          Statistic: "Sum",
          Period: 60,
          EvaluationPeriods: 1,
          Threshold: 1,
          ComparisonOperator: "GreaterThanOrEqualToThreshold",
        });
        const composite = yield* CompositeAlarm("ListCompositeAlarm", {
          name: "alchemy-test-composite-list",
          AlarmRule: Output.interpolate`ALARM("${metric.alarmName}")`,
        });
        return composite;
      }),
    );

    const provider = yield* Provider.findProvider(CompositeAlarm);
    const all = yield* provider.list();

    expect(all.some((a) => a.alarmName === deployed.alarmName)).toBe(true);

    yield* stack.destroy();

    // Out-of-band assert-gone: both the composite alarm and its member
    // metric alarm are deleted after the final destroy.
    const gone = yield* cloudwatch.describeAlarms({
      AlarmNames: [
        "alchemy-test-composite-list",
        "alchemy-test-composite-list-metric",
      ],
      AlarmTypes: ["CompositeAlarm", "MetricAlarm"],
    });
    expect(gone.CompositeAlarms ?? []).toEqual([]);
    expect(gone.MetricAlarms ?? []).toEqual([]);
  }),
);
