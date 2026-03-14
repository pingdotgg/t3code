import { EDITORS, EditorId, NativeApi } from "@t3tools/contracts";
import {
  getLocalStorageItem,
  removeLocalStorageItem,
  setLocalStorageItem,
  useLocalStorage,
} from "./hooks/useLocalStorage";
import { useMemo } from "react";

const LAST_EDITOR_KEY = "t3code:last-editor";

function isKnownEditorId(value: string): value is EditorId {
  return EDITORS.some((editor) => editor.id === value);
}

function readStoredPreferredEditor(): { editor: EditorId | null; needsMigration: boolean } {
  try {
    return {
      editor: getLocalStorageItem(LAST_EDITOR_KEY, EditorId),
      needsMigration: false,
    };
  } catch {
    if (typeof window === "undefined") {
      return { editor: null, needsMigration: false };
    }

    const raw = window.localStorage.getItem(LAST_EDITOR_KEY);
    if (!raw) {
      return { editor: null, needsMigration: false };
    }

    if (isKnownEditorId(raw)) {
      return { editor: raw, needsMigration: true };
    }

    removeLocalStorageItem(LAST_EDITOR_KEY);
    return { editor: null, needsMigration: false };
  }
}

export function usePreferredEditor(availableEditors: ReadonlyArray<EditorId>) {
  const [lastEditor, setLastEditor] = useLocalStorage(LAST_EDITOR_KEY, null, EditorId);

  const effectiveEditor = useMemo(() => {
    if (lastEditor && availableEditors.includes(lastEditor)) return lastEditor;
    return EDITORS.find((editor) => availableEditors.includes(editor.id))?.id ?? null;
  }, [lastEditor, availableEditors]);

  return [effectiveEditor, setLastEditor] as const;
}

export function resolveAndPersistPreferredEditor(
  availableEditors: readonly EditorId[],
): EditorId | null {
  const availableEditorIds = new Set(availableEditors);
  const stored = readStoredPreferredEditor();
  if (stored.editor && availableEditorIds.has(stored.editor)) {
    if (stored.needsMigration) {
      setLocalStorageItem(LAST_EDITOR_KEY, stored.editor, EditorId);
    }
    return stored.editor;
  }
  const editor = EDITORS.find((editor) => availableEditorIds.has(editor.id))?.id ?? null;
  if (editor) setLocalStorageItem(LAST_EDITOR_KEY, editor, EditorId);
  return editor ?? null;
}

export async function openInPreferredEditor(api: NativeApi, targetPath: string): Promise<EditorId> {
  const { availableEditors } = await api.server.getConfig();
  const editor = resolveAndPersistPreferredEditor(availableEditors);
  if (!editor) throw new Error("No available editors found.");
  await api.shell.openInEditor(targetPath, editor);
  return editor;
}
