import * as apprunner from "@distilled.cloud/aws/apprunner";
import * as ecr from "@distilled.cloud/aws/ecr";
import * as iam from "@distilled.cloud/aws/iam";
import type { Region } from "@distilled.cloud/aws/Region";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import type * as rolldown from "rolldown";
import { Unowned } from "../../AdoptPolicy.ts";
import { AlchemyContext } from "../../AlchemyContext.ts";
import * as Bundle from "../../Bundle/Bundle.ts";
import {
  findCwdForBundle,
  getStableContextDir,
  resolveMainPath,
} from "../../Bundle/TempRoot.ts";
import { isResolved } from "../../Diff.ts";
import { Docker } from "../../Docker/Docker.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import { Platform, type Main, type PlatformProps } from "../../Platform.ts";
import * as Provider from "../../Provider.ts";
import { Resource, type ResourceBinding } from "../../Resource.ts";
import {
  createHostRuntimeContext,
  type HostRuntimeContext,
  type ServerHost,
} from "../../Server/Process.ts";
import { Stack } from "../../Stack.ts";
import {
  createInternalTags,
  createTagsList,
  hasAlchemyTags,
  hasTags,
} from "../../Tags.ts";
import { toSeconds } from "../../Util/Duration.ts";
import type { Credentials } from "../Credentials.ts";
import { buildAndPushEcrImage } from "../ECR/Image.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";
import type { Providers } from "../Providers.ts";
import {
  readAppRunnerTags,
  syncAppRunnerTags,
  toWireTags,
} from "./internal.ts";

/**
 * Container image source for an App Runner service.
 */
export interface ServiceImageRepository {
  /**
   * Image identifier: a private ECR image URI
   * (`{account}.dkr.ecr.{region}.amazonaws.com/{repo}:{tag}`) or a public
   * ECR image (`public.ecr.aws/{alias}/{repo}:{tag}`).
   */
  imageIdentifier: string;
  /**
   * Repository type. `ECR` (private, requires `accessRoleArn`) or
   * `ECR_PUBLIC` (public gallery images, no access role).
   */
  imageRepositoryType: "ECR" | "ECR_PUBLIC";
  /**
   * Port the application listens on.
   * @default "8080"
   */
  port?: string;
  /**
   * Command App Runner runs to start the container. Overrides the image's
   * default start command.
   */
  startCommand?: string;
  /**
   * Environment variables available to the running service.
   */
  runtimeEnvironmentVariables?: Record<string, string>;
  /**
   * Secrets exposed as environment variables. Values are Secrets Manager
   * secret ARNs or SSM parameter ARNs (the instance role must be able to
   * read them).
   */
  runtimeEnvironmentSecrets?: Record<string, string>;
}

/**
 * Compute resources for each instance of the service.
 */
export interface ServiceInstanceConfiguration {
  /**
   * CPU units per instance: `"256"` (0.25 vCPU), `"512"`, `"1024"`,
   * `"2048"`, or `"4096"`. The `"0.25 vCPU"`-style forms are also
   * accepted.
   * @default "1024"
   */
  cpu?: string;
  /**
   * Memory per instance in MB: `"512"`, `"1024"`, `"2048"`, `"3072"`,
   * `"4096"`, `"6144"`, `"8192"`, `"10240"`, or `"12288"`. The
   * `"2 GB"`-style forms are also accepted.
   * @default "2048"
   */
  memory?: string;
  /**
   * IAM role assumed by the running service (analogous to an ECS task
   * role). Required when the app calls AWS APIs or reads
   * `runtimeEnvironmentSecrets`. For the Effect-native form (`main`),
   * Alchemy provisions and manages this role automatically.
   */
  instanceRoleArn?: string;
}

/**
 * Health check App Runner performs against the service.
 */
export interface ServiceHealthCheckConfiguration {
  /**
   * Health check protocol.
   * @default "TCP"
   */
  protocol?: "TCP" | "HTTP";
  /**
   * URL path for HTTP health checks.
   * @default "/"
   */
  path?: string;
  /**
   * Time between health checks, e.g. `"5 seconds"` or
   * `Duration.seconds(5)` (1-20 seconds on the wire).
   * @default "5 seconds"
   */
  interval?: Duration.Input;
  /**
   * Time to wait for a response, e.g. `"2 seconds"` or
   * `Duration.seconds(2)` (1-20 seconds on the wire).
   * @default "2 seconds"
   */
  timeout?: Duration.Input;
  /**
   * Consecutive successful checks before the target is healthy (1-20).
   * @default 1
   */
  healthyThreshold?: number;
  /**
   * Consecutive failed checks before the target is unhealthy (1-20).
   * @default 5
   */
  unhealthyThreshold?: number;
}

/**
 * Network settings for inbound and outbound service traffic.
 */
export interface ServiceNetworkConfiguration {
  /**
   * Outbound traffic routing. `DEFAULT` egresses through App Runner;
   * `VPC` routes through the VPC connector named by `vpcConnectorArn`.
   * @default "DEFAULT"
   */
  egressType?: "DEFAULT" | "VPC";
  /**
   * ARN of the App Runner VPC connector for `egressType: "VPC"`.
   */
  vpcConnectorArn?: string;
  /**
   * Whether the service is reachable from the public internet. Set to
   * false to only allow access from a VPC ingress connection.
   * @default true
   */
  isPubliclyAccessible?: boolean;
  /**
   * IP address type for the public endpoint.
   * @default "IPV4"
   */
  ipAddressType?: "IPV4" | "DUAL_STACK";
}

/**
 * Observability (tracing) settings for the service.
 */
export interface ServiceObservabilityProps {
  /**
   * Whether observability (X-Ray tracing) is enabled for the service.
   */
  observabilityEnabled: boolean;
  /**
   * ARN of the App Runner observability configuration to use. Required
   * when `observabilityEnabled` is true.
   */
  observabilityConfigurationArn?: string;
}

