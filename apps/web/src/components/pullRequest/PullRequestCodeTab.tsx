import {
  EMPTY_PULL_REQUEST_DIFF_FOLDS,
  foldAllPullRequestDiffs,
  isFileDiffCollapsed,
  withFileDiffFold,
  withPullRequestDiffFold,
  type FileDiffFoldChoices,
} from "@t3tools/client-runtime/pull-request-diff-fold";
import {
  parsePullRequestAnchor,
  pullRequestDiffPathMatches,
  pullRequestLinkCommit,
  resolvePullRequestAnchorRange,
} from "@t3tools/shared/pullRequestAnchor";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import type {
  CodeViewItem,
  DiffLineAnnotation,
  FileDiffMetadata,
  SelectedLineRange,
} from "@pierre/diffs";
import type { CodeViewAnnotationArgs, CodeViewDiffItem } from "@pierre/diffs/react";
import type {
  EnvironmentId,
  PullRequestDetailView,
  PullRequestDiffSide,
  PullRequestDiffResult,
  PullRequestOmittedFileStat,
  PullRequestRef,
  PullRequestReviewPosition,
  PullRequestReviewThread,
  PullRequestThreadCommentsResult,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { SOURCE_CONTROL_MEDIA_ASSET } from "@t3tools/contracts";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  Columns2Icon,
  FlaskConicalOffIcon,
  FolderTreeIcon,
  InfoIcon,
  MessageSquareOffIcon,
  PilcrowIcon,
  Rows3Icon,
  Settings2Icon,
  TextWrapIcon,
  TriangleAlertIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
} from "lucide-react";
import { RegistryContext, useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Schema from "effect/Schema";
import {
  createContext,
  use,
  useContext,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { msg, T, useGT, useMessages, Var } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

import { observeIntersection } from "~/lib/observeIntersection";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useClientSettings, updateClientSettings } from "~/hooks/useSettings";
import { useRenderedAppearance } from "~/hooks/useTheme";
import { areAllDiffFilesCollapsed } from "~/lib/diffCollapse";
import {
  pullRequestFindingKey,
  type PullRequestChatSubject,
  type PullRequestFinding,
} from "./pullRequestDetail.logic";
import {
  canEditPullRequestComment,
  canResolvePullRequestThread,
} from "@t3tools/client-runtime/pull-request-editing";
import { fileDiffRows } from "@t3tools/client-runtime/review-guide-tour";
import { isTestChangedFile } from "@t3tools/shared/changedFileKind";
import { orderDiffFilesForReview } from "@t3tools/client-runtime/diff-file-order";
import { isWorkspaceImagePreviewPath } from "@t3tools/shared/mediaPreview";
import {
  buildFileDiffContentVersion,
  buildFileDiffIdentityKey,
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
  diffReviewSelectionId,
  resolveDiffReviewAnchor,
  type ReviewCommentContext,
} from "~/reviewCommentContext";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import { ChatMarkdownAssetImage } from "../chat/ChatMarkdownMedia";
import { DiffPanelLoadingState } from "../DiffPanelShell";
import { useDiffWorkerPool, useDiffWorkerPoolReady } from "../DiffWorkerPoolProvider";
import { DiffCommentAnnotation } from "../diffs/DiffCommentAnnotation";
import { DiffFileTree } from "../diffs/DiffFileTree";
import { FileExplorerPane } from "../files/FileExplorerPane";
import { useCodeViewFileReveal } from "../diffs/useCodeViewFileReveal";
import { useHideTestFiles } from "../diffs/useHideTestFiles";
import { diffFileTreeEntries } from "../diffs/diffFileTree.logic";
import { StyledDiffCodeView } from "../diffs/StyledDiffCodeView";
import { Button, InlineButton } from "../ui/button";
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
import {
  getReviewPositionAnchor,
  InlineReviewThreads,
  PendingReviewCommentCard,
  ReviewThreadCard,
  toViewerSide,
} from "./PullRequestReviewAnnotation";
import { pullRequestCompletionScope } from "./PullRequestMarkdownTextarea";
import { getFileViewedRange, isGitLfsPointerDiff, isLineInFileDiff } from "./pullRequestDiff.logic";
import { PullRequestDiffStat, PullRequestMetaLine } from "./pullRequestPresentation";
import { PullRequestDiffUnavailableState } from "./PullRequestDiffUnavailableState";
import { usePullRequestFilesViewed } from "./usePullRequestFilesViewed";
import { hasCutLines } from "@t3tools/shared/diffCutLines";
import { CUT_LINES_CSS, markCutLineNotes } from "./cutLineNotes";
import {
  nextPendingReviewCommentId,
  pullRequestReviewKey,
  usePendingReviewComments,
  usePullRequestReviewStore,
  type PendingReviewComment,
} from "./pullRequestReviewStore";

import { changeRequestTermKind } from "./changeRequestTerm";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";

interface ReviewAnnotationGroup {
  readonly threads: ReadonlyArray<PullRequestReviewThread>;
  readonly pending: ReadonlyArray<PendingReviewComment>;
  readonly draft: boolean;
  readonly image?: { readonly url: string; readonly path: string };
  readonly withheld?: { readonly path: string; readonly status: WithheldFileStatus };
}

type WithheldFileStatus = "idle" | "loading" | "error" | "empty";

type PullRequestDiffTarget = Parameters<typeof pullRequestEnvironment.diff>[0];

// One read per withheld file the reader asked for, so only that file's diff crosses the wire.
const withheldFileDiffsAtom = Atom.family((key: string) => {
  const { environmentId, input, paths } = JSON.parse(key) as {
    readonly environmentId: PullRequestDiffTarget["environmentId"];
    readonly input: PullRequestDiffTarget["input"];
    readonly paths: ReadonlyArray<string>;
  };
  return Atom.make((get) =>
    paths.map((path) =>
      get(pullRequestEnvironment.diff({ environmentId, input: { ...input, path } })),
    ),
  ).pipe(Atom.withLabel(`pull-request-withheld-file-diffs:${key}`));
});

const NO_PATHS: ReadonlyArray<string> = [];

type ReviewAnnotation = DiffLineAnnotation<ReviewAnnotationGroup>;

const COMMIT_PAGE_SIZE = 10;

const PULL_REQUEST_FILE_TREE_STORAGE_KEY = "t3code.pullRequestFileTreeOpen";

interface DiffSlice {
  readonly source: PullRequestDiffResult;
  readonly cursor: string | null;
  readonly patch: string;
  readonly truncated: boolean;
  readonly nextCursor: string | null;
  readonly omittedFileStats: ReadonlyArray<PullRequestOmittedFileStat>;
}

// Show host counts outside the shadow root; hunk totals are zero when hosts withhold hunks.
const REPLACE_FILE_COUNTS_CSS = `
[data-diffs-header] [data-additions-count],
[data-diffs-header] [data-deletions-count] {
  display: none !important;
}`;

const NO_SLICES: ReadonlyArray<DiffSlice> = [];

// Query results outlive the panel's slices, so their parses survive closing and reopening
// without retaining anything beyond the query cache's lifetime.
const sliceParses = new WeakMap<PullRequestDiffResult, Map<string, RenderablePatch | null>>();
// Cached parses keep a raw patch's reason untranslated; the view resolves it in the UI language.
const keepMessage = ((message: string) => message) as MessageResolver;

function parseSlice(slice: DiffSlice, cacheKey: string, ignoreWhitespace: boolean) {
  let parses = sliceParses.get(slice.source);
  if (parses === undefined) {
    parses = new Map();
    sliceParses.set(slice.source, parses);
  }
  if (parses.has(cacheKey)) return parses.get(cacheKey) ?? null;
  const parsed = getRenderablePatch(
    slice.patch,
    cacheKey,
    { compactPartialHunkOffsets: true, ignoreWhitespace },
    keepMessage,
  );
  parses.set(cacheKey, parsed);
  return parsed;
}

type DiffModel = {
  readonly parsedSlices: ReadonlyArray<RenderablePatch | null>;
  readonly loadedFiles: ReadonlyArray<Extract<RenderablePatch, { kind: "files" }>["files"][number]>;
  readonly sourceFileStats: ReadonlyMap<string, ReturnType<typeof getDiffLineStat>>;
};
const diffModels = new WeakMap<ReadonlyArray<DiffSlice>, Map<string, DiffModel>>();
const patchHashes = new WeakMap<DiffSlice, number>();

// Hashing, ordering and counting every file of a huge pull request costs a second, and the tab
// renders far more often than its slices change, so the model is kept per slice list.
function diffModel(
  slices: ReadonlyArray<DiffSlice>,
  keyPrefix: string,
  ignoreWhitespace: boolean,
): DiffModel {
  let models = diffModels.get(slices);
  if (models === undefined) diffModels.set(slices, (models = new Map()));
  const cached = models.get(keyPrefix);
  if (cached !== undefined) return cached;
  const parsedSlices = slices.map((slice) => {
    let hash = patchHashes.get(slice);
    if (hash === undefined) patchHashes.set(slice, (hash = fnv1a32(slice.patch)));
    // The cache key carries the theme, which the tokenizer caches against, and the patch's
    // hash: a refreshed page reuses its cursor, so position alone would return a stale parse.
    return parseSlice(slice, `${keyPrefix}:${slice.cursor ?? "first"}:${hash}`, ignoreWhitespace);
  });
  const model: DiffModel = {
    parsedSlices,
    loadedFiles: orderDiffFilesForReview(
      parsedSlices.flatMap((parsed) => (parsed?.kind === "files" ? parsed.files : [])),
      resolveFileDiffPath,
    ),
    sourceFileStats: new Map(
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
    ),
  };
  models.set(keyPrefix, model);
  return model;
}

const threadsByPathCache = new WeakMap<
  ReadonlyArray<PullRequestReviewThread>,
  ReadonlyMap<string, ReadonlyArray<PullRequestReviewThread>>
>();

function reviewThreadsByPath(threads: ReadonlyArray<PullRequestReviewThread>) {
  let byPath = threadsByPathCache.get(threads);
  if (byPath === undefined) {
    const grouped = new Map<string, PullRequestReviewThread[]>();
    for (const thread of threads) {
      const list = grouped.get(thread.path);
      if (list) list.push(thread);
      else grouped.set(thread.path, [thread]);
    }
    threadsByPathCache.set(threads, (byPath = grouped));
  }
  return byPath;
}

interface FileViewedToggleState {
  readonly enabled: boolean;
  readonly isViewed: (path: string) => boolean;
  readonly isStale: (path: string) => boolean;
  readonly setFileViewed: (fileKey: string, viewed: boolean, extendRange: boolean) => void;
}

// Context updates viewed toggles without invalidating memoized header portals.
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
  const gt = useGT();
  const viewedFiles = use(FileViewedToggleContext);
  if (viewedFiles === null || !viewedFiles.enabled) return stat;
  const viewed = viewedFiles.isViewed(path);
  const stale = viewedFiles.isStale(path);
  return (
    <span className="flex items-center gap-3">
      {stat}
      <label
        data-viewed-toggle=""
        className="flex h-8 w-18 shrink-0 cursor-pointer select-none items-center gap-1.5 text-2xs text-muted-foreground"
        onClick={(event) => event.stopPropagation()}
      >
        <Checkbox
          aria-label={
            stale
              ? gt("Changed", { $context: "file changed since viewed" })
              : gt("Viewed", { $context: "file marked as viewed" })
          }
          checked={viewed}
          onCheckedChange={(next, details) =>
            viewedFiles.setFileViewed(
              fileKey,
              next === true,
              "shiftKey" in details.event && details.event.shiftKey === true,
            )
          }
        />
        {stale ? (
          <SharedTooltipTrigger
            render={<span className="text-warning-foreground" />}
            label={
              <>
                <T>This file has been pushed to since you marked it viewed.</T>
              </>
            }
            side="bottom"
          >
            <T context="file changed since viewed">Changed</T>
          </SharedTooltipTrigger>
        ) : (
          <span className="@max-xs:hidden">
            <T context="file marked as viewed">Viewed</T>
          </span>
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
  // A refresh re-keys every file's render key, so the draft finds its file by identity and content.
  readonly identityKey: string;
  readonly fileVersion: number;
  readonly path: string;
  readonly oldPath: string | null;
  readonly position: PullRequestReviewPosition;
  readonly startPosition?: PullRequestReviewPosition;
  readonly range: SelectedLineRange;
}

// The viewer remounts a file's annotations when a refresh re-keys it, so draft text lives outside.
const draftCommentTexts = new WeakMap<DraftAnchor, string>();

function PullRequestDraftCommentAnnotation({
  draft,
  ...props
}: Omit<ComponentProps<typeof DiffCommentAnnotation>, "text" | "onTextChange"> & {
  readonly draft: DraftAnchor;
}) {
  const [text, setText] = useState(() => draftCommentTexts.get(draft) ?? "");
  return (
    <DiffCommentAnnotation
      {...props}
      text={text}
      onTextChange={(next) => {
        setText(next);
        draftCommentTexts.set(draft, next);
      }}
    />
  );
}

export interface PullRequestAgentSelectionInput {
  readonly comment: ReviewCommentContext;
  readonly request: string;
}

// A test's fold belongs to the file even when filtering or a refresh replaces its viewer item.
function buildFileDiffFoldKey(fileDiff: FileDiffMetadata): string {
  return isTestChangedFile(resolveFileDiffPath(fileDiff))
    ? buildFileDiffIdentityKey(fileDiff)
    : buildFileDiffRenderKey(fileDiff);
}

function isRemovedLine(fileDiff: FileDiffMetadata, oldLine: number): boolean {
  return fileDiff.hunks.some((hunk) => {
    let next = hunk.deletionStart;
    return hunk.hunkContent.some((content) => {
      const count = content.type === "context" ? content.lines : content.deletions;
      const removed = content.type === "change" && oldLine >= next && oldLine < next + count;
      next += count;
      return removed;
    });
  });
}

function PullRequestCodeTab({
  scrollerRef,
  environmentId,
  threadRef = null,
  reference,
  detail,
  selectedCommitOid,
  onSelectedCommitChange,
  pendingFinding,
  fixFindingLabel: requestedFixFindingLabel,
  onFixFinding,
  onAddToChat,
  onAddToAgentSelection,
  onRefresh,
  refreshToken = 0,
  backgroundRefreshToken = 0,
  revealRequest = null,
  revealUrl,
  onRevealSettled,
}: {
  scrollerRef: (node: HTMLDivElement | null) => void;
  environmentId: EnvironmentId;
  threadRef?: ScopedThreadRef | null;
  reference: PullRequestRef;
  detail: PullRequestDetailView;
  selectedCommitOid: string | null;
  onSelectedCommitChange: (oid: string | null) => void;
  pendingFinding?: string | null;
  fixFindingLabel?: string;
  onFixFinding?: (finding: PullRequestFinding) => void;
  /** Absent where there is no composer beside the panel to add a conversation to. */
  onAddToChat?: (subject: PullRequestChatSubject) => void;
  onAddToAgentSelection?: (input: PullRequestAgentSelectionInput) => void;
  onRefresh: () => void;
  refreshToken?: number;
  backgroundRefreshToken?: number;
  /** A clicked link to a file or line range, until onRevealSettled reports it shown. */
  revealUrl?: string | undefined;
  onRevealSettled?: ((revealUrl: string) => void) | undefined;
  revealRequest?: { readonly path: string; readonly nonce: number } | null;
}) {
  const gt = useGT();
  const messages = useMessages();
  const fixFindingLabel = requestedFixFindingLabel ?? gt("Fix in a thread");
  const resolvedTheme = useRenderedAppearance();
  // Initialize the shared tokenizer and workers while the diff request is still pending.
  const workerPoolReady = useDiffWorkerPoolReady(useDiffWorkerPool());
  const settings = useClientSettings((settings) => ({
    diffFilesCollapsed: settings.diffFilesCollapsed,
    diffIgnoreWhitespace: settings.diffIgnoreWhitespace,
    diffLayout: settings.diffLayout,
    wordWrap: settings.wordWrap,
  }));
  const [folds, setFolds] = useState(EMPTY_PULL_REQUEST_DIFF_FOLDS);
  const foldGroup = (path: string) => {
    const group = isTestChangedFile(path) ? folds.test : folds.source;
    return group.override === null && settings.diffFilesCollapsed
      ? { ...group, override: "folded" as const }
      : group;
  };
  const setFoldChoices = (
    path: string,
    update: (choices: FileDiffFoldChoices) => FileDiffFoldChoices,
  ) => setFolds((current) => withPullRequestDiffFold(current, isTestChangedFile(path), update));
  const [lastViewedFileKey, setLastViewedFileKey] = useState<string | null>(null);
  const [visibleCommitCount, setVisibleCommitCount] = useState(COMMIT_PAGE_SIZE);
  const diffLayout = settings.diffLayout;
  const [wordWrapOverride, setWordWrapOverride] = useState<boolean | null>(null);
  const wordWrap = wordWrapOverride ?? settings.wordWrap;
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(settings.diffIgnoreWhitespace);
  const [fileTreeOpen, setFileTreeOpen] = useLocalStorage(
    PULL_REQUEST_FILE_TREE_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const [hideTestFiles, setHideTestFiles] = useHideTestFiles();
  const [selectedLines, setSelectedLines] = useState<{
    id: string;
    range: SelectedLineRange;
  } | null>(null);
  const [draft, setDraft] = useState<DraftAnchor | null>(null);
  const [threadPending, setThreadPending] = useState(false);
  const [orphansOpen, setOrphansOpen] = useState(false);
  // Scope slices before reset to prevent using a previous pull request's data or cursor.
  const [sliceState, setSliceState] = useState<{
    readonly key: string;
    readonly cursor: string | null;
    readonly slices: ReadonlyArray<DiffSlice>;
  }>({ key: "", cursor: null, slices: NO_SLICES });

  const referenceKey = pullRequestReviewKey(reference);
  // A commit opened from the timeline or left selected across a force-push may no longer be
  // part of the pull request; read it as "All commits" instead of requesting its diff.
  const selectedCommit = detail.commits.find((entry) => entry.oid === selectedCommitOid);
  const commit = selectedCommit?.oid ?? null;
  const scopeKey = JSON.stringify([environmentId, referenceKey, commit]);
  // The panel keeps this mounted across pull requests, so an open composer would otherwise
  // survive the switch and attach its comment to whichever one is on screen when it is sent.
  const [stateScopeKey, setStateScopeKey] = useState(scopeKey);
  if (stateScopeKey !== scopeKey) {
    setStateScopeKey(scopeKey);
    setLastViewedFileKey(null);
    setDraft(null);
    setSelectedLines(null);
    setFolds(EMPTY_PULL_REQUEST_DIFF_FOLDS);
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
    messages,
  );
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
        source: data,
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
        existing.source.withheldFilesReadable === next.source.withheldFilesReadable &&
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
      // Drop later slices when replacing a changed page; their cursors target the old diff.
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
  const [withheldLoads, setWithheldLoads] = useState<{
    readonly scope: string;
    readonly paths: ReadonlyArray<string>;
    /** The render key each loaded file was last shown under; a changed patch gets a new one. */
    readonly shownKeys: ReadonlyMap<string, string>;
  }>({ scope: "", paths: NO_PATHS, shownKeys: new Map() });
  const withheldPaths = withheldLoads.scope === scopeKey ? withheldLoads.paths : NO_PATHS;
  const withheldInput = { ...reference, ...(commit === null ? {} : { commit }) };
  const atomRegistry = useContext(RegistryContext);
  const withheldFileDiff = (path: string) =>
    pullRequestEnvironment.diff({ environmentId, input: { ...withheldInput, path } });
  const refreshWithheldFiles = useEffectEvent(() => {
    for (const path of withheldPaths) atomRegistry.refresh(withheldFileDiff(path));
  });
  const appliedRefreshToken = useRef(refreshToken);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a new refresh token clears loaded slices and refetches the first diff page and viewed files
  useEffect(() => {
    if (appliedRefreshToken.current === refreshToken) return;
    appliedRefreshToken.current = refreshToken;
    setSliceState({ key: scopeKey, cursor: null, slices: NO_SLICES });
    // An equal refetch keeps the answer's identity, so the emptied slices refill only if the
    // applied page is forgotten too.
    setAppliedPage(null);
    refreshFirstDiffPage();
    refreshWithheldFiles();
    refreshFilesViewed();
  }, [refreshToken, scopeKey, refreshFirstDiffPage, refreshFilesViewed]);
  const appliedBackgroundRefreshToken = useRef(backgroundRefreshToken);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a background refresh token refetches the first diff page and viewed files while keeping slices
  useEffect(() => {
    if (appliedBackgroundRefreshToken.current === backgroundRefreshToken) return;
    appliedBackgroundRefreshToken.current = backgroundRefreshToken;
    // Keeping slices mounted preserves scroll; the page merge invalidates changed pages.
    setSliceState((previous) => ({ ...previous, cursor: null }));
    refreshFirstDiffPage();
    refreshWithheldFiles();
    refreshFilesViewed();
  }, [backgroundRefreshToken, refreshFirstDiffPage, refreshFilesViewed]);

  const codeViewReveal = useCodeViewFileReveal();
  const answeredRevealNonce = useRef<number | null>(null);

  const loadDiffFiles = createPullRequestDiffFileContentsLoader(getDiffFileContents, {
    environmentId,
    reference,
    commit,
    cacheKey: `pull-request:${referenceKey}:${detail.updatedAt}:${commit ?? "all"}`,
  });
  const completionScope = pullRequestCompletionScope(detail, environmentId, reference);
  const hostReview = detail.capabilities.review;
  const review = {
    inlineComment: hostReview.inlineComment && detail.viewerPermissions.comment,
    reply: hostReview.reply && detail.viewerPermissions.comment,
    resolve: hostReview.resolve && detail.viewerPermissions.resolve,
  };
  const canCommentOnLines = review.inlineComment && commit === null;
  const rangeComments = hostReview.rangeComment === true;
  // Agent context is local, so it does not require host comment permission.
  const canSelectLines =
    commit === null && (review.inlineComment || onAddToAgentSelection !== undefined);
  const {
    parsedSlices,
    loadedFiles: pagedFiles,
    sourceFileStats,
  } = diffModel(loadedSlices, `pull-request:${scopeKey}:${ignoreWhitespace}`, ignoreWhitespace);
  const withheldResults = useAtomValue(
    withheldFileDiffsAtom(
      JSON.stringify({ environmentId, input: withheldInput, paths: withheldPaths }),
    ),
  );
  // A refetch keeps showing the last patch, whose lines may not exist at the new head.
  const withheldRefetching = withheldResults.some((result) => result.waiting);
  const withheldStatuses = new Map<string, WithheldFileStatus>();
  const withheldFiles = new Map<string, (typeof pagedFiles)[number]>();
  const cutFiles = new Set<unknown>();
  withheldPaths.forEach((path, index) => {
    const result = withheldResults[index];
    if (result === undefined) return;
    // A failed refresh still carries the earlier patch; show the failure instead of stale code.
    const data = result._tag === "Failure" ? null : AsyncResult.getOrElse(result, () => null);
    if (data === null) {
      withheldStatuses.set(path, result._tag === "Failure" ? "error" : "loading");
      return;
    }
    const parsed = parseSlice(
      {
        source: data,
        cursor: null,
        patch: data.patch,
        truncated: false,
        nextCursor: null,
        omittedFileStats: [],
      },
      `pull-request:${scopeKey}:withheld:${path}`,
      // Cut lines can match up to the cut and differ after it; hiding them would drop changes.
      false,
    );
    const file = parsed?.kind === "files" ? parsed.files[0] : undefined;
    if (file !== undefined && file.hunks.length > 0) {
      withheldFiles.set(path, file);
      if (hasCutLines(data.patch)) cutFiles.add(file);
    } else withheldStatuses.set(path, "empty");
  });
  // A withheld patch opens on first load and keeps its choice when its fold key changes.
  const rekeyed = [...withheldFiles].flatMap(([path, file]) => {
    const key = buildFileDiffFoldKey(file);
    return withheldLoads.shownKeys.get(path) === key ? [] : [[path, key] as const];
  });
  if (withheldLoads.scope === scopeKey && rekeyed.length > 0) {
    setWithheldLoads({
      ...withheldLoads,
      shownKeys: new Map([...withheldLoads.shownKeys, ...rekeyed]),
    });
    for (const [path, key] of rekeyed) {
      const shown = withheldLoads.shownKeys.get(path);
      setFoldChoices(path, (current) => {
        const collapsed = shown === undefined ? (current.get(key) ?? false) : current.get(shown);
        return collapsed === undefined ? current : withFileDiffFold(current, key, collapsed);
      });
    }
  }
  const loadedFiles =
    withheldFiles.size === 0
      ? pagedFiles
      : // A refreshed page may carry the file's patch itself now.
        pagedFiles.map((file) =>
          file.hunks.length === 0 ? (withheldFiles.get(resolveFileDiffPath(file)) ?? file) : file,
        );
  const loadWithheldFile = (path: string) => {
    // The read is keyed without the head, so even a first load must not reuse an older one.
    atomRegistry.refresh(withheldFileDiff(path));
    if (withheldPaths.includes(path)) return;
    setWithheldLoads({
      scope: scopeKey,
      paths: [...withheldPaths, path],
      shownKeys: withheldLoads.scope === scopeKey ? withheldLoads.shownKeys : new Map(),
    });
  };
  const linkAnchor = parsePullRequestAnchor(revealUrl);
  const linkFile =
    linkAnchor?.kind === "diff"
      ? loadedFiles.find((file) =>
          pullRequestDiffPathMatches(linkAnchor.digest, resolveFileDiffPath(file)),
        )
      : undefined;
  const pendingLinkPath = linkFile ? resolveFileDiffPath(linkFile) : null;
  // The linked file stays shown past the test-file filter after the link settles.
  const [revealedLink, setRevealedLink] = useState<{
    readonly scope: string;
    readonly path: string;
  } | null>(null);
  const linkPath = pendingLinkPath ?? (revealedLink?.scope === scopeKey ? revealedLink.path : null);
  const testFileCount = loadedFiles.filter((file) =>
    isTestChangedFile(resolveFileDiffPath(file)),
  ).length;
  // A requested file stays visible so a jump to a hidden test still lands.
  const files = hideTestFiles
    ? loadedFiles.filter((file) => {
        const path = resolveFileDiffPath(file);
        return path === revealRequest?.path || path === linkPath || !isTestChangedFile(path);
      })
    : loadedFiles;
  const hiddenTestFileCount = loadedFiles.length - files.length;
  const nextCursor = loadedSlices.at(-1)?.nextCursor ?? null;
  const draftFile =
    draft === null
      ? undefined
      : loadedFiles.find((file) => buildFileDiffIdentityKey(file) === draft.identityKey);
  const draftFileKey =
    draftFile !== undefined && buildFileDiffContentVersion(draftFile) === draft?.fileVersion
      ? buildFileDiffRenderKey(draftFile)
      : null;
  if (draft !== null && draftFileKey === null) {
    // Never attach the draft to lines of a changed file; one missing mid-refresh may come back.
    if (draftFile !== undefined || (loadedSlices.length > 0 && nextCursor === null)) {
      setDraft(null);
      setSelectedLines(null);
    }
  }
  const filePaths = files.map((file) => resolveFileDiffPath(file));
  const omittedFileStats = new Map(
    loadedSlices.flatMap((slice) =>
      slice.omittedFileStats.map((file) => [file.path, file] as const),
    ),
  );
  const fileTreeEntries = diffFileTreeEntries(files);
  const threadsByPath = reviewThreadsByPath(detail.reviewThreads);
  // File membership does not guarantee a rendered hunk for the thread.
  const placedThreadIds = (() => {
    const placed = new Set<string>();
    // Commit diffs use different line coordinates; list conversations separately.
    if (commit !== null) return placed;
    for (const file of files) {
      for (const thread of threadsByPath.get(resolveFileDiffPath(file)) ?? []) {
        if (thread.line !== null && isLineInFileDiff(file, thread.side, thread.line)) {
          placed.add(thread.id);
        }
      }
    }
    return placed;
  })();

  const imageRevision = commit ?? detail.headSha;
  const rawFileUrl = sourceControlClients.find(detail.provider)?.rawFileUrl;
  const repositoryUrl = sourceControlClients.parseChangeRequestUrl(detail.url)?.link.repositoryUrl;
  // Hosts send no patch for an image, or only its LFS pointer, so the row shows the file itself.
  const imagePreviewUrl = (fileDiff: FileDiffMetadata, path: string) =>
    (fileDiff.hunks.length === 0 || isGitLfsPointerDiff(fileDiff)) &&
    fileDiff.type !== "deleted" &&
    isWorkspaceImagePreviewPath(path) &&
    imageRevision !== undefined &&
    rawFileUrl !== undefined &&
    repositoryUrl !== undefined
      ? rawFileUrl({ repositoryUrl, sha: imageRevision, path })
      : null;

  const annotatedFiles = files.map((fileDiff) => {
    const fileKey = buildFileDiffRenderKey(fileDiff);
    const path = resolveFileDiffPath(fileDiff);
    const groups = new Map<string, MutableAnnotationGroup>();
    // Stacked view draws a context row once, so its old side shares the new side's annotation.
    const contextNewLines = new Map<number, number>();
    const groupAt = (anchorSide: PullRequestDiffSide, anchorLine: number) => {
      if (anchorSide === "left" && diffLayout !== "split" && contextNewLines.size === 0) {
        for (const row of fileDiffRows(fileDiff)) {
          if (row.oldLine !== null && row.newLine !== null) {
            contextNewLines.set(row.oldLine, row.newLine);
          }
        }
      }
      const contextLine = anchorSide === "left" ? contextNewLines.get(anchorLine) : undefined;
      const side = contextLine === undefined ? anchorSide : "right";
      const line = contextLine ?? anchorLine;
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

    for (const thread of threadsByPath.get(path) ?? []) {
      if (thread.line === null || !placedThreadIds.has(thread.id)) continue;
      groupAt(thread.side, thread.line).threads.push(thread);
    }
    if (commit === null) {
      for (const comment of pendingComments) {
        if (comment.path !== path) continue;
        const anchor = getReviewPositionAnchor(comment.position);
        groupAt(anchor.side, anchor.line).pending.push(comment);
      }
    }
    if (draft !== null && draftFileKey === fileKey) {
      const anchor = getReviewPositionAnchor(draft.position);
      groupAt(anchor.side, anchor.line).draft = true;
    }

    const annotations: ReviewAnnotation[] = [...groups.values()].map((group) => ({
      side: toViewerSide(group.side),
      lineNumber: group.line,
      metadata: { threads: group.threads, pending: group.pending, draft: group.draft },
    }));
    const imageUrl = imagePreviewUrl(fileDiff, path);
    if (imageUrl !== null) {
      annotations.push({
        side: "additions",
        lineNumber: 0,
        metadata: { threads: [], pending: [], draft: false, image: { url: imageUrl, path } },
      });
    } else if (fileDiff.hunks.length === 0 && omittedFileStats.has(path)) {
      annotations.push({
        side: "additions",
        lineNumber: 0,
        metadata: {
          threads: [],
          pending: [],
          draft: false,
          withheld: { path, status: withheldStatuses.get(path) ?? "idle" },
        },
      });
    }
    return {
      fileKey,
      foldKey: buildFileDiffFoldKey(fileDiff),
      path,
      fileDiff,
      annotations,
      // The viewer redraws annotations only when their version changes.
      annotationsVersion: fnv1a32(
        annotations
          .map(
            ({ side, lineNumber, metadata }) =>
              `${side}:${lineNumber}:${metadata.image?.url ?? ""}:${metadata.withheld?.status ?? ""}:${metadata.draft ? "d" : ""}:${metadata.pending
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

  const withheldFilesReadable = loadedSlices[0]?.source.withheldFilesReadable === true;
  const withheldContent =
    loadedSlices.some((slice) => slice.truncated) ||
    parsedSlices.some((parsed) => parsed?.kind === "raw");
  // Keep the sentinel until all pages load; returning raw slices early would stop pagination.
  const rawSlices =
    nextCursor === null
      ? parsedSlices.flatMap((parsed) => (parsed?.kind === "raw" ? [parsed] : []))
      : [];
  const rawSlicesView =
    files.length === 0 && rawSlices.length > 0 ? (
      <div className="space-y-4 px-4 py-5">
        {rawSlices.map((slice) => (
          <div key={`${slice.reason}:${slice.text.slice(0, 64)}`} className="space-y-2">
            <p className="text-xs text-muted-foreground">{messages(slice.reason)}</p>
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
            <p className="text-xs text-muted-foreground">{messages(slice.reason)}</p>
            <pre className="whitespace-pre-wrap break-words font-mono text-xs">{slice.text}</pre>
          </div>
        ))}
      </div>
    );

  const foldsAsViewed = (path: string) =>
    filesViewedEnabled && isFileViewed(path) && !isFileViewedStale(path);
  const items: CodeViewDiffItem<ReviewAnnotationGroup>[] = annotatedFiles.map(
    ({ fileKey, foldKey, path, fileDiff, annotations, annotationsVersion }) => {
      const group = foldGroup(path);
      const collapsed = isFileDiffCollapsed(
        foldKey,
        group.override,
        group.choices,
        foldsAsViewed(path),
      );
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

  // Do not re-arm the visible sentinel after failure; it would retry indefinitely.
  const canLoadNextSlice =
    nextCursor !== null &&
    nextCursor !== cursor &&
    !diffQuery.isPending &&
    diffQuery.error === null;
  const loadNextSlice = () => {
    if (nextCursor === null) return;
    setSliceState((previous) => ({ ...previous, cursor: nextCursor }));
  };
  const sentinelRef = (node: HTMLDivElement | null) => {
    if (node === null || !canLoadNextSlice) return;
    return observeIntersection(
      node,
      (entry) => {
        if (entry.isIntersecting) loadNextSlice();
      },
      { rootMargin: "240px" },
    );
  };

  const toggleFile = (fileKey: string) => {
    const file = annotatedFiles.find((file) => file.fileKey === fileKey);
    if (file === undefined) return;
    const { path, foldKey } = file;
    const { override } = foldGroup(path);
    const viewed = foldsAsViewed(path);
    setFoldChoices(path, (current) =>
      withFileDiffFold(current, foldKey, !isFileDiffCollapsed(foldKey, override, current, viewed)),
    );
  };

  const setFileViewed = (fileKey: string, viewed: boolean, extendRange: boolean) => {
    const range = getFileViewedRange(
      annotatedFiles,
      fileKey,
      extendRange ? lastViewedFileKey : null,
    );
    setLastViewedFileKey(fileKey);
    for (const file of range) {
      // A commit's diff names that commit's version of the file, not the head's.
      setViewed(file.path, viewed, commit === null ? file.fileDiff.newObjectId : undefined);
    }
    for (const file of range) {
      const collapsed = foldGroup(file.path).override === null ? undefined : viewed;
      setFoldChoices(file.path, (current) => withFileDiffFold(current, file.foldKey, collapsed));
    }
  };
  const fileViewedToggle = {
    enabled: filesViewedEnabled,
    isViewed: isFileViewed,
    isStale: isFileViewedStale,
    setFileViewed,
  };

  const revealFile = (path: string, range?: SelectedLineRange) => {
    const item = items.find((candidate) => resolveFileDiffPath(candidate.fileDiff) === path);
    if (item === undefined) return;
    // Record the unfold even when already open, so a Viewed mark that loads later cannot fold it.
    setFoldChoices(path, (current) =>
      withFileDiffFold(current, buildFileDiffFoldKey(item.fileDiff), false),
    );
    if (range) setSelectedLines({ id: item.id, range });
    codeViewReveal.request(item.id, range);
  };

  const toggleAllFiles = () => {
    const shownTestKeys = annotatedFiles.flatMap((file) =>
      isTestChangedFile(file.path) ? [file.foldKey] : [],
    );
    setFolds((current) =>
      foldAllPullRequestDiffs(
        current,
        allFilesCollapsed ? "expanded" : "folded",
        hideTestFiles ? { shownKeys: shownTestKeys } : null,
      ),
    );
  };

  const orderedCommits = // GitLab preserves UTC offsets, so compare instants.
    detail.commits.toSorted(
      (left, right) => Date.parse(right.committedDate) - Date.parse(left.committedDate),
    );

  const beginComment = (
    range: SelectedLineRange | null,
    context: { item: CodeViewItem<ReviewAnnotationGroup> },
  ) => {
    if (!range || !canSelectLines || withheldRefetching) return;
    const item = context.item;
    if (item.type !== "diff") return;
    const file = files.find((candidate) => buildFileDiffRenderKey(candidate) === item.id);
    if (!file) return;
    // On a host without ranged comments a range collapses to its last line: one that silently
    // lost its first line there would be worse than one line.
    const path = resolveFileDiffPath(file);
    const previousPath = resolveFileDiffPreviousPath(file);
    const sourceFile = parsedSlices
      .flatMap((slice) => (slice?.kind === "files" ? slice.sourceFiles : []))
      .find((candidate) => resolveFileDiffPath(candidate) === path);
    const anchor =
      (sourceFile && resolveDiffReviewAnchor(sourceFile, range, rangeComments)) ??
      resolveDiffReviewAnchor(file, range, rangeComments);
    if (anchor === null) return;
    setDraft({
      identityKey: buildFileDiffIdentityKey(file),
      fileVersion: buildFileDiffContentVersion(file),
      path,
      oldPath: previousPath === path ? null : previousPath,
      ...anchor,
      range,
    });
  };

  const finishSelection = (
    anchor: DraftAnchor,
    text: string,
    onFinish: (comment: ReviewCommentContext) => void,
  ) => {
    const comment =
      draftFile === undefined || draftFileKey === null
        ? null
        : buildDiffReviewComment({
            id: `pull-request-selection:${diffReviewSelectionId(draftFileKey, anchor.range)}`,
            sectionId: `pull-request:${detail.number}`,
            // oxlint-disable-next-line t3code/no-untranslated-copy -- context title sent to the agent
            sectionTitle: `PR #${detail.number} review`,
            filePath: anchor.path,
            fileDiff: draftFile,
            range: anchor.range,
            text,
          });
    setDraft(null);
    setSelectedLines(null);
    if (comment !== null) onFinish(comment);
  };

  // Stable props preserve viewer portals during selection, typing, and review updates.
  const renderCodeViewFooter = () =>
    nextCursor === null ? null : (
      <div
        ref={sentinelRef}
        className="flex items-center justify-center gap-2 py-2 text-xs text-muted-foreground"
      >
        {diffQuery.error !== null ? (
          <>
            <span>
              <T>The rest of this diff could not be loaded.</T>
            </span>
            <Button size="xs" variant="outline" onClick={() => diffQuery.refresh()}>
              <T>Retry</T>
            </Button>
          </>
        ) : diffQuery.isPending ? (
          gt("Loading more files...")
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
        aria-label={collapsed ? gt("Expand diff") : gt("Collapse diff")}
        className="mr-1"
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
    // Full contents would not match the cut lines, and would bring back the lines just cut.
    loadDiffFiles: (fileDiff: FileDiffMetadata) =>
      cutFiles.has(fileDiff)
        ? Promise.reject(
            new Error(m(msg("Unchanged lines are unavailable in a file with cut lines."))),
          )
        : loadDiffFiles(fileDiff),
    enableGutterUtility: canSelectLines && draft === null && !withheldRefetching,
    enableLineSelection: canSelectLines && draft === null && !withheldRefetching,
    onGutterUtilityClick: beginComment,
    onLineSelectionEnd: beginComment,
    onPostRender: (fileContainer: HTMLElement, instance: object) => {
      codeViewReveal.flush();
      // Containers are reused across files, so the flag is set or cleared on every render.
      fileContainer.toggleAttribute(
        "data-cut-lines",
        "fileDiff" in instance && cutFiles.has(instance.fileDiff),
      );
      if (withheldFiles.size > 0) markCutLineNotes(fileContainer);
    },
    onItemCollapsedChange: (
      _item: CodeViewItem<ReviewAnnotationGroup>,
      nextItem: CodeViewItem<ReviewAnnotationGroup>,
    ) => {
      if (nextItem.type !== "diff") return;
      setFoldChoices(resolveFileDiffPath(nextItem.fileDiff), (current) =>
        withFileDiffFold(
          current,
          buildFileDiffFoldKey(nextItem.fileDiff),
          nextItem.collapsed === true,
        ),
      );
    },
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

  const renderThreadCard = (thread: PullRequestReviewThread, hidden?: boolean) => (
    <ReviewThreadCard
      // Host thread ids can collide across pull requests.
      key={`${reference.projectId}#${reference.number}:${thread.id}`}
      thread={thread}
      workspaceRoot={detail.workspaceRoot}
      canReply={review.reply}
      canResolve={review.resolve && canResolvePullRequestThread(detail, thread)}
      canReact={detail.capabilities.reactions === true}
      environmentId={environmentId}
      reference={reference}
      completionScope={completionScope}
      pending={threadPending}
      fixPending={pendingFinding === pullRequestFindingKey({ kind: "thread", thread })}
      fixLabel={fixFindingLabel}
      {...(onFixFinding ? { onFix: () => onFixFinding({ kind: "thread", thread }) } : {})}
      {...(onAddToChat
        ? { onAddToChat: (loaded) => onAddToChat({ kind: "thread", thread: loaded }) }
        : {})}
      onLoadMore={async (cursor): Promise<PullRequestThreadCommentsResult | null> => {
        const result = await loadThreadComments({
          environmentId,
          input: { ...reference, threadId: thread.id, cursor },
        });
        if (result._tag === "Failure") {
          toastManager.add({
            type: "error",
            title: m(msg("More comments could not be loaded")),
          });
          return null;
        }
        return result.value;
      }}
      onReply={(body) =>
        runThreadCommand(m(msg("Reply could not be posted")), () =>
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
        runThreadCommand(m(msg("The comment could not be saved")), () =>
          updateComment({
            environmentId,
            input: { ...reference, commentId, kind: "review-comment", body },
          }),
        )
      }
      onToggleResolved={() =>
        void runThreadCommand(m(msg("The conversation could not be updated")), () =>
          setThreadResolution({
            environmentId,
            input: { ...reference, threadId: thread.id, resolved: !thread.isResolved },
          }),
        )
      }
      onReacted={onRefresh}
      {...(hidden === undefined ? {} : { hidden })}
    />
  );

  const renderAnnotation = (...[annotation]: CodeViewAnnotationArgs<ReviewAnnotationGroup>) => (
    // Folded resolved conversations alone add no row, so the code reads straight through.
    <div className="relative font-sans text-foreground has-[>:not([data-resolved-threads])]:py-1">
      {annotation.metadata.image ? (
        <div className="flex justify-center p-3">
          <ChatMarkdownAssetImage
            environmentId={environmentId}
            resource={{
              _tag: SOURCE_CONTROL_MEDIA_ASSET,
              cwd: detail.workspaceRoot,
              url: annotation.metadata.image.url,
              repository: detail.repository,
            }}
            alt={annotation.metadata.image.path}
          />
        </div>
      ) : null}
      {annotation.metadata.withheld ? (
        <WithheldFileNotice
          {...annotation.metadata.withheld}
          onLoad={withheldFilesReadable ? loadWithheldFile : undefined}
        />
      ) : null}
      <InlineReviewThreads threads={annotation.metadata.threads} renderThread={renderThreadCard} />
      {annotation.metadata.pending.map((comment) => (
        <PendingReviewCommentCard
          key={comment.id}
          comment={comment}
          onRemove={() => removeComment(reviewKey, comment.id)}
        />
      ))}
      {annotation.metadata.draft && draft && canSelectLines ? (
        <PullRequestDraftCommentAnnotation
          draft={draft}
          environmentId={environmentId}
          projectId={reference.projectId}
          ownerKey={JSON.stringify([environmentId, reviewKey, draft])}
          kind="draft"
          rangeLabel={`${draft.path}:${getReviewPositionAnchor(draft.position).line}`}
          completionScope={canCommentOnLines ? completionScope : null}
          submitLabel={canCommentOnLines ? gt("Add to review") : gt("Add to agent")}
          {...(canCommentOnLines && onAddToAgentSelection
            ? {
                secondaryAction: {
                  label: gt("Add to agent"),
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
            addComment(reviewKey, {
              id: nextPendingReviewCommentId(),
              path: draft.path,
              ...(draft.oldPath === null ? {} : { oldPath: draft.oldPath }),
              ...(draft.startPosition === undefined ? {} : { startPosition: draft.startPosition }),
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

  const scopeLabel = selectedCommit ? selectedCommit.messageHeadline : gt("All commits");
  const reportedFileCount = selectedCommit ? selectedCommit.changedFiles : detail.changedFiles;
  const scopeFileCount = hideTestFiles ? 0 : (reportedFileCount ?? 0);
  const fileCount = Math.max(scopeFileCount, files.length);
  const fileCountSuffix =
    nextCursor !== null && (scopeFileCount === 0 || scopeFileCount < fileCount) ? "+" : "";
  const usePullRequestViewedCount =
    viewedFilesStore === "host" &&
    commit === null &&
    !hideTestFiles &&
    filesViewed.viewedCount <= fileCount;
  const viewedCount = usePullRequestViewedCount
    ? filesViewed.viewedCount
    : filePaths.filter(isFileViewed).length;
  const viewedCountSuffix =
    !usePullRequestViewedCount &&
    (nextCursor !== null || files.length < fileCount) &&
    viewedCount < filesViewed.viewedCount
      ? "+"
      : "";
  const hiddenTestFilesLabel =
    hiddenTestFileCount > 0
      ? gt("{count, plural, one {{count} test file hidden} other {{count} test files hidden}}", {
          count: hiddenTestFileCount,
        })
      : null;
  const changeIgnoreWhitespace = (next: boolean) => {
    setIgnoreWhitespace(next);
    setDraft(null);
    setSelectedLines(null);
  };
  const toolbar = (
    <div className="@container flex h-10 min-h-10 shrink-0 items-center justify-between gap-2 border-b border-border/60 bg-background px-4 text-xs text-muted-foreground">
      <div className="flex min-w-0 flex-1 items-center gap-3 overflow-x-clip">
        {orderedCommits.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button size="xs" variant="secondary" />}
              className="min-w-0 max-w-64 shrink-[999]"
              aria-label={gt("Diff scope: {scope}", { scope: scopeLabel })}
            >
              <span className={cn("truncate", selectedCommit && "hidden @xl:inline")}>
                {scopeLabel}
              </span>
              {selectedCommit ? (
                <span className="truncate font-mono @xl:hidden">
                  {selectedCommit.oid.slice(0, 7)}
                </span>
              ) : null}
              <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-w-[min(28rem,calc(100vw-2rem))]">
              <DropdownMenuRadioGroup
                value={commit ?? "all"}
                onValueChange={(value) => onSelectedCommitChange(value === "all" ? null : value)}
              >
                <DropdownMenuRadioItem value="all" closeOnClick>
                  <span>
                    <T>All commits</T>
                  </span>
                </DropdownMenuRadioItem>
                {orderedCommits.slice(0, visibleCommitCount).map((entry) => (
                  <DropdownMenuRadioItem key={entry.oid} value={entry.oid} closeOnClick>
                    <span className="flex items-center gap-2">
                      <SharedTooltipTrigger
                        render={<span className="min-w-0 truncate">{entry.messageHeadline}</span>}
                        label={entry.messageHeadline}
                      />
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
                    {gt(
                      "{count, plural, one {Show more ({count} left)} other {Show more ({count} left)}}",
                      { count: orderedCommits.length - visibleCommitCount },
                    )}
                  </span>
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        <PullRequestMetaLine>
          <span className="flex shrink-0 items-center gap-1.5">
            <span className="tabular-nums">
              {gt("{count, plural, one {{count} file} other {{count} files}}", {
                count: fileCount,
              })}
              {fileCountSuffix}
            </span>
            {hiddenTestFilesLabel !== null && (files.length > 0 || nextCursor !== null) ? (
              <span className="hidden items-center gap-1.5 @2xl:flex">
                <span aria-hidden className="text-muted-foreground/50">
                  ·
                </span>
                <Button
                  type="button"
                  size="xs"
                  variant="link"
                  onClick={() => setHideTestFiles(false)}
                >
                  {hiddenTestFilesLabel}
                </Button>
              </span>
            ) : null}
          </span>
          {filesViewed.enabled && files.length > 0 ? (
            <span className="flex min-w-0 items-center gap-1 tabular-nums">
              <span className="shrink-0">
                {viewedCount}
                {viewedCountSuffix} / {fileCount}
                {fileCountSuffix}
              </span>
              <span className="truncate">
                {viewedFilesStore === "environment"
                  ? gt("viewed in {app}", { app: APP_BASE_NAME })
                  : gt("viewed", { $context: "files marked as viewed" })}
              </span>
              {viewedFilesStore === "environment" ? (
                <SharedTooltipTrigger
                  render={<span className="flex shrink-0 items-center" />}
                  label={
                    <>
                      <T>
                        This host keeps no shared record of which files you have read, so these
                        ticks are kept by this environment. They follow you between the apps
                        connected to it, but the host's own web UI will not show them.
                      </T>
                    </>
                  }
                  side="bottom"
                >
                  <InfoIcon
                    aria-label={gt("These ticks are kept here, not on the host")}
                    className="text-muted-foreground size-3.5"
                  />
                </SharedTooltipTrigger>
              ) : null}
              {filesViewed.error !== null ? (
                <SharedTooltipTrigger
                  render={<span className="flex shrink-0 items-center" />}
                  label={
                    <>
                      <T>
                        The boxes below are whatever was last read, and empty if nothing has been
                        read yet. <Var>{filesViewed.error}</Var>
                      </T>
                    </>
                  }
                  side="bottom"
                >
                  <TriangleAlertIcon
                    aria-label={gt("Your ticks could not be read")}
                    className="size-3.5 text-warning-foreground"
                  />
                </SharedTooltipTrigger>
              ) : null}
              {filesViewed.truncated ? (
                <SharedTooltipTrigger
                  render={<span className="flex shrink-0 items-center" />}
                  label={
                    <>
                      <T>
                        This change has more files than the host will report ticks for in one read,
                        so the count is short and some boxes below start empty.
                      </T>
                    </>
                  }
                  side="bottom"
                >
                  <TriangleAlertIcon
                    aria-label={gt("This count covers only part of the change")}
                    className="size-3.5 text-warning-foreground"
                  />
                </SharedTooltipTrigger>
              ) : null}
            </span>
          ) : null}
          {withheldContent ? (
            <SharedTooltipTrigger
              render={<span className="flex shrink-0 items-center" />}
              label={
                <>
                  <T>
                    The host withheld part of this diff: a binary file, or a change too large to
                    inline.
                  </T>
                </>
              }
              side="bottom"
            >
              <TriangleAlertIcon
                aria-label={gt("Some of this diff was not shown")}
                className="size-3.5 text-warning-foreground"
              />
            </SharedTooltipTrigger>
          ) : null}
          {commit !== null && review.inlineComment ? (
            <SharedTooltipTrigger
              render={<span className="flex shrink-0 items-center" />}
              label={
                <>
                  <T>
                    A comment is anchored to the whole change, so switch to All commits to write
                    one.
                  </T>
                </>
              }
              side="bottom"
            >
              <MessageSquareOffIcon
                aria-label={gt("Line comments are written from the whole change")}
                className="size-3.5"
              />
            </SharedTooltipTrigger>
          ) : null}
        </PullRequestMetaLine>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <DropdownMenu>
          <SharedTooltipTrigger
            render={
              <DropdownMenuTrigger
                render={<Button size="icon-sm" variant="ghost" />}
                className="@lg:hidden"
                aria-label={gt("Diff options")}
              />
            }
            label={
              <>
                <T>Diff options</T>
              </>
            }
          >
            <Settings2Icon className="size-3.5" />
          </SharedTooltipTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuCheckboxItem
              checked={ignoreWhitespace}
              onCheckedChange={(checked) => changeIgnoreWhitespace(checked)}
            >
              <T>Hide whitespace changes</T>
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={wordWrap}
              onCheckedChange={(checked) => setWordWrapOverride(checked)}
            >
              <T>Wrap lines</T>
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
                <T context="diff layout">Stacked</T>
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="split" closeOnClick>
                <T context="diff layout">Split</T>
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="hidden items-center gap-1 @lg:flex">
          <SharedTooltipTrigger
            render={
              <Toggle
                aria-label={
                  ignoreWhitespace ? gt("Show whitespace changes") : gt("Hide whitespace changes")
                }
                variant="ghost"
                size="sm"
                pressed={ignoreWhitespace}
                onPressedChange={(pressed) => changeIgnoreWhitespace(Boolean(pressed))}
              />
            }
            label={ignoreWhitespace ? gt("Show whitespace changes") : gt("Hide whitespace changes")}
          >
            <PilcrowIcon className="size-3.5" />
          </SharedTooltipTrigger>
          <ToggleGroup
            aria-label={gt("Diff layout")}
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
            <Toggle aria-label={gt("Stacked diff view")} value="stacked">
              <Rows3Icon className="size-3.5" />
            </Toggle>
            <Toggle aria-label={gt("Split diff view")} value="split">
              <Columns2Icon className="size-3.5" />
            </Toggle>
          </ToggleGroup>
          <SharedTooltipTrigger
            render={
              <Toggle
                aria-label={
                  wordWrap ? gt("Disable diff line wrapping") : gt("Enable diff line wrapping")
                }
                variant="ghost"
                size="sm"
                pressed={wordWrap}
                onPressedChange={(pressed) => {
                  setWordWrapOverride(Boolean(pressed));
                }}
              />
            }
            label={wordWrap ? gt("Disable line wrapping") : gt("Enable line wrapping")}
          >
            <TextWrapIcon className="size-3.5" />
          </SharedTooltipTrigger>
        </div>
        {fileKeys.length > 0 ? (
          <SharedTooltipTrigger
            render={
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={allFilesCollapsed ? gt("Expand all files") : gt("Collapse all files")}
                onClick={toggleAllFiles}
              />
            }
            label={allFilesCollapsed ? gt("Expand all files") : gt("Collapse all files")}
          >
            {allFilesCollapsed ? (
              <ChevronsUpDownIcon className="size-3.5" />
            ) : (
              <ChevronsDownUpIcon className="size-3.5" />
            )}
          </SharedTooltipTrigger>
        ) : null}
        {testFileCount > 0 ? (
          <SharedTooltipTrigger
            render={
              <Toggle
                aria-label={gt("Hide test files")}
                variant="ghost"
                size="sm"
                pressed={hideTestFiles}
                onPressedChange={(pressed) => setHideTestFiles(Boolean(pressed))}
              />
            }
            label={hideTestFiles ? gt("Show test files") : gt("Hide test files")}
          >
            <FlaskConicalOffIcon className="size-3.5" />
          </SharedTooltipTrigger>
        ) : null}
        {fileKeys.length > 0 ? (
          <SharedTooltipTrigger
            render={
              <Toggle
                aria-label={fileTreeOpen ? gt("Hide file tree") : gt("Show file tree")}
                variant="ghost"
                size="sm"
                pressed={fileTreeOpen}
                onPressedChange={(pressed) => setFileTreeOpen(Boolean(pressed))}
              />
            }
            label={fileTreeOpen ? gt("Hide file tree") : gt("Show file tree")}
          >
            <FolderTreeIcon className="size-3.5" />
          </SharedTooltipTrigger>
        ) : null}
      </div>
    </div>
  );
  // A file not loaded yet pages forward each time a slice arrives; once loaded, the viewer
  // positions it when it renders it.
  const answerReveal = useEffectEvent(() => {
    if (revealRequest === null || answeredRevealNonce.current === revealRequest.nonce) return;
    if (!items.some((item) => resolveFileDiffPath(item.fileDiff) === revealRequest.path)) {
      if (canLoadNextSlice) loadNextSlice();
      return;
    }
    answeredRevealNonce.current = revealRequest.nonce;
    revealFile(revealRequest.path);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the code view to a requested file once loaded, or pages forward until it arrives
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- A reveal for a file not loaded yet pages forward, which sets the slice cursor.
    answerReveal();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Re-checked as pages load until the requested file arrives.
  }, [canLoadNextSlice, items, revealRequest]);
  // The store clears a settled link after this render, so one link must not reveal twice.
  const answeredLink = useRef<string | null>(null);
  const revealLink = useEffectEvent(() => {
    if (revealUrl === undefined) answeredLink.current = null;
    if (revealUrl === undefined || linkAnchor?.kind !== "diff") return;
    // The panel selects the link's commit after this tab's effects run, so the files on screen
    // can still be another commit's.
    const linkCommit = pullRequestLinkCommit(revealUrl);
    if ((detail.commits.some((entry) => entry.oid === linkCommit) ? linkCommit : null) !== commit) {
      return;
    }
    const key = `${scopeKey}:${revealUrl}`;
    if (answeredLink.current === key) return;
    if (
      !pendingLinkPath ||
      !items.some((item) => resolveFileDiffPath(item.fileDiff) === pendingLinkPath)
    ) {
      if (canLoadNextSlice) loadNextSlice();
      // Every page is loaded and none has the file.
      else if (!pendingLinkPath && loadedSlices.length > 0 && nextCursor === null) {
        answeredLink.current = key;
        onRevealSettled?.(revealUrl);
      }
      return;
    }
    answeredLink.current = key;
    setRevealedLink({ scope: scopeKey, path: pendingLinkPath });
    onRevealSettled?.(revealUrl);
    const range =
      linkAnchor.range &&
      resolvePullRequestAnchorRange(
        linkAnchor.range,
        (line) => linkFile !== undefined && isRemovedLine(linkFile, line),
      );
    revealFile(
      pendingLinkPath,
      range
        ? {
            start: range.start,
            end: range.end,
            side: toViewerSide(range.side),
            endSide: toViewerSide(range.endSide),
          }
        : undefined,
    );
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pages and scrolls the virtual diff to a clicked file or line range
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- revealing unfolds the target and may request the next diff page
    revealLink();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- retries the reveal as diff pages and viewer items arrive
  }, [revealUrl, pendingLinkPath, canLoadNextSlice, items]);
  const withToolbar = (body: ReactNode) => (
    <div className="flex h-full min-h-0 flex-col">
      {toolbar}
      {/* Keyed so the diff replaces this node: a reused one keeps focus without its tabIndex. */}
      <div
        key="status"
        ref={scrollerRef}
        tabIndex={-1}
        data-workspace-focus-default
        className="min-h-0 flex-1 overflow-auto outline-none"
      >
        {body}
      </div>
    </div>
  );

  const term = changeRequestTermKind(sourceControlClients.get(detail.provider).changeRequest);
  const diffLoading = (
    <DiffPanelLoadingState
      label={gt(
        "Loading {term, select, mr {merge request} cr {change request} other {pull request}} diff...",
        { term },
      )}
    />
  );
  if (diffQuery.isPending && loadedSlices.length === 0) {
    return withToolbar(diffLoading);
  }

  if (diffQuery.error && loadedSlices.length === 0) {
    return withToolbar(
      <PullRequestDiffUnavailableState
        error={diffQuery.error}
        provider={detail.provider}
        url={detail.url}
        threadRef={threadRef}
        onRetry={() => diffQuery.refresh()}
      />,
    );
  }

  if (rawSlicesView !== null) {
    return withToolbar(rawSlicesView);
  }

  if (items.length === 0 && nextCursor === null) {
    if (hiddenTestFilesLabel !== null && files.length === 0) {
      return withToolbar(
        <div className="flex flex-wrap items-center gap-2 px-4 py-5 text-sm text-muted-foreground">
          <p>{hiddenTestFilesLabel}</p>
          <InlineButton onClick={() => setHideTestFiles(false)}>
            {gt("Show test files")}
          </InlineButton>
        </div>,
      );
    }
    return withToolbar(
      <p className="px-4 py-5 text-sm text-muted-foreground">
        {commit === null
          ? gt(
              "This {term, select, mr {merge request} cr {change request} other {pull request}} has no file changes.",
              { term },
            )
          : gt("This commit has no file changes.")}
      </p>,
    );
  }

  // Wait here rather than in the viewer's own placeholder, so panel focus stays on this scroller.
  if (!workerPoolReady) {
    return withToolbar(diffLoading);
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
                    ? gt("Conversations not on the current diff")
                    : gt("Conversations not on the diff loaded so far")}
                </span>
                <ChevronRightIcon
                  aria-hidden
                  className={cn("size-3.5 transition-transform", orphansOpen && "rotate-90")}
                />
                <span aria-hidden className="tabular-nums">
                  {orphanThreads.length}
                </span>
                <span className="sr-only">
                  {gt("{count, plural, one {{count} conversation} other {{count} conversations}}", {
                    count: orphanThreads.length,
                  })}
                </span>
              </CollapsibleTrigger>
            </h2>
            <CollapsiblePanel>
              <div className="max-h-64 space-y-1 overflow-auto px-1 pb-1">
                {[...orphanFiles].map(([path, threads]) => (
                  <div key={path}>
                    <SharedTooltipTrigger
                      render={<p className="truncate px-3 text-xs text-muted-foreground">{path}</p>}
                      label={path}
                    />
                    <div className="mt-1 space-y-2">
                      {threads.map((thread) => (
                        <div key={thread.id}>
                          {thread.line === null ? null : (
                            <p className="px-3 text-xs text-muted-foreground">
                              <T>
                                Line <Var>{thread.line}</Var>
                              </T>
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
        <div
          className="relative min-h-0 min-w-0 flex-1"
          onWheelCapture={codeViewReveal.cancel}
          onTouchStartCapture={codeViewReveal.cancel}
          onPointerDownCapture={codeViewReveal.cancel}
          onKeyDownCapture={codeViewReveal.cancel}
          // Headers live in shadow DOM; composedPath crosses that boundary.
          onClickCapture={(event) => {
            const composedPath = event.nativeEvent.composedPath?.() ?? [];
            for (const node of composedPath) {
              if (!(node instanceof HTMLElement)) continue;
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
          {/* The viewer must own its scroll element to position virtual rows within it. */}
          <FileViewedToggleContext value={fileViewedToggle}>
            <StyledDiffCodeView<ReviewAnnotationGroup>
              className="@container h-full overflow-auto [scrollbar-gutter:stable]"
              containerRef={(node) => {
                // Pierre sets tabIndex -1 on this root and forwards no data attributes.
                node?.setAttribute("data-workspace-focus-default", "");
                scrollerRef(node);
              }}
              viewerRef={codeViewReveal.attach}
              items={items}
              selectedLines={selectedLines}
              onSelectedLinesChange={setSelectedLines}
              options={diffViewOptions}
              renderCodeViewFooter={renderCodeViewFooter}
              renderHeaderPrefix={renderHeaderPrefix}
              renderHeaderMetadata={renderHeaderMetadata}
              renderAnnotation={renderAnnotation}
              unsafeCSSExtra={`${REPLACE_FILE_COUNTS_CSS}\n${CUT_LINES_CSS}`}
            />
          </FileViewedToggleContext>
        </div>
        {fileTreeOpen ? (
          <FileExplorerPane
            resizable
            storageKey="t3code:diff-file-tree-width"
            defaultWidth={320}
            defaultWidthFraction={0.4}
            minWidth={192}
            resizeLabel={gt("Resize PR Code files")}
          >
            <DiffFileTree
              ariaLabel={gt(
                "{term, select, mr {Merge request} cr {Change request} other {Pull request}} #{number} files",
                {
                  term,
                  number: detail.number,
                },
              )}
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
                        ? gt("Retry")
                        : diffQuery.isPending
                          ? gt("Loading more files...")
                          : gt("Load more files")}
                    </Button>
                  </div>
                )
              }
            />
          </FileExplorerPane>
        ) : null}
      </div>
      {unstructured}
    </div>
  );
}

function WithheldFileNotice({
  path,
  status,
  onLoad,
}: {
  readonly path: string;
  readonly status: WithheldFileStatus;
  readonly onLoad: ((path: string) => void) | undefined;
}) {
  const gt = useGT();
  return (
    <div className="flex items-center gap-2 bg-warning/8 px-3 py-2 text-xs text-warning-foreground">
      <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0 text-warning" />
      <span>
        {status === "error"
          ? gt("Couldn't load this diff.")
          : status === "empty"
            ? gt("No text diff for this file.")
            : gt("Diff too large to display.")}
      </span>
      {onLoad === undefined || status === "empty" ? null : (
        <Button
          size="micro"
          variant="warning-outline"
          disabled={status === "loading"}
          onClick={() => onLoad(path)}
        >
          {status === "loading"
            ? gt("Loading...")
            : status === "error"
              ? gt("Retry")
              : gt("Load diff")}
        </Button>
      )}
    </div>
  );
}

export default PullRequestCodeTab;
