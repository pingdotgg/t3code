const COMPOSER_FLOATING_LAYER_SELECTOR = [
  '[data-composer-drawer-layer="true"]',
  '[data-chat-composer-floating-layer="true"]',
].join(",");
const COMPOSER_FOCUS_SCOPE_SELECTOR = [
  COMPOSER_FLOATING_LAYER_SELECTOR,
  '[data-chat-composer-focus-scope="true"]',
].join(",");

export const composerFloatingLayerProps = {
  "data-chat-composer-floating-layer": "true",
} as const;

export const composerFocusScopeProps = {
  "data-chat-composer-focus-scope": "true",
} as const;

export function isInsideComposerFloatingLayer(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(COMPOSER_FLOATING_LAYER_SELECTOR) !== null;
}

export function isInsideComposerFocusScope(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(COMPOSER_FOCUS_SCOPE_SELECTOR) !== null;
}

export function resolveDesktopComposerFocus(input: {
  currentFocused: boolean;
  composerForm: HTMLElement | null;
  target: EventTarget | null;
}): boolean {
  if (!input.currentFocused || !(input.target instanceof Node)) return false;
  return Boolean(
    input.composerForm?.contains(input.target) ||
    isInsideComposerFocusScope(input.target) ||
    isInsideRestingComposerControlScope(input.target),
  );
}

// Banners, the approval row, and the tasks badge dock above the surface. A
// pointer or focus landing on one of them acts on that control and must not
// expand a resting or collapsed composer.
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
