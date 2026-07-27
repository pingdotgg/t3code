import * as guardduty from "@distilled.cloud/aws/guardduty";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  diffTags,
  hasAlchemyTags,
  tagRecord,
} from "../../Tags.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

/** Action taken on findings that match the filter's criteria. */
export type FilterAction = "NOOP" | "ARCHIVE";

export interface FilterProps {
  /**
   * ID of the detector the filter belongs to. Changing this replaces the
   * filter.
   */
  detectorId: string;

  /**
   * Name of the filter (3-64 alphanumeric, `.`, `_`, `-` characters). If
   * omitted, a unique name is generated. Changing this replaces the filter.
   */
  name?: string;

  /**
   * Human-readable description of the filter. Updatable in place.
   */
  description?: string;

  /**
   * Action applied to findings that match the criteria: `NOOP` keeps them
   * visible, `ARCHIVE` auto-archives them. Updatable in place.
   * @default "NOOP"
   */
  action?: FilterAction;

  /**
   * Position of the filter relative to other filters (1 is evaluated first).
   * Updatable in place.
   */
  rank?: number;

  /**
   * The criteria findings are matched against, e.g.
   * `{ Criterion: { severity: { Gte: 7 } } }`. Updatable in place.
   */
  findingCriteria: guardduty.FindingCriteria;

  /**
   * Tags applied to the filter. Alchemy ownership tags are merged in
   * automatically.
   */
  tags?: Record<string, string>;
}

/** @resource */
export interface Filter extends Resource<
  "AWS.GuardDuty.Filter",
  FilterProps,
  {
    /** ID of the detector the filter belongs to. */
    detectorId: string;
    /** Name of the filter (its identity within the detector). */
    name: string;
    /** ARN of the filter. */
    filterArn: string;
    /** Action applied to matching findings. */
    action: FilterAction;
    /** Description of the filter. */
    description: string | undefined;
    /** Evaluation rank of the filter. */
    rank: number | undefined;
  },
  never,
  Providers
> {}

/**
 * A GuardDuty findings filter — matches findings against criteria and either
 * keeps (`NOOP`) or auto-archives (`ARCHIVE`) them. Identity is the
 * `(detectorId, name)` pair; description, action, rank, and criteria are
 * updatable in place.
 *
 * @section Filtering Findings
 * @example Auto-archive low-severity findings
 * ```typescript
 * const detector = yield* AWS.GuardDuty.Detector("Detector", {});
 * const filter = yield* AWS.GuardDuty.Filter("LowSeverity", {
 *   detectorId: detector.detectorId,
 *   action: "ARCHIVE",
 *   rank: 1,
 *   findingCriteria: { Criterion: { severity: { LessThan: 4 } } },
 * });
 * ```
 *
 * @example Keep a named filter for the console
 * ```typescript
 * const filter = yield* AWS.GuardDuty.Filter("ProdOnly", {
 *   detectorId: detector.detectorId,
 *   name: "prod-only",
 *   description: "Findings on production resources",
 *   findingCriteria: {
 *     Criterion: { "resource.instanceDetails.tags.value": { Equals: ["prod"] } },
 *   },
 * });
 * ```
 */
const FilterResource = Resource<Filter>("AWS.GuardDuty.Filter");

export { FilterResource as Filter };

const filterArn = (
  region: string,
  accountId: string,
  detectorId: string,
  name: string,
) =>
  `arn:aws:guardduty:${region}:${accountId}:detector/${detectorId}/filter/${name}`;

