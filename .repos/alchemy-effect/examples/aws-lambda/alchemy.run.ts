import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import JobFunction from "./src/JobFunction.ts";

// AWS.providers() already provides AWSEnvironment from the SSO profile
// named by $AWS_PROFILE (defaults to "default"). To pin a different
// profile per stage, wrap with `Layer.provide(AWS.makeEnvironment({...}))`.
const aws = AWS.providers();
const dashboardRegion = process.env.AWS_REGION ?? "us-west-2";

export default Alchemy.Stack(
  "JobLambda",
  {
    providers: aws,
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const func = yield* JobFunction;
    const dashboard = yield* AWS.CloudWatch.Dashboard("JobDashboard", {
      DashboardBody: func.functionName.pipe(
        Output.map((functionName) => ({
          widgets: [
            {
              type: "metric",
              x: 0,
              y: 0,
              width: 12,
              height: 6,
              properties: {
                title: "Lambda Invocations and Errors",
                region: dashboardRegion,
                stat: "Sum",
                period: 300,
                metrics: [
                  ["AWS/Lambda", "Invocations", "FunctionName", functionName],
                  ["AWS/Lambda", "Errors", "FunctionName", functionName],
                ],
              },
            },
            {
              type: "metric",
              x: 12,
              y: 0,
              width: 12,
              height: 6,
              properties: {
                title: "Lambda Duration",
                region: dashboardRegion,
                stat: "Average",
                period: 300,
                metrics: [
                  ["AWS/Lambda", "Duration", "FunctionName", functionName],
                ],
              },
            },
          ],
        })),
      ),
    });
    const alarm = yield* AWS.CloudWatch.Alarm("JobFunctionErrorsAlarm", {
      AlarmDescription:
        "Alerts when the example Lambda function reports errors.",
      MetricName: "Errors",
      Namespace: "AWS/Lambda",
      Statistic: "Sum",
      Period: 300,
      EvaluationPeriods: 1,
      Threshold: 1,
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
      TreatMissingData: "notBreaching",
      Dimensions: [
        {
          Name: "FunctionName",
          Value: func.functionName,
        },
      ],
    });
    return {
      url: Output.interpolate`${func.functionUrl}?jobId=foo`,
      dashboardName: dashboard.dashboardName,
      alarmName: alarm.alarmName,
    };
  }),
);