export interface ServiceProps extends PlatformProps {
  /**
   * Name of the service. Must be 4-40 characters. If omitted, a
   * deterministic physical name is generated. Changing the name replaces
   * the service.
   */
  serviceName?: string;
  /**
   * Container image source for the service (low-level form). Required
   * unless `main` is given. Code-repository (GitHub) sources are not
   * supported — they require an App Runner Connection whose handshake is
   * completed manually in the console.
   */
  imageRepository?: ServiceImageRepository;
  /**
   * Module entrypoint for an Effect-native service (typically
   * `import.meta.url` from an inline Effect program). Alchemy bundles the
   * program, builds a container image, pushes it to a managed ECR
   * repository, and provisions the instance/access IAM roles — mutually
   * exclusive with a caller-supplied `imageRepository`.
   */
  main?: string;
  /**
   * Named export to load from `main`.
   * @default "default"
   */
  handler?: string;
  /**
   * HTTP port the Effect-native program listens on (App Runner injects it
   * as `PORT`). Only used with `main`; the low-level form configures
   * `imageRepository.port` instead.
   * @default 3000
   */
  port?: number;
  /**
   * Additional environment variables for the Effect-native container.
   * Non-string values are JSON-encoded.
   */
  env?: Record<string, any>;
  /**
   * Bundler configuration for the Effect-native entrypoint.
   */
  build?: {
    input?: Partial<rolldown.InputOptions>;
    output?: Partial<rolldown.OutputOptions>;
  };
  /**
   * Docker image build for the Effect-native form: optional full
   * `dockerfile`. When omitted, Alchemy generates a Dockerfile for the
   * bundled `index.mjs`.
   */
  docker?: {
    /**
     * Base image when Alchemy generates the Dockerfile.
     * @default public.ecr.aws/docker/library/bun:1
     */
    base?: string;
    /** Full Dockerfile content (replaces generated Dockerfile). */
    dockerfile?: string;
  };
  /**
   * Whether App Runner automatically deploys new image versions pushed to
   * the (private ECR only) repository.
   * @default false
   */
  autoDeploymentsEnabled?: boolean;
  /**
   * IAM role App Runner assumes to pull from private ECR (must trust
   * `build.apprunner.amazonaws.com`). Required for
   * `imageRepositoryType: "ECR"`, forbidden for `ECR_PUBLIC`. For the
   * Effect-native form (`main`), Alchemy provisions and manages this role
   * automatically.
   */
  accessRoleArn?: string;
  /**
   * CPU, memory, and instance role for the running service.
   */
  instanceConfiguration?: ServiceInstanceConfiguration;
  /**
   * Health check configuration.
   */
  healthCheckConfiguration?: ServiceHealthCheckConfiguration;
  /**
   * Inbound/outbound network configuration.
   */
  networkConfiguration?: ServiceNetworkConfiguration;
  /**
   * ARN of an App Runner auto scaling configuration. Defaults to the
   * account's default configuration.
   */
  autoScalingConfigurationArn?: string;
  /**
   * Observability (X-Ray tracing) configuration, referencing an
   * `AppRunner.ObservabilityConfiguration`.
   */
  observabilityConfiguration?: ServiceObservabilityProps;
  /**
   * Customer-managed KMS key ARN for encrypting stored copies of the
   * image and configuration. Changing the key replaces the service.
   * @default AWS-owned key
   */
  kmsKeyArn?: string;
  /**
   * User-defined tags for the service.
   */
  tags?: Record<string, string>;
}

export interface Service extends Resource<
  "AWS.AppRunner.Service",
  ServiceProps,
  {
    /**
     * Name of the App Runner service.
     */
    serviceName: string;
    /**
     * ARN of the service.
     */
    serviceArn: string;
    /**
     * ID of the service.
     */
    serviceId: string;
    /**
     * Default HTTPS endpoint of the service (`xxxx.awsapprunner.com`).
     */
    serviceUrl: string | undefined;
    /**
     * Current status of the service (e.g. `RUNNING`, `OPERATION_IN_PROGRESS`).
     */
    status: string;
    /**
     * The full URI of the container image the service runs (Effect-native
     * form only).
     */
    imageUri: string | undefined;
    /**
     * The name of the managed ECR repository holding the built image
     * (Effect-native form only).
     */
    repositoryName: string | undefined;
    /**
     * The URI of the managed ECR repository (Effect-native form only).
     */
    repositoryUri: string | undefined;
    /**
     * The ARN of the managed instance role (Effect-native form only).
     */
    instanceRoleArn: string | undefined;
    /**
     * The name of the managed instance role (Effect-native form only).
     */
    instanceRoleName: string | undefined;
    /**
     * The ARN of the managed ECR access role (Effect-native form only).
     */
    accessRoleArn: string | undefined;
    /**
     * The name of the managed ECR access role (Effect-native form only).
     */
    accessRoleName: string | undefined;
    /**
     * The content hash of the bundled application code (Effect-native
     * form only).
     */
    codeHash: string | undefined;
  },
  {
    /** Environment variables injected into the service's containers. */
    env?: Record<string, any>;
    /** IAM policy statements attached to the managed instance role. */
    policyStatements?: PolicyStatement[];
  },
  Providers
> {}

export type ServiceServices =
  | Credentials
  | Region
  | ServerHost
  | AWSEnvironment;

export type ServiceShape = Main<ServiceServices>;

export interface ServiceRuntimeContext extends HostRuntimeContext {
  readonly Type: "AWS.AppRunner.Service";
}

