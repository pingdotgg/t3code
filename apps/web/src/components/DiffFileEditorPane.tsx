import Editor, { type OnMount } from "@monaco-editor/react";
import type { EnvironmentId } from "@forma/contracts";
import type { FileDiffMetadata } from "@pierre/diffs";
import {
  IconExclamationmarkTriangle as AlertTriangleIcon,
  IconArrowLeft as ArrowLeftIcon,
  IconProgressIndicator as LoaderIcon,
  IconArrowClockwise as RefreshCwIcon,
  IconSquareAndArrowDown as SaveIcon,
  IconSquareAndArrowUp as OpenInIDEIcon,
} from "symbols-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readEnvironmentApi } from "../environmentApi";
import {
  reconstructPreTurnFileContents,
  type PersistedDiffFileEditOverride,
} from "../lib/diffFileEditOverrides";
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

type PendingNavigation =
  | {
      type: "back";
    }
  | {
      type: "switch-file";
      filePath: string;
    };

interface DiffFileEditorPaneProps {
  environmentId: EnvironmentId;
  cwd: string;
  filePath: string;
  filePaths: readonly string[];
  fileDiff: FileDiffMetadata | null;
  initialOverride: PersistedDiffFileEditOverride | undefined;
  initialLine?: number | undefined;
  initialColumn?: number | undefined;
  navigationLabel: string;
  resolvedTheme: ResolvedThemeMode;
  onRequestBack: () => void;
  onRequestFilePathChange: (filePath: string) => void;
  onOpenInEditor: (filePath: string) => void;
  onOpenPreview: (filePath: string) => void;
  previewDisabledReason: string | null;
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

function resolveFileTabLabel(filePath: string): string {
  const normalizedPath = filePath.replaceAll("\\", "/");
  const segments = normalizedPath.split("/");
  return segments.at(-1) ?? filePath;
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
    onOpenInEditor,
    onOpenPreview,
    previewDisabledReason,
    onPersisted,
    onAddCodeContext,
    onRequestBack,
    onRequestFilePathChange,
    resolvedTheme,
  } = props;
  const [status, setStatus] = useState<ProjectFileEditorStatus>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [baseContents, setBaseContents] = useState("");
  const [draftContents, setDraftContents] = useState("");
  const [baseVersion, setBaseVersion] = useState<string | null>(null);
  const [pendingNavigation, setPendingNavigation] = useState<PendingNavigation | null>(null);
  const loadRequestIdRef = useRef(0);
  const pendingNavigationRef = useRef<PendingNavigation | null>(null);
  const preTurnContentsRef = useRef<string | null>(initialOverride?.preTurnContents ?? null);
  const saveHandlerRef = useRef<() => Promise<boolean>>(async () => false);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
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
      onRequestFilePathChange(navigation.filePath);
    },
    [onRequestBack, onRequestFilePathChange],
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

  const loadFile = useCallback(async () => {
    const requestId = ++loadRequestIdRef.current;
    const api = readEnvironmentApi(environmentId);
    if (!api) {
      setStatus("error");
      setMessage("Environment connection is unavailable.");
      return;
    }

    setStatus("loading");
    setMessage(null);
    setBaseContents("");
    setDraftContents("");
    setBaseVersion(null);

    try {
      const file = await api.projects.readFile({
        cwd,
        relativePath: filePath,
      });

      if (requestId !== loadRequestIdRef.current) {
        return;
      }

      preTurnContentsRef.current =
        initialOverride?.preTurnContents ??
        (fileDiff ? reconstructPreTurnFileContents(fileDiff, file.contents) : null);
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
      setStatus(resolved.status);
      setMessage(resolved.message);
    }
  }, [cwd, environmentId, fileDiff, filePath, initialOverride?.preTurnContents]);

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
    saveHandlerRef.current = handleSave;
  }, [handleSave]);

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
  }, [filePath, initialColumn, initialLine, status]);

  const editorOptions = useMemo(
    () => ({
      automaticLayout: true,
      fontSize: getCodeEditorFontSize(codeFontScale),
      minimap: { enabled: false },
      readOnly: status === "loading" || status === "saving",
      scrollBeyondLastLine: false,
      tabSize: 2,
      wordWrap: "off" as const,
    }),
    [codeFontScale, status],
  );
  const monacoTheme = useMemo(() => ensureAppMonacoTheme(resolvedTheme), [resolvedTheme]);
  const monacoLanguage = useMemo(() => resolveMonacoLanguage(filePath), [filePath]);

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/70 px-3 py-2">
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
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              size="xs"
              className="px-2"
              onClick={() => void handleSave()}
              disabled={!canSave || !isDirty}
            >
              {status === "saving" ? "Saving..." : "Save"}
              <KbdGroup aria-hidden className="pointer-events-none inline-flex items-center gap-1">
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
        <div className="min-h-0 flex-1 overflow-hidden">
          <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
            <div className="shrink-0 border-b border-border/70 bg-background">
              <div className="flex gap-1 overflow-x-auto px-2 py-1.5">
                {filePaths.map((candidatePath) => (
                  <button
                    key={candidatePath}
                    type="button"
                    className={cn(
                      "text-code-compact min-w-0 shrink-0 rounded-md border px-2 py-1 text-left font-mono transition-colors",
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
                    <span className="block truncate">{resolveFileTabLabel(candidatePath)}</span>
                  </button>
                ))}
              </div>
            </div>
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
                      <Button size="xs" variant="outline" onClick={() => void loadFile()}>
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
              {status === "missing" || status === "unsupported" || status === "error" ? (
                <StatePanel
                  filePath={filePath}
                  message={message ?? "Unable to load this file."}
                  navigationLabel={navigationLabel}
                  status={status}
                  onBack={() => requestNavigation({ type: "back" })}
                  onOpenInEditor={() => onOpenInEditor(filePath)}
                  onReload={() => void loadFile()}
                />
              ) : status === "loading" ? (
                <div className="flex min-h-0 flex-1 items-center justify-center gap-2 px-4 py-6 text-sm text-muted-foreground">
                  <LoaderIcon className="size-4 animate-spin" />
                  Loading file…
                </div>
              ) : (
                <div ref={editorContainerRef} className="relative min-h-0 flex-1 overflow-hidden">
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
                  <Editor
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
                    path={filePath}
                    theme={monacoTheme}
                    value={draftContents}
                    {...(monacoLanguage ? { language: monacoLanguage } : {})}
                  />
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