export const FilterProvider = () =>
  Provider.effect(
    FilterResource,
    Effect.gen(function* () {
      // Filter names: [a-zA-Z0-9.\-_]{3,64}. The engine name is compatible.
      const toName = (id: string, props: { name?: string }) =>
        props.name
          ? Effect.succeed(props.name)
          : createPhysicalName({ id, maxLength: 64 });

      const getFilter = (detectorId: string, name: string) =>
        guardduty
          .getFilter({ DetectorId: detectorId, FilterName: name })
          .pipe(
            Effect.catchTag("BadRequestException", () =>
              Effect.succeed(undefined),
            ),
          );

      const buildAttrs = Effect.fn(function* (
        detectorId: string,
        name: string,
        f: guardduty.GetFilterResponse,
      ) {
        const { accountId, region } = yield* AWSEnvironment.current;
        return {
          detectorId,
          name,
          filterArn: filterArn(region, accountId, detectorId, name),
          action: f.Action as FilterAction,
          description: f.Description,
          rank: f.Rank,
        };
      });

      return {
        stables: ["detectorId", "name", "filterArn"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          if (olds === undefined) return;
          if (olds.detectorId !== news.detectorId) {
            return { action: "replace" } as const;
          }
          if ((yield* toName(id, olds)) !== (yield* toName(id, news))) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const detectorId = output?.detectorId ?? olds?.detectorId;
          if (!detectorId) return undefined;
          const name = output?.name ?? (yield* toName(id, olds ?? {}));
          const f = yield* getFilter(detectorId, name);
          if (!f) return undefined;
          const attrs = yield* buildAttrs(detectorId, name, f);
          return (yield* hasAlchemyTags(id, f.Tags)) ? attrs : Unowned(attrs);
        }),
        list: () =>
          Effect.gen(function* () {
            const { DetectorIds } = yield* guardduty.listDetectors({});
            const out: Filter["Attributes"][] = [];
            for (const detectorId of DetectorIds ?? []) {
              const pages = yield* guardduty.listFilters
                .pages({ DetectorId: detectorId })
                .pipe(Stream.runCollect);
              const names = Array.from(pages).flatMap(
                (page) => page.FilterNames ?? [],
              );
              for (const name of names) {
                const f = yield* getFilter(detectorId, name);
                if (f) out.push(yield* buildAttrs(detectorId, name, f));
              }
            }
            return out;
          }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const detectorId = news.detectorId;
          const name = output?.name ?? (yield* toName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. OBSERVE — cloud state is authoritative.
          const live = yield* getFilter(detectorId, name);

          if (!live) {
            // 2. ENSURE — create with tags applied inline.
            yield* guardduty.createFilter({
              DetectorId: detectorId,
              Name: name,
              Description: news.description,
              Action: news.action,
              Rank: news.rank,
              FindingCriteria: news.findingCriteria,
              Tags: desiredTags,
            });
          } else {
            // 3. SYNC settings — observed ↔ desired.
            const desiredAction = news.action ?? "NOOP";
            const drift =
              live.Action !== desiredAction ||
              (news.description !== undefined &&
                live.Description !== news.description) ||
              (news.rank !== undefined && live.Rank !== news.rank) ||
              JSON.stringify(live.FindingCriteria) !==
                JSON.stringify(news.findingCriteria);
            if (drift) {
              yield* guardduty.updateFilter({
                DetectorId: detectorId,
                FilterName: name,
                Description: news.description,
                Action: desiredAction,
                Rank: news.rank,
                FindingCriteria: news.findingCriteria,
              });
            }

            // 3b. SYNC tags — diff against OBSERVED cloud tags.
            const { accountId, region } = yield* AWSEnvironment.current;
            const arn = filterArn(region, accountId, detectorId, name);
            const { upsert, removed } = diffTags(
              tagRecord(live.Tags),
              desiredTags,
            );
            if (upsert.length > 0) {
              yield* guardduty.tagResource({
                ResourceArn: arn,
                Tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
              });
            }
            if (removed.length > 0) {
              yield* guardduty.untagResource({
                ResourceArn: arn,
                TagKeys: removed,
              });
            }
          }

          // 4. RETURN fresh attributes.
          const final = yield* guardduty.getFilter({
            DetectorId: detectorId,
            FilterName: name,
          });
          yield* session.note(`${detectorId}/${name}`);
          return yield* buildAttrs(detectorId, name, final);
        }),
        delete: Effect.fn(function* ({ output }) {
          // Idempotent — the filter (or its whole detector) may already be
          // gone; both surface as BadRequestException.
          yield* guardduty
            .deleteFilter({
              DetectorId: output.detectorId,
              FilterName: output.name,
            })
            .pipe(Effect.catchTag("BadRequestException", () => Effect.void));
        }),
      };
    }),
  );
