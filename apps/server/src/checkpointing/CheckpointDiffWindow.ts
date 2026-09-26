import * as NodeCrypto from "node:crypto";
import {
  CHECKPOINT_DIFF_WINDOW_ROWS,
  type CheckpointDiffFile,
  type CheckpointDiffPage,
  type CheckpointDiffRow,
} from "@t3tools/contracts";
import { unquoteGitPatchPath } from "@t3tools/shared/gitPatchPath";

type MutableFile = { -readonly [K in keyof CheckpointDiffFile]: CheckpointDiffFile[K] } & {
  lineStarts: Array<{ lineIndex: number; rowIndex: number }>;
};

function patchPath(value: string): string {
  const path = unquoteGitPatchPath(value.split("\t", 1)[0]!);
  return path === "/dev/null" ? path : path.replace(/^[ab]\//, "");
}

/** Consumes the complete Git stream while retaining only one window of line contents. */
export function createCheckpointDiffWindow(start: number) {
  const decoder = new TextDecoder();
  const hash = NodeCrypto.createHash("sha256");
  const files: MutableFile[] = [];
  const rows: CheckpointDiffRow[] = [];
  let pending = "";
  let rowCount = 0;
  let lineIndex = 0;
  let oldLine = 0;
  let newLine = 0;
  let oldRemaining = 0;
  let newRemaining = 0;
  let received = false;

  function emit(kind: CheckpointDiffRow["kind"], content: string, marker = " ") {
    const file = files.at(-1);
    if (!file) return;
    if (rowCount >= start && rowCount < start + CHECKPOINT_DIFF_WINDOW_ROWS) {
      rows.push({
        index: rowCount,
        fileIndex: files.length - 1,
        kind,
        content,
        change: marker === "+" ? "add" : marker === "-" ? "delete" : "context",
        oldLineNumber: kind === "line" && marker !== "+" ? oldLine : null,
        newLineNumber: kind === "line" && marker !== "-" ? newLine : null,
        lineIndex,
      });
    }
    rowCount += 1;
    file.rowCount += 1;
    if (kind === "line") {
      const previous = file.lineStarts.at(-1);
      if (!previous || previous.rowIndex - previous.lineIndex !== rowCount - 1 - lineIndex) {
        file.lineStarts.push({ lineIndex, rowIndex: rowCount - 1 });
      }
      file.lineCount += 1;
      lineIndex += 1;
      if (marker !== "+") {
        oldLine += 1;
        oldRemaining -= 1;
      }
      if (marker !== "-") {
        newLine += 1;
        newRemaining -= 1;
      }
      if (marker === "+") file.additions += 1;
      if (marker === "-") file.deletions += 1;
      if (file.changeType === "rename-pure") file.changeType = "rename-changed";
    }
  }

  function line(text: string) {
    if (text.startsWith("diff --git ")) {
      // Quoted names may contain escaped spaces; unquoted names may contain real ones.
      const match = /^diff --git ("(?:[^"\\]|\\.)*"|a\/.*?) ("(?:[^"\\]|\\.)*"|b\/.*)$/.exec(text);
      const oldPath = patchPath(match?.[1] ?? "");
      const path = patchPath(match?.[2] ?? oldPath);
      files.push({
        path,
        previousPath: oldPath !== path ? oldPath : null,
        changeType: "change",
        additions: 0,
        deletions: 0,
        rowStart: rowCount,
        rowCount: 0,
        lineCount: 0,
        lineStarts: [],
      });
      lineIndex = 0;
      oldRemaining = newRemaining = 0;
      return;
    }
    const file = files.at(-1);
    if (!file) return;
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      oldRemaining = Number(hunk[2] ?? 1);
      newRemaining = Number(hunk[4] ?? 1);
      emit("hunk", text);
    } else if ((oldRemaining > 0 || newRemaining > 0) && /^[ +-]/.test(text)) {
      emit("line", text.slice(1), text[0]);
    } else if (text.startsWith("new file mode ")) {
      file.changeType = "new";
    } else if (text.startsWith("deleted file mode ")) {
      file.changeType = "deleted";
    } else if (text.startsWith("rename from ") || text.startsWith("copy from ")) {
      file.previousPath = unquoteGitPatchPath(text.slice(text.indexOf("from ") + 5));
      file.changeType = "rename-pure";
    } else if (text.startsWith("rename to ") || text.startsWith("copy to ")) {
      file.path = unquoteGitPatchPath(text.slice(text.indexOf("to ") + 3));
    } else if (text.startsWith("+++ ") && text !== "+++ /dev/null") {
      file.path = patchPath(text.slice(4));
    } else if (text.startsWith("--- ") && text !== "--- /dev/null") {
      const previousPath = patchPath(text.slice(4));
      if (previousPath !== file.path) file.previousPath = previousPath;
    } else if (text.startsWith("Binary files ") || text === "GIT binary patch") {
      emit("notice", "Binary file contents are not available as a text diff.");
    } else if (text.startsWith("\\ No newline")) {
      emit("hunk", text);
    }
  }

  function consume(text: string) {
    let from = 0;
    for (let end = text.indexOf("\n"); end !== -1; end = text.indexOf("\n", from)) {
      line(pending + text.slice(from, end));
      pending = "";
      from = end + 1;
    }
    pending += text.slice(from);
  }

  return {
    write(chunk: Uint8Array) {
      received = true;
      hash.update(chunk);
      consume(decoder.decode(chunk, { stream: true }));
    },
    finish(fallback: string): CheckpointDiffPage {
      // Non-streaming checkpoint adapters can still supply their complete patch.
      if (!received) {
        hash.update(fallback);
        consume(fallback);
      }
      consume(decoder.decode());
      if (pending) line(pending);
      return { revision: hash.digest("hex"), files, rowCount, start, rows };
    },
  };
}
