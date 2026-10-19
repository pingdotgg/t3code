import type {
  DiffLineAnnotation,
  FileDiffContentsLoader,
  FileDiffMetadata,
  SelectedLineRange,
} from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import type { PullRequestReviewGuideExcerpt, PullRequestReviewPosition } from "@t3tools/contracts";
import { ArrowUpRightIcon } from "lucide-react";
import { useState } from "react";

import { useTheme } from "~/hooks/useTheme";
import {
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPreviousPath,
} from "~/lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "~/lib/syntaxHighlighting";
import {
  buildDiffReviewComment,
  resolveDiffReviewPosition,
  type ReviewCommentContext,
} from "~/reviewCommentContext";

import { DiffCommentAnnotation } from "../../diffs/DiffCommentAnnotation";
import { DIFF_VIEW_UNSAFE_CSS } from "../../diffs/StyledDiffCodeView";
import { Button } from "../../ui/button";
import {
  getReviewPositionAnchor,
  PendingReviewCommentCard,
  toViewerSide,
} from "../PullRequestReviewAnnotation";
import type { PendingReviewComment } from "../pullRequestReviewStore";
import {
  excerptExpansionOldContents,
  excerptRows,
  fileDiffRows,
  rowsToPatch,
} from "@t3tools/client-runtime/review-guide-tour";
import { GuideNoteMarker } from "./GuideNotes";
import { GuideProse } from "./GuideProse";

const EXCERPT_UNSAFE_CSS = `${DIFF_VIEW_UNSAFE_CSS}
[data-code]::-webkit-scrollbar-thumb {
  background-color: var(--diffs-bg-context);
}
`;

export interface ExcerptNoteMarker {
  readonly line: number;
  readonly markers: ReadonlyArray<{ readonly marker: string; readonly title: string }>;
}

export interface ExcerptCommenting {
  readonly canComment: boolean;
  readonly pending: ReadonlyArray<PendingReviewComment>;
  readonly onComment: (comment: {
    readonly path: string;
    readonly oldPath: string | null;
    readonly position: PullRequestReviewPosition;
    readonly body: string;
  }) => void;
  readonly onRemove: (commentId: string) => void;
  readonly onAskAgent: ((comment: ReviewCommentContext, request: string) => void) | null;
}

interface ExcerptAnnotation {
  readonly markers: ExcerptNoteMarker["markers"];
  readonly pending: ReadonlyArray<PendingReviewComment>;
  readonly draft: boolean;
}

interface ExcerptDraft {
  readonly range: SelectedLineRange;
  readonly position: PullRequestReviewPosition;
}

type ExcerptSlice = NonNullable<ReturnType<typeof excerptSlice>>;

function excerptSlice(file: FileDiffMetadata | null, excerpt: PullRequestReviewGuideExcerpt) {
  if (file === null) return null;
  const rows = fileDiffRows(file);
  const shown = excerptRows(rows, excerpt);
  if (shown.length === 0) return null;
  const parsed = getRenderablePatch(
    rowsToPatch(excerpt.path, resolveFileDiffPreviousPath(file), shown),
    `pull-request-guide-excerpt:${excerpt.path}:${excerpt.side}:${excerpt.start}-${excerpt.end}`,
  );
  const fileDiff = parsed?.kind === "files" ? parsed.files[0] : undefined;
  if (fileDiff === undefined) return null;
  const drawn = {
    additions: new Set(shown.flatMap((row) => (row.newLine === null ? [] : [row.newLine]))),
    deletions: new Set(shown.flatMap((row) => (row.oldLine === null ? [] : [row.oldLine]))),
  };
  return { fileDiff, rows: shown, shown: shown.length, total: rows.length, drawn };
}

// The excerpt expands against an old side of its own: the file's real old side differs from
// the new one wherever another hunk changed it, and the renderer needs the two to agree around
// the lines it shows. A slice across hunks has nothing consistent to expand into.
function excerptLoader(
  excerpt: PullRequestReviewGuideExcerpt,
  sliceRows: ExcerptSlice["rows"],
  loadDiffFiles: FileDiffContentsLoader,
): FileDiffContentsLoader | null {
  if (sliceRows.some((row) => row.hunk !== sliceRows[0]?.hunk)) {
    return null;
  }
  return async (fileDiff) => {
    const loaded = await loadDiffFiles(fileDiff);
    const oldContents = excerptExpansionOldContents(loaded.newFile.contents, sliceRows);
    if (oldContents === null) return loaded;
    return {
      newFile: loaded.newFile,
      oldFile: {
        name: loaded.oldFile?.name ?? loaded.newFile.name,
        contents: oldContents,
        cacheKey: `${loaded.newFile.cacheKey ?? loaded.newFile.name}:excerpt:${excerpt.side}:${excerpt.start}-${excerpt.end}`,
      },
    };
  };
}

