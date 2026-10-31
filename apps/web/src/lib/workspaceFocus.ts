import type { AnyRouter } from "@tanstack/react-router";
import { dismissContextMenu } from "../contextMenuFallback";
import { useRightPanelStore } from "../rightPanelStore";

const AREA_SELECTOR = "[data-workspace-area]";
const FOCUS_BOUNDARY_SELECTOR =
  '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open], [data-slot$="-popup"]:not([data-slot="tooltip-popup"]):not([role="tooltip"])';
const FOCUSABLE_SELECTOR =
  'button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [contenteditable="true"], [tabindex]';

/** Props that make an element one stop in the F6 cycle; `order` sets its place in the cycle. */
export function workspaceAreaProps(name: string, order: number, label: string) {
  return {
    "data-workspace-area": name,
    "data-workspace-order": order,
    "aria-label": label,
    role: "region",
    tabIndex: -1,
  } as const;
}

export interface WorkspaceFocusTarget {
  area: string;
  selector?: string;
  restore?: boolean;
}

function workspaceArea(element: Element): HTMLElement | null {
  const area = element.closest<HTMLElement>(AREA_SELECTOR);
  if (area) return area;
  const root = element.getRootNode();
  return root instanceof ShadowRoot ? workspaceArea(root.host) : null;
}

function isWorkspaceElementVisible(element: HTMLElement): boolean {
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

function scrollingAncestors(target: HTMLElement) {
  const scrollers: HTMLElement[] = [];
  for (let element = target.parentElement; element; element = element.parentElement) {
    const { overflowY } = getComputedStyle(element);
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      element.scrollHeight > element.clientHeight
    )
      scrollers.push(element);
  }
  return scrollers;
}

function isInScrollView(target: HTMLElement) {
  const rect = target.getBoundingClientRect();
  return scrollingAncestors(target).every((scroller) => {
    const box = scroller.getBoundingClientRect();
    return rect.bottom > box.top && rect.top < box.bottom;
  });
}

/**
 * Brings a restored control into view, innermost scrolling list first.
 * scrollIntoView would also scroll overflow-hidden layout containers out of place.
 */
function revealInScrollers(target: HTMLElement) {
  for (const scroller of scrollingAncestors(target)) {
    const box = scroller.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    if (rect.top < box.top) scroller.scrollTop -= box.top - rect.top;
    else if (rect.bottom > box.bottom) scroller.scrollTop += rect.bottom - box.bottom;
  }
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
    // Moving the timeline to an old control would also stop it following a running turn,
    // so the conversation reuses a control only while it is still in view.
    const isConversation = area.dataset.workspaceArea === "conversation";
    const targets = new Set([
      previous && belongs(previous) && (!isConversation || isInScrollView(previous))
        ? previous
        : undefined,
      isConversation ? undefined : restored,
      preferred,
      surfaceControl,
      isConversation ? undefined : fallback,
      area,
    ]);
    for (const target of targets) {
      if (!target) continue;
      target.focus({ preventScroll: true });
      const root = target.getRootNode();
      const active = root instanceof ShadowRoot ? root.activeElement : doc.activeElement;
      if (active === target || (active && target.contains(active))) {
        if (target !== area && !isConversation) revealInScrollers(target);
        return true;
      }
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
    // Settings opens as a route modal with its own areas; navigation stays inside it.
    const appModal = Array.from(doc.querySelectorAll<HTMLElement>("[data-app-modal]")).find(
      isWorkspaceElementVisible,
    );
    const boundaries = Array.from(
      doc.querySelectorAll<HTMLElement>(FOCUS_BOUNDARY_SELECTOR),
    ).filter((boundary) => boundary !== appModal);
    if (activePopup && !activePopup.closest(AREA_SELECTOR)) boundaries.push(activePopup);
    // A modal keeps focus wherever it is; any other popup only while it holds focus,
    // so hover popups and notifications never swallow the key.
    if (
      boundaries.some(
        (boundary) =>
          !(closingPalette && boundary.closest("[data-command-palette]")) &&
          (boundary.matches('[aria-modal="true"]') || boundary.contains(doc.activeElement)) &&
          isWorkspaceElementVisible(boundary),
      )
    )
      return false;
    const areas = Array.from((appModal ?? doc).querySelectorAll<HTMLElement>(AREA_SELECTOR))
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

  // Focus that drops to the body because its element was hidden, made inert, or removed
  // returns to the same control when React remounted it, else to its area, else the content.
  const recover = (event: FocusEvent) => {
    const lost = event.target;
    if (!(lost instanceof HTMLElement) || event.relatedTarget) return;
    const areaName = workspaceArea(lost)?.dataset.workspaceArea;
    const label = lost.getAttribute("aria-label");
    requestAnimationFrame(() => {
      if (doc.activeElement !== doc.body || !doc.hasFocus() || isWorkspaceElementVisible(lost))
        return;
      const remounted = Array.from(doc.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).find(
        (element) =>
          element.tagName === lost.tagName &&
          ((lost.id && element.id === lost.id) ||
            (label && element.getAttribute("aria-label") === label)) &&
          isWorkspaceElementVisible(element),
      );
      if (remounted) remounted.focus({ preventScroll: true });
      else if (!areaName || !focus(areaName)) focus("content");
    });
  };
  doc.addEventListener("focusout", recover);

  // A request names a destination React has not committed yet, so it retries as the
  // DOM changes. User input cancels it, and it gives up after two seconds.
  let pending: WorkspaceFocusTarget | undefined;
  let frame = 0;
  let deadline = 0;
  let cancelOnInput = false;
  const observer = new MutationObserver(() => schedule());
  const cancelRequest = () => {
    pending = undefined;
    cancelOnInput = false;
    observer.disconnect();
    cancelAnimationFrame(frame);
    clearTimeout(deadline);
  };
  const schedule = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (pending && focus(pending.area, pending.restore, pending.selector)) cancelRequest();
    });
  };
  const request = (target: WorkspaceFocusTarget) => {
    cancelRequest();
    pending = target;
    // The key or click that made the request may still be propagating.
    queueMicrotask(() => {
      if (pending === target) cancelOnInput = true;
    });
    observer.observe(doc.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["inert", "aria-hidden", "data-workspace-unavailable"],
    });
    deadline = window.setTimeout(cancelRequest, 2000);
    schedule();
  };
  const onUserInput = () => {
    if (cancelOnInput) cancelRequest();
  };
  doc.addEventListener("pointerdown", onUserInput, true);
  doc.addEventListener("keydown", onUserInput, true);

  return {
    move: (direction: 1 | -1, fromArea?: string, closingPalette = false) => {
      cancelRequest();
      return move(direction, fromArea, closingPalette);
    },
    focus,
    request,
    dispose: () => {
      cancelRequest();
      doc.removeEventListener("focusin", remember);
      doc.removeEventListener("focusout", recover);
      doc.removeEventListener("pointerdown", onUserInput, true);
      doc.removeEventListener("keydown", onUserInput, true);
    },
  };
}

