export type ClusterUser = {
  /** Principal granted cluster-admin (user clusters) or cluster-view (admin). */
  username?: string;
};

export type Authorization = {
  /** Users granted bootstrap RBAC on the cluster. */
  adminUsers?: ClusterUser[];
};

export type BinaryAuthorization = {
  /**
   * Binauthz evaluation mode (`DISABLED`,
   * `PROJECT_SINGLETON_POLICY_ENFORCE`).
   */
  evaluationMode?: string;
};

export type NodeTaint = {
  /** Taint effect (`NO_SCHEDULE`, `PREFER_NO_SCHEDULE`, `NO_EXECUTE`). */
  effect?: string;
  /** Taint key. */
  key?: string;
  /** Taint value. */
  value?: string;
};

export type BareMetalNodeConfig = {
  /** Node IPv4 used for SSH and Kubernetes. */
  nodeIp?: string;
  /** Kubernetes labels applied to this node. */
  labels?: Record<string, string | undefined>;
};

export type BareMetalKubeletConfig = {
  /** Registry pull QPS limit. `0` means unlimited. */
  registryPullQps?: number;
  /** Burst size for registry pulls. */
  registryBurst?: number;
  /** When true, kubelet pulls one image at a time. */
  serializeImagePullsDisabled?: boolean;
};

export type BareMetalNodePoolConfig = {
  /** Kubernetes labels applied to every node in the pool. */
  labels?: Record<string, string | undefined>;
  /** Machine addresses that make up the pool. Required on create. */
  nodeConfigs?: BareMetalNodeConfig[];
  /** Modifiable kubelet settings. */
  kubeletConfig?: BareMetalKubeletConfig;
  /** Node OS (`LINUX`). */
  operatingSystem?: string;
  /** Initial taints assigned to nodes of this pool. */
  taints?: NodeTaint[];
};

export type BareMetalControlPlaneNodePoolConfig = {
  /** Node pool that runs the control plane. */
  nodePoolConfig?: BareMetalNodePoolConfig;
};

export type BareMetalApiServerArgument = {
  /** API server flag name without leading dashes. */
  argument?: string;
  /** Flag value passed on the command line. */
  value?: string;
};

export type BareMetalControlPlaneConfig = {
  /** Control plane node pool. Required on create. */
  controlPlaneNodePoolConfig?: BareMetalControlPlaneNodePoolConfig;
  /** Extra kube-apiserver arguments. */
  apiServerArgs?: BareMetalApiServerArgument[];
};

export type BareMetalSecurityConfig = {
  /** Bootstrap RBAC users. */
  authorization?: Authorization;
};

export type BareMetalProxyConfig = {
  /** Proxy URI (`http://proxy.example.com`). Credentials are rejected. */
  uri?: string;
  /** Hosts that skip the proxy. */
  noProxy?: string[];
};

export type BareMetalClusterUpgradePolicy = {
  /** Upgrade policy (`SERIAL`, `CONCURRENT`). */
  policy?: string;
  /** Output-only pause flag. */
  pause?: boolean;
};

export type BareMetalLvpConfig = {
  /** Host path used for local persistent volumes. */
  path?: string;
  /** StorageClass name created for those volumes. */
  storageClass?: string;
};

export type BareMetalLvpShareConfig = {
  /** Shared-filesystem LVP path and StorageClass. */
  lvpConfig?: BareMetalLvpConfig;
  /** Number of subdirectories created under the share path. */
  sharedPathPvCount?: number;
};

export type BareMetalStorageConfig = {
  /** Local PVs backed by subdirectories of a shared filesystem. */
  lvpShareConfig?: BareMetalLvpShareConfig;
  /** Local PVs backed by mounted node disks. */
  lvpNodeMountsConfig?: BareMetalLvpConfig;
};

export type BareMetalNodeAccessConfig = {
  /** SSH login user. Defaults to `root`. */
  loginUser?: string;
};

export type BareMetalIslandModeCidrConfig = {
  /** Service CIDR blocks (RFC1918). Mutable from 1.15. */
  serviceAddressCidrBlocks?: string[];
  /** Pod CIDR blocks (RFC1918). Immutable after create. */
  podAddressCidrBlocks?: string[];
};

