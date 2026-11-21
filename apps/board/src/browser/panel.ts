import { Atom, type AtomRegistry } from "effect/reactivity";

import { appAtomRegistry } from "../state/registry";

/** The panel's tabs. Later tabs join this list and the strip, and this one does not move. */
export const PANEL_TABS = ["chat", "ticket", "explorer", "changes", "checks"] as const;
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

const checksShown = (state: PanelState) => state.open && state.tab === "checks";

let awaitingChecksPaint = false;

/** Marks the Checks tab coming into view, which pairs with the one paint that follows it. */
const change = (registry: AtomRegistry.AtomRegistry, next: (state: PanelState) => PanelState) => {
  const before = registry.get(panelAtom);
  const after = next(before);
  if (checksShown(after) && !checksShown(before)) {
    performance.mark("board:checks-open");
    awaitingChecksPaint = true;
  } else if (!checksShown(after)) {
    awaitingChecksPaint = false;
  }
  registry.set(panelAtom, after);
};

/** Marks the frame that drew the Checks tab's rows, once for each time the tab came into view. */
export function markChecksPainted(): void {
  if (!awaitingChecksPaint) return;
  awaitingChecksPaint = false;
  performance.mark("board:checks-painted");
}

/** The agent the Ticket tab reads, with the ticket whose frame it opened from. */
export interface TicketChoice {
  readonly threadId: string | null;
  readonly ticketKey: string | null;
}

export const ticketChoiceAtom = Atom.make<TicketChoice | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("ticket-choice"),
);

let awaitingTicketPaint = false;

/** Shows the Ticket tab for a card, opening the panel when it is closed. */
export function chooseTicket(registry: AtomRegistry.AtomRegistry, choice: TicketChoice): void {
  performance.mark("board:ticket-open");
  awaitingTicketPaint = true;
  registry.set(ticketChoiceAtom, choice);
  showPanelTab(registry, "ticket");
}

/** Marks the frame that drew the Ticket tab after a card was chosen, once for each choice. */
export function markTicketPainted(): void {
  if (!awaitingTicketPaint) return;
  awaitingTicketPaint = false;
  performance.mark("board:ticket-painted");
}

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

/** Where the open board's ticket draws, which needs the board's model. */
export const ticketSlotAtom = Atom.make<HTMLElement | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("ticket-slot"),
);

export const attachTicketSlot = (node: HTMLElement | null) =>
  appAtomRegistry.set(ticketSlotAtom, node);

/** Where the open board's checks draw, which needs the board's pull request context. */
export const checksSlotAtom = Atom.make<HTMLElement | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("checks-slot"),
);

export const attachChecksSlot = (node: HTMLElement | null) =>
  appAtomRegistry.set(checksSlotAtom, node);
