import { isOrchestrationV2WorkActive, type ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";

// Agents finish tools in bursts, and each refresh runs git status on the checkout.
const REFRESH_DELAY = "1 second";

export class VcsStatusTurnReactor extends Context.Service<
  VcsStatusTurnReactor,
  { readonly start: () => Effect.Effect<void, never, Scope.Scope> }
>()("t3/orchestration-v2/VcsStatusTurnReactor") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const vcsStatus = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
  const refreshes = yield* FiberMap.make<string>();
  // Keyed by checkout, since threads can share one. The value is whether HEAD may have moved.
  const dirty = new Map<string, boolean>();

  const resolveCwd = Effect.fn("VcsStatusTurnReactor.resolveCwd")(function* (threadId: ThreadId) {
    const thread = yield* projections.getThreadShell(threadId);
    if (thread === null) return undefined;
    return (
      thread.worktreePath ??
      Option.getOrUndefined(yield* projects.get(thread.projectId))?.workspaceRoot
    );
  });

  const logSkipped = (message: string) => (cause: Cause.Cause<unknown>) =>
    Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logWarning(message, { cause });

  // One loop per checkout, so refreshes never overlap and a slow repo slows its own cadence.
  const schedule = (cwd: string, includeDivergence: boolean) =>
    Effect.suspend(() => {
      dirty.set(cwd, includeDivergence || dirty.get(cwd) === true);
      return Effect.sleep(REFRESH_DELAY).pipe(
        Effect.andThen(
          Effect.suspend(() => {
            const includeDivergence = dirty.get(cwd) === true;
            dirty.delete(cwd);
            return vcsStatus.refreshWatchedStatus(cwd, { includeDivergence });
          }),
        ),
        Effect.catchCause(logSkipped("failed to refresh git status during a turn")),
        Effect.repeat({ while: () => dirty.has(cwd) }),
        FiberMap.run(refreshes, cwd, { onlyIfMissing: true }),
        Effect.asVoid,
      );
    });

  const start: VcsStatusTurnReactor["Service"]["start"] = Effect.fn("VcsStatusTurnReactor.start")(
    function* () {
      yield* forkParked(
        Stream.runForEach(engine.streamDomainEvents, (event) => {
          if (event.type !== "turn-item.updated") return Effect.void;
          const item = event.payload;
          if (item.type !== "file_change" && item.type !== "command_execution") return Effect.void;
          if (isOrchestrationV2WorkActive(item.status)) return Effect.void;
          return resolveCwd(item.threadId).pipe(
            Effect.flatMap((cwd) =>
              cwd === undefined ? Effect.void : schedule(cwd, item.type === "command_execution"),
            ),
            Effect.catchCause(logSkipped("failed to resolve a thread's checkout")),
          );
        }).pipe(Effect.catchCause(logSkipped("git status turn event stream failed"))),
      );
    },
  );

  return { start } satisfies VcsStatusTurnReactor["Service"];
});

export const layer = Layer.effect(VcsStatusTurnReactor, make);
