import { RegistryContext, useAtomValue } from "@effect/atom-react";
// The board has no web diff adapter to go through, and `diffTheme.ts` is its one place that styles the viewer.
// oxlint-disable-next-line eslint/no-restricted-imports
import { CodeView, type CodeViewHandle } from "@pierre/diffs/react";
import type { CodeViewDiffItem } from "@pierre/diffs";
import type { ReviewDiffPreviewSource } from "@t3tools/contracts";
import { Columns2, Pilcrow, RefreshCw, Rows3 } from "lucide-react";
import { useContext, useMemo, useRef, useState } from "react";

import { useArtifacts } from "../artifacts/ArtifactsContext";
import { CODE_THEME, PREFERRED_HIGHLIGHTER } from "../chat/highlight";
import { Notice } from "../artifacts/Notice";
import { changesPrefsAtom, previewInput } from "../state/changesView";
import { type DiffSource, type FileRef, openFile } from "../state/filesView";
import { Tooltip } from "../ui/Tooltip";
import { ChangeRows } from "./ChangeRows";
import { Counts } from "./Counts";
import { changeSetOf, firstChangedLine } from "./changeSet";
import { DIFF_SURFACE, DIFF_UNSAFE_CSS } from "./diffTheme";
import { diffContentsLoader } from "./fileContents";
import { useDiffPreview } from "./useDiffPreview";
import { useFilePatches } from "./useFilePatches";

const TOGGLE =
  "grid size-6 place-items-center rounded-md text-muted hover:bg-hover hover:text-fg aria-pressed:bg-hover aria-pressed:text-fg";

// Two frames: the first commits the viewer's rows, the second runs after they were painted. A
// stable function, so a re-render does not run it again.
function markPainted() {
  requestAnimationFrame(() => requestAnimationFrame(() => performance.mark("board:diff-painted")));
}

/**
 * A diff in the main view, as Orca opens one beside the board: the file's own diff, or with no
 * path every changed file under a tree of them. Unchanged lines expand from the full file, and a
 * file's name or a line number opens it in the file view at that line.
 */
