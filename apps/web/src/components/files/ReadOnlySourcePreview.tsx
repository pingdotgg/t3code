import { VirtualizedFile } from "@pierre/diffs";
import { File, type FileOptions, Virtualizer } from "@pierre/diffs/react";
import { useLayoutEffect, useRef, useState } from "react";

import { DiffWorkerPoolProvider } from "~/components/DiffWorkerPoolProvider";
import { useClientSettings } from "~/hooks/useSettings";
import { useRenderedAppearance } from "~/hooks/useTheme";
import { resolveDiffThemeName } from "~/lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "~/lib/syntaxHighlighting";

import { FileMarksMenu } from "./FileMarksMenu";
import { resolveCenteredFileLineScrollTop } from "./fileLineReveal";
import { FILE_LINK_REVEAL_ATTRIBUTE, FILE_LINK_REVEAL_UNSAFE_CSS } from "./fileSurfaceChrome";
import { collectXcodeMarks, updateXcodeMarkDecorations } from "./fileXcodeMarks";

type SourcePostRender = NonNullable<FileOptions<unknown, undefined>["onPostRender"]>;
type SourceFileInstance = Parameters<SourcePostRender>[1];

function updateFileLinkReveal(fileContainer: HTMLElement, line: number | null): void {
  const root = fileContainer.shadowRoot ?? fileContainer;
  for (const element of root.querySelectorAll<HTMLElement>(`[${FILE_LINK_REVEAL_ATTRIBUTE}]`)) {
    element.removeAttribute(FILE_LINK_REVEAL_ATTRIBUTE);
  }
  if (line === null) return;
  root
    .querySelector<HTMLElement>(`[data-line="${line}"]`)
    ?.setAttribute(FILE_LINK_REVEAL_ATTRIBUTE, "");
  root
    .querySelector<HTMLElement>(`[data-column-number="${line}"]`)
    ?.setAttribute(FILE_LINK_REVEAL_ATTRIBUTE, "");
}

function clampLine(contents: string, requestedLine: number): number {
  let lineCount = 1;
  for (let index = 0; index < contents.length; index += 1) {
    if (contents.charCodeAt(index) === 10) lineCount += 1;
    else if (contents.charCodeAt(index) === 13) {
      lineCount += 1;
      if (contents.charCodeAt(index + 1) === 10) index += 1;
    }
  }
  return Math.min(Math.max(1, requestedLine), lineCount);
}

function scrollFileToLine(
  fileContainer: HTMLElement,
  instance: SourceFileInstance,
  line: number,
): void {
  updateFileLinkReveal(fileContainer, line);
  if (!(instance instanceof VirtualizedFile)) return;
  const scrollContainer = fileContainer.closest<HTMLElement>(".file-preview-virtualizer");
  const linePosition = instance.getLinePosition(line);
  if (!scrollContainer || !linePosition) return;
  const scrollContainerRect = scrollContainer.getBoundingClientRect();
  const fileTop =
    scrollContainer.scrollTop + fileContainer.getBoundingClientRect().top - scrollContainerRect.top;
  const root = fileContainer.shadowRoot ?? fileContainer;
  const renderedLineElement = root.querySelector<HTMLElement>(`[data-line="${line}"]`);
  const renderedLineRect = renderedLineElement?.getBoundingClientRect();
  const targetTop = resolveCenteredFileLineScrollTop({
    scrollTop: scrollContainer.scrollTop,
    scrollHeight: scrollContainer.scrollHeight,
    viewportTop: scrollContainerRect.top,
    viewportHeight: scrollContainer.clientHeight,
    fileTop,
    estimatedLine: linePosition,
    ...(renderedLineRect && renderedLineRect.height > 0
      ? {
          renderedLine: {
            top: renderedLineRect.top,
            height: renderedLineRect.height,
          },
        }
      : {}),
  });
  if (targetTop !== null) scrollContainer.scrollTop = targetTop;
}

export default function ReadOnlySourcePreview(props: {
  readonly name: string;
  readonly text: string;
  readonly cacheKey?: string;
  readonly onPostRender?: SourcePostRender;
  /** When true, shows an in-surface marks jump control. Full file surfaces opt in. */
  readonly marksMenu?: boolean;
  /** A preview's own wrap toggle; omitted follows the word wrap setting. */
  readonly wordWrap?: boolean;
}) {
  const resolvedTheme = useRenderedAppearance();
  const defaultWordWrap = useClientSettings((settings) => settings.wordWrap);
  const wordWrap = props.wordWrap ?? defaultWordWrap;
  const marks = collectXcodeMarks(props.text);
  const showMarksMenu = props.marksMenu === true && marks.length > 0;
  const [reveal, setReveal] = useState<{ line: number; requestId: number } | null>(null);
  const handledRevealRequestIdRef = useRef<number | null>(null);
  const surfaceRef = useRef<{
    fileContainer: HTMLElement;
    instance: SourceFileInstance;
  } | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- jumps to a mark after the Pierre surface reports its container
  useLayoutEffect(() => {
    if (reveal === null) return;
    if (handledRevealRequestIdRef.current === reveal.requestId) return;
    const surface = surfaceRef.current;
    if (!surface) return;
    const line = clampLine(props.text, reveal.line);
    scrollFileToLine(surface.fileContainer, surface.instance, line);
    handledRevealRequestIdRef.current = reveal.requestId;
  }, [props.text, reveal]);

  const handlePostRender: SourcePostRender = (fileContainer, instance, phase) => {
    if (phase === "unmount") {
      surfaceRef.current = null;
      props.onPostRender?.(fileContainer, instance, phase);
      return;
    }

    surfaceRef.current = { fileContainer, instance };
    updateXcodeMarkDecorations(fileContainer, marks);
    if (reveal !== null) {
      const line = clampLine(props.text, reveal.line);
      // Keep the reveal highlight on later virtualized ranges, but scroll only once per jump.
      if (handledRevealRequestIdRef.current === reveal.requestId) {
        updateFileLinkReveal(fileContainer, line);
      } else {
        scrollFileToLine(fileContainer, instance, line);
        handledRevealRequestIdRef.current = reveal.requestId;
      }
    } else {
      updateFileLinkReveal(fileContainer, null);
    }
    props.onPostRender?.(fileContainer, instance, phase);
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {showMarksMenu ? (
        <div className="absolute top-2 right-2 z-10">
          <FileMarksMenu
            marks={marks}
            onSelect={(line) =>
              setReveal((current) => ({
                line,
                requestId: (current?.requestId ?? 0) + 1,
              }))
            }
          />
        </div>
      ) : null}
      <DiffWorkerPoolProvider>
        <Virtualizer
          key={`${props.name}:${resolvedTheme}:${props.text.length}`}
          className="file-preview-virtualizer min-h-0 flex-1 overflow-auto"
          config={{ overscrollSize: 600, intersectionObserverMargin: 1200 }}
        >
          <File
            file={{
              name: props.name,
              contents: props.text,
              ...(props.cacheKey ? { cacheKey: props.cacheKey } : {}),
            }}
            options={{
              disableFileHeader: true,
              overflow: wordWrap ? "wrap" : "scroll",
              theme: resolveDiffThemeName(resolvedTheme),
              preferredHighlighter: PREFERRED_HIGHLIGHTER,
              themeType: resolvedTheme,
              unsafeCSS: FILE_LINK_REVEAL_UNSAFE_CSS,
              onPostRender: handlePostRender,
            }}
            className="min-h-full"
          />
        </Virtualizer>
      </DiffWorkerPoolProvider>
    </div>
  );
}
