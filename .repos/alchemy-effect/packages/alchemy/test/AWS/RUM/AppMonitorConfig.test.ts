import * as AWS from "@/AWS";
import * as Output from "@/Output";
import {
  AppMonitor,
  type MetricDefinition,
  MetricsDestination,
  ResourcePolicy,
} from "@/AWS/RUM";
import * as Test from "@/Test/Alchemy";
import * as rum from "@distilled.cloud/aws/rum";
import * as sts from "@distilled.cloud/aws/sts";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: AWS.providers() });

const MONITOR_NAME = "alchemy-test-rum-config-monitor";

const listDefinitions = () =>
  rum.batchGetRumMetricDefinitions
    .items({ AppMonitorName: MONITOR_NAME, Destination: "CloudWatch" })
    .pipe(
      Stream.runCollect,
      Effect.map((c) => Array.from(c)),
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed([] as rum.MetricDefinition[]),
      ),
    );

const listDestinations = () =>
  rum.listRumMetricsDestinations.items({ AppMonitorName: MONITOR_NAME }).pipe(
    Stream.runCollect,
    Effect.map((c) => Array.from(c)),
    Effect.catchTag("ResourceNotFoundException", () =>
      Effect.succeed([] as rum.MetricDestinationSummary[]),
    ),
  );

test.provider(
  "metrics destination + resource policy lifecycle on one app monitor",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { Account } = yield* sts.getCallerIdentity({});
      // RUM resource policies only accept rum:PutRumEvents actions — rotate
      // the policy document by its Sid instead.
      const policyFor = (arn: string, sid: string) =>
        JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Sid: sid,
              Effect: "Allow",
              Principal: { AWS: `arn:aws:iam::${Account}:root` },
              Action: ["rum:PutRumEvents"],
              Resource: arn,
            },
          ],
        });

      const program = (definitions: MetricDefinition[], policySid: string) =>
        Effect.gen(function* () {
          const monitor = yield* AppMonitor("ConfigMonitor", {
            appMonitorName: MONITOR_NAME,
            domain: "example.com",
          });
          const metrics = yield* MetricsDestination("Metrics", {
            appMonitorName: monitor.appMonitorName,
            destination: "CloudWatch",
            metricDefinitions: definitions,
          });
          const policy = yield* ResourcePolicy("Policy", {
            appMonitorName: monitor.appMonitorName,
            policyDocument: Output.map(monitor.appMonitorArn, (arn: string) =>
              policyFor(arn, policySid),
            ),
          });
          return { monitor, metrics, policy };
        });

      // Extended metrics require the event pattern that matches the metric.
      const sessionCountPattern = JSON.stringify({
        event_type: ["com.amazon.rum.session_start_event"],
      });
      const jsErrorCountPattern = JSON.stringify({
        event_type: ["com.amazon.rum.js_error_event"],
      });

      // Create: one extended metric definition + a PutRumEvents policy.
      const created = yield* stack.deploy(
        program(
          [{ name: "SessionCount", eventPattern: sessionCountPattern }],
          "AlchemyRumTest",
        ),
      );
      expect(created.metrics.appMonitorName).toBe(MONITOR_NAME);
      expect(created.metrics.destination).toBe("CloudWatch");
      const firstRevision = created.policy.policyRevisionId;
      expect(firstRevision).toBeTruthy();

      // Out-of-band verification via distilled.
      const destinations = yield* listDestinations();
      expect(destinations.map((d) => d.Destination)).toContain("CloudWatch");
      const defs = yield* listDefinitions();
      expect(defs.map((d) => d.Name)).toEqual(["SessionCount"]);

      const policy = yield* rum.getResourcePolicy({ Name: MONITOR_NAME });
      expect(policy.PolicyDocument).toContain("rum:PutRumEvents");

      // Update: modify SessionCount in place (dimension keys — the pattern
      // must also filter on the dimension's event field), add JsErrorCount
      // (batch create). The policy document is unchanged — its revision must
      // be stable (no-op skipped the put).
      const sessionCountByBrowserPattern = JSON.stringify({
        event_type: ["com.amazon.rum.session_start_event"],
        metadata: { browserName: ["Chrome", "Firefox", "Safari"] },
      });
      const updated = yield* stack.deploy(
        program(
          [
            {
              name: "SessionCount",
              eventPattern: sessionCountByBrowserPattern,
              dimensionKeys: { "metadata.browserName": "BrowserName" },
            },
            { name: "JsErrorCount", eventPattern: jsErrorCountPattern },
          ],
          "AlchemyRumTest",
        ),
      );
      expect(updated.policy.policyRevisionId).toBe(firstRevision);

      const defsAfterUpdate = yield* listDefinitions();
      expect(defsAfterUpdate.map((d) => d.Name).sort()).toEqual([
        "JsErrorCount",
        "SessionCount",
      ]);
      expect(
        defsAfterUpdate.find((d) => d.Name === "SessionCount")?.DimensionKeys,
      ).toEqual({ "metadata.browserName": "BrowserName" });

      // Update: drop SessionCount (batch delete) and rotate the policy
      // document (revision changes).
      const rotated = yield* stack.deploy(
        program(
          [{ name: "JsErrorCount", eventPattern: jsErrorCountPattern }],
          "AlchemyRumTestRotated",
        ),
      );
      expect(rotated.policy.policyRevisionId).not.toBe(firstRevision);

      const defsAfterDelete = yield* listDefinitions();
      expect(defsAfterDelete.map((d) => d.Name)).toEqual(["JsErrorCount"]);
      const rotatedPolicy = yield* rum.getResourcePolicy({
        Name: MONITOR_NAME,
      });
      expect(rotatedPolicy.PolicyDocument).toContain("AlchemyRumTestRotated");

      yield* stack.destroy();

      // Everything died with the stack: the monitor (and with it the
      // destination + policy) is a typed not-found.
      const gone = yield* Effect.flip(
        rum.getAppMonitor({ Name: MONITOR_NAME }),
      );
      expect(gone._tag).toBe("ResourceNotFoundException");
    }),
  { timeout: 240_000 },
);
