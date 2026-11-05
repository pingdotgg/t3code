const ROW = "[data-sidebar-row]";
const CONTROL = 'button, a[href], input, textarea, select, [contenteditable="true"], [tabindex]';
const TEXT_ENTRY = 'input, textarea, select, [contenteditable="true"]';

function setAttribute(element: Element, name: string, value: string) {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

function setTabIndex(element: HTMLElement, value: number) {
  if (element.tabIndex !== value) element.tabIndex = value;
}

export const SIDEBAR_TREE_PROPS = { role: "tree", "aria-label": "Threads" } as const;

/** Ref callback for a sidebar list; installs the tree and returns its cleanup. */
export function attachSidebarTree(element: HTMLElement | null) {
  return element ? installSidebarTree(element) : undefined;
}

/** A roving DOM focus, separate from thread activation, as in VS Code's list commands. */
export function installSidebarTree(root: HTMLElement) {
  let rows: HTMLElement[] = [];
  let focusedId: string | undefined;
  let ownsFocus = false;
  let tabStop: HTMLElement | undefined;
  let contextMenuRow: HTMLElement | undefined;
  // A control's own tab index, restored while its row holds the Tab stop and on uninstall.
  const ownTabIndex = new Map<HTMLElement, number>();

  const rowControls = (row: HTMLElement) => {
    const id = row.dataset.sidebarRow;
    const linked = id
      ? root.querySelectorAll<HTMLElement>(`[data-sidebar-action-for="${CSS.escape(id)}"]`)
      : [];
    return [...row.querySelectorAll<HTMLElement>(CONTROL), ...linked].filter(
      (control) => !control.matches(ROW) && !control.matches(TEXT_ENTRY),
    );
  };
  // Tab reaches the buttons of the focused row only, so the tree stays one stop for the rest.
  const setRowControlsReachable = (row: HTMLElement, reachable: boolean) => {
    for (const control of rowControls(row)) {
      if (!ownTabIndex.has(control)) ownTabIndex.set(control, control.tabIndex);
      setTabIndex(control, reachable ? ownTabIndex.get(control)! : -1);
    }
  };

  const setTabStop = (row: HTMLElement) => {
    if (tabStop === row) return;
    if (tabStop) {
      setTabIndex(tabStop, -1);
      setRowControlsReachable(tabStop, false);
    }
    setTabIndex(row, 0);
    setRowControlsReachable(row, true);
    tabStop = row;
    focusedId = row.dataset.sidebarRow;
  };

  const focusRow = (row: HTMLElement) => {
    setTabStop(row);
    // Revealing before focusing also materializes content-visibility:auto descendants.
    row.scrollIntoView({ block: "nearest" });
    row.focus({ preventScroll: true });
  };

  const refresh = () => {
    const previousRows = rows;
    const previousIndex = previousRows.findIndex((row) => row.dataset.sidebarRow === focusedId);
    const previous = previousRows[previousIndex];
    rows = Array.from(root.querySelectorAll<HTMLElement>(ROW)).filter((row) => {
      const hidden = row.closest('[hidden], [inert], [aria-hidden="true"]');
      // A dialog can temporarily make the whole workspace inert. Keep the tree's
      // Tab stop ready for its return while still excluding exiting row clones.
      return (!hidden || !root.contains(hidden)) && !row.matches(":disabled");
    });
    let selected =
      rows.find((row) => row.dataset.sidebarRow === focusedId) ??
      rows.find((row) => row === document.activeElement);
    if (!selected) {
      selected =
        rows.find((row) => row.dataset.sidebarRow === previous?.dataset.sidebarParent) ??
        (previousIndex === -1 ? rows.find((row) => row.hasAttribute("aria-current")) : undefined) ??
        rows[Math.min(Math.max(previousIndex, 0), rows.length - 1)];
    }
    focusedId = selected?.dataset.sidebarRow;
    tabStop = selected;
    setTabIndex(root, selected ? -1 : 0);
    const siblings = new Map<string, HTMLElement[]>();
    for (const row of rows) {
      const parent = row.dataset.sidebarParent ?? "";
      const group = siblings.get(parent) ?? [];
      group.push(row);
      siblings.set(parent, group);
      setAttribute(row, "aria-level", parent ? "2" : "1");
      setTabIndex(row, row === selected ? 0 : -1);
    }
    const byId = new Map(rows.map((row) => [row.dataset.sidebarRow, row]));
    for (const control of ownTabIndex.keys()) if (!control.isConnected) ownTabIndex.delete(control);
    for (const control of root.querySelectorAll<HTMLElement>(CONTROL)) {
      if (control.matches(ROW) || control.matches(TEXT_ENTRY)) continue;
      const linked = control.dataset.sidebarActionFor;
      const owner = control.closest<HTMLElement>(ROW) ?? (linked ? byId.get(linked) : undefined);
      if (!owner) continue;
      if (!ownTabIndex.has(control)) ownTabIndex.set(control, control.tabIndex);
      setTabIndex(control, owner === selected ? ownTabIndex.get(control)! : -1);
    }
    for (const group of siblings.values())
      group.forEach((row, index) => {
        setAttribute(row, "aria-posinset", String(index + 1));
        setAttribute(row, "aria-setsize", String(group.length));
      });
    for (const listItem of root.querySelectorAll("li:not([role])"))
      listItem.setAttribute("role", "presentation");
    if (
      ownsFocus &&
      selected &&
      (document.activeElement === document.body ||
        document.activeElement === root ||
        (root.contains(document.activeElement) &&
          !rows.includes(document.activeElement as HTMLElement) &&
          document.activeElement?.matches(ROW)))
    ) {
      // A settled row moves to the bottom shelf; scrolling after it fights the route reveal.
      selected.focus({ preventScroll: true });
    }
    if (ownsFocus && !selected && document.activeElement === document.body) root.focus();
  };

  // Clicking non-focusable content drops focus to the body without a focusin event.
  const onPointerDown = (event: PointerEvent) => {
    if (!root.contains(event.target as Node)) ownsFocus = false;
  };
  const onFocus = (event: FocusEvent) => {
    ownsFocus = root.contains(event.target as Node);
    if (!ownsFocus || !(event.target instanceof HTMLElement) || !event.target.matches(ROW)) return;
    setTabStop(event.target);
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
  refresh();
  const observer = new MutationObserver((records) => {
    if (
      records.some(
        (record) =>
          record.type === "attributes" ||
          [...record.addedNodes, ...record.removedNodes].some(
            (node) =>
              node instanceof Element &&
              (node.matches(`${ROW}, ${CONTROL}`) || node.querySelector(`${ROW}, ${CONTROL}`)),
          ),
      )
    )
      refresh();
  });
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      "data-sidebar-row",
      "data-sidebar-parent",
      "aria-expanded",
      "hidden",
      "disabled",
      "inert",
      "aria-hidden",
    ],
  });
  document.addEventListener("focusin", onFocus);
  document.addEventListener("pointerdown", onPointerDown, true);
  root.addEventListener("keydown", onKeyDown, true);
  root.addEventListener("keyup", onKeyUp, true);
  return () => {
    observer.disconnect();
    // A later install reads these as the controls' own tab indexes.
    for (const [control, tabIndex] of ownTabIndex) setTabIndex(control, tabIndex);
    document.removeEventListener("focusin", onFocus);
    document.removeEventListener("pointerdown", onPointerDown, true);
    root.removeEventListener("keydown", onKeyDown, true);
    root.removeEventListener("keyup", onKeyUp, true);
  };
}
