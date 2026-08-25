import * as greengrassv2 from "@distilled.cloud/aws/greengrassv2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

export interface ComponentVersionProps {
  /**
   * The inline component recipe, as a JSON or YAML string. The recipe defines
   * the component's name (`ComponentName`), version (`ComponentVersion`),
   * lifecycle, and platform capability.
   *
   * Component versions are immutable — changing the recipe replaces the
   * component version.
   */
  recipe: string;
  /**
   * Tags to apply to the component version. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface ComponentVersion extends Resource<
  "AWS.GreengrassV2.ComponentVersion",
  ComponentVersionProps,
  {
    /** The ARN of this component version. */
    arn: string;
    /** The name of the component. */
    componentName: string;
    /** The semantic version of the component. */
    componentVersion: string;
  },
  never,
  Providers
> {}

/**
 * An IoT Greengrass V2 component version created from an inline recipe.
 * Components are software modules that run on Greengrass core devices.
 *
 * Component versions are immutable in the cloud: any change to the recipe
 * replaces the component version (a new name/version pair is registered and
 * the previous one is deleted). Only tags are mutable in place.
 *
 * @resource
 * @section Creating Component Versions
 * @example Component from an inline JSON recipe
 * ```typescript
 * import * as GreengrassV2 from "alchemy/AWS/GreengrassV2";
 *
 * const component = yield* GreengrassV2.ComponentVersion("Hello", {
 *   recipe: JSON.stringify({
 *     RecipeFormatVersion: "2020-01-25",
 *     ComponentName: "com.example.Hello",
 *     ComponentVersion: "1.0.0",
 *     ComponentDescription: "Prints a greeting",
 *     ComponentPublisher: "Example",
 *     Manifests: [
 *       {
 *         Platform: { os: "linux" },
 *         Lifecycle: { run: "echo hello" },
 *       },
 *     ],
 *   }),
 * });
 * ```
 *
 * @example Tagged component version
 * ```typescript
 * const component = yield* GreengrassV2.ComponentVersion("Hello", {
 *   recipe,
 *   tags: { team: "edge" },
 * });
 * ```
 */
export const ComponentVersion = Resource<ComponentVersion>(
  "AWS.GreengrassV2.ComponentVersion",
);

/**
 * Raised when the inline recipe does not declare a `ComponentName` and
 * `ComponentVersion` that Alchemy can derive the component identity from.
 */
export class GreengrassInvalidRecipe extends Data.TaggedError(
  "GreengrassInvalidRecipe",
)<{ message: string }> {}

/**
 * Raised when the cloud reports the component version entered the `FAILED`
 * or `DEPRECATED` state instead of becoming `DEPLOYABLE`.
 */
export class GreengrassComponentFailed extends Data.TaggedError(
  "GreengrassComponentFailed",
)<{ message: string }> {}

/**
 * Internal signal used to poll a freshly created component version until the
 * cloud marks it `DEPLOYABLE`.
 */
export class GreengrassComponentNotReady extends Data.TaggedError(
  "GreengrassComponentNotReady",
)<{ message: string }> {}

// Explicitly-typed pipeable retry helper — inlining `Effect.retry` in a
// provider lifecycle op leaks `Retry.Return`'s conditional into declaration
// emit and widens the provider layer to `unknown` R for every consumer of
// `AWS.providers()`.
const retryWhileNotReady = <A, E extends { readonly _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "GreengrassComponentNotReady",
    schedule: Schedule.max([Schedule.fixed(2000), Schedule.recurs(15)]),
  });

/**
 * Derives `{ componentName, componentVersion }` from an inline recipe string.
 * JSON recipes are parsed; YAML recipes are scanned for the top-level
 * `ComponentName:` / `ComponentVersion:` keys.
 */
const parseRecipeIdentity = Effect.fn(function* (recipe: string) {
  const fromJson = yield* Effect.sync(() => {
    try {
      const parsed = JSON.parse(recipe) as Record<string, unknown>;
      const name = parsed.ComponentName;
      const version = parsed.ComponentVersion;
      return typeof name === "string" && typeof version === "string"
        ? { componentName: name, componentVersion: version }
        : undefined;
    } catch {
      return undefined;
    }
  });
  if (fromJson !== undefined) return fromJson;
  const yamlValue = (key: string) => {
    const match = recipe.match(
      new RegExp(`^${key}:[ \\t]*['"]?([^'"#\\s]+)`, "m"),
    );
    return match?.[1];
  };
  const componentName = yamlValue("ComponentName");
  const componentVersion = yamlValue("ComponentVersion");
  if (componentName === undefined || componentVersion === undefined) {
    return yield* Effect.fail(
      new GreengrassInvalidRecipe({
        message:
          "the inline recipe must declare top-level ComponentName and ComponentVersion (JSON or YAML)",
      }),
    );
  }
  return { componentName, componentVersion };
});

