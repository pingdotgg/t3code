import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
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

const HEADER_LINE = /^(?:diff --git |--- |\+\+\+ |rename from |rename to )/;
const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;
// A separator in a recorded path: / or \, which a quoted header escapes as \\.
const SEPARATOR = /^(?:\/|\\\\|\\)/;

// Absolute paths under the workspace read relative to it, like the relative paths agents record.
function relativeHeaderPaths(patch: string | undefined, workspaceRoot: string | null | undefined) {
  const root = workspaceRoot?.split(/[\\/]+/).filter(Boolean);
  if (!patch || !root?.length) return patch;
  const sameSegment = /^[A-Za-z]:$/.test(root[0]!)
    ? (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
    : (a: string, b: string) => a === b;
  // Removes the root only where a path starts: after an optional quote and git's a/ or b/.
  const stripAt = (line: string, start: number) => {
    const kept = start + /^"?(?:[ab]\/)?/.exec(line.slice(start))![0].length;
    const separator = (at: number) => SEPARATOR.exec(line.slice(at))?.[0].length ?? 0;
    let at = kept + separator(kept);
    for (const segment of root) {
      if (!sameSegment(line.slice(at, at + segment.length), segment)) return line;
      at += segment.length;
      const width = separator(at);
      if (width === 0) return line;
      at += width;
    }
    return line.slice(0, kept) + line.slice(at);
  };
  let oldLines = 0;
  let newLines = 0;
  return patch
    .split("\n")
    .map((line) => {
      // Hunk lines can start like headers ("--- " is a removed "-- "); count them out.
      if (oldLines > 0 || newLines > 0) {
        if (line.startsWith("-")) oldLines -= 1;
        else if (line.startsWith("+")) newLines -= 1;
        else if (!line.startsWith("\\")) {
          oldLines -= 1;
          newLines -= 1;
        }
        return line;
      }
      const hunk = HUNK_HEADER.exec(line);
      if (hunk) {
        oldLines = Number(hunk[1] ?? 1);
        newLines = Number(hunk[2] ?? 1);
        return line;
      }
      const keyword = HEADER_LINE.exec(line)?.[0];
      if (keyword === undefined) return line;
      if (keyword !== "diff --git ") return stripAt(line, keyword.length);
      const second = Math.max(line.lastIndexOf(' "b/'), line.lastIndexOf(" b/"));
      const both = second > keyword.length ? stripAt(line, second + 1) : line;
      return stripAt(both, keyword.length);
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
  workspaceRoot?: string | null,
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
          { label: "Recorded content before", text: before.text },
          { label: "Recorded content after", text: after.text },
        ].filter((entry): entry is { label: string; text: string } => entry.text !== undefined),
    truncated: diff.truncated || before.truncated || after.truncated,
  };
}