export function GuideExcerpt({
  excerpt,
  file,
  loading,
  notes,
  commenting,
  loadDiffFiles,
  onOpenFile,
}: {
  excerpt: PullRequestReviewGuideExcerpt;
  file: FileDiffMetadata | null;
  loading: boolean;
  notes: ReadonlyArray<ExcerptNoteMarker>;
  commenting: ExcerptCommenting | null;
  loadDiffFiles: FileDiffContentsLoader;
  onOpenFile: (path: string) => void;
}) {
  // Kept here, not in ExcerptDiff, so a selection survives the diff reloading for a new head.
  const [draft, setDraft] = useState<ExcerptDraft | null>(null);
  const slice = excerptSlice(file, excerpt);

  return (
    <figure className="flex min-w-0 flex-col gap-1.5">
      {excerpt.caption.trim() !== "" ? (
        <figcaption className="text-xs text-muted-foreground">
          <GuideProse text={excerpt.caption} plain />
        </figcaption>
      ) : null}
      {slice !== null && file !== null ? (
        <ExcerptDiff
          excerpt={excerpt}
          file={file}
          slice={slice}
          draft={draft}
          setDraft={setDraft}
          loadDiffFiles={loadDiffFiles}
          notes={notes}
          commenting={commenting}
          onOpenFile={onOpenFile}
        />
      ) : loading ? (
        <p className="rounded-lg border border-border/60 px-3 py-2 text-xs text-muted-foreground">
          Loading {excerpt.path}...
        </p>
      ) : (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 px-3 py-2 text-xs text-muted-foreground">
          <span className="min-w-0 truncate">
            <span className="font-mono text-foreground">{excerpt.path}</span> lines {excerpt.start}-
            {excerpt.end} are not in the loaded diff.
          </span>
          <Button size="xs" variant="outline" onClick={() => onOpenFile(excerpt.path)}>
            Open in Code
          </Button>
        </div>
      )}
    </figure>
  );
}

