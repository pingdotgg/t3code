import * as quicksight from "@distilled.cloud/aws/quicksight";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  readQuickSightTags,
  syncQuickSightTags,
  toWireTags,
  waitForSettled,
} from "./internal.ts";

/**
 * Properties for an Amazon QuickSight analysis — an editable workspace built
 * from a template or an inline definition, which can be published as a
 * dashboard.
 */
export interface AnalysisProps {
  /**
   * Unique id of the analysis within the account. Stable — changing it
   * replaces the analysis. If omitted, a unique id is generated.
   */
  analysisId?: string;

  /**
   * Display name of the analysis.
   */
  name: string;

  /**
   * Source of the analysis content — a template to clone. Provide either
   * `sourceEntity` or `definition`.
   */
  sourceEntity?: quicksight.AnalysisSourceEntity;

  /**
   * Inline definition of the analysis content. Provide either `definition`
   * or `sourceEntity`.
   */
  definition?: quicksight.AnalysisDefinition;

  /**
   * Parameters passed to the analysis's datasets.
   */
  parameters?: quicksight.Parameters;

  /**
   * Resource-level permissions on the analysis.
   */
  permissions?: quicksight.ResourcePermission[];

  /**
   * ARN of the theme applied to the analysis.
   */
  themeArn?: string;

  /**
   * When deleting, whether to skip the recovery window and delete
   * immediately. Recommended for ephemeral/test analyses so they don't
   * linger in a recoverable state.
   * @default true
   */
  forceDeleteWithoutRecovery?: boolean;

  /**
   * Tags to apply to the analysis.
   */
  tags?: Record<string, string>;
}

export interface Analysis extends Resource<
  "AWS.QuickSight.Analysis",
  AnalysisProps,
  {
    /** Unique id of the analysis within the account. */
    analysisId: string;
    /** ARN of the analysis. */
    arn: string;
    /** Display name of the analysis. */
    name: string;
    /** Current lifecycle status (e.g. `CREATION_SUCCESSFUL`). */
    status: string;
  },
  never,
  Providers
> {}

/**
 * An Amazon QuickSight analysis — an editable workspace built from a template
 * or an inline definition, which can be published as a dashboard.
 *
 * QuickSight requires an active account subscription in the region. Without
 * one, create operations fail with the typed `QuickSightSubscriptionRequired`
 * error.
 *
 * @section Creating an Analysis
 * @example Analysis from a Template
 * ```typescript
 * const analysis = yield* Analysis("explore-sales", {
 *   name: "Explore Sales",
 *   sourceEntity: {
 *     SourceTemplate: {
 *       Arn: templateArn,
 *       DataSetReferences: [
 *         { DataSetPlaceholder: "sales", DataSetArn: dataset.arn },
 *       ],
 *     },
 *   },
 * });
 * ```
 *
 * @resource
 */
export const Analysis = Resource<Analysis>("AWS.QuickSight.Analysis");

export const AnalysisProvider = () =>
  Provider.effect(
    Analysis,
    Effect.gen(function* () {
      const toId = (id: string, props: Partial<AnalysisProps>) =>
        props.analysisId
          ? Effect.succeed(props.analysisId)
          : createPhysicalName({ id, maxLength: 64 });

      const readAnalysis = Effect.fn(function* (
        accountId: string,
        analysisId: string,
      ) {
        const response = yield* quicksight
          .describeAnalysis({ AwsAccountId: accountId, AnalysisId: analysisId })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        const analysis = response?.Analysis;
        if (analysis === undefined || analysis.Status === "DELETED") {
          return undefined;
        }
        return analysis;
      });

      const settle = (accountId: string, analysisId: string) =>
        waitForSettled(
          analysisId,
          readAnalysis(accountId, analysisId).pipe(
            Effect.map((a) =>
              a === undefined ? undefined : { ...a, status: a.Status },
            ),
          ),
        );

      const toAttrs = (analysis: quicksight.Analysis) => ({
        analysisId: analysis.AnalysisId!,
        arn: analysis.Arn!,
        name: analysis.Name ?? "",
        status: analysis.Status ?? "",
      });

      return Analysis.Provider.of({
        stables: ["analysisId", "arn"],

        diff: Effect.fn(function* ({ id, olds = {}, news }) {
          if (!isResolved(news)) return undefined;
          if ((yield* toId(id, olds)) !== (yield* toId(id, news))) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds = {}, output }) {
          const { accountId } = yield* AWSEnvironment.current;
          const analysisId = output?.analysisId ?? (yield* toId(id, olds));
          const analysis = yield* readAnalysis(accountId, analysisId);
          if (analysis === undefined) return undefined;
          const attrs = toAttrs(analysis);
          const tags = yield* readQuickSightTags(attrs.arn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const { accountId } = yield* AWSEnvironment.current;
          const analysisId = output?.analysisId ?? (yield* toId(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // 1. Observe.
          let observed = yield* readAnalysis(accountId, analysisId);

          // 2. Ensure — create if missing.
          if (observed === undefined) {
            yield* quicksight
              .createAnalysis({
                AwsAccountId: accountId,
                AnalysisId: analysisId,
                Name: news.name,
                SourceEntity: news.sourceEntity,
                Definition: news.definition,
                Parameters: news.parameters,
                Permissions: news.permissions,
                ThemeArn: news.themeArn,
                Tags: toWireTags(desiredTags),
              })
              .pipe(
                Effect.catchTag("ResourceExistsException", () => Effect.void),
              );
          } else {
            // 3. Sync.
            yield* quicksight.updateAnalysis({
              AwsAccountId: accountId,
              AnalysisId: analysisId,
              Name: news.name,
              SourceEntity: news.sourceEntity,
              Definition: news.definition,
              Parameters: news.parameters,
              ThemeArn: news.themeArn,
            });
          }

          observed = yield* settle(accountId, analysisId);
          if (observed === undefined) {
            return yield* Effect.fail(
              new Error(
                `QuickSight analysis '${analysisId}' not found after reconcile`,
              ),
            );
          }

          // 3b. Sync tags.
          yield* syncQuickSightTags(observed.Arn!, desiredTags);

          yield* session.note(analysisId);
          return toAttrs(observed);
        }),

        delete: Effect.fn(function* ({ olds, output }) {
          const { accountId } = yield* AWSEnvironment.current;
          yield* quicksight
            .deleteAnalysis({
              AwsAccountId: accountId,
              AnalysisId: output.analysisId,
              ForceDeleteWithoutRecovery:
                olds?.forceDeleteWithoutRecovery ?? true,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),

        list: () =>
          Effect.gen(function* () {
            const { accountId } = yield* AWSEnvironment.current;
            return yield* quicksight.listAnalyses
              .pages({ AwsAccountId: accountId })
              .pipe(
                Stream.runCollect,
                Effect.map((chunk) =>
                  Array.from(chunk)
                    .flatMap((page) => page.AnalysisSummaryList ?? [])
                    .flatMap((s) =>
                      s.AnalysisId !== undefined &&
                      s.Arn !== undefined &&
                      s.Status !== "DELETED"
                        ? [
                            {
                              analysisId: s.AnalysisId,
                              arn: s.Arn,
                              name: s.Name ?? "",
                              status: s.Status ?? "",
                            },
                          ]
                        : [],
                    ),
                ),
              );
          }),
      });
    }),
  );
