import * as AWS from "@alchemy.run/aws";
import { Network } from "@alchemy.run/aws/EC2/Network";
import { SecurityGroup } from "@alchemy.run/aws/EC2/SecurityGroup";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import { normalizePolicyDocument, type PolicyDocument } from "@alchemy.run/aws/IAM/Policy";
import { Key } from "@alchemy.run/aws/KMS/Key";
import { DBCluster, DBInstance, MigrationRunner, type DBInstanceProps } from "@alchemy.run/aws/RDS";
import { Aurora, type AuroraProps } from "@alchemy.run/aws/RDS/Aurora";
import { DBParameterGroup } from "@alchemy.run/aws/RDS/DBParameterGroup";
import { DBSubnetGroup } from "@alchemy.run/aws/RDS/DBSubnetGroup";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Lambda from "@distilled.cloud/aws/lambda";
import * as rds from "@distilled.cloud/aws/rds";
import * as rdsdata from "@distilled.cloud/aws/rds-data";
import * as secretsmanager from "@distilled.cloud/aws/secrets-manager";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Drift from "alchemy/Drift";
import * as Output from "alchemy/Output";
import * as Provider from "alchemy/Provider";
import { State } from "alchemy/State";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { driftOf } from "../drift.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Gated lifecycle budget, measured on a live run (us-west-2): a postgres
// db.t3.micro creates in 283–343s, a reboot-applied modify takes 137–199s and
// a delete 90–210s; an Aurora serverless-v2 writer creates in ~380s and
// deletes in ~315s. A create + up to three applied modifies + delete fits in
// 30 minutes; cases that apply four or more modifies (or measured >25 min)
// get 45.
const INSTANCE_TIMEOUT = 1_800_000;
const LONG_INSTANCE_TIMEOUT = 2_700_000;

// Every gated case provisions its own Network + instance and spends 10–25
// minutes doing it, so running them one after another takes ~7 hours. They
// are registered into lanes instead: lanes run concurrently, the cases within
// a lane run sequentially. Nine lanes bound the VPCs and instances alive at
// once (well under the account's VPC quota of 20) while the whole file
// finishes in about an hour. Cases cannot share instances: RDS allows one
// storage modification per instance every six hours, and the others assert
// exact request sequences, adoption, or drift on an instance they own.
type LifecycleCase = Parameters<ReturnType<typeof test.provider.skipIf>>;
const LANES = 9;
const lanes: Array<Array<{ enabled: boolean; args: LifecycleCase }>> = Array.from(
  { length: LANES },
  () => [],
);
const lifecycle =
  (lane: number, gate: string | undefined) =>
  (...args: LifecycleCase) => {
    lanes[lane - 1]!.push({ enabled: !!gate, args });
  };

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

// Live wire probes for this PR's Redacted/Duration prop conversions on
// DBInstance (the instance reconcile has its own conversion code, separate
// from DBCluster's). Both drive the full engine + provider `reconcile` path
// into a real `createDBInstance` call that AWS rejects at
// parameter-validation time — nothing is provisioned and the probe completes
// in seconds. Probe 1 proves `masterUserPassword: Redacted.Redacted<string>`
// serializes to the actual secret characters on the wire; probe 2 proves
// `backupRetentionPeriod: Duration.Input` ("60 days") arrives as integer days
// (rejected as > the 35-day maximum). These rejected requests do not verify
// the RDS_TEST_LIFECYCLE-gated storage lifecycle below.
test.provider(
  "wire probe: Redacted password + Duration retention reach createDBInstance",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const network = Effect.gen(function* () {
        const net = yield* Network("ProbeNet", { cidrBlock: "10.47.0.0/16" });
        return yield* DBSubnetGroup("ProbeSubnetGroup", {
          description: "RDS serialization probe network",
          subnetIds: net.privateSubnetIds,
        });
      });
      const badPassword = yield* Effect.result(
        stack.deploy(
          Effect.gen(function* () {
            const subnetGroup = yield* network;
            return yield* DBInstance("AuditProbeInstance", {
              dbInstanceIdentifier: "alchemy-audit-probe-instance",
              dbSubnetGroupName: subnetGroup.dbSubnetGroupName,
              engine: "postgres",
              dbInstanceClass: "db.t3.micro",
              allocatedStorage: 20,
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
      expect(renderFailure(badPassword)).toContain("InvalidParameterValue");
      expect(renderFailure(badPassword)).toContain("MasterUserPassword");

      const badRetention = yield* Effect.result(
        stack.deploy(
          Effect.gen(function* () {
            const subnetGroup = yield* network;
            return yield* DBInstance("AuditProbeInstance", {
              dbInstanceIdentifier: "alchemy-audit-probe-instance",
              dbSubnetGroupName: subnetGroup.dbSubnetGroupName,
              engine: "postgres",
              dbInstanceClass: "db.t3.micro",
              allocatedStorage: 20,
              masterUsername: "alchemy",
              masterUserPassword: Redacted.make("ValidPassw0rd"),
              // 60 days is above the 1-35 day API maximum — AWS can only
              // reject it if the converted integer arrived on the wire.
              backupRetentionPeriod: "60 days",
            });
          }),
        ),
      );
      expect(Result.isFailure(badRetention)).toBe(true);
      expect(renderFailure(badRetention)).toContain("InvalidParameterValue");
      expect(renderFailure(badRetention)).toMatch(/retention/i);

      const invalidFlags = yield* rds
        .describeDBEngineVersions({
          Engine: "postgres",
          IncludeAll: true,
          DefaultOnly: true,
        })
        .pipe(Effect.result);
      expect(Result.isFailure(invalidFlags)).toBe(true);
      if (Result.isFailure(invalidFlags)) {
        expect(invalidFlags.failure._tag).toBe("InvalidParameterCombination");
      }
      const emptyGroups = yield* stack
        .deploy(
          Effect.gen(function* () {
            const subnetGroup = yield* network;
            return yield* DBInstance("AuditProbeInstance", {
              dbInstanceIdentifier: "alchemy-audit-probe-instance",
              engine: "postgres",
              dbInstanceClass: "db.t3.micro",
              dbSubnetGroupName: subnetGroup.dbSubnetGroupName,
              vpcSecurityGroupIds: [],
              masterUsername: "alchemy",
              masterUserPassword: Redacted.make("bad@pass word1"),
            });
          }),
        )
        .pipe(Effect.result);
      expect(Result.isFailure(emptyGroups)).toBe(true);
      expect(renderFailure(emptyGroups)).toContain("InvalidDBInstanceAssociations");

      yield* stack.destroy();
    }),
  {
    tags: ["provider:aws", "provider:aws:ec2", "provider:aws:rds", "live"],
    timeout: 120_000,
  },
);

// Default (read-only) path: an RDS instance takes many minutes to create and
// delete — far beyond the 240s test budget — so the canonical `list()` test
// here does NOT deploy. It resolves the provider via the typed
// `Provider.findProvider(DBInstance)` helper and calls `list()` directly,
// asserting it returns a well-typed `DBInstance["Attributes"][]`. On a fresh
// account this is typically empty; either way every element must conform to
// the exact `read` shape.
test.provider(
  "list returns well-typed DB instance attributes",
  () =>
    Effect.gen(function* () {
      const provider = yield* Provider.findProvider(DBInstance);
      const all = yield* provider.list();

      expect(Array.isArray(all)).toBe(true);

      // Every element must match the exact `Attributes` shape `read` produces.
      for (const instance of all) {
        expect(typeof instance.dbInstanceIdentifier).toBe("string");
        expect(typeof instance.dbInstanceArn).toBe("string");
        expect(Array.isArray(instance.dbParameterGroupNames)).toBe(true);
        expect(typeof instance.tags).toBe("object");
      }
    }),
  { tags: ["provider:aws", "provider:aws:rds", "live"] },
);

// Full lifecycle is gated: provisioning an Aurora cluster + instance and then
// tearing it down takes many minutes, exceeding the 240s budget. Set
// AWS_TEST_RDS_DBINSTANCE=1 on an account that can afford the wait to run it.
// It deploys a serverless-v2 Aurora cluster + instance and asserts the
// instance appears in the exhaustively-paginated `list()` result.
lifecycle(3, process.env.AWS_TEST_RDS_DBINSTANCE)(
  "list enumerates the deployed DB instance",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { client, requests } = yield* observeInstanceRequests;
      const program = (round: string) =>
        Effect.gen(function* () {
          const network = yield* Network("ListNet", {
            cidrBlock: "10.43.0.0/16",
          });
          const subnetGroup = yield* DBSubnetGroup("ListSubnetGroup", {
            description: "alchemy instance list lifecycle",
            subnetIds: network.privateSubnetIds,
          });
          const clusterGroup = yield* SecurityGroup("ListClusterGroup", {
            vpcId: network.vpcId,
            description: "Aurora cluster group",
          });
          const ignoredInstanceGroup = yield* SecurityGroup("ListIgnoredInstanceGroup", {
            vpcId: network.vpcId,
            description: "Ignored instance group",
          });
          const cluster = yield* DBCluster("ListCluster", {
            dbSubnetGroupName: subnetGroup.dbSubnetGroupName,
            vpcSecurityGroupIds: [clusterGroup.groupId],
            engine: "aurora-postgresql",
            engineMode: "provisioned",
            port: 5434,
            serverlessV2ScalingConfiguration: {
              MinCapacity: 0.5,
              MaxCapacity: 1,
            },
            manageMasterUserPassword: true,
            masterUsername: "alchemy",
          });

          return yield* DBInstance("ListInstance", {
            dbClusterIdentifier: cluster.dbClusterIdentifier,
            dbInstanceClass: "db.serverless",
            engine: "aurora-postgresql",
            port: 5435,
            vpcSecurityGroupIds: [ignoredInstanceGroup.groupId],
            tags: { round },
          });
        });
      const instance = yield* stack
        .deploy(program("created"))
        .pipe(Effect.provideService(HttpClient.HttpClient, client));
      expect(instance.endpointPort).toBe(5434);
      const updated = yield* stack
        .deploy(program("updated"))
        .pipe(Effect.provideService(HttpClient.HttpClient, client));
      expect(updated.endpointPort).toBe(5434);
      // #2688: drift observes autoMinorVersionUpgrade.
      const observedInstance = (yield* rds.describeDBInstances({
        DBInstanceIdentifier: updated.dbInstanceIdentifier,
      })).DBInstances![0]!;
      expect((yield* driftOf(stack, "ListInstance"))?.attr?.autoMinorVersionUpgrade).toBe(
        observedInstance.AutoMinorVersionUpgrade,
      );
      expect(requests.filter((request) => request.port !== null)).toEqual([]);
      expect(requests.filter((request) => request.securityGroups.length > 0)).toEqual([]);
      const cluster = (yield* rds.describeDBClusters({
        DBClusterIdentifier: instance.dbClusterIdentifier!,
      })).DBClusters![0]!;
      expect([...updated.vpcSecurityGroupIds].sort()).toEqual(
        cluster.VpcSecurityGroups!.map((group) => group.VpcSecurityGroupId!).sort(),
      );
      const family = (yield* rds.describeDBEngineVersions({
        Engine: "aurora-postgresql",
        EngineVersion: cluster.EngineVersion,
      })).DBEngineVersions![0]!.DBParameterGroupFamily!;
      expect(updated.dbParameterGroupNames).toEqual([`default.${family}`]);
      expect(
        requests.filter(
          (request) => request.action === "ModifyDBInstance" && request.parameterGroup !== null,
        ),
      ).toEqual([]);
      expect(requests.some((request) => request.action === "CreateDBInstance")).toBe(true);
      yield* assertPort(instance.dbInstanceIdentifier, 5434);
      expect((yield* stack.plan(program("updated"))).resources.ListInstance).toMatchObject({
        action: "noop",
      });

      const provider = yield* Provider.findProvider(DBInstance);
      const all = yield* provider.list();

      expect(all.some((i) => i.dbInstanceIdentifier === instance.dbInstanceIdentifier)).toBe(true);

      yield* stack.destroy();
    }),
  {
    tags: ["provider:aws", "provider:aws:ec2", "provider:aws:rds", "live"],
    timeout: INSTANCE_TIMEOUT,
  },
);

// RDS provisioning and storage optimization exceed the default test budget.
lifecycle(1, process.env.RDS_TEST_LIFECYCLE)(
  "standalone instance: autoscaling defaults, drift, and allocation floor",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // The testing account has no default VPC/subnets, so provision a
      // production-shaped network (VPC + subnets across 2 AZs) and a DB subnet
      // group for the instance to live in.
      const network = Effect.gen(function* () {
        const net = yield* Network("RdsNet", { cidrBlock: "10.41.0.0/16" });
        // No fixed name — let the engine generate a unique physical name so a
        // leftover group from an interrupted run can't force a cross-VPC
        // ModifyDBSubnetGroup ("new Subnets are not in the same Vpc").
        const subnetGroup = yield* DBSubnetGroup("RdsSubnetGroup", {
          description: "alchemy standalone instance lifecycle",
          subnetIds: net.privateSubnetIds,
        });
        return { dbSubnetGroupName: subnetGroup.dbSubnetGroupName };
      });

      const program = (
        allocatedStorage: number,
        maxAllocatedStorage?: number,
        backupRetentionPeriod: "1 day" | "3 days" = "1 day",
        enablePerformanceInsights = false,
      ) =>
        Effect.gen(function* () {
          const { dbSubnetGroupName } = yield* network;
          return yield* DBInstance("StandaloneInstance", {
            engine: "postgres",
            dbInstanceClass: "db.t3.micro",
            allocatedStorage,
            ...(maxAllocatedStorage === undefined ? {} : { maxAllocatedStorage }),
            storageType: "gp2",
            masterUsername: "alchemy",
            manageMasterUserPassword: true,
            backupRetentionPeriod,
            enablePerformanceInsights,
            deletionProtection: false,
            dbSubnetGroupName,
            publiclyAccessible: false,
          });
        });
      const created = yield* stack.deploy(program(20));
      expect(created.allocatedStorage).toBe(20);
      expect(created.storageType).toBe("gp2");
      expect(created.backupRetentionPeriod).toBe(1);
      expect([0, 20]).toContain(created.maxAllocatedStorage ?? 0);
      const describe = rds.describeDBInstances({
        DBInstanceIdentifier: created.dbInstanceIdentifier,
      });
      expect([0, 20]).toContain((yield* describe).DBInstances?.[0]?.MaxAllocatedStorage ?? 0);

      const enabled = yield* stack.deploy(program(20, 40));
      expect(enabled.maxAllocatedStorage).toBe(40);
      expect((yield* describe).DBInstances?.[0]?.MaxAllocatedStorage).toBe(40);
      // Grow beyond the old ceiling while disabling autoscaling in the same request.
      const updated = yield* stack.deploy(program(50, undefined, "3 days", true));
      expect(updated.dbInstanceArn).toBe(created.dbInstanceArn);
      expect(updated.backupRetentionPeriod).toBe(3);
      expect(updated.allocatedStorage).toBe(50);
      expect([0, 50]).toContain(updated.maxAllocatedStorage ?? 0);
      const grown = (yield* describe).DBInstances?.[0];
      expect(grown?.AllocatedStorage).toBe(50);
      expect([0, 50]).toContain(grown?.MaxAllocatedStorage ?? 0);
      expect(grown?.PendingModifiedValues?.AllocatedStorage).toBeUndefined();

      const explicit = program(20, 100, "3 days", true);
      const reenabled = yield* stack.deploy(explicit);
      expect(reenabled.allocatedStorage).toBe(50);
      expect(reenabled.maxAllocatedStorage).toBe(100);
      expect((yield* describe).DBInstances?.[0]?.MaxAllocatedStorage).toBe(100);

      const injectCeiling = Effect.fn(function* (ceiling: number) {
        yield* rds.modifyDBInstance({
          DBInstanceIdentifier: created.dbInstanceIdentifier,
          MaxAllocatedStorage: ceiling,
          ApplyImmediately: true,
        });
        const injected = yield* describe.pipe(
          Effect.repeat({
            schedule: Schedule.spaced("5 seconds"),
            times: 8,
            until: (response) => response.DBInstances?.[0]?.MaxAllocatedStorage === ceiling,
          }),
        );
        expect(injected.DBInstances?.[0]?.MaxAllocatedStorage).toBe(ceiling);
      });
      yield* injectCeiling(120);
      expect((yield* stack.plan(explicit)).resources.StandaloneInstance).toMatchObject({
        action: "update",
      });
      const repairedExplicit = yield* stack.deploy(explicit);
      expect(repairedExplicit.maxAllocatedStorage).toBe(100);
      expect((yield* describe).DBInstances?.[0]?.MaxAllocatedStorage).toBe(100);

      // Lowering the minimum cannot shrink capacity, but omission disables autoscaling.
      const lowerMinimum = program(20);
      expect((yield* stack.plan(lowerMinimum)).resources.StandaloneInstance).toMatchObject({
        action: "update",
      });
      const preserved = yield* stack.deploy(lowerMinimum);
      expect(preserved.dbInstanceArn).toBe(created.dbInstanceArn);
      expect(preserved.allocatedStorage).toBe(50);
      expect([0, 50]).toContain(preserved.maxAllocatedStorage ?? 0);
      const observed = (yield* describe).DBInstances?.[0];
      expect(observed?.AllocatedStorage).toBe(50);
      expect([0, 50]).toContain(observed?.MaxAllocatedStorage ?? 0);
      expect(observed?.PendingModifiedValues?.AllocatedStorage).toBeUndefined();

      yield* injectCeiling(80);
      const drift = yield* Drift.detect({
        name: stack.name,
        stage: stack.stage,
      });
      expect(drift.resources.StandaloneInstance?.action).toBe("drifted");
      expect((yield* stack.plan(lowerMinimum)).resources.StandaloneInstance).toMatchObject({
        action: "update",
      });
      const repaired = yield* stack.deploy(lowerMinimum);
      expect(repaired.dbInstanceArn).toBe(created.dbInstanceArn);
      expect(repaired.allocatedStorage).toBe(50);
      expect([0, 50]).toContain(repaired.maxAllocatedStorage ?? 0);
      const settled = (yield* describe).DBInstances?.[0];
      expect([0, 50]).toContain(settled?.MaxAllocatedStorage ?? 0);
      expect(settled?.AllocatedStorage).toBe(50);
      expect((yield* stack.plan(lowerMinimum)).resources.StandaloneInstance).toMatchObject({
        action: "noop",
      });

      const disabled = program(20, 0);
      const explicitZero = yield* stack.deploy(disabled);
      expect([0, 50]).toContain(explicitZero.maxAllocatedStorage ?? 0);
      expect(explicitZero.allocatedStorage).toBe(50);
      expect((yield* stack.plan(disabled)).resources.StandaloneInstance).toMatchObject({
        action: "noop",
      });

      yield* stack.destroy();
      const gone = yield* describe.pipe(
        Effect.as(false),
        Effect.catchTag("DBInstanceNotFoundFault", () => Effect.succeed(true)),
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          times: 8,
          until: (absent) => absent,
        }),
      );
      expect(gone).toBe(true);
    }),
  {
    tags: ["provider:aws", "provider:aws:ec2", "provider:aws:rds", "live"],
    timeout: LONG_INSTANCE_TIMEOUT,
  },
);

