import type { ContextMenuItem, DesktopWindowContextMenuRequest } from "@t3tools/contracts";
import type * as Electron from "electron";

type EditRole = "cut" | "copy" | "paste" | "selectAll";

export type WindowContextMenuAction =
  | { readonly type: "replace-misspelling"; readonly word: string }
  | { readonly type: "copy-link" }
  | { readonly type: "copy-image" }
  | { readonly type: "edit"; readonly role: EditRole };

export interface WindowContextMenuEntry {
  readonly label: string;
  readonly enabled: boolean;
  readonly separatorBefore: boolean;
  readonly action: WindowContextMenuAction | null;
}

type MenuParams = Pick<
  Electron.ContextMenuParams,
  "misspelledWord" | "dictionarySuggestions" | "mediaType" | "editFlags"
>;

const EDIT_ROLES = ["cut", "copy", "paste", "selectAll"] as const;
// Shortcuts are only drawn by the page, which happens on Windows and Linux, so they use Ctrl.
const EDIT_ITEMS = {
  cut: { label: "Cut", flag: "canCut", shortcut: "Ctrl+X" },
  copy: { label: "Copy", flag: "canCopy", shortcut: "Ctrl+C" },
  paste: { label: "Paste", flag: "canPaste", shortcut: "Ctrl+V" },
  selectAll: { label: "Select all", flag: "canSelectAll", shortcut: "Ctrl+A" },
} as const satisfies Record<
  EditRole,
  { label: string; flag: keyof Electron.EditFlags; shortcut: string }
>;

/** The menu for a right-click no page handler claimed: spelling, link, image, then editing. */
export function buildWindowContextMenu(
  params: MenuParams,
  hasSafeLink: boolean,
): WindowContextMenuEntry[] {
  const entries: WindowContextMenuEntry[] = [];
  const addSection = (section: ReadonlyArray<Omit<WindowContextMenuEntry, "separatorBefore">>) => {
    for (const [index, entry] of section.entries()) {
      entries.push({ ...entry, separatorBefore: index === 0 && entries.length > 0 });
    }
  };

  if (params.misspelledWord) {
    const suggestions = params.dictionarySuggestions.slice(0, 5);
    addSection(
      suggestions.length > 0
        ? suggestions.map((word) => ({
            label: word,
            enabled: true,
            action: { type: "replace-misspelling", word } as const,
          }))
        : [{ label: "No suggestions", enabled: false, action: null }],
    );
  }
  if (hasSafeLink) {
    addSection([{ label: "Copy Link", enabled: true, action: { type: "copy-link" } }]);
  }
  if (params.mediaType === "image") {
    addSection([{ label: "Copy Image", enabled: true, action: { type: "copy-image" } }]);
  }
  addSection(
    EDIT_ROLES.map((role) => ({
      label: EDIT_ITEMS[role].label,
      enabled: params.editFlags[EDIT_ITEMS[role].flag],
      action: { type: "edit", role } as const,
    })),
  );
  return entries;
}

/** Editing entries keep their native roles, so the OS supplies their labels and shortcuts. */
export function toNativeContextMenuTemplate(
  entries: readonly WindowContextMenuEntry[],
  run: (action: WindowContextMenuAction) => void,
): Electron.MenuItemConstructorOptions[] {
  return entries.flatMap(({ label, enabled, separatorBefore, action }) => {
    const item: Electron.MenuItemConstructorOptions =
      action?.type === "edit"
        ? { role: action.role, enabled }
        : { label, enabled, ...(action ? { click: () => run(action) } : {}) };
    return separatorBefore ? [{ type: "separator" as const }, item] : [item];
  });
}

/**
 * Hands menus to the page to draw and runs the entry it picks. Each new menu replaces the
 * previous one, so a late answer for an older menu does nothing.
 */
export function makeInPageContextMenus(send: (request: DesktopWindowContextMenuRequest) => void) {
  let lastRequestId = 0;
  let pending: {
    readonly requestId: number;
    readonly entries: readonly WindowContextMenuEntry[];
    readonly run: (action: WindowContextMenuAction) => void;
  } | null = null;

  return {
    show: (
      entries: readonly WindowContextMenuEntry[],
      position: DesktopWindowContextMenuRequest["position"],
      run: (action: WindowContextMenuAction) => void,
    ) => {
      lastRequestId += 1;
      pending = { requestId: lastRequestId, entries, run };
      const items: ContextMenuItem[] = entries.map((entry, index) => ({
        id: String(index),
        label: entry.label,
        ...(entry.action?.type === "edit"
          ? { shortcut: EDIT_ITEMS[entry.action.role].shortcut }
          : {}),
        ...(entry.enabled ? {} : { disabled: true }),
        ...(entry.separatorBefore ? { separatorBefore: true } : {}),
      }));
      send({ requestId: lastRequestId, items, position });
    },
    resolve: (result: unknown) => {
      if (typeof result !== "object" || result === null || pending === null) return;
      const { requestId, itemId } = result as { requestId?: unknown; itemId?: unknown };
      if (requestId !== pending.requestId) return;
      const { entries, run } = pending;
      pending = null;
      const entry = entries.find((_, index) => String(index) === itemId);
      if (entry?.enabled && entry.action) run(entry.action);
    },
  };
}
