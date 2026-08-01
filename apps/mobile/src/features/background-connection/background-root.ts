import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, type AtomRegistry } from "effect/unstable/reactivity";

import { environmentCatalog } from "../../connection/catalog";
import { environmentServerConfigsAtom } from "../../state/server";
import { environmentShell } from "../../state/shell";
import { environmentThreadShells, environmentThreads } from "../../state/threads";
import {
  clearBackgroundConnectionRetainedThread,
  ensureBackgroundConnectionRetainedThreadLoaded,
  getBackgroundConnectionRetainedThreadSnapshot,
  subscribeBackgroundConnectionRetainedThread,
} from "./retained-thread";
import { selectBackgroundConnectionThreadTargets } from "./target-selection";

interface DetailLease {
  readonly ref: ScopedThreadRef;
  readonly release: () => void;
}

interface BackgroundConnectionRoot {
  readonly start: () => void;
  readonly stop: () => void;
}

function refKey(ref: ScopedThreadRef): string {
  return JSON.stringify([ref.environmentId, ref.threadId]);
}

function refsEqual(left: ScopedThreadRef | null, right: ScopedThreadRef): boolean {
  return (
    left !== null && left.environmentId === right.environmentId && left.threadId === right.threadId
  );
}

function releaseBestEffort(label: string, release: (() => void) | null): void {
  if (release === null) {
    return;
  }
  try {
    release();
  } catch (error) {
    console.error(`[background-connection] failed to release ${label}`, error);
  }
}