type StorageProps = Pick<
  DBInstanceProps,
  "allocatedStorage" | "storageType" | "iops" | "storageThroughput" | "maxAllocatedStorage"
>;

type StorageState = readonly [
  allocatedStorage: number,
  storageType: string,
  iops: number,
  storageThroughput: number,
];

const storageProgram = (props: StorageProps) =>
  Effect.gen(function* () {
    const network = yield* Network("StorageNet", { cidrBlock: "10.44.0.0/16" });
    const subnetGroup = yield* DBSubnetGroup("StorageSubnetGroup", {
      description: "alchemy coupled storage lifecycle",
      subnetIds: network.privateSubnetIds,
    });
    return yield* DBInstance("StorageInstance", {
      engine: "postgres",
      dbInstanceClass: "db.t3.micro",
      masterUsername: "alchemy",
      masterUserPassword: Redacted.make("StorageCouplingPass123"),
      dbSubnetGroupName: subnetGroup.dbSubnetGroupName,
      backupRetentionPeriod: "0 days",
      deletionProtection: false,
      skipFinalSnapshot: true,
      publiclyAccessible: false,
      ...props,
    });
  });

const assertStorageState = Effect.fn(function* (
  identifier: string,
  expected: StorageState,
  maximum = 0,
) {
  const observed = (yield* rds.describeDBInstances({
    DBInstanceIdentifier: identifier,
  })).DBInstances?.[0];
  expect([
    observed?.AllocatedStorage,
    observed?.StorageType,
    observed?.Iops ?? 0,
    observed?.StorageThroughput ?? 0,
  ]).toEqual(expected);
  if (maximum === 0) {
    expect([0, expected[0]]).toContain(observed?.MaxAllocatedStorage ?? 0);
  } else {
    expect(observed?.MaxAllocatedStorage).toBe(maximum);
  }
  expect(observed?.PendingModifiedValues?.AllocatedStorage).toBeUndefined();
  expect(observed?.PendingModifiedValues?.StorageType).toBeUndefined();
  expect(observed?.PendingModifiedValues?.Iops).toBeUndefined();
  expect(observed?.PendingModifiedValues?.StorageThroughput).toBeUndefined();
});

// A point-in-time restore swapped into place leaves the same identifier (and
// props) on a different physical instance. Do exactly that against the real
// API: restore the deployed instance to its latest restorable time under a
// temporary identifier, carrying every source setting over, then rename the
// original away and the restored copy into place. The redeploy must publish
// the restored server's `dbiResourceId`; on main it plans no change and keeps
// the old one.
lifecycle(1, process.env.RDS_TEST_LIFECYCLE)(
  "identity: a point-in-time restore swapped into place is picked up on redeploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const identifier = `alchemy-pitr-${stack.stage.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
      const restoredId = `${identifier}-restored`;
      const displacedId = `${identifier}-old`;

      const describeInstance = (id: string) =>
        rds.describeDBInstances({ DBInstanceIdentifier: id }).pipe(
          Effect.map((r) => r.DBInstances?.[0]),
          Effect.catchTag("DBInstanceNotFoundFault", () => Effect.succeed(undefined)),
        );
      const waitUntil = (id: string, done: (instance: rds.DBInstance | undefined) => boolean) =>
        describeInstance(id).pipe(
          Effect.repeat({ schedule: Schedule.spaced("20 seconds"), times: 120, until: done }),
        );
      const waitAvailable = (id: string) =>
        waitUntil(id, (i) => i?.DBInstanceStatus === "available");
      const deleteIfPresent = (id: string) =>
        rds
          .deleteDBInstance({
            DBInstanceIdentifier: id,
            SkipFinalSnapshot: true,
            DeleteAutomatedBackups: true,
          })
          .pipe(
            Effect.catchTag("DBInstanceNotFoundFault", () => Effect.void),
            Effect.andThen(waitUntil(id, (i) => i === undefined)),
            Effect.ignore,
          );

      const program = Effect.gen(function* () {
        const net = yield* Network("PitrNet", { cidrBlock: "10.48.0.0/16" });
        const subnetGroup = yield* DBSubnetGroup("PitrSubnetGroup", {
          description: "alchemy DBInstance point-in-time restore identity",
          subnetIds: net.privateSubnetIds,
        });
        return yield* DBInstance("PitrInstance", {
          dbInstanceIdentifier: identifier,
          engine: "postgres",
          dbInstanceClass: "db.t3.micro",
          allocatedStorage: 20,
          masterUsername: "alchemy",
          masterUserPassword: Redacted.make("alchemy-pitr-test-password"),
          backupRetentionPeriod: "1 day",
          deletionProtection: false,
          skipFinalSnapshot: true,
          dbSubnetGroupName: subnetGroup.dbSubnetGroupName,
          publiclyAccessible: false,
        });
      });

      yield* Effect.gen(function* () {
        const first = yield* stack.deploy(program);

        // Automated backups make the instance restorable a few minutes in.
        const source = (yield* waitUntil(
          identifier,
          (i) => i?.LatestRestorableTime !== undefined,
        ))!;

        yield* rds.restoreDBInstanceToPointInTime({
          SourceDBInstanceIdentifier: identifier,
          TargetDBInstanceIdentifier: restoredId,
          UseLatestRestorableTime: true,
          DBInstanceClass: source.DBInstanceClass,
          DBSubnetGroupName: source.DBSubnetGroup?.DBSubnetGroupName,
          VpcSecurityGroupIds: (source.VpcSecurityGroups ?? []).flatMap((g) =>
            g.VpcSecurityGroupId ? [g.VpcSecurityGroupId] : [],
          ),
          DBParameterGroupName: source.DBParameterGroups?.[0]?.DBParameterGroupName,
          OptionGroupName: source.OptionGroupMemberships?.[0]?.OptionGroupName,
          StorageType: source.StorageType,
          AllocatedStorage: source.AllocatedStorage,
          MaxAllocatedStorage: source.MaxAllocatedStorage,
          Iops: source.Iops,
          StorageThroughput: source.StorageThroughput,
          Port: source.Endpoint?.Port,
          PubliclyAccessible: source.PubliclyAccessible,
          MultiAZ: source.MultiAZ,
          EnableIAMDatabaseAuthentication: source.IAMDatabaseAuthenticationEnabled,
          CACertificateIdentifier: source.CACertificateIdentifier,
          BackupRetentionPeriod: source.BackupRetentionPeriod,
          CopyTagsToSnapshot: source.CopyTagsToSnapshot,
          DeletionProtection: false,
          Tags: source.TagList,
        });
        const restored = (yield* waitAvailable(restoredId))!;
        expect(restored.DbiResourceId).not.toBe(first.dbiResourceId);

        // Swap: original out of the way, restored copy into place.
        yield* rds.modifyDBInstance({
          DBInstanceIdentifier: identifier,
          NewDBInstanceIdentifier: displacedId,
          ApplyImmediately: true,
        });
        yield* waitAvailable(displacedId);
        yield* rds.modifyDBInstance({
          DBInstanceIdentifier: restoredId,
          NewDBInstanceIdentifier: identifier,
          ApplyImmediately: true,
        });
        const swapped = (yield* waitUntil(
          identifier,
          (i) => i?.DBInstanceStatus === "available" && i.DbiResourceId === restored.DbiResourceId,
        ))!;
        expect(swapped.DbiResourceId).toBe(restored.DbiResourceId);

        // Unchanged props, new physical server: the redeploy publishes it.
        const second = yield* stack.deploy(program);
        expect(second.dbInstanceIdentifier).toBe(identifier);
        expect(second.dbiResourceId).toBe(restored.DbiResourceId);

        // The displaced original still sits in the stack's subnet group.
        yield* deleteIfPresent(displacedId);
        yield* stack.destroy();
        yield* assertInstanceGone(identifier);
      }).pipe(
        // The displaced original (and a stranded restore) are not tracked by
        // the stack; remove them whether the test passes or fails.
        Effect.ensuring(
          Effect.all([deleteIfPresent(displacedId), deleteIfPresent(restoredId)], {
            concurrency: 2,
          }),
        ),
      );
    }),
  {
    tags: ["provider:aws", "provider:aws:ec2", "provider:aws:rds", "live"],
    timeout: 5_400_000,
  },
);

const assertInstanceGone = Effect.fn(function* (identifier: string) {
  const gone = yield* rds.describeDBInstances({ DBInstanceIdentifier: identifier }).pipe(
    Effect.as(false),
    Effect.catchTag("DBInstanceNotFoundFault", () => Effect.succeed(true)),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      times: 8,
      until: (gone) => gone,
    }),
  );
  expect(gone).toBe(true);
});

