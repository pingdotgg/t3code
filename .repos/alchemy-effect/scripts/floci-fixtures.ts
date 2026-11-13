import { createHash, randomBytes, randomUUID } from "node:crypto";
/**
 * Standing prerequisites for the Floci-gated AWS suites (EKS, AMP scraper,
 * SageMaker HyperPod and endpoints, RDS proxy, ECS capacity providers, Flink,
 * custom domains, API Gateway VPC links, SES, OAM, Control Tower). They are
 * created through the emulated AWS APIs before `test:aws:floci` spawns the
 * suite, exported as the env vars the suites read, and removed after the run.
 *
 * Every call uses the credentials and Region of
 * `packages/aws/src/Local/FlociServices.ts` (access key `test`,
 * us-east-1): Floci scopes state by access key and Region, and that is what
 * the local providers and the test-body SDK clients use under
 * `ALCHEMY_TEST_DEV=1`. The OAM sink lives in a second emulator account,
 * selected by a 12-digit access key (Floci core/common/AccountResolver.java).
 */
import * as Floci from "@alchemy.run/aws/Local/Floci";
import * as acm from "@distilled.cloud/aws/acm";
import * as autoscaling from "@distilled.cloud/aws/auto-scaling";
import * as controltower from "@distilled.cloud/aws/controltower";
import { Credentials } from "@distilled.cloud/aws/Credentials";
import * as EC2 from "@distilled.cloud/aws/ec2";
import * as eks from "@distilled.cloud/aws/eks";
import * as elbv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import * as Endpoint from "@distilled.cloud/aws/Endpoint";
import * as iam from "@distilled.cloud/aws/iam";
import * as oam from "@distilled.cloud/aws/oam";
import { Region, type RegionName } from "@distilled.cloud/aws/Region";
import * as route53 from "@distilled.cloud/aws/route-53";
import * as s3 from "@distilled.cloud/aws/s3";
import * as sagemaker from "@distilled.cloud/aws/sagemaker";
import * as secretsmanager from "@distilled.cloud/aws/secrets-manager";
import * as ses from "@distilled.cloud/aws/ses";
import * as sesv2 from "@distilled.cloud/aws/sesv2";
import * as ssm from "@distilled.cloud/aws/ssm";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { FetchHttpClient } from "effect/http";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

export interface FlociStandingFixtures {
  readonly env: Record<string, string>;
  /** Removes every provisioned fixture, newest first. */
  readonly teardown: Effect.Effect<void, FixtureError, PlatformServices>;
}

export interface FlociStandingFixtureOptions {
  /** Selected test files (relative or absolute). Omit to provision every group. */
  readonly files?: ReadonlyArray<string>;
}

const NAME = "alchemy-floci-standing";
const FIXTURE_TAG_KEY = "alchemy-floci-fixture";
const FIXTURE_TAG_VALUE = "standing";
const VPC_CIDR = "10.250.0.0/16";
// Must match FLOCI_REGION / FLOCI_ACCOUNT_ID in
// packages/aws/src/Local/FlociServices.ts.
const REGION = "us-east-1" as RegionName;
const ACCOUNT_ID = "000000000000";
// Second emulator account for the cross-account OAM sink.
const OAM_SINK_ACCOUNT_ID = "111111111111";
const LANDING_ZONE_VERSION = "3.3";
// Legacy detective guardrail; Floci's control catalog registers it
// (services/controlcatalog/ControlCatalogService.java).
const CONTROL_ARN = `arn:aws:controltower:${REGION}::control/AWS-GR_ENCRYPTED_VOLUMES`;
// Floci accepts 3.0/4.0/5.0 for AWSControlTowerBaseline; 4.0 pairs with landing zone 3.3.
const BASELINE_VERSION = "4.0";
const FLINK_JAR_KEY = "flink/flink-examples-streaming-1.20.0-TopSpeedWindowing.jar";
const FLINK_JAR_URL =
  "https://repo1.maven.org/maven2/org/apache/flink/flink-examples-streaming/1.20.0/flink-examples-streaming-1.20.0-TopSpeedWindowing.jar";
const FLINK_JAR_SHA1 = "a9466bf8f379dce881d06236c752b84374abc54a";
const DOMAIN_ZONE = `${NAME}.test`;
const SES_ZONE = `${NAME}.example.com`;
const SES_REDIRECT_DOMAIN = `track.${SES_ZONE}`;
const SES_FROM = `${NAME}@example.com`;
// Default BounceSender of test/AWS/SES/handler.ts `/send-bounce`.
const SES_BOUNCE_SENDER = "mailer-daemon@ses-bindings.alchemy-test.example.com";
const SES_CVE_TEMPLATE = `${NAME}-cve`;
const SES_CVE_RECIPIENT = `${NAME}-cve-recipient@example.com`;
const SAGEMAKER_SERVE_IMAGE = "alchemy-floci/sagemaker-serve:1";
const log = (message: string) => Console.log(`test:aws:floci: ${message}`);

type Group =
  | "eksRole"
  | "eksCluster"
  | "amp"
  | "hyperpod"
  | "rdsProxy"
  | "ecsAsg"
  | "flink"
  | "domain"
  | "vpcLink"
  | "ses"
  | "oam"
  | "sagemakerEndpoint"
  | "controlTower";

const groupVars: Record<Group, ReadonlyArray<string>> = {
  eksRole: ["AWS_TEST_EKS_ROLE_ARN", "AWS_TEST_EKS_SUBNET_IDS"],
  eksCluster: [
    "AWS_TEST_EKS_CLUSTER",
    "AWS_TEST_EKS_PRIVATE_SUBNETS",
    "AWS_TEST_EKS_NODE_ROLE_ARN",
    "AWS_TEST_EKS_FARGATE_ROLE_ARN",
    "AWS_TEST_EKS_POD_ROLE_ARN",
  ],
  amp: [
    "AWS_TEST_AMP_SCRAPER",
    "AWS_TEST_AMP_SCRAPER_CLUSTER_ARN",
    "AWS_TEST_AMP_SCRAPER_SUBNET_IDS",
  ],
  hyperpod: ["AWS_TEST_SAGEMAKER_HYPERPOD_EKS_CLUSTER_ARN"],
  rdsProxy: [
    "AWS_TEST_RDS_DBPROXY",
    "DBPROXY_SUBNET_IDS",
    "DBPROXY_ROLE_ARN",
    "DBPROXY_SECRET_ARN",
  ],
  ecsAsg: ["TEST_ASG_ARN"],
  flink: ["AWS_TEST_FLINK_START", "AWS_TEST_FLINK_JAR_BUCKET_ARN", "AWS_TEST_FLINK_JAR_KEY"],
  domain: [
    "AWS_TEST_DOMAIN",
    "AWS_TEST_APIGATEWAY_DOMAIN",
    "AWS_TEST_ACM_CERTIFICATE_ARN",
    "AWS_TEST_APIGATEWAY_DOMAIN_NAME",
    "AWS_TEST_APIGATEWAY_CERT_ARN",
    "AWS_TEST_APIGATEWAYV2_DOMAIN_NAME",
    "AWS_TEST_APPSYNC_DOMAIN_NAME",
    "AWS_TEST_APPSYNC_DOMAIN_CERT_ARN",
    "AWS_TEST_HOSTED_ZONE",
  ],
  vpcLink: ["ALCHEMY_TEST_VPC_LINK_TARGET_ARN"],
  ses: [
    "AWS_TEST_SES_FROM",
    "AWS_TEST_SES_BOUNCE_MESSAGE_ID",
    "AWS_TEST_SES_CVE_TEMPLATE",
    "AWS_TEST_SES_CVE_RECIPIENT",
    "AWS_TEST_SES_REDIRECT_DOMAIN",
    "AWS_TEST_SES_VDM",
  ],
  oam: ["AWS_TEST_OAM_SINK_ARN"],
  sagemakerEndpoint: ["AWS_TEST_SAGEMAKER_ENDPOINT", "AWS_TEST_SAGEMAKER_IMAGE"],
  controlTower: [
    "AWS_TEST_CONTROLTOWER",
    "AWS_TEST_CONTROLTOWER_CONTROL",
    "AWS_TEST_CONTROLTOWER_BASELINE_VERSION",
  ],
};

