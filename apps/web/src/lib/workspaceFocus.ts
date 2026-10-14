import { dismissContextMenu } from "../contextMenuFallback";

const AREA_SELECTOR = "[data-workspace-area]";
const FOCUS_BOUNDARY_SELECTOR =
  '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open], [data-keybinding-capture], [data-slot$="-popup"]:not([data-slot="tooltip-popup"]):not([role="tooltip"])';
const FOCUSABLE_SELECTOR =
  'button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [contenteditable="true"], [tabindex]';

function workspaceArea(element: Element): HTMLElement | null {
  const area = element.closest<HTMLElement>(AREA_SELECTOR);
  if (area) return area;
  const root = element.getRootNode();
  return root instanceof ShadowRoot ? workspaceArea(root.host) : null;
}

export function isWorkspaceElementVisible(element: HTMLElement): boolean {
  if (
    !element.isConnected ||
    element.closest(
      '[hidden], [inert], [data-closed], [aria-hidden="true"], [data-chat-column-maximized-away="true"], [data-slot="sidebar"][data-state="collapsed"], [data-workspace-unavailable="true"]',
    )
  )
    return false;
  const style = getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") return false;
  const root = element.getRootNode();
  if (
    root instanceof ShadowRoot &&
    root.host instanceof HTMLElement &&
    !isWorkspaceElementVisible(root.host)
  )
    return false;
  return Array.from(element.getClientRects()).some((rect) => rect.width > 0 && rect.height > 0);
}

/** Keeps area focus local, like VS Code's layout service focusPart/visible-neighbour actions. */
export function createWorkspaceFocusController(doc: Document) {
  const lastFocused = new Map<string, HTMLElement>();
  let lastArea: string | undefined;
  const remember = (event: FocusEvent) => {
    if (!(event.target instanceof HTMLElement)) return;
    const area = workspaceArea(event.target);
    if (!area?.dataset.workspaceArea) return;
    lastArea = area.dataset.workspaceArea;
    const key = area.dataset.workspaceFocusKey ?? lastArea;
    lastFocused.delete(key);
    // Custom file trees retarget focusin to their nonfocusable shadow host.
    const target = event.composedPath().find((element) => element instanceof HTMLElement);
    lastFocused.set(key, target instanceof HTMLElement ? target : event.target);
    // Surface history must not retain an unbounded number of detached panel trees.
    if (lastFocused.size > 64) lastFocused.delete(lastFocused.keys().next().value!);
  };
  doc.addEventListener("focusin", remember);

  const focusArea = (area: HTMLElement, restore = true) => {
    const key = area.dataset.workspaceFocusKey ?? area.dataset.workspaceArea!;
    const previous = restore ? lastFocused.get(key) : undefined;
    const belongs = (element: HTMLElement) =>
      workspaceArea(element) === area &&
      isWorkspaceElementVisible(element) &&
      !element.matches(":disabled");
    const preferred = Array.from(
      area.querySelectorAll<HTMLElement>(
        '[data-workspace-focus-default], [role="treeitem"][tabindex="0"], [data-settings-section][tabindex="0"], .xterm-helper-textarea, [contenteditable="true"]',
      ),
    ).find(belongs);
    const fallback = Array.from(area.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).find(
      (element) => element.tabIndex >= 0 && belongs(element),
    );
    // Panel surfaces may unmount when hidden. Recover the same named control when
    // it mounts again, without sharing focus history between different surface tabs.
    const restored =
      previous && !previous.isConnected
        ? Array.from(area.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).find(
            (element) =>
              belongs(element) &&
              element.tagName === previous.tagName &&
              ((previous.id && element.id === previous.id) ||
                (previous.getAttribute("aria-label") &&
                  element.getAttribute("aria-label") === previous.getAttribute("aria-label")) ||
                (previous.matches("button") &&
                  previous.textContent?.trim() &&
                  element.textContent === previous.textContent)),
          )
        : undefined;
    const surface = area.querySelector<HTMLElement>("[data-right-panel-surface-content]");
    const surfaceControl = surface
      ? Array.from(surface.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).find(
          (element) => belongs(element) && element.tabIndex >= 0,
        )
      : undefined;
    const targets = new Set([
      previous && belongs(previous) ? previous : undefined,
      restored,
      preferred,
      surfaceControl,
      area.dataset.workspaceArea === "conversation" ? undefined : fallback,
      area,
    ]);
    for (const target of targets) {
      if (!target) continue;
      target.focus({ preventScroll: true });
      const root = target.getRootNode();
      const active = root instanceof ShadowRoot ? root.activeElement : doc.activeElement;
      if (active === target || (active && target.contains(active))) return true;
    }
    return false;
  };
  const focus = (name: string, restore = true, selector?: string) => {
    const areas = Array.from(doc.querySelectorAll<HTMLElement>(AREA_SELECTOR)).filter(
      isWorkspaceElementVisible,
    );
    const area =
      name === "content"
        ? (areas.find((element) => element.dataset.workspaceArea === "composer") ??
          areas.find(
            (element) =>
              element.dataset.workspaceArea === "pull-requests" || element.matches("main"),
          ) ??
          areas.find((element) => element.dataset.workspaceArea === "conversation") ??
          areas.find((element) => element.dataset.workspaceArea === "panel"))
        : areas.find((element) => element.dataset.workspaceArea === name);
    if (!area) return false;
    const surface = area.querySelector("[data-right-panel-surface-content]");
    // A lazy surface's Suspense fallback is empty. Wait for its content instead
    // of claiming focus on the tab strip before the useful controls mount.
    if (surface && !surface.hasChildNodes()) return false;
    if (selector) {
      const target = area.querySelector<HTMLElement>(selector);
      if (!target || !isWorkspaceElementVisible(target)) return false;
      target.focus({ preventScroll: true });
      return doc.activeElement === target;
    }
    return focusArea(area, restore);
  };
  const move = (direction: 1 | -1, fromArea?: string, closingPalette = false) => {
    // HTML context menus close on blur, unlike modal dialogs and Base UI popups.
    dismissContextMenu(false);
    // A palette closes before running its command. Other popups keep their focus boundary.
    // Inline listboxes (such as Settings search) belong to their workspace area, while
    // portalled listboxes and menus can also supply a boundary without a popup data-slot.
    const activePopup = doc.activeElement?.closest<HTMLElement>('[role="menu"], [role="listbox"]');
    const boundaries = Array.from(doc.querySelectorAll<HTMLElement>(FOCUS_BOUNDARY_SELECTOR));
    if (activePopup && !activePopup.closest(AREA_SELECTOR)) boundaries.push(activePopup);
    if (
      boundaries.some(
        (boundary) =>
          !(closingPalette && boundary.closest("[data-command-palette]")) &&
          // Base UI names notifications as non-modal dialogs, including anchored
          // toast popups. Their presence must not block navigation elsewhere.
          !(
            boundary.matches('[aria-modal="false"]:is([role="dialog"], [role="alertdialog"])') &&
            boundary.closest('[data-slot^="toast-viewport"]')
          ) &&
          isWorkspaceElementVisible(boundary),
      )
    )
      return false;
    const areas = Array.from(doc.querySelectorAll<HTMLElement>(AREA_SELECTOR))
      .filter(isWorkspaceElementVisible)
      .sort(
        (left, right) => Number(left.dataset.workspaceOrder) - Number(right.dataset.workspaceOrder),
      );
    if (areas.length === 0) return false;
    const activeArea = doc.activeElement?.closest<HTMLElement>(AREA_SELECTOR);
    const currentId = fromArea ?? activeArea?.dataset.workspaceArea ?? lastArea;
    const current = areas.findIndex((area) => area.dataset.workspaceArea === currentId);
    const index =
      current === -1
        ? direction === 1
          ? 0
          : areas.length - 1
        : (current + direction + areas.length) % areas.length;
    const area = areas[index]!;
    return focusArea(area);
  };
  return { move, focus, dispose: () => doc.removeEventListener("focusin", remember) };
}

