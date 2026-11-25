import type { CodeViewItem, File as FileInstance, FileDiff, PostRenderPhase } from "@pierre/diffs";
import type { FileOptions } from "@pierre/diffs/react";
import { type ClipboardEvent, useEffect, useRef, useState } from "react";

import { StyledDiffCodeView } from "~/components/diffs/StyledDiffCodeView";
import { useClientSettings } from "~/hooks/useSettings";
import { useRenderedAppearance } from "~/hooks/useTheme";
import { resolveDiffThemeName } from "~/lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "~/lib/syntaxHighlighting";

import { FILE_LINK_REVEAL_UNSAFE_CSS } from "./fileSurfaceChrome";
import { SourceSelection } from "./sourceSelection";

// The diff surface fades a file in as it mounts; a preview appears at once, as the editable view does.
const READ_ONLY_SOURCE_UNSAFE_CSS = `${FILE_LINK_REVEAL_UNSAFE_CSS}
[data-file] {
  transition: none;
}
`;

export default function ReadOnlySourcePreview(props: {
  readonly name: string;
  readonly text: string;
  readonly cacheKey?: string;
  readonly onPostRender?: FileOptions<unknown, undefined>["onPostRender"];
  /** A preview's own wrap toggle; omitted follows the word wrap setting. */
  readonly wordWrap?: boolean;
  /** Files with more lines than this render without highlighting; omitted keeps Pierre's limit. */
  readonly tokenizeMaxLength?: number;
}) {
  const resolvedTheme = useRenderedAppearance();
  const defaultWordWrap = useClientSettings((settings) => settings.wordWrap);
  const wordWrap = props.wordWrap ?? defaultWordWrap;
  const { text, onPostRender } = props;
  const wrapper = useRef<HTMLDivElement>(null);
  const [selection] = useState(() => new SourceSelection());
  // CodeView only re-renders a reused item when its version changes; bump it as streaming or
  // refreshed files update text without remounting and losing scroll position.
  const [sourceRevision, setSourceRevision] = useState({
    text: props.text,
    cacheKey: props.cacheKey,
    version: 0,
  });
  if (sourceRevision.text !== props.text || sourceRevision.cacheKey !== props.cacheKey) {
    setSourceRevision({
      text: props.text,
      cacheKey: props.cacheKey,
      version: sourceRevision.version + 1,
    });
  }
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
    const root =
      event.target instanceof Element
        ? event.target.closest("diffs-container")?.shadowRoot
        : undefined;
    const copied = root ? selection.copy(root, text) : undefined;
    if (copied === undefined) return;
    event.clipboardData.setData("text/plain", copied);
    event.preventDefault();
  };
  const drawSelection = (
    node: HTMLElement,
    instance: FileInstance<unknown, undefined> | FileDiff<unknown, undefined>,
    phase: PostRenderPhase,
  ) => {
    if (phase !== "unmount" && node.shadowRoot) selection.render(node.shadowRoot, text);
    if (onPostRender && "file" in instance) return onPostRender(node, instance, phase);
  };
  const items: CodeViewItem<unknown>[] = [
    {
      id: "source",
      type: "file",
      version: sourceRevision.version,
      file: {
        name: props.name,
        contents: props.text,
        ...(props.cacheKey ? { cacheKey: props.cacheKey } : {}),
      },
    },
  ];
  return (
    <div
      ref={wrapper}
      className="contents"
      onCopy={copySelection}
      onPointerDown={(event) => {
        if (event.target instanceof Element && event.target.closest("[data-search-panel]")) return;
        selection.press(event.button !== 0 || event.shiftKey);
      }}
      // Scrolling unmounts rows, and a selection made in the same task has not been reported yet.
      onScrollCapture={(event) => {
        const root = event.currentTarget.querySelector("diffs-container")?.shadowRoot;
        if (root) selection.sync(root, text);
      }}
    >
      <StyledDiffCodeView<unknown>
        // Not keyed on the text: a file that grows or finishes downloading keeps its scroll position.
        key={`${props.name}:${resolvedTheme}`}
        className="file-preview-virtualizer min-h-0 flex-1 overflow-auto"
        items={items}
        unsafeCSSExtra={READ_ONLY_SOURCE_UNSAFE_CSS}
        options={{
          disableFileHeader: true,
          overflow: wordWrap ? "wrap" : "scroll",
          theme: resolveDiffThemeName(resolvedTheme),
          preferredHighlighter: PREFERRED_HIGHLIGHTER,
          ...(props.tokenizeMaxLength === undefined
            ? {}
            : { tokenizeMaxLength: props.tokenizeMaxLength }),
          themeType: resolvedTheme,
          onPostRender: drawSelection,
        }}
      />
    </div>
  );
}
