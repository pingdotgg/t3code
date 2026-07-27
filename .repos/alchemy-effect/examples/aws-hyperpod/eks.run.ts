/**
 * An EKS-orchestrated SageMaker HyperPod cluster with every DX tier:
 *
 * - `src/eks-infra.ts` — network → EKS control plane → HyperPod cluster →
 *   task governance (the amazon-sagemaker-hyperpod-taskgovernance add-on,
 *   an `AWS.SageMaker.ClusterSchedulerConfig` policy, and a team
 *   `AWS.SageMaker.ComputeQuota`),
 * - LOW LEVEL: a raw batch/v1 Job applied via `AWS.EKS.Manifest`, pinned
 *   to HyperPod nodes with the well-known node labels and submitted
 *   through task governance with the Kueue labels (below),
 * - HIGH LEVEL: `src/TrainJob.ts`, an effectful `AWS.EKS.Job` bundled from
 *   TypeScript and pinned + governed via the `hyperpod:` prop.
 *
 * Deploy with `bun alchemy deploy ./eks.run.ts`. The EKS control plane
 * takes ~10-15 minutes and the HyperPod cluster another ~10-20.
 */
import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { HyperPodEksInfra } from "./src/eks-infra.ts";
import TrainJob from "./src/TrainJob.ts";

export default Alchemy.Stack(
  "AwsHyperPodEksExample",
  {
    providers: AWS.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const { eks, hyperpod, scheduler, researchQuota } =
      yield* HyperPodEksInfra;

    // ── LOW LEVEL: any Kubernetes object, applied as data. This one is
    // governed: it runs in the research team's namespace (created by the
    // ComputeQuota) and carries the Kueue queue + priority labels, so
    // HyperPod task governance arbitrates it against the team's quota.
    const governedJob = yield* AWS.EKS.Manifest("GovernedJob", {
      cluster: eks,
      manifest: {
        apiVersion: "batch/v1",
        kind: "Job",
        metadata: {
          name: "governed-hello",
          namespace: Output.interpolate`hyperpod-ns-${researchQuota.teamName}`,
          labels: {
            "kueue.x-k8s.io/queue-name": Output.interpolate`hyperpod-ns-${researchQuota.teamName}-localqueue`,
            "kueue.x-k8s.io/priority-class": "training-priority",
          },
        },
        spec: {
          backoffLimit: 1,
          template: {
            spec: {
              nodeSelector: {
                "sagemaker.amazonaws.com/node-health-status": "Schedulable",
                "sagemaker.amazonaws.com/instance-group-name":
                  hyperpod.instanceGroups.workers.InstanceGroupName,
              },
              containers: [
                {
                  name: "hello",
                  image: "public.ecr.aws/docker/library/busybox:stable",
                  command: ["sh", "-c", "echo hello from HyperPod"],
                },
              ],
              restartPolicy: "Never",
            },
          },
        },
      },
    });

    // ── HIGH LEVEL: the effectful Job (bundled TypeScript, pinned +
    // governed via the `hyperpod:` prop). See src/TrainJob.ts.
    const trainJob = yield* TrainJob;

    return {
      eksClusterName: eks.clusterName,
      hyperpodClusterArn: hyperpod.clusterArn,
      hyperpodStatus: hyperpod.clusterStatus,
      schedulerPolicyId: scheduler.clusterSchedulerConfigId,
      researchTeam: researchQuota.teamName,
      governedJobName: governedJob.name,
      trainJobName: trainJob.jobName,
    };
  }),
);
