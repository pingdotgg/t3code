import * as resourcegroups from "@distilled.cloud/aws/resource-groups";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

/**
 * The query that determines which AWS resources are members of a group.
 */
export interface GroupResourceQuery {
  /**
   * The type of the query.
   *
   * - `TAG_FILTERS_1_0` — a tag-based query; `query` is a JSON string with
   *   `ResourceTypeFilters` and `TagFilters`.
   * - `CLOUDFORMATION_STACK_1_0` — a CloudFormation stack-based query;
   *   `query` is a JSON string with `ResourceTypeFilters` and `StackIdentifier`.
   */
  type: "TAG_FILTERS_1_0" | "CLOUDFORMATION_STACK_1_0";

  /**
   * The query expression as a JSON string. See the *Resource Groups User
   * Guide* for the query syntax of each query type.
   */
  query: string;
}

/**
 * A parameter of a group configuration item.
 */
export interface GroupConfigurationParameter {
  /**
   * The name of the parameter, e.g. `allowed-resource-types`.
   */
  name: string;

  /**
   * The values of the parameter.
   */
  values?: string[];
}

/**
 * An item of an AWS service configuration attached to a resource group.
 */
export interface GroupConfigurationItem {
  /**
   * The configuration type, e.g. `AWS::ResourceGroups::Generic` or
   * `AWS::EC2::CapacityReservationPool`.
   */
  type: string;

  /**
   * Parameters of the configuration item.
   */
  parameters?: GroupConfigurationParameter[];
}

export interface GroupProps {
  /**
   * Name of the resource group. If omitted, a unique name is generated from
   * the app, stage and logical ID. Changing it replaces the group.
   */
  groupName?: string;

  /**
   * A description of the resource group.
   */
  description?: string;

  /**
   * The resource query that determines the group's members. Mutually
   * exclusive with `configuration`.
   */
  resourceQuery?: GroupResourceQuery;

  /**
   * An AWS service configuration attached to the group (a
   * configuration-based group). Mutually exclusive with `resourceQuery`.
   * Adding or removing the configuration entirely replaces the group.
   */
  configuration?: GroupConfigurationItem[];

  /**
   * User tags to attach to the group. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface Group extends Resource<
  "AWS.ResourceGroups.Group",
  GroupProps,
  {
    /** The name of the resource group. */
    groupName: string;
    /** The ARN of the resource group. */
    groupArn: string;
  },
  never,
  Providers
> {}

/**
 * An AWS Resource Groups group — a collection of AWS resources defined by a
 * tag-based query, a CloudFormation stack query, or an attached service
 * configuration.
 *
 * Deleting a group never deletes its member resources; it only deletes the
 * group structure.
 *
 * @resource
 * @section Creating Groups
 * @example Tag-based Group
 * ```typescript
 * import * as ResourceGroups from "alchemy/AWS/ResourceGroups";
 *
 * const group = yield* ResourceGroups.Group("EnvGroup", {
 *   description: "All resources tagged env=prod",
 *   resourceQuery: {
 *     type: "TAG_FILTERS_1_0",
 *     query: JSON.stringify({
 *       ResourceTypeFilters: ["AWS::AllSupported"],
 *       TagFilters: [{ Key: "env", Values: ["prod"] }],
 *     }),
 *   },
 * });
 * ```
 *
 * @example CloudFormation Stack Group
 * ```typescript
 * const group = yield* ResourceGroups.Group("StackGroup", {
 *   resourceQuery: {
 *     type: "CLOUDFORMATION_STACK_1_0",
 *     query: JSON.stringify({
 *       ResourceTypeFilters: ["AWS::AllSupported"],
 *       StackIdentifier: stackArn,
 *     }),
 *   },
 * });
 * ```
 *
 * @section Service Configurations
 * @example Capacity Reservation Pool Group
 * ```typescript
 * const pool = yield* ResourceGroups.Group("ReservationPool", {
 *   configuration: [
 *     {
 *       type: "AWS::ResourceGroups::Generic",
 *       parameters: [
 *         {
 *           name: "allowed-resource-types",
 *           values: ["AWS::EC2::CapacityReservation"],
 *         },
 *       ],
 *     },
 *     { type: "AWS::EC2::CapacityReservationPool" },
 *   ],
 * });
 * ```
 *
 * @section Tagging
 * @example Group with Tags
 * ```typescript
 * const group = yield* ResourceGroups.Group("TaggedGroup", {
 *   resourceQuery: {
 *     type: "TAG_FILTERS_1_0",
 *     query: JSON.stringify({
 *       ResourceTypeFilters: ["AWS::AllSupported"],
 *       TagFilters: [{ Key: "team", Values: ["platform"] }],
 *     }),
 *   },
 *   tags: { team: "platform" },
 * });
 * ```
 */