interface StorageCase {
  name: string;
  initial: StorageProps;
  desired: StorageProps;
  before: StorageState;
  after: StorageState;
  equivalent?: StorageProps;
}

// Each database receives at most one storage modification; optimization can take hours.
const storageCases: StorageCase[] = [
  {
    name: "small gp3 defaults and resize",
    initial: {},
    desired: {
      allocatedStorage: 25,
      storageType: "gp3",
      iops: 3000,
      storageThroughput: 125,
    },
    before: [20, "gp3", 3000, 125],
    after: [25, "gp3", 3000, 125],
    equivalent: {},
  },
  {
    name: "gp3 resize retains provisioned performance",
    initial: { allocatedStorage: 400 },
    desired: { allocatedStorage: 500 },
    before: [400, "gp3", 12000, 500],
    after: [500, "gp3", 12000, 500],
  },
  {
    name: "gp3 IOPS update includes allocation",
    initial: { allocatedStorage: 400 },
    desired: { allocatedStorage: 400, iops: 16000 },
    before: [400, "gp3", 12000, 500],
    after: [400, "gp3", 16000, 500],
  },
  {
    name: "gp3 throughput update includes IOPS",
    initial: { allocatedStorage: 400 },
    desired: { allocatedStorage: 400, storageThroughput: 750 },
    before: [400, "gp3", 12000, 500],
    after: [400, "gp3", 12000, 750],
  },
  {
    name: "gp3 performance removal restores defaults",
    initial: { allocatedStorage: 400, iops: 16000, storageThroughput: 750 },
    desired: { allocatedStorage: 400 },
    before: [400, "gp3", 16000, 750],
    after: [400, "gp3", 12000, 500],
  },
  {
    name: "storage type removal restores gp3",
    initial: { allocatedStorage: 25, storageType: "gp2" },
    desired: {},
    before: [25, "gp2", 0, 0],
    after: [25, "gp3", 3000, 125],
  },
  ...(["io1", "io2"] as const).flatMap((storageType): StorageCase[] => [
    {
      name: `${storageType} resize includes unchanged IOPS`,
      initial: { storageType },
      desired: { storageType, allocatedStorage: 120 },
      before: [100, storageType, 1000, 0],
      after: [120, storageType, 1000, 0],
    },
    {
      name: `${storageType} performance and autoscaling removal are atomic`,
      initial: { storageType, iops: 3000, maxAllocatedStorage: 6000 },
      desired: { storageType },
      before: [100, storageType, 3000, 0],
      after: [100, storageType, 1000, 0],
      equivalent: { storageType, maxAllocatedStorage: 0 },
    },
  ]),
];

// Lane per storage case (index-aligned with `storageCases`).
const storageLanes = [6, 7, 7, 7, 8, 6, 8, 8, 9, 9];

for (const [index, scenario] of storageCases.entries()) {
  lifecycle(storageLanes[index]!, process.env.RDS_TEST_LIFECYCLE)(
    `storage coupling: ${scenario.name}`,
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const created = yield* stack.deploy(storageProgram(scenario.initial));
        yield* assertStorageState(
          created.dbInstanceIdentifier,
          scenario.before,
          scenario.initial.maxAllocatedStorage,
        );
        const updated = yield* stack.deploy(storageProgram(scenario.desired));
        expect(updated.dbInstanceArn).toBe(created.dbInstanceArn);
        yield* assertStorageState(
          updated.dbInstanceIdentifier,
          scenario.after,
          scenario.desired.maxAllocatedStorage,
        );
        const finalProps = scenario.equivalent ?? scenario.desired;
        if (scenario.equivalent) {
          const equivalent = yield* stack.deploy(storageProgram(finalProps));
          expect(equivalent.dbInstanceArn).toBe(created.dbInstanceArn);
          yield* assertStorageState(
            equivalent.dbInstanceIdentifier,
            scenario.after,
            finalProps.maxAllocatedStorage,
          );
        }
        expect(
          (yield* stack.plan(storageProgram(finalProps))).resources.StorageInstance,
        ).toMatchObject({ action: "noop" });
        yield* stack.destroy();
        yield* assertInstanceGone(created.dbInstanceIdentifier);
      }),
    {
      tags: ["provider:aws", "provider:aws:ec2", "provider:aws:rds", "live"],
      timeout: INSTANCE_TIMEOUT,
    },
  );
}

lifecycle(9, process.env.RDS_TEST_LIFECYCLE)(
  "storage coupling: plans correction for external storage drift",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const desired = storageProgram({});
      const created = yield* stack.deploy(desired);
      yield* assertStorageState(created.dbInstanceIdentifier, [20, "gp3", 3000, 125]);
      yield* rds.modifyDBInstance({
        DBInstanceIdentifier: created.dbInstanceIdentifier,
        StorageType: "gp2",
        ApplyImmediately: true,
      });
      yield* rds
        .describeDBInstances({
          DBInstanceIdentifier: created.dbInstanceIdentifier,
        })
        .pipe(
          Effect.repeat({
            schedule: Schedule.min([
              Schedule.exponential("5 seconds"),
              Schedule.spaced("1 minute"),
            ]),
            times: 10,
            until: (response) => {
              const instance = response.DBInstances?.[0];
              return (
                instance?.StorageType === "gp2" &&
                (instance.Iops ?? 0) === 0 &&
                (instance.StorageThroughput ?? 0) === 0 &&
                instance.PendingModifiedValues?.StorageType === undefined
              );
            },
          }),
        );
      yield* assertStorageState(created.dbInstanceIdentifier, [20, "gp2", 0, 0]);
      const drift = yield* Drift.detect({
        name: stack.name,
        stage: stack.stage,
      });
      expect(drift.resources.StorageInstance?.action).toBe("drifted");
      expect((yield* stack.plan(desired)).resources.StorageInstance).toMatchObject({
        action: "update",
      });
      // A second storage modification must wait for AWS's optimization cooldown.
      yield* stack.destroy();
      yield* assertInstanceGone(created.dbInstanceIdentifier);
    }),
  {
    tags: ["provider:aws", "provider:aws:ec2", "provider:aws:rds", "live"],
    timeout: INSTANCE_TIMEOUT,
  },
);

const observeInstanceRequests = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const requests: Array<{
    action: string;
    port: string | null;
    parameterGroup: string | null;
    securityGroups: string[];
    iamAuthentication: string | null;
    publiclyAccessible: string | null;
    deletionProtection: string | null;
    networkType: string | null;
    applyImmediately: string | null;
    enabledLogs: string[];
    disabledLogs: string[];
  }> = [];
  const observedClient = client.pipe(
    HttpClient.tapRequest((request) =>
      Effect.sync(() => {
        if (request.body._tag !== "Uint8Array") return;
        const parameters = new URLSearchParams(new TextDecoder().decode(request.body.body));
        const action = parameters.get("Action");
        if (
          action === "CreateDBInstance" ||
          action === "ModifyDBInstance" ||
          action === "DescribeDBInstances"
        ) {
          requests.push({
            action,
            iamAuthentication: parameters.get("EnableIAMDatabaseAuthentication"),
            publiclyAccessible: parameters.get("PubliclyAccessible"),
            deletionProtection: parameters.get("DeletionProtection"),
            networkType: parameters.get("NetworkType"),
            applyImmediately: parameters.get("ApplyImmediately"),
            enabledLogs: [...parameters.entries()]
              .filter(
                ([key]) =>
                  key.startsWith("EnableCloudwatchLogsExports.") ||
                  key.startsWith("CloudwatchLogsExportConfiguration.EnableLogTypes."),
              )
              .map(([, value]) => value)
              .sort(),
            disabledLogs: [...parameters.entries()]
              .filter(([key]) =>
                key.startsWith("CloudwatchLogsExportConfiguration.DisableLogTypes."),
              )
              .map(([, value]) => value)
              .sort(),
            parameterGroup: parameters.get("DBParameterGroupName"),
            securityGroups: [...parameters.entries()]
              .filter(([key]) => key.startsWith("VpcSecurityGroupIds."))
              .map(([, value]) => value)
              .sort(),
            port: parameters.get(action === "CreateDBInstance" ? "Port" : "DBPortNumber"),
          });
        }
      }),
    ),
  );
  return { client: observedClient, requests };
});

const portProgram = (port?: number, round = "ports", identifier?: string) =>
  Effect.gen(function* () {
    const network = yield* Network("PortNet", { cidrBlock: "10.45.0.0/16" });
    const subnetGroup = yield* DBSubnetGroup("PortSubnetGroup", {
      description: "alchemy listener port lifecycle",
      subnetIds: network.privateSubnetIds,
    });
    return yield* DBInstance("PortInstance", {
      dbInstanceIdentifier: identifier,
      engine: "postgres",
      dbInstanceClass: "db.t3.micro",
      masterUsername: "alchemy",
      manageMasterUserPassword: true,
      dbSubnetGroupName: subnetGroup.dbSubnetGroupName,
      backupRetentionPeriod: "0 days",
      deletionProtection: false,
      skipFinalSnapshot: true,
      publiclyAccessible: false,
      ...(port === undefined ? {} : { port }),
      tags: { round },
    });
  });

const assertPort = Effect.fn(function* (identifier: string, port: number) {
  const instance = (yield* rds.describeDBInstances({
    DBInstanceIdentifier: identifier,
  })).DBInstances?.[0];
  expect(instance?.Endpoint?.Port).toBe(port);
  expect(instance?.PendingModifiedValues?.Port).toBeUndefined();
  expect(["available", "storage-optimization"]).toContain(instance?.DBInstanceStatus);
  return instance;
});

const injectPort = Effect.fn(function* (identifier: string, port: number) {
  yield* rds.modifyDBInstance({
    DBInstanceIdentifier: identifier,
    DBPortNumber: port,
    ApplyImmediately: true,
  });
  yield* rds.describeDBInstances({ DBInstanceIdentifier: identifier }).pipe(
    Effect.repeat({
      schedule: Schedule.min([Schedule.exponential("5 seconds"), Schedule.spaced("1 minute")]),
      times: 10,
      until: (response) => {
        const instance = response.DBInstances?.[0];
        return (
          instance?.DBInstanceStatus === "available" &&
          instance.Endpoint?.Port === port &&
          instance.PendingModifiedValues?.Port === undefined
        );
      },
    }),
  );
  yield* assertPort(identifier, port);
});

lifecycle(4, process.env.RDS_TEST_LIFECYCLE)(
  "listener port: defaults, updates, removal, and no redundant writes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { client, requests } = yield* observeInstanceRequests;
      const deploy = (port?: number, round?: string) =>
        stack
          .deploy(portProgram(port, round))
          .pipe(Effect.provideService(HttpClient.HttpClient, client));
      const writes = () =>
        requests
          .filter((request) => request.action === "ModifyDBInstance" && request.port !== null)
          .map((request) => request.port);
      const created = yield* deploy();
      expect(created.endpointPort).toBe(5432);
      expect(
        requests
          .filter((request) => request.action === "CreateDBInstance")
          .map((request) => request.port),
      ).toEqual(["5432"]);
      expect((yield* assertPort(created.dbInstanceIdentifier, 5432))?.DbInstancePort).toBe(0);

      requests.length = 0;
      yield* deploy(5432, "same-port");
      expect(requests.some((request) => request.action === "DescribeDBInstances")).toBe(true);
      expect(writes()).toEqual([]);

      requests.length = 0;
      const changed = yield* deploy(5433);
      expect(changed.dbInstanceArn).toBe(created.dbInstanceArn);
      expect(changed.endpointPort).toBe(5433);
      expect(writes()).toEqual(["5433"]);
      yield* assertPort(created.dbInstanceIdentifier, 5433);

      requests.length = 0;
      yield* deploy(5433, "same-custom-port");
      expect(writes()).toEqual([]);
      yield* assertPort(created.dbInstanceIdentifier, 5433);

      requests.length = 0;
      const restored = yield* deploy();
      expect(restored.dbInstanceArn).toBe(created.dbInstanceArn);
      expect(restored.endpointPort).toBe(5432);
      expect(writes()).toEqual(["5432"]);
      yield* assertPort(created.dbInstanceIdentifier, 5432);
      expect((yield* stack.plan(portProgram())).resources.PortInstance).toMatchObject({
        action: "noop",
      });
      yield* stack.destroy();
      yield* assertInstanceGone(created.dbInstanceIdentifier);
    }),
  {
    tags: ["provider:aws", "provider:aws:ec2", "provider:aws:rds", "live"],
    timeout: INSTANCE_TIMEOUT,
  },
);

lifecycle(4, process.env.RDS_TEST_LIFECYCLE)(
  "listener port: unchanged-input drift repair and adoption defaults",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const identifier = "alchemy-rds-port-adoption";
      const program = (port?: number) => portProgram(port, "adoption", identifier);
      const created = yield* stack.deploy(program(5433));
      yield* assertPort(identifier, 5433);
      yield* injectPort(identifier, 5434);
      expect((yield* stack.plan(program(5433))).resources.PortInstance).toMatchObject({
        action: "update",
      });
      const drift = yield* Drift.detect({
        name: stack.name,
        stage: stack.stage,
      });
      expect(drift.resources.PortInstance?.action).toBe("drifted");
      const repaired = yield* stack.deploy(program(5433));
      expect(repaired.dbInstanceArn).toBe(created.dbInstanceArn);
      expect(repaired.endpointPort).toBe(5433);
      yield* assertPort(identifier, 5433);
      expect((yield* stack.plan(program(5433))).resources.PortInstance).toMatchObject({
        action: "noop",
      });

      // Removing the saved row exercises discovery with no previous props or attributes.
      yield* Effect.gen(function* () {
        const state = yield* yield* State;
        yield* state.delete({
          stack: stack.name,
          stage: stack.stage,
          fqn: "PortInstance",
        });
      }).pipe(Effect.provide(stack.state));
      const adopted = yield* stack.deploy(program());
      expect(adopted.dbInstanceArn).toBe(created.dbInstanceArn);
      expect(adopted.endpointPort).toBe(5432);
      yield* assertPort(identifier, 5432);
      expect((yield* stack.plan(program())).resources.PortInstance).toMatchObject({
        action: "noop",
      });

      yield* injectPort(identifier, 5434);
      expect((yield* stack.plan(program())).resources.PortInstance).toMatchObject({
        action: "update",
      });
      const defaultRepaired = yield* stack.deploy(program());
      expect(defaultRepaired.endpointPort).toBe(5432);
      yield* assertPort(identifier, 5432);
      expect((yield* stack.plan(program())).resources.PortInstance).toMatchObject({
        action: "noop",
      });
      yield* stack.destroy();
      yield* assertInstanceGone(identifier);
    }),
  {
    tags: ["provider:aws", "provider:aws:ec2", "provider:aws:rds", "live"],
    timeout: LONG_INSTANCE_TIMEOUT,
  },
);

