import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas";

export const EDITORS = [
  { id: "cursor", label: "Cursor", command: "cursor" },
  { id: "windsurf", label: "Windsurf", command: "windsurf" },
  { id: "vscode", label: "VS Code", command: "code" },
  { id: "zed", label: "Zed", command: "zed" },
  { id: "positron", label: "Positron", command: "positron" },
  { id: "sublime", label: "Sublime Text", command: "subl" },
  { id: "webstorm", label: "WebStorm", command: "webstorm" },
  { id: "intellij", label: "IntelliJ IDEA", command: "idea" },
  { id: "fleet", label: "Fleet", command: "fleet" },
  { id: "ghostty", label: "Ghostty", command: "ghostty" },
  { id: "file-manager", label: "File Manager", command: null },
] as const;

export const EditorId = Schema.Literals(EDITORS.map((e) => e.id));
export type EditorId = typeof EditorId.Type;

export const OpenInEditorInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  editor: EditorId,
});
export type OpenInEditorInput = typeof OpenInEditorInput.Type;
