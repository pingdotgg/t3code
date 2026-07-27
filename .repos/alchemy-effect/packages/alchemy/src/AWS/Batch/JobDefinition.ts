import * as batch from "@distilled.cloud/aws/batch";
import * as logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as ecr from "@distilled.cloud/aws/ecr";
import * as ecs from "@distilled.cloud/aws/ecs";
import * as iam from "@distilled.cloud/aws/iam";
import type { Credentials } from "../Credentials.ts";
import type { Region } from "@distilled.cloud/aws/Region";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type { Scope } from "effect/Scope";
import * as Stream from "effect/Stream";
import type * as rolldown from "rolldown";
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
import {
  Platform,
  type PlatformProps,
  type PlatformServices,
} from "../../Platform.ts";
import * as Provider from "../../Provider.ts";
import { Resource, type ResourceBinding } from "../../Resource.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import {
  createHostRuntimeContext,
  type HostRuntimeContext,
  type ServerHost,
} from "../../Server/Process.ts";
import { Stack } from "../../Stack.ts";
import {
  createInternalTags,
  createTagsList,
  diffTags,
  hasTags,
} from "../../Tags.ts";
import { toWireSeconds } from "../../Util/Duration.ts";
import { AWSEnvironment, type AccountID } from "../Environment.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";
import { buildAndPushEcrImage } from "../ECR/Image.ts";
import type { Providers } from "../Providers.ts";
import type { RegionID } from "../Region.ts";

export type JobDefinitionName = string;
/** Revision-qualified job definition ARN (`.../job-definition/{name}:{revision}`). */
export type JobDefinitionArn =
  `arn:aws:batch:${RegionID}:${AccountID}:job-definition/${JobDefinitionName}:${number}`;

/**
 * Raised when the props don't select exactly one of the two forms: the
 * low-level container form (`image` + `executionRoleArn`) or the
 * Effect-native form (`main`).
 */
export class JobDefinitionConfigError extends Data.TaggedError(
  "JobDefinitionConfigError",
)<{
  readonly message: string;
}> {}

class JobDefinitionStillVisible extends Data.TaggedError(
  "JobDefinitionStillVisible",
)<{
  readonly family: string;
  readonly service: "Batch" | "ECS";
  readonly arns: readonly string[];
}> {}

export interface JobDefinitionProps extends PlatformProps {
  /**
   * Name (family) of the job definition. If omitted, a unique name is
   * generated. Content changes register a new revision under the same name.
   */
  jobDefinitionName?: string;
  /**
   * Container image the job runs (low-level form, e.g.
   * `public.ecr.aws/docker/library/busybox:latest`). Mutually exclusive
   * with `main`.
   */
  image?: string;
  /**
   * Module entrypoint for an Effect-native run-to-completion job (typically
   * `import.meta.url` from an inline Effect program). Alchemy bundles the
   * program, builds a container image, pushes it to a managed ECR
   * repository, and provisions the job/execution IAM roles — mutually
   * exclusive with a caller-supplied `image`.
   */
  main?: string;
  /**
   * Named export to load from `main`.
   * @default "default"
   */
  handler?: string;
  /**
   * Command to run in the container (low-level form). Overridable
   * per-submission via `containerOverrides.command`. The Effect-native form
   * bakes its entrypoint into the image instead.
   */
  command?: string[];
  /**
   * Fargate vCPUs for the job. Must be a valid Fargate size (0.25, 0.5, 1,
   * 2, 4, 8, 16) compatible with `memory`.
   * @default 0.25
   */
  vcpus?: number;
  /**
   * Memory (MiB) for the job. Must be compatible with `vcpus` per the
   * Fargate size matrix.
   * @default 512
   */
  memory?: number;
  /**
   * Environment variables set in the job container.
   */
  environment?: Record<string, string>;
  /**
   * Additional environment variables for the Effect-native container.
   * Non-string values are JSON-encoded. (Capability bindings also inject
   * their variables here automatically.)
   */
  env?: Record<string, any>;
  /**
   * IAM role assumed by the job's application code. For the Effect-native
   * form (`main`), Alchemy provisions and manages this role automatically
   * (binding policy statements attach to it).
   */
  jobRoleArn?: string;
  /**
   * Execution role used by ECS/Fargate to pull the image and write logs.
   * Required for the low-level form; provisioned automatically for the
   * Effect-native form.
   */
  executionRoleArn?: string;
  /**
   * Compute platforms that can run this definition. Use `EC2` for unmanaged
   * ECS compute environments.
   * @default ["FARGATE"]
   */
  platformCapabilities?: ("EC2" | "FARGATE")[];
  /**
   * Whether the Fargate task ENI gets a public IP. Required for image pulls
   * from public registries when running in public subnets.
   * @default "ENABLED"
   */
  assignPublicIp?: "ENABLED" | "DISABLED";
  /**
   * Default parameter substitutions for `Ref::` placeholders in `command`.
   */
  parameters?: Record<string, string>;
  /**
   * Number of times a failed job is retried (1-10).
   * @default 1
   */
  retryAttempts?: number;
  /**
   * Job execution timeout (minimum 60 seconds), e.g. `"15 minutes"` or
   * `Duration.minutes(15)`.
   */
  timeout?: Duration.Input;
  /**
   * Propagate job definition tags to the ECS task.
   * @default false
   */
  propagateTags?: boolean;
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
   * Additional managed policy ARNs for the managed job role
   * (Effect-native form only).
   */
  jobRoleManagedPolicyArns?: string[];
  /**
   * User-defined tags to apply to the job definition.
   */
  tags?: Record<string, string>;
}

