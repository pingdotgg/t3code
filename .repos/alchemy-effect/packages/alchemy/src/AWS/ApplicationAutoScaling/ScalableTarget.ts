import * as aas from "@distilled.cloud/aws/application-auto-scaling";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { diffTags, hasAlchemyTags, createInternalTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import { SERVICE_NAMESPACES } from "./internal.ts";

export interface ScalableTargetProps {
  /**
   * The namespace of the AWS service that provides the resource,
   * e.g. `ecs`, `dynamodb`, `lambda`.
   *
   * Changing this triggers a replacement.
   */
  serviceNamespace: aas.ServiceNamespace;
  /**
   * The identifier of the resource to scale, in the format the service
   * expects — e.g. `service/{clusterName}/{serviceName}` for an ECS service
   * or `table/{tableName}` for a DynamoDB table.
   *
   * Changing this triggers a replacement.
   */
  resourceId: string;
  /**
   * The scalable dimension of the resource,
   * e.g. `ecs:service:DesiredCount` or `dynamodb:table:ReadCapacityUnits`.
   *
   * Changing this triggers a replacement.
   */
  scalableDimension: aas.ScalableDimension;
  /**
   * The minimum capacity that Application Auto Scaling may scale in to.
   */
  minCapacity: number;
  /**
   * The maximum capacity that Application Auto Scaling may scale out to.
   */
  maxCapacity: number;
  /**
   * IAM role that allows Application Auto Scaling to modify the scalable
   * target on your behalf. For services that support service-linked roles
   * (ECS, DynamoDB, Lambda, ...) omit this — AWS creates and uses the
   * service-linked role automatically.
   */
  roleArn?: string;
  /**
   * Suspend/resume the target's dynamic and scheduled scaling activities.
   */
  suspendedState?: aas.SuspendedState;
  /**
   * User-defined tags to apply to the scalable target.
   */
  tags?: Record<string, string>;
}

export interface ScalableTarget extends Resource<
  "AWS.ApplicationAutoScaling.ScalableTarget",
  ScalableTargetProps,
  {
    /**
     * Namespace of the AWS service that provides the resource.
     */
    serviceNamespace: aas.ServiceNamespace;
    /**
     * Identifier of the scaled resource.
     */
    resourceId: string;
    /**
     * Scalable dimension being managed.
     */
    scalableDimension: aas.ScalableDimension;
    /**
     * ARN of the scalable target.
     */
    scalableTargetArn: string;
    /**
     * Minimum capacity Application Auto Scaling may scale in to.
     */
    minCapacity: number;
    /**
     * Maximum capacity Application Auto Scaling may scale out to.
     */
    maxCapacity: number;
    /**
     * IAM role Application Auto Scaling uses to modify the target
     * (service-linked role when none was supplied).
     */
    roleArn: string;
    /**
     * Suspension state of dynamic and scheduled scaling activities.
     */
    suspendedState: aas.SuspendedState | undefined;
  },
  never,
  Providers
> {}

/**
 * An Application Auto Scaling scalable target — registers a resource's
 * capacity dimension (an ECS service's desired count, a DynamoDB table's
 * read capacity, Lambda provisioned concurrency, ...) so that scaling
 * policies and scheduled actions can act on it.
 *
 * A scalable target is uniquely identified by the
 * (`serviceNamespace`, `resourceId`, `scalableDimension`) triple; changing
 * any part of the triple replaces the target. Deregistering a scalable
 * target deletes the scaling policies and scheduled actions associated
 * with it.
 * @resource
 * @section Creating Scalable Targets
 * @example Scale an ECS Service
 * ```typescript
 * const target = yield* ScalableTarget("ApiScaling", {
 *   serviceNamespace: "ecs",
 *   resourceId: Output.interpolate`service/${cluster.clusterName}/${service.serviceName}`,
 *   scalableDimension: "ecs:service:DesiredCount",
 *   minCapacity: 1,
 *   maxCapacity: 3,
 * });
 * ```
 *
 * @example Scale DynamoDB Read Capacity
 * ```typescript
 * const target = yield* ScalableTarget("TableReadScaling", {
 *   serviceNamespace: "dynamodb",
 *   resourceId: Output.interpolate`table/${table.tableName}`,
 *   scalableDimension: "dynamodb:table:ReadCapacityUnits",
 *   minCapacity: 1,
 *   maxCapacity: 10,
 * });
 * ```
 *
 * @section Suspending Scaling
 * @example Suspend Dynamic Scale-In
 * ```typescript
 * yield* ScalableTarget("ApiScaling", {
 *   serviceNamespace: "ecs",
 *   resourceId: Output.interpolate`service/${cluster.clusterName}/${service.serviceName}`,
 *   scalableDimension: "ecs:service:DesiredCount",
 *   minCapacity: 1,
 *   maxCapacity: 3,
 *   suspendedState: { DynamicScalingInSuspended: true },
 * });
 * ```
 */
export const ScalableTarget = Resource<ScalableTarget>(
  "AWS.ApplicationAutoScaling.ScalableTarget",
);

export const ScalableTargetProvider = () =>
  Provider.effect(
    ScalableTarget,
    Effect.gen(function* () {
      const describe = (props: {
        serviceNamespace: aas.ServiceNamespace;
        resourceId: string;
        scalableDimension: aas.ScalableDimension;
      }) =>
        aas
          .describeScalableTargets({
            ServiceNamespace: props.serviceNamespace,
            ResourceIds: [props.resourceId],
            ScalableDimension: props.scalableDimension,
          })
          .pipe(
            Effect.map((res) =>
              res.ScalableTargets?.find(
                (t) =>
                  t.ResourceId === props.resourceId &&
                  t.ScalableDimension === props.scalableDimension,
              ),
            ),
          );

      const toAttributes = (
        target: aas.ScalableTarget,
      ): ScalableTarget["Attributes"] => ({
        serviceNamespace: target.ServiceNamespace,
        resourceId: target.ResourceId,
        scalableDimension: target.ScalableDimension,
        scalableTargetArn: target.ScalableTargetARN ?? "",
        minCapacity: target.MinCapacity,
        maxCapacity: target.MaxCapacity,
        roleArn: target.RoleARN,
        suspendedState: target.SuspendedState,
      });

      const observedTags = (scalableTargetArn: string) =>
        aas.listTagsForResource({ ResourceARN: scalableTargetArn }).pipe(
          Effect.map((res) =>
            Object.fromEntries(
              Object.entries(res.Tags ?? {}).filter(
                (entry): entry is [string, string] => entry[1] !== undefined,
              ),
            ),
          ),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed({} as Record<string, string>),
          ),
        );

      // Derive the (namespace, resourceId, dimension) identity triple.
      // `output` is preferred (it always survives state persistence);
      // props may have lost Output-valued fields in a `creating`-state
      // round-trip, so tolerate undefined and report "unknown identity".
      const identityOf = (
        output:
          | Pick<
              ScalableTarget["Attributes"],
              "serviceNamespace" | "resourceId" | "scalableDimension"
            >
          | undefined,
        props: Partial<ScalableTargetProps> | undefined,
      ) => {
        const serviceNamespace =
          output?.serviceNamespace ?? props?.serviceNamespace;
        const resourceId = output?.resourceId ?? props?.resourceId;
        const scalableDimension =
          output?.scalableDimension ?? props?.scalableDimension;
        return serviceNamespace !== undefined &&
          resourceId !== undefined &&
          scalableDimension !== undefined
          ? { serviceNamespace, resourceId, scalableDimension }
          : undefined;
      };

      return {
        stables: [
          "serviceNamespace",
          "resourceId",
          "scalableDimension",
          "scalableTargetArn",
        ],

        // Account/region-wide enumeration. The describe API requires a
        // `ServiceNamespace` filter, so union the per-namespace pages over
        // every known namespace.
        list: () =>
          Effect.forEach(
            SERVICE_NAMESPACES,
            (namespace) =>
              aas.describeScalableTargets
                .pages({ ServiceNamespace: namespace })
                .pipe(
                  Stream.runCollect,
                  Effect.map((chunk) =>
                    Array.from(chunk).flatMap((page) =>
                      (page.ScalableTargets ?? []).map(toAttributes),
                    ),
                  ),
                ),
            { concurrency: 4 },
          ).pipe(Effect.map((groups) => groups.flat())),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          // The identity triple is immutable — any change replaces the
          // target. Only compare sides that are actually known: a
          // half-created state row may have lost Output-valued props.
          for (const key of [
            "serviceNamespace",
            "resourceId",
            "scalableDimension",
          ] as const) {
            const oldValue = olds?.[key];
            if (
              oldValue !== undefined &&
              isResolved(oldValue) &&
              oldValue !== news[key]
            ) {
              return { action: "replace" } as const;
            }
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const identity = identityOf(output, olds);
          if (identity === undefined) return undefined;
          const found = yield* describe(identity);
          if (!found) return undefined;
          const attrs = toAttributes(found);
          const tags = found.ScalableTargetARN
            ? yield* observedTags(found.ScalableTargetARN)
            : {};
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, session }) {
          const identity = {
            serviceNamespace: news.serviceNamespace,
            resourceId: news.resourceId,
            scalableDimension: news.scalableDimension,
          };
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // Observe — cloud state is authoritative.
          const existing = yield* describe(identity);

          // Ensure + sync capacity — `registerScalableTarget` is an upsert
          // (a put keyed by the identity triple), so one call both creates
          // a missing target and converges min/max/role/suspendedState on
          // an existing one. Tags in the request only apply on creation;
          // existing targets are converged by the tag sync below.
          yield* aas.registerScalableTarget({
            ServiceNamespace: identity.serviceNamespace,
            ResourceId: identity.resourceId,
            ScalableDimension: identity.scalableDimension,
            MinCapacity: news.minCapacity,
            MaxCapacity: news.maxCapacity,
            RoleARN: news.roleArn,
            SuspendedState: news.suspendedState,
            ...(existing === undefined ? { Tags: desiredTags } : {}),
          });

          // Re-observe to pick up the generated ARN and the service-linked
          // role AWS resolved.
          const found = yield* describe(identity);
          const scalableTargetArn =
            found?.ScalableTargetARN ?? existing?.ScalableTargetARN;

          // Sync tags — diff observed cloud tags against desired.
          if (scalableTargetArn) {
            const currentTags = yield* observedTags(scalableTargetArn);
            const { removed, upsert } = diffTags(currentTags, desiredTags);
            if (upsert.length > 0) {
              yield* aas.tagResource({
                ResourceARN: scalableTargetArn,
                Tags: Object.fromEntries(
                  upsert.map((t) => [t.Key, t.Value] as const),
                ),
              });
            }
            if (removed.length > 0) {
              yield* aas.untagResource({
                ResourceARN: scalableTargetArn,
                TagKeys: removed,
              });
            }
          }

          yield* session.note(
            `${identity.serviceNamespace}/${identity.resourceId}`,
          );

          return {
            serviceNamespace: identity.serviceNamespace,
            resourceId: identity.resourceId,
            scalableDimension: identity.scalableDimension,
            scalableTargetArn: scalableTargetArn ?? "",
            minCapacity: found?.MinCapacity ?? news.minCapacity,
            maxCapacity: found?.MaxCapacity ?? news.maxCapacity,
            roleArn: found?.RoleARN ?? news.roleArn ?? "",
            suspendedState: found?.SuspendedState ?? news.suspendedState,
          };
        }),

        // Deregistering also deletes any scaling policies and scheduled
        // actions still attached to the target; already-gone targets
        // surface as the typed `ObjectNotFoundException` and are success.
        delete: Effect.fn(function* ({ output }) {
          yield* aas
            .deregisterScalableTarget({
              ServiceNamespace: output.serviceNamespace,
              ResourceId: output.resourceId,
              ScalableDimension: output.scalableDimension,
            })
            .pipe(
              Effect.catchTag("ObjectNotFoundException", () => Effect.void),
            );
        }),
      };
    }),
  );
