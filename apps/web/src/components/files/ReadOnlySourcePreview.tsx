import { File, type FileOptions, Virtualizer } from "@pierre/diffs/react";
import type { ClipboardEvent } from "react";

import { DiffWorkerPoolProvider } from "~/components/DiffWorkerPoolProvider";
import { useClientSettings } from "~/hooks/useSettings";
import { useRenderedAppearance } from "~/hooks/useTheme";
import { resolveDiffThemeName } from "~/lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "~/lib/syntaxHighlighting";

import { FILE_LINK_REVEAL_UNSAFE_CSS } from "./fileSurfaceChrome";

/** Select All spans the file's shadow tree, where the virtualizer mounts only rows near the viewport. */
function selectsEveryMountedRow(root: ShadowRoot) {
  const rows = root.querySelectorAll("[data-line]");
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (!first || !last) return false;
  try {
    const selected = document.getSelection()?.getComposedRanges({ shadowRoots: [root] })[0];
    if (!selected) return false;
    if (!root.contains(selected.startContainer) || !root.contains(selected.endContainer)) {
      return false;
    }
    const range = document.createRange();
    range.setStart(selected.startContainer, selected.startOffset);
    range.setEnd(selected.endContainer, selected.endOffset);
    // A dragged selection ends inside rows, so it never holds a row's own boundaries.
    return (
      range.comparePoint(first, 0) === 0 && range.comparePoint(last, last.childNodes.length) === 0
    );
  } catch {
    // Engines without composed ranges keep their own copy.
    return false;
  }
}

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
  const copyWholeFile = (event: ClipboardEvent<HTMLDivElement>) => {
    const root = event.currentTarget.querySelector("diffs-container")?.shadowRoot;
    if (!root || !selectsEveryMountedRow(root)) return;
    event.clipboardData.setData("text/plain", props.text);
    event.preventDefault();
  };
  return (
    <DiffWorkerPoolProvider>
      <div className="contents" onCopy={copyWholeFile}>
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
              ...(props.onPostRender ? { onPostRender: props.onPostRender } : {}),
            }}
            className="min-h-full"
          />
        </Virtualizer>
      </div>
    </DiffWorkerPoolProvider>
  );
}
