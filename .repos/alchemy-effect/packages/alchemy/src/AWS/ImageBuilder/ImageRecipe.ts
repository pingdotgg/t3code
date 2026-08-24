import * as imagebuilder from "@distilled.cloud/aws/imagebuilder";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { deepEqual } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import {
  deleteImageBuilderLogGroup,
  imageBuilderArn,
  immutableVersionKeysChanged,
  retryWhileDependedOn,
  syncImageBuilderTags,
  toTagRecord,
} from "./internal.ts";

/**
 * Image Builder image recipe versions are immutable — the deployed recipe
 * differs from the desired one but the semantic version was not bumped, so
 * the cloud state cannot be converged.
 */
export class ImageRecipeVersionImmutable extends Data.TaggedError(
  "AWS::ImageBuilder::ImageRecipeVersionImmutable",
)<{
  message: string;
}> {}

export interface RecipeComponentParameter {
  /** Name of the component parameter to set. */
  name: string;
  /** Value(s) to assign to the parameter. */
  value: string[];
}

export interface RecipeComponent {
  /**
   * Build-version ARN of the component to apply
   * (e.g. `component.componentBuildVersionArn`).
   */
  componentArn: string;
  /** Parameter overrides for parameterized components. */
  parameters?: RecipeComponentParameter[];
}

export interface ImageRecipeProps {
  /**
   * Name of the image recipe. If omitted, a deterministic physical name is
   * generated. Changing the name replaces the recipe.
   */
  imageRecipeName?: string;
  /**
   * Semantic version of the recipe (`major.minor.patch`). Recipes are
   * immutable — bump the version when changing any property. Changing the
   * version replaces the recipe.
   * @default "1.0.0"
   */
  semanticVersion?: string;
  /**
   * Base image of the recipe: an Image Builder image ARN (e.g. the
   * AWS-managed `arn:aws:imagebuilder:us-west-2:aws:image/amazon-linux-2023-x86/x.x.x`),
   * an AMI ID, or an SSM parameter reference (`ssm:/path/to/parameter`).
   * Changing the parent image replaces the recipe.
   */
  parentImage: string;
  /**
   * Components applied to the image, in order. Changing the component list
   * replaces the recipe.
   */
  components: RecipeComponent[];
  /**
   * Description of the recipe. Changing it replaces the recipe.
   */
  description?: string;
  /**
   * Block device mappings for instances built from the recipe. Changing
   * them replaces the recipe.
   */
  blockDeviceMappings?: imagebuilder.InstanceBlockDeviceMapping[];
  /**
   * Working directory used during build and test workflows.
   * Changing it replaces the recipe.
   * @default "/tmp"
   */
  workingDirectory?: string;
  /**
   * Additional instance configuration (SSM agent removal, user data
   * override). Changing it replaces the recipe.
   */
  additionalInstanceConfiguration?: imagebuilder.AdditionalInstanceConfiguration;
  /**
   * Tags applied to output AMIs created from the recipe. Changing them
   * replaces the recipe.
   */
  amiTags?: Record<string, string>;
  /**
   * User-defined tags for the recipe.
   */
  tags?: Record<string, string>;
}

