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

/**
 * composer.mode marks the trigger it opens; the menu's onOpenChangeComplete then moves focus
 * to the checked permission in that menu's own popup, after the menu placed its own focus.
 */
export function markOpenToPermissions(trigger: HTMLElement): void {
  trigger.dataset.openToPermissions = "true";
}

export function focusRequestedPermission(open: boolean, trigger: HTMLElement | null): void {
  if (!trigger?.dataset.openToPermissions) return;
  delete trigger.dataset.openToPermissions;
  if (open) focusCheckedPermission(trigger);
}

/** Focuses the checked permission in the menu this trigger opened. */
export function focusCheckedPermission(trigger: HTMLElement | null): void {
  const popupId = trigger?.getAttribute("aria-controls");
  const popup = popupId ? document.getElementById(popupId) : null;
  popup
    ?.querySelector<HTMLElement>("[data-composer-permissions] [aria-checked='true']")
    ?.focus({ preventScroll: true });
}

/**
 * composer.effort marks the model picker trigger it opens; the picker then moves focus to the
 * selected effort level once its popup is open.
 */
export function markOpenToEffort(trigger: HTMLElement): void {
  trigger.dataset.openToEffort = "true";
}

/** Reads and clears an open-to mark: effort from composer.effort, permissions from composer.mode. */
export function takeOpenTarget(trigger: HTMLElement | null): "effort" | "permissions" | null {
  if (trigger?.dataset.openToEffort) {
    delete trigger.dataset.openToEffort;
    return "effort";
  }
  if (trigger?.dataset.openToPermissions) {
    delete trigger.dataset.openToPermissions;
    return "permissions";
  }
  return null;
}
