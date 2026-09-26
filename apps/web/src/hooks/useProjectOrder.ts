import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { useCallback } from "react";
import { create } from "zustand";
import { toastManager } from "../components/ui/toast";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";

const EMPTY_ORDER: readonly string[] = [];

// A reorder shows immediately and holds while the owning server still has an
// order it was built on: the order before the drag, or an earlier drag in the
// same chain whose save landed first. Any other server order (our final
// broadcast, or another client's) replaces it, as does a failed save. Compared
// by content: every settings broadcast decodes a fresh array.
interface PendingOrder {
  readonly environmentId: string;
  readonly order: readonly string[];
  readonly bases: readonly (readonly string[] | null)[];
}
const usePendingOrder = create<{ pending: PendingOrder | null }>(() => ({ pending: null }));

/** Moves the dragged keys to the target's position, or returns null for a no-op. */
export function reorderProjectKeys(
  currentOrder: readonly string[],
  draggedKeys: readonly string[],
  targetKeys: readonly string[],
): string[] | null {
  const draggedSet = new Set(draggedKeys);
  const targetSet = new Set(targetKeys);
  if (draggedKeys.every((key) => targetSet.has(key))) {
    return null;
  }
  const originalTargetIndex = currentOrder.findIndex((key) => targetSet.has(key));
  if (originalTargetIndex < 0) {
    return null;
  }

  const order = [...currentOrder];
  const removed: string[] = [];
  let draggedBeforeTarget = 0;
  for (let i = order.length - 1; i >= 0; i--) {
    if (draggedSet.has(order[i]!)) {
      removed.unshift(order.splice(i, 1)[0]!);
      if (i < originalTargetIndex) {
        draggedBeforeTarget++;
      }
    }
  }
  if (removed.length === 0) {
    return null;
  }

  order.splice(originalTargetIndex - Math.max(0, draggedBeforeTarget - 1), 0, ...removed);
  return order;
}

/**
 * Keeps keys missing from `next` (projects this client cannot see, such as a
 * server still loading) after the key they followed in `previous`, so a
 * reorder never drops another environment's placement.
 */
function keepUnseenKeys(next: readonly string[], previous: readonly string[]): string[] {
  const seen = new Set(next);
  const unseenAfter = new Map<string | null, string[]>();
  let anchor: string | null = null;
  for (const key of previous) {
    if (seen.has(key)) {
      anchor = key;
    } else {
      unseenAfter.set(anchor, [...(unseenAfter.get(anchor) ?? []), key]);
    }
  }
  return [
    ...(unseenAfter.get(null) ?? []),
    ...next.flatMap((key) => [key, ...(unseenAfter.get(key) ?? [])]),
  ];
}

function sameOrder(a: readonly string[] | null, b: readonly string[] | null) {
  return a === b || (!!a && !!b && a.length === b.length && a.every((key, i) => key === b[i]));
}

function useProjectOrderEnvironment() {
  const { environments } = useEnvironments();
  const primaryId = usePrimaryEnvironmentId();
  // Hosted clients have no primary. Choose consistently, including disconnected
  // environments, so a temporary outage cannot change which server owns the order.
  return primaryId !== null
    ? environments.find((environment) => environment.environmentId === primaryId)
    : environments.toSorted((a, b) => (a.environmentId < b.environmentId ? -1 : 1))[0];
}

export function useProjectOrder(): readonly string[] {
  const environment = useProjectOrderEnvironment();
  const server = environment?.serverConfig?.settings.sidebarProjectOrder ?? null;
  const pending = usePendingOrder((state) => state.pending);
  if (
    pending &&
    pending.environmentId === environment?.environmentId &&
    pending.bases.some((base) => sameOrder(base, server))
  ) {
    return pending.order;
  }
  return server ?? EMPTY_ORDER;
}

export function useReorderProjects() {
  const environment = useProjectOrderEnvironment();
  const persist = useAtomCommand(serverEnvironment.updateSettings, "save project order");
  return useCallback(
    async (
      currentOrder: readonly string[],
      draggedKeys: readonly string[],
      targetKeys: readonly string[],
    ) => {
      const reordered = reorderProjectKeys(currentOrder, draggedKeys, targetKeys);
      if (!reordered || !environment) return;
      const server = environment.serverConfig?.settings.sidebarProjectOrder ?? null;
      const previous = usePendingOrder.getState().pending;
      const chained =
        previous?.environmentId === environment.environmentId &&
        previous.bases.some((base) => sameOrder(base, server));
      const order = keepUnseenKeys(reordered, chained ? previous.order : (server ?? []));
      const pending = {
        environmentId: environment.environmentId,
        order,
        bases: chained ? [...previous.bases, previous.order] : [server],
      };
      usePendingOrder.setState({ pending });
      const result = await persist({
        environmentId: environment.environmentId,
        input: { patch: { sidebarProjectOrder: order } },
      });
      if (AsyncResult.isSuccess(result)) return;
      if (usePendingOrder.getState().pending === pending) {
        usePendingOrder.setState({ pending: null });
      }
      toastManager.add({
        type: "warning",
        title: "Project order could not be saved",
        description: "Reconnect to the server and try again.",
      });
    },
    [environment, persist],
  );
}
