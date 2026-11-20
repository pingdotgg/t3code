import { EDITORS, type EditorId } from "@t3tools/contracts";

/**
 * The editors the menu lists: the one opened last first when the server still offers it, and the
 * server's own order otherwise.
 */
export function editorMenu(
  available: ReadonlyArray<EditorId>,
  lastPick: string | null,
): ReadonlyArray<EditorId> {
  const first = available.find((id) => id === lastPick);
  return first === undefined ? available : [first, ...available.filter((id) => id !== first)];
}

export const editorLabel = (id: EditorId): string =>
  EDITORS.find((editor) => editor.id === id)?.label ?? id;
