import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas";

export const WORKSPACE_TARGETS = [
  { id: "cursor", label: "Cursor", command: "cursor" },
  { id: "vscode", label: "VS Code", command: "code" },
  { id: "zed", label: "Zed", command: "zed" },
  { id: "file-manager", label: "File Manager", command: null },
  { id: "ghostty", label: "Ghostty", command: "ghostty" },
  { id: "cmux", label: "cmux", command: "cmux" },
] as const;

export const WorkspaceTargetId = Schema.Literals(WORKSPACE_TARGETS.map((target) => target.id));
export type WorkspaceTargetId = typeof WorkspaceTargetId.Type;

export const WorkspaceTargetLaunchInput = Schema.Struct({
  path: TrimmedNonEmptyString,
  target: WorkspaceTargetId,
});
export type WorkspaceTargetLaunchInput = typeof WorkspaceTargetLaunchInput.Type;
