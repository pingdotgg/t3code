import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadProjection } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/unstable/reactivity";

import { environmentThreadDetails, useEnvironmentThread } from "./threads";
import { useThreadSelection } from "./use-thread-selection";

const EMPTY_THREAD_PROJECTION_ATOM = Atom.make<ScopedThreadProjection | null>(null).pipe(
  Atom.withLabel("mobile-thread-projection:empty"),
);

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

export function useSelectedThreadDetail() {
  return Option.getOrNull(useSelectedThreadDetailState().data);
}

export function useThreadProjection(target: ThreadDetailTarget): ScopedThreadProjection | null {
  return useAtomValue(
    target.environmentId === null || target.threadId === null
      ? EMPTY_THREAD_PROJECTION_ATOM
      : environmentThreadDetails.threadAtom({
          environmentId: target.environmentId,
          threadId: target.threadId,
        }),
  );
}

export function useSelectedThreadProjection(): ScopedThreadProjection | null {
  const { selectedThread } = useThreadSelection();
  return useThreadProjection({
    environmentId: selectedThread?.environmentId ?? null,
    threadId: selectedThread?.id ?? null,
  });
}
