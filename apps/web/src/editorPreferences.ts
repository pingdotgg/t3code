import { type EditorId, EDITORS } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";

import { serverConfigQueryOptions } from "./lib/serverReactQuery";

export const LAST_EDITOR_KEY = "t3code:last-editor";
export const EMPTY_AVAILABLE_EDITORS: EditorId[] = [];
const EDITOR_IDS_WITH_COMMAND = new Set(
  EDITORS.filter((editor) => editor.command).map((editor) => editor.id),
);

function isFileOpenEditor(editorId: EditorId): boolean {
  return EDITOR_IDS_WITH_COMMAND.has(editorId);
}

function readStoredEditorPreference(): EditorId | null {
  if (typeof window === "undefined") return null;

  const stored = window.localStorage.getItem(LAST_EDITOR_KEY);
  return EDITORS.some((editor) => editor.id === stored) ? (stored as EditorId) : null;
}

function resolvePreferredEditor(
  availableEditors: ReadonlyArray<EditorId>,
  storedEditor: EditorId | null,
): EditorId | null {
  const eligibleEditors = availableEditors.filter(isFileOpenEditor);

  if (storedEditor && eligibleEditors.includes(storedEditor)) {
    return storedEditor;
  }

  return eligibleEditors[0] ?? null;
}

export function getPreferredEditor(availableEditors: ReadonlyArray<EditorId>): EditorId | null {
  return resolvePreferredEditor(availableEditors, readStoredEditorPreference());
}

export function useAvailableEditors(): ReadonlyArray<EditorId> {
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  return serverConfigQuery.data?.availableEditors ?? EMPTY_AVAILABLE_EDITORS;
}
