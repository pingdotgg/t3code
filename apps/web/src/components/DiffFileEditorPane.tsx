import Editor, { type OnMount } from "@monaco-editor/react";
import type { EnvironmentId } from "@forma/contracts";
import type { FileDiffMetadata } from "@pierre/diffs";
import {
  IconExclamationmarkTriangle as AlertTriangleIcon,
  IconArrowLeft as ArrowLeftIcon,
  IconProgressIndicator as LoaderIcon,
  IconArrowClockwise as RefreshCwIcon,
  IconSquareAndArrowDown as SaveIcon,
} from "symbols-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readEnvironmentApi } from "../environmentApi";
import {
  reconstructPreTurnFileContents,
  type PersistedDiffFileEditOverride,
} from "../lib/diffFileEditOverrides";
import { ensureMonacoConfigured } from "../lib/monaco";
import {
  normalizeProjectFileEditError,
  resolveProjectFileEditorError,
  type ProjectFileEditorStatus,
} from "../lib/projectFileEditing";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
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
  resolvedTheme: "light" | "dark";
  onRequestBack: () => void;
  onRequestFilePathChange: (filePath: string) => void;
  onOpenInEditor: (filePath: string) => void;
  onPersisted: (input: {
    filePath: string;
    savedContents: string;
    preTurnContents: string | null;
  }) => Promise<void> | void;
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

function resolveFileTabLabel(filePath: string): string {
  const normalizedPath = filePath.replaceAll("\\", "/");
  const segments = normalizedPath.split("/");
  return segments.at(-1) ?? filePath;
}

function StatePanel(props: {
  filePath: string;
  message: string;
  status: Extract<ProjectFileEditorStatus, "missing" | "unsupported" | "error">;
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
              <p className="mt-1 break-words font-mono text-[11px] text-muted-foreground">
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
                Back to diff
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
    initialOverride,
    onOpenInEditor,
    onPersisted,
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

  const handleEditorMount = useCallback<OnMount>((editor, monaco) => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void saveHandlerRef.current();
    });
  }, []);

  const editorOptions = useMemo(
    () => ({
      automaticLayout: true,
      minimap: { enabled: false },
      readOnly: status === "loading" || status === "saving",
      scrollBeyondLastLine: false,
      tabSize: 2,
      wordWrap: "off" as const,
    }),
    [status],
  );

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex shrink-0 flex-col gap-3 border-b border-border/70 px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate font-mono text-[11px] text-muted-foreground">{filePath}</p>
              <p className="text-sm text-foreground">
                {isDirty ? "Unsaved changes" : "Saved to workspace"}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="xs" variant="ghost" onClick={() => requestNavigation({ type: "back" })}>
                <ArrowLeftIcon className="size-3.5" />
                Back to diff
              </Button>
              <Button size="xs" variant="outline" onClick={() => onOpenInEditor(filePath)}>
                Open in IDE
              </Button>
              <Button size="xs" onClick={() => void handleSave()} disabled={!canSave || !isDirty}>
                {status === "saving" ? (
                  <LoaderIcon className="size-3.5 animate-spin" />
                ) : (
                  <SaveIcon className="size-3.5" />
                )}
                Save
              </Button>
            </div>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden p-4 pt-3">
          <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border/70 bg-card/70">
            <div className="shrink-0 border-b border-border/70 bg-background/50">
              <div className="flex gap-1 overflow-x-auto px-2 py-2">
                {filePaths.map((candidatePath) => (
                  <button
                    key={candidatePath}
                    type="button"
                    className={cn(
                      "min-w-0 shrink-0 rounded-md border px-2.5 py-1.5 text-left font-mono text-[11px] transition-colors",
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
                <div className="min-h-0 flex-1 overflow-hidden">
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
                    theme={resolvedTheme === "dark" ? "vs-dark" : "vs"}
                    value={draftContents}
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
