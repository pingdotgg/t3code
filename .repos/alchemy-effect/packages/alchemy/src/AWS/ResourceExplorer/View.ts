import * as re2 from "@distilled.cloud/aws/resource-explorer-2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

export interface ViewProps {
  /**
   * Name of the view. Can include letters, digits, and the dash character
   * (up to 64 characters), and must be unique within the region.
   * @default ${app}-${stage}-${id}
   */
  viewName?: string;

  /**
   * A Resource Explorer search filter that scopes every query made through
   * this view, e.g. `"service:s3"` or `"tag:stage=prod"`. Results of a
   * search are the intersection of the query and this filter.
   * Omit to leave the view unfiltered.
   */
  filterString?: string;

  /**
   * Additional resource properties to include in search results returned
   * by this view. `"tags"` is the only supported property today.
   */
  includedProperties?: string[];

  /**
   * The root ARN the view is scoped to. Defaults to the account
   * (`arn:aws:iam::<account>:root`). Changing the scope requires
   * replacement — the API offers no scope update.
   */
  scope?: string;

  /**
   * Tags to apply to the view. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

/** @resource */
export interface View extends Resource<
  "AWS.ResourceExplorer.View",
  ViewProps,
  {
    /** ARN of the view, e.g. `arn:aws:resource-explorer-2:us-west-2:123456789012:view/my-view/uuid`. */
    viewArn: string;
    /** Name of the view. */
    viewName: string;
    /** The root ARN the view is scoped to. */
    scope: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An AWS Resource Explorer view — a saved search lens with an optional
 * filter and a set of included properties that `Search` queries run
 * through.
 *
 * Views require an active `AWS.ResourceExplorer.Index` in the region.
 * When an index and a view deploy together, the view provider retries
 * through the window where the index is still provisioning.
 *
 * @section Creating Views
 * @example Unfiltered view over the whole account
 * ```typescript
 * const index = yield* AWS.ResourceExplorer.Index("Index", {});
 * const view = yield* AWS.ResourceExplorer.View("AllResources", {});
 * ```
 *
 * @example Filtered view with tags included in results
 * ```typescript
 * const view = yield* AWS.ResourceExplorer.View("S3Only", {
 *   filterString: "service:s3",
 *   includedProperties: ["tags"],
 * });
 * ```
 *
 * @section Searching
 * @example Search from a Lambda function
 * ```typescript
 * // init
 * const search = yield* AWS.ResourceExplorer.Search(view);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     const results = yield* search({ QueryString: "service:s3" });
 *     return HttpServerResponse.json({ count: results.Count });
 *   }),
 * };
 * ```
 */
const ViewResource = Resource<View>("AWS.ResourceExplorer.View");

export { ViewResource as View };

/**
 * Raised when a view can neither be created (a peer holds the name) nor
 * observed afterwards — i.e. reconciliation raced a concurrent delete.
 */
export class ViewUnobservable extends Data.TaggedError(
  "ResourceExplorerViewUnobservable",
)<{ message: string }> {}

/**
 * Resource Explorer answers `GetView`/`DeleteView` for a nonexistent or
 * deleted view with the typed `UnauthorizedException` (HTTP 401, empty
 * message) rather than `ResourceNotFoundException` — both mean "the view
 * is not there for you".
 */
const getViewSafe = Effect.fn(function* (viewArn: string) {
  return yield* re2.getView({ ViewArn: viewArn }).pipe(
    Effect.map((r): re2.GetViewOutput | undefined => r),
    Effect.catchTag(
      ["UnauthorizedException", "ResourceNotFoundException"],
      () => Effect.succeed(undefined),
    ),
  );
});

/**
 * Find a view's ARN by its name. View ARNs embed the name as the second
 * `/`-segment: `arn:...:view/{name}/{uuid}`.
 */
const findViewArnByName = Effect.fn(function* (name: string) {
  const arns = yield* re2.listViews.pages({}).pipe(
    Stream.runCollect,
    Effect.map((chunk) =>
      Array.from(chunk).flatMap((page) => page.Views ?? []),
    ),
  );
  return arns.find((arn) => arn.split("/")[1] === name);
});

/**
 * Creating a view while the region's index is still provisioning (or
 * missing) is rejected with the typed `UnauthorizedException`. When an
 * `Index` and a `View` deploy concurrently this is a transient ordering
 * race — retry through it on a bounded schedule (an index becomes ACTIVE
 * in ~15s). Explicitly-typed helper: an inline `Effect.retry` widens the
 * provider layer's declaration-emitted R to `unknown`.
 */
const retryWhileIndexProvisioning = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "UnauthorizedException",
    schedule: Schedule.max([Schedule.fixed("3 seconds"), Schedule.recurs(20)]),
  });

const toTagRecord = (
  tags: { [key: string]: string | undefined } | undefined,
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags ?? {})) {
    if (value !== undefined) out[key] = value;
  }
  return out;
};

const includedPropertyNames = (
  properties: re2.IncludedProperty[] | undefined,
): string[] => (properties ?? []).map((p) => p.Name);

const sameStringSet = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");

