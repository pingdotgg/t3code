import { useComposerHandleContext } from "../../composerHandleContext";

const COMPOSER_FLOATING_LAYER_SELECTOR = [
  '[data-composer-drawer-layer="true"]',
  '[data-chat-composer-floating-layer="true"]',
].join(",");

export const composerFloatingLayerProps = {
  "data-chat-composer-floating-layer": "true",
} as const;

export function useComposerMenuProps() {
  const composerRef = useComposerHandleContext();

  return {
    ...composerFloatingLayerProps,
    finalFocus: composerRef
      ? () => {
          const activeElement = document.activeElement;
          if (activeElement !== document.body && !isInsideComposerFloatingLayer(activeElement)) {
            return false;
          }
          composerRef.current?.focusAtEnd();
          return false;
        }
      : undefined,
  };
}

const EMBEDDED_CHAT_SELECTOR = "[data-chat-embedded]";

// Composer menus portal to document.body, so they have no chat ancestor. Focus
// inside one belongs to the chat that last had focus outside a floating layer.
let lastFocusedChat: Element | null = null;
if (typeof document !== "undefined") {
  document.addEventListener(
    "focusin",
    (event) => {
      if (!(event.target instanceof Element) || isInsideComposerFloatingLayer(event.target)) {
        return;
      }
      lastFocusedChat = event.target.closest(EMBEDDED_CHAT_SELECTOR);
    },
    true,
  );
}

function chatIdOf(element: Element | null): string | null {
  return element?.getAttribute("data-chat-embedded") ?? null;
}

/**
 * The thread id of the side chat that owns `target`, or null for the host
 * chat. A side chat's composer renders in the host's composer slot while it
 * has focus, so ownership is the attribute's value, not one root element.
 */
export function chatViewOf(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  if (isInsideComposerFloatingLayer(target)) return chatIdOf(lastFocusedChat);
  return chatIdOf(target.closest(EMBEDDED_CHAT_SELECTOR));
}

/**
 * Whether a window-level composer shortcut from `target` is for the composer
 * containing `own`. A side chat renders a second chat view inside the host's,
 * so only one composer may act. A key pressed in a side chat goes to its
 * composer; one pressed anywhere else goes to the composer on screen, which is
 * the side chat's while it has the host's composer (the host's is hidden then).
 */
export function composerTakesShortcut(target: EventTarget | null, own: Element | null): boolean {
  if (own === null) return false;
  const targetChat = chatViewOf(target);
  if (targetChat !== null) return targetChat === chatIdOf(own.closest(EMBEDDED_CHAT_SELECTOR));
  return own.closest("[hidden]") === null;
}

function isInsideComposerFloatingLayer(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(COMPOSER_FLOATING_LAYER_SELECTOR) !== null;
}

export function isInsideCollapsedComposerControls(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest('[data-chat-composer-collapsed-controls="true"]') !== null
  );
}

export function isInsideRestingComposerControlScope(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    (target.closest('[data-chat-composer-resting-controls="true"]') !== null ||
      target.closest('[data-chat-composer-resting-images="true"]') !== null ||
      target.closest("[data-composer-context-control]") !== null ||
      isInsideComposerFloatingLayer(target))
  );
}
