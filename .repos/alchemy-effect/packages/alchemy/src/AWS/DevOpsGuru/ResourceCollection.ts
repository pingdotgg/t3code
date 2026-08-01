import * as devopsguru from "@distilled.cloud/aws/devops-guru";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export interface TagAppBoundary {
  /**
   * Tag key that defines an application boundary. DevOps Guru requires the
   * key to begin with `devops-guru-` (any casing, e.g.
   * `DevOps-Guru-deployment-application`).
   */
  appBoundaryKey: string;
  /**
   * Tag values that select the resources to analyze. Use `["*"]` to match
   * every resource carrying the key.
   */
  tagValues: string[];
}

export interface ResourceCollectionProps {
  /**
   * Analyze resources belonging to the named CloudFormation stacks. Use
   * `{ stackNames: ["*"] }` to analyze every stack in the account. Mutually
   * exclusive with `tags` — an account's collection uses one filter type at
   * a time.
   */
  cloudFormation?: {
    /** CloudFormation stack names to analyze (`["*"]` for all stacks). */
    stackNames: string[];
  };
  /**
   * Analyze resources carrying the given app-boundary tags. Tag keys must
   * begin with `devops-guru-` (any casing). Mutually exclusive with
   * `cloudFormation`.
   */
  tags?: TagAppBoundary[];
}

export interface ResourceCollection extends Resource<
  "AWS.DevOpsGuru.ResourceCollection",
  ResourceCollectionProps,
  {
    /** CloudFormation stack names DevOps Guru analyzes. */
    cloudFormationStackNames: string[];
    /** App-boundary tag filters DevOps Guru analyzes. */
    tags: TagAppBoundary[];
  },
  never,
  Providers
> {}

/**
 * The DevOps Guru resource collection — the account/region singleton that
 * defines which AWS resources DevOps Guru analyzes for operational insights,
 * either by CloudFormation stack or by app-boundary tag. Configuring a
 * collection is what "enables" DevOps Guru analysis in an account.
 *
 * An account has exactly one collection, so this resource is a
 * capture-and-restore singleton: adopting a collection that Alchemy did not
 * configure requires `--adopt`.
 *
 * @section Defining Coverage
 * @example Analyze specific CloudFormation stacks
 * ```typescript
 * const collection = yield* DevOpsGuru.ResourceCollection("Coverage", {
 *   cloudFormation: { stackNames: ["my-app-prod"] },
 * });
 * ```
 *
 * @example Analyze every stack in the account
 * ```typescript
 * const collection = yield* DevOpsGuru.ResourceCollection("Coverage", {
 *   cloudFormation: { stackNames: ["*"] },
 * });
 * ```
 *
 * @example Analyze resources by app-boundary tag
 * ```typescript
 * const collection = yield* DevOpsGuru.ResourceCollection("Coverage", {
 *   tags: [
 *     { appBoundaryKey: "devops-guru-app", tagValues: ["checkout", "billing"] },
 *   ],
 * });
 * ```
 * @resource
 */
export const ResourceCollection = Resource<ResourceCollection>(
  "AWS.DevOpsGuru.ResourceCollection",
);

/**
 * Concurrent `UpdateResourceCollection` calls conflict server-side — retry
 * the typed conflict tag on a short bounded schedule.
 *
 * Explicitly typed: inlining `Effect.retry` with options in provider
 * lifecycle code can widen the provider layer to `unknown` in declaration
 * emit.
 *
 * @internal
 */
const retryUpdateConflict = <A, E extends { readonly _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "ConflictException",
    schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(8)]),
  });

const sameKey = (left: string, right: string) =>
  left.toLowerCase() === right.toLowerCase();

