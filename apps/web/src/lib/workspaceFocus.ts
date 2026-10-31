import type { AnyRouter } from "@tanstack/react-router";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { dismissContextMenu } from "../contextMenuFallback";
import { findLayoutTab } from "../layout/layoutModel";
import { useLayoutStore } from "../layout/layoutStore";
import { useRightPanelStore } from "../rightPanelStore";

const AREA_SELECTOR = "[data-workspace-area]";
const PANE_SELECTOR = "[data-layout-tab-id]";
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
  surface?: { threadKey: string; surfaceId: string };
}

function workspaceArea(element: Element): HTMLElement | null {
  const area = element.closest<HTMLElement>(AREA_SELECTOR);
  if (area) return area;
  const root = element.getRootNode();
  return root instanceof ShadowRoot ? workspaceArea(root.host) : null;
}

function workspaceAreaKey(area: HTMLElement) {
  return JSON.stringify([
    area.closest<HTMLElement>(PANE_SELECTOR)?.dataset.layoutTabId,
    area.dataset.workspaceFocusKey ?? area.dataset.workspaceArea,
  ]);
}

function paneId(element: Element | null | undefined): string | undefined {
  return element?.closest<HTMLElement>(PANE_SELECTOR)?.dataset.layoutTabId;
}

function claimWorkspacePane(area: HTMLElement) {
  const tabId = area.closest<HTMLElement>(PANE_SELECTOR)?.dataset.layoutTabId;
  if (tabId) useLayoutStore.getState().focusTab(tabId);
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
  const clip = element.closest<HTMLElement>("[data-layout-clip]");
  if (clip) {
    const bounds = clip.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    if (
      rect.right <= bounds.left ||
      rect.left >= bounds.right ||
      rect.bottom <= bounds.top ||
      rect.top >= bounds.bottom
    )
      return false;
  }
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
  let lastArea: HTMLElement | undefined;
  let lastAreaKey: string | undefined;
  const remember = (event: FocusEvent) => {
    if (!(event.target instanceof HTMLElement)) return;
    const area = workspaceArea(event.target);
    if (!area?.dataset.workspaceArea) return;
    lastArea = area;
    const key = workspaceAreaKey(area);
    lastAreaKey = key;
    lastFocused.delete(key);
    // Custom file trees retarget focusin to their nonfocusable shadow host.
    const target = event.composedPath().find((element) => element instanceof HTMLElement);
    lastFocused.set(key, target instanceof HTMLElement ? target : event.target);
    // Surface history must not retain an unbounded number of detached panel trees.
    if (lastFocused.size > 64) lastFocused.delete(lastFocused.keys().next().value!);
  };
  doc.addEventListener("focusin", remember);

  const focusArea = (area: HTMLElement, restore = true) => {
    const key = workspaceAreaKey(area);
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
        claimWorkspacePane(area);
        if (target !== area && !isConversation) revealInScrollers(target);
        return true;
      }
    }
    return false;
  };
  const focus = (
    name: string,
    restore = true,
    selector?: string,
    preferredPane?: string,
    surfaceTarget?: WorkspaceFocusTarget["surface"],
  ) => {
    const areas = Array.from(doc.querySelectorAll<HTMLElement>(AREA_SELECTOR)).filter(
      isWorkspaceElementVisible,
    );
    const findArea = (candidates: HTMLElement[]) =>
      name === "content"
        ? (candidates.find((element) => element.dataset.workspaceArea === "composer") ??
          candidates.find(
            (element) =>
              element.dataset.workspaceArea === "pull-requests" || element.matches("main"),
          ) ??
          candidates.find((element) => element.dataset.workspaceArea === "conversation") ??
          candidates.find((element) => element.dataset.workspaceArea === "panel") ??
          candidates.find((element) => element.dataset.workspaceArea === "launcher"))
        : candidates.find((element) => element.dataset.workspaceArea === name);
    const currentPane =
      preferredPane ??
      paneId(doc.activeElement) ??
      doc.querySelector<HTMLElement>('[data-layout-pane-focused="true"]')?.dataset.layoutTabId;
    const surfaceTab = surfaceTarget
      ? findLayoutTab(
          useLayoutStore.getState().layout,
          (tab) =>
            tab.content.kind === "surface" &&
            scopedThreadKey(tab.content.threadRef) === surfaceTarget.threadKey &&
            tab.content.surfaceId === surfaceTarget.surfaceId,
        )?.tab.id
      : undefined;
    const localArea = findArea(areas.filter((element) => paneId(element) === currentPane));
    const area = surfaceTarget
      ? surfaceTab && findArea(areas.filter((element) => paneId(element) === surfaceTab))
      : (localArea ??
        (currentPane && (name === "panel" || name === "details") ? undefined : findArea(areas)));
    if (!area) return false;
    const surface = area.querySelector("[data-right-panel-surface-content]");
    // A lazy surface's Suspense fallback is empty. Wait for its content instead
    // of claiming focus on the tab strip before the useful controls mount.
    if (surface && !surface.hasChildNodes()) return false;
    if (!selector && surface?.contains(doc.activeElement)) return true;
    if (selector) {
      const target = area.querySelector<HTMLElement>(selector);
      if (!target || !isWorkspaceElementVisible(target)) return false;
      target.focus({ preventScroll: true });
      if (doc.activeElement !== target) return false;
      claimWorkspacePane(area);
      return true;
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
    const groups = new Map<HTMLElement, HTMLElement[]>();
    for (const area of (appModal ?? doc).querySelectorAll<HTMLElement>(AREA_SELECTOR)) {
      if (!isWorkspaceElementVisible(area)) continue;
      const group = area.closest<HTMLElement>(PANE_SELECTOR) ?? area;
      const areas = groups.get(group) ?? [];
      areas.push(area);
      groups.set(group, areas);
    }
    const order = (area: HTMLElement) => Number(area.dataset.workspaceOrder);
    const areas = Array.from(groups.values())
      .map((group) => group.sort((left, right) => order(left) - order(right)))
      .sort((left, right) => order(left[0]!) - order(right[0]!))
      .flat();
    if (areas.length === 0) return false;
    const activeArea = doc.activeElement ? workspaceArea(doc.activeElement) : null;
    const currentArea = fromArea
      ? (areas.find(
          (area) =>
            area.dataset.workspaceArea === fromArea &&
            area.closest('[data-layout-pane-focused="true"]'),
        ) ?? areas.find((area) => area.dataset.workspaceArea === fromArea))
      : (activeArea ?? lastArea);
    const currentKey = activeArea ? workspaceAreaKey(activeArea) : lastAreaKey;
    const current = areas.findIndex(
      (area) => area === currentArea || (!fromArea && workspaceAreaKey(area) === currentKey),
    );
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
    const lostArea = workspaceArea(lost);
    const lostAreaKey = lostArea ? workspaceAreaKey(lostArea) : undefined;
    const tabId = lost.closest<HTMLElement>(PANE_SELECTOR)?.dataset.layoutTabId;
    const label = lost.getAttribute("aria-label");
    requestAnimationFrame(() => {
      if (doc.activeElement !== doc.body || !doc.hasFocus() || isWorkspaceElementVisible(lost))
        return;
      const remounted = Array.from(doc.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).find(
        (element) =>
          element.closest<HTMLElement>(PANE_SELECTOR)?.dataset.layoutTabId === tabId &&
          element.tagName === lost.tagName &&
          ((lost.id && element.id === lost.id) ||
            (label && element.getAttribute("aria-label") === label)) &&
          isWorkspaceElementVisible(element),
      );
      if (remounted) remounted.focus({ preventScroll: true });
      else {
        const area = lostAreaKey
          ? Array.from(doc.querySelectorAll<HTMLElement>(AREA_SELECTOR)).find(
              (candidate) =>
                workspaceAreaKey(candidate) === lostAreaKey && isWorkspaceElementVisible(candidate),
            )
          : undefined;
        if (!area || !focusArea(area)) focus("content");
      }
    });
  };
  doc.addEventListener("focusout", recover);

  // A request names a destination React has not committed yet, so it retries as the
  // DOM changes. User input cancels it, and it gives up after two seconds.
  let pending: WorkspaceFocusTarget | undefined;
  let pendingPane: string | undefined;
  let frame = 0;
  let deadline = 0;
  let cancelOnInput = false;
  const observer = new MutationObserver(() => schedule());
  const cancelRequest = () => {
    pending = undefined;
    pendingPane = undefined;
    cancelOnInput = false;
    observer.disconnect();
    cancelAnimationFrame(frame);
    clearTimeout(deadline);
  };
  const schedule = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (
        pending &&
        focus(pending.area, pending.restore, pending.selector, pendingPane, pending.surface)
      )
        cancelRequest();
    });
  };
  const request = (target: WorkspaceFocusTarget) => {
    cancelRequest();
    pending = target;
    pendingPane =
      paneId(doc.activeElement) ??
      doc.querySelector<HTMLElement>('[data-layout-pane-focused="true"]')?.dataset.layoutTabId;
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
      if (
        next?.isOpen &&
        next.activeSurfaceId &&
        (!before?.isOpen || next.activeSurfaceId !== before.activeSurfaceId)
      )
        requestWorkspaceFocus({
          area: "panel",
          surface: { threadKey, surfaceId: next.activeSurfaceId },
        });
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
