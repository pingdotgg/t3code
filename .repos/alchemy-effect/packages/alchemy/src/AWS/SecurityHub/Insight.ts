import * as securityhub from "@distilled.cloud/aws/securityhub";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export interface InsightProps {
  /**
   * Name of the insight. If omitted, a unique name is generated. Updatable
   * in place.
   */
  name?: string;

  /**
   * The finding filters the insight aggregates over, e.g.
   * `{ SeverityLabel: [{ Value: "CRITICAL", Comparison: "EQUALS" }] }`.
   * Updatable in place.
   */
  filters: securityhub.AwsSecurityFindingFilters;

  /**
   * The finding attribute results are grouped by, e.g. `ResourceId`,
   * `SeverityLabel`, `AwsAccountId`. Updatable in place.
   */
  groupByAttribute: string;
}

/** @resource */
export interface Insight extends Resource<
  "AWS.SecurityHub.Insight",
  InsightProps,
  {
    /** ARN of the insight (its identity). */
    insightArn: string;
    /** Name of the insight. */
    name: string;
    /** The attribute results are grouped by. */
    groupByAttribute: string;
  },
  never,
  Providers
> {}

/**
 * A Security Hub custom insight — a saved finding query grouped by an
 * attribute. Read its aggregated results at runtime with the
 * {@link GetInsightResults} binding.
 *
 * @section Creating an Insight
 * @example Critical Findings by Resource
 * ```typescript
 * const insight = yield* AWS.SecurityHub.Insight("CriticalByResource", {
 *   filters: {
 *     SeverityLabel: [{ Value: "CRITICAL", Comparison: "EQUALS" }],
 *     RecordState: [{ Value: "ACTIVE", Comparison: "EQUALS" }],
 *   },
 *   groupByAttribute: "ResourceId",
 * });
 * ```
 *
 * @example Read Insight Results at Runtime
 * ```typescript
 * const getInsightResults = yield* AWS.SecurityHub.GetInsightResults();
 * const { InsightResults } = yield* getInsightResults({
 *   InsightArn: insight.insightArn,
 * });
 * ```
 */
const InsightResource = Resource<Insight>("AWS.SecurityHub.Insight");

export { InsightResource as Insight };

export const InsightProvider = () =>
  Provider.effect(
    InsightResource,
    Effect.gen(function* () {
      const toName = (id: string, props: { name?: string }) =>
        props.name
          ? Effect.succeed(props.name)
          : createPhysicalName({ id, maxLength: 128 });

      const getInsight = (arn: string) =>
        securityhub.getInsights({ InsightArns: [arn] }).pipe(
          Effect.map((r) => r.Insights?.[0]),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
          // The whole hub may be disabled — the insight is gone too.
          Effect.catchTag("InvalidAccessException", () =>
            Effect.succeed(undefined),
          ),
          // Security Hub reports an unknown insight ARN as invalid input.
          Effect.catchTag("InvalidInputException", () =>
            Effect.succeed(undefined),
          ),
        );

      const listInsights = securityhub.getInsights.pages({}).pipe(
        Stream.runCollect,
        Effect.map((pages) =>
          Array.from(pages).flatMap((page) => page.Insights ?? []),
        ),
        Effect.catchTag("InvalidAccessException", () =>
          Effect.succeed([] as securityhub.Insight[]),
        ),
      );

      const buildAttrs = (i: securityhub.Insight) => ({
        insightArn: i.InsightArn!,
        name: i.Name ?? "",
        groupByAttribute: i.GroupByAttribute ?? "",
      });

      return {
        stables: ["insightArn"],
        read: Effect.fn(function* ({ id, olds, output }) {
          if (output?.insightArn) {
            const live = yield* getInsight(output.insightArn);
            return live ? buildAttrs(live) : undefined;
          }
          // No prior state — find by (deterministic) name. Insights cannot be
          // tagged; the generated name embeds the app/stage physical-name
          // hash, so a match is ours.
          const name = yield* toName(id, olds ?? {});
          const all = yield* listInsights;
          const match = all.find((i) => i.Name === name);
          return match ? buildAttrs(match) : undefined;
        }),
        list: () => listInsights.pipe(Effect.map((all) => all.map(buildAttrs))),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* toName(id, news);

          // 1. OBSERVE — by cached ARN first, then by name.
          let live: securityhub.Insight | undefined = output?.insightArn
            ? yield* getInsight(output.insightArn)
            : undefined;
          if (!live) {
            const all = yield* listInsights;
            live = all.find((i) => i.Name === name);
          }

          let final: securityhub.Insight;
          if (!live) {
            // 2. ENSURE.
            const { InsightArn } = yield* securityhub.createInsight({
              Name: name,
              Filters: news.filters,
              GroupByAttribute: news.groupByAttribute,
            });
            // The read-after-create may lag — fall back to the desired state.
            final = (yield* getInsight(InsightArn)) ?? {
              InsightArn,
              Name: name,
              Filters: news.filters,
              GroupByAttribute: news.groupByAttribute,
            };
          } else if (
            live.Name !== name ||
            live.GroupByAttribute !== news.groupByAttribute ||
            JSON.stringify(live.Filters) !== JSON.stringify(news.filters)
          ) {
            // 3. SYNC — observed ↔ desired.
            const arn = live.InsightArn!;
            yield* securityhub.updateInsight({
              InsightArn: arn,
              Name: name,
              Filters: news.filters,
              GroupByAttribute: news.groupByAttribute,
            });
            final = (yield* getInsight(arn)) ?? {
              InsightArn: arn,
              Name: name,
              Filters: news.filters,
              GroupByAttribute: news.groupByAttribute,
            };
          } else {
            final = live;
          }

          // 4. RETURN fresh attributes.
          yield* session.note(final.InsightArn!);
          return buildAttrs(final);
        }),
        delete: Effect.fn(function* ({ output }) {
          // Idempotent — the insight (or the whole hub) may already be gone.
          yield* securityhub
            .deleteInsight({ InsightArn: output.insightArn })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              Effect.catchTag("InvalidAccessException", () => Effect.void),
              Effect.catchTag("InvalidInputException", () => Effect.void),
            );
        }),
      };
    }),
  );
