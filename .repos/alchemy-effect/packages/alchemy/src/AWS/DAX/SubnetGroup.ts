import * as dax from "@distilled.cloud/aws/dax";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { sameStringSet } from "./internal.ts";

export interface SubnetGroupProps {
  /**
   * Name of the subnet group. Must be 1-255 characters. If omitted, a
   * deterministic physical name is generated. Changing the name replaces the
   * subnet group.
   */
  subnetGroupName?: string;
  /**
   * Human-readable description of the subnet group.
   */
  description?: string;
  /**
   * VPC subnet IDs the subnet group spans. DAX places cluster nodes into
   * these subnets; cover at least two Availability Zones for a multi-node
   * cluster.
   */
  subnetIds: string[];
}

export interface SubnetGroup extends Resource<
  "AWS.DAX.SubnetGroup",
  SubnetGroupProps,
  {
    /** Name of the subnet group. */
    subnetGroupName: string;
    /** Description of the subnet group. */
    description: string | undefined;
    /** ID of the VPC the subnets belong to. */
    vpcId: string | undefined;
    /** IDs of the subnets in the group. */
    subnetIds: string[];
  },
  never,
  Providers
> {}

/**
 * A DAX subnet group — the set of VPC subnets a DAX cluster's nodes are
 * placed into.
 *
 * Subnet groups are free and provision instantly. A {@link Cluster}
 * references one by name via `subnetGroupName`. DAX does not support tags on
 * subnet groups.
 * @resource
 * @section Creating a Subnet Group
 * @example Subnet Group Spanning Two Subnets
 * ```typescript
 * const subnetGroup = yield* SubnetGroup("DaxSubnets", {
 *   description: "DAX cluster subnets",
 *   subnetIds: [subnetA.subnetId, subnetB.subnetId],
 * });
 * ```
 *
 * @section Placing a Cluster
 * @example Cluster in the Subnet Group
 * ```typescript
 * const cluster = yield* Cluster("Cache", {
 *   nodeType: "dax.t3.small",
 *   replicationFactor: 1,
 *   iamRoleArn: role.roleArn,
 *   subnetGroupName: subnetGroup.subnetGroupName,
 * });
 * ```
 */
export const SubnetGroup = Resource<SubnetGroup>("AWS.DAX.SubnetGroup");

export const SubnetGroupProvider = () =>
  Provider.effect(
    SubnetGroup,
    Effect.gen(function* () {
      const toName = (id: string, props: SubnetGroupProps) =>
        props.subnetGroupName
          ? Effect.succeed(props.subnetGroupName)
          : createPhysicalName({ id, maxLength: 255, lowercase: true });

      const readGroup = Effect.fn(function* (name: string) {
        const response = yield* dax
          .describeSubnetGroups({ SubnetGroupNames: [name] })
          .pipe(
            Effect.catchTag("SubnetGroupNotFoundFault", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.SubnetGroups?.[0];
      });

      const toAttrs = (group: dax.SubnetGroup) => ({
        subnetGroupName: group.SubnetGroupName ?? "",
        description: group.Description,
        vpcId: group.VpcId,
        subnetIds: (group.Subnets ?? [])
          .map((s) => s.SubnetIdentifier)
          .filter((id): id is string => id !== undefined),
      });

      return {
        stables: ["subnetGroupName"],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            (yield* toName(id, olds ?? { subnetIds: [] })) !==
            (yield* toName(id, news ?? { subnetIds: [] }))
          ) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.subnetGroupName ??
            (yield* toName(id, olds ?? { subnetIds: [] }));
          const group = yield* readGroup(name);
          if (group?.SubnetGroupName === undefined) return undefined;
          // DAX subnet groups do not support tags, so ownership cannot be
          // verified — return the attributes directly.
          return toAttrs(group);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const props = news ?? { subnetIds: [] };
          const name = output?.subnetGroupName ?? (yield* toName(id, props));

          // 1. Observe — cloud state is authoritative.
          let observed = yield* readGroup(name);

          // 2. Ensure — create if missing; tolerate AlreadyExists as a race.
          if (observed === undefined) {
            yield* dax
              .createSubnetGroup({
                SubnetGroupName: name,
                Description: props.description,
                SubnetIds: props.subnetIds,
              })
              .pipe(
                Effect.catchTag(
                  "SubnetGroupAlreadyExistsFault",
                  () => Effect.void,
                ),
              );
            observed = yield* readGroup(name);
          }
          if (observed === undefined) {
            return yield* Effect.fail(
              new Error(`DAX subnet group '${name}' not found after create`),
            );
          }

          // 3. Sync — apply description / subnet delta from OBSERVED state.
          const update: dax.UpdateSubnetGroupRequest = {
            SubnetGroupName: name,
          };
          let mutated = false;
          if (
            props.description !== undefined &&
            props.description !== observed.Description
          ) {
            update.Description = props.description;
            mutated = true;
          }
          const observedSubnets = (observed.Subnets ?? [])
            .map((s) => s.SubnetIdentifier)
            .filter((s): s is string => s !== undefined);
          if (!sameStringSet(props.subnetIds, observedSubnets)) {
            update.SubnetIds = props.subnetIds;
            mutated = true;
          }
          if (mutated) {
            const response = yield* dax.updateSubnetGroup(update);
            observed = response.SubnetGroup ?? observed;
          }

          yield* session.note(name);
          return toAttrs(observed);
        }),

        delete: Effect.fn(function* ({ output }) {
          // A subnet group still attached to a cluster rejects deletion with
          // SubnetGroupInUseFault — retry (bounded) while the cluster
          // releases it. NotFound is success (idempotent delete).
          yield* dax
            .deleteSubnetGroup({ SubnetGroupName: output.subnetGroupName })
            .pipe(
              Effect.catchTag("SubnetGroupNotFoundFault", () => Effect.void),
              Effect.retry({
                while: (e) => e._tag === "SubnetGroupInUseFault",
                schedule: Schedule.max([
                  Schedule.fixed("5 seconds"),
                  Schedule.recurs(10),
                ]),
              }),
            );
        }),

        list: () =>
          Effect.gen(function* () {
            // DAX has no paginated distilled ops — hand-roll a bounded loop
            // and treat an empty/absent NextToken as terminal.
            const groups: dax.SubnetGroup[] = [];
            let nextToken: string | undefined;
            for (let page = 0; page < 20; page++) {
              const response = yield* dax.describeSubnetGroups({
                NextToken: nextToken,
              });
              groups.push(...(response.SubnetGroups ?? []));
              nextToken = response.NextToken;
              if (!nextToken) break;
            }
            return groups
              .filter((group) => group.SubnetGroupName !== undefined)
              .map(toAttrs);
          }),
      };
    }),
  );