lifecycle(4, process.env.RDS_TEST_LIFECYCLE)(
  "listener port: waits for an accepted change without resubmitting",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const created = yield* stack.deploy(portProgram());
      yield* assertPort(created.dbInstanceIdentifier, 5432);
      yield* rds.modifyDBInstance({
        DBInstanceIdentifier: created.dbInstanceIdentifier,
        DBPortNumber: 5433,
        ApplyImmediately: false,
      });
      const { client, requests } = yield* observeInstanceRequests;
      const settled = yield* stack
        .deploy(portProgram(5433))
        .pipe(Effect.provideService(HttpClient.HttpClient, client));
      expect(settled.dbInstanceArn).toBe(created.dbInstanceArn);
      expect(settled.endpointPort).toBe(5433);
      expect(requests.some((request) => request.action === "DescribeDBInstances")).toBe(true);
      expect(
        requests.filter(
          (request) => request.action === "ModifyDBInstance" && request.port !== null,
        ),
      ).toEqual([]);
      yield* assertPort(created.dbInstanceIdentifier, 5433);
      expect((yield* stack.plan(portProgram(5433))).resources.PortInstance).toMatchObject({
        action: "noop",
      });
      yield* stack.destroy();
      yield* assertInstanceGone(created.dbInstanceIdentifier);
    }),
  {
    tags: ["provider:aws", "provider:aws:ec2", "provider:aws:rds", "live"],
    timeout: INSTANCE_TIMEOUT,
  },
);

type SecurityProps = Pick<
  DBInstanceProps,
  | "enableIAMDatabaseAuthentication"
  | "publiclyAccessible"
  | "deletionProtection"
  | "networkType"
  | "enableCloudwatchLogsExports"
>;

const securityProgram = (
  security: SecurityProps = {},
  round = "security",
  identifier?: string,
  preferredMaintenanceWindow?: string,
) =>
  Effect.gen(function* () {
    const network = yield* Network("SecurityNet", {
      cidrBlock: "10.51.0.0/16",
    });
    const subnetGroup = yield* DBSubnetGroup("SecuritySubnetGroup", {
      description: "RDS security desired-state lifecycle",
      subnetIds: network.publicSubnetIds,
    });
    return yield* DBInstance("SecurityInstance", {
      dbInstanceIdentifier: identifier,
      engine: "postgres",
      dbInstanceClass: "db.t3.micro",
      masterUsername: "alchemy",
      manageMasterUserPassword: true,
      dbSubnetGroupName: subnetGroup.dbSubnetGroupName,
      backupRetentionPeriod: "0 days",
      preferredMaintenanceWindow,
      skipFinalSnapshot: true,
      ...security,
      tags: { round },
    });
  });

const assertSecurity = Effect.fn(function* (identifier: string, security: SecurityProps = {}) {
  const instance = (yield* rds.describeDBInstances({
    DBInstanceIdentifier: identifier,
  })).DBInstances?.[0];
  expect(["available", "storage-optimization"]).toContain(instance?.DBInstanceStatus);
  expect(instance?.IAMDatabaseAuthenticationEnabled).toBe(
    security.enableIAMDatabaseAuthentication ?? false,
  );
  expect(instance?.PendingModifiedValues?.IAMDatabaseAuthenticationEnabled).toBeUndefined();
  expect(instance?.PubliclyAccessible).toBe(security.publiclyAccessible ?? false);
  expect(instance?.DeletionProtection).toBe(security.deletionProtection ?? false);
  expect(instance?.NetworkType).toBe(security.networkType ?? "IPV4");
  expect([...(instance?.EnabledCloudwatchLogsExports ?? [])].sort()).toEqual(
    [...new Set(security.enableCloudwatchLogsExports ?? [])].sort(),
  );
  expect(
    instance?.PendingModifiedValues?.PendingCloudwatchLogsExports?.LogTypesToEnable ?? [],
  ).toEqual([]);
  expect(
    instance?.PendingModifiedValues?.PendingCloudwatchLogsExports?.LogTypesToDisable ?? [],
  ).toEqual([]);
  return instance;
});

const waitForSecurityObservation = (
  identifier: string,
  until: (instance: rds.DBInstance) => boolean,
) =>
  rds.describeDBInstances({ DBInstanceIdentifier: identifier }).pipe(
    Effect.map((response) => response.DBInstances?.[0]),
    Effect.repeat({
      schedule: Schedule.min([Schedule.exponential("5 seconds"), Schedule.spaced("1 minute")]),
      times: 10,
      until: (instance) =>
        instance !== undefined &&
        ["available", "storage-optimization"].includes(instance.DBInstanceStatus ?? "") &&
        until(instance),
    }),
    Effect.tap((instance) =>
      Effect.sync(() => {
        expect(instance).toBeDefined();
        expect(["available", "storage-optimization"]).toContain(instance?.DBInstanceStatus);
        expect(instance !== undefined && until(instance)).toBe(true);
      }),
    ),
  );

const enabledSecurity: SecurityProps = {
  enableIAMDatabaseAuthentication: true,
  publiclyAccessible: true,
  deletionProtection: true,
  networkType: "IPV4",
  enableCloudwatchLogsExports: ["postgresql", "upgrade"],
};

lifecycle(2, process.env.RDS_TEST_LIFECYCLE)(
  "security: defaults, removal, drift, adoption, and no redundant writes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const identifier = "alchemy-rds-security-defaults";
      const { client, requests } = yield* observeInstanceRequests;
      const program = (security: SecurityProps = {}, round = "security") =>
        securityProgram(security, round, identifier);
      const deploy = (security: SecurityProps = {}, round = "security") =>
        stack
          .deploy(program(security, round))
          .pipe(Effect.provideService(HttpClient.HttpClient, client));
      const created = yield* deploy();
      yield* assertSecurity(identifier);
      expect(created.iamDatabaseAuthenticationEnabled).toBe(false);
      expect(created.pendingIamDatabaseAuthenticationEnabled).toBeUndefined();
      expect(created.publiclyAccessible).toBe(false);
      expect(created.deletionProtection).toBe(false);
      expect(created.networkType).toBe("IPV4");
      expect(created.enabledCloudwatchLogsExports).toEqual([]);
      expect(Object.keys(created.vpcSecurityGroupStatuses).sort()).toEqual(
        [...created.vpcSecurityGroupIds].sort(),
      );
      expect(Object.values(created.vpcSecurityGroupStatuses)).toEqual(["active"]);
      expect(requests.filter((request) => request.action === "CreateDBInstance")).toMatchObject([
        {
          iamAuthentication: "false",
          publiclyAccessible: "false",
          deletionProtection: "false",
          networkType: "IPV4",
          enabledLogs: [],
        },
      ]);

      const enabled = yield* deploy(enabledSecurity);
      expect(enabled.dbInstanceArn).toBe(created.dbInstanceArn);
      expect(enabled.iamDatabaseAuthenticationEnabled).toBe(true);
      expect(enabled.pendingIamDatabaseAuthenticationEnabled).toBeUndefined();
      yield* assertSecurity(identifier, enabledSecurity);
      requests.length = 0;
      yield* deploy(
        {
          ...enabledSecurity,
          enableCloudwatchLogsExports: ["upgrade", "postgresql", "postgresql"],
        },
        "set-equivalent",
      );
      expect(requests.filter((request) => request.action === "ModifyDBInstance")).toEqual([]);

      requests.length = 0;
      const removed = yield* deploy();
      expect(removed.dbInstanceArn).toBe(created.dbInstanceArn);
      yield* assertSecurity(identifier);
      expect(requests.filter((request) => request.disabledLogs.length > 0)).toMatchObject([
        {
          disabledLogs: ["postgresql", "upgrade"],
          applyImmediately: "false",
        },
      ]);
      expect((yield* stack.plan(program())).resources.SecurityInstance).toMatchObject({
        action: "noop",
      });

      const inject = Effect.gen(function* () {
        yield* rds.modifyDBInstance({
          DBInstanceIdentifier: identifier,
          EnableIAMDatabaseAuthentication: true,
          PubliclyAccessible: true,
          DeletionProtection: true,
          CloudwatchLogsExportConfiguration: {
            EnableLogTypes: ["postgresql", "upgrade"],
          },
          ApplyImmediately: true,
        });
        yield* waitForSecurityObservation(
          identifier,
          (instance) =>
            instance.IAMDatabaseAuthenticationEnabled === true &&
            instance.PendingModifiedValues?.IAMDatabaseAuthenticationEnabled === undefined &&
            instance.PubliclyAccessible === true &&
            instance.DeletionProtection === true &&
            (instance.EnabledCloudwatchLogsExports ?? []).length === 2 &&
            (instance.PendingModifiedValues?.PendingCloudwatchLogsExports?.LogTypesToEnable
              ?.length ?? 0) === 0 &&
            (instance.PendingModifiedValues?.PendingCloudwatchLogsExports?.LogTypesToDisable
              ?.length ?? 0) === 0,
        );
        yield* assertSecurity(identifier, enabledSecurity);
      });
      yield* inject;
      const drift = yield* Drift.detect({
        name: stack.name,
        stage: stack.stage,
      });
      expect(drift.resources.SecurityInstance?.action).toBe("drifted");
      expect((yield* stack.plan(program())).resources.SecurityInstance).toMatchObject({
        action: "update",
      });
      const repaired = yield* deploy();
      expect(repaired.dbInstanceArn).toBe(created.dbInstanceArn);
      yield* assertSecurity(identifier);

      yield* inject;
      yield* Effect.gen(function* () {
        const state = yield* yield* State;
        yield* state.delete({
          stack: stack.name,
          stage: stack.stage,
          fqn: "SecurityInstance",
        });
      }).pipe(Effect.provide(stack.state));
      const adopted = yield* deploy();
      expect(adopted.dbInstanceArn).toBe(created.dbInstanceArn);
      yield* assertSecurity(identifier);
      requests.length = 0;
      yield* deploy({}, "tag-only");
      expect(requests.filter((request) => request.action === "ModifyDBInstance")).toEqual([]);
      expect((yield* stack.plan(program({}, "tag-only"))).resources.SecurityInstance).toMatchObject(
        { action: "noop" },
      );
      yield* stack.destroy();
      yield* assertInstanceGone(identifier);
    }),
  {
    tags: ["provider:aws", "provider:aws:ec2", "provider:aws:rds", "live"],
    timeout: LONG_INSTANCE_TIMEOUT,
  },
);

