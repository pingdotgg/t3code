import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as kafka from "@distilled.cloud/gcp/managedkafka_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";
import { withKafkaClusterSlot } from "./quota.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Kafka and Connect clusters take ~30 minutes to provision.
const runLifecycle = !!process.env.GCP_TEST_SLOW && !process.env.FAST;

const waitUntilGone = (name: string) =>
  kafka.getProjectsLocationsClustersAcls({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsClustersAcls on a missing acl fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        kafka.getProjectsLocationsClustersAcls({
          name: `projects/${project}/locations/us-central1/clusters/alchemy-missing/acls/cluster`,
        }),
      );
      // GCP has answered a missing parent cluster with both 404 NOT_FOUND
      // and 400 FAILED_PRECONDITION "cluster must exist"
      // (AclClusterNotFound); both are typed.
      expect(["NotFound", "AclClusterNotFound"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:managedkafka", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a kafka acl",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const cluster = yield* GCP.ManagedKafka.Cluster("Brokers", {
            location: "us-central1",
            labels: { env: "test" },
          });
          const acl = yield* GCP.ManagedKafka.ClustersAcl("OrdersAcl", {
            cluster: cluster.name,
            aclId: "topic/orders",
            aclEntries: [
              {
                principal: "User:*",
                operation: "DESCRIBE",
                permissionType: "ALLOW",
                host: "*",
              },
            ],
          });
          return { cluster, acl };
        }),
      );

      expect(created.acl.name).toContain("/acls/");
      expect(created.acl.aclId).toEqual("topic/orders");
      expect(created.acl.aclEntries.length).toBeGreaterThan(0);

      const fetched = yield* kafka.getProjectsLocationsClustersAcls({
        name: created.acl.name,
      });
      expect(fetched.name).toEqual(created.acl.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const cluster = yield* GCP.ManagedKafka.Cluster("Brokers", {
            clusterId: created.cluster.clusterId,
            location: "us-central1",
            labels: { env: "test" },
          });
          const acl = yield* GCP.ManagedKafka.ClustersAcl("OrdersAcl", {
            cluster: cluster.name,
            aclId: "topic/orders",
            aclEntries: [
              {
                principal: "User:*",
                operation: "READ",
                permissionType: "ALLOW",
                host: "*",
              },
            ],
          });
          return { cluster, acl };
        }),
      );
      expect(updated.acl.aclId).toEqual("topic/orders");
      expect(
        updated.acl.aclEntries.some(
          (entry) => (entry.operation ?? "").toUpperCase() === "READ",
        ),
      ).toEqual(true);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.acl.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel, withKafkaClusterSlot),
  {
    tags: ["provider:gcp", "provider:gcp:managedkafka", "live"],
    timeout: 10_800_000,
    retry: 0,
  },
);
