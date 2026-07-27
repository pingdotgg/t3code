import * as codebuild from "@distilled.cloud/aws/codebuild";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import { toWireMinutes } from "../../Util/Duration.ts";
import {
  normalizePolicyDocument,
  stringifyPolicyDocument,
  type PolicyDocument,
} from "../IAM/Policy.ts";
import type { Providers } from "../Providers.ts";

/**
 * Where CodeBuild fetches the source to build.
 */
export interface ProjectSourceConfig {
  /**
   * Source provider type. `NO_SOURCE` builds run only the inline `buildspec`
   * (nothing is fetched); `S3` pulls an object; the git types
   * (`CODECOMMIT`/`GITHUB`/`GITLAB`/`BITBUCKET`/…) require a matching
   * source credential or connection.
   */
  type:
    | "NO_SOURCE"
    | "S3"
    | "CODECOMMIT"
    | "CODEPIPELINE"
    | "GITHUB"
    | "GITHUB_ENTERPRISE"
    | "GITLAB"
    | "GITLAB_SELF_MANAGED"
    | "BITBUCKET";
  /**
   * Source location. Required for every type except `NO_SOURCE` and
   * `CODEPIPELINE`. For `S3` this is `bucket/path/to/object.zip`; for git
   * types it is the clone URL.
   */
  location?: string;
  /**
   * Inline build spec (YAML/JSON). Required when `type` is `NO_SOURCE`;
   * otherwise overrides the `buildspec.yml` in the source root. May also be
   * an `arn:aws:s3:::` path to a build spec object.
   */
  buildspec?: string;
  /**
   * Depth of history to fetch for git sources. `0` fetches full history.
   */
  gitCloneDepth?: number;
  /**
   * Report the build's start and completion status back to the source
   * provider (git sources only).
   */
  reportBuildStatus?: boolean;
  /**
   * Ignore TLS errors when connecting to the source (git sources only).
   */
  insecureSsl?: boolean;
}

/**
 * Where CodeBuild writes build output artifacts.
 */
export interface ProjectArtifactsConfig {
  /**
   * Artifact destination. `NO_ARTIFACTS` discards output; `S3` uploads to a
   * bucket; `CODEPIPELINE` hands artifacts back to a pipeline stage.
   * @default "NO_ARTIFACTS"
   */
  type: "NO_ARTIFACTS" | "S3" | "CODEPIPELINE";
  /**
   * Output bucket name (for `type: "S3"`).
   */
  location?: string;
  /**
   * Path inside the bucket to write to.
   */
  path?: string;
  /**
   * Whether to prefix the artifact path with the build ID.
   * @default "NONE"
   */
  namespaceType?: "NONE" | "BUILD_ID";
  /**
   * Name of the artifact object/folder.
   */
  name?: string;
  /**
   * Whether the artifact is zipped.
   * @default "NONE"
   */
  packaging?: "NONE" | "ZIP";
  /**
   * Use the artifact `name` verbatim instead of appending it to the path.
   */
  overrideArtifactName?: boolean;
  /**
   * Disable default artifact encryption.
   */
  encryptionDisabled?: boolean;
}

/**
 * An environment variable exposed to the build container.
 */
export interface ProjectEnvironmentVariable {
  /** Variable name. */
  name: string;
  /**
   * Variable value. For `PLAINTEXT` this is the literal value; for
   * `PARAMETER_STORE`/`SECRETS_MANAGER` it is the parameter name / secret
   * ARN to resolve at build time.
   */
  value: string;
  /**
   * How to interpret `value`.
   * @default "PLAINTEXT"
   */
  type?: "PLAINTEXT" | "PARAMETER_STORE" | "SECRETS_MANAGER";
}

/**
 * The build container: image, compute size, and runtime settings.
 */
export interface ProjectEnvironmentConfig {
  /**
   * Container environment type.
   * @default "LINUX_CONTAINER"
   */
  type?:
    | "LINUX_CONTAINER"
    | "LINUX_GPU_CONTAINER"
    | "ARM_CONTAINER"
    | "WINDOWS_SERVER_2019_CONTAINER"
    | "WINDOWS_SERVER_2022_CONTAINER"
    | "LINUX_LAMBDA_CONTAINER"
    | "ARM_LAMBDA_CONTAINER"
    | "MAC_ARM";
  /**
   * Docker image to run the build in, e.g.
   * `aws/codebuild/amazonlinux2-x86_64-standard:5.0`.
   */
  image: string;
  /**
   * Compute size for the build fleet.
   * @default "BUILD_GENERAL1_SMALL"
   */
  computeType?:
    | "BUILD_GENERAL1_SMALL"
    | "BUILD_GENERAL1_MEDIUM"
    | "BUILD_GENERAL1_LARGE"
    | "BUILD_GENERAL1_XLARGE"
    | "BUILD_GENERAL1_2XLARGE"
    | "BUILD_LAMBDA_1GB"
    | "BUILD_LAMBDA_2GB"
    | "BUILD_LAMBDA_4GB"
    | "BUILD_LAMBDA_8GB"
    | "BUILD_LAMBDA_10GB";
  /**
   * Environment variables available to every build.
   */
  environmentVariables?: ProjectEnvironmentVariable[];
  /**
   * Run the build container in privileged mode (required to build Docker
   * images inside the build).
   * @default false
   */
  privilegedMode?: boolean;
  /**
   * ARN of an S3 object holding a PEM-encoded certificate to install.
   */
  certificate?: string;
  /**
   * Credentials used to pull the build image.
   * @default "CODEBUILD"
   */
  imagePullCredentialsType?: "CODEBUILD" | "SERVICE_ROLE";
}