export function createBackgroundConnectionRoot(
  registry: AtomRegistry.AtomRegistry,
): BackgroundConnectionRoot {
  let started = false;
  let retainedThread = getBackgroundConnectionRetainedThreadSnapshot().thread;
  let catalogReady = false;
  let catalogEnvironmentIds = new Set<EnvironmentId>();
  let threadShells = registry.get(environmentThreadShells.threadShellsAtom);
  let catalogRelease: (() => void) | null = null;
  let threadShellsRelease: (() => void) | null = null;
  let serverConfigsRelease: (() => void) | null = null;
  let retainedThreadRelease: (() => void) | null = null;
  const clearingDeletedKeys = new Set<string>();
  const shellLeases = new Map<EnvironmentId, () => void>();
  const detailLeases = new Map<string, DetailLease>();

  const clearRetainedIfCurrent = (ref: ScopedThreadRef) => {
    if (!refsEqual(retainedThread, ref)) {
      return;
    }
    const key = refKey(ref);
    if (clearingDeletedKeys.has(key)) {
      return;
    }
    clearingDeletedKeys.add(key);
    void clearBackgroundConnectionRetainedThread().finally(() => {
      clearingDeletedKeys.delete(key);
      // Saving publishes before its persistence operation is queued. If the
      // same deleted ref was saved while this clear was pending, clear it once
      // more now so the final persistence operation cannot restore it.
      if (started && refsEqual(retainedThread, ref)) {
        clearRetainedIfCurrent(ref);
      }
    });
  };

  const syncDetailLeases = () => {
    if (!started) {
      return;
    }
    const targets = selectBackgroundConnectionThreadTargets(retainedThread, threadShells);
    const targetKeys = new Set(targets.map(refKey));

    for (const [key, lease] of detailLeases) {
      if (targetKeys.has(key)) {
        continue;
      }
      detailLeases.delete(key);
      releaseBestEffort(`thread detail ${key}`, lease.release);
    }

    for (const ref of targets) {
      const key = refKey(ref);
      if (detailLeases.has(key)) {
        continue;
      }
      const atom = environmentThreads.stateAtom(ref.environmentId, ref.threadId);
      let subscribedRelease: (() => void) | null = null;
      const lease: DetailLease = {
        ref,
        release: () => subscribedRelease?.(),
      };
      // Register the lease before subscribing because an immediate deleted
      // state can synchronously clear the retained target and re-enter this
      // reconciliation.
      detailLeases.set(key, lease);
      subscribedRelease = registry.subscribe(
        atom,
        (result) => {
          const state = Option.getOrNull(AsyncResult.value(result));
          if (state?.status === "deleted") {
            clearRetainedIfCurrent(ref);
          }
        },
        { immediate: true },
      );
      if (!detailLeases.has(key)) {
        subscribedRelease();
      }
    }
  };

  const validateRetainedEnvironment = () => {
    if (
      catalogReady &&
      retainedThread !== null &&
      !catalogEnvironmentIds.has(retainedThread.environmentId)
    ) {
      clearRetainedIfCurrent(retainedThread);
    }
  };

  const syncRetainedThread = () => {
    retainedThread = getBackgroundConnectionRetainedThreadSnapshot().thread;
    validateRetainedEnvironment();
    syncDetailLeases();
  };

  return {
    start() {
      if (started) {
        return;
      }
      started = true;
      retainedThreadRelease = subscribeBackgroundConnectionRetainedThread(syncRetainedThread);
      retainedThread = getBackgroundConnectionRetainedThreadSnapshot().thread;
      serverConfigsRelease = registry.mount(environmentServerConfigsAtom);
      catalogRelease = registry.subscribe(
        environmentCatalog.catalogValueAtom,
        (catalog) => {
          catalogReady = catalog.isReady;
          catalogEnvironmentIds = new Set(catalog.entries.keys());

          for (const [environmentId, release] of shellLeases) {
            if (catalogEnvironmentIds.has(environmentId)) {
              continue;
            }
            shellLeases.delete(environmentId);
            releaseBestEffort(`environment shell ${environmentId}`, release);
          }
          for (const environmentId of catalogEnvironmentIds) {
            if (!shellLeases.has(environmentId)) {
              shellLeases.set(
                environmentId,
                registry.mount(environmentShell.stateAtom(environmentId)),
              );
            }
          }
          validateRetainedEnvironment();
        },
        { immediate: true },
      );
      threadShellsRelease = registry.subscribe(
        environmentThreadShells.threadShellsAtom,
        (nextThreadShells) => {
          threadShells = nextThreadShells;
          syncDetailLeases();
        },
        { immediate: true },
      );
      void ensureBackgroundConnectionRetainedThreadLoaded();
      syncDetailLeases();
    },
    stop() {
      if (!started) {
        return;
      }
      started = false;
      releaseBestEffort("retained-thread listener", retainedThreadRelease);
      retainedThreadRelease = null;
      releaseBestEffort("thread-shell listener", threadShellsRelease);
      threadShellsRelease = null;
      releaseBestEffort("environment catalog", catalogRelease);
      catalogRelease = null;
      releaseBestEffort("server configs", serverConfigsRelease);
      serverConfigsRelease = null;
      for (const [environmentId, release] of shellLeases) {
        releaseBestEffort(`environment shell ${environmentId}`, release);
      }
      shellLeases.clear();
      for (const [key, lease] of detailLeases) {
        releaseBestEffort(`thread detail ${key}`, lease.release);
      }
      detailLeases.clear();
    },
  };
}

const roots = new WeakMap<
  AtomRegistry.AtomRegistry,
  { readonly root: BackgroundConnectionRoot; owners: number }
>();

export function acquireBackgroundConnectionRoot(registry: AtomRegistry.AtomRegistry): () => void {
  let shared = roots.get(registry);
  if (shared === undefined) {
    const root = createBackgroundConnectionRoot(registry);
    shared = { root, owners: 1 };
    roots.set(registry, shared);
    try {
      root.start();
    } catch (error) {
      roots.delete(registry);
      root.stop();
      throw error;
    }
  } else {
    shared.owners += 1;
  }
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    const current = roots.get(registry);
    if (current === undefined) {
      return;
    }
    current.owners -= 1;
    if (current.owners > 0) {
      return;
    }
    current.root.stop();
    roots.delete(registry);
  };
}
