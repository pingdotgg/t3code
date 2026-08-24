import * as inspector2 from "@distilled.cloud/aws/inspector2";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  diffTags,
  hasAlchemyTags,
  tagRecord,
} from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

/**
 * Action applied to findings that match the filter's criteria: `NONE` keeps
 * them visible (a saved view), `SUPPRESS` hides them from default views.
 */
export type FilterAction = "NONE" | "SUPPRESS";

export interface FilterProps {
  /**
   * Name of the filter. If omitted, a unique name is generated. Updatable in
   * place — the filter's identity is its ARN.
   */
  name?: string;

  /**
   * Action applied to findings that match the criteria: `NONE` keeps them
   * visible, `SUPPRESS` hides them (a suppression rule). Updatable in place.
   */
  action: FilterAction;

  /**
   * The criteria findings are matched against, e.g.
   * `{ severity: [{ comparison: "EQUALS", value: "INFORMATIONAL" }] }`.
   * Updatable in place.
   */
  filterCriteria: inspector2.FilterCriteria;

  /**
   * Human-readable description of the filter. Updatable in place.
   */
  description?: string;

  /**
   * The reason for creating the filter (shown in the console next to
   * suppressed findings). Updatable in place.
   */
  reason?: string;

  /**
   * Tags applied to the filter. Alchemy ownership tags are merged in
   * automatically.
   */
  tags?: Record<string, string>;
}

/** @resource */
export interface Filter extends Resource<
  "AWS.Inspector2.Filter",
  FilterProps,
  {
    /** ARN of the filter (its identity). */
    arn: string;
    /** Name of the filter. */
    name: string;
    /** Account that owns the filter. */
    ownerId: string;
    /** Action applied to matching findings. */
    action: FilterAction;
    /** Description of the filter. */
    description: string | undefined;
    /** Reason recorded for the filter. */
    reason: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Amazon Inspector findings filter — matches findings against criteria
 * and either keeps them visible (`NONE`, a saved view) or suppresses them
 * (`SUPPRESS`, a suppression rule). Everything is updatable in place; the
 * filter's identity is its ARN.
 *
 * @section Suppressing Findings
 * @example Suppress informational findings
 * ```typescript
 * const filter = yield* AWS.Inspector2.Filter("SuppressInfo", {
 *   action: "SUPPRESS",
 *   reason: "Informational findings are tracked elsewhere",
 *   filterCriteria: {
 *     severity: [{ comparison: "EQUALS", value: "INFORMATIONAL" }],
 *   },
 * });
 * ```
 *
 * @example Saved view of one repository's findings
 * ```typescript
 * const filter = yield* AWS.Inspector2.Filter("RepoView", {
 *   name: "payments-repository",
 *   action: "NONE",
 *   filterCriteria: {
 *     ecrImageRepositoryName: [{ comparison: "EQUALS", value: "payments" }],
 *   },
 * });
 * ```
 */
const FilterResource = Resource<Filter>("AWS.Inspector2.Filter");

export { FilterResource as Filter };

export const FilterProvider = () =>
  Provider.effect(
    FilterResource,
    Effect.gen(function* () {
      const toName = (id: string, props: { name?: string }) =>
        props.name
          ? Effect.succeed(props.name)
          : createPhysicalName({ id, maxLength: 128 });

      const findByArn = (arn: string) =>
        inspector2
          .listFilters({ arns: [arn] })
          .pipe(Effect.map((r) => r.filters[0]));

      const findByName = (name: string) =>
        inspector2.listFilters.items({}).pipe(
          Stream.filter((f) => f.name === name),
          Stream.take(1),
          Stream.runCollect,
          Effect.map((c) => Array.from(c)[0]),
        );

      const buildAttrs = (f: inspector2.Filter) => ({
        arn: f.arn,
        name: f.name,
        ownerId: f.ownerId,
        action: f.action as FilterAction,
        description: f.description,
        reason: f.reason,
      });

      return {
        stables: ["arn", "ownerId"],
        read: Effect.fn(function* ({ id, olds, output }) {
          const live = output?.arn
            ? yield* findByArn(output.arn)
            : yield* findByName(yield* toName(id, olds ?? {}));
          if (!live) return undefined;
          const attrs = buildAttrs(live);
          return (yield* hasAlchemyTags(id, live.tags))
            ? attrs
            : Unowned(attrs);
        }),
        list: () =>
          inspector2.listFilters
            .items({})
            .pipe(Stream.map(buildAttrs), Stream.runCollect)
            .pipe(Effect.map((c) => Array.from(c))),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* toName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. OBSERVE — cloud state is authoritative. The ARN (if we have
          // one) survives renames; fall back to a name lookup otherwise.
          let live = output?.arn
            ? yield* findByArn(output.arn)
            : yield* findByName(name);

          // 2. ENSURE — create when missing. A BadRequestException here is
          // a duplicate-name race: re-observe and converge on the winner.
          if (!live) {
            const { arn } = yield* inspector2
              .createFilter({
                name,
                action: news.action,
                filterCriteria: news.filterCriteria,
                description: news.description,
                reason: news.reason,
                tags: desiredTags,
              })
              .pipe(
                Effect.catchTag("BadRequestException", () =>
                  Effect.succeed({ arn: undefined }),
                ),
              );
            live = arn ? yield* findByArn(arn) : yield* findByName(name);
            if (!live) {
              return yield* Effect.die(
                new Error(`Inspector2 filter ${name} not visible after create`),
              );
            }
          }

          // 3. SYNC settings — observed ↔ desired.
          const drift =
            live.name !== name ||
            live.action !== news.action ||
            (news.description !== undefined &&
              live.description !== news.description) ||
            (news.reason !== undefined && live.reason !== news.reason) ||
            JSON.stringify(live.criteria) !==
              JSON.stringify(news.filterCriteria);
          if (drift) {
            yield* inspector2.updateFilter({
              filterArn: live.arn,
              name,
              action: news.action,
              filterCriteria: news.filterCriteria,
              description: news.description,
              reason: news.reason,
            });
          }

          // 3b. SYNC tags — diff against OBSERVED cloud tags so adoption
          // converges foreign tags too.
          const { upsert, removed } = diffTags(
            tagRecord(live.tags),
            desiredTags,
          );
          if (upsert.length > 0) {
            yield* inspector2.tagResource({
              resourceArn: live.arn,
              tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
            });
          }
          if (removed.length > 0) {
            yield* inspector2.untagResource({
              resourceArn: live.arn,
              tagKeys: removed,
            });
          }

          // 4. RETURN fresh attributes.
          const final = yield* findByArn(live.arn);
          yield* session.note(live.arn);
          return buildAttrs(final ?? live);
        }),
        delete: Effect.fn(function* ({ output }) {
          // Idempotent — the filter may already be gone.
          yield* inspector2
            .deleteFilter({ arn: output.arn })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      };
    }),
  );
