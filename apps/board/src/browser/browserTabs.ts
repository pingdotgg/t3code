import { Atom, type AtomRegistry } from "effect/reactivity";

import { newId } from "../state/boards";
import { filesViewAtom, showBoard, showSurface } from "../state/filesView";
import { appAtomRegistry } from "../state/registry";
import { browserHost } from "./host";
import {
  EMPTY_TABS,
  normalizeUrl,
  tabForUrl,
  tabsReducer,
  type TabsAction,
  type TabsState,
} from "./tabs";

export interface AgentTabRef {
  readonly threadId: string;
  readonly tabId: string;
}

export interface BrowserState {
  /** The user's native pages, which exist only inside Electron. */
  readonly tabs: TabsState;
  /** Whether the agent tabs view is open as a main-view tab. */
  readonly agents: boolean;
  readonly agentTab: AgentTabRef | null;
}

export const browserAtom = Atom.make<BrowserState>({
  tabs: EMPTY_TABS,
  agents: false,
  agentTab: null,
}).pipe(Atom.keepAlive, Atom.withLabel("browser-tabs"));

const change = (registry: AtomRegistry.AtomRegistry, next: (state: BrowserState) => BrowserState) =>
  registry.set(browserAtom, next(registry.get(browserAtom)));

/** Runs a tab action on the list and tells the main process which page is now active. */
export function dispatchTabs(registry: AtomRegistry.AtomRegistry, action: TabsAction): TabsState {
  const tabs = tabsReducer(registry.get(browserAtom).tabs, action);
  change(registry, (state) => ({ ...state, tabs }));
  if (action.type !== "update") browserHost?.activate(tabs.activeId);
  return tabs;
}

/** Shows a page tab in the main view. */
export function activateTab(registry: AtomRegistry.AtomRegistry, id: string): void {
  dispatchTabs(registry, { type: "activate", id });
  showSurface(registry, "page");
}

export function openTab(registry: AtomRegistry.AtomRegistry, url: string): void {
  const id = newId();
  browserHost?.open(id, url);
  dispatchTabs(registry, { type: "open", id, url });
  showSurface(registry, "page");
}

export function closeTab(registry: AtomRegistry.AtomRegistry, id: string): void {
  browserHost?.close(id);
  const { activeId } = dispatchTabs(registry, { type: "close", id });
  // The last page closing leaves nothing for the main view to show but the board.
  if (activeId === null && registry.get(filesViewAtom).surface === "page") showBoard(registry);
}

export function showAgents(registry: AtomRegistry.AtomRegistry): void {
  change(registry, (state) => ({ ...state, agents: true }));
  showSurface(registry, "agents");
}

export function closeAgents(registry: AtomRegistry.AtomRegistry): void {
  change(registry, (state) => ({ ...state, agents: false }));
  if (registry.get(filesViewAtom).surface === "agents") showBoard(registry);
}

export function selectAgentTab(registry: AtomRegistry.AtomRegistry, agentTab: AgentTabRef | null) {
  change(registry, (state) => ({ ...state, agentTab }));
}

/** Shows the browser: the active page, a blank one when none is open, or the agent tabs where there are no pages. */
export function showBrowser(registry: AtomRegistry.AtomRegistry): void {
  const { tabs } = registry.get(browserAtom);
  if (browserHost === null) showAgents(registry);
  else if (tabs.activeId === null) openTab(registry, "");
  else activateTab(registry, tabs.activeId);
}

/** Opens a link in a page tab of the main view, or shows the tab that already holds it. Without Electron there are no page tabs, so the link goes to the system browser. */
export function openInBrowser(url: string, registry: AtomRegistry.AtomRegistry = appAtomRegistry) {
  const target = normalizeUrl(url);
  if (target === null) return;
  if (browserHost === null) {
    window.open(target, "_blank", "noopener,noreferrer");
    return;
  }
  const existing = tabForUrl(registry.get(browserAtom).tabs, target);
  if (existing === null) openTab(registry, target);
  else activateTab(registry, existing.id);
}

browserHost?.onTabState(({ id, ...patch }) =>
  dispatchTabs(appAtomRegistry, { type: "update", id, patch }),
);
