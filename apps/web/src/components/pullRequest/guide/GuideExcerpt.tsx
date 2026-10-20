import { reviewPositionRange, reviewPositionLabel } from "@t3tools/client-runtime/review-selection";
import type {
  DiffLineAnnotation,
  FileDiffContentsLoader,
  FileDiffMetadata,
  SelectedLineRange,
} from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import type {
  EnvironmentId,
  PullRequestRef,
  PullRequestReviewThread,
  PullRequestReviewGuideExcerpt,
  PullRequestReviewPosition,
} from "@t3tools/contracts";
import { ArrowUpRightIcon } from "lucide-react";
import { useState, type ReactNode, type RefObject } from "react";

import { useRenderedAppearance } from "~/hooks/useTheme";
import { PierreEntryIcon } from "../../chat/PierreEntryIcon";
import { useClientSettings } from "~/hooks/useSettings";
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
import { INLINE_RENAME_HEADER_CSS } from "../../diffs/StyledDiffCodeView";
import { GUIDE_DIFF_UNSAFE_CSS } from "./guideDiffStyles";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { DiffFileRename } from "../../diffs/DiffFileRename";
import {
  getReviewPositionAnchor,
  PendingReviewCommentCard,
  HostedReviewThreadCard,
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

// When wrapping is off, keep the excerpt's scrollbar visible so long lines do not look cut off.
const EXCERPT_UNSAFE_CSS = `${GUIDE_DIFF_UNSAFE_CSS}
${INLINE_RENAME_HEADER_CSS}
[data-diffs-header] [data-change-icon] {
  display: none;
}
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
  readonly canCommentRanges?: boolean;
  readonly renderAttachments?: (
    onTextChange: (text: string) => void,
    onBusyChange: (busy: boolean) => void,
    textarea: HTMLTextAreaElement | null,
  ) => ReactNode;
  /** Comments already queued for the review, placed on the lines they belong to. */
  readonly pending: ReadonlyArray<PendingReviewComment>;
  readonly threads?: ReadonlyArray<PullRequestReviewThread>;
  readonly pendingCommentTarget: {
    environmentId: EnvironmentId;
    reference: PullRequestRef;
    canCopyLink: boolean;
  };
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
  readonly threads: ReadonlyArray<PullRequestReviewThread>;
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
  viewed,
  onSetViewed,
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
  viewed: boolean;
  onSetViewed: ((viewed: boolean) => void) | null;
}) {
  const [draft, setDraft] = useState<ExcerptDraft | null>(null);
  const resolvedTheme = useRenderedAppearance();
  const settings = useClientSettings();
  const slice = (() => {
    if (file === null) return null;
    const rows = fileDiffRows(file);
    const shown = excerptRows(rows, excerpt);
    if (shown.length === 0) return null;
    const parsed = getRenderablePatch(
      rowsToPatch(excerpt.path, resolveFileDiffPreviousPath(file), shown),
      `pull-request-guide-excerpt:${excerpt.path}:${excerpt.side}:${excerpt.start}-${excerpt.end}:${settings.diffIgnoreWhitespace}`,
      { ignoreWhitespace: settings.diffIgnoreWhitespace },
    );
    const fileDiff = parsed?.kind === "files" ? parsed.files[0] : undefined;
    if (fileDiff === undefined) return null;
    // Lines the excerpt draws, by side, so only comments that land on one are placed in it.
    const drawn = {
      additions: new Set(shown.flatMap((row) => (row.newLine === null ? [] : [row.newLine]))),
      deletions: new Set(shown.flatMap((row) => (row.oldLine === null ? [] : [row.oldLine]))),
    };
    return { fileDiff, rows: shown, shown: shown.length, total: rows.length, drawn };
  })();

  // The excerpt expands against an old side of its own: the file's real old side differs from
  // the new one wherever another hunk changed it, and the renderer needs the two to agree around
  // the lines it shows. A slice across hunks has nothing consistent to expand into.
  const sliceRows = slice?.rows ?? null;
  const loadExcerptFiles = ((): FileDiffContentsLoader | null => {
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
  })();

  // Notes, queued comments and the draft share one annotation per line, as in the Code tab.
  const annotations = (() => {
    const groups = new Map<string, DiffLineAnnotation<ExcerptAnnotation>>();
    const at = (side: "additions" | "deletions", line: number) => {
      const key = `${side}:${line}`;
      const existing = groups.get(key);
      if (existing !== undefined) return existing;
      const created: DiffLineAnnotation<ExcerptAnnotation> = {
        side,
        lineNumber: line,
        metadata: { markers: [], pending: [], threads: [], draft: false },
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
    for (const thread of commenting?.threads ?? []) {
      if (thread.path !== excerpt.path || thread.isOutdated || thread.line === null) continue;
      const side = toViewerSide(thread.side);
      if (!slice?.drawn[side].has(thread.line)) continue;
      update(side, thread.line, (metadata) => ({
        ...metadata,
        threads: [...metadata.threads, thread],
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
  })();

  // Positions and the agent's copy of the lines come from the whole file's diff, so a comment
  // lands where the Code tab would put it rather than on the excerpt's cut-down patch.
  const beginComment = (range: SelectedLineRange | null) => {
    if (range === null || file === null) return;
    const end = resolveDiffReviewPosition(file, range.end, range.endSide ?? range.side);
    const start = resolveDiffReviewPosition(file, range.start, range.side);
    if (end === null) return;
    setDraft({ range, position: start ? reviewPositionRange(start, end) : end });
  };
  const interactive =
    commenting !== null &&
    draft === null &&
    (commenting.canComment || commenting.onAskAgent !== null);
  const canQueueComment =
    commenting?.canComment === true &&
    (draft?.position.startLine === undefined || commenting.canCommentRanges === true);
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

  const options = {
    diffStyle: settings.diffLayout === "split" ? ("split" as const) : ("unified" as const),
    lineDiffType: "none" as const,
    overflow: settings.wordWrap ? ("wrap" as const) : ("scroll" as const),
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
  };

  return (
    <figure className="flex min-w-0 flex-col gap-1.5">
      {excerpt.caption.trim() !== "" ? (
        <figcaption className="px-4 text-xs text-muted-foreground">
          <GuideProse text={excerpt.caption} plain />
        </figcaption>
      ) : null}
      {slice !== null ? (
        <div className="min-w-0 border-y border-border/60">
          <FileDiff<ExcerptAnnotation>
            renderHeaderPrefix={() => (
              <PierreEntryIcon pathValue={excerpt.path} kind="file" theme={resolvedTheme} />
            )}
            renderHeaderFilenameSuffix={() => (file ? <DiffFileRename file={file} /> : null)}
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
                {commenting !== null
                  ? annotation.metadata.threads.map((thread) => (
                      <HostedReviewThreadCard
                        key={thread.id}
                        threadId={thread.id}
                        environmentId={commenting.pendingCommentTarget.environmentId}
                        reference={commenting.pendingCommentTarget.reference}
                      />
                    ))
                  : null}
                {commenting !== null
                  ? annotation.metadata.pending.map((comment) => (
                      <PendingReviewCommentCard
                        key={comment.id}
                        comment={comment}
                        {...commenting.pendingCommentTarget}
                      />
                    ))
                  : null}
                {annotation.metadata.draft && draft !== null && commenting !== null ? (
                  <DiffCommentAnnotation
                    kind="draft"
                    renderAttachments={commenting.renderAttachments}
                    pending={!canQueueComment && onAskAgent === null}
                    rangeLabel={`${excerpt.path} · ${reviewPositionLabel(draft.position)}`}
                    text=""
                    placeholder={
                      canQueueComment ? "Add a comment…" : "Ask the agent about these lines…"
                    }
                    submitLabel={canQueueComment ? "Add to review" : "Add to composer"}
                    {...(canQueueComment && onAskAgent !== null
                      ? {
                          secondaryAction: {
                            label: "Add to composer",
                            onAction: (text: string) => askAgent(text),
                          },
                        }
                      : {})}
                    onCancel={() => setDraft(null)}
                    onComment={(body) => {
                      if (!canQueueComment) {
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
              <span className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                {onSetViewed ? (
                  <label className="flex items-center gap-1.5">
                    <Checkbox
                      aria-label={`Reviewed ${excerpt.path}`}
                      checked={viewed}
                      onCheckedChange={(checked) => onSetViewed(checked === true)}
                    />
                    Reviewed
                  </label>
                ) : null}
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
