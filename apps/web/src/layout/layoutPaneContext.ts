import { createContext, use, useLayoutEffect, useRef } from "react";
import { BackgroundThreadContext } from "../components/chat/backgroundThread";

/**
 * Only the focused chat handles global input; only visible chats count as visited.
 * Outside a layout host, the default is one focused, visible view.
 */
export interface LayoutPaneState {
  readonly tabId: string | null;
  /** The pane the tab sits in; its notch lists the pane's other tabs. */
  readonly paneId: string | null;
  /**
   * Several panes share the strip: each draws its own pane, so window-anchored
   * header controls anchor to the pane instead.
   */
  readonly split: boolean;
  /** The pane is too narrow for the right panel beside the chat; it opens as a sheet. */
  readonly narrow: boolean;
  /**
   * The pane touches the window's top-left corner, where the collapsed
   * sidebar's toggle and the macOS traffic lights sit.
   */
  readonly leadingEdge: boolean;
  /**
   * The pane touches the window's top-right corner, where the Windows and
   * Linux caption buttons sit.
   */
  readonly trailingEdge: boolean;
  /** The pane holds keyboard focus; the URL follows this tab. Exactly one pane does. */
  readonly focused: boolean;
  /**
   * A chat whose thread's surface tab has focus. It answers only the thread's
   * own commands (`RELATED_CHAT_COMMANDS`) and lends the surface its
   * composer; DOM focus and every other shortcut belong to the focused surface.
   */
  readonly related: boolean;
  /** The tab is on screen: the active tab of a pane in the focused workspace. */
  readonly visible: boolean;
}

const LONE_PANE: LayoutPaneState = {
  tabId: null,
  paneId: null,
  split: false,
  narrow: false,
  leadingEdge: true,
  trailingEdge: true,
  focused: true,
  related: false,
  visible: true,
};

export const LayoutPaneContext = createContext<LayoutPaneState>(LONE_PANE);

export function useLayoutPane(): LayoutPaneState {
  return use(LayoutPaneContext);
}

/**
 * For window and document listeners: read `.current` when the event fires so
 * a focus change does not have to re-subscribe every handler.
 */
export function useLayoutPaneFocusedRef(): React.RefObject<boolean> {
  const { focused } = useLayoutPane();
  const background = use(BackgroundThreadContext);
  const active = focused && !background;
  const ref = useRef(active);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes committed pane ownership to the ref read by window-level keyboard listeners
  useLayoutEffect(() => {
    ref.current = active;
  }, [active]);
  return ref;
}

/**
 * As `useLayoutPaneFocusedRef`, also true while related: for listeners that
 * answer the thread's own commands from its focused surface tab.
 */
export function useLayoutPaneOwnsThreadRef(): React.RefObject<boolean> {
  const { focused, related } = useLayoutPane();
  const background = use(BackgroundThreadContext);
  const active = (focused || related) && !background;
  const ref = useRef(active);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Publish committed related-pane ownership for thread command listeners without resubscribing them.
  useLayoutEffect(() => {
    ref.current = active;
  }, [active]);
  return ref;
}

/**
 * The thread-scoped commands a related chat still answers for its focused
 * surface tab: its panel toggles and opening its folder in the editor.
 */
export const RELATED_CHAT_COMMANDS: ReadonlySet<string> = new Set([
  "terminal.toggle",
  "rightPanel.toggle",
  "diff.toggle",
  "threadPanel.toggle",
  "preview.toggle",
  "editor.openFavorite",
]);

/** The focused pane taking the keyboard back (see `returnKeyboardToFocusedPane`). */
let focusedPaneTakesKeyboard: (() => void) | null = null;

/** The focused pane registers how it takes the keyboard; returns the way to let go. */
export function holdFocusedPaneKeyboard(take: () => void): () => void {
  focusedPaneTakesKeyboard = take;
  return () => {
    if (focusedPaneTakesKeyboard === take) focusedPaneTakesKeyboard = null;
  };
}

/**
 * A closing palette hands the keyboard to the focused pane, which may have
 * changed under it (Open beside… puts a surface tab there). False with no
 * layout pane focused.
 */
export function returnKeyboardToFocusedPane(): boolean {
  if (!focusedPaneTakesKeyboard) return false;
  focusedPaneTakesKeyboard();
  return true;
}