export interface JobDefinition extends Resource<
  "AWS.Batch.JobDefinition",
  JobDefinitionProps,
  {
    jobDefinitionName: JobDefinitionName;
    jobDefinitionArn: JobDefinitionArn;
    revision: number;
    status: string;
    tags: Record<string, string>;
    /** The full URI of the built container image (Effect-native form only). */
    imageUri: string | undefined;
    /** The managed ECR repository name (Effect-native form only). */
    repositoryName: string | undefined;
    /** The managed ECR repository URI (Effect-native form only). */
    repositoryUri: string | undefined;
    /** The ARN of the managed job role (Effect-native form only). */
    jobRoleArn: string | undefined;
    /** The name of the managed job role (Effect-native form only). */
    jobRoleName: string | undefined;
    /** The ARN of the execution role the job definition uses. */
    executionRoleArn: string | undefined;
    /** The name of the managed execution role (Effect-native form only). */
    executionRoleName: string | undefined;
    /** Content hash of the bundled program (Effect-native form only). */
    codeHash: string | undefined;
  },
  {
    /** Environment variables injected into the job container. */
    env?: Record<string, any>;
    /** IAM policy statements attached to the managed job role. */
    policyStatements?: PolicyStatement[];
  },
  Providers
> {}

export type JobDefinitionServices =
  | Credentials
  | Region
  | ServerHost
  | AWSEnvironment;

/**
 * The shape an Effect-native job implementation returns: a single `run`
 * Effect that is the run-to-completion body of the job. The container exits
 * 0 when it succeeds (job `SUCCEEDED`) and 1 when it fails (job `FAILED`,
 * subject to the definition's `retryAttempts`).
 */
export type JobDefinitionShape = void | {
  run: Effect.Effect<
    void,
    unknown,
    JobDefinitionServices | PlatformServices | RuntimeContext | Scope
  >;
};

export interface JobDefinitionRuntimeContext extends HostRuntimeContext {
  readonly Type: "AWS.Batch.JobDefinition";
}

const createJobDefinitionRuntimeContext = (
  id: string,
): JobDefinitionRuntimeContext => {
  const base = createHostRuntimeContext("AWS.Batch.JobDefinition")(id);
  return {
    ...base,
    // A Batch job is run-to-completion, not a server. `Platform` hands any
    // non-`fetch` impl shape to `serve`; register the shape's `run` Effect
    // as a host runner (collected into `exports.program`, executed by the
    // generated container entrypoint) instead of booting an HTTP server.
    serve: ((_handler, options) => {
      const run = (options?.shape as { run?: unknown } | undefined)?.run;
      return Effect.isEffect(run)
        ? base.run(run as Effect.Effect<void, never, any>)
        : Effect.void;
    }) as HostRuntimeContext["serve"],
  } as JobDefinitionRuntimeContext;
};

