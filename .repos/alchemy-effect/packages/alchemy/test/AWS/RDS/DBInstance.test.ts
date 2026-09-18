import * as AWS from "@/AWS";
import * as ec2 from "@distilled.cloud/aws/ec2";
import { SecurityGroup } from "@/AWS/EC2/SecurityGroup";
import { DBParameterGroup } from "@/AWS/RDS/DBParameterGroup";
import { Network } from "@/AWS/EC2/Network";
import { DBCluster, DBInstance, type DBInstanceProps } from "@/AWS/RDS";
import * as Drift from "@/Drift";
import { State } from "@/State";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { DBSubnetGroup } from "@/AWS/RDS/DBSubnetGroup.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as rds from "@distilled.cloud/aws/rds";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

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
      expect(renderFailure(emptyGroups)).toContain(
        "InvalidDBInstanceAssociations",
      );

      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);

// Default (read-only) path: an RDS instance takes many minutes to create and
// delete — far beyond the 240s test budget — so the canonical `list()` test
// here does NOT deploy. It resolves the provider via the typed
// `Provider.findProvider(DBInstance)` helper and calls `list()` directly,
// asserting it returns a well-typed `DBInstance["Attributes"][]`. On a fresh
// account this is typically empty; either way every element must conform to
// the exact `read` shape.
test.provider("list returns well-typed DB instance attributes", () =>
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
);

// Full lifecycle is gated: provisioning an Aurora cluster + instance and then
// tearing it down takes many minutes, exceeding the 240s budget. Set
// AWS_TEST_RDS_DBINSTANCE=1 on an account that can afford the wait to run it.
// It deploys a serverless-v2 Aurora cluster + instance and asserts the
// instance appears in the exhaustively-paginated `list()` result.
test.provider.skipIf(!process.env.AWS_TEST_RDS_DBINSTANCE)(
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
          const ignoredInstanceGroup = yield* SecurityGroup(
            "ListIgnoredInstanceGroup",
            { vpcId: network.vpcId, description: "Ignored instance group" },
          );
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
      expect(requests.filter((request) => request.port !== null)).toEqual([]);
      expect(
        requests.filter((request) => request.securityGroups.length > 0),
      ).toEqual([]);
      const cluster = (yield* rds.describeDBClusters({
        DBClusterIdentifier: instance.dbClusterIdentifier!,
      })).DBClusters![0]!;
      expect([...updated.vpcSecurityGroupIds].sort()).toEqual(
        cluster
          .VpcSecurityGroups!.map((group) => group.VpcSecurityGroupId!)
          .sort(),
      );
      const family = (yield* rds.describeDBEngineVersions({
        Engine: "aurora-postgresql",
        EngineVersion: cluster.EngineVersion,
      })).DBEngineVersions![0]!.DBParameterGroupFamily!;
      expect(updated.dbParameterGroupNames).toEqual([`default.${family}`]);
      expect(
        requests.filter(
          (request) =>
            request.action === "ModifyDBInstance" &&
            request.parameterGroup !== null,
        ),
      ).toEqual([]);
      expect(
        requests.some((request) => request.action === "CreateDBInstance"),
      ).toBe(true);
      yield* assertPort(instance.dbInstanceIdentifier, 5434);
      expect(
        (yield* stack.plan(program("updated"))).resources.ListInstance,
      ).toMatchObject({ action: "noop" });

      const provider = yield* Provider.findProvider(DBInstance);
      const all = yield* provider.list();

      expect(
        all.some(
          (i) => i.dbInstanceIdentifier === instance.dbInstanceIdentifier,
        ),
      ).toBe(true);

      yield* stack.destroy();
    }),
);