/**
 * An AWS App Runner service — the zero-infrastructure way to run a
 * container behind an HTTPS endpoint: App Runner provisions,
 * load-balances, scales, and patches the fleet for you. Service creation
 * and deletion are asynchronous and take several minutes; the provider
 * waits (bounded) for operations to settle.
 *
 * `Service` is a Platform: alongside the low-level container-image form
 * (`imageRepository`), it supports Effect-native implementations — an
 * inline Effect HTTP program that Alchemy bundles, containerizes, pushes
 * to a managed ECR repository, and deploys, provisioning the instance and
 * ECR access roles automatically. Capability bindings (e.g. DynamoDB
 * `GetItem`) attach IAM policy statements to the managed instance role.
 * @resource
 * @section Creating a Service
 * @example Public ECR Image
 * ```typescript
 * const service = yield* AppRunner.Service("Hello", {
 *   imageRepository: {
 *     imageIdentifier: "public.ecr.aws/aws-containers/hello-app-runner:latest",
 *     imageRepositoryType: "ECR_PUBLIC",
 *     port: "8000",
 *   },
 *   instanceConfiguration: { cpu: "256", memory: "512" },
 * });
 * // service.serviceUrl -> "xxxxxxxx.us-west-2.awsapprunner.com"
 * ```
 *
 * @example Private ECR Image with Access Role
 * ```typescript
 * const service = yield* AppRunner.Service("Api", {
 *   imageRepository: {
 *     imageIdentifier: `${repository.repositoryUri}:latest`,
 *     imageRepositoryType: "ECR",
 *     port: "8080",
 *     runtimeEnvironmentVariables: { NODE_ENV: "production" },
 *   },
 *   accessRoleArn: accessRole.roleArn,
 *   autoDeploymentsEnabled: true,
 * });
 * ```
 *
 * @section Effect-Native Services
 * @example Inline Effect HTTP Program
 * ```typescript
 * export default class Api extends AppRunner.Service<Api>()(
 *   "Api",
 *   {
 *     main: import.meta.url,
 *     port: 3000,
 *     instanceConfiguration: { cpu: "256", memory: "512" },
 *   },
 *   Effect.gen(function* () {
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const request = yield* HttpServerRequest;
 *         return HttpServerResponse.text("hello from app runner");
 *       }),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * @section Scaling and Networking
 * @example Custom Auto Scaling and VPC Egress
 * ```typescript
 * const service = yield* AppRunner.Service("Api", {
 *   imageRepository: {
 *     imageIdentifier: "public.ecr.aws/aws-containers/hello-app-runner:latest",
 *     imageRepositoryType: "ECR_PUBLIC",
 *     port: "8000",
 *   },
 *   autoScalingConfigurationArn: scaling.autoScalingConfigurationArn,
 *   networkConfiguration: {
 *     egressType: "VPC",
 *     vpcConnectorArn: connector.vpcConnectorArn,
 *   },
 * });
 * ```
 */
export const Service: Platform<
  Service,
  ServiceServices,
  ServiceShape,
  ServiceRuntimeContext
> = Platform("AWS.AppRunner.Service", {
  createRuntimeContext: createHostRuntimeContext("AWS.AppRunner.Service") as (
    id: string,
  ) => ServiceRuntimeContext,
});

class AppRunnerServiceNotSettled extends Data.TaggedError(
  "AppRunnerServiceNotSettled",
)<{
  readonly serviceArn: string;
  readonly status: string;
}> {}

/**
 * Case-insensitive status comparison — App Runner returns lowercase
 * statuses for some resource types despite documenting uppercase.
 */
const statusIs = (status: string | undefined, expected: string): boolean =>
  status?.toUpperCase() === expected;

/** Normalize the vCPU-style CPU forms to the numeric wire echo. */
const normalizeCpu = (cpu: string): string =>
  ({
    "0.25 vCPU": "256",
    "0.5 vCPU": "512",
    "1 vCPU": "1024",
    "2 vCPU": "2048",
    "4 vCPU": "4096",
  })[cpu] ?? cpu;

/** Normalize the GB-style memory forms to the numeric wire echo. */
const normalizeMemory = (memory: string): string =>
  ({
    "0.5 GB": "512",
    "1 GB": "1024",
    "2 GB": "2048",
    "3 GB": "3072",
    "4 GB": "4096",
    "6 GB": "6144",
    "8 GB": "8192",
    "10 GB": "10240",
    "12 GB": "12288",
  })[memory] ?? memory;

/** Unwrap distilled's sensitive-string decoding to a plain value. */
const plain = (
  value: string | Redacted.Redacted<string> | undefined,
): string | undefined =>
  value === undefined || typeof value === "string"
    ? value
    : Redacted.value(value);

const plainRecord = (
  record:
    | { [key: string]: string | Redacted.Redacted<string> | undefined }
    | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(record ?? {}).flatMap(([key, value]) => {
      const v = plain(value);
      return v === undefined ? [] : [[key, v]];
    }),
  );

const sameRecord = (
  a: Record<string, string>,
  b: Record<string, string>,
): boolean => {
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  return (
    aKeys.length === bKeys.length &&
    aKeys.every((k, i) => k === bKeys[i] && a[k] === b[k])
  );
};

/** Props with the source resolved (either given or built from `main`). */
interface ResolvedServiceProps extends ServiceProps {
  imageRepository: ServiceImageRepository;
}

const toWireSource = (
  props: ResolvedServiceProps,
): apprunner.SourceConfiguration => ({
  ImageRepository: {
    ImageIdentifier: props.imageRepository.imageIdentifier,
    ImageRepositoryType: props.imageRepository.imageRepositoryType,
    ImageConfiguration: {
      Port: props.imageRepository.port,
      StartCommand: props.imageRepository.startCommand,
      RuntimeEnvironmentVariables:
        props.imageRepository.runtimeEnvironmentVariables,
      RuntimeEnvironmentSecrets:
        props.imageRepository.runtimeEnvironmentSecrets,
    },
  },
  AutoDeploymentsEnabled: props.autoDeploymentsEnabled,
  AuthenticationConfiguration: props.accessRoleArn
    ? { AccessRoleArn: props.accessRoleArn }
    : undefined,
});

const toWireInstance = (
  instance: ServiceInstanceConfiguration | undefined,
): apprunner.InstanceConfiguration | undefined =>
  instance === undefined
    ? undefined
    : {
        Cpu: instance.cpu,
        Memory: instance.memory,
        InstanceRoleArn: instance.instanceRoleArn,
      };

const toWireHealthCheck = (
  healthCheck: ServiceHealthCheckConfiguration | undefined,
): apprunner.HealthCheckConfiguration | undefined =>
  healthCheck === undefined
    ? undefined
    : {
        Protocol: healthCheck.protocol,
        Path: healthCheck.path,
        Interval: toSeconds(healthCheck.interval),
        Timeout: toSeconds(healthCheck.timeout),
        HealthyThreshold: healthCheck.healthyThreshold,
        UnhealthyThreshold: healthCheck.unhealthyThreshold,
      };

const toWireNetwork = (
  network: ServiceNetworkConfiguration | undefined,
): apprunner.NetworkConfiguration | undefined =>
  network === undefined
    ? undefined
    : {
        EgressConfiguration:
          network.egressType !== undefined ||
          network.vpcConnectorArn !== undefined
            ? {
                EgressType: network.egressType,
                VpcConnectorArn: network.vpcConnectorArn,
              }
            : undefined,
        IngressConfiguration:
          network.isPubliclyAccessible !== undefined
            ? { IsPubliclyAccessible: network.isPubliclyAccessible }
            : undefined,
        IpAddressType: network.ipAddressType,
      };

