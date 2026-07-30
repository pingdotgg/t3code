import * as AWS from "@/AWS";
import {
  AnomalyDetector,
  LoggingConfiguration,
  QueryLoggingConfiguration,
  ResourcePolicy,
  Workspace,
} from "@/AWS/AMP";
import * as Logs from "@/AWS/Logs";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as amp from "@distilled.cloud/aws/amp";
import * as sts from "@distilled.cloud/aws/sts";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

class WorkspaceStillExists extends Data.TaggedError("WorkspaceStillExists")<{
  readonly workspaceId: string;
}> {}

/** Poll the workspace configuration until the retention lands (bounded). */
const pollRetention = (workspaceId: string, expected: number) =>
  amp.describeWorkspaceConfiguration({ workspaceId }).pipe(
    Effect.map((r) => r.workspaceConfiguration.retentionPeriodInDays),
    Effect.repeat({
      schedule: Schedule.spaced("4 seconds"),
      until: (days): boolean => days === expected,
      times: 25,
    }),
  );

const assertWorkspaceDeleted = (workspaceId: string) =>
  amp.describeWorkspace({ workspaceId }).pipe(
    Effect.flatMap((r) =>
      r.workspace.status.statusCode === "DELETING"
        ? Effect.fail(new WorkspaceStillExists({ workspaceId }))
        : Effect.succeed(undefined),
    ),
    Effect.catchTag("ResourceNotFoundException", () =>
      Effect.succeed(undefined),
    ),
    Effect.retry({
      while: (e) => e._tag === "WorkspaceStillExists",
      schedule: Schedule.max([
        Schedule.spaced("3 seconds"),
        Schedule.recurs(20),
      ]),
    }),
  );

