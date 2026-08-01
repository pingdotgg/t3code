import * as AWS from "@/AWS";
import { AWSEnvironment } from "@/AWS/Environment";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as docdbelastic from "@distilled.cloud/aws/docdb-elastic";
import * as EC2 from "@distilled.cloud/aws/ec2";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { getDefaultVpc } from "../DefaultVpc.ts";

import DocDBElasticTestFunctionLive, {
  DocDBElasticTestFunction,
} from "./handler";
import DocDBElasticSlowTestFunctionLive, {
  DocDBElasticSlowTestFunction,
  SECURITY_GROUPS_ENV,
  SUBNETS_ENV,
} from "./slow-handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "DocDBElasticBindings");

const NONEXISTENT_UUID = "00000000-0000-0000-0000-000000000000";

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;

// Well-formed-but-nonexistent ARNs the probe routes are driven against.
// Computed inside test bodies (test.provider provides AWSEnvironment).
const probeArns = Effect.gen(function* () {
  const { accountId, region } = yield* AWSEnvironment.current;
  return {
    snapshot: `arn:aws:docdb-elastic:${region}:${accountId}:cluster-snapshot/${NONEXISTENT_UUID}`,
    cluster: `arn:aws:docdb-elastic:${region}:${accountId}:cluster/${NONEXISTENT_UUID}`,
  };
});

const getJson = (path: string) =>
  HttpClient.get(`${baseUrl}${path}`).pipe(
    Effect.flatMap((response) =>
      response.status >= 500
        ? Effect.fail(new Error(`transient upstream ${response.status}`))
        : Effect.succeed(response),
    ),
    Effect.retry({
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(6),
      ]),
    }),
    Effect.flatMap((r) => r.json),
  );

