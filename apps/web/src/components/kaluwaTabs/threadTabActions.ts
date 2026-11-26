// Fork: what Kaluwa's titlebar tabs do: open, close, switch, follow the route, and the keys and
// middle-click that reach them. Everything reads app state at call time, so the strip, the
// shortcuts and the command palette act on the same live tab list.
import { scopedThreadKey, parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { selectProjectGroupingSettings } from "@t3tools/client-runtime/state/project-grouping";
import { THREAD_TAB_JUMP_KEYBINDING_COMMANDS, type ScopedThreadRef } from "@t3tools/contracts";
import type { AnyRouter } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";

import { isCommandPaletteOpen, openCommandPalette } from "../../commandPaletteBus";
import { useComposerDraftStore } from "../../composerDraftStore";
import {
  createNewThreadHandler,
  readLastUsedProjectKey,
  resolveDefaultProjectRef,
} from "../../hooks/useHandleNewThread";
import { getClientSettings } from "../../hooks/useSettings";
import { readKaluwaTabsSettings, useKaluwaTabsSettings } from "../../kaluwa/kaluwaTabsSettings";
import { KALUWA_PROJECT_COLOR_SWATCHES } from "../../kaluwa/kaluwaPalette";
import { deriveProjectIdentity } from "../../projectIdentity";
import {
  THREAD_TAB_GROUP_COLORS,
  groupThreadTabsByProject,
  type ProjectGroupingInput,
  type ThreadTabGroupColor,
  closeThreadTabs,
  parseThreadTabKey,
  pruneThreadTabs,
  relativeThreadTab,
  reopenClosedThreadTabs,
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
import {
  readProjects,
  readThreadShell,
  readThreadShells,
  useProjects,
  useQuietThreadShells,
  useThreadRefs,
} from "../../state/entities";
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
export function readLiveThreadTabs(): ThreadTabsState {
  const drafts = useComposerDraftStore.getState();
  const pruned = pruneThreadTabs(
    readThreadTabs(),
    livenessInput(
      appAtomRegistry.get(environmentThreadShells.threadRefsAtom),
      appAtomRegistry.get(liveShellEnvironmentIdsAtom),
      drafts.draftThreadsByThreadKey,
      drafts.promotedDraftRedirects,
    ),
  );
  return groupThreadTabsByProject(
    pruned,
    projectGroupingInput(
      readKaluwaTabsSettings().groupByProject,
      readThreadShells(),
      drafts.draftThreadsByThreadKey,
      readProjects(),
    ),
  );
}

/** The scoped key a tab's project is grouped by. */
export function threadTabProjectKey(environmentId: string, projectId: string): string {
  return `${environmentId}:${projectId}`;
}

/** A project's group colour: its icon colour's palette swatch, or one picked from its name. */
function threadTabProjectColor(project: EnvironmentProject): ThreadTabGroupColor {
  const icon = project.projectIcon;
  const color =
    icon && "color" in icon && typeof icon.color === "string"
      ? icon.color
      : deriveProjectIdentity(project.title).color;
  const slot = KALUWA_PROJECT_COLOR_SWATCHES[color];
  return THREAD_TAB_GROUP_COLORS.find((candidate) => candidate === slot) ?? "steel";
}

function projectGroupingInput(
  enabled: boolean,
  shells: ReadonlyArray<EnvironmentThreadShell>,
  draftThreadsByThreadKey: Readonly<
    Record<string, { readonly environmentId: string; readonly projectId: string }>
  >,
  projects: ReadonlyArray<EnvironmentProject>,
): ProjectGroupingInput {
  const projectByThreadKey = new Map(
    shells.map((shell) => [
      `${shell.environmentId}:${shell.id}`,
      threadTabProjectKey(shell.environmentId, shell.projectId),
    ]),
  );
  const projectByKey = new Map(
    projects.map((project) => [threadTabProjectKey(project.environmentId, project.id), project]),
  );
  return {
    enabled,
    projectOf: (key) => {
      const target = parseThreadTabKey(key);
      if (target === null) return null;
      if (target.kind === "thread") return projectByThreadKey.get(scopedThreadKey(target.ref));
      const draft = draftThreadsByThreadKey[target.draftId];
      return draft ? threadTabProjectKey(draft.environmentId, draft.projectId) : undefined;
    },
    colorOf: (project) => {
      const found = projectByKey.get(project);
      return found ? threadTabProjectColor(found) : "steel";
    },
  };
}

/** The same list as `readLiveThreadTabs`, re-rendering when a tab's thread or draft goes. */
export function useLiveThreadTabs(): ThreadTabsState {
  const stored = useStoredThreadTabs();
  const threadRefs = useThreadRefs();
  const liveEnvironmentIds = useAtomValue(liveShellEnvironmentIdsAtom);
  const draftThreadsByThreadKey = useComposerDraftStore((store) => store.draftThreadsByThreadKey);
  const promotedDraftRedirects = useComposerDraftStore((store) => store.promotedDraftRedirects);
  const { groupByProject } = useKaluwaTabsSettings();
  const shells = useQuietThreadShells();
  const projects = useProjects();
  const pruned = pruneThreadTabs(
    stored,
    livenessInput(threadRefs, liveEnvironmentIds, draftThreadsByThreadKey, promotedDraftRedirects),
  );
  return groupThreadTabsByProject(
    pruned,
    projectGroupingInput(groupByProject, shells, draftThreadsByThreadKey, projects),
  );
}

/** Whether `key` is the thread the active draft tab was just sent as. */
function isActiveDraftSentAs(state: ThreadTabsState, key: ThreadTabKey): boolean {
  const active = state.active === null ? null : parseThreadTabKey(state.active);
  const next = parseThreadTabKey(key);
  if (active?.kind !== "draft" || next?.kind !== "thread") return false;
  const drafts = useComposerDraftStore.getState();
  const session = drafts.draftThreadsByThreadKey[active.draftId];
  const promoted = session?.promotedTo ?? drafts.promotedDraftRedirects[active.draftId] ?? null;
  const sentAs =
    promoted ??
    (session ? { environmentId: session.environmentId, threadId: session.threadId } : null);
  return sentAs !== null && threadTabKeyForThread(sentAs) === key;
}

/** Applies the route the router shows now, as the strip does when it changes. */
export function syncThreadTabRoute(router: AnyRouter): void {
  const key = readRouteTabKey(router);
  if (key === null) return;
  const live = readLiveThreadTabs();
  applyThreadTabRoute(live, key, {
    openInNewTab: readKaluwaTabsSettings().openIn === "new-tab",
    replaceActive: isActiveDraftSentAs(live, key),
  });
  // Saved with project groups applied, so a new tab is stored in its project's group.
  writeThreadTabs(readLiveThreadTabs());
}

/** Applies a change to the live tab list. */
export function updateThreadTabs(change: (state: ThreadTabsState) => ThreadTabsState): void {
  writeThreadTabs(change(readLiveThreadTabs()));
  writeThreadTabs(readLiveThreadTabs());
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
  writeThreadTabs({ ...live, active: key });
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

/** Closes tabs; the active one hands over to its neighbour, and closing the last leaves a new thread. */
export function closeThreadTabsAndFollow(
  router: AnyRouter,
  keys: ReadonlyArray<ThreadTabKey>,
): void {
  const live = readLiveThreadTabs();
  const { state, activate } = closeThreadTabs(live, keys);
  if (state === live) return;
  writeThreadTabs(state);
  if (activate !== null) navigateToThreadTab(router, activate);
  else if (state.tabs.length === 0) void openNewThreadTab(router, { inNewTab: false });
}

export function closeActiveThreadTab(router: AnyRouter): void {
  const { active } = readLiveThreadTabs();
  if (active !== null) closeThreadTabsAndFollow(router, [active]);
}

/** Reopens the last closed tabs and shows the first of them. */
export function reopenClosedThreadTab(router: AnyRouter): void {
  const { state, activate } = reopenClosedThreadTabs(readLiveThreadTabs());
  writeThreadTabs(state);
  if (activate !== null) navigateToThreadTab(router, activate);
}

export function activateRelativeThreadTab(router: AnyRouter, delta: 1 | -1): void {
  const key = relativeThreadTab(readLiveThreadTabs(), delta);
  if (key !== null) activateThreadTab(router, key);
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
      "threadTab.reopen": run(() => reopenClosedThreadTab(router)),
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