export const WORKSPACE_FOCUS_TARGET_EVENT = "t3:workspace-focus-target";
export const SETTINGS_SEARCH_FOCUS_EVENT = "t3:settings-search-focus";
export interface WorkspaceFocusTarget {
  area: string;
  selector?: string;
  restore?: boolean;
}
let focusRequestVersion = 0;
export const getWorkspaceFocusRequestVersion = () => focusRequestVersion;

/** Explicit user actions request focus after React has committed the destination. */
export function requestWorkspaceFocus(target: WorkspaceFocusTarget) {
  focusRequestVersion++;
  window.dispatchEvent(new CustomEvent(WORKSPACE_FOCUS_TARGET_EVENT, { detail: target }));
}

export function requestWorkspaceContentFocus() {
  // Resolve after the layout commits: closing a maximized panel makes the
  // composer available again, while hiding a sidebar may leave only the panel.
  requestWorkspaceFocus({ area: "content" });
}

export const WORKSPACE_FOCUS_EVENT = "t3:workspace-focus";
let pendingPaletteDirection: 1 | -1 | undefined;
export function queueWorkspaceFocusFromPalette(direction: 1 | -1) {
  pendingPaletteDirection = direction;
}

/** Runs at the palette's normal focus restoration milestone, after its focus trap closes. */
export function restoreWorkspaceFocusFromPalette(): boolean {
  if (pendingPaletteDirection === undefined) return false;
  const direction = pendingPaletteDirection;
  pendingPaletteDirection = undefined;
  window.requestAnimationFrame(() => {
    window.dispatchEvent(new CustomEvent(WORKSPACE_FOCUS_EVENT, { detail: direction }));
  });
  return true;
}
