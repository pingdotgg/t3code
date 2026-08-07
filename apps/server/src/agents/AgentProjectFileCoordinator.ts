/** Serialize project-file read/modify/write transactions per workspace. */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

export class AgentProjectFileCoordinator extends Context.Service<
  AgentProjectFileCoordinator,
  {
    readonly withWorkspaceLock: <A, E, R>(
      workspaceRoot: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
  }
>()("t3/agents/AgentProjectFileCoordinator") {}

export const make = Effect.gen(function* () {
  const mapMutex = yield* Semaphore.make(1);
  const locks = new Map<string, Semaphore.Semaphore>();

  const lockFor = Effect.fn("AgentProjectFileCoordinator.lockFor")(function* (
    workspaceRoot: string,
  ) {
    return yield* mapMutex.withPermits(1)(
      Effect.gen(function* () {
        const existing = locks.get(workspaceRoot);
        if (existing) return existing;
        const lock = yield* Semaphore.make(1);
        locks.set(workspaceRoot, lock);
        return lock;
      }),
    );
  });

  const withWorkspaceLock: AgentProjectFileCoordinator["Service"]["withWorkspaceLock"] = (
    workspaceRoot,
    effect,
  ) => lockFor(workspaceRoot).pipe(Effect.flatMap((lock) => lock.withPermits(1)(effect)));

  return AgentProjectFileCoordinator.of({ withWorkspaceLock });
});

export const layer = Layer.effect(AgentProjectFileCoordinator, make);
