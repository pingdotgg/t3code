import { createVimListKeys } from "./vimListKeys";

const ROW = "[data-sidebar-row]";
const MENU_BUTTON = '[data-sidebar="menu-button"]';

function isVisibleRow(row: HTMLElement, sidebar: HTMLElement) {
  const hidden = row.closest('[hidden], [inert], [aria-hidden="true"]');
  return (!hidden || !sidebar.contains(hidden)) && !row.matches(":disabled");
}

function visibleRows(root: HTMLElement) {
  return Array.from(root.querySelectorAll<HTMLElement>(ROW)).filter((row) =>
    isVisibleRow(row, root),
  );
}

function focusRow(row: HTMLElement, smooth = false) {
  row.scrollIntoView({ block: "nearest", behavior: smooth ? "smooth" : "auto" });
  row.focus({ preventScroll: true });
}

export function focusCurrentSidebarRow(sidebar: HTMLElement) {
  const rows = visibleRows(sidebar);
  const row =
    rows.find((candidate) => candidate.getAttribute("aria-current") === "page") ?? rows[0];
  if (!row) return false;
  focusRow(row);
  return row.ownerDocument.activeElement === row;
}

/**
 * Arrow keys move focus between rows without opening them, as in VS Code's list commands.
 * Rows stay ordinary buttons in the Tab order so screen readers can browse the list.
 */
