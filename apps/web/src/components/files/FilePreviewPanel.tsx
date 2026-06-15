import type { EnvironmentId } from "@t3tools/contracts";
import { Editor } from "@pierre/diffs/editor";
import { EditorProvider, File, Virtualizer } from "@pierre/diffs/react";
import { ChevronRight, FolderTree, LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { ensureEnvironmentApi } from "~/environmentApi";
import { useTheme } from "~/hooks/useTheme";
import { resolveDiffThemeName } from "~/lib/diffRendering";
import { cn } from "~/lib/utils";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Toggle } from "~/components/ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import FileBrowserPanel from "./FileBrowserPanel";
import { projectFileCacheKey } from "./fileContentRevision";
import { fileBreadcrumbs } from "./filePath";
import { FileSaveCoordinator } from "./fileSaveCoordinator";
import {
  confirmProjectFileQueryData,
  setProjectFileQueryData,
  useProjectFileQuery,
} from "./projectFilesQueryState";

interface FilePreviewPanelProps {
  environmentId: EnvironmentId;
  cwd: string;
  projectName: string;
  relativePath: string | null;
  onOpenFile: (relativePath: string) => void;
  onPendingChange: (relativePath: string, pending: boolean) => void;
}

const FILE_EXPLORER_STORAGE_KEY = "t3code.fileExplorerOpen";
const FILE_SAVE_DEBOUNCE_MS = 500;

interface EditableFileSurfaceProps {
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
  contents: string;
  resolvedTheme: "light" | "dark";
  onPendingChange: (relativePath: string, pending: boolean) => void;
}

function EditableFileSurface({
  environmentId,
  cwd,
  relativePath,
  contents,
  resolvedTheme,
  onPendingChange,
}: EditableFileSurfaceProps) {
  const saveCoordinator = useMemo(
    () =>
      new FileSaveCoordinator({
        debounceMs: FILE_SAVE_DEBOUNCE_MS,
        onPendingChange: (pending) => onPendingChange(relativePath, pending),
        persist: async (nextContents) => {
          await ensureEnvironmentApi(environmentId).projects.writeFile({
            cwd,
            relativePath,
            contents: nextContents,
          });
        },
        onConfirmed: (confirmedContents) => {
          confirmProjectFileQueryData(environmentId, cwd, relativePath, confirmedContents);
        },
      }),
    [cwd, environmentId, onPendingChange, relativePath],
  );
  const editor = useMemo(
    () =>
      new Editor({
        onChange: (file) => {
          setProjectFileQueryData(environmentId, cwd, relativePath, file.contents);
          saveCoordinator.change(file.contents);
        },
      }),
    [cwd, environmentId, relativePath, saveCoordinator],
  );

  useEffect(
    () => () => {
      editor.cleanUp();
      saveCoordinator.dispose();
    },
    [editor, saveCoordinator],
  );

  return (
    <EditorProvider editor={editor}>
      <Virtualizer
        className="file-preview-virtualizer min-h-0 flex-1 overflow-auto"
        config={{
          overscrollSize: 600,
          intersectionObserverMargin: 1200,
        }}
      >
        <File
          file={{
            name: relativePath,
            contents,
            cacheKey: projectFileCacheKey(cwd, relativePath, contents),
          }}
          options={{
            disableFileHeader: true,
            overflow: "scroll",
            theme: resolveDiffThemeName(resolvedTheme),
            themeType: resolvedTheme,
          }}
          className="min-h-full"
          contentEditable
        />
      </Virtualizer>
    </EditorProvider>
  );
}