/** Build log destinations for a CodeBuild project. */
export interface ProjectLogsConfig {
  /** CloudWatch Logs delivery configuration. */
  cloudWatchLogs?: {
    /** Whether CloudWatch Logs delivery is enabled. */
    status: "ENABLED" | "DISABLED";
    /** Optional CloudWatch log group name. */
    groupName?: string;
    /** Optional CloudWatch log stream name. */
    streamName?: string;
  };
  /** S3 log delivery configuration. */
  s3Logs?: {
    /** Whether S3 log delivery is enabled. */
    status: "ENABLED" | "DISABLED";
    /** S3 bucket and prefix for build logs. */
    location?: string;
    /** Disable default encryption for S3 build logs. */
    encryptionDisabled?: boolean;
    /** Access granted to the destination bucket owner. */
    bucketOwnerAccess?: "NONE" | "READ_ONLY" | "FULL";
  };
}

export interface ProjectProps {
  /**
   * Name of the build project (2-255 chars). If omitted a deterministic
   * physical name is generated. Changing the name replaces the project.
   */
  projectName?: string;
  /**
   * Description of the project.
   */
  description?: string;
  /**
   * Source configuration.
   */
  source: ProjectSourceConfig;
  /**
   * Artifact configuration.
   * @default { type: "NO_ARTIFACTS" }
   */
  artifacts?: ProjectArtifactsConfig;
  /**
   * Build container configuration.
   */
  environment: ProjectEnvironmentConfig;
  /**
   * ARN of the IAM role CodeBuild assumes to run builds. Must trust
   * `codebuild.amazonaws.com`.
   */
  serviceRole: string;
  /**
   * How long a build may run before CodeBuild stops it, e.g. `"1 hour"`
   * (5 minutes to 36 hours). Rounded to whole minutes on the wire.
   * @default 60 minutes
   */
  timeout?: Duration.Input;
  /**
   * How long a build may sit queued before it is failed, e.g.
   * `"30 minutes"` (5 minutes to 8 hours). Rounded to whole minutes on
   * the wire.
   */
  queuedTimeout?: Duration.Input;
  /**
   * Maximum number of builds allowed to run concurrently for this project.
   */
  concurrentBuildLimit?: number;
  /**
   * KMS key ARN/alias used to encrypt build output. Defaults to the
   * account's default S3 CMK.
   */
  encryptionKey?: string;
  /**
   * Enable a publicly visible build badge.
   * @default false
   */
  badgeEnabled?: boolean;
  /**
   * Build log destinations. Set both destinations to `DISABLED` for builds
   * that do not need persisted logs.
   */
  logsConfig?: ProjectLogsConfig;
  /**
   * Resource policy attached to the project — shares the project with other
   * AWS accounts by granting them read actions such as
   * `codebuild:BatchGetProjects`. Accepts a typed {@link PolicyDocument} or a
   * raw JSON string (escape hatch / adoption of an existing policy). Omit to
   * remove any existing policy.
   */
  resourcePolicy?: PolicyDocument | string;
  /**
   * User-defined tags.
   */
  tags?: Record<string, string>;
}

export interface Project extends Resource<
  "AWS.CodeBuild.Project",
  ProjectProps,
  {
    /** Physical name of the build project. */
    projectName: string;
    /** ARN of the build project. */
    projectArn: string;
  },
  never,
  Providers
> {}

