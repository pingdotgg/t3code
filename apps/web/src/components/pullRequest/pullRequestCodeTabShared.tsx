import {
  capitalizeTerm,
  sourceControlClients,
} from "@t3tools/client-runtime/source-control-clients";
import type { CodeViewItem, DiffLineAnnotation, SelectedLineRange } from "@pierre/diffs";
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
} from "@t3tools/contracts";
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

import { observeIntersection } from "~/lib/observeIntersection";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useClientSettings, updateClientSettings } from "~/hooks/useSettings";
import { useRenderedAppearance } from "~/hooks/useTheme";
import { areAllDiffFilesCollapsed } from "~/lib/diffCollapse";
import { pullRequestFindingKey, type PullRequestFinding } from "./pullRequestDetail.logic";
import {
  canEditPullRequestComment,
  canResolvePullRequestThread,
} from "@t3tools/client-runtime/pull-request-editing";
import { isTestChangedFile } from "@t3tools/shared/changedFileKind";
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
  resolveDiffReviewAnchor,
  type ReviewCommentContext,
} from "~/reviewCommentContext";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import { DiffPanelLoadingState } from "../DiffPanelShell";
import { useDiffWorkerPool } from "../DiffWorkerPoolProvider";
import { DiffCommentAnnotation } from "../diffs/DiffCommentAnnotation";
import { DiffFileTree } from "../diffs/DiffFileTree";
import { FileExplorerPane } from "../files/FileExplorerPane";
import { useCodeViewFileReveal } from "../diffs/useCodeViewFileReveal";
import { useHideTestFiles } from "../diffs/useHideTestFiles";
import { diffFileTreeEntries, orderDiffFilesLikeTree } from "../diffs/diffFileTree.logic";
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
  getFileViewedRange,
  isFileDiffCollapsed,
  isLineInFileDiff,
  toggleFileDiffFoldForViewed,
  type DiffFoldOverride,
} from "./pullRequestDiff.logic";
import { PullRequestDiffStat, PullRequestMetaLine } from "./pullRequestPresentation";
import { PullRequestDiffUnavailableState } from "./PullRequestDiffUnavailableState";
import { usePullRequestFilesViewed } from "./usePullRequestFilesViewed";
import {
  nextPendingReviewCommentId,
  pullRequestReviewKey,
  usePendingReviewComments,
  usePullRequestReviewStore,
  type PendingReviewComment,
} from "./pullRequestReviewStore";

export interface ReviewAnnotationGroup {
  readonly threads: ReadonlyArray<PullRequestReviewThread>;
  readonly pending: ReadonlyArray<PendingReviewComment>;
  readonly draft: boolean;
}

export type ReviewAnnotation = DiffLineAnnotation<ReviewAnnotationGroup>;

export const COMMIT_PAGE_SIZE = 10;

export const PULL_REQUEST_FILE_TREE_STORAGE_KEY = "t3code.pullRequestFileTreeOpen";

export interface DiffSlice {
  readonly source: PullRequestDiffResult;
  readonly cursor: string | null;
  readonly patch: string;
  readonly truncated: boolean;
  readonly nextCursor: string | null;
  readonly omittedFileStats: ReadonlyArray<PullRequestOmittedFileStat>;
}

// Show host counts outside the shadow root; hunk totals are zero when hosts withhold hunks.
export const REPLACE_FILE_COUNTS_CSS = `
[data-diffs-header] [data-additions-count],
[data-diffs-header] [data-deletions-count] {
  display: none !important;
}`;

export const NO_SLICES: ReadonlyArray<DiffSlice> = [];

// Query results outlive the panel's slices, so their parses survive closing and reopening
// without retaining anything beyond the query cache's lifetime.
export const sliceParses = new WeakMap<PullRequestDiffResult, Map<string, RenderablePatch | null>>();

export function parseSlice(slice: DiffSlice, cacheKey: string, ignoreWhitespace: boolean) {
  let parses = sliceParses.get(slice.source);
  if (parses === undefined) {
    parses = new Map();
    sliceParses.set(slice.source, parses);
  }
  if (parses.has(cacheKey)) return parses.get(cacheKey) ?? null;
  const parsed = getRenderablePatch(slice.patch, cacheKey, {
    compactPartialHunkOffsets: true,
    ignoreWhitespace,
  });
  parses.set(cacheKey, parsed);
  return parsed;
}

export type DiffModel = {
  readonly parsedSlices: ReadonlyArray<RenderablePatch | null>;
  readonly loadedFiles: ReadonlyArray<Extract<RenderablePatch, { kind: "files" }>["files"][number]>;
  readonly sourceFileStats: ReadonlyMap<string, ReturnType<typeof getDiffLineStat>>;
};
export const diffModels = new WeakMap<ReadonlyArray<DiffSlice>, Map<string, DiffModel>>();
export const patchHashes = new WeakMap<DiffSlice, number>();

// Hashing, ordering and counting every file of a huge pull request costs a second, and the tab
// renders far more often than its slices change, so the model is kept per slice list.
export function diffModel(
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
    loadedFiles: orderDiffFilesLikeTree(
      parsedSlices.flatMap((parsed) =>
        parsed?.kind === "files" ? orderDiffFiles(parsed.files) : [],
      ),
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

export const threadsByPathCache = new WeakMap<
  ReadonlyArray<PullRequestReviewThread>,
  ReadonlyMap<string, ReadonlyArray<PullRequestReviewThread>>
>();

export function reviewThreadsByPath(threads: ReadonlyArray<PullRequestReviewThread>) {
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

export interface FileViewedToggleState {
  readonly enabled: boolean;
  readonly isViewed: (path: string) => boolean;
  readonly isStale: (path: string) => boolean;
  readonly setFileViewed: (fileKey: string, viewed: boolean, extendRange: boolean) => void;
}

// Context updates viewed toggles without invalidating memoized header portals.
export const FileViewedToggleContext = createContext<FileViewedToggleState | null>(null);

export function FileViewedToggle({
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
        className="flex w-18 shrink-0 cursor-pointer select-none items-center gap-1.5 text-2xs text-muted-foreground"
        onClick={(event) => event.stopPropagation()}
      >
        <Checkbox
          aria-label={stale ? "Changed" : "Viewed"}
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

export interface MutableAnnotationGroup {
  readonly side: PullRequestDiffSide;
  readonly line: number;
  readonly threads: PullRequestReviewThread[];
  readonly pending: PendingReviewComment[];
  draft: boolean;
}

export interface DraftAnchor {
  readonly fileKey: string;
  readonly path: string;
  readonly oldPath: string | null;
  readonly position: PullRequestReviewPosition;
  readonly startPosition?: PullRequestReviewPosition;
  readonly range: SelectedLineRange;
}

export interface PullRequestAgentSelectionInput {
  readonly comment: ReviewCommentContext;
  readonly request: string;
}


export interface PullRequestCodeTabProps {
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
  backgroundRefreshToken?: number;
  revealRequest?: { readonly path: string; readonly nonce: number } | null;
}
