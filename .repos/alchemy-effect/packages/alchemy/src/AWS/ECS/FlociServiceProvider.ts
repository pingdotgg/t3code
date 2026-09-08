/** @effect-diagnostics anyUnknownInErrorContext:off */

/**
 * The `alchemy dev` provider for `AWS.ECS.Service`: deploys the service
 * (and, for the image-owning forms, its synthesized task definition) into
 * the floci emulator and hot-swaps the service's running tasks on file
 * change.
 *
 * Built on the shared dev-watch skeleton
 * ([DevWatchProvider](../Local/DevWatchProvider.ts)); this file supplies
 * only the Service-specific parts:
 *
 * - **Watch triggers** ({@link imageSourceTrigger}) apply to the
 *   image-owning forms (`main` / `context` / `image`). A BYO `task:`
 *   reference owns its image on the `AWS.ECS.Task` resource, so the
 *   service watcher has nothing to build — hot reload of the referenced
 *   task flows through [FlociTaskProvider](./FlociTaskProvider.ts) plus a
 *   redeploy to roll the service.
 * - **Swap mechanism** — a trigger re-runs the LIVE reconcile: the
 *   content-addressed image pipeline pushes a new `<repositoryUri>:<hash>`
 *   tag, registers a new task definition revision, and `updateService`
 *   points the service at it. Floci swaps the service's task definition in
 *   place WITHOUT restarting running containers (probed), so the
 *   old-revision tasks are stopped and the floci service scheduler
 *   relaunches them on the new revision (~6s observed end-to-end for a
 *   container relaunch).
 * - **Task roll** lives in the skeleton's `onReconciled` hook — NOT in the
 *   watch loop — so it also fires for engine-driven reconciles. Prop-only
 *   changes (an inline `dockerfile` edit, a new env var) never produce a
 *   file event: before the hook, they registered a new revision and
 *   `updateService`d onto it, but the running containers kept serving the
 *   old one until the next source edit.
 */

import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { deepEqual } from "../../Diff.ts";
import type { ImageSourceLike } from "../ECR/ImageSource.ts";
import {
  flociSidecarEntry,
  makeDevWatchProvider,
} from "../Local/DevWatchProvider.ts";
import { imageSourceTrigger, restartFamilyTasks } from "./EcsDevWatch.ts";
import { Service, ServiceProvider, type ServiceProps } from "./Service.ts";

/** Cluster ARN from either form of the `cluster` prop (see ServiceProvider). */
const clusterArnOfProps = (
  cluster: ServiceProps["cluster"] | undefined,
): string | undefined =>
  typeof cluster === "string"
    ? cluster
    : typeof (cluster as { clusterArn?: unknown } | undefined)?.clusterArn ===
        "string"
      ? (cluster as { clusterArn: string }).clusterArn
      : undefined;

/** The truly-immutable post-create fields (mirrors the live diff). */
const immutableFieldsOf = (props: ServiceProps) => ({
  usesStrategy: !!props.capacityProviderStrategy,
  schedulingStrategy: props.schedulingStrategy ?? "REPLICA",
  deploymentControllerType: props.deploymentController?.type ?? "ECS",
  enableECSManagedTags: props.enableECSManagedTags ?? true,
  role: props.role,
});

/** The BYO task reference, when the props use the `task:` form. */
const taskRefOf = (props: ServiceProps) =>
  "task" in props ? props.task : undefined;

export const FlociServiceProvider = () =>
  makeDevWatchProvider<Service, ServiceProps, Service["Attributes"]>(
    Service,
    flociSidecarEntry(),
    {
      liveProvider: () => ServiceProvider(),
      watchConfigOf: (news, attrs) => {
        const source = news as ImageSourceLike;
        return {
          serviceName: attrs.serviceName,
          clusterArn: attrs.clusterArn,
          taskFamily: attrs.taskFamily,
          byoTaskDefinitionArn: taskRefOf(news)?.taskDefinitionArn,
          main: source.main,
          handler: source.handler,
          build: source.build,
          isExternal: news.isExternal,
          context: source.context,
          dockerfile: source.dockerfile,
          image: source.image,
          port: (news as { port?: number }).port,
          runtimePlatform: (news as { runtimePlatform?: unknown })
            .runtimePlatform,
        };
      },
      // Mirrors the live diff's cheap replacement rules (never building):
      // serviceName is the identity, a service can't move clusters, and the
      // immutable post-create flags replace delete-first.
      replaceOn: ({ olds, news }) =>
        Effect.sync(() => {
          if ((olds.serviceName ?? null) !== (news.serviceName ?? null)) {
            return { action: "replace" as const, deleteFirst: true };
          }
          const oldCluster = clusterArnOfProps(olds.cluster);
          const newCluster = clusterArnOfProps(news.cluster);
          if (
            oldCluster !== undefined &&
            newCluster !== undefined &&
            oldCluster !== newCluster
          ) {
            return { action: "replace" as const, deleteFirst: true };
          }
          if (!deepEqual(immutableFieldsOf(olds), immutableFieldsOf(news))) {
            return { action: "replace" as const, deleteFirst: true };
          }
          return undefined;
        }),
      // Fires on every reconcile — watcher-triggered AND engine-driven
      // (prop changes never produce a file event, so rolling only from the
      // watch loop left the service's containers on the old revision).
      onReconciled: ({ id, previous, attrs }) =>
        Effect.gen(function* () {
          if (
            attrs.taskFamily === undefined ||
            attrs.taskDefinitionArn === undefined ||
            previous?.taskDefinitionArn === attrs.taskDefinitionArn
          ) {
            return;
          }
          const startedAt = Date.now();
          // `updateService` (inside the reconcile) pointed the service at
          // the new revision, but floci's in-place swap keeps the old
          // containers running — stop them so the scheduler relaunches on
          // the new revision.
          const restarted = yield* restartFamilyTasks({
            family: attrs.taskFamily,
            nextTaskDefinitionArn: attrs.taskDefinitionArn,
            serviceManaged: true,
          });
          yield* Effect.logInfo(
            `[alchemy dev] ${attrs.serviceName}: task definition swapped (${restarted} service task(s) rolling) in ${Date.now() - startedAt}ms`,
          );
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(
              `[alchemy dev] ${id}: service roll failed`,
              cause,
            ),
          ),
        ),
      startWatch: (ctx) =>
        Effect.gen(function* () {
          if (taskRefOf(ctx.news) !== undefined) {
            // BYO task reference: the image (and its hot reload) belongs to
            // the referenced `AWS.ECS.Task` resource.
            return;
          }
          const trigger = yield* imageSourceTrigger({
            id: ctx.id,
            source: ctx.news as ImageSourceLike,
            isExternal: ctx.news.isExternal,
          });
          yield* trigger.pipe(
            // The reconcile registers the new revision and `updateService`s
            // onto it; the `onReconciled` hook (shared with engine-driven
            // updates) rolls the running tasks.
            Stream.runForEach(() =>
              ctx.rerunReconcile.pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning(
                    `[alchemy dev] ${ctx.id}: image swap failed`,
                    cause,
                  ),
                ),
              ),
            ),
          );
        }),
    },
  );
