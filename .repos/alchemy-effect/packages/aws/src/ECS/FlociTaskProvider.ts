/** @effect-diagnostics anyUnknownInErrorContext:off */

/**
 * The `alchemy dev` provider for `AWS.ECS.Task`: deploys the task
 * definition (image, roles, log group, ECR repository) into the floci
 * emulator and hot-swaps running tasks on file change.
 *
 * Built on the shared dev-watch skeleton
 * ([DevWatchProvider](../Local/DevWatchProvider.ts)); this file supplies
 * only the Task-specific parts:
 *
 * - **Watch triggers** by image source ({@link imageSourceTrigger}):
 *   `main` re-uses the deploy's exact rolldown module graph via
 *   `Bundle.watch`; `context` fs-watches the Docker build context;
 *   registry `image` refs have nothing local to watch.
 * - **Swap mechanism** — every trigger re-runs the LIVE reconcile against
 *   the emulator: the image pipeline is content-addressed, so a real change
 *   builds and pushes a NEW `<repositoryUri>:<hash>` tag and registers a
 *   new task definition revision (an unchanged hash is a cheap no-op).
 * - **Task restart** lives in the skeleton's `onReconciled` hook — NOT in
 *   the watch loop — so it also fires for engine-driven reconciles.
 *   Prop-only changes (an inline `dockerfile` edit, a new env var) never
 *   produce a file event: before the hook, they registered a new revision
 *   and running tasks kept serving the old one until the next source edit.
 *   RUNNING standalone tasks of the family (launched via `RunTask`) are
 *   stopped and re-run on the new revision — service-managed tasks belong
 *   to [FlociServiceProvider](./FlociServiceProvider.ts).
 */

import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { makeImageSource, type ImageSourceLike } from "../ECR/ImageSource.ts";
import { flociProvidersUrl, makeDevWatchProvider } from "../Local/DevWatchProvider.ts";
import { imageSourceTrigger, restartFamilyTasks } from "./EcsDevWatch.ts";
import { Task, TaskProvider, taskImageInput, type TaskProps } from "./Task.ts";

export const FlociTaskProvider = () =>
  makeDevWatchProvider<Task, TaskProps, Task["Attributes"]>(Task, flociProvidersUrl(), {
    liveProvider: () => TaskProvider(),
    // The restart surface of the watch loop: everything that changes WHAT
    // the watcher builds or WHERE it publishes/runs.
    watchConfigOf: (news, attrs) => {
      const source = news as ImageSourceLike;
      return {
        family: attrs.taskFamily,
        repositoryName: attrs.repositoryName,
        main: source.main,
        handler: source.handler,
        // Secrets stay out, as in the image hash: rotating one does not rebuild.
        build: source.build === undefined ? undefined : { ...source.build, secrets: undefined },
        isExternal: news.isExternal,
        context: source.context,
        dockerfile: source.dockerfile,
        image: source.image,
        port: news.port,
        runtimePlatform: news.runtimePlatform,
      };
    },
    // Mirrors the live diff's replacement rule: the family (taskName, or
    // the id-derived generated name) is the identity.
    replaceOn: ({ olds, news }) =>
      Effect.sync(() =>
        (olds.taskName ?? null) !== (news.taskName ?? null)
          ? { action: "replace" as const }
          : undefined,
      ),
    // Fires on every reconcile — watcher-triggered AND engine-driven
    // (prop changes never produce a file event, so restarting only from
    // the watch loop left running tasks on the old revision).
    onReconciled: ({ previous, attrs }) =>
      Effect.gen(function* () {
        if (previous?.taskDefinitionArn === attrs.taskDefinitionArn) return;
        const startedAt = Date.now();
        const restarted = yield* restartFamilyTasks({
          family: attrs.taskFamily,
          nextTaskDefinitionArn: attrs.taskDefinitionArn,
          serviceManaged: false,
        });
        yield* Effect.logInfo(
          `task definition swapped (${restarted} task(s) restarted) in ${Date.now() - startedAt}ms`,
        );
      }).pipe(Effect.catchCause((cause) => Effect.logWarning(`task restart failed`, cause))),
    startWatch: (ctx) =>
      Effect.gen(function* () {
        const imageSource = yield* makeImageSource;
        const trigger = yield* imageSourceTrigger({
          id: ctx.id,
          source: ctx.news as ImageSourceLike,
          isExternal: ctx.news.isExternal,
        });
        yield* trigger.pipe(
          // The reconcile registers the new revision; the `onReconciled`
          // hook (shared with engine-driven updates) restarts the tasks.
          Stream.runForEach(() =>
            // The staleness check runs under the per-id lock: an engine
            // reconcile holding the lock may publish exactly this content
            // first, and a pre-lock check against the older attrs would
            // still re-register and reap the revision the engine recorded.
            ctx
              .rerunReconcileIfStale((current) =>
                Effect.gen(function* () {
                  const hash = yield* imageSource.hash(taskImageInput(ctx.news));
                  // Bundle.watch emits its initial build too. Re-registering
                  // unchanged content would delete the ARN just returned by
                  // deploy before callers can launch a task with it.
                  return hash === undefined || hash !== current.code.hash;
                }),
              )
              .pipe(Effect.catchCause((cause) => Effect.logWarning(`image swap failed`, cause))),
          ),
        );
      }),
  });
