import * as appsignals from "@distilled.cloud/aws/application-signals";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export interface GroupingConfigurationProps {
  /**
   * The custom grouping attribute definitions for this account. Each
   * definition names a grouping dimension (`GroupingName`), the telemetry
   * attribute or AWS tag keys it is sourced from (`GroupingSourceKeys`,
   * e.g. `"Tag.team"` or an OTel resource attribute key), and an optional
   * `DefaultGroupingValue` used when none of the source keys are present.
   */
  groupingAttributeDefinitions: appsignals.GroupingAttributeDefinition[];
}

export interface GroupingConfiguration extends Resource<
  "AWS.ApplicationSignals.GroupingConfiguration",
  GroupingConfigurationProps,
  {
    /**
     * The grouping attribute definitions as returned by the service.
     */
    groupingAttributeDefinitions: appsignals.GroupingAttributeDefinition[];
    /**
     * When the grouping configuration was last updated (ISO timestamp).
     */
    updatedAt: string | undefined;
  },
  never,
  Providers
> {}

/**
 * The CloudWatch Application Signals grouping configuration for this
 * account — an account-level singleton that defines custom grouping
 * attributes (sourced from telemetry attributes or AWS tags) used to
 * organize and filter discovered services in the Application Signals
 * console and APIs.
 *
 * There is at most ONE grouping configuration per account/region;
 * `PutGroupingConfiguration` replaces the whole definition list.
 *
 * @resource
 * @section Creating a Grouping Configuration
 * @example Group Services by Team Tag
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const grouping = yield* AWS.ApplicationSignals.GroupingConfiguration(
 *   "Grouping",
 *   {
 *     groupingAttributeDefinitions: [
 *       {
 *         GroupingName: "Team",
 *         GroupingSourceKeys: ["Tag.team"],
 *         DefaultGroupingValue: "unassigned",
 *       },
 *     ],
 *   },
 * );
 * ```
 *
 * @example Multiple Grouping Dimensions
 * ```typescript
 * const grouping = yield* AWS.ApplicationSignals.GroupingConfiguration(
 *   "Grouping",
 *   {
 *     groupingAttributeDefinitions: [
 *       { GroupingName: "Team", GroupingSourceKeys: ["Tag.team"] },
 *       {
 *         GroupingName: "CostCenter",
 *         GroupingSourceKeys: ["Tag.cost-center", "business_unit"],
 *         DefaultGroupingValue: "shared",
 *       },
 *     ],
 *   },
 * );
 * ```
 */
export const GroupingConfiguration = Resource<GroupingConfiguration>(
  "AWS.ApplicationSignals.GroupingConfiguration",
);

/** Normalize a definition for comparison (drop undefined members). */
const normalizeDefinition = (
  definition: appsignals.GroupingAttributeDefinition,
) => ({
  GroupingName: definition.GroupingName,
  GroupingSourceKeys: definition.GroupingSourceKeys ?? [],
  DefaultGroupingValue: definition.DefaultGroupingValue,
});

const sameDefinitions = (
  desired: appsignals.GroupingAttributeDefinition[],
  observed: appsignals.GroupingAttributeDefinition[],
): boolean =>
  desired.length === observed.length &&
  desired.every(
    (d, i) =>
      JSON.stringify(normalizeDefinition(d)) ===
      JSON.stringify(normalizeDefinition(observed[i])),
  );

export const GroupingConfigurationProvider = () =>
  Provider.effect(
    GroupingConfiguration,
    Effect.gen(function* () {
      /**
       * Observe the account's grouping configuration. The API has no
       * dedicated "get" — an account without a configuration returns an
       * empty definition list and no `UpdatedAt`.
       */
      const observe = appsignals.listGroupingAttributeDefinitions({}).pipe(
        Effect.map((response) =>
          response.UpdatedAt === undefined &&
          response.GroupingAttributeDefinitions.length === 0
            ? undefined
            : {
                groupingAttributeDefinitions: [
                  ...response.GroupingAttributeDefinitions,
                ],
                updatedAt: response.UpdatedAt?.toISOString(),
              },
        ),
      );

      return {
        stables: [],

        read: Effect.fn(function* ({ olds, output }) {
          const observed = yield* observe;
          if (observed === undefined) return undefined;
          // The grouping configuration is not taggable, so ownership cannot
          // be branded. If we have no record of creating it, surface it as
          // an existing-but-foreign singleton so takeover requires --adopt.
          return output !== undefined || olds !== undefined
            ? observed
            : Unowned(observed);
        }),

        reconcile: Effect.fn(function* ({ id, news, session }) {
          const desired = news.groupingAttributeDefinitions;

          // 1. Observe — the live configuration is authoritative.
          const observed = yield* observe;

          // 2/3. Ensure + sync — PutGroupingConfiguration is a full-replace
          // upsert; skip the call when the observed definitions already
          // match the desired ones.
          const fresh =
            observed !== undefined &&
            sameDefinitions(desired, observed.groupingAttributeDefinitions)
              ? observed
              : yield* appsignals
                  .putGroupingConfiguration({
                    GroupingAttributeDefinitions: desired,
                  })
                  .pipe(
                    Effect.map((response) => ({
                      groupingAttributeDefinitions: [
                        ...response.GroupingConfiguration
                          .GroupingAttributeDefinitions,
                      ],
                      updatedAt:
                        response.GroupingConfiguration.UpdatedAt?.toISOString(),
                    })),
                  );

          yield* session.note(id);
          return fresh;
        }),

        delete: Effect.fn(function* () {
          // DeleteGroupingConfiguration is idempotent — deleting an absent
          // configuration succeeds.
          yield* appsignals.deleteGroupingConfiguration({});
        }),

        // Account-level singleton; enumeration happens through read.
        list: () => Effect.succeed([]),
      };
    }),
  );