const toWireObservability = (
  observability: ServiceObservabilityProps | undefined,
): apprunner.ServiceObservabilityConfiguration | undefined =>
  observability === undefined
    ? undefined
    : {
        ObservabilityEnabled: observability.observabilityEnabled,
        ObservabilityConfigurationArn:
          observability.observabilityConfigurationArn,
      };

/**
 * True when any user-specified aspect of the source configuration differs
 * from the observed one. Only fields the user actually specified are
 * compared — the service fills in defaults that must not trigger
 * spurious deployments.
 */
const sourceDrifted = (
  news: ResolvedServiceProps,
  observed: apprunner.SourceConfiguration | undefined,
): boolean => {
  const image = observed?.ImageRepository;
  const config = image?.ImageConfiguration;
  const desired = news.imageRepository;
  return (
    image?.ImageIdentifier !== desired.imageIdentifier ||
    image?.ImageRepositoryType !== desired.imageRepositoryType ||
    (desired.port !== undefined && config?.Port !== desired.port) ||
    (desired.startCommand !== undefined &&
      plain(config?.StartCommand) !== desired.startCommand) ||
    (desired.runtimeEnvironmentVariables !== undefined &&
      !sameRecord(
        plainRecord(config?.RuntimeEnvironmentVariables),
        desired.runtimeEnvironmentVariables,
      )) ||
    (desired.runtimeEnvironmentSecrets !== undefined &&
      !sameRecord(
        plainRecord(config?.RuntimeEnvironmentSecrets),
        desired.runtimeEnvironmentSecrets,
      )) ||
    (news.autoDeploymentsEnabled !== undefined &&
      observed?.AutoDeploymentsEnabled !== news.autoDeploymentsEnabled) ||
    (news.accessRoleArn !== undefined &&
      observed?.AuthenticationConfiguration?.AccessRoleArn !==
        news.accessRoleArn)
  );
};

const instanceDrifted = (
  desired: ServiceInstanceConfiguration | undefined,
  observed: apprunner.InstanceConfiguration | undefined,
): boolean =>
  desired !== undefined &&
  ((desired.cpu !== undefined &&
    normalizeCpu(observed?.Cpu ?? "") !== normalizeCpu(desired.cpu)) ||
    (desired.memory !== undefined &&
      normalizeMemory(observed?.Memory ?? "") !==
        normalizeMemory(desired.memory)) ||
    (desired.instanceRoleArn !== undefined &&
      observed?.InstanceRoleArn !== desired.instanceRoleArn));

const healthCheckDrifted = (
  desired: ServiceHealthCheckConfiguration | undefined,
  observed: apprunner.HealthCheckConfiguration | undefined,
): boolean =>
  desired !== undefined &&
  ((desired.protocol !== undefined &&
    observed?.Protocol !== desired.protocol) ||
    (desired.path !== undefined && observed?.Path !== desired.path) ||
    (desired.interval !== undefined &&
      observed?.Interval !== toSeconds(desired.interval)) ||
    (desired.timeout !== undefined &&
      observed?.Timeout !== toSeconds(desired.timeout)) ||
    (desired.healthyThreshold !== undefined &&
      observed?.HealthyThreshold !== desired.healthyThreshold) ||
    (desired.unhealthyThreshold !== undefined &&
      observed?.UnhealthyThreshold !== desired.unhealthyThreshold));

const networkDrifted = (
  desired: ServiceNetworkConfiguration | undefined,
  observed: apprunner.NetworkConfiguration | undefined,
): boolean =>
  desired !== undefined &&
  ((desired.egressType !== undefined &&
    observed?.EgressConfiguration?.EgressType !== desired.egressType) ||
    (desired.vpcConnectorArn !== undefined &&
      observed?.EgressConfiguration?.VpcConnectorArn !==
        desired.vpcConnectorArn) ||
    (desired.isPubliclyAccessible !== undefined &&
      observed?.IngressConfiguration?.IsPubliclyAccessible !==
        desired.isPubliclyAccessible) ||
    (desired.ipAddressType !== undefined &&
      observed?.IpAddressType !== desired.ipAddressType));

const observabilityDrifted = (
  desired: ServiceObservabilityProps | undefined,
  observed: apprunner.ServiceObservabilityConfiguration | undefined,
): boolean =>
  desired !== undefined &&
  ((observed?.ObservabilityEnabled ?? false) !== desired.observabilityEnabled ||
    (desired.observabilityConfigurationArn !== undefined &&
      // App Runner echoes the resolved (revision-qualified) ARN; compare
      // on the revision-less name partial so both forms converge.
      !(observed?.ObservabilityConfigurationArn ?? "").startsWith(
        desired.observabilityConfigurationArn.split("/").slice(0, 2).join("/"),
      )));

/** Attributes only produced by the Effect-native (`main`) form. */
interface PlatformAttributes {
  imageUri: string | undefined;
  repositoryName: string | undefined;
  repositoryUri: string | undefined;
  instanceRoleArn: string | undefined;
  instanceRoleName: string | undefined;
  accessRoleArn: string | undefined;
  accessRoleName: string | undefined;
  codeHash: string | undefined;
}

const emptyPlatformAttributes: PlatformAttributes = {
  imageUri: undefined,
  repositoryName: undefined,
  repositoryUri: undefined,
  instanceRoleArn: undefined,
  instanceRoleName: undefined,
  accessRoleArn: undefined,
  accessRoleName: undefined,
  codeHash: undefined,
};