export const ResourceCollectionProvider = () =>
  Provider.effect(
    ResourceCollection,
    Effect.gen(function* () {
      // GetResourceCollection fails with a typed ResourceNotFoundException
      // ("No CustomerResourceFilter present") when nothing has ever been
      // configured — treat that as an empty collection.
      const observeType = Effect.fn(function* (
        type: devopsguru.ResourceCollectionType,
      ) {
        return yield* devopsguru.getResourceCollection
          .pages({ ResourceCollectionType: type })
          .pipe(
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed([] as devopsguru.GetResourceCollectionResponse[]),
            ),
          );
      });

      // Observe the full account collection (both filter types).
      const observe = Effect.gen(function* () {
        const cfnPages = yield* observeType("AWS_CLOUD_FORMATION");
        const tagPages = yield* observeType("AWS_TAGS");
        const stackNames = [
          ...new Set(
            cfnPages.flatMap(
              (page) =>
                page.ResourceCollection?.CloudFormation?.StackNames ?? [],
            ),
          ),
        ].sort();
        const tagMap = new Map<string, Set<string>>();
        for (const page of tagPages) {
          for (const tag of page.ResourceCollection?.Tags ?? []) {
            const values = tagMap.get(tag.AppBoundaryKey) ?? new Set<string>();
            for (const value of tag.TagValues) values.add(value);
            tagMap.set(tag.AppBoundaryKey, values);
          }
        }
        // AWS keeps an app-boundary key with an empty TagValues list after
        // its last value is removed — a key selecting no values analyzes
        // nothing, so it is treated as absent.
        const tags = [...tagMap.entries()]
          .filter(([, values]) => values.size > 0)
          .map(([appBoundaryKey, values]) => ({
            appBoundaryKey,
            tagValues: [...values].sort(),
          }))
          .sort((l, r) => l.appBoundaryKey.localeCompare(r.appBoundaryKey));
        return { stackNames, tags };
      });

      const update = Effect.fn(function* (
        action: devopsguru.UpdateResourceCollectionAction,
        filter: devopsguru.UpdateResourceCollectionFilter,
      ) {
        yield* retryUpdateConflict(
          devopsguru.updateResourceCollection({
            Action: action,
            ResourceCollection: filter,
          }),
        );
      });

      const toAttrs = (observed: {
        stackNames: string[];
        tags: TagAppBoundary[];
      }) => ({
        cloudFormationStackNames: observed.stackNames,
        tags: observed.tags,
      });

      return {
        // Account/region singleton — the one collection, when configured.
        list: () =>
          observe.pipe(
            Effect.map((observed) =>
              observed.stackNames.length > 0 || observed.tags.length > 0
                ? [toAttrs(observed)]
                : [],
            ),
          ),

        read: Effect.fn(function* ({ output }) {
          const observed = yield* observe;
          if (observed.stackNames.length === 0 && observed.tags.length === 0) {
            return undefined;
          }
          const attrs = toAttrs(observed);
          // The collection can't carry ownership tags — a configured
          // collection we have no record of belongs to someone else until
          // explicitly adopted.
          return output !== undefined ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ news, session }) {
          const desiredStacks = news.cloudFormation?.stackNames ?? [];
          const desiredTags = news.tags ?? [];

          // 1. OBSERVE — the live account collection is authoritative.
          const observed = yield* observe;

          // 2. SYNC (removals first) — the two filter types are mutually
          //    exclusive, so pruning before adding also handles switching
          //    between CloudFormation- and tag-based coverage.
          const stacksToRemove = observed.stackNames.filter(
            (name) => !desiredStacks.includes(name),
          );
          if (stacksToRemove.length > 0) {
            yield* update("REMOVE", {
              CloudFormation: { StackNames: stacksToRemove },
            });
          }
          for (const tag of observed.tags) {
            const desired = desiredTags.find((t) =>
              sameKey(t.appBoundaryKey, tag.appBoundaryKey),
            );
            const valuesToRemove = tag.tagValues.filter(
              (value) => !(desired?.tagValues ?? []).includes(value),
            );
            if (valuesToRemove.length > 0) {
              yield* update("REMOVE", {
                Tags: [
                  {
                    AppBoundaryKey: tag.appBoundaryKey,
                    TagValues: valuesToRemove,
                  },
                ],
              });
            }
          }

          // 3. SYNC (additions) — apply only the delta.
          const stacksToAdd = desiredStacks.filter(
            (name) => !observed.stackNames.includes(name),
          );
          if (stacksToAdd.length > 0) {
            yield* update("ADD", {
              CloudFormation: { StackNames: stacksToAdd },
            });
          }
          for (const desired of desiredTags) {
            const current = observed.tags.find((t) =>
              sameKey(t.appBoundaryKey, desired.appBoundaryKey),
            );
            const valuesToAdd = desired.tagValues.filter(
              (value) => !(current?.tagValues ?? []).includes(value),
            );
            if (valuesToAdd.length > 0) {
              yield* update("ADD", {
                Tags: [
                  {
                    AppBoundaryKey: desired.appBoundaryKey,
                    TagValues: valuesToAdd,
                  },
                ],
              });
            }
          }

          // 4. RETURN fresh attributes.
          const final = yield* observe;
          yield* session.note(
            final.stackNames.length > 0
              ? `stacks: ${final.stackNames.join(", ")}`
              : `tags: ${final.tags.map((t) => t.appBoundaryKey).join(", ")}`,
          );
          return toAttrs(final);
        }),

        // Deleting the collection removes every observed filter, returning
        // the account to "DevOps Guru analyzes nothing".
        delete: Effect.fn(function* () {
          const observed = yield* observe;
          if (observed.stackNames.length > 0) {
            yield* update("REMOVE", {
              CloudFormation: { StackNames: observed.stackNames },
            });
          }
          for (const tag of observed.tags) {
            yield* update("REMOVE", {
              Tags: [
                {
                  AppBoundaryKey: tag.appBoundaryKey,
                  TagValues: tag.tagValues,
                },
              ],
            });
          }
        }),
      };
    }),
  );
