import * as AWS from "alchemy/AWS";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { FetchHyperPodChart } from "./hyperpod-chart.ts";
import { UploadLifecycleScript } from "./lifecycle.ts";

/**
 * Shared infrastructure for the EKS-orchestrated HyperPod stack:
 * network → EKS control plane → HyperPod cluster → task governance.
 *
 * Resources are memoized by logical id, so this Effect can be yielded from
 * the stack program and from workload modules and always converges on the
 * same instances.
 */
export const HyperPodEksInfra = Effect.gen(function* () {
  // HyperPod nodes must live in private subnets; NAT gives them a path to
  // pull container images.
  const network = yield* AWS.EC2.Network("HyperPodNetwork", {
    cidrBlock: "10.72.0.0/16",
    availabilityZones: 2,
    nat: "single",
  });

  // The control-plane role for the orchestrating EKS cluster.
  const eksRole = yield* AWS.IAM.Role("OrchestratorRole", {
    assumeRolePolicyDocument: {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { Service: "eks.amazonaws.com" },
          Action: ["sts:AssumeRole"],
        },
      ],
    },
    managedPolicyArns: ["arn:aws:iam::aws:policy/AmazonEKSClusterPolicy"],
  });

  // The orchestrator: a plain EKS control plane. HyperPod requires the
  // `API` (or `API_AND_CONFIG_MAP`) authentication mode — EKS's own
  // CONFIG_MAP default is rejected by CreateCluster. HyperPod provides the
  // nodes, so there is no compute config here.
  const eks = yield* AWS.EKS.Cluster("Orchestrator", {
    roleArn: eksRole.roleArn,
    // HyperPod trails the newest EKS Kubernetes version — pin one it
    // supports (1.28-1.35 today) rather than taking the EKS default.
    version: "1.34",
    resourcesVpcConfig: { subnetIds: network.privateSubnetIds },
    accessConfig: {
      authenticationMode: "API",
      bootstrapClusterCreatorAdminPermissions: true,
    },
  });

  // Lifecycle scripts are REQUIRED for EKS-orchestrated instance groups
  // (and Slurm continuous provisioning): every node runs its `OnCreate`
  // script from S3 when it boots.
  const lifecycleBucket = yield* AWS.S3.Bucket("EksLifecycleScripts", {
    forceDestroy: true,
  });
  const script = yield* UploadLifecycleScript({
    bucketName: lifecycleBucket.bucketName,
  });

  // The HyperPod instance role: the AWS-managed cluster-instance policy
  // plus the EKS-orchestration networking/ECR/pod-identity permissions
  // from the HyperPod IAM guide.
  const role = yield* AWS.IAM.Role("HyperPodEksInstanceRole", {
    assumeRolePolicyDocument: {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { Service: "sagemaker.amazonaws.com" },
          Action: ["sts:AssumeRole"],
        },
      ],
    },
    managedPolicyArns: [
      "arn:aws:iam::aws:policy/AmazonSageMakerClusterInstanceRolePolicy",
    ],
    inlinePolicies: {
      "hyperpod-eks-nodes": {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: [
              "ec2:AssignPrivateIpAddresses",
              "ec2:AttachNetworkInterface",
              "ec2:CreateNetworkInterface",
              "ec2:CreateNetworkInterfacePermission",
              "ec2:DeleteNetworkInterface",
              "ec2:DeleteNetworkInterfacePermission",
              "ec2:DescribeInstances",
              "ec2:DescribeInstanceTypes",
              "ec2:DescribeNetworkInterfaces",
              "ec2:DescribeTags",
              "ec2:DescribeVpcs",
              "ec2:DescribeDhcpOptions",
              "ec2:DescribeSubnets",
              "ec2:DescribeSecurityGroups",
              "ec2:DetachNetworkInterface",
              "ec2:ModifyNetworkInterfaceAttribute",
              "ec2:UnassignPrivateIpAddresses",
              "ecr:BatchCheckLayerAvailability",
              "ecr:BatchGetImage",
              "ecr:GetAuthorizationToken",
              "ecr:GetDownloadUrlForLayer",
              "eks-auth:AssumeRoleForPodIdentity",
            ],
            Resource: "*",
          },
          {
            Effect: "Allow",
            Action: ["ec2:CreateTags"],
            Resource: ["arn:aws:ec2:*:*:network-interface/*"],
          },
          {
            Effect: "Allow",
            Action: ["s3:GetObject", "s3:ListBucket"],
            Resource: [
              lifecycleBucket.bucketArn,
              Output.interpolate`${lifecycleBucket.bucketArn}/*`,
            ],
          },
        ],
      },
    },
  });

  // The HyperPod dependencies Helm chart (health-monitoring agent,
  // training operators, device plugins, RBAC) is MANDATORY — SageMaker
  // validates it and fails the cluster with "missing one or more required
  // dependencies" otherwise. Rendered locally and applied to the EKS
  // cluster before the HyperPod cluster attaches.
  const chart = yield* FetchHyperPodChart({
    repo: "https://github.com/aws/sagemaker-hyperpod-cli.git",
  });
  const dependencies = yield* AWS.EKS.HelmChart("HyperPodDependencies", {
    cluster: eks,
    chart: chart.chartPath,
    releaseName: "dependencies",
    namespace: "kube-system",
    values: {
      // The vendored legacy mpi-operator CRD fails Kubernetes >=1.34
      // strict server-side-apply validation, and MPI jobs aren't part of
      // this example.
      "mpi-operator": { enabled: false },
    },
  });

  // The HyperPod cluster, attached to the EKS control plane. SageMaker
  // creates the EKS access entry for the node role automatically.
  // `Output.all` holds the attach until the dependencies chart is applied.
  // Instance-group keys carry through to the cluster's attributes, so
  // workloads reference `hyperpod.instanceGroups.workers` — typed per key.
  const hyperpod = yield* AWS.SageMaker.Cluster("HyperPod", {
    orchestrator: {
      Eks: {
        ClusterArn: Output.map(
          Output.all(eks.clusterArn, dependencies.releaseName),
          ([clusterArn]) => clusterArn,
        ),
      },
    },
    vpcConfig: {
      // The EKS-managed cluster security group already allows node ↔
      // control-plane and intra-cluster traffic.
      SecurityGroupIds: [
        Output.map(
          eks.resourcesVpcConfig,
          (vpc) => vpc.clusterSecurityGroupId!,
        ),
      ],
      Subnets: network.privateSubnetIds,
    },
    instanceGroups: {
      workers: {
        InstanceType: "ml.t3.medium",
        InstanceCount: 1,
        ExecutionRole: role.roleArn,
        LifeCycleConfig: {
          SourceS3Uri: script.sourceS3Uri,
          OnCreate: script.onCreate,
        },
      },
    },
    // Node auto-replacement is not supported for CPU instances.
    nodeRecovery: "None",
    tags: { app: "aws-hyperpod-example" },
  });

  // Task governance (Kueue + the HyperPod scheduler) ships as an EKS
  // add-on. Deriving the cluster name from the HyperPod cluster's
  // orchestrator ARN (instead of using eks.clusterName directly) makes the
  // add-on deploy AFTER the HyperPod nodes join — its controllers need a
  // schedulable node.
  const governance = yield* AWS.EKS.Addon("TaskGovernance", {
    clusterName: Output.map(
      hyperpod.orchestratorEksClusterArn,
      (arn) => arn!.split("/").pop()!,
    ),
    addonName: "amazon-sagemaker-hyperpod-taskgovernance",
  });

  // The cluster policy: priority classes + fair-share arbitration.
  // `Output.all` makes the policy wait for the governance add-on (which
  // hosts the controllers that reconcile it) while still reading the
  // HyperPod cluster's ARN.
  const scheduler = yield* AWS.SageMaker.ClusterSchedulerConfig("Scheduler", {
    clusterArn: Output.map(
      Output.all(hyperpod.clusterArn, governance.addonArn),
      ([clusterArn]) => clusterArn,
    ),
    schedulerConfig: {
      PriorityClasses: [
        { Name: "inference", Weight: 100 },
        { Name: "training", Weight: 75 },
      ],
      FairShare: "Enabled",
    },
  });

  // The research team's quota. Creating it materializes the
  // `hyperpod-ns-research` namespace and its Kueue LocalQueue.
  const researchQuota = yield* AWS.SageMaker.ComputeQuota("ResearchQuota", {
    clusterArn: scheduler.clusterArn,
    computeQuotaTarget: { TeamName: "research", FairShareWeight: 10 },
    computeQuotaConfig: {
      ComputeQuotaResources: [{ InstanceType: "ml.t3.medium", Count: 1 }],
    },
  });

  return {
    network,
    eks,
    role,
    hyperpod,
    governance,
    scheduler,
    researchQuota,
  };
});
