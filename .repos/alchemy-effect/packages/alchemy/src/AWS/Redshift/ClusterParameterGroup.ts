import * as redshift from "@distilled.cloud/aws/redshift";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { applyRedshiftTagDelta, redshiftArn, toTagRecord } from "./internal.ts";

export interface ClusterParameterGroupProps {
  /**
   * Name of the cluster parameter group. Must be 1-255 lowercase
   * alphanumeric characters or hyphens, starting with a letter, and must
   * not be prefixed `default`. If omitted, a deterministic physical name is
   * generated. Changing the name replaces the parameter group.
   */
  clusterParameterGroupName?: string;
  /**
   * Parameter group family the group applies to, e.g. `redshift-2.0` (or `redshift-1.0`).
   * Changing the family replaces the parameter group.
   */
  family: string;
  /**
   * Human-readable description. Changing the description replaces the
   * parameter group (Redshift descriptions are create-only).
   * @default "Managed by Alchemy"
   */
  description?: string;
  /**
   * Cluster database parameters to override from the family defaults, e.g.
   * `{ enable_user_activity_logging: "true" }`. Parameters removed from
   * this map are reset to their engine defaults.
   */
  parameters?: Record<string, string>;
  /**
   * User-defined tags for the parameter group.
   */
  tags?: Record<string, string>;
}

