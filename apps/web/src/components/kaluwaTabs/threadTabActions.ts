// Fork: what Kaluwa's titlebar tabs do: open, close, switch, follow the route, and the keys and
// middle-click that reach them. Everything reads app state at call time, so the strip, the
// shortcuts and the command palette act on the same live tab list.
import { scopedThreadKey, parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { selectProjectGroupingSettings } from "@t3tools/client-runtime/state/project-grouping";
import { THREAD_TAB_JUMP_KEYBINDING_COMMANDS, type ScopedThreadRef } from "@t3tools/contracts";
import type { AnyRouter } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";

import { isCommandPaletteOpen, openCommandPalette } from "../../commandPaletteBus";
import { useComposerDraftStore } from "../../composerDraftStore";
import {
  createNewThreadHandler,
  readLastUsedProjectKey,
  resolveDefaultProjectRef,
} from "../../hooks/useHandleNewThread";
import { getClientSettings } from "../../hooks/useSettings";
import {
  closeThreadTab,
  moveThreadTab,
  parseThreadTabKey,
  pruneThreadTabs,
  relativeThreadTab,
  threadTabAt,
  threadTabKeyForDraft,
  threadTabKeyForThread,
  type ThreadTabKey,
  type ThreadTabLivenessInput,
  type ThreadTabsState,
} from "../../kaluwa/kaluwaThreadTabs.logic";
import {
  applyThreadTabRoute,
  armNewThreadTab,
  disarmNewThreadTab,
  readThreadTabs,
  useStoredThreadTabs,
  writeThreadTabs,
} from "../../kaluwa/kaluwaThreadTabsStore";
import { markKaluwaThreadTabStripMounted } from "../../kaluwa/kaluwaThreadTabShortcuts";
import { startNewThreadFromContext } from "../../lib/chatThreadActions";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { registerCommands, type CommandHandler } from "../../shortcuts/dispatcher";
import { readProjects, readThreadShell, useThreadRefs } from "../../state/entities";
import { defaultProjectFallbackReadyAtom } from "../../state/projects";
import { liveShellEnvironmentIdsAtom } from "../../state/shell";
import { environmentThreadShells } from "../../state/threads";
import {
  buildThreadRouteParams,
  resolveThreadRouteTarget,
  type ThreadRouteTarget,
} from "../../threadRoutes";
import { useUiStateStore } from "../../uiStateStore";

export function threadTabKeyForRouteTarget(target: ThreadRouteTarget | null): ThreadTabKey | null {
  if (target === null) return null;
  return target.kind === "server"
    ? threadTabKeyForThread(target.threadRef)
    : threadTabKeyForDraft(target.draftId);
}

function readRouteTabKey(router: AnyRouter): ThreadTabKey | null {
  return threadTabKeyForRouteTarget(
    resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {}),
  );
}

function livenessInput(
  threadRefs: ReadonlyArray<ScopedThreadRef>,
  liveEnvironmentIds: ReadonlySet<string>,
  draftThreadsByThreadKey: Readonly<Record<string, unknown>>,
  promotedDraftRedirects: Readonly<Record<string, ScopedThreadRef>>,
): ThreadTabLivenessInput {
  return {
    knownThreadKeys: new Set(threadRefs.map(scopedThreadKey)),
    liveEnvironmentIds,
    draftExists: (draftId) => draftThreadsByThreadKey[draftId] !== undefined,
    promotedTo: (draftId) => promotedDraftRedirects[draftId] ?? null,
  };
}

/** The stored tabs minus any whose thread or draft is gone, read now. */
function readLiveThreadTabs(): ThreadTabsState {
  const drafts = useComposerDraftStore.getState();
  return pruneThreadTabs(
    readThreadTabs(),
    livenessInput(
      appAtomRegistry.get(environmentThreadShells.threadRefsAtom),
      appAtomRegistry.get(liveShellEnvironmentIdsAtom),
      drafts.draftThreadsByThreadKey,
      drafts.promotedDraftRedirects,
    ),
  );
}

/** The same list as `readLiveThreadTabs`, re-rendering when a tab's thread or draft goes. */
export function useLiveThreadTabs(): ThreadTabsState {
  const stored = useStoredThreadTabs();
  const threadRefs = useThreadRefs();
  const liveEnvironmentIds = useAtomValue(liveShellEnvironmentIdsAtom);
  const draftThreadsByThreadKey = useComposerDraftStore((store) => store.draftThreadsByThreadKey);
  const promotedDraftRedirects = useComposerDraftStore((store) => store.promotedDraftRedirects);
  return pruneThreadTabs(
    stored,
    livenessInput(threadRefs, liveEnvironmentIds, draftThreadsByThreadKey, promotedDraftRedirects),
  );
}

/** Applies the route the router shows now, as the strip does when it changes. */
export function syncThreadTabRoute(router: AnyRouter): void {
  const key = readRouteTabKey(router);
  if (key !== null) applyThreadTabRoute(readLiveThreadTabs(), key);
}

function navigateToThreadTab(router: AnyRouter, key: ThreadTabKey): void {
  const target = parseThreadTabKey(key);
  if (target === null) return;
  if (target.kind === "thread") {
    void router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(target.ref),
    });
  } else {
    void router.navigate({ to: "/draft/$draftId", params: { draftId: target.draftId } });
  }
}

