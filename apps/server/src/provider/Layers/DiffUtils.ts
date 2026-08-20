export function synthesizeUnifiedDiff(oldText: string, newText: string): string {
  const oldLines = oldText === "" ? [] : oldText.split("\n");
  const newLines = newText === "" ? [] : newText.split("\n");
  if (oldLines[oldLines.length - 1] === "") oldLines.pop();
  if (newLines[newLines.length - 1] === "") newLines.pop();
  const oldCount = oldLines.length;
  const newCount = newLines.length;
  const lines: string[] = [];
  lines.push(`@@ -1,${oldCount} +1,${newCount} @@`);
  for (const line of oldLines) {
    lines.push(`-${line}`);
  }
  for (const line of newLines) {
    lines.push(`+${line}`);
  }
  return lines.join("\n");
}

/**
 * Shared file-change extraction for provider adapters.
 *
 * Normalizes tool names case-insensitively and tries multiple field-name
 * patterns so both Claude (snake_case) and OpenCode (camelCase + snake_case)
 * inputs are handled by a single code path.
 *
 * Returns `undefined` when the tool is not a file-change tool or required
 * fields are missing. Entries with an unresolvable file path are filtered out.
 */
export function extractToolFileChanges(
  toolName: string,
  input: Record<string, unknown>,
): Array<{ path: string; diff: string }> | undefined {
  const normalized = toolName.toLowerCase();

  if (
    !(
      normalized.includes("edit") ||
      normalized.includes("write") ||
      normalized.includes("patch") ||
      normalized.includes("multiedit")
    )
  ) {
    return undefined;
  }

  // Skip TodoWrite / similar todo-related write tools
  if (normalized.includes("write") && normalized.includes("todo")) {
    return undefined;
  }

  // Resolve file path from multiple field-name conventions
  const filePath =
    typeof input.file_path === "string"
      ? input.file_path
      : typeof input.filePath === "string"
        ? input.filePath
        : typeof input.path === "string"
          ? input.path
          : undefined;
  if (!filePath) return undefined;

  // Edit-style: old_string/oldString + new_string/newString → unified diff
  const oldString =
    typeof input.old_string === "string"
      ? input.old_string
      : typeof input.oldString === "string"
        ? input.oldString
        : undefined;
  const newString =
    typeof input.new_string === "string"
      ? input.new_string
      : typeof input.newString === "string"
        ? input.newString
        : undefined;
  if (oldString !== undefined && newString !== undefined) {
    return [{ path: filePath, diff: synthesizeUnifiedDiff(oldString, newString) }];
  }

  // Write-style: content/new_content → create diff from empty
  const content =
    typeof input.content === "string"
      ? input.content
      : typeof input.new_content === "string"
        ? input.new_content
        : undefined;
  if (content !== undefined) {
    return [{ path: filePath, diff: synthesizeUnifiedDiff("", content) }];
  }

  // Patch-style fallback: input.patch as raw patch string
  const patch = typeof input.patch === "string" ? input.patch : undefined;
  if (patch && patch.length > 0) {
    return [{ path: filePath, diff: patch }];
  }

  return undefined;
}