lifecycle(2, process.env.RDS_TEST_LIFECYCLE)(
  "security: maintenance-queued IAM convergence and immediate-only queue isolation",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const maintenance = yield* Effect.sync(() => {
        const day = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][
          (new Date().getUTCDay() + 2) % 7
        ];
        return `${day}:03:00-${day}:04:00`;
      });
      const { client, requests } = yield* observeInstanceRequests;
      const program = (security: SecurityProps = {}, round = "security") =>
        securityProgram(security, round, undefined, maintenance);
      const deploy = (security: SecurityProps = {}, round = "security") =>
        stack
          .deploy(program(security, round))
          .pipe(Effect.provideService(HttpClient.HttpClient, client));
      const created = yield* deploy();
      const identifier = created.dbInstanceIdentifier;
      yield* rds.modifyDBInstance({
        DBInstanceIdentifier: identifier,
        BackupRetentionPeriod: 1,
        ApplyImmediately: false,
      });
      yield* waitForSecurityObservation(
        identifier,
        (instance) => instance.PendingModifiedValues?.BackupRetentionPeriod === 1,
      );
      requests.length = 0;
      const immediateOnly: SecurityProps = {
        publiclyAccessible: true,
        deletionProtection: true,
        enableCloudwatchLogsExports: ["postgresql"],
      };
      const changed = yield* deploy(immediateOnly);
      expect(changed.dbInstanceArn).toBe(created.dbInstanceArn);
      expect(
        (yield* assertSecurity(identifier, immediateOnly))?.PendingModifiedValues
          ?.BackupRetentionPeriod,
      ).toBe(1);
      expect(requests.filter((request) => request.action === "ModifyDBInstance")).toMatchObject([
        { applyImmediately: "false", iamAuthentication: null },
      ]);
      expect((yield* stack.plan(program(immediateOnly))).resources.SecurityInstance).toMatchObject({
        action: "noop",
      });
      yield* deploy();
      expect(
        (yield* assertSecurity(identifier))?.PendingModifiedValues?.BackupRetentionPeriod,
      ).toBe(1);
      // Cancel the test's unrelated queued change before exercising queue promotion.
      yield* rds.modifyDBInstance({
        DBInstanceIdentifier: identifier,
        BackupRetentionPeriod: 0,
        ApplyImmediately: true,
      });
      yield* waitForSecurityObservation(
        identifier,
        (instance) =>
          instance.BackupRetentionPeriod === 0 &&
          instance.PendingModifiedValues?.BackupRetentionPeriod === undefined,
      );

      yield* rds.modifyDBInstance({
        DBInstanceIdentifier: identifier,
        EnableIAMDatabaseAuthentication: true,
        ApplyImmediately: false,
      });
      yield* waitForSecurityObservation(
        identifier,
        (instance) =>
          instance.IAMDatabaseAuthenticationEnabled === false &&
          instance.PendingModifiedValues?.IAMDatabaseAuthenticationEnabled === true,
      );
      const pendingDrift = yield* Drift.detect({
        name: stack.name,
        stage: stack.stage,
      });
      expect(pendingDrift.resources.SecurityInstance).toMatchObject({
        action: "drifted",
        attr: {
          iamDatabaseAuthenticationEnabled: false,
          pendingIamDatabaseAuthenticationEnabled: true,
        },
      });
      requests.length = 0;
      const desired = { enableIAMDatabaseAuthentication: true };
      const promoted = yield* deploy(desired);
      expect(promoted.iamDatabaseAuthenticationEnabled).toBe(true);
      expect(promoted.pendingIamDatabaseAuthenticationEnabled).toBeUndefined();
      yield* assertSecurity(identifier, desired);
      // Matching pending IAM needs queue promotion, not another IAM assignment.
      expect(requests.filter((request) => request.action === "ModifyDBInstance")).toMatchObject([
        { applyImmediately: "true", iamAuthentication: null },
      ]);

      yield* rds.modifyDBInstance({
        DBInstanceIdentifier: identifier,
        EnableIAMDatabaseAuthentication: false,
        ApplyImmediately: false,
      });
      yield* waitForSecurityObservation(
        identifier,
        (instance) =>
          instance.IAMDatabaseAuthenticationEnabled === true &&
          instance.PendingModifiedValues?.IAMDatabaseAuthenticationEnabled === false,
      );
      expect((yield* stack.plan(program(desired))).resources.SecurityInstance).toMatchObject({
        action: "update",
      });
      requests.length = 0;
      const repaired = yield* deploy(desired);
      expect(repaired.dbInstanceArn).toBe(created.dbInstanceArn);
      yield* assertSecurity(identifier, desired);
      expect(requests.filter((request) => request.action === "ModifyDBInstance")).toMatchObject([
        { applyImmediately: "true", iamAuthentication: "true" },
      ]);
      requests.length = 0;
      yield* deploy(desired, "tag-only");
      expect(requests.filter((request) => request.action === "ModifyDBInstance")).toEqual([]);
      yield* rds.modifyDBInstance({
        DBInstanceIdentifier: identifier,
        EnableIAMDatabaseAuthentication: false,
        ApplyImmediately: false,
      });
      yield* waitForSecurityObservation(
        identifier,
        (instance) =>
          instance.IAMDatabaseAuthenticationEnabled === true &&
          instance.PendingModifiedValues?.IAMDatabaseAuthenticationEnabled === false,
      );
      requests.length = 0;
      yield* deploy();
      yield* assertSecurity(identifier);
      expect(requests.filter((request) => request.action === "ModifyDBInstance")).toMatchObject([
        { applyImmediately: "true", iamAuthentication: null },
      ]);
      expect((yield* stack.plan(program())).resources.SecurityInstance).toMatchObject({
        action: "noop",
      });
      yield* stack.destroy();
      yield* assertInstanceGone(identifier);
    }),
  {
    tags: ["provider:aws", "provider:aws:ec2", "provider:aws:rds", "live"],
    timeout: INSTANCE_TIMEOUT,
  },
);

lifecycle(3, process.env.AWS_TEST_RDS_DBINSTANCE)(
  "security: Aurora cluster ownership survives omitted membership and adoption",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const identifier = "alchemy-rds-security-aurora";
      const { client, requests } = yield* observeInstanceRequests;
      const program = (membership = true, explicit = true, round = "created") =>
        Effect.gen(function* () {
          const network = yield* Network("AuroraSecurityNet", {
            cidrBlock: "10.52.0.0/16",
          });
          const subnetGroup = yield* DBSubnetGroup("AuroraSecuritySubnetGroup", {
            description: "Aurora instance security ownership",
            subnetIds: network.privateSubnetIds,
          });
          const cluster = yield* DBCluster("AuroraSecurityCluster", {
            engine: "aurora-postgresql",
            engineMode: "provisioned",
            dbSubnetGroupName: subnetGroup.dbSubnetGroupName,
            masterUsername: "alchemy",
            manageMasterUserPassword: true,
            enableIAMDatabaseAuthentication: true,
            enableCloudwatchLogsExports: ["postgresql"],
            networkType: "IPV4",
            deletionProtection: false,
            serverlessV2ScalingConfiguration: {
              MinCapacity: 0.5,
              MaxCapacity: 1,
            },
          });
          return yield* DBInstance("AuroraSecurityInstance", {
            dbInstanceIdentifier: identifier,
            dbClusterIdentifier: membership ? cluster.dbClusterIdentifier : undefined,
            engine: "aurora-postgresql",
            dbInstanceClass: "db.serverless",
            ...(explicit
              ? {
                  enableIAMDatabaseAuthentication: false,
                  deletionProtection: true,
                  networkType: "DUAL",
                  enableCloudwatchLogsExports: ["not-an-instance-log"],
                }
              : {}),
            tags: { round, cluster: cluster.dbClusterIdentifier },
          });
        });
      const deploy = (membership = true, explicit = true, round = "created") =>
        stack
          .deploy(program(membership, explicit, round))
          .pipe(Effect.provideService(HttpClient.HttpClient, client));
      const created = yield* deploy();
      expect(created.publiclyAccessible).toBe(false);
      const check = Effect.gen(function* () {
        const instance = (yield* rds.describeDBInstances({
          DBInstanceIdentifier: identifier,
        })).DBInstances![0]!;
        const cluster = (yield* rds.describeDBClusters({
          DBClusterIdentifier: instance.DBClusterIdentifier!,
        })).DBClusters![0]!;
        expect(cluster.IAMDatabaseAuthenticationEnabled).toBe(true);
        expect(cluster.EnabledCloudwatchLogsExports).toEqual(["postgresql"]);
        expect(cluster.DeletionProtection).toBe(false);
        expect(cluster.NetworkType).toBe("IPV4");
        expect(instance.PubliclyAccessible).toBe(false);
        expect(
          requests
            .filter(
              (request) =>
                request.action === "CreateDBInstance" || request.action === "ModifyDBInstance",
            )
            .every(
              (request) =>
                request.iamAuthentication === null &&
                request.deletionProtection === null &&
                request.networkType === null &&
                request.enabledLogs.length === 0 &&
                request.disabledLogs.length === 0,
            ),
        ).toBe(true);
        return instance;
      });
      yield* check;
      const omitted = yield* deploy(true, false, "omitted");
      expect(omitted.dbInstanceArn).toBe(created.dbInstanceArn);
      yield* check;
      yield* Effect.gen(function* () {
        const state = yield* yield* State;
        yield* state.delete({
          stack: stack.name,
          stage: stack.stage,
          fqn: "AuroraSecurityInstance",
        });
      }).pipe(Effect.provide(stack.state));
      const adopted = yield* deploy(false, true, "adopted");
      expect(adopted.dbInstanceArn).toBe(created.dbInstanceArn);
      const observed = yield* check;
      expect(adopted.iamDatabaseAuthenticationEnabled).toBe(
        observed.IAMDatabaseAuthenticationEnabled,
      );
      expect(adopted.enabledCloudwatchLogsExports).toEqual(
        observed.EnabledCloudwatchLogsExports ?? [],
      );
      expect(
        (yield* stack.plan(program(false, true, "adopted"))).resources.AuroraSecurityInstance,
      ).toMatchObject({ action: "noop" });
      yield* stack.destroy();
      yield* assertInstanceGone(identifier);
    }),
  {
    tags: ["provider:aws", "provider:aws:ec2", "provider:aws:rds", "live"],
    timeout: INSTANCE_TIMEOUT,
  },
);

const associationProgram = (
  options: {
    explicit?: boolean;
    reverse?: boolean;
    version?: string;
    identifier?: string;
    round?: string;
    omitSubnet?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const network = yield* Network("AssociationNet", {
      cidrBlock: "10.46.0.0/16",
    });
    const subnetGroup = yield* DBSubnetGroup("AssociationSubnetGroup", {
      description: "RDS association lifecycle",
      subnetIds: network.privateSubnetIds,
    });
    const groupA = yield* SecurityGroup("AssociationGroupA", {
      vpcId: network.vpcId,
      description: "RDS association A",
    });
    const groupB = yield* SecurityGroup("AssociationGroupB", {
      vpcId: network.vpcId,
      description: "RDS association B",
    });
    const parameterGroup = yield* DBParameterGroup("AssociationParameters", {
      family: "postgres16",
      parameters: { max_connections: "120" },
    });
    const groups = options.reverse
      ? [groupB.groupId, groupA.groupId, groupA.groupId]
      : [groupA.groupId, groupB.groupId];
    const instance = yield* DBInstance("AssociationInstance", {
      dbInstanceIdentifier: options.identifier,
      engine: "postgres",
      engineVersion: options.version,
      dbInstanceClass: "db.t3.micro",
      masterUsername: "alchemy",
      manageMasterUserPassword: true,
      ...(options.omitSubnet ? {} : { dbSubnetGroupName: subnetGroup.dbSubnetGroupName }),
      ...(options.explicit
        ? {
            dbParameterGroupName: parameterGroup.dbParameterGroupName,
            vpcSecurityGroupIds: groups,
          }
        : {}),
      backupRetentionPeriod: "0 days",
      deletionProtection: false,
      skipFinalSnapshot: true,
      publiclyAccessible: false,
      // Keep teardown ordered when adoption omits the subnet input.
      tags: {
        round: options.round ?? "associations",
        subnetGroup: subnetGroup.dbSubnetGroupName,
      },
    });
    return {
      instance,
      parameterGroupName: parameterGroup.dbParameterGroupName,
      groupIds: [groupA.groupId, groupB.groupId],
      vpcId: network.vpcId,
    };
  });

const defaultGroupForVpc = Effect.fn(function* (vpcId: string) {
  const groups = yield* ec2.describeSecurityGroups({
    Filters: [
      { Name: "vpc-id", Values: [vpcId] },
      { Name: "group-name", Values: ["default"] },
    ],
  });
  expect(groups.SecurityGroups).toHaveLength(1);
  return groups.SecurityGroups![0]!.GroupId!;
});

const assertAssociations = Effect.fn(function* (
  identifier: string,
  parameterGroup: string,
  securityGroups: string[],
) {
  const instance = (yield* rds.describeDBInstances({
    DBInstanceIdentifier: identifier,
  })).DBInstances?.[0];
  expect(["available", "storage-optimization"]).toContain(instance?.DBInstanceStatus);
  expect(instance?.DBParameterGroups?.map((group) => group.DBParameterGroupName)).toEqual([
    parameterGroup,
  ]);
  expect(["in-sync", "pending-reboot"]).toContain(
    instance?.DBParameterGroups?.[0]?.ParameterApplyStatus,
  );
  expect(instance?.VpcSecurityGroups?.map((group) => group.VpcSecurityGroupId).sort()).toEqual(
    [...securityGroups].sort(),
  );
  expect(instance?.VpcSecurityGroups?.every((group) => group.Status === "active")).toBe(true);
  return instance;
});

const injectAssociations = Effect.fn(function* (
  identifier: string,
  parameterGroup: string,
  securityGroups: string[],
) {
  yield* rds.modifyDBInstance({
    DBInstanceIdentifier: identifier,
    DBParameterGroupName: parameterGroup,
    VpcSecurityGroupIds: securityGroups,
    ApplyImmediately: true,
  });
  yield* rds.describeDBInstances({ DBInstanceIdentifier: identifier }).pipe(
    Effect.repeat({
      schedule: Schedule.min([Schedule.exponential("5 seconds"), Schedule.spaced("1 minute")]),
      times: 10,
      until: (response) => {
        const db = response.DBInstances?.[0];
        return (
          db?.DBInstanceStatus === "available" &&
          db.DBParameterGroups?.[0]?.DBParameterGroupName === parameterGroup &&
          ["in-sync", "pending-reboot"].includes(
            db.DBParameterGroups?.[0]?.ParameterApplyStatus ?? "",
          ) &&
          db.VpcSecurityGroups?.every((group) => group.Status === "active") === true &&
          JSON.stringify(db.VpcSecurityGroups.map((group) => group.VpcSecurityGroupId).sort()) ===
            JSON.stringify([...securityGroups].sort())
        );
      },
    }),
  );
  yield* assertAssociations(identifier, parameterGroup, securityGroups);
});

lifecycle(5, process.env.RDS_TEST_LIFECYCLE)(
  "associations: defaults, explicit attachments, and order-independent no-op writes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { client, requests } = yield* observeInstanceRequests;
      const options = { version: "16.13" };
      const deploy = (extra: Parameters<typeof associationProgram>[0] = {}) =>
        stack
          .deploy(associationProgram({ ...options, ...extra }))
          .pipe(Effect.provideService(HttpClient.HttpClient, client));
      const created = yield* deploy();
      const defaultGroup = yield* defaultGroupForVpc(created.vpcId);
      yield* assertAssociations(created.instance.dbInstanceIdentifier, "default.postgres16", [
        defaultGroup,
      ]);
      expect(created.instance.vpcSecurityGroupIds).toEqual([defaultGroup]);
      expect(requests.filter((request) => request.action === "CreateDBInstance")).toMatchObject([
        {
          parameterGroup: "default.postgres16",
          securityGroups: [defaultGroup],
        },
      ]);

      requests.length = 0;
      const attached = yield* deploy({ explicit: true });
      expect(attached.instance.dbInstanceArn).toBe(created.instance.dbInstanceArn);
      yield* assertAssociations(
        created.instance.dbInstanceIdentifier,
        created.parameterGroupName,
        created.groupIds,
      );
      expect(
        requests.filter(
          (request) =>
            request.action === "ModifyDBInstance" &&
            (request.parameterGroup !== null || request.securityGroups.length > 0),
        ),
      ).toHaveLength(1);
      expect(["in-sync", "pending-reboot"]).toContain(
        attached.instance.dbParameterGroupApplyStatuses[created.parameterGroupName],
      );

      requests.length = 0;
      yield* deploy({ explicit: true, reverse: true, round: "reordered" });
      expect(requests.some((request) => request.action === "DescribeDBInstances")).toBe(true);
      expect(
        requests.filter(
          (request) =>
            request.action === "ModifyDBInstance" &&
            (request.parameterGroup !== null || request.securityGroups.length > 0),
        ),
      ).toEqual([]);
      yield* assertAssociations(
        created.instance.dbInstanceIdentifier,
        created.parameterGroupName,
        created.groupIds,
      );
      expect(
        (yield* stack.plan(
          associationProgram({
            ...options,
            explicit: true,
            reverse: true,
            round: "reordered",
          }),
        )).resources.AssociationInstance,
      ).toMatchObject({ action: "noop" });
      yield* stack.destroy();
      yield* assertInstanceGone(created.instance.dbInstanceIdentifier);
    }),
  {
    tags: ["provider:aws", "provider:aws:ec2", "provider:aws:rds", "live"],
    timeout: INSTANCE_TIMEOUT,
  },
);

