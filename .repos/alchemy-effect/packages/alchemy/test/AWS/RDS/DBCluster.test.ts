import * as AWS from "@/AWS";
import { Network } from "@/AWS/EC2/Network";
import { DBCluster } from "@/AWS/RDS/DBCluster.ts";
import type { DBClusterProps } from "@/AWS/RDS/DBCluster.ts";
import { DBSubnetGroup } from "@/AWS/RDS/DBSubnetGroup.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";

const { test } = Test.make({ providers: AWS.providers() });

// Fast, unconditional `diff` checks for the replacement-set logic. No deploy.
const callDiff = (olds: DBClusterProps, news: DBClusterProps) =>
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(DBCluster);
    return yield* provider.diff!({
      id: "TestCluster",
      fqn: "TestCluster",
      instanceId: "test-cluster",
      olds,
      news,
      oldBindings: undefined as never,
      newBindings: undefined as never,
      output: undefined,
    });
  });

const base: DBClusterProps = {
  dbClusterIdentifier: "alchemy-rds-cluster-diff",
  engine: "aurora-postgresql",
};

test.provider("diff: backup retention is an in-place update", () =>
  Effect.gen(function* () {
    const result = yield* callDiff(
      { ...base, backupRetentionPeriod: "1 day" },
      { ...base, backupRetentionPeriod: "7 days" },
    );
    expect(result).toBeUndefined();
  }),
);

test.provider("diff: changing databaseName forces replacement", () =>
  Effect.gen(function* () {
    const result = yield* callDiff(
      { ...base, databaseName: "app" },
      { ...base, databaseName: "other" },
    );
    expect(result).toEqual({ action: "replace" });
  }),
);

test.provider("diff: changing kmsKeyId forces replacement", () =>
  Effect.gen(function* () {
    const result = yield* callDiff(
      { ...base, kmsKeyId: "key-a" },
      { ...base, kmsKeyId: "key-b" },
    );
    expect(result).toEqual({ action: "replace" });
  }),
);

test.provider("diff: changing engineMode forces replacement", () =>
  Effect.gen(function* () {
    const result = yield* callDiff(
      { ...base, engineMode: "provisioned" },
      { ...base, engineMode: "serverless" },
    );
    expect(result).toEqual({ action: "replace" });
  }),
);

// Render a deploy failure (whatever engine wrapper it arrives in) to a string
// we can assert AWS's parameter-validation message against.
const renderFailure = (attempt: Result.Result<unknown, unknown>): string => {
  if (!Result.isFailure(attempt)) {
    return "";
  }
  const failure = attempt.failure;
  const json = (() => {
    try {
      return JSON.stringify(failure);
    } catch {
      return "";
    }
  })();
  return `${String(failure)} ${json}`;
};

// Live wire probes for this PR's Redacted/Duration prop conversions. Both
// drive the full engine + provider `reconcile` path into a real
// `createDBCluster` call that AWS rejects at parameter-validation time, so
// nothing is ever provisioned and the probe completes in seconds.
//
// Probe 1 proves `masterUserPassword: Redacted.Redacted<string>` is
// serialized to the actual secret characters on the wire — AWS's validator
// can only reject the password if it saw the real '@'/' ' characters, not a
// "<redacted>" placeholder.
//
// Probe 2 proves `backupRetentionPeriod: Duration.Input` ("60 days") reaches
// the wire as integer days — AWS can only reject 60 > 35 if the converted
// number arrived.
//
// (The in-range live round-trip — create with "1 day", read back 1, modify to
// "3 days", read back 3 — is covered by the RDS_TEST_LIFECYCLE-gated test
// below, which needs ~15+ minutes of Aurora provisioning.)
test.provider(
  "wire probe: Redacted password + Duration retention reach createDBCluster",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const badPassword = yield* Effect.result(
        stack.deploy(
          Effect.gen(function* () {
            return yield* DBCluster("AuditProbeCluster", {
              dbClusterIdentifier: "alchemy-audit-probe",
              engine: "aurora-postgresql",
              masterUsername: "alchemy",
              // '@' and ' ' are forbidden password characters — AWS rejects
              // the create before provisioning anything.
              masterUserPassword: Redacted.make("bad@pass word1"),
              backupRetentionPeriod: "3 days",
            });
          }),
        ),
      );
      expect(Result.isFailure(badPassword)).toBe(true);
      // Typed tag (patched into distilled rds createDBCluster) + AWS's own
      // validation text naming the password parameter.
      expect(renderFailure(badPassword)).toContain("InvalidParameterValue");
      expect(renderFailure(badPassword)).toContain("MasterUserPassword");

      const badRetention = yield* Effect.result(
        stack.deploy(
          Effect.gen(function* () {
            return yield* DBCluster("AuditProbeCluster", {
              dbClusterIdentifier: "alchemy-audit-probe",
              engine: "aurora-postgresql",
              masterUsername: "alchemy",
              masterUserPassword: Redacted.make("ValidPassw0rd"),
              // 60 days is above the 1-35 day API maximum — AWS echoes the
              // converted integer back in the validation error.
              backupRetentionPeriod: "60 days",
            });
          }),
        ),
      );
      expect(Result.isFailure(badRetention)).toBe(true);
      expect(renderFailure(badRetention)).toContain("InvalidParameterValue");
      expect(renderFailure(badRetention)).toMatch(/retention/i);

      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);

