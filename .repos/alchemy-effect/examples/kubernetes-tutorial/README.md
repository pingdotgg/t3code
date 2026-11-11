# Kubernetes tutorial

The complete stack from the [five-part Kubernetes tutorial](https://alchemy.run/kubernetes/tutorial/part-1): a local kind cluster with podinfo in its own namespace, an Effect smoke-test Job, the same program as a CronJob, and metrics-server from its Helm chart.

## Requirements

- [Docker](https://docs.docker.com/get-started/get-docker/), running
- [kind](https://kind.sigs.k8s.io/docs/user/quick-start/#installation)
- [helm](https://helm.sh/docs/intro/install/)
- [kubectl](https://kubernetes.io/docs/tasks/tools/), to inspect the cluster

## Run

From the repository root, install dependencies with `pnpm install`. Then:

```sh
cd examples/kubernetes-tutorial
bun run deploy
```

The first deploy creates a kind cluster named `alchemy` (context `kind-alchemy`) with an image registry on `localhost:5001`, then builds and pushes the smoke test and health check.

```sh
kubectl --context kind-alchemy -n my-app get deployments,jobs,cronjobs
kubectl --context kind-alchemy -n my-app logs job/<smokeTest>
bun run destroy
```

`--stage prod` targets a kubeconfig context named `prod` and pushes to `ghcr.io/you`. Edit `src/infra.ts` for your cluster and registry first, as described in [Part 5](https://alchemy.run/kubernetes/tutorial/part-5).

## Test

```sh
timeout 400 bun test
```

The test deploys the stack to a fresh local cluster, waits for the smoke-test Job to complete, checks the Deployment, CronJob, and metrics-server, and destroys everything afterward. Set `NO_DESTROY=1` to keep the cluster for inspection.
