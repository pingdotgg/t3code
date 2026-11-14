const ROW = "[data-sidebar-row]";

/** Ref callback for a sidebar list; installs its keyboard navigation and returns its cleanup. */
export function attachSidebarTree(element: HTMLElement | null) {
  return element ? installSidebarTree(element) : undefined;
}

/**
 * Arrow keys move focus between rows without opening them, as in VS Code's list commands.
 * Rows stay ordinary buttons in the Tab order so screen readers can browse the list.
 */
export function installSidebarTree(root: HTMLElement) {
  let focusedId: string | undefined;
  let focusedParent: string | undefined;
  let focusedIndex = -1;
  let ownsFocus = false;
  let contextMenuRow: HTMLElement | undefined;

  const isVisibleRow = (row: HTMLElement) => {
    const hidden = row.closest('[hidden], [inert], [aria-hidden="true"]');
    // A dialog can temporarily make the whole workspace inert. Keep rows navigable
    // for its return while still excluding exiting row clones.
    return (!hidden || !root.contains(hidden)) && !row.matches(":disabled");
  };
  const visibleRows = () =>
    Array.from(root.querySelectorAll<HTMLElement>(ROW)).filter(isVisibleRow);

  const ownerRow = (element: HTMLElement) => {
    const row = element.closest<HTMLElement>(ROW);
    if (row) return row;
    const linked = element.dataset.sidebarActionFor;
    return linked
      ? root.querySelector<HTMLElement>(`[data-sidebar-row="${CSS.escape(linked)}"]`)
      : null;
  };

  const focusRow = (row: HTMLElement) => {
    // Revealing before focusing also materializes content-visibility:auto descendants.
    row.scrollIntoView({ block: "nearest" });
    row.focus({ preventScroll: true });
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
        !isVisibleRow(active));
    if (!lost) return;
    const rows = visibleRows();
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
    ownsFocus = root.contains(event.target as Node);
    if (!ownsFocus || !(event.target instanceof HTMLElement)) return;
    const row = ownerRow(event.target);
    if (!row) return;
    focusedId = row.dataset.sidebarRow;
    focusedParent = row.dataset.sidebarParent;
    focusedIndex = visibleRows().indexOf(row);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const row = event.target;
    if (
      !event.defaultPrevented &&
      !event.isComposing &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) &&
      row instanceof HTMLElement &&
      row.matches(ROW)
    ) {
      event.preventDefault();
      event.stopPropagation();
      contextMenuRow = row;
      return;
    }
    if (
      event.defaultPrevented ||
      event.isComposing ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    )
      return;
    if (!(row instanceof HTMLElement) || !row.matches(ROW)) return;
    const rows = visibleRows();
    const index = rows.indexOf(row);
    if (index < 0) return;
    let target: HTMLElement | undefined;
    switch (event.key) {
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
    if (target) focusRow(target);
  };
  const onKeyUp = (event: KeyboardEvent) => {
    if (!contextMenuRow || (event.key !== "ContextMenu" && event.key !== "F10")) return;
    const row = contextMenuRow;
    contextMenuRow = undefined;
    event.preventDefault();
    event.stopPropagation();
    if (document.activeElement !== row || !row.isConnected) return;
    const rect = row.getBoundingClientRect();
    // Like VS Code's list, suppress keydown and open on release. Reuse the row's
    // selection-aware handler, including its Electron native menu route.
    row.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
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
  root.addEventListener("keydown", onKeyDown, true);
  root.addEventListener("keyup", onKeyUp, true);
  return () => {
    observer.disconnect();
    document.removeEventListener("focusin", onFocus);
    document.removeEventListener("pointerdown", onPointerDown, true);
    root.removeEventListener("keydown", onKeyDown, true);
    root.removeEventListener("keyup", onKeyUp, true);
  };
}