export const ServiceProvider = () =>
  Provider.effect(
    Service,
    Effect.gen(function* () {
      const stack = yield* Stack;
      const docker = yield* Docker;
      const { dotAlchemy } = yield* AlchemyContext;
      const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;

      const alchemyEnv = {
        ALCHEMY_STACK_NAME: stack.name,
        ALCHEMY_STAGE: stack.stage,
        ALCHEMY_PHASE: "runtime",
      };

      const toName = (id: string, props: Partial<ServiceProps>) =>
        props.serviceName
          ? Effect.succeed(props.serviceName)
          : createPhysicalName({ id, maxLength: 40 });

      const createRoleName = (id: string, suffix: string) =>
        createPhysicalName({ id: `${id}-${suffix}`, maxLength: 64 });

      const createRepositoryName = (id: string) =>
        createPhysicalName({
          id: `${id}-repo`,
          maxLength: 256,
          lowercase: true,
        });

      /**
       * Ensure an IAM role trusted by the given App Runner principal exists
       * (creates on miss, adopts on race when it carries our tags).
       */
      const ensureRole = Effect.fn(function* ({
        id,
        roleName,
        principal,
        managedPolicyArns,
      }: {
        id: string;
        roleName: string;
        principal: string;
        managedPolicyArns?: string[];
      }) {
        const tags = yield* createInternalTags(id);
        const role = yield* iam
          .createRole({
            RoleName: roleName,
            AssumeRolePolicyDocument: JSON.stringify({
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { Service: principal },
                  Action: "sts:AssumeRole",
                },
              ],
            }),
            Tags: createTagsList(tags),
          })
          .pipe(
            Effect.catchTag("EntityAlreadyExistsException", () =>
              iam.getRole({ RoleName: roleName }).pipe(
                Effect.filterOrFail(
                  (existing) => hasTags(tags, existing.Role?.Tags),
                  () =>
                    new Error(
                      `Role '${roleName}' already exists and is not managed by alchemy`,
                    ),
                ),
              ),
            ),
          );
        for (const policyArn of managedPolicyArns ?? []) {
          yield* iam
            .attachRolePolicy({ RoleName: roleName, PolicyArn: policyArn })
            .pipe(Effect.catchTag("LimitExceededException", () => Effect.void));
        }
        return role.Role!.Arn!;
      });

      /** Ensure the managed ECR repository for the built image exists. */
      const ensureRepository = Effect.fn(function* ({
        repositoryName,
        tags,
      }: {
        repositoryName: string;
        tags: Record<string, string>;
      }) {
        const created = yield* ecr
          .createRepository({
            repositoryName,
            imageTagMutability: "MUTABLE",
            imageScanningConfiguration: { scanOnPush: true },
            tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
          })
          .pipe(
            Effect.catchTag("RepositoryAlreadyExistsException", () =>
              Effect.gen(function* () {
                const existing = yield* ecr.describeRepositories({
                  repositoryNames: [repositoryName],
                });
                return { repository: existing.repositories?.[0] };
              }),
            ),
          );
        const repository = created.repository;
        if (!repository?.repositoryUri) {
          return yield* Effect.fail(
            new Error(`Failed to resolve ECR repository '${repositoryName}'`),
          );
        }
        return { repositoryUri: repository.repositoryUri };
      });

      /**
       * Attach binding-declared IAM policy statements to the managed
       * instance role and collect binding-declared environment variables.
       */
      const attachBindings = Effect.fn(function* ({
        roleName,
        policyName,
        bindings,
      }: {
        roleName: string;
        policyName: string;
        bindings: ResourceBinding<Service["Binding"]>[];
      }) {
        const activeBindings = bindings.filter(
          (
            binding: ResourceBinding<Service["Binding"]> & { action?: string },
          ) => binding.action !== "delete",
        );

        const env = activeBindings
          .map((binding) => binding?.data?.env)
          .reduce((acc, value) => ({ ...acc, ...value }), {});

        const policyStatements = activeBindings.flatMap(
          (binding) =>
            binding?.data?.policyStatements?.map((statement) => ({
              ...statement,
              Sid: statement.Sid?.replace(/[^A-Za-z0-9]+/gi, ""),
            })) ?? [],
        );

        if (policyStatements.length > 0) {
          yield* iam.putRolePolicy({
            RoleName: roleName,
            PolicyName: policyName,
            PolicyDocument: JSON.stringify({
              Version: "2012-10-17",
              Statement: policyStatements,
            }),
          });
        } else {
          yield* iam
            .deleteRolePolicy({ RoleName: roleName, PolicyName: policyName })
            .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
        }

        return env;
      });

      /** Bundle the Effect-native program into container-ready files. */
      const bundleProgram = Effect.fn(function* (props: ServiceProps) {
        const handler = props.handler ?? "default";
        const realMain = yield* resolveMainPath(props.main!);
        const cwd = yield* findCwdForBundle(realMain);

        const buildBundle = Effect.fn(function* (
          entry: string,
          plugins?: rolldown.RolldownPluginOption,
        ) {
          return yield* Bundle.build(
            {
              ...props.build?.input,
              input: entry,
              cwd,
              platform: "node",
              // The container runs on `bun`; keep `bun`/`bun:*` external (the
              // runtime provides them) and resolve the `bun` export condition
              // so `@effect/platform-bun` picks its Bun implementations.
              external: [
                "bun",
                "bun:*",
                ...((props.build?.input?.external as string[] | undefined) ??
                  []),
              ],
              resolve: {
                conditionNames: ["bun", "import", "module", "default"],
                ...props.build?.input?.resolve,
              },
              plugins: [props.build?.input?.plugins, plugins],
            },
            {
              ...props.build?.output,
              format: "esm",
              sourcemap: props.build?.output?.sourcemap ?? false,
              minify: props.build?.output?.minify ?? false,
              entryFileNames: "index.mjs",
            },
          );
        });

        const bundleOutput = props.isExternal
          ? yield* buildBundle(realMain)
          : yield* buildBundle(
              realMain,
              virtualEntryPlugin(
                (importPath) => `
import { BunServices } from "@effect/platform-bun";
import { BunHttpServer } from "alchemy/Http";
import { Stack } from "alchemy/Stack";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Credentials from "@distilled.cloud/aws/Credentials";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Region from "@distilled.cloud/aws/Region";

import { ${handler} as handler } from ${JSON.stringify(importPath)};

const platform = Layer.mergeAll(
  BunServices.layer,
  FetchHttpClient.layer,
  Logger.layer([Logger.consolePretty()]),
);

// Resolve the bundled program (the runners registered via host.run / serve)
// and run it with a Bun HTTP server bound to PORT (App Runner injects PORT
// for the configured service port), so a returned { fetch } handler is
// actually served and host.run loops stay alive.
const program = handler.pipe(
  Effect.flatMap((service) => service.RuntimeContext.exports),
  Effect.flatMap((exports) => exports.program),
  Effect.provide(
    Layer.effect(
      Stack,
      Effect.all([
        Config.string("ALCHEMY_STACK_NAME"),
        Config.string("ALCHEMY_STAGE")
      ]).pipe(
        Effect.map(([name, stage]) => ({
          name,
          stage,
          bindings: {},
          resources: {}
        }))
      )
    ).pipe(
      Layer.provideMerge(Credentials.fromEnv()),
      Layer.provideMerge(Region.fromEnv()),
      Layer.provideMerge(BunHttpServer()),
      Layer.provideMerge(platform),
      Layer.provideMerge(
        Layer.succeed(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnv()
        )
      ),
    )
  ),
  Effect.scoped
);

console.log("App Runner service bootstrap starting...");
await Effect.runPromise(program).catch((err) => {
  console.error("App Runner service bootstrap failed:", err);
  process.exit(1);
});
`,
              ),
            );

        // Return every emitted file (entry + shared chunks). Dynamic imports
        // in the Bun HTTP server / AWS SDK split into chunks; dropping any of
        // them crashes the container with `Cannot find module './chunk-X.js'`.
        const files = bundleOutput.files.map((file) => ({
          path: file.path,
          content:
            typeof file.content === "string"
              ? new TextEncoder().encode(file.content)
              : file.content,
        }));

        return { files, hash: bundleOutput.hash };
      });

      /** Build + push the container image for the bundled program. */
      const buildAndPushImage = Effect.fn(function* ({
        id,
        repositoryUri,
        hash,
        files,
        props,
        port,
      }: {
        id: string;
        repositoryUri: string;
        hash: string;
        files: { path: string; content: Uint8Array<ArrayBufferLike> }[];
        props: ServiceProps;
        port: number;
      }) {
        const realMain = yield* resolveMainPath(props.main!);
        const contextDir = yield* getStableContextDir(
          realMain,
          dotAlchemy,
          `${id}-image`,
        );
        const imageUri = `${repositoryUri}:${hash}`;

        const generatedDockerfile = (() => {
          const base =
            props.docker?.base ?? "public.ecr.aws/docker/library/bun:1";
          return [
            `FROM ${base}`,
            `WORKDIR /app`,
            `COPY index.mjs /app/index.mjs`,
            // Copy any additional rolldown chunks (`chunk-XXX.js`, ...).
            // Non-trivial bundles always emit at least one; minimal bundles
            // emit none and the COPY no-ops.
            `COPY *.js /app/`,
            `ENV PORT=${String(port)}`,
            `EXPOSE ${String(port)}`,
            `ENTRYPOINT ["bun", "/app/index.mjs"]`,
          ].join("\n");
        })();

        const dockerfile = props.docker?.dockerfile ?? generatedDockerfile;

        yield* docker.materialize({
          context: contextDir,
          dockerfile,
          // Entry chunk becomes `index.mjs`; all other chunks keep their
          // emitted `*.js` names so the entry's relative imports resolve.
          files: files.map((file, index) => ({
            path: index === 0 ? "index.mjs" : file.path,
            content: file.content,
          })),
        });
        // App Runner only runs x86_64 images — always build linux/amd64
        // (cross-built via emulation on ARM64 hosts).
        return yield* buildAndPushEcrImage(docker, {
          imageUri,
          context: contextDir,
          platform: "linux/amd64",
        });
      });

      /** Describe a service; a missing or DELETED service reads as absent. */
      const readService = Effect.fn(function* (arn: string) {
        const response = yield* apprunner
          .describeService({ ServiceArn: arn })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        const service = response?.Service;
        return service === undefined || statusIs(service.Status, "DELETED")
          ? undefined
          : service;
      });

      /** Find a live service by name (list has no name filter). */
      const findByName = Effect.fn(function* (name: string) {
        const summary = yield* apprunner.listServices.pages({}).pipe(
          Stream.map((page) => page.ServiceSummaryList ?? []),
          Stream.flattenIterable,
          Stream.filter(
            (s) =>
              s.ServiceName === name &&
              !statusIs(s.Status, "DELETED") &&
              s.ServiceArn !== undefined,
          ),
          Stream.runHead,
          Effect.map(Option.getOrUndefined),
        );
        if (!summary?.ServiceArn) return undefined;
        return yield* readService(summary.ServiceArn);
      });

      // Create/update/delete are asynchronous; App Runner reports
      // OPERATION_IN_PROGRESS while converging. Service provisioning
      // typically takes 3-5 minutes; budget ~10 min (60 * 10s).
      const waitForSettled = Effect.fn(function* (arn: string) {
        return yield* readService(arn).pipe(
          Effect.flatMap((service) =>
            service !== undefined &&
            statusIs(service.Status, "OPERATION_IN_PROGRESS")
              ? Effect.fail(
                  new AppRunnerServiceNotSettled({
                    serviceArn: arn,
                    status: service.Status,
                  }),
                )
              : Effect.succeed(service),
          ),
          Effect.retry({
            while: (e) => e instanceof AppRunnerServiceNotSettled,
            schedule: Schedule.max([
              Schedule.fixed("10 seconds"),
              Schedule.recurs(60),
            ]),
          }),
        );
      });

      // Deletion is asynchronous too; wait until the service is gone so
      // dependencies (auto scaling configurations, VPC connectors) can be
      // deleted right after.
      const waitUntilGone = Effect.fn(function* (arn: string) {
        yield* readService(arn).pipe(
          Effect.flatMap((service) => {
            if (service === undefined) return Effect.void;
            if (statusIs(service.Status, "DELETE_FAILED")) {
              return Effect.fail(
                new Error(
                  `App Runner service '${arn}' failed to delete (status: DELETE_FAILED)`,
                ),
              );
            }
            return Effect.fail(
              new AppRunnerServiceNotSettled({
                serviceArn: arn,
                status: service.Status,
              }),
            );
          }),
          Effect.retry({
            while: (e) => e instanceof AppRunnerServiceNotSettled,
            schedule: Schedule.max([
              Schedule.fixed("10 seconds"),
              Schedule.recurs(60),
            ]),
          }),
        );
      });

      const toAttrs = (
        service: apprunner.Service,
        platform: PlatformAttributes,
      ): Service["Attributes"] => ({
        serviceName: service.ServiceName,
        serviceArn: service.ServiceArn,
        serviceId: service.ServiceId,
        serviceUrl: service.ServiceUrl,
        status: service.Status,
        ...platform,
      });

      const platformAttributesOf = (
        output: Service["Attributes"] | undefined,
      ): PlatformAttributes =>
        output === undefined
          ? emptyPlatformAttributes
          : {
              imageUri: output.imageUri,
              repositoryName: output.repositoryName,
              repositoryUri: output.repositoryUri,
              instanceRoleArn: output.instanceRoleArn,
              instanceRoleName: output.instanceRoleName,
              accessRoleArn: output.accessRoleArn,
              accessRoleName: output.accessRoleName,
              codeHash: output.codeHash,
            };

      return {
        stables: [
          "serviceName",
          "serviceArn",
          "serviceId",
          "repositoryName",
          "repositoryUri",
          "instanceRoleArn",
          "instanceRoleName",
          "accessRoleArn",
          "accessRoleName",
        ],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            (yield* toName(id, olds ?? {})) !== (yield* toName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
          // The encryption key is create-only.
          if (
            (news?.kmsKeyArn ?? undefined) !== (olds?.kmsKeyArn ?? undefined)
          ) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const service = output?.serviceArn
            ? yield* readService(output.serviceArn)
            : yield* findByName(yield* toName(id, olds ?? {}));
          if (service === undefined) return undefined;
          const attrs = toAttrs(service, platformAttributesOf(output));
          const tags = yield* readAppRunnerTags(attrs.serviceArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({
          id,
          news,
          bindings,
          output,
          session,
        }) {
          const name = output?.serviceName ?? (yield* toName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          const activeBindings = (
            bindings as (ResourceBinding<Service["Binding"]> & {
              action?: string;
            })[]
          ).filter((binding) => binding.action !== "delete");

          // Effect-native form: bundle the program, build + push the image,
          // and provision the managed IAM roles + ECR repository, then fall
          // through to the same observe/ensure/sync flow with the derived
          // source configuration.
          let effective: ServiceProps = news;
          let platformAttributes = emptyPlatformAttributes;
          if (news.main !== undefined) {
            const instanceRoleName =
              output?.instanceRoleName ??
              (yield* createRoleName(id, "instance-role"));
            const accessRoleName =
              output?.accessRoleName ??
              (yield* createRoleName(id, "access-role"));
            const policyName = yield* createPhysicalName({
              id: `${id}-policy`,
              maxLength: 128,
            });
            const repositoryName =
              output?.repositoryName ?? (yield* createRepositoryName(id));

            // Ensure roles + repository. Each helper is idempotent (creates
            // on miss, adopts on race) so the same sequence runs on initial
            // create, adoption, or update.
            const instanceRoleArn =
              output?.instanceRoleArn ??
              (yield* ensureRole({
                id,
                roleName: instanceRoleName,
                principal: "tasks.apprunner.amazonaws.com",
              }));
            const accessRoleArn =
              output?.accessRoleArn ??
              (yield* ensureRole({
                id,
                roleName: accessRoleName,
                principal: "build.apprunner.amazonaws.com",
                managedPolicyArns: [
                  "arn:aws:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess",
                ],
              }));

            const bindingEnv = yield* attachBindings({
              roleName: instanceRoleName,
              policyName,
              bindings,
            });

            const { repositoryUri } =
              output?.repositoryUri && output?.repositoryName === repositoryName
                ? { repositoryUri: output.repositoryUri }
                : yield* ensureRepository({
                    repositoryName,
                    tags: desiredTags,
                  });

            const port = news.port ?? 3000;
            const { files, hash } = yield* bundleProgram(news);
            const imageUri = yield* buildAndPushImage({
              id,
              repositoryUri,
              hash,
              files,
              props: news,
              port,
            });

            // App Runner env values must be strings — JSON-encode the rest.
            const runtimeEnvironmentVariables = Object.fromEntries(
              Object.entries({
                ...bindingEnv,
                ...alchemyEnv,
                ...news.env,
              }).map(([key, value]) => [
                key,
                typeof value === "string" ? value : JSON.stringify(value),
              ]),
            );

            effective = {
              ...news,
              imageRepository: {
                imageIdentifier: imageUri,
                imageRepositoryType: "ECR",
                port: String(port),
                runtimeEnvironmentVariables,
              },
              accessRoleArn,
              autoDeploymentsEnabled: news.autoDeploymentsEnabled ?? false,
              instanceConfiguration: {
                ...news.instanceConfiguration,
                instanceRoleArn,
              },
            };
            platformAttributes = {
              imageUri,
              repositoryName,
              repositoryUri,
              instanceRoleArn,
              instanceRoleName,
              accessRoleArn,
              accessRoleName,
              codeHash: hash,
            };
          } else if (
            activeBindings.some(
              (binding) =>
                (binding.data?.policyStatements?.length ?? 0) > 0 ||
                Object.keys(binding.data?.env ?? {}).length > 0,
            )
          ) {
            return yield* Effect.fail(
              new Error(
                `App Runner service '${name}' received capability bindings but uses ` +
                  "the low-level `imageRepository` form. Bindings attach IAM policies " +
                  "and environment variables to the Alchemy-managed instance role, " +
                  "which only exists for Effect-native services (`main`). Either use " +
                  "the Effect-native form or grant the permissions on your own " +
                  "`instanceConfiguration.instanceRoleArn`.",
              ),
            );
          }

          if (effective.imageRepository === undefined) {
            return yield* Effect.fail(
              new Error(
                `App Runner service '${name}' needs either \`imageRepository\` ` +
                  "(container-image form) or `main` (Effect-native form)",
              ),
            );
          }
          const desired = effective as ResolvedServiceProps;

          // 1. Observe — cloud state is authoritative; output is only an
          // identifier cache.
          let observed = output?.serviceArn
            ? yield* readService(output.serviceArn)
            : undefined;
          if (observed === undefined) {
            observed = yield* findByName(name);
          }

          // 2. Ensure — create if missing. A freshly-minted access role can
          // take a few seconds to become assumable by App Runner
          // (InvalidRequestException "Error in assuming access role") —
          // retry through that IAM-propagation window (bounded).
          if (observed === undefined) {
            const created = yield* apprunner
              .createService({
                ServiceName: name,
                SourceConfiguration: toWireSource(desired),
                InstanceConfiguration: toWireInstance(
                  desired.instanceConfiguration,
                ),
                HealthCheckConfiguration: toWireHealthCheck(
                  desired.healthCheckConfiguration,
                ),
                NetworkConfiguration: toWireNetwork(
                  desired.networkConfiguration,
                ),
                AutoScalingConfigurationArn:
                  desired.autoScalingConfigurationArn,
                ObservabilityConfiguration: toWireObservability(
                  desired.observabilityConfiguration,
                ),
                EncryptionConfiguration: desired.kmsKeyArn
                  ? { KmsKey: desired.kmsKeyArn }
                  : undefined,
                Tags: toWireTags(desiredTags),
              })
              .pipe(
                Effect.retry({
                  while: (e): boolean => e._tag === "InvalidRequestException",
                  schedule: Schedule.max([
                    Schedule.fixed("5 seconds"),
                    Schedule.recurs(12),
                  ]),
                }),
              );
            observed = created.Service;
          }

          // Creation and prior updates run asynchronously — wait (bounded)
          // for the service to settle before mutating it.
          const settled = yield* waitForSettled(observed.ServiceArn);
          if (settled === undefined) {
            return yield* Effect.fail(
              new Error(
                `App Runner service '${name}' disappeared while reconciling`,
              ),
            );
          }
          observed = settled;
          if (statusIs(observed.Status, "CREATE_FAILED")) {
            return yield* Effect.fail(
              new Error(
                `App Runner service '${name}' failed to create (status: CREATE_FAILED). ` +
                  "Check the service's event and application logs in CloudWatch.",
              ),
            );
          }

          // 3. Sync — compare each user-specified aspect against OBSERVED
          // state and send a single updateService with only the drifted
          // groups.
          const update: Omit<apprunner.UpdateServiceRequest, "ServiceArn"> = {};
          if (sourceDrifted(desired, observed.SourceConfiguration)) {
            update.SourceConfiguration = toWireSource(desired);
          }
          if (
            instanceDrifted(
              desired.instanceConfiguration,
              observed.InstanceConfiguration,
            )
          ) {
            update.InstanceConfiguration = toWireInstance(
              desired.instanceConfiguration,
            );
          }
          if (
            healthCheckDrifted(
              desired.healthCheckConfiguration,
              observed.HealthCheckConfiguration,
            )
          ) {
            update.HealthCheckConfiguration = toWireHealthCheck(
              desired.healthCheckConfiguration,
            );
          }
          if (
            networkDrifted(
              desired.networkConfiguration,
              observed.NetworkConfiguration,
            )
          ) {
            update.NetworkConfiguration = toWireNetwork(
              desired.networkConfiguration,
            );
          }
          if (
            observabilityDrifted(
              desired.observabilityConfiguration,
              observed.ObservabilityConfiguration,
            )
          ) {
            update.ObservabilityConfiguration = toWireObservability(
              desired.observabilityConfiguration,
            );
          }
          if (
            desired.autoScalingConfigurationArn !== undefined &&
            observed.AutoScalingConfigurationSummary
              ?.AutoScalingConfigurationArn !==
              desired.autoScalingConfigurationArn
          ) {
            update.AutoScalingConfigurationArn =
              desired.autoScalingConfigurationArn;
          }

          if (Object.keys(update).length > 0) {
            yield* apprunner.updateService({
              ServiceArn: observed.ServiceArn,
              ...update,
            });
            const updated = yield* waitForSettled(observed.ServiceArn);
            if (updated === undefined) {
              return yield* Effect.fail(
                new Error(
                  `App Runner service '${name}' disappeared while updating`,
                ),
              );
            }
            observed = updated;
          }

          // 3b. Sync tags — diff against OBSERVED cloud tags.
          yield* syncAppRunnerTags(observed.ServiceArn, desiredTags);

          // 4. Return fresh attributes.
          yield* session.note(name);
          return toAttrs(observed, platformAttributes);
        }),

        delete: Effect.fn(function* ({ output }) {
          // A service mid-operation rejects deletion with
          // InvalidStateException — wait (bounded) for it to settle first.
          const observed = yield* waitForSettled(output.serviceArn);
          if (observed !== undefined) {
            yield* apprunner
              .deleteService({ ServiceArn: output.serviceArn })
              .pipe(
                Effect.catchTag("ResourceNotFoundException", () => Effect.void),
                // Already deleting — deletion is in progress.
                Effect.catchTag("InvalidStateException", () => Effect.void),
              );
            yield* waitUntilGone(output.serviceArn);
          }

          // Effect-native form: also clean up the managed ECR repository and
          // IAM roles so destroying the service leaves zero leftovers.
          if (output.repositoryName !== undefined) {
            yield* ecr
              .deleteRepository({
                repositoryName: output.repositoryName,
                force: true,
              })
              .pipe(
                Effect.catchTag(
                  "RepositoryNotFoundException",
                  () => Effect.void,
                ),
              );
          }
          for (const roleName of [
            output.instanceRoleName,
            output.accessRoleName,
          ]) {
            if (roleName === undefined) continue;
            yield* iam.listRolePolicies.items({ RoleName: roleName }).pipe(
              Stream.mapEffect((policyName) =>
                iam
                  .deleteRolePolicy({
                    RoleName: roleName,
                    PolicyName: policyName,
                  })
                  .pipe(
                    Effect.catchTag("NoSuchEntityException", () => Effect.void),
                  ),
              ),
              Stream.runDrain,
              // The role may already be gone (delete re-run / race) —
              // treat a missing role as "no policies" so delete is
              // idempotent.
              Effect.catchTag("NoSuchEntityException", () => Effect.void),
            );
            yield* iam.listAttachedRolePolicies
              .items({ RoleName: roleName })
              .pipe(
                Stream.mapEffect((policy) =>
                  iam
                    .detachRolePolicy({
                      RoleName: roleName,
                      PolicyArn: policy.PolicyArn!,
                    })
                    .pipe(
                      Effect.catchTag(
                        "NoSuchEntityException",
                        () => Effect.void,
                      ),
                    ),
                ),
                Stream.runDrain,
                Effect.catchTag("NoSuchEntityException", () => Effect.void),
              );
            yield* iam
              .deleteRole({ RoleName: roleName })
              .pipe(
                Effect.catchTag("NoSuchEntityException", () => Effect.void),
              );
          }
        }),

        list: () =>
          apprunner.listServices.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk)
                .flatMap((page) => page.ServiceSummaryList ?? [])
                .flatMap((s) =>
                  s.Status !== undefined &&
                  !statusIs(s.Status, "DELETED") &&
                  s.ServiceName !== undefined &&
                  s.ServiceArn !== undefined &&
                  s.ServiceId !== undefined
                    ? [
                        {
                          serviceName: s.ServiceName,
                          serviceArn: s.ServiceArn,
                          serviceId: s.ServiceId,
                          serviceUrl: s.ServiceUrl,
                          status: s.Status,
                          ...emptyPlatformAttributes,
                        },
                      ]
                    : [],
                ),
            ),
          ),
      };
    }),
  );
