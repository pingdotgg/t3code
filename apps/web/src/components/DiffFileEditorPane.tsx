import Editor, { type Monaco, type OnMount } from "@monaco-editor/react";
import type { EnvironmentId, ProjectReadFileResult } from "@forma/contracts";
import type { FileDiffMetadata } from "@pierre/diffs";
import {
  IconExclamationmarkTriangle as AlertTriangleIcon,
  IconArrowLeft as ArrowLeftIcon,
  IconProgressIndicator as LoaderIcon,
  IconArrowClockwise as RefreshCwIcon,
  IconSquareAndArrowDown as SaveIcon,
  IconSquareAndArrowUp as OpenInIDEIcon,
} from "symbols-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { readEnvironmentApi } from "../environmentApi";
import {
  reconstructPreTurnFileContents,
  type PersistedDiffFileEditOverride,
} from "../lib/diffFileEditOverrides";
import { resolveEditorFileLabel } from "../lib/editorFileLabel";
import {
  getCodeContextSelectionLimitMessage,
  normalizeCodeContextSelection,
  type CodeContextSelection,
} from "../lib/codeContext";
import { resolveMonacoLanguage } from "../lib/monacoLanguage";
import { ensureAppMonacoTheme, ensureMonacoConfigured } from "../lib/monaco";
import {
  normalizeProjectFileEditError,
  resolveProjectFileEditorError,
  type ProjectFileEditorStatus,
} from "../lib/projectFileEditing";
import {
  invalidateProjectFileForEditor,
  loadProjectFileForEditor,
  peekProjectFileForEditor,
  storeProjectFileForEditor,
} from "../lib/projectFileReadCache";
import { useSettings } from "../hooks/useSettings";
import { getCodeEditorFontSize } from "../interfaceAppearance";
import { cn } from "../lib/utils";
import type { ResolvedThemeMode } from "../theme";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Kbd, KbdGroup } from "./ui/kbd";
import { toastManager } from "./ui/toast";

ensureMonacoConfigured();

export interface DiffFileEditorRequestedNavigation {
  nonce: number;
  type: "back" | "close-panel" | "show-diff" | "switch-file";
  filePath?: string | undefined;
}

type PendingNavigation =
  | {
      type: "back";
    }
  | {
      type: "close-panel";
    }
  | {
      type: "show-diff";
    }
  | {
      type: "switch-file";
      filePath: string;
    };

interface DiffFileEditorPaneProps {
  environmentId: EnvironmentId;
  cwd: string;
  sessionKey?: string | undefined;
  showHeader?: boolean | undefined;
  filePath: string;
  filePaths: readonly string[];
  fileDiff: FileDiffMetadata | null;
  initialOverride: PersistedDiffFileEditOverride | undefined;
  initialLine?: number | undefined;
  initialColumn?: number | undefined;
  navigationLabel: string;
  resolvedTheme: ResolvedThemeMode;
  onRequestBack: () => void;
  onRequestClosePanel?: (() => void) | undefined;
  onRequestShowDiff?: (() => void) | undefined;
  onRequestFilePathChange: (filePath: string) => void;
  requestedNavigation?: DiffFileEditorRequestedNavigation | null | undefined;
  requestedSaveNonce?: number | undefined;
  requestedDiscardNonce?: number | undefined;
  lineNumbersVisible?: boolean | undefined;
  wordWrapEnabled?: boolean | undefined;
  autoSaveEnabled?: boolean | undefined;
  onEditorControlsStateChange?:
    | ((
        state: Readonly<{
          canSave: boolean;
          filePath: string;
          isDirty: boolean;
          isSaving: boolean;
        }>,
      ) => void)
    | undefined;
  onOpenInEditor: (filePath: string) => void;
  onOpenPreview: (filePath: string) => void;
  previewDisabledReason: string | null;
  reuseMonacoModels?: boolean | undefined;
  onPersisted: (input: {
    filePath: string;
    savedContents: string;
    preTurnContents: string | null;
  }) => Promise<void> | void;
  onAddCodeContext: (selection: CodeContextSelection) => void;
}

const SELECTION_ACTION_OFFSET_PX = 8;
const SELECTION_ACTION_HEIGHT_PX = 28;
const SELECTION_ACTION_MIN_EDGE_PX = 8;
const MAX_WARM_EDITOR_MODELS = 20;

interface CachedEditorSessionState {
  filePath: string;
  status: ProjectFileEditorStatus;
  message: string | null;
  baseContents: string;
  draftContents: string;
  baseVersion: string | null;
  preTurnContents: string | null;
}

const editorSessionStateByKey = new Map<string, CachedEditorSessionState>();
const warmEditorModelUsageBySessionKey = new Map<
  string,
  ReadonlyArray<{ cwd: string; filePath: string }>
>();

function normalizePathValue(path: string): string {
  return path.replaceAll("\\", "/");
}

