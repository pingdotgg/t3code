import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";
import { HyperPodEksInfra } from "./eks-infra.ts";

/**
 * The HIGH-LEVEL tier: an effectful `AWS.EKS.Job` running ON HyperPod
 * nodes. The Effect program is bundled into a generated image
 * (`main: import.meta.url`), and the `hyperpod` prop pins it to the
 * `workers` instance group on health-checked nodes and submits it through
 * task governance under the research team's quota — the namespace, Kueue
 * labels, and node selector all derive from the props.
 *
 * Swap `run` for a real training/eval harness; bindings (DynamoDB, S3, SQS,
 * ...) resolve in init and land IAM on the pod-identity role, exactly like
 * any other EKS Job.
 */
export default AWS.EKS.Job(
  "TrainJob",
  Effect.gen(function* () {
    const { eks, hyperpod, researchQuota } = yield* HyperPodEksInfra;
    return {
      cluster: eks,
      main: import.meta.url,
      hyperpod: {
        // Referenced through the cluster's attributes, so the job is
        // connected to the HyperPod cluster through the resource graph.
        instanceGroup: hyperpod.instanceGroups.workers,
        quota: researchQuota,
        priorityClass: "training",
      },
      backoffLimit: 2,
    };
  }),
  Effect.gen(function* () {
    return {
      run: Effect.gen(function* () {
        yield* Effect.log("training step running on a HyperPod node");
      }),
    };
  }),
);
