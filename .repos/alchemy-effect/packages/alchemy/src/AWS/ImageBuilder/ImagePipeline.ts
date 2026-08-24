import * as imagebuilder from "@distilled.cloud/aws/imagebuilder";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import { toWireMinutes } from "../../Util/Duration.ts";
import type { Providers } from "../Providers.ts";
import {
  deleteImageBuilderLogGroup,
  driftedFrom,
  imageBuilderArn,
  retryWhileDependedOn,
  syncImageBuilderTags,
  toTagRecord,
} from "./internal.ts";

/**
 * Image test settings applied to builds of the pipeline. Mirrors the wire
 * `ImageTestsConfiguration`, with the timeout expressed as a
 * {@link Duration.Input} instead of raw minutes.
 */
export interface ImageTestsConfiguration {
  /**
   * Whether to run tests on the output image.
   * @default true
   */
  imageTestsEnabled?: boolean;
  /**
   * Maximum time tests may run before they are considered failed
   * (e.g. `"90 minutes"`). AWS accepts 1 hour to 24 hours, in whole
   * minutes on the wire.
   * @default "12 hours"
   */
  timeout?: Duration.Input;
}

/** Convert the duration-typed test settings to the wire shape. */
const toWireImageTests = (
  config: ImageTestsConfiguration | undefined,
): imagebuilder.ImageTestsConfiguration | undefined =>
  config === undefined
    ? undefined
    : {
        imageTestsEnabled: config.imageTestsEnabled,
        timeoutMinutes: toWireMinutes(config.timeout),
      };

export interface ImagePipelineProps {
  /**
   * Name of the image pipeline. If omitted, a deterministic physical name
   * is generated. Changing the name replaces the pipeline.
   */
  imagePipelineName?: string;
  /**
   * ARN of the image recipe that the pipeline builds. Exactly one of
   * `imageRecipeArn` / `containerRecipeArn` is required.
   */
  imageRecipeArn?: string;
  /**
   * ARN of the container recipe that the pipeline builds.
   */
  containerRecipeArn?: string;
  /**
   * ARN of the infrastructure configuration used to build images.
   */
  infrastructureConfigurationArn: string;
  /**
   * ARN of the distribution configuration applied to output images.
   */
  distributionConfigurationArn?: string;
  /**
   * Description of the pipeline.
   */
  description?: string;
  /**
   * Image test settings (enable/disable tests, timeout).
   */
  imageTestsConfiguration?: ImageTestsConfiguration;
  /**
   * Collect additional information about the image being created,
   * including the operating system and packages.
   * @default true
   */
  enhancedImageMetadataEnabled?: boolean;
  /**
   * Build schedule (cron expression + start condition). Without a
   * schedule the pipeline only builds on manual invocation.
   */
  schedule?: imagebuilder.Schedule;
  /**
   * Whether the pipeline schedule is active.
   * @default "ENABLED"
   */
  status?: "ENABLED" | "DISABLED";
  /**
   * Image scanning (Amazon Inspector) settings for output images.
   */
  imageScanningConfiguration?: imagebuilder.ImageScanningConfiguration;
  /**
   * Custom build/test workflows to run.
   */
  workflows?: imagebuilder.WorkflowConfiguration[];
  /**
   * IAM role (name or ARN) that Image Builder assumes to run workflows.
   */
  executionRole?: string;
  /**
   * User-defined tags for the pipeline.
   */
  tags?: Record<string, string>;
}

