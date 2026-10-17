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
  Columns2Icon,
  FolderTreeIcon,
  InfoIcon,
  MessageSquareOffIcon,
  PilcrowIcon,
  Rows3Icon,
  Settings2Icon,
  TextWrapIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown } from "lucide";
import { useAtomRefresh } from "@effect/atom-react";
import * as Schema from "effect/Schema";
import {
  createContext,
  use,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useClientSettings, useUpdateClientSettings } from "~/hooks/useSettings";
import { useTheme } from "~/hooks/useTheme";
import { areAllDiffFilesCollapsed } from "~/lib/diffCollapse";
import { pullRequestFindingKey, type PullRequestFinding } from "./pullRequestDetail.logic";
import { canEditPullRequestComment, canResolvePullRequestThread } from "./pullRequestEditing.logic";
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
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/menu";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
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
import {
  nextPendingReviewCommentId,
  pullRequestReviewKey,
  usePendingReviewComments,
  usePullRequestReviewStore,
  type PendingReviewComment,
} from "./pullRequestReviewStore";

interface ReviewAnnotationGroup {
  readonly threads: ReadonlyArray<PullRequestReviewThread>;
  readonly pending: ReadonlyArray<PendingReviewComment>;
  readonly draft: boolean;
}

type ReviewAnnotation = DiffLineAnnotation<ReviewAnnotationGroup>;

const COMMIT_PAGE_SIZE = 10;

const PULL_REQUEST_FILE_TREE_STORAGE_KEY = "t3code.pullRequestFileTreeOpen";

interface DiffSlice {
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
  readonly oldPath: string | null;
  readonly position: PullRequestReviewPosition;
  readonly range: SelectedLineRange;
}