lifecycle(5, process.env.RDS_TEST_LIFECYCLE)(
  "associations: removal, older-engine defaults, drift, and nondefault-VPC adoption",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const identifier = "alchemy-rds-association-defaults";
      const program = (extra: Parameters<typeof associationProgram>[0] = {}) =>
        associationProgram({ identifier, ...extra });
      const created = yield* stack.deploy(program({ version: "16.13", explicit: true }));
      const defaultGroup = yield* defaultGroupForVpc(created.vpcId);
      yield* assertAssociations(identifier, created.parameterGroupName, created.groupIds);

      const removed = yield* stack.deploy(program());
      expect(removed.instance.dbInstanceArn).toBe(created.instance.dbInstanceArn);
      expect(removed.instance.engineVersion).toBe("16.13");
      yield* assertAssociations(identifier, "default.postgres16", [defaultGroup]);
      expect(
        (yield* ec2.describeSecurityGroups({ GroupIds: created.groupIds })).SecurityGroups,
      ).toHaveLength(2);
      expect(
        (yield* rds.describeDBParameterGroups({
          DBParameterGroupName: created.parameterGroupName,
        })).DBParameterGroups,
      ).toHaveLength(1);

      yield* injectAssociations(identifier, created.parameterGroupName, created.groupIds);
      const drift = yield* Drift.detect({
        name: stack.name,
        stage: stack.stage,
      });
      expect(drift.resources.AssociationInstance?.action).toBe("drifted");
      expect((yield* stack.plan(program())).resources.AssociationInstance).toMatchObject({
        action: "update",
      });
      yield* stack.deploy(program());
      yield* assertAssociations(identifier, "default.postgres16", [defaultGroup]);
      expect((yield* stack.plan(program())).resources.AssociationInstance).toMatchObject({
        action: "noop",
      });

      yield* injectAssociations(identifier, created.parameterGroupName, created.groupIds);
      yield* Effect.gen(function* () {
        const state = yield* yield* State;
        yield* state.delete({
          stack: stack.name,
          stage: stack.stage,
          fqn: "AssociationInstance",
        });
      }).pipe(Effect.provide(stack.state));
      const adopted = yield* stack.deploy(program({ omitSubnet: true }));
      expect(adopted.instance.dbInstanceArn).toBe(created.instance.dbInstanceArn);
      expect(adopted.instance.engineVersion).toBe("16.13");
      yield* assertAssociations(identifier, "default.postgres16", [defaultGroup]);
      expect(
        (yield* stack.plan(program({ omitSubnet: true }))).resources.AssociationInstance,
      ).toMatchObject({ action: "noop" });
      yield* stack.destroy();
      yield* assertInstanceGone(identifier);
    }),
  {
    tags: ["provider:aws", "provider:aws:ec2", "provider:aws:rds", "live"],
    timeout: LONG_INSTANCE_TIMEOUT,
  },
);

lifecycle(6, process.env.RDS_TEST_LIFECYCLE)(
  "managed secret policy: create, update, removal, drift, adoption, and public rejection",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* AWSEnvironment.current;
      const policy = (actions: string[]): PolicyDocument => ({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { AWS: `arn:aws:iam::${accountId}:root` },
            Action: actions,
            Resource: "*",
          },
        ],
      });
      const initialPolicy = policy(["secretsmanager:DescribeSecret"]);
      const updatedPolicy = policy([
        "secretsmanager:DescribeSecret",
        "secretsmanager:GetResourcePolicy",
      ]);
      const client = yield* HttpClient.HttpClient;
      const requests: Array<{
        action: string;
        blockPublicPolicy: boolean | undefined;
        secretId: string | undefined;
      }> = [];
      const observedClient = client.pipe(
        HttpClient.tapRequest((request) =>
          Effect.sync(() => {
            const target = request.headers["x-amz-target"];
            if (!target?.startsWith("secretsmanager.")) return;
            const body =
              request.body._tag === "Uint8Array"
                ? JSON.parse(new TextDecoder().decode(request.body.body))
                : {};
            requests.push({
              action: target.split(".").at(-1)!,
              blockPublicPolicy: body.BlockPublicPolicy,
              secretId: body.SecretId,
            });
          }),
        ),
      );
      const identifier = "alchemy-rds-secret-policy";
      const program = (
        masterUserSecretResourcePolicy: PolicyDocument | undefined,
        round = "default",
      ) =>
        Effect.gen(function* () {
          const net = yield* Network("SecretPolicyNet", {
            cidrBlock: "10.49.0.0/16",
          });
          const subnetGroup = yield* DBSubnetGroup("SecretPolicySubnetGroup", {
            description: "RDS managed secret policy lifecycle",
            subnetIds: net.privateSubnetIds,
          });
          return yield* DBInstance("SecretPolicyInstance", {
            dbInstanceIdentifier: identifier,
            engine: "postgres",
            dbInstanceClass: "db.t3.micro",
            masterUsername: "alchemy",
            manageMasterUserPassword: true,
            masterUserSecretResourcePolicy,
            dbSubnetGroupName: subnetGroup.dbSubnetGroupName,
            backupRetentionPeriod: "0 days",
            deletionProtection: false,
            skipFinalSnapshot: true,
            publiclyAccessible: false,
            tags: { round },
          });
        });
      const deploy = (desired: PolicyDocument | undefined, round = "default") =>
        stack
          .deploy(program(desired, round))
          .pipe(Effect.provideService(HttpClient.HttpClient, observedClient));
      const created = yield* deploy(initialPolicy);
      const secretArn = created.masterUserSecretArn;
      if (!secretArn)
        return yield* Effect.fail(new Error("RDS did not return its managed secret ARN"));
      const readPolicy = secretsmanager
        .getResourcePolicy({ SecretId: secretArn })
        .pipe(
          Effect.map((response) =>
            response.ResourcePolicy === undefined
              ? undefined
              : normalizePolicyDocument(response.ResourcePolicy),
          ),
        );
      const waitPolicy = (desired: PolicyDocument | undefined) =>
        readPolicy.pipe(
          Effect.repeat({
            schedule: Schedule.spaced("5 seconds"),
            times: 8,
            until: (actual) =>
              actual === (desired === undefined ? undefined : normalizePolicyDocument(desired)),
          }),
        );
      const injectPolicy = (desired: PolicyDocument) =>
        Effect.gen(function* () {
          yield* secretsmanager.putResourcePolicy({
            SecretId: secretArn,
            ResourcePolicy: JSON.stringify(desired),
            BlockPublicPolicy: true,
          });
          expect(yield* waitPolicy(desired)).toBe(normalizePolicyDocument(desired));
        });
      const metadata = yield* secretsmanager.describeSecret({
        SecretId: secretArn,
      });
      expect(metadata.OwningService).toBe("rds");
      expect(created.masterUserSecretResourcePolicy).toBe(normalizePolicyDocument(initialPolicy));
      expect(yield* readPolicy).toBe(normalizePolicyDocument(initialPolicy));
      expect(requests.filter((request) => request.action === "PutResourcePolicy")).toEqual([
        { action: "PutResourcePolicy", blockPublicPolicy: true, secretId: secretArn },
      ]);
      // ValidateResourcePolicy is authorized against the secret it names, so
      // once the secret exists every validation must name it: an identity
      // scoped to this secret's ARN is denied an untargeted (`*`) validation.
      // Only the first create, before RDS returns a secret, runs untargeted.
      const validatedSecretIds = (from: number) =>
        requests
          .slice(from)
          .filter((request) => request.action === "ValidateResourcePolicy")
          .map((request) => request.secretId);
      expect(validatedSecretIds(0).length).toBeGreaterThan(0);
      expect(validatedSecretIds(0).every((secretId) => secretId === undefined)).toBe(true);
      const beforePlan = requests.length;
      expect(
        (yield* stack
          .plan(program(initialPolicy))
          .pipe(Effect.provideService(HttpClient.HttpClient, observedClient))).resources
          .SecretPolicyInstance,
      ).toMatchObject({ action: "noop" });
      expect(validatedSecretIds(beforePlan).length).toBeGreaterThan(0);
      expect(validatedSecretIds(beforePlan).every((secretId) => secretId === secretArn)).toBe(true);

      const beforeNoop = requests.length;
      const unchanged = yield* deploy(initialPolicy, "force-reconcile");
      expect(unchanged.dbInstanceArn).toBe(created.dbInstanceArn);
      expect(validatedSecretIds(beforeNoop).length).toBeGreaterThan(0);
      expect(validatedSecretIds(beforeNoop).every((secretId) => secretId === secretArn)).toBe(true);
      expect(
        requests
          .slice(beforeNoop)
          .filter((request) =>
            ["PutResourcePolicy", "DeleteResourcePolicy"].includes(request.action),
          ),
      ).toEqual([]);

      const updated = yield* deploy(updatedPolicy);
      expect(updated.masterUserSecretArn).toBe(secretArn);
      expect(updated.masterUserSecretResourcePolicy).toBe(normalizePolicyDocument(updatedPolicy));
      expect(yield* readPolicy).toBe(normalizePolicyDocument(updatedPolicy));

      yield* secretsmanager.deleteResourcePolicy({ SecretId: secretArn });
      expect(yield* waitPolicy(undefined)).toBeUndefined();
      expect(
        (yield* stack.plan(program(updatedPolicy))).resources.SecretPolicyInstance,
      ).toMatchObject({ action: "update" });
      yield* deploy(updatedPolicy);
      expect(yield* readPolicy).toBe(normalizePolicyDocument(updatedPolicy));

      const removed = yield* deploy(undefined);
      expect(removed.masterUserSecretArn).toBe(secretArn);
      expect(removed.masterUserSecretResourcePolicy).toBeUndefined();
      expect(yield* readPolicy).toBeUndefined();
      expect((yield* stack.plan(program(undefined))).resources.SecretPolicyInstance).toMatchObject({
        action: "noop",
      });

      yield* injectPolicy(initialPolicy);
      const drift = yield* Drift.detect({
        name: stack.name,
        stage: stack.stage,
      });
      expect(drift.resources.SecretPolicyInstance?.action).toBe("drifted");
      expect((yield* stack.plan(program(undefined))).resources.SecretPolicyInstance).toMatchObject({
        action: "update",
      });
      yield* deploy(undefined);
      expect(yield* readPolicy).toBeUndefined();

      yield* injectPolicy(updatedPolicy);
      yield* Effect.gen(function* () {
        const state = yield* yield* State;
        yield* state.delete({
          stack: stack.name,
          stage: stack.stage,
          fqn: "SecretPolicyInstance",
        });
      }).pipe(Effect.provide(stack.state));
      const adopted = yield* deploy(undefined);
      expect(adopted.dbInstanceArn).toBe(created.dbInstanceArn);
      expect(adopted.masterUserSecretArn).toBe(secretArn);
      expect(yield* readPolicy).toBeUndefined();

      const publicPolicy: PolicyDocument = {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { AWS: "*" },
            Action: ["secretsmanager:GetSecretValue"],
            Resource: "*",
          },
        ],
      };
      const rejected = yield* deploy(publicPolicy).pipe(Effect.result);
      expect(Result.isFailure(rejected)).toBe(true);
      expect(renderFailure(rejected)).toContain("InvalidDBInstanceSecretPolicy");
      expect(yield* readPolicy).toBeUndefined();
      yield* deploy(undefined);
      const finalMetadata = yield* secretsmanager.describeSecret({
        SecretId: secretArn,
      });
      expect(finalMetadata.ARN).toBe(metadata.ARN);
      expect(finalMetadata.RotationEnabled).toBe(metadata.RotationEnabled);
      expect(finalMetadata.VersionIdsToStages).toEqual(metadata.VersionIdsToStages);
      expect(
        requests.some((request) =>
          [
            "GetSecretValue",
            "BatchGetSecretValue",
            "PutSecretValue",
            "UpdateSecret",
            "RotateSecret",
            "DeleteSecret",
          ].includes(request.action),
        ),
      ).toBe(false);
      expect(
        requests
          .filter((request) => request.action === "PutResourcePolicy")
          .every((request) => request.blockPublicPolicy),
      ).toBe(true);
      expect((yield* stack.plan(program(undefined))).resources.SecretPolicyInstance).toMatchObject({
        action: "noop",
      });
      yield* stack.destroy();
      yield* assertInstanceGone(identifier);
      expect(
        yield* secretsmanager.describeSecret({ SecretId: secretArn }).pipe(
          Effect.as(false),
          Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(true)),
          Effect.repeat({
            schedule: Schedule.spaced("5 seconds"),
            times: 8,
            until: (gone) => gone,
          }),
        ),
      ).toBe(true);
    }),
  {
    tags: [
      "provider:aws",
      "provider:aws:ec2",
      "provider:aws:iam",
      "provider:aws:rds",
      "provider:aws:secretsmanager",
      "live",
    ],
    timeout: LONG_INSTANCE_TIMEOUT,
  },
);

