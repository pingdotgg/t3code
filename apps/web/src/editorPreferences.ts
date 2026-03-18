import { EDITORS, EditorId, NativeApi } from "@t3tools/contracts";
import {
  getLocalStorageItem,
  removeLocalStorageItem,
  setLocalStorageItem,
  useLocalStorage,
} from "./hooks/useLocalStorage";
import { useCallback, useMemo } from "react";

const LAST_EDITOR_KEY = "t3code:last-editor";
const LAST_OPEN_TARGET_KEY = "t3code:last-open-target";

function resolveDefaultOpenTarget(availableEditors: ReadonlyArray<EditorId>): EditorId | null {
  if (availableEditors.includes("file-manager")) {
    return "file-manager";
  }

  return EDITORS.find((editor) => availableEditors.includes(editor.id))?.id ?? null;
}

function resolveDefaultPreferredEditor(availableEditors: ReadonlyArray<EditorId>): EditorId | null {
  return (
    EDITORS.find((editor) => editor.id !== "file-manager" && availableEditors.includes(editor.id))
      ?.id ?? (availableEditors.includes("file-manager") ? "file-manager" : null)
  );
}

export function usePreferredEditor(availableEditors: ReadonlyArray<EditorId>) {
  const [lastOpenTarget, setLastOpenTarget] = useLocalStorage(
    LAST_OPEN_TARGET_KEY,
    getLocalStorageItem(LAST_EDITOR_KEY, EditorId),
    EditorId,
  );

  const effectiveEditor = useMemo(() => {
    if (lastOpenTarget && availableEditors.includes(lastOpenTarget)) return lastOpenTarget;
    return resolveDefaultOpenTarget(availableEditors);
  }, [lastOpenTarget, availableEditors]);

  const setPreferredEditor = useCallback(
    (value: EditorId | null | ((val: EditorId | null) => EditorId | null)) => {
      setLastOpenTarget((prev) => {
        const next = typeof value === "function" ? value(prev) : value;
        if (next === null) {
          removeLocalStorageItem(LAST_EDITOR_KEY);
          return next;
        }
        if (next !== "file-manager") {
          setLocalStorageItem(LAST_EDITOR_KEY, next, EditorId);
        }
        return next;
      });
    },
    [setLastOpenTarget],
  );

  return [effectiveEditor, setPreferredEditor] as const;
}

export function resolveAndPersistPreferredEditor(
  availableEditors: readonly EditorId[],
): EditorId | null {
  const availableEditorIds = new Set(availableEditors);
  const stored = getLocalStorageItem(LAST_EDITOR_KEY, EditorId);
  if (stored && availableEditorIds.has(stored)) return stored;
  const editor = resolveDefaultPreferredEditor(availableEditors);
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
