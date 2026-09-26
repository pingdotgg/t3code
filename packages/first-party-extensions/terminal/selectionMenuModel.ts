/**
 * Pure model for the terminal's selection popup and right-click menu, ported
 * from the native terminal drawer (`terminalSelectionMenuItems`,
 * `terminalContextMenuItems`, and its request-id supersession). The DOM half
 * lives in `selectionMenu.tsx`.
 *
 * "Add to chat" is offered only while the composer this client hosts accepts
 * terminal excerpts (`t3.composer/context.insertTerminalContext`), the
 * plugin's equivalent of the native drawer having a chat target.
 */

export type TerminalMenuAction = "add-to-chat" | "copy" | "paste";

export interface TerminalMenuItem<T extends TerminalMenuAction = TerminalMenuAction> {
  readonly id: T;
  readonly label: string;
  readonly disabled?: boolean;
}

export interface TerminalMenuPoint {
  readonly x: number;
  readonly y: number;
}

/** Post-selection popup: available selection actions, always enabled. */
export function terminalSelectionMenuItems(options?: {
  canAddToChat?: boolean;
}): TerminalMenuItem<"add-to-chat" | "copy">[] {
  return [
    ...(options?.canAddToChat === false
      ? []
      : [{ id: "add-to-chat", label: "Add to chat" } as const]),
    { id: "copy", label: "Copy" },
  ];
}

/**
 * Right-click menu: the selection actions (disabled until a selection exists)
 * plus Paste. Paste is always offered — the browser's own menu can only paste
 * into an editable element, so a canvas terminal never gets a usable entry.
 */
export function terminalContextMenuItems(options: {
  hasSelection: boolean;
  canAddToChat?: boolean;
}): TerminalMenuItem[] {
  const { hasSelection, canAddToChat = true } = options;
  return [
    ...terminalSelectionMenuItems({ canAddToChat }).map((item) => ({
      ...item,
      disabled: !hasSelection,
    })),
    { id: "paste", label: "Paste" },
  ];
}

/** The excerpt "Add to chat" sends: the native `TerminalContextSelection`. */
export interface TerminalChatSelection {
  readonly terminalId: string;
  readonly terminalLabel: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly text: string;
}

/**
 * `t3.composer/context.insertTerminalContext` input bounds, in UTF-16 code
 * units: the server adapter's schema checks `string.length`, which is stricter
 * than the broker's code-point count for astral text.
 */
export const TERMINAL_CHAT_TEXT_MAX_CHARS = 10_000;
export const TERMINAL_CHAT_LABEL_MAX_CHARS = 128;

/** 1-based line range of a selection given in 0-based screen rows, as in native. */
export function terminalSelectionLineRange(position: {
  start: { y: number };
  end: { y: number };
}): { lineStart: number; lineEnd: number } {
  const lineStart = position.start.y + 1;
  return { lineStart, lineEnd: Math.max(lineStart, position.end.y + 1) };
}

/**
 * The excerpt for the live selection, normalized as native does (CRLF folded,
 * leading/trailing blank lines dropped; inner lines and indentation kept).
 * Null when there is no position or nothing but newlines was selected.
 */
export function buildTerminalChatSelection(input: {
  terminalId: string;
  terminalLabel: string;
  text: string;
  position: { start: { y: number }; end: { y: number } } | null;
}): TerminalChatSelection | null {
  const text = normalizeSelectionText(input.text);
  if (input.position === null || text.length === 0) return null;
  const label = input.terminalLabel.trim() || "Terminal";
  return {
    terminalId: input.terminalId,
    terminalLabel: truncateUtf16(label, TERMINAL_CHAT_LABEL_MAX_CHARS),
    ...terminalSelectionLineRange(input.position),
    text,
  };
}

/**
 * Native sends any length; the composer contract caps an excerpt at 10,000
 * and a label at 128, counted in UTF-16 units as the server adapter's schema
 * counts them. Refuse rather than cut, so a chip never claims lines it does
 * not hold and the limit is named here instead of in a generic host rejection.
 */
export function terminalChatSelectionError(selection: TerminalChatSelection): string | null {
  if (selection.text.length > TERMINAL_CHAT_TEXT_MAX_CHARS) {
    return "Selection is too long to add to chat (10,000 characters at most).";
  }
  if (selection.terminalLabel.length > TERMINAL_CHAT_LABEL_MAX_CHARS) {
    return "Terminal name is too long to add to chat (128 characters at most).";
  }
  return null;
}

/**
 * Runs a chosen "Add to chat". Native clears the selection once the excerpt is
 * in the chat, duplicate or not, and leaves focus to the composer, which takes
 * it after its insert. A failure is reported in the terminal and focus stays
 * there. Once a newer flow is current (it may own a newer selection) the
 * completion does nothing at all.
 */
