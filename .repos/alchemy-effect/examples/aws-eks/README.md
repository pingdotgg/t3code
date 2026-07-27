# AWS EKS Example

A "guestbook" app on EKS Auto Mode, fully TypeScript-driven — no YAML, no
`kubectl apply`, no Helm.

- [`src/infra.ts`](./src/infra.ts) — the shared infrastructure: a VPC, an
  `AWS.EKS.Cluster` with `compute: "auto"` (the provider creates and owns the
  cluster + node IAM roles and enables managed compute, storage, and load
  balancing), a DynamoDB table, and a namespace applied as a raw manifest via
  `AWS.EKS.Manifest` + the typed `alchemy/Kubernetes` builders.
- [`src/Api.ts`](./src/Api.ts) — an effectful `AWS.EKS.Deployment` in the
  tagged form (`Api.make(props, impl)`): an Effect HTTP server bundled into a
  generated image, exposed through an internet-facing NLB, with DynamoDB
  bindings that land IAM on the pod-identity role and inject the table name
  into the pod. Includes the typed `podTemplate` escape hatch.
- [`src/SeedJob.ts`](./src/SeedJob.ts) — an inline-effect one-shot
  `AWS.EKS.Job` (`{ run }`) that seeds the guestbook table when the Job is
  applied on deploy.
- [`alchemy.run.ts`](./alchemy.run.ts) — thin composition: yields the shared
  infra, the tagged `Api` (via `Effect.provide(ApiLive)`), an EXTERNAL
  nginx `AWS.EKS.Deployment` (registry `image:` source), and the `SeedJob`.

## Commands

```sh
bun install
bun run --filter aws-eks-example deploy
bun run --filter aws-eks-example destroy
```

The cluster control plane takes ~15 minutes to provision.

## Try it

```sh
# outputs: apiUrl (note the :3000 — the NLB listens on the Service port), webUrl
curl "$apiUrl/entries"                            # seeded by SeedJob
curl -X POST "$apiUrl/entries?author=you&message=hello"
curl "$apiUrl/entries/ada"
curl "$webUrl"                                    # external nginx deployment
```

## Optional Inspection

To inspect the cluster manually after deploy:

```sh
aws eks update-kubeconfig --name <clusterName output> --region "$AWS_REGION"
kubectl get pods -n guestbook
```