// Suites (under packages/integration-tests/test/AWS) gated on each group's vars.
const groupSuites: Record<Group, ReadonlyArray<string>> = {
  eksRole: ["EKS/Cluster.test.ts", "EKS/ClusterBindings.test.ts"],
  eksCluster: [
    "EKS/AccessEntry.test.ts",
    "EKS/Addon.test.ts",
    "EKS/FargateProfile.test.ts",
    "EKS/Nodegroup.test.ts",
    "EKS/PodIdentityAssociation.test.ts",
  ],
  amp: ["AMP/Scraper.test.ts"],
  hyperpod: ["SageMaker/ClusterSchedulerConfig.test.ts", "SageMaker/ComputeQuota.test.ts"],
  rdsProxy: [
    "RDS/DBProxy.test.ts",
    "RDS/DBProxyEndpoint.test.ts",
    "RDS/DBProxyTargetGroup.test.ts",
  ],
  ecsAsg: ["ECS/CapacityProvider.test.ts", "ECS/CapacityProvider.smoke.test.ts"],
  flink: ["KinesisAnalyticsV2/ApplicationSnapshot.test.ts"],
  domain: [
    "ApiGateway/BasePathMapping.test.ts",
    "ApiGateway/DomainName.test.ts",
    "ApiGatewayV2/DomainName.test.ts",
    "AppSync/DomainName.test.ts",
    "ECS/ServiceDomain.test.ts",
    "Website/RouterHostnameBinding.test.ts",
  ],
  vpcLink: ["ApiGateway/VpcLink.test.ts"],
  ses: [
    "SES/Bindings.test.ts",
    "SES/ConfigurationSet.test.ts",
    "SES/CustomVerificationEmailTemplate.test.ts",
  ],
  oam: ["OAM/Sink.test.ts"],
  sagemakerEndpoint: ["SageMaker/Endpoint.test.ts", "SageMaker/EndpointBindings.test.ts"],
  controlTower: ["ControlTower/ControlTower.test.ts"],
};

export class FixtureError extends Data.TaggedError("FlociFixtureError")<{
  readonly message: string;
}> {}

const fixtureError = (message: string) => Effect.fail(new FixtureError({ message }));

const credentialsFor = (accessKeyId: string) =>
  Layer.succeed(
    Credentials,
    Effect.succeed({
      accessKeyId: Redacted.make(accessKeyId),
      secretAccessKey: Redacted.make("test"),
      sessionToken: undefined,
      region: REGION,
    }),
  );

const fixtureLayer = Layer.mergeAll(
  credentialsFor("test"),
  Layer.succeed(Region, Effect.succeed(REGION)),
  Endpoint.of(`http://localhost:${Floci.DEFAULT_FLOCI_PORT}`),
  FetchHttpClient.layer,
);

/** Platform services the caller provides (e.g. `NodeServices.layer`). */
type PlatformServices = Path.Path | ChildProcessSpawner.ChildProcessSpawner;

type Services = Layer.Success<typeof fixtureLayer> | PlatformServices;

interface Cleanup {
  readonly label: string;
  readonly run: Effect.Effect<void, unknown, Services>;
}

/** Runs `effect` as the second emulator account (Floci keys accounts by access key). */
const asSinkAccount = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(credentialsFor(OAM_SINK_ACCOUNT_ID)));

const register = (ledger: Array<Cleanup>, cleanup: Cleanup) =>
  Effect.sync(() => {
    ledger.push(cleanup);
  });

/** Runs cleanups newest-first, continuing past failures. */
const runCleanups = (ledger: Array<Cleanup>) =>
  Effect.gen(function* () {
    const failures: Array<string> = [];
    for (const cleanup of ledger.splice(0).reverse()) {
      const exit = yield* Effect.exit(cleanup.run);
      if (Exit.isFailure(exit)) {
        failures.push(`${cleanup.label}: ${Cause.pretty(exit.cause)}`);
      } else {
        yield* log(`removed ${cleanup.label}`);
      }
    }
    if (failures.length > 0) {
      return yield* fixtureError(`could not remove standing fixtures:\n${failures.join("\n")}`);
    }
  });

// ─── EC2 ─────────────────────────────────────────────────────────────────────

const nameTags = (name: string) => [
  { Key: "Name", Value: name },
  { Key: FIXTURE_TAG_KEY, Value: FIXTURE_TAG_VALUE },
];

const deleteVpc = (vpcId: string) =>
  EC2.deleteVpc({ VpcId: vpcId }).pipe(
    Effect.retry({
      while: (error) => error._tag === "DependencyViolation",
      schedule: Schedule.spaced("5 seconds"),
      times: 12,
    }),
    Effect.catchTag("InvalidVpcID.NotFound", () => Effect.void),
  );

const deleteSubnet = (subnetId: string) =>
  EC2.deleteSubnet({ SubnetId: subnetId }).pipe(
    Effect.retry({
      while: (error) => error._tag === "DependencyViolation",
      schedule: Schedule.spaced("5 seconds"),
      times: 12,
    }),
    Effect.catchTag("InvalidSubnetID.NotFound", () => Effect.void),
  );

const ensureVpc = (ledger: Array<Cleanup>) =>
  Effect.gen(function* () {
    const observed = yield* EC2.describeVpcs({
      Filters: [
        { Name: "tag:Name", Values: [NAME] },
        { Name: `tag:${FIXTURE_TAG_KEY}`, Values: [FIXTURE_TAG_VALUE] },
      ],
    });
    let vpcId = observed.Vpcs?.find((vpc) => vpc.CidrBlock === VPC_CIDR)?.VpcId;
    if (vpcId === undefined) {
      const created = yield* EC2.createVpc({
        CidrBlock: VPC_CIDR,
        TagSpecifications: [{ ResourceType: "vpc", Tags: nameTags(NAME) }],
      });
      vpcId = created.Vpc?.VpcId;
      if (vpcId === undefined) {
        return yield* fixtureError("CreateVpc returned no VpcId");
      }
    }
    const id = vpcId;
    yield* register(ledger, { label: `VPC ${id}`, run: deleteVpc(id) });
    return id;
  });

const ensurePrivateSubnet = (ledger: Array<Cleanup>, vpcId: string, index: number, zone: string) =>
  Effect.gen(function* () {
    const name = `${NAME}-private-${index + 1}`;
    const cidr = `10.250.${index + 1}.0/24`;
    const observed = yield* EC2.describeSubnets({
      Filters: [
        { Name: "vpc-id", Values: [vpcId] },
        { Name: "tag:Name", Values: [name] },
      ],
    });
    const existing = observed.Subnets?.find(
      (subnet) => subnet.VpcId === vpcId && subnet.SubnetId !== undefined,
    );
    if (
      existing?.SubnetId !== undefined &&
      existing.AvailabilityZone === zone &&
      existing.CidrBlock === cidr
    ) {
      const id = existing.SubnetId;
      yield* register(ledger, { label: `subnet ${id}`, run: deleteSubnet(id) });
      return id;
    }
    if (existing?.SubnetId !== undefined) {
      yield* deleteSubnet(existing.SubnetId);
    }
    const created = yield* EC2.createSubnet({
      VpcId: vpcId,
      CidrBlock: cidr,
      AvailabilityZone: zone,
      TagSpecifications: [{ ResourceType: "subnet", Tags: nameTags(name) }],
    });
    const id = created.Subnet?.SubnetId;
    if (id === undefined) {
      return yield* fixtureError("CreateSubnet returned no SubnetId");
    }
    yield* register(ledger, { label: `subnet ${id}`, run: deleteSubnet(id) });
    return id;
  });

interface Network {
  readonly vpcId: string;
  readonly subnetIds: ReadonlyArray<string>;
}

