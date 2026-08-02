import * as codepipeline from "@distilled.cloud/aws/codepipeline";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

/**
 * Where a pipeline stores the artifacts it passes between stages.
 */
export interface PipelineArtifactStore {
  /**
   * Store type. Only `S3` is supported by CodePipeline.
   * @default "S3"
   */
  type?: "S3";
  /**
   * Name of the S3 bucket that holds pipeline artifacts.
   */
  location: string;
  /**
   * Optional customer-managed KMS key for artifact encryption.
   */
  encryptionKey?: {
    /** Key id or ARN. */
    id: string;
    /** Key type. */
    type: "KMS";
  };
}

/**
 * A single action within a stage — a source pull, a build, a deploy, etc.
 */
export interface PipelineActionConfig {
  /** Unique name of the action within its stage. */
  name: string;
  /** Action category. */
  category:
    | "Source"
    | "Build"
    | "Deploy"
    | "Test"
    | "Invoke"
    | "Approval"
    | "Compute";
  /** Who owns the action provider. */
  owner: "AWS" | "ThirdParty" | "Custom";
  /**
   * Action provider, e.g. `S3`, `CodeBuild`, `CodeDeploy`,
   * `CodeStarSourceConnection`.
   */
  provider: string;
  /**
   * Provider version.
   * @default "1"
   */
  version?: string;
  /**
   * Provider-specific configuration key/value map (e.g. `{ ProjectName }`
   * for CodeBuild, `{ S3Bucket, S3ObjectKey }` for an S3 source).
   */
  configuration?: Record<string, string>;
  /** Names of artifacts this action consumes. */
  inputArtifacts?: string[];
  /** Names of artifacts this action produces. */
  outputArtifacts?: string[];
  /** Order of execution within the stage (actions with the same order run in parallel). */
  runOrder?: number;
  /** Region the action runs in (for cross-region actions). */
  region?: string;
  /** IAM role the action assumes. */
  roleArn?: string;
  /** Variable namespace for referencing this action's output variables. */
  namespace?: string;
}

/**
 * A pipeline stage: a named group of actions.
 */
export interface PipelineStageConfig {
  /** Unique name of the stage. */
  name: string;
  /** Actions that make up the stage. */
  actions: PipelineActionConfig[];
}

export interface PipelineProps {
  /**
   * Name of the pipeline. If omitted a deterministic physical name is
   * generated. Changing the name replaces the pipeline.
   */
  pipelineName?: string;
  /**
   * ARN of the IAM role CodePipeline assumes. Must trust
   * `codepipeline.amazonaws.com`.
   */
  roleArn: string;
  /**
   * Artifact store for passing outputs between stages.
   */
  artifactStore: PipelineArtifactStore;
  /**
   * Ordered list of stages. A pipeline needs at least two stages, the first
   * of which contains a single source action.
   */
  stages: PipelineStageConfig[];
  /**
   * Pipeline type.
   * @default "V2"
   */
  pipelineType?: "V1" | "V2";
  /**
   * Execution mode (V2 pipelines).
   * @default "SUPERSEDED"
   */
  executionMode?: "QUEUED" | "SUPERSEDED" | "PARALLEL";
  /**
   * User-defined tags.
   */
  tags?: Record<string, string>;
}

export interface Pipeline extends Resource<
  "AWS.CodePipeline.Pipeline",
  PipelineProps,
  {
    /** Physical name of the pipeline. */
    pipelineName: string;
    /** ARN of the pipeline. */
    pipelineArn: string;
    /** Version number, incremented by CodePipeline on every structure update. */
    pipelineVersion: number;
  },
  never,
  Providers
> {}