let controller: ReturnType<typeof createWorkspaceFocusController> | undefined;
let focusRequestVersion = 0;
export const getWorkspaceFocusRequestVersion = () => focusRequestVersion;

/**
 * Starts workspace focus for the app: F6 area moves, focus requests, focus-loss recovery,
 * focus into a panel the user opens, and focus into the Pull Requests page on entry.
 */
export function startWorkspaceFocus(router: AnyRouter): () => void {
  const active = createWorkspaceFocusController(document);
  controller = active;
  const stopPanels = useRightPanelStore.subscribe((state, previous) => {
    if (state.userActionRevisionByThreadKey === previous.userActionRevisionByThreadKey) return;
    for (const [threadKey, revision] of Object.entries(state.userActionRevisionByThreadKey)) {
      if (previous.userActionRevisionByThreadKey[threadKey] === revision) continue;
      const next = state.byThreadKey[threadKey];
      const before = previous.byThreadKey[threadKey];
      if (next?.isOpen && (!before?.isOpen || next.activeSurfaceId !== before.activeSurfaceId))
        requestWorkspaceFocus({ area: "panel" });
    }
  });
  const stopRoute = router.subscribe("onResolved", ({ fromLocation, toLocation }) => {
    if (toLocation.pathname === "/pull-requests" && fromLocation?.pathname !== "/pull-requests")
      requestWorkspaceFocus({ area: "pull-requests" });
  });
  return () => {
    stopPanels();
    stopRoute();
    active.dispose();
    if (controller === active) controller = undefined;
  };
}

/** Moves to the next or previous visible area. `fromArea` overrides the focused area. */
export function moveWorkspaceFocus(direction: 1 | -1, fromArea?: string): boolean {
  return controller?.move(direction, fromArea) ?? false;
}

/** Explicit user actions request focus after React has committed the destination. */
export function requestWorkspaceFocus(target: WorkspaceFocusTarget) {
  focusRequestVersion++;
  controller?.request(target);
}

export function requestWorkspaceContentFocus() {
  // Resolve after the layout commits: closing a maximized panel makes the
  // composer available again, while hiding a sidebar may leave only the panel.
  requestWorkspaceFocus({ area: "content" });
}

let pendingPaletteDirection: 1 | -1 | undefined;
export function queueWorkspaceFocusFromPalette(direction: 1 | -1) {
  pendingPaletteDirection = direction;
}

/** Runs at the palette's normal focus restoration milestone, after its focus trap closes. */
export function restoreWorkspaceFocusFromPalette(): boolean {
  if (pendingPaletteDirection === undefined) return false;
  const direction = pendingPaletteDirection;
  pendingPaletteDirection = undefined;
  window.requestAnimationFrame(() => controller?.move(direction, undefined, true));
  return true;
}
