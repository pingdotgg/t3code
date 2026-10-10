import * as Kubernetes from "@/Kubernetes";

/**
 * The shared `Kubernetes.LocalCluster` for LocalCluster.test.ts: a kind
 * cluster plus its image registry on a dedicated port, with a kubeconfig
 * under `.alchemy/` so the run never touches `~/.kube/config`.
 */
export const TestLocalCluster = Kubernetes.LocalCluster("TestLocalCluster", {
  name: "alchemy-test-local",
  registryPort: 5061,
  kubeconfig: ".alchemy/test-local-cluster.kubeconfig",
});
