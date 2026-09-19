/**
 * Left-edge hover peek: while the sidebar is collapsed, resting the pointer on
 * the window's left edge floats it back over the content without reopening it.
 * The layout gap stays zero throughout, so the main pane never reflows.
 */

/** Pointer dwell required on the edge before peeking, so passing sweeps miss. */
export const SIDEBAR_HOVER_PEEK_OPEN_DELAY_MS = 110;

/** Grace after leaving the panel, so clipping its corner does not dismiss it. */
export const SIDEBAR_HOVER_PEEK_CLOSE_DELAY_MS = 180;

/** Slack to the right of the panel that still counts as "on" it. */
export const SIDEBAR_HOVER_PEEK_REGION_SLACK_PX = 12;

/**
 * Matches a control whose menu or popover is open. Queried within the peeked
 * panel only: a row's menu portals outside the panel, so the pointer sitting on
 * it reads as "outside", and collapsing the panel would pull the anchor out
 * from under it. Menus elsewhere in the app must not hold the panel open.
 *
 * `aria-expanded` rather than Base UI's `data-popup-open`, which tooltips set
 * too: a focused row button showing its tooltip would pin the panel open.
 * `aria-haspopup` keeps expanded disclosures, such as the settled shelf, out.
 */
export const SIDEBAR_HOVER_PEEK_HOLD_OPEN_SELECTOR = '[aria-haspopup][aria-expanded="true"]';

/**
 * Peek is a mouse affordance. Touch reports a tap as a hover and would open the
 * panel on every tap near the edge; pen behaves the same way.
 */
export function isHoverPeekPointerType(pointerType: string): boolean {
  return pointerType === "mouse" || pointerType === "";
}

export function shouldClosePeekForPointer(input: {
  pointerX: number;
  panelWidth: number;
  holdOpen: boolean;
}): boolean {
  if (input.holdOpen) return false;
  return input.pointerX > input.panelWidth + SIDEBAR_HOVER_PEEK_REGION_SLACK_PX;
}