lifecycle(5, process.env.RDS_TEST_LIFECYCLE)(
  "managed secret policy: enable management on an existing instance",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* AWSEnvironment.current;
      const policy: PolicyDocument = {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { AWS: `arn:aws:iam::${accountId}:root` },
            Action: ["secretsmanager:DescribeSecret"],
            Resource: "*",
          },
        ],
      };
      const program = (managed: boolean, resourcePolicy?: PolicyDocument) =>
        Effect.gen(function* () {
          const net = yield* Network("EnableSecretNet", {
            cidrBlock: "10.50.0.0/16",
          });
          const subnetGroup = yield* DBSubnetGroup("EnableSecretSubnetGroup", {
            description: "Enable RDS managed credentials",
            subnetIds: net.privateSubnetIds,
          });
          return yield* DBInstance("EnableSecretInstance", {
            engine: "postgres",
            dbInstanceClass: "db.t3.micro",
            masterUsername: "alchemy",
            masterUserPassword: managed ? undefined : Redacted.make("Alchemy-secret-policy-42!"),
            manageMasterUserPassword: managed,
            masterUserSecretResourcePolicy: resourcePolicy,
            dbSubnetGroupName: subnetGroup.dbSubnetGroupName,
            backupRetentionPeriod: "0 days",
            deletionProtection: false,
            skipFinalSnapshot: true,
            publiclyAccessible: false,
          });
        });
      const invalid = yield* stack.deploy(program(false, policy)).pipe(Effect.result);
      expect(renderFailure(invalid)).toContain("InvalidDBInstanceSecretPolicy");
      const created = yield* stack.deploy(program(false));
      expect(created.masterUserSecretArn).toBeUndefined();
      expect(created.masterUserSecretResourcePolicy).toBeUndefined();
      const enabled = yield* stack.deploy(program(true, policy));
      expect(enabled.dbInstanceArn).toBe(created.dbInstanceArn);
      const secretArn = enabled.masterUserSecretArn;
      if (!secretArn) return yield* Effect.fail(new Error("RDS did not enable its managed secret"));
      expect(enabled.masterUserSecretResourcePolicy).toBe(normalizePolicyDocument(policy));
      expect(
        normalizePolicyDocument(
          (yield* secretsmanager.getResourcePolicy({ SecretId: secretArn })).ResourcePolicy!,
        ),
      ).toBe(normalizePolicyDocument(policy));
      const removed = yield* stack.deploy(program(true));
      expect(removed.masterUserSecretArn).toBe(secretArn);
      expect(
        (yield* secretsmanager.getResourcePolicy({ SecretId: secretArn })).ResourcePolicy,
      ).toBeUndefined();
      expect((yield* stack.plan(program(true))).resources.EnableSecretInstance).toMatchObject({
        action: "noop",
      });
      yield* stack.destroy();
      yield* assertInstanceGone(created.dbInstanceIdentifier);
    }),
  {
    tags: [
      "provider:aws",
      "provider:aws:ec2",
      "provider:aws:iam",
      "provider:aws:rds",
      "provider:aws:secretsmanager",
      "live",
    ],
    timeout: INSTANCE_TIMEOUT,
  },
);

lifecycle(3, process.env.RDS_TEST_LIFECYCLE)(
  "readiness: pending creation, blocked stop, and restart recovery",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const client = yield* HttpClient.HttpClient;
      const observations: Array<{ action: string; statuses: string[] }> = [];
      const observedClient = client.pipe(
        HttpClient.transformResponse(
          Effect.flatMap((response) =>
            Effect.gen(function* () {
              const body = response.request.body;
              if (body._tag !== "Uint8Array") return response;
              const action = yield* Effect.sync(() =>
                new URLSearchParams(new TextDecoder().decode(body.body)).get("Action"),
              );
              if (action !== "DescribeDBInstances") return response;
              const bytes = yield* response.arrayBuffer;
              return yield* Effect.sync(() => {
                const text = new TextDecoder().decode(bytes);
                observations.push({
                  action,
                  statuses: [
                    ...text.matchAll(/<DBInstanceStatus>([^<]+)<\/DBInstanceStatus>/g),
                  ].map((match) => match[1]!),
                });
                // Forward the real response bytes unchanged to the SDK parser.
                return HttpClientResponse.fromWeb(
                  response.request,
                  new Response(bytes, {
                    status: response.status,
                    headers: response.headers,
                  }),
                );
              });
            }),
          ),
        ),
      );
      const program = Effect.gen(function* () {
        const network = yield* Network("ReadinessNet", {
          cidrBlock: "10.48.0.0/16",
        });
        const subnetGroup = yield* DBSubnetGroup("ReadinessSubnetGroup", {
          description: "RDS readiness lifecycle",
          subnetIds: network.privateSubnetIds,
        });
        return yield* DBInstance("ReadinessInstance", {
          engine: "postgres",
          dbInstanceClass: "db.t3.micro",
          dbSubnetGroupName: subnetGroup.dbSubnetGroupName,
          masterUsername: "alchemy",
          manageMasterUserPassword: true,
          backupRetentionPeriod: "0 days",
          deletionProtection: false,
          skipFinalSnapshot: true,
          publiclyAccessible: false,
        });
      });
      const deploy = stack
        .deploy(program)
        .pipe(Effect.provideService(HttpClient.HttpClient, observedClient));
      const created = yield* deploy;
      const statuses = () => observations.flatMap((observation) => observation.statuses);
      expect(statuses()).toContain("creating");
      expect(statuses().at(-1)).toBe("available");
      expect(created.status).toBe("available");
      const identifier = created.dbInstanceIdentifier;
      const describe = rds.describeDBInstances({
        DBInstanceIdentifier: identifier,
      });
      const waitForStatus = (status: string) =>
        describe.pipe(
          Effect.repeat({
            schedule: Schedule.min([
              Schedule.exponential("5 seconds"),
              Schedule.spaced("1 minute"),
            ]),
            times: 10,
            until: (response) => response.DBInstances?.[0]?.DBInstanceStatus === status,
          }),
        );
      expect((yield* describe).DBInstances?.[0]?.DBInstanceStatus).toBe("available");

      yield* rds.stopDBInstance({ DBInstanceIdentifier: identifier });
      const stopped = yield* waitForStatus("stopped");
      expect(stopped.DBInstances?.[0]?.DBInstanceStatus).toBe("stopped");
      expect((yield* stack.plan(program)).resources.ReadinessInstance).toMatchObject({
        action: "update",
      });
      const [elapsed, blocked] = yield* deploy.pipe(Effect.result, Effect.timed);
      expect(Result.isFailure(blocked)).toBe(true);
      expect(renderFailure(blocked)).toContain("DBInstanceReadinessBlocked");
      expect(renderFailure(blocked)).toContain("stopped");
      expect(Duration.toMillis(elapsed)).toBeLessThan(60_000);

      yield* rds.startDBInstance({ DBInstanceIdentifier: identifier });
      const starting = yield* describe.pipe(
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          times: 8,
          until: (response) =>
            ["starting", "available"].includes(response.DBInstances?.[0]?.DBInstanceStatus ?? ""),
        }),
      );
      expect(["starting", "available"]).toContain(starting.DBInstances?.[0]?.DBInstanceStatus);
      observations.length = 0;
      const started = yield* deploy;
      expect(statuses().at(-1)).toBe("available");
      expect(started.dbInstanceArn).toBe(created.dbInstanceArn);
      expect(started.status).toBe("available");
      expect((yield* describe).DBInstances?.[0]?.DBInstanceStatus).toBe("available");
      expect((yield* stack.plan(program)).resources.ReadinessInstance).toMatchObject({
        action: "noop",
      });
      yield* stack.destroy();
      yield* assertInstanceGone(identifier);
    }),
  {
    tags: ["provider:aws", "provider:aws:ec2", "provider:aws:rds", "live"],
    timeout: INSTANCE_TIMEOUT,
  },
);

// Fingerprint-guarded master password lifecycle (#876), gated behind
// RDS_TEST_LIFECYCLE=1 (real db.t3.micro, ~15-25 min).
//
// AWS never returns the master password, so the provider fingerprints the
// configured value (identifier-salted sha256, persisted `Redacted`) and only
// sends `MasterUserPassword` on modify when the fingerprint changed. RDS
// durably records a "Reset master credentials" event whenever a password
// modify actually applies, which makes the guard observable out-of-band:
//
//   1. create with password P1 — set at create time, no reset event
//   2. redeploy P1 with a tag change (forces reconcile) — fingerprint stable
//   3. redeploy P2 — fingerprint changes; RDS records the credentials reset
//
// After step 3's event is observed, the reset-event count over the whole run
// must be exactly 1 — the anchored positive event proves step 2's reconcile
// did not re-send the unchanged password (pre-#876 every reconcile did,
// putting the instance through a live `resetting-master-credentials` cycle).
lifecycle(2, process.env.RDS_TEST_LIFECYCLE)(
  "master password: fingerprint guard skips unchanged, applies rotation",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const identifier = "alchemy-rds-fingerprint";
      const startedAt = yield* Effect.sync(() => new Date());

      // The testing account has no default VPC/subnets — provision a network
      // and DB subnet group like the standalone lifecycle test above.
      const network = Effect.gen(function* () {
        const net = yield* Network("FingerprintNet", {
          cidrBlock: "10.42.0.0/16",
        });
        const subnetGroup = yield* DBSubnetGroup("FingerprintSubnetGroup", {
          description: "alchemy master-password fingerprint lifecycle",
          subnetIds: net.privateSubnetIds,
        });
        return { dbSubnetGroupName: subnetGroup.dbSubnetGroupName };
      });

      const deployInstance = (password: string, round: string) =>
        stack.deploy(
          Effect.gen(function* () {
            const { dbSubnetGroupName } = yield* network;
            return yield* DBInstance("FingerprintInstance", {
              dbInstanceIdentifier: identifier,
              engine: "postgres",
              dbInstanceClass: "db.t3.micro",
              allocatedStorage: 20,
              masterUsername: "alchemy",
              masterUserPassword: Redacted.make(password),
              deletionProtection: false,
              dbSubnetGroupName,
              publiclyAccessible: false,
              // A changed tag guarantees the engine sees a props diff and
              // runs `reconcile` — the exact path that used to re-send the
              // unchanged password.
              tags: { round },
            });
          }),
        );

      const resetEvents = rds
        .describeEvents({
          SourceIdentifier: identifier,
          SourceType: "db-instance",
          StartTime: startedAt,
        })
        .pipe(
          Effect.map((response) =>
            (response.Events ?? []).filter((event) =>
              /reset master credentials/i.test(event.Message ?? ""),
            ),
          ),
        );

      const created = yield* deployInstance("FingerprintPass1", "one");
      const createdFingerprint = created.masterUserPasswordFingerprint;
      expect(createdFingerprint).toBeDefined();
      // sha256 hex digest — never the password itself.
      expect(Redacted.value(createdFingerprint!)).toMatch(/^[0-9a-f]{64}$/);

      // Same password, tag-only change → reconcile runs but must skip the
      // `MasterUserPassword` modify (same fingerprint).
      const unchanged = yield* deployInstance("FingerprintPass1", "two");
      expect(unchanged.dbInstanceArn).toBe(created.dbInstanceArn);
      expect(Redacted.value(unchanged.masterUserPasswordFingerprint!)).toBe(
        Redacted.value(createdFingerprint!),
      );

      // Rotation: new password → new fingerprint, and RDS applies a real
      // master-credentials reset.
      const rotated = yield* deployInstance("FingerprintPass2", "three");
      expect(rotated.dbInstanceArn).toBe(created.dbInstanceArn);
      expect(Redacted.value(rotated.masterUserPasswordFingerprint!)).not.toBe(
        Redacted.value(createdFingerprint!),
      );

      // The reset event lands when the modify applies; poll bounded for it,
      // then assert the count over the whole run is exactly 1 — proving
      // round "two" (unchanged password) never triggered a reset.
      const events = yield* resetEvents.pipe(
        Effect.repeat({
          schedule: Schedule.min([Schedule.exponential("5 seconds"), Schedule.spaced("1 minute")]),
          until: (found) => found.length > 0,
          times: 10,
        }),
      );
      expect(events).toHaveLength(1);

      yield* stack.destroy();
    }),
  {
    tags: ["provider:aws", "provider:aws:ec2", "provider:aws:rds", "live"],
    timeout: INSTANCE_TIMEOUT,
  },
);

