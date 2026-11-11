// Coverage verdicts for the remaining `emr-containers` operations:
// - create/describe/list SecurityConfiguration: out of scope as a Resource —
//   the API has NO DeleteSecurityConfiguration, so a provisioned config can
//   never be destroyed (violates destroy/zero-orphan semantics); neither
//   Terraform nor CloudFormation models it. VirtualCluster accepts a
//   `securityConfigurationId` prop for configs created out of band.
// - create/delete ManagedEndpoint: resource lifecycle of an object that
//   requires a live EKS cluster + RUNNING virtual cluster + EMR Studio
//   setup; not modeled by Terraform/CloudFormation. The data plane is
//   covered (DescribeManagedEndpoint, ListManagedEndpoints,
//   GetManagedEndpointSessionCredentials).
// - tagResource/untagResource/listTagsForResource: covered by the
//   VirtualCluster/JobTemplate providers' tag sync.
export * from "./CancelJobRun.ts";
export * from "./CancelJobRunHttp.ts";
export * from "./DescribeJobRun.ts";
export * from "./DescribeJobRunHttp.ts";
export * from "./DescribeJobTemplate.ts";
export * from "./DescribeJobTemplateHttp.ts";
export * from "./DescribeManagedEndpoint.ts";
export * from "./DescribeManagedEndpointHttp.ts";
export * from "./DescribeVirtualCluster.ts";
export * from "./DescribeVirtualClusterHttp.ts";
export * from "./GetManagedEndpointSessionCredentials.ts";
export * from "./GetManagedEndpointSessionCredentialsHttp.ts";
export * from "./JobRunEventSource.ts";
export * from "./JobTemplate.ts";
export * from "./ListJobRuns.ts";
export * from "./ListJobRunsHttp.ts";
export * from "./ListJobTemplates.ts";
export * from "./ListJobTemplatesHttp.ts";
export * from "./ListManagedEndpoints.ts";
export * from "./ListManagedEndpointsHttp.ts";
export * from "./ListVirtualClusters.ts";
export * from "./ListVirtualClustersHttp.ts";
export * from "./StartJobRun.ts";
export * from "./StartJobRunHttp.ts";
export * from "./VirtualCluster.ts";