/** Two private subnets in two AZs; the VPC never gets an internet gateway. */
const ensureNetwork = (ledger: Array<Cleanup>) =>
  Effect.gen(function* () {
    const vpcId = yield* ensureVpc(ledger);
    const zones = yield* EC2.describeAvailabilityZones({});
    const names = (zones.AvailabilityZones ?? [])
      .filter((zone) => (zone.State ?? "available") === "available")
      .flatMap((zone) => (zone.ZoneName === undefined ? [] : [zone.ZoneName]))
      .sort();
    if (names.length < 2) {
      return yield* fixtureError(
        `${REGION} reports ${names.length} available zone(s); two are required`,
      );
    }
    const subnetIds = yield* Effect.forEach([0, 1], (index) =>
      ensurePrivateSubnet(ledger, vpcId, index, names[index]!),
    );
    const tables = yield* EC2.describeRouteTables({
      Filters: [{ Name: "vpc-id", Values: [vpcId] }],
    });
    const publicRoute = (tables.RouteTables ?? [])
      .filter((table) => table.VpcId === vpcId)
      .flatMap((table) => table.Routes ?? [])
      .find((route) => route.GatewayId?.startsWith("igw-"));
    if (publicRoute !== undefined) {
      return yield* fixtureError(
        `VPC ${vpcId} routes ${publicRoute.DestinationCidrBlock} to ${publicRoute.GatewayId}; the standing subnets must stay private`,
      );
    }
    const network: Network = { vpcId, subnetIds };
    return network;
  });

// ─── IAM ─────────────────────────────────────────────────────────────────────

const trustPolicy = (service: string, actions: ReadonlyArray<string>) =>
  JSON.stringify({
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Principal: { Service: service }, Action: actions }],
  });

const deleteRole = (roleName: string) =>
  Effect.gen(function* () {
    const attached = yield* iam.listAttachedRolePolicies({
      RoleName: roleName,
    });
    for (const policy of attached.AttachedPolicies ?? []) {
      if (policy.PolicyArn === undefined) continue;
      yield* iam
        .detachRolePolicy({ RoleName: roleName, PolicyArn: policy.PolicyArn })
        .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
    }
    yield* iam.deleteRole({ RoleName: roleName });
  }).pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));

const ensureRole = (
  ledger: Array<Cleanup>,
  suffix: string,
  service: string,
  actions: ReadonlyArray<string>,
  managedPolicies: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const roleName = `${NAME}-${suffix}`;
    const document = trustPolicy(service, actions);
    const getRole = iam
      .getRole({ RoleName: roleName })
      .pipe(Effect.map((response) => response.Role));
    const existing = yield* getRole.pipe(
      Effect.catchTag("NoSuchEntityException", () => Effect.undefined),
    );
    const role =
      existing === undefined
        ? yield* iam
            .createRole({
              RoleName: roleName,
              AssumeRolePolicyDocument: document,
              Tags: [{ Key: FIXTURE_TAG_KEY, Value: FIXTURE_TAG_VALUE }],
            })
            .pipe(
              Effect.map((response) => response.Role),
              Effect.catchTag("EntityAlreadyExistsException", () => getRole),
            )
        : existing;
    yield* register(ledger, {
      label: `IAM role ${roleName}`,
      run: deleteRole(roleName),
    });
    if (existing !== undefined) {
      yield* iam.updateAssumeRolePolicy({
        RoleName: roleName,
        PolicyDocument: document,
      });
    }
    // Floci resolves managed policy ARNs against the published catalog
    // (services/iam/AwsManagedPolicies.java), so a typo fails here.
    for (const policy of managedPolicies) {
      yield* iam.attachRolePolicy({
        RoleName: roleName,
        PolicyArn: `arn:aws:iam::aws:policy/${policy}`,
      });
    }
    return role.Arn;
  });

// ─── EKS ─────────────────────────────────────────────────────────────────────

const findEksCluster = eks.describeCluster({ name: NAME }).pipe(
  Effect.map((response) => response.cluster),
  Effect.catchTag("ResourceNotFoundException", () => Effect.undefined),
);

const deleteEksCluster = Effect.gen(function* () {
  yield* eks
    .deleteCluster({ name: NAME })
    .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.void));
  const remaining = yield* findEksCluster.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (cluster): boolean => cluster === undefined,
      times: 60,
    }),
  );
  if (remaining !== undefined) {
    return yield* fixtureError(`EKS cluster ${NAME} is still ${remaining.status} after deletion`);
  }
});

const ensureEksCluster = (ledger: Array<Cleanup>, network: Network, roleArn: string) =>
  Effect.gen(function* () {
    const existing = yield* findEksCluster;
    const reusable =
      existing !== undefined &&
      existing.status !== "FAILED" &&
      existing.status !== "DELETING" &&
      existing.roleArn === roleArn &&
      existing.resourcesVpcConfig?.vpcId === network.vpcId &&
      existing.accessConfig?.authenticationMode === "API_AND_CONFIG_MAP";
    yield* register(ledger, {
      label: `EKS cluster ${NAME}`,
      run: deleteEksCluster,
    });
    if (existing !== undefined && !reusable) {
      yield* log(`replacing EKS cluster ${NAME} (${existing.status})`);
      yield* deleteEksCluster;
    }
    if (!reusable) {
      yield* log(`creating EKS cluster ${NAME} (waits for ACTIVE)`);
      yield* eks
        .createCluster({
          name: NAME,
          roleArn,
          resourcesVpcConfig: {
            subnetIds: [...network.subnetIds],
            endpointPublicAccess: true,
            endpointPrivateAccess: true,
          },
          accessConfig: { authenticationMode: "API_AND_CONFIG_MAP" },
          tags: { [FIXTURE_TAG_KEY]: FIXTURE_TAG_VALUE },
        })
        .pipe(Effect.catchTag("ResourceInUseException", () => Effect.void));
    }
    // Floci boots a k3s container and flips CREATING -> ACTIVE once its API
    // server answers (services/eks/EksService.java startReadinessPoller).
    const cluster = yield* findEksCluster.pipe(
      Effect.repeat({
        schedule: Schedule.spaced("5 seconds"),
        until: (cluster): boolean =>
          cluster?.status === undefined ||
          cluster.status === "ACTIVE" ||
          cluster.status === "FAILED",
        times: 120,
      }),
    );
    if (cluster?.status !== "ACTIVE" || cluster.arn === undefined) {
      return yield* fixtureError(
        `EKS cluster ${NAME} did not become ACTIVE within 10 minutes (status: ${cluster?.status ?? "missing"})`,
      );
    }
    return {
      name: NAME,
      arn: cluster.arn,
      securityGroupId: cluster.resourcesVpcConfig?.clusterSecurityGroupId,
      created: !reusable,
    };
  });

// ─── SageMaker HyperPod ──────────────────────────────────────────────────────

// DescribeCluster has no typed not-found tag in distilled; observe by listing.
const findHyperPodCluster = sagemaker
  .listClusters({ NameContains: NAME })
  .pipe(
    Effect.map((response) =>
      response.ClusterSummaries.find((summary) => summary.ClusterName === NAME),
    ),
  );

const deleteHyperPodCluster = Effect.gen(function* () {
  yield* sagemaker.deleteCluster({ ClusterName: NAME }).pipe(
    Effect.retry({
      while: (error) => error._tag === "ConflictException",
      schedule: Schedule.spaced("3 seconds"),
      times: 20,
    }),
    Effect.catchTag("ResourceNotFound", () => Effect.void),
  );
  const remaining = yield* findHyperPodCluster.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (cluster): boolean => cluster === undefined,
      times: 40,
    }),
  );
  if (remaining !== undefined) {
    return yield* fixtureError(
      `HyperPod cluster ${NAME} is still ${remaining.ClusterStatus} after deletion`,
    );
  }
});

