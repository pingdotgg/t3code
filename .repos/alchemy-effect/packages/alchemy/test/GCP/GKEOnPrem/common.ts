import { GcpEnvironment } from "@/GCP/Environment";
import * as Effect from "effect/Effect";

export const currentProject = GcpEnvironment.current.pipe(
  Effect.map((env) => env.project),
);

// User clusters need a registered on-prem admin cluster (fleet membership
// name).
export const bareMetalAdminMembership =
  process.env.GCP_TEST_GKEONPREM_BAREMETAL_ADMIN?.trim() || undefined;
export const vmwareAdminMembership =
  process.env.GCP_TEST_GKEONPREM_VMWARE_ADMIN?.trim() || undefined;
export const runBareMetalLifecycle = !!bareMetalAdminMembership;
export const runVmwareLifecycle = !!vmwareAdminMembership;

export const missingMembership = (projectId: string) =>
  `projects/${projectId}/locations/global/memberships/alchemy-missing-admin`;

export const missingBareMetalCluster = (projectId: string) =>
  `projects/${projectId}/locations/us-central1/bareMetalClusters/alchemy-missing-bmc`;

export const missingVmwareCluster = (projectId: string) =>
  `projects/${projectId}/locations/us-central1/vmwareClusters/alchemy-missing-vmc`;

export const bareMetalControlPlane = {
  controlPlaneNodePoolConfig: {
    nodePoolConfig: {
      nodeConfigs: [{ nodeIp: "10.200.0.2" }],
    },
  },
};

export const bareMetalStorage = {
  lvpShareConfig: {
    lvpConfig: {
      path: "/mnt/localpv-share",
      storageClass: "local-shared",
    },
    sharedPathPvCount: 5,
  },
  lvpNodeMountsConfig: {
    path: "/mnt/localpv-disk",
    storageClass: "local-disks",
  },
};

export const bareMetalNetwork = {
  islandModeCidr: {
    serviceAddressCidrBlocks: ["10.96.0.0/12"],
    podAddressCidrBlocks: ["192.168.0.0/16"],
  },
};

export const bareMetalLoadBalancer = {
  vipConfig: {
    controlPlaneVip: "10.200.0.8",
    ingressVip: "10.200.0.9",
  },
  portConfig: { controlPlaneLoadBalancerPort: 443 },
  metalLbConfig: {
    addressPools: [{ pool: "pool-1", addresses: ["10.200.0.10-10.200.0.20"] }],
  },
};

export const vmwareControlPlane = {
  cpus: "4",
  memory: "8192",
  replicas: "1",
};

export const vmwareNetwork = {
  serviceAddressCidrBlocks: ["10.96.0.0/12"],
  podAddressCidrBlocks: ["192.168.0.0/16"],
  dhcpIpConfig: { enabled: true },
};

export const vmwareLoadBalancer = {
  vipConfig: {
    controlPlaneVip: "10.200.0.8",
    ingressVip: "10.200.0.9",
  },
  metalLbConfig: {
    addressPools: [{ pool: "pool-1", addresses: ["10.200.0.10-10.200.0.20"] }],
  },
};
