import * as AWS from "@/AWS";
import { AWSEnvironment } from "@/AWS/Environment";
import * as Test from "@/Test/Alchemy";
import * as EC2 from "@distilled.cloud/aws/ec2";
import * as Kafka from "@distilled.cloud/aws/kafka";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { getDefaultVpc } from "../DefaultVpc.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: proves the distilled kafka error union carries the
// NotFoundException tag this provider's read/delete paths depend on. A
// well-formed but nonexistent cluster ARN returns NotFoundException.
test.provider(
  "describeClusterV2 on a nonexistent cluster fails with NotFoundException",
  () =>
    Effect.gen(function* () {
      const { accountId, region } = yield* AWSEnvironment.current;
      const error = yield* Effect.flip(
        Kafka.describeClusterV2({
          ClusterArn: `arn:aws:kafka:${region}:${accountId}:cluster/alchemy-nonexistent-probe/00000000-0000-0000-0000-000000000000-1`,
        }),
      );
      expect(error._tag).toBe("NotFoundException");
    }),
);

const nonexistentClusterArn = Effect.gen(function* () {
  const { accountId, region } = yield* AWSEnvironment.current;
  return `arn:aws:kafka:${region}:${accountId}:cluster/alchemy-nonexistent-probe/00000000-0000-0000-0000-000000000000-1`;
});

// Ungated typed-error probes for the operations behind the runtime bindings
// (GetBootstrapBrokers + the topic control plane). Each proves the distilled
// error union carries the tag a caller must handle for a missing cluster.
test.provider(
  "getBootstrapBrokers on a nonexistent cluster fails with a typed tag",
  () =>
    Effect.gen(function* () {
      const ClusterArn = yield* nonexistentClusterArn;
      const error = yield* Effect.flip(
        Kafka.getBootstrapBrokers({ ClusterArn }),
      );
      expect(error._tag).toBe("NotFoundException");
    }),
);

test.provider(
  "listTopics on a nonexistent cluster fails with a typed tag",
  () =>
    Effect.gen(function* () {
      const ClusterArn = yield* nonexistentClusterArn;
      const error = yield* Effect.flip(Kafka.listTopics({ ClusterArn }));
      expect(error._tag).toBe("NotFoundException");
    }),
);

test.provider(
  "describeTopic on a nonexistent cluster fails with a typed tag",
  () =>
    Effect.gen(function* () {
      const ClusterArn = yield* nonexistentClusterArn;
      const error = yield* Effect.flip(
        Kafka.describeTopic({ ClusterArn, TopicName: "alchemy-probe" }),
      );
      expect(error._tag).toBe("NotFoundException");
    }),
);

test.provider(
  "createTopic on a nonexistent cluster fails with a typed tag",
  () =>
    Effect.gen(function* () {
      const ClusterArn = yield* nonexistentClusterArn;
      const error = yield* Effect.flip(
        Kafka.createTopic({
          ClusterArn,
          TopicName: "alchemy-probe",
          PartitionCount: 1,
        }),
      );
      // The topic control plane validates the request body before resolving
      // the cluster, so a nonexistent cluster surfaces the typed 400.
      expect(error._tag).toBe("BadRequestException");
    }),
);

// Resolve two default-for-AZ subnets from the account's default VPC — MSK
// requires at least two subnets in distinct Availability Zones.
const resolveSubnets = Effect.gen(function* () {
  const vpc = yield* getDefaultVpc;
  const subnets = yield* EC2.describeSubnets({
    Filters: [
      { Name: "vpc-id", Values: [vpc.vpcId] },
      { Name: "default-for-az", Values: ["true"] },
    ],
  });
  const byAz = new Map<string, string>();
  for (const s of subnets.Subnets ?? []) {
    if (s.AvailabilityZone && s.SubnetId && !byAz.has(s.AvailabilityZone)) {
      byAz.set(s.AvailabilityZone, s.SubnetId);
    }
  }
  return [...byAz.values()].slice(0, 3);
});

// MSK Serverless clusters take ~5-10 minutes to create and are metered while
// they exist. The full lifecycle is gated behind AWS_TEST_SLOW=1 and always
// destroys what it created.
test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
  "create serverless cluster, verify IAM-auth brokers, destroy, verify gone",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const subnetIds = yield* resolveSubnets;
      expect(subnetIds.length).toBeGreaterThanOrEqual(2);

      const { cluster } = yield* stack.deploy(
        Effect.gen(function* () {
          const cluster = yield* AWS.Kafka.ServerlessCluster("Events", {
            subnetIds,
            tags: { fixture: "kafka-serverless" },
          });
          return { cluster };
        }),
      );

      expect(cluster.clusterName).toBeDefined();
      expect(cluster.clusterArn).toContain(":cluster/");
      expect(cluster.clusterType).toBe("SERVERLESS");
      expect(cluster.state).toBe("ACTIVE");
      // Serverless clusters only expose the SASL/IAM bootstrap endpoint.
      expect(cluster.bootstrapBrokerStringSaslIam).toBeDefined();
      expect(cluster.bootstrapBrokerStringSaslIam).toContain(":9098");

      // Out-of-band verification via distilled.
      const described = yield* Kafka.describeClusterV2({
        ClusterArn: cluster.clusterArn,
      });
      const info = described.ClusterInfo;
      expect(info?.State).toBe("ACTIVE");
      expect(info?.ClusterType).toBe("SERVERLESS");
      expect(info?.Serverless?.ClientAuthentication?.Sasl?.Iam?.Enabled).toBe(
        true,
      );

      yield* stack.destroy();
      yield* assertClusterDeleted(cluster.clusterArn);
    }),
  // create (~5-10 min) + destroy initiation, one test.
  { timeout: 1_200_000 },
);

// Deletion is verified as INITIATED (state DELETING, irreversible) or fully
// gone. Full disappearance takes several more minutes server-side.
const assertClusterDeleted = (arn: string) =>
  Effect.gen(function* () {
    const state = yield* Kafka.describeClusterV2({ ClusterArn: arn }).pipe(
      Effect.map((r) => r.ClusterInfo?.State ?? "gone"),
      Effect.catchTag("NotFoundException", () =>
        Effect.succeed("gone" as const),
      ),
    );
    if (state !== "gone" && state !== "DELETING") {
      return yield* Effect.fail(
        new Error(`MSK cluster '${arn}' still exists (state: ${state})`),
      );
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([
        Schedule.fixed("10 seconds"),
        Schedule.recurs(18),
      ]),
    }),
  );
