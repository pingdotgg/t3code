import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { request } from "@t3tools/client-runtime/rpc";
import { createEnvironmentQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/shell";
import {
  ORCHESTRATION_V2_WS_METHODS,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { connectionAtomRuntime } from "./connection/runtime";
import { appAtomRegistry } from "./rpc/atomRegistry";
import { environmentPresentations } from "./state/presentation";
import { environmentThreadShells } from "./state/threads";

export type ThreadReferenceHighlightRole = "target" | "related" | null;
type ThreadRuntime = Parameters<typeof threadRuntimeIsActive>[0];

export interface ActiveThreadReferences {
  readonly hovered: ScopedThreadRef | null;
  readonly pinned: ReadonlyArray<ScopedThreadRef>;
}

export interface ThreadReferenceMatches {
  readonly mentions: ReadonlySet<string>;
  readonly waits: ReadonlySet<string>;
  readonly unavailable: number;
  readonly pending: boolean;
}

export interface ThreadReferenceHighlight {
  readonly targetKeys: ReadonlySet<string>;
  readonly relatedKeys: ReadonlySet<string>;
  readonly matchesByTarget: ReadonlyMap<string, ThreadReferenceMatches>;
}

const key = (ref: ScopedThreadRef) => scopedThreadKey(ref);
const sameRef = (left: ScopedThreadRef, right: ScopedThreadRef) => key(left) === key(right);

export const activeThreadReferencesAtom = Atom.make<ActiveThreadReferences>({
  hovered: null,
  pinned: [],
}).pipe(Atom.keepAlive, Atom.withLabel("thread-reference-highlight:active"));

const update = (next: (state: ActiveThreadReferences) => ActiveThreadReferences) =>
  appAtomRegistry.update(activeThreadReferencesAtom, next);
const isPinned = (state: ActiveThreadReferences, target: ScopedThreadRef) =>
  state.pinned.some((ref) => sameRef(ref, target));
const unpin = (target: ScopedThreadRef) =>
  update((state) => ({ ...state, pinned: state.pinned.filter((ref) => !sameRef(ref, target)) }));
const pin = (target: ScopedThreadRef) =>
  update((state) =>
    isPinned(state, target) ? state : { ...state, pinned: [...state.pinned, target] },
  );

export const threadReferenceHighlight = {
  enter: (target: ScopedThreadRef) => update((state) => ({ ...state, hovered: target })),
  leave: (target: ScopedThreadRef) =>
    update((state) =>
      state.hovered && sameRef(state.hovered, target) ? { ...state, hovered: null } : state,
    ),
  pin,
  unpin,
  togglePinned: (target: ScopedThreadRef) =>
    isPinned(appAtomRegistry.get(activeThreadReferencesAtom), target) ? unpin(target) : pin(target),
  clear: () => update(() => ({ hovered: null, pinned: [] })),
};

const hoveredAtom = Atom.make((get) => get(activeThreadReferencesAtom).hovered);
const settledHoverAtom = hoveredAtom.pipe(Atom.debounce("200 millis"));

/** Pinned targets plus a hover that has rested 200ms. Leaving a target ends its hover at once. */
export const activeTargetsAtom = Atom.make((get): ReadonlyArray<ScopedThreadRef> => {
  const settled = get(settledHoverAtom);
  const { hovered, pinned } = get(activeThreadReferencesAtom);
  return hovered && settled && sameRef(hovered, settled) && !pinned.some((r) => sameRef(r, hovered))
    ? [...pinned, hovered]
    : pinned;
});

/**
 * Changes whenever references may have changed. Quiet shells hold still through a run's streaming
 * ticks, so a mention added mid-run would wait for the run to end; a running thread polls instead.
 */
export const referenceActivitySignal = (
  shells: Atom.Atom<ReadonlyArray<{ readonly runtime: ThreadRuntime }>>,
) => {
  let revision = 0;
  return Atom.make((get) => {
    if (get(shells).some((thread) => threadRuntimeIsActive(thread.runtime))) {
      const timer = setTimeout(() => get.refreshSelf(), 10_000);
      get.addFinalizer(() => clearTimeout(timer));
    }
    return ++revision;
  });
};

const referenceActivityAtom = referenceActivitySignal(
  environmentThreadShells.quietThreadShellsAtom.pipe(Atom.debounce("500 millis")),
);

const references = createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
  label: "thread-references",
  staleTimeMs: 10_000,
  idleTtlMs: 10_000,
  refreshTrigger: () => referenceActivityAtom,
  execute: Effect.fn("ThreadReferences.read")(function* (input: {
    sourceEnvironmentId: EnvironmentId;
    target: ScopedThreadRef;
  }) {
    return yield* request(ORCHESTRATION_V2_WS_METHODS.getThreadReferences, {
      ...input,
      knownThreads: appAtomRegistry.get(environmentThreadShells.threadRefsAtom),
    });
  }),
});

