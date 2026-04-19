import { EDITORS, EditorId, LocalApi } from "@workbench/contracts";
import { getLocalStorageItem, setLocalStorageItem, useLocalStorage } from "./hooks/useLocalStorage";
import { useMemo } from "react";

const LAST_EDITOR_KEY = "workbench:last-editor";
// back-compat read for migration; remove in next major.
const LEGACY_LAST_EDITOR_KEY = "t3code:last-editor";

export function usePreferredEditor(availableEditors: ReadonlyArray<EditorId>) {
  const [lastEditor, setLastEditor] = useLocalStorage(LAST_EDITOR_KEY, null, EditorId);
  // back-compat read for migration; remove in next major.
  const legacyLastEditor = useLocalStorage(LEGACY_LAST_EDITOR_KEY, null, EditorId)[0];

  const effectiveEditor = useMemo(() => {
    const candidate = lastEditor ?? legacyLastEditor;
    if (candidate && availableEditors.includes(candidate)) return candidate;
    return EDITORS.find((editor) => availableEditors.includes(editor.id))?.id ?? null;
  }, [lastEditor, legacyLastEditor, availableEditors]);

  return [effectiveEditor, setLastEditor] as const;
}

export function resolveAndPersistPreferredEditor(
  availableEditors: readonly EditorId[],
): EditorId | null {
  const availableEditorIds = new Set(availableEditors);
  const stored =
    getLocalStorageItem(LAST_EDITOR_KEY, EditorId) ??
    // back-compat read for migration; remove in next major.
    getLocalStorageItem(LEGACY_LAST_EDITOR_KEY, EditorId);
  if (stored && availableEditorIds.has(stored)) return stored;
  const editor = EDITORS.find((editor) => availableEditorIds.has(editor.id))?.id ?? null;
  if (editor) setLocalStorageItem(LAST_EDITOR_KEY, editor, EditorId);
  return editor ?? null;
}

export async function openInPreferredEditor(api: LocalApi, targetPath: string): Promise<EditorId> {
  const { availableEditors } = await api.server.getConfig();
  const editor = resolveAndPersistPreferredEditor(availableEditors);
  if (!editor) throw new Error("No available editors found.");
  await api.shell.openInEditor(targetPath, editor);
  return editor;
}
