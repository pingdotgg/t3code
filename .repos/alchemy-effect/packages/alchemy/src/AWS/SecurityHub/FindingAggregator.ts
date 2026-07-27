import * as securityhub from "@distilled.cloud/aws/securityhub";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

/**
 * How linked Regions are selected for cross-Region finding aggregation.
 */
export type RegionLinkingMode =
  | "ALL_REGIONS"
  | "ALL_REGIONS_EXCEPT_SPECIFIED"
  | "SPECIFIED_REGIONS"
  | "NO_REGIONS";

export interface FindingAggregatorProps {
  /**
   * How linked Regions are selected: `ALL_REGIONS` aggregates from every
   * Region (including future ones), `ALL_REGIONS_EXCEPT_SPECIFIED` excludes
   * `regions`, `SPECIFIED_REGIONS` includes only `regions`, and `NO_REGIONS`
   * disables aggregation. Updatable in place.
   */
  regionLinkingMode: RegionLinkingMode;

  /**
   * The Regions excluded from (`ALL_REGIONS_EXCEPT_SPECIFIED`) or included
   * in (`SPECIFIED_REGIONS`) aggregation. Updatable in place.
   */
  regions?: string[];
}

/** @resource */
export interface FindingAggregator extends Resource<
  "AWS.SecurityHub.FindingAggregator",
  FindingAggregatorProps,
  {
    /** ARN of the finding aggregator (its identity). */
    findingAggregatorArn: string;
    /** The home Region findings are aggregated into. */
    findingAggregationRegion: string | undefined;
    /** The active Region-linking mode. */
    regionLinkingMode: string | undefined;
    /** The Regions included in or excluded from aggregation. */
    regions: string[] | undefined;
  },
  never,
  Providers
> {}

/**
 * The Security Hub cross-Region finding aggregator — replicates findings
 * from linked Regions into the home Region. Only one aggregator can exist
 * per account, so this is a singleton: adopting a pre-existing aggregator
 * that Alchemy did not create requires `--adopt`.
 *
 * @section Aggregating Findings Across Regions
 * @example Aggregate from All Regions
 * ```typescript
 * const aggregator = yield* AWS.SecurityHub.FindingAggregator("Aggregator", {
 *   regionLinkingMode: "ALL_REGIONS",
 * });
 * ```
 *
 * @example Aggregate from Specific Regions
 * ```typescript
 * const aggregator = yield* AWS.SecurityHub.FindingAggregator("Aggregator", {
 *   regionLinkingMode: "SPECIFIED_REGIONS",
 *   regions: ["us-east-1", "eu-west-1"],
 * });
 * ```
 */
const FindingAggregatorResource = Resource<FindingAggregator>(
  "AWS.SecurityHub.FindingAggregator",
);

export { FindingAggregatorResource as FindingAggregator };

export const FindingAggregatorProvider = () =>
  Provider.effect(
    FindingAggregatorResource,
    Effect.gen(function* () {
      const getAggregator = (arn: string) =>
        securityhub.getFindingAggregator({ FindingAggregatorArn: arn }).pipe(
          Effect.map(
            (r) => r as securityhub.GetFindingAggregatorResponse | undefined,
          ),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
          Effect.catchTag("InvalidAccessException", () =>
            Effect.succeed(undefined),
          ),
        );

      // At most one aggregator exists per account — a single page suffices.
      const findAggregator = securityhub.listFindingAggregators({}).pipe(
        Effect.map((r) => r.FindingAggregators?.[0]?.FindingAggregatorArn),
        Effect.catchTag("InvalidAccessException", () =>
          Effect.succeed(undefined),
        ),
      );

      const buildAttrs = (r: securityhub.GetFindingAggregatorResponse) => ({
        findingAggregatorArn: r.FindingAggregatorArn!,
        findingAggregationRegion: r.FindingAggregationRegion,
        regionLinkingMode: r.RegionLinkingMode,
        regions: r.Regions,
      });

      return {
        stables: ["findingAggregatorArn", "findingAggregationRegion"],
        read: Effect.fn(function* ({ output }) {
          if (output?.findingAggregatorArn) {
            const live = yield* getAggregator(output.findingAggregatorArn);
            return live ? buildAttrs(live) : undefined;
          }
          // Aggregators cannot be tagged; an existing one we have no state
          // for is foreign until adopted.
          const arn = yield* findAggregator;
          if (!arn) return undefined;
          const live = yield* getAggregator(arn);
          return live ? Unowned(buildAttrs(live)) : undefined;
        }),
        list: () =>
          Effect.gen(function* () {
            const arn = yield* findAggregator;
            if (!arn) return [];
            const live = yield* getAggregator(arn);
            return live ? [buildAttrs(live)] : [];
          }),
        reconcile: Effect.fn(function* ({ news, output, session }) {
          // 1. OBSERVE — the account's single aggregator is authoritative.
          const arn = output?.findingAggregatorArn ?? (yield* findAggregator);
          const live = arn ? yield* getAggregator(arn) : undefined;

          let final: securityhub.GetFindingAggregatorResponse;
          if (!live) {
            // 2. ENSURE.
            final = yield* securityhub.createFindingAggregator({
              RegionLinkingMode: news.regionLinkingMode,
              Regions: news.regions,
            });
          } else if (
            live.RegionLinkingMode !== news.regionLinkingMode ||
            // The API returns Regions in normalized order — compare as sets.
            JSON.stringify([...(live.Regions ?? [])].sort()) !==
              JSON.stringify([...(news.regions ?? [])].sort())
          ) {
            // 3. SYNC — observed ↔ desired.
            final = yield* securityhub.updateFindingAggregator({
              FindingAggregatorArn: live.FindingAggregatorArn!,
              RegionLinkingMode: news.regionLinkingMode,
              Regions: news.regions,
            });
          } else {
            final = live;
          }

          // 4. RETURN fresh attributes.
          yield* session.note(final.FindingAggregatorArn!);
          return buildAttrs(final);
        }),
        delete: Effect.fn(function* ({ output }) {
          // Idempotent — the aggregator (or the whole hub) may already be gone.
          yield* securityhub
            .deleteFindingAggregator({
              FindingAggregatorArn: output.findingAggregatorArn,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              Effect.catchTag("InvalidAccessException", () => Effect.void),
            );
        }),
      };
    }),
  );
