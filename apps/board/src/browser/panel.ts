import { Atom, type AtomRegistry } from "effect/reactivity";

import { appAtomRegistry } from "../state/registry";

/** The panel's tabs. Later tabs join this list and the strip, and this one does not move. */
export const PANEL_TABS = ["chat", "explorer", "changes"] as const;
export type PanelTab = (typeof PANEL_TABS)[number];

export interface PanelState {
  readonly open: boolean;
  readonly tab: PanelTab;
  readonly width: number;
}

export const PANEL_MIN_WIDTH = 320;
export const PANEL_DEFAULT_WIDTH = 420;

export const panelAtom = Atom.make<PanelState>({
  open: true,
  tab: "chat",
  width: PANEL_DEFAULT_WIDTH,
}).pipe(Atom.keepAlive, Atom.withLabel("side-panel"));

const change = (registry: AtomRegistry.AtomRegistry, next: (state: PanelState) => PanelState) =>
  registry.set(panelAtom, next(registry.get(panelAtom)));

export function setPanelTab(registry: AtomRegistry.AtomRegistry, tab: PanelTab): void {
  change(registry, (state) => ({ ...state, tab }));
}

export function showPanelTab(registry: AtomRegistry.AtomRegistry, tab: PanelTab): void {
  change(registry, (state) => ({ ...state, open: true, tab }));
}

export function togglePanel(registry: AtomRegistry.AtomRegistry): void {
  change(registry, (state) => ({ ...state, open: !state.open }));
}

export function setPanelWidth(registry: AtomRegistry.AtomRegistry, width: number): void {
  change(registry, (state) => ({ ...state, width }));
}

/** Where the open board's orchestrator chat draws, so the chat stays mounted whichever tab shows. */
export const chatSlotAtom = Atom.make<HTMLElement | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("chat-slot"),
);

// A stable function, so a re-render does not detach and attach the slot again.
export const attachChatSlot = (node: HTMLElement | null) => appAtomRegistry.set(chatSlotAtom, node);
