import { FileDiff } from "@pierre/diffs/react";

import {
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from "../../lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "../../lib/syntaxHighlighting";
import {
  buildReviewCommentRenderablePatch,
  type ReviewCommentContext,
} from "../../reviewCommentContext";
import { DiffWorkerPoolProvider } from "../DiffWorkerPoolProvider";

/** The diff of a review comment quoted in a user message. Loaded lazily with the diff renderer. */
export function ReviewCommentDiff({
  comment,
  resolvedTheme,
}: {
  comment: ReviewCommentContext;
  resolvedTheme: "light" | "dark";
}) {
  const renderablePatch = getRenderablePatch(
    buildReviewCommentRenderablePatch(comment),
    `review-comment:${comment.id}`,
  );
  if (renderablePatch?.kind === "files") {
    return (
      <DiffWorkerPoolProvider>
        {renderablePatch.files.map((fileDiff) => (
          <FileDiff
            key={resolveFileDiffPath(fileDiff)}
            fileDiff={fileDiff}
            options={{
              collapsed: false,
              diffStyle: "unified",
              theme: resolveDiffThemeName(resolvedTheme),
              preferredHighlighter: PREFERRED_HIGHLIGHTER,
            }}
          />
        ))}
      </DiffWorkerPoolProvider>
    );
  }
  if (renderablePatch?.kind === "raw") {
    return (
      <pre className="overflow-x-auto rounded-md bg-muted/40 p-2 text-xs">
        {renderablePatch.text}
      </pre>
    );
  }
  return null;
}
