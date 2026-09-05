import * as greengrassv2 from "@distilled.cloud/aws/greengrassv2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

/**
 * A configuration update applied to a component when the deployment reaches
 * a core device.
 */
export interface DeploymentComponentConfigurationUpdate {
  /**
   * A JSON-serialized object that the deployment merges into the component's
   * default configuration.
   */
  merge?: string;
  /**
   * Configuration paths to reset to their default values.
   */
  reset?: string[];
}

/**
 * A component to include in a deployment, keyed by component name on the
 * deployment's `components` map.
 */
export interface DeploymentComponent {
  /**
   * The version of the component to deploy, e.g. `1.0.0`.
   */
  componentVersion: string;
  /**
   * Configuration update the deployment applies to the component.
   */
  configurationUpdate?: DeploymentComponentConfigurationUpdate;
}

export interface DeploymentProps {
  /**
   * The ARN of the target IoT thing or thing group. Each target has at most
   * one deployment; creating a new deployment for a target supersedes the
   * previous revision.
   *
   * Changing the target replaces the deployment.
   */
  targetArn: string;
  /**
   * A friendly name for the deployment.
   * @default ${app}-${stage}-${id}
   */
  deploymentName?: string;
  /**
   * The components to deploy, keyed by component name. Updating this map
   * creates a new deployment revision for the target.
   */
  components?: Record<string, DeploymentComponent>;
  /**
   * Tags to apply to the deployment. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface Deployment extends Resource<
  "AWS.GreengrassV2.Deployment",
  DeploymentProps,
  {
    /** The unique ID of the deployment. */
    deploymentId: string;
    /** The ARN of the deployment. */
    deploymentArn: string;
    /** The ARN of the target core device or thing group. */
    targetArn: string;
    /** The revision of the deployment. */
    revisionId?: string;
    /** The current status of the deployment (`ACTIVE`, `COMPLETED`, ...). */
    deploymentStatus?: string;
    /** The ID of the IoT job that rolls the deployment out to core devices. */
    iotJobId?: string;
    /** The ARN of the IoT job that rolls the deployment out to core devices. */
    iotJobArn?: string;
  },
  never,
  Providers
> {}

/**
 * An IoT Greengrass V2 continuous deployment that installs a set of component
 * versions on a target IoT thing or thing group.
 *
 * Updating the deployment's components or name creates a new deployment
 * revision for the target (the `deploymentId` attribute changes); the
 * previous revision is canceled and deleted.
 *
 * @resource
 * @section Creating Deployments
 * @example Deploy a component to a thing
 * ```typescript
 * import * as GreengrassV2 from "alchemy/AWS/GreengrassV2";
 * import * as IoT from "alchemy/AWS/IoT";
 *
 * const core = yield* IoT.Thing("Core", {});
 * const component = yield* GreengrassV2.ComponentVersion("Hello", { recipe });
 *
 * const deployment = yield* GreengrassV2.Deployment("Rollout", {
 *   targetArn: core.thingArn,
 *   components: {
 *     [component.componentName]: {
 *       componentVersion: component.componentVersion,
 *     },
 *   },
 * });
 * ```
 *
 * @example Deployment with a configuration update
 * ```typescript
 * const deployment = yield* GreengrassV2.Deployment("Rollout", {
 *   targetArn: core.thingArn,
 *   components: {
 *     "com.example.Hello": {
 *       componentVersion: "1.0.0",
 *       configurationUpdate: { merge: JSON.stringify({ interval: 30 }) },
 *     },
 *   },
 * });
 * ```
 */
export const Deployment = Resource<Deployment>("AWS.GreengrassV2.Deployment");

/**
 * Raised when `createDeployment` returns without a deployment ID, which the
 * provider needs to track the deployment revision.
 */
export class GreengrassDeploymentMissingId extends Data.TaggedError(
  "GreengrassDeploymentMissingId",
)<{ message: string }> {}

