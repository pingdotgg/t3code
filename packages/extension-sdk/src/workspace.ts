import { copyJson } from "./contracts.js";

/** Workspace-confined UTF-8 text read; authority and canonical confinement remain host-owned. */
export const WORKSPACE_READ_TEXT = "t3.workspace/read-text";
export type WorkspaceReadTextInput = {
  readonly relativePath: string;
};
export type WorkspaceReadTextResult = {
  readonly relativePath: string;
  readonly contents: string;
  readonly byteLength: number;
  readonly truncated: boolean;
};
export function validateWorkspaceReadTextInput(value: unknown): WorkspaceReadTextInput {
  const input = copyJson(value);
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).length !== 1 ||
    !("relativePath" in input) ||
    typeof input.relativePath !== "string"
  )
    throw new Error("Expected a workspace-relative path");
  const path = input.relativePath;
  if (
    !path ||
    path !== path.trim() ||
    path.length > 1024 ||
    /[\\:]/.test(path) ||
    [...path].some((character) => character.charCodeAt(0) < 32) ||
    path.startsWith("/") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("Expected a workspace-relative path using forward slashes");
  return { relativePath: path };
}
export function validateWorkspaceReadTextResult(value: unknown): WorkspaceReadTextResult {
  const result = copyJson(value);
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    Object.keys(result).length !== 4 ||
    !("relativePath" in result) ||
    !("contents" in result) ||
    typeof result.contents !== "string" ||
    !("byteLength" in result) ||
    typeof result.byteLength !== "number" ||
    !Number.isSafeInteger(result.byteLength) ||
    result.byteLength < 0 ||
    !("truncated" in result) ||
    typeof result.truncated !== "boolean"
  )
    throw new Error("Invalid workspace text result");
  const { relativePath } = validateWorkspaceReadTextInput({ relativePath: result.relativePath });
  return {
    relativePath,
    contents: result.contents,
    byteLength: result.byteLength,
    truncated: result.truncated,
  };
}
