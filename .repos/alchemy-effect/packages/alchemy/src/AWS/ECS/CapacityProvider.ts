import * as ecs from "@distilled.cloud/aws/ecs";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasTags } from "../../Tags.ts";
import { AWSEnvironment, type AccountID } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import type { RegionID } from "../Region.ts";

export type CapacityProviderName = string;
export type CapacityProviderArn =
  `arn:aws:ecs:${RegionID}:${AccountID}:capacity-provider/${CapacityProviderName}`;

export interface CapacityProviderProps {
  /**
   * Capacity provider name. If omitted, a deterministic name is generated.
   *
   * Names beginning with `aws`, `ecs`, or `fargate` are reserved by AWS.
   * Changing this triggers a replacement.
   */
  name?: string;
  /**
   * ARN of the EC2 Auto Scaling Group that backs this capacity provider.
   *
   * Cannot be changed after creation; changing this triggers a replacement.
   */
  autoScalingGroupArn: Input<string>;
  /**
   * Managed scaling configuration applied by ECS to the underlying ASG.
   */
  managedScaling?: ecs.ManagedScaling;
  /**
   * Whether ECS protects in-use container instances from ASG scale-in.
   * @default "DISABLED"
   */
  managedTerminationProtection?: ecs.ManagedTerminationProtection;
  /**
   * Whether ECS sets container instances to DRAINING when terminated by ASG.
   * @default "DISABLED"
   */
  managedDraining?: ecs.ManagedDraining;
  /**
   * User-defined tags to apply to the capacity provider.
   */
  tags?: Record<string, string>;
}

