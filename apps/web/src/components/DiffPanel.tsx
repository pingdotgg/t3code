import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff, Virtualizer, type FileDiffMetadata } from "@pierre/diffs/react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import type { TurnId } from "@t3tools/contracts";
import {
  ArrowLeftIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  Columns2Icon,
  FileSearchIcon,
  PanelRightCloseIcon,
  PilcrowIcon,
  Rows3Icon,
  TextWrapIcon,
} from "lucide-react";
import {
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useGitStatus } from "~/lib/gitStatusState";
import { gitWorkingTreeDiffQueryOptions } from "~/lib/gitReactQuery";
import { checkpointDiffQueryOptions } from "~/lib/providerReactQuery";
import { cn } from "~/lib/utils";
import { resolvePathLinkTarget } from "../terminal-links";
import {
  buildClosedDiffSearch,
  buildOpenDiffSearch,
  parseDiffRouteSearch,
  stripDiffSearchParams,
  type DiffRouteSource,
} from "../diffRouteSearch";
import { useTheme } from "../hooks/useTheme";
import {
  buildPatchCacheKey,
  DIFF_MOBILE_TEXT_FLOOR_UNSAFE_CSS,
  resolveDiffThemeName,
} from "../lib/diffRendering";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import { selectProjectByRef, useStore } from "../store";
import { createThreadSelectorByRef } from "../storeSelectors";
import {
  buildDraftThreadRouteParams,
  buildThreadRouteParams,
  resolveThreadRouteTarget,
  type ThreadRouteTarget,
} from "../threadRoutes";
import { useSettings } from "../hooks/useSettings";
import { useSourceControlPanelState } from "../sourceControlPanelState";
import { formatShortTimestamp } from "../timestampFormat";
import { DiffPanelLoadingState, DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { Button } from "./ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { ToggleGroup, Toggle } from "./ui/toggle-group";
import {
  openPathInPreferredEditorOrFilePreview,
  openWorkspaceFilePreview,
  type WorkspaceFilePreviewDiffReturnTarget,
} from "../workspaceFilePreview";
import {
  isWorkspaceImagePreviewPath,
  resolveWorkspaceGitImagePreviewUrl,
  resolveWorkspaceImagePreviewUrl,
} from "../workspaceImagePreview";
import { useComposerDraftStore } from "../composerDraftStore";
import type { Thread } from "../types";

type DiffRenderMode = "stacked" | "split";
type DiffThemeType = "light" | "dark";

type DiffPanelThreadContext = Pick<
  Thread,
  "id" | "environmentId" | "projectId" | "worktreePath" | "turnDiffSummaries"
> & {
  routeTarget: ThreadRouteTarget;
};

const DIFF_PANEL_UNSAFE_CSS = `
[data-diffs-header],
[data-diff],
[data-file],
[data-error-wrapper],
[data-virtualizer-buffer] {
  --diffs-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-light-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-dark-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-token-light-bg: transparent;
  --diffs-token-dark-bg: transparent;

  --diffs-bg-context-override: color-mix(in srgb, var(--background) 97%, var(--foreground));
  --diffs-bg-hover-override: color-mix(in srgb, var(--background) 94%, var(--foreground));
  --diffs-bg-separator-override: color-mix(in srgb, var(--background) 95%, var(--foreground));
  --diffs-bg-buffer-override: color-mix(in srgb, var(--background) 90%, var(--foreground));

  --diffs-bg-addition-override: color-mix(in srgb, var(--background) 92%, var(--success));
  --diffs-bg-addition-number-override: color-mix(in srgb, var(--background) 88%, var(--success));
  --diffs-bg-addition-hover-override: color-mix(in srgb, var(--background) 85%, var(--success));
  --diffs-bg-addition-emphasis-override: color-mix(in srgb, var(--background) 80%, var(--success));

  --diffs-bg-deletion-override: color-mix(in srgb, var(--background) 92%, var(--destructive));
  --diffs-bg-deletion-number-override: color-mix(in srgb, var(--background) 88%, var(--destructive));
  --diffs-bg-deletion-hover-override: color-mix(in srgb, var(--background) 85%, var(--destructive));
  --diffs-bg-deletion-emphasis-override: color-mix(
    in srgb,
    var(--background) 80%,
    var(--destructive)
  );

  background-color: var(--diffs-bg) !important;
}

[data-file-info] {
  background-color: color-mix(in srgb, var(--card) 94%, var(--foreground)) !important;
  border-block-color: var(--border) !important;
  color: var(--foreground) !important;
}

[data-diffs-header] {
  position: sticky !important;
  top: 0;
  z-index: 4;
  background-color: color-mix(in srgb, var(--card) 94%, var(--foreground)) !important;
  border-bottom: 1px solid var(--border) !important;
}

[data-title] {
  cursor: pointer;
  transition:
    color 120ms ease,
    text-decoration-color 120ms ease;
  text-decoration: underline;
  text-decoration-color: transparent;
  text-underline-offset: 2px;
}

[data-title]:hover {
  color: color-mix(in srgb, var(--foreground) 84%, var(--primary)) !important;
  text-decoration-color: currentColor;
}

${DIFF_MOBILE_TEXT_FLOOR_UNSAFE_CSS}
`;

type RenderablePatch =
  | {
      kind: "files";
      files: FileDiffMetadata[];
    }
  | {
      kind: "raw";
      text: string;
      reason: string;
    };

function getRenderablePatch(
  patch: string | undefined,
  cacheScope = "diff-panel",
): RenderablePatch | null {
  if (!patch) return null;
  const normalizedPatch = patch.trim();
  if (normalizedPatch.length === 0) return null;

  try {
    const parsedPatches = parsePatchFiles(
      normalizedPatch,
      buildPatchCacheKey(normalizedPatch, cacheScope),
    );
    const files = parsedPatches.flatMap((parsedPatch) => parsedPatch.files);
    if (files.length > 0) {
      return { kind: "files", files };
    }

    return {
      kind: "raw",
      text: normalizedPatch,
      reason: "Unsupported diff format. Showing raw patch.",
    };
  } catch {
    return {
      kind: "raw",
      text: normalizedPatch,
      reason: "Failed to parse patch. Showing raw patch.",
    };
  }
}

function resolveFileDiffPath(fileDiff: FileDiffMetadata): string {
  const raw = fileDiff.name ?? fileDiff.prevName ?? "";
  if (raw.startsWith("a/") || raw.startsWith("b/")) {
    return raw.slice(2);
  }
  return raw;
}

function buildFileDiffRenderKey(fileDiff: FileDiffMetadata): string {
  return fileDiff.cacheKey ?? `${fileDiff.prevName ?? "none"}:${fileDiff.name}`;
}

function resolveFileDiffPreviewObjectId(fileDiff: FileDiffMetadata): string | undefined {
  return fileDiff.type === "deleted" ? fileDiff.prevObjectId : fileDiff.newObjectId;
}

function getDiffCollapseIconClassName(fileDiff: FileDiffMetadata): string {
  switch (fileDiff.type) {
    case "new":
      return "text-[var(--diffs-addition-base)]";
    case "deleted":
      return "text-[var(--diffs-deletion-base)]";
    case "change":
    case "rename-pure":
    case "rename-changed":
      return "text-[var(--diffs-modified-base)]";
    default:
      return "text-muted-foreground/80";
  }
}

function DiffImagePreview(props: {
  filePath: string;
  imageUrl: string | null;
  type: FileDiffMetadata["type"];
}) {
  const [loadState, setLoadState] = useState<"loading" | "loaded" | "error">("loading");

  useEffect(() => {
    setLoadState(props.imageUrl ? "loading" : "error");
  }, [props.imageUrl]);

  if (!props.imageUrl) {
    return (
      <div className="border-x border-b border-border/70 bg-background/55 px-3 py-6 text-center text-xs text-muted-foreground/70">
        {props.type === "deleted" ? "Image deleted." : "Unable to resolve image preview URL."}
      </div>
    );
  }

  return (
    <div className="border-x border-b border-border/70 bg-background/55 p-3">
      <div className="relative flex min-h-48 items-center justify-center overflow-auto rounded-sm bg-background/80">
        {loadState === "loading" ? (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground/70">
            Loading image...
          </div>
        ) : null}
        {loadState === "error" ? (
          <div className="absolute inset-0 flex items-center justify-center px-3 text-center text-xs text-destructive">
            Unable to load image preview.
          </div>
        ) : null}
        <img
          src={props.imageUrl}
          alt={`${props.filePath} preview`}
          draggable={false}
          aria-hidden={loadState !== "loaded"}
          className={
            loadState === "loaded"
              ? "max-h-[60vh] max-w-full object-contain"
              : "pointer-events-none max-h-[60vh] max-w-full object-contain opacity-0"
          }
          onLoad={() => setLoadState("loaded")}
          onError={() => setLoadState("error")}
        />
      </div>
    </div>
  );
}

interface DiffPanelProps {
  mode?: DiffPanelMode;
}

export { DiffWorkerPoolProvider } from "./DiffWorkerPoolProvider";

export default function DiffPanel({ mode = "inline" }: DiffPanelProps) {
  const navigate = useNavigate();
  const { resolvedTheme } = useTheme();
  const settings = useSettings();
  const [diffRenderMode, setDiffRenderMode] = useState<DiffRenderMode>("stacked");
  const [diffWordWrap, setDiffWordWrap] = useState(settings.diffWordWrap);
  const [diffIgnoreWhitespace, setDiffIgnoreWhitespace] = useState(settings.diffIgnoreWhitespace);
  const [collapsedDiffFileKeys, setCollapsedDiffFileKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const patchViewportRef = useRef<HTMLDivElement>(null);
  const turnStripRef = useRef<HTMLDivElement>(null);
  const previousDiffOpenRef = useRef(false);
  const [canScrollTurnStripLeft, setCanScrollTurnStripLeft] = useState(false);
  const [canScrollTurnStripRight, setCanScrollTurnStripRight] = useState(false);
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const diffSearch = useSearch({ strict: false, select: (search) => parseDiffRouteSearch(search) });
  const diffOpen = diffSearch.diff === "1";
  const sourceControlOpen = useSourceControlPanelState().open;
  const routeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const routeDraftId = routeTarget?.kind === "draft" ? routeTarget.draftId : null;
  const serverThread = useStore(
    useMemo(() => createThreadSelectorByRef(routeThreadRef), [routeThreadRef]),
  );
  const draftRouteSession = useComposerDraftStore((store) =>
    routeDraftId ? store.getDraftSession(routeDraftId) : null,
  );
  const serverRouteDraftSession = useComposerDraftStore((store) =>
    routeThreadRef ? store.getDraftSessionByRef(routeThreadRef) : null,
  );
  const activeDiffContext = useMemo<DiffPanelThreadContext | null>(() => {
    if (!routeTarget) {
      return null;
    }

    if (routeTarget.kind === "server") {
      if (serverThread) {
        return {
          id: serverThread.id,
          environmentId: serverThread.environmentId,
          projectId: serverThread.projectId,
          worktreePath: serverThread.worktreePath,
          turnDiffSummaries: serverThread.turnDiffSummaries,
          routeTarget,
        };
      }
      if (serverRouteDraftSession) {
        return {
          id: serverRouteDraftSession.threadId,
          environmentId: serverRouteDraftSession.environmentId,
          projectId: serverRouteDraftSession.projectId,
          worktreePath: serverRouteDraftSession.worktreePath,
          turnDiffSummaries: [],
          routeTarget,
        };
      }
      return null;
    }

    if (!draftRouteSession) {
      return null;
    }
    return {
      id: draftRouteSession.threadId,
      environmentId: draftRouteSession.environmentId,
      projectId: draftRouteSession.projectId,
      worktreePath: draftRouteSession.worktreePath,
      turnDiffSummaries: [],
      routeTarget,
    };
  }, [draftRouteSession, routeTarget, serverRouteDraftSession, serverThread]);
  const activeThreadId =
    activeDiffContext?.routeTarget.kind === "server" ? activeDiffContext.id : null;
  const activeProjectId = activeDiffContext?.projectId ?? null;
  const activeProject = useStore((store) =>
    activeDiffContext && activeProjectId
      ? selectProjectByRef(store, {
          environmentId: activeDiffContext.environmentId,
          projectId: activeProjectId,
        })
      : undefined,
  );
  const activeCwd = activeDiffContext?.worktreePath ?? activeProject?.cwd;
  const gitStatusQuery = useGitStatus({
    environmentId: activeDiffContext?.environmentId ?? null,
    cwd: activeCwd ?? null,
  });
  const previousGitStatusDataRef = useRef(gitStatusQuery.data);
  const isGitRepo = gitStatusQuery.data?.isRepo ?? true;
  const { turnDiffSummaries, inferredCheckpointTurnCountByTurnId } = useTurnDiffSummaries(
    activeDiffContext ?? undefined,
  );
  const orderedTurnDiffSummaries = useMemo(
    () =>
      [...turnDiffSummaries].toSorted((left, right) => {
        const leftTurnCount =
          left.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[left.turnId] ?? 0;
        const rightTurnCount =
          right.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[right.turnId] ?? 0;
        if (leftTurnCount !== rightTurnCount) {
          return rightTurnCount - leftTurnCount;
        }
        return right.completedAt.localeCompare(left.completedAt);
      }),
    [inferredCheckpointTurnCountByTurnId, turnDiffSummaries],
  );

  const selectedDiffSource = diffSearch.diffSource ?? null;
  const isWorkingTreeSelection = selectedDiffSource !== null;
  const selectedTurnId = isWorkingTreeSelection ? null : (diffSearch.diffTurnId ?? null);
  const selectedFilePath =
    selectedTurnId !== null || selectedDiffSource !== null
      ? (diffSearch.diffFilePath ?? null)
      : null;
  const selectedTurn =
    selectedTurnId === null
      ? undefined
      : (orderedTurnDiffSummaries.find((summary) => summary.turnId === selectedTurnId) ??
        orderedTurnDiffSummaries[0]);
  const selectedCheckpointTurnCount =
    selectedTurn &&
    (selectedTurn.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[selectedTurn.turnId]);
  const selectedTurnAttributionNote =
    selectedTurn?.attribution === "unattributed"
      ? "May include changes from other threads in this workspace."
      : selectedTurn?.attribution === "touched-paths"
        ? "Limited to detected paths; same-file overlaps may be approximate."
        : null;
  const selectedCheckpointRange = useMemo(
    () =>
      typeof selectedCheckpointTurnCount === "number"
        ? {
            fromTurnCount: Math.max(0, selectedCheckpointTurnCount - 1),
            toTurnCount: selectedCheckpointTurnCount,
          }
        : null,
    [selectedCheckpointTurnCount],
  );
  const conversationCheckpointTurnCount = useMemo(() => {
    const turnCounts: Array<number> = [];
    for (const summary of orderedTurnDiffSummaries) {
      const value =
        summary.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[summary.turnId];
      if (typeof value === "number") {
        turnCounts.push(value);
      }
    }
    if (turnCounts.length === 0) {
      return undefined;
    }
    const latest = Math.max(...turnCounts);
    return latest > 0 ? latest : undefined;
  }, [inferredCheckpointTurnCountByTurnId, orderedTurnDiffSummaries]);
  const conversationCheckpointRange = useMemo(
    () =>
      !isWorkingTreeSelection &&
      !selectedTurn &&
      typeof conversationCheckpointTurnCount === "number"
        ? {
            fromTurnCount: 0,
            toTurnCount: conversationCheckpointTurnCount,
          }
        : null,
    [conversationCheckpointTurnCount, isWorkingTreeSelection, selectedTurn],
  );
  const activeCheckpointRange = isWorkingTreeSelection
    ? null
    : selectedTurn
      ? selectedCheckpointRange
      : conversationCheckpointRange;
  const conversationCacheScope = useMemo(() => {
    if (isWorkingTreeSelection || selectedTurn || orderedTurnDiffSummaries.length === 0) {
      return null;
    }
    return `conversation:${orderedTurnDiffSummaries.map((summary) => summary.turnId).join(",")}`;
  }, [isWorkingTreeSelection, orderedTurnDiffSummaries, selectedTurn]);
  const activeCheckpointDiffQuery = useQuery(
    checkpointDiffQueryOptions({
      environmentId: activeDiffContext?.environmentId ?? null,
      threadId: activeThreadId,
      fromTurnCount: activeCheckpointRange?.fromTurnCount ?? null,
      toTurnCount: activeCheckpointRange?.toTurnCount ?? null,
      ignoreWhitespace: diffIgnoreWhitespace,
      cacheScope: selectedTurn ? `turn:${selectedTurn.turnId}` : conversationCacheScope,
      enabled: isGitRepo && !isWorkingTreeSelection,
    }),
  );
  const workingTreeDiffQuery = useQuery(
    gitWorkingTreeDiffQueryOptions({
      environmentId: activeDiffContext?.environmentId ?? null,
      cwd: activeCwd ?? null,
      target: selectedDiffSource,
      ignoreWhitespace: diffIgnoreWhitespace,
      enabled: isGitRepo,
    }),
  );
  const refetchWorkingTreeDiff = workingTreeDiffQuery.refetch;
  const workingTreeDiffFetched = workingTreeDiffQuery.isFetched;
  const selectedTurnCheckpointDiff = selectedTurn
    ? activeCheckpointDiffQuery.data?.diff
    : undefined;
  const conversationCheckpointDiff =
    selectedTurn || isWorkingTreeSelection ? undefined : activeCheckpointDiffQuery.data?.diff;
  const workingTreeDiff = isWorkingTreeSelection ? workingTreeDiffQuery.data?.diff : undefined;
  const isLoadingSelectedDiff = isWorkingTreeSelection
    ? workingTreeDiffQuery.isLoading
    : activeCheckpointDiffQuery.isLoading;
  const checkpointDiffError =
    activeCheckpointDiffQuery.error instanceof Error
      ? activeCheckpointDiffQuery.error.message
      : activeCheckpointDiffQuery.error
        ? "Failed to load checkpoint diff."
        : null;
  const workingTreeDiffError =
    workingTreeDiffQuery.error instanceof Error
      ? workingTreeDiffQuery.error.message
      : workingTreeDiffQuery.error
        ? "Failed to load working tree diff."
        : null;
  const selectedDiffError = isWorkingTreeSelection ? workingTreeDiffError : checkpointDiffError;

  const selectedPatch = isWorkingTreeSelection
    ? workingTreeDiff
    : selectedTurn
      ? selectedTurnCheckpointDiff
      : conversationCheckpointDiff;
  const hasResolvedPatch = typeof selectedPatch === "string";
  const hasNoNetChanges = hasResolvedPatch && selectedPatch.trim().length === 0;
  const renderablePatch = useMemo(
    () => getRenderablePatch(selectedPatch, `diff-panel:${resolvedTheme}`),
    [resolvedTheme, selectedPatch],
  );
  const renderableFiles = useMemo(() => {
    if (!renderablePatch || renderablePatch.kind !== "files") {
      return [];
    }
    return renderablePatch.files.toSorted((left, right) =>
      resolveFileDiffPath(left).localeCompare(resolveFileDiffPath(right), undefined, {
        numeric: true,
        sensitivity: "base",
      }),
    );
  }, [renderablePatch]);

  useEffect(() => {
    if (renderableFiles.length === 0) {
      setCollapsedDiffFileKeys((current) => (current.size === 0 ? current : new Set()));
      return;
    }

    const visibleFileKeys = new Set(renderableFiles.map(buildFileDiffRenderKey));
    setCollapsedDiffFileKeys((current) => {
      const next = new Set([...current].filter((fileKey) => visibleFileKeys.has(fileKey)));
      return next.size === current.size ? current : next;
    });
  }, [renderableFiles]);

  useEffect(() => {
    if (diffOpen && !previousDiffOpenRef.current) {
      setDiffWordWrap(settings.diffWordWrap);
      setDiffIgnoreWhitespace(settings.diffIgnoreWhitespace);
    }
    previousDiffOpenRef.current = diffOpen;
  }, [diffOpen, settings.diffIgnoreWhitespace, settings.diffWordWrap]);

  useEffect(() => {
    const previousGitStatusData = previousGitStatusDataRef.current;
    previousGitStatusDataRef.current = gitStatusQuery.data;
    if (
      previousGitStatusData === gitStatusQuery.data ||
      !selectedDiffSource ||
      !workingTreeDiffFetched
    ) {
      return;
    }
    void refetchWorkingTreeDiff();
  }, [gitStatusQuery.data, refetchWorkingTreeDiff, selectedDiffSource, workingTreeDiffFetched]);

  useEffect(() => {
    if (!selectedFilePath || !patchViewportRef.current) {
      return;
    }
    const target = Array.from(
      patchViewportRef.current.querySelectorAll<HTMLElement>("[data-diff-file-path]"),
    ).find((element) => element.dataset.diffFilePath === selectedFilePath);
    target?.scrollIntoView({ block: "nearest" });
  }, [selectedFilePath, renderableFiles]);

  const buildDiffFileReturnTarget = useCallback(
    (filePath: string): WorkspaceFilePreviewDiffReturnTarget => ({
      kind: "diff",
      ...(selectedDiffSource ? { diffSource: selectedDiffSource, diffFilePath: filePath } : {}),
      ...(selectedTurn?.turnId ? { diffTurnId: selectedTurn.turnId, diffFilePath: filePath } : {}),
    }),
    [selectedDiffSource, selectedTurn?.turnId],
  );
  const openDiffFileInEditor = useCallback(
    (filePath: string) => {
      const targetPath = activeCwd ? resolvePathLinkTarget(filePath, activeCwd) : filePath;
      void openPathInPreferredEditorOrFilePreview({
        targetPath,
        ...(activeDiffContext?.environmentId
          ? { environmentId: activeDiffContext.environmentId }
          : {}),
        ...(activeCwd ? { cwd: activeCwd, displayPath: filePath } : {}),
        returnTarget: buildDiffFileReturnTarget(filePath),
      }).catch((error) => {
        console.warn("Failed to open diff file in editor.", error);
      });
    },
    [activeCwd, activeDiffContext?.environmentId, buildDiffFileReturnTarget],
  );
  const openDiffFilePreview = useCallback(
    (filePath: string) => {
      if (!activeCwd || !activeDiffContext?.environmentId) {
        return;
      }

      openWorkspaceFilePreview(
        {
          environmentId: activeDiffContext.environmentId,
          cwd: activeCwd,
          relativePath: filePath,
          displayPath: filePath,
        },
        { returnTarget: buildDiffFileReturnTarget(filePath) },
      );
    },
    [activeCwd, activeDiffContext?.environmentId, buildDiffFileReturnTarget],
  );
  const toggleDiffFileCollapsed = useCallback((fileKey: string) => {
    setCollapsedDiffFileKeys((current) => {
      const next = new Set(current);
      if (next.has(fileKey)) {
        next.delete(fileKey);
      } else {
        next.add(fileKey);
      }
      return next;
    });
  }, []);

  const selectTurn = (turnId: TurnId) => {
    if (!activeDiffContext) return;
    if (activeDiffContext.routeTarget.kind === "draft") {
      void navigate({
        to: "/draft/$draftId",
        params: buildDraftThreadRouteParams(activeDiffContext.routeTarget.draftId),
        search: (previous) => {
          const rest = stripDiffSearchParams(previous);
          return { ...rest, diff: "1", diffTurnId: turnId };
        },
      });
      return;
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(activeDiffContext.routeTarget.threadRef),
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        return { ...rest, diff: "1", diffTurnId: turnId };
      },
    });
  };
  const selectWholeConversation = () => {
    if (!activeDiffContext) return;
    if (activeDiffContext.routeTarget.kind === "draft") {
      void navigate({
        to: "/draft/$draftId",
        params: buildDraftThreadRouteParams(activeDiffContext.routeTarget.draftId),
        search: (previous) => buildOpenDiffSearch(previous),
      });
      return;
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(activeDiffContext.routeTarget.threadRef),
      search: (previous) => buildOpenDiffSearch(previous),
    });
  };
  const selectWorkingTreeDiff = (target: DiffRouteSource) => {
    if (!activeDiffContext) return;
    if (activeDiffContext.routeTarget.kind === "draft") {
      void navigate({
        to: "/draft/$draftId",
        params: buildDraftThreadRouteParams(activeDiffContext.routeTarget.draftId),
        search: (previous) => buildOpenDiffSearch(previous, { source: target }),
      });
      return;
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(activeDiffContext.routeTarget.threadRef),
      search: (previous) => buildOpenDiffSearch(previous, { source: target }),
    });
  };
  const closeDiffPanel = () => {
    if (!activeDiffContext) return;
    if (activeDiffContext.routeTarget.kind === "draft") {
      void navigate({
        to: "/draft/$draftId",
        params: buildDraftThreadRouteParams(activeDiffContext.routeTarget.draftId),
        search: (previous) => buildClosedDiffSearch(previous),
      });
      return;
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(activeDiffContext.routeTarget.threadRef),
      search: (previous) => buildClosedDiffSearch(previous),
    });
  };
  const updateTurnStripScrollState = useCallback(() => {
    const element = turnStripRef.current;
    if (!element) {
      setCanScrollTurnStripLeft(false);
      setCanScrollTurnStripRight(false);
      return;
    }

    const maxScrollLeft = Math.max(0, element.scrollWidth - element.clientWidth);
    setCanScrollTurnStripLeft(element.scrollLeft > 4);
    setCanScrollTurnStripRight(element.scrollLeft < maxScrollLeft - 4);
  }, []);
  const scrollTurnStripBy = useCallback((offset: number) => {
    const element = turnStripRef.current;
    if (!element) return;
    element.scrollBy({ left: offset, behavior: "smooth" });
  }, []);
  const onTurnStripWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    const element = turnStripRef.current;
    if (!element) return;
    if (element.scrollWidth <= element.clientWidth + 1) return;
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;

    event.preventDefault();
    element.scrollBy({ left: event.deltaY, behavior: "auto" });
  }, []);

  useEffect(() => {
    const element = turnStripRef.current;
    if (!element) return;

    const frameId = window.requestAnimationFrame(() => updateTurnStripScrollState());
    const onScroll = () => updateTurnStripScrollState();

    element.addEventListener("scroll", onScroll, { passive: true });

    const resizeObserver = new ResizeObserver(() => updateTurnStripScrollState());
    resizeObserver.observe(element);

    return () => {
      window.cancelAnimationFrame(frameId);
      element.removeEventListener("scroll", onScroll);
      resizeObserver.disconnect();
    };
  }, [updateTurnStripScrollState]);

  useEffect(() => {
    const frameId = window.requestAnimationFrame(() => updateTurnStripScrollState());
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [orderedTurnDiffSummaries, selectedDiffSource, selectedTurnId, updateTurnStripScrollState]);

  useEffect(() => {
    const element = turnStripRef.current;
    if (!element) return;

    const selectedChip = element.querySelector<HTMLElement>("[data-turn-chip-selected='true']");
    selectedChip?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }, [selectedDiffSource, selectedTurn?.turnId, selectedTurnId]);

  const diffSelectionValue = selectedDiffSource ?? selectedTurn?.turnId ?? "all";
  const selectedDiffDropdownLabel = (() => {
    if (selectedDiffSource === "unstaged") {
      return "Unstaged";
    }
    if (selectedDiffSource === "staged") {
      return "Staged";
    }
    if (!selectedTurn) {
      return "All turns";
    }
    const count =
      selectedTurn.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[selectedTurn.turnId];
    return `Turn ${count ?? "?"}`;
  })();
  const headerRow = (
    <>
      {sourceControlOpen ? (
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Back to source control"
          title="Back to source control"
          className="shrink-0 [-webkit-app-region:no-drag]"
          onClick={closeDiffPanel}
        >
          <ArrowLeftIcon className="size-3.5" />
        </Button>
      ) : null}
      <div className="hidden min-w-0 flex-1 [-webkit-app-region:no-drag] max-[760px]:block">
        <Select
          value={diffSelectionValue}
          onValueChange={(value) => {
            if (value === "unstaged" || value === "staged") {
              selectWorkingTreeDiff(value);
              return;
            }
            if (value === "all") {
              selectWholeConversation();
              return;
            }
            selectTurn(value as TurnId);
          }}
        >
          <SelectTrigger className="w-full min-w-0" aria-label="Diff selection">
            <SelectValue>{selectedDiffDropdownLabel}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem hideIndicator value="unstaged">
              Unstaged
            </SelectItem>
            <SelectItem hideIndicator value="staged">
              Staged
            </SelectItem>
            <SelectItem hideIndicator value="all">
              All turns
            </SelectItem>
            {orderedTurnDiffSummaries.map((summary) => {
              const turnCount =
                summary.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[summary.turnId];
              return (
                <SelectItem hideIndicator key={summary.turnId} value={summary.turnId}>
                  <span className="flex items-center gap-2">
                    <span>Turn {turnCount ?? "?"}</span>
                    <span className="text-[10px] text-muted-foreground/70">
                      {formatShortTimestamp(summary.completedAt, settings.timestampFormat)}
                    </span>
                  </span>
                </SelectItem>
              );
            })}
          </SelectPopup>
        </Select>
      </div>
      <div className="relative min-w-0 flex-1 [-webkit-app-region:no-drag] max-[760px]:hidden">
        <Button
          size="icon-xs"
          variant="outline"
          className={cn(
            "absolute left-0 top-1/2 z-20 -translate-y-1/2 bg-background/90 text-muted-foreground",
            canScrollTurnStripLeft
              ? "hover:text-foreground"
              : "cursor-not-allowed border-border/40 text-muted-foreground/40",
          )}
          onClick={() => scrollTurnStripBy(-180)}
          disabled={!canScrollTurnStripLeft}
          aria-label="Scroll turn list left"
        >
          <ChevronLeftIcon className="size-3.5" />
        </Button>
        <Button
          size="icon-xs"
          variant="outline"
          className={cn(
            "absolute right-0 top-1/2 z-20 -translate-y-1/2 bg-background/90 text-muted-foreground",
            canScrollTurnStripRight
              ? "hover:text-foreground"
              : "cursor-not-allowed border-border/40 text-muted-foreground/40",
          )}
          onClick={() => scrollTurnStripBy(180)}
          disabled={!canScrollTurnStripRight}
          aria-label="Scroll turn list right"
        >
          <ChevronRightIcon className="size-3.5" />
        </Button>
        <div
          ref={turnStripRef}
          className="turn-chip-strip flex gap-1 overflow-x-auto px-8 py-0.5"
          style={
            canScrollTurnStripLeft || canScrollTurnStripRight
              ? {
                  maskImage: `linear-gradient(to right, ${canScrollTurnStripLeft ? "transparent 24px, black 72px" : "black"}, ${canScrollTurnStripRight ? "black calc(100% - 72px), transparent calc(100% - 24px)" : "black"})`,
                }
              : undefined
          }
          onWheel={onTurnStripWheel}
        >
          <button
            type="button"
            className="shrink-0 rounded-md"
            onClick={() => selectWorkingTreeDiff("unstaged")}
            data-turn-chip-selected={selectedDiffSource === "unstaged"}
          >
            <div
              className={cn(
                "rounded-md border px-2 py-1 text-left transition-colors",
                selectedDiffSource === "unstaged"
                  ? "border-border bg-accent text-accent-foreground"
                  : "border-border/70 bg-background/70 text-muted-foreground/80 hover:border-border hover:text-foreground/80",
              )}
            >
              <div className="text-[10px] leading-tight font-medium">Unstaged</div>
            </div>
          </button>
          <button
            type="button"
            className="shrink-0 rounded-md"
            onClick={() => selectWorkingTreeDiff("staged")}
            data-turn-chip-selected={selectedDiffSource === "staged"}
          >
            <div
              className={cn(
                "rounded-md border px-2 py-1 text-left transition-colors",
                selectedDiffSource === "staged"
                  ? "border-border bg-accent text-accent-foreground"
                  : "border-border/70 bg-background/70 text-muted-foreground/80 hover:border-border hover:text-foreground/80",
              )}
            >
              <div className="text-[10px] leading-tight font-medium">Staged</div>
            </div>
          </button>
          <button
            type="button"
            className="shrink-0 rounded-md"
            onClick={selectWholeConversation}
            data-turn-chip-selected={selectedDiffSource === null && selectedTurnId === null}
          >
            <div
              className={cn(
                "rounded-md border px-2 py-1 text-left transition-colors",
                selectedDiffSource === null && selectedTurnId === null
                  ? "border-border bg-accent text-accent-foreground"
                  : "border-border/70 bg-background/70 text-muted-foreground/80 hover:border-border hover:text-foreground/80",
              )}
            >
              <div className="text-[10px] leading-tight font-medium">All turns</div>
            </div>
          </button>
          {orderedTurnDiffSummaries.map((summary) => (
            <button
              key={summary.turnId}
              type="button"
              className="shrink-0 rounded-md"
              onClick={() => selectTurn(summary.turnId)}
              title={summary.turnId}
              data-turn-chip-selected={summary.turnId === selectedTurn?.turnId}
            >
              <div
                className={cn(
                  "rounded-md border px-2 py-1 text-left transition-colors",
                  summary.turnId === selectedTurn?.turnId
                    ? "border-border bg-accent text-accent-foreground"
                    : "border-border/70 bg-background/70 text-muted-foreground/80 hover:border-border hover:text-foreground/80",
                )}
              >
                <div className="flex items-center gap-1">
                  <span className="text-[10px] leading-tight font-medium">
                    Turn{" "}
                    {summary.checkpointTurnCount ??
                      inferredCheckpointTurnCountByTurnId[summary.turnId] ??
                      "?"}
                  </span>
                  <span className="text-[9px] leading-tight opacity-70">
                    {formatShortTimestamp(summary.completedAt, settings.timestampFormat)}
                  </span>
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
        <ToggleGroup
          className="shrink-0"
          variant="outline"
          size="xs"
          value={[diffRenderMode]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "stacked" || next === "split") {
              setDiffRenderMode(next);
            }
          }}
        >
          <Toggle aria-label="Stacked diff view" value="stacked">
            <Rows3Icon className="size-3" />
          </Toggle>
          <Toggle aria-label="Split diff view" value="split">
            <Columns2Icon className="size-3" />
          </Toggle>
        </ToggleGroup>
        <Toggle
          aria-label={diffWordWrap ? "Disable diff line wrapping" : "Enable diff line wrapping"}
          title={diffWordWrap ? "Disable line wrapping" : "Enable line wrapping"}
          variant="outline"
          size="xs"
          pressed={diffWordWrap}
          onPressedChange={(pressed) => {
            setDiffWordWrap(Boolean(pressed));
          }}
        >
          <TextWrapIcon className="size-3" />
        </Toggle>
        <Toggle
          aria-label={diffIgnoreWhitespace ? "Show whitespace changes" : "Hide whitespace changes"}
          title={diffIgnoreWhitespace ? "Show whitespace changes" : "Hide whitespace changes"}
          variant="outline"
          size="xs"
          pressed={diffIgnoreWhitespace}
          onPressedChange={(pressed) => {
            setDiffIgnoreWhitespace(Boolean(pressed));
          }}
        >
          <PilcrowIcon className="size-3" />
        </Toggle>
        {mode === "sheet" ? (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Close diff"
            title="Close diff"
            onClick={closeDiffPanel}
          >
            <PanelRightCloseIcon className="size-3.5" />
          </Button>
        ) : null}
      </div>
    </>
  );

  return (
    <>
      <DiffPanelShell mode={mode} header={headerRow}>
        {!activeDiffContext ? (
          <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
            Select a thread to inspect turn diffs.
          </div>
        ) : !isGitRepo ? (
          <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
            Turn diffs are unavailable because this project is not a git repository.
          </div>
        ) : orderedTurnDiffSummaries.length === 0 && !isWorkingTreeSelection ? (
          <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
            No completed turns yet.
          </div>
        ) : (
          <>
            {selectedTurnAttributionNote ? (
              <p className="border-b border-border/60 px-4 py-1.5 text-[11px] text-muted-foreground/75">
                {selectedTurnAttributionNote}
              </p>
            ) : null}
            <div
              ref={patchViewportRef}
              className="diff-panel-viewport min-h-0 min-w-0 flex-1 overflow-hidden"
            >
              {selectedDiffError && !renderablePatch && (
                <div className="px-3">
                  <p className="mb-2 text-[11px] text-red-500/80">{selectedDiffError}</p>
                </div>
              )}
              {!renderablePatch ? (
                isLoadingSelectedDiff ? (
                  <DiffPanelLoadingState
                    label={
                      isWorkingTreeSelection
                        ? "Loading working tree diff..."
                        : "Loading checkpoint diff..."
                    }
                  />
                ) : (
                  <div className="flex h-full items-center justify-center px-3 py-2 text-xs text-muted-foreground/70">
                    <p>
                      {hasNoNetChanges
                        ? "No net changes in this selection."
                        : "No patch available for this selection."}
                    </p>
                  </div>
                )
              ) : renderablePatch.kind === "files" ? (
                <Virtualizer
                  className="diff-render-surface h-full min-h-0 overflow-auto px-2 pb-2"
                  config={{
                    overscrollSize: 600,
                    intersectionObserverMargin: 1200,
                  }}
                >
                  {renderableFiles.map((fileDiff) => {
                    const filePath = resolveFileDiffPath(fileDiff);
                    const fileKey = buildFileDiffRenderKey(fileDiff);
                    const themedFileKey = `${fileKey}:${resolvedTheme}`;
                    const collapsed = collapsedDiffFileKeys.has(fileKey);
                    const imagePreviewObjectId = resolveFileDiffPreviewObjectId(fileDiff);
                    const imagePreviewUrl =
                      activeDiffContext?.environmentId &&
                      activeCwd &&
                      isWorkspaceImagePreviewPath(filePath)
                        ? (resolveWorkspaceGitImagePreviewUrl({
                            environmentId: activeDiffContext.environmentId,
                            cwd: activeCwd,
                            relativePath: filePath,
                            objectId: imagePreviewObjectId,
                          }) ??
                          (fileDiff.type !== "deleted"
                            ? resolveWorkspaceImagePreviewUrl({
                                environmentId: activeDiffContext.environmentId,
                                cwd: activeCwd,
                                relativePath: filePath,
                              })
                            : null))
                        : null;
                    const shouldRenderImagePreview =
                      isWorkspaceImagePreviewPath(filePath) && imagePreviewUrl !== null;
                    return (
                      <div
                        key={themedFileKey}
                        data-diff-file-path={filePath}
                        className="diff-render-file group/diff-file mb-2 rounded-md first:mt-2 last:mb-0"
                        onClickCapture={(event) => {
                          const nativeEvent = event.nativeEvent as MouseEvent;
                          const composedPath = nativeEvent.composedPath?.() ?? [];
                          const clickedHeader = composedPath.some((node) => {
                            if (!(node instanceof Element)) return false;
                            return node.hasAttribute("data-title");
                          });
                          if (!clickedHeader) return;
                          openDiffFileInEditor(filePath);
                        }}
                      >
                        <FileDiff
                          fileDiff={fileDiff}
                          renderHeaderPrefix={() => (
                            <button
                              type="button"
                              className={cn(
                                "inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent p-0 transition-colors hover:bg-foreground/10 focus-visible:outline-hidden",
                                getDiffCollapseIconClassName(fileDiff),
                              )}
                              aria-label={collapsed ? `Expand ${filePath}` : `Collapse ${filePath}`}
                              aria-expanded={!collapsed}
                              title={collapsed ? "Expand diff" : "Collapse diff"}
                              onClick={(event) => {
                                event.stopPropagation();
                                toggleDiffFileCollapsed(fileKey);
                              }}
                            >
                              {collapsed ? (
                                <ChevronRightIcon className="size-4" />
                              ) : (
                                <ChevronDownIcon className="size-4" />
                              )}
                            </button>
                          )}
                          renderHeaderMetadata={() => (
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <Button
                                    type="button"
                                    size="icon-xs"
                                    variant="ghost"
                                    aria-label={`Preview ${filePath}`}
                                    className="size-5 text-muted-foreground/75 hover:text-foreground"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      openDiffFilePreview(filePath);
                                    }}
                                  />
                                }
                              >
                                <FileSearchIcon className="size-3.5" />
                              </TooltipTrigger>
                              <TooltipPopup className="pointer-events-none" side="bottom">
                                Preview file
                              </TooltipPopup>
                            </Tooltip>
                          )}
                          options={{
                            collapsed: collapsed || shouldRenderImagePreview,
                            diffStyle: diffRenderMode === "split" ? "split" : "unified",
                            lineDiffType: "none",
                            overflow: diffWordWrap ? "wrap" : "scroll",
                            theme: resolveDiffThemeName(resolvedTheme),
                            themeType: resolvedTheme as DiffThemeType,
                            unsafeCSS: DIFF_PANEL_UNSAFE_CSS,
                          }}
                        />
                        {!collapsed && shouldRenderImagePreview ? (
                          <DiffImagePreview
                            filePath={filePath}
                            imageUrl={imagePreviewUrl}
                            type={fileDiff.type}
                          />
                        ) : null}
                      </div>
                    );
                  })}
                </Virtualizer>
              ) : (
                <div className="h-full overflow-auto p-2">
                  <div className="space-y-2">
                    <p className="text-[15px] text-muted-foreground/75 md:text-[11px]">
                      {renderablePatch.reason}
                    </p>
                    <pre
                      className={cn(
                        "max-h-[72vh] rounded-md border border-border/70 bg-background/70 p-3 font-mono text-[15px] leading-relaxed text-muted-foreground/90 md:text-[11px]",
                        diffWordWrap
                          ? "overflow-auto whitespace-pre-wrap wrap-break-word"
                          : "overflow-auto",
                      )}
                    >
                      {renderablePatch.text}
                    </pre>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </DiffPanelShell>
    </>
  );
}
