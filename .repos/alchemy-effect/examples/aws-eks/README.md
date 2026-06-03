# AWS EKS Auto Mode Example

This example is fully TypeScript-driven. It provisions:

- `AWS.EC2.Network`
- `AWS.EKS.AutoCluster`
- `AWS.EKS.AccessEntry` for cluster-admin access
- `AWS.EKS.Addon` for `metrics-server` and `snapshot-controller`
- `AWS.EKS.LoadBalancedWorkload` for deployment + public service composition
- `AWS.EKS.PodIdentityWorkload` for workload identity + deployment composition
- `Kubernetes.Namespace`
- `Kubernetes.Job`

There is no YAML or `kubectl apply` step. The workloads are declared in
[`alchemy.run.ts`](./alchemy.run.ts) and reconciled by the EKS cluster resource.

## Commands

```sh
bun install
bun run --filter aws-eks-example deploy
bun run --filter aws-eks-example destroy
```

## Cluster Access

By default, the example grants cluster-admin access to the IAM principal that is
running the deploy. If your current caller is not a normal IAM user or IAM role,
set this before deploy:

```sh
export EKS_ADMIN_PRINCIPAL_ARN=arn:aws:iam::123456789012:role/YourAdminRole
```

## What Gets Deployed

The example creates these in-cluster workloads in code:

- a `demo` namespace
- an `echo-server` workload created with `AWS.EKS.LoadBalancedWorkload`
- a `pod-identity-demo` workload created with `AWS.EKS.PodIdentityWorkload`
- a `cluster-info` job

The pod identity workload creates the Kubernetes service account, IAM role,
`AWS.EKS.PodIdentityAssociation`, and deployment together.

## Optional Inspection

If you want to inspect the cluster manually after deploy, you can still use your
normal kubeconfig flow, for example:

```sh
aws eks update-kubeconfig --name alchemy-eks-auto-example --region "$AWS_REGION"
kubectl get pods -n demo
```