/**
 * An AWS CodePipeline continuous-delivery pipeline: an ordered set of
 * stages, each running one or more actions (source → build → deploy), with
 * an S3 artifact store carrying outputs between them.
 *
 * Defining and updating the pipeline is instant. Pipelines that use a git
 * source require a CodeConnections connection whose OAuth handshake is
 * completed manually — use an S3 source to avoid the handshake.
 * @resource
 * @section Creating a Pipeline
 * @example S3-Source → CodeBuild Pipeline
 * ```typescript
 * const pipeline = yield* CodePipeline.Pipeline("Release", {
 *   roleArn: role.roleArn,
 *   artifactStore: { type: "S3", location: artifactBucket.bucketName },
 *   stages: [
 *     {
 *       name: "Source",
 *       actions: [{
 *         name: "S3Source",
 *         category: "Source",
 *         owner: "AWS",
 *         provider: "S3",
 *         outputArtifacts: ["SourceOutput"],
 *         configuration: {
 *           S3Bucket: sourceBucket.bucketName,
 *           S3ObjectKey: "source.zip",
 *           PollForSourceChanges: "false",
 *         },
 *       }],
 *     },
 *     {
 *       name: "Build",
 *       actions: [{
 *         name: "Build",
 *         category: "Build",
 *         owner: "AWS",
 *         provider: "CodeBuild",
 *         inputArtifacts: ["SourceOutput"],
 *         configuration: { ProjectName: project.projectName },
 *       }],
 *     },
 *   ],
 * });
 * ```
 */
export const Pipeline = Resource<Pipeline>("AWS.CodePipeline.Pipeline");

/** Convert a CodePipeline wire tag list into a plain record. */
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

const toWireArtifactStore = (
  store: PipelineArtifactStore,
): codepipeline.ArtifactStore => ({
  type: store.type ?? "S3",
  location: store.location,
  encryptionKey: store.encryptionKey,
});

const toWireStages = (
  stages: PipelineStageConfig[],
): codepipeline.StageDeclaration[] =>
  stages.map((stage) => ({
    name: stage.name,
    actions: stage.actions.map((action) => ({
      name: action.name,
      actionTypeId: {
        category: action.category,
        owner: action.owner,
        provider: action.provider,
        version: action.version ?? "1",
      },
      runOrder: action.runOrder,
      configuration: action.configuration,
      inputArtifacts: action.inputArtifacts?.map((n) => ({ name: n })),
      outputArtifacts: action.outputArtifacts?.map((n) => ({ name: n })),
      region: action.region,
      roleArn: action.roleArn,
      namespace: action.namespace,
    })),
  }));

const toWireDeclaration = (
  name: string,
  props: PipelineProps,
): codepipeline.PipelineDeclaration => ({
  name,
  roleArn: props.roleArn,
  artifactStore: toWireArtifactStore(props.artifactStore),
  stages: toWireStages(props.stages),
  pipelineType: props.pipelineType ?? "V2",
  executionMode: props.executionMode,
});

