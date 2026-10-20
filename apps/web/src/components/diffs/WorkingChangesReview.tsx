import { OptimisticReviewMutationQueue } from "@t3tools/client-runtime/review-mutation-queue";
import type { FileDiffMetadata } from "@pierre/diffs";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import {
  orderReviewFiles,
  reviewPatchHunks,
  reviewHunkPatch,
  reviewSelectedLinesPatch,
  reviewFolderContains,
} from "@t3tools/client-runtime/review-workspace";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import type { DraftId } from "~/composerDraftStore";
import { reviewEnvironment } from "~/state/review";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { useTheme } from "~/hooks/useTheme";
import { useResizableWidth } from "~/hooks/useResizableWidth";
import { createGitDiffFileContentsLoader } from "~/lib/diffFileContents";
import {
  buildFileDiffIdentityKey,
  fnv1a32,
  getRenderablePatch,
  getDiffLineStat,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from "~/lib/diffRendering";
import {
  Files,
  GitBranch,
  ChevronDown,
  GitCommitHorizontal,
  Sparkles,
  FilePlus,
  FileMinus,
  Plus,
  Minus,
  Undo2,
} from "lucide";
import { WorkingChangesTree } from "./WorkingChangesTree";
import { Badge } from "../ui/badge";
import { DiffStatLabel } from "../chat/DiffStatLabel";
import { InputGroup, InputGroupAddon, InputGroupTextarea } from "../ui/input-group";
import { Group, GroupSeparator } from "../ui/group";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../ui/dialog";
import { MorphIcon } from "../MorphIcon";
import { ToggleGroup, Toggle } from "../ui/toggle-group";
import { RightPanelResizeHandle } from "../preview/RightPanelResizeHandle";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { AnnotatableCodeView, type AnnotatableCodeViewHandle } from "./AnnotatableCodeView";
import FileBrowserPanel from "../files/FileBrowserPanel";
import { WorkspaceSourcePreview } from "../files/WorkspaceSourcePreview";
import { diffFileTreeEntries } from "./diffFileTree.logic";
import { useReviewFilePatches } from "./useReviewFilePatches";
import { applyWorkingChangesMutation, type WorkingChangesState } from "./workingChangesState";
import { reviewDiffEdits } from "@t3tools/client-runtime/review-diff-context";
import { hideWhitespaceChanges } from "~/lib/diffRendering";

interface WorkingReviewProps {
  environmentId: EnvironmentId;
  cwd: string;
  composerDraftTarget: ScopedThreadRef | DraftId;
  wordWrap: boolean;
  split: boolean;
  ignoreWhitespace: boolean;
  fileTreeOpen: boolean;
  revision: string | null;
  onChanged: () => void;
  navigationKey?: string;
  projectName: string;
  onOpenFile: (path: string) => void;
}

type WorkingScope = "staged" | "unstaged";

type WorkingSelection = { scope: WorkingScope; path: string | null };
type WorkingNavigation = {
  view: "files" | "git";
  selection: WorkingSelection;
  folded: ReadonlySet<string>;
  message: string;
  workspacePath: string | null;
};
// Thread switches unmount the pane, so remember its scoped selection independently of its query cache.
const workingNavigation = new Map<string, WorkingNavigation>();

/** The same diff data powers a combined file list and the index/working-copy trees. */
function useWorkingChanges(
  props: WorkingReviewProps,
  scope: WorkingScope | undefined,
  generation: number,
) {
  const { environmentId, cwd } = props;
  const { resolvedTheme } = useTheme();
  const query = useEnvironmentQuery(
    reviewEnvironment.diffPreview({
      environmentId,
      input: { cwd, ...(scope ? { workingTreeScope: scope } : {}) },
    }),
  );
  const refresh = query.refresh;
  const revision = props.revision;
  useEffect(() => {
    refresh();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Git status revisions and completed staging actions request a fresh preview.
  }, [refresh, revision, generation]);
  const source = query.data?.sources.find((source) => source.kind === "working-tree") ?? null;
  const parsed = source ? getRenderablePatch(source.diff, `${scope}:${source.diffHash}`) : null;
  const patches = useReviewFilePatches({
    environmentId,
    cwd,
    source: source?.files ? source : null,
    baseRef: null,
    ignoreWhitespace: false,
    theme: resolvedTheme,
    revision: source?.diffHash,
    preview: parsed,
    workingTreeScope: scope,
  });
  const files = orderReviewFiles(patches.renderableFiles, resolveFileDiffPath);
  const getContents = useAtomCommand(reviewEnvironment.diffFileContents);
  const loadDiffFiles = createGitDiffFileContentsLoader(getContents, {
    environmentId,
    cwd,
    sourceKind: "working-tree",
    ...(scope ? { workingTreeScope: scope } : {}),
    baseRef: "HEAD",
    headRef: null,
    cacheKey: `${scope ?? "all"}:${source?.diffHash ?? ""}`,
  });
  const hunksByPath = new Map(
    [...(source ? [source.diff] : []), ...patches.rawPatches]
      .flatMap((patch) => reviewPatchHunks(patch))
      .flatMap((entry) => {
        const parsed = getRenderablePatch(entry.filePatch, `${scope}:${fnv1a32(entry.filePatch)}`);
        return parsed?.kind === "files"
          ? parsed.files.map((file) => [resolveFileDiffPath(file), entry.hunks] as const)
          : [];
      }),
  );
  return { files, source, patches, query, loadDiffFiles, hunksByPath };
}

export function WorkingChangesReview(props: WorkingReviewProps) {
  const { environmentId, cwd, composerDraftTarget, fileTreeOpen } = props;
  const { resolvedTheme } = useTheme();
  const [generation, setGeneration] = useState(0);
  const navigationKey = props.navigationKey ?? JSON.stringify([environmentId, composerDraftTarget]);
  const remembered = workingNavigation.get(navigationKey);
  const [chosenView, setView] = useState<"files" | "git" | null>(remembered?.view ?? null);
  const [selection, setSelection] = useState<WorkingSelection>(
    remembered?.selection ?? { scope: "unstaged", path: null },
  );
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => remembered?.folded ?? new Set());
  const [pending, setPending] = useState(false);
  const [stagingCount, setStagingCount] = useState(0);
  const stagingCountRef = useRef(0);
  type StagingMutation = {
    scope: WorkingScope;
    paths: string[];
    patch?: string;
    revert?: boolean;
    retainContext: boolean;
    combined: WorkingChangesState["staged"];
  };
  const stagingQueue = useRef<OptimisticReviewMutationQueue<
    WorkingChangesState,
    StagingMutation
  > | null>(null);
  const stagingState = useRef<WorkingChangesState | null>(null);
  const [viewer, setViewer] = useState<AnnotatableCodeViewHandle | null>(null);
  const [message, setMessage] = useState(remembered?.message ?? "");
  const [workspacePath, setWorkspacePath] = useState<string | null>(
    remembered?.workspacePath ?? null,
  );
  const [generatingMessage, setGeneratingMessage] = useState(false);
  const [reverting, setReverting] = useState<{
    paths: string[];
    label: string;
    patch?: string;
  } | null>(null);
  const all = useWorkingChanges(props, undefined, generation);
  const staged = useWorkingChanges(props, "staged", generation);
  const unstaged = useWorkingChanges(props, "unstaged", generation);
  const initialGitStatusReady = staged.query.data !== null && unstaged.query.data !== null;
  const initialChangedCount =
    (staged.source?.files?.length ?? staged.files.length) +
    (unstaged.source?.files?.length ?? unstaged.files.length);
  const view = chosenView ?? (initialGitStatusReady && initialChangedCount === 0 ? "files" : "git");
  // Choose once after the initial read. Later writes keep the current reader open.
  if (chosenView === null && initialGitStatusReady) setView(view);
  useLayoutEffect(() => {
    workingNavigation.set(navigationKey, { view, selection, folded, message, workspacePath });
  }, [navigationKey, view, selection, folded, message, workspacePath]);

  const [optimistic, setOptimistic] = useState<{
    state: WorkingChangesState;
    confirmed: boolean;
    stagedBefore: typeof staged.query.data;
    unstagedBefore: typeof unstaged.query.data;
    stagedUpdatedAt: number;
    unstagedUpdatedAt: number;
  } | null>(null);
  const [readerContext, setReaderContext] = useState<{
    selection: WorkingSelection;
    state: WorkingChangesState;
  } | null>(null);
  const busy = useRef(false);
  const refreshedScopes = useRef({ staged: false, unstaged: false });
  const queryData = useRef({
    staged: staged.query.data,
    unstaged: unstaged.query.data,
    stagedUpdatedAt: staged.query.dataUpdatedAt,
    unstagedUpdatedAt: unstaged.query.dataUpdatedAt,
  });
  useLayoutEffect(() => {
    queryData.current = {
      staged: staged.query.data,
      unstaged: unstaged.query.data,
      stagedUpdatedAt: staged.query.dataUpdatedAt,
      unstagedUpdatedAt: unstaged.query.dataUpdatedAt,
    };
  }, [
    staged.query.data,
    unstaged.query.data,
    staged.query.dataUpdatedAt,
    unstaged.query.dataUpdatedAt,
  ]);
  useEffect(() => {
    if (!optimistic?.confirmed) return;
    if (staged.query.isPending) refreshedScopes.current.staged = true;
    if (unstaged.query.isPending) refreshedScopes.current.unstaged = true;
    if (staged.query.isPending || unstaged.query.isPending) return;
    // A successful write stays projected if reading Git fails. Let the reader retry
    // without trapping every action behind a pending flag or rolling back the write.
    if (staged.query.error || unstaged.query.error) {
      if (busy.current) {
        busy.current = false;
        setPending(false);
      }
      return;
    }
    if (staged.patches.isPending || unstaged.patches.isPending) return;
    const stagedFresh =
      staged.query.dataUpdatedAt > optimistic.stagedUpdatedAt ||
      staged.query.data !== optimistic.stagedBefore ||
      refreshedScopes.current.staged;
    const unstagedFresh =
      unstaged.query.dataUpdatedAt > optimistic.unstagedUpdatedAt ||
      unstaged.query.data !== optimistic.unstagedBefore ||
      refreshedScopes.current.unstaged;
    if (stagedFresh && unstagedFresh) {
      setOptimistic(null);
      stagingState.current = null;
      if (busy.current) {
        busy.current = false;
        setPending(false);
      }
    }
  }, [
    optimistic,
    staged.query.data,
    unstaged.query.data,
    staged.query.dataUpdatedAt,
    unstaged.query.dataUpdatedAt,
    staged.query.isPending,
    unstaged.query.isPending,
    staged.query.error,
    unstaged.query.error,
    staged.patches.isPending,
    unstaged.patches.isPending,
  ]);
  const scopes = {
    staged: { ...staged, ...optimistic?.state.staged },
    unstaged: { ...unstaged, ...optimistic?.state.unstaged },
  };
  const scope = selection.scope;
  const retained =
    view === "git" && selection.path !== null && readerContext?.selection === selection
      ? readerContext.state[scope]
      : null;
  const authoritativeReaderFiles = (view === "files" ? all : scopes[scope]).files;
  const readerFiles = (() => {
    const actual = authoritativeReaderFiles;
    if (!retained) return actual;
    const previous = new Map(
      [...retained.files, ...(retained.retainedFiles ?? [])].map((file) => [
        resolveFileDiffPath(file),
        file,
      ]),
    );
    const result = actual.map((file) => {
      const remembered = previous.get(resolveFileDiffPath(file));
      return remembered &&
        (file.cacheKey?.endsWith(":pending") ||
          reviewDiffEdits(remembered) === reviewDiffEdits(file))
        ? remembered
        : file;
    });
    for (const file of retained.retainedFiles ?? []) {
      if (
        reviewDiffEdits(file) === "[]" &&
        !actual.some((candidate) => resolveFileDiffPath(candidate) === resolveFileDiffPath(file))
      )
        result.push(file);
    }
    return orderReviewFiles(result, resolveFileDiffPath);
  })();
  const selectedPath =
    selection.path && readerFiles.some((file) => resolveFileDiffPath(file) === selection.path)
      ? selection.path
      : null;
  const data = view === "files" ? all : scopes[scope];
  const files =
    view === "git" && selectedPath
      ? readerFiles.filter((file) => resolveFileDiffPath(file) === selectedPath)
      : readerFiles;
  const requestFile = data.patches.requestFile;
  useEffect(() => {
    if (!selectedPath) return;
    const index = data.files.findIndex((file) => resolveFileDiffPath(file) === selectedPath);
    if (index >= 0) requestFile(index);
  }, [data.files, requestFile, selectedPath]);
  const changedCount = new Set(
    [...scopes.staged.files, ...scopes.unstaged.files].map(resolveFileDiffPath),
  ).size;
  const stagedEntries = diffFileTreeEntries(scopes.staged.files);
  const unstagedEntries = diffFileTreeEntries(scopes.unstaged.files);
  const workspaceGitChanges = [
    ...new Map(
      [...stagedEntries, ...unstagedEntries, ...diffFileTreeEntries(all.files)].map((entry) => [
        entry.path,
        entry,
      ]),
    ).values(),
  ];
  const canCommit = useAtomValue(reviewEnvironment.commit.permissionAtom(environmentId));
  const canRevert = useAtomValue(reviewEnvironment.revert.permissionAtom(environmentId));
  const commit = useAtomCommand(reviewEnvironment.commit, { reportFailure: false });
  const revert = useAtomCommand(reviewEnvironment.revert, { reportFailure: false });
  const canGenerate = useAtomValue(
    reviewEnvironment.generateCommitMessage.permissionAtom(environmentId),
  );
  const generateMessage = useAtomCommand(reviewEnvironment.generateCommitMessage, {
    reportFailure: false,
  });
  const generatePreview = async () => {
    if (pending || stagingCountRef.current > 0 || !canGenerate || staged.files.length === 0) return;
    setPending(true);
    setGeneratingMessage(true);
    const result = await generateMessage({ environmentId, input: { cwd } });
    setPending(false);
    setGeneratingMessage(false);
    if (result._tag === "Success") setMessage(result.value);
    else
      toastManager.add({
        type: "error",
        title: "Could not generate a commit message",
        description: "Check your source-control writing model in Settings and try again.",
      });
  };
  const runCommit = async (action: "commit" | "amend" | "commit-push" = "commit") => {
    if (
      pending ||
      stagingCountRef.current > 0 ||
      !canCommit ||
      (staged.files.length === 0 && (action !== "amend" || !message.trim()))
    )
      return;
    setPending(true);
    const result = await commit({ environmentId, input: { cwd, message, action } });
    setPending(false);
    setGeneration((value) => value + 1);
    props.onChanged();
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Could not commit",
        description:
          "Check your staged changes and Git or source-control writer settings, then try again.",
      });
    } else {
      setMessage("");
      toastManager.add({
        type: result.value.pushStatus === "failed" ? "error" : "success",
        title:
          result.value.pushStatus === "failed"
            ? "Committed, but push failed"
            : result.value.pushStatus === "pushed"
              ? "Committed and pushed"
              : "Committed",
        description:
          result.value.pushStatus === "failed"
            ? "Your commit is saved locally. Check the remote connection and retry pushing from the Git menu."
            : result.value.commitSha.slice(0, 7),
      });
    }
  };
  const runRevert = async () => {
    if (reverting?.patch) {
      updateStaging("unstaged", reverting.paths, reverting.patch, true);
      setReverting(null);
      return;
    }
    if (busy.current || pending || stagingCountRef.current > 0 || !canRevert || !reverting) return;
    busy.current = true;
    refreshedScopes.current = { staged: false, unstaged: false };
    setPending(true);
    setOptimistic({
      state: applyWorkingChangesMutation(scopes, all, {
        scope: "unstaged",
        paths: reverting.paths,
        revert: true,
      }),
      confirmed: false,
      stagedBefore: staged.query.data,
      unstagedBefore: unstaged.query.data,
      stagedUpdatedAt: staged.query.dataUpdatedAt,
      unstagedUpdatedAt: unstaged.query.dataUpdatedAt,
    });
    const result = await revert({ environmentId, input: { cwd, paths: reverting.paths } });
    setReverting(null);
    if (result._tag === "Failure") {
      setOptimistic(null);
      busy.current = false;
      setPending(false);
      toastManager.add({
        type: "error",
        title: "Could not revert changes",
        description: "Refresh the diff and try again.",
      });
    } else {
      setOptimistic((current) =>
        current
          ? {
              ...current,
              confirmed: true,
              stagedBefore: queryData.current.staged,
              unstagedBefore: queryData.current.unstaged,
              stagedUpdatedAt: queryData.current.stagedUpdatedAt,
              unstagedUpdatedAt: queryData.current.unstagedUpdatedAt,
            }
          : null,
      );
      props.onChanged();
    }
    setGeneration((value) => value + 1);
  };
  const canStage = useAtomValue(reviewEnvironment.setStaged.permissionAtom(environmentId));
  const stage = useAtomCommand(reviewEnvironment.setStaged, { reportFailure: false });
  const updateStaging = (
    scope: WorkingScope,
    paths: string[],
    patch?: string,
    revertingPatch = false,
  ) => {
    if (pending || !(revertingPatch ? canRevert : canStage) || paths.length === 0) return;
    const current = stagingState.current ?? scopes;
    const displayed = {
      ...current,
      [scope]: {
        ...current[scope],
        files: current[scope].files.map((file) => {
          const item = view === "git" ? viewer?.getItem(buildFileDiffIdentityKey(file)) : undefined;
          return item?.type === "diff" && reviewDiffEdits(item.fileDiff) === reviewDiffEdits(file)
            ? item.fileDiff
            : file;
        }),
      },
    };
    if (stagingCountRef.current === 0) {
      stagingQueue.current = new OptimisticReviewMutationQueue(displayed, {
        apply: (state, mutation) => applyWorkingChangesMutation(state, mutation.combined, mutation),
        send: async ({ scope, paths, patch, revert: revertingPatch }) => {
          const result = revertingPatch
            ? await revert({
                environmentId,
                // Older servers reject an empty selection instead of ignoring the patch
                // and reverting a whole file. The patch supplies its own file paths.
                input: { cwd, paths: [], ...(patch ? { patch } : {}) },
              })
            : await stage({
                environmentId,
                input: {
                  cwd,
                  paths: [...new Set(paths)],
                  staged: scope === "unstaged",
                  ...(patch ? { patch } : {}),
                },
              });
          return result._tag === "Success";
        },
        onSnapshot: (state, pendingCount) => {
          stagingState.current = state;
          stagingCountRef.current = pendingCount;
          setStagingCount(pendingCount);
          setReaderContext((current) => ({ selection: current?.selection ?? selection, state }));
          refreshedScopes.current = { staged: false, unstaged: false };
          setOptimistic({
            state,
            confirmed: pendingCount === 0,
            stagedBefore: queryData.current.staged,
            unstagedBefore: queryData.current.unstaged,
            stagedUpdatedAt: queryData.current.stagedUpdatedAt,
            unstagedUpdatedAt: queryData.current.unstagedUpdatedAt,
          });
          if (pendingCount === 0) {
            props.onChanged();
            setGeneration((value) => value + 1);
          }
        },
        onFailure: () =>
          toastManager.add({
            type: "error",
            title: "Could not update changes",
            description: "The failed action was rolled back. Your other changes have been kept.",
          }),
      });
    }
    setReaderContext({ selection, state: displayed });
    stagingQueue.current!.enqueue({
      scope,
      paths,
      ...(patch ? { patch } : {}),
      revert: revertingPatch,
      retainContext: view === "git" && selection.path !== null,
      combined: all,
    });
  };
  const stagingPaths = (scope: WorkingScope, path: string) =>
    scopes[scope].files.flatMap((file) =>
      resolveFileDiffPath(file) === path || reviewFolderContains(path, resolveFileDiffPath(file))
        ? [resolveFileDiffPath(file), ...(file.prevName ? [file.prevName] : [])]
        : [],
    );
  const selectFile = (scope: WorkingScope, path: string) => {
    setSelection({ scope, path });
    const target = view === "files" ? all : scopes[scope];
    const index = target.files.findIndex((file) => resolveFileDiffPath(file) === path);
    if (index < 0) return;
    target.patches.requestFile(index);
    setFolded((current) => new Set([...current].filter((entry) => entry !== path)));
    if (view === "files")
      viewer?.scrollTo({
        type: "item",
        id: buildFileDiffIdentityKey(target.files[index]!),
        align: "start",
      });
  };
  const width = useResizableWidth({
    storageKey: "t3code:working-diff-tree-width",
    defaultWidth: 320,
    minWidth: 192,
    maxWidth: 640,
    edge: "left",
  });
  const codeFiles = files.map((fileDiff) => ({
    fileDiff: props.ignoreWhitespace ? hideWhitespaceChanges(fileDiff) : fileDiff,
    filePath: resolveFileDiffPath(fileDiff),
    fileKey: buildFileDiffIdentityKey(fileDiff),
    fileVersion: fnv1a32(`${props.ignoreWhitespace}:${JSON.stringify(fileDiff)}`),
    collapsed:
      folded.has(resolveFileDiffPath(fileDiff)) || fileDiff.cacheKey?.endsWith(":pending") === true,
  }));
  const renderActions = (file: FileDiffMetadata) => {
    const path = resolveFileDiffPath(file);
    if (view === "files") return null;
    if (!scopes[scope].files.some((candidate) => resolveFileDiffPath(candidate) === path))
      return null;
    return (
      <>
        <Button
          size="xs"
          variant="outline"
          disabled={!canStage || pending}
          aria-label={`${scope === "unstaged" ? "Stage" : "Unstage"} ${path}`}
          onClick={() => void updateStaging(scope, stagingPaths(scope, path))}
        >
          <MorphIcon icon={scope === "unstaged" ? FilePlus : FileMinus} />
          {scope === "unstaged" ? "Stage file" : "Unstage file"}
        </Button>
      </>
    );
  };
  const viewTabs = (
    <ToggleGroup
      className="w-full"
      value={[view]}
      onValueChange={(values) => {
        const next = values[0];
        if (next === "files" || next === "git") {
          if (next === "files" && selection.path) setWorkspacePath(selection.path);
          setView(next);
        }
      }}
      aria-label="Workspace navigation"
    >
      <Toggle value="git" className="flex-1">
        <MorphIcon icon={GitBranch} />
        Git
        <Badge size="sm" variant="info" aria-label={`${changedCount} changed files`}>
          {changedCount}
        </Badge>
      </Toggle>
      <Toggle value="files" className="flex-1">
        <MorphIcon icon={Files} />
        Files
      </Toggle>
    </ToggleGroup>
  );
  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      style={{ "--resizable-width": `${width.width}px` } as React.CSSProperties}
    >
      <div className="flex h-10 shrink-0 border-b border-border/60 bg-background">
        <div className="flex min-w-0 flex-1 items-center gap-2 px-3 text-xs text-muted-foreground">
          <span className="truncate">
            {view === "git"
              ? scope === "staged"
                ? "Staged"
                : "Unstaged"
              : (workspacePath ?? "Workspace files")}
          </span>
          {!fileTreeOpen ? viewTabs : null}
        </div>
        {fileTreeOpen ? (
          <div className="flex w-(--resizable-width) min-w-48 max-w-[60%] shrink-0 items-center border-l border-border/60 px-2">
            {viewTabs}
          </div>
        ) : null}
      </div>
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {view === "files" ? (
            <WorkspaceSourcePreview
              environmentId={environmentId}
              cwd={cwd}
              path={workspacePath}
              revision={props.revision}
              onOpenFile={props.onOpenFile}
            />
          ) : (
            <>
              {data.query.error ? (
                <div className="flex shrink-0 items-center gap-2 px-3 py-2 text-xs">
                  <p>{data.query.error}</p>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => setGeneration((value) => value + 1)}
                  >
                    Retry
                  </Button>
                </div>
              ) : null}
              {files.length === 0 ? (
                <p className="px-3 py-4 text-xs text-muted-foreground">
                  {!optimistic && data.query.isPending ? "Loading changes…" : "No changes."}
                </p>
              ) : (
                <AnnotatableCodeView
                  pendingFiles={[]}
                  codeViewKey={`${cwd}:${view}:${view === "git" ? `${scope}:${selectedPath ?? "all"}` : "all"}`}
                  sectionId={view === "git" ? scope : "working-tree"}
                  sectionTitle={view === "git" ? scope : "Uncommitted"}
                  composerDraftTarget={composerDraftTarget}
                  files={codeFiles}
                  viewerRef={setViewer}
                  className="min-h-0 flex-1 overflow-auto"
                  stageLinesAction={
                    view === "git" ? (scope === "unstaged" ? "stage" : "unstage") : undefined
                  }
                  canStageLines={(file, range) =>
                    canStage &&
                    !pending &&
                    Boolean(
                      reviewSelectedLinesPatch(
                        data.hunksByPath.get(resolveFileDiffPath(file)) ?? [],
                        range,
                        scope === "staged",
                        props.split ? "split" : "unified",
                      ),
                    )
                  }
                  onStageLines={
                    view === "git"
                      ? (file, range) => {
                          const path = resolveFileDiffPath(file);
                          const patch = reviewSelectedLinesPatch(
                            data.hunksByPath.get(path) ?? [],
                            range,
                            scope === "staged",
                            props.split ? "split" : "unified",
                          );
                          if (patch) void updateStaging(scope, stagingPaths(scope, path), patch);
                        }
                      : undefined
                  }
                  canRevertLines={(file, range) =>
                    canRevert &&
                    !pending &&
                    Boolean(
                      reviewSelectedLinesPatch(
                        data.hunksByPath.get(resolveFileDiffPath(file)) ?? [],
                        range,
                        true,
                        props.split ? "split" : "unified",
                      ),
                    )
                  }
                  onRevertLines={
                    view === "git" && scope === "unstaged"
                      ? (file, range) => {
                          const path = resolveFileDiffPath(file);
                          const patch = reviewSelectedLinesPatch(
                            data.hunksByPath.get(path) ?? [],
                            range,
                            true,
                            props.split ? "split" : "unified",
                          );
                          if (patch)
                            setReverting({
                              paths: stagingPaths(scope, path),
                              patch,
                              label: `the selected ${range.start === range.end ? "line" : "lines"} in ${path}`,
                            });
                        }
                      : undefined
                  }
                  renderHunkAction={
                    view === "git"
                      ? (file, index) => {
                          const path = resolveFileDiffPath(file);
                          const patch = reviewHunkPatch(
                            data.hunksByPath.get(path) ?? [],
                            file.hunks[index]?.hunkSpecs ?? "",
                          );
                          return patch ? (
                            <div className="flex justify-end gap-1 px-3 py-0.5 font-sans">
                              {scope === "unstaged" ? (
                                <Button
                                  size="xs"
                                  variant="ghost-muted"
                                  disabled={!canRevert || pending}
                                  aria-label={`Revert hunk ${index + 1} in ${path}`}
                                  onClick={() =>
                                    setReverting({
                                      paths: stagingPaths(scope, path),
                                      patch,
                                      label: `hunk ${index + 1} in ${path}`,
                                    })
                                  }
                                >
                                  <MorphIcon icon={Undo2} />
                                  Revert hunk
                                </Button>
                              ) : null}
                              <Button
                                size="xs"
                                variant="ghost"
                                disabled={!canStage || pending}
                                aria-label={`${scope === "unstaged" ? "Stage" : "Unstage"} hunk ${index + 1} in ${path}`}
                                onClick={() =>
                                  void updateStaging(scope, stagingPaths(scope, path), patch)
                                }
                              >
                                <MorphIcon icon={scope === "unstaged" ? Plus : Minus} />
                                {scope === "unstaged" ? "Stage hunk" : "Unstage hunk"}
                              </Button>
                            </div>
                          ) : null;
                        }
                      : undefined
                  }
                  renderHeaderFilenameSuffix={renderActions}
                  renderHeaderMetadata={(file) => {
                    const stat = file.cacheKey?.endsWith(":pending")
                      ? data.source?.files?.find((stat) => stat.path === resolveFileDiffPath(file))
                      : null;
                    return <DiffStatLabel {...(stat ?? getDiffLineStat([file]))} layout="inline" />;
                  }}
                  renderHeaderPrefix={(file) => (
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Toggle ${resolveFileDiffPath(file)}`}
                      onClick={() => {
                        if (file.cacheKey?.endsWith(":pending")) {
                          if (data.patches.fileStates.get(resolveFileDiffPath(file))?.error)
                            data.patches.retry(resolveFileDiffPath(file));
                          requestFile(
                            data.files.findIndex(
                              (candidate) =>
                                resolveFileDiffPath(candidate) === resolveFileDiffPath(file),
                            ),
                          );
                          setFolded(
                            (current) =>
                              new Set(
                                [...current].filter((path) => path !== resolveFileDiffPath(file)),
                              ),
                          );
                          return;
                        }
                        setFolded((current) => {
                          const next = new Set(current);
                          const path = resolveFileDiffPath(file);
                          if (next.has(path)) next.delete(path);
                          else next.add(path);
                          return next;
                        });
                      }}
                    >
                      {folded.has(resolveFileDiffPath(file)) || file.cacheKey?.endsWith(":pending")
                        ? "▸"
                        : "▾"}
                    </Button>
                  )}
                  onRevealSearchMatch={(key) => {
                    const file = files.find((file) => buildFileDiffIdentityKey(file) === key);
                    if (file)
                      setFolded(
                        (current) =>
                          new Set(
                            [...current].filter((path) => path !== resolveFileDiffPath(file)),
                          ),
                      );
                  }}
                  options={{
                    diffStyle: props.split ? "split" : "unified",
                    overflow: props.wordWrap ? "wrap" : "scroll",
                    theme: resolveDiffThemeName(resolvedTheme),
                    themeType: resolvedTheme,
                    ...(optimistic ? {} : { loadDiffFiles: data.loadDiffFiles }),
                  }}
                />
              )}
              {data.patches.settledFileCount < data.files.length && !selectedPath ? (
                <Button size="xs" variant="ghost" onClick={data.patches.loadNextFiles}>
                  Load more files
                </Button>
              ) : null}
            </>
          )}
        </div>
        {fileTreeOpen ? (
          <aside
            aria-label="Changed files panel"
            className="relative flex w-(--resizable-width) min-w-48 max-w-[60%] shrink-0 flex-col border-l border-border/60"
            style={{ "--resizable-width": `${width.width}px` } as React.CSSProperties}
          >
            <RightPanelResizeHandle handlers={width.handlers} />
            {view === "files" ? (
              <FileBrowserPanel
                environmentId={environmentId}
                cwd={cwd}
                projectName={props.projectName}
                selectedPath={workspacePath}
                selectedPathRevealId={0}
                workspaceMutationId={props.revision}
                gitChanges={workspaceGitChanges}
                onOpenFile={setWorkspacePath}
              />
            ) : (
              <>
                <div className="flex shrink-0 flex-col gap-1 px-2 py-1.5">
                  <InputGroup size="compact" aria-label="Commit message field">
                    <InputGroupTextarea
                      rows={1}
                      aria-label="Commit message"
                      placeholder="Message (blank generates one)"
                      value={message}
                      disabled={pending || stagingCount > 0 || !canCommit}
                      onChange={(event) => setMessage(event.target.value)}
                      onKeyDown={(event) => {
                        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                          event.preventDefault();
                          void runCommit();
                        }
                      }}
                    />
                    {staged.files.length > 0 ? (
                      <InputGroupAddon align="inline-end">
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          disabled={pending || stagingCount > 0 || !canGenerate}
                          aria-label="Generate commit message"
                          aria-busy={generatingMessage}
                          onClick={() => void generatePreview()}
                        >
                          <MorphIcon icon={Sparkles} />
                        </Button>
                      </InputGroupAddon>
                    ) : null}
                  </InputGroup>
                  <Group className="w-full" aria-label="Commit actions">
                    <Button
                      size="sm"
                      className="min-w-0 flex-1"
                      disabled={
                        pending || stagingCount > 0 || !canCommit || staged.files.length === 0
                      }
                      onClick={() => void runCommit()}
                    >
                      <MorphIcon icon={GitCommitHorizontal} />
                      {generatingMessage
                        ? "Generating…"
                        : pending && !optimistic
                          ? "Working…"
                          : "Commit"}
                    </Button>
                    <GroupSeparator />
                    <Menu>
                      <MenuTrigger
                        render={
                          <Button
                            size="icon-sm"
                            disabled={pending || stagingCount > 0 || !canCommit}
                            aria-label="Commit options"
                          />
                        }
                      >
                        <MorphIcon icon={ChevronDown} />
                      </MenuTrigger>
                      <MenuPopup>
                        {(["commit", "amend", "commit-push"] as const).map((action) => (
                          <MenuItem
                            key={action}
                            disabled={
                              pending ||
                              stagingCount > 0 ||
                              !canCommit ||
                              (staged.files.length === 0 && (action !== "amend" || !message.trim()))
                            }
                            onClick={() => void runCommit(action)}
                          >
                            {action === "amend"
                              ? "Commit (Amend)"
                              : action === "commit-push"
                                ? "Commit & Push"
                                : "Commit"}
                          </MenuItem>
                        ))}
                      </MenuPopup>
                    </Menu>
                  </Group>
                </div>
                <WorkingChangesTree
                  staged={stagedEntries}
                  unstaged={unstagedEntries}
                  selected={selectedPath ? { scope, path: selectedPath } : null}
                  disabled={!canStage || pending}
                  revertDisabled={!canRevert || pending || stagingCount > 0}
                  onSelect={selectFile}
                  onViewAll={(scope) => {
                    setSelection({ scope, path: null });
                    setView("git");
                  }}
                  onStage={(scope, paths) => {
                    const selectedPaths = paths === null ? null : new Set(paths);
                    void updateStaging(
                      scope,
                      scopes[scope].files.flatMap((file) =>
                        selectedPaths === null || selectedPaths.has(resolveFileDiffPath(file))
                          ? [resolveFileDiffPath(file), ...(file.prevName ? [file.prevName] : [])]
                          : [],
                      ),
                    );
                  }}
                  onRevert={(paths) => {
                    const selectedPaths = paths === null ? null : new Set(paths);
                    setReverting({
                      paths: scopes.unstaged.files
                        .filter(
                          (file) =>
                            selectedPaths === null || selectedPaths.has(resolveFileDiffPath(file)),
                        )
                        .map(resolveFileDiffPath),
                      label:
                        paths === null
                          ? "all unstaged changes"
                          : paths.length === 1
                            ? paths[0]!
                            : `${paths.length} selected files`,
                    });
                  }}
                />
              </>
            )}
          </aside>
        ) : null}
      </div>
      <Dialog
        open={reverting !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setReverting(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Revert unstaged changes?</DialogTitle>
            <DialogDescription>
              This reverts {reverting?.patch ? "only " : "unstaged edits in "}
              {reverting?.label}. Staged changes are kept.
              {!reverting?.patch ? " Selected new, untracked files will be deleted." : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={pending} onClick={() => setReverting(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={pending || !canRevert || !reverting?.paths.length}
              onClick={() => void runRevert()}
            >
              Revert changes
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
