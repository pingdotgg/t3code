import { EDITORS, type EditorId, type NativeApi } from "@t3tools/contracts";

const LAST_EDITOR_KEY = "t3code:last-editor";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isEditorId(value: string | null): value is EditorId {
  return EDITORS.some((editor) => editor.id === value);
}

export function readStoredPreferredEditor(
  storage: StorageLike | null = defaultStorage(),
): EditorId | null {
  const stored = storage?.getItem(LAST_EDITOR_KEY) ?? null;
  return isEditorId(stored) ? stored : null;
}

export function writeStoredPreferredEditor(
  editor: EditorId,
  storage: StorageLike | null = defaultStorage(),
): void {
  storage?.setItem(LAST_EDITOR_KEY, editor);
}

export function resolvePreferredEditor(
  availableEditors: readonly EditorId[],
  storage: StorageLike | null = defaultStorage(),
): EditorId | null {
  const stored = readStoredPreferredEditor(storage);
  if (stored && availableEditors.includes(stored)) {
    return stored;
  }

  const availableEditorIds = new Set(availableEditors);
  return EDITORS.find((editor) => availableEditorIds.has(editor.id))?.id ?? null;
}

export function resolveAndPersistPreferredEditor(
  availableEditors: readonly EditorId[],
  storage: StorageLike | null = defaultStorage(),
): EditorId | null {
  const editor = resolvePreferredEditor(availableEditors, storage);
  if (editor) {
    writeStoredPreferredEditor(editor, storage);
  }
  return editor;
}

export async function openInPreferredEditor(
  api: Pick<NativeApi, "server" | "shell">,
  targetPath: string,
  storage: StorageLike | null = defaultStorage(),
): Promise<EditorId> {
  const { availableEditors } = await api.server.getConfig();
  const editor = resolveAndPersistPreferredEditor(availableEditors, storage);
  if (!editor) {
    throw new Error("No available editors found.");
  }

  await api.shell.openInEditor(targetPath, editor);
  return editor;
}
