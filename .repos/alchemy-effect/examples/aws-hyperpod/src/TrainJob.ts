import * as AWS from "alchemy/AWS";
import * as Kubernetes from "alchemy/Kubernetes";
import * as Effect from "effect/Effect";
import { HyperPodEksInfra } from "./eks-infra.ts";

/**
 * The HIGH-LEVEL tier: an effectful `Kubernetes.Job` running ON HyperPod
 * nodes, written in plain Kubernetes vocabulary. The Effect program is
 * bundled into a generated image (`main: import.meta.url`), and the
 * HyperPod resources expose everything the job needs as attributes
 * referenced through the resource graph:
 *
 * - `quota.namespace` — the governed `hyperpod-ns-<team>` namespace,
 * - `quota.queueName` — the team's Kueue LocalQueue, set under the
 *   well-known `KUEUE_QUEUE_NAME_LABEL`,
 * - `instanceGroups.workers.nodeSelector` — health-checked nodes of the
 *   `workers` group (typed per key; a typo'd group name is a compile
 *   error).
 *
 * Swap `run` for a real training/eval harness; bindings (DynamoDB, S3, SQS,
 * ...) resolve in init and land IAM on the pod-identity role, exactly like
 * any other Kubernetes Job on EKS.
 */
export default Kubernetes.Job(
  "TrainJob",
  Effect.gen(function* () {
    const { eks, hyperpod, researchQuota } = yield* HyperPodEksInfra;
    return {
      cluster: eks,
      main: import.meta.url,
      namespace: researchQuota.namespace,
      labels: {
        [AWS.SageMaker.KUEUE_QUEUE_NAME_LABEL]: researchQuota.queueName,
        [AWS.SageMaker.KUEUE_PRIORITY_CLASS_LABEL]: "training-priority",
      },
      podTemplate: {
        spec: {
          nodeSelector: hyperpod.instanceGroups.workers.nodeSelector,
        },
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
