import { CheckIcon, Code2Icon, CopyIcon, EyeIcon, LayersIcon, WrapTextIcon } from "lucide-react";
import React, { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { PierreEntryIcon } from "../chat/PierreEntryIcon";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { getDiagramDisplayName, isLikeC4Language, isMermaidLanguage } from "./diagramUtils";
import { LikeC4Diagram, LikeC4ErrorBoundary, type LikeC4ViewOption } from "./LikeC4Diagram";
import { MermaidDiagram, MermaidErrorBoundary } from "./MermaidDiagram";

export interface MarkdownDiagramBlockProps {
  readonly code: string;
  readonly language: string;
  readonly fenceTitle: string | null;
  readonly theme: "light" | "dark";
  readonly isStreaming?: boolean;
  readonly children: (props: { wrapped: boolean }) => ReactNode;
}

export function MarkdownDiagramBlock({
  code,
  language,
  fenceTitle,
  theme,
  isStreaming = false,
  children,
}: MarkdownDiagramBlockProps) {
  const [viewMode, setViewMode] = useState<"diagram" | "code">("diagram");
  const [copied, setCopied] = useState(false);
  const [wrapped, setWrapped] = useState(false);
  const [likeC4Views, setLikeC4Views] = useState<ReadonlyArray<LikeC4ViewOption>>([]);
  const [selectedViewId, setSelectedViewId] = useState<string | null>(null);

  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isMermaid = isMermaidLanguage(language);
  const isLikeC4 = isLikeC4Language(language);

  const handleCopy = useCallback(() => {
    if (typeof navigator === "undefined" || navigator.clipboard == null) {
      return;
    }
    void navigator.clipboard
      .writeText(code)
      .then(() => {
        if (copiedTimerRef.current != null) {
          clearTimeout(copiedTimerRef.current);
        }
        setCopied(true);
        copiedTimerRef.current = setTimeout(() => {
          setCopied(false);
          copiedTimerRef.current = null;
        }, 1200);
      })
      .catch((err) => {
        console.warn("Failed to copy diagram code:", err);
      });
  }, [code]);

  useEffect(
    () => () => {
      if (copiedTimerRef.current != null) {
        clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = null;
      }
    },
    [],
  );

  const copyLabel = copied ? "Copied" : "Copy code";
  const wrapLabel = wrapped ? "Disable line wrap" : "Wrap lines";
  const toggleViewLabel = viewMode === "diagram" ? "View source code" : "View diagram";
  const displayName = fenceTitle || getDiagramDisplayName(language);

  return (
    <div
      className="chat-markdown-codeblock chat-markdown-diagram-block my-[0.65rem] overflow-hidden rounded-[var(--radius)] border border-border/70 bg-secondary leading-snug dark:border-transparent dark:bg-input/32"
      data-language={language}
      data-diagram-type={isMermaid ? "mermaid" : isLikeC4 ? "likec4" : "diagram"}
      data-view-mode={viewMode}
      data-wrap={wrapped ? "true" : "false"}
    >
      <div className="chat-markdown-codeblock-header flex items-center justify-between gap-2 pt-1.5 pr-1.5 pb-1 pl-3 select-none">
        <div className="inline-flex min-w-0 items-center gap-[0.4rem] [font-family:var(--font-mono,ui-monospace,SFMono-Regular,monospace)] [font-size:0.6875rem]">
          {fenceTitle ? (
            <>
              <PierreEntryIcon
                pathValue={fenceTitle}
                kind="file"
                theme={theme}
                className="size-3.5"
              />
              <span className="truncate">{fenceTitle}</span>
            </>
          ) : (
            <>
              <LayersIcon className="size-3.5 text-muted-foreground" />
              <span className="font-semibold truncate">{displayName}</span>
            </>
          )}

          {/* LikeC4 View Selector if multiple views */}
          {isLikeC4 && viewMode === "diagram" && likeC4Views.length > 1 && (
            <div className="ml-2 flex items-center gap-1">
              <span className="text-[10px] text-muted-foreground">View:</span>
              <select
                aria-label="Select LikeC4 View"
                value={selectedViewId ?? likeC4Views[0]?.id ?? ""}
                onChange={(e) => setSelectedViewId(e.target.value)}
                className="h-5 rounded border border-input bg-background/80 px-1 text-[10px] text-foreground focus:outline-hidden"
              >
                {likeC4Views.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.title}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        <div
          className="flex items-center gap-0.5"
          role="toolbar"
          aria-label="Diagram block actions"
        >
          {/* Toggle between Diagram Preview and Code */}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="chat-markdown-chrome-action"
                  aria-pressed={viewMode === "code"}
                  onClick={() => setViewMode((prev) => (prev === "diagram" ? "code" : "diagram"))}
                  aria-label={toggleViewLabel}
                />
              }
            >
              {viewMode === "diagram" ? (
                <Code2Icon className="size-3" />
              ) : (
                <EyeIcon className="size-3" />
              )}
            </TooltipTrigger>
            <TooltipPopup side="top">{toggleViewLabel}</TooltipPopup>
          </Tooltip>

          {/* Line wrap button (only relevant in code mode) */}
          {viewMode === "code" && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="chat-markdown-chrome-action"
                    aria-pressed={wrapped}
                    onClick={() => setWrapped((v) => !v)}
                    aria-label={wrapLabel}
                  />
                }
              >
                <WrapTextIcon className="size-3" />
              </TooltipTrigger>
              <TooltipPopup side="top">{wrapLabel}</TooltipPopup>
            </Tooltip>
          )}

          {/* Copy code button */}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="chat-markdown-chrome-action"
                  onClick={handleCopy}
                  aria-label={copyLabel}
                />
              }
            >
              {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
            </TooltipTrigger>
            <TooltipPopup side="top">{copyLabel}</TooltipPopup>
          </Tooltip>
        </div>
      </div>

      {viewMode === "diagram" ? (
        <div className="chat-markdown-diagram-content border-t border-border/50 bg-background/50">
          {isMermaid && (
            <MermaidErrorBoundary
              fallback={(err) => (
                <div className="p-3">
                  <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
                    <div className="font-semibold mb-1">Failed to render Mermaid diagram</div>
                    <p className="font-mono text-[11px] whitespace-pre-wrap">{err.message}</p>
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      className="mt-2 text-xs"
                      onClick={() => setViewMode("code")}
                    >
                      View Source Code
                    </Button>
                  </div>
                </div>
              )}
            >
              <MermaidDiagram code={code} theme={theme} isStreaming={isStreaming} />
            </MermaidErrorBoundary>
          )}

          {isLikeC4 && (
            <LikeC4ErrorBoundary
              fallback={(err) => (
                <div className="p-3">
                  <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
                    <div className="font-semibold mb-1">Failed to render LikeC4 diagram</div>
                    <p className="font-mono text-[11px] whitespace-pre-wrap">{err.message}</p>
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      className="mt-2 text-xs"
                      onClick={() => setViewMode("code")}
                    >
                      View Source Code
                    </Button>
                  </div>
                </div>
              )}
            >
              <LikeC4Diagram
                code={code}
                theme={theme}
                isStreaming={isStreaming}
                selectedViewId={selectedViewId}
                onViewsDiscovered={setLikeC4Views}
              />
            </LikeC4ErrorBoundary>
          )}
        </div>
      ) : (
        children({ wrapped })
      )}
    </div>
  );
}