export interface ImageRecipe extends Resource<
  "AWS.ImageBuilder.ImageRecipe",
  ImageRecipeProps,
  {
    /** The name of the image recipe. */
    imageRecipeName: string;
    /** The ARN of the image recipe. */
    imageRecipeArn: string;
    /** The semantic version of the recipe. */
    semanticVersion: string;
    /** The OS platform of the recipe (`Linux` / `Windows`). */
    platform: string | undefined;
    /** The base image the recipe builds on. */
    parentImage: string | undefined;
    /** When the recipe was created. */
    dateCreated: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An EC2 Image Builder image recipe — the blueprint that combines a parent
 * image with an ordered list of components to produce a new AMI.
 *
 * Recipes are immutable versions: every property except `tags` replaces the
 * recipe. Bump `semanticVersion` when changing the definition.
 * @resource
 * @section Creating an Image Recipe
 * @example Recipe from an AWS-Managed Parent Image
 * ```typescript
 * const recipe = yield* ImageBuilder.ImageRecipe("Recipe", {
 *   parentImage: "arn:aws:imagebuilder:us-west-2:aws:image/amazon-linux-2023-x86/x.x.x",
 *   semanticVersion: "1.0.0",
 *   components: [{ componentArn: component.componentBuildVersionArn }],
 * });
 * ```
 *
 * @section Using in a Pipeline
 * @example Wire into an Image Pipeline
 * ```typescript
 * const pipeline = yield* ImageBuilder.ImagePipeline("Pipeline", {
 *   imageRecipeArn: recipe.imageRecipeArn,
 *   infrastructureConfigurationArn: infra.infrastructureConfigurationArn,
 * });
 * ```
 */
export const ImageRecipe = Resource<ImageRecipe>(
  "AWS.ImageBuilder.ImageRecipe",
);

export const ImageRecipeProvider = () =>
  Provider.effect(
    ImageRecipe,
    Effect.gen(function* () {
      const toName = (id: string, props: ImageRecipeProps) =>
        props.imageRecipeName
          ? Effect.succeed(props.imageRecipeName)
          : createPhysicalName({ id, maxLength: 126 });

      const toVersion = (props: ImageRecipeProps) =>
        props.semanticVersion ?? "1.0.0";

      const toArn = (name: string, version: string) =>
        imageBuilderArn("image-recipe", `${name}/${version}`);

      const getRecipe = Effect.fn(function* (arn: string) {
        const response = yield* imagebuilder
          .getImageRecipe({ imageRecipeArn: arn })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.imageRecipe;
      });

      const toAttrs = Effect.fn(function* (recipe: imagebuilder.ImageRecipe) {
        if (!recipe.arn || !recipe.name || !recipe.version) {
          return yield* Effect.fail(
            new Error(
              "Image Builder image recipe is missing its ARN, name, or version",
            ),
          );
        }
        return {
          imageRecipeName: recipe.name,
          imageRecipeArn: recipe.arn,
          semanticVersion: recipe.version,
          platform: recipe.platform,
          parentImage: recipe.parentImage,
          dateCreated: recipe.dateCreated,
        };
      });

      return {
        stables: ["imageRecipeName", "semanticVersion"],

        // Recipes are immutable — any changed property except tags
        // replaces. Individual keys may still hold unresolved Outputs at
        // plan time (e.g. the ARN of a component being replaced in the
        // same deploy); compare per key so a resolved change (like a
        // semanticVersion bump) still plans a replacement, and let the
        // reconcile immutability guard catch drift hidden behind an
        // unresolved key.
        diff: Effect.fn(function* ({ olds, news }) {
          const immutableKeys = [
            "imageRecipeName",
            "semanticVersion",
            "parentImage",
            "components",
            "description",
            "blockDeviceMappings",
            "workingDirectory",
            "additionalInstanceConfiguration",
            "amiTags",
          ] as const;
          if (immutableVersionKeysChanged(olds, news, immutableKeys)) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const arn =
            output?.imageRecipeArn ??
            (yield* toArn(yield* toName(id, olds), toVersion(olds)));
          const recipe = yield* getRecipe(arn);
          if (recipe === undefined) return undefined;
          const attrs = yield* toAttrs(recipe);
          const tags = toTagRecord(recipe.tags);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          // One idempotency token per reconcile — retries within this run
          // are deduplicated by the API.
          const clientToken = yield* Effect.sync(() => crypto.randomUUID());
          const name = output?.imageRecipeName ?? (yield* toName(id, news));
          const version = output?.semanticVersion ?? toVersion(news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // 1. Observe — the recipe ARN is deterministic from name+version.
          const arn = output?.imageRecipeArn ?? (yield* toArn(name, version));
          let observed = yield* getRecipe(arn);

          // Immutability guard — the version already exists in the cloud
          // with a different definition (e.g. a component was replaced
          // without bumping the recipe version). It cannot be converged in
          // place; the user must bump `semanticVersion`.
          if (observed !== undefined) {
            const observedComponents = (observed.components ?? []).map(
              (component) => component.componentArn,
            );
            const desiredComponents = news.components.map(
              (component) => component.componentArn,
            );
            if (
              !deepEqual(observedComponents, desiredComponents) ||
              observed.parentImage !== news.parentImage
            ) {
              return yield* new ImageRecipeVersionImmutable({
                message: `Image Builder recipe '${name}' version '${version}' already exists with a different definition — bump semanticVersion to publish the change`,
              });
            }
          }

          // 2. Ensure — recipes are immutable; missing is the only create
          //    path.
          if (observed === undefined) {
            const created = yield* imagebuilder.createImageRecipe({
              name,
              semanticVersion: version,
              parentImage: news.parentImage,
              components: news.components,
              description: news.description,
              blockDeviceMappings: news.blockDeviceMappings,
              workingDirectory: news.workingDirectory,
              additionalInstanceConfiguration:
                news.additionalInstanceConfiguration,
              amiTags: news.amiTags,
              tags: desiredTags,
              clientToken,
            });
            if (!created.imageRecipeArn) {
              return yield* Effect.fail(
                new Error("CreateImageRecipe returned no imageRecipeArn"),
              );
            }
            observed = yield* getRecipe(created.imageRecipeArn);
            if (observed === undefined) {
              return yield* Effect.fail(
                new Error(
                  `created Image Builder recipe '${name}' is not readable`,
                ),
              );
            }
          }

          // 3. Sync — tags are the only mutable aspect.
          if (observed.arn) {
            yield* syncImageBuilderTags(observed.arn, desiredTags);
          }

          // 4. Return fresh attributes.
          yield* session.note(name);
          return yield* toAttrs(observed);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* retryWhileDependedOn(
            imagebuilder.deleteImageRecipe({
              imageRecipeArn: output.imageRecipeArn,
            }),
          ).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );

          // Do not discard state until Image Builder confirms the owned
          // version is gone. The auto-created recipe log group is shared by
          // every version with the same name, so delete it only when no live
          // same-name recipe remains (including a replacement version).
          for (let attempt = 0; attempt < 30; attempt++) {
            if ((yield* getRecipe(output.imageRecipeArn)) === undefined) break;
            if (attempt === 29) {
              return yield* Effect.die(
                new Error(
                  `Image Builder recipe ${output.imageRecipeArn} remained observable 30 seconds after delete`,
                ),
              );
            }
            yield* Effect.sleep("1 second");
          }

          const summaries = yield* imagebuilder.listImageRecipes
            .pages({ owner: "Self" })
            .pipe(
              Stream.runCollect,
              Effect.map((pages) =>
                Array.from(pages).flatMap(
                  (page) => page.imageRecipeSummaryList ?? [],
                ),
              ),
            );
          const sameName = summaries.filter(
            (summary) =>
              summary.name === output.imageRecipeName &&
              summary.arn !== undefined,
          );
          const liveSameName = yield* Effect.forEach(
            sameName,
            (summary) => getRecipe(summary.arn!),
            { concurrency: 4 },
          );
          if (liveSameName.every((recipe) => recipe === undefined)) {
            yield* deleteImageBuilderLogGroup(
              `/aws/imagebuilder/${output.imageRecipeName}`,
            );
          }
        }),

        list: () =>
          imagebuilder.listImageRecipes.pages({ owner: "Self" }).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.imageRecipeSummaryList ?? []).filter(
                  (
                    summary,
                  ): summary is imagebuilder.ImageRecipeSummary & {
                    arn: string;
                  } => summary.arn !== undefined,
                ),
              ),
            ),
            Effect.flatMap(
              Effect.forEach(
                (summary) =>
                  getRecipe(summary.arn).pipe(
                    Effect.flatMap((recipe) =>
                      recipe === undefined
                        ? Effect.succeed(undefined)
                        : toAttrs(recipe),
                    ),
                  ),
                { concurrency: 4 },
              ),
            ),
            Effect.map((items) => items.filter((item) => item !== undefined)),
          ),
      };
    }),
  );