describe.sequential("DocDBElastic Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "DocDBElastic test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("DocDBElastic test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* DocDBElasticTestFunction;
        }).pipe(Effect.provide(DocDBElasticTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      const readinessUrl = `${baseUrl}/bindings`;
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 120_000 });

  describe("binding registration", () => {
    test.provider("all eight capabilities initialize in the runtime", () =>
      Effect.gen(function* () {
        const response = yield* getJson("/bindings");
        expect((response as any).bound).toHaveLength(8);
      }),
    );
  });

  describe("ListClusterSnapshots", () => {
    test.provider("lists the account's snapshots", () =>
      Effect.gen(function* () {
        const response = yield* getJson("/snapshots");
        expect((response as any).count).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  describe("ListPendingMaintenanceActions", () => {
    test.provider("lists the account's pending maintenance", () =>
      Effect.gen(function* () {
        const response = yield* getJson("/maintenance");
        expect((response as any).count).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  describe("GetClusterSnapshot", () => {
    test.provider("surfaces the typed not-found tag", () =>
      Effect.gen(function* () {
        const arns = yield* probeArns;
        const response = yield* getJson(
          `/snapshot-probe?arn=${encodeURIComponent(arns.snapshot)}`,
        );
        expect((response as any).tag).toBe("ResourceNotFoundException");
      }),
    );
  });

  describe("DeleteClusterSnapshot", () => {
    test.provider("surfaces the typed not-found tag", () =>
      Effect.gen(function* () {
        const arns = yield* probeArns;
        const response = yield* getJson(
          `/delete-probe?arn=${encodeURIComponent(arns.snapshot)}`,
        );
        expect((response as any).tag).toBe("ResourceNotFoundException");
      }),
    );
  });

  describe("CopyClusterSnapshot", () => {
    test.provider(
      "rejects a nonexistent source snapshot with a typed tag",
      () =>
        Effect.gen(function* () {
          const arns = yield* probeArns;
          const response = yield* getJson(
            `/copy-probe?arn=${encodeURIComponent(arns.snapshot)}`,
          );
          // Copy authorizes against the source-snapshot resource; a
          // nonexistent snapshot is reported as AccessDeniedException
          // (existence non-disclosure) rather than not-found.
          expect([
            "ResourceNotFoundException",
            "ValidationException",
            "AccessDeniedException",
          ]).toContain((response as any).tag);
        }),
    );
  });

  describe("RestoreClusterFromSnapshot", () => {
    test.provider(
      "rejects a nonexistent source snapshot with a typed tag",
      () =>
        Effect.gen(function* () {
          const arns = yield* probeArns;
          const response = yield* getJson(
            `/restore-probe?arn=${encodeURIComponent(arns.snapshot)}`,
          );
          // Restore authorizes against the source-snapshot resource; a
          // nonexistent snapshot is reported as AccessDeniedException
          // (existence non-disclosure) rather than not-found.
          expect([
            "ResourceNotFoundException",
            "ValidationException",
            "AccessDeniedException",
          ]).toContain((response as any).tag);
        }),
    );
  });

  describe("GetPendingMaintenanceAction", () => {
    test.provider("surfaces a typed tag for a nonexistent cluster", () =>
      Effect.gen(function* () {
        const arns = yield* probeArns;
        const response = yield* getJson(
          `/pending-probe?arn=${encodeURIComponent(arns.cluster)}`,
        );
        expect(["ResourceNotFoundException", "ValidationException"]).toContain(
          (response as any).tag,
        );
      }),
    );
  });

  describe("ApplyPendingMaintenanceAction", () => {
    test.provider("surfaces a typed tag for a nonexistent cluster", () =>
      Effect.gen(function* () {
        const arns = yield* probeArns;
        const response = yield* getJson(
          `/apply-probe?arn=${encodeURIComponent(arns.cluster)}`,
        );
        expect(["ResourceNotFoundException", "ValidationException"]).toContain(
          (response as any).tag,
        );
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Cluster-scoped bindings (CreateClusterSnapshot, StopCluster, StartCluster)
// need a real elastic cluster (~10 min to provision, billed per
// shard-vCPU-hour) — gated behind AWS_TEST_SLOW=1 like the Cluster lifecycle
// test.
// ---------------------------------------------------------------------------

const slowStack = Core.scratchStack(testOptions, "DocDBElasticSlowBindings");

const SLOW_SNAPSHOT_NAME = "alchemy-docdb-elastic-bindings-snap";

// Resolve two default-for-AZ subnets from the region's first three AZs
// (elastic clusters are not offered in every AZ, e.g. us-west-2d) and the
// default security group — same selection as Cluster.test.ts.
const defaultNetwork = Effect.gen(function* () {
  const vpc = yield* getDefaultVpc;
  const subnets = yield* EC2.describeSubnets({
    Filters: [
      { Name: "vpc-id", Values: [vpc.vpcId] },
      { Name: "default-for-az", Values: ["true"] },
    ],
  });
  const subnetIds = (subnets.Subnets ?? [])
    .filter((s) => /[abc]$/.test(s.AvailabilityZone ?? ""))
    .sort((l, r) =>
      (l.AvailabilityZone ?? "").localeCompare(r.AvailabilityZone ?? ""),
    )
    .map((s) => s.SubnetId)
    .filter((id): id is `subnet-${string}` => id !== undefined)
    .slice(0, 2);
  const groups = yield* EC2.describeSecurityGroups({
    Filters: [
      { Name: "vpc-id", Values: [vpc.vpcId] },
      { Name: "group-name", Values: ["default"] },
    ],
  });
  const securityGroupId = groups.SecurityGroups?.[0]?.GroupId;
  if (subnetIds.length < 2 || securityGroupId === undefined) {
    return yield* Effect.die(
      new Error("default VPC is missing subnets or its default security group"),
    );
  }
  return { subnetIds, securityGroupIds: [securityGroupId] };
});

// The snapshot the gated test creates is cleaned up out-of-band; deletion of
// a snapshot still CREATING conflicts, so retry (bounded) while it settles.
const deleteSnapshot = (snapshotArn: string) =>
  docdbelastic.deleteClusterSnapshot({ snapshotArn }).pipe(
    Effect.asVoid,
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
    Effect.retry({
      while: (e): boolean => e._tag === "ConflictException",
      schedule: Schedule.max([
        Schedule.fixed("15 seconds"),
        Schedule.recurs(40),
      ]),
    }),
  );

test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
  "snapshot + stop + start bindings against a live elastic cluster",
  () =>
    Effect.gen(function* () {
      yield* slowStack.destroy();
      const network = yield* defaultNetwork;
      yield* Effect.sync(() => {
        process.env[SUBNETS_ENV] = JSON.stringify(network.subnetIds);
        process.env[SECURITY_GROUPS_ENV] = JSON.stringify(
          network.securityGroupIds,
        );
      });

      let snapshotArn: string | undefined;

      yield* Effect.gen(function* () {
        const { functionUrl } = yield* slowStack.deploy(
          Effect.gen(function* () {
            return yield* DocDBElasticSlowTestFunction;
          }).pipe(Effect.provide(DocDBElasticSlowTestFunctionLive)),
        );
        expect(functionUrl).toBeTruthy();
        const slowBaseUrl = functionUrl!.replace(/\/+$/, "");

        const get = (path: string) =>
          HttpClient.get(`${slowBaseUrl}${path}`).pipe(
            Effect.retry({
              schedule: Schedule.max([
                Schedule.exponential("500 millis"),
                Schedule.recurs(10),
              ]),
            }),
            Effect.flatMap((r) => r.json),
          );

        // Take an on-demand snapshot of the live cluster.
        const snapshot = (yield* get(
          `/snapshot?name=${SLOW_SNAPSHOT_NAME}`,
        )) as { snapshotArn: string; status: string };
        expect(snapshot.snapshotArn).toContain(":cluster-snapshot/");
        snapshotArn = snapshot.snapshotArn;

        // Wait (bounded) for the snapshot to become AVAILABLE so the stop
        // call below does not conflict with the in-flight snapshot.
        yield* docdbelastic
          .getClusterSnapshot({ snapshotArn: snapshot.snapshotArn })
          .pipe(
            Effect.map((r) => r.snapshot.status),
            Effect.repeat({
              schedule: Schedule.spaced("10 seconds"),
              until: (status): boolean => status === "AVAILABLE",
              times: 60,
            }),
          );

        // Stop the cluster (compute billing pauses).
        const stop = (yield* get("/stop")) as { status: string };
        expect(["STOPPING", "STOPPED"]).toContain(stop.status);

        // Starting while STOPPING surfaces a typed rejection; a fully
        // stopped cluster reports STARTING. Both prove the grant.
        const start = (yield* get("/start")) as { status: string };
        expect(["STARTING", "ValidationException"]).toContain(start.status);
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* slowStack.destroy();
            if (snapshotArn !== undefined) {
              yield* deleteSnapshot(snapshotArn);
            }
          }).pipe(Effect.orDie),
        ),
      );
    }),
  // cluster create (~10 min) + snapshot + stop + destroy in one test.
  { timeout: 2_400_000 },
);
