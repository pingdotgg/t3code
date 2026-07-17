import * as QuickActions from "expo-quick-actions";
import { useEffect, useMemo, useRef, useState } from "react";
import { Platform } from "react-native";
import { useLinkTo, type NavigationState } from "@react-navigation/native";

import {
  loadRecentThreadShortcuts,
  saveRecentThreadShortcuts,
  type RecentThreadShortcut,
} from "../../persistence/imperative";
import { useThreadShell } from "../../state/entities";
import {
  activeThreadRef,
  buildShortcutActions,
  shortcutHref,
  withRecentThreadShortcut,
} from "./appShortcuts";

/**
 * Owns the launcher app shortcuts (Android long-press menu): keeps the
 * static "New task" entry plus the recently opened threads in sync, and
 * routes shortcut taps — cold start included — to their in-app screens.
 * Mounted once in the root stack layout.
 */
export function useAppShortcuts(state: NavigationState): void {
  useShortcutNavigation();
  useRecentThreadShortcutSync(state);
}

function useShortcutNavigation(): void {
  const linkTo = useLinkTo();
  const handledInitialAction = useRef(false);

  useEffect(() => {
    // Cold start: the tapped shortcut arrives as the launch action, before
    // any listener can fire. Navigating from here pushes the target over the
    // initial Home route, so back returns home instead of exiting the app.
    if (!handledInitialAction.current) {
      handledInitialAction.current = true;
      const initialHref = QuickActions.initial ? shortcutHref(QuickActions.initial) : null;
      if (initialHref !== null) {
        linkTo(initialHref);
      }
    }

    const subscription = QuickActions.addListener((action) => {
      const href = shortcutHref(action);
      if (href !== null) {
        linkTo(href);
      }
    });
    return () => subscription.remove();
  }, [linkTo]);
}

function useRecentThreadShortcutSync(state: NavigationState): void {
  const threadRef = useMemo(() => activeThreadRef(state), [state]);
  const threadShell = useThreadShell(threadRef);
  // null until the persisted list loads; recording waits on it so the first
  // thread opened after a cold start cannot clobber older entries.
  const [recents, setRecents] = useState<ReadonlyArray<RecentThreadShortcut> | null>(null);
  // Gates storage writes: a failed load falls back to an empty in-memory
  // list (so the launcher still gets the "New task" item), but persisting
  // that fallback would erase valid history over a transient read error.
  // Real thread opens flip this on — by then the list is the new truth.
  const persistableRef = useRef(false);
  // Saves are fire-and-forget; chaining them keeps an older list from
  // finishing after (and overwriting) a newer one.
  const saveQueueRef = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    if (Platform.OS !== "android") {
      return;
    }

    let cancelled = false;
    void loadRecentThreadShortcuts()
      .then((threads) => {
        if (!cancelled) {
          persistableRef.current = true;
          setRecents(threads);
        }
      })
      .catch((error) => {
        console.warn("[app-shortcuts] failed to load recent threads", error);
        if (!cancelled) {
          setRecents([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const loaded = recents !== null;
  const environmentId = threadRef?.environmentId ?? null;
  const threadId = threadRef?.threadId ?? null;
  const title = threadShell?.title ?? "";
  useEffect(() => {
    if (!loaded || environmentId === null || threadId === null) {
      return;
    }

    // withRecentThreadShortcut returns the same array when nothing changed,
    // so React bails out and the persist effect below does not re-fire.
    setRecents((current) => {
      if (current === null) {
        return current;
      }
      const next = withRecentThreadShortcut(current, { environmentId, threadId, title });
      if (next !== current) {
        persistableRef.current = true;
      }
      return next;
    });
  }, [loaded, environmentId, threadId, title]);

  useEffect(() => {
    if (recents === null) {
      return;
    }

    if (persistableRef.current) {
      saveQueueRef.current = saveQueueRef.current.then(
        () =>
          saveRecentThreadShortcuts(recents).catch((error) => {
            console.warn("[app-shortcuts] failed to persist recent threads", error);
          }),
        () => undefined,
      );
    }
    void QuickActions.setItems(buildShortcutActions(recents)).catch((error) => {
      console.warn("[app-shortcuts] failed to update launcher shortcuts", error);
    });
  }, [recents]);
}
