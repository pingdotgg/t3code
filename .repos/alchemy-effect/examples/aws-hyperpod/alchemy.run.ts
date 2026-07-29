/**
 * A minimal SageMaker HyperPod training cluster:
 *
 * - a lifecycle-script bucket + instance execution role (`src/infra.ts`),
 * - a deploy-time Action that uploads `on_create.sh` to the bucket
 *   (`src/lifecycle.ts`) — bucket → script → cluster ordering is inferred
 *   from the data flow,
 * - a Slurm-orchestrated `AWS.SageMaker.Cluster` with one instance group.
 *
 * The demo instance group is a single ml.t3.medium to keep the example
 * cheap; swap in ml.g5/ml.p5 groups (and more of them) for real training.
 * Provisioning takes ~5 minutes at this size, 10-25 minutes for large GPU
 * groups.
 */
import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";
import { HyperPodInfra } from "./src/infra.ts";
import { UploadLifecycleScript } from "./src/lifecycle.ts";

export default Alchemy.Stack(
  "AwsHyperPodExample",
  {
    providers: AWS.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const { bucket, role } = yield* HyperPodInfra;

    // Upload the on_create script; the Action's output feeds the cluster's
    // LifeCycleConfig, so the script is in place before the cluster exists.
    const script = yield* UploadLifecycleScript({
      bucketName: bucket.bucketName,
    });

    const cluster = yield* AWS.SageMaker.Cluster("TrainingCluster", {
      instanceGroups: {
        controller: {
          InstanceType: "ml.t3.medium",
          InstanceCount: 1,
          ExecutionRole: role.roleArn,
          LifeCycleConfig: {
            SourceS3Uri: script.sourceS3Uri,
            OnCreate: script.onCreate,
          },
        },
      },
      // Automatic recovery replaces faulty nodes; "None" is fine for a demo
      // controller group and avoids replacement churn on tiny instances.
      nodeRecovery: "None",
      tags: { app: "aws-hyperpod-example" },
    });

    return {
      clusterName: cluster.clusterName,
      clusterArn: cluster.clusterArn,
      clusterStatus: cluster.clusterStatus,
      lifecycleBucket: bucket.bucketName,
    };
  }),
);
