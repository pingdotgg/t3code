const CANDIDATE_SURFACE_SELECTOR = [
  "[data-composer-command-menu]",
  '[data-slot="command-dialog-popup"]',
  '[data-slot="command-list"]',
  '[data-slot="combobox-popup"]',
  '[data-slot="autocomplete-popup"]',
  '[data-slot="select-popup"]',
  '[data-slot="menu-popup"]',
  '[role="listbox"]',
].join(",");

type SelectionNavigationKey = "ArrowDown" | "ArrowUp";

const SURFACE_SLOT_BY_TRIGGER_SLOT: Readonly<Record<string, string>> = {
  "autocomplete-trigger": "autocomplete-popup",
  "combobox-trigger": "combobox-popup",
  "menu-trigger": "menu-popup",
  "select-trigger": "select-popup",
};

function resolveSelectionNavigationKey(event: KeyboardEvent): SelectionNavigationKey | null {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    !event.ctrlKey ||
    event.altKey ||
    event.metaKey ||
    event.shiftKey
  ) {
    return null;
  }

  const key = event.key.toLowerCase();
  if (key === "n") return "ArrowDown";
  if (key === "p") return "ArrowUp";
  return null;
}

function candidateSurfaceBelongsToFocus(
  surface: HTMLElement,
  focusedElement: Element | null,
  document: Document,
): boolean {
  if (!focusedElement) return false;
  if (surface.contains(focusedElement)) return true;

  const controlledIds = focusedElement.getAttribute("aria-controls")?.split(/\s+/) ?? [];
  if (surface.id && controlledIds.includes(surface.id)) return true;

  const triggerSlot = focusedElement.getAttribute("data-slot");
  const surfaceSlot = surface.getAttribute("data-slot");
  if (
    focusedElement.getAttribute("aria-expanded") === "true" &&
    triggerSlot !== null &&
    surfaceSlot === SURFACE_SLOT_BY_TRIGGER_SLOT[triggerSlot]
  ) {
    return true;
  }

  if (
    surface.hasAttribute("data-composer-command-menu") &&
    focusedElement.closest('[data-chat-composer-form="true"]') !== null
  ) {
    return true;
  }

  // Some non-portaled pickers render beside their controlling input without
  // an aria-controls relationship. Accept a nearby shared container, but do
  // not climb as far as body where an unrelated open picker could match.
  let container = surface.parentElement;
  for (let depth = 0; container && depth < 6; depth += 1) {
    if (container === document.body) return false;
    if (container.contains(focusedElement)) return true;
    container = container.parentElement;
  }
  return false;
}

function isCandidateSelectionOpen(document: Document, eventTarget: EventTarget | null): boolean {
  const focusedElement =
    document.activeElement instanceof Element
      ? document.activeElement
      : eventTarget instanceof Element
        ? eventTarget
        : null;

  return Array.from(document.querySelectorAll<HTMLElement>(CANDIDATE_SURFACE_SELECTOR)).some(
    (surface) =>
      !surface.hidden &&
      surface.getAttribute("aria-hidden") !== "true" &&
      candidateSurfaceBelongsToFocus(surface, focusedElement, document),
  );
}

function dispatchSelectionNavigation(event: KeyboardEvent, key: SelectionNavigationKey): void {
  event.preventDefault();
  event.stopImmediatePropagation();

  const document = (event.target as Node | null)?.ownerDocument ?? globalThis.document;
  const target =
    document.activeElement instanceof HTMLElement ? document.activeElement : event.target;
  if (!(target instanceof EventTarget)) return;

  const KeyboardEventConstructor = document.defaultView?.KeyboardEvent ?? KeyboardEvent;
  target.dispatchEvent(
    new KeyboardEventConstructor("keydown", {
      bubbles: true,
      cancelable: true,
      code: key,
      key,
      repeat: event.repeat,
    }),
  );
}

export function handleSelectionNavigationKeyDown(event: KeyboardEvent): void {
  const key = resolveSelectionNavigationKey(event);
  if (!key || !(event.target instanceof Element)) return;
  if (
    event.target.closest("[data-terminal-owner]") !== null ||
    event.target.closest("[data-keybinding-capture]") !== null
  ) {
    return;
  }

  const document = (event.target as Node).ownerDocument;
  if (!document) return;
  if (!isCandidateSelectionOpen(document, event.target)) return;
  dispatchSelectionNavigation(event, key);
}