export async function addTerminalSelectionToChat(options: {
  selection: TerminalChatSelection;
  insert: (selection: TerminalChatSelection) => Promise<unknown>;
  isCurrent: () => boolean;
  clearSelection: () => void;
  focusTerminal: () => void;
  reportError: (message: string) => void;
}): Promise<void> {
  try {
    const tooLong = terminalChatSelectionError(options.selection);
    if (tooLong !== null) throw new Error(tooLong);
    await options.insert(options.selection);
  } catch (error) {
    if (!options.isCurrent()) return;
    options.reportError(
      error instanceof Error ? error.message : "Unable to add the terminal selection to chat",
    );
    options.focusTerminal();
    return;
  }
  if (options.isCurrent()) options.clearSelection();
}

/**
 * Whether the composer this client hosts accepts terminal excerpts. Probes
 * again on each `refresh()` until the answer is yes, so a composer that
 * connects after the pane mounted is picked up by the next menu.
 */
export class TerminalChatTarget {
  private availableValue = false;
  private probing = false;
  private readonly probe: () => Promise<boolean>;

  constructor(probe: () => Promise<boolean>) {
    this.probe = probe;
  }

  get available(): boolean {
    return this.availableValue;
  }

  refresh(): void {
    if (this.availableValue || this.probing) return;
    this.probing = true;
    void this.probe()
      .then(
        (available) => {
          this.availableValue = available;
        },
        () => {},
      )
      .finally(() => {
        this.probing = false;
      });
  }
}

/** Popup anchor: the release pointer, else the selection end, kept inside the pane. */
export function resolveSelectionActionPosition(options: {
  bounds: { left: number; top: number; width: number; height: number };
  selectionRect: { right: number; bottom: number } | null;
  pointer: TerminalMenuPoint | null;
  viewport: { width: number; height: number };
}): TerminalMenuPoint {
  const { bounds, selectionRect, pointer, viewport } = options;
  const preferred = pointer ?? {
    x: selectionRect?.right ?? bounds.left + bounds.width - 140,
    y: selectionRect ? selectionRect.bottom + 4 : bounds.top + 12,
  };
  return {
    x: Math.max(
      8,
      Math.min(Math.max(bounds.left, preferred.x), bounds.left + bounds.width, viewport.width - 8),
    ),
    y: Math.max(
      8,
      Math.min(Math.max(bounds.top, preferred.y), bounds.top + bounds.height, viewport.height - 8),
    ),
  };
}

/** Keeps a measured menu fully inside the viewport, `margin` px from each edge. */
export function clampMenuToViewport(options: {
  point: TerminalMenuPoint;
  size: { width: number; height: number };
  viewport: { width: number; height: number };
  margin?: number;
}): TerminalMenuPoint {
  const { point, size, viewport, margin = 4 } = options;
  return {
    x: Math.min(Math.max(margin, point.x), Math.max(margin, viewport.width - size.width - margin)),
    y: Math.min(
      Math.max(margin, point.y),
      Math.max(margin, viewport.height - size.height - margin),
    ),
  };
}

export interface TerminalMenuState {
  readonly requestId: number;
  readonly kind: "selection" | "context";
  readonly items: readonly TerminalMenuItem[];
  readonly position: TerminalMenuPoint;
  /** Selection captured when the menu opened; Copy writes this, like native. */
  readonly clipboardText: string | null;
  /** Excerpt captured when the menu opened; Add to chat sends this, like native. */
  readonly chatSelection: TerminalChatSelection | null;
}

export interface TerminalMenuChoice {
  readonly action: TerminalMenuAction;
  readonly requestId: number;
  readonly clipboardText: string | null;
  readonly chatSelection: TerminalChatSelection | null;
}

interface TerminalMenuOpenInput {
  readonly selectionText: string | null;
  readonly chatSelection?: TerminalChatSelection | null;
  readonly position: TerminalMenuPoint;
}

/**
 * Monotonic request-id supersession, as in the native drawer. Every flow
 * (popup or right-click) carries the id current when it opened; any async
 * completion checks `isCurrent` and goes silent — no error message, no focus
 * steal — once a newer flow has started.
 */
export class TerminalSelectionMenuFlow {
  private requestId = 0;
  private open: TerminalMenuState | null = null;
  private readonly onChange: (menu: TerminalMenuState | null) => void;
  private readonly canAddToChat: () => boolean;

  constructor(
    onChange: (menu: TerminalMenuState | null) => void = () => {},
    options?: { canAddToChat?: () => boolean },
  ) {
    this.onChange = onChange;
    this.canAddToChat = options?.canAddToChat ?? (() => false);
  }