export type BareMetalSrIovConfig = {
  /** Install the SR-IOV operator. */
  enabled?: boolean;
};

export type BareMetalMultipleNetworkInterfacesConfig = {
  /** Enable multiple network interfaces for pods. */
  enabled?: boolean;
};

export type BareMetalNetworkConfig = {
  /** Island-mode pod and service CIDRs. */
  islandModeCidr?: BareMetalIslandModeCidrConfig;
  /** SR-IOV operator config. */
  srIovConfig?: BareMetalSrIovConfig;
  /** Enable advanced Anthos networking features. */
  advancedNetworking?: boolean;
  /** Multiple network interfaces. */
  multipleNetworkInterfacesConfig?: BareMetalMultipleNetworkInterfacesConfig;
};

export type BareMetalMaintenanceConfig = {
  /** CIDRs whose nodes are cordoned and drained. */
  maintenanceAddressCidrBlocks?: string[];
};

export type BareMetalWorkloadNodeConfig = {
  /** Max pods per node (drives the node CIDR size). */
  maxPodsPerNode?: string;
  /** Container runtime (`CONTAINERD`). */
  containerRuntime?: string;
};

export type BareMetalVipConfig = {
  /** VIP reserved for the Kubernetes API. */
  controlPlaneVip?: string;
  /** VIP reserved for ingress. */
  ingressVip?: string;
};

export type BareMetalLoadBalancerAddressPool = {
  /** Address pool name. */
  pool?: string;
  /** CIDRs or ranges in the pool. */
  addresses?: string[];
  /** Avoid IPs ending in `.0` or `.255`. */
  avoidBuggyIps?: boolean;
  /** Disable automatic assignment from this pool. */
  manualAssign?: boolean;
};

export type BareMetalLoadBalancerNodePoolConfig = {
  /** Node pool that runs the load balancer. */
  nodePoolConfig?: BareMetalNodePoolConfig;
};

export type BareMetalMetalLbConfig = {
  /** Non-overlapping address pools. Ingress VIP must be included. */
  addressPools?: BareMetalLoadBalancerAddressPool[];
  /** Load balancer node pool. Defaults to the control plane pool. */
  loadBalancerNodePoolConfig?: BareMetalLoadBalancerNodePoolConfig;
};

export type BareMetalPortConfig = {
  /** Port the control plane load balancer listens on. */
  controlPlaneLoadBalancerPort?: number;
};

export type BareMetalManualLbConfig = {
  /** Enable manual load balancing. */
  enabled?: boolean;
};

export type BareMetalBgpPeerConfig = {
  /** Control plane node IPs that peer with the external device. */
  controlPlaneNodes?: string[];
  /** Peer ASN. */
  asn?: string;
  /** Peer IP address. */
  ipAddress?: string;
};

export type BareMetalBgpLbConfig = {
  /** Load balancer node pool. Defaults to the control plane pool. */
  loadBalancerNodePoolConfig?: BareMetalLoadBalancerNodePoolConfig;
  /** Cluster ASN. Mutable after create. */
  asn?: string;
  /** Non-overlapping address pools. */
  addressPools?: BareMetalLoadBalancerAddressPool[];
  /** BGP peers advertised by control plane nodes. */
  bgpPeerConfigs?: BareMetalBgpPeerConfig[];
};

export type BareMetalLoadBalancerConfig = {
  /** Control plane and ingress VIPs. */
  vipConfig?: BareMetalVipConfig;
  /** MetalLB configuration. */
  metalLbConfig?: BareMetalMetalLbConfig;
  /** Load balancer listen ports. */
  portConfig?: BareMetalPortConfig;
  /** Manual load balancer. */
  manualLbConfig?: BareMetalManualLbConfig;
  /** BGP load balancer. Implies advanced networking. */
  bgpLbConfig?: BareMetalBgpLbConfig;
};

export type BareMetalClusterOperationsConfig = {
  /** Collect application logs and metrics in addition to system ones. */
  enableApplicationLogs?: boolean;
};

export type BareMetalOsEnvironmentConfig = {
  /** Skip adding the package repo when initializing machines. */
  packageRepoExcluded?: boolean;
};

