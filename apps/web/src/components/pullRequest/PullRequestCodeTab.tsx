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
} from "@t3tools/contracts";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  Columns2Icon,
  FolderTreeIcon,
  MessageSquareIcon,
  MessageSquareOffIcon,
  Rows3Icon,
  TextWrapIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { useAtomRefresh } from "@effect/atom-react";
import * as Schema from "effect/Schema";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useClientSettings, useUpdateClientSettings } from "~/hooks/useSettings";
import { useTheme } from "~/hooks/useTheme";
import { areAllDiffFilesCollapsed } from "~/lib/diffCollapse";
import { pullRequestFindingKey, type PullRequestFinding } from "./pullRequestDetail.logic";
import { canEditPullRequestComment } from "./pullRequestEditing.logic";
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
import { DiffWorkerPoolProvider } from "../DiffWorkerPoolProvider";
import { DiffCommentAnnotation } from "../diffs/DiffCommentAnnotation";
import { DiffFileTree } from "../diffs/DiffFileTree";
import { diffFileTreeEntries } from "../diffs/diffFileTree.logic";
import { StyledDiffCodeView } from "../diffs/StyledDiffCodeView";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/menu";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PendingReviewCommentCard, ReviewThreadCard } from "./PullRequestReviewAnnotation";
import { PullRequestReviewBar } from "./PullRequestReviewBar";
import {
  isFileDiffCollapsed,
  isLineInFileDiff,
  type DiffFoldOverride,
} from "./pullRequestDiff.logic";
import { PullRequestDiffStat, PullRequestMetaLine } from "./pullRequestPresentation";
import {
  nextPendingReviewCommentId,
  pullRequestReviewKey,
  usePendingReviewComments,
  usePullRequestReviewStore,
  type PendingReviewComment,
} from "./pullRequestReviewStore";

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
  /** The whole selection, which the comment collapses to one line but a question keeps. */
  readonly range: SelectedLineRange;
}

/** A range of the diff and the reader's request for the agent. */
export interface PullRequestAgentSelectionInput {
  /** The marked lines, already in the shape the composer draws and the agent reads. */
  readonly comment: ReviewCommentContext;
  readonly request: string;
}

/** The contract's sides named the way the diff viewer names them, and back again. */
function toViewerSide(side: PullRequestDiffSide) {
  return side === "left" ? ("deletions" as const) : ("additions" as const);
}

