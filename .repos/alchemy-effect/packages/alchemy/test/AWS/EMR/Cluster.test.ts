import * as AWS from "@/AWS";
import { Cluster } from "@/AWS/EMR/Cluster.ts";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as EC2 from "@distilled.cloud/aws/ec2";
import * as emr from "@distilled.cloud/aws/emr";
import { expect } from "alchemy-test";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { getDefaultVpc } from "../DefaultVpc.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probes: prove the distilled emr error union carries the
// not-found tags this provider's read/reconcile/delete paths depend on.
// DescribeCluster surfaces a missing cluster as InvalidRequestException
// ("Cluster id 'j-…' is not valid.") → synthetic ClusterNotFound, and
// TerminateJobFlows as ValidationException ("Specified job flow ID not
// valid.") → synthetic JobFlowNotFound.
test.provider(
  "describeCluster on a nonexistent id fails with ClusterNotFound",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        emr.describeCluster({ ClusterId: "j-1K48XAOQ4XHCB" }),
      );
      expect(error._tag).toBe("ClusterNotFound");
    }),
);

test.provider(
  "terminateJobFlows on a nonexistent id fails with JobFlowNotFound",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        emr.terminateJobFlows({ JobFlowIds: ["j-1K48XAOQ4XHCB"] }),
      );
      expect(error._tag).toBe("JobFlowNotFound");
    }),
);

// Resolve a subnet of the account's default VPC (public subnet — EMR
// clusters launch fine there and the factory never creates NAT gateways).
const resolveSubnet = Effect.gen(function* () {
  const vpc = yield* getDefaultVpc;
  const subnets = yield* EC2.describeSubnets({
    Filters: [
      { Name: "vpc-id", Values: [vpc.vpcId] },
      { Name: "default-for-az", Values: ["true"] },
    ],
  });
  const subnetId = (subnets.Subnets ?? []).flatMap((s) =>
    s.SubnetId ? [s.SubnetId] : [],
  )[0];
  return { subnetId };
});