const ensureHyperPodCluster = (
  ledger: Array<Cleanup>,
  eksCluster: {
    readonly arn: string;
    readonly securityGroupId: string | undefined;
    readonly created: boolean;
  },
  subnetIds: ReadonlyArray<string>,
  executionRoleArn: string,
) =>
  Effect.gen(function* () {
    if (eksCluster.securityGroupId === undefined) {
      return yield* fixtureError(`EKS cluster ${NAME} reports no cluster security group`);
    }
    const existing = yield* findHyperPodCluster;
    yield* register(ledger, {
      label: `SageMaker HyperPod cluster ${NAME}`,
      run: deleteHyperPodCluster,
    });
    const reusable =
      existing !== undefined &&
      !eksCluster.created &&
      !["Failed", "Deleting", "RollingBack"].includes(existing.ClusterStatus);
    if (existing !== undefined && !reusable) {
      yield* log(`replacing HyperPod cluster ${NAME} (${existing.ClusterStatus})`);
      yield* deleteHyperPodCluster;
    }
    if (!reusable) {
      // EKS-orchestrated groups need no lifecycle scripts; Floci validates the
      // execution role and an ACTIVE API_AND_CONFIG_MAP EKS cluster
      // (services/sagemaker/SageMakerHyperPodService.java).
      yield* sagemaker
        .createCluster({
          ClusterName: NAME,
          Orchestrator: { Eks: { ClusterArn: eksCluster.arn } },
          InstanceGroups: [
            {
              InstanceGroupName: "standing",
              InstanceType: "ml.t3.medium",
              InstanceCount: 1,
              ExecutionRole: executionRoleArn,
            },
          ],
          VpcConfig: {
            SecurityGroupIds: [eksCluster.securityGroupId],
            Subnets: [...subnetIds],
          },
          NodeRecovery: "Automatic",
          Tags: [{ Key: FIXTURE_TAG_KEY, Value: FIXTURE_TAG_VALUE }],
        })
        .pipe(Effect.catchTag("ResourceInUse", () => Effect.void));
    }
    const cluster = yield* findHyperPodCluster.pipe(
      Effect.repeat({
        schedule: Schedule.spaced("3 seconds"),
        until: (cluster): boolean =>
          cluster?.ClusterStatus !== "Creating" && cluster?.ClusterStatus !== "Updating",
        times: 40,
      }),
    );
    if (cluster?.ClusterStatus !== "InService") {
      return yield* fixtureError(
        `HyperPod cluster ${NAME} did not reach InService (status: ${cluster?.ClusterStatus ?? "missing"})`,
      );
    }
    return cluster.ClusterArn;
  });

// ─── RDS proxy ───────────────────────────────────────────────────────────────

const RDS_PROXY_SECRET = `${NAME}-rds-proxy`;

const ensureRdsProxySecret = (ledger: Array<Cleanup>) =>
  Effect.gen(function* () {
    const password = yield* Effect.sync(() => randomBytes(24).toString("base64url"));
    const arn = yield* secretsmanager
      .createSecret({
        Name: RDS_PROXY_SECRET,
        Description: "Standing DB proxy credentials for the Floci test run",
        SecretString: JSON.stringify({ username: "alchemy", password }),
        Tags: [{ Key: FIXTURE_TAG_KEY, Value: FIXTURE_TAG_VALUE }],
      })
      .pipe(
        Effect.map((response) => response.ARN),
        Effect.catchTag("ResourceExistsException", () =>
          secretsmanager
            .describeSecret({ SecretId: RDS_PROXY_SECRET })
            .pipe(Effect.map((response) => response.ARN)),
        ),
      );
    if (arn === undefined) {
      return yield* fixtureError(`secret ${RDS_PROXY_SECRET} has no ARN`);
    }
    yield* register(ledger, {
      label: `secret ${RDS_PROXY_SECRET}`,
      run: secretsmanager
        .deleteSecret({ SecretId: arn, ForceDeleteWithoutRecovery: true })
        .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.void)),
    });
    return arn;
  });

// ─── Auto Scaling (ECS capacity providers) ───────────────────────────────────

const ECS_ASG = `${NAME}-ecs`;
const AL2023_AMI_PARAMETER =
  "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64";

const findAutoScalingGroup = autoscaling
  .describeAutoScalingGroups({ AutoScalingGroupNames: [ECS_ASG] })
  .pipe(Effect.map((response) => response.AutoScalingGroups[0]));

const findLaunchConfiguration = autoscaling
  .describeLaunchConfigurations({ LaunchConfigurationNames: [ECS_ASG] })
  .pipe(Effect.map((response) => response.LaunchConfigurations[0]));

// Floci answers a missing group or launch configuration with an untyped
// ValidationError, so every delete observes first.
const deleteAutoScalingGroup = Effect.gen(function* () {
  if ((yield* findAutoScalingGroup) !== undefined) {
    yield* autoscaling
      .deleteAutoScalingGroup({
        AutoScalingGroupName: ECS_ASG,
        ForceDelete: true,
      })
      .pipe(
        Effect.retry({
          while: (error) =>
            error._tag === "ScalingActivityInProgressFault" ||
            error._tag === "ResourceInUseFault" ||
            error._tag === "ResourceContentionFault",
          schedule: Schedule.spaced("5 seconds"),
          times: 12,
        }),
      );
  }
  const remaining = yield* findAutoScalingGroup.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (group): boolean => group === undefined,
      times: 24,
    }),
  );
  if (remaining !== undefined) {
    return yield* fixtureError(`Auto Scaling group ${ECS_ASG} still exists`);
  }
});

const deleteLaunchConfiguration = Effect.gen(function* () {
  if ((yield* findLaunchConfiguration) === undefined) return;
  yield* autoscaling.deleteLaunchConfiguration({ LaunchConfigurationName: ECS_ASG }).pipe(
    Effect.retry({
      while: (error) =>
        error._tag === "ResourceInUseFault" || error._tag === "ResourceContentionFault",
      schedule: Schedule.spaced("5 seconds"),
      times: 12,
    }),
  );
});

const ensureEcsAutoScalingGroup = (ledger: Array<Cleanup>, network: Network) =>
  Effect.gen(function* () {
    // Floci resolves the public AMI parameter from its image catalog
    // (services/ssm/SsmService.java publicParameter).
    const parameter = yield* ssm.getParameter({ Name: AL2023_AMI_PARAMETER });
    const value = parameter.Parameter?.Value;
    const imageId = Redacted.isRedacted(value) ? Redacted.value(value) : value;
    if (imageId === undefined) {
      return yield* fixtureError(`${AL2023_AMI_PARAMETER} has no value`);
    }
    yield* register(ledger, {
      label: `launch configuration ${ECS_ASG}`,
      run: deleteLaunchConfiguration,
    });
    if ((yield* findLaunchConfiguration) === undefined) {
      yield* autoscaling
        .createLaunchConfiguration({
          LaunchConfigurationName: ECS_ASG,
          ImageId: imageId,
          InstanceType: "t3.micro",
        })
        .pipe(Effect.catchTag("AlreadyExistsFault", () => Effect.void));
    }
    yield* register(ledger, {
      label: `Auto Scaling group ${ECS_ASG}`,
      run: deleteAutoScalingGroup,
    });
    if ((yield* findAutoScalingGroup) === undefined) {
      yield* autoscaling
        .createAutoScalingGroup({
          AutoScalingGroupName: ECS_ASG,
          LaunchConfigurationName: ECS_ASG,
          MinSize: 0,
          MaxSize: 0,
          DesiredCapacity: 0,
          VPCZoneIdentifier: network.subnetIds.join(","),
          Tags: [
            {
              Key: FIXTURE_TAG_KEY,
              Value: FIXTURE_TAG_VALUE,
              PropagateAtLaunch: true,
            },
          ],
        })
        .pipe(Effect.catchTag("AlreadyExistsFault", () => Effect.void));
    }
    const group = yield* findAutoScalingGroup;
    if (group?.AutoScalingGroupARN === undefined) {
      return yield* fixtureError(`Auto Scaling group ${ECS_ASG} has no ARN`);
    }
    return group.AutoScalingGroupARN;
  });

// ─── Network Load Balancer (API Gateway VPC link) ────────────────────────────

const VPC_LINK_NLB = `${NAME}-nlb`;

