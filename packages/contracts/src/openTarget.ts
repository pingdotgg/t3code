import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas";

export const WORKSPACE_OPEN_TARGETS = [
  { id: "cursor", label: "Cursor" },
  { id: "vscode", label: "VS Code" },
  { id: "zed", label: "Zed" },
  { id: "ghostty", label: "Ghostty" },
  { id: "file-manager", label: "File Manager" },
] as const;

export const WorkspaceOpenTargetId = Schema.Literals(
  WORKSPACE_OPEN_TARGETS.map((target) => target.id),
);
export type WorkspaceOpenTargetId = typeof WorkspaceOpenTargetId.Type;

export const OpenWorkspaceTargetInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  target: WorkspaceOpenTargetId,
});
export type OpenWorkspaceTargetInput = typeof OpenWorkspaceTargetInput.Type;
