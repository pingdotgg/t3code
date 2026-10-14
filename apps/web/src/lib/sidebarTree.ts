import { isWorkspaceElementVisible } from "./workspaceFocus";

const ROW = "[data-sidebar-row]";
const CONTROL = 'button, a[href], input, textarea, select, [contenteditable="true"], [tabindex]';

/** A roving DOM focus, separate from thread activation, as in VS Code's list commands. */
export function installSidebarTree(root: HTMLElement) {
  let rows: HTMLElement[] = [];
  let focusedId: string | undefined;
  let ownsFocus = false;
  let tabStop: HTMLElement | undefined;
  let actionRow: HTMLElement | undefined;
  let rowActions: HTMLElement[] = [];
  let contextMenuRow: HTMLElement | undefined;
  const leaveActions = () => {
    for (const action of rowActions) action.tabIndex = -1;
    actionRow = undefined;
    rowActions = [];
  };

  const setTabStop = (row: HTMLElement) => {
    if (tabStop === row) return;
    if (tabStop) tabStop.tabIndex = -1;
    row.tabIndex = 0;
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
      return !hidden || !root.contains(hidden);
    });
    const byId = new Map(rows.map((row) => [row.dataset.sidebarRow, row]));
    rows = rows.filter((row) => {
      const parent = byId.get(row.dataset.sidebarParent);
      return !parent || parent.getAttribute("aria-expanded") !== "false";
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
    root.tabIndex = selected ? -1 : 0;
    const siblings = new Map<string, HTMLElement[]>();
    for (const row of rows) {
      const parent = row.dataset.sidebarParent ?? "";
      const group = siblings.get(parent) ?? [];
      group.push(row);
      siblings.set(parent, group);
      row.setAttribute("aria-level", parent ? "2" : "1");
      row.tabIndex = row === selected ? 0 : -1;
    }
    for (const group of siblings.values())
      group.forEach((row, index) => {
        row.setAttribute("aria-posinset", String(index + 1));
        row.setAttribute("aria-setsize", String(group.length));
      });
    for (const listItem of root.querySelectorAll("li:not([role])"))
      listItem.setAttribute("role", "presentation");
    // F2 enters nested actions. Rename fields remain ordinary inputs while editing;
    // the tree otherwise contributes one Tab stop.
    for (const control of root.querySelectorAll<HTMLElement>(CONTROL)) {
      if (
        !control.matches(ROW) &&
        !control.matches('input, textarea, select, [contenteditable="true"]') &&
        !rowActions.includes(control)
      )
        control.tabIndex = -1;
    }
    if (
      ownsFocus &&
      selected &&
      (document.activeElement === document.body ||
        document.activeElement === root ||
        (root.contains(document.activeElement) &&
          !rows.includes(document.activeElement as HTMLElement) &&
          document.activeElement?.matches(ROW)))
    ) {
      focusRow(selected);
    }
    if (ownsFocus && !selected && document.activeElement === document.body) root.focus();
  };

  const onFocus = (event: FocusEvent) => {
    ownsFocus = root.contains(event.target as Node);
    if (!ownsFocus || (event.target instanceof HTMLElement && event.target.matches(ROW)))
      leaveActions();
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
    if (
      actionRow &&
      (event.key === "Escape" || event.key === "F2") &&
      row instanceof HTMLElement &&
      !row.matches('input, textarea, select, [contenteditable="true"]')
    ) {
      const owner = actionRow;
      leaveActions();
      focusRow(owner);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (!(row instanceof HTMLElement) || !row.matches(ROW)) return;
    const index = rows.indexOf(row);
    if (index < 0) return;
    let target: HTMLElement | undefined;
    switch (event.key) {
      case "F2": {
        rowActions = Array.from(root.querySelectorAll<HTMLElement>(CONTROL)).filter(
          (control) =>
            control !== row &&
            !control.matches(`${ROW}, :disabled`) &&
            isWorkspaceElementVisible(control) &&
            (control.closest(ROW) === row ||
              control.dataset.sidebarActionFor === row.dataset.sidebarRow),
        );
        if (rowActions.length > 0) {
          actionRow = row;
          for (const action of rowActions) action.tabIndex = 0;
          rowActions[0]!.focus();
        }
        break;
      }
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
      // Existing row handlers own Enter, Space, rename, and the context menu.
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
      "inert",
      "aria-hidden",
    ],
  });
  document.addEventListener("focusin", onFocus);
  root.addEventListener("keydown", onKeyDown, true);
  root.addEventListener("keyup", onKeyUp, true);
  return () => {
    observer.disconnect();
    document.removeEventListener("focusin", onFocus);
    root.removeEventListener("keydown", onKeyDown, true);
    root.removeEventListener("keyup", onKeyUp, true);
  };
}