export type BareMetalParallelUpgradeConfig = {
  /** Minimum healthy nodes during an upgrade. */
  minimumAvailableNodes?: number;
  /** Maximum nodes upgraded at once. */
  concurrentNodes?: number;
};

export type BareMetalNodePoolUpgradePolicy = {
  /** Parallel upgrade settings. */
  parallelUpgradeConfig?: BareMetalParallelUpgradeConfig;
};

export type VmwareAutoResizeConfig = {
  /** Enable control plane node auto-resizing. */
  enabled?: boolean;
};

export type VmwareControlPlaneVsphereConfig = {
  /** vSphere datastore for control plane nodes. */
  datastore?: string;
  /** vSphere storage policy for control plane nodes. */
  storagePolicyName?: string;
};

export type VmwareControlPlaneNodeConfig = {
  /** Memory in MB per control plane node. Default 8192. */
  memory?: string;
  /** Auto-resize configuration. */
  autoResizeConfig?: VmwareAutoResizeConfig;
  /** CPUs per control plane node. Default 4. */
  cpus?: string;
  /** vSphere-specific control plane settings. */
  vsphereConfig?: VmwareControlPlaneVsphereConfig;
  /** Replica count. Must be 1 or 3. Default 1. */
  replicas?: string;
};

export type VmwareStorageConfig = {
  /** Disable vSphere CSI in the user cluster. Enabled by default. */
  vsphereCsiDisabled?: boolean;
};

export type VmwareVCenterConfig = {
  /** vCenter CA certificate public key for SSL verification. */
  caCertData?: string;
  /** vCenter datastore. */
  datastore?: string;
  /** vCenter datacenter. */
  datacenter?: string;
  /** vCenter cluster. */
  cluster?: string;
  /** vCenter folder. */
  folder?: string;
  /** Output-only vCenter address. */
  address?: string;
  /** vCenter resource pool. */
  resourcePool?: string;
  /** vCenter storage policy. */
  storagePolicyName?: string;
};

export type VmwareVipConfig = {
  /** VIP reserved for the Kubernetes API. */
  controlPlaneVip?: string;
  /** VIP reserved for ingress. */
  ingressVip?: string;
};

export type VmwareF5BigIpConfig = {
  /** Pre-existing F5 partition. */
  partition?: string;
  /** SNAT pool name. */
  snatPool?: string;
  /** Load balancer IP. */
  address?: string;
};

export type VmwareManualLbConfig = {
  /** NodePort for the control plane service. */
  controlPlaneNodePort?: number;
  /** NodePort for ingress HTTP. */
  ingressHttpNodePort?: number;
  /** NodePort for ingress HTTPS. */
  ingressHttpsNodePort?: number;
  /** NodePort for the konnectivity sidecar. */
  konnectivityServerNodePort?: number;
};

export type VmwareHostIp = {
  /** IP or CIDR. */
  ip?: string;
  /** Hostname. VM name is used when empty. */
  hostname?: string;
};

export type VmwareIpBlock = {
  /** Netmask. */
  netmask?: string;
  /** Per-node IP assignments. */
  ips?: VmwareHostIp[];
  /** Gateway. */
  gateway?: string;
};

export type VmwareSeesawConfig = {
  /** Enable a highly-available Seesaw pair. */
  enableHa?: boolean;
  /** IP blocks used by Seesaw. */
  ipBlocks?: VmwareIpBlock[];
  /** VM names created for this Seesaw group. */
  vms?: string[];
  /** Seesaw group name, typically `seesaw-for-{cluster}`. */
  group?: string;
  /** IP announced by the Seesaw master. */
  masterIp?: string;
  /** Stackdriver name. */
  stackdriverName?: string;
};

export type VmwareAddressPool = BareMetalLoadBalancerAddressPool;

export type VmwareMetalLbConfig = {
  /** Non-overlapping address pools. Ingress VIP must be included. */
  addressPools?: VmwareAddressPool[];
};