/**
 * An AWS Batch job definition for Fargate container jobs. Job definitions are
 * immutable revisions — changing the container configuration registers a new
 * revision under the same name (like ECS task definitions); destroying the
 * resource deregisters every active revision.
 *
 * `JobDefinition` is a Platform: alongside the low-level container form
 * (`image` + `executionRoleArn`), it supports Effect-native run-to-completion
 * implementations — an inline Effect program that Alchemy bundles,
 * containerizes as the job container's command, pushes to a managed ECR
 * repository, and registers, provisioning the job and execution roles
 * automatically. Capability bindings (e.g. S3 `GetObject`) attach IAM policy
 * statements to the managed job role and inject their environment variables
 * into the container.
 *
 * @resource
 * @section Creating Job Definitions
 * @example Busybox echo job (low-level container form)
 * ```typescript
 * const jobDef = yield* Batch.JobDefinition("EchoJob", {
 *   image: "public.ecr.aws/docker/library/busybox:latest",
 *   command: ["echo", "hello from batch"],
 *   executionRoleArn: executionRole.roleArn,
 * });
 * ```
 *
 * @example Sized job with environment
 * ```typescript
 * const jobDef = yield* Batch.JobDefinition("EtlJob", {
 *   image: image.imageUri,
 *   vcpus: 1,
 *   memory: 2048,
 *   environment: { STAGE: "prod" },
 *   jobRoleArn: jobRole.roleArn,
 *   executionRoleArn: executionRole.roleArn,
 *   retryAttempts: 3,
 *   timeout: "15 minutes",
 * });
 * ```
 *
 * @section Effect-Native Jobs
 * @example Tagged class with an inline run-to-completion Effect
 * ```typescript
 * export default class Nightly extends Batch.JobDefinition<Nightly>()(
 *   "Nightly",
 *   { main: import.meta.url, vcpus: 1, memory: 2048 },
 *   Effect.gen(function* () {
 *     const getObject = yield* AWS.S3.GetObject(bucket);
 *     return {
 *       run: Effect.gen(function* () {
 *         const data = yield* getObject({ key: "input.csv" });
 *         yield* Effect.log("processed nightly batch");
 *       }),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * @example Eager inline job
 * ```typescript
 * export default Batch.JobDefinition(
 *   "Reindex",
 *   { main: import.meta.url },
 *   Effect.succeed({
 *     run: Effect.log("reindex complete"),
 *   }),
 * );
 * ```
 *
 * @example Plain external script (bundled as-is)
 * ```typescript
 * // ./job.ts runs top-level and exits; Alchemy bundles + containerizes it.
 * const jobDef = yield* Batch.JobDefinition("Script", {
 *   main: path.join(import.meta.dirname, "job.ts"),
 * });
 * ```
 */
export const JobDefinition: Platform<
  JobDefinition,
  JobDefinitionServices,
  JobDefinitionShape,
  JobDefinitionRuntimeContext
> = Platform("AWS.Batch.JobDefinition", {
  createRuntimeContext: createJobDefinitionRuntimeContext,
});

const observedTagsOf = (d: { tags?: { [key: string]: string | undefined } }) =>
  Object.fromEntries(
    Object.entries(d.tags ?? {}).filter(
      (e): e is [string, string] => typeof e[1] === "string",
    ),
  );

/** Attributes only produced by the Effect-native (`main`) form. */
interface PlatformAttributes {
  imageUri: string | undefined;
  repositoryName: string | undefined;
  repositoryUri: string | undefined;
  jobRoleArn: string | undefined;
  jobRoleName: string | undefined;
  executionRoleName: string | undefined;
  codeHash: string | undefined;
}

const emptyPlatformAttributes: PlatformAttributes = {
  imageUri: undefined,
  repositoryName: undefined,
  repositoryUri: undefined,
  jobRoleArn: undefined,
  jobRoleName: undefined,
  executionRoleName: undefined,
  codeHash: undefined,
};

const toAttributes = (
  d: batch.JobDefinition,
  tags: Record<string, string>,
  platform: PlatformAttributes = emptyPlatformAttributes,
) => ({
  jobDefinitionName: d.jobDefinitionName!,
  jobDefinitionArn: d.jobDefinitionArn as JobDefinitionArn,
  revision: d.revision ?? 1,
  status: d.status ?? "ACTIVE",
  tags,
  executionRoleArn: d.containerProperties?.executionRoleArn,
  ...platform,
});

/**
 * The effective (resolved) container configuration a reconcile wants
 * registered — identical for both forms once the Effect-native form has
 * built its image and roles.
 */
interface EffectiveContainer {
  image: string;
  command: string[] | undefined;
  vcpus: string;
  memory: string;
  environment: Record<string, string>;
  jobRoleArn: string | undefined;
  executionRoleArn: string;
  assignPublicIp: "ENABLED" | "DISABLED";
  parameters: Record<string, string> | undefined;
  retryAttempts: number | undefined;
  timeoutSeconds: number | undefined;
  propagateTags: boolean | undefined;
}

/**
 * Normalized content fingerprint of a job definition — used to decide whether
 * a new revision must be registered. Only covers the aspects this resource
 * manages.
 */