export const ViewProvider = () =>
  Provider.effect(
    ViewResource,
    Effect.gen(function* () {
      const createViewName = Effect.fn(function* (
        id: string,
        props: { viewName?: string | undefined },
      ) {
        return (
          props.viewName ?? (yield* createPhysicalName({ id, maxLength: 64 }))
        );
      });

      const toAttrs = (view: re2.View, name: string): View["Attributes"] => ({
        viewArn: view.ViewArn!,
        viewName: name,
        scope: view.Scope,
      });

      return ViewResource.Provider.of({
        stables: ["viewArn", "viewName"],

        list: () =>
          Effect.gen(function* () {
            const arns = yield* re2.listViews.pages({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) => page.Views ?? []),
              ),
            );
            // A view can vanish between enumeration and hydration — drop it.
            const items = yield* Effect.forEach(
              arns,
              (arn) =>
                getViewSafe(arn).pipe(
                  Effect.map((found) =>
                    found?.View?.ViewArn
                      ? toAttrs(
                          found.View,
                          found.View.ViewName ?? arn.split("/")[1]!,
                        )
                      : undefined,
                  ),
                ),
              { concurrency: 10 },
            );
            return items.filter(
              (item): item is View["Attributes"] => item !== undefined,
            );
          }),

        read: Effect.fn(function* ({ id, olds, output }) {
          // Prefer the cached ARN; fall back to a by-name scan (state may
          // have been lost after a persistence failure).
          let arn = output?.viewArn;
          if (arn === undefined) {
            const name = yield* createViewName(id, olds ?? {});
            arn = yield* findViewArnByName(name);
          }
          if (arn === undefined) return undefined;
          const found = yield* getViewSafe(arn);
          if (!found?.View?.ViewArn) return undefined;
          const attrs = toAttrs(
            found.View,
            found.View.ViewName ?? arn.split("/")[1]!,
          );
          const tags = toTagRecord(found.Tags);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createViewName(id, olds ?? {});
          const newName = yield* createViewName(id, news);
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
          // Scope has no update API — a change requires replacement.
          if ((olds ?? {}).scope !== news.scope) {
            return { action: "replace" } as const;
          }
          // Fall through: default update path handles filters/properties/tags.
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.viewName ?? (yield* createViewName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };
          const desiredProperties = news.includedProperties ?? [];
          const desiredFilter = news.filterString;

          // 1. OBSERVE — by cached ARN first, then by name (covers
          //    adoption and lost state).
          let found =
            output?.viewArn !== undefined
              ? yield* getViewSafe(output.viewArn)
              : undefined;
          if (!found?.View) {
            const arn = yield* findViewArnByName(name);
            found = arn !== undefined ? yield* getViewSafe(arn) : undefined;
          }

          // 2. ENSURE — create when missing. Retries through the window
          //    where the region's index is still provisioning, and
          //    tolerates a duplicate-name Conflict as a race (observe the
          //    winner and converge below).
          if (!found?.View) {
            found = yield* retryWhileIndexProvisioning(
              re2.createView({
                ViewName: name,
                Filters:
                  desiredFilter !== undefined
                    ? { FilterString: desiredFilter }
                    : undefined,
                IncludedProperties: desiredProperties.map((Name) => ({
                  Name,
                })),
                Scope: news.scope,
                Tags: desiredTags,
              }),
            ).pipe(
              Effect.map(
                (r): re2.GetViewOutput | undefined =>
                  r.View && { View: r.View, Tags: desiredTags },
              ),
              Effect.catchTag("ConflictException", () =>
                Effect.gen(function* () {
                  const arn = yield* findViewArnByName(name);
                  return arn !== undefined
                    ? yield* getViewSafe(arn)
                    : undefined;
                }),
              ),
            );
          }
          const view = found?.View;
          if (found === undefined || view?.ViewArn === undefined) {
            // Unreachable in practice: create either succeeded or the
            // conflicting peer exists; observation just raced a delete.
            return yield* Effect.fail(
              new ViewUnobservable({
                message: `ResourceExplorer view ${name} could not be created or observed`,
              }),
            );
          }

          // 3. SYNC — UpdateView REPLACES both Filters and
          //    IncludedProperties (omitted fields are cleared), so always
          //    send the full desired shape when either differs.
          const observedFilter = view.Filters?.FilterString;
          const observedProperties = includedPropertyNames(
            view.IncludedProperties,
          );
          if (
            (observedFilter ?? undefined) !== desiredFilter ||
            !sameStringSet(observedProperties, desiredProperties)
          ) {
            yield* re2.updateView({
              ViewArn: view.ViewArn,
              Filters:
                desiredFilter !== undefined
                  ? { FilterString: desiredFilter }
                  : undefined,
              IncludedProperties: desiredProperties.map((Name) => ({ Name })),
            });
          }

          // 3b. SYNC TAGS — diff against OBSERVED cloud tags.
          const observedTags = toTagRecord(found.Tags);
          const { upsert, removed } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* re2.tagResource({
              resourceArn: view.ViewArn,
              Tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
            });
          }
          if (removed.length > 0) {
            yield* re2.untagResource({
              resourceArn: view.ViewArn,
              tagKeys: removed,
            });
          }

          yield* session.note(view.ViewArn);
          return toAttrs(view, view.ViewName ?? name);
        }),

        delete: Effect.fn(function* ({ output }) {
          // Idempotent: a missing/deleted view answers with the typed
          // UnauthorizedException (Resource Explorer's "not found" for
          // views) or ResourceNotFoundException.
          yield* re2.deleteView({ ViewArn: output.viewArn }).pipe(
            Effect.catchTag(
              ["UnauthorizedException", "ResourceNotFoundException"],
              () => Effect.succeed(undefined),
            ),
            Effect.asVoid,
          );
        }),
      });
    }),
  );