const normalizeTags = (
  tags: { [key: string]: string | undefined } | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(tags ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

export const ComponentVersionProvider = () =>
  Provider.effect(
    ComponentVersion,
    Effect.gen(function* () {
      // The component version ARN is deterministic from the recipe identity,
      // so read/reconcile never depend on persisted output to find it.
      const componentArn = Effect.fn(function* (recipe: string) {
        const { accountId, region } = yield* AWSEnvironment.current;
        const { componentName, componentVersion } =
          yield* parseRecipeIdentity(recipe);
        return {
          componentName,
          componentVersion,
          arn: `arn:aws:greengrass:${region}:${accountId}:components:${componentName}:versions:${componentVersion}`,
        };
      });

      const observeComponent = (arn: string) =>
        greengrassv2
          .describeComponent({ arn })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

      return ComponentVersion.Provider.of({
        stables: ["arn", "componentName", "componentVersion"],
        list: () =>
          Effect.gen(function* () {
            const components = yield* greengrassv2.listComponents
              .items({ scope: "PRIVATE" })
              .pipe(Stream.runCollect);
            const results: {
              arn: string;
              componentName: string;
              componentVersion: string;
            }[] = [];
            for (const component of components) {
              if (component.arn === undefined) continue;
              const versions = yield* greengrassv2.listComponentVersions
                .items({ arn: component.arn })
                .pipe(
                  Stream.runCollect,
                  Effect.catchTag("ResourceNotFoundException", () =>
                    Effect.succeed([] as const),
                  ),
                );
              for (const version of versions) {
                if (
                  version.arn !== undefined &&
                  version.componentName !== undefined &&
                  version.componentVersion !== undefined
                ) {
                  results.push({
                    arn: version.arn,
                    componentName: version.componentName,
                    componentVersion: version.componentVersion,
                  });
                }
              }
            }
            return results;
          }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const arn =
            output?.arn ??
            (olds !== undefined
              ? (yield* componentArn(olds.recipe)).arn
              : undefined);
          if (arn === undefined) return undefined;
          const found = yield* observeComponent(arn);
          if (
            found?.arn === undefined ||
            found.componentName === undefined ||
            found.componentVersion === undefined
          ) {
            return undefined;
          }
          const attrs = {
            arn: found.arn,
            componentName: found.componentName,
            componentVersion: found.componentVersion,
          };
          return (yield* hasAlchemyTags(id, normalizeTags(found.tags)))
            ? attrs
            : Unowned(attrs);
        }),
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          // Component versions are immutable — any recipe change replaces.
          if (olds !== undefined && news.recipe !== olds.recipe) {
            return { action: "replace" } as const;
          }
          // fall through: engine default update (tags sync in reconcile)
        }),
        reconcile: Effect.fn(function* ({ id, news, session }) {
          const identity = yield* componentArn(news.recipe);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. OBSERVE — cloud state is authoritative.
          let live = yield* observeComponent(identity.arn);

          // 2. ENSURE — create when missing. A concurrent create surfaces as
          //    the typed ConflictException / RequestAlreadyInProgressException
          //    tags, which we treat as races and re-observe.
          if (live === undefined) {
            yield* greengrassv2
              .createComponentVersion({
                inlineRecipe: new TextEncoder().encode(news.recipe),
                tags: desiredTags,
              })
              .pipe(
                Effect.catchTag(
                  ["ConflictException", "RequestAlreadyInProgressException"],
                  () => Effect.succeed(undefined),
                ),
              );
            // Wait until the cloud marks the version DEPLOYABLE (bounded ~30s;
            // inline-recipe components typically settle within seconds).
            live = yield* Effect.gen(function* () {
              const observed = yield* observeComponent(identity.arn);
              const state = observed?.status?.componentState;
              if (state === "FAILED" || state === "DEPRECATED") {
                return yield* Effect.fail(
                  new GreengrassComponentFailed({
                    message: `component ${identity.componentName}@${identity.componentVersion} entered state ${state}: ${
                      observed?.status?.message ?? "no message"
                    }`,
                  }),
                );
              }
              if (observed === undefined || state !== "DEPLOYABLE") {
                return yield* Effect.fail(
                  new GreengrassComponentNotReady({
                    message: `component ${identity.componentName}@${identity.componentVersion} is ${state ?? "missing"}`,
                  }),
                );
              }
              return observed;
            }).pipe(retryWhileNotReady);
          }

          // 3. SYNC TAGS — diff against OBSERVED cloud tags so adoption
          //    converges (create-time tags only apply on first create).
          const observedTags = normalizeTags(live.tags);
          const { upsert, removed } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* greengrassv2.tagResource({
              resourceArn: identity.arn,
              tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
            });
          }
          if (removed.length > 0) {
            yield* greengrassv2.untagResource({
              resourceArn: identity.arn,
              tagKeys: removed,
            });
          }

          yield* session.note(
            `${identity.componentName}@${identity.componentVersion}`,
          );
          return {
            arn: identity.arn,
            componentName: identity.componentName,
            componentVersion: identity.componentVersion,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* greengrassv2
            .deleteComponent({ arn: output.arn })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      });
    }),
  );