const fingerprint = (input: {
  image?: string;
  command?: string[];
  vcpus?: string;
  memory?: string;
  environment?: Record<string, string>;
  jobRoleArn?: string;
  executionRoleArn?: string;
  assignPublicIp?: string;
  parameters?: Record<string, string>;
  retryAttempts?: number;
  timeoutSeconds?: number;
  propagateTags?: boolean;
  platformCapabilities?: ("EC2" | "FARGATE")[];
}) =>
  JSON.stringify({
    image: input.image,
    command: input.command ?? [],
    vcpus: input.vcpus,
    memory: input.memory,
    environment: Object.entries(input.environment ?? {}).sort(([a], [b]) =>
      a.localeCompare(b),
    ),
    jobRoleArn: input.jobRoleArn,
    executionRoleArn: input.executionRoleArn,
    assignPublicIp: input.assignPublicIp ?? "ENABLED",
    parameters: Object.entries(input.parameters ?? {}).sort(([a], [b]) =>
      a.localeCompare(b),
    ),
    retryAttempts: input.retryAttempts ?? 1,
    timeoutSeconds: input.timeoutSeconds,
    propagateTags: input.propagateTags ?? false,
    platformCapabilities: [
      ...(input.platformCapabilities ?? ["FARGATE"]),
    ].sort(),
  });

const observedFingerprint = (d: batch.JobDefinition) => {
  const c = d.containerProperties ?? {};
  const req = (type: string) =>
    c.resourceRequirements?.find((r) => r.type === type)?.value;
  return fingerprint({
    image: c.image,
    command: [...(c.command ?? [])],
    vcpus: req("VCPU"),
    memory: req("MEMORY"),
    environment: Object.fromEntries(
      (c.environment ?? []).flatMap((kv) =>
        kv.name !== undefined ? [[kv.name, kv.value ?? ""]] : [],
      ),
    ),
    jobRoleArn: c.jobRoleArn,
    executionRoleArn: c.executionRoleArn,
    assignPublicIp: c.networkConfiguration?.assignPublicIp,
    parameters: Object.fromEntries(
      Object.entries(d.parameters ?? {}).flatMap(([k, v]) =>
        v !== undefined ? [[k, v]] : [],
      ),
    ),
    retryAttempts: d.retryStrategy?.attempts,
    timeoutSeconds: d.timeout?.attemptDurationSeconds,
    propagateTags: d.propagateTags,
    platformCapabilities: d.platformCapabilities as
      | ("EC2" | "FARGATE")[]
      | undefined,
  });
};

const desiredFingerprint = (
  effective: EffectiveContainer,
  news: JobDefinitionProps,
) =>
  fingerprint({
    image: effective.image,
    command: effective.command,
    vcpus: effective.vcpus,
    memory: effective.memory,
    environment: effective.environment,
    jobRoleArn: effective.jobRoleArn,
    executionRoleArn: effective.executionRoleArn,
    assignPublicIp: news.assignPublicIp,
    parameters: effective.parameters,
    retryAttempts: effective.retryAttempts,
    timeoutSeconds: effective.timeoutSeconds,
    propagateTags: effective.propagateTags,
    platformCapabilities: news.platformCapabilities,
  });

