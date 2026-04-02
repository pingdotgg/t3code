import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas";

export const EditorLaunchStyle = Schema.Literals(["direct-path", "goto", "line-column"]);
export type EditorLaunchStyle = typeof EditorLaunchStyle.Type;

type EditorDefinition = {
  readonly id: string;
  readonly label: string;
  readonly command: string | null;
  readonly launchStyle: EditorLaunchStyle;
};

export const EDITORS = [
  { id: "cursor", label: "Cursor", command: "cursor", launchStyle: "goto" },
  { id: "trae", label: "Trae", command: "trae", launchStyle: "goto" },
  { id: "vscode", label: "VS Code", command: "code", launchStyle: "goto" },
  {
    id: "vscode-insiders",
    label: "VS Code Insiders",
    command: "code-insiders",
    launchStyle: "goto",
  },
  { id: "vscodium", label: "VSCodium", command: "codium", launchStyle: "goto" },
  { id: "zed", label: "Zed", command: "zed", launchStyle: "direct-path" },
  { id: "antigravity", label: "Antigravity", command: "agy", launchStyle: "goto" },
  { id: "idea", label: "IntelliJ IDEA", command: "idea", launchStyle: "line-column" },
  { id: "file-manager", label: "File Manager", command: null, launchStyle: "direct-path" },
] as const satisfies ReadonlyArray<EditorDefinition>;

export const EditorId = Schema.Literals(EDITORS.map((e) => e.id));
export type EditorId = typeof EditorId.Type;

export const OpenInEditorInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  editor: EditorId,
});
export type OpenInEditorInput = typeof OpenInEditorInput.Type;

export class OpenError extends Schema.TaggedErrorClass<OpenError>()("OpenError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}