/**
 * An AWS CodeBuild build project — a reusable definition of how to run a
 * build: the source, the build container, the compute size, the IAM role,
 * and where artifacts land.
 *
 * The project is a definition only; creating it is instant and free.
 * Running a build (`StartBuild`) provisions compute and is billed per
 * build-minute.
 * @resource
 * @section Creating a Project
 * @example NO_SOURCE Project with an Inline Buildspec
 * ```typescript
 * const project = yield* CodeBuild.Project("Hello", {
 *   serviceRole: role.roleArn,
 *   source: {
 *     type: "NO_SOURCE",
 *     buildspec: [
 *       "version: 0.2",
 *       "phases:",
 *       "  build:",
 *       "    commands:",
 *       "      - echo Hello from CodeBuild",
 *     ].join("\n"),
 *   },
 *   environment: {
 *     image: "aws/codebuild/amazonlinux2-x86_64-standard:5.0",
 *     computeType: "BUILD_GENERAL1_SMALL",
 *   },
 * });
 * ```
 *
 * @example S3-Source Project with S3 Artifacts
 * ```typescript
 * const project = yield* CodeBuild.Project("Packager", {
 *   serviceRole: role.roleArn,
 *   source: { type: "S3", location: `${bucket.bucketName}/source.zip` },
 *   artifacts: { type: "S3", location: bucket.bucketName, name: "out.zip", packaging: "ZIP" },
 *   environment: {
 *     image: "aws/codebuild/amazonlinux2-x86_64-standard:5.0",
 *     environmentVariables: [{ name: "STAGE", value: "prod" }],
 *   },
 * });
 * ```
 */
export const Project = Resource<Project>("AWS.CodeBuild.Project");

/** Convert a CodeBuild wire tag list into a plain record. */
const toTagRecord = (
  tags: ReadonlyArray<{ key?: string; value?: string }> | undefined,
): Record<string, string> =>
  Object.fromEntries(
    (tags ?? [])
      .filter(
        (tag): tag is { key: string; value: string } =>
          typeof tag.key === "string" && typeof tag.value === "string",
      )
      .map((tag) => [tag.key, tag.value]),
  );

const toWireTags = (tags: Record<string, string>): codebuild.Tag[] =>
  Object.entries(tags).map(([key, value]) => ({ key, value }));

const toWireSource = (
  source: ProjectSourceConfig,
): codebuild.ProjectSource => ({
  type: source.type,
  location: source.location,
  buildspec: source.buildspec,
  gitCloneDepth: source.gitCloneDepth,
  reportBuildStatus: source.reportBuildStatus,
  insecureSsl: source.insecureSsl,
});

const toWireArtifacts = (
  artifacts: ProjectArtifactsConfig | undefined,
): codebuild.ProjectArtifacts => ({
  type: artifacts?.type ?? "NO_ARTIFACTS",
  location: artifacts?.location,
  path: artifacts?.path,
  namespaceType: artifacts?.namespaceType,
  name: artifacts?.name,
  packaging: artifacts?.packaging,
  overrideArtifactName: artifacts?.overrideArtifactName,
  encryptionDisabled: artifacts?.encryptionDisabled,
});

const toWireEnvironment = (
  environment: ProjectEnvironmentConfig,
): codebuild.ProjectEnvironment => ({
  type: environment.type ?? "LINUX_CONTAINER",
  image: environment.image,
  computeType: environment.computeType ?? "BUILD_GENERAL1_SMALL",
  environmentVariables: environment.environmentVariables?.map((v) => ({
    name: v.name,
    value: v.value,
    type: v.type,
  })),
  privilegedMode: environment.privilegedMode,
  certificate: environment.certificate,
  imagePullCredentialsType: environment.imagePullCredentialsType,
});

/**
 * CodeBuild validates the service role at create/update time; a freshly
 * created IAM role is not yet assumable, surfacing as an
 * `InvalidInputException` whose message mentions the role is not authorized.
 * Retry (bounded) through IAM propagation. The explicit return annotation
 * keeps the retry's conditional type out of declaration emit (which would
 * otherwise widen the provider layer — see PATTERNS §7).
 */
const retryIamPropagation = <
  A,
  E extends { readonly _tag: string; readonly message?: string },
  R,
>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  effect.pipe(
    Effect.retry({
      while: (e) =>
        e._tag === "InvalidInputException" &&
        (e.message ?? "").toLowerCase().includes("not authorized"),
      schedule: Schedule.max([
        Schedule.fixed("3 seconds"),
        Schedule.recurs(10),
      ]),
    }),
  );