// RDS provisioning and storage optimization exceed the default test budget.
test.provider.skipIf(!process.env.RDS_TEST_LIFECYCLE)(
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
            ...(maxAllocatedStorage === undefined
              ? {}
              : { maxAllocatedStorage }),
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
      expect([0, 20]).toContain(
        (yield* describe).DBInstances?.[0]?.MaxAllocatedStorage ?? 0,
      );

      const enabled = yield* stack.deploy(program(20, 40));
      expect(enabled.maxAllocatedStorage).toBe(40);
      expect((yield* describe).DBInstances?.[0]?.MaxAllocatedStorage).toBe(40);
      // Grow beyond the old ceiling while disabling autoscaling in the same request.
      const updated = yield* stack.deploy(
        program(50, undefined, "3 days", true),
      );
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
            until: (response) =>
              response.DBInstances?.[0]?.MaxAllocatedStorage === ceiling,
          }),
        );
        expect(injected.DBInstances?.[0]?.MaxAllocatedStorage).toBe(ceiling);
      });
      yield* injectCeiling(120);
      expect(
        (yield* stack.plan(explicit)).resources.StandaloneInstance,
      ).toMatchObject({
        action: "update",
      });
      const repairedExplicit = yield* stack.deploy(explicit);
      expect(repairedExplicit.maxAllocatedStorage).toBe(100);
      expect((yield* describe).DBInstances?.[0]?.MaxAllocatedStorage).toBe(100);

      // Lowering the minimum cannot shrink capacity, but omission disables autoscaling.
      const lowerMinimum = program(20);
      expect(
        (yield* stack.plan(lowerMinimum)).resources.StandaloneInstance,
      ).toMatchObject({
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
      expect(
        (yield* stack.plan(lowerMinimum)).resources.StandaloneInstance,
      ).toMatchObject({
        action: "update",
      });
      const repaired = yield* stack.deploy(lowerMinimum);
      expect(repaired.dbInstanceArn).toBe(created.dbInstanceArn);
      expect(repaired.allocatedStorage).toBe(50);
      expect([0, 50]).toContain(repaired.maxAllocatedStorage ?? 0);
      const settled = (yield* describe).DBInstances?.[0];
      expect([0, 50]).toContain(settled?.MaxAllocatedStorage ?? 0);
      expect(settled?.AllocatedStorage).toBe(50);
      expect(
        (yield* stack.plan(lowerMinimum)).resources.StandaloneInstance,
      ).toMatchObject({ action: "noop" });

      const disabled = program(20, 0);
      const explicitZero = yield* stack.deploy(disabled);
      expect([0, 50]).toContain(explicitZero.maxAllocatedStorage ?? 0);
      expect(explicitZero.allocatedStorage).toBe(50);
      expect(
        (yield* stack.plan(disabled)).resources.StandaloneInstance,
      ).toMatchObject({ action: "noop" });

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
);

type StorageProps = Pick<
  DBInstanceProps,
  | "allocatedStorage"
  | "storageType"
  | "iops"
  | "storageThroughput"
  | "maxAllocatedStorage"
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

const assertInstanceGone = Effect.fn(function* (identifier: string) {
  const gone = yield* rds
    .describeDBInstances({ DBInstanceIdentifier: identifier })
    .pipe(
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

for (const scenario of storageCases) {
  test.provider.skipIf(!process.env.RDS_TEST_LIFECYCLE)(
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
          (yield* stack.plan(storageProgram(finalProps))).resources
            .StorageInstance,
        ).toMatchObject({ action: "noop" });
        yield* stack.destroy();
        yield* assertInstanceGone(created.dbInstanceIdentifier);
      }),
  );
}

test.provider.skipIf(!process.env.RDS_TEST_LIFECYCLE)(
  "storage coupling: plans correction for external storage drift",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const desired = storageProgram({});
      const created = yield* stack.deploy(desired);
      yield* assertStorageState(created.dbInstanceIdentifier, [
        20,
        "gp3",
        3000,
        125,
      ]);
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
      yield* assertStorageState(created.dbInstanceIdentifier, [
        20,
        "gp2",
        0,
        0,
      ]);
      const drift = yield* Drift.detect({
        name: stack.name,
        stage: stack.stage,
      });
      expect(drift.resources.StorageInstance?.action).toBe("drifted");
      expect(
        (yield* stack.plan(desired)).resources.StorageInstance,
      ).toMatchObject({ action: "update" });
      // A second storage modification must wait for AWS's optimization cooldown.
      yield* stack.destroy();
      yield* assertInstanceGone(created.dbInstanceIdentifier);
    }),
);

