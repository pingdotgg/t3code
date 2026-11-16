import type { ContextMenuItem } from "@t3tools/contracts";

/**
 * The role of the checkable items in one menu list: a lone checkable item is a switch, such as
 * Enable Dashboard, and several in one list are a choice of one.
 */
export const checkedItemRole = (
  entries: ReadonlyArray<Pick<ContextMenuItem<string>, "checked">>,
): "menuitemcheckbox" | "menuitemradio" =>
  entries.filter((entry) => typeof entry.checked === "boolean").length > 1
    ? "menuitemradio"
    : "menuitemcheckbox";