const findLoadBalancer = elbv2.describeLoadBalancers({ Names: [VPC_LINK_NLB] }).pipe(
  Effect.map((response) => response.LoadBalancers?.[0]),
  Effect.catchTag("LoadBalancerNotFoundException", () => Effect.undefined),
);

const deleteLoadBalancer = Effect.gen(function* () {
  const existing = yield* findLoadBalancer;
  if (existing?.LoadBalancerArn === undefined) return;
  yield* elbv2.deleteLoadBalancer({ LoadBalancerArn: existing.LoadBalancerArn }).pipe(
    Effect.retry({
      while: (error) => error._tag === "ResourceInUseException",
      schedule: Schedule.spaced("5 seconds"),
      times: 12,
    }),
    Effect.catchTag("LoadBalancerNotFoundException", () => Effect.void),
  );
  const remaining = yield* findLoadBalancer.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (balancer): boolean => balancer === undefined,
      times: 20,
    }),
  );
  if (remaining !== undefined) {
    return yield* fixtureError(`load balancer ${VPC_LINK_NLB} still exists`);
  }
});

const ensureVpcLinkLoadBalancer = (ledger: Array<Cleanup>, network: Network) =>
  Effect.gen(function* () {
    yield* register(ledger, {
      label: `load balancer ${VPC_LINK_NLB}`,
      run: deleteLoadBalancer,
    });
    const existing = yield* findLoadBalancer;
    const balancer =
      existing ??
      (yield* elbv2
        .createLoadBalancer({
          Name: VPC_LINK_NLB,
          Type: "network",
          Scheme: "internal",
          Subnets: [...network.subnetIds],
          Tags: [{ Key: FIXTURE_TAG_KEY, Value: FIXTURE_TAG_VALUE }],
        })
        .pipe(
          Effect.map((response) => response.LoadBalancers?.[0]),
          Effect.catchTag("DuplicateLoadBalancerNameException", () => findLoadBalancer),
        ));
    if (balancer?.LoadBalancerArn === undefined) {
      return yield* fixtureError(`load balancer ${VPC_LINK_NLB} has no ARN`);
    }
    if (balancer.Type !== "network" || balancer.VpcId !== network.vpcId) {
      return yield* fixtureError(
        `load balancer ${VPC_LINK_NLB} exists as ${balancer.Type} in ${balancer.VpcId}; delete it and rerun`,
      );
    }
    return balancer.LoadBalancerArn;
  });

// ─── S3 (Flink application code) ─────────────────────────────────────────────

const FLINK_BUCKET = `${NAME}-flink`;

const deleteBucket = (bucket: string) =>
  Effect.gen(function* () {
    // Bounded pagination: the fixture bucket holds a single object.
    for (let page = 0; page < 10; page++) {
      const listed = yield* s3.listObjectsV2({ Bucket: bucket });
      const objects = (listed.Contents ?? []).flatMap((object) =>
        object.Key ? [{ Key: object.Key }] : [],
      );
      if (objects.length === 0) break;
      yield* s3.deleteObjects({
        Bucket: bucket,
        Delete: { Objects: objects, Quiet: true },
      });
      if (!listed.IsTruncated) break;
    }
    yield* s3.deleteBucket({ Bucket: bucket });
  }).pipe(Effect.catchTag("NoSuchBucket", () => Effect.void));

const downloadFlinkJar = Effect.gen(function* () {
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const response = yield* client
    .get(FLINK_JAR_URL)
    .pipe(Effect.retry({ schedule: Schedule.exponential("1 second"), times: 3 }));
  const bytes = new Uint8Array(yield* response.arrayBuffer);
  const sha1 = yield* Effect.sync(() => createHash("sha1").update(bytes).digest("hex"));
  if (sha1 !== FLINK_JAR_SHA1) {
    return yield* fixtureError(`${FLINK_JAR_URL} has sha1 ${sha1}, expected ${FLINK_JAR_SHA1}`);
  }
  return bytes;
}).pipe(
  Effect.catchTags({
    HttpClientError: (error) =>
      fixtureError(`could not download ${FLINK_JAR_URL}: ${error.message}`),
  }),
);

const ensureFlinkJar = (ledger: Array<Cleanup>) =>
  Effect.gen(function* () {
    const jar = yield* downloadFlinkJar;
    const exists = yield* s3.headBucket({ Bucket: FLINK_BUCKET }).pipe(
      Effect.as(true),
      Effect.catchTag(["NotFound", "NoSuchBucket"], () => Effect.succeed(false)),
    );
    yield* register(ledger, {
      label: `S3 bucket ${FLINK_BUCKET}`,
      run: deleteBucket(FLINK_BUCKET),
    });
    if (!exists) {
      yield* s3
        .createBucket({ Bucket: FLINK_BUCKET })
        .pipe(Effect.catchTag("BucketAlreadyOwnedByYou", () => Effect.void));
    }
    yield* s3.putObject({
      Bucket: FLINK_BUCKET,
      Key: FLINK_JAR_KEY,
      Body: jar,
      ContentType: "application/java-archive",
    });
    return `arn:aws:s3:::${FLINK_BUCKET}`;
  });

// ─── Route 53 + ACM ──────────────────────────────────────────────────────────

