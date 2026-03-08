import { EDITORS, type EditorId } from "@t3tools/contracts";

export const LAST_EDITOR_KEY = "t3code:last-editor";

function resolveStorage(storage?: Storage): Storage | null {
  if (storage) {
    return storage;
  }
  if (typeof window === "undefined") {
    return null;
  }
  return window.localStorage;
}

export function normalizeEditorPreference(value: string | null | undefined): EditorId | null {
  if (!value) {
    return null;
  }

  const configured = EDITORS.find((editor) => editor.id === value);
  return configured?.id ?? null;
}

export function readPreferredEditor(storage?: Storage): EditorId | null {
  const resolvedStorage = resolveStorage(storage);
  if (!resolvedStorage) {
    return null;
  }

  return normalizeEditorPreference(resolvedStorage.getItem(LAST_EDITOR_KEY));
}

export function rememberPreferredEditor(editorId: EditorId, storage?: Storage): void {
  const resolvedStorage = resolveStorage(storage);
  if (!resolvedStorage) {
    return;
  }

  resolvedStorage.setItem(LAST_EDITOR_KEY, editorId);
}

export function resolveEffectiveEditor(
  availableEditors: ReadonlyArray<EditorId>,
  storage?: Storage,
): EditorId | null {
  const preferredEditor = readPreferredEditor(storage);
  if (preferredEditor && availableEditors.includes(preferredEditor)) {
    return preferredEditor;
  }

  return availableEditors[0] ?? null;
}

export function resolvePreferredCommandEditor(storage?: Storage): EditorId {
  const preferredEditor = readPreferredEditor(storage);
  if (preferredEditor) {
    const configured = EDITORS.find((editor) => editor.id === preferredEditor);
    if (configured?.command) {
      return configured.id;
    }
  }

  return EDITORS.find((editor) => editor.command)?.id ?? EDITORS[0]?.id ?? "cursor";
}
