import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as PlatformError from "effect/PlatformError";
import * as Semaphore from "effect/Semaphore";

export interface WorkspaceIoGateOptions {
  /** In-flight calls across all roots; keep it below libuv's pool size. */
  readonly maxInFlight: number;
  readonly timeout: Duration.Input;
}

interface Waiter {
  readonly turn: Deferred.Deferred<void, PlatformError.PlatformError>;
  granted: boolean;
}

/** Exists only while a root has a call in flight, so state never outlives the work. */
interface RootEntry {
  readonly root: string;
  busy: boolean;
  hung: boolean;
  readonly waiters: Set<Waiter>;
}

const gateError = (tag: "TimedOut" | "NotFound", path: string, description: string) =>
  PlatformError.systemError({
    _tag: tag,
    module: "FileSystem",
    method: "WorkspaceIoGate.run",
    pathOrDescriptor: path,
    description,
  });

/**
 * A call on a folder that stops answering holds a libuv thread until the kernel returns, even if
 * the fiber is interrupted. One call per root at a time; a root whose call outlives the timeout
 * fails fast until that call returns, while other roots carry on.
 */
export const makeWorkspaceIoGate = (options: WorkspaceIoGateOptions) => {
  const global = Semaphore.makeUnsafe(options.maxInFlight);
  const roots = new Map<string, RootEntry>();
  const isCurrent = (entry: RootEntry) => roots.get(entry.root) === entry;

  const passOn = (entry: RootEntry) => {
    const next = isCurrent(entry) && !entry.hung ? entry.waiters.values().next() : undefined;
    if (next !== undefined && !next.done) {
      entry.waiters.delete(next.value);
      next.value.granted = true;
      Deferred.doneUnsafe(next.value.turn, Exit.void);
      return;
    }
    entry.busy = false;
    if (isCurrent(entry) && entry.waiters.size === 0) roots.delete(entry.root);
  };

  const failWaiters = (entry: RootEntry, error: PlatformError.PlatformError) => {
    for (const waiter of entry.waiters) Deferred.doneUnsafe(waiter.turn, Exit.fail(error));
    entry.waiters.clear();
  };

  const acquireRoot = (
    root: string,
    path: string,
    restore: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>,
  ) =>
    Effect.suspend(() => {
      let entry = roots.get(root);
      if (entry === undefined) {
        entry = { root, busy: false, hung: false, waiters: new Set() };
        roots.set(root, entry);
      }
      if (entry.hung) {
        return Effect.fail(gateError("TimedOut", path, `${root} is not responding.`));
      }
      if (!entry.busy) {
        entry.busy = true;
        return Effect.succeed(entry);
      }
      const owner = entry;
      const waiter: Waiter = { turn: Deferred.makeUnsafe(), granted: false };
      owner.waiters.add(waiter);
      return restore(Deferred.await(waiter.turn)).pipe(
        Effect.as(owner),
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            owner.waiters.delete(waiter);
            // Granted the slot just as the caller gave up: hand it on.
            if (waiter.granted) passOn(owner);
          }),
        ),
      );
    });

  const run = <A, E>(
    root: string,
    path: string,
    effect: Effect.Effect<A, E>,
  ): Effect.Effect<A, E | PlatformError.PlatformError> =>
    Effect.suspend(() => {
      let inFlight: RootEntry | undefined;
      let settled = false;
      const settle = (entry: RootEntry) =>
        Effect.sync(() => {
          settled = true;
          entry.hung = false;
          passOn(entry);
        });
      const onTimeout = Effect.suspend(() => {
        const entry = inFlight;
        if (entry === undefined || settled || !isCurrent(entry) || entry.hung) {
          return Effect.fail(
            gateError("TimedOut", path, "The filesystem did not respond in time."),
          );
        }
        entry.hung = true;
        const error = gateError("TimedOut", path, `${root} is not responding.`);
        failWaiters(entry, error);
        return Effect.logWarning(
          "Project folder is not responding; background file access to it is paused",
          { root, path },
        ).pipe(Effect.andThen(Effect.fail(error)));
      });
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const entry = yield* acquireRoot(root, path, restore);
          yield* restore(Semaphore.take(global, 1)).pipe(
            Effect.onInterrupt(() => Effect.sync(() => passOn(entry))),
          );
          inFlight = entry;
          return yield* effect.pipe(
            Effect.exit,
            Effect.ensuring(Semaphore.release(global, 1).pipe(Effect.andThen(settle(entry)))),
            Effect.forkDetach,
          );
        }),
      ).pipe(
        Effect.flatMap(Fiber.join),
        Effect.flatten,
        Effect.timeoutOrElse({ duration: options.timeout, orElse: () => onTimeout }),
      );
    });

  /** Drops a removed or re-rooted project; a call still in the kernel only keeps its global slot. */
  const forget = (root: string) =>
    Effect.sync(() => {
      const entry = roots.get(root);
      if (entry === undefined) return;
      roots.delete(root);
      failWaiters(entry, gateError("NotFound", root, "The project was removed."));
    });

  return { run, forget, trackedRoots: () => roots.size };
};

const poolSize = () => {
  const size = Number(process.env.UV_THREADPOOL_SIZE);
  return Number.isInteger(size) && size > 0 ? size : 4;
};

// One per process, like the libuv pool it protects; half the pool always stays free.
export class WorkspaceIoGate extends Context.Reference<ReturnType<typeof makeWorkspaceIoGate>>(
  "t3/workspace/WorkspaceIoGate",
  {
    defaultValue: () =>
      makeWorkspaceIoGate({
        maxInFlight: Math.max(1, Math.floor(poolSize() / 2)),
        timeout: Duration.seconds(10),
      }),
  },
) {}
