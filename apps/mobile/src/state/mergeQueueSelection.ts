import { AsyncResult, Atom } from "effect/reactivity";
import { composerPullRequests } from "./pull-requests";
import { workspaceConnections } from "./workspace";
import { mobileMergeQueuesEnabledAtom } from "./preferences";

export type QueueScope = {
  environmentId: string;
  host?: string;
  repository: string;
  branch: string;
};
export const queuePickerOpenAtom = Atom.make(false);
export const queuePickerVisibleAtom = Atom.make(
  (get) => get(queuePickerOpenAtom) && get(mobileMergeQueuesEnabledAtom),
);
export const requestedQueueAtom = Atom.make<QueueScope | null>(null);

export const selectedQueueAtom = Atom.make((get) => {
  const requested = get(requestedQueueAtom);
  let first: QueueScope | null = null;
  for (const env of get(workspaceConnections.environmentsAtom)) {
    if (!env.isEnabled || env.connectionState !== "connected") continue;
    const result = get(
      composerPullRequests.mergeQueues({ environmentId: env.environmentId, input: {} }),
    );
    for (const project of AsyncResult.getOrElse(result, () => [])) {
      for (const queue of project.queues ?? []) {
        const scope = {
          environmentId: env.environmentId,
          host: project.host,
          repository: project.repository,
          branch: queue.branch,
        };
        if (
          requested?.environmentId === scope.environmentId &&
          requested.host === scope.host &&
          requested.repository === scope.repository &&
          requested.branch === scope.branch
        )
          return requested;
        first ??= scope;
      }
    }
  }
  return first;
});