export function activateThreadTab(router: AnyRouter, key: ThreadTabKey): void {
  const live = readLiveThreadTabs();
  if (!live.tabs.includes(key)) return;
  writeThreadTabs({ tabs: live.tabs, active: key });
  navigateToThreadTab(router, key);
}

/** Starts a thread in the current project, as the new-thread shortcut does, in a new tab. */
export async function openNewThreadTab(
  router: AnyRouter,
  options: { readonly inNewTab: boolean } = { inNewTab: true },
): Promise<void> {
  if (options.inNewTab) armNewThreadTab();
  const target = resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {});
  const drafts = useComposerDraftStore.getState();
  const lastUsedProjectKey = readLastUsedProjectKey();
  const started = await startNewThreadFromContext({
    activeThread:
      target?.kind === "server" ? (readThreadShell(target.threadRef) ?? undefined) : undefined,
    activeDraftThread: target
      ? target.kind === "server"
        ? drafts.getDraftThread(target.threadRef)
        : drafts.getDraftSession(target.draftId)
      : null,
    defaultProjectRef: resolveDefaultProjectRef(
      readProjects(),
      useUiStateStore.getState().projectOrder,
      lastUsedProjectKey,
      appAtomRegistry.get(defaultProjectFallbackReadyAtom(lastUsedProjectKey)),
      selectProjectGroupingSettings(getClientSettings()),
    ),
    handleNewThread: createNewThreadHandler(router),
  }).catch(() => false);
  if (!started) {
    disarmNewThreadTab();
    openCommandPalette({ open: "new-thread-in" });
    return;
  }
  // The project's open draft may be the page already, so no route change would apply the tab.
  syncThreadTabRoute(router);
}

/** Closes a tab; the active one hands over to its neighbour, and the last leaves a new thread. */
export function closeThreadTabAndFollow(router: AnyRouter, key: ThreadTabKey): void {
  const { state, activate } = closeThreadTab(readLiveThreadTabs(), key);
  writeThreadTabs(state);
  if (activate !== null) navigateToThreadTab(router, activate);
  else if (state.tabs.length === 0) void openNewThreadTab(router, { inNewTab: false });
}

export function closeActiveThreadTab(router: AnyRouter): void {
  const { active } = readLiveThreadTabs();
  if (active !== null) closeThreadTabAndFollow(router, active);
}

export function activateRelativeThreadTab(router: AnyRouter, delta: 1 | -1): void {
  const key = relativeThreadTab(readLiveThreadTabs(), delta);
  if (key !== null) activateThreadTab(router, key);
}

export function moveThreadTabTo(key: ThreadTabKey, toIndex: number): void {
  writeThreadTabs(moveThreadTab(readLiveThreadTabs(), key, toIndex));
}

const SIDEBAR_THREAD_ROW_SELECTOR = "[data-app-sidebar] [data-thread-item]";

function sidebarThreadRowRef(event: MouseEvent) {
  if (event.button !== 1 || !(event.target instanceof Element)) return null;
  const key = event.target.closest(SIDEBAR_THREAD_ROW_SELECTOR)?.getAttribute("data-thread-item");
  return key ? parseScopedThreadKey(key) : null;
}

/** Tab keys and a middle-click on a sidebar thread, live while the strip is mounted. */
export function registerThreadTabStrip(router: AnyRouter): () => void {
  const releaseMounted = markKaluwaThreadTabStripMounted();
  const claim = (event: KeyboardEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };
  const run =
    (action: () => void): CommandHandler =>
    (event) => {
      claim(event);
      if (!event.repeat) action();
    };
  const jumps: Partial<
    Record<(typeof THREAD_TAB_JUMP_KEYBINDING_COMMANDS)[number], CommandHandler>
  > = {};
  THREAD_TAB_JUMP_KEYBINDING_COMMANDS.forEach((command, index) => {
    jumps[command] = run(() => {
      const key = threadTabAt(readLiveThreadTabs(), index);
      if (key !== null) activateThreadTab(router, key);
    });
  });
  // Captured, so the terminal and editors cannot swallow Ctrl+Tab first.
  const unregister = registerCommands(
    {
      "threadTab.new": run(() => void openNewThreadTab(router)),
      "threadTab.close": run(() => closeActiveThreadTab(router)),
      "threadTab.next": (event) => {
        claim(event);
        activateRelativeThreadTab(router, 1);
      },
      "threadTab.previous": (event) => {
        claim(event);
        activateRelativeThreadTab(router, -1);
      },
      ...jumps,
    },
    { capture: true, when: () => !isCommandPaletteOpen() },
  );
  // Middle-click opens a sidebar thread in a new tab; its mousedown would start autoscroll.
  const onMouseDown = (event: MouseEvent) => {
    if (sidebarThreadRowRef(event) !== null) event.preventDefault();
  };
  const onAuxClick = (event: MouseEvent) => {
    const ref = sidebarThreadRowRef(event);
    if (ref === null) return;
    event.preventDefault();
    event.stopPropagation();
    if (threadTabKeyForThread(ref) === readRouteTabKey(router)) return;
    armNewThreadTab();
    void router.navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
  };
  document.addEventListener("mousedown", onMouseDown, true);
  document.addEventListener("auxclick", onAuxClick, true);
  return () => {
    unregister();
    releaseMounted();
    document.removeEventListener("mousedown", onMouseDown, true);
    document.removeEventListener("auxclick", onAuxClick, true);
  };
}