function initialExplorerOpen(): boolean {
  try {
    return window.localStorage.getItem(FILE_EXPLORER_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

export default function FilePreviewPanel({
  environmentId,
  cwd,
  projectName,
  relativePath,
  onOpenFile,
  onPendingChange,
}: FilePreviewPanelProps) {
  const { resolvedTheme } = useTheme();
  const file = useProjectFileQuery(environmentId, cwd, relativePath);
  const [explorerOpen, setExplorerOpen] = useState(initialExplorerOpen);
  const breadcrumbRef = useRef<HTMLDivElement>(null);
  const breadcrumbs = useMemo(
    () => (relativePath ? fileBreadcrumbs(projectName, relativePath) : []),
    [projectName, relativePath],
  );

  useEffect(() => {
    const currentCrumb = breadcrumbRef.current?.querySelector<HTMLElement>(
      "[data-current-file-crumb='true']",
    );
    currentCrumb?.scrollIntoView({ block: "nearest", inline: "end" });
  }, [relativePath]);

  const toggleExplorer = () => {
    setExplorerOpen((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(FILE_EXPLORER_STORAGE_KEY, String(next));
      } catch {}
      return next;
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      {relativePath ? (
        <div className="flex h-11 shrink-0 items-center gap-2 border-y border-border/60 px-3">
          <ScrollArea
            ref={breadcrumbRef}
            hideScrollbars
            scrollFade
            className="min-w-0 flex-1 rounded-none"
            data-file-breadcrumbs
          >
            <div className="flex h-full w-max min-w-full items-center text-xs">
              {breadcrumbs.map((crumb, index) => (
                <div
                  key={crumb.path || "project"}
                  className="flex min-w-0 shrink-0 items-center"
                  data-current-file-crumb={crumb.kind === "file"}
                >
                  {index > 0 ? (
                    <ChevronRight className="mx-1 size-3.5 shrink-0 text-muted-foreground/60" />
                  ) : null}
                  <span
                    className={cn(
                      "max-w-40 truncate",
                      crumb.kind === "file"
                        ? "font-medium text-foreground"
                        : "text-muted-foreground",
                    )}
                    title={crumb.path || projectName}
                  >
                    {crumb.label}
                  </span>
                </div>
              ))}
            </div>
          </ScrollArea>
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  className="shrink-0"
                  pressed={explorerOpen}
                  onPressedChange={toggleExplorer}
                  aria-label={explorerOpen ? "Hide file explorer" : "Show file explorer"}
                  variant="ghost"
                  size="sm"
                >
                  <FolderTree className="size-3.5" />
                </Toggle>
              }
            />
            <TooltipPopup>
              {explorerOpen ? "Hide file explorer" : "Show file explorer"}
            </TooltipPopup>
          </Tooltip>
        </div>
      ) : null}
      {relativePath && file.data?.truncated ? (
        <div className="shrink-0 border-b border-amber-500/20 bg-amber-500/8 px-3 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
          Preview limited to the first 1 MB of a {file.data.byteLength.toLocaleString()} byte file.
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div
          className={cn(
            "min-w-0 flex-1 flex-col overflow-hidden",
            relativePath ? "flex" : "hidden",
          )}
        >
          {relativePath && file.error && file.data === null ? (
            <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs leading-relaxed text-destructive">
              {file.error}
            </div>
          ) : relativePath && file.data === null ? (
            <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
              <LoaderCircle className="size-5 animate-spin" />
            </div>
          ) : relativePath && file.data ? (
            file.data.truncated ? (
              <Virtualizer
                key={`${relativePath}:${resolvedTheme}:${file.data.byteLength}`}
                className="file-preview-virtualizer min-h-0 flex-1 overflow-auto"
                config={{
                  overscrollSize: 600,
                  intersectionObserverMargin: 1200,
                }}
              >
                <File
                  file={{
                    name: relativePath,
                    contents: file.data.contents,
                    cacheKey: projectFileCacheKey(cwd, relativePath, file.data.contents),
                  }}
                  options={{
                    disableFileHeader: true,
                    overflow: "scroll",
                    theme: resolveDiffThemeName(resolvedTheme),
                    themeType: resolvedTheme,
                  }}
                  className="min-h-full"
                />
              </Virtualizer>
            ) : (
              <EditableFileSurface
                key={`${relativePath}:${resolvedTheme}`}
                environmentId={environmentId}
                cwd={cwd}
                relativePath={relativePath}
                contents={file.data.contents}
                resolvedTheme={resolvedTheme}
                onPendingChange={onPendingChange}
              />
            )
          ) : null}
        </div>
        {explorerOpen || relativePath === null ? (
          <aside
            className={cn(
              "flex min-h-0 shrink-0 bg-background",
              relativePath
                ? "w-[min(22rem,46%)] min-w-64 border-l border-border/60"
                : "min-w-0 flex-1",
            )}
          >
            <FileBrowserPanel
              key={`${environmentId}:${cwd}`}
              environmentId={environmentId}
              cwd={cwd}
              projectName={projectName}
              onOpenFile={onOpenFile}
            />
          </aside>
        ) : null}
      </div>
    </div>
  );
}
