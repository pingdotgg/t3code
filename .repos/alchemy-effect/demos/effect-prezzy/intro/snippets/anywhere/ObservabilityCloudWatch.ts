import * as AWS from "@alchemy.run/aws";
import type { Output } from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import Api from "./ApiLambda.ts";

const widget = (name: Output<string>) => ({
  type: "metric" as const,
  x: 0,
  y: 0,
  width: 12,
  height: 6,
  properties: {
    title: "Errors",
    metrics: [["AWS/Lambda", "Errors", "FunctionName", name]],
    stat: "Sum",
    period: 60,
  },
});

// #region show
export const ObservabilityLive = Layer.unwrap(
  Effect.gen(function* () {
    const api = yield* Api;

    yield* AWS.CloudWatch.Dashboard("Chat", {
      DashboardBody: { widgets: [widget(api.functionName)] },
    });
    yield* AWS.CloudWatch.Alarm("Errors", {
      Namespace: "AWS/Lambda",
      MetricName: "Errors",
      Dimensions: [{ Name: "FunctionName", Value: api.functionName }],
      Statistic: "Sum",
      Period: 300,
      EvaluationPeriods: 1,
      Threshold: 10,
      ComparisonOperator: "GreaterThanThreshold",
    });

    // Lambda already ships its logs and metrics to CloudWatch.
    return Layer.empty;
  }),
);
// #endregion show