const trimDot = (name: string) => name.replace(/\.+$/, "");
const zoneIdOf = (id: string) => id.replace(/^\/hostedzone\//, "");

const findPublicZone = (name: string) =>
  route53
    .listHostedZonesByName({ DNSName: name })
    .pipe(
      Effect.map((response) =>
        (response.HostedZones ?? []).find(
          (zone) => trimDot(zone.Name) === name && !zone.Config?.PrivateZone,
        ),
      ),
    );

const listRecordSets = (zoneId: string) =>
  Effect.gen(function* () {
    const records: Array<route53.ResourceRecordSet> = [];
    let start: Pick<
      route53.ListResourceRecordSetsRequest,
      "StartRecordName" | "StartRecordType" | "StartRecordIdentifier"
    > = {};
    for (let page = 0; page < 50; page++) {
      const response = yield* route53.listResourceRecordSets({
        HostedZoneId: zoneId,
        ...start,
      });
      records.push(...(response.ResourceRecordSets ?? []));
      if (!response.IsTruncated) break;
      start = {
        StartRecordName: response.NextRecordName,
        StartRecordType: response.NextRecordType,
        StartRecordIdentifier: response.NextRecordIdentifier,
      };
    }
    return records;
  });

/** Deletes every record except the apex SOA/NS, then the zone. */
const deleteZone = (zoneId: string, name: string) =>
  Effect.gen(function* () {
    const doomed = (yield* listRecordSets(zoneId)).filter(
      (record) =>
        !(trimDot(record.Name) === name && (record.Type === "SOA" || record.Type === "NS")),
    );
    if (doomed.length > 0) {
      yield* route53.changeResourceRecordSets({
        HostedZoneId: zoneId,
        ChangeBatch: {
          Changes: doomed.map((record) => ({
            Action: "DELETE",
            ResourceRecordSet: record,
          })),
        },
      });
    }
    yield* route53.deleteHostedZone({ Id: zoneId });
  }).pipe(Effect.catchTag("NoSuchHostedZone", () => Effect.void));

const ensurePublicZone = (ledger: Array<Cleanup>, name: string) =>
  Effect.gen(function* () {
    const existing = yield* findPublicZone(name);
    let zoneId = existing === undefined ? undefined : zoneIdOf(existing.Id);
    if (zoneId === undefined) {
      const reference = yield* Effect.sync(() => randomUUID());
      const created = yield* route53.createHostedZone({
        Name: name,
        CallerReference: `${NAME}-${reference}`,
        HostedZoneConfig: {
          Comment: "Standing fixture zone for the Floci test run",
          PrivateZone: false,
        },
      });
      zoneId = zoneIdOf(created.HostedZone.Id);
    }
    const id = zoneId;
    yield* register(ledger, {
      label: `hosted zone ${name}`,
      run: deleteZone(id, name),
    });
    return id;
  });

const upsertCnames = (
  zoneId: string,
  records: ReadonlyArray<{ readonly name: string; readonly value: string }>,
) =>
  route53.changeResourceRecordSets({
    HostedZoneId: zoneId,
    ChangeBatch: {
      Changes: records.map((record) => ({
        Action: "UPSERT",
        ResourceRecordSet: {
          Name: record.name,
          Type: "CNAME",
          TTL: 300,
          ResourceRecords: [{ Value: record.value }],
        },
      })),
    },
  });

const describeCertificate = (arn: string) =>
  acm
    .describeCertificate({ CertificateArn: arn })
    .pipe(Effect.map((response) => response.Certificate));

const ensureZoneCertificate = (ledger: Array<Cleanup>, zoneId: string, zone: string) =>
  Effect.gen(function* () {
    const wildcard = `*.${zone}`;
    const summaries = yield* acm.listCertificates.pages({}).pipe(
      Stream.runCollect,
      Effect.map((pages) => Array.from(pages).flatMap((page) => page.CertificateSummaryList ?? [])),
    );
    const existing = summaries.find(
      (summary) =>
        summary.DomainName === zone &&
        (summary.SubjectAlternativeNameSummaries ?? []).includes(wildcard) &&
        (summary.Status === "ISSUED" || summary.Status === "PENDING_VALIDATION"),
    );
    const arn =
      existing?.CertificateArn ??
      (yield* acm
        .requestCertificate({
          DomainName: zone,
          SubjectAlternativeNames: [wildcard],
          ValidationMethod: "DNS",
          Tags: [{ Key: FIXTURE_TAG_KEY, Value: FIXTURE_TAG_VALUE }],
        })
        .pipe(Effect.map((response) => response.CertificateArn)));
    if (arn === undefined) {
      return yield* fixtureError(`RequestCertificate for ${zone} returned no ARN`);
    }
    const certificateArn = arn;
    yield* register(ledger, {
      label: `ACM certificate ${certificateArn}`,
      run: acm.deleteCertificate({ CertificateArn: certificateArn }).pipe(
        Effect.retry({
          while: (error) => error._tag === "ResourceInUseException",
          schedule: Schedule.spaced("5 seconds"),
          times: 12,
        }),
        Effect.catchTag("ResourceNotFoundException", () => Effect.void),
      ),
    });
    // The zone and its wildcard can share one validation record.
    const pending = yield* describeCertificate(certificateArn).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (certificate): boolean =>
          certificate?.Status === "ISSUED" ||
          (certificate?.DomainValidationOptions ?? []).every(
            (option) => option.ResourceRecord !== undefined,
          ),
        times: 15,
      }),
    );
    const records = new Map<string, { name: string; value: string }>();
    for (const option of pending?.DomainValidationOptions ?? []) {
      const record = option.ResourceRecord;
      if (record === undefined || record.Type !== "CNAME") continue;
      records.set(`${record.Name}|${record.Value}`, {
        name: record.Name,
        value: record.Value,
      });
    }
    if (pending?.Status !== "ISSUED") {
      if (records.size === 0) {
        return yield* fixtureError(
          `certificate ${certificateArn} exposes no DNS validation records`,
        );
      }
      yield* upsertCnames(zoneId, [...records.values()]);
    }
    // Floci settles DNS validation when the certificate is read
    // (services/acm/AcmService.java settleValidation).
    const issued = yield* describeCertificate(certificateArn).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("3 seconds"),
        until: (certificate): boolean => certificate?.Status !== "PENDING_VALIDATION",
        times: 40,
      }),
    );
    if (issued?.Status !== "ISSUED") {
      return yield* fixtureError(
        `certificate ${certificateArn} is ${issued?.Status ?? "missing"}, not ISSUED`,
      );
    }
    return certificateArn;
  });

// ─── SES ─────────────────────────────────────────────────────────────────────

// v1 DeleteIdentity is idempotent for missing identities.
const deleteSesIdentity = (identity: string) => ses.deleteIdentity({ Identity: identity });

/** A v1-verified email address (Floci verifies without the email round trip). */
const ensureVerifiedAddress = (ledger: Array<Cleanup>, address: string) =>
  Effect.gen(function* () {
    yield* register(ledger, {
      label: `SES identity ${address}`,
      run: deleteSesIdentity(address),
    });
    yield* ses.verifyEmailIdentity({ EmailAddress: address });
  });

const ensureDkimVerifiedDomain = (ledger: Array<Cleanup>, zoneId: string, domain: string) =>
  Effect.gen(function* () {
    yield* register(ledger, {
      label: `SES identity ${domain}`,
      run: deleteSesIdentity(domain),
    });
    const getIdentity = sesv2.getEmailIdentity({ EmailIdentity: domain });
    const identity = yield* sesv2
      .createEmailIdentity({
        EmailIdentity: domain,
        Tags: [{ Key: FIXTURE_TAG_KEY, Value: FIXTURE_TAG_VALUE }],
      })
      .pipe(Effect.catchTag("AlreadyExistsException", () => getIdentity));
    const tokens = identity.DkimAttributes?.Tokens ?? [];
    if (tokens.length === 0) {
      return yield* fixtureError(`SES identity ${domain} has no DKIM tokens`);
    }
    yield* upsertCnames(
      zoneId,
      tokens.map((token) => ({
        name: `${token}._domainkey.${domain}`,
        value: `${token}.dkim.amazonses.com`,
      })),
    );
    // Floci re-checks the CNAMEs on read with a 5s lookup cache
    // (services/ses/SesIdentityService.java hasAllExpectedDkimRecords).
    const verified = yield* getIdentity.pipe(
      Effect.repeat({
        schedule: Schedule.spaced("3 seconds"),
        until: (observed): boolean => observed.VerifiedForSendingStatus === true,
        times: 20,
      }),
    );
    if (verified.VerifiedForSendingStatus !== true) {
      return yield* fixtureError(
        `SES identity ${domain} is not verified for sending (DKIM ${verified.DkimAttributes?.Status})`,
      );
    }
  });

const ensureCustomVerificationTemplate = (ledger: Array<Cleanup>) =>
  Effect.gen(function* () {
    yield* register(ledger, {
      label: `SES custom verification template ${SES_CVE_TEMPLATE}`,
      run: sesv2
        .deleteCustomVerificationEmailTemplate({
          TemplateName: SES_CVE_TEMPLATE,
        })
        .pipe(Effect.catchTag("NotFoundException", () => Effect.void)),
    });
    // The gated send registers the recipient as a pending identity.
    yield* register(ledger, {
      label: `SES identity ${SES_CVE_RECIPIENT}`,
      run: deleteSesIdentity(SES_CVE_RECIPIENT),
    });
    yield* sesv2
      .createCustomVerificationEmailTemplate({
        TemplateName: SES_CVE_TEMPLATE,
        FromEmailAddress: SES_FROM,
        TemplateSubject: "Confirm your email address",
        TemplateContent:
          "<html><body><p>Confirm your address for the Alchemy Floci tests.</p></body></html>",
        SuccessRedirectionURL: "https://example.com/verified",
        FailureRedirectionURL: "https://example.com/verify-failed",
      })
      .pipe(Effect.catchTag("AlreadyExistsException", () => Effect.void));
  });

const ensureVdmEnabled = (ledger: Array<Cleanup>) =>
  Effect.gen(function* () {
    const account = yield* sesv2.getAccount({});
    const previous: sesv2.VdmAttributes = account.VdmAttributes ?? {
      VdmEnabled: "DISABLED",
    };
    yield* register(ledger, {
      label: `SES VDM restore (${previous.VdmEnabled})`,
      run: sesv2.putAccountVdmAttributes({ VdmAttributes: previous }),
    });
    yield* sesv2.putAccountVdmAttributes({
      VdmAttributes: { ...previous, VdmEnabled: "ENABLED" },
    });
  });