export const Group = Resource<Group>("AWS.ResourceGroups.Group");

/**
 * Raised when a `Group` is configured with both `resourceQuery` and
 * `configuration`. A resource group is defined by exactly one of the two.
 */
export class ResourceGroupDefinitionConflict extends Data.TaggedError(
  "ResourceGroupDefinitionConflict",
)<{ message: string }> {}

const validateDefinition = (props: GroupProps) =>
  props.resourceQuery !== undefined && props.configuration !== undefined
    ? Effect.fail(
        new ResourceGroupDefinitionConflict({
          message:
            "resourceQuery and configuration are mutually exclusive — a resource group is defined by exactly one of the two.",
        }),
      )
    : Effect.void;

/** Wire shape of the resource query, built from props. */
const toResourceQuery = (query: GroupResourceQuery) => ({
  Type: query.type,
  Query: query.query,
});

/** Wire shape of the service configuration, built from props. */
const toConfiguration = (configuration: GroupConfigurationItem[]) =>
  configuration.map((item) => ({
    Type: item.type,
    Parameters: item.parameters?.map((p) => ({
      Name: p.name,
      Values: p.values,
    })),
  }));

/**
 * Canonical, order-insensitive fingerprint of a service configuration.
 * The API returns configuration items (and their parameters) in arbitrary
 * order, so both sides are sorted before comparison.
 */
const configurationFingerprint = (
  items: readonly {
    Type: string;
    Parameters?: readonly { Name: string; Values?: readonly string[] }[];
  }[],
) =>
  JSON.stringify(
    items
      .map((item) => ({
        Type: item.Type,
        Parameters: (item.Parameters ?? [])
          .map((p) => ({ Name: p.Name, Values: p.Values ?? [] }))
          .sort((a, b) => a.Name.localeCompare(b.Name)),
      }))
      .sort((a, b) => a.Type.localeCompare(b.Type)),
  );