export interface ImagePipeline extends Resource<
  "AWS.ImageBuilder.ImagePipeline",
  ImagePipelineProps,
  {
    /** The name of the image pipeline. */
    imagePipelineName: string;
    /** The ARN of the image pipeline. */
    imagePipelineArn: string;
    /** The OS platform of the pipeline's recipe (`Linux` / `Windows`). */
    platform: string | undefined;
    /** Whether the pipeline is `ENABLED` or `DISABLED`. */
    status: string | undefined;
    /** When the pipeline was created. */
    dateCreated: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An EC2 Image Builder image pipeline — wires a recipe to an infrastructure
 * configuration (and optionally a distribution configuration) and automates
 * image builds on a schedule or on demand.
 *
 * Creating the pipeline does not start a build; builds start on the
 * configured schedule or when explicitly invoked.
 * @resource
 * @section Creating an Image Pipeline
 * @example Manual-Only Pipeline
 * ```typescript
 * const pipeline = yield* ImageBuilder.ImagePipeline("Pipeline", {
 *   imageRecipeArn: recipe.imageRecipeArn,
 *   infrastructureConfigurationArn: infra.infrastructureConfigurationArn,
 *   status: "DISABLED",
 * });
 * ```
 *
 * @example Scheduled Pipeline with Distribution
 * ```typescript
 * const pipeline = yield* ImageBuilder.ImagePipeline("Nightly", {
 *   imageRecipeArn: recipe.imageRecipeArn,
 *   infrastructureConfigurationArn: infra.infrastructureConfigurationArn,
 *   distributionConfigurationArn: distribution.distributionConfigurationArn,
 *   schedule: {
 *     scheduleExpression: "cron(0 9 * * ? *)",
 *     pipelineExecutionStartCondition:
 *       "EXPRESSION_MATCH_AND_DEPENDENCY_UPDATES_AVAILABLE",
 *   },
 * });
 * ```
 */
export const ImagePipeline = Resource<ImagePipeline>(
  "AWS.ImageBuilder.ImagePipeline",
);

export const ImagePipelineProvider = () =>
  Provider.effect(
    ImagePipeline,
    Effect.gen(function* () {
      const toName = (id: string, props: ImagePipelineProps) =>
        props.imagePipelineName
          ? Effect.succeed(props.imagePipelineName)
          : createPhysicalName({ id, maxLength: 126 });

      const toArn = (name: string) => imageBuilderArn("image-pipeline", name);

      const getPipeline = Effect.fn(function* (arn: string) {
        const response = yield* imagebuilder
          .getImagePipeline({ imagePipelineArn: arn })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.imagePipeline;
      });

      const toAttrs = Effect.fn(function* (
        pipeline: imagebuilder.ImagePipeline,
      ) {
        if (!pipeline.arn || !pipeline.name) {
          return yield* Effect.fail(
            new Error(
              "Image Builder image pipeline is missing its ARN or name",
            ),
          );
        }
        return {
          imagePipelineName: pipeline.name,
          imagePipelineArn: pipeline.arn,
          platform: pipeline.platform,
          status: pipeline.status,
          dateCreated: pipeline.dateCreated,
        };
      });

      /** Mutable aspects synced by a full-PUT update. */
      const mutableKeys = [
        "description",
        "imageRecipeArn",
        "containerRecipeArn",
        "infrastructureConfigurationArn",
        "distributionConfigurationArn",
        "imageTestsConfiguration",
        "enhancedImageMetadataEnabled",
        "schedule",
        "status",
        "imageScanningConfiguration",
        "workflows",
        "executionRole",
      ] as const;

      return {
        stables: ["imagePipelineName", "imagePipelineArn"],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if ((yield* toName(id, olds)) !== (yield* toName(id, news))) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const arn =
            output?.imagePipelineArn ?? (yield* toArn(yield* toName(id, olds)));
          const pipeline = yield* getPipeline(arn);
          if (pipeline === undefined) return undefined;
          const attrs = yield* toAttrs(pipeline);
          const tags = toTagRecord(pipeline.tags);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, olds, output, session }) {
          // One idempotency token per reconcile — retries within this run
          // are deduplicated by the API.
          const clientToken = yield* Effect.sync(() => crypto.randomUUID());
          const name = output?.imagePipelineName ?? (yield* toName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };
          // Desired state in wire shape (Duration timeout → whole minutes)
          // so create/update/drift all compare like against like.
          const desired = {
            ...news,
            imageTestsConfiguration: toWireImageTests(
              news.imageTestsConfiguration,
            ),
          };

          // 1. Observe.
          const arn = output?.imagePipelineArn ?? (yield* toArn(name));
          let observed = yield* getPipeline(arn);

          // 2. Ensure — create if missing; tolerate an AlreadyExists race.
          if (observed === undefined) {
            const created = yield* imagebuilder
              .createImagePipeline({
                name,
                description: news.description,
                imageRecipeArn: news.imageRecipeArn,
                containerRecipeArn: news.containerRecipeArn,
                infrastructureConfigurationArn:
                  news.infrastructureConfigurationArn,
                distributionConfigurationArn: news.distributionConfigurationArn,
                imageTestsConfiguration: desired.imageTestsConfiguration,
                enhancedImageMetadataEnabled: news.enhancedImageMetadataEnabled,
                schedule: news.schedule,
                status: news.status,
                imageScanningConfiguration: news.imageScanningConfiguration,
                workflows: news.workflows,
                executionRole: news.executionRole,
                tags: desiredTags,
                clientToken,
              })
              .pipe(
                Effect.catchTag("ResourceAlreadyExistsException", () =>
                  Effect.succeed(undefined),
                ),
              );
            observed = yield* getPipeline(created?.imagePipelineArn ?? arn);
            if (observed === undefined) {
              return yield* Effect.fail(
                new Error(
                  `created Image Builder pipeline '${name}' is not readable`,
                ),
              );
            }
          }

          // 3. Sync — compare OBSERVED cloud state against the desired
          //    props; a full-PUT update converges any drift (`olds` is only
          //    a hint for removed props).
          const drifted = mutableKeys.some(
            (key) =>
              driftedFrom(observed?.[key], desired[key]) ||
              (desired[key] === undefined && olds?.[key] !== undefined),
          );
          if (drifted && observed.arn) {
            yield* imagebuilder.updateImagePipeline({
              imagePipelineArn: observed.arn,
              description: news.description,
              imageRecipeArn: news.imageRecipeArn,
              containerRecipeArn: news.containerRecipeArn,
              infrastructureConfigurationArn:
                news.infrastructureConfigurationArn,
              distributionConfigurationArn: news.distributionConfigurationArn,
              imageTestsConfiguration: desired.imageTestsConfiguration,
              enhancedImageMetadataEnabled: news.enhancedImageMetadataEnabled,
              schedule: news.schedule,
              status: news.status,
              imageScanningConfiguration: news.imageScanningConfiguration,
              workflows: news.workflows,
              executionRole: news.executionRole,
              clientToken,
            });
            observed = (yield* getPipeline(observed.arn)) ?? observed;
          }

          // 3b. Sync tags — diff against OBSERVED cloud tags.
          if (observed.arn) {
            yield* syncImageBuilderTags(observed.arn, desiredTags);
          }

          // 4. Return fresh attributes.
          yield* session.note(name);
          return yield* toAttrs(observed);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* retryWhileDependedOn(
            imagebuilder.deleteImagePipeline({
              imagePipelineArn: output.imagePipelineArn,
            }),
          ).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );

          // Image Builder creates this fixed group outside of the pipeline
          // API. Delete only the exact group derived from this owned output,
          // and only after the pipeline itself is observed absent.
          for (let attempt = 0; attempt < 30; attempt++) {
            if ((yield* getPipeline(output.imagePipelineArn)) === undefined) {
              yield* deleteImageBuilderLogGroup(
                `/aws/imagebuilder/pipeline/${output.imagePipelineName.toLowerCase()}`,
              );
              return;
            }
            yield* Effect.sleep("1 second");
          }
          return yield* Effect.die(
            new Error(
              `Image Builder pipeline ${output.imagePipelineArn} remained observable 30 seconds after delete`,
            ),
          );
        }),

        list: () =>
          imagebuilder.listImagePipelines.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.imagePipelineList ?? []).filter(
                  (
                    pipeline,
                  ): pipeline is imagebuilder.ImagePipeline & {
                    arn: string;
                    name: string;
                  } =>
                    pipeline.arn !== undefined && pipeline.name !== undefined,
                ),
              ),
            ),
            Effect.map((pipelines) =>
              pipelines.map((pipeline) => ({
                imagePipelineName: pipeline.name,
                imagePipelineArn: pipeline.arn,
                platform: pipeline.platform,
                status: pipeline.status,
                dateCreated: pipeline.dateCreated,
              })),
            ),
          ),
      };
    }),
  );