export function installSidebarTree(root: HTMLElement, isVimEnabled = () => false) {
  const sidebar = root.closest<HTMLElement>("[data-app-sidebar]") ?? root;
  let focusedId: string | undefined;
  let focusedParent: string | undefined;
  let focusedIndex = -1;
  let ownsFocus = false;
  let contextMenu: { row: HTMLElement; key: string } | undefined;
  const vimKeys = createVimListKeys();

  const ownerRow = (element: HTMLElement) => {
    const row = element.closest<HTMLElement>(ROW);
    if (row) return row;
    const linked = element.dataset.sidebarActionFor;
    return linked
      ? root.querySelector<HTMLElement>(`[data-sidebar-row="${CSS.escape(linked)}"]`)
      : null;
  };

  // A row that moves shelves remounts and drops focus to the body; follow it.
  const restoreFocus = () => {
    if (!ownsFocus || focusedId === undefined) return;
    const active = document.activeElement;
    const lost =
      active === document.body ||
      (active instanceof HTMLElement &&
        root.contains(active) &&
        active.matches(ROW) &&
        !isVisibleRow(active, sidebar));
    if (!lost) return;
    const rows = visibleRows(root);
    const target =
      rows.find((row) => row.dataset.sidebarRow === focusedId) ??
      rows.find((row) => row.dataset.sidebarRow === focusedParent) ??
      rows[Math.min(Math.max(focusedIndex, 0), rows.length - 1)];
    // A settled row moves to the bottom shelf; scrolling after it fights the route reveal.
    target?.focus({ preventScroll: true });
  };

  // Clicking non-focusable content, including empty list space, drops focus to the body
  // without a focusin event. A click on the focused row fires no focusin either.
  const onPointerDown = (event: PointerEvent) => {
    const focusable =
      event.target instanceof Element
        ? event.target.closest(`${ROW}, button, a[href], input, [tabindex]`)
        : null;
    ownsFocus = focusable !== null && root.contains(focusable);
  };
  const onFocus = (event: FocusEvent) => {
    vimKeys.reset();
    contextMenu = undefined;
    ownsFocus = root.contains(event.target as Node);
    if (!ownsFocus || !(event.target instanceof HTMLElement)) return;
    const row = ownerRow(event.target);
    if (!row) return;
    focusedId = row.dataset.sidebarRow;
    focusedParent = row.dataset.sidebarParent;
    focusedIndex = visibleRows(root).indexOf(row);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const row = event.target;
    if (!(row instanceof HTMLElement)) return;
    const inTree = row.matches(ROW) && root.contains(row);
    const vim = isVimEnabled();
    if (
      !inTree &&
      !(vim && row.matches(MENU_BUTTON) && ["j", "k", "g", "G", "/"].includes(event.key))
    )
      return;
    const key = vimKeys.read(event, vim);
    if (
      event.defaultPrevented ||
      event.isComposing ||
      event.keyCode === 229 ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    )
      return;
    if (
      inTree &&
      (key === "ContextMenu" ||
        (event.shiftKey && key === "F10") ||
        (vim && key === "m" && !event.shiftKey))
    ) {
      event.preventDefault();
      event.stopPropagation();
      contextMenu = { row, key: event.key };
      return;
    }
    if (event.shiftKey && !(vim && (event.key === "G" || event.key === "/"))) return;
    if (vim && key === "/") {
      const search = sidebar.querySelector<HTMLInputElement>('input[type="search"]');
      if (!search) return;
      event.preventDefault();
      event.stopPropagation();
      search.focus();
      return;
    }
    const vimStep = key !== event.key && (key === "ArrowDown" || key === "ArrowUp");
    const rows = vimStep
      ? Array.from(sidebar.querySelectorAll<HTMLElement>(`${ROW}, ${MENU_BUTTON}`)).filter(
          (element) =>
            isVisibleRow(element, sidebar) &&
            (element.matches(ROW) || element.getClientRects().length > 0),
        )
      : visibleRows(root);
    const index = rows.indexOf(row);
    if (inTree && index < 0) return;
    let target: HTMLElement | undefined;
    switch (key) {
      case null:
        break;
      case "ArrowDown":
        target = rows[Math.min(index + 1, rows.length - 1)];
        break;
      case "ArrowUp":
        target = rows[Math.max(index - 1, 0)];
        break;
      case "Home":
        target = rows[0];
        break;
      case "End":
        target = rows.at(-1);
        break;
      case "ArrowRight":
        if (row.getAttribute("aria-expanded") === "false") row.click();
        else
          target = rows.find(
            (candidate) => candidate.dataset.sidebarParent === row.dataset.sidebarRow,
          );
        break;
      case "ArrowLeft":
        if (row.getAttribute("aria-expanded") === "true") row.click();
        else
          target = rows.find(
            (candidate) => candidate.dataset.sidebarRow === row.dataset.sidebarParent,
          );
        break;
      // Row handlers own Enter, Space, F2 rename, and the context menu.
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (target)
      focusRow(
        target,
        key !== event.key && !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      );
  };
  const onKeyUp = (event: KeyboardEvent) => {
    if (contextMenu?.key !== event.key) return;
    const { row } = contextMenu;
    contextMenu = undefined;
    event.preventDefault();
    event.stopPropagation();
    if (document.activeElement !== row || !row.isConnected) return;
    const rect = row.getBoundingClientRect();
    // Like VS Code's list, suppress keydown and open on release. Reuse the row's
    // selection-aware handler, including its Electron native menu route.
    row.dispatchEvent(
      // A PointerEvent, as Chromium sends, keeps button -1 (a MouseEvent clamps it to 0),
      // which contextMenuSourceOf reads as a keyboard-opened menu.
      new PointerEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: -1,
        clientX: rect.left,
        clientY: rect.bottom,
      }),
    );
  };
  const observer = new MutationObserver(restoreFocus);
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["hidden", "inert", "aria-hidden"],
  });
  document.addEventListener("focusin", onFocus);
  document.addEventListener("pointerdown", onPointerDown, true);
  sidebar.addEventListener("keydown", onKeyDown, true);
  sidebar.addEventListener("keyup", onKeyUp, true);
  return () => {
    observer.disconnect();
    document.removeEventListener("focusin", onFocus);
    document.removeEventListener("pointerdown", onPointerDown, true);
    sidebar.removeEventListener("keydown", onKeyDown, true);
    sidebar.removeEventListener("keyup", onKeyUp, true);
  };
}