export function DiffView({ file, diff }: { file: FileRef; diff: DiffSource }) {
  const registry = useContext(RegistryContext);
  const { files: board } = useArtifacts();
  const prefs = useAtomValue(changesPrefsAtom);
  const viewer = useRef<CodeViewHandle<undefined, undefined>>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const { environmentId } = board;
  const preview = useDiffPreview(
    environmentId,
    { ...previewInput(file.cwd, diff, prefs.ignoreWhitespace), metadataOnly: true },
    "",
  );
  const source: ReviewDiffPreviewSource | null = preview.state === "ready" ? preview.source : null;
  const set = useMemo(
    () =>
      source === null
        ? null
        : changeSetOf(source, (path) => file.path === "" || path === file.path),
    [source, file.path],
  );
  const patches = useFilePatches(
    environmentId,
    file.cwd,
    diff,
    prefs.ignoreWhitespace,
    set?.files ?? null,
    source?.diffHash ?? "",
  );
  const shown = patches.loaded;
  const items = useMemo(
    (): CodeViewDiffItem[] =>
      shown.map((fileDiff) => ({
        id: `${fileDiff.prevName ?? ""}\0${fileDiff.name}\0${fileDiff.type}`,
        type: "diff",
        fileDiff,
      })),
    [shown],
  );
  const options = useMemo(
    () => ({
      diffStyle: prefs.layout,
      lineDiffType: "none" as const,
      overflow: "scroll" as const,
      theme: CODE_THEME,
      themeType: "dark" as const,
      preferredHighlighter: PREFERRED_HIGHLIGHTER,
      stickyHeaders: true,
      onPostRender: markPainted,
      unsafeCSS: DIFF_UNSAFE_CSS,
      itemMetrics: {
        diffHeaderHeight: 32,
        hunkSeparatorHeight: 24,
        spacing: 0,
        paddingTop: 0,
        paddingBottom: 8,
      },
      layout: { paddingTop: 0, paddingBottom: 0, gap: 0 },
      ...(source === null
        ? {}
        : {
            loadDiffFiles: diffContentsLoader(registry, { environmentId, cwd: file.cwd, source }),
          }),
      // A removed line has no place in the file as it is now, so only the lines that remain open it.
      onLineNumberClick: (props: {
        readonly lineNumber: number;
        readonly lineType?: string;
        readonly lineElement: HTMLElement;
      }) => {
        const root = props.lineElement.getRootNode();
        const path =
          root instanceof ShadowRoot ? root.querySelector("[data-title]")?.textContent : null;
        if (!path || props.lineType === "change-deletion") return;
        openFile(registry, { cwd: file.cwd, path, line: props.lineNumber });
      },
    }),
    [prefs.layout, source, registry, environmentId, file.cwd],
  );

  const openAtFirstChange = (path: string) => {
    const fileDiff = shown.find((entry) => entry.name === path);
    if (fileDiff === undefined || fileDiff.type === "deleted") return;
    openFile(registry, { cwd: file.cwd, path, line: firstChangedLine(fileDiff) });
  };
  const title =
    file.path !== ""
      ? file.path
      : source === null
        ? "Changes"
        : `${source.title}${source.commitSubject === undefined ? "" : `: ${source.commitSubject}`}`;

  return (
    <section
      aria-label="Diff"
      data-testid="diff-view"
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg"
    >
      <div className="flex shrink-0 items-center gap-1 border-b border-line px-3 py-1">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted">{title}</span>
        {set !== null && (
          <span className="flex items-center gap-2 text-[11px] text-faint">
            {file.path === "" && <span>{set.totals.files} files</span>}
            <Counts additions={set.totals.additions} deletions={set.totals.deletions} />
          </span>
        )}
        <Tooltip text="Unified view" side="bottom">
          <button
            type="button"
            aria-label="Unified view"
            aria-pressed={prefs.layout === "unified"}
            onClick={() => registry.set(changesPrefsAtom, { ...prefs, layout: "unified" })}
            className={TOGGLE}
          >
            <Rows3 className="size-3.5" aria-hidden />
          </button>
        </Tooltip>
        <Tooltip text="Split view" side="bottom">
          <button
            type="button"
            aria-label="Split view"
            aria-pressed={prefs.layout === "split"}
            onClick={() => registry.set(changesPrefsAtom, { ...prefs, layout: "split" })}
            className={TOGGLE}
          >
            <Columns2 className="size-3.5" aria-hidden />
          </button>
        </Tooltip>
        <Tooltip text="Ignore whitespace" side="bottom">
          <button
            type="button"
            aria-label="Ignore whitespace"
            aria-pressed={prefs.ignoreWhitespace}
            onClick={() =>
              registry.set(changesPrefsAtom, {
                ...prefs,
                ignoreWhitespace: !prefs.ignoreWhitespace,
              })
            }
            className={TOGGLE}
          >
            <Pilcrow className="size-3.5" aria-hidden />
          </button>
        </Tooltip>
        <Tooltip text="Refresh diff" side="bottom" align="end">
          <button
            type="button"
            aria-label="Refresh diff"
            disabled={preview.state !== "ready"}
            onClick={() => preview.state === "ready" && preview.refresh()}
            className={`${TOGGLE} disabled:opacity-40`}
          >
            <RefreshCw className="size-3.5" aria-hidden />
          </button>
        </Tooltip>
      </div>
      {preview.state === "failed" ? (
        <Notice tone="text-red-300">{preview.message}</Notice>
      ) : preview.state === "loading" ? (
        <Notice>Loading the diff</Notice>
      ) : source === null ? (
        <Notice>This folder is not a git repository.</Notice>
      ) : set !== null && set.totals.files === 0 ? (
        <Notice>No changes</Notice>
      ) : patches.failure !== null && items.length === 0 ? (
        <Notice tone="text-red-300">{patches.failure}</Notice>
      ) : items.length === 0 ? (
        <Notice>Loading the diff</Notice>
      ) : (
        <div className="flex min-h-0 flex-1">
          {file.path === "" && set !== null && (
            <nav
              aria-label="Changed files"
              data-testid="diff-tree"
              className="w-64 shrink-0 overflow-y-auto border-r border-line py-1"
            >
              <ChangeRows
                set={set}
                asTree
                selectedPath={focused}
                onOpen={(entry) => {
                  setFocused(entry.path);
                  const target = items.find((item) => item.fileDiff.name === entry.path);
                  if (target !== undefined)
                    viewer.current?.scrollTo({ type: "item", id: target.id, align: "start" });
                }}
              />
            </nav>
          )}
          {/* Capturing the header's click here, since the header draws inside the viewer's shadow root. */}
          <div
            className="min-h-0 min-w-0 flex-1"
            onClickCapture={(event) => {
              const title = event.nativeEvent
                .composedPath()
                .find(
                  (node): node is HTMLElement =>
                    node instanceof HTMLElement && node.hasAttribute("data-title"),
                );
              if (title?.textContent) openAtFirstChange(title.textContent);
            }}
          >
            <CodeView
              key={`${source.diffHash}:${file.path}`}
              ref={viewer}
              className={`${DIFF_SURFACE} h-full min-h-0 overflow-auto`}
              items={items}
              options={options}
            />
          </div>
        </div>
      )}
    </section>
  );
}