export const JobDefinitionProvider = () =>
  Provider.effect(
    JobDefinition,
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

      const toName = (
        id: string,
        props: { jobDefinitionName?: string } = {},
      ) =>
        props.jobDefinitionName
          ? Effect.succeed(props.jobDefinitionName)
          : createPhysicalName({ id, maxLength: 128 });

      const createRoleName = (id: string, suffix: string) =>
        createPhysicalName({ id: `${id}-${suffix}`, maxLength: 64 });

      const createRepositoryName = (id: string) =>
        createPhysicalName({
          id: `${id}-repo`,
          maxLength: 256,
          lowercase: true,
        });

      /** Every ACTIVE revision of the family, ascending by revision. */
      const activeRevisions = (name: string) =>
        batch.describeJobDefinitions
          .pages({ jobDefinitionName: name, status: "ACTIVE" })
          .pipe(
            Stream.runCollect,
            Effect.map((pages) =>
              Array.from(pages)
                .flatMap((page) => page.jobDefinitions ?? [])
                .sort((a, b) => (a.revision ?? 0) - (b.revision ?? 0)),
            ),
          );

      const latestRevision = (name: string) =>
        activeRevisions(name).pipe(Effect.map((defs) => defs.at(-1)));

      const waitUntilNoActiveBatchRevisions = (family: string) =>
        Effect.gen(function* () {
          const active = yield* activeRevisions(family);
          if (active.length > 0) {
            return yield* Effect.fail(
              new JobDefinitionStillVisible({
                family,
                service: "Batch",
                arns: active.flatMap((revision) =>
                  revision.jobDefinitionArn ? [revision.jobDefinitionArn] : [],
                ),
              }),
            );
          }
        }).pipe(
          Effect.retry({
            while: (error) => error._tag === "JobDefinitionStillVisible",
            schedule: Schedule.max([
              Schedule.fixed("2 seconds"),
              Schedule.recurs(15),
            ]),
          }),
        );

      const listBackingTaskDefinitions = (
        family: string,
        status: "ACTIVE" | "INACTIVE",
      ) =>
        ecs.listTaskDefinitions.items({ familyPrefix: family, status }).pipe(
          Stream.filter((arn) => {
            const suffix = arn.split("/").at(-1);
            return suffix?.slice(0, suffix.lastIndexOf(":")) === family;
          }),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
        );

      const waitUntilBackingRevisionDeletionStarted = (
        family: string,
        arn: string,
      ) =>
        Effect.gen(function* () {
          const status = yield* ecs
            .describeTaskDefinition({ taskDefinition: arn })
            .pipe(
              Effect.map((response) => response.taskDefinition?.status),
              // Not-found means ECS already completed the asynchronous
              // deletion and is therefore terminal as well.
              Effect.catchTag("ClientException", () =>
                Effect.succeed(undefined),
              ),
            );
          if (status !== undefined && status !== "DELETE_IN_PROGRESS") {
            return yield* Effect.fail(
              new JobDefinitionStillVisible({
                family,
                service: "ECS",
                arns: [arn],
              }),
            );
          }
        }).pipe(
          Effect.retry({
            while: (error) => error._tag === "JobDefinitionStillVisible",
            schedule: Schedule.max([
              Schedule.fixed("2 seconds"),
              Schedule.recurs(30),
            ]),
          }),
        );

      /**
       * AWS Batch registers an ECS task definition under the same family when
       * a job first runs. It is not part of Batch's list API or Alchemy state,
       * and Batch can leave it ACTIVE after the Batch definition is gone.
       * Exact-family filtering keeps this cleanup scoped to the resource.
       */
      const reapBackingTaskDefinitions = (family: string) =>
        Effect.gen(function* () {
          const active = yield* listBackingTaskDefinitions(family, "ACTIVE");
          yield* Effect.forEach(
            active,
            (arn) =>
              ecs
                .deregisterTaskDefinition({ taskDefinition: arn })
                .pipe(Effect.catchTag("ClientException", () => Effect.void)),
            { concurrency: 4, discard: true },
          );

          // Observe ACTIVE absence before attempting the hard delete. This is
          // the transition ECS requires before deleteTaskDefinitions.
          yield* Effect.gen(function* () {
            const remaining = yield* listBackingTaskDefinitions(
              family,
              "ACTIVE",
            );
            if (remaining.length > 0) {
              return yield* Effect.fail(
                new JobDefinitionStillVisible({
                  family,
                  service: "ECS",
                  arns: remaining,
                }),
              );
            }
          }).pipe(
            Effect.retry({
              while: (error) => error._tag === "JobDefinitionStillVisible",
              schedule: Schedule.max([
                Schedule.fixed("2 seconds"),
                Schedule.recurs(15),
              ]),
            }),
          );

          const inactive = [
            ...new Set([
              ...active,
              ...(yield* listBackingTaskDefinitions(family, "INACTIVE")),
            ]),
          ];
          for (let i = 0; i < inactive.length; i += 10) {
            const response = yield* ecs.deleteTaskDefinitions({
              taskDefinitions: inactive.slice(i, i + 10),
            });
            if ((response.failures?.length ?? 0) > 0) {
              return yield* Effect.fail(
                new Error(
                  `ECS failed to delete Batch backing task definitions for ${family}: ${response.failures
                    ?.map(
                      (failure) =>
                        `${failure.arn ?? "unknown"}: ${failure.reason ?? "unknown"} (${failure.detail ?? "no detail"})`,
                    )
                    .join(", ")}`,
                ),
              );
            }
          }
          yield* Effect.forEach(
            inactive,
            (arn) => waitUntilBackingRevisionDeletionStarted(family, arn),
            { concurrency: 4, discard: true },
          );
        });

      /**
       * Ensure an IAM role trusted by ECS tasks exists (creates on miss,
       * adopts on race when it carries our tags).
       */
      const ensureRole = Effect.fn(function* ({
        id,
        roleName,
        managedPolicyArns,
      }: {
        id: string;
        roleName: string;
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
                  Principal: { Service: "ecs-tasks.amazonaws.com" },
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
          return yield* Effect.die(
            new Error(`Failed to resolve ECR repository '${repositoryName}'`),
          );
        }
        return { repositoryUri: repository.repositoryUri };
      });

      /**
       * Attach binding-declared IAM policy statements to the managed job
       * role and collect binding-declared environment variables.
       */
      const attachBindings = Effect.fn(function* ({
        roleName,
        policyName,
        bindings,
      }: {
        roleName: string;
        policyName: string;
        bindings: ResourceBinding<JobDefinition["Binding"]>[];
      }) {
        const activeBindings = bindings.filter(
          (
            binding: ResourceBinding<JobDefinition["Binding"]> & {
              action?: string;
            },
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
      const bundleProgram = Effect.fn(function* (props: JobDefinitionProps) {
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

// Resolve the bundled program (the \`run\` Effect registered by the job's
// impl shape plus any host.run loops) and run it TO COMPLETION — a Batch
// job is not a server. Exit 0 on success (job SUCCEEDED) and 1 on failure
// (job FAILED, subject to the definition's retry strategy).
const program = handler.pipe(
  Effect.flatMap((job) => job.RuntimeContext.exports),
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

console.log("Batch job bootstrap starting...");
await Effect.runPromise(program).then(
  () => {
    console.log("Batch job completed.");
    process.exit(0);
  },
  (err) => {
    console.error("Batch job failed:", err);
    process.exit(1);
  },
);
`,
              ),
            );

        // Return every emitted file (entry + shared chunks). Dynamic imports
        // in the AWS SDK split into chunks; dropping any of them crashes the
        // container with `Cannot find module './chunk-X.js'`.
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
      }: {
        id: string;
        repositoryUri: string;
        hash: string;
        files: { path: string; content: Uint8Array<ArrayBufferLike> }[];
        props: JobDefinitionProps;
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
        // Batch Fargate defaults to X86_64 — always build linux/amd64
        // (cross-built via emulation on ARM64 hosts).
        return yield* buildAndPushEcrImage(docker, {
          imageUri,
          context: contextDir,
          platform: "linux/amd64",
        });
      });

      /**
       * Delete the managed platform resources (ECR repository, job +
       * execution roles). Used by `delete` and by a reconcile that switches
       * an Effect-native definition back to the low-level form. Idempotent.
       */
      const cleanupPlatformResources = Effect.fn(function* (platform: {
        repositoryName?: string | undefined;
        jobRoleName?: string | undefined;
        executionRoleName?: string | undefined;
      }) {
        if (platform.repositoryName) {
          yield* ecr
            .deleteRepository({
              repositoryName: platform.repositoryName,
              force: true,
            })
            .pipe(
              Effect.catchTag("RepositoryNotFoundException", () => Effect.void),
            );
        }
        for (const roleName of [
          platform.jobRoleName,
          platform.executionRoleName,
        ]) {
          if (!roleName) continue;
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
                    Effect.catchTag("NoSuchEntityException", () => Effect.void),
                  ),
              ),
              Stream.runDrain,
              Effect.catchTag("NoSuchEntityException", () => Effect.void),
            );
          yield* iam
            .deleteRole({ RoleName: roleName })
            .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
        }
      });

      return {
        stables: [
          "jobDefinitionName",
          "repositoryName",
          "repositoryUri",
          "jobRoleArn",
          "jobRoleName",
          "executionRoleName",
        ],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          if (
            (yield* toName(id, olds ?? {})) !== (yield* toName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.jobDefinitionName ?? (yield* toName(id, olds ?? {}));
          const latest = yield* latestRevision(name);
          if (!latest?.jobDefinitionArn) return undefined;
          // Managed platform resources (repo, roles) are stable identifiers —
          // carry them through from the cached output.
          return toAttributes(latest, observedTagsOf(latest), {
            ...emptyPlatformAttributes,
            ...(output
              ? {
                  imageUri: output.imageUri,
                  repositoryName: output.repositoryName,
                  repositoryUri: output.repositoryUri,
                  jobRoleArn: output.jobRoleArn,
                  jobRoleName: output.jobRoleName,
                  executionRoleName: output.executionRoleName,
                  codeHash: output.codeHash,
                }
              : {}),
          });
        }),
        list: () =>
          Effect.gen(function* () {
            // Enumerate the latest ACTIVE revision of every family.
            const pages = yield* batch.describeJobDefinitions
              .pages({ status: "ACTIVE" })
              .pipe(Stream.runCollect);
            const latest = new Map<string, batch.JobDefinition>();
            for (const page of pages) {
              for (const d of page.jobDefinitions ?? []) {
                if (!d.jobDefinitionName || !d.jobDefinitionArn) continue;
                const prior = latest.get(d.jobDefinitionName);
                if (!prior || (prior.revision ?? 0) < (d.revision ?? 0)) {
                  latest.set(d.jobDefinitionName, d);
                }
              }
            }
            return Array.from(latest.values()).map((d) =>
              toAttributes(d, observedTagsOf(d)),
            );
          }),
        reconcile: Effect.fn(function* ({
          id,
          news,
          bindings,
          output,
          session,
        }) {
          const { region } = yield* AWSEnvironment.current;
          const name = output?.jobDefinitionName ?? (yield* toName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          if (news.main !== undefined && news.image !== undefined) {
            return yield* Effect.fail(
              new JobDefinitionConfigError({
                message:
                  "`main` (Effect-native form) and `image` (low-level form) are mutually exclusive",
              }),
            );
          }
          if (news.main === undefined && news.image === undefined) {
            return yield* Effect.fail(
              new JobDefinitionConfigError({
                message:
                  "one of `main` (Effect-native form) or `image` (low-level form) is required",
              }),
            );
          }
          if (news.main === undefined && news.executionRoleArn === undefined) {
            return yield* Effect.fail(
              new JobDefinitionConfigError({
                message:
                  "`executionRoleArn` is required with `image` (Fargate jobs pull the image and write logs through it)",
              }),
            );
          }

          // Resolve the effective container configuration. The Effect-native
          // form first ensures its managed roles + repository, bundles the
          // program, and builds + pushes the image; the low-level form uses
          // the caller-supplied image and roles directly. Each ensure step is
          // independently idempotent.
          let platformAttributes = emptyPlatformAttributes;
          let effective: EffectiveContainer;
          if (news.main !== undefined) {
            const jobRoleName =
              output?.jobRoleName ?? (yield* createRoleName(id, "job-role"));
            const executionRoleName =
              output?.executionRoleName ??
              (yield* createRoleName(id, "execution-role"));
            const repositoryName =
              output?.repositoryName ?? (yield* createRepositoryName(id));
            const jobPolicyName = yield* createPhysicalName({
              id: `${id}-job-policy`,
              maxLength: 128,
            });

            const jobRoleArn = yield* ensureRole({
              id,
              roleName: jobRoleName,
              managedPolicyArns: news.jobRoleManagedPolicyArns,
            });
            const executionRoleArn = yield* ensureRole({
              id,
              roleName: executionRoleName,
              managedPolicyArns: [
                "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy",
              ],
            });

            const bindingEnv = yield* attachBindings({
              roleName: jobRoleName,
              policyName: jobPolicyName,
              bindings,
            });

            const { repositoryUri } =
              output?.repositoryUri && output.repositoryName === repositoryName
                ? { repositoryUri: output.repositoryUri }
                : yield* ensureRepository({
                    repositoryName,
                    tags: desiredTags,
                  });

            const { files, hash } = yield* bundleProgram(news);
            const imageUri = yield* buildAndPushImage({
              id,
              repositoryUri,
              hash,
              files,
              props: news,
            });

            platformAttributes = {
              imageUri,
              repositoryName,
              repositoryUri,
              jobRoleArn,
              jobRoleName,
              executionRoleName,
              codeHash: hash,
            };
            effective = {
              image: imageUri,
              command: undefined,
              vcpus: String(news.vcpus ?? 0.25),
              memory: String(news.memory ?? 512),
              environment: {
                // Bindings + alchemy runtime env first (JSON-encoded), then
                // the caller's `env`, then plain `environment` wins last.
                ...Object.fromEntries(
                  Object.entries({
                    ...bindingEnv,
                    ...alchemyEnv,
                    // Fargate does not inject AWS_REGION — the bundled
                    // program's `Region.fromEnv()` needs it.
                    AWS_REGION: region,
                    ...news.env,
                  }).map(([key, value]) => [
                    key,
                    typeof value === "string" ? value : JSON.stringify(value),
                  ]),
                ),
                ...news.environment,
              },
              jobRoleArn,
              executionRoleArn,
              assignPublicIp: news.assignPublicIp ?? "ENABLED",
              parameters: news.parameters,
              retryAttempts: news.retryAttempts,
              timeoutSeconds: toWireSeconds(news.timeout),
              propagateTags: news.propagateTags,
            };
          } else {
            // Low-level form. If a previous deploy used the Effect-native
            // form, its managed repo/roles are no longer referenced — reap
            // them so nothing leaks.
            if (
              output?.repositoryName ||
              output?.jobRoleName ||
              output?.executionRoleName
            ) {
              yield* cleanupPlatformResources(output);
            }
            effective = {
              image: news.image!,
              command: news.command,
              vcpus: String(news.vcpus ?? 0.25),
              memory: String(news.memory ?? 512),
              environment: { ...news.environment },
              jobRoleArn: news.jobRoleArn,
              executionRoleArn: news.executionRoleArn!,
              assignPublicIp: news.assignPublicIp ?? "ENABLED",
              parameters: news.parameters,
              retryAttempts: news.retryAttempts,
              timeoutSeconds: toWireSeconds(news.timeout),
              propagateTags: news.propagateTags,
            };
          }

          // Observe — the latest ACTIVE revision is the live state.
          const latest = yield* latestRevision(name);

          // Ensure/Sync — register a new revision only when managed content
          // differs (revisions are immutable; registration IS the update).
          if (
            !latest ||
            observedFingerprint(latest) !== desiredFingerprint(effective, news)
          ) {
            const platformCapabilities = news.platformCapabilities ?? [
              "FARGATE",
            ];
            const registered = yield* batch.registerJobDefinition({
              jobDefinitionName: name,
              type: "container",
              platformCapabilities,
              containerProperties: {
                image: effective.image,
                command: effective.command,
                jobRoleArn: effective.jobRoleArn,
                executionRoleArn: effective.executionRoleArn,
                resourceRequirements: [
                  { type: "VCPU", value: effective.vcpus },
                  { type: "MEMORY", value: effective.memory },
                ],
                environment: Object.entries(effective.environment).map(
                  ([key, value]) => ({ name: key, value }),
                ),
                networkConfiguration: platformCapabilities.includes("FARGATE")
                  ? { assignPublicIp: effective.assignPublicIp }
                  : undefined,
              },
              parameters: effective.parameters,
              retryStrategy:
                effective.retryAttempts !== undefined
                  ? { attempts: effective.retryAttempts }
                  : undefined,
              timeout:
                effective.timeoutSeconds !== undefined
                  ? { attemptDurationSeconds: effective.timeoutSeconds }
                  : undefined,
              propagateTags: effective.propagateTags,
              tags: desiredTags,
            });
            yield* session.note(registered.jobDefinitionArn);
            return {
              jobDefinitionName: registered.jobDefinitionName,
              jobDefinitionArn: registered.jobDefinitionArn as JobDefinitionArn,
              revision: registered.revision,
              status: "ACTIVE",
              tags: desiredTags,
              executionRoleArn: effective.executionRoleArn,
              ...platformAttributes,
            };
          }

          // Content unchanged — sync tags in place on the revision ARN.
          const { upsert, removed } = diffTags(
            observedTagsOf(latest),
            desiredTags,
          );
          if (upsert.length > 0) {
            yield* batch.tagResource({
              resourceArn: latest.jobDefinitionArn!,
              tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
            });
          }
          if (removed.length > 0) {
            yield* batch.untagResource({
              resourceArn: latest.jobDefinitionArn!,
              tagKeys: removed,
            });
          }

          yield* session.note(latest.jobDefinitionArn!);
          return toAttributes(latest, desiredTags, platformAttributes);
        }),
        delete: Effect.fn(function* ({ output }) {
          // Deregister EVERY active revision of the family. Deregistration is
          // idempotent (succeeds when the revision is already gone).
          const revisions = yield* activeRevisions(output.jobDefinitionName);
          yield* Effect.forEach(
            revisions,
            (d) =>
              batch.deregisterJobDefinition({
                jobDefinition: `${d.jobDefinitionName}:${d.revision}`,
              }),
            { concurrency: 4 },
          );
          yield* waitUntilNoActiveBatchRevisions(output.jobDefinitionName);

          // A submitted Batch job causes AWSServiceRoleForBatch to create a
          // backing ECS task-definition revision with the exact same family.
          // Batch deregistration does not reliably reclaim it, so delete it
          // explicitly only after the Batch family is observed inactive.
          yield* reapBackingTaskDefinitions(output.jobDefinitionName);

          // Reap the managed platform resources (Effect-native form only).
          yield* cleanupPlatformResources(output);

          // Reap this family's log streams from the shared, service-managed
          // `/aws/batch/job` group. The awslogs driver names streams
          // `{jobDefinitionName}/default/{taskId}`, so the family prefix is
          // exact; the group itself is account-level AWS infrastructure
          // (recreated by the Batch service on the next job) and is left
          // alone.
          const logGroupName = "/aws/batch/job";
          const streams = yield* logs.describeLogStreams
            .pages({
              logGroupName,
              logStreamNamePrefix: `${output.jobDefinitionName}/`,
            })
            .pipe(
              Stream.runCollect,
              Effect.map((pages) =>
                Array.from(pages).flatMap((p) => p.logStreams ?? []),
              ),
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed([]),
              ),
            );
          yield* Effect.forEach(
            streams,
            (s) =>
              s.logStreamName === undefined
                ? Effect.void
                : logs
                    .deleteLogStream({
                      logGroupName,
                      logStreamName: s.logStreamName,
                    })
                    .pipe(
                      Effect.catchTag(
                        "ResourceNotFoundException",
                        () => Effect.void,
                      ),
                    ),
            { concurrency: 4 },
          );
        }),
      };
    }),
  );