export interface CapacityProvider extends Resource<
  "AWS.ECS.CapacityProvider",
  CapacityProviderProps,
  {
    /** The ARN of the capacity provider. */
    capacityProviderArn: CapacityProviderArn;
    /** The name of the capacity provider. */
    name: CapacityProviderName;
    /** The current status, e.g. `ACTIVE`. */
    status: ecs.CapacityProviderStatus;
    /** The status of the most recent update to the provider. */
    updateStatus: ecs.CapacityProviderUpdateStatus | undefined;
    /** The Auto Scaling group backing the provider. */
    autoScalingGroupArn: string;
    /** The managed scaling configuration. */
    managedScaling: ecs.ManagedScaling | undefined;
    /** Whether managed termination protection is enabled. */
    managedTerminationProtection: ecs.ManagedTerminationProtection | undefined;
    /** Whether managed instance draining is enabled. */
    managedDraining: ecs.ManagedDraining | undefined;
    /** The tags attached to the capacity provider. */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Amazon ECS capacity provider backed by an EC2 Auto Scaling Group.
 *
 * Capacity providers are associated with one or more ECS clusters via
 * {@link Cluster#capacityProviders} and are referenced by a service or task's
 * capacity provider strategy.
 *
 * Only EC2 Auto Scaling Group-backed capacity providers are currently
 * supported. The reserved AWS providers `FARGATE` and `FARGATE_SPOT` do not
 * need to be created and can be referenced by name on a `Cluster` directly.
 * @resource
 * @section Creating Capacity Providers
 * @example ASG-Backed Capacity Provider
 * ```typescript
 * const provider = yield* CapacityProvider("AppCapacityProvider", {
 *   autoScalingGroupArn: asg.autoScalingGroupArn,
 *   managedScaling: {
 *     status: "ENABLED",
 *     targetCapacity: 80,
 *     minimumScalingStepSize: 1,
 *     maximumScalingStepSize: 10,
 *   },
 *   managedTerminationProtection: "ENABLED",
 * });
 *
 * yield* Cluster("AppCluster", {
 *   capacityProviders: [provider.name],
 *   defaultCapacityProviderStrategy: [
 *     { capacityProvider: provider.name, weight: 1 },
 *   ],
 * });
 * ```
 *
 * @section Adopting Existing Capacity Providers
 * Foreign-tagged capacity providers (i.e. providers that exist in AWS but were
 * not created by this stack/stage/logical-id) are surfaced as `Unowned` by
 * `read`, and the engine fails with `OwnedBySomeoneElse` unless adoption is
 * explicitly opted in via `--adopt` or {@link adopt}.
 * @example Adopt an existing provider
 * ```typescript
 * import { adopt } from "alchemy/AdoptPolicy";
 *
 * yield* CapacityProvider("AppCapacityProvider", {
 *   name: "existing-provider",
 *   autoScalingGroupArn: asg.autoScalingGroupArn,
 * }).pipe(adopt());
 * ```
 */
export const CapacityProvider = Resource<CapacityProvider>(
  "AWS.ECS.CapacityProvider",
);

export const CapacityProviderProvider = () =>
  Provider.effect(
    CapacityProvider,
    Effect.gen(function* () {
      const toEcsTags = (tags: Record<string, string>): ecs.Tag[] =>
        Object.entries(tags).map(([key, value]) => ({ key, value }));

      const fromEcsTags = (
        tags: ecs.Tag[] | undefined,
      ): Record<string, string> =>
        Object.fromEntries(
          (tags ?? [])
            .filter(
              (t): t is { key: string; value: string } =>
                t.key !== undefined && t.value !== undefined,
            )
            .map((t) => [t.key, t.value]),
        );

      const toName = (id: string, props: { name?: string } = {}) =>
        props.name
          ? Effect.succeed(props.name)
          : createPhysicalName({ id, maxLength: 255, lowercase: true });

      const describe = (name: string) =>
        ecs
          .describeCapacityProviders({
            capacityProviders: [name],
            include: ["TAGS"],
          })
          .pipe(
            Effect.map((res) =>
              res.capacityProviders?.find((p) => p.name === name),
            ),
          );

      return {
        stables: ["capacityProviderArn", "name"],

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return;
          const oldName = yield* toName(id, olds ?? {});
          const newName = yield* toName(id, news);
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
          if (
            isResolved(olds.autoScalingGroupArn) &&
            olds.autoScalingGroupArn !== news.autoScalingGroupArn
          ) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.name ?? (yield* toName(id, olds ?? {}));
          const found = yield* describe(name);
          if (!found?.name || !found.capacityProviderArn) {
            return undefined;
          }
          const internalTags = yield* createInternalTags(id);
          const existingTags = fromEcsTags(found.tags);
          const attrs = {
            capacityProviderArn:
              found.capacityProviderArn as CapacityProviderArn,
            name: found.name,
            status: (found.status ?? "ACTIVE") as ecs.CapacityProviderStatus,
            updateStatus: found.updateStatus,
            autoScalingGroupArn:
              found.autoScalingGroupProvider?.autoScalingGroupArn ?? "",
            managedScaling: found.autoScalingGroupProvider?.managedScaling,
            managedTerminationProtection:
              found.autoScalingGroupProvider?.managedTerminationProtection,
            managedDraining: found.autoScalingGroupProvider?.managedDraining,
            tags: existingTags,
          };
          return hasTags(internalTags, existingTags) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, session }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const name = yield* toName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };
          const autoScalingGroupArn = news.autoScalingGroupArn as string;

          // Observe — fetch live cloud state. We fetch fresh on every
          // reconcile so adoption, drift, and partial-prior-runs all
          // converge.
          let existing = yield* describe(name);

          // Ensure — create the capacity provider if missing.
          if (!existing?.name || !existing.capacityProviderArn) {
            yield* ecs
              .createCapacityProvider({
                name,
                autoScalingGroupProvider: {
                  autoScalingGroupArn,
                  managedScaling: news.managedScaling,
                  managedTerminationProtection:
                    news.managedTerminationProtection,
                  managedDraining: news.managedDraining,
                },
                tags: toEcsTags(desiredTags),
              })
              .pipe(
                // ECS may surface concurrent creation either as
                // `LimitExceededException` or a generic `ClientException`
                // with name conflict semantics — re-describe and continue.
                Effect.catchTag("LimitExceededException", () => Effect.void),
              );
            existing = yield* describe(name);
          }

          const capacityProviderArn = (existing?.capacityProviderArn ??
            `arn:aws:ecs:${region}:${accountId}:capacity-provider/${name}`) as CapacityProviderArn;

          // Sync managed scaling — observed ↔ desired. ECS
          // updateCapacityProvider only mutates managed* fields; ASG ARN is
          // immutable (replacement-triggering, handled in diff).
          yield* ecs.updateCapacityProvider({
            name,
            autoScalingGroupProvider: {
              managedScaling: news.managedScaling,
              managedTerminationProtection: news.managedTerminationProtection,
              managedDraining: news.managedDraining,
            },
          });

          // Sync tags — diff observed cloud tags against desired.
          const observedTags = fromEcsTags(existing?.tags);
          const { removed, upsert } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* ecs.tagResource({
              resourceArn: capacityProviderArn,
              tags: upsert.map((t) => ({ key: t.Key, value: t.Value })),
            });
          }
          if (removed.length > 0) {
            yield* ecs.untagResource({
              resourceArn: capacityProviderArn,
              tagKeys: removed,
            });
          }

          // Re-read to capture status / updateStatus reflecting our changes.
          const found = yield* describe(name);
          yield* session.note(capacityProviderArn);

          return {
            capacityProviderArn,
            name,
            status: (found?.status ?? "ACTIVE") as ecs.CapacityProviderStatus,
            updateStatus: found?.updateStatus,
            autoScalingGroupArn:
              found?.autoScalingGroupProvider?.autoScalingGroupArn ??
              autoScalingGroupArn,
            managedScaling:
              found?.autoScalingGroupProvider?.managedScaling ??
              news.managedScaling,
            managedTerminationProtection:
              found?.autoScalingGroupProvider?.managedTerminationProtection ??
              news.managedTerminationProtection,
            managedDraining:
              found?.autoScalingGroupProvider?.managedDraining ??
              news.managedDraining,
            tags: desiredTags,
          };
        }),

        list: () =>
          Effect.gen(function* () {
            // Enumerate every capacity provider in the account/region.
            // `describeCapacityProviders` with no filter returns all providers
            // and paginates via `nextToken`; it is a plain operation (no
            // `.pages`), so drive the pagination with `Stream.paginate`.
            const all = yield* Stream.paginate(
              undefined as string | undefined,
              (token) =>
                ecs
                  .describeCapacityProviders({
                    include: ["TAGS"],
                    ...(token ? { nextToken: token } : {}),
                  })
                  .pipe(
                    Effect.map(
                      (res) =>
                        [
                          res.capacityProviders ?? [],
                          res.nextToken
                            ? Option.some(res.nextToken)
                            : Option.none<string>(),
                        ] as const,
                    ),
                  ),
            ).pipe(
              Stream.runCollect,
              Effect.map((chunk) => Array.from(chunk)),
            );

            return all
              .filter(
                (
                  p,
                ): p is ecs.CapacityProvider & {
                  name: string;
                  capacityProviderArn: string;
                } =>
                  p.name != null &&
                  p.capacityProviderArn != null &&
                  // FARGATE / FARGATE_SPOT are AWS-managed reserved providers
                  // that this resource does not create or own.
                  p.name !== "FARGATE" &&
                  p.name !== "FARGATE_SPOT",
              )
              .map((p) => ({
                capacityProviderArn:
                  p.capacityProviderArn as CapacityProviderArn,
                name: p.name,
                status: (p.status ?? "ACTIVE") as ecs.CapacityProviderStatus,
                updateStatus: p.updateStatus,
                autoScalingGroupArn:
                  p.autoScalingGroupProvider?.autoScalingGroupArn ?? "",
                managedScaling: p.autoScalingGroupProvider?.managedScaling,
                managedTerminationProtection:
                  p.autoScalingGroupProvider?.managedTerminationProtection,
                managedDraining: p.autoScalingGroupProvider?.managedDraining,
                tags: fromEcsTags(p.tags),
              }));
          }),

        delete: Effect.fn(function* ({ output }) {
          yield* ecs
            .deleteCapacityProvider({ capacityProvider: output.name })
            .pipe(
              // Already gone — treat as success.
              Effect.catchTag("InvalidParameterException", () => Effect.void),
              Effect.catchTag("ClientException", () => Effect.void),
            );
        }),
      };
    }),
  );