// Regression for #2317: a deploy whose core modify resets the master
// password and also enables IAM authentication. RDS keeps reporting
// `available` for a few seconds after accepting the reset, so the follow-up
// IAM modify used to reach a busy instance and fail with
// `InvalidDBInstanceStateFault`.
lifecycle(7, process.env.RDS_TEST_LIFECYCLE)(
  "master password: a password reset followed by an IAM change in one deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const startedAt = yield* Effect.sync(() => new Date());
      const deployInstance = (password: string, iam: boolean) =>
        stack.deploy(
          Effect.gen(function* () {
            const net = yield* Network("ResetIamNet", {
              cidrBlock: "10.43.0.0/16",
            });
            const subnetGroup = yield* DBSubnetGroup("ResetIamSubnetGroup", {
              description: "alchemy password reset + IAM lifecycle",
              subnetIds: net.privateSubnetIds,
            });
            return yield* DBInstance("ResetIamInstance", {
              engine: "postgres",
              dbInstanceClass: "db.t3.micro",
              allocatedStorage: 20,
              masterUsername: "alchemy",
              masterUserPassword: Redacted.make(password),
              enableIAMDatabaseAuthentication: iam,
              deletionProtection: false,
              dbSubnetGroupName: subnetGroup.dbSubnetGroupName,
              publiclyAccessible: false,
            });
          }),
        );

      const created = yield* deployInstance("ResetIamPass1", false);
      // The race is a few seconds wide, so give it several chances: each
      // round resets the password and flips IAM authentication together.
      const rounds = [
        { password: "ResetIamPass2", iam: true },
        { password: "ResetIamPass3", iam: false },
        { password: "ResetIamPass4", iam: true },
      ];
      for (const { password, iam } of rounds) {
        const updated = yield* deployInstance(password, iam);
        expect(updated.dbInstanceArn).toBe(created.dbInstanceArn);
        const instance = (yield* rds.describeDBInstances({
          DBInstanceIdentifier: updated.dbInstanceIdentifier,
        })).DBInstances?.[0];
        expect(instance?.IAMDatabaseAuthenticationEnabled).toBe(iam);
      }

      // Every password reset really applied, so each IAM modify followed one.
      const resets = yield* rds
        .describeEvents({
          SourceIdentifier: created.dbInstanceIdentifier,
          SourceType: "db-instance",
          StartTime: startedAt,
        })
        .pipe(
          Effect.map((response) =>
            (response.Events ?? []).filter((event) =>
              /reset master credentials/i.test(event.Message ?? ""),
            ),
          ),
          Effect.repeat({
            schedule: Schedule.min([
              Schedule.exponential("5 seconds"),
              Schedule.spaced("1 minute"),
            ]),
            until: (found) => found.length >= rounds.length,
            times: 10,
          }),
        );
      expect(resets).toHaveLength(rounds.length);

      yield* stack.destroy();
    }),
  {
    tags: ["provider:aws", "provider:aws:ec2", "provider:aws:rds", "live"],
    timeout: INSTANCE_TIMEOUT,
  },
);

// Both guards fire while the stack is built, before any cloud call.
test.provider(
  "Aurora rejects the Data API transport without the Data API, and non-Aurora engines",
  (stack) =>
    Effect.gen(function* () {
      const rejection = (props: Partial<AuroraProps>) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(
            stack.deploy(
              Aurora("RejectedMigrationsDb", {
                subnetIds: [],
                securityGroupIds: [],
                migrations: "./migrations",
                ...props,
              }),
            ),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          return Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "";
        });

      yield* stack.destroy();
      expect(yield* rejection({ dataApi: false, migrationsTransport: "data-api" })).toContain(
        'migrationsTransport "data-api" requires "dataApi" to be enabled',
      );
      expect(yield* rejection({ engine: "postgres" })).toContain(
        '"migrations" support the "aurora-postgresql" and "aurora-mysql" engines',
      );
      yield* stack.destroy();
    }),
  { tags: ["provider:aws", "provider:aws:rds", "live"] },
);

// An Aurora cluster plus writer takes ~15+ minutes to create and delete,
// far beyond the default test budget. The fixture SQL is valid in both
// dialects, so each engine runs the same case in its own lane.
for (const { lane, engine, cidrBlock } of [
  { lane: 7, engine: "aurora-postgresql", cidrBlock: "10.53.0.0/16" },
  { lane: 8, engine: "aurora-mysql", cidrBlock: "10.54.0.0/16" },
]) {
  lifecycle(lane, process.env.AWS_TEST_RDS_DBINSTANCE)(
    `Aurora writer applies migrations over the Data API, then only pending ones (${engine})`,
    (stack) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const migrationsDir = yield* fs.makeTempDirectoryScoped({
          prefix: "alchemy-aurora-migrations-",
        });
        yield* fs.writeFileString(
          path.join(migrationsDir, "0001_users.sql"),
          "CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT NOT NULL);",
        );
        const deployDb = stack.deploy(
          Effect.gen(function* () {
            const net = yield* Network("MigrationsNet", { cidrBlock });
            const securityGroup = yield* SecurityGroup("MigrationsDbSecurityGroup", {
              vpcId: net.vpcId,
              description: "alchemy Aurora migrations test",
            });
            const key = yield* Key("MigrationsDbKey", {
              description: "alchemy Aurora migrations test",
            });
            // `kmsKeyId` and `migrations` take Outputs (#2363).
            const db = yield* Aurora("MigrationsDb", {
              engine,
              subnetIds: net.privateSubnetIds,
              securityGroupIds: [securityGroup.groupId],
              storageEncrypted: true,
              kmsKeyId: key.keyArn,
              migrations: Output.asOutput(migrationsDir),
            });
            return {
              keyArn: key.keyArn,
              clusterArn: db.cluster.dbClusterArn,
              secretArn: db.secret.secretArn,
              writer: db.writer,
            };
          }),
        );

        yield* stack.destroy();

        const created = yield* deployDb;
        expect(created.writer.migrationsTable).toEqual("__alchemy_migrations");
        expect(Object.keys(created.writer.migrationsHashes)).toEqual(["0001_users.sql"]);

        yield* fs.writeFileString(
          path.join(migrationsDir, "0002_posts.sql"),
          "CREATE TABLE posts (id SERIAL PRIMARY KEY, title TEXT NOT NULL);",
        );
        const updated = yield* deployDb;
        expect(updated.clusterArn).toEqual(created.clusterArn);
        expect(updated.writer.dbiResourceId).toEqual(created.writer.dbiResourceId);
        expect(Object.keys(updated.writer.migrationsHashes).sort()).toEqual([
          "0001_users.sql",
          "0002_posts.sql",
        ]);

        const cluster = (yield* rds.describeDBClusters({
          DBClusterIdentifier: created.clusterArn,
        })).DBClusters?.[0];
        expect(cluster?.KmsKeyId).toEqual(created.keyArn);

        // Out-of-band: the bookkeeping rows via the Data API.
        const applied = yield* rdsdata.executeStatement({
          resourceArn: created.clusterArn,
          secretArn: created.secretArn,
          database: "app",
          sql: "SELECT name FROM __alchemy_migrations ORDER BY id;",
          formatRecordsAs: "JSON",
        });
        expect(JSON.parse(applied.formattedRecords ?? "[]")).toEqual([
          { name: "0001_users.sql" },
          { name: "0002_posts.sql" },
        ]);

        yield* stack.destroy();
      }),
    {
      tags: ["provider:aws", "provider:aws:ec2", "provider:aws:rds", "live"],
      timeout: LONG_INSTANCE_TIMEOUT,
    },
  );
}

// Writes `0001_users.sql` into a fresh temp directory; the returned `add`
// writes later migrations into the same directory between deploys.
const migrationsFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-rds-migrations-" });
  const add = (name: string, sql: string) => fs.writeFileString(path.join(dir, name), sql);
  yield* add("0001_users.sql", "CREATE TABLE users (id INT PRIMARY KEY, name TEXT NOT NULL);");
  return { dir, add };
});

const readSecretCredentials = Effect.fn(function* (secretArn: string) {
  const value = yield* secretsmanager.getSecretValue({ SecretId: secretArn });
  const secretString =
    typeof value.SecretString === "string"
      ? value.SecretString
      : Redacted.value(value.SecretString!);
  return JSON.parse(secretString) as { username: string; password: string };
});

// A public PostgreSQL instance reachable only from this machine's address.
lifecycle(4, process.env.AWS_TEST_RDS_DBINSTANCE)(
  "standalone PostgreSQL applies migrations directly from the deploying machine",
  (stack) =>
    Effect.gen(function* () {
      const migrations = yield* migrationsFixture;
      const ip = yield* HttpClient.get("https://checkip.amazonaws.com").pipe(
        Effect.flatMap((response) => response.text),
        Effect.map((text) => text.trim()),
      );
      const deployDb = stack.deploy(
        Effect.gen(function* () {
          const net = yield* Network("DirectMigrationsNet", { cidrBlock: "10.55.0.0/16" });
          const subnetGroup = yield* DBSubnetGroup("DirectMigrationsSubnets", {
            description: "alchemy direct migrations test",
            subnetIds: net.publicSubnetIds,
          });
          const securityGroup = yield* SecurityGroup("DirectMigrationsSg", {
            vpcId: net.vpcId,
            description: "alchemy direct migrations test",
            ingress: [{ ipProtocol: "tcp", fromPort: 5432, toPort: 5432, cidrIpv4: `${ip}/32` }],
          });
          return yield* DBInstance("DirectMigrationsDb", {
            engine: "postgres",
            dbInstanceClass: "db.t4g.micro",
            allocatedStorage: 20,
            dbName: "app",
            masterUsername: "app",
            manageMasterUserPassword: true,
            publiclyAccessible: true,
            dbSubnetGroupName: subnetGroup.dbSubnetGroupName,
            vpcSecurityGroupIds: [securityGroup.groupId],
            migrations: migrations.dir,
            migrationsTransport: "direct",
          });
        }),
      );

      yield* stack.destroy();

      const created = yield* deployDb;
      expect(Object.keys(created.migrationsHashes)).toEqual(["0001_users.sql"]);

      yield* migrations.add(
        "0002_posts.sql",
        "CREATE TABLE posts (id INT PRIMARY KEY, title TEXT NOT NULL);",
      );
      const updated = yield* deployDb;
      expect(updated.dbiResourceId).toEqual(created.dbiResourceId);
      expect(Object.keys(updated.migrationsHashes).sort()).toEqual([
        "0001_users.sql",
        "0002_posts.sql",
      ]);

      // Out-of-band: read the bookkeeping rows over our own connection.
      const credentials = yield* readSecretCredentials(updated.masterUserSecretArn!);
      const rows = yield* Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql`SELECT name FROM __alchemy_migrations ORDER BY id`;
      }).pipe(
        Effect.provide(
          PgClient.layer({
            host: updated.endpointAddress,
            port: updated.endpointPort,
            database: "app",
            username: credentials.username,
            password: Redacted.make(credentials.password),
            ssl: { rejectUnauthorized: false },
          }),
        ),
      );
      expect(rows).toEqual([{ name: "0001_users.sql" }, { name: "0002_posts.sql" }]);

      yield* stack.destroy();
    }),
  {
    tags: ["provider:aws", "provider:aws:ec2", "provider:aws:rds", "live"],
    timeout: LONG_INSTANCE_TIMEOUT,
  },
);

// A private MySQL instance only the in-VPC runner can reach.
lifecycle(5, process.env.AWS_TEST_RDS_DBINSTANCE)(
  "private MySQL applies migrations through an in-VPC MigrationRunner",
  (stack) =>
    Effect.gen(function* () {
      const migrations = yield* migrationsFixture;
      const deployDb = stack.deploy(
        Effect.gen(function* () {
          const net = yield* Network("RunnerMigrationsNet", { cidrBlock: "10.56.0.0/16" });
          const subnetGroup = yield* DBSubnetGroup("RunnerMigrationsSubnets", {
            description: "alchemy runner migrations test",
            subnetIds: net.privateSubnetIds,
          });
          const runnerSecurityGroup = yield* SecurityGroup("RunnerMigrationsRunnerSg", {
            vpcId: net.vpcId,
            description: "alchemy migration runner",
          });
          const databaseSecurityGroup = yield* SecurityGroup("RunnerMigrationsDbSg", {
            vpcId: net.vpcId,
            description: "alchemy runner migrations database",
            ingress: [
              {
                ipProtocol: "tcp",
                fromPort: 3306,
                toPort: 3306,
                referencedGroupId: runnerSecurityGroup.groupId,
              },
            ],
          });
          const runner = yield* MigrationRunner("RunnerMigrationsRunner", {
            subnetIds: net.privateSubnetIds,
            securityGroupIds: [runnerSecurityGroup.groupId],
          });
          const db = yield* DBInstance("RunnerMigrationsDb", {
            engine: "mysql",
            dbInstanceClass: "db.t4g.micro",
            allocatedStorage: 20,
            dbName: "app",
            masterUsername: "app",
            manageMasterUserPassword: true,
            publiclyAccessible: false,
            dbSubnetGroupName: subnetGroup.dbSubnetGroupName,
            vpcSecurityGroupIds: [databaseSecurityGroup.groupId],
            migrations: migrations.dir,
            migrationsTransport: runner,
          });
          return { db, runnerArn: runner.functionArn };
        }),
      );

      yield* stack.destroy();

      const created = yield* deployDb;
      expect(Object.keys(created.db.migrationsHashes)).toEqual(["0001_users.sql"]);

      yield* migrations.add(
        "0002_posts.sql",
        "CREATE TABLE posts (id INT PRIMARY KEY, title TEXT NOT NULL);",
      );
      const updated = yield* deployDb;
      expect(updated.db.dbiResourceId).toEqual(created.db.dbiResourceId);
      expect(Object.keys(updated.db.migrationsHashes).sort()).toEqual([
        "0001_users.sql",
        "0002_posts.sql",
      ]);

      // Out-of-band: the database is private, so query it through the runner.
      const credentials = yield* readSecretCredentials(updated.db.masterUserSecretArn!);
      const response = yield* Lambda.invoke({
        FunctionName: updated.runnerArn,
        Payload: JSON.stringify({
          op: "query",
          target: {
            dialect: "mysql",
            host: updated.db.endpointAddress,
            port: updated.db.endpointPort,
            database: "app",
            ...credentials,
          },
          sql: "SELECT name FROM __alchemy_migrations ORDER BY id;",
        }),
      });
      const body = yield* response.Payload!.pipe(Stream.decodeText(), Stream.mkString);
      expect(JSON.parse(body)).toEqual({
        ok: true,
        rows: [{ name: "0001_users.sql" }, { name: "0002_posts.sql" }],
      });

      yield* stack.destroy();
    }),
  {
    tags: ["provider:aws", "provider:aws:ec2", "provider:aws:lambda", "provider:aws:rds", "live"],
    timeout: LONG_INSTANCE_TIMEOUT,
  },
);

describe.concurrent("lifecycle lanes", () => {
  lanes.forEach((cases, index) =>
    describe(`lane ${index + 1}`, () => {
      for (const { enabled, args } of cases) {
        test.provider.skipIf(!enabled)(...args);
      }
    }),
  );
});
