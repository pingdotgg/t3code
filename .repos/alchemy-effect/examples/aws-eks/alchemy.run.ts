import * as STS from "@distilled.cloud/aws/sts";
import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as EC2 from "alchemy/AWS/EC2";
import * as EKS from "alchemy/AWS/EKS";
import * as Kubernetes from "alchemy/Kubernetes";
import * as Output from "alchemy/Output";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

const aws = AWS.providers();

const EKS_ADMIN_PRINCIPAL_ARN = Config.string("EKS_ADMIN_PRINCIPAL_ARN").pipe(
  Config.option,
  Config.map(Option.getOrUndefined),
);

const clusterName = "alchemy-eks-auto-example";
const namespace = "demo";
const serviceAccount = "pod-identity-demo";

const toIamPrincipalArn = (arn: string): string | undefined => {
  const assumedRole = arn.match(
    /^arn:([^:]+):sts::([0-9]{12}):assumed-role\/(.+)\/[^/]+$/,
  );
  if (assumedRole) {
    const [, partition, accountId, rolePath] = assumedRole;
    return `arn:${partition}:iam::${accountId}:role/${rolePath}`;
  }

  if (arn.includes(":role/") || arn.includes(":user/")) {
    return arn;
  }

  return undefined;
};

const resolveClusterAdminPrincipalArn = Effect.gen(function* () {
  const configured = yield* EKS_ADMIN_PRINCIPAL_ARN;
  if (configured) {
    return configured;
  }

  const caller = yield* STS.getCallerIdentity({});
  const principalArn =
    typeof caller.Arn === "string" ? toIamPrincipalArn(caller.Arn) : undefined;

  if (!principalArn) {
    return yield* Effect.fail(
      new Error(
        "Unable to infer an IAM principal ARN for cluster access. Set EKS_ADMIN_PRINCIPAL_ARN before deploy.",
      ),
    );
  }

  return principalArn;
});

export default Alchemy.Stack(
  "AwsEksExample",
  {
    providers: aws,
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const tags = {
      Example: "aws-eks",
      Surface: "eks",
      Mode: "auto",
    };

    const clusterAdminPrincipalArn = yield* resolveClusterAdminPrincipalArn;

    const network = yield* EC2.Network("Network", {
      cidrBlock: "10.42.0.0/16",
      availabilityZones: 2,
      nat: "single",
      tags,
    });

    const cluster = yield* EKS.AutoCluster("Cluster", {
      clusterName,
      network,
      tags,
    });

    const clusterAdmin = yield* EKS.AccessEntry("ClusterAdmin", {
      clusterName: cluster.cluster.clusterName,
      principalArn: clusterAdminPrincipalArn,
      accessPolicies: [
        {
          policyArn:
            "arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy",
          accessScope: {
            type: "cluster",
          },
        },
      ],
      tags,
    });

    const metricsServer = yield* EKS.Addon("MetricsServer", {
      clusterName: cluster.cluster.clusterName,
      addonName: "metrics-server",
      tags,
    });

    const snapshotController = yield* EKS.Addon("SnapshotController", {
      clusterName: cluster.cluster.clusterName,
      addonName: "snapshot-controller",
      tags,
    });

    const demoNamespace = yield* Kubernetes.Namespace("DemoNamespace", {
      cluster: cluster.cluster,
      name: namespace,
      labels: {
        "app.kubernetes.io/part-of": "aws-eks-example",
      },
    });

    const echoServer = yield* EKS.LoadBalancedWorkload("EchoServer", {
      cluster: cluster.cluster,
      namespace: demoNamespace,
      name: "echo-server",
      labels: {
        "app.kubernetes.io/name": "echo-server",
        "app.kubernetes.io/part-of": "aws-eks-example",
      },
      replicas: 2,
      containers: [
        {
          name: "echo-server",
          image: "registry.k8s.io/echoserver:1.10",
          ports: [
            {
              containerPort: 8080,
              name: "http",
            },
          ],
          resources: {
            requests: {
              cpu: "50m",
              memory: "64Mi",
            },
            limits: {
              cpu: "250m",
              memory: "128Mi",
            },
          },
        },
      ],
      ports: [
        {
          name: "http",
          port: 80,
          targetPort: 8080,
        },
      ],
    });

    const podIdentityWorkload = yield* EKS.PodIdentityWorkload(
      "PodIdentityDemo",
      {
        cluster: cluster.cluster,
        namespace: demoNamespace,
        name: "pod-identity-demo",
        serviceAccountName: serviceAccount,
        tags,
        serviceAccountLabels: {
          "app.kubernetes.io/name": serviceAccount,
          "app.kubernetes.io/part-of": "aws-eks-example",
        },
        labels: {
          "app.kubernetes.io/name": "pod-identity-demo",
          "app.kubernetes.io/part-of": "aws-eks-example",
        },
        containers: [
          {
            name: "aws-cli",
            image: "public.ecr.aws/aws-cli/aws-cli:2.17.37",
            command: ["/bin/sh", "-lc"],
            args: [
              [
                "while true; do",
                "  date;",
                "  aws sts get-caller-identity;",
                "  sleep 60;",
                "done",
              ].join(" "),
            ],
            resources: {
              requests: {
                cpu: "50m",
                memory: "64Mi",
              },
              limits: {
                cpu: "250m",
                memory: "128Mi",
              },
            },
          },
        ],
      },
    );

    const clusterInfoJob = yield* Kubernetes.Job("ClusterInfoJob", {
      cluster: cluster.cluster,
      namespace: demoNamespace,
      name: "cluster-info",
      labels: {
        "app.kubernetes.io/name": "cluster-info",
        "app.kubernetes.io/part-of": "aws-eks-example",
      },
      containers: [
        {
          name: "cluster-info",
          image: "public.ecr.aws/docker/library/busybox:1.36",
          command: ["/bin/sh", "-lc"],
          args: [
            [
              'echo "demo workload is running on EKS Auto Mode";',
              "nslookup echo-server.demo.svc.cluster.local || true;",
            ].join(" "),
          ],
        },
      ],
    });

    return {
      clusterName: cluster.cluster.clusterName,
      clusterArn: cluster.cluster.clusterArn,
      endpoint: cluster.cluster.endpoint,
      adminPrincipalArn: clusterAdmin.principalArn,
      namespace: demoNamespace.name,
      serviceAccount: podIdentityWorkload.serviceAccount.name,
      podIdentityAssociationArn:
        podIdentityWorkload.podIdentityAssociation.associationArn,
      workloadRoleArn: podIdentityWorkload.roleArn,
      metricsServerAddonArn: metricsServer.addonArn,
      snapshotControllerAddonArn: snapshotController.addonArn,
      echoDeploymentName: echoServer.deployment.name,
      echoServiceName: echoServer.service?.name,
      podIdentityDeploymentName: podIdentityWorkload.deployment.name,
      clusterInfoJobName: clusterInfoJob.name,
      accessSummary: Output.interpolate`Granted cluster-admin access on ${cluster.cluster.clusterName} to ${clusterAdmin.principalArn}.`,
      workloadSummary: Output.interpolate`Demo workloads are declared in TypeScript and reconciled into namespace ${demoNamespace.name} on ${cluster.cluster.clusterName}.`,
    };
  }).pipe(Effect.orDie),
);
