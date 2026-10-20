import {
  reviewFileChapters,
  reviewFileGroup,
  type ReviewFileGroup,
} from "@t3tools/shared/reviewFileClassification";
import { createPortal } from "react-dom";
import { ReviewPath } from "../diffs/ReviewPath";
import {
  reviewPositionRange,
  reviewPositionLabel,
  reviewLineRangeLabel,
} from "@t3tools/client-runtime/review-selection";
import { PullRequestAttachments } from "./PullRequestAttachments";
import type { CodeViewItem, DiffLineAnnotation, SelectedLineRange } from "@pierre/diffs";
import type { CodeViewDiffItem, CodeViewHandle } from "@pierre/diffs/react";
import type {
  EnvironmentId,
  PullRequestDetailView,
  PullRequestDiffSide,
  PullRequestOmittedFileStat,
  PullRequestRef,
  PullRequestReviewPosition,
  PullRequestReviewThread,
  PullRequestThreadCommentsResult,
  PullRequestThreadComment,
} from "@t3tools/contracts";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FolderTreeIcon,
  InfoIcon,
  MessageSquareOffIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown } from "lucide";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import * as Schema from "effect/Schema";
import {
  createContext,
  use,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { useResizableWidth } from "~/hooks/useResizableWidth";
import { RightPanelResizeHandle } from "../preview/RightPanelResizeHandle";
import {
  isReviewFileVisible,
  reviewCommentCounts,
  toggleReviewCommit,
  reviewCommitSelection,
  reviewCommitScope,
  latestReviewedCommit,
} from "@t3tools/client-runtime/review-workspace";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useClientSettings, updateClientSettings } from "~/hooks/useSettings";
import { useRenderedAppearance } from "~/hooks/useTheme";
import { areAllDiffFilesCollapsed } from "~/lib/diffCollapse";
import { pullRequestFindingKey, type PullRequestFinding } from "./pullRequestDetail.logic";
import {
  canEditPullRequestComment,
  canResolvePullRequestThread,
} from "@t3tools/client-runtime/review-editing";
import { orderDiffFiles } from "./pullRequestFileOrder.logic";
import {
  buildFileDiffRenderKey,
  fnv1a32,
  getDiffLineStat,
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
  resolveFileDiffPreviousPath,
  type RenderablePatch,
} from "~/lib/diffRendering";
import { APP_BASE_NAME } from "~/branding";
import { PREFERRED_HIGHLIGHTER } from "~/lib/syntaxHighlighting";
import { cn } from "~/lib/utils";
import { createPullRequestDiffFileContentsLoader } from "~/lib/diffFileContents";
import {
  buildDiffReviewComment,
  resolveDiffReviewPosition,
  type ReviewCommentContext,
} from "~/reviewCommentContext";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import { DiffPanelLoadingState } from "../DiffPanelShell";
import { DiffCommentAnnotation } from "../diffs/DiffCommentAnnotation";
import { DiffFileTree } from "../diffs/DiffFileTree";
import { ReviewChapterRail, ReviewChapterFileLink } from "./ReviewChapterRail";
import { GuideChapterPanel } from "./guide/GuideChapterPanel";
import { ReviewChapterHeader, ReviewChapterProgress } from "./ReviewChapterHeader";
import { useCodeViewFileReveal } from "../diffs/useCodeViewFileReveal";
import { diffFileTreeEntries } from "../diffs/diffFileTree.logic";
import { StyledDiffCodeView } from "../diffs/StyledDiffCodeView";
import { Button } from "../ui/button";
import { MorphIcon } from "~/components/MorphIcon";
import { Checkbox } from "../ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/menu";
import { toastManager } from "../ui/toast";
import { Toggle } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  getReviewPositionAnchor,
  PendingReviewCommentCard,
  ReviewThreadCard,
  toViewerSide,
} from "./PullRequestReviewAnnotation";
import {
  isFileDiffCollapsed,
  isLineInFileDiff,
  toggleFileDiffFoldForViewed,
  type DiffFoldOverride,
} from "./pullRequestDiff.logic";
import { PullRequestDiffStat, PullRequestMetaLine } from "./pullRequestPresentation";
import { usePullRequestFilesViewed } from "./usePullRequestFilesViewed";
import { DiffDisplayControls } from "../diffs/DiffDisplayControls";
import {
  nextPendingReviewCommentId,
  pullRequestReviewKey,
  usePendingReviewComments,
  type PendingReviewComment,
} from "./pullRequestReviewStore";
import { usePendingReviewCommentActions } from "./usePendingReviewCommentActions";

/** Everything pinned to one line of one file: what is already there, and what is being added. */
interface ReviewAnnotationGroup {
  readonly threads: ReadonlyArray<PullRequestReviewThread>;
  readonly pending: ReadonlyArray<PendingReviewComment>;
  readonly draft: boolean;
}

type ReviewAnnotation = DiffLineAnnotation<ReviewAnnotationGroup>;

/** Commits per press of "Show more" in the scope menu. */
const COMMIT_PAGE_SIZE = 10;

const PULL_REQUEST_FILE_TREE_STORAGE_KEY = "t3code.pullRequestFileTreeOpen";

/** One answer from the host: a whole number of files, and where the next one carries on. */
interface DiffSlice {
  /** What was asked for, null being the first slice. Identifies the slice among the loaded ones. */
  readonly cursor: string | null;
  readonly patch: string;
  readonly truncated: boolean;
  readonly nextCursor: string | null;
  readonly omittedFileStats: ReadonlyArray<PullRequestOmittedFileStat>;
}

/**
 * The viewer's own per-file counts are hidden and drawn from this side of its shadow root
 * instead: its counts are hunk sums, and a file whose hunks the host withheld would read as
 * an empty change rather than as the counts the host did report.
 */
const REPLACE_FILE_COUNTS_CSS = `
[data-diffs-header] [data-additions-count],
[data-diffs-header] [data-deletions-count] {
  display: none !important;
}`;

/** Nothing loaded yet, as one identity, so the memos below do not see a new array every render. */
const NO_SLICES: ReadonlyArray<DiffSlice> = [];

// Each slice is parsed once per cache key and the parse lives as long as the slice does, so a
// slice arriving costs one parse rather than one per slice already on screen.
const sliceParses = new WeakMap<DiffSlice, Map<string, RenderablePatch | null>>();

function parseSlice(slice: DiffSlice, cacheKey: string, ignoreWhitespace: boolean) {
  let parses = sliceParses.get(slice);
  if (parses === undefined) {
    parses = new Map();
    sliceParses.set(slice, parses);
  }
  if (parses.has(cacheKey)) return parses.get(cacheKey) ?? null;
  const parsed = getRenderablePatch(slice.patch, cacheKey, {
    compactPartialHunkOffsets: true,
    ignoreWhitespace,
  });
  parses.set(cacheKey, parsed);
  return parsed;
}

interface FileViewedToggleState {
  readonly enabled: boolean;
  readonly isViewed: (path: string) => boolean;
  readonly isStale: (path: string) => boolean;
  readonly setFileViewed: (fileKey: string, path: string, viewed: boolean) => void;
}

// Header portals are memoized on the render props; the viewed toggle reads its state through
// context so a press redraws the toggles, not every header on screen.
const FileViewedToggleContext = createContext<FileViewedToggleState | null>(null);

function FileViewedToggle({
  fileKey,
  path,
  stat,
}: {
  readonly fileKey: string;
  readonly path: string;
  readonly stat: ReactNode;
}) {
  const viewedFiles = use(FileViewedToggleContext);
  if (viewedFiles === null || !viewedFiles.enabled) return stat;
  const viewed = viewedFiles.isViewed(path);
  const stale = viewedFiles.isStale(path);
  return (
    <span className="flex items-center gap-3">
      {stat}
      <label
        data-viewed-toggle=""
        className="flex cursor-pointer select-none items-center gap-1.5 text-2xs text-muted-foreground"
        onClick={(event) => event.stopPropagation()}
      >
        <Checkbox
          aria-label={stale ? "Changed" : "Viewed"}
          checked={viewed}
          onCheckedChange={(next) => viewedFiles.setFileViewed(fileKey, path, next === true)}
        />
        {stale ? (
          <Tooltip>
            <TooltipTrigger render={<span className="text-warning-foreground" />}>
              Changed
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              This file has been pushed to since you marked it viewed.
            </TooltipPopup>
          </Tooltip>
        ) : (
          <span className="@max-xs:hidden">Viewed</span>
        )}
      </label>
    </span>
  );
}

/** A group while it is still gathering what belongs on its line. */
interface MutableAnnotationGroup {
  readonly side: PullRequestDiffSide;
  readonly line: number;
  readonly threads: PullRequestReviewThread[];
  readonly pending: PendingReviewComment[];
  draft: boolean;
}

interface DraftAnchor {
  readonly fileKey: string;
  readonly path: string;
  /** What the file was called before the change, for the hosts that resolve a position by both. */
  readonly oldPath: string | null;
  readonly position: PullRequestReviewPosition;
  /** The selected lines used for the comment and composer context. */
  readonly range: SelectedLineRange;
}

