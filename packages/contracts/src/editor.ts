import { Schema } from "effect";

export const EDITORS = [
  { id: "cursor", label: "Cursor", command: "cursor" },
  { id: "file-manager", label: "File Manager", command: null },
] as const;

export const EditorId = Schema.Literals(EDITORS.map((e) => e.id));
export type EditorId = typeof EditorId.Type;

export class OpenInEditorInput extends Schema.Class<OpenInEditorInput>("OpenInEditorInput")({
  cwd: Schema.String,
  editor: EditorId,
}) {}