// Full lifecycle for the workspace-configuration surface: retention period
// (workspace configuration), rules/alerting logging, query logging, and the
// workspace resource-based policy.
test.provider(
  "workspace configuration, logging, query logging, and resource policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { Account } = yield* sts.getCallerIdentity({});
      const policyFor = (workspaceArn: string, action: string) =>
        JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { AWS: `arn:aws:iam::${Account}:root` },
              Action: [action],
              Resource: workspaceArn,
            },
          ],
        });

      const program = (retention: Duration.Input, qspThreshold: number) =>
        Effect.gen(function* () {
          const workspace = yield* Workspace("Metrics", {
            alias: "alchemy-test-amp-config",
            retentionPeriod: retention,
            tags: { Environment: "test" },
          });
          const ruleLogs = yield* Logs.LogGroup("RuleLogs", {
            logGroupName: "/aws/vendedlogs/prometheus/alchemy-test-amp-config",
            retention: "1 day",
          });
          const queryLogs = yield* Logs.LogGroup("QueryLogs", {
            logGroupName:
              "/aws/vendedlogs/prometheus/alchemy-test-amp-config-queries",
            retention: "1 day",
          });
          const logging = yield* LoggingConfiguration("Logging", {
            workspaceId: workspace.workspaceId,
            logGroupArn: ruleLogs.logGroupArn,
          });
          const queryLogging = yield* QueryLoggingConfiguration(
            "QueryLogging",
            {
              workspaceId: workspace.workspaceId,
              destinations: [
                { logGroupArn: queryLogs.logGroupArn, qspThreshold },
              ],
            },
          );
          const policy = yield* ResourcePolicy("Policy", {
            workspaceId: workspace.workspaceId,
            policyDocument: Output.map(workspace.workspaceArn, (arn) =>
              policyFor(arn, "aps:QueryMetrics"),
            ),
          });
          return { workspace, ruleLogs, logging, queryLogging, policy };
        });

      // Create.
      const created = yield* stack.deploy(program("30 days", 0));
      const workspaceId = created.workspace.workspaceId;
      expect(workspaceId).toMatch(/^ws-/);
      expect(created.logging.workspaceId).toBe(workspaceId);
      expect(created.logging.logGroupArn).toContain(":log-group:");
      expect(created.queryLogging.destinations).toHaveLength(1);
      expect(created.queryLogging.destinations[0].qspThreshold).toBe(0);
      expect(created.policy.policyStatus).toBeTruthy();
      const firstRevision = created.policy.revisionId;

      // Out-of-band verification via distilled. The retention update
      // applies asynchronously — poll until it lands.
      const retentionAfterCreate = yield* pollRetention(workspaceId, 30);
      expect(retentionAfterCreate).toBe(30);

      const logging = yield* amp.describeLoggingConfiguration({ workspaceId });
      expect(logging.loggingConfiguration.logGroupArn).toContain(
        "alchemy-test-amp-config",
      );

      const queryLogging = yield* amp.describeQueryLoggingConfiguration({
        workspaceId,
      });
      expect(queryLogging.queryLoggingConfiguration.destinations).toHaveLength(
        1,
      );
      expect(
        queryLogging.queryLoggingConfiguration.destinations[0].filters
          .qspThreshold,
      ).toBe(0);

      const policy = yield* amp.describeResourcePolicy({ workspaceId });
      expect(policy.policyDocument).toContain("aps:QueryMetrics");

      // Update: retention 45 days, qsp threshold 1000. The policy document
      // is unchanged — its revision must be stable (no-op skipped the put).
      const updated = yield* stack.deploy(program("45 days", 1000));
      expect(updated.workspace.workspaceId).toBe(workspaceId);
      expect(updated.policy.revisionId).toBe(firstRevision);
      expect(updated.queryLogging.destinations[0].qspThreshold).toBe(1000);

      const retentionAfterUpdate = yield* pollRetention(workspaceId, 45);
      expect(retentionAfterUpdate).toBe(45);
      const queryLoggingAfter = yield* amp.describeQueryLoggingConfiguration({
        workspaceId,
      });
      expect(
        queryLoggingAfter.queryLoggingConfiguration.destinations[0].filters
          .qspThreshold,
      ).toBe(1000);

      yield* stack.destroy();
      yield* assertWorkspaceDeleted(workspaceId);

      // The sub-configurations died with the workspace; a fresh describe on
      // the deleted workspace id is a typed not-found.
      const error = yield* Effect.flip(
        amp.describeLoggingConfiguration({ workspaceId }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
  { timeout: 300_000 },
);

// Anomaly detectors train asynchronously (backfill against workspace data),
// so the lifecycle asserts identity + configuration and lets the provider's
// bounded wait tolerate a still-training detector.
test.provider(
  "anomaly detector lifecycle",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = (interval: Duration.Input) =>
        Effect.gen(function* () {
          const workspace = yield* Workspace("DetectorWorkspace", {
            alias: "alchemy-test-amp-anomaly",
            tags: { Environment: "test" },
          });
          const detector = yield* AnomalyDetector("Detector", {
            workspaceId: workspace.workspaceId,
            alias: "alchemy-test-detector",
            query: "avg(rate(alchemy_amp_anomaly_test_total[5m]))",
            evaluationInterval: interval,
            missingDataAction: { skip: true },
            tags: { Environment: "test" },
          });
          return { workspace, detector };
        });

      const created = yield* stack.deploy(program("1 minute"));
      const workspaceId = created.workspace.workspaceId;
      const detectorId = created.detector.anomalyDetectorId;
      expect(detectorId).toBeTruthy();
      expect(created.detector.anomalyDetectorArn).toContain("arn:aws:aps:");
      expect(created.detector.alias).toBe("alchemy-test-detector");

      // Out-of-band verification via distilled.
      const described = yield* amp.describeAnomalyDetector({
        workspaceId,
        anomalyDetectorId: detectorId,
      });
      expect(described.anomalyDetector.evaluationIntervalInSeconds).toBe(60);
      expect(described.anomalyDetector.tags?.["alchemy::id"]).toBe("Detector");

      // Update the evaluation interval in place (same id survives).
      const updated = yield* stack.deploy(program("2 minutes"));
      expect(updated.detector.anomalyDetectorId).toBe(detectorId);
      const describedAfter = yield* amp.describeAnomalyDetector({
        workspaceId,
        anomalyDetectorId: detectorId,
      });
      expect(describedAfter.anomalyDetector.evaluationIntervalInSeconds).toBe(
        120,
      );

      yield* stack.destroy();
      yield* assertWorkspaceDeleted(workspaceId);
    }),
  { timeout: 300_000 },
);
