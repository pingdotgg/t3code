export type PatchLineKind = "header" | "hunk" | "addition" | "deletion" | "context";

export interface PatchLine {
  readonly kind: PatchLineKind;
  readonly text: string;
}

const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

/**
 * Classifies unified-diff lines for plain-text rendering. Hunk line counts decide where a hunk
 * ends, so a removed line that reads `-- x` is not mistaken for the next file's `--- x` header.
 */
export function patchLines(
  patch: string,
  maxLines: number,
): { readonly lines: ReadonlyArray<PatchLine>; readonly hiddenCount: number } {
  const all = (patch.endsWith("\n") ? patch.slice(0, -1) : patch).split("\n");
  const lines: PatchLine[] = [];
  let oldLeft = 0;
  let newLeft = 0;
  for (const text of all.slice(0, maxLines)) {
    // Hunks without ranges carry no counts; they run until the next hunk or file header.
    const unbounded = oldLeft === Infinity;
    if (unbounded && (text.startsWith("@@") || text.startsWith("diff --git "))) {
      oldLeft = 0;
      newLeft = 0;
    }
    if (oldLeft > 0 || newLeft > 0) {
      if (text.startsWith("+")) {
        lines.push({ kind: "addition", text });
        newLeft -= 1;
      } else if (text.startsWith("-")) {
        lines.push({ kind: "deletion", text });
        oldLeft -= 1;
      } else {
        lines.push({ kind: "context", text });
        if (!text.startsWith("\\")) {
          oldLeft -= 1;
          newLeft -= 1;
        }
      }
      continue;
    }
    if (text.startsWith("@@")) {
      const match = HUNK_HEADER.exec(text);
      oldLeft = match ? Number(match[1] ?? 1) : Infinity;
      newLeft = match ? Number(match[2] ?? 1) : Infinity;
      lines.push({ kind: "hunk", text });
      continue;
    }
    lines.push({ kind: text.startsWith("\\") ? "context" : "header", text });
  }
  return { lines, hiddenCount: Math.max(0, all.length - maxLines) };
}