// A provisioned EMR cluster takes ~10-15 minutes to reach WAITING, bills per
// instance-hour for 3 m5.xlarge-class instances while it exists, and takes
// ~5-10 more minutes to terminate. The full lifecycle is gated behind
// AWS_TEST_SLOW=1 and always destroys what it created.
test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
  "create Spark cluster, verify WAITING, update in place, destroy, verify terminating",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { subnetId } = yield* resolveSubnet;
      expect(subnetId).toBeDefined();

      const deploy = (props: {
        stepConcurrencyLevel?: number;
        idleTimeoutSeconds?: number;
      }) =>
        stack.deploy(
          Effect.gen(function* () {
            const logs = yield* AWS.S3.Bucket("EmrLogs", {
              forceDestroy: true,
            });
            // EMR service role (legacy managed policy — the v2 policy
            // requires tag-scoped resources).
            const serviceRole = yield* AWS.IAM.Role("EmrServiceRole", {
              assumeRolePolicyDocument: {
                Version: "2012-10-17",
                Statement: [
                  {
                    Effect: "Allow",
                    Principal: { Service: ["elasticmapreduce.amazonaws.com"] },
                    Action: ["sts:AssumeRole"],
                  },
                ],
              },
              managedPolicyArns: [
                "arn:aws:iam::aws:policy/service-role/AmazonElasticMapReduceRole",
              ],
            });
            // EC2 instance role + profile (the job-flow role).
            const ec2Role = yield* AWS.IAM.Role("EmrEc2Role", {
              assumeRolePolicyDocument: {
                Version: "2012-10-17",
                Statement: [
                  {
                    Effect: "Allow",
                    Principal: { Service: ["ec2.amazonaws.com"] },
                    Action: ["sts:AssumeRole"],
                  },
                ],
              },
              managedPolicyArns: [
                "arn:aws:iam::aws:policy/service-role/AmazonElasticMapReduceforEC2Role",
              ],
            });
            const instanceProfile = yield* AWS.IAM.InstanceProfile(
              "EmrEc2Profile",
              { roleName: ec2Role.roleName },
            );
            const cluster = yield* Cluster("Spark", {
              releaseLabel: "emr-7.5.0",
              applications: ["Spark", "Hadoop"],
              serviceRole: serviceRole.roleName,
              jobFlowRole: instanceProfile.instanceProfileName,
              logUri: Output.interpolate`s3://${logs.bucketName}/logs/`,
              instances: {
                masterInstanceType: "m5.xlarge",
                coreInstanceType: "m5.xlarge",
                coreInstanceCount: 1,
                ec2SubnetId: subnetId,
                keepJobFlowAliveWhenNoSteps: true,
              },
              stepConcurrencyLevel: props.stepConcurrencyLevel,
              autoTerminationPolicy: props.idleTimeoutSeconds
                ? {
                    idleTimeout: Duration.seconds(props.idleTimeoutSeconds),
                  }
                : undefined,
              tags: { fixture: "emr-cluster" },
            });
            return { cluster };
          }),
        );

      // Create — reconcile waits (bounded) for WAITING/RUNNING.
      const { cluster } = yield* deploy({ idleTimeoutSeconds: 3600 });
      expect(cluster.clusterId).toMatch(/^j-/);
      expect(cluster.clusterArn).toContain(":cluster/");
      expect(["WAITING", "RUNNING"]).toContain(cluster.state);

      // Out-of-band verification via distilled.
      const created = yield* emr.describeCluster({
        ClusterId: cluster.clusterId,
      });
      expect(created.Cluster?.ReleaseLabel).toBe("emr-7.5.0");
      expect(
        (created.Cluster?.Applications ?? []).map((a) => a.Name).sort(),
      ).toEqual(["Hadoop", "Spark"]);
      const tags = Object.fromEntries(
        (created.Cluster?.Tags ?? []).map((t) => [t.Key, t.Value]),
      );
      expect(tags.fixture).toBe("emr-cluster");
      const policy = yield* emr.getAutoTerminationPolicy({
        ClusterId: cluster.clusterId,
      });
      expect(policy.AutoTerminationPolicy?.IdleTimeout).toBe(3600);

      // Update in place — step concurrency and auto-termination policy sync
      // without replacement.
      const { cluster: updated } = yield* deploy({
        stepConcurrencyLevel: 4,
        idleTimeoutSeconds: 7200,
      });
      expect(updated.clusterId).toBe(cluster.clusterId);
      const afterUpdate = yield* emr.describeCluster({
        ClusterId: cluster.clusterId,
      });
      expect(afterUpdate.Cluster?.StepConcurrencyLevel).toBe(4);
      const updatedPolicy = yield* emr.getAutoTerminationPolicy({
        ClusterId: cluster.clusterId,
      });
      expect(updatedPolicy.AutoTerminationPolicy?.IdleTimeout).toBe(7200);

      // Destroy — the provider initiates termination (irreversible) and
      // waits for the cluster to leave the active states.
      yield* stack.destroy();
      yield* assertClusterTerminating(cluster.clusterId);
    }),
  // create (~10-15 min) + update + termination initiation, one test.
  { timeout: 2_700_000 },
);

// Termination is verified as INITIATED (TERMINATING, irreversible) or fully
// TERMINATED; full instance teardown takes ~5-10 more minutes server-side.
const assertClusterTerminating = (clusterId: string) =>
  Effect.gen(function* () {
    const state = yield* emr.describeCluster({ ClusterId: clusterId }).pipe(
      Effect.map((r) => r.Cluster?.Status?.State ?? "gone"),
      Effect.catchTag("ClusterNotFound", () => Effect.succeed("gone" as const)),
    );
    if (
      state !== "gone" &&
      state !== "TERMINATING" &&
      state !== "TERMINATED" &&
      state !== "TERMINATED_WITH_ERRORS"
    ) {
      return yield* Effect.fail(
        new Error(`EMR cluster '${clusterId}' still active (state: ${state})`),
      );
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([
        Schedule.fixed("10 seconds"),
        Schedule.recurs(20),
      ]),
    }),
  );
