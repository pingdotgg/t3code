/**
 * Converts provider tool `args` from an approval request into a renderable
 * diff result.  The function is intentionally defensive -- unknown or
 * malformed payloads gracefully fall back to `{ kind: "unknown" }`.
 */

// ---------------------------------------------------------------------------
// Public result type
// ---------------------------------------------------------------------------

export type ApprovalDiffResult =
  | { kind: "diff"; patch: string; filePath: string }
  | { kind: "command"; command: string; detail?: string }
  | { kind: "file-read"; filePath: string }
  | { kind: "unknown" };

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function toolArgsToDiff(
  args: unknown,
  requestKind: "command" | "file-read" | "file-change",
): ApprovalDiffResult {
  if (args == null || typeof args !== "object") {
    return { kind: "unknown" };
  }

  const record = args as Record<string, unknown>;

  // Claude Code adapter shape: { toolName, input, toolUseId? }
  if (typeof record.toolName === "string" && record.input != null) {
    return fromClaudeCodeArgs(record.toolName, record.input, requestKind);
  }

  // Codex adapter: raw payload – attempt to detect common shapes
  return fromRawPayload(record, requestKind);
}

// ---------------------------------------------------------------------------
// Claude Code adapter
// ---------------------------------------------------------------------------

function fromClaudeCodeArgs(
  toolName: string,
  input: unknown,
  requestKind: "command" | "file-read" | "file-change",
): ApprovalDiffResult {
  if (input == null || typeof input !== "object") {
    return { kind: "unknown" };
  }
  const inp = input as Record<string, unknown>;

  // Dispatch by toolName first for unambiguous matching
  switch (toolName) {
    case "Edit":
      if (
        typeof inp.file_path === "string" &&
        typeof inp.old_string === "string" &&
        typeof inp.new_string === "string"
      ) {
        return {
          kind: "diff",
          patch: generateEditDiff(inp.file_path, inp.old_string, inp.new_string),
          filePath: inp.file_path,
        };
      }
      break;

    case "Write":
    case "NotebookEdit":
      if (typeof inp.file_path === "string" && typeof inp.content === "string") {
        return {
          kind: "diff",
          patch: generateNewFileDiff(inp.file_path, inp.content),
          filePath: inp.file_path,
        };
      }
      break;

    case "Bash":
      if (typeof inp.command === "string") {
        const result: ApprovalDiffResult = { kind: "command", command: inp.command };
        if (typeof inp.description === "string") {
          result.detail = inp.description;
        }
        return result;
      }
      break;

    case "Read":
    case "Glob":
    case "Grep":
      if (typeof inp.file_path === "string") {
        return { kind: "file-read", filePath: inp.file_path };
      }
      break;
  }

  // Fallback: structural pattern matching for unknown tool names
  if (
    typeof inp.file_path === "string" &&
    typeof inp.old_string === "string" &&
    typeof inp.new_string === "string"
  ) {
    return {
      kind: "diff",
      patch: generateEditDiff(inp.file_path, inp.old_string, inp.new_string),
      filePath: inp.file_path,
    };
  }
  if (typeof inp.file_path === "string" && typeof inp.content === "string") {
    return {
      kind: "diff",
      patch: generateNewFileDiff(inp.file_path, inp.content),
      filePath: inp.file_path,
    };
  }
  if (typeof inp.command === "string") {
    const result: ApprovalDiffResult = { kind: "command", command: inp.command };
    if (typeof inp.description === "string") {
      result.detail = inp.description;
    }
    return result;
  }
  if (typeof inp.file_path === "string" && requestKind === "file-read") {
    return { kind: "file-read", filePath: inp.file_path };
  }

  return { kind: "unknown" };
}

// ---------------------------------------------------------------------------
// Codex / raw payload fallback
// ---------------------------------------------------------------------------

function fromRawPayload(
  record: Record<string, unknown>,
  requestKind: "command" | "file-read" | "file-change",
): ApprovalDiffResult {
  // Check for common Codex shapes
  if (typeof record.command === "string") {
    return { kind: "command", command: record.command };
  }

  if (typeof record.file_path === "string" && typeof record.content === "string") {
    return {
      kind: "diff",
      patch: generateNewFileDiff(record.file_path, record.content),
      filePath: record.file_path,
    };
  }

  if (
    typeof record.file_path === "string" &&
    typeof record.old_string === "string" &&
    typeof record.new_string === "string"
  ) {
    return {
      kind: "diff",
      patch: generateEditDiff(record.file_path, record.old_string, record.new_string),
      filePath: record.file_path,
    };
  }

  if (typeof record.file_path === "string" && requestKind === "file-read") {
    return { kind: "file-read", filePath: record.file_path };
  }

  return { kind: "unknown" };
}

// ---------------------------------------------------------------------------
// Unified-diff generation helpers
// ---------------------------------------------------------------------------

/**
 * Generate a unified diff for an edit operation (string replacement).
 */
function generateEditDiff(
  filePath: string,
  oldString: string,
  newString: string,
): string {
  const oldLines = oldString.split("\n");
  const newLines = newString.split("\n");
  const removals = oldLines.map((line) => `-${line}`).join("\n");
  const additions = newLines.map((line) => `+${line}`).join("\n");
  const hunk = `@@ -1,${oldLines.length} +1,${newLines.length} @@\n${removals}\n${additions}`;
  return `--- a/${filePath}\n+++ b/${filePath}\n${hunk}`;
}

/**
 * Generate a unified diff for a new-file write (all additions).
 */
function generateNewFileDiff(filePath: string, content: string): string {
  if (content.length === 0) {
    return `--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +0,0 @@`;
  }
  const lines = content.split("\n");
  // Omit trailing empty line from split if the file ends with a newline
  const effectiveLines =
    lines.length > 1 && lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;

  const additions = effectiveLines.map((line) => `+${line}`).join("\n");
  return `--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${effectiveLines.length} @@\n${additions}`;
}
