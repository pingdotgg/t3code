# @alchemy.run/kubernetes

Kubernetes for [Alchemy](https://alchemy.run). Declare Deployments, Jobs, raw manifests, and Helm charts on any cluster, in the same TypeScript program as the rest of your infrastructure. No YAML, no `kubectl apply`.

```sh
npm install alchemy @alchemy.run/kubernetes effect
```

A local cluster and a Deployment on it:

```typescript
// alchemy.run.ts
import * as Alchemy from "alchemy";
import * as Kubernetes from "@alchemy.run/kubernetes";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "MyApp",
  {
    providers: Kubernetes.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const cluster = yield* Kubernetes.LocalCluster("Cluster", { name: "alchemy" });

    const web = yield* Kubernetes.Deployment("Web", {
      cluster,
      name: "web",
      image: "ghcr.io/stefanprodan/podinfo:6.15.0",
      port: 9898,
      replicas: 2,
    });

    return { service: web.serviceName };
  }),
);
```

Swap `LocalCluster` for an EKS cluster from `@alchemy.run/aws` or a GKE cluster from `@alchemy.run/gcp` and the Deployment stays the same.

## Learn more

- [Kubernetes on alchemy.run](https://alchemy.run/kubernetes)
- [Setup](https://alchemy.run/kubernetes/setup)
- [Tutorial](https://alchemy.run/kubernetes/tutorial/part-1)
- [API reference](https://alchemy.run/providers)