const ensureSesFixtures = (ledger: Array<Cleanup>) =>
  Effect.gen(function* () {
    yield* ensureVerifiedAddress(ledger, SES_FROM);
    // The bounce sender must be verified for the gated SendBounce success
    // path; a fabricated message id is still rejected with MessageRejected.
    yield* ensureVerifiedAddress(ledger, SES_BOUNCE_SENDER);
    // Floci bounces any message it recorded (services/ses/SesService.java sendBounce).
    const sent = yield* sesv2.sendEmail({
      FromEmailAddress: SES_FROM,
      Destination: { ToAddresses: ["success@simulator.amazonses.com"] },
      Content: {
        Simple: {
          Subject: { Data: "Alchemy Floci standing bounce source" },
          Body: { Text: { Data: "Original message for the SendBounce test." } },
        },
      },
    });
    if (sent.MessageId === undefined) {
      return yield* fixtureError("SendEmail returned no MessageId");
    }
    yield* ensureCustomVerificationTemplate(ledger);
    const zoneId = yield* ensurePublicZone(ledger, SES_ZONE);
    yield* ensureDkimVerifiedDomain(ledger, zoneId, SES_REDIRECT_DOMAIN);
    yield* ensureVdmEnabled(ledger);
    return { bounceMessageId: sent.MessageId };
  });

// ─── OAM (second account) ────────────────────────────────────────────────────

const OAM_RESOURCE_TYPES = ["AWS::CloudWatch::Metric", "AWS::Logs::LogGroup", "AWS::XRay::Trace"];

const findSink = asSinkAccount(
  oam
    .listSinks({})
    .pipe(
      Effect.map(
        (response) => response.Items.find((sink) => sink.Name === NAME) ?? response.Items[0],
      ),
    ),
);

const ensureOamSink = (ledger: Array<Cleanup>) =>
  Effect.gen(function* () {
    const existing = yield* findSink;
    const arn =
      existing?.Arn ??
      (yield* asSinkAccount(
        oam
          .createSink({
            Name: NAME,
            Tags: { [FIXTURE_TAG_KEY]: FIXTURE_TAG_VALUE },
          })
          .pipe(
            Effect.map((response) => response.Arn),
            // Floci allows one sink per account and Region.
            Effect.catchTag("ConflictException", () =>
              findSink.pipe(Effect.map((sink) => sink?.Arn)),
            ),
          ),
      ));
    if (arn === undefined) {
      return yield* fixtureError(`OAM sink ${NAME} has no ARN`);
    }
    const sinkArn = arn;
    yield* register(ledger, {
      label: `OAM sink ${sinkArn}`,
      run: asSinkAccount(
        oam.deleteSink({ Identifier: sinkArn }).pipe(
          // Links from the test account must be gone first.
          Effect.retry({
            while: (error) => error._tag === "ConflictException",
            schedule: Schedule.spaced("3 seconds"),
            times: 20,
          }),
          Effect.catchTag("ResourceNotFoundException", () => Effect.void),
        ),
      ),
    });
    yield* asSinkAccount(
      oam.putSinkPolicy({
        SinkIdentifier: sinkArn,
        Policy: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { AWS: [ACCOUNT_ID] },
              Action: ["oam:CreateLink", "oam:UpdateLink"],
              Resource: "*",
              Condition: {
                "ForAllValues:StringEquals": {
                  "oam:ResourceTypes": OAM_RESOURCE_TYPES,
                },
              },
            },
          ],
        }),
      }),
    );
    return sinkArn;
  });

// ─── SageMaker serving image ─────────────────────────────────────────────────

/** Builds the local serving image Floci runs with `serve` (no registry push). */
const buildSageMakerServeImage = Effect.gen(function* () {
  const path = yield* Path.Path;
  const context = yield* path.fromFileUrl(
    new URL("./floci-fixtures-assets/sagemaker-serve/", import.meta.url),
  );
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const result = yield* spawner
    .spawn(
      ChildProcess.make("docker", ["build", "--tag", SAGEMAKER_SERVE_IMAGE, context], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }),
    )
    .pipe(
      Effect.flatMap((child) =>
        Effect.all(
          {
            exitCode: child.exitCode,
            stdout: child.stdout.pipe(Stream.decodeText, Stream.mkString),
            stderr: child.stderr.pipe(Stream.decodeText, Stream.mkString),
          },
          { concurrency: "unbounded" },
        ),
      ),
      Effect.scoped,
    );
  if (result.exitCode !== 0) {
    return yield* fixtureError(
      `docker build of ${SAGEMAKER_SERVE_IMAGE} exited ${result.exitCode}: ${result.stderr.trim().slice(-2000)}`,
    );
  }
  return SAGEMAKER_SERVE_IMAGE;
}).pipe(
  Effect.catchTags({
    PlatformError: (error) =>
      fixtureError(`could not run docker build for ${SAGEMAKER_SERVE_IMAGE}: ${error.message}`),
  }),
);

// ─── Control Tower ───────────────────────────────────────────────────────────

/** One landing zone per Region; Floci's CreateLandingZone needs no Organization. */
const ensureLandingZone = (ledger: Array<Cleanup>) =>
  Effect.gen(function* () {
    // Floci keeps at most one landing zone per Region
    // (services/controltower/ControlTowerService.java createLandingZone).
    const listed = yield* controltower.listLandingZones({});
    let landingZoneArn = listed.landingZones[0]?.arn;
    if (landingZoneArn === undefined) {
      const created = yield* controltower
        .createLandingZone({
          version: LANDING_ZONE_VERSION,
          manifest: {
            governedRegions: [REGION],
            organizationStructure: { security: { name: "Security" } },
            centralizedLogging: {
              accountId: ACCOUNT_ID,
              configurations: {
                loggingBucket: { retentionDays: 365 },
                accessLoggingBucket: { retentionDays: 3650 },
              },
              enabled: true,
            },
            securityRoles: { accountId: ACCOUNT_ID },
            accessManagement: { enabled: false },
          },
          tags: { [FIXTURE_TAG_KEY]: FIXTURE_TAG_VALUE },
        })
        .pipe(
          Effect.map((response) => response.arn),
          Effect.catchTag("ConflictException", () =>
            controltower
              .listLandingZones({})
              .pipe(Effect.map((response) => response.landingZones[0]?.arn)),
          ),
        );
      if (created === undefined) {
        return yield* fixtureError("CreateLandingZone returned no ARN");
      }
      const arn = created;
      yield* register(ledger, {
        label: `landing zone ${arn}`,
        run: controltower
          .deleteLandingZone({ landingZoneIdentifier: arn })
          .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.void)),
      });
      landingZoneArn = arn;
    } else {
      yield* log(`reusing landing zone ${landingZoneArn}`);
    }
    const landingZone = yield* controltower
      .getLandingZone({ landingZoneIdentifier: landingZoneArn })
      .pipe(
        Effect.map((response) => response.landingZone),
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (zone): boolean => zone.status !== "PROCESSING",
          times: 24,
        }),
      );
    if (landingZone.status !== "ACTIVE") {
      return yield* fixtureError(
        `landing zone ${landingZoneArn} is ${landingZone.status ?? "without status"}`,
      );
    }
  });

// ─── Orchestration ───────────────────────────────────────────────────────────

const matchesSuite = (file: string, suite: string) =>
  file.replaceAll("\\", "/").endsWith(`AWS/${suite}`);

const allVarsSet = (group: Group) =>
  Effect.forEach(groupVars[group], (name) => Config.String(name).pipe(Config.withDefault(""))).pipe(
    Effect.map((values) => values.every((value) => value !== "")),
  );

const selectGroups = (files: ReadonlyArray<string> | undefined) =>
  Effect.gen(function* () {
    const selected = new Set<Group>();
    for (const group of Object.keys(groupVars) as Array<Group>) {
      const wanted =
        files === undefined ||
        files.some((file) => groupSuites[group].some((suite) => matchesSuite(file, suite)));
      if (!wanted) continue;
      if (yield* allVarsSet(group)) {
        yield* log(`fixtures: ${group} uses the caller's env vars`);
        continue;
      }
      selected.add(group);
    }
    return selected;
  });

