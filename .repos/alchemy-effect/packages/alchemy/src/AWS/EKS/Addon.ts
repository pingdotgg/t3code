import * as eks from "@distilled.cloud/aws/eks";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { deepEqual, isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";

export interface AddonProps {
  /**
   * Target cluster name.
   */
  clusterName: Input<string>;
  /**
   * Add-on name, such as `metrics-server`.
   */
  addonName: string;
  /**
   * Optional add-on version. If omitted, EKS chooses the default compatible version.
   */
  addonVersion?: string;
  /**
   * IAM role ARN used by the add-on's service account.
   */
  serviceAccountRoleArn?: Input<string>;
  /**
   * Conflict resolution strategy used during create and update.
   */
  resolveConflicts?: eks.ResolveConflicts;
  /**
   * Optional add-on configuration JSON string.
   */
  configurationValues?: string;
  /**
   * Optional pod identity associations managed by the add-on.
   */
  podIdentityAssociations?: eks.AddonPodIdentityAssociations[];
  /**
   * Optional namespace override. Changing this requires replacement.
   */
  namespaceConfig?: eks.AddonNamespaceConfigRequest;
  /**
   * Preserve the add-on installation when the Alchemy resource is deleted.
   */
  preserveOnDelete?: boolean;
  /**
   * User-defined tags to apply to the add-on.
   */
  tags?: Record<string, string>;
}

export interface Addon extends Resource<
  "AWS.EKS.Addon",
  AddonProps,
  {
    /** The ARN of the add-on. */
    addonArn: string;
    /** The name of the add-on (e.g. `vpc-cni`, `coredns`). */
    addonName: string;
    /** The name of the EKS cluster the add-on is installed on. */
    clusterName: string;
    /** The add-on status (e.g. `ACTIVE`, `DEGRADED`). */
    status: eks.AddonStatus;
    /** The installed version of the add-on. */
    addonVersion: string | undefined;
    /** The IAM role ARN bound to the add-on's service account, if any. */
    serviceAccountRoleArn: string | undefined;
    /** The add-on's configuration values (JSON or YAML). */
    configurationValues: string | undefined;
    /** The ARNs of the pod identity associations owned by the add-on. */
    podIdentityAssociations: string[];
    /** The Kubernetes namespace the add-on is installed in. */
    namespace: string | undefined;
    /** The publisher of the add-on. */
    publisher: string | undefined;
    /** The owner of the add-on. */
    owner: string | undefined;
    /** The tags applied to the add-on. */
    tags: Record<string, string>;
    /** Health issues currently reported for the add-on. */
    healthIssues: eks.AddonIssue[];
  },
  never,
  Providers
> {}

/**
 * An Amazon EKS managed add-on installed on a cluster.
 *
 * `Addon` is intended for optional managed add-ons. On Auto Mode clusters, many
 * core components are already provided by AWS and do not need to be modeled as
 * explicit add-on resources.
 * @resource
 * @section Managing Add-ons
 * @example Install Metrics Server
 * ```typescript
 * const metricsServer = yield* Addon("MetricsServer", {
 *   clusterName: cluster.clusterName,
 *   addonName: "metrics-server",
 * });
 * ```
 */
export const Addon = Resource<Addon>("AWS.EKS.Addon");

const normalizeTags = (tags: Record<string, string | undefined> | undefined) =>
  Object.fromEntries(
    Object.entries(tags ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

const mapAddon = (addon: eks.Addon) => ({
  addonArn: addon.addonArn!,
  addonName: addon.addonName!,
  clusterName: addon.clusterName!,
  status: addon.status ?? "CREATING",
  addonVersion: addon.addonVersion,
  serviceAccountRoleArn: addon.serviceAccountRoleArn,
  configurationValues: addon.configurationValues,
  podIdentityAssociations: addon.podIdentityAssociations ?? [],
  namespace: addon.namespaceConfig?.namespace,
  publisher: addon.publisher,
  owner: addon.owner,
  tags: normalizeTags(addon.tags),
  healthIssues: addon.health?.issues ?? [],
});

const readAddon = Effect.fn(function* ({
  clusterName,
  addonName,
}: {
  clusterName: string;
  addonName: string;
}) {
  const response = yield* eks
    .describeAddon({
      clusterName,
      addonName,
    })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );

  const addon = response?.addon;
  if (!addon?.addonArn || !addon.addonName || !addon.clusterName) {
    return undefined;
  }

  return mapAddon(addon);
});

class AddonNotReady extends Data.TaggedError("AddonNotReady")<{
  readonly clusterName: string;
  readonly addonName: string;
  readonly status: string | undefined;
}> {
  override get message(): string {
    return `addon '${this.clusterName}/${this.addonName}' is not ACTIVE (status: ${this.status ?? "absent"})`;
  }
}

class AddonStillExists extends Data.TaggedError("AddonStillExists")<{
  readonly clusterName: string;
  readonly addonName: string;
}> {}
export const AddonProvider = () =>
  Provider.effect(
    Addon,
    Effect.gen(function* () {
      const toClientRequestToken = (id: string, action: string) =>
        createPhysicalName({
          id: `${id}-${action}`,
          maxLength: 64,
          delimiter: "-",
        });

      return {
        stables: ["addonArn"],
        // Add-ons are keyed by (clusterName, addonName) and `listAddons`
        // requires a cluster. Enumerate every cluster, list its add-ons,
        // then hydrate each via `describeAddon` to produce full Attributes.
        list: () =>
          Effect.gen(function* () {
            const clusterNames = yield* eks.listClusters.pages({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) => page.clusters ?? []),
              ),
            );

            const perCluster = yield* Effect.forEach(
              clusterNames,
              (clusterName) =>
                eks.listAddons.pages({ clusterName }).pipe(
                  Stream.runCollect,
                  Effect.map((chunk) =>
                    Array.from(chunk).flatMap((page) => page.addons ?? []),
                  ),
                  Effect.flatMap((addonNames) =>
                    Effect.forEach(
                      addonNames,
                      (addonName) => readAddon({ clusterName, addonName }),
                      { concurrency: 5 },
                    ),
                  ),
                ),
              { concurrency: 5 },
            );

            return perCluster
              .flat()
              .filter(
                (addon): addon is NonNullable<typeof addon> =>
                  addon !== undefined,
              );
          }),
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return;
          if (olds.clusterName !== news.clusterName) {
            return { action: "replace" } as const;
          }

          if (olds.addonName !== news.addonName) {
            return { action: "replace" } as const;
          }

          if (!deepEqual(olds.namespaceConfig, news.namespaceConfig)) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds }) {
          const clusterName = olds.clusterName as string | undefined;
          // A crashed prior run can persist a row before its unresolved
          // inputs were stripped — nothing observable yet.
          if (clusterName === undefined || olds.addonName === undefined) {
            return undefined;
          }
          const state = yield* readAddon({
            clusterName,
            addonName: olds.addonName,
          });
          if (!state) return undefined;
          return (yield* hasAlchemyTags(id, state.tags))
            ? state
            : Unowned(state);
        }),
        reconcile: Effect.fn(function* ({ id, news, session }) {
          const clusterName = news.clusterName as string;
          const addonName = news.addonName;
          const desiredTags = {
            ...(yield* createInternalTags(id)),
            ...news.tags,
          };

          // Observe — fetch live cloud state by (clusterName, addonName).
          let state = yield* readAddon({
            clusterName,
            addonName,
          });

          // Ensure — create if missing. Tolerate `ResourceInUseException`
          // as a race with a peer reconciler: re-read and continue with
          // sync.
          if (!state) {
            yield* eks
              .createAddon({
                clusterName,
                addonName,
                addonVersion: news.addonVersion,
                serviceAccountRoleArn: news.serviceAccountRoleArn as
                  | string
                  | undefined,
                resolveConflicts: news.resolveConflicts,
                configurationValues: news.configurationValues,
                podIdentityAssociations: news.podIdentityAssociations,
                namespaceConfig: news.namespaceConfig,
                tags: desiredTags,
                clientRequestToken: yield* toClientRequestToken(id, "create"),
              })
              .pipe(
                Effect.catchTag("ResourceInUseException", () => Effect.void),
              );

            state = yield* waitForAddonActive({
              clusterName,
              addonName,
            });
          }

          // Sync addon version / config — diff observed against desired.
          // updateAddon handles version, role, resolve conflicts, config
          // values, and pod identity associations atomically.
          const podIdentityChanged =
            JSON.stringify(state.podIdentityAssociations ?? []) !==
            JSON.stringify(news.podIdentityAssociations ?? []);
          if (
            (news.addonVersion !== undefined &&
              state.addonVersion !== news.addonVersion) ||
            state.serviceAccountRoleArn !==
              (news.serviceAccountRoleArn as string | undefined) ||
            state.configurationValues !== news.configurationValues ||
            podIdentityChanged
          ) {
            yield* eks.updateAddon({
              clusterName,
              addonName,
              addonVersion: news.addonVersion,
              serviceAccountRoleArn: news.serviceAccountRoleArn as
                | string
                | undefined,
              resolveConflicts: news.resolveConflicts,
              configurationValues: news.configurationValues,
              podIdentityAssociations: news.podIdentityAssociations,
              clientRequestToken: yield* toClientRequestToken(id, "update"),
            });
            state = yield* waitForAddonActive({
              clusterName,
              addonName,
            });
          }

          // Sync tags — diff observed cloud tags against desired.
          const { removed, upsert } = diffTags(state.tags, desiredTags);
          if (upsert.length > 0) {
            yield* eks.tagResource({
              resourceArn: state.addonArn,
              tags: Object.fromEntries(
                upsert.map((tag) => [tag.Key, tag.Value] as const),
              ),
            });
          }
          if (removed.length > 0) {
            yield* eks.untagResource({
              resourceArn: state.addonArn,
              tagKeys: removed,
            });
          }

          yield* session.note(state.addonArn);
          return state;
        }),
        delete: Effect.fn(function* ({ olds, output }) {
          yield* eks
            .deleteAddon({
              clusterName: output.clusterName,
              addonName: output.addonName,
              preserve: olds.preserveOnDelete,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );

          if (!olds.preserveOnDelete) {
            yield* waitForAddonDeleted({
              clusterName: output.clusterName,
              addonName: output.addonName,
            });
          }
        }),
      };
    }),
  );

