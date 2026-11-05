import type { KeybindingCommand } from "@t3tools/contracts";

import {
  isSurfaceLauncherKey,
  shouldRedirectInputToComposer,
  TYPE_TO_FOCUS_EDITABLE_SELECTOR,
  TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR,
} from "./components/chat/composerFocusRedirect";
import { effectiveShortcutsForCommand } from "./keybindings";
import { isMacPlatform } from "./lib/utils";
import { appAtomRegistry } from "./rpc/atomRegistry";
import { primaryServerKeybindingsAtom } from "./state/server";

const SEQUENCE_TIMEOUT = 1000;
const LINE_SCROLL = 60;
const AREA_SELECTOR = "[data-workspace-area]";
const LIST_SELECTOR =
  '[role="menu"], [role="listbox"], [role="tree"], [role="tablist"], [role="radiogroup"], [data-sidebar-row], [data-workspace-area="sidebar"], [data-workspace-area="settings-nav"]';
const COMPOSER_SELECTOR = '[data-workspace-area="composer"] [contenteditable="true"]';

/** Commands run through the user's own shortcut, so rebinding one rebinds this too. */
const KEY_COMMANDS: Readonly<Record<string, KeybindingCommand>> = {
  J: "thread.next",
  K: "thread.previous",
  H: "workspace.focusPrevious",
  L: "workspace.focusNext",
  ":": "commandPalette.toggle",
  "/": "chat.find",
  gb: "sidebar.toggle",
  gd: "diff.toggle",
  gf: "filePicker.toggle",
  gn: "chat.new",
  gr: "rightPanel.toggle",
  gt: "terminal.toggle",
};

const LIST_ARROWS: Readonly<Record<string, string>> = {
  h: "ArrowLeft",
  j: "ArrowDown",
  k: "ArrowUp",
  l: "ArrowRight",
};

function isScrollable(element: Element) {
  const { overflowY } = getComputedStyle(element);
  return (
    (overflowY === "auto" || overflowY === "scroll") && element.scrollHeight > element.clientHeight
  );
}

function scrollerInside(root: Element) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  for (let node = walker.currentNode; node; node = walker.nextNode()!) {
    if (node instanceof Element && isScrollable(node)) return node;
  }
  return null;
}

/** The pane the keyboard is in, falling back to the conversation. */
function activeScroller() {
  const active = document.activeElement;
  for (
    let element = active;
    element && element !== document.body;
    element = element.parentElement
  ) {
    if (isScrollable(element)) return element;
  }
  const roots = [
    active?.closest(AREA_SELECTOR),
    document.querySelector('[data-workspace-area="conversation"]'),
    document.querySelector("main"),
  ];
  for (const root of roots) {
    const scroller = root ? scrollerInside(root) : null;
    if (scroller) return scroller;
  }
  return null;
}

function runCommand(command: KeybindingCommand) {
  const keybindings = appAtomRegistry.get(primaryServerKeybindingsAtom);
  const shortcut = effectiveShortcutsForCommand(keybindings, command)[0];
  if (!shortcut) return;
  const mac = isMacPlatform(navigator.platform);
  (document.activeElement ?? document.body).dispatchEvent(
    new KeyboardEvent("keydown", {
      key: shortcut.key,
      metaKey: shortcut.metaKey || (shortcut.modKey && mac),
      ctrlKey: shortcut.ctrlKey || (shortcut.modKey && !mac),
      shiftKey: shortcut.shiftKey,
      altKey: shortcut.altKey,
      bubbles: true,
      cancelable: true,
    }),
  );
}

function pressArrow(element: Element, key: string) {
  element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

let pending = "";
let pendingAt = 0;

/** Returns whether the key was used. Editable targets belong to their own vim mode. */
export function handleVimNavigationKey(event: KeyboardEvent) {
  if (!event.isTrusted || event.defaultPrevented || event.isComposing) return false;
  if (event.metaKey || event.ctrlKey || event.altKey || [...event.key].length !== 1) return false;
  const target = event.target;
  if (!(target instanceof Element) || target.closest(TYPE_TO_FOCUS_EDITABLE_SELECTOR)) return false;
  if (isSurfaceLauncherKey(event)) return false;

  const active = document.activeElement;
  const list = active?.closest(LIST_SELECTOR);
  const arrow = LIST_ARROWS[event.key];
  if (active && list && arrow) {
    pressArrow(active, arrow);
    return true;
  }
  // Dialogs and popups own their keys, apart from moving through their lists above.
  if (document.querySelector(TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR)) return false;

  const sequence = Date.now() - pendingAt < SEQUENCE_TIMEOUT ? pending + event.key : event.key;
  pending = "";
  if (sequence === "g") {
    pending = "g";
    pendingAt = Date.now();
    return true;
  }
  const scroller = activeScroller();
  switch (sequence) {
    case "j":
      scroller?.scrollBy({ top: LINE_SCROLL });
      return true;
    case "k":
      scroller?.scrollBy({ top: -LINE_SCROLL });
      return true;
    case "d":
      scroller?.scrollBy({ top: scroller.clientHeight / 2 });
      return true;
    case "u":
      scroller?.scrollBy({ top: -scroller.clientHeight / 2 });
      return true;
    case "gg":
      scroller?.scrollTo({ top: 0 });
      return true;
    case "G":
      scroller?.scrollTo({ top: scroller.scrollHeight });
      return true;
    case "i":
      document.querySelector<HTMLElement>(COMPOSER_SELECTOR)?.focus();
      return true;
    default:
  }
  const command = KEY_COMMANDS[sequence];
  if (command) {
    runCommand(command);
    return true;
  }
  // Letters must not fall through to type-to-focus, or a mistyped key would land in the composer.
  return shouldRedirectInputToComposer(event);
}