export type VmwareLoadBalancerConfig = {
  /** Control plane and ingress VIPs. */
  vipConfig?: VmwareVipConfig;
  /** F5 BIG-IP configuration. */
  f5Config?: VmwareF5BigIpConfig;
  /** Manual load balancer. */
  manualLbConfig?: VmwareManualLbConfig;
  /** Output-only Seesaw configuration. */
  seesawConfig?: VmwareSeesawConfig;
  /** MetalLB configuration. */
  metalLbConfig?: VmwareMetalLbConfig;
};

export type VmwareControlPlaneV2Config = {
  /** Static IPs for control plane V2 nodes. */
  controlPlaneIpBlock?: VmwareIpBlock;
};

export type VmwareHostConfig = {
  /** NTP servers. */
  ntpServers?: string[];
  /** DNS servers. */
  dnsServers?: string[];
  /** DNS search domains. */
  dnsSearchDomains?: string[];
};

export type VmwareStaticIpConfig = {
  /** Static IP blocks assigned to nodes. */
  ipBlocks?: VmwareIpBlock[];
};

export type VmwareDhcpIpConfig = {
  /** Use DHCP for node IPs. */
  enabled?: boolean;
};

export type VmwareNetworkConfig = {
  /** vCenter network name. Inherited from the admin cluster. */
  vcenterNetwork?: string;
  /** Common host network settings. */
  hostConfig?: VmwareHostConfig;
  /** Control plane V2 IP config. */
  controlPlaneV2Config?: VmwareControlPlaneV2Config;
  /** Service CIDR blocks. Single range. Immutable. */
  serviceAddressCidrBlocks?: string[];
  /** Pod CIDR blocks. Single range. Immutable. */
  podAddressCidrBlocks?: string[];
  /** Static IP configuration. */
  staticIpConfig?: VmwareStaticIpConfig;
  /** DHCP IP configuration. */
  dhcpIpConfig?: VmwareDhcpIpConfig;
};

export type VmwareDataplaneV2Config = {
  /** Enable Dataplane V2 on Windows nodes. */
  windowsDataplaneV2Enabled?: boolean;
  /** Enable Dataplane V2. */
  dataplaneV2Enabled?: boolean;
  /** Advanced networking. Requires Dataplane V2. */
  advancedNetworking?: boolean;
  /** Dataplane V2 forward mode. */
  forwardMode?: string;
};

export type VmwareAAGConfig = {
  /** Disable anti-affinity (spread across three hosts). Enabled by default. */
  aagConfigDisabled?: boolean;
};

export type VmwareAutoRepairConfig = {
  /** Enable auto repair. */
  enabled?: boolean;
};

export type VmwareClusterUpgradePolicy = {
  /** Restrict the upgrade to the control plane. */
  controlPlaneOnly?: boolean;
};

export type VmwareNodePoolAutoscalingConfig = {
  /** Minimum replicas. */
  minReplicas?: number;
  /** Maximum replicas. */
  maxReplicas?: number;
};

export type VmwareVsphereTag = {
  /** vSphere tag name. */
  tag?: string;
  /** vSphere tag category. */
  category?: string;
};

export type VmwareVsphereConfig = {
  /** Host groups applied to VMs in the pool. */
  hostGroups?: string[];
  /** vCenter datastore. Inherited from the user cluster. */
  datastore?: string;
  /** vSphere tags applied to VMs. */
  tags?: VmwareVsphereTag[];
};

export type VmwareNodeConfig = {
  /** Replica count. */
  replicas?: string;
  /** OS image name in vCenter (Windows only). */
  image?: string;
  /** Allow MetalLB to load-balance this pool. */
  enableLoadBalancer?: boolean;
  /**
   * OS image type (`cos`, `cos_cgv2`, `ubuntu`, `ubuntu_cgv2`,
   * `ubuntu_containerd`, `windows`).
   */
  imageType?: string;
  /** Initial taints. */
  taints?: NodeTaint[];
  /** CPUs per node. */
  cpus?: string;
  /** vSphere settings for this pool. */
  vsphereConfig?: VmwareVsphereConfig;
  /** Memory in MB per node. */
  memoryMb?: string;
  /** Boot disk size in GB. */
  bootDiskSizeGb?: string;
  /** Kubernetes labels applied to each node. */
  labels?: Record<string, string | undefined>;
};

export type Fleet = {
  /** Output-only Hub membership resource name. */
  membership?: string;
};