const waitForAddonActive = Effect.fn(function* ({
  clusterName,
  addonName,
}: {
  clusterName: string;
  addonName: string;
}) {
  return yield* readAddon({
    clusterName,
    addonName,
  }).pipe(
    Effect.flatMap((addon) => {
      if (!addon) {
        return Effect.fail(
          new AddonNotReady({
            clusterName,
            addonName,
            status: undefined,
          }),
        );
      }

      switch (addon.status) {
        case "ACTIVE":
          return Effect.succeed(addon);
        case "CREATE_FAILED":
        case "UPDATE_FAILED":
        case "DELETE_FAILED":
          return Effect.fail(
            new Error(
              `Addon '${clusterName}/${addonName}' entered terminal status '${addon.status}'`,
            ),
          );
        default:
          return Effect.fail(
            new AddonNotReady({
              clusterName,
              addonName,
              status: addon.status,
            }),
          );
      }
    }),
    Effect.retry({
      while: (error) => error instanceof AddonNotReady,
      // Flat 5s polls, ~20 min budget (uncapped exponential sleeps for
      // multi-minute stretches late in the wait — looks like a deadlock).
      // Node-bound addons (e.g. HyperPod task governance) stay DEGRADED
      // until nodes join and pull images, which can take most of the
      // budget when the addon installs alongside its node group.
      schedule: Schedule.max([
        Schedule.spaced("5 seconds"),
        Schedule.recurs(240),
      ]),
    }),
  );
});

const waitForAddonDeleted = Effect.fn(function* ({
  clusterName,
  addonName,
}: {
  clusterName: string;
  addonName: string;
}) {
  yield* readAddon({
    clusterName,
    addonName,
  }).pipe(
    Effect.flatMap((addon) =>
      addon
        ? Effect.fail(new AddonStillExists({ clusterName, addonName }))
        : Effect.void,
    ),
    Effect.retry({
      while: (error) => error instanceof AddonStillExists,
      // Flat 5s polls, ~10 min budget (uncapped exponential sleeps for
      // multi-minute stretches late in the wait — looks like a deadlock).
      schedule: Schedule.max([
        Schedule.spaced("5 seconds"),
        Schedule.recurs(120),
      ]),
    }),
  );
});
