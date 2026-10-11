import type {
  DiffLineAnnotation,
  FileDiffContentsLoader,
  FileDiffMetadata,
  SelectedLineRange,
} from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import type { PullRequestReviewGuideExcerpt, PullRequestReviewPosition } from "@t3tools/contracts";
import { ArrowUpRightIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

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

// Long lines scroll inside the excerpt. The renderer only shows its scrollbar on hover, which
// reads as code cut off at the edge, so the excerpt keeps it visible.
const EXCERPT_UNSAFE_CSS = `${DIFF_VIEW_UNSAFE_CSS}
[data-code]::-webkit-scrollbar-thumb {
  background-color: var(--diffs-bg-context);
}
`;

export interface ExcerptNoteMarker {
  readonly line: number;
  readonly markers: ReadonlyArray<{ readonly marker: string; readonly title: string }>;
}

/**
 * What a reader can do with lines of an excerpt, the same two things the Code tab offers: queue a
 * comment for the review, or ask an agent about them. Null where neither is possible.
 */
export interface ExcerptCommenting {
  /** Whether a comment can be queued for the review; asking an agent needs no host support. */
  readonly canComment: boolean;
  /** Comments already queued for the review, placed on the lines they belong to. */
  readonly pending: ReadonlyArray<PendingReviewComment>;
  readonly onComment: (comment: {
    readonly path: string;
    readonly oldPath: string | null;
    readonly position: PullRequestReviewPosition;
    readonly body: string;
  }) => void;
  readonly onRemove: (commentId: string) => void;
  /** Opens an agent thread about the lines; null where no thread can be opened. */
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

/**
 * The lines of one excerpt, drawn by the same renderer as the Code tab from a patch cut down to
 * the excerpt's range, so line numbers, colors and highlighting match the full diff. The cut keeps
 * the file's real line numbers, so the bars above and below it load the code around the excerpt
 * from the file itself, as they do between hunks in the Code tab.
 */
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
  /** The file's parsed diff, null while it loads or when the host withheld it. */
  file: FileDiffMetadata | null;
  loading: boolean;
  notes: ReadonlyArray<ExcerptNoteMarker>;
  commenting: ExcerptCommenting | null;
  /** Loads the file's unchanged lines for the bars around the excerpt. */
  loadDiffFiles: FileDiffContentsLoader;
  onOpenFile: (path: string) => void;
}) {
  const [draft, setDraft] = useState<ExcerptDraft | null>(null);
  const { resolvedTheme } = useTheme();
  const slice = useMemo(() => {
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
    // Lines the excerpt draws, by side, so only comments that land on one are placed in it.
    const drawn = {
      additions: new Set(shown.flatMap((row) => (row.newLine === null ? [] : [row.newLine]))),
      deletions: new Set(shown.flatMap((row) => (row.oldLine === null ? [] : [row.oldLine]))),
    };
    return { fileDiff, rows: shown, shown: shown.length, total: rows.length, drawn };
  }, [excerpt, file]);

  // The excerpt expands against an old side of its own: the file's real old side differs from
  // the new one wherever another hunk changed it, and the renderer needs the two to agree around
  // the lines it shows. A slice across hunks has nothing consistent to expand into.
  const sliceRows = slice?.rows ?? null;
  const loadExcerptFiles = useMemo<FileDiffContentsLoader | null>(() => {
    if (sliceRows === null || sliceRows.some((row) => row.hunk !== sliceRows[0]?.hunk)) {
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
  }, [excerpt.end, excerpt.side, excerpt.start, loadDiffFiles, sliceRows]);

  // Notes, queued comments and the draft share one annotation per line, as in the Code tab.
  const annotations = useMemo(() => {
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
      if (!slice?.drawn[side].has(anchor.line)) continue;
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
  }, [commenting?.pending, draft, excerpt.path, excerpt.side, notes, slice]);

  // Positions and the agent's copy of the lines come from the whole file's diff, so a comment
  // lands where the Code tab would put it rather than on the excerpt's cut-down patch.
  const beginComment = useCallback(
    (range: SelectedLineRange | null) => {
      if (range === null || file === null) return;
      const position = resolveDiffReviewPosition(file, range.end, range.endSide ?? range.side);
      if (position === null) return;
      setDraft({ range, position });
    },
    [file],
  );
  const interactive = commenting !== null && draft === null;
  const onAskAgent = commenting?.onAskAgent ?? null;
  const askAgent = (request: string) => {
    if (draft === null || file === null || onAskAgent === null) return;
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

  const options = useMemo(
    () => ({
      diffStyle: "unified" as const,
      lineDiffType: "none" as const,
      overflow: "scroll" as const,
      theme: resolveDiffThemeName(resolvedTheme),
      themeType: resolvedTheme,
      preferredHighlighter: PREFERRED_HIGHLIGHTER,
      unsafeCSS: EXCERPT_UNSAFE_CSS,
      // Hover a line for the gutter button, or drag across line numbers, as in the Code tab.
      enableGutterUtility: interactive,
      enableLineSelection: interactive,
      onGutterUtilityClick: beginComment,
      onLineSelectionEnd: beginComment,
      // Without a loader there is nothing to expand into, so the bars stay plain.
      ...(loadExcerptFiles === null
        ? { hunkSeparators: "simple" as const }
        : { loadDiffFiles: loadExcerptFiles }),
    }),
    [resolvedTheme, interactive, beginComment, loadExcerptFiles],
  );

  return (
    <figure className="flex min-w-0 flex-col gap-1.5">
      {excerpt.caption.trim() !== "" ? (
        <figcaption className="text-xs text-muted-foreground">
          <GuideProse text={excerpt.caption} plain />
        </figcaption>
      ) : null}
      {slice !== null ? (
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
                        oldPath: file === null ? null : previousPathOf(file, excerpt.path),
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
                  {excerpt.side === "old" ? "removed code, " : ""}showing {slice.shown} of{" "}
                  {slice.total} diff lines
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

/** A renamed file's comment carries its old path too, which hosts need to place it. */
function previousPathOf(file: FileDiffMetadata, path: string): string | null {
  const previous = resolveFileDiffPreviousPath(file);
  return previous === path ? null : previous;
}
