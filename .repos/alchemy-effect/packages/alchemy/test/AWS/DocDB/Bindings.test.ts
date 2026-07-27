import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as EC2 from "@distilled.cloud/aws/ec2";
import { Region } from "@distilled.cloud/aws/Region";
import * as sts from "@distilled.cloud/aws/sts";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { getDefaultVpc } from "../DefaultVpc.ts";

import DocDBTestFunctionLive, { DocDBTestFunction } from "./handler";
import DocDBSlowTestFunctionLive, {
  DocDBSlowTestFunction,
} from "./slow-handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "DocDBBindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;

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

describe.sequential("DocDB Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo("DocDB test setup: destroying previous resources");
      yield* sharedStack.destroy();

      yield* Effect.logInfo("DocDB test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* DocDBTestFunction;
        }).pipe(Effect.provide(DocDBTestFunctionLive)),
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
    test.provider("all capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        const response = yield* getJson("/bindings");
        expect((response as any).bound).toHaveLength(8);
      }),
    );
  });

  describe("DescribeDBClusters", () => {
    test.provider(
      "surfaces the typed not-found tag for a nonexistent cluster",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* getJson("/clusters");
          expect((response as any).tag).toBe("DBClusterNotFoundFault");
        }),
    );
  });

  describe("DescribeEvents", () => {
    test.provider("lists the account's recent DocumentDB events", (_stack) =>
      Effect.gen(function* () {
        const response = yield* getJson("/events");
        expect((response as any).count).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  describe("DescribeDBInstances", () => {
    test.provider(
      "surfaces the typed not-found tag for a nonexistent instance",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* getJson("/instances");
          expect((response as any).tag).toBe("DBInstanceNotFoundFault");
        }),
    );
  });

  describe("DescribeDBClusterSnapshots", () => {
    test.provider("lists the account's cluster snapshots", (_stack) =>
      Effect.gen(function* () {
        const response = yield* getJson("/snapshots");
        expect((response as any).count).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  describe("DeleteDBClusterSnapshot", () => {
    test.provider(
      "surfaces the typed not-found tag for a nonexistent snapshot",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* getJson("/delete-snapshot-probe");
          expect((response as any).tag).toBe("DBClusterSnapshotNotFoundFault");
        }),
    );
  });

  describe("CopyDBClusterSnapshot", () => {
    test.provider(
      "surfaces the typed not-found tag for a nonexistent source snapshot",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* getJson("/copy-snapshot-probe");
          expect((response as any).tag).toBe("DBClusterSnapshotNotFoundFault");
        }),
    );
  });

  describe("DescribePendingMaintenanceActions", () => {
    test.provider("lists the account's pending maintenance actions", (_stack) =>
      Effect.gen(function* () {
        const response = yield* getJson("/pending-maintenance");
        expect((response as any).count).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  describe("ApplyPendingMaintenanceAction", () => {
    test.provider(
      "surfaces the typed not-found tag for a nonexistent resource ARN",
      (_stack) =>
        Effect.gen(function* () {
          // Build a well-formed cluster ARN in this account/region that
          // cannot exist — the apply call must decode ResourceNotFoundFault.
          // (`Region`'s service value is itself an Effect — resolve twice.)
          const region = yield* yield* Region;
          const identity = yield* sts.getCallerIdentity({});
          const arn = `arn:aws:rds:${region}:${identity.Account}:cluster:alchemy-nonexistent-docdb-probe`;
          const response = yield* getJson(
            `/apply-probe?arn=${encodeURIComponent(arn)}`,
          );
          expect((response as any).tag).toBe("ResourceNotFoundFault");
        }),
    );
  });
});

// ---------------------------------------------------------------------------
// Data-plane binding (Connect + mongo) needs a real DocumentDB cluster +
// instance (~15 min to provision, billed per instance-hour) and a Secrets
// Manager VPC interface endpoint (the VPC-attached Lambda has no internet
// path) — gated behind AWS_TEST_SLOW=1 like the DBCluster lifecycle test.
// ---------------------------------------------------------------------------

const slowStack = Core.scratchStack(testOptions, "DocDBSlowBindings");

// Resolve two default-for-AZ subnets and the default security group. The
// default security group allows all traffic from itself, so the Lambda, the
// cluster, and the endpoint can all share it.
const defaultNetwork = Effect.gen(function* () {
  const vpc = yield* getDefaultVpc;
  const subnets = yield* EC2.describeSubnets({
    Filters: [
      { Name: "vpc-id", Values: [vpc.vpcId] },
      { Name: "default-for-az", Values: ["true"] },
    ],
  });
  const subnetIds = (subnets.Subnets ?? [])
    .map((s) => s.SubnetId)
    .filter((id): id is `subnet-${string}` => id !== undefined)
    .sort()
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
  return { vpcId: vpc.vpcId, subnetIds, securityGroupIds: [securityGroupId] };
});

// The VPC-attached Lambda resolves the master secret through a Secrets
// Manager interface endpoint. Managed out-of-band (create-if-missing, keep
// across runs — recreating interface endpoints costs ~2 min per run).
const ensureSecretsManagerEndpoint = (network: {
  vpcId: string;
  subnetIds: string[];
  securityGroupIds: string[];
}) =>
  Effect.gen(function* () {
    // `Region`'s service value is itself an Effect — resolve twice.
    const region = yield* yield* Region;
    const serviceName = `com.amazonaws.${region}.secretsmanager`;
    const existing = yield* EC2.describeVpcEndpoints({
      Filters: [
        { Name: "vpc-id", Values: [network.vpcId] },
        { Name: "service-name", Values: [serviceName] },
      ],
    });
    if ((existing.VpcEndpoints ?? []).length > 0) return;
    yield* EC2.createVpcEndpoint({
      VpcId: network.vpcId as `vpc-${string}`,
      ServiceName: serviceName,
      VpcEndpointType: "Interface",
      SubnetIds: network.subnetIds as `subnet-${string}`[],
      SecurityGroupIds: network.securityGroupIds as `sg-${string}`[],
      PrivateDnsEnabled: true,
      TagSpecifications: [
        {
          ResourceType: "vpc-endpoint",
          Tags: [{ Key: "alchemy-test", Value: "docdb-bindings" }],
        },
      ],
    });
    // Bounded readiness wait for the endpoint's private DNS to serve.
    yield* EC2.describeVpcEndpoints({
      Filters: [
        { Name: "vpc-id", Values: [network.vpcId] },
        { Name: "service-name", Values: [serviceName] },
      ],
    }).pipe(
      Effect.flatMap((r) =>
        r.VpcEndpoints?.[0]?.State === "available"
          ? Effect.void
          : Effect.fail(new Error("secretsmanager endpoint not available")),
      ),
      Effect.retry({
        schedule: Schedule.max([
          Schedule.fixed("10 seconds"),
          Schedule.recurs(24),
        ]),
      }),
    );
  });

test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
  "connect + mongo data plane against a live cluster",
  () =>
    Effect.gen(function* () {
      yield* slowStack.destroy();
      const network = yield* defaultNetwork;
      yield* ensureSecretsManagerEndpoint(network);

      // The fixture's init Effect runs in this process — pass the resolved
      // network through env (the module cannot look it up itself).
      yield* Effect.sync(() => {
        process.env.DOCDB_TEST_SUBNET_IDS = network.subnetIds.join(",");
        process.env.DOCDB_TEST_SG_IDS = network.securityGroupIds.join(",");
      });

      yield* Effect.gen(function* () {
        const { functionUrl } = yield* slowStack.deploy(
          Effect.gen(function* () {
            return yield* DocDBSlowTestFunction;
          }).pipe(Effect.provide(DocDBSlowTestFunctionLive)),
        );
        expect(functionUrl).toBeTruthy();
        const slowBaseUrl = functionUrl!.replace(/\/+$/, "");

        const get = (path: string) =>
          HttpClient.get(`${slowBaseUrl}${path}`).pipe(
            Effect.retry({
              schedule: Schedule.max([
                Schedule.exponential("1 second"),
                Schedule.recurs(10),
              ]),
            }),
            Effect.flatMap((r) => r.json),
          );

        // Connection info resolves from the runtime attributes, the secret,
        // and the published environment variables.
        const info = (yield* get("/info")) as {
          host: string;
          port: number;
          database?: string;
          username?: string;
          tls: boolean;
          hasPassword: boolean;
          env: { host?: string; port?: string };
        };
        expect(info.host).toContain("docdb");
        expect(info.port).toBe(27017);
        expect(info.database).toBe("alchemy_test");
        expect(info.username).toBe("alchemy");
        expect(info.tls).toBe(true);
        expect(info.hasPassword).toBe(true);
        expect(info.env.host).toBe(info.host);
        expect(info.env.port).toBe(String(info.port));

        // The mongo Effect client opens a TLS socket, authenticates via the
        // managed master secret, and round-trips a document.
        const ping = (yield* get("/ping")) as { ok: number };
        expect(ping.ok).toBe(1);

        const crud = (yield* get("/crud?value=alchemy-docdb")) as {
          marker?: string;
        };
        expect(crud.marker).toBe("alchemy-docdb");
      }).pipe(Effect.ensuring(slowStack.destroy().pipe(Effect.orDie)));
    }),
  // cluster + instance create (~15 min) + probes + delete initiation.
  { timeout: 2_400_000 },
);
