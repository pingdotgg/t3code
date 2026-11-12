import type { KindClusterConfig, LocalClusterProps } from "../LocalCluster.ts";

/**
 * containerd patch enabling the per-registry `hosts.toml` directory that
 * points `localhost:<registryPort>` at the local registry container. The
 * default on kind v0.27+ node images; kept for older ones
 * (https://kind.sigs.k8s.io/docs/user/local-registry/).
 */
export const REGISTRY_CONTAINERD_PATCH = `[plugins."io.containerd.grpc.v1.cri".registry]
  config_path = "/etc/containerd/certs.d"`;

/** The kind config fields of a `LocalCluster`'s props. */
export const kindConfigOf = ({
  nodes,
  networking,
  featureGates,
  runtimeConfig,
  kubeadmConfigPatches,
  kubeadmConfigPatchesJSON6902,
  containerdConfigPatches,
  containerdConfigPatchesJSON6902,
}: Partial<LocalClusterProps>): KindClusterConfig => ({
  nodes,
  networking,
  featureGates,
  runtimeConfig,
  kubeadmConfigPatches,
  kubeadmConfigPatchesJSON6902,
  containerdConfigPatches,
  containerdConfigPatchesJSON6902,
});

/**
 * The kind cluster config `LocalCluster` passes to `kind create cluster`:
 * the kind fields with the kind/apiVersion header and the registry
 * containerd patch added. kind reads YAML, and JSON is valid YAML.
 */
export const kindClusterConfig = (config: KindClusterConfig) => ({
  kind: "Cluster",
  apiVersion: "kind.x-k8s.io/v1alpha4",
  ...JSON.parse(JSON.stringify(config)),
  containerdConfigPatches: [...(config.containerdConfigPatches ?? []), REGISTRY_CONTAINERD_PATCH],
});
