// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as Os from "node:os";

export const COMPUTER_HISTORY_DIR_NAME = "computer-history";
export const SEGMENTS_DIR_NAME = "segments";
export const MEMORIES_DIR_NAME = "memories";
export const RESOURCES_DIR_NAME = "resources";
export const CONTROL_FILE_NAME = "control.json";
export const STATUS_FILE_NAME = "status.json";
export const INSTRUCTIONS_FILE_NAME = "instructions.md";
export const CODEX_SKYSIGHT_RELATIVE = NodePath.join("memories", "extensions", "skysight");

export function computerHistoryRoot(stateDir: string): string {
  return NodePath.join(stateDir, COMPUTER_HISTORY_DIR_NAME);
}

export function computerHistorySegmentsDir(root: string): string {
  return NodePath.join(root, SEGMENTS_DIR_NAME);
}

export function computerHistoryMemoriesDir(root: string): string {
  return NodePath.join(root, MEMORIES_DIR_NAME);
}

export function computerHistoryResourcesDir(root: string): string {
  return NodePath.join(root, MEMORIES_DIR_NAME, RESOURCES_DIR_NAME);
}

export function computerHistoryControlPath(root: string): string {
  return NodePath.join(root, CONTROL_FILE_NAME);
}

export function computerHistoryStatusPath(root: string): string {
  return NodePath.join(root, STATUS_FILE_NAME);
}

export function computerHistoryInstructionsPath(root: string): string {
  return NodePath.join(root, MEMORIES_DIR_NAME, INSTRUCTIONS_FILE_NAME);
}

/** Default Codex home; callers should prefer configured CODEX_HOME when known. */
export function defaultCodexHome(): string {
  return NodePath.join(Os.homedir(), ".codex");
}

export function codexSkysightRoot(codexHome: string): string {
  return NodePath.join(codexHome, CODEX_SKYSIGHT_RELATIVE);
}

export function codexSkysightResourcesDir(codexHome: string): string {
  return NodePath.join(codexSkysightRoot(codexHome), RESOURCES_DIR_NAME);
}
