import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../i18n/messages";
import { getRenderablePatch, resolveFileDiffPath } from "./diffRendering";

type FileChange = Extract<OrchestrationV2TurnItem, { type: "file_change" }>;

function toolCallPatch(item: Pick<FileChange, "diffStr" | "fileName" | "changes">) {
  let patch = item.diffStr;
  if (!patch) return patch;
  const change = item.changes?.[0];
  const rawFileOperation = change?.operation === "add" || change?.operation === "delete";
  if (patch.startsWith("diff --git ") || patch.startsWith("--- ")) {
    if (!rawFileOperation) return patch;
    const parsed = getRenderablePatch(patch, "tool-call-format");
    if (
      parsed?.kind === "files" &&
      parsed.files.every((file) => {
        const path = resolveFileDiffPath(file).replaceAll("\\", "/");
        return (
          file.hunks.length > 0 &&
          item.changes?.some((recorded) => {
            const recordedPath = recorded.path.replaceAll("\\", "/");
            return (
              (recorded.operation === "add"
                ? file.deletionLines.length === 0
                : recorded.operation === "delete"
                  ? file.additionLines.length === 0
                  : true) &&
              (recordedPath === path || recordedPath.endsWith(`/${path}`))
            );
          })
        );
      })
    )
      return patch;
  }
  // Codex can record added/deleted file contents or bare hunks instead of a complete patch.
  if (rawFileOperation || !patch.trimStart().startsWith("@@ ")) {
    if (!rawFileOperation) return patch;
    const lines = patch.split("\n");
    const hasFinalNewline = patch.endsWith("\n");
    if (hasFinalNewline) lines.pop();
    const added = change.operation === "add";
    const range = `1,${lines.length}`;
    patch = `@@ -${added ? "0,0" : range} +${added ? range : "0,0"} @@\n${lines.map((line) => `${added ? "+" : "-"}${line}`).join("\n")}\n${hasFinalNewline ? "" : "\\ No newline at end of file\n"}`;
  }
  const oldPath = change?.oldPath ?? item.fileName;
  const newPath = change?.path ?? item.fileName;
  const before = change?.operation === "add" ? "/dev/null" : JSON.stringify(`a/${oldPath}`);
  const after = change?.operation === "delete" ? "/dev/null" : JSON.stringify(`b/${newPath}`);
  return `diff --git ${JSON.stringify(`a/${oldPath}`)} ${JSON.stringify(`b/${newPath}`)}\n--- ${before}\n+++ ${after}\n${patch.trimStart()}`;
}

// Claude records absolute paths; name files under the workspace relative to it, as other diffs do.
// Only header lines, from the start or a `diff --git` line up to the first hunk, are rewritten.
function relativeHeaderPaths(patch: string | undefined, workspaceRoot: string | undefined) {
  const windows = /^(?:[A-Za-z]:[\\/]|\\\\)/.test(workspaceRoot ?? "");
  const segments = workspaceRoot?.split(windows ? /[\\/]+/ : /\/+/);
  while (segments?.at(-1) === "") segments.pop();
  if (!patch || !segments?.some(Boolean)) return patch;
  // Windows separates with / or \ (\\ in a quoted header); POSIX only with /, where a \ is part of
  // a name and a quoted header doubles it.
  const separator = windows ? String.raw`[\\/]+` : "/+";
  const root = segments
    .map((segment) =>
      segment
        .split("\\")
        .map((text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(String.raw`\\\\?`),
    )
    .join(separator);
  const prefix = new RegExp(String.raw`^("?(?:[ab]/)?)${root}${separator}`, windows ? "i" : "");
  const relative = (name: string) => name.replace(prefix, "$1");
  let inHeader = true;
  return patch
    .split("\n")
    .map((line) => {
      if (line.startsWith("diff --git ")) {
        inHeader = true;
        // Split the names as Pierre's parser does, so a name containing a space stays whole.
        const names =
          /^diff --git ("a\/(?:[^"\\]|\\.)*"|a\/.+?) ("b\/(?:[^"\\]|\\.)*"|b\/.+?)$/.exec(line);
        return names ? `diff --git ${relative(names[1]!)} ${relative(names[2]!)}` : line;
      }
      if (line.startsWith("@@")) inHeader = false;
      const name = inHeader ? /^(---|\+\+\+)(\s+)(.*)$/.exec(line) : null;
      return name ? `${name[1]}${name[2]}${relative(name[3]!)}` : line;
    })
    .join("\n");
}

function recordedText(value: string | undefined) {
  const suffix = "\n… output truncated for transport";
  const truncated = value !== undefined && value.endsWith(suffix);
  return { text: truncated ? value.slice(0, -suffix.length) : value, truncated };
}

export function toolCallDiff(
  item: Pick<FileChange, "diffStr" | "fileName" | "changes" | "oldStr" | "newStr">,
  workspaceRoot?: string,
  resolve: MessageResolver = m,
) {
  const diff = recordedText(item.diffStr);
  const operation = item.changes?.[0]?.operation;
  const emptyContent = diff.text === "" ? "" : undefined;
  const before = recordedText(item.oldStr ?? (operation === "delete" ? emptyContent : undefined));
  const after = recordedText(item.newStr ?? (operation === "add" ? emptyContent : undefined));
  return {
    patch: relativeHeaderPaths(
      toolCallPatch({ ...item, ...(diff.text === undefined ? {} : { diffStr: diff.text }) }),
      workspaceRoot,
    ),
    content: diff.text?.trim()
      ? []
      : [
          { label: resolve(msg("Recorded content before")), text: before.text },
          { label: resolve(msg("Recorded content after")), text: after.text },
        ].filter((entry): entry is { label: string; text: string } => entry.text !== undefined),
    truncated: diff.truncated || before.truncated || after.truncated,
  };
}
