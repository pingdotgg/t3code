import {
  CommandId,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type VcsStatusResult,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import { resolveThreadWorkspaceCwd } from "../checkpointing/Utils.ts";
import { forkParked } from "../serverActivation.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { VcsStatusBroadcaster } from "../vcs/VcsStatusBroadcaster.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import {
  type AutomaticSettlementChangeRequestState,
  resolveAutomaticSettlementVerdict,
} from "./threadSettlement.ts";

const RECONCILE_INTERVAL = Duration.minutes(1);
const PR_VERIFY_COOLDOWN_MS = Duration.toMillis(Duration.minutes(30));
const MAX_PR_VERIFICATIONS_PER_RECONCILE = 5;

export class ThreadSettlementReactor extends Context.Service<
  ThreadSettlementReactor,
  {
    /** Start the persisted inactivity and merged-PR settlement lifecycle. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;

    /** Resolves when all automatic settlement work already queued is complete. */
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/ThreadSettlementReactor") {}

function workspaceCwd(
  thread: Pick<OrchestrationThreadShell, "projectId" | "worktreePath">,
  projects: ReadonlyArray<OrchestrationProjectShell>,
): string | undefined {
  return resolveThreadWorkspaceCwd({ thread, projects });
}

function cachedChangeRequestState(
  thread: Pick<OrchestrationThreadShell, "branch">,
  status: VcsStatusResult | null,
): AutomaticSettlementChangeRequestState {
  if (thread.branch === null) return null;
  if (status === null || status.refName !== thread.branch) return "unknown";
  if (status.pr === null || status.pr.headRef !== thread.branch) return "unknown";
  if (status.pr.state === "open") return "open-cached";
  if (status.pr.state === "closed") return "closed-cached";
  return "merged";
}

function liveChangeRequestState(
  thread: Pick<OrchestrationThreadShell, "branch">,
  status: VcsStatusResult,
): AutomaticSettlementChangeRequestState {
  if (thread.branch === null) return null;
  if (status.refName !== thread.branch || status.pr?.headRef !== thread.branch) return "unknown";
  return status.pr.state;
}

export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const serverSettings = yield* ServerSettingsService;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;
  const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
  const lastPrVerifyAtByCwd = yield* Ref.make(new Map<string, number>());

  const dispatchSettlement = Effect.fn("ThreadSettlementReactor.dispatchSettlement")(function* (
    thread: OrchestrationThreadShell,
    reason: "inactivity" | "pr-merged",
  ) {
    const commandId = CommandId.make(
      `server:thread-auto-settle:${reason}:${yield* crypto.randomUUIDv4}`,
    );
    yield* orchestrationEngine.dispatch({
      type: "thread.settle",
      commandId,
      threadId: thread.id,
    });
  });

  const dispatchSettlementSafely = (
    thread: OrchestrationThreadShell,
    reason: "inactivity" | "pr-merged",
  ) =>
    dispatchSettlement(thread, reason).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
        return Effect.logDebug("automatic thread settlement skipped after a raced state change", {
          threadId: thread.id,
          reason,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const verifyChangeRequestState = Effect.fn("ThreadSettlementReactor.verifyChangeRequestState")(
    function* (input: {
      readonly thread: OrchestrationThreadShell;
      readonly cwd: string;
    }): Effect.fn.Return<{
      readonly state: AutomaticSettlementChangeRequestState;
      readonly verified: boolean;
    }> {
      const now = yield* Clock.currentTimeMillis;
      const mayVerify = yield* Ref.modify(lastPrVerifyAtByCwd, (byCwd) => {
        const lastAt = byCwd.get(input.cwd);
        if (lastAt !== undefined && now - lastAt < PR_VERIFY_COOLDOWN_MS) {
          return [false, byCwd] as const;
        }
        const next = new Map(byCwd);
        next.set(input.cwd, now);
        return [true, next] as const;
      });
      if (!mayVerify) return { state: "unknown", verified: false };

      const status = yield* vcsStatusBroadcaster.pollStatus(input.cwd).pipe(
        Effect.catch((error) =>
          Effect.logDebug("automatic thread settlement could not verify change request state", {
            threadId: input.thread.id,
            cwdLength: input.cwd.length,
            errorTag: error._tag,
          }).pipe(Effect.as(null)),
        ),
      );
      return status === null
        ? { state: "unknown", verified: true }
        : { state: liveChangeRequestState(input.thread, status), verified: true };
    },
  );

  const reconcile = Effect.fn("ThreadSettlementReactor.reconcile")(function* () {
    const [snapshot, settings, now, mayVerifyPr] = yield* Effect.all([
      projectionSnapshotQuery.getShellSnapshot(),
      serverSettings.getSettings,
      DateTime.now,
      backgroundPolicy.shouldRunOpportunisticWork,
    ]);
    const nowIso = DateTime.formatIso(now);
    let verifyBudget = MAX_PR_VERIFICATIONS_PER_RECONCILE;

    for (const thread of snapshot.threads) {
      const cwd = workspaceCwd(thread, snapshot.projects);
      const changeRequestState =
        thread.branch === null
          ? null
          : cwd === undefined
            ? "unknown"
            : cachedChangeRequestState(thread, yield* vcsStatusBroadcaster.peekStatus({ cwd }));
      const verdict = resolveAutomaticSettlementVerdict(thread, {
        now: nowIso,
        autoSettleAfterDays: settings.threadAutoSettleAfterDays,
        autoSettleOnMerge: settings.threadAutoSettleOnMerge,
        changeRequestState,
      });
      if (verdict.kind === "skip") continue;
      if (verdict.kind === "settle") {
        yield* dispatchSettlementSafely(thread, verdict.reason);
        continue;
      }
      if (!mayVerifyPr || cwd === undefined || verifyBudget <= 0) continue;

      const verification = yield* verifyChangeRequestState({ thread, cwd });
      if (verification.verified) verifyBudget -= 1;
      const verifiedVerdict = resolveAutomaticSettlementVerdict(thread, {
        now: nowIso,
        autoSettleAfterDays: settings.threadAutoSettleAfterDays,
        autoSettleOnMerge: settings.threadAutoSettleOnMerge,
        changeRequestState: verification.state,
      });
      if (verifiedVerdict.kind === "settle") {
        yield* dispatchSettlementSafely(thread, verifiedVerdict.reason);
      }
    }
  });

  const reconcileSafely = reconcile().pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
      return Effect.logWarning("thread settlement reactor failed to reconcile", {
        cause: Cause.pretty(cause),
      });
    }),
  );

  const worker = yield* makeDrainableWorker((_input: void) => reconcileSafely);

  const start: ThreadSettlementReactor["Service"]["start"] = Effect.fn(
    "ThreadSettlementReactor.start",
  )(function* () {
    yield* forkParked(
      Stream.runForEach(serverSettings.streamChanges, () => worker.enqueue(undefined)),
    );
    yield* worker.enqueue(undefined);
    yield* forkParked(
      Effect.sleep(RECONCILE_INTERVAL).pipe(
        Effect.andThen(worker.enqueue(undefined)),
        Effect.forever,
      ),
    );
  });

  return ThreadSettlementReactor.of({
    start,
    drain: worker.drain,
  });
});

export const layer = Layer.effect(ThreadSettlementReactor, make);
