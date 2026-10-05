import { Stage } from "alchemy";
import * as Kubernetes from "alchemy/Kubernetes";
import * as Effect from "effect/Effect";

export const Cluster = Effect.gen(function* () {
  const stage = yield* Stage;
  if (stage === "prod") {
    return Kubernetes.KubeConfig({
      context: "prod",
      registry: { server: "ghcr.io/you" },
    });
  }
  return yield* Kubernetes.LocalCluster("Cluster", { name: "alchemy" });
});

export const Namespace = Effect.gen(function* () {
  const cluster = yield* Cluster;
  return yield* Kubernetes.Manifest("Namespace", {
    cluster,
    manifest: {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: { name: "my-app" },
    },
  });
});

export const Web = Effect.gen(function* () {
  const cluster = yield* Cluster;
  const namespace = yield* Namespace;
  return yield* Kubernetes.Deployment("Web", {
    cluster,
    name: "web",
    namespace: namespace.name,
    image: "ghcr.io/stefanprodan/podinfo:6.15.0",
    port: 9898,
    replicas: 2,
    serviceType: "ClusterIP",
    env: {
      PODINFO_UI_MESSAGE: "hello from alchemy",
    },
    resources: {
      requests: { cpu: "10m", memory: "32Mi" },
      limits: { memory: "64Mi" },
    },
  });
});
