import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas";

export const EDITORS = [
  { id: "cursor", label: "Cursor", command: "cursor" },
  { id: "vscode", label: "VS Code", command: "code" },
  { id: "zed", label: "Zed", command: "zed" },
  { id: "antigravity", label: "Antigravity", command: "agy" },
  { id: "system-editor", label: "System Editor", command: null },
  { id: "file-manager", label: "File Manager", command: null },
] as const;

export const EditorId = Schema.Literals(EDITORS.map((e) => e.id));
export type EditorId = typeof EditorId.Type;

export const OpenInEditorInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  editor: EditorId,
});
export type OpenInEditorInput = typeof OpenInEditorInput.Type;
