# AWS SageMaker HyperPod Example

SageMaker HyperPod clusters in TypeScript, covering both orchestrators and
every workload tier — from `sbatch` on a Slurm login node to effectful
TypeScript jobs arbitrated by task governance.

HyperPod is a persistent, resilient fleet of ML compute. How work lands on
it depends on the orchestrator you pick at creation:

| | Slurm (default) | EKS (`orchestrator: { Eks }`) |
|---|---|---|
| Provision | [`alchemy.run.ts`](./alchemy.run.ts) | [`eks.run.ts`](./eks.run.ts) |
| Low-level workloads | `ssm start-session` → `sbatch` | `AWS.EKS.Manifest` (or `kubectl`) |
| High-level workloads | — (no submission API) | `AWS.EKS.Job` / `AWS.EKS.Deployment` with the `hyperpod:` prop |
| Governance | Slurm accounting | `ClusterSchedulerConfig` + `ComputeQuota` (Kueue) |

## The Slurm stack (`alchemy.run.ts`)

- [`src/infra.ts`](./src/infra.ts) — the lifecycle-script bucket and the
  instance execution role (inline grant built with `Output.interpolate`).
- [`src/lifecycle.ts`](./src/lifecycle.ts) — a deploy-time `Alchemy.Action`
  that uploads `on_create.sh` with the Effect-native distilled SDK
  (`s3.putObject`). Bucket → script → cluster ordering is inferred from the
  data flow.
- Slurm requires a `LifeCycleConfig` per instance group — that's where real
  clusters install the scheduler, mount FSx, and wire observability.

```sh
bun run --filter aws-hyperpod-example deploy    # ~5 minutes at this size
bun run --filter aws-hyperpod-example destroy
```

Workloads are submitted **on the cluster** — each node is an SSM target:

```sh
aws sagemaker list-cluster-nodes --cluster-name <clusterName output>
aws ssm start-session \
  --target sagemaker-cluster:<cluster-id>_controller-<instance-id>
# then, on the node:
sbatch --nodes=1 train.sbatch
```

## The EKS stack (`eks.run.ts`)

- [`src/eks-infra.ts`](./src/eks-infra.ts) — network (private subnets +
  NAT), a plain EKS control plane (HyperPod supplies the nodes), the
  HyperPod instance role (managed policy + the EKS networking/ECR/pod
  identity grants), the HyperPod cluster attached via
  `orchestrator: { Eks: { ClusterArn } }`, the
  `amazon-sagemaker-hyperpod-taskgovernance` add-on, a scheduler policy,
  and the research team's compute quota. `LifeCycleConfig` is required
  here too — the API enforces it for EKS-orchestrated instance groups.
- **Low level** (`eks.run.ts`) — a raw batch/v1 Job applied with
  `AWS.EKS.Manifest`, pinned to HyperPod nodes with the well-known labels
  and submitted through governance with the Kueue labels:

  ```typescript
  nodeSelector: {
    "sagemaker.amazonaws.com/node-health-status": "Schedulable",
    "sagemaker.amazonaws.com/instance-group-name":
      hyperpod.instanceGroups.workers.InstanceGroupName,
  },
  labels: {
    "kueue.x-k8s.io/queue-name": Output.interpolate`hyperpod-ns-${researchQuota.teamName}-localqueue`,
    "kueue.x-k8s.io/priority-class": "training-priority",
  },
  ```

- **High level** ([`src/TrainJob.ts`](./src/TrainJob.ts)) — an effectful
  `AWS.EKS.Job` bundled from TypeScript. The `hyperpod:` prop references
  **resources through the graph**: the instance-group keys carry through
  to the cluster's attributes as types (a typo'd name is a compile
  error), and the quota resource derives the namespace, Kueue labels, and
  ordering:

  ```typescript
  yield* AWS.EKS.Job("TrainJob", {
    cluster: eks,
    main: import.meta.url,
    hyperpod: {
      instanceGroup: hyperpod.instanceGroups.workers, // key-typed group ref
      quota: researchQuota,      // → hyperpod-ns-research + Kueue queue label
      priorityClass: "training", // → training-priority
    },
  });
  ```

  Bindings resolve in init and land IAM on the pod-identity role, exactly
  like any other EKS Job or Deployment.

```sh
bun alchemy deploy ./eks.run.ts    # EKS ~10-15 min + HyperPod ~10-20 min
bun alchemy destroy ./eks.run.ts
```

## Inspection

```sh
aws sagemaker describe-cluster --cluster-name <name>
aws eks update-kubeconfig --name <eksClusterName output>
kubectl get nodes -l sagemaker.amazonaws.com/node-health-status=Schedulable
kubectl get workloads -n hyperpod-ns-research    # Kueue admission
```
