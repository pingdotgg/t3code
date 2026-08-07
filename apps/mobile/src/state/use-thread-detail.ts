import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThread } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, OrchestrationV2ThreadProjection, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { environmentThreadDetails, useEnvironmentThread } from "./threads";
import { useThreadSelection } from "./use-thread-selection";

const EMPTY_THREAD_PROJECTION_ATOM = Atom.make<EnvironmentThread | null>(null).pipe(
  Atom.withLabel("mobile-thread-projection:empty"),
);
const EMPTY_VISIBLE_TURN_ITEMS_ATOM = Atom.make<
  OrchestrationV2ThreadProjection["visibleTurnItems"]
>(Object.freeze([])).pipe(Atom.withLabel("mobile-thread-visible-turn-items:empty"));

export interface ThreadDetailTarget {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
}

export function useThreadDetail(target: ThreadDetailTarget) {
  return useEnvironmentThread(target.environmentId, target.threadId);
}

export function useSelectedThreadDetailState() {
  const { selectedThread } = useThreadSelection();
  return useThreadDetail({
    environmentId: selectedThread?.environmentId ?? null,
    threadId: selectedThread?.id ?? null,
  });
}

export function useThreadProjection(target: ThreadDetailTarget): EnvironmentThread | null {
  return useAtomValue(
    target.environmentId === null || target.threadId === null
      ? EMPTY_THREAD_PROJECTION_ATOM
      : environmentThreadDetails.threadAtom({
          environmentId: target.environmentId,
          threadId: target.threadId,
        }),
  );
}

export function useSelectedThreadProjection(): EnvironmentThread | null {
  const { selectedThread } = useThreadSelection();
  return useThreadProjection({
    environmentId: selectedThread?.environmentId ?? null,
    threadId: selectedThread?.id ?? null,
  });
}

export function useThreadVisibleTurnItems(
  target: ThreadDetailTarget,
): OrchestrationV2ThreadProjection["visibleTurnItems"] {
  return useAtomValue(
    target.environmentId === null || target.threadId === null
      ? EMPTY_VISIBLE_TURN_ITEMS_ATOM
      : environmentThreadDetails.visibleTurnItemsAtom({
          environmentId: target.environmentId,
          threadId: target.threadId,
        }),
  );
}

export function useSelectedThreadVisibleTurnItems(): OrchestrationV2ThreadProjection["visibleTurnItems"] {
  const { selectedThread } = useThreadSelection();
  return useThreadVisibleTurnItems({
    environmentId: selectedThread?.environmentId ?? null,
    threadId: selectedThread?.id ?? null,
  });
}