export function classifyThreadReferences(
  targets: ReadonlyArray<ScopedThreadRef>,
  matchesFor: (target: ScopedThreadRef) => ThreadReferenceMatches,
): ThreadReferenceHighlight {
  const targetKeys = new Set(targets.map(key));
  const relatedKeys = new Set<string>();
  const matchesByTarget = new Map<string, ThreadReferenceMatches>();
  for (const target of targets) {
    const matches = matchesFor(target);
    matchesByTarget.set(key(target), matches);
    for (const threadKey of [...matches.mentions, ...matches.waits]) {
      if (!targetKeys.has(threadKey)) relatedKeys.add(threadKey);
    }
  }
  return { targetKeys, relatedKeys, matchesByTarget };
}

export const referenceHighlightRole = (
  highlight: ThreadReferenceHighlight,
  threadKey: string,
): ThreadReferenceHighlightRole =>
  highlight.targetKeys.has(threadKey)
    ? "target"
    : highlight.relatedKeys.has(threadKey)
      ? "related"
      : null;

const NO_HIGHLIGHT: ThreadReferenceHighlight = {
  targetKeys: new Set(),
  relatedKeys: new Set(),
  matchesByTarget: new Map(),
};

const highlightAtom = Atom.make((get): ThreadReferenceHighlight => {
  const targets = get(activeTargetsAtom);
  if (targets.length === 0) return NO_HIGHLIGHT;
  const environmentIds = [...get(environmentPresentations.presentationsAtom).keys()];
  const shells = get(environmentThreadShells.quietThreadShellsAtom);
  return classifyThreadReferences(targets, (target) => {
    const mentions = new Set<string>();
    const waits = new Set<string>();
    let unavailable = 0;
    let pending = false;
    for (const environmentId of environmentIds) {
      const result = get(
        references({ environmentId, input: { sourceEnvironmentId: environmentId, target } }),
      );
      const data = AsyncResult.getOrElse(result, () => null);
      for (const threadId of data?.mentions ?? []) mentions.add(key({ environmentId, threadId }));
      for (const threadId of data?.waits ?? []) waits.add(key({ environmentId, threadId }));
      if (AsyncResult.isFailure(result)) unavailable++;
      if (result.waiting && !data) pending = true;
    }
    for (const thread of shells) {
      if (
        thread.environmentId === target.environmentId &&
        thread.pendingBackgroundTasks?.some(
          (task) => task.kind === "subagent" && task.childThreadId === target.threadId,
        )
      ) {
        waits.add(key({ environmentId: thread.environmentId, threadId: thread.id }));
      }
    }
    return { mentions, waits, unavailable, pending };
  });
}).pipe(Atom.withLabel("thread-reference-highlight:matches"));

// One atom per thread, so a highlight change re-renders only the rows and chips whose role changed.
const roleAtom = Atom.family((threadKey: string) =>
  Atom.make((get) => referenceHighlightRole(get(highlightAtom), threadKey)),
);
const matchesAtom = Atom.family((threadKey: string) =>
  Atom.make((get) => get(highlightAtom).matchesByTarget.get(threadKey) ?? null),
);
const pinnedAtom = Atom.make((get) => get(activeThreadReferencesAtom).pinned);

export const usePinnedThreadReferences = () => useAtomValue(pinnedAtom);
export const useReferenceHighlightRole = (threadKey: string) => useAtomValue(roleAtom(threadKey));
export const useReferenceMatches = (threadKey: string) => useAtomValue(matchesAtom(threadKey));
