import { CommandId, type GitManagerServiceError } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { GitManager } from "../../git/GitManager.ts";
import { PullRequestService, type PullRequestError } from "../../pullRequest/PullRequestService.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { forkParked } from "../../serverActivation.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ThreadSettlementReactor,
  type ThreadSettlementReactorShape,
} from "../Services/ThreadSettlementReactor.ts";
import {
  isAutoSettlementCandidate,
  shouldAutoSettleThread,
  type SettlementPullRequest,
} from "../ThreadSettlementPolicy.ts";

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const settingsService = yield* ServerSettingsService;
  const git = yield* GitManager;
  const pullRequests = yield* PullRequestService;
  const crypto = yield* Crypto.Crypto;

  const sweep = Effect.fn("ThreadSettlementReactor.sweep")(function* () {
    const snapshot = yield* snapshots.getShellSnapshot();
    const now = DateTime.formatIso(yield* DateTime.now);
    const projects = new Map(snapshot.projects.map((project) => [project.id, project]));
    const candidates = snapshot.threads.filter((thread) => isAutoSettlementCandidate(thread, now));
    const lookupByKey = new Map<
      string,
      Effect.Effect<SettlementPullRequest | null, GitManagerServiceError | PullRequestError>
    >();

    const pullRequestFor = Effect.fn("ThreadSettlementReactor.pullRequestFor")(function* (
      thread: (typeof candidates)[number],
    ) {
      const project = projects.get(thread.projectId);
      if (project === undefined) return null;
      if (thread.linkedPullRequest != null) {
        const linkedProject = projects.get(thread.linkedPullRequest.projectId);
        if (linkedProject === undefined) {
          return yield* Effect.die(new Error("linked pull request project not found"));
        }
        const key = `linked:${thread.linkedPullRequest.projectId}:${thread.linkedPullRequest.repository}:${thread.linkedPullRequest.number}`;
        let lookup = lookupByKey.get(key);
        if (lookup === undefined) {
          lookup = yield* Effect.cached(
            pullRequests
              .detail({
                projectId: thread.linkedPullRequest.projectId,
                repository: thread.linkedPullRequest.repository,
                number: thread.linkedPullRequest.number,
              })
              .pipe(Effect.map((detail) => ({ state: detail.state, updatedAt: detail.updatedAt }))),
          );
          lookupByKey.set(key, lookup);
        }
        return yield* lookup;
      }
      if (thread.branch === null) return null;
      const cwd = project.workspaceRoot;
      const key = `branch:${cwd}:${thread.branch}`;
      let lookup = lookupByKey.get(key);
      if (lookup === undefined) {
        lookup = yield* Effect.cached(git.branchPullRequest({ cwd, branch: thread.branch }));
        lookupByKey.set(key, lookup);
      }
      return yield* lookup;
    });

    yield* Effect.forEach(
      candidates,
      (thread) =>
        Effect.gen(function* () {
          const pullRequest = yield* pullRequestFor(thread);
          const settings = yield* settingsService.getSettings;
          const decisionNow = DateTime.formatIso(yield* DateTime.now);
          if (
            !shouldAutoSettleThread({
              thread,
              pullRequest,
              now: decisionNow,
              autoSettleAfterDays: settings.sidebarAutoSettleAfterDays,
              autoSettleOnMerge: settings.sidebarAutoSettleOnMerge,
            })
          ) {
            return;
          }
          const uuid = yield* crypto.randomUUIDv4;
          yield* engine.dispatch({
            type: "thread.auto-settle",
            commandId: CommandId.make(`server:auto-settle:${thread.id}:${uuid}`),
            threadId: thread.id,
            expectedUpdatedAt: thread.updatedAt,
          });
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("automatic thread settlement skipped", {
                  threadId: thread.id,
                  cause: Cause.pretty(cause),
                }),
          ),
        ),
      { concurrency: 8, discard: true },
    );
  });

  const worker = yield* makeDrainableWorker(() =>
    sweep().pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("automatic thread settlement sweep failed", {
              cause: Cause.pretty(cause),
            }),
      ),
    ),
  );

  const start: ThreadSettlementReactorShape["start"] = Effect.fn("ThreadSettlementReactor.start")(
    function* () {
      const settingsChanges = yield* settingsService.subscribeChanges;
      const initialSettings = yield* settingsService.getSettings.pipe(Effect.orDie);
      let lastAfterDays = initialSettings.sidebarAutoSettleAfterDays;
      let lastOnMerge = initialSettings.sidebarAutoSettleOnMerge;
      yield* forkParked(
        Effect.gen(function* () {
          yield* worker.enqueue(undefined);
          yield* worker.drain;
        }).pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.asVoid),
      );
      yield* forkParked(
        Stream.runForEach(settingsChanges, (settings) => {
          if (
            settings.sidebarAutoSettleAfterDays === lastAfterDays &&
            settings.sidebarAutoSettleOnMerge === lastOnMerge
          ) {
            return Effect.void;
          }
          lastAfterDays = settings.sidebarAutoSettleAfterDays;
          lastOnMerge = settings.sidebarAutoSettleOnMerge;
          return worker.enqueue(undefined);
        }),
      );
    },
  );

  return { start, drain: worker.drain } satisfies ThreadSettlementReactorShape;
});

export const ThreadSettlementReactorLive = Layer.effect(ThreadSettlementReactor, make);