// Read-only `list()` test (no deploy). An Aurora DB cluster takes MANY minutes
// to create *and* delete — far beyond the 240s test budget — so we exercise the
// enumeration path without provisioning. We resolve the provider via the typed
// `Provider.findProvider(DBCluster)` so `list()`'s element type is the exact
// `DBCluster["Attributes"]` shape, call it, and assert it returns a well-typed
// array (likely empty in a clean test account). This proves the paginated
// `describeDBClusters` -> Attributes mapping compiles and runs.
test.provider("list returns a typed DBCluster Attributes array", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(DBCluster);
    const all = yield* provider.list();

    expect(Array.isArray(all)).toBe(true);
    for (const cluster of all) {
      expect(typeof cluster.dbClusterIdentifier).toBe("string");
      expect(typeof cluster.dbClusterArn).toBe("string");
      expect(typeof cluster.engine).toBe("string");
      expect(typeof cluster.tags).toBe("object");
      expect(Array.isArray(cluster.vpcSecurityGroupIds)).toBe(true);
    }
  }),
);

// Full deploy-based `list()` test, gated behind AWS_TEST_RDS_DBCLUSTER=1.
// Reason: an Aurora cluster create + delete spans many minutes, blowing past
// the 240s budget, so it is opt-in only. When enabled, it deploys a real
// cluster and asserts the deployed identifier appears in the exhaustively
// paginated `list()` result.
test.provider.skipIf(!process.env.AWS_TEST_RDS_DBCLUSTER)(
  "list enumerates the deployed DB cluster",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const cluster = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* DBCluster("ListCluster", {
            engine: "aurora-postgresql",
            engineMode: "provisioned",
            serverlessV2ScalingConfiguration: {
              MinCapacity: 0.5,
              MaxCapacity: 1,
            },
            manageMasterUserPassword: true,
            masterUsername: "alchemy",
          });
        }),
      );

      const provider = yield* Provider.findProvider(DBCluster);
      const all = yield* provider.list();

      expect(
        all.some((c) => c.dbClusterIdentifier === cluster.dbClusterIdentifier),
      ).toBe(true);

      yield* stack.destroy();
    }),
  { timeout: 1_800_000 },
);

// Full cluster lifecycle gated behind RDS_TEST_LIFECYCLE=1. Creates a
// serverless-v2 Aurora cluster with backup/log/deletion-protection knobs, then
// does an in-place modify (backup retention, toggle deletionProtection — a
// regression for the previously-missing `modifyDBCluster` deletion-protection
// sync — and scaling min/max), asserting no replacement (same ARN).
test.provider.skipIf(!process.env.RDS_TEST_LIFECYCLE)(
  "cluster: create with knobs, then in-place modify (deletionProtection toggle)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // No default VPC/subnets in the testing account — provision a
      // production-shaped network (VPC + subnets across 2 AZs) + a DB subnet
      // group for the cluster.
      const network = Effect.gen(function* () {
        const net = yield* Network("ClusterNet", { cidrBlock: "10.42.0.0/16" });
        // No fixed name — let the engine generate a unique physical name so a
        // leftover group from an interrupted run can't force a cross-VPC
        // ModifyDBSubnetGroup ("new Subnets are not in the same Vpc").
        const subnetGroup = yield* DBSubnetGroup("ClusterSubnetGroup", {
          description: "alchemy cluster lifecycle",
          subnetIds: net.privateSubnetIds,
        });
        return { dbSubnetGroupName: subnetGroup.dbSubnetGroupName };
      });

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const { dbSubnetGroupName } = yield* network;
          return yield* DBCluster("LifecycleCluster", {
            dbClusterIdentifier: "alchemy-rds-lifecycle",
            engine: "aurora-postgresql",
            engineMode: "provisioned",
            dbSubnetGroupName,
            serverlessV2ScalingConfiguration: {
              MinCapacity: 0.5,
              MaxCapacity: 1,
            },
            manageMasterUserPassword: true,
            masterUsername: "alchemy",
            backupRetentionPeriod: "1 day",
            enableCloudwatchLogsExports: ["postgresql"],
            deletionProtection: false,
          });
        }),
      );

      expect(created.backupRetentionPeriod).toBe(1);
      expect(created.enabledCloudwatchLogsExports).toContain("postgresql");
      expect(created.deletionProtection).toBe(false);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const { dbSubnetGroupName } = yield* network;
          return yield* DBCluster("LifecycleCluster", {
            dbClusterIdentifier: "alchemy-rds-lifecycle",
            engine: "aurora-postgresql",
            engineMode: "provisioned",
            dbSubnetGroupName,
            serverlessV2ScalingConfiguration: {
              MinCapacity: 1,
              MaxCapacity: 2,
            },
            manageMasterUserPassword: true,
            masterUsername: "alchemy",
            backupRetentionPeriod: "3 days",
            enableCloudwatchLogsExports: ["postgresql"],
            deletionProtection: true,
          });
        }),
      );

      expect(updated.dbClusterArn).toBe(created.dbClusterArn);
      expect(updated.backupRetentionPeriod).toBe(3);
      expect(updated.deletionProtection).toBe(true);

      // Re-disable protection so the trailing destroy can delete the cluster.
      yield* stack.deploy(
        Effect.gen(function* () {
          const { dbSubnetGroupName } = yield* network;
          return yield* DBCluster("LifecycleCluster", {
            dbClusterIdentifier: "alchemy-rds-lifecycle",
            engine: "aurora-postgresql",
            engineMode: "provisioned",
            dbSubnetGroupName,
            serverlessV2ScalingConfiguration: {
              MinCapacity: 1,
              MaxCapacity: 2,
            },
            manageMasterUserPassword: true,
            masterUsername: "alchemy",
            backupRetentionPeriod: "3 days",
            enableCloudwatchLogsExports: ["postgresql"],
            deletionProtection: false,
          });
        }),
      );

      yield* stack.destroy();
    }),
  { timeout: 2_400_000 },
);
