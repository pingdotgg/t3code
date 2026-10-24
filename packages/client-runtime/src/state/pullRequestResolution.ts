import type { EnvironmentId, PullRequestActivity, PullRequestRef } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import type { AtomCommand } from "./runtime.ts";

type Target = {
  readonly environmentId: EnvironmentId;
  readonly input: PullRequestRef;
};
type ResolutionTarget = Target & {
  readonly input: PullRequestRef & { readonly threadId: string; readonly resolved: boolean };
};
interface ResolutionUpdate {
  readonly threadId: string;
  readonly resolved: boolean;
  accepted: boolean;
  unsubscribe?: (() => void) | undefined;
}

/** The host read is shared by every review surface, so its pending edits are shared too. */
export function createOptimisticPullRequestResolution<E>(
  sourceActivity: (target: Target) => Atom.Atom<AsyncResult.AsyncResult<PullRequestActivity, E>>,
) {
  const pendingFamily = Atom.family((_key: string) =>
    Atom.make<ReadonlyArray<ResolutionUpdate>>([]).pipe(Atom.keepAlive),
  );
  const pendingFor = ({ environmentId, input }: Target) =>
    pendingFamily(
      JSON.stringify([
        environmentId,
        input.projectId,
        input.host ?? "",
        input.repository.toLowerCase(),
        input.number,
      ]),
    );
  const project = Atom.family((source: ReturnType<typeof sourceActivity>) =>
    Atom.family((pending: ReturnType<typeof pendingFor>) =>
      Atom.readable(
        (get) => {
          const result = get(source);
          const updates = get(pending);
          if (updates.length === 0) return result;
          const resolutions = new Map(updates.map((update) => [update.threadId, update.resolved]));
          return AsyncResult.map(result, (activity) => ({
            ...activity,
            reviewThreads: activity.reviewThreads.map((thread) => {
              const resolved = resolutions.get(thread.id);
              return resolved === undefined || resolved === thread.isResolved
                ? thread
                : { ...thread, isResolved: resolved };
            }),
          }));
        },
        (refresh) => refresh(source),
      ),
    ),
  );

  function wrap<W extends ResolutionTarget, A, CommandError>(
    command: AtomCommand<W, A, CommandError>,
  ): typeof command {
    return {
      ...command,
      run: async (registry, target) => {
        const pending = pendingFor(target);
        const source = sourceActivity(target);
        const update: ResolutionUpdate = {
          threadId: target.input.threadId,
          resolved: target.input.resolved,
          accepted: false,
        };
        const remove = () => {
          registry.update(pending, (updates) => updates.filter((entry) => entry !== update));
          update.unsubscribe?.();
        };
        // Before dispatch or waiting for the serial lane: no network latency reaches the card.
        registry.update(pending, (updates) => [...updates, update]);
        let accepted = false;
        try {
          const result = await command.run(registry, target);
          if (result._tag === "Success") {
            accepted = true;
            update.accepted = true;
            // Keep the accepted state until a fresh host read agrees. Clearing it immediately
            // would briefly restore the old state while the mutation's refresh is in flight.
            registry.refresh(source);
            const reconcile = (result: AsyncResult.AsyncResult<PullRequestActivity, E>) => {
              if (result._tag !== "Success" || result.waiting) return;
              const thread = result.value.reviewThreads.find(
                (thread) => thread.id === update.threadId,
              );
              if (thread && thread.isResolved !== update.resolved) return;
              const updates = registry.get(pending);
              const index = updates.indexOf(update);
              if (index < 0) return;
              // A later accepted reversal supersedes earlier accepted edits even when the host
              // never returned their intermediate state. Pending edits still need their rollback
              // predecessor, so neither they nor any later intent is retired here.
              const retired = new Set(
                updates.filter(
                  (entry, position) =>
                    entry === update ||
                    (position < index && entry.threadId === update.threadId && entry.accepted),
                ),
              );
              registry.update(pending, (current) => current.filter((entry) => !retired.has(entry)));
              for (const entry of retired) entry.unsubscribe?.();
            };
            update.unsubscribe = registry.subscribe(source, reconcile);
            reconcile(registry.get(source));
          }
          return result;
        } finally {
          // Remove only this intent. An older failure cannot roll back a newer selection.
          if (!accepted) remove();
        }
      },
    };
  }

  return {
    activity: (target: Target) => project(sourceActivity(target))(pendingFor(target)),
    wrap,
  };
}