export const GroupProvider = () =>
  Provider.effect(
    Group,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (id: string, props: GroupProps) {
        return props.groupName ?? (yield* createPhysicalName({ id }));
      });

      const readGroupTags = (groupArn: string) =>
        resourcegroups.getTags({ Arn: groupArn }).pipe(
          Effect.map((r) => (r.Tags ?? {}) as Record<string, string>),
          Effect.catch(() => Effect.succeed({} as Record<string, string>)),
        );

      return Group.Provider.of({
        stables: ["groupName", "groupArn"],
        list: () =>
          resourcegroups.listGroups.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.GroupIdentifiers ?? [])
                  .filter((g) => g.GroupName != null && g.GroupArn != null)
                  .map((g) => ({
                    groupName: g.GroupName!,
                    groupArn: g.GroupArn!,
                  })),
              ),
            ),
          ),
        read: Effect.fn(function* ({ id, olds, output }) {
          const groupName =
            output?.groupName ?? (yield* createName(id, olds ?? {}));
          const found = yield* resourcegroups
            .getGroup({ Group: groupName })
            .pipe(
              Effect.map((r) => r.Group),
              Effect.catchTag("NotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          if (!found) return undefined;
          const attrs = {
            groupName,
            groupArn: found.GroupArn,
          };
          const tags = yield* readGroupTags(found.GroupArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),
        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          yield* validateDefinition(news);
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          if (oldName !== newName) return { action: "replace" } as const;
          // A group is either query-based or configuration-based for its
          // whole life — switching between the two requires replacement.
          if (
            (olds.configuration !== undefined) !==
            (news.configuration !== undefined)
          ) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          yield* validateDefinition(news);
          const groupName = output?.groupName ?? (yield* createName(id, news));
          const internalTags = yield* createInternalTags(id);

          // OBSERVE — cloud state is authoritative; output is only a name cache.
          let live = yield* resourcegroups.getGroup({ Group: groupName }).pipe(
            Effect.map((r) => r.Group),
            Effect.catchTag("NotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

          // ENSURE — create if missing; tolerate the already-exists race.
          if (live === undefined) {
            live = yield* resourcegroups
              .createGroup({
                Name: groupName,
                Description: news.description,
                ResourceQuery: news.resourceQuery
                  ? toResourceQuery(news.resourceQuery)
                  : undefined,
                Configuration: news.configuration
                  ? toConfiguration(news.configuration)
                  : undefined,
                Tags: { ...news.tags, ...internalTags },
              })
              .pipe(
                Effect.map((r) => r.Group),
                Effect.catchTag("GroupAlreadyExists", () =>
                  resourcegroups
                    .getGroup({ Group: groupName })
                    .pipe(Effect.map((r) => r.Group)),
                ),
              );
          }
          const groupArn = live.GroupArn;

          // SYNC description — diff observed against desired; empty string
          // clears. Fields omitted from updateGroup are left unchanged.
          const desiredDescription = news.description ?? "";
          if ((live.Description ?? "") !== desiredDescription) {
            yield* resourcegroups.updateGroup({
              Group: groupName,
              Description: desiredDescription,
            });
          }

          // SYNC resource query — only meaningful for query-based groups
          // (getGroupQuery rejects configuration-based groups).
          if (news.resourceQuery !== undefined) {
            const desiredQuery = toResourceQuery(news.resourceQuery);
            const observedQuery = yield* resourcegroups
              .getGroupQuery({ Group: groupName })
              .pipe(
                Effect.map((r) => r.GroupQuery?.ResourceQuery),
                Effect.catchTag("NotFoundException", () =>
                  Effect.succeed(undefined),
                ),
              );
            if (
              observedQuery?.Type !== desiredQuery.Type ||
              observedQuery?.Query !== desiredQuery.Query
            ) {
              yield* resourcegroups.updateGroupQuery({
                Group: groupName,
                ResourceQuery: desiredQuery,
              });
            }
          }

          // SYNC service configuration — order-insensitive comparison, the
          // API returns configuration items in arbitrary order.
          if (news.configuration !== undefined) {
            const desiredConfiguration = toConfiguration(news.configuration);
            const observedConfiguration = yield* resourcegroups
              .getGroupConfiguration({ Group: groupName })
              .pipe(
                Effect.map((r) => r.GroupConfiguration?.Configuration ?? []),
                Effect.catchTag("NotFoundException", () => Effect.succeed([])),
              );
            if (
              configurationFingerprint(observedConfiguration) !==
              configurationFingerprint(desiredConfiguration)
            ) {
              yield* resourcegroups.putGroupConfiguration({
                Group: groupName,
                Configuration: desiredConfiguration,
              });
            }
          }

          // SYNC tags — diff against OBSERVED cloud tags so adoption
          // converges (createGroup tags only apply on first create).
          const observedTags = yield* readGroupTags(groupArn);
          const { upsert, removed } = diffTags(observedTags, {
            ...news.tags,
            ...internalTags,
          });
          if (upsert.length > 0) {
            yield* resourcegroups.tag({
              Arn: groupArn,
              Tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
            });
          }
          if (removed.length > 0) {
            yield* resourcegroups.untag({ Arn: groupArn, Keys: removed });
          }

          yield* session.note(groupName);
          return {
            groupName,
            groupArn,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* resourcegroups
            .deleteGroup({ Group: output.groupName })
            .pipe(Effect.catchTag("NotFoundException", () => Effect.void));
        }),
      });
    }),
  );
