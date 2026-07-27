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
 * Properties for an Amazon QuickSight dashboard — a published, read-only view
 * built from a template, an analysis, or an inline definition.
 */
export interface DashboardProps {
  /**
   * Unique id of the dashboard within the account. Stable — changing it
   * replaces the dashboard. If omitted, a unique id is generated.
   */
  dashboardId?: string;

  /**
   * Display name of the dashboard.
   */
  name: string;

  /**
   * Source of the dashboard content — a template or an existing analysis to
   * clone. Provide either `sourceEntity` or `definition`.
   */
  sourceEntity?: quicksight.DashboardSourceEntity;

  /**
   * Inline definition of the dashboard content. Provide either `definition`
   * or `sourceEntity`.
   */
  definition?: quicksight.DashboardVersionDefinition;

  /**
   * Parameters passed to the dashboard's datasets.
   */
  parameters?: quicksight.Parameters;

  /**
   * Resource-level permissions on the dashboard.
   */
  permissions?: quicksight.ResourcePermission[];

  /**
   * Publish options (e.g. ad-hoc filtering, export to CSV).
   */
  dashboardPublishOptions?: quicksight.DashboardPublishOptions;

  /**
   * ARN of the theme applied to the dashboard.
   */
  themeArn?: string;

  /**
   * Description of the created/updated version.
   */
  versionDescription?: string;

  /**
   * Tags to apply to the dashboard.
   */
  tags?: Record<string, string>;
}

export interface Dashboard extends Resource<
  "AWS.QuickSight.Dashboard",
  DashboardProps,
  {
    /** Unique id of the dashboard within the account. */
    dashboardId: string;
    /** ARN of the dashboard. */
    arn: string;
    /** Display name of the dashboard. */
    name: string;
    /** Current version status (e.g. `CREATION_SUCCESSFUL`). */
    status: string;
  },
  never,
  Providers
> {}

/**
 * An Amazon QuickSight dashboard — a published, read-only view built from a
 * template, an analysis, or an inline definition.
 *
 * QuickSight requires an active account subscription in the region. Without
 * one, create operations fail with the typed `QuickSightSubscriptionRequired`
 * error.
 *
 * @section Creating a Dashboard
 * @example Dashboard from a Template
 * ```typescript
 * const dashboard = yield* Dashboard("sales-overview", {
 *   name: "Sales Overview",
 *   sourceEntity: {
 *     SourceTemplate: {
 *       Arn: templateArn,
 *       DataSetReferences: [
 *         {
 *           DataSetPlaceholder: "sales",
 *           DataSetArn: dataset.arn,
 *         },
 *       ],
 *     },
 *   },
 * });
 * ```
 *
 * @resource
 */
export const Dashboard = Resource<Dashboard>("AWS.QuickSight.Dashboard");

export const DashboardProvider = () =>
  Provider.effect(
    Dashboard,
    Effect.gen(function* () {
      const toId = (id: string, props: Partial<DashboardProps>) =>
        props.dashboardId
          ? Effect.succeed(props.dashboardId)
          : createPhysicalName({ id, maxLength: 64 });

      const readDashboard = Effect.fn(function* (
        accountId: string,
        dashboardId: string,
      ) {
        const response = yield* quicksight
          .describeDashboard({
            AwsAccountId: accountId,
            DashboardId: dashboardId,
          })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.Dashboard;
      });

      const settle = (accountId: string, dashboardId: string) =>
        waitForSettled(
          dashboardId,
          readDashboard(accountId, dashboardId).pipe(
            Effect.map((d) =>
              d === undefined ? undefined : { ...d, status: d.Version?.Status },
            ),
          ),
        );

      const toAttrs = (dashboard: quicksight.Dashboard) => ({
        dashboardId: dashboard.DashboardId!,
        arn: dashboard.Arn!,
        name: dashboard.Name ?? "",
        status: dashboard.Version?.Status ?? "",
      });

      return Dashboard.Provider.of({
        stables: ["dashboardId", "arn"],

        diff: Effect.fn(function* ({ id, olds = {}, news }) {
          if (!isResolved(news)) return undefined;
          if ((yield* toId(id, olds)) !== (yield* toId(id, news))) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds = {}, output }) {
          const { accountId } = yield* AWSEnvironment.current;
          const dashboardId = output?.dashboardId ?? (yield* toId(id, olds));
          const dashboard = yield* readDashboard(accountId, dashboardId);
          if (dashboard === undefined) return undefined;
          const attrs = toAttrs(dashboard);
          const tags = yield* readQuickSightTags(attrs.arn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const { accountId } = yield* AWSEnvironment.current;
          const dashboardId = output?.dashboardId ?? (yield* toId(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // 1. Observe.
          let observed = yield* readDashboard(accountId, dashboardId);

          // 2. Ensure — create if missing.
          if (observed === undefined) {
            yield* quicksight
              .createDashboard({
                AwsAccountId: accountId,
                DashboardId: dashboardId,
                Name: news.name,
                SourceEntity: news.sourceEntity,
                Definition: news.definition,
                Parameters: news.parameters,
                Permissions: news.permissions,
                DashboardPublishOptions: news.dashboardPublishOptions,
                ThemeArn: news.themeArn,
                VersionDescription: news.versionDescription,
                Tags: toWireTags(desiredTags),
              })
              .pipe(
                Effect.catchTag("ResourceExistsException", () => Effect.void),
              );
          } else {
            // 3. Sync — publish a new version.
            yield* quicksight.updateDashboard({
              AwsAccountId: accountId,
              DashboardId: dashboardId,
              Name: news.name,
              SourceEntity: news.sourceEntity,
              Definition: news.definition,
              Parameters: news.parameters,
              DashboardPublishOptions: news.dashboardPublishOptions,
              ThemeArn: news.themeArn,
              VersionDescription: news.versionDescription,
            });
          }

          observed = yield* settle(accountId, dashboardId);
          if (observed === undefined) {
            return yield* Effect.fail(
              new Error(
                `QuickSight dashboard '${dashboardId}' not found after reconcile`,
              ),
            );
          }

          // 3b. Sync tags.
          yield* syncQuickSightTags(observed.Arn!, desiredTags);

          yield* session.note(dashboardId);
          return toAttrs(observed);
        }),

        delete: Effect.fn(function* ({ output }) {
          const { accountId } = yield* AWSEnvironment.current;
          yield* quicksight
            .deleteDashboard({
              AwsAccountId: accountId,
              DashboardId: output.dashboardId,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),

        list: () =>
          Effect.gen(function* () {
            const { accountId } = yield* AWSEnvironment.current;
            return yield* quicksight.listDashboards
              .pages({ AwsAccountId: accountId })
              .pipe(
                Stream.runCollect,
                Effect.map((chunk) =>
                  Array.from(chunk)
                    .flatMap((page) => page.DashboardSummaryList ?? [])
                    .flatMap((s) =>
                      s.DashboardId !== undefined && s.Arn !== undefined
                        ? [
                            {
                              dashboardId: s.DashboardId,
                              arn: s.Arn,
                              name: s.Name ?? "",
                              status: "",
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