export interface ClusterParameterGroup extends Resource<
  "AWS.Redshift.ClusterParameterGroup",
  ClusterParameterGroupProps,
  {
    /**
     * Name of the parameter group.
     */
    clusterParameterGroupName: string;
    /**
     * ARN of the parameter group.
     */
    clusterParameterGroupArn: string;
    /**
     * Parameter group family (e.g. `"redshift-2.0"`).
     */
    family: string;
    /**
     * Description of the parameter group.
     */
    description: string | undefined;
    /**
     * Non-default parameter values applied to the group.
     */
    parameters: Record<string, string>;
    /**
     * Tags on the parameter group (including internal Alchemy tags).
     */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Amazon Redshift cluster parameter group — a named set of database
 * parameters applied to provisioned Redshift clusters.
 *
 * Parameter groups are free and provision instantly. A {@link Cluster}
 * references one by name via `clusterParameterGroupName`; parameter changes
 * take effect after the cluster reboots.
 * @resource
 * @section Creating a Parameter Group
 * @example Default Parameter Group
 * ```typescript
 * const params = yield* Redshift.ClusterParameterGroup("WarehouseParams", {
 *   family: "redshift-2.0",
 * });
 * ```
 * @example Overriding Parameters
 * ```typescript
 * const params = yield* Redshift.ClusterParameterGroup("WarehouseParams", {
 *   family: "redshift-2.0",
 *   parameters: {
 *     enable_user_activity_logging: "true",
 *     statement_timeout: "60000",
 *   },
 * });
 * ```
 */
export const ClusterParameterGroup = Resource<ClusterParameterGroup>(
  "AWS.Redshift.ClusterParameterGroup",
);

export const ClusterParameterGroupProvider = () =>
  Provider.effect(
    ClusterParameterGroup,
    Effect.gen(function* () {
      const toName = (
        id: string,
        props: Partial<ClusterParameterGroupProps>,
      ) =>
        props.clusterParameterGroupName
          ? Effect.succeed(props.clusterParameterGroupName)
          : createPhysicalName({ id, maxLength: 255, lowercase: true });

      const readGroup = Effect.fn(function* (name: string) {
        const response = yield* redshift
          .describeClusterParameterGroups({ ParameterGroupName: name })
          .pipe(
            Effect.catchTag("ClusterParameterGroupNotFoundFault", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.ParameterGroups?.[0];
      });

      // User-sourced parameter overrides currently applied to the group.
      const readUserParameters = Effect.fn(function* (name: string) {
        const parameters = yield* redshift.describeClusterParameters
          .items({ ParameterGroupName: name, Source: "user" })
          .pipe(Stream.runCollect, Effect.map(Array.from<redshift.Parameter>));
        return Object.fromEntries(
          parameters.flatMap((parameter) =>
            parameter.ParameterName !== undefined &&
            parameter.ParameterValue !== undefined
              ? [[parameter.ParameterName, parameter.ParameterValue]]
              : [],
          ),
        );
      });

      const toAttrs = Effect.fn(function* (
        group: redshift.ClusterParameterGroup,
      ) {
        const { accountId, region } = yield* AWSEnvironment.current;
        if (!group.ParameterGroupName) {
          return yield* Effect.fail(
            new Error("Cluster parameter group is missing its name"),
          );
        }
        return {
          clusterParameterGroupName: group.ParameterGroupName,
          clusterParameterGroupArn: redshiftArn(
            region,
            accountId,
            "parametergroup",
            group.ParameterGroupName,
          ),
          family: group.ParameterGroupFamily ?? "",
          description: group.Description,
          parameters: yield* readUserParameters(group.ParameterGroupName),
          tags: toTagRecord(group.Tags),
        };
      });

      return {
        stables: ["clusterParameterGroupName", "clusterParameterGroupArn"],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            (yield* toName(id, olds ?? {})) !== (yield* toName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
          // Family and description are create-only.
          if (
            olds?.family !== news.family ||
            olds?.description !== news.description
          ) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.clusterParameterGroupName ??
            (yield* toName(id, olds ?? {}));
          const group = yield* readGroup(name);
          if (!group?.ParameterGroupName) return undefined;
          const attrs = yield* toAttrs(group);
          return (yield* hasAlchemyTags(id, attrs.tags))
            ? attrs
            : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name =
            output?.clusterParameterGroupName ?? (yield* toName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // 1. Observe — cloud state is authoritative.
          let observed = yield* readGroup(name);

          // 2. Ensure — create if missing; tolerate AlreadyExists as a race
          //    with a peer reconciler by re-reading.
          if (!observed?.ParameterGroupName) {
            yield* redshift
              .createClusterParameterGroup({
                ParameterGroupName: name,
                ParameterGroupFamily: news.family,
                Description: news.description ?? "Managed by Alchemy",
                Tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                  Key,
                  Value,
                })),
              })
              .pipe(
                Effect.catchTag(
                  "ClusterParameterGroupAlreadyExistsFault",
                  () => Effect.void,
                ),
              );
            observed = yield* readGroup(name);
            if (!observed?.ParameterGroupName) {
              return yield* Effect.fail(
                new Error(`Failed to create cluster parameter group '${name}'`),
              );
            }
          }

          // 3. Sync parameters — diff OBSERVED user-sourced overrides
          //    against desired; changed/added values are applied, removed
          //    ones are reset to the engine defaults.
          const observedParameters = yield* readUserParameters(name);
          const desiredParameters = news.parameters ?? {};
          const upsertParameters = Object.entries(desiredParameters)
            .filter(([key, value]) => observedParameters[key] !== value)
            .map(([ParameterName, ParameterValue]) => ({
              ParameterName,
              ParameterValue,
            }));
          const resetParameters = Object.keys(observedParameters)
            .filter((key) => !(key in desiredParameters))
            .map((ParameterName) => ({ ParameterName }));
          if (upsertParameters.length > 0) {
            yield* redshift.modifyClusterParameterGroup({
              ParameterGroupName: name,
              Parameters: upsertParameters,
            });
          }
          if (resetParameters.length > 0) {
            yield* redshift.resetClusterParameterGroup({
              ParameterGroupName: name,
              ResetAllParameters: false,
              Parameters: resetParameters,
            });
          }

          // 3b. Sync tags — diff against OBSERVED cloud tags (describe
          //     surfaces them inline).
          const { accountId, region } = yield* AWSEnvironment.current;
          const arn = redshiftArn(region, accountId, "parametergroup", name);
          const { removed, upsert } = diffTags(
            toTagRecord(observed.Tags),
            desiredTags,
          );
          yield* applyRedshiftTagDelta({ arn, upsert, removed });

          yield* session.note(arn);
          return {
            clusterParameterGroupName: name,
            clusterParameterGroupArn: arn,
            family: observed.ParameterGroupFamily ?? news.family,
            description: observed.Description,
            parameters: desiredParameters,
            tags: desiredTags,
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* redshift
            .deleteClusterParameterGroup({
              ParameterGroupName: output.clusterParameterGroupName,
            })
            .pipe(
              Effect.catchTag(
                "ClusterParameterGroupNotFoundFault",
                () => Effect.void,
              ),
            );
        }),

        list: () =>
          // Top-level account/region collection: exhaustively paginate
          // describeClusterParameterGroups. AWS-managed `default.*` groups
          // cannot be deleted — don't enumerate them.
          redshift.describeClusterParameterGroups.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.ParameterGroups ?? []).filter(
                  (group) =>
                    group.ParameterGroupName !== undefined &&
                    !group.ParameterGroupName.startsWith("default."),
                ),
              ),
            ),
            Effect.flatMap(
              Effect.forEach((group) => toAttrs(group), { concurrency: 4 }),
            ),
          ),
      };
    }),
  );
