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

function recordedText(value: string | undefined) {
  const suffix = "\n… output truncated for transport";
  const truncated = value !== undefined && value.endsWith(suffix);
  return { text: truncated ? value.slice(0, -suffix.length) : value, truncated };
}

export function toolCallDiff(
  item: Pick<FileChange, "diffStr" | "fileName" | "changes" | "oldStr" | "newStr">,
) {
  const diff = recordedText(item.diffStr);
  const operation = item.changes?.[0]?.operation;
  const emptyContent = diff.text === "" ? "" : undefined;
  const before = recordedText(item.oldStr ?? (operation === "delete" ? emptyContent : undefined));
  const after = recordedText(item.newStr ?? (operation === "add" ? emptyContent : undefined));
  return {
    patch: toolCallPatch({ ...item, ...(diff.text === undefined ? {} : { diffStr: diff.text }) }),
    content: diff.text?.trim()
      ? []
      : [
          { label: "Recorded content before", text: before.text },
          { label: "Recorded content after", text: after.text },
        ].filter((entry): entry is { label: string; text: string } => entry.text !== undefined),
    truncated: diff.truncated || before.truncated || after.truncated,
  };
}