const observeInstanceRequests = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const requests: Array<{
    action: string;
    port: string | null;
    parameterGroup: string | null;
    securityGroups: string[];
  }> = [];
  const observedClient = client.pipe(
    HttpClient.tapRequest((request) =>
      Effect.sync(() => {
        if (request.body._tag !== "Uint8Array") return;
        const parameters = new URLSearchParams(
          new TextDecoder().decode(request.body.body),
        );
        const action = parameters.get("Action");
        if (
          action === "CreateDBInstance" ||
          action === "ModifyDBInstance" ||
          action === "DescribeDBInstances"
        ) {
          requests.push({
            action,
            parameterGroup: parameters.get("DBParameterGroupName"),
            securityGroups: [...parameters.entries()]
              .filter(([key]) => key.startsWith("VpcSecurityGroupIds."))
              .map(([, value]) => value)
              .sort(),
            port: parameters.get(
              action === "CreateDBInstance" ? "Port" : "DBPortNumber",
            ),
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
  expect(["available", "storage-optimization"]).toContain(
    instance?.DBInstanceStatus,
  );
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
      schedule: Schedule.min([
        Schedule.exponential("5 seconds"),
        Schedule.spaced("1 minute"),
      ]),
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

test.provider.skipIf(!process.env.RDS_TEST_LIFECYCLE)(
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
          .filter(
            (request) =>
              request.action === "ModifyDBInstance" && request.port !== null,
          )
          .map((request) => request.port);
      const created = yield* deploy();
      expect(created.endpointPort).toBe(5432);
      expect(
        requests
          .filter((request) => request.action === "CreateDBInstance")
          .map((request) => request.port),
      ).toEqual(["5432"]);
      expect(
        (yield* assertPort(created.dbInstanceIdentifier, 5432))?.DbInstancePort,
      ).toBe(0);

      requests.length = 0;
      yield* deploy(5432, "same-port");
      expect(
        requests.some((request) => request.action === "DescribeDBInstances"),
      ).toBe(true);
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
      expect(
        (yield* stack.plan(portProgram())).resources.PortInstance,
      ).toMatchObject({ action: "noop" });
      yield* stack.destroy();
      yield* assertInstanceGone(created.dbInstanceIdentifier);
    }),
);

test.provider.skipIf(!process.env.RDS_TEST_LIFECYCLE)(
  "listener port: unchanged-input drift repair and adoption defaults",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const identifier = "alchemy-rds-port-adoption";
      const program = (port?: number) =>
        portProgram(port, "adoption", identifier);
      const created = yield* stack.deploy(program(5433));
      yield* assertPort(identifier, 5433);
      yield* injectPort(identifier, 5434);
      expect(
        (yield* stack.plan(program(5433))).resources.PortInstance,
      ).toMatchObject({ action: "update" });
      const drift = yield* Drift.detect({
        name: stack.name,
        stage: stack.stage,
      });
      expect(drift.resources.PortInstance?.action).toBe("drifted");
      const repaired = yield* stack.deploy(program(5433));
      expect(repaired.dbInstanceArn).toBe(created.dbInstanceArn);
      expect(repaired.endpointPort).toBe(5433);
      yield* assertPort(identifier, 5433);
      expect(
        (yield* stack.plan(program(5433))).resources.PortInstance,
      ).toMatchObject({ action: "noop" });

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
      expect(
        (yield* stack.plan(program())).resources.PortInstance,
      ).toMatchObject({ action: "noop" });

      yield* injectPort(identifier, 5434);
      expect(
        (yield* stack.plan(program())).resources.PortInstance,
      ).toMatchObject({ action: "update" });
      const defaultRepaired = yield* stack.deploy(program());
      expect(defaultRepaired.endpointPort).toBe(5432);
      yield* assertPort(identifier, 5432);
      expect(
        (yield* stack.plan(program())).resources.PortInstance,
      ).toMatchObject({ action: "noop" });
      yield* stack.destroy();
      yield* assertInstanceGone(identifier);
    }),
);

test.provider.skipIf(!process.env.RDS_TEST_LIFECYCLE)(
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
      expect(
        requests.some((request) => request.action === "DescribeDBInstances"),
      ).toBe(true);
      expect(
        requests.filter(
          (request) =>
            request.action === "ModifyDBInstance" && request.port !== null,
        ),
      ).toEqual([]);
      yield* assertPort(created.dbInstanceIdentifier, 5433);
      expect(
        (yield* stack.plan(portProgram(5433))).resources.PortInstance,
      ).toMatchObject({ action: "noop" });
      yield* stack.destroy();
      yield* assertInstanceGone(created.dbInstanceIdentifier);
    }),
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
      ...(options.omitSubnet
        ? {}
        : { dbSubnetGroupName: subnetGroup.dbSubnetGroupName }),
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
  expect(["available", "storage-optimization"]).toContain(
    instance?.DBInstanceStatus,
  );
  expect(
    instance?.DBParameterGroups?.map((group) => group.DBParameterGroupName),
  ).toEqual([parameterGroup]);
  expect(["in-sync", "pending-reboot"]).toContain(
    instance?.DBParameterGroups?.[0]?.ParameterApplyStatus,
  );
  expect(
    instance?.VpcSecurityGroups?.map(
      (group) => group.VpcSecurityGroupId,
    ).sort(),
  ).toEqual([...securityGroups].sort());
  expect(
    instance?.VpcSecurityGroups?.every((group) => group.Status === "active"),
  ).toBe(true);
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
      schedule: Schedule.min([
        Schedule.exponential("5 seconds"),
        Schedule.spaced("1 minute"),
      ]),
      times: 10,
      until: (response) => {
        const db = response.DBInstances?.[0];
        return (
          db?.DBInstanceStatus === "available" &&
          db.DBParameterGroups?.[0]?.DBParameterGroupName === parameterGroup &&
          ["in-sync", "pending-reboot"].includes(
            db.DBParameterGroups?.[0]?.ParameterApplyStatus ?? "",
          ) &&
          db.VpcSecurityGroups?.every((group) => group.Status === "active") ===
            true &&
          JSON.stringify(
            db.VpcSecurityGroups.map(
              (group) => group.VpcSecurityGroupId,
            ).sort(),
          ) === JSON.stringify([...securityGroups].sort())
        );
      },
    }),
  );
  yield* assertAssociations(identifier, parameterGroup, securityGroups);
});

