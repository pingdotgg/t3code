import {
  CommandId,
  type LinearIssueLink,
  type LinearWorkflowState,
  type OrchestrationThreadShell,
  type ServerSettings as ServerSettingsType,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as LinearApi from "../../linear/LinearApi.ts";
import {
  resolveTargetStateId,
  type LinearLifecycleStage,
} from "../../linear/linearStateMapping.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as VcsStatusBroadcaster from "../../vcs/VcsStatusBroadcaster.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../Services/ProjectionSnapshotQuery.ts";
import { LinearSyncReactor } from "../Services/LinearSyncReactor.ts";

const STAGE_RANK: Record<LinearLifecycleStage, number> = { started: 1, review: 2, done: 3 };

function transitionEnabled(
  settings: ServerSettingsType["linear"],
  stage: LinearLifecycleStage,
): boolean {
  switch (stage) {
    case "started":
      return settings.transitionOnStart;
    case "review":
      return settings.transitionOnPrOpen;
    case "done":
      return settings.transitionOnMerge;
  }
}

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const linear = yield* LinearApi.LinearApi;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const snapshot = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const vcs = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
  const crypto = yield* Crypto.Crypto;

  // Highest lifecycle stage already written per Linear issue id (never regress).
  const appliedRank = new Map<string, number>();
  // Threads whose PR status we're already watching.
  const watchedThreads = new Set<string>();
  // Cache team workflow states for the process lifetime.
  const statesByTeam = new Map<string, ReadonlyArray<LinearWorkflowState>>();

  const getTeamStates = (teamId: string) =>
    statesByTeam.has(teamId)
      ? Effect.succeed(statesByTeam.get(teamId)!)
      : linear.listWorkflowStates({ teamId }).pipe(
          Effect.tap((states) => Effect.sync(() => statesByTeam.set(teamId, states))),
          Effect.catchCause((cause) =>
            Effect.logDebug("linear sync could not load workflow states", {
              teamId,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as([] as ReadonlyArray<LinearWorkflowState>)),
          ),
        );

  const reflectState = (threadId: ThreadId, issue: LinearIssueLink, state: LinearWorkflowState) =>
    crypto.randomUUIDv4.pipe(
      Effect.flatMap((uuid) =>
        engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make(uuid),
          threadId,
          linearIssue: { ...issue, stateName: state.name, stateType: state.type },
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.logDebug("linear sync could not reflect state to thread", {
          threadId,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const applyStage = (thread: OrchestrationThreadShell, stage: LinearLifecycleStage) =>
    Effect.gen(function* () {
      const issue = thread.linearIssue;
      if (issue === null || issue === undefined) return;
      const teamId = issue.teamId;
      if (teamId === undefined) return;

      const settings = (yield* settingsService.getSettings).linear;
      if (!settings.autoSync || !transitionEnabled(settings, stage)) return;

      const rank = STAGE_RANK[stage];
      if ((appliedRank.get(issue.id) ?? 0) >= rank) return;

      const states = yield* getTeamStates(teamId);
      const stateId = resolveTargetStateId(states, settings.stateMappingByTeam[teamId], stage);
      if (stateId === undefined) return;

      const result = yield* linear.updateIssueState({ issueId: issue.id, stateId });
      if (!result.success) return;

      if (stage === "started" && settings.postComments) {
        yield* linear
          .createComment({
            issueId: issue.id,
            body: `T3 Code started working on this issue in thread “${thread.title}”.`,
          })
          .pipe(Effect.ignore);
      }

      const nextState = states.find((state) => state.id === stateId);
      if (nextState !== undefined) {
        yield* reflectState(thread.id, issue, nextState);
      }
      // Mark applied only after the write + best-effort badge reflect, so a
      // failed issueUpdate can be retried on the next signal.
      appliedRank.set(issue.id, rank);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("linear sync failed to apply stage", {
          threadId: thread.id,
          stage,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const watchPullRequest = (thread: OrchestrationThreadShell) =>
    Effect.gen(function* () {
      const worktreePath = thread.worktreePath;
      if (worktreePath === null || thread.linearIssue == null) return;
      // Key by worktree so a thread that later moves/creates its worktree gets
      // a fresh watcher instead of being ignored on the stale path.
      const watchKey = `${thread.id}:${worktreePath}`;
      if (watchedThreads.has(watchKey)) return;
      watchedThreads.add(watchKey);

      yield* Effect.forkScoped(
        Stream.runForEach(vcs.streamStatus({ cwd: worktreePath }), (event) => {
          const remote = event._tag === "localUpdated" ? null : event.remote;
          const pr = remote?.pr ?? null;
          if (pr === null) return Effect.void;
          if (pr.state === "open") return applyStage(thread, "review");
          if (pr.state === "merged") return applyStage(thread, "done");
          return Effect.void;
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logDebug("linear sync PR watcher stopped", {
              threadId: thread.id,
              cause: Cause.pretty(cause),
            }),
          ),
        ),
      );
    });

  const onThreadActivity = (threadId: ThreadId, markStarted: boolean) =>
    snapshot.getThreadShellById(threadId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.void,
          onSome: (thread) =>
            thread.linearIssue == null
              ? Effect.void
              : watchPullRequest(thread).pipe(
                  Effect.andThen(markStarted ? applyStage(thread, "started") : Effect.void),
                ),
        }),
      ),
      Effect.catchCause(() => Effect.void),
    );

  const start: LinearSyncReactor["Service"]["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(engine.streamDomainEvents, (event) => {
        switch (event.type) {
          case "thread.turn-start-requested":
            return onThreadActivity(event.payload.threadId, true);
          case "thread.created":
          case "thread.meta-updated":
            return onThreadActivity(event.payload.threadId, false);
          default:
            return Effect.void;
        }
      }),
    );
  });

  return { start } satisfies LinearSyncReactor["Service"];
});

export const LinearSyncReactorLive = Layer.effect(LinearSyncReactor, make);
