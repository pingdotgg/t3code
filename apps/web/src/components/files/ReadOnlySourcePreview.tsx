import { File, type FileOptions, Virtualizer } from "@pierre/diffs/react";
import { type ClipboardEvent, useEffect, useRef, useState } from "react";

import { DiffWorkerPoolProvider } from "~/components/DiffWorkerPoolProvider";
import { useClientSettings } from "~/hooks/useSettings";
import { useRenderedAppearance } from "~/hooks/useTheme";
import { resolveDiffThemeName } from "~/lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "~/lib/syntaxHighlighting";

import { FILE_LINK_REVEAL_UNSAFE_CSS } from "./fileSurfaceChrome";
import { SourceSelection } from "./sourceSelection";

export default function ReadOnlySourcePreview(props: {
  readonly name: string;
  readonly text: string;
  readonly cacheKey?: string;
  readonly onPostRender?: FileOptions<unknown, undefined>["onPostRender"];
  /** A preview's own wrap toggle; omitted follows the word wrap setting. */
  readonly wordWrap?: boolean;
}) {
  const resolvedTheme = useRenderedAppearance();
  const defaultWordWrap = useClientSettings((settings) => settings.wordWrap);
  const wordWrap = props.wordWrap ?? defaultWordWrap;
  const { text, onPostRender } = props;
  const wrapper = useRef<HTMLDivElement>(null);
  const [selection] = useState(() => new SourceSelection());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows the document's selection, which only it reports
  useEffect(() => {
    const root = () => wrapper.current?.querySelector("diffs-container")?.shadowRoot;
    const sync = () => {
      const shadowRoot = root();
      if (shadowRoot) selection.sync(shadowRoot, text);
    };
    // A drag that autoscrolls is usually released outside the preview.
    const release = () => {
      const shadowRoot = root();
      if (shadowRoot) selection.release(shadowRoot, text);
    };
    document.addEventListener("selectionchange", sync);
    window.addEventListener("pointerup", release, true);
    window.addEventListener("pointercancel", release, true);
    return () => {
      document.removeEventListener("selectionchange", sync);
      window.removeEventListener("pointerup", release, true);
      window.removeEventListener("pointercancel", release, true);
    };
  }, [selection, text]);
  const copySelection = (event: ClipboardEvent<HTMLDivElement>) => {
    const root = event.currentTarget.querySelector("diffs-container")?.shadowRoot;
    const copied = root ? selection.copy(root, text) : undefined;
    if (copied === undefined) return;
    event.clipboardData.setData("text/plain", copied);
    event.preventDefault();
  };
  const drawSelection: NonNullable<typeof onPostRender> = (node, instance, phase) => {
    if (phase !== "unmount" && node.shadowRoot) selection.render(node.shadowRoot, text);
    return onPostRender?.(node, instance, phase);
  };
  return (
    <DiffWorkerPoolProvider>
      <div
        ref={wrapper}
        className="contents"
        onCopy={copySelection}
        onPointerDown={(event) => selection.press(event.button !== 0 || event.shiftKey)}
        // Scrolling unmounts rows, and a selection made in the same task has not been reported yet.
        onScrollCapture={(event) => {
          const root = event.currentTarget.querySelector("diffs-container")?.shadowRoot;
          if (root) selection.sync(root, text);
        }}
      >
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
              onPostRender: drawSelection,
            }}
            className="min-h-full"
          />
        </Virtualizer>
      </div>
    </DiffWorkerPoolProvider>
  );
}
