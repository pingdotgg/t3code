import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as dax from "@distilled.cloud/aws/dax";
import * as EC2 from "@distilled.cloud/aws/ec2";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { getDefaultVpc } from "../DefaultVpc.ts";

import DAXTestFunctionLive, { DAXTestFunction } from "./handler";
import DAXSlowTestFunctionLive, {
  DAXSlowTestFunction,
  SLOW_SUBNET_GROUP_NAME,
} from "./slow-handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "DAXBindings");

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

describe.sequential("DAX Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo("DAX test setup: destroying previous resources");
      yield* sharedStack.destroy();

      yield* Effect.logInfo("DAX test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* DAXTestFunction;
        }).pipe(Effect.provide(DAXTestFunctionLive)),
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
    test.provider("both capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        const response = yield* getJson("/bindings");
        expect((response as any).bound).toHaveLength(2);
      }),
    );
  });

  describe("DescribeClusters", () => {
    test.provider(
      "surfaces the typed not-found tag for a nonexistent cluster",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* getJson("/clusters");
          expect((response as any).tag).toBe("ClusterNotFoundFault");
        }),
    );
  });

  describe("DescribeEvents", () => {
    test.provider("lists the account's recent DAX events", (_stack) =>
      Effect.gen(function* () {
        const response = yield* getJson("/events");
        expect((response as any).count).toBeGreaterThanOrEqual(0);
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Cluster-scoped bindings (ConnectReadWrite, RebootNode) need a real DAX
// cluster (~10 min to provision, billed per node-hour) — gated behind
// AWS_TEST_SLOW=1 like the Cluster lifecycle test.
// ---------------------------------------------------------------------------

const slowStack = Core.scratchStack(testOptions, "DAXSlowBindings");

// Resolve two default-for-AZ subnets from the region's first three AZs (DAX
// is not offered in every AZ, e.g. us-west-2d).
const defaultSubnetIds = Effect.gen(function* () {
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
  if (subnetIds.length < 2) {
    return yield* Effect.die(new Error("default VPC is missing subnets"));
  }
  return subnetIds;
});

// The fixture module cannot look up subnet ids, so the subnet group is
// managed out-of-band under a deterministic name.
const ensureSubnetGroup = (subnetIds: string[]) =>
  dax
    .createSubnetGroup({
      SubnetGroupName: SLOW_SUBNET_GROUP_NAME,
      Description: "alchemy dax bindings test subnets",
      SubnetIds: subnetIds,
    })
    .pipe(Effect.catchTag("SubnetGroupAlreadyExistsFault", () => Effect.void));

// The subnet group is only deletable once the cluster is fully gone —
// deletion takes several minutes after destroy initiates it, so retry
// through SubnetGroupInUseFault (gated test: generous bounded budget).
const deleteSubnetGroup = dax
  .deleteSubnetGroup({ SubnetGroupName: SLOW_SUBNET_GROUP_NAME })
  .pipe(
    Effect.catchTag("SubnetGroupNotFoundFault", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "SubnetGroupInUseFault",
      schedule: Schedule.max([
        Schedule.fixed("15 seconds"),
        Schedule.recurs(60),
      ]),
    }),
  );

test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
  "connect + scaling + reboot-node bindings against a live cluster",
  () =>
    Effect.gen(function* () {
      yield* slowStack.destroy();
      const subnetIds = yield* defaultSubnetIds;
      yield* ensureSubnetGroup(subnetIds);

      yield* Effect.gen(function* () {
        const { functionUrl } = yield* slowStack.deploy(
          Effect.gen(function* () {
            return yield* DAXSlowTestFunction;
          }).pipe(Effect.provide(DAXSlowTestFunctionLive)),
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

        // Connection info resolves from both the runtime attributes and the
        // published environment variables.
        const connect = (yield* get("/connect")) as {
          info: { host: string; port: number; url: string; tls: boolean };
          env: { host?: string; port?: string; url?: string; tls?: string };
        };
        expect(connect.info.host).toBeTruthy();
        expect(connect.info.port).toBe(8111);
        expect(connect.info.url).toContain("dax://");
        expect(connect.info.tls).toBe(false);
        expect(connect.env.host).toBe(connect.info.host);
        expect(connect.env.port).toBe(String(connect.info.port));
        expect(connect.env.url).toBe(connect.info.url);
        expect(connect.env.tls).toBe("false");

        // Scaling bindings: invalid target factors reach service-side
        // validation and surface typed tags — proves the per-cluster IAM
        // grant and the ClusterName injection for both bindings.
        const scale = (yield* get("/scale-probe")) as {
          increaseTag: string;
          decreaseTag: string;
        };
        expect([
          "InvalidParameterValueException",
          "InvalidClusterStateFault",
        ]).toContain(scale.increaseTag);
        expect([
          "InvalidParameterValueException",
          "InvalidClusterStateFault",
        ]).toContain(scale.decreaseTag);

        // Reboot the cluster's only node and observe it transition.
        const nodes = (yield* get("/nodes")) as { nodeIds: string[] };
        expect(nodes.nodeIds.length).toBe(1);
        const reboot = (yield* get(`/reboot?nodeId=${nodes.nodeIds[0]}`)) as {
          nodeStatus?: string;
        };
        expect(reboot.nodeStatus).toBeDefined();
      }).pipe(
        Effect.ensuring(
          slowStack
            .destroy()
            .pipe(Effect.andThen(deleteSubnetGroup), Effect.orDie),
        ),
      );
    }),
  // cluster create (~10 min) + probes + delete (~10 min) in one test.
  { timeout: 2_400_000 },
);