const provision = (external: boolean, groups: ReadonlySet<Group>, ledger: Array<Cleanup>) =>
  Effect.gen(function* () {
    yield* Floci.ensureFloci({ port: Floci.DEFAULT_FLOCI_PORT, external });
    yield* log(`fixtures: provisioning ${[...groups].join(", ")}`);
    const env: Record<string, string> = {};
    // Shared by every group that needs subnets; cleanups register once.
    const network = yield* Effect.cached(ensureNetwork(ledger));
    const needsEksCluster = groups.has("eksCluster") || groups.has("amp") || groups.has("hyperpod");

    if (needsEksCluster || groups.has("eksRole")) {
      const { subnetIds } = yield* network;
      const subnets = subnetIds.join(",");
      const clusterRoleArn = yield* ensureRole(
        ledger,
        "eks-cluster",
        "eks.amazonaws.com",
        ["sts:AssumeRole", "sts:TagSession"],
        ["AmazonEKSClusterPolicy"],
      );
      if (groups.has("eksRole")) {
        env.AWS_TEST_EKS_ROLE_ARN = clusterRoleArn;
        env.AWS_TEST_EKS_SUBNET_IDS = subnets;
      }

      if (needsEksCluster) {
        const cluster = yield* ensureEksCluster(ledger, yield* network, clusterRoleArn);
        if (groups.has("eksCluster")) {
          env.AWS_TEST_EKS_NODE_ROLE_ARN = yield* ensureRole(
            ledger,
            "eks-node",
            "ec2.amazonaws.com",
            ["sts:AssumeRole"],
            [
              "AmazonEKSWorkerNodePolicy",
              "AmazonEKS_CNI_Policy",
              "AmazonEC2ContainerRegistryReadOnly",
            ],
          );
          env.AWS_TEST_EKS_FARGATE_ROLE_ARN = yield* ensureRole(
            ledger,
            "eks-fargate",
            "eks-fargate-pods.amazonaws.com",
            ["sts:AssumeRole"],
            ["AmazonEKSFargatePodExecutionRolePolicy"],
          );
          env.AWS_TEST_EKS_POD_ROLE_ARN = yield* ensureRole(
            ledger,
            "eks-pod",
            "pods.eks.amazonaws.com",
            ["sts:AssumeRole", "sts:TagSession"],
            [],
          );
          env.AWS_TEST_EKS_CLUSTER = cluster.name;
          env.AWS_TEST_EKS_PRIVATE_SUBNETS = subnets;
        }
        if (groups.has("amp")) {
          env.AWS_TEST_AMP_SCRAPER = "1";
          env.AWS_TEST_AMP_SCRAPER_CLUSTER_ARN = cluster.arn;
          env.AWS_TEST_AMP_SCRAPER_SUBNET_IDS = subnets;
        }
        if (groups.has("hyperpod")) {
          const executionRoleArn = yield* ensureRole(
            ledger,
            "hyperpod",
            "sagemaker.amazonaws.com",
            ["sts:AssumeRole"],
            ["AmazonSageMakerClusterInstanceRolePolicy"],
          );
          env.AWS_TEST_SAGEMAKER_HYPERPOD_EKS_CLUSTER_ARN = yield* ensureHyperPodCluster(
            ledger,
            cluster,
            subnetIds,
            executionRoleArn,
          );
        }
      }
    }

    if (groups.has("rdsProxy")) {
      const { subnetIds } = yield* network;
      const roleArn = yield* ensureRole(
        ledger,
        "rds-proxy",
        "rds.amazonaws.com",
        ["sts:AssumeRole"],
        ["SecretsManagerReadWrite"],
      );
      const secretArn = yield* ensureRdsProxySecret(ledger);
      env.AWS_TEST_RDS_DBPROXY = "1";
      env.DBPROXY_SUBNET_IDS = subnetIds.join(",");
      env.DBPROXY_ROLE_ARN = roleArn;
      env.DBPROXY_SECRET_ARN = secretArn;
    }

    if (groups.has("ecsAsg")) {
      env.TEST_ASG_ARN = yield* ensureEcsAutoScalingGroup(ledger, yield* network);
    }

    if (groups.has("vpcLink")) {
      env.ALCHEMY_TEST_VPC_LINK_TARGET_ARN = yield* ensureVpcLinkLoadBalancer(
        ledger,
        yield* network,
      );
    }

    if (groups.has("flink")) {
      env.AWS_TEST_FLINK_START = "1";
      env.AWS_TEST_FLINK_JAR_BUCKET_ARN = yield* ensureFlinkJar(ledger);
      env.AWS_TEST_FLINK_JAR_KEY = FLINK_JAR_KEY;
    }

    if (groups.has("domain")) {
      const zoneId = yield* ensurePublicZone(ledger, DOMAIN_ZONE);
      const certificateArn = yield* ensureZoneCertificate(ledger, zoneId, DOMAIN_ZONE);
      env.AWS_TEST_DOMAIN = DOMAIN_ZONE;
      env.AWS_TEST_HOSTED_ZONE = DOMAIN_ZONE;
      env.AWS_TEST_APIGATEWAY_DOMAIN = `apigw-bpm.${DOMAIN_ZONE}`;
      env.AWS_TEST_ACM_CERTIFICATE_ARN = certificateArn;
      env.AWS_TEST_APIGATEWAY_DOMAIN_NAME = `apigw.${DOMAIN_ZONE}`;
      env.AWS_TEST_APIGATEWAY_CERT_ARN = certificateArn;
      env.AWS_TEST_APIGATEWAYV2_DOMAIN_NAME = `apigw2.${DOMAIN_ZONE}`;
      env.AWS_TEST_APPSYNC_DOMAIN_NAME = `appsync.${DOMAIN_ZONE}`;
      env.AWS_TEST_APPSYNC_DOMAIN_CERT_ARN = certificateArn;
    }

    if (groups.has("ses")) {
      const { bounceMessageId } = yield* ensureSesFixtures(ledger);
      env.AWS_TEST_SES_FROM = SES_FROM;
      env.AWS_TEST_SES_BOUNCE_MESSAGE_ID = bounceMessageId;
      env.AWS_TEST_SES_CVE_TEMPLATE = SES_CVE_TEMPLATE;
      env.AWS_TEST_SES_CVE_RECIPIENT = SES_CVE_RECIPIENT;
      env.AWS_TEST_SES_REDIRECT_DOMAIN = SES_REDIRECT_DOMAIN;
      env.AWS_TEST_SES_VDM = "1";
    }

    if (groups.has("oam")) {
      env.AWS_TEST_OAM_SINK_ARN = yield* ensureOamSink(ledger);
    }

    if (groups.has("sagemakerEndpoint")) {
      env.AWS_TEST_SAGEMAKER_ENDPOINT = "1";
      env.AWS_TEST_SAGEMAKER_IMAGE = yield* buildSageMakerServeImage;
    }

    if (groups.has("controlTower")) {
      yield* ensureLandingZone(ledger);
      env.AWS_TEST_CONTROLTOWER = "1";
      env.AWS_TEST_CONTROLTOWER_CONTROL = CONTROL_ARN;
      env.AWS_TEST_CONTROLTOWER_BASELINE_VERSION = BASELINE_VERSION;
    }
    return env;
  });

/**
 * Provisions the standing fixtures the selected suites need. On failure or
 * interruption, everything already created is removed before the effect fails.
 */
export const provisionFlociStandingFixtures = Effect.fn(function* (
  external: boolean,
  options: FlociStandingFixtureOptions = {},
) {
  const ledger: Array<Cleanup> = [];
  const groups = yield* selectGroups(options.files);
  const teardown: FlociStandingFixtures["teardown"] = Effect.suspend(() =>
    ledger.length === 0 ? Effect.void : runCleanups(ledger),
  ).pipe(Effect.provide(fixtureLayer));
  if (groups.size === 0) return { env: {}, teardown } satisfies FlociStandingFixtures;
  const env = yield* provision(external, groups, ledger).pipe(
    Effect.onError(() =>
      runCleanups(ledger).pipe(Effect.catch((error) => Console.error(String(error.message)))),
    ),
    Effect.provide(fixtureLayer),
  );
  return { env, teardown } satisfies FlociStandingFixtures;
});