function encodePathSegments(path: string): string {
  return normalizePathValue(path)
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function buildEditorSessionStateCacheKey(input: {
  sessionKey: string | undefined;
  cwd: string;
  filePath: string;
}): string | null {
  if (!input.sessionKey) {
    return null;
  }
  return `${input.sessionKey}:${normalizePathValue(input.cwd)}:${normalizePathValue(input.filePath)}`;
}

function buildWarmEditorModelPath(input: {
  sessionKey: string | undefined;
  filePath: string;
}): string {
  if (!input.sessionKey) {
    return input.filePath;
  }
  return `file:///__forma-workspace/${encodeURIComponent(input.sessionKey)}/${encodePathSegments(input.filePath)}`;
}

function buildWarmEditorUsageKey(input: { cwd: string; filePath: string }): string {
  return `${normalizePathValue(input.cwd)}:${normalizePathValue(input.filePath)}`;
}

function readWarmEditorModelUsage(sessionKey: string | undefined) {
  if (!sessionKey) {
    return [];
  }
  return [...(warmEditorModelUsageBySessionKey.get(sessionKey) ?? [])];
}

function writeWarmEditorModelUsage(
  sessionKey: string | undefined,
  usage: ReadonlyArray<{ cwd: string; filePath: string }>,
): void {
  if (!sessionKey) {
    return;
  }
  if (usage.length === 0) {
    warmEditorModelUsageBySessionKey.delete(sessionKey);
    return;
  }
  warmEditorModelUsageBySessionKey.set(sessionKey, usage);
}

function markWarmEditorModelUsed(input: {
  sessionKey: string | undefined;
  cwd: string;
  filePath: string;
}) {
  const usage = readWarmEditorModelUsage(input.sessionKey);
  const nextKey = buildWarmEditorUsageKey({ cwd: input.cwd, filePath: input.filePath });
  const nextUsage = usage.filter((entry) => buildWarmEditorUsageKey(entry) !== nextKey);
  nextUsage.push({
    cwd: input.cwd,
    filePath: input.filePath,
  });
  writeWarmEditorModelUsage(input.sessionKey, nextUsage);
  return nextUsage;
}

function forgetWarmEditorModel(input: {
  sessionKey: string | undefined;
  cwd: string;
  filePath: string;
}): void {
  if (!input.sessionKey) {
    return;
  }

  const targetKey = buildWarmEditorUsageKey({
    cwd: input.cwd,
    filePath: input.filePath,
  });
  writeWarmEditorModelUsage(
    input.sessionKey,
    readWarmEditorModelUsage(input.sessionKey).filter(
      (entry) => buildWarmEditorUsageKey(entry) !== targetKey,
    ),
  );
}

function evictWarmEditorModels(input: {
  sessionKey: string | undefined;
  currentCwd: string;
  currentFilePath: string;
  monaco: Monaco;
}): void {
  if (!input.sessionKey) {
    return;
  }

  const usage = readWarmEditorModelUsage(input.sessionKey);
  if (usage.length <= MAX_WARM_EDITOR_MODELS) {
    return;
  }

  const nextUsage = [...usage];
  const currentUsageKey = buildWarmEditorUsageKey({
    cwd: input.currentCwd,
    filePath: input.currentFilePath,
  });
  let index = 0;
  while (nextUsage.length > MAX_WARM_EDITOR_MODELS && index < nextUsage.length) {
    const candidate = nextUsage[index];
    if (!candidate) {
      index += 1;
      continue;
    }

    if (buildWarmEditorUsageKey(candidate) === currentUsageKey) {
      index += 1;
      continue;
    }

    const cachedState = readCachedEditorSessionState(
      input.sessionKey,
      candidate.cwd,
      candidate.filePath,
    );
    if (cachedState && cachedState.draftContents !== cachedState.baseContents) {
      index += 1;
      continue;
    }

    input.monaco.editor
      .getModel(
        input.monaco.Uri.parse(
          buildWarmEditorModelPath({
            sessionKey: input.sessionKey,
            filePath: candidate.filePath,
          }),
        ),
      )
      ?.dispose();
    nextUsage.splice(index, 1);
  }

  writeWarmEditorModelUsage(input.sessionKey, nextUsage);
}

function readCachedEditorSessionState(
  sessionKey: string | undefined,
  cwd: string,
  filePath: string,
): CachedEditorSessionState | null {
  const cacheKey = buildEditorSessionStateCacheKey({
    sessionKey,
    cwd,
    filePath,
  });
  if (!cacheKey) {
    return null;
  }
  const state = editorSessionStateByKey.get(cacheKey) ?? null;
  return state?.filePath === filePath ? state : null;
}

function writeCachedEditorSessionState(
  sessionKey: string | undefined,
  cwd: string,
  filePath: string,
  state: CachedEditorSessionState,
): void {
  const cacheKey = buildEditorSessionStateCacheKey({
    sessionKey,
    cwd,
    filePath,
  });
  if (!cacheKey) {
    return;
  }
  editorSessionStateByKey.set(cacheKey, state);
}

function clearCachedEditorSessionState(
  sessionKey: string | undefined,
  cwd: string,
  filePath: string,
): void {
  const cacheKey = buildEditorSessionStateCacheKey({
    sessionKey,
    cwd,
    filePath,
  });
  if (!cacheKey) {
    return;
  }
  editorSessionStateByKey.delete(cacheKey);
}

function canReuseCachedEditorSessionState(
  state: CachedEditorSessionState | null,
): state is CachedEditorSessionState {
  return state !== null && state.status !== "idle" && state.status !== "loading";
}

function buildCachedEditorSessionStateFromProjectFile(input: {
  filePath: string;
  file: ProjectReadFileResult;
  fileDiff: FileDiffMetadata | null;
  preTurnContents: string | null | undefined;
}): CachedEditorSessionState {
  return {
    filePath: input.filePath,
    status: "ready",
    message: null,
    baseContents: input.file.contents,
    draftContents: input.file.contents,
    baseVersion: input.file.version,
    preTurnContents:
      input.preTurnContents ??
      (input.fileDiff ? reconstructPreTurnFileContents(input.fileDiff, input.file.contents) : null),
  };
}

export function __resetDiffFileEditorPaneSessionCacheForTests(): void {
  editorSessionStateByKey.clear();
  warmEditorModelUsageBySessionKey.clear();
}

function buildUnavailableMessage(status: ProjectFileEditorStatus): string {
  switch (status) {
    case "missing":
      return "This file no longer exists in the workspace.";
    case "unsupported":
      return "This file cannot be edited here because it is binary or too large.";
    default:
      return "Unable to open this file in the diff editor.";
  }
}

function StatePanel(props: {
  filePath: string;
  message: string;
  status: Extract<ProjectFileEditorStatus, "missing" | "unsupported" | "error">;
  navigationLabel: string;
  onBack: () => void;
  onOpenInEditor: () => void;
  onReload: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-4">
      <div className="w-full max-w-md rounded-xl border border-border/70 bg-card/80 p-4 shadow-sm">
        <div className="flex items-start gap-3">
          <div className="rounded-full bg-amber-500/12 p-2 text-amber-700 dark:text-amber-300">
            <AlertTriangleIcon className="size-4" />
          </div>
          <div className="min-w-0 space-y-2">
            <div>
              <p className="font-medium text-sm text-foreground">
                {buildUnavailableMessage(props.status)}
              </p>
              <p className="text-code-compact mt-1 break-words font-mono text-muted-foreground">
                {props.filePath}
              </p>
            </div>
            <p className="text-sm text-muted-foreground">{props.message}</p>
            <div className="flex flex-wrap gap-2">
              <Button size="xs" variant="outline" onClick={props.onReload}>
                <RefreshCwIcon className="size-3.5" />
                Reload from disk
              </Button>
              <Button size="xs" variant="outline" onClick={props.onOpenInEditor}>
                Open in IDE
              </Button>
              <Button size="xs" variant="ghost" onClick={props.onBack}>
                {props.navigationLabel}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function DiffFileEditorPane(props: DiffFileEditorPaneProps) {
  const {
    cwd,
    environmentId,
    fileDiff,
    filePath,
    filePaths,
    initialColumn,
    initialLine,
    initialOverride,
    navigationLabel,
    onEditorControlsStateChange,
    onOpenInEditor,
    onOpenPreview,
    onRequestClosePanel,
    onRequestShowDiff,
    previewDisabledReason,
    requestedNavigation,
    reuseMonacoModels = false,
    requestedSaveNonce,
    requestedDiscardNonce,
    lineNumbersVisible = true,
    wordWrapEnabled = false,
    autoSaveEnabled = false,
    showHeader = true,
    onPersisted,
    onAddCodeContext,
    sessionKey,
    onRequestBack,
    onRequestFilePathChange,
    resolvedTheme,
  } = props;
  const cachedSessionState = readCachedEditorSessionState(sessionKey, cwd, filePath);
  const cachedProjectFile = peekProjectFileForEditor({
    environmentId,
    cwd,
    relativePath: filePath,
  });
  const initialSessionState =
    cachedSessionState ??
    (cachedProjectFile
      ? buildCachedEditorSessionStateFromProjectFile({
          filePath,
          file: cachedProjectFile,
          fileDiff,
          preTurnContents: initialOverride?.preTurnContents,
        })
      : null);
  const [status, setStatus] = useState<ProjectFileEditorStatus>(
    initialSessionState?.status ?? "loading",
  );
  const [message, setMessage] = useState<string | null>(initialSessionState?.message ?? null);
  const [baseContents, setBaseContents] = useState(initialSessionState?.baseContents ?? "");
  const [draftContents, setDraftContents] = useState(initialSessionState?.draftContents ?? "");
  const [baseVersion, setBaseVersion] = useState<string | null>(
    initialSessionState?.baseVersion ?? null,
  );
  const [stateSessionKey, setStateSessionKey] = useState<string | undefined>(sessionKey);
  const [stateFilePath, setStateFilePath] = useState(initialSessionState?.filePath ?? filePath);
  const [pendingNavigation, setPendingNavigation] = useState<PendingNavigation | null>(null);
  const loadRequestIdRef = useRef(0);
  const pendingNavigationRef = useRef<PendingNavigation | null>(null);
  const preTurnContentsRef = useRef<string | null>(
    initialSessionState?.preTurnContents ?? initialOverride?.preTurnContents ?? null,
  );
  const saveHandlerRef = useRef<() => Promise<boolean>>(async () => false);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const lastHandledRequestedNavigationNonceRef = useRef<number | undefined>(
    requestedNavigation?.nonce,
  );
  const lastHandledRequestedSaveNonceRef = useRef<number | undefined>(requestedSaveNonce);
  const lastHandledRequestedDiscardNonceRef = useRef<number | undefined>(requestedDiscardNonce);
  const [monacoReadyGeneration, setMonacoReadyGeneration] = useState(0);
  const editorContainerRef = useRef<HTMLDivElement | null>(null);
  const editorSubscriptionsRef = useRef<Array<{ dispose: () => void }>>([]);
  const updateSelectionActionRef = useRef<() => void>(() => undefined);
  const [selectionAction, setSelectionAction] = useState<{
    selection: CodeContextSelection;
    disabledReason: string | null;
    top: number;
    left: number;
  } | null>(null);
  const codeFontScale = useSettings((settings) => settings.codeFontScale);
  const renderedEditorFilePath = reuseMonacoModels ? stateFilePath : filePath;
  const renderedEditorModelPath = useMemo(
    () =>
      reuseMonacoModels
        ? buildWarmEditorModelPath({
            sessionKey,
            filePath: renderedEditorFilePath,
          })
        : renderedEditorFilePath,
    [renderedEditorFilePath, reuseMonacoModels, sessionKey],
  );

  const isDirty = draftContents !== baseContents;
  const canSave =
    baseVersion !== null &&
    status !== "loading" &&
    status !== "saving" &&
    status !== "missing" &&
    status !== "unsupported";

  const performNavigation = useCallback(
    (navigation: PendingNavigation) => {
      setPendingNavigation(null);
      pendingNavigationRef.current = null;
      if (navigation.type === "back") {
        onRequestBack();
        return;
      }
      if (navigation.type === "close-panel") {
        onRequestClosePanel?.();
        return;
      }
      if (navigation.type === "show-diff") {
        onRequestShowDiff?.();
        return;
      }
      onRequestFilePathChange(navigation.filePath);
    },
    [onRequestBack, onRequestClosePanel, onRequestFilePathChange, onRequestShowDiff],
  );

  const requestNavigation = useCallback(
    (navigation: PendingNavigation) => {
      if (isDirty) {
        setPendingNavigation(navigation);
        pendingNavigationRef.current = navigation;
        return;
      }
      performNavigation(navigation);
    },
    [isDirty, performNavigation],
  );

  useLayoutEffect(() => {
    const nextCachedState = readCachedEditorSessionState(sessionKey, cwd, filePath);
    if (nextCachedState) {
      setStateSessionKey(sessionKey);
      setStateFilePath(filePath);
      setStatus(nextCachedState.status);
      setMessage(nextCachedState.message);
      setBaseContents(nextCachedState.baseContents);
      setDraftContents(nextCachedState.draftContents);
      setBaseVersion(nextCachedState.baseVersion);
      preTurnContentsRef.current = nextCachedState.preTurnContents;
      return;
    }

    const nextCachedProjectFile = peekProjectFileForEditor({
      environmentId,
      cwd,
      relativePath: filePath,
    });
    if (nextCachedProjectFile) {
      const nextProjectState = buildCachedEditorSessionStateFromProjectFile({
        filePath,
        file: nextCachedProjectFile,
        fileDiff,
        preTurnContents: initialOverride?.preTurnContents,
      });
      setStateSessionKey(sessionKey);
      setStateFilePath(filePath);
      setStatus(nextProjectState.status);
      setMessage(nextProjectState.message);
      setBaseContents(nextProjectState.baseContents);
      setDraftContents(nextProjectState.draftContents);
      setBaseVersion(nextProjectState.baseVersion);
      preTurnContentsRef.current = nextProjectState.preTurnContents;
      return;
    }

    setStateSessionKey(sessionKey);
    setStateFilePath(filePath);
    setStatus("loading");
    setMessage(null);
    setBaseContents("");
    setDraftContents("");
    setBaseVersion(null);
    preTurnContentsRef.current = initialOverride?.preTurnContents ?? null;
  }, [cwd, environmentId, fileDiff, filePath, initialOverride?.preTurnContents, sessionKey]);

  useEffect(() => {
    if (status === "idle" || stateFilePath !== filePath || stateSessionKey !== sessionKey) {
      return;
    }

    writeCachedEditorSessionState(sessionKey, cwd, filePath, {
      filePath,
      status,
      message,
      baseContents,
      draftContents,
      baseVersion,
      preTurnContents: preTurnContentsRef.current,
    });
  }, [
    baseContents,
    baseVersion,
    draftContents,
    filePath,
    message,
    cwd,
    sessionKey,
    stateFilePath,
    stateSessionKey,
    status,
  ]);

  const loadFile = useCallback(
    async (options?: { force?: boolean }) => {
      const cachedState = readCachedEditorSessionState(sessionKey, cwd, filePath);
      if (canReuseCachedEditorSessionState(cachedState) && !options?.force) {
        setStateSessionKey(sessionKey);
        setStateFilePath(filePath);
        setStatus(cachedState.status);
        setMessage(cachedState.message);
        setBaseContents(cachedState.baseContents);
        setDraftContents(cachedState.draftContents);
        setBaseVersion(cachedState.baseVersion);
        preTurnContentsRef.current = cachedState.preTurnContents;
        return;
      }

      const cachedProjectFile = !options?.force
        ? peekProjectFileForEditor({
            environmentId,
            cwd,
            relativePath: filePath,
          })
        : null;
      if (cachedProjectFile) {
        const nextProjectState = buildCachedEditorSessionStateFromProjectFile({
          filePath,
          file: cachedProjectFile,
          fileDiff,
          preTurnContents: initialOverride?.preTurnContents,
        });
        setStateSessionKey(sessionKey);
        setStateFilePath(filePath);
        setStatus(nextProjectState.status);
        setMessage(nextProjectState.message);
        setBaseContents(nextProjectState.baseContents);
        setDraftContents(nextProjectState.draftContents);
        setBaseVersion(nextProjectState.baseVersion);
        preTurnContentsRef.current = nextProjectState.preTurnContents;
        return;
      }

      const requestId = ++loadRequestIdRef.current;
      setStateSessionKey(sessionKey);
      setStateFilePath(filePath);
      setStatus("loading");
      setMessage(null);
      setBaseContents("");
      setDraftContents("");
      setBaseVersion(null);

      try {
        const file = await loadProjectFileForEditor(
          {
            environmentId,
            cwd,
            relativePath: filePath,
          },
          options,
        );

        if (requestId !== loadRequestIdRef.current) {
          return;
        }

        preTurnContentsRef.current =
          initialOverride?.preTurnContents ??
          (fileDiff ? reconstructPreTurnFileContents(fileDiff, file.contents) : null);
        setStateSessionKey(sessionKey);
        setStateFilePath(filePath);
        setBaseContents(file.contents);
        setDraftContents(file.contents);
        setBaseVersion(file.version);
        setStatus("ready");
        setMessage(null);
      } catch (error) {
        if (requestId !== loadRequestIdRef.current) {
          return;
        }

        const resolved = resolveProjectFileEditorError(error);
        setStateSessionKey(sessionKey);
        setStateFilePath(filePath);
        setStatus(resolved.status);
        setMessage(resolved.message);
      }
    },
    [cwd, environmentId, fileDiff, filePath, initialOverride?.preTurnContents, sessionKey],
  );

  const handleSave = useCallback(async () => {
    if (!canSave || baseVersion === null) {
      return false;
    }
    const api = readEnvironmentApi(environmentId);
    if (!api) {
      const nextMessage = "Environment connection is unavailable.";
      setStatus("error");
      setMessage(nextMessage);
      toastManager.add({
        type: "error",
        title: "Unable to save file",
        description: nextMessage,
      });
      return false;
    }

    setStatus("saving");
    setMessage(null);

    try {
      const result = await api.projects.writeFile({
        cwd,
        relativePath: filePath,
        contents: draftContents,
        expectedVersion: baseVersion,
      });

      setBaseContents(draftContents);
      setBaseVersion(result.version);
      setStatus("ready");
      setMessage(null);
      storeProjectFileForEditor({
        environmentId,
        cwd,
        relativePath: filePath,
        result: {
          relativePath: filePath,
          contents: draftContents,
          version: result.version,
        },
      });

      await onPersisted({
        filePath,
        savedContents: draftContents,
        preTurnContents: preTurnContentsRef.current,
      });

      toastManager.add({
        type: "success",
        title: "File saved",
        description: filePath,
      });

      const nextNavigation = pendingNavigationRef.current;
      if (nextNavigation) {
        performNavigation(nextNavigation);
      }

      return true;
    } catch (error) {
      invalidateProjectFileForEditor({
        environmentId,
        cwd,
        relativePath: filePath,
      });
      const resolved = resolveProjectFileEditorError(error);
      setStatus(resolved.status === "conflict" ? "conflict" : "error");
      setMessage(resolved.message);
      toastManager.add({
        type: "error",
        title: "Unable to save file",
        description: normalizeProjectFileEditError(error),
      });
      return false;
    }
  }, [
    baseVersion,
    canSave,
    cwd,
    draftContents,
    environmentId,
    filePath,
    onPersisted,
    performNavigation,
  ]);

  useEffect(() => {
    void loadFile();
  }, [loadFile]);

  useEffect(() => {
    if (initialOverride?.preTurnContents) {
      preTurnContentsRef.current = initialOverride.preTurnContents;
    }
  }, [initialOverride?.preTurnContents]);

  useEffect(() => {
    onEditorControlsStateChange?.({
      canSave,
      filePath,
      isDirty,
      isSaving: status === "saving",
    });
  }, [canSave, filePath, isDirty, onEditorControlsStateChange, status]);

  useEffect(() => {
    if (
      requestedNavigation === undefined ||
      requestedNavigation === null ||
      requestedNavigation.nonce === lastHandledRequestedNavigationNonceRef.current
    ) {
      return;
    }

    lastHandledRequestedNavigationNonceRef.current = requestedNavigation.nonce;
    if (requestedNavigation.type === "switch-file") {
      if (!requestedNavigation.filePath || requestedNavigation.filePath === filePath) {
        return;
      }
      requestNavigation({
        type: "switch-file",
        filePath: requestedNavigation.filePath,
      });
      return;
    }

    if (requestedNavigation.type === "show-diff") {
      requestNavigation({ type: "show-diff" });
      return;
    }

    if (requestedNavigation.type === "close-panel") {
      requestNavigation({ type: "close-panel" });
      return;
    }

    requestNavigation({ type: "back" });
  }, [filePath, requestNavigation, requestedNavigation]);

  useEffect(() => {
    if (
      requestedSaveNonce === undefined ||
      requestedSaveNonce === lastHandledRequestedSaveNonceRef.current
    ) {
      return;
    }

    lastHandledRequestedSaveNonceRef.current = requestedSaveNonce;
    void handleSave();
  }, [handleSave, requestedSaveNonce]);

  useEffect(() => {
    if (
      requestedDiscardNonce === undefined ||
      requestedDiscardNonce === lastHandledRequestedDiscardNonceRef.current
    ) {
      return;
    }

    lastHandledRequestedDiscardNonceRef.current = requestedDiscardNonce;
    if (status === "loading" || status === "saving") {
      return;
    }

    setDraftContents(baseContents);
    setMessage(null);
  }, [baseContents, requestedDiscardNonce, status]);

  useEffect(() => {
    if (!autoSaveEnabled || !isDirty || !canSave || status !== "ready") {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void handleSave();
    }, 800);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [autoSaveEnabled, canSave, handleSave, isDirty, status]);

  useEffect(() => {
    saveHandlerRef.current = handleSave;
  }, [handleSave]);

  useEffect(() => {
    if (!reuseMonacoModels || !sessionKey || monacoRef.current === null) {
      return;
    }
    if (
      status === "loading" ||
      status === "missing" ||
      status === "unsupported" ||
      status === "error"
    ) {
      return;
    }

    markWarmEditorModelUsed({
      sessionKey,
      cwd,
      filePath: stateFilePath,
    });
    evictWarmEditorModels({
      sessionKey,
      currentCwd: cwd,
      currentFilePath: stateFilePath,
      monaco: monacoRef.current,
    });
  }, [cwd, monacoReadyGeneration, reuseMonacoModels, sessionKey, stateFilePath, status]);

  const clearEditorSubscriptions = useCallback(() => {
    for (const subscription of editorSubscriptionsRef.current) {
      subscription.dispose();
    }
    editorSubscriptionsRef.current = [];
  }, []);

  const updateSelectionAction = useCallback(() => {
    const editor = editorRef.current;
    const container = editorContainerRef.current;
    const model = editor?.getModel?.();
    if (!editor || !container || !model) {
      setSelectionAction(null);
      return;
    }

    const rawSelection = editor.getSelection?.();
    if (!rawSelection) {
      setSelectionAction(null);
      return;
    }

    const startLineNumber =
      typeof rawSelection.startLineNumber === "number" ? rawSelection.startLineNumber : 0;
    const startColumn = typeof rawSelection.startColumn === "number" ? rawSelection.startColumn : 0;
    const endLineNumber =
      typeof rawSelection.endLineNumber === "number" ? rawSelection.endLineNumber : 0;
    const endColumn = typeof rawSelection.endColumn === "number" ? rawSelection.endColumn : 0;
    const isEmpty = startLineNumber === endLineNumber && startColumn === endColumn;
    if (isEmpty) {
      setSelectionAction(null);
      return;
    }

    const selectedText = model.getValueInRange?.(rawSelection) ?? "";
    const normalizedSelection = normalizeCodeContextSelection({
      filePath,
      lineStart: startLineNumber,
      lineEnd: endLineNumber,
      text: selectedText,
    });
    if (!normalizedSelection || normalizedSelection.text.trim().length === 0) {
      setSelectionAction(null);
      return;
    }

    const position =
      editor.getScrolledVisiblePosition?.({
        lineNumber: startLineNumber,
        column: startColumn,
      }) ?? null;
    const containerWidth = container.clientWidth;
    const containerHeight = container.clientHeight;
    const positionTop =
      typeof position?.top === "number"
        ? position.top
        : (editor.getTopForLineNumber?.(startLineNumber) ?? 0) - (editor.getScrollTop?.() ?? 0);
    const positionLeft =
      typeof position?.left === "number" ? position.left : SELECTION_ACTION_MIN_EDGE_PX;
    const positionHeight =
      typeof position?.height === "number" ? position.height : SELECTION_ACTION_HEIGHT_PX;
    const preferredTop = positionTop - SELECTION_ACTION_HEIGHT_PX - SELECTION_ACTION_OFFSET_PX;
    const fallbackTop = positionTop + positionHeight + SELECTION_ACTION_OFFSET_PX;
    const nextTop =
      preferredTop >= SELECTION_ACTION_MIN_EDGE_PX
        ? preferredTop
        : Math.min(
            Math.max(SELECTION_ACTION_MIN_EDGE_PX, fallbackTop),
            Math.max(
              SELECTION_ACTION_MIN_EDGE_PX,
              containerHeight - SELECTION_ACTION_HEIGHT_PX - SELECTION_ACTION_MIN_EDGE_PX,
            ),
          );
    const nextLeft = Math.max(
      SELECTION_ACTION_MIN_EDGE_PX,
      Math.min(positionLeft, Math.max(SELECTION_ACTION_MIN_EDGE_PX, containerWidth - 120)),
    );

    setSelectionAction({
      selection: normalizedSelection,
      disabledReason: getCodeContextSelectionLimitMessage(normalizedSelection),
      top: nextTop,
      left: nextLeft,
    });
  }, [filePath]);

  updateSelectionActionRef.current = updateSelectionAction;

  const handleEditorMount = useCallback<OnMount>(
    (editor, monaco) => {
      editorRef.current = editor;
      monacoRef.current = monaco;
      setMonacoReadyGeneration((current) => current + 1);
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        void saveHandlerRef.current();
      });
      clearEditorSubscriptions();
      editorSubscriptionsRef.current = [
        editor.onDidChangeCursorSelection?.(() => {
          updateSelectionActionRef.current();
        }),
        editor.onDidScrollChange?.(() => {
          updateSelectionActionRef.current();
        }),
        editor.onDidLayoutChange?.(() => {
          updateSelectionActionRef.current();
        }),
      ].filter((value): value is { dispose: () => void } => value !== undefined && value !== null);
      updateSelectionActionRef.current();
    },
    [clearEditorSubscriptions],
  );

  useEffect(() => {
    setSelectionAction(null);
  }, [filePath, status]);

  useEffect(() => {
    return () => {
      clearEditorSubscriptions();
      monacoRef.current = null;
    };
  }, [clearEditorSubscriptions]);

  useEffect(() => {
    if (status !== "ready" || !initialLine || initialLine < 1) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      const editor = editorRef.current;
      const model = editor?.getModel?.();
      if (!editor || !model) {
        return;
      }

      const lineNumber = Math.min(Math.max(1, initialLine), model.getLineCount());
      const requestedColumn = initialColumn ?? 1;
      const column = Math.min(Math.max(1, requestedColumn), model.getLineMaxColumn(lineNumber));
      const position = { lineNumber, column };

      editor.revealPositionInCenter?.(position);
      editor.setPosition?.(position);
      editor.focus?.();
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [renderedEditorFilePath, initialColumn, initialLine, status]);

  const editorOptions = useMemo(
    () => ({
      automaticLayout: true,
      fontSize: getCodeEditorFontSize(codeFontScale),
      lineNumbers: lineNumbersVisible ? ("on" as const) : ("off" as const),
      minimap: { enabled: false },
      readOnly: status === "loading" || status === "saving",
      scrollBeyondLastLine: false,
      tabSize: 2,
      wordWrap: wordWrapEnabled ? ("on" as const) : ("off" as const),
    }),
    [codeFontScale, lineNumbersVisible, status, wordWrapEnabled],
  );
  const monacoTheme = useMemo(() => ensureAppMonacoTheme(resolvedTheme), [resolvedTheme]);
  const monacoLanguage = useMemo(
    () => resolveMonacoLanguage(renderedEditorFilePath),
    [renderedEditorFilePath],
  );
  const showUnavailableState =
    status === "missing" || status === "unsupported" || status === "error";
  const showPersistentEditor = reuseMonacoModels || status !== "loading";

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {showHeader ? (
          <div className="flex shrink-0 items-center gap-2 border-b border-border/70 px-3 py-2">
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={() => requestNavigation({ type: "back" })}
              aria-label={navigationLabel}
              title={navigationLabel}
            >
              <ArrowLeftIcon className="size-3.5" />
              <span className="sr-only">{navigationLabel}</span>
            </Button>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-1 overflow-x-auto py-0.5">
                {filePaths.map((candidatePath) => (
                  <button
                    key={candidatePath}
                    type="button"
                    className={cn(
                      "min-w-0 shrink-0 rounded-full border px-2.5 py-1 font-medium leading-none transition-colors",
                      candidatePath === filePath
                        ? "border-border bg-accent text-accent-foreground"
                        : "border-transparent text-muted-foreground hover:border-border/60 hover:bg-accent/40 hover:text-foreground",
                    )}
                    onClick={() =>
                      requestNavigation({
                        type: "switch-file",
                        filePath: candidatePath,
                      })
                    }
                    title={candidatePath}
                  >
                    <span className="text-ui-xs block max-w-60 truncate">
                      {resolveEditorFileLabel(candidatePath)}
                    </span>
                  </button>
                ))}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <Button
                size="xs"
                className="px-2"
                onClick={() => void handleSave()}
                disabled={!canSave || !isDirty}
              >
                {status === "saving" ? "Saving..." : "Save"}
                <KbdGroup
                  aria-hidden
                  className="pointer-events-none inline-flex items-center gap-1"
                >
                  <Kbd className="text-ui-2xs h-4 min-w-0 rounded-sm bg-primary-foreground/12 px-1 text-primary-foreground/80">
                    ⌘
                  </Kbd>
                  <Kbd className="text-ui-2xs h-4 min-w-4 rounded-sm bg-primary-foreground/12 px-1 text-primary-foreground/80">
                    S
                  </Kbd>
                </KbdGroup>
              </Button>
              <Button
                size="xs"
                variant="outline"
                onClick={() => onOpenPreview(filePath)}
                disabled={previewDisabledReason !== null}
                title={previewDisabledReason ?? "Open Preview"}
              >
                Preview
              </Button>
              <Button
                size="icon-xs"
                variant="outline"
                onClick={() => onOpenInEditor(filePath)}
                aria-label="Open in IDE"
                title="Open in IDE"
              >
                <OpenInIDEIcon className="size-3.5" />
              </Button>
            </div>
          </div>
        ) : null}
        <div className="min-h-0 flex-1 overflow-hidden">
          <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              {status === "conflict" ? (
                <div className="flex shrink-0 items-start gap-3 border-b border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-950 dark:text-amber-100">
                  <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
                  <div className="min-w-0">
                    <p className="font-medium">
                      This file changed on disk before your save completed.
                    </p>
                    <p className="mt-1 text-xs opacity-90">
                      {message ?? "Reload from disk to pick up the latest file contents."}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => void loadFile({ force: true })}
                      >
                        <RefreshCwIcon className="size-3.5" />
                        Reload from disk
                      </Button>
                      <Button size="xs" variant="outline" onClick={() => onOpenInEditor(filePath)}>
                        Open in IDE
                      </Button>
                    </div>
                  </div>
                </div>
              ) : null}
              {showUnavailableState ? (
                <StatePanel
                  filePath={filePath}
                  message={message ?? "Unable to load this file."}
                  navigationLabel={navigationLabel}
                  status={status}
                  onBack={() => requestNavigation({ type: "back" })}
                  onOpenInEditor={() => onOpenInEditor(filePath)}
                  onReload={() => void loadFile({ force: true })}
                />
              ) : !showPersistentEditor ? (
                <div className="flex min-h-0 flex-1 items-center justify-center gap-2 px-4 py-6 text-sm text-muted-foreground">
                  <LoaderIcon className="size-4 animate-spin" />
                  Loading file…
                </div>
              ) : (
                <div ref={editorContainerRef} className="relative min-h-0 flex-1 overflow-hidden">
                  {status === "loading" ? (
                    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-2 bg-background/80 px-4 py-6 text-sm text-muted-foreground backdrop-blur-[1px]">
                      <LoaderIcon className="size-4 animate-spin" />
                      Loading file…
                    </div>
                  ) : null}
                  {selectionAction ? (
                    <Button
                      type="button"
                      size="xs"
                      className="absolute z-10 h-7 px-2 shadow-sm"
                      style={{
                        top: `${selectionAction.top}px`,
                        left: `${selectionAction.left}px`,
                      }}
                      aria-label="Add selected code to chat"
                      title={selectionAction.disabledReason ?? "Add selected code to chat"}
                      disabled={selectionAction.disabledReason !== null}
                      onClick={() => {
                        if (selectionAction.disabledReason) {
                          return;
                        }
                        onAddCodeContext(selectionAction.selection);
                        editorRef.current?.focus?.();
                      }}
                    >
                      Add to chat
                    </Button>
                  ) : null}
                  {reuseMonacoModels ? (
                    <Editor
                      height="100%"
                      keepCurrentModel={true}
                      loading={
                        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                          Loading editor…
                        </div>
                      }
                      onChange={(value) => setDraftContents(value ?? "")}
                      onMount={handleEditorMount}
                      options={editorOptions}
                      path={renderedEditorModelPath}
                      saveViewState={true}
                      theme={monacoTheme}
                      value={draftContents}
                      {...(monacoLanguage ? { language: monacoLanguage } : {})}
                    />
                  ) : (
                    <Editor
                      key={filePath}
                      height="100%"
                      keepCurrentModel={false}
                      loading={
                        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                          Loading editor…
                        </div>
                      }
                      onChange={(value) => setDraftContents(value ?? "")}
                      onMount={handleEditorMount}
                      options={editorOptions}
                      path={renderedEditorModelPath}
                      saveViewState={false}
                      theme={monacoTheme}
                      value={draftContents}
                      {...(monacoLanguage ? { language: monacoLanguage } : {})}
                    />
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      <Dialog
        open={pendingNavigation !== null}
        onOpenChange={(open) => !open && setPendingNavigation(null)}
      >
        <DialogPopup className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Unsaved changes</DialogTitle>
            <DialogDescription>
              Save or discard your changes before leaving this file.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingNavigation(null)}>
              Cancel
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                if (reuseMonacoModels && sessionKey && monacoRef.current?.editor) {
                  monacoRef.current.editor
                    .getModel?.(
                      monacoRef.current.Uri.parse(
                        buildWarmEditorModelPath({
                          sessionKey,
                          filePath,
                        }),
                      ),
                    )
                    ?.dispose?.();
                  forgetWarmEditorModel({
                    sessionKey,
                    cwd,
                    filePath,
                  });
                }
                clearCachedEditorSessionState(sessionKey, cwd, filePath);
                if (pendingNavigation) {
                  performNavigation(pendingNavigation);
                }
              }}
            >
              Discard
            </Button>
            <Button
              onClick={() => {
                void handleSave();
              }}
              disabled={!canSave}
            >
              {status === "saving" ? (
                <LoaderIcon className="size-3.5 animate-spin" />
              ) : (
                <SaveIcon className="size-3.5" />
              )}
              Save
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
