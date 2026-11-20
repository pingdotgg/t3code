import { Atom, type AtomRegistry } from "effect/reactivity";

import { newId } from "../state/boards";
import { appAtomRegistry } from "../state/registry";
import { browserHost } from "./host";
import { EMPTY_TABS, normalizeUrl, tabsReducer, type TabsAction, type TabsState } from "./tabs";

export type PanelView = "tabs" | "agents";

export interface AgentTabRef {
  readonly threadId: string;
  readonly tabId: string;
}

export interface PanelState {
  readonly open: boolean;
  readonly view: PanelView;
  readonly width: number;
  readonly tabs: TabsState;
  readonly agentTab: AgentTabRef | null;
}

export const PANEL_MIN_WIDTH = 320;
export const PANEL_DEFAULT_WIDTH = 420;

export const panelAtom = Atom.make<PanelState>({
  open: false,
  view: browserHost === null ? "agents" : "tabs",
  width: PANEL_DEFAULT_WIDTH,
  tabs: EMPTY_TABS,
  agentTab: null,
}).pipe(Atom.keepAlive, Atom.withLabel("browser-panel"));

const change = (registry: AtomRegistry.AtomRegistry, next: (state: PanelState) => PanelState) =>
  registry.set(panelAtom, next(registry.get(panelAtom)));

/** Runs a tab action on the list and tells the main process which page is now active. */
export function dispatchTabs(registry: AtomRegistry.AtomRegistry, action: TabsAction): TabsState {
  const tabs = tabsReducer(registry.get(panelAtom).tabs, action);
  change(registry, (state) => ({ ...state, tabs }));
  if (action.type !== "update") browserHost?.activate(tabs.activeId);
  return tabs;
}

export function openTab(registry: AtomRegistry.AtomRegistry, url: string): void {
  const id = newId();
  browserHost?.open(id, url);
  dispatchTabs(registry, { type: "open", id, url });
}

export function closeTab(registry: AtomRegistry.AtomRegistry, id: string): void {
  browserHost?.close(id);
  dispatchTabs(registry, { type: "close", id });
}

export function setPanelView(registry: AtomRegistry.AtomRegistry, view: PanelView): void {
  change(registry, (state) => ({ ...state, view }));
}

export function togglePanel(registry: AtomRegistry.AtomRegistry): void {
  change(registry, (state) => ({ ...state, open: !state.open }));
}

export function closePanel(registry: AtomRegistry.AtomRegistry): void {
  change(registry, (state) => ({ ...state, open: false }));
}

export function setPanelWidth(registry: AtomRegistry.AtomRegistry, width: number): void {
  change(registry, (state) => ({ ...state, width }));
}

export function selectAgentTab(registry: AtomRegistry.AtomRegistry, agentTab: AgentTabRef | null) {
  change(registry, (state) => ({ ...state, agentTab }));
}

/** Opens a link in a new tab of the panel. Without Electron there is no panel tab, so the link goes to the system browser. */
export function openInPanel(url: string, registry: AtomRegistry.AtomRegistry = appAtomRegistry) {
  const target = normalizeUrl(url);
  if (target === null) return;
  if (browserHost === null) {
    window.open(target, "_blank", "noopener,noreferrer");
    return;
  }
  openTab(registry, target);
  change(registry, (state) => ({ ...state, open: true, view: "tabs" }));
}

browserHost?.onTabState(({ id, ...patch }) =>
  dispatchTabs(appAtomRegistry, { type: "update", id, patch }),
);