function getReviewPositionAnchor(position: PullRequestReviewPosition): {
  line: number;
  side: PullRequestDiffSide;
} {
  switch (position.kind) {
    case "added":
      return { line: position.newLine, side: "right" };
    case "deleted":
      return { line: position.oldLine, side: "left" };
    case "context":
      return {
        line: position.side === "left" ? position.oldLine : position.newLine,
        side: position.side,
      };
  }
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
export function PullRequestCodeTab({
  environmentId,
  reference,
  detail,
  selectedCommitOid,
  onSelectedCommitChange,
  pendingFinding,
  fixFindingLabel = "Fix in a thread",
  onFixFinding,
  onAddToAgentSelection,
  onRefresh,
  refreshToken = 0,
}: {
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
  onRefresh: () => void;
  /** Bumped by the panel's refresh button: drop the accumulated pages and re-read the diff. */
  refreshToken?: number;
}) {
  const { resolvedTheme } = useTheme();
  const settings = useClientSettings();
  const [toggledFiles, setToggledFiles] = useState<ReadonlySet<string>>(() => new Set());
  // A change of any size can carry hundreds of commits, and a menu that long is a scroll rather
  // than a choice. The rest arrive ten at a time, on request.
  const [visibleCommitCount, setVisibleCommitCount] = useState(COMMIT_PAGE_SIZE);
  /** Set once the reader has asked for every file at once, until they pick a file apart again. */
  const [foldOverride, setFoldOverride] = useState<DiffFoldOverride>(null);
  const diffLayout = settings.diffLayout;
  const updateClientSettings = useUpdateClientSettings();
  const [wordWrap, setWordWrap] = useState(settings.wordWrap);
  const [fileTreeOpen, setFileTreeOpen] = useLocalStorage(
    PULL_REQUEST_FILE_TREE_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const [selectedLines, setSelectedLines] = useState<{
    id: string;
    range: SelectedLineRange;
  } | null>(null);
  const [draft, setDraft] = useState<DraftAnchor | null>(null);
  const [threadPending, setThreadPending] = useState(false);
  const [orphansOpen, setOrphansOpen] = useState(false);
  // Closed by default so the review form does not permanently eat vertical space below the
  // diff; opened on demand as a floating overlay instead.
  const [reviewOpen, setReviewOpen] = useState(false);
  // Which pull request the slices belong to travels with them, so a render taken before the
  // reset below cannot read the previous one's slices — or send its cursor to the host.
  const [sliceState, setSliceState] = useState<{
    readonly key: string;
    readonly cursor: string | null;
    readonly slices: ReadonlyArray<DiffSlice>;
  }>({ key: "", cursor: null, slices: NO_SLICES });
  const parseCache = useRef(new Map<string, RenderablePatch>());
  const viewerRef = useRef<CodeViewHandle<ReviewAnnotationGroup> | null>(null);

  const referenceKey = pullRequestReviewKey(reference);
  const commit = selectedCommitOid;
  // One commit's own changes and the whole change are two different diffs, paged separately, so
  // everything below is keyed by both.
  const scopeKey = commit === null ? referenceKey : `${referenceKey}@${commit}`;
  // The panel keeps this mounted across pull requests, so an open composer would otherwise
  // survive the switch and attach its comment to whichever one is on screen when it is sent.
  useEffect(() => {
    setDraft(null);
    setSelectedLines(null);
    setToggledFiles(new Set());
    setFoldOverride(null);
    setVisibleCommitCount(COMMIT_PAGE_SIZE);
    setOrphansOpen(false);
    setSliceState({ key: scopeKey, cursor: null, slices: NO_SLICES });
    parseCache.current.clear();
  }, [scopeKey]);

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
  useEffect(() => {
    const data = diffQuery.data;
    if (data === null) return;
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
  }, [cursor, diffQuery.data, scopeKey]);
  // The refresh button rereads from the first page rather than the page the reader is on:
  // pages are positions in one snapshot of the diff, and a fresh snapshot starts over.
  const refreshFirstDiffPage = useAtomRefresh(
    pullRequestEnvironment.diff({
      environmentId,
      input: { ...reference, ...(commit === null ? {} : { commit }) },
    }),
  );
  const appliedRefreshToken = useRef(refreshToken);
  useEffect(() => {
    if (appliedRefreshToken.current === refreshToken) return;
    appliedRefreshToken.current = refreshToken;
    setSliceState({ key: scopeKey, cursor: null, slices: NO_SLICES });
    refreshFirstDiffPage();
  }, [refreshToken, scopeKey, refreshFirstDiffPage]);
  const reviewKey = referenceKey;
  const pendingComments = usePendingReviewComments(reference);
  const addComment = usePullRequestReviewStore((store) => store.addComment);
  const removeComment = usePullRequestReviewStore((store) => store.removeComment);
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
  const loadDiffFiles = useMemo(
    () =>
      createPullRequestDiffFileContentsLoader(getDiffFileContents, {
        environmentId,
        reference,
        commit,
        cacheKey: `pull-request:${referenceKey}:${detail.updatedAt}:${commit ?? "all"}`,
      }),
    [commit, detail.updatedAt, environmentId, getDiffFileContents, reference, referenceKey],
  );

  // What is offered is the intersection of two different questions: what this host can do at
  // all, and what this account may do on this repository. Either one saying no means a control
  // that would only ever end in a refusal.
  const review = useMemo(() => {
    const hostReview = detail.capabilities.review;
    const viewer = detail.viewerPermissions;
    return {
      inlineComment: hostReview.inlineComment && viewer.comment,
      reply: hostReview.reply && viewer.comment,
      resolve: hostReview.resolve && viewer.resolve,
      verdicts: hostReview.verdicts.filter((verdict) => viewer.verdicts.includes(verdict)),
    };
  }, [detail.capabilities.review, detail.viewerPermissions]);
  // A comment is posted against the pull request's head diff, so a line number taken from one
  // commit's own diff would land somewhere else entirely. Commenting waits for the whole change.
  const canCommentOnLines = review.inlineComment && commit === null;
  // Every slice is parsed on its own and the result held, so a slice arriving costs one parse
  // rather than one per slice already on screen. Its cache key carries the theme, which is what
  // the tokenizer caches against, so a theme change is still a fresh parse.
  const parsedSlices = useMemo(
    () =>
      loadedSlices.map((slice) => {
        // The patch's own hash is part of the key: a refreshed page reuses its cursor, and a
        // key of position alone would keep handing back the parse of the patch it replaced.
        const cacheKey = `pull-request:${scopeKey}:${resolvedTheme}:${slice.cursor ?? "first"}:${fnv1a32(slice.patch)}`;
        const cached = parseCache.current.get(cacheKey);
        if (cached) return cached;
        const parsed = getRenderablePatch(slice.patch, cacheKey, {
          compactPartialHunkOffsets: true,
        });
        if (parsed) parseCache.current.set(cacheKey, parsed);
        return parsed;
      }),
    [loadedSlices, resolvedTheme, scopeKey],
  );
  // Ordered within a slice rather than across them: ordering the accumulated set would let a late
  // slice push a file the reader is part way through further down the page.
  const files = useMemo(
    () =>
      parsedSlices.flatMap((parsed) =>
        parsed?.kind === "files" ? orderDiffFiles(parsed.files) : [],
      ),
    [parsedSlices],
  );
  const nextCursor = loadedSlices.at(-1)?.nextCursor ?? null;
  // What a slice withheld: the host declining to inline part of it, or a patch the viewer could
  // not structure and so dropped. Neither says anything about there being more to fetch.
  const withheldContent =
    loadedSlices.some((slice) => slice.truncated) ||
    parsedSlices.some((parsed) => parsed?.kind === "raw");

  // Placing a conversation takes more than its file being in the diff: its line has to fall
  // inside a hunk that was rendered. One that does not is drawn nowhere, so it belongs in the
  // off-diff list rather than disappearing between the two.
  const placedThreadIds = useMemo(() => {
    const placed = new Set<string>();
    // A commit's diff counts lines within that commit; a review comment is anchored to the
    // pull request's head diff. Pinning one onto the other would put the remark against
    // whichever code happens to hold that line number in this commit, so while a commit is on
    // screen every conversation is listed rather than placed.
    if (commit !== null) return placed;
    for (const file of files) {
      const path = resolveFileDiffPath(file);
      for (const thread of detail.reviewThreads) {
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
  }, [commit, detail.reviewThreads, files]);

  const items = useMemo<CodeViewDiffItem<ReviewAnnotationGroup>[]>(
    () =>
      files.map((fileDiff) => {
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

        for (const thread of detail.reviewThreads) {
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

        const collapsed = isFileDiffCollapsed(fileKey, foldOverride, toggledFiles);

        const annotations: ReviewAnnotation[] = [...groups.values()].map((group) => ({
          side: toViewerSide(group.side),
          lineNumber: group.line,
          metadata: { threads: group.threads, pending: group.pending, draft: group.draft },
        }));
        return {
          id: fileKey,
          type: "diff" as const,
          fileDiff,
          annotations,
          collapsed,
          // The viewer re-renders an item only when its version changes, so everything the
          // annotations show has to be part of it.
          version: fnv1a32(
            `${collapsed ? "1" : "0"}:${annotations
              .map(
                ({ side, lineNumber, metadata }) =>
                  `${side}:${lineNumber}:${metadata.draft ? "d" : ""}:${metadata.pending
                    .map((comment) => `${comment.id}:${comment.body}`)
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
                                .map(
                                  (r) => `${r.content}:${r.count}:${r.viewerHasReacted ? "v" : ""}`,
                                )
                                .join(",")}`,
                          )
                          .join(";")}`,
                    )
                    .join(",")}`,
              )
              .join("|")}`,
          ),
        };
      }),
    [
      commit,
      detail.reviewThreads,
      draft,
      files,
      foldOverride,
      pendingComments,
      placedThreadIds,
      toggledFiles,
    ],
  );
  const lineStat = useMemo(() => getDiffLineStat(files), [files]);
  const omittedFileStats = useMemo(
    () =>
      new Map(
        loadedSlices.flatMap((slice) =>
          slice.omittedFileStats.map((file) => [file.path, file] as const),
        ),
      ),
    [loadedSlices],
  );
  const fileKeys = useMemo(() => items.map((item) => item.id), [items]);
  const collapsedFileKeys = useMemo(
    () => new Set(items.filter((item) => item.collapsed === true).map((item) => item.id)),
    [items],
  );
  const allFilesCollapsed = areAllDiffFilesCollapsed(fileKeys, collapsedFileKeys);
  const fileTreeEntries = useMemo(() => diffFileTreeEntries(files), [files]);

  // A failed slice must not be asked for again on its own. The files already loaded keep the
  // sentinel on screen, so re-arming it after a failure would request the same slice forever.
  const canLoadNextSlice =
    nextCursor !== null &&
    nextCursor !== cursor &&
    !diffQuery.isPending &&
    diffQuery.error === null;
  const loadNextSlice = useCallback(() => {
    if (nextCursor === null) return;
    setSliceState((previous) => ({ ...previous, cursor: nextCursor }));
  }, [nextCursor]);

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
  const toggleFile = useCallback(
    (fileKey: string) =>
      setToggledFiles((current) => {
        // The override becomes this file's new default the moment it is folded into the set below,
        // so nothing has to be re-derived when the reader goes back to choosing one at a time.
        const next = new Set(current);
        if (next.has(fileKey)) next.delete(fileKey);
        else next.add(fileKey);
        return next;
      }),
    [],
  );

  // Held as state so the scroll runs after a folded file has been drawn open; scrolling in the
  // same tick would land on the folded header's position.
  const [treeReveal, setTreeReveal] = useState<{ fileKey: string; id: number } | null>(null);
  useEffect(() => {
    if (treeReveal === null) return;
    viewerRef.current?.scrollTo({ type: "item", id: treeReveal.fileKey, align: "start" });
  }, [treeReveal]);
  const revealFile = useCallback(
    (path: string) => {
      const item = items.find((candidate) => resolveFileDiffPath(candidate.fileDiff) === path);
      if (item === undefined) return;
      if (item.collapsed === true) toggleFile(item.id);
      setTreeReveal((current) => ({ fileKey: item.id, id: (current?.id ?? 0) + 1 }));
    },
    [items, toggleFile],
  );

  const toggleAllFiles = () => {
    // Held as an override of the default rather than as the file keys on screen: a diff that is
    // still paging would otherwise bring its next slice in folded, moments after the reader
    // asked for everything to be open.
    setFoldOverride(areAllDiffFilesCollapsed(fileKeys, collapsedFileKeys) ? "expanded" : "folded");
    setToggledFiles(new Set());
  };

  // Newest first: the last commit is the one a reader coming back to a change is looking for.
  const orderedCommits = useMemo(
    () =>
      // By instant, not by the text: GitLab keeps a commit's own UTC offset, so two commits
      // from different zones would sort by how they were written rather than when they landed.
      detail.commits.toSorted(
        (left, right) => Date.parse(right.committedDate) - Date.parse(left.committedDate),
      ),
    [detail.commits],
  );

  const beginComment = useCallback(
    (range: SelectedLineRange | null, context: { item: CodeViewItem<ReviewAnnotationGroup> }) => {
      if (!range || !canCommentOnLines) return;
      const item = context.item;
      if (item.type !== "diff") return;
      const file = files.find((candidate) => buildFileDiffRenderKey(candidate) === item.id);
      if (!file) return;
      // A range collapses to its last line: only GitHub carries a multi-line comment, and one
      // that silently lost its first line on the other hosts would be worse than one line.
      const path = resolveFileDiffPath(file);
      const previousPath = resolveFileDiffPreviousPath(file);
      const position = resolveDiffReviewPosition(file, range.end, range.endSide ?? range.side);
      if (position === null) return;
      setDraft({
        fileKey: item.id,
        path,
        oldPath: previousPath === path ? null : previousPath,
        position,
        range,
      });
    },
    [canCommentOnLines, files],
  );

  // Built here because the parsed diff only lives here, and built by the same function the
  // thread panel's own line selection uses — the gesture is the same one, so a second reading of
  // the hunks would only be a second place for it to drift.
  const finishSelection = useCallback(
    (anchor: DraftAnchor, text: string, onFinish: (comment: ReviewCommentContext) => void) => {
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
    },
    [detail.number, files],
  );

  // The viewer's SlotPortals memoizes each visible file's header/annotation portal on these
  // render props and on `options` below; a fresh identity on any of them — as a plain inline
  // function or object literal would be — invalidates that memo and recreates every portal on
  // screen on any tab re-render (a drag-selection, a keystroke in the draft, a review-store
  // update), which is the jank this file is otherwise clean of.
  const renderCodeViewFooter = useCallback(
    () =>
      // Only while something is still owed. A finished diff whose query fails on a later
      // refresh — a reconnect re-runs every one of them — is whole on screen already, and
      // saying otherwise sends the reader looking for files that are all there.
      nextCursor === null ? null : (
        <div
          ref={setSentinel}
          className="flex items-center justify-center gap-2 py-2 text-xs text-muted-foreground"
        >
          {diffQuery.error !== null ? (
            <>
              <span>The rest of this diff could not be loaded.</span>
              <Button size="xs" variant="outline" onClick={() => diffQuery.refresh()}>
                Retry
              </Button>
            </>
          ) : diffQuery.isPending ? (
            "Loading more files..."
          ) : null}
        </div>
      ),
    [nextCursor, diffQuery.error, diffQuery.isPending, diffQuery.refresh],
  );

  const renderHeaderPrefix = useCallback(
    (item: CodeViewItem<ReviewAnnotationGroup>) => {
      // The item the viewer is drawing already carries the state the memo settled on, so the
      // chevron follows it rather than recomputing the default here.
      const collapsed = item.collapsed === true;
      return (
        <Button
          size="icon-micro"
          variant="ghost-muted"
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand diff" : "Collapse diff"}
          className="mr-1 rounded hover:bg-transparent"
          onClick={(event) => {
            event.stopPropagation();
            toggleFile(item.id);
          }}
        >
          {collapsed ? (
            <ChevronRightIcon className="size-4" />
          ) : (
            <ChevronDownIcon className="size-4" />
          )}
        </Button>
      );
    },
    [toggleFile],
  );

  const renderHeaderMetadata = useCallback(
    (item: CodeViewItem<ReviewAnnotationGroup>) => {
      if (item.type !== "diff") return null;
      let additions = 0;
      let deletions = 0;
      for (const hunk of item.fileDiff.hunks) {
        additions += hunk.additionLines;
        deletions += hunk.deletionLines;
      }
      if (additions === 0 && deletions === 0) {
        const withheld = omittedFileStats.get(resolveFileDiffPath(item.fileDiff));
        if (withheld) ({ additions, deletions } = withheld);
      }
      return (
        <PullRequestDiffStat
          additions={additions}
          deletions={deletions}
          className="font-mono text-[11px]"
        />
      );
    },
    [omittedFileStats],
  );

  const diffViewOptions = useMemo(
    () => ({
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
    }),
    [diffLayout, wordWrap, resolvedTheme, loadDiffFiles, canCommentOnLines, draft, beginComment],
  );

  const runThreadCommand = useCallback(
    async (label: string, run: () => Promise<{ readonly _tag: string }>): Promise<boolean> => {
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
    },
    [onRefresh, threadPending],
  );

  // A conversation is the same card wired to the same commands whether it sits on its line or
  // was stranded off the diff; only where it is drawn differs.
  const renderThreadCard = useCallback(
    (thread: PullRequestReviewThread) => (
      <ReviewThreadCard
        // Named with the pull request too: a thread's id is the host's own, and two pull requests
        // can hand out the same one — which would leave one card's open editor standing over the
        // other's conversation.
        key={`${reference.projectId}#${reference.number}:${thread.id}`}
        thread={thread}
        workspaceRoot={detail.workspaceRoot}
        canReply={review.reply}
        canResolve={review.resolve}
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
          canEditPullRequestComment(detail, { author: comment.author, kind: "review-comment" })
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
          void runThreadCommand("The conversation could not be updated", () =>
            setThreadResolution({
              environmentId,
              input: { ...reference, threadId: thread.id, resolved: !thread.isResolved },
            }),
          )
        }
        onReacted={onRefresh}
      />
    ),
    [
      detail,
      environmentId,
      fixFindingLabel,
      loadThreadComments,
      onRefresh,
      onFixFinding,
      pendingFinding,
      reference,
      replyToThread,
      review.reply,
      review.resolve,
      runThreadCommand,
      setThreadResolution,
      threadPending,
      updateComment,
    ],
  );

  const renderAnnotation = useCallback(
    (annotation: ReviewAnnotation) => (
      <div className="py-1 font-sans text-foreground">
        {annotation.metadata.threads.map(renderThreadCard)}
        {annotation.metadata.pending.map((comment) => (
          <PendingReviewCommentCard
            key={comment.id}
            comment={comment}
            onRemove={() => removeComment(reviewKey, comment.id)}
          />
        ))}
        {annotation.metadata.draft && draft ? (
          <DiffCommentAnnotation
            kind="draft"
            rangeLabel={`${draft.path}:${getReviewPositionAnchor(draft.position).line}`}
            text=""
            submitLabel="Add to review"
            {...(onAddToAgentSelection
              ? {
                  secondaryAction: {
                    label: "Add to agent",
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
              addComment(reviewKey, {
                id: nextPendingReviewCommentId(),
                path: draft.path,
                ...(draft.oldPath === null ? {} : { oldPath: draft.oldPath }),
                position: draft.position,
                body,
              });
              setDraft(null);
              setSelectedLines(null);
            }}
          />
        ) : null}
      </div>
    ),
    [
      addComment,
      draft,
      finishSelection,
      onAddToAgentSelection,
      removeComment,
      renderThreadCard,
      reviewKey,
    ],
  );

  /**
   * The review overlay belongs to the pull request, not to the patch: a change whose diff
   * cannot be structured — or read at all — is still one a reviewer can approve or reject, so
   * it survives every branch below. It floats over the scroll area rather than sitting in the
   * layout flow, so the diff keeps the full height instead of permanently losing a strip to a
   * footer most reviews never touch. Hidden entirely where the host offers no verdicts, same as
   * the bar it wraps did.
   */
  const reviewOverlay =
    review.verdicts.length === 0 ? null : (
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10">
        {reviewOpen ? (
          <div className="surface-glass pointer-events-auto absolute inset-x-3 bottom-3 rounded-xl border border-border/60 shadow-lg">
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="Close review"
              className="absolute right-2 top-2"
              onClick={() => setReviewOpen(false)}
            >
              <XIcon className="size-3.5" />
            </Button>
            <PullRequestReviewBar
              environmentId={environmentId}
              reference={reference}
              verdicts={review.verdicts}
              onSubmitted={() => {
                onRefresh();
                setReviewOpen(false);
              }}
            />
          </div>
        ) : (
          // Bottom-right, clear of the vertical scrollbar the diff view keeps to its own right
          // edge.
          <Button
            className="pointer-events-auto absolute right-4 bottom-3 rounded-full shadow-lg"
            onClick={() => setReviewOpen(true)}
            size="compact"
            variant="glass"
          >
            <MessageSquareIcon className="size-3.5" />
            Review
            {pendingComments.length > 0 ? (
              <span className="flex size-4 items-center justify-center rounded-full bg-accent text-[10px] tabular-nums text-accent-foreground">
                {pendingComments.length}
              </span>
            ) : null}
          </Button>
        )}
      </div>
    );
  // A rebase or a force-push can take the scoped commit out of the change. Its diff may still
  // be reachable on the host, but it is no longer part of what is being reviewed, so the scope
  // goes back to the whole change rather than sitting under a name nothing matches.
  //
  // Including when the change reports no commits at all: the scope dropdown is the only way back
  // to the whole diff and it is not drawn without commits to list, so a scope that outlived them
  // would leave the tab reading one obsolete commit with nothing to press.
  const selectedCommit = orderedCommits.find((entry) => entry.oid === commit);
  useEffect(() => {
    if (commit !== null && selectedCommit === undefined) {
      onSelectedCommitChange(null);
    }
  }, [commit, onSelectedCommitChange, selectedCommit]);
  const scopeLabel = selectedCommit ? selectedCommit.messageHeadline : "All commits";
  /**
   * The same controls the thread diff panel carries, in the same order, minus the
   * ignore-whitespace toggle: that is `git diff -w` on the server, and no host's pull request
   * diff API offers it.
   */
  const toolbar = (
    <div className="flex h-10 min-h-10 shrink-0 items-center justify-between gap-2 border-b border-border/60 bg-background px-4 text-xs text-muted-foreground">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {/* A host that reports no commits has nothing to scope by, and a dropdown whose only
            entry is the scope already showing is a control that does nothing. */}
        {orderedCommits.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              className="inline-flex h-6 max-w-64 items-center gap-1 rounded-md bg-accent px-2 text-xs font-medium text-accent-foreground outline-none transition-colors hover:bg-accent/80 focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`Diff scope: ${scopeLabel}`}
            >
              <span className="truncate">{scopeLabel}</span>
              <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-80">
              <DropdownMenuItem
                className={commit === null ? "bg-foreground/[0.08]" : undefined}
                onClick={() => onSelectedCommitChange(null)}
              >
                <span>All commits</span>
              </DropdownMenuItem>
              {orderedCommits.slice(0, visibleCommitCount).map((entry) => (
                <DropdownMenuItem
                  key={entry.oid}
                  className={entry.oid === commit ? "bg-foreground/[0.08]" : undefined}
                  onClick={() => onSelectedCommitChange(entry.oid)}
                >
                  {/* Headlines run long, and the abbreviated oid after one is what a reader
                      matches against the commit list on the host. */}
                  <Tooltip>
                    <TooltipTrigger
                      render={<span className="min-w-0 truncate">{entry.messageHeadline}</span>}
                    />
                    <TooltipPopup side="top">{entry.messageHeadline}</TooltipPopup>
                  </Tooltip>
                  <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">
                    {entry.oid.slice(0, 7)}
                  </span>
                </DropdownMenuItem>
              ))}
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
          <span className="shrink-0 tabular-nums">
            {files.length} {files.length === 1 ? "file" : "files"}
            {nextCursor === null ? "" : "+"}
          </span>
          {withheldContent ? (
            <Tooltip>
              <TooltipTrigger render={<span className="flex shrink-0 items-center" />}>
                <TriangleAlertIcon
                  aria-label="Some of this diff was not shown"
                  className="size-3.5 text-amber-600 dark:text-amber-500"
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
        <PullRequestDiffStat
          additions={lineStat.additions}
          deletions={lineStat.deletions}
          className="mr-1"
        />
        {fileKeys.length > 0 ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={allFilesCollapsed ? "Expand all files" : "Collapse all files"}
                  onClick={toggleAllFiles}
                />
              }
            >
              {allFilesCollapsed ? (
                <ChevronsUpDownIcon className="size-3.5" />
              ) : (
                <ChevronsDownUpIcon className="size-3.5" />
              )}
            </TooltipTrigger>
            <TooltipPopup side="top">
              {allFilesCollapsed ? "Expand all files" : "Collapse all files"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
        <ToggleGroup
          className="shrink-0 gap-1"
          size="sm"
          value={[diffLayout]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "stacked" || next === "split") {
              updateClientSettings({ diffLayout: next });
            }
          }}
        >
          <Toggle aria-label="Stacked diff view" value="stacked" variant="ghost">
            <Rows3Icon className="size-3.5" />
          </Toggle>
          <Toggle aria-label="Split diff view" value="split" variant="ghost">
            <Columns2Icon className="size-3.5" />
          </Toggle>
        </ToggleGroup>
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                aria-label={wordWrap ? "Disable diff line wrapping" : "Enable diff line wrapping"}
                variant="ghost"
                size="sm"
                pressed={wordWrap}
                onPressedChange={(pressed) => {
                  setWordWrap(Boolean(pressed));
                }}
              />
            }
          >
            <TextWrapIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">
            {wordWrap ? "Disable line wrapping" : "Enable line wrapping"}
          </TooltipPopup>
        </Tooltip>
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
  // The toolbar rides above every branch below, not just the one with a patch in it: a commit
  // whose diff is empty or unreadable still needs the scope dropdown that got the reader there.
  const withReviewBar = (body: ReactNode) => (
    <div className="flex h-full min-h-0 flex-col">
      {toolbar}
      {/* The overlay is anchored to this wrapper, not the scroller: absolute positioning
          inside an overflowing element tracks the content's bottom edge, which would carry
          the trigger away with the first scroll. */}
      <div className="relative min-h-0 flex-1">
        <div className="h-full overflow-auto">{body}</div>
        {reviewOverlay}
      </div>
    </div>
  );

  // Under the toolbar rather than in place of it, so choosing a commit does not take the
  // dropdown that was just used off the screen while its diff loads.
  if (diffQuery.isPending && loadedSlices.length === 0) {
    return withReviewBar(<DiffPanelLoadingState label="Loading pull request diff..." />);
  }

  // A slice that fails once there are files on screen is reported at the end of them instead:
  // the diff already read is worth more than the error that stopped it growing.
  if (diffQuery.error && loadedSlices.length === 0) {
    return withReviewBar(
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
    return withReviewBar(
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

  if (items.length === 0 && nextCursor === null) {
    return withReviewBar(
      <p className="px-4 py-5 text-sm text-muted-foreground">
        {commit === null
          ? "This pull request has no file changes."
          : "This commit has no file changes."}
      </p>,
    );
  }

  const orphanThreads = detail.reviewThreads.filter((thread) => !placedThreadIds.has(thread.id));
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

  return (
    <DiffWorkerPoolProvider>
      <div className="flex h-full min-h-0 flex-col">
        {toolbar}
        {/* Above the code, closed, and counted: these belong to the change rather than to any
            line of it, and in the stream they read as cards dropped into the patch. */}
        {orphanFiles.size > 0 ? (
          <Collapsible
            className="shrink-0 border-b border-border/60"
            open={orphansOpen}
            onOpenChange={setOrphansOpen}
          >
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
              {/* Capped: opened on a change with dozens of them, this would otherwise leave no
                  room for the diff it sits above. */}
              <div className="max-h-64 space-y-3 overflow-auto px-4 pb-3">
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
                            <p className="px-3 text-xs text-muted-foreground">Line {thread.line}</p>
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
        ) : null}
        <div className="flex min-h-0 flex-1 overflow-hidden">
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
            <StyledDiffCodeView<ReviewAnnotationGroup>
              // Keep scrollbar space stable so file metadata and line numbers do not shift as a
              // diff crosses the overflow boundary. The viewer is itself focusable for keyboard
              // interaction, but its native host outline clips and competes with the focus
              // indicators on its actual controls.
              className="h-full overflow-auto [scrollbar-gutter:stable]"
              viewerRef={viewerRef}
              items={items}
              selectedLines={selectedLines}
              onSelectedLinesChange={setSelectedLines}
              options={diffViewOptions}
              // The viewer owns the scroll container, so the sentinel that asks for the next slice
              // has to live inside it — at the end of the files, where reaching it means the reader
              // is running out of diff.
              renderCodeViewFooter={renderCodeViewFooter}
              renderHeaderPrefix={renderHeaderPrefix}
              renderHeaderMetadata={renderHeaderMetadata}
              renderAnnotation={renderAnnotation}
              unsafeCSSExtra={REPLACE_FILE_COUNTS_CSS}
            />
            {reviewOverlay}
          </div>
          {fileTreeOpen ? (
            <aside className="flex w-[min(20rem,40%)] min-w-48 shrink-0 border-l border-border/60">
              <DiffFileTree
                ariaLabel={`Pull request #${detail.number} files`}
                entries={fileTreeEntries}
                onSelectFile={revealFile}
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
                        onClick={
                          diffQuery.error !== null ? () => diffQuery.refresh() : loadNextSlice
                        }
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
    </DiffWorkerPoolProvider>
  );
}

export default PullRequestCodeTab;
