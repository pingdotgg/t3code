import { useQuery } from "@tanstack/react-query";
import { CheckIcon, CopyIcon, PanelRightCloseIcon, TextWrapIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { readEnvironmentApi } from "../environmentApi";
import { formatWorkspaceRelativePath } from "../filePathDisplay";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { useTheme } from "../hooks/useTheme";
import { cn } from "../lib/utils";
import type { WorkspaceFilePreviewTarget } from "../workspaceFilePreview";
import { closeWorkspaceFilePreview } from "../workspaceFilePreview";
import { VscodeEntryIcon } from "./chat/VscodeEntryIcon";
import { DiffPanelLoadingState, DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { Button } from "./ui/button";

const EMPTY_FILE_LINES = [""];

function basenameOfPath(path: string): string {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separatorIndex >= 0 ? path.slice(separatorIndex + 1) : path;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function splitFileLines(contents: string): string[] {
  if (contents.length === 0) return EMPTY_FILE_LINES;
  return contents.replace(/\r\n/g, "\n").split("\n");
}

function workspaceFilePreviewQueryOptions(target: WorkspaceFilePreviewTarget | null) {
  return {
    queryKey: [
      "workspaceFilePreview",
      target?.environmentId ?? null,
      target?.cwd ?? null,
      target?.relativePath ?? null,
    ],
    enabled: target !== null,
    queryFn: async () => {
      if (!target) {
        throw new Error("No file selected.");
      }
      const api = readEnvironmentApi(target.environmentId);
      if (!api) {
        throw new Error("Environment API not found.");
      }
      return api.projects.readFile({
        cwd: target.cwd,
        relativePath: target.relativePath,
      });
    },
  };
}

export function WorkspaceFilePreviewPanel(props: {
  mode: DiffPanelMode;
  target: WorkspaceFilePreviewTarget | null;
}) {
  const { resolvedTheme } = useTheme();
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const [wordWrap, setWordWrap] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const query = useQuery(workspaceFilePreviewQueryOptions(props.target));
  const fileContents = query.data?.contents ?? "";
  const fileLines = useMemo(() => splitFileLines(fileContents), [fileContents]);
  const targetLine = props.target?.line ?? null;
  const displayPath = props.target
    ? formatWorkspaceRelativePath(props.target.relativePath, props.target.cwd)
    : "No file selected";
  const title = props.target ? basenameOfPath(props.target.relativePath) : "File preview";
  const subtitle = props.target?.displayPath ?? displayPath;

  useEffect(() => {
    if (!targetLine || !scrollRef.current || !query.data) {
      return;
    }
    const element = scrollRef.current.querySelector<HTMLElement>(`[data-line="${targetLine}"]`);
    element?.scrollIntoView({ block: "center" });
  }, [query.data, targetLine]);

  const copyFile = useCallback(() => {
    if (!query.data) return;
    copyToClipboard(query.data.contents);
  }, [copyToClipboard, query.data]);

  const header = (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {props.target ? (
          <VscodeEntryIcon
            pathValue={props.target.relativePath}
            kind="file"
            theme={resolvedTheme}
            className="size-4 shrink-0 text-muted-foreground/80"
          />
        ) : null}
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">{title}</p>
          <p className="truncate font-mono text-[11px] text-muted-foreground/70">{subtitle}</p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={wordWrap ? "Disable word wrap" : "Enable word wrap"}
          title={wordWrap ? "Disable word wrap" : "Enable word wrap"}
          onClick={() => setWordWrap((value) => !value)}
        >
          <TextWrapIcon className="size-3.5" />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          disabled={!query.data}
          aria-label={isCopied ? "Copied file" : "Copy file"}
          title={isCopied ? "Copied" : "Copy file"}
          onClick={copyFile}
        >
          {isCopied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Close file preview"
          title="Close file preview"
          onClick={closeWorkspaceFilePreview}
        >
          <PanelRightCloseIcon className="size-3.5" />
        </Button>
      </div>
    </>
  );

  return (
    <DiffPanelShell mode={props.mode} header={header}>
      {query.isLoading ? (
        <DiffPanelLoadingState label="Loading file preview..." />
      ) : query.error ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-4 text-center text-sm text-destructive">
          {query.error instanceof Error ? query.error.message : "Failed to load file."}
        </div>
      ) : query.data ? (
        <div className="flex min-h-0 flex-1 flex-col">
          {query.data.truncated ? (
            <div className="border-b border-border/60 bg-warning/10 px-3 py-2 text-[11px] text-warning">
              Preview truncated. File size: {formatBytes(query.data.sizeBytes)}.
            </div>
          ) : null}
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto bg-background">
            <div className="min-w-full py-2 font-mono text-[12px] leading-5">
              {fileLines.map((line, index) => {
                const lineNumber = index + 1;
                const highlighted = lineNumber === targetLine;
                return (
                  <div
                    key={lineNumber}
                    data-line={lineNumber}
                    className={cn(
                      "grid min-w-full grid-cols-[3.5rem_minmax(0,1fr)] px-2",
                      highlighted && "bg-primary/10",
                    )}
                  >
                    <span className="select-none pr-3 text-right text-muted-foreground/45">
                      {lineNumber}
                    </span>
                    <code
                      className={cn(
                        "min-w-0 whitespace-pre text-foreground/85",
                        wordWrap && "whitespace-pre-wrap break-words",
                      )}
                    >
                      {line.length > 0 ? line : " "}
                    </code>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center p-4 text-sm text-muted-foreground">
          No file selected.
        </div>
      )}
    </DiffPanelShell>
  );
}
