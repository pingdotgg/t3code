import { EDITORS, type EditorId } from "@t3tools/contracts";

import { translateDynamic } from "./i18nCore";
import { getLocalFileManagerName } from "~/lib/utils";

const editorLabels = new Map<EditorId, string>(EDITORS.map((editor) => [editor.id, editor.label]));

export function editorLabelForPlatform(editorId: EditorId, platform: string): string {
  if (editorId === "file-manager") {
    return getLocalFileManagerName(platform);
  }

  return editorLabels.get(editorId) ?? "Editor";
}

export function openInEditorMenuLabel(editorId: EditorId | null): string {
  return editorId === null || editorId === "file-manager"
    ? translateDynamic("chat:openIn.openInEditor")
    : translateDynamic("chat:openIn.openInApp", {
        app: editorLabels.get(editorId) ?? translateDynamic("chat:openIn.editor"),
      });
}