// Explicitly-typed pipeable retry helper (see EC2/VolumeAttachment.ts) —
// deleting a deployment right after cancellation can race the state change.
const retryWhileConflict = <A, E extends { readonly _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "ConflictException",
    schedule: Schedule.max([Schedule.fixed(2000), Schedule.recurs(10)]),
  });

const normalizeTags = (
  tags: { [key: string]: string | undefined } | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(tags ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

/**
 * Canonicalizes a components map (ours or the wire's) for drift comparison:
 * sorted keys, only defined fields.
 */
interface ComparableComponentSpec {
  componentVersion?: string;
  configurationUpdate?: { merge?: string; reset?: readonly string[] };
}

const canonicalComponents = (
  components:
    | { [key: string]: ComparableComponentSpec | undefined }
    | undefined,
): string =>
  JSON.stringify(
    Object.keys(components ?? {})
      .sort()
      .flatMap((name) => {
        const spec = components?.[name];
        return spec === undefined
          ? []
          : [
              [
                name,
                {
                  componentVersion: spec.componentVersion,
                  merge: spec.configurationUpdate?.merge,
                  reset: spec.configurationUpdate?.reset?.slice().sort(),
                },
              ],
            ];
      }),
  );

export const DeploymentProvider = () =>
  Provider.effect(
    Deployment,
    Effect.gen(function* () {
      const createDeploymentName = Effect.fn(function* (
        id: string,
        props: Pick<DeploymentProps, "deploymentName">,
      ) {
        return props.deploymentName ?? (yield* createPhysicalName({ id }));
      });

      const deploymentArn = Effect.fn(function* (deploymentId: string) {
        const { accountId, region } = yield* AWSEnvironment.current;
        return `arn:aws:greengrass:${region}:${accountId}:deployments:${deploymentId}`;
      });

      const observeDeployment = (deploymentId: string) =>
        greengrassv2
          .getDeployment({ deploymentId })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

      // The latest deployment revision for a target (cloud-authoritative).
      const observeLatestForTarget = (targetArn: string) =>
        Effect.gen(function* () {
          const deployments = yield* greengrassv2.listDeployments
            .items({ targetArn, historyFilter: "LATEST_ONLY" })
            .pipe(Stream.runCollect);
          const latest = Array.from(deployments)[0];
          if (latest?.deploymentId === undefined) return undefined;
          return yield* observeDeployment(latest.deploymentId);
        });

      const attributesOf = Effect.fn(function* (
        live: greengrassv2.GetDeploymentResponse,
        fallbackTargetArn: string,
      ) {
        const deploymentId = live.deploymentId;
        if (deploymentId === undefined) {
          return yield* Effect.fail(
            new GreengrassDeploymentMissingId({
              message: "getDeployment returned no deploymentId",
            }),
          );
        }
        return {
          deploymentId,
          deploymentArn: yield* deploymentArn(deploymentId),
          targetArn: live.targetArn ?? fallbackTargetArn,
          revisionId: live.revisionId,
          deploymentStatus: live.deploymentStatus,
          iotJobId: live.iotJobId,
          iotJobArn: live.iotJobArn,
        };
      });

      // Cancel (if still active) and delete a superseded/destroyed revision.
      const cancelAndDelete = (deploymentId: string) =>
        Effect.gen(function* () {
          yield* greengrassv2.cancelDeployment({ deploymentId }).pipe(
            // Already completed/canceled/inactive revisions reject the
            // cancellation — that is exactly the state we want.
            Effect.catchTag(
              [
                "ResourceNotFoundException",
                "ConflictException",
                "ValidationException",
              ],
              () => Effect.succeed(undefined),
            ),
          );
          yield* greengrassv2
            .deleteDeployment({ deploymentId })
            .pipe(retryWhileConflict)
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        });

      return Deployment.Provider.of({
        stables: ["targetArn"],
        list: () =>
          Effect.gen(function* () {
            const deployments = yield* greengrassv2.listDeployments
              .items({ historyFilter: "LATEST_ONLY" })
              .pipe(Stream.runCollect);
            const results: {
              deploymentId: string;
              deploymentArn: string;
              targetArn: string;
              revisionId?: string;
              deploymentStatus?: string;
              iotJobId?: string;
              iotJobArn?: string;
            }[] = [];
            for (const deployment of deployments) {
              if (
                deployment.deploymentId === undefined ||
                deployment.targetArn === undefined
              ) {
                continue;
              }
              results.push({
                deploymentId: deployment.deploymentId,
                deploymentArn: yield* deploymentArn(deployment.deploymentId),
                targetArn: deployment.targetArn,
                revisionId: deployment.revisionId,
                deploymentStatus: deployment.deploymentStatus,
              });
            }
            return results;
          }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const live =
            output?.deploymentId !== undefined
              ? yield* observeDeployment(output.deploymentId)
              : olds !== undefined
                ? yield* observeLatestForTarget(olds.targetArn)
                : undefined;
          if (live?.deploymentId === undefined) return undefined;
          const attrs = yield* attributesOf(
            live,
            output?.targetArn ?? olds?.targetArn ?? "",
          );
          return (yield* hasAlchemyTags(id, normalizeTags(live.tags)))
            ? attrs
            : Unowned(attrs);
        }),
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          // A deployment belongs to exactly one target.
          if (olds !== undefined && news.targetArn !== olds.targetArn) {
            return { action: "replace" } as const;
          }
          // fall through: engine default update (new revision in reconcile)
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const deploymentName = yield* createDeploymentName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };
          const desiredComponents = canonicalComponents(news.components);

          // 1. OBSERVE — the latest revision for the target is authoritative;
          //    output.deploymentId is only a cache of the revision we made.
          let live = yield* observeLatestForTarget(news.targetArn);

          // 2. ENSURE/SYNC — a deployment revision is immutable: when the
          //    observed latest revision drifts from the desired spec (or none
          //    exists), create a new revision that supersedes it.
          const inSync =
            live !== undefined &&
            live.deploymentName === deploymentName &&
            canonicalComponents(live.components) === desiredComponents;
          if (!inSync) {
            const created = yield* greengrassv2.createDeployment({
              targetArn: news.targetArn,
              deploymentName,
              components: news.components ?? {},
              tags: desiredTags,
            });
            if (created.deploymentId === undefined) {
              return yield* Effect.fail(
                new GreengrassDeploymentMissingId({
                  message: `createDeployment for ${news.targetArn} returned no deploymentId`,
                }),
              );
            }
            // Clean up the revision we previously created, now superseded.
            if (
              output?.deploymentId !== undefined &&
              output.deploymentId !== created.deploymentId
            ) {
              yield* cancelAndDelete(output.deploymentId);
            }
            live = yield* observeDeployment(created.deploymentId);
            if (live === undefined) {
              return yield* Effect.fail(
                new GreengrassDeploymentMissingId({
                  message: `deployment ${created.deploymentId} disappeared after creation`,
                }),
              );
            }
          }

          // Post-ensure narrowing: `inSync` implies `live` was observed and
          // the !inSync branch re-observed after create, but TS cannot track
          // that through the reassignment — guard with a typed error.
          if (live === undefined) {
            return yield* Effect.fail(
              new GreengrassDeploymentMissingId({
                message: `no deployment observed for target ${news.targetArn} after reconcile`,
              }),
            );
          }

          const attrs = yield* attributesOf(live, news.targetArn);

          // 3. SYNC TAGS — diff against OBSERVED cloud tags so adoption and
          //    no-op updates converge (create-time tags only apply on create).
          const observedTags = normalizeTags(live.tags);
          const { upsert, removed } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* greengrassv2.tagResource({
              resourceArn: attrs.deploymentArn,
              tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
            });
          }
          if (removed.length > 0) {
            yield* greengrassv2.untagResource({
              resourceArn: attrs.deploymentArn,
              tagKeys: removed,
            });
          }

          yield* session.note(attrs.deploymentId);
          return attrs;
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* cancelAndDelete(output.deploymentId);
        }),
      });
    }),
  );