  get menu(): TerminalMenuState | null {
    return this.open;
  }

  isCurrent(requestId: number): boolean {
    return requestId === this.requestId;
  }

  /** A right-click supersedes a pending or open popup and any in-flight action. */
  openContextMenu(input: TerminalMenuOpenInput): TerminalMenuState {
    const selectionText = nonEmpty(input.selectionText);
    const chatSelection = selectionText === null ? null : (input.chatSelection ?? null);
    return this.show({
      requestId: ++this.requestId,
      kind: "context",
      items: withChatAvailability(
        terminalContextMenuItems({
          hasSelection: selectionText !== null,
          canAddToChat: this.canAddToChat(),
        }),
        chatSelection,
      ),
      position: input.position,
      clipboardText: selectionText,
      chatSelection,
    });
  }

  /**
   * Opens the post-selection popup. A current popup stays as is (a repeated
   * selection-end must not reopen it); an empty selection opens nothing.
   */
  openSelectionPopup(input: TerminalMenuOpenInput): TerminalMenuState | null {
    if (this.ownsOpenMenu("selection")) return this.open;
    const selectionText = nonEmpty(input.selectionText);
    if (selectionText === null) {
      this.supersede();
      return null;
    }
    const chatSelection = input.chatSelection ?? null;
    return this.show({
      requestId: ++this.requestId,
      kind: "selection",
      items: withChatAvailability(
        terminalSelectionMenuItems({ canAddToChat: this.canAddToChat() }),
        chatSelection,
      ),
      position: input.position,
      clipboardText: selectionText,
      chatSelection,
    });
  }

  /**
   * Resolves a click on an item of the menu opened as `requestId`. A stale
   * menu, a disabled item, or a missing selection resolves to null. The menu
   * closes but the id stays current, so the action it starts can still report
   * and return focus unless a newer flow supersedes it.
   */
  choose(requestId: number, action: TerminalMenuAction): TerminalMenuChoice | null {
    const menu = this.open;
    if (menu === null || menu.requestId !== requestId || !this.isCurrent(requestId)) return null;
    const item = menu.items.find((candidate) => candidate.id === action);
    this.close();
    if (!item || item.disabled === true) return null;
    if (action !== "paste" && menu.clipboardText === null) return null;
    if (action === "add-to-chat" && menu.chatSelection === null) return null;
    return {
      action,
      requestId,
      clipboardText: menu.clipboardText,
      chatSelection: menu.chatSelection,
    };
  }

  /**
   * Passive cancellation (Escape, outside click, scroll, blur): closes the
   * open menu. It only invalidates the id when the menu it closes is current,
   * so it can never cancel a newer flow's in-flight action.
   */
  dismiss(): void {
    if (this.open === null) return;
    if (this.isCurrent(this.open.requestId)) this.requestId += 1;
    this.close();
  }

  /** Active cancellation: invalidates every flow, open or in flight. */
  supersede(): void {
    this.requestId += 1;
    this.close();
  }

  /**
   * An emptied selection may only cancel a selection flow that is still
   * current — a pending popup timer, or the open popup. A right-click menu
   * keeps the text it captured.
   */
  shouldClearOnEmptySelection(popupPending: boolean): boolean {
    return popupPending || this.ownsOpenMenu("selection");
  }

  private ownsOpenMenu(kind: TerminalMenuState["kind"]): boolean {
    return this.open?.kind === kind && this.isCurrent(this.open.requestId);
  }

  private show(menu: TerminalMenuState): TerminalMenuState {
    this.open = menu;
    this.onChange(menu);
    return menu;
  }

  private close(): void {
    if (this.open === null) return;
    this.open = null;
    this.onChange(null);
  }
}

/**
 * A selection with no resolvable line range cannot be sent; its Add to chat is
 * disabled. Native opens no popup at all for such a selection, and disables
 * Copy with it in the right-click menu; the plugin keeps Copy usable.
 */
function withChatAvailability(
  items: TerminalMenuItem[],
  chatSelection: TerminalChatSelection | null,
): TerminalMenuItem[] {
  if (chatSelection !== null) return items;
  return items.map((item) => (item.id === "add-to-chat" ? { ...item, disabled: true } : item));
}

/** Cuts to `max` UTF-16 units without leaving half a surrogate pair. */
function truncateUtf16(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

function normalizeSelectionText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
}

function nonEmpty(text: string | null): string | null {
  if (text === null) return null;
  // Native gates on the trimmed text but copies the raw selection.
  return normalizeSelectionText(text).length > 0 ? text : null;
}