/** A range of the diff and the reader's request for the agent. */
export interface PullRequestAgentSelectionInput {
  /** The marked lines, already in the shape the composer draws and the agent reads. */
  readonly comment: ReviewCommentContext;
  readonly request: string;
}

/**
 * Whether the viewer draws this line at all. A line counts the new file on the right and the old
 * one on the left, and each hunk covers one run of each; a line outside every run — a
 * conversation the host could not mark outdated, or one under a hunk it withheld — has no row to
 * be pinned to, however much its file looks like a match.
 */
/**
 * The pull request's patch, with the review written against it. Conversations already on the
 * host sit under the line they were written on, and a new comment joins the review being
 * drafted rather than being posted as it is typed.
 */
function PullRequestCodeTab({
  scrollerRef,
  environmentId,
  reference,
  detail,
  selectedCommitOid,
  onSelectedCommitChange,
  pendingFinding,
  fixFindingLabel = "Fix in a thread",
  onFixFinding,
  onAddToAgentSelection,
  onAddThreadCommentToComposer,
  onAddPendingToComposer,
  onRefresh,
  refreshToken = 0,
  backgroundRefreshToken = 0,
  revealRequest = null,
  guideFallback = false,
  guideStatus,
  viewControlsTarget,
}: {
  guideStatus?: ReactNode;
  viewControlsTarget?: HTMLElement | null;
  /** Before a Guide is ready, keep its chapter layout with files grouped by type. */
  guideFallback?: boolean;
  scrollerRef: (node: HTMLDivElement | null) => void;
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  detail: PullRequestDetailView;
  /** Commit whose diff is open. Null keeps the whole pull-request diff selected. */
  selectedCommitOid: string | null;
  onSelectedCommitChange: (oid: string | null) => void;
  /** The hand-off currently preparing, if any, so only the finding it belongs to says so. */
  pendingFinding?: string | null;
  fixFindingLabel?: string;
  onFixFinding?: (finding: PullRequestFinding) => void;
  /** Absent where there is no active agent composer to receive a local comment. */
  onAddToAgentSelection?: (input: PullRequestAgentSelectionInput) => void;
  onAddThreadCommentToComposer?:
    | ((thread: PullRequestReviewThread, comment: PullRequestThreadComment) => void)
    | undefined;
  onAddPendingToComposer?: ((comment: PendingReviewComment) => void) | undefined;
  onRefresh: () => void;
  /** Bumped by the panel's refresh button: drop the accumulated pages and re-read the diff. */
  refreshToken?: number;
  backgroundRefreshToken?: number;
  /** A file another tab asked to show. A new nonce asks again for the same path. */
  revealRequest?: {
    readonly path: string;
    readonly nonce: number;
    readonly line?: number | null;
    readonly side?: PullRequestDiffSide;
    readonly threadId?: string;
  } | null;
}) {
  const resolvedTheme = useRenderedAppearance();
  const settings = useClientSettings((settings) => ({
    pullRequestViewing: settings.pullRequestViewing,
    diffFilesCollapsed: settings.diffFilesCollapsed,
    diffIgnoreWhitespace: settings.diffIgnoreWhitespace,
    diffLayout: settings.diffLayout,
    wordWrap: settings.wordWrap,
  }));
  const [toggledFiles, setToggledFiles] = useState<ReadonlySet<string>>(() => new Set());
  // A change of any size can carry hundreds of commits, and a menu that long is a scroll rather
  // than a choice. The rest arrive ten at a time, on request.
  const [visibleCommitCount, setVisibleCommitCount] = useState(COMMIT_PAGE_SIZE);
  /** Set once the reader has asked for every file at once, until they pick a file apart again. */
  const [foldOverride, setFoldOverride] = useState<DiffFoldOverride>(null);
  const effectiveFoldOverride =
    foldOverride ?? (settings.diffFilesCollapsed ? "folded" : "expanded");
  const diffLayout = settings.diffLayout;
  const wordWrap = settings.wordWrap;
  const ignoreWhitespace = settings.diffIgnoreWhitespace;
  const [fileTreeOpen, setFileTreeOpen] = useLocalStorage(
    PULL_REQUEST_FILE_TREE_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const commentsOnly = !guideFallback && settings.pullRequestViewing.commentsOnly;
  const hideReviewed = !guideFallback && settings.pullRequestViewing.hideReviewed;
  const groupByType = guideFallback || settings.pullRequestViewing.groupByType;
  const [selectedChapter, setSelectedChapter] = useState<ReviewFileGroup>("implementation");
  const [chapterRailOpen, setChapterRailOpen] = useState(false);
  const canSetChapterViewed = useAtomValue(
    pullRequestEnvironment.setFilesViewed.permissionAtom(environmentId),
  );
  const treeWidth = useResizableWidth({
    storageKey: "t3code:pr-diff-tree-width",
    defaultWidth: 320,
    minWidth: 192,
    maxWidth: 640,
    edge: "left",
  });
  const scrollElement = useRef<HTMLDivElement | null>(null);
  const savedScroll = useRef<number | null>(null);
  const setScroller = (node: HTMLDivElement | null) => {
    scrollElement.current = node;
    scrollerRef(node);
  };
  const [selectedLines, setSelectedLines] = useState<{
    id: string;
    range: SelectedLineRange;
  } | null>(null);
  const [draft, setDraft] = useState<DraftAnchor | null>(null);
  const [threadPending, setThreadPending] = useState(false);
  const [orphansOpen, setOrphansOpen] = useState(false);
  // Which pull request the slices belong to travels with them, so a render taken before the
  // reset below cannot read the previous one's slices — or send its cursor to the host.
  const [sliceState, setSliceState] = useState<{
    readonly key: string;
    readonly cursor: string | null;
    readonly slices: ReadonlyArray<DiffSlice>;
  }>({ key: "", cursor: null, slices: NO_SLICES });
  const [viewer, setViewer] = useState<CodeViewHandle<ReviewAnnotationGroup, undefined> | null>(
    null,
  );

  const referenceKey = pullRequestReviewKey(reference);
  const commit = selectedCommitOid;
  const scopeKey = JSON.stringify([environmentId, referenceKey, commit]);
  // The panel keeps this mounted across pull requests, so an open composer would otherwise
  // survive the switch and attach its comment to whichever one is on screen when it is sent.
  const [stateScopeKey, setStateScopeKey] = useState(scopeKey);
  if (stateScopeKey !== scopeKey) {
    setStateScopeKey(scopeKey);
    setDraft(null);
    setSelectedLines(null);
    setToggledFiles(new Set());
    setFoldOverride(null);
    setVisibleCommitCount(COMMIT_PAGE_SIZE);
    setOrphansOpen(false);
    setSelectedChapter("implementation");
    setChapterRailOpen(false);
    setSliceState({ key: scopeKey, cursor: null, slices: NO_SLICES });
  }

  const loadedSlices = sliceState.key === scopeKey ? sliceState.slices : NO_SLICES;
  const cursor = sliceState.key === scopeKey ? sliceState.cursor : null;
  const diffQuery = useEnvironmentQuery(
    pullRequestEnvironment.diff({
      environmentId,
      input: {
        ...reference,
        ...(cursor === null ? {} : { cursor }),
        ...(commit === null ? {} : { commit }),
      },
    }),
  );
  // Each answer is kept as its own slice. Concatenating the patches and re-parsing the growing
  // text would cost more with every slice, which is the wall the slicing exists to remove.
  const [appliedPage, setAppliedPage] = useState<{
    readonly data: typeof diffQuery.data;
    readonly cursor: string | null;
    readonly scopeKey: string;
  } | null>(null);
  const data = diffQuery.data;
  if (
    data !== null &&
    (appliedPage?.data !== data ||
      appliedPage.cursor !== cursor ||
      appliedPage.scopeKey !== scopeKey)
  ) {
    setAppliedPage({ data, cursor, scopeKey });
    setSliceState((previous) => {
      const slices = previous.key === scopeKey ? previous.slices : NO_SLICES;
      const next = {
        cursor,
        patch: data.patch,
        truncated: data.truncated,
        nextCursor: data.nextCursor,
        omittedFileStats: data.omittedFileStats ?? [],
      };
      const index = slices.findIndex((slice) => slice.cursor === cursor);
      if (index === -1) {
        return { key: scopeKey, cursor, slices: [...slices, next] };
      }
      const existing = slices[index];
      if (
        existing !== undefined &&
        existing.patch === next.patch &&
        existing.truncated === next.truncated &&
        existing.nextCursor === next.nextCursor &&
        existing.omittedFileStats.length === next.omittedFileStats.length &&
        existing.omittedFileStats.every((file, index) => {
          const refreshed = next.omittedFileStats[index];
          return (
            refreshed !== undefined &&
            refreshed.path === file.path &&
            refreshed.additions === file.additions &&
            refreshed.deletions === file.deletions
          );
        })
      ) {
        return previous;
      }
      // A page that came back different means the diff moved under the review. The slices
      // after it go with the replacement: their cursors were positions in the old diff.
      return { key: scopeKey, cursor, slices: [...slices.slice(0, index), next] };
    });
  }
  // The refresh button rereads from the first page rather than the page the reader is on:
  // pages are positions in one snapshot of the diff, and a fresh snapshot starts over.
  const refreshFirstDiffPage = useAtomRefresh(
    pullRequestEnvironment.diff({
      environmentId,
      input: { ...reference, ...(commit === null ? {} : { commit }) },
    }),
  );
  const pendingComments = usePendingReviewComments(reference, detail.reviewThreads);
  const { add: addComment } = usePendingReviewCommentActions(environmentId, reference);
  const replyToThread = useAtomCommand(pullRequestEnvironment.replyToThread, {
    reportFailure: false,
  });
  const setThreadResolution = useAtomCommand(pullRequestEnvironment.setThreadResolution, {
    reportFailure: false,
  });
  const updateComment = useAtomCommand(pullRequestEnvironment.updateComment, {
    reportFailure: false,
  });
  const loadThreadComments = useAtomCommand(pullRequestEnvironment.threadComments, {
    reportFailure: false,
  });
  const getDiffFileContents = useAtomCommand(pullRequestEnvironment.diffFileContents);
  const loadDiffFiles = createPullRequestDiffFileContentsLoader(getDiffFileContents, {
    environmentId,
    reference,
    commit,
    cacheKey: `pull-request:${referenceKey}:${detail.updatedAt}:${commit ?? "all"}`,
  });

  // What is offered is the intersection of two different questions: what this host can do at
  // all, and what this account may do on this repository. Either one saying no means a control
  // that would only ever end in a refusal.
  const review = (() => {
    const hostReview = detail.capabilities.review;
    const viewer = detail.viewerPermissions;
    return {
      inlineComment: hostReview.inlineComment && viewer.comment,
      reply: hostReview.reply && viewer.comment,
      resolve: hostReview.resolve && viewer.resolve,
    };
  })();
  // A comment is posted against the pull request's head diff, so a line number taken from one
  // commit's own diff would land somewhere else entirely. Commenting waits for the whole change.
  const canCommentOnLines = review.inlineComment && commit === null;
  const canSelectLines =
    commit === null && (review.inlineComment || onAddToAgentSelection !== undefined);
  // Every slice is parsed on its own and the result held, so a slice arriving costs one parse
  // rather than one per slice already on screen. Its cache key carries the theme, which is what
  // the tokenizer caches against, so a theme change is still a fresh parse.
  const parsedSlices = loadedSlices.map((slice) =>
    parseSlice(
      slice,
      `pull-request:${scopeKey}:${resolvedTheme}:${ignoreWhitespace}:${slice.cursor ?? "first"}:${fnv1a32(slice.patch)}`,
      ignoreWhitespace,
    ),
  );
  // Ordered within a slice rather than across them: ordering the accumulated set would let a late
  // slice push a file the reader is part way through further down the page.
  const files = orderDiffFiles(
    parsedSlices.flatMap((parsed) => (parsed?.kind === "files" ? parsed.files : [])),
    groupByType,
  );
  const filePaths = files.map((file) => resolveFileDiffPath(file));
  // Offered under a commit scope as well as from the whole change, because reading a change one
  // commit at a time is what the scope is for. The tick is kept against the change request rather
  // than the scope it was made in, so clearing a file here clears it everywhere.
  const viewedFilesStore = detail.capabilities.viewedFiles;
  const filesViewed = usePullRequestFilesViewed({
    environmentId,
    reference,
    enabled: viewedFilesStore !== undefined,
    paths: filePaths,
  });
  const {
    setViewed,
    refresh: refreshFilesViewed,
    enabled: filesViewedEnabled,
    isViewed: isFileViewed,
    isStale: isFileViewedStale,
  } = filesViewed;
  // The button goes around the host's cache, so everything the tab reads from it starts over:
  // the diff from its first page, and with it the ticks, which a push since the last read can
  // have marked as standing against an older version of the file.
  const appliedRefreshToken = useRef(refreshToken);
  useEffect(() => {
    if (appliedRefreshToken.current === refreshToken) return;
    appliedRefreshToken.current = refreshToken;
    setSliceState({ key: scopeKey, cursor: null, slices: NO_SLICES });
    refreshFirstDiffPage();
    refreshFilesViewed();
  }, [refreshToken, scopeKey, refreshFirstDiffPage, refreshFilesViewed]);
  const appliedBackgroundRefreshToken = useRef(backgroundRefreshToken);
  useEffect(() => {
    if (appliedBackgroundRefreshToken.current === backgroundRefreshToken) return;
    appliedBackgroundRefreshToken.current = backgroundRefreshToken;
    // Keeping slices mounted preserves scroll; the page merge invalidates changed pages.
    setSliceState((previous) => ({ ...previous, cursor: null }));
    refreshFirstDiffPage();
    refreshFilesViewed();
  }, [backgroundRefreshToken, refreshFirstDiffPage, refreshFilesViewed]);
  const nextCursor = loadedSlices.at(-1)?.nextCursor ?? null;
  // What a slice withheld: the host declining to inline part of it, or a patch the viewer could
  // not structure and so dropped. Neither says anything about there being more to fetch.
  const withheldContent =
    loadedSlices.some((slice) => slice.truncated) ||
    parsedSlices.some((parsed) => parsed?.kind === "raw");

  // Placing a conversation takes more than its file being in the diff: its line has to fall
  // inside a hunk that was rendered. One that does not is drawn nowhere, so it belongs in the
  // off-diff list rather than disappearing between the two.
  const visibleHostThreads = detail.reviewThreads.flatMap((thread) => {
    const comments = thread.comments.filter((comment) => !comment.pendingReviewId);
    if (comments.length === 0) return [];
    if (comments.length === thread.comments.length) return [thread];
    return [
      {
        ...thread,
        comments,
        ...(thread.commentCount === undefined
          ? {}
          : {
              commentCount: Math.max(
                comments.length,
                thread.commentCount - (thread.comments.length - comments.length),
              ),
            }),
      },
    ];
  });

  const placedThreadIds = (() => {
    const placed = new Set<string>();
    // A commit's diff counts lines within that commit; a review comment is anchored to the
    // pull request's head diff. Pinning one onto the other would put the remark against
    // whichever code happens to hold that line number in this commit, so while a commit is on
    // screen every conversation is listed rather than placed.
    if (commit !== null) return placed;
    for (const file of files) {
      const path = resolveFileDiffPath(file);
      for (const thread of visibleHostThreads) {
        if (
          thread.path === path &&
          thread.line !== null &&
          isLineInFileDiff(file, thread.side, thread.line)
        ) {
          placed.add(thread.id);
        }
      }
    }
    return placed;
  })();

  // Hashing what the annotations show is the costly part of an item's version, and none of it
  // moves when a file is ticked or folded, so it is kept apart from the two that do.
  const annotatedFiles = files.map((fileDiff) => {
    const fileKey = buildFileDiffRenderKey(fileDiff);
    const path = resolveFileDiffPath(fileDiff);
    // One annotation per line, so a line that already carries a conversation shows a new
    // comment underneath it rather than in place of it.
    const groups = new Map<string, MutableAnnotationGroup>();
    const groupAt = (side: PullRequestDiffSide, line: number) => {
      const key = `${side}:${line}`;
      const existing = groups.get(key);
      if (existing) return existing;
      const created: MutableAnnotationGroup = {
        side,
        line,
        threads: [],
        pending: [],
        draft: false,
      };
      groups.set(key, created);
      return created;
    };

    for (const thread of visibleHostThreads) {
      if (thread.path !== path || thread.line === null) continue;
      if (!placedThreadIds.has(thread.id)) continue;
      groupAt(thread.side, thread.line).threads.push(thread);
    }
    // Pending comments anchor to the head diff exactly like host threads do, so a
    // commit's diff must not place them either — the same line means other code there.
    if (commit === null) {
      for (const comment of pendingComments) {
        if (comment.path !== path) continue;
        const anchor = getReviewPositionAnchor(comment.position);
        groupAt(anchor.side, anchor.line).pending.push(comment);
      }
    }
    if (draft?.fileKey === fileKey) {
      const anchor = getReviewPositionAnchor(draft.position);
      groupAt(anchor.side, anchor.line).draft = true;
    }

    const annotations: ReviewAnnotation[] = [...groups.values()].map((group) => ({
      side: toViewerSide(group.side),
      lineNumber: group.line,
      metadata: { threads: group.threads, pending: group.pending, draft: group.draft },
    }));
    return {
      fileKey,
      path,
      fileDiff,
      annotations,
      // The viewer re-renders an item only when its version changes, so everything the
      // annotations show has to be part of it.
      annotationsVersion: fnv1a32(
        annotations
          .map(
            ({ side, lineNumber, metadata }) =>
              `${side}:${lineNumber}:${metadata.draft ? "d" : ""}:${metadata.pending
                .map(
                  (comment) =>
                    `${comment.id}:${comment.body}:${comment.hostedComment?.commentId ?? ""}`,
                )
                .join(",")}:${metadata.threads
                .map(
                  (thread) =>
                    `${thread.id}:${thread.isResolved ? "r" : ""}:${
                      thread.isOutdated ? "o" : ""
                    }:${thread.comments
                      .map(
                        (comment) =>
                          `${comment.id}:${comment.author?.login ?? ""}:${comment.createdAt}:${comment.body}:${(
                            comment.reactions ?? []
                          )
                            .map((r) => `${r.content}:${r.count}:${r.viewerHasReacted ? "v" : ""}`)
                            .join(",")}`,
                      )
                      .join(";")}`,
                )
                .join(",")}`,
          )
          .join("|"),
      ),
    };
  });

  const commentCounts = reviewCommentCounts(
    files.map((file) => ({
      path: resolveFileDiffPath(file),
      previousPath: resolveFileDiffPreviousPath(file),
    })),
    detail.reviewThreads,
    pendingComments,
  );
  const filteredFiles = annotatedFiles.filter(
    ({ path }) =>
      path === revealRequest?.path ||
      isReviewFileVisible(
        { hideReviewed, commentsOnly },
        isFileViewed(path),
        (commentCounts.get(path)?.unresolved ?? 0) > 0,
      ),
  );
  const chapters = groupByType
    ? reviewFileChapters(annotatedFiles, (file) => file.path, filteredFiles)
    : [];
  const chapterPosition = Math.max(
    0,
    chapters.findIndex((chapter) => chapter.id === selectedChapter),
  );
  const chapter = chapters[chapterPosition] ?? null;
  const chapterReviewComplete = nextCursor === null && !diffQuery.isPending;
  const items = ((): CodeViewDiffItem<ReviewAnnotationGroup>[] =>
    (chapter?.visibleFiles ?? filteredFiles).map(
      ({ fileKey, path, fileDiff, annotations, annotationsVersion }) => {
        const collapsed = isFileDiffCollapsed(
          fileKey,
          foldOverride ?? (isFileViewed(path) ? "folded" : effectiveFoldOverride),
          toggledFiles,
        );
        // Ticking a file that is already folded changes no fold, so without this the box on
        // screen would keep saying the opposite of what the count says.
        const viewedMark = filesViewedEnabled
          ? `e${isFileViewed(path) ? "v" : ""}${isFileViewedStale(path) ? "s" : ""}`
          : "";
        return {
          id: fileKey,
          type: "diff" as const,
          fileDiff,
          annotations,
          collapsed,
          version: fnv1a32(`${collapsed ? "1" : "0"}:${viewedMark}:${annotationsVersion}`),
        };
      },
    ))();
  const omittedFileStats = new Map(
    loadedSlices.flatMap((slice) =>
      slice.omittedFileStats.map((file) => [file.path, file] as const),
    ),
  );
  const sourceFileStats = new Map(
    parsedSlices.flatMap((parsed) =>
      parsed?.kind === "files"
        ? parsed.files.map(
            (file, index) =>
              [
                buildFileDiffRenderKey(file),
                getDiffLineStat([parsed.sourceFiles[index] ?? file]),
              ] as const,
          )
        : [],
    ),
  );
  const fileKeys = items.map((item) => item.id);
  const collapsedFileKeys = new Set(
    items.filter((item) => item.collapsed === true).map((item) => item.id),
  );
  const allFilesCollapsed = areAllDiffFilesCollapsed(fileKeys, collapsedFileKeys);
  const fileTreeEntries = diffFileTreeEntries(items.map((item) => item.fileDiff)).map((entry) => ({
    ...entry,
    reviewed: isFileViewed(entry.path),
    unresolvedComments: commentCounts.get(entry.path)?.unresolved ?? 0,
  }));
  const folderReviewEntries = diffFileTreeEntries(annotatedFiles.map((file) => file.fileDiff)).map(
    (entry) => ({
      ...entry,
      reviewed: isFileViewed(entry.path),
    }),
  );
  const displayedChapter = useRef<string | null>(null);
  useLayoutEffect(() => {
    const chapterId = chapter?.id ?? null;
    if (displayedChapter.current !== chapterId) {
      displayedChapter.current = chapterId;
      savedScroll.current = null;
      scrollElement.current?.scrollTo({ top: 0 });
    }
    if (savedScroll.current !== null && scrollElement.current) {
      scrollElement.current.scrollTop = savedScroll.current;
      savedScroll.current = null;
    }
  });
  const chapterId = chapter?.id ?? null;
  const [selectionChapter, setSelectionChapter] = useState(chapterId);
  if (selectionChapter !== chapterId) {
    setSelectionChapter(chapterId);
    setSelectedLines(null);
  }

  // A failed slice must not be asked for again on its own. The files already loaded keep the
  // sentinel on screen, so re-arming it after a failure would request the same slice forever.
  const canLoadNextSlice =
    nextCursor !== null &&
    nextCursor !== cursor &&
    !diffQuery.isPending &&
    diffQuery.error === null;
  const loadNextSlice = () => {
    if (nextCursor === null) return;
    setSliceState((previous) => ({ ...previous, cursor: nextCursor }));
  };

  // The sentinel is held as state rather than a ref because the viewer mounts its own footer:
  // an effect reading a ref could run before that node exists and would never arm the observer.
  const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (sentinel === null || !canLoadNextSlice) return;
    const observer = new IntersectionObserver(
      (observed) => {
        if (observed.some((entry) => entry.isIntersecting)) loadNextSlice();
      },
      // Start the next slice slightly before the sentinel is on screen.
      { rootMargin: "240px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [canLoadNextSlice, loadNextSlice, sentinel]);

  // A stable identity: the viewer's SlotPortals memoizes each file's header/annotation portal on
  // these render props, so a fresh function here would recreate every visible file's portal on
  // every tab re-render (a line-selection drag, a keystroke in the draft, a review-store update).
  const toggleFile = (fileKey: string) =>
    setToggledFiles((current) => {
      // The override becomes this file's new default the moment it is folded into the set below,
      // so nothing has to be re-derived when the reader goes back to choosing one at a time.
      const next = new Set(current);
      if (next.has(fileKey)) next.delete(fileKey);
      else next.add(fileKey);
      return next;
    });

  // The tick and the fold are one gesture: clearing a file puts it away, un-clearing brings it
  // back. Folding is still held as the reader's difference from the toolbar's default rather
  // than derived from what has been ticked, so folding everything ticks nothing off.
  const setFileViewed = (fileKey: string, path: string, viewed: boolean) => {
    savedScroll.current = scrollElement.current?.scrollTop ?? null;
    setViewed(path, viewed);
    setToggledFiles((current) =>
      toggleFileDiffFoldForViewed(
        fileKey,
        viewed,
        foldOverride ?? (viewed ? "folded" : effectiveFoldOverride),
        current,
      ),
    );
  };

  const chapterSummaries = chapters.map((candidate, index) => {
    const members = candidate.files;
    const reviewedCount = members.filter((file) => isFileViewed(file.path)).length;
    const stat = members.reduce(
      (total, file) => {
        const next = sourceFileStats.get(file.fileKey) ?? getDiffLineStat([file.fileDiff]);
        return {
          additions: total.additions + next.additions,
          deletions: total.deletions + next.deletions,
        };
      },
      { additions: 0, deletions: 0 },
    );
    return {
      title: candidate.title,
      reviewed: chapterReviewComplete && reviewedCount === members.length,
      stat,
      detail:
        index !== chapterPosition ? (
          <span>
            {reviewedCount} of {members.length} files reviewed
            {chapterReviewComplete ? "" : " (loaded)"}
          </span>
        ) : null,
      ...(filesViewed.enabled && canSetChapterViewed
        ? {
            review: {
              reviewedCount,
              fileCount: members.length,
              disabled: !chapterReviewComplete,
              onSetReviewed: (reviewed: boolean) => {
                for (const file of members) setFileViewed(file.fileKey, file.path, reviewed);
              },
            },
          }
        : {}),
    };
  });

  const requestTreeReveal = useCodeViewFileReveal(viewer, scopeKey, fileKeys);
  const revealFile = (path: string, line?: number | null, side: PullRequestDiffSide = "right") => {
    const file = filteredFiles.find((candidate) => candidate.path === path);
    if (file === undefined) return;
    if (groupByType) {
      setSelectedChapter(reviewFileGroup(path));
      setChapterRailOpen(false);
      savedScroll.current = null;
    }
    if (
      isFileDiffCollapsed(
        file.fileKey,
        foldOverride ?? (isFileViewed(path) ? "folded" : effectiveFoldOverride),
        toggledFiles,
      )
    )
      toggleFile(file.fileKey);
    requestTreeReveal(
      file.fileKey,
      line != null && isLineInFileDiff(file.fileDiff, side, line)
        ? {
            type: "line",
            id: file.fileKey,
            lineNumber: line,
            side: toViewerSide(side),
            align: "center",
          }
        : undefined,
    );
  };
  // Answered once the requested file has arrived: a large diff may still be paging when the
  // request comes in, so it waits for the slice that carries the path rather than dropping it.
  const answeredReveal = useRef<number | null>(null);
  const answerReveal = useEffectEvent(() => {
    if (revealRequest === null || answeredReveal.current === revealRequest.nonce) return;
    if (diffQuery.isPending && files.length === 0) return;
    if (
      revealRequest.threadId &&
      !placedThreadIds.has(revealRequest.threadId) &&
      !canLoadNextSlice
    ) {
      setOrphansOpen(true);
      scrollElement.current?.scrollTo({ top: 0 });
      answeredReveal.current = revealRequest.nonce;
      return;
    }
    if (!filteredFiles.some((file) => file.path === revealRequest.path)) {
      // The reader is not scrolling toward it, so the sentinel would never ask for its slice.
      if (canLoadNextSlice) loadNextSlice();
      return;
    }
    answeredReveal.current = revealRequest.nonce;
    revealFile(revealRequest.path, revealRequest.line, revealRequest.side);
  });
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- A reveal may open its conversation or advance the diff cursor.
    answerReveal();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Re-check the external reveal as its files and conversations load.
  }, [canLoadNextSlice, diffQuery.isPending, files, filteredFiles, placedThreadIds, revealRequest]);

  const toggleAllFiles = () => {
    // Held as an override of the default rather than as the file keys on screen: a diff that is
    // still paging would otherwise bring its next slice in folded, moments after the reader
    // asked for everything to be open.
    setFoldOverride(areAllDiffFilesCollapsed(fileKeys, collapsedFileKeys) ? "expanded" : "folded");
    setToggledFiles(new Set());
  };

  // Newest first: the last commit is the one a reader coming back to a change is looking for.
  const orderedCommits = detail.commits.toSorted(
    (left, right) => Date.parse(right.committedDate) - Date.parse(left.committedDate),
  );

  const beginComment = (
    range: SelectedLineRange | null,
    context: { item: CodeViewItem<ReviewAnnotationGroup> },
  ) => {
    if (!range || !canSelectLines) return;
    const item = context.item;
    if (item.type !== "diff") return;
    const file = files.find((candidate) => buildFileDiffRenderKey(candidate) === item.id);
    if (!file) return;
    const path = resolveFileDiffPath(file);
    const previousPath = resolveFileDiffPreviousPath(file);
    const sourceFile = parsedSlices
      .flatMap((slice) => (slice?.kind === "files" ? slice.sourceFiles : []))
      .find((candidate) => resolveFileDiffPath(candidate) === path);
    const side = range.endSide ?? range.side;
    const endPosition =
      (sourceFile && resolveDiffReviewPosition(sourceFile, range.end, side)) ??
      resolveDiffReviewPosition(file, range.end, side);
    if (endPosition === null) return;
    const startPosition = resolveDiffReviewPosition(sourceFile ?? file, range.start, range.side);
    const position = startPosition ? reviewPositionRange(startPosition, endPosition) : endPosition;
    if (
      canCommentOnLines &&
      position.startLine !== undefined &&
      detail.capabilities.review.multilineComment !== true
    ) {
      toastManager.add({
        type: "error",
        title: "This host supports single-line comments",
        description: "Select one line to add a review comment.",
      });
      return;
    }

    setDraft({
      fileKey: item.id,
      path,
      oldPath: previousPath === path ? null : previousPath,
      position,
      range,
    });
  };

  // Built here because the parsed diff only lives here, and built by the same function the
  // thread panel's own line selection uses — the gesture is the same one, so a second reading of
  // the hunks would only be a second place for it to drift.
  const finishSelection = (
    anchor: DraftAnchor,
    text: string,
    onFinish: (comment: ReviewCommentContext) => void,
  ) => {
    const file = files.find((candidate) => buildFileDiffRenderKey(candidate) === anchor.fileKey);
    const comment =
      file === undefined
        ? null
        : buildDiffReviewComment({
            id: `pull-request-selection:${anchor.fileKey}:${anchor.range.start}:${anchor.range.end}`,
            sectionId: `pull-request:${detail.number}`,
            sectionTitle: `PR #${detail.number} review`,
            filePath: anchor.path,
            fileDiff: file,
            range: anchor.range,
            text,
          });
    setDraft(null);
    setSelectedLines(null);
    if (comment !== null) onFinish(comment);
  };

  // The viewer's SlotPortals memoizes each visible file's header/annotation portal on these
  // render props and on `options` below; a fresh identity on any of them — as a plain inline
  // function or object literal would be — invalidates that memo and recreates every portal on
  // screen on any tab re-render (a drag-selection, a keystroke in the draft, a review-store
  // update), which is the jank this file is otherwise clean of.
  const refreshDiffQuery = diffQuery.refresh;
  const hasVisibleItems = items.length > 0;
  const renderCodeViewFooter = () =>
    // An empty filtered chapter keeps its navigation and totals. Loading failures belong
    // only to an outstanding cursor, rather than a failed refresh of a finished diff.
    nextCursor === null ? (
      !hasVisibleItems ? (
        <p className="px-4 py-5 text-sm text-muted-foreground">
          No files match the viewing options.
        </p>
      ) : null
    ) : (
      <div
        ref={setSentinel}
        className="flex items-center justify-center gap-2 py-2 text-xs text-muted-foreground"
      >
        {diffQuery.error !== null ? (
          <>
            <span>The rest of this diff could not be loaded.</span>
            <Button size="xs" variant="outline" onClick={refreshDiffQuery}>
              Retry
            </Button>
          </>
        ) : diffQuery.isPending ? (
          "Loading more files..."
        ) : null}
      </div>
    );

  const renderHeaderPrefix = (item: CodeViewItem<ReviewAnnotationGroup>) => {
    // The item the viewer is drawing already carries the state the memo settled on, so the
    // chevron follows it rather than recomputing the default here.
    const collapsed = item.collapsed === true;
    return (
      <Button
        size="icon-micro"
        variant="ghost-muted"
        aria-expanded={!collapsed}
        aria-label={collapsed ? "Expand diff" : "Collapse diff"}
        className="mr-1"
        onClick={(event) => {
          event.stopPropagation();
          toggleFile(item.id);
        }}
      >
        <MorphIcon className="size-4" icon={collapsed ? ChevronRight : ChevronDown} />
      </Button>
    );
  };

  const fileViewedToggle = {
    enabled: filesViewed.enabled,
    isViewed: filesViewed.isViewed,
    isStale: filesViewed.isStale,
    setFileViewed,
  };
  const renderHeaderMetadata = (item: CodeViewItem<ReviewAnnotationGroup>) => {
    if (item.type !== "diff") return null;
    let { additions, deletions } = sourceFileStats.get(item.id) ?? getDiffLineStat([item.fileDiff]);
    const path = resolveFileDiffPath(item.fileDiff);
    if (additions === 0 && deletions === 0) {
      const withheld = omittedFileStats.get(path);
      if (withheld) ({ additions, deletions } = withheld);
    }
    return (
      <FileViewedToggle
        fileKey={item.id}
        path={path}
        stat={
          <PullRequestDiffStat
            additions={additions}
            deletions={deletions}
            className="font-mono text-2xs [&>span]:w-[5ch] [&>span]:text-right"
          />
        }
      />
    );
  };

  const diffViewOptions = {
    diffStyle: diffLayout === "split" ? ("split" as const) : ("unified" as const),
    lineDiffType: "none" as const,
    overflow: wordWrap ? ("wrap" as const) : ("scroll" as const),
    theme: resolveDiffThemeName(resolvedTheme),
    preferredHighlighter: PREFERRED_HIGHLIGHTER,
    themeType: resolvedTheme,
    stickyHeaders: true,
    loadDiffFiles,
    enableGutterUtility: canCommentOnLines && draft === null,
    enableLineSelection: canCommentOnLines && draft === null,
    // Two gestures reach the same place: dragging the line numbers selects a range, and the
    // gutter's own button comments on the one line it sits on. They are separate callbacks in
    // the viewer, so a reader who only ever presses the button gets nothing unless both are
    // wired.
    onGutterUtilityClick: beginComment,
    onLineSelectionEnd: beginComment,
  };

  const runThreadCommand = async (
    label: string,
    run: () => Promise<{ readonly _tag: string }>,
  ): Promise<boolean> => {
    if (threadPending) return false;
    setThreadPending(true);
    const result = await run();
    setThreadPending(false);
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: label });
      return false;
    }
    onRefresh();
    return true;
  };

  // A conversation is the same card wired to the same commands whether it sits on its line or
  // was stranded off the diff; only where it is drawn differs.
  const renderThreadCard = (thread: PullRequestReviewThread) => (
    <ReviewThreadCard
      // Named with the pull request too: a thread's id is the host's own, and two pull requests
      // can hand out the same one — which would leave one card's open editor standing over the
      // other's conversation.
      key={`${reference.projectId}#${reference.number}:${thread.id}`}
      thread={thread}
      revealRequest={revealRequest?.threadId === thread.id ? revealRequest.nonce : undefined}
      workspaceRoot={detail.workspaceRoot}
      canReply={review.reply}
      canResolve={review.resolve && canResolvePullRequestThread(detail, thread)}
      canReact={detail.capabilities.reactions === true}
      environmentId={environmentId}
      reference={reference}
      pending={threadPending}
      fixPending={pendingFinding === pullRequestFindingKey({ kind: "thread", thread })}
      fixLabel={fixFindingLabel}
      {...(onFixFinding ? { onFix: () => onFixFinding({ kind: "thread", thread }) } : {})}
      onLoadMore={async (cursor): Promise<PullRequestThreadCommentsResult | null> => {
        const result = await loadThreadComments({
          environmentId,
          input: { ...reference, threadId: thread.id, cursor },
        });
        if (result._tag === "Failure") {
          toastManager.add({
            type: "error",
            title: "More comments could not be loaded",
          });
          return null;
        }
        return result.value;
      }}
      onReply={(body) =>
        runThreadCommand("Reply could not be posted", () =>
          replyToThread({
            environmentId,
            input: { ...reference, threadId: thread.id, body },
          }),
        )
      }
      // A conversation on a line is made of review comments, whatever the host filed them as.
      canEditComment={(comment) =>
        canEditPullRequestComment(detail, {
          author: comment.author,
          kind: "review-comment",
          canEdit: comment.canEdit,
        })
      }
      onEditComment={(commentId, body) =>
        runThreadCommand("The comment could not be saved", () =>
          updateComment({
            environmentId,
            input: { ...reference, commentId, kind: "review-comment", body },
          }),
        )
      }
      onToggleResolved={() =>
        void setThreadResolution({
          environmentId,
          input: { ...reference, threadId: thread.id, resolved: !thread.isResolved },
        }).then((result) => {
          if (result._tag === "Failure") {
            toastManager.add({ type: "error", title: "The conversation could not be updated" });
          }
        })
      }
      onReacted={onRefresh}
      onAddToComposer={
        onAddThreadCommentToComposer
          ? (comment) => onAddThreadCommentToComposer(thread, comment)
          : undefined
      }
    />
  );

  const renderAnnotation = (annotation: ReviewAnnotation) => (
    <div className="py-1 font-sans text-foreground">
      {annotation.metadata.threads.map(renderThreadCard)}
      {annotation.metadata.pending.map((comment) => (
        <PendingReviewCommentCard
          key={comment.id}
          onAddToComposer={
            onAddPendingToComposer ? () => onAddPendingToComposer(comment) : undefined
          }
          comment={comment}
          environmentId={environmentId}
          reference={reference}
          canCopyLink={detail.capabilities.review.draftComment === true}
        />
      ))}
      {annotation.metadata.draft && draft && canSelectLines ? (
        <DiffCommentAnnotation
          kind="draft"
          renderAttachments={(onTextChange, onBusyChange, textarea) => (
            <PullRequestAttachments
              environmentId={environmentId}
              reference={reference}
              onTextChange={onTextChange}
              textareaRef={{ current: textarea }}
              onBusyChange={onBusyChange}
            />
          )}
          rangeLabel={`${draft.path} · ${reviewPositionLabel(draft.position)}`}
          text=""
          submitLabel={canCommentOnLines ? "Add to review" : "Add to agent"}
          {...(canCommentOnLines && onAddToAgentSelection
            ? {
                secondaryAction: {
                  label: "Add to composer",
                  onAction: (text: string) =>
                    finishSelection(draft, text, (comment) =>
                      onAddToAgentSelection({ comment, request: text }),
                    ),
                },
              }
            : {})}
          onCancel={() => {
            setDraft(null);
            setSelectedLines(null);
          }}
          onComment={(body) => {
            if (!canCommentOnLines) {
              if (onAddToAgentSelection) {
                finishSelection(draft, body, (comment) =>
                  onAddToAgentSelection({ comment, request: body }),
                );
              }
              return;
            }
            addComment(
              {
                id: nextPendingReviewCommentId(),
                path: draft.path,
                ...(draft.oldPath === null ? {} : { oldPath: draft.oldPath }),
                position: draft.position,
                body,
              },
              detail.capabilities.review.draftComment === true,
            );
            setDraft(null);
            setSelectedLines(null);
          }}
        />
      ) : null}
    </div>
  );

  // A rebase or a force-push can take the scoped commit out of the change. Its diff may still
  // be reachable on the host, but it is no longer part of what is being reviewed, so the scope
  // goes back to the whole change rather than sitting under a name nothing matches.
  //
  // Including when the change reports no commits at all: the scope dropdown is the only way back
  // to the whole diff and it is not drawn without commits to list, so a scope that outlived them
  // would leave the tab reading one obsolete commit with nothing to press.
  const commitOids = orderedCommits.toReversed().map((entry) => entry.oid);
  const selectedOids = reviewCommitSelection(commitOids, commit);
  const selectedCommit = orderedCommits.find((entry) => entry.oid === commit);
  const lastReviewedSha = latestReviewedCommit(detail.comments, detail.viewer);
  const lastReviewedIndex = lastReviewedSha === null ? -1 : commitOids.indexOf(lastReviewedSha);
  useEffect(() => {
    if (commit !== null && selectedOids.length === 0) onSelectedCommitChange(null);
  }, [commit, onSelectedCommitChange, selectedOids.length]);
  const scopeLabel = selectedCommit
    ? selectedCommit.messageHeadline
    : commit === null
      ? "All commits"
      : `${selectedOids.length} commits`;
  const changeIgnoreWhitespace = (next: boolean) => {
    updateClientSettings({ diffIgnoreWhitespace: next });
    setDraft(null);
    setSelectedLines(null);
  };
  const displayControls = (
    <DiffDisplayControls
      onWhitespaceChange={changeIgnoreWhitespace}
      filters={
        guideFallback
          ? []
          : [
              {
                label: "Hide reviewed",
                checked: hideReviewed,
                disabled: !filesViewed.enabled,
                onCheckedChange: (checked) =>
                  updateClientSettings({
                    pullRequestViewing: {
                      ...settings.pullRequestViewing,
                      hideReviewed: checked,
                    },
                  }),
              },
              {
                label: "Hide without unresolved comments",
                checked: commentsOnly,
                onCheckedChange: (checked) =>
                  updateClientSettings({
                    pullRequestViewing: {
                      ...settings.pullRequestViewing,
                      commentsOnly: checked,
                    },
                  }),
              },
              {
                label: "Group by file type",
                checked: groupByType,
                onCheckedChange: (checked) =>
                  updateClientSettings({
                    pullRequestViewing: {
                      ...settings.pullRequestViewing,
                      groupByType: checked,
                    },
                  }),
              },
            ]
      }
    />
  );
  const toolbarContent = (
    <div className="@container flex h-10 min-h-10 shrink-0 items-center justify-between gap-2 border-b border-border/60 bg-background px-4 text-xs text-muted-foreground">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {/* A host that reports no commits has nothing to scope by, and a dropdown whose only
            entry is the scope already showing is a control that does nothing. */}
        {!guideFallback && orderedCommits.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button size="xs" variant="secondary" />}
              className="min-w-0 max-w-64"
              aria-label={`Diff scope: ${scopeLabel}`}
            >
              <span className="truncate">{scopeLabel}</span>
              <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-w-[min(28rem,calc(100vw-2rem))]">
              <DropdownMenuItem closeOnClick onClick={() => onSelectedCommitChange(null)}>
                All commits
              </DropdownMenuItem>
              <DropdownMenuItem
                closeOnClick
                disabled={lastReviewedIndex < 0 || lastReviewedIndex === commitOids.length - 1}
                onClick={() =>
                  onSelectedCommitChange(reviewCommitScope(commitOids.slice(lastReviewedIndex + 1)))
                }
              >
                Since last reviewed
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {orderedCommits.slice(0, visibleCommitCount).map((entry) =>
                detail.provider === "github" ? (
                  <DropdownMenuCheckboxItem
                    key={entry.oid}
                    closeOnClick={false}
                    checked={selectedOids.includes(entry.oid)}
                    onCheckedChange={() =>
                      onSelectedCommitChange(
                        reviewCommitScope(
                          toggleReviewCommit(
                            commitOids,
                            commit === null ? [] : selectedOids,
                            entry.oid,
                          ),
                        ),
                      )
                    }
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <ReviewPath className="min-w-0 truncate" path={entry.messageHeadline} />
                      <span className="ml-auto shrink-0 font-mono text-xs">
                        {entry.oid.slice(0, 7)}
                      </span>
                    </span>
                  </DropdownMenuCheckboxItem>
                ) : (
                  <DropdownMenuItem
                    key={entry.oid}
                    closeOnClick
                    onClick={() => onSelectedCommitChange(entry.oid)}
                  >
                    {entry.messageHeadline}
                  </DropdownMenuItem>
                ),
              )}
              {orderedCommits.length > visibleCommitCount ? (
                // Kept out of the radio group: it changes how much of the list is on screen
                // rather than what the diff is scoped to.
                <DropdownMenuItem
                  closeOnClick={false}
                  onClick={() => setVisibleCommitCount((count) => count + COMMIT_PAGE_SIZE)}
                >
                  <span className="text-muted-foreground">
                    Show more ({orderedCommits.length - visibleCommitCount} left)
                  </span>
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        {/* One count, and the caveats as icons that carry their own words. Spelled out they
            competed for a strip this narrow and every one of them truncated to nothing. */}
        <PullRequestMetaLine>
          {!filesViewed.enabled ? (
            <span className="shrink-0 tabular-nums">
              {files.length} {files.length === 1 ? "file" : "files"}
              {nextCursor === null ? "" : "+"}
            </span>
          ) : null}
          {filesViewed.enabled && files.length > 0 ? (
            <span className="flex min-w-0 items-center gap-1 tabular-nums">
              {/* Named on a host that keeps no record of its own, so the reader is told whose
                  ticks these are without having to find the icon beside them. The count holds its
                  width and the wording gives way, so the narrow right panel keeps its controls. */}
              <span className="shrink-0">
                {filesViewed.viewedCount} / {files.length}
              </span>
              <span className="truncate">
                {viewedFilesStore === "environment" ? `viewed in ${APP_BASE_NAME}` : "viewed"}
              </span>
              {viewedFilesStore === "environment" ? (
                <Tooltip>
                  <TooltipTrigger render={<span className="flex shrink-0 items-center" />}>
                    <InfoIcon
                      aria-label="These ticks are kept here, not on the host"
                      className="text-muted-foreground size-3.5"
                    />
                  </TooltipTrigger>
                  <TooltipPopup side="bottom">
                    This host keeps no shared record of which files you have read, so these ticks
                    are kept by this environment. They follow you between the apps connected to it,
                    but the host's own web UI will not show them.
                  </TooltipPopup>
                </Tooltip>
              ) : null}
              {filesViewed.error !== null ? (
                <Tooltip>
                  <TooltipTrigger render={<span className="flex shrink-0 items-center" />}>
                    <TriangleAlertIcon
                      aria-label="Your ticks could not be read"
                      className="size-3.5 text-warning-foreground"
                    />
                  </TooltipTrigger>
                  <TooltipPopup side="bottom">
                    The boxes below are whatever was last read, and empty if nothing has been read
                    yet. {filesViewed.error}
                  </TooltipPopup>
                </Tooltip>
              ) : null}
              {filesViewed.truncated ? (
                <Tooltip>
                  <TooltipTrigger render={<span className="flex shrink-0 items-center" />}>
                    <TriangleAlertIcon
                      aria-label="This count covers only part of the change"
                      className="size-3.5 text-warning-foreground"
                    />
                  </TooltipTrigger>
                  <TooltipPopup side="bottom">
                    This change has more files than the host will report ticks for in one read, so
                    the count is short and some boxes below start empty.
                  </TooltipPopup>
                </Tooltip>
              ) : null}
            </span>
          ) : null}
          {withheldContent ? (
            <Tooltip>
              <TooltipTrigger render={<span className="flex shrink-0 items-center" />}>
                <TriangleAlertIcon
                  aria-label="Some of this diff was not shown"
                  className="size-3.5 text-warning-foreground"
                />
              </TooltipTrigger>
              <TooltipPopup side="bottom">
                The host withheld part of this diff — a binary file, or a change too large to
                inline.
              </TooltipPopup>
            </Tooltip>
          ) : null}
          {commit !== null && review.inlineComment ? (
            <Tooltip>
              <TooltipTrigger render={<span className="flex shrink-0 items-center" />}>
                <MessageSquareOffIcon
                  aria-label="Line comments are written from the whole change"
                  className="size-3.5"
                />
              </TooltipTrigger>
              <TooltipPopup side="bottom">
                A comment is anchored to the whole change, so switch to All commits to write one.
              </TooltipPopup>
            </Tooltip>
          ) : null}
        </PullRequestMetaLine>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {viewControlsTarget === undefined ? displayControls : null}
        {fileKeys.length > 0 ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  aria-label={allFilesCollapsed ? "Expand all files" : "Collapse all files"}
                  onClick={toggleAllFiles}
                />
              }
            >
              <MorphIcon
                className="size-3.5"
                icon={allFilesCollapsed ? ChevronsUpDown : ChevronsDownUp}
              />
              {allFilesCollapsed ? "Expand all" : "Collapse all"}
            </TooltipTrigger>
            <TooltipPopup side="top">
              {allFilesCollapsed ? "Expand all files" : "Collapse all files"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
        {fileKeys.length > 0 ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  aria-label={fileTreeOpen ? "Hide file tree" : "Show file tree"}
                  variant="ghost"
                  size="sm"
                  pressed={fileTreeOpen}
                  onPressedChange={(pressed) => setFileTreeOpen(Boolean(pressed))}
                />
              }
            >
              <FolderTreeIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {fileTreeOpen ? "Hide file tree" : "Show file tree"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
    </div>
  );
  const toolbar = (
    <>
      {viewControlsTarget ? createPortal(displayControls, viewControlsTarget) : null}
      {guideFallback ? null : toolbarContent}
    </>
  );
  // The toolbar rides above every branch below, not just the one with a patch in it: a commit
  // whose diff is empty or unreadable still needs the scope dropdown that got the reader there.
  const withToolbar = (body: ReactNode) => (
    <div className="flex h-full min-h-0 flex-col">
      {toolbar}
      <div className="@container/guide flex min-h-0 flex-1">
        {guideFallback && guideStatus ? <GuideChapterPanel>{guideStatus}</GuideChapterPanel> : null}
        <div ref={scrollerRef} className="min-h-0 min-w-0 flex-1 overflow-auto">
          {guideFallback && guideStatus ? (
            <div className="px-4 py-3 @min-[56rem]/guide:hidden">{guideStatus}</div>
          ) : null}
          {body}
        </div>
      </div>
    </div>
  );

  // Under the toolbar rather than in place of it, so choosing a commit does not take the
  // dropdown that was just used off the screen while its diff loads.
  if (diffQuery.isPending && loadedSlices.length === 0) {
    return withToolbar(<DiffPanelLoadingState label="Loading pull request diff..." />);
  }

  // A slice that fails once there are files on screen is reported at the end of them instead:
  // the diff already read is worth more than the error that stopped it growing.
  if (diffQuery.error && loadedSlices.length === 0) {
    return withToolbar(
      <p className="px-4 py-5 text-sm text-muted-foreground">{diffQuery.error}</p>,
    );
  }

  // A patch the viewer cannot structure (binary, or a format it does not parse) still has to
  // be readable, so it falls back to the raw text rather than an empty tab. Only once the diff
  // is whole: returning here while a cursor is outstanding would take the sentinel off screen
  // and end the walk, leaving the rest of the change unasked for.
  const rawSlices =
    nextCursor === null
      ? parsedSlices.flatMap((parsed) => (parsed?.kind === "raw" ? [parsed] : []))
      : [];
  if (files.length === 0 && rawSlices.length > 0) {
    return withToolbar(
      <div className="space-y-4 px-4 py-5">
        {rawSlices.map((slice) => (
          <div key={`${slice.reason}:${slice.text.slice(0, 64)}`} className="space-y-2">
            <p className="text-xs text-muted-foreground">{slice.reason}</p>
            <pre className="whitespace-pre-wrap break-words font-mono text-xs">{slice.text}</pre>
          </div>
        ))}
      </div>,
    );
  }

  if (items.length === 0 && nextCursor === null && chapter === null) {
    return withToolbar(
      <p className="px-4 py-5 text-sm text-muted-foreground">
        {files.length > 0
          ? "No files match the viewing options."
          : commit === null
            ? "This pull request has no file changes."
            : "This commit has no file changes."}
      </p>,
    );
  }

  const orphanThreads = visibleHostThreads.filter((thread) => !placedThreadIds.has(thread.id));
  // A file carrying five stranded conversations should read as that file once rather than as
  // five copies of its path.
  const orphanFiles = new Map<string, PullRequestReviewThread[]>();
  for (const thread of orphanThreads) {
    const existing = orphanFiles.get(thread.path);
    if (existing) existing.push(thread);
    else orphanFiles.set(thread.path, [thread]);
  }

  const unstructured =
    rawSlices.length === 0 ? null : (
      // A slice the viewer cannot structure is still part of the change. Shown under the files
      // that did parse rather than dropped, because the alternative is a diff that silently
      // omits whatever the viewer could not read.
      <div className="space-y-4 border-t border-border/60 px-4 py-5">
        {rawSlices.map((slice) => (
          <div key={`${slice.reason}:${slice.text.slice(0, 64)}`} className="space-y-2">
            <p className="text-xs text-muted-foreground">{slice.reason}</p>
            <pre className="whitespace-pre-wrap break-words font-mono text-xs">{slice.text}</pre>
          </div>
        ))}
      </div>
    );

  const selectChapter = (position: number) => {
    const next = chapters[position];
    if (!next) return;
    savedScroll.current = null;
    scrollElement.current?.scrollTo({ top: 0 });
    setSelectedLines(null);
    setSelectedChapter(next.id);
    setChapterRailOpen(false);
  };
  const chapterRail = chapter ? (
    <ReviewChapterRail
      ariaLabel="Code review chapters"
      chapters={chapterSummaries.map((summary, index) => {
        const members = chapters[index]?.files ?? [];
        const reviewedCount = members.filter((file) => isFileViewed(file.path)).length;
        return {
          ...summary,
          selectedContent:
            index === chapterPosition ? (
              <div className="flex min-w-0 flex-col gap-2 px-2 pb-2">
                <ReviewChapterProgress
                  reviewedCount={reviewedCount}
                  fileCount={members.length}
                  disabled={!chapterReviewComplete}
                  onSetReviewed={
                    filesViewed.enabled && canSetChapterViewed
                      ? (reviewed) => {
                          for (const file of members)
                            setFileViewed(file.fileKey, file.path, reviewed);
                        }
                      : null
                  }
                />
                {!chapterReviewComplete ? (
                  <p className="text-xs text-muted-foreground">
                    Load all files to review this chapter.
                  </p>
                ) : null}
                {guideFallback ? (
                  <ul className="flex min-w-0 flex-col gap-0.5">
                    {chapters[index]?.visibleFiles.map((file) => (
                      <li key={file.path}>
                        <ReviewChapterFileLink
                          path={file.path}
                          stat={
                            sourceFileStats.get(file.fileKey) ?? getDiffLineStat([file.fileDiff])
                          }
                          onSelect={() => revealFile(file.path)}
                        />
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null,
        };
      })}
      position={chapterPosition}
      onSelect={selectChapter}
    />
  ) : null;

  const chapterHeader = chapter ? (
    <div className="space-y-2 border-b border-border/60 px-4 py-3">
      {guideFallback && guideStatus ? (
        <div className="@min-[56rem]/guide:hidden">{guideStatus}</div>
      ) : null}
      <ReviewChapterHeader
        index={chapterPosition}
        count={chapters.length}
        railOpen={chapterRailOpen}
        onRailOpenChange={setChapterRailOpen}
        rail={chapterRail}
        onStep={(delta) => selectChapter(chapterPosition + delta)}
      />
      <h2 className="text-lg font-semibold text-foreground">{chapter.title}</h2>
    </div>
  ) : null;
  return (
    <div className="@container/guide flex h-full min-h-0 flex-col">
      {toolbar}
      {/* Above the code, closed, and counted: these belong to the change rather than to any
            line of it, and in the stream they read as cards dropped into the patch. */}
      {orphanFiles.size > 0 ? (
        <div className="shrink-0 border-b border-border/60">
          <Collapsible open={orphansOpen} onOpenChange={setOrphansOpen}>
            {/* Still a heading, so the section keeps its place in a screen reader's outline;
                the count is spelled out there rather than left as a bare number. */}
            <h2>
              <CollapsibleTrigger className="flex w-full items-center gap-1.5 px-4 py-2 text-left text-xs text-muted-foreground">
                {/* While slices are still arriving a conversation may simply belong to a file
                    that has not landed yet, which is not the same as being off the diff. */}
                <span>
                  {nextCursor === null
                    ? "Conversations not on the current diff"
                    : "Conversations not on the diff loaded so far"}
                </span>
                <ChevronRightIcon
                  aria-hidden
                  className={cn("size-3.5 transition-transform", orphansOpen && "rotate-90")}
                />
                <span aria-hidden className="tabular-nums">
                  {orphanThreads.length}
                </span>
                <span className="sr-only">
                  {orphanThreads.length === 1
                    ? "1 conversation"
                    : `${orphanThreads.length} conversations`}
                </span>
              </CollapsibleTrigger>
            </h2>
            <CollapsiblePanel>
              {/* Keep room for the diff, but let an active reply form fit at its full height. */}
              <div
                data-review-conversations
                className="max-h-64 space-y-3 overflow-auto px-4 pb-3 has-[[data-review-reply-composer]]:max-h-[min(32rem,50vh)]"
              >
                {[...orphanFiles].map(([path, threads]) => (
                  <div key={path}>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <p className="truncate px-3 text-xs text-muted-foreground">{path}</p>
                        }
                      />
                      <TooltipPopup side="top">{path}</TooltipPopup>
                    </Tooltip>
                    <div className="mt-1 space-y-2">
                      {threads.map((thread) => (
                        <div key={thread.id}>
                          {thread.line === null ? null : (
                            <p className="px-3 text-xs text-muted-foreground">
                              {reviewLineRangeLabel(thread)}
                            </p>
                          )}
                          {renderThreadCard(thread)}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </CollapsiblePanel>
          </Collapsible>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {chapter && guideFallback ? (
          <GuideChapterPanel>
            {guideStatus}
            {chapterRail}
          </GuideChapterPanel>
        ) : chapter ? (
          <aside className="w-64 shrink-0 overflow-y-auto border-r border-border/60 px-3 py-4 @max-[56rem]/guide:hidden">
            {guideStatus}
            {chapterRail}
          </aside>
        ) : null}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* Relative wrapper so the review overlay floats over the diff rather than pushing it
              up; the viewer inside still owns its own scrolling. */}
          <div
            className="relative min-h-0 min-w-0 flex-1"
            // The chevron answers this too, but the whole header row is the target a reader
            // actually aims for. The header lives in the viewer's shadow tree, so the capture
            // listener walks `composedPath` — the only way to see through the shadow boundary.
            onClickCapture={(event) => {
              const composedPath = event.nativeEvent.composedPath?.() ?? [];
              for (const node of composedPath) {
                if (!(node instanceof HTMLElement)) continue;
                // A control inside the header — the collapse chevron — handles itself, and
                // this capture listener fires before its own click does. Leave it alone or
                // the two toggles cancel out.
                if (node instanceof HTMLButtonElement || node instanceof HTMLAnchorElement) {
                  return;
                }
                // A label answers for the control it names and this listener runs before it hears
                // anything, so stopping the press keeps the header from folding what the tick folds.
                if (node.hasAttribute("data-viewed-toggle")) return;
                if (node.hasAttribute("data-diffs-header")) {
                  const filePath = node.querySelector("[data-title]")?.textContent?.trim();
                  if (filePath === undefined || filePath === "") return;
                  const item = items.find(
                    (candidate) => resolveFileDiffPath(candidate.fileDiff) === filePath,
                  );
                  if (item !== undefined) toggleFile(item.id);
                  return;
                }
              }
            }}
          >
            {/* The viewer virtualizes against the element it is told is scrolling and places its
              rows absolutely, so it has to own that element — the thread diff panel hands it the
              same one. Scrolling from a parent instead leaves it painting over its neighbours. */}
            <FileViewedToggleContext value={fileViewedToggle}>
              <StyledDiffCodeView<ReviewAnnotationGroup>
                // Keep scrollbar space stable so file metadata and line numbers do not shift as a
                // diff crosses the overflow boundary. The viewer is itself focusable for keyboard
                // interaction, but its native host outline clips and competes with the focus
                // indicators on its actual controls.
                className="@container h-full overflow-auto [scrollbar-gutter:stable]"
                containerRef={setScroller}
                viewerRef={setViewer}
                items={items}
                selectedLines={selectedLines}
                onSelectedLinesChange={setSelectedLines}
                options={diffViewOptions}
                // The viewer owns the scroll container, so the sentinel that asks for the next slice
                // has to live inside it — at the end of the files, where reaching it means the reader
                // is running out of diff.
                renderCodeViewHeader={() => chapterHeader}
                renderCodeViewFooter={renderCodeViewFooter}
                renderHeaderPrefix={renderHeaderPrefix}
                renderHeaderMetadata={renderHeaderMetadata}
                renderAnnotation={renderAnnotation}
                // Find can ask again before the unfolded file arrives, so this unfolds and never folds.
                onRevealSearchMatch={(item) =>
                  setToggledFiles((current) =>
                    toggleFileDiffFoldForViewed(item.id, false, effectiveFoldOverride, current),
                  )
                }
                unsafeCSSExtra={REPLACE_FILE_COUNTS_CSS}
              />
            </FileViewedToggleContext>
          </div>
        </div>
        {!guideFallback && fileTreeOpen ? (
          <aside
            className="relative flex max-w-[60%] min-w-48 shrink-0 flex-col border-l border-border/60 w-(--resizable-width)"
            style={{ "--resizable-width": `${treeWidth.width}px` } as React.CSSProperties}
          >
            <RightPanelResizeHandle handlers={treeWidth.handlers} />
            <DiffFileTree
              key={chapter?.id ?? "all"}
              headerLabel={chapter ? "Files in this chapter" : "Files"}
              ariaLabel={`Pull request #${detail.number} files`}
              entries={fileTreeEntries}
              reviewEntries={
                chapter
                  ? folderReviewEntries.filter(
                      (entry) => reviewFileGroup(entry.path) === chapter.id,
                    )
                  : folderReviewEntries
              }
              onSelectFile={revealFile}
              onReviewFiles={
                filesViewed.enabled && canSetChapterViewed && nextCursor === null
                  ? (paths, reviewed) => {
                      const selectedPaths = new Set(paths);
                      for (const item of annotatedFiles) {
                        if (selectedPaths.has(item.path))
                          setFileViewed(item.fileKey, item.path, reviewed);
                      }
                    }
                  : undefined
              }
              // The tree lists only what has arrived; a footer says so while the diff is still
              // paging, and lets the reader pull the rest in without scrolling for it.
              footer={
                nextCursor === null ? null : (
                  <div className="shrink-0 border-t border-border/60 p-2">
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      className="w-full"
                      disabled={diffQuery.isPending}
                      onClick={diffQuery.error !== null ? () => diffQuery.refresh() : loadNextSlice}
                    >
                      {diffQuery.error !== null
                        ? "Retry"
                        : diffQuery.isPending
                          ? "Loading more files..."
                          : "Load more files"}
                    </Button>
                  </div>
                )
              }
            />
          </aside>
        ) : null}
      </div>
      {unstructured}
    </div>
  );
}

export default PullRequestCodeTab;