/**
 * CodePipeline validates the pipeline role at create time; a freshly created
 * IAM role is not yet assumable, surfacing as an `InvalidStructureException`
 * whose message mentions the role cannot be assumed / is not authorized.
 * Retry (bounded) through IAM propagation. The explicit return annotation
 * keeps the retry's conditional type out of declaration emit (PATTERNS §7).
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
      while: (e) => {
        const message = (e.message ?? "").toLowerCase();
        return (
          e._tag === "InvalidStructureException" &&
          (message.includes("not authorized") ||
            message.includes("cannot be assumed") ||
            message.includes("unable to assume"))
        );
      },
      schedule: Schedule.max([
        Schedule.fixed("3 seconds"),
        Schedule.recurs(10),
      ]),
    }),
  );

export const PipelineProvider = () =>
  Provider.effect(
    Pipeline,
    Effect.gen(function* () {
      const toName = (id: string, props: Partial<PipelineProps>) =>
        props.pipelineName
          ? Effect.succeed(props.pipelineName)
          : createPhysicalName({ id, maxLength: 100 });

      /** Read a pipeline; a missing pipeline reads as absent. */
      const getPipeline = Effect.fn(function* (name: string) {
        return yield* codepipeline
          .getPipeline({ name })
          .pipe(
            Effect.catchTag("PipelineNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      const syncTags = Effect.fn(function* (
        arn: string,
        desiredTags: Record<string, string>,
      ) {
        const observed = yield* codepipeline
          .listTagsForResource({ resourceArn: arn })
          .pipe(Effect.catch(() => Effect.succeed(undefined)));
        const { removed, upsert } = diffTags(
          toTagRecord(observed?.tags),
          desiredTags,
        );
        if (upsert.length > 0) {
          yield* codepipeline.tagResource({
            resourceArn: arn,
            tags: upsert.map(({ Key, Value }) => ({ key: Key, value: Value })),
          });
        }
        if (removed.length > 0) {
          yield* codepipeline.untagResource({
            resourceArn: arn,
            tagKeys: removed,
          });
        }
      });

      return {
        stables: ["pipelineName", "pipelineArn"],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            (yield* toName(id, olds ?? {})) !== (yield* toName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.pipelineName ?? (yield* toName(id, olds ?? {}));
          const found = yield* getPipeline(name);
          if (found?.metadata?.pipelineArn === undefined) return undefined;
          const attrs = {
            pipelineName: found.pipeline?.name ?? name,
            pipelineArn: found.metadata.pipelineArn,
            pipelineVersion: found.pipeline?.version ?? 1,
          };
          const tags = yield* codepipeline
            .listTagsForResource({ resourceArn: attrs.pipelineArn })
            .pipe(
              Effect.map((res) => toTagRecord(res.tags)),
              Effect.catch(() => Effect.succeed({})),
            );
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const name = output?.pipelineName ?? (yield* toName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };
          const declaration = toWireDeclaration(name, news);

          // 1. Observe — cloud state is authoritative.
          let observed = yield* getPipeline(name);

          // 2. Ensure — create if missing; tolerate the name-in-use race.
          if (observed === undefined) {
            yield* retryIamPropagation(
              codepipeline.createPipeline({
                pipeline: declaration,
                tags: Object.entries(desiredTags).map(([key, value]) => ({
                  key,
                  value,
                })),
              }),
            ).pipe(
              Effect.catchTag("PipelineNameInUseException", () => Effect.void),
            );
            observed = yield* getPipeline(name);
          } else {
            // 3. Sync — updatePipeline is a full upsert of the declaration.
            yield* retryIamPropagation(
              codepipeline.updatePipeline({ pipeline: declaration }),
            );
            observed = yield* getPipeline(name);
          }

          const arn =
            observed?.metadata?.pipelineArn ??
            `arn:aws:codepipeline:${region}:${accountId}:${name}`;

          // 3b. Sync tags — diff against OBSERVED cloud tags.
          yield* syncTags(arn, desiredTags);

          // 4. Return fresh attributes.
          yield* session.note(name);
          return {
            pipelineName: observed?.pipeline?.name ?? name,
            pipelineArn: arn,
            pipelineVersion: observed?.pipeline?.version ?? 1,
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          // deletePipeline is idempotent — a missing pipeline returns success.
          yield* codepipeline.deletePipeline({ name: output.pipelineName });
        }),

        list: () =>
          codepipeline.listPipelines.pages({}).pipe(
            Stream.runCollect,
            Effect.flatMap((chunk) =>
              Effect.gen(function* () {
                const { accountId, region } = yield* AWSEnvironment.current;
                return Array.from(chunk)
                  .flatMap((page) => page.pipelines ?? [])
                  .flatMap((p) =>
                    p.name !== undefined
                      ? [
                          {
                            pipelineName: p.name,
                            pipelineArn: `arn:aws:codepipeline:${region}:${accountId}:${p.name}`,
                            pipelineVersion: p.version ?? 1,
                          },
                        ]
                      : [],
                  );
              }),
            ),
          ),
      };
    }),
  );