export interface PullRequestAgentSelectionInput {
  readonly comment: ReviewCommentContext;
  readonly request: string;
}

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
  onRefresh,
  refreshToken = 0,
  revealRequest = null,
}: {
  scrollerRef: (node: HTMLDivElement | null) => void;
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  detail: PullRequestDetailView;
  selectedCommitOid: string | null;
  onSelectedCommitChange: (oid: string | null) => void;
  pendingFinding?: string | null;
  fixFindingLabel?: string;
  onFixFinding?: (finding: PullRequestFinding) => void;
  onAddToAgentSelection?: (input: PullRequestAgentSelectionInput) => void;
  onRefresh: () => void;
  refreshToken?: number;
  revealRequest?: { readonly path: string; readonly nonce: number } | null;
}) {
  const { resolvedTheme } = useTheme();
  const settings = useClientSettings();
  const [toggledFiles, setToggledFiles] = useState<ReadonlySet<string>>(() => new Set());
  const [visibleCommitCount, setVisibleCommitCount] = useState(COMMIT_PAGE_SIZE);
  const [foldOverride, setFoldOverride] = useState<DiffFoldOverride>(null);
  const effectiveFoldOverride =
    foldOverride ?? (settings.diffFilesCollapsed ? "folded" : "expanded");
  const diffLayout = settings.diffLayout;
  const updateClientSettings = useUpdateClientSettings();
  const [wordWrap, setWordWrap] = useState(settings.wordWrap);
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(settings.diffIgnoreWhitespace);
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
  const scopeKey = commit === null ? referenceKey : `${referenceKey}@${commit}`;
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
  // Pages accumulate into slices as each answer arrives, so the slice list is adjusted while
  // rendering the answer rather than one commit later.
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
  const refreshFirstDiffPage = useAtomRefresh(
    pullRequestEnvironment.diff({
      environmentId,
      input: { ...reference, ...(commit === null ? {} : { commit }) },
    }),
  );
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

  const viewedFilesStore = detail.capabilities.viewedFiles;
  const filesViewed = usePullRequestFilesViewed({
    environmentId,
    reference,
    enabled: viewedFilesStore !== undefined,
  });
  const {
    setViewed,
    refresh: refreshFilesViewed,
    enabled: filesViewedEnabled,
    isViewed: isFileViewed,
    isStale: isFileViewedStale,
  } = filesViewed;
  const appliedRefreshToken = useRef(refreshToken);
  useEffect(() => {
    if (appliedRefreshToken.current === refreshToken) return;
    appliedRefreshToken.current = refreshToken;
    setSliceState({ key: scopeKey, cursor: null, slices: NO_SLICES });
    refreshFirstDiffPage();
    refreshFilesViewed();
  }, [refreshToken, scopeKey, refreshFirstDiffPage, refreshFilesViewed]);

  // The sentinel is held as state rather than a ref because the viewer mounts its own footer:
  // an effect reading a ref could run before that node exists and would never arm the observer.
  const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null);
  const requestTreeReveal = useCodeViewFileReveal(viewer, scopeKey);
  const answeredReveal = useRef<number | null>(null);

  const loadDiffFiles = createPullRequestDiffFileContentsLoader(getDiffFileContents, {
    environmentId,
    reference,
    commit,
    cacheKey: `pull-request:${referenceKey}:${detail.updatedAt}:${commit ?? "all"}`,
  });
  const hostReview = detail.capabilities.review;
  const review = {
    inlineComment: hostReview.inlineComment && detail.viewerPermissions.comment,
    reply: hostReview.reply && detail.viewerPermissions.comment,
    resolve: hostReview.resolve && detail.viewerPermissions.resolve,
  };
  const canCommentOnLines = review.inlineComment && commit === null;
  // The cache key carries the theme, which is what the tokenizer caches against, so a theme
  // change is still a fresh parse. The patch's own hash is part of it too: a refreshed page
  // reuses its cursor, and a key of position alone would hand back the parse it replaced.
  const parsedSlices = loadedSlices.map((slice) =>
    parseSlice(
      slice,
      `pull-request:${scopeKey}:${resolvedTheme}:${ignoreWhitespace}:${slice.cursor ?? "first"}:${fnv1a32(slice.patch)}`,
      ignoreWhitespace,
    ),
  );
  const files = parsedSlices.flatMap((parsed) =>
    parsed?.kind === "files" ? orderDiffFiles(parsed.files) : [],
  );
  const filePaths = files.map((file) => resolveFileDiffPath(file));
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
  const fileTreeEntries = diffFileTreeEntries(files);
  // Placing a conversation takes more than its file being in the diff: its line has to fall
  // inside a hunk that was rendered. One that does not is drawn nowhere, so it belongs in the
  // off-diff list rather than disappearing between the two.
  const placedThreadIds = (() => {
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
  })();

  const annotatedFiles = files.map((fileDiff) => {
    const fileKey = buildFileDiffRenderKey(fileDiff);
    const path = resolveFileDiffPath(fileDiff);
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

  const nextCursor = loadedSlices.at(-1)?.nextCursor ?? null;
  const withheldContent =
    loadedSlices.some((slice) => slice.truncated) ||
    parsedSlices.some((parsed) => parsed?.kind === "raw");
  // Only once the diff is whole: returning here while a cursor is outstanding would take the
  // sentinel off screen and end the walk, leaving the rest of the change unasked for.
  const rawSlices =
    nextCursor === null
      ? parsedSlices.flatMap((parsed) => (parsed?.kind === "raw" ? [parsed] : []))
      : [];
  const rawSlicesView =
    files.length === 0 && rawSlices.length > 0 ? (
      <div className="space-y-4 px-4 py-5">
        {rawSlices.map((slice) => (
          <div key={`${slice.reason}:${slice.text.slice(0, 64)}`} className="space-y-2">
            <p className="text-xs text-muted-foreground">{slice.reason}</p>
            <pre className="whitespace-pre-wrap break-words font-mono text-xs">{slice.text}</pre>
          </div>
        ))}
      </div>
    ) : null;
  const unstructured =
    rawSlices.length === 0 ? null : (
      <div className="space-y-4 border-t border-border/60 px-4 py-5">
        {rawSlices.map((slice) => (
          <div key={`${slice.reason}:${slice.text.slice(0, 64)}`} className="space-y-2">
            <p className="text-xs text-muted-foreground">{slice.reason}</p>
            <pre className="whitespace-pre-wrap break-words font-mono text-xs">{slice.text}</pre>
          </div>
        ))}
      </div>
    );

  const items: CodeViewDiffItem<ReviewAnnotationGroup>[] = annotatedFiles.map(
    ({ fileKey, path, fileDiff, annotations, annotationsVersion }) => {
      const collapsed = isFileDiffCollapsed(fileKey, effectiveFoldOverride, toggledFiles);
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
  );
  const fileKeys = items.map((item) => item.id);
  const collapsedFileKeys = new Set(
    items.filter((item) => item.collapsed === true).map((item) => item.id),
  );
  const allFilesCollapsed = areAllDiffFilesCollapsed(fileKeys, collapsedFileKeys);

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

  const toggleFile = (fileKey: string) =>
    setToggledFiles((current) => {
      const next = new Set(current);
      if (next.has(fileKey)) next.delete(fileKey);
      else next.add(fileKey);
      return next;
    });

  const setFileViewed = (fileKey: string, path: string, viewed: boolean) => {
    setViewed(path, viewed);
    setToggledFiles((current) =>
      toggleFileDiffFoldForViewed(fileKey, viewed, effectiveFoldOverride, current),
    );
  };
  const fileViewedToggle = {
    enabled: filesViewedEnabled,
    isViewed: isFileViewed,
    isStale: isFileViewedStale,
    setFileViewed,
  };

  const revealFile = (path: string) => {
    const item = items.find((candidate) => resolveFileDiffPath(candidate.fileDiff) === path);
    if (item === undefined) return;
    if (item.collapsed === true) toggleFile(item.id);
    requestTreeReveal(item.id);
  };

  const toggleAllFiles = () => {
    setFoldOverride(areAllDiffFilesCollapsed(fileKeys, collapsedFileKeys) ? "expanded" : "folded");
    setToggledFiles(new Set());
  };

  const orderedCommits = // By instant, not by the text: GitLab keeps a commit's own UTC offset, so two commits
    // from different zones would sort by how they were written rather than when they landed.
    detail.commits.toSorted(
      (left, right) => Date.parse(right.committedDate) - Date.parse(left.committedDate),
    );

  const beginComment = (
    range: SelectedLineRange | null,
    context: { item: CodeViewItem<ReviewAnnotationGroup> },
  ) => {
    if (!range || !canCommentOnLines) return;
    const item = context.item;
    if (item.type !== "diff") return;
    const file = files.find((candidate) => buildFileDiffRenderKey(candidate) === item.id);
    if (!file) return;
    // A range collapses to its last line: only GitHub carries a multi-line comment, and one
    // that silently lost its first line on the other hosts would be worse than one line.
    const path = resolveFileDiffPath(file);
    const previousPath = resolveFileDiffPreviousPath(file);
    const sourceFile = parsedSlices
      .flatMap((slice) => (slice?.kind === "files" ? slice.sourceFiles : []))
      .find((candidate) => resolveFileDiffPath(candidate) === path);
    const side = range.endSide ?? range.side;
    const position =
      (sourceFile && resolveDiffReviewPosition(sourceFile, range.end, side)) ??
      resolveDiffReviewPosition(file, range.end, side);
    if (position === null) return;
    setDraft({
      fileKey: item.id,
      path,
      oldPath: previousPath === path ? null : previousPath,
      position,
      range,
    });
  };

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
  const renderCodeViewFooter = () =>
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
    );

  const renderHeaderPrefix = (item: CodeViewItem<ReviewAnnotationGroup>) => {
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
            className="font-mono text-2xs"
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

  const renderThreadCard = (thread: PullRequestReviewThread) => (
    <ReviewThreadCard
      // Named with the pull request too: a thread's id is the host's own, and two pull requests
      // can hand out the same one — which would leave one card's open editor standing over the
      // other's conversation.
      key={`${reference.projectId}#${reference.number}:${thread.id}`}
      thread={thread}
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
        void runThreadCommand("The conversation could not be updated", () =>
          setThreadResolution({
            environmentId,
            input: { ...reference, threadId: thread.id, resolved: !thread.isResolved },
          }),
        )
      }
      onReacted={onRefresh}
    />
  );

  const renderAnnotation = (annotation: ReviewAnnotation) => (
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
  );

  // A rebase or a force-push can take the scoped commit out of the change. Its diff may still
  // be reachable on the host, but it is no longer part of what is being reviewed, so the scope
  // goes back to the whole change rather than sitting under a name nothing matches.
  // Including when the change reports no commits at all: the scope dropdown is the only way back
  // to the whole diff and it is not drawn without commits to list, so a scope that outlived them
  // would leave the tab reading one obsolete commit with nothing to press.
  const selectedCommit = orderedCommits.find((entry) => entry.oid === commit);
  const scopeLabel = selectedCommit ? selectedCommit.messageHeadline : "All commits";
  const changeIgnoreWhitespace = (next: boolean) => {
    setIgnoreWhitespace(next);
    setDraft(null);
    setSelectedLines(null);
  };
  const toolbar = (
    <div className="@container flex h-10 min-h-10 shrink-0 items-center justify-between gap-2 border-b border-border/60 bg-background px-4 text-xs text-muted-foreground">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {orderedCommits.length > 0 ? (
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
              <DropdownMenuRadioGroup
                value={commit ?? "all"}
                onValueChange={(value) => onSelectedCommitChange(value === "all" ? null : value)}
              >
                <DropdownMenuRadioItem value="all" closeOnClick>
                  <span>All commits</span>
                </DropdownMenuRadioItem>
                {orderedCommits.slice(0, visibleCommitCount).map((entry) => (
                  <DropdownMenuRadioItem key={entry.oid} value={entry.oid} closeOnClick>
                    <span className="flex items-center gap-2">
                      <Tooltip>
                        <TooltipTrigger
                          render={<span className="min-w-0 truncate">{entry.messageHeadline}</span>}
                        />
                        <TooltipPopup side="top">{entry.messageHeadline}</TooltipPopup>
                      </Tooltip>
                      <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">
                        {entry.oid.slice(0, 7)}
                      </span>
                    </span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              {orderedCommits.length > visibleCommitCount ? (
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
        <PullRequestMetaLine>
          <span className="shrink-0 tabular-nums">
            {files.length} {files.length === 1 ? "file" : "files"}
            {nextCursor === null ? "" : "+"}
          </span>
          {filesViewed.enabled && files.length > 0 ? (
            <span className="flex min-w-0 items-center gap-1 tabular-nums">
              <span className="shrink-0">
                {filePaths.filter(isFileViewed).length} / {files.length}
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
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger
              render={
                <DropdownMenuTrigger
                  render={<Button size="icon-sm" variant="ghost" />}
                  className="@lg:hidden"
                  aria-label="Diff options"
                />
              }
            >
              <Settings2Icon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="top">Diff options</TooltipPopup>
          </Tooltip>
          <DropdownMenuContent align="end">
            <DropdownMenuCheckboxItem
              checked={ignoreWhitespace}
              onCheckedChange={(checked) => changeIgnoreWhitespace(checked)}
            >
              Hide whitespace changes
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={wordWrap}
              onCheckedChange={(checked) => setWordWrap(checked)}
            >
              Wrap lines
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup
              value={diffLayout}
              onValueChange={(value) => {
                if (value === "stacked" || value === "split") {
                  updateClientSettings({ diffLayout: value });
                }
              }}
            >
              <DropdownMenuRadioItem value="stacked" closeOnClick>
                Stacked
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="split" closeOnClick>
                Split
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="hidden items-center gap-1 @lg:flex">
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  aria-label={
                    ignoreWhitespace ? "Show whitespace changes" : "Hide whitespace changes"
                  }
                  variant="ghost"
                  size="sm"
                  pressed={ignoreWhitespace}
                  onPressedChange={(pressed) => changeIgnoreWhitespace(Boolean(pressed))}
                />
              }
            >
              <PilcrowIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {ignoreWhitespace ? "Show whitespace changes" : "Hide whitespace changes"}
            </TooltipPopup>
          </Tooltip>
          <ToggleGroup
            aria-label="Diff layout"
            className="shrink-0"
            variant="segmented"
            value={[diffLayout]}
            onValueChange={(value) => {
              const next = value[0];
              if (next === "stacked" || next === "split") {
                updateClientSettings({ diffLayout: next });
              }
            }}
          >
            <Toggle aria-label="Stacked diff view" value="stacked">
              <Rows3Icon className="size-3.5" />
            </Toggle>
            <Toggle aria-label="Split diff view" value="split">
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
        </div>
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
              <MorphIcon
                className="size-3.5"
                icon={allFilesCollapsed ? ChevronsUpDown : ChevronsDownUp}
              />
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
  // The effects sit after every derivation: a hook between the diff's derivations and their
  // later readers (the viewer options, the reveal handler) would leave them uncached.
  useEffect(() => {
    if (sentinel === null || !canLoadNextSlice) return;
    const observer = new IntersectionObserver(
      (observed) => {
        if (observed.some((entry) => entry.isIntersecting)) loadNextSlice();
      },
      { rootMargin: "240px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [canLoadNextSlice, loadNextSlice, sentinel]);
  const answerReveal = useEffectEvent(() => {
    if (revealRequest === null || answeredReveal.current === revealRequest.nonce) return;
    if (!items.some((item) => resolveFileDiffPath(item.fileDiff) === revealRequest.path)) {
      if (canLoadNextSlice) loadNextSlice();
      return;
    }
    answeredReveal.current = revealRequest.nonce;
    revealFile(revealRequest.path);
  });
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- A reveal for a file not loaded yet pages forward, which sets the slice cursor.
    answerReveal();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Re-checked as pages load until the requested file arrives.
  }, [canLoadNextSlice, items, revealRequest]);
  useEffect(() => {
    if (commit !== null && selectedCommit === undefined) {
      onSelectedCommitChange(null);
    }
  }, [commit, onSelectedCommitChange, selectedCommit]);
  const withToolbar = (body: ReactNode) => (
    <div className="flex h-full min-h-0 flex-col">
      {toolbar}
      <div ref={scrollerRef} className="min-h-0 flex-1 overflow-auto">
        {body}
      </div>
    </div>
  );

  if (diffQuery.isPending && loadedSlices.length === 0) {
    return withToolbar(<DiffPanelLoadingState label="Loading pull request diff..." />);
  }

  if (diffQuery.error && loadedSlices.length === 0) {
    return withToolbar(
      <p className="px-4 py-5 text-sm text-muted-foreground">{diffQuery.error}</p>,
    );
  }

  if (rawSlicesView !== null) {
    return withToolbar(rawSlicesView);
  }

  if (items.length === 0 && nextCursor === null) {
    return withToolbar(
      <p className="px-4 py-5 text-sm text-muted-foreground">
        {commit === null
          ? "This pull request has no file changes."
          : "This commit has no file changes."}
      </p>,
    );
  }

  const orphanThreads = detail.reviewThreads.filter((thread) => !placedThreadIds.has(thread.id));
  const orphanFiles = new Map<string, PullRequestReviewThread[]>();
  for (const thread of orphanThreads) {
    const existing = orphanFiles.get(thread.path);
    if (existing) existing.push(thread);
    else orphanFiles.set(thread.path, [thread]);
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {toolbar}
      {orphanFiles.size > 0 ? (
        <div className="shrink-0 border-b border-border/60">
          <Collapsible open={orphansOpen} onOpenChange={setOrphansOpen}>
            <h2>
              <CollapsibleTrigger className="flex w-full items-center gap-1.5 px-4 py-2 text-left text-xs text-muted-foreground">
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
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div
          className="relative min-h-0 min-w-0 flex-1"
          // The header lives in the viewer's shadow tree, so the capture listener walks
          // `composedPath` — the only way to see through the shadow boundary.
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
              className="@container h-full overflow-auto [scrollbar-gutter:stable]"
              containerRef={scrollerRef}
              viewerRef={setViewer}
              items={items}
              selectedLines={selectedLines}
              onSelectedLinesChange={setSelectedLines}
              options={diffViewOptions}
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
        {fileTreeOpen ? (
          <aside className="flex w-[min(20rem,40%)] min-w-48 shrink-0 border-l border-border/60">
            <DiffFileTree
              ariaLabel={`Pull request #${detail.number} files`}
              entries={fileTreeEntries}
              onSelectFile={revealFile}
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