export const ProjectProvider = () =>
  Provider.effect(
    Project,
    Effect.gen(function* () {
      const toName = (id: string, props: Partial<ProjectProps>) =>
        props.projectName
          ? Effect.succeed(props.projectName)
          : createPhysicalName({ id, maxLength: 128 });

      /** Read a project by name; a missing project reads as absent. */
      const getProject = Effect.fn(function* (name: string) {
        const response = yield* codebuild.batchGetProjects({ names: [name] });
        return response.projects?.[0];
      });

      return {
        stables: ["projectName", "projectArn"],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            (yield* toName(id, olds ?? {})) !== (yield* toName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.projectName ?? (yield* toName(id, olds ?? {}));
          const project = yield* getProject(name);
          if (project === undefined || project.arn === undefined) {
            return undefined;
          }
          const attrs = {
            projectName: project.name ?? name,
            projectArn: project.arn,
          };
          const tags = toTagRecord(project.tags);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.projectName ?? (yield* toName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // 1. Observe — cloud state is authoritative.
          let observed = yield* getProject(name);

          const spec = {
            description: news.description,
            source: toWireSource(news.source),
            artifacts: toWireArtifacts(news.artifacts),
            environment: toWireEnvironment(news.environment),
            serviceRole: news.serviceRole,
            // The CodeBuild wire unit for build/queue timeouts is whole minutes.
            timeoutInMinutes: toWireMinutes(news.timeout),
            queuedTimeoutInMinutes: toWireMinutes(news.queuedTimeout),
            concurrentBuildLimit: news.concurrentBuildLimit,
            encryptionKey: news.encryptionKey,
            badgeEnabled: news.badgeEnabled,
            logsConfig: news.logsConfig,
            tags: toWireTags(desiredTags),
          };

          // 3. Sync — updateProject is a full upsert of the definition and
          // tags; apply the desired spec (project updates are instant). A
          // delete→redeploy race can leave batchGetProjects returning the
          // just-deleted project; updateProject then reports the truth with
          // a typed ResourceNotFoundException — treat it as missing.
          if (observed !== undefined) {
            observed = yield* retryIamPropagation(
              codebuild.updateProject({ name, ...spec }),
            ).pipe(
              Effect.map((updated) => updated.project),
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          }

          // 2. Ensure — create if missing; tolerate the create/create race.
          if (observed === undefined) {
            const created = yield* retryIamPropagation(
              codebuild.createProject({ name, ...spec }),
            ).pipe(
              Effect.catchTag("ResourceAlreadyExistsException", () =>
                getProject(name).pipe(Effect.map((p) => ({ project: p }))),
              ),
            );
            observed = created.project;
          }

          if (observed === undefined || observed.arn === undefined) {
            return yield* Effect.fail(
              new Error(
                `CodeBuild project '${name}' disappeared while reconciling`,
              ),
            );
          }

          // 3b. Sync — resource policy. Compare observed against desired in
          // normalized form (keys sorted, no whitespace) so a re-deploy of an
          // equivalent document — regardless of key order or string vs typed
          // object — is a no-op that skips the API entirely.
          const desiredPolicy =
            news.resourcePolicy === undefined
              ? undefined
              : typeof news.resourcePolicy === "string"
                ? news.resourcePolicy
                : stringifyPolicyDocument(news.resourcePolicy);
          const observedPolicy = yield* codebuild
            .getResourcePolicy({ resourceArn: observed.arn })
            .pipe(
              Effect.map((res) => res.policy),
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          if (desiredPolicy === undefined) {
            if (observedPolicy !== undefined && observedPolicy !== "") {
              yield* codebuild.deleteResourcePolicy({
                resourceArn: observed.arn,
              });
            }
          } else if (
            observedPolicy === undefined ||
            normalizePolicyDocument(observedPolicy) !==
              normalizePolicyDocument(desiredPolicy)
          ) {
            yield* codebuild.putResourcePolicy({
              resourceArn: observed.arn,
              policy: desiredPolicy,
            });
          }

          // 4. Return fresh attributes.
          yield* session.note(name);
          return {
            projectName: observed.name ?? name,
            projectArn: observed.arn,
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          // deleteProject is idempotent — a missing project returns success.
          yield* codebuild.deleteProject({ name: output.projectName });
        }),

        list: () =>
          codebuild.listProjects.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) => page.projects ?? []),
            ),
            Effect.flatMap((names) =>
              names.length === 0
                ? Effect.succeed(
                    [] as { projectName: string; projectArn: string }[],
                  )
                : Effect.forEach(
                    // batchGetProjects accepts up to 100 names per call.
                    chunkNames(names, 100),
                    (batch) =>
                      codebuild
                        .batchGetProjects({ names: batch })
                        .pipe(Effect.map((res) => res.projects ?? [])),
                    { concurrency: 2 },
                  ).pipe(
                    Effect.map((results) =>
                      results
                        .flat()
                        .flatMap((p) =>
                          p.name !== undefined && p.arn !== undefined
                            ? [{ projectName: p.name, projectArn: p.arn }]
                            : [],
                        ),
                    ),
                  ),
            ),
          ),
      };
    }),
  );

/** Split a list into fixed-size chunks. */
const chunkNames = (names: string[], size: number): string[][] => {
  const chunks: string[][] = [];
  for (let i = 0; i < names.length; i += size) {
    chunks.push(names.slice(i, i + size));
  }
  return chunks;
};
