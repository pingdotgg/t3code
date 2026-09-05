import { RegistryContext } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentCatalogState } from "@t3tools/client-runtime/state/connections";
import type { EnvironmentShellState } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, OrchestrationThreadShell, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import type { Atom, AtomRegistry } from "effect/unstable/reactivity";
import { useContext, useEffect } from "react";

import { environmentCatalog } from "../connection/catalog";
import { environmentShell } from "../state/shell";
import { useUiStateStore } from "../uiStateStore";

export function subscribeToUnvisitedCompletions(input: {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly catalogAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly shellAtom: (environmentId: EnvironmentId) => Atom.Atom<EnvironmentShellState>;
}): () => void {
  const subscriptions = new Map<EnvironmentId, () => void>();
  const unsubscribeCatalog = input.registry.subscribe(
    input.catalogAtom,
    ({ entries }) => {
      for (const [environmentId, unsubscribe] of subscriptions) {
        if (entries.has(environmentId)) continue;
        unsubscribe();
        subscriptions.delete(environmentId);
      }
      for (const environmentId of entries.keys()) {
        if (subscriptions.has(environmentId)) continue;
        let previousCompletions: Map<ThreadId, string | null> | null = null;
        let previousThreads: ReadonlyArray<OrchestrationThreadShell> | null = null;
        const unsubscribe = input.registry.subscribe(
          input.shellAtom(environmentId),
          (state) => {
            if (state.status !== "live" || Option.isNone(state.snapshot)) return;
            if (state.snapshot.value.threads === previousThreads) return;
            previousThreads = state.snapshot.value.threads;
            const previous = previousCompletions;
            const next = new Map<ThreadId, string | null>();
            previousCompletions = next;
            for (const thread of state.snapshot.value.threads) {
              const completedAt =
                thread.latestTurn?.state === "completed" ? thread.latestTurn.completedAt : null;
              next.set(thread.id, completedAt);
              // The first live snapshot is history, including anything replayed from
              // cache during initial synchronization. Reconnects retain this baseline.
              if (previous === null || !completedAt || previous.get(thread.id) === completedAt)
                continue;
              const threadKey = scopedThreadKey(scopeThreadRef(environmentId, thread.id));
              const ui = useUiStateStore.getState();
              if (ui.threadLastVisitedAtById[threadKey] === undefined) {
                ui.markThreadUnread(threadKey, completedAt);
              }
            }
          },
          { immediate: true },
        );
        subscriptions.set(environmentId, unsubscribe);
      }
    },
    { immediate: true },
  );
  return () => {
    unsubscribeCatalog();
    for (const unsubscribe of subscriptions.values()) unsubscribe();
    subscriptions.clear();
  };
}

export function useUnvisitedCompletionsUnread(): void {
  const registry = useContext(RegistryContext);
  useEffect(
    () =>
      subscribeToUnvisitedCompletions({
        registry,
        catalogAtom: environmentCatalog.catalogValueAtom,
        shellAtom: environmentShell.stateValueAtom,
      }),
    [registry],
  );
}
