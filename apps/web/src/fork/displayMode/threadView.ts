import { useAtomValue } from "@effect/atom-react";
import { parseThreadKey, threadKey } from "@t3tools/client-runtime/state/entities";
import type { EnvironmentThreadState } from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { resolveDisplayMode } from "@t3tools/shared/displayModes";
import * as Schema from "effect/Schema";
import { type AsyncResult, Atom } from "effect/reactivity";

import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";
import { serverEnvironment } from "../../state/server";

/** The threads this viewer last saw in a display mode, by thread key. */
export interface ShownViewHints {
  readonly has: (key: string) => boolean;
  readonly set: (key: string, shown: boolean) => void;
}

const HINTS_KEY = "t3code:shown-view-threads:v1";
const HINTS_KEPT = 200;
const HintKeys = Schema.Array(Schema.String);

function localStorageHints(): ShownViewHints {
  let keys: Set<string> | undefined;
  const load = () => {
    if (keys !== undefined) return keys;
    try {
      keys = new Set(getLocalStorageItem(HINTS_KEY, HintKeys) ?? []);
    } catch {
      keys = new Set();
    }
    return keys;
  };
  return {
    has: (key) => load().has(key),
    set: (key, shown) => {
      const current = load();
      if (current.has(key) === shown) return;
      if (shown) current.add(key);
      else current.delete(key);
      for (const oldest of current) {
        if (current.size <= HINTS_KEPT) break;
        current.delete(oldest);
      }
      try {
        setLocalStorageItem(HINTS_KEY, [...current], HintKeys);
      } catch {
        return;
      }
    },
  };
}

/** What the view of a thread depends on in its server's config. */
export interface ThreadViewConfig {
  readonly environment: { readonly capabilities: { readonly threadShownHistory?: boolean } };
  readonly settings: { readonly threadDisplayModes: Readonly<Record<string, string>> };
}

type ThreadStates<E> = {
  readonly stateAtom: (
    environmentId: EnvironmentId,
    threadId: ThreadId,
    shownOnly?: boolean,
  ) => Atom.Atom<AsyncResult.AsyncResult<EnvironmentThreadState, E>>;
};

/**
 * A thread shows its shown-only view when its server serves one and its display mode draws only
 * messages. Until the server's config arrives, the viewer's last answer stands in, so a cold start
 * opens one view and does not switch.
 */
export function createThreadViews(
  configAtom: (environmentId: EnvironmentId) => Atom.Atom<ThreadViewConfig | null>,
  hints: ShownViewHints,
) {
  const shownFamily = Atom.family((key: string) => {
    const { environmentId, threadId } = parseThreadKey(key);
    return Atom.make((get) => {
      const config = get(configAtom(environmentId));
      if (config === null) return hints.has(key);
      const shown =
        config.environment.capabilities.threadShownHistory === true &&
        resolveDisplayMode(config.settings.threadDisplayModes[threadId]).subThreads;
      hints.set(key, shown);
      return shown;
    }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`web-thread-shown-view:${key}`));
  });

  return {
    shownAtom: (ref: ScopedThreadRef) => shownFamily(threadKey(ref)),
    /** Each thread mounts exactly one of its views from `base`, and Normal threads the same state as before. */
    wrap: <E>(base: ThreadStates<E>) => {
      const stateFamily = Atom.family((key: string) => {
        const { environmentId, threadId } = parseThreadKey(key);
        return Atom.make((get) =>
          get(base.stateAtom(environmentId, threadId, get(shownFamily(key)))),
        ).pipe(Atom.setIdleTTL(0), Atom.withLabel(`web-thread-view-state:${key}`));
      });
      return {
        stateAtom: (environmentId: EnvironmentId, threadId: ThreadId) =>
          stateFamily(threadKey({ environmentId, threadId })),
      };
    },
  };
}

const threadViews = createThreadViews(serverEnvironment.configValueAtom, localStorageHints());

export const displayModeThreadStates = threadViews.wrap;

const NOT_SHOWN = Atom.make(false).pipe(Atom.withLabel("web-thread-shown-view:none"));

/** Whether the thread's state holds only what its display mode shows. */
export const useThreadShownView = (ref: ScopedThreadRef | null): boolean =>
  useAtomValue(ref === null ? NOT_SHOWN : threadViews.shownAtom(ref));
