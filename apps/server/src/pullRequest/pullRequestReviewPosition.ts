import type { PullRequestReviewPosition } from "@t3tools/contracts";

import { HUNK_HEADER, headerPath } from "./pullRequestReviewGuideNormalize.ts";

/** `new` numbers a line in the PR's head, `old` in its base. */
export type ReviewLineSide = "new" | "old";

/** Where a line of `path` sits in a unified patch, or null when the patch does not show it. */
export function reviewPositionInPatch(
  patch: string,
  path: string,
  line: number,
  side: ReviewLineSide,
): PullRequestReviewPosition | null {
  let oldPath: string | null = null;
  let inFile = false;
  let inHunks = false;
  let oldLine = 0;
  let newLine = 0;
  for (const text of patch.split("\n")) {
    if (text.startsWith("diff --git ")) {
      oldPath = null;
      inFile = false;
      inHunks = false;
    } else if (!inHunks && text.startsWith("--- ")) {
      oldPath = headerPath(text, "a/");
    } else if (!inHunks && text.startsWith("+++ ")) {
      inFile = (headerPath(text, "b/") ?? oldPath) === path;
    } else if (text.startsWith("@@")) {
      // Every file's hunks count, so another file's `+++ ` source line is never a header.
      const header = HUNK_HEADER.exec(text);
      if (header === null) continue;
      inHunks = true;
      oldLine = Number(header[1]);
      newLine = Number(header[3]);
    } else if (inFile && inHunks) {
      if (text.startsWith("+")) {
        if (side === "new" && newLine === line) return { kind: "added", newLine };
        newLine += 1;
      } else if (text.startsWith("-")) {
        if (side === "old" && oldLine === line) return { kind: "deleted", oldLine };
        oldLine += 1;
      } else if (text.startsWith(" ")) {
        if ((side === "new" ? newLine : oldLine) === line) {
          return { kind: "context", oldLine, newLine, side: side === "new" ? "right" : "left" };
        }
        oldLine += 1;
        newLine += 1;
      }
    }
  }
  return null;
}