// Split out so draft changes re-render the diff without re-slicing the patch.
function ExcerptDiff({
  excerpt,
  file,
  slice,
  draft,
  setDraft,
  loadDiffFiles,
  notes,
  commenting,
  onOpenFile,
}: {
  excerpt: PullRequestReviewGuideExcerpt;
  file: FileDiffMetadata;
  slice: ExcerptSlice;
  draft: ExcerptDraft | null;
  setDraft: (draft: ExcerptDraft | null) => void;
  loadDiffFiles: FileDiffContentsLoader;
  notes: ReadonlyArray<ExcerptNoteMarker>;
  commenting: ExcerptCommenting | null;
  onOpenFile: (path: string) => void;
}) {
  const { resolvedTheme } = useTheme();
  const loadExcerptFiles = excerptLoader(excerpt, slice.rows, loadDiffFiles);

  const annotations = (() => {
    const groups = new Map<string, DiffLineAnnotation<ExcerptAnnotation>>();
    const at = (side: "additions" | "deletions", line: number) => {
      const key = `${side}:${line}`;
      const existing = groups.get(key);
      if (existing !== undefined) return existing;
      const created: DiffLineAnnotation<ExcerptAnnotation> = {
        side,
        lineNumber: line,
        metadata: { markers: [], pending: [], draft: false },
      };
      groups.set(key, created);
      return created;
    };
    const update = (
      side: "additions" | "deletions",
      line: number,
      change: (metadata: ExcerptAnnotation) => ExcerptAnnotation,
    ) => {
      const group = at(side, line);
      groups.set(`${side}:${line}`, { ...group, metadata: change(group.metadata) });
    };
    const noteSide = excerpt.side === "new" ? "additions" : "deletions";
    for (const note of notes) {
      update(noteSide, note.line, (metadata) => ({
        ...metadata,
        markers: [...metadata.markers, ...note.markers],
      }));
    }
    for (const comment of commenting?.pending ?? []) {
      if (comment.path !== excerpt.path) continue;
      const anchor = getReviewPositionAnchor(comment.position);
      const side = toViewerSide(anchor.side);
      if (!slice.drawn[side].has(anchor.line)) continue;
      update(side, anchor.line, (metadata) => ({
        ...metadata,
        pending: [...metadata.pending, comment],
      }));
    }
    if (draft !== null) {
      const anchor = getReviewPositionAnchor(draft.position);
      update(toViewerSide(anchor.side), anchor.line, (metadata) => ({ ...metadata, draft: true }));
    }
    return [...groups.values()];
  })();

  const beginComment = (range: SelectedLineRange | null) => {
    if (range === null) return;
    const position = resolveDiffReviewPosition(file, range.end, range.endSide ?? range.side);
    if (position === null) return;
    setDraft({ range, position });
  };
  const interactive = commenting !== null && draft === null;
  const onAskAgent = commenting?.onAskAgent ?? null;
  const askAgent = (request: string) => {
    if (draft === null || onAskAgent === null) return;
    const comment = buildDiffReviewComment({
      id: `pull-request-guide:${excerpt.path}:${draft.range.start}:${draft.range.end}`,
      sectionId: `pull-request-guide:${excerpt.path}`,
      sectionTitle: "Review guide",
      filePath: excerpt.path,
      fileDiff: file,
      range: draft.range,
      text: request,
    });
    setDraft(null);
    if (comment !== null) onAskAgent(comment, request);
  };

  const options = {
    diffStyle: "unified" as const,
    lineDiffType: "none" as const,
    overflow: "scroll" as const,
    theme: resolveDiffThemeName(resolvedTheme),
    themeType: resolvedTheme,
    preferredHighlighter: PREFERRED_HIGHLIGHTER,
    unsafeCSS: EXCERPT_UNSAFE_CSS,
    enableGutterUtility: interactive,
    enableLineSelection: interactive,
    onGutterUtilityClick: beginComment,
    onLineSelectionEnd: beginComment,
    ...(loadExcerptFiles === null
      ? { hunkSeparators: "simple" as const }
      : { loadDiffFiles: loadExcerptFiles }),
  };

  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-border/60">
      <FileDiff<ExcerptAnnotation>
        fileDiff={slice.fileDiff}
        options={options}
        lineAnnotations={annotations}
        selectedLines={draft?.range ?? null}
        renderAnnotation={(annotation) => (
          <div className="font-sans">
            {annotation.metadata.markers.length > 0 ? (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1 text-xs">
                {annotation.metadata.markers.map((entry) => (
                  <span key={entry.marker} className="inline-flex items-center gap-1.5">
                    <GuideNoteMarker marker={entry.marker} />
                    <span className="text-foreground">{entry.title}</span>
                  </span>
                ))}
              </div>
            ) : null}
            {annotation.metadata.pending.map((comment) => (
              <PendingReviewCommentCard
                key={comment.id}
                comment={comment}
                onRemove={() => commenting?.onRemove(comment.id)}
              />
            ))}
            {annotation.metadata.draft && draft !== null && commenting !== null ? (
              <DiffCommentAnnotation
                kind="draft"
                rangeLabel={`${excerpt.path}:${getReviewPositionAnchor(draft.position).line}`}
                text=""
                placeholder={
                  commenting.canComment ? "Add a comment…" : "Ask the agent about these lines…"
                }
                submitLabel={commenting.canComment ? "Add to review" : "Ask agent"}
                {...(commenting.canComment && onAskAgent !== null
                  ? {
                      secondaryAction: {
                        label: "Ask agent",
                        onAction: (text: string) => askAgent(text),
                      },
                    }
                  : {})}
                onCancel={() => setDraft(null)}
                onComment={(body) => {
                  if (!commenting.canComment) {
                    askAgent(body);
                    return;
                  }
                  commenting.onComment({
                    path: excerpt.path,
                    oldPath: previousPathOf(file, excerpt.path),
                    position: draft.position,
                    body,
                  });
                  setDraft(null);
                }}
              />
            ) : null}
          </div>
        )}
        renderHeaderMetadata={() => (
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="tabular-nums">
              {excerpt.side === "old" ? "removed code, " : ""}showing {slice.shown} of {slice.total}{" "}
              diff lines
            </span>
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label={`Open ${excerpt.path} in Code`}
              onClick={() => onOpenFile(excerpt.path)}
            >
              <ArrowUpRightIcon aria-hidden />
            </Button>
          </span>
        )}
      />
    </div>
  );
}

function previousPathOf(file: FileDiffMetadata, path: string): string | null {
  const previous = resolveFileDiffPreviousPath(file);
  return previous === path ? null : previous;
}