test.provider.skipIf(!process.env.RDS_TEST_LIFECYCLE)(
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
      yield* assertAssociations(
        created.instance.dbInstanceIdentifier,
        "default.postgres16",
        [defaultGroup],
      );
      expect(created.instance.vpcSecurityGroupIds).toEqual([defaultGroup]);
      expect(
        requests.filter((request) => request.action === "CreateDBInstance"),
      ).toMatchObject([
        {
          parameterGroup: "default.postgres16",
          securityGroups: [defaultGroup],
        },
      ]);

      requests.length = 0;
      const attached = yield* deploy({ explicit: true });
      expect(attached.instance.dbInstanceArn).toBe(
        created.instance.dbInstanceArn,
      );
      yield* assertAssociations(
        created.instance.dbInstanceIdentifier,
        created.parameterGroupName,
        created.groupIds,
      );
      expect(
        requests.filter(
          (request) =>
            request.action === "ModifyDBInstance" &&
            (request.parameterGroup !== null ||
              request.securityGroups.length > 0),
        ),
      ).toHaveLength(1);
      expect(["in-sync", "pending-reboot"]).toContain(
        attached.instance.dbParameterGroupApplyStatuses[
          created.parameterGroupName
        ],
      );

      requests.length = 0;
      yield* deploy({ explicit: true, reverse: true, round: "reordered" });
      expect(
        requests.some((request) => request.action === "DescribeDBInstances"),
      ).toBe(true);
      expect(
        requests.filter(
          (request) =>
            request.action === "ModifyDBInstance" &&
            (request.parameterGroup !== null ||
              request.securityGroups.length > 0),
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
);

test.provider.skipIf(!process.env.RDS_TEST_LIFECYCLE)(
  "associations: removal, older-engine defaults, drift, and nondefault-VPC adoption",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const identifier = "alchemy-rds-association-defaults";
      const program = (extra: Parameters<typeof associationProgram>[0] = {}) =>
        associationProgram({ identifier, ...extra });
      const created = yield* stack.deploy(
        program({ version: "16.13", explicit: true }),
      );
      const defaultGroup = yield* defaultGroupForVpc(created.vpcId);
      yield* assertAssociations(
        identifier,
        created.parameterGroupName,
        created.groupIds,
      );

      const removed = yield* stack.deploy(program());
      expect(removed.instance.dbInstanceArn).toBe(
        created.instance.dbInstanceArn,
      );
      expect(removed.instance.engineVersion).toBe("16.13");
      yield* assertAssociations(identifier, "default.postgres16", [
        defaultGroup,
      ]);
      expect(
        (yield* ec2.describeSecurityGroups({ GroupIds: created.groupIds }))
          .SecurityGroups,
      ).toHaveLength(2);
      expect(
        (yield* rds.describeDBParameterGroups({
          DBParameterGroupName: created.parameterGroupName,
        })).DBParameterGroups,
      ).toHaveLength(1);

      yield* injectAssociations(
        identifier,
        created.parameterGroupName,
        created.groupIds,
      );
      const drift = yield* Drift.detect({
        name: stack.name,
        stage: stack.stage,
      });
      expect(drift.resources.AssociationInstance?.action).toBe("drifted");
      expect(
        (yield* stack.plan(program())).resources.AssociationInstance,
      ).toMatchObject({ action: "update" });
      yield* stack.deploy(program());
      yield* assertAssociations(identifier, "default.postgres16", [
        defaultGroup,
      ]);
      expect(
        (yield* stack.plan(program())).resources.AssociationInstance,
      ).toMatchObject({ action: "noop" });

      yield* injectAssociations(
        identifier,
        created.parameterGroupName,
        created.groupIds,
      );
      yield* Effect.gen(function* () {
        const state = yield* yield* State;
        yield* state.delete({
          stack: stack.name,
          stage: stack.stage,
          fqn: "AssociationInstance",
        });
      }).pipe(Effect.provide(stack.state));
      const adopted = yield* stack.deploy(program({ omitSubnet: true }));
      expect(adopted.instance.dbInstanceArn).toBe(
        created.instance.dbInstanceArn,
      );
      expect(adopted.instance.engineVersion).toBe("16.13");
      yield* assertAssociations(identifier, "default.postgres16", [
        defaultGroup,
      ]);
      expect(
        (yield* stack.plan(program({ omitSubnet: true }))).resources
          .AssociationInstance,
      ).toMatchObject({ action: "noop" });
      yield* stack.destroy();
      yield* assertInstanceGone(identifier);
    }),
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
test.provider.skipIf(!process.env.RDS_TEST_LIFECYCLE)(
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
          schedule: Schedule.min([
            Schedule.exponential("5 seconds"),
            Schedule.spaced("1 minute"),
          ]),
          until: (found) => found.length > 0,
          times: 10,
        }),
      );
      expect(events).toHaveLength(1);

      yield* stack.destroy();
    }),
);
