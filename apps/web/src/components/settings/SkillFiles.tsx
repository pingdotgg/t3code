import { FileTree, useFileTree } from "@pierre/trees/react";
import type { EnvironmentId, SkillFileEntry } from "@t3tools/contracts";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useMemo, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";

import { useTheme } from "../../hooks/useTheme";
import { T3_PIERRE_ICONS } from "../../pierre-icons";
import { PIERRE_TREE_UNSAFE_CSS, pierreTreeStyle } from "../../pierre-tree-theme";
import { useProjectFileQuery } from "../files/projectFilesQueryState";
import ReadOnlySourcePreview from "../files/ReadOnlySourcePreview";
import { Button } from "../ui/button";
import { compareSkillFiles, skillBody } from "./toolsSettings.logic";

const SKILL_FILE = "SKILL.md";
/** The tree and the viewer share one height, so the page doesn't jump between files. */
const PANE_HEIGHT = "h-[26rem]";

/**
 * A skill's files as a tree beside a read-only viewer. Loaded when a skill
 * opens, since the tree and the highlighter are large. Adapted from the
 * skills page in #17513.
 */
export default function SkillFiles({
  environmentId,
  folder,
  files,
}: {
  environmentId: EnvironmentId;
  /** The skill's folder after following links. */
  folder: string;
  files: ReadonlyArray<SkillFileEntry>;
}) {
  const { resolvedTheme } = useTheme();
  const fileSet = useMemo(() => new Set(files.map((file) => file.path)), [files]);
  const scripts = useMemo(
    () => new Set(files.filter((file) => file.script).map((file) => file.path)),
    [files],
  );
  const [current, setCurrent] = useState(
    fileSet.has(SKILL_FILE) ? SKILL_FILE : (files[0]?.path ?? ""),
  );
  const [treeOpen, setTreeOpen] = useState(false);
  const { model } = useFileTree({
    paths: [...fileSet],
    sort: compareSkillFiles,
    density: "compact",
    flattenEmptyDirectories: true,
    initialExpansion: "open",
    initialSelectedPaths: current ? [current] : [],
    icons: T3_PIERRE_ICONS,
    // Files an agent could run say so, matching "Includes scripts" above.
    renderRowDecoration: ({ item }) =>
      scripts.has(item.path) ? { text: "script", title: "Agents can run this" } : null,
    search: false,
    unsafeCSS: PIERRE_TREE_UNSAFE_CSS,
    onSelectionChange: (selected) => {
      const path = selected.at(-1);
      // Folders end in a slash; only files open.
      if (path !== undefined && fileSet.has(path)) {
        setCurrent(path);
        setTreeOpen(false);
      }
    },
  });

  return (
    <div className="grid min-w-0 md:grid-cols-[15rem_minmax(0,1fr)]">
      <div className="min-w-0 border-b border-border/60 md:border-r md:border-b-0">
        <div className="p-1 md:hidden">
          <Button
            size="xs"
            variant="ghost-muted"
            aria-expanded={treeOpen}
            onClick={() => setTreeOpen(!treeOpen)}
          >
            {treeOpen ? <ChevronDownIcon /> : <ChevronRightIcon />}
            Files ({files.length}) · {current}
          </Button>
        </div>
        <div
          className={`${treeOpen ? "flex" : "hidden md:flex"} ${PANE_HEIGHT} max-h-60 min-h-0 flex-col md:max-h-none`}
        >
          <FileTree
            model={model}
            aria-label="Files in this skill"
            className="min-h-0 flex-1 overflow-hidden"
            style={pierreTreeStyle(resolvedTheme)}
          />
        </div>
      </div>
      <FilePane environmentId={environmentId} folder={folder} path={current} />
    </div>
  );
}

/** One file, read when it is picked. SKILL.md also renders as text. */
function FilePane({
  environmentId,
  folder,
  path,
}: {
  environmentId: EnvironmentId;
  folder: string;
  path: string;
}) {
  const file = useProjectFileQuery(environmentId, folder, path === "" ? null : path);
  const [source, setSource] = useState(false);
  const isSkillFile = path === SKILL_FILE;
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-1.5">
        <span className="min-w-0 truncate font-mono text-xs">{path}</span>
        <span className="flex-1" />
        {isSkillFile ? (
          <>
            <Button
              size="xs"
              variant={source ? "ghost-muted" : "secondary"}
              aria-pressed={!source}
              onClick={() => setSource(false)}
            >
              Preview
            </Button>
            <Button
              size="xs"
              variant={source ? "secondary" : "ghost-muted"}
              aria-pressed={source}
              onClick={() => setSource(true)}
            >
              Source
            </Button>
          </>
        ) : (
          <span className="text-xs text-muted-foreground">Read-only</span>
        )}
      </div>
      <div className={`${PANE_HEIGHT} flex flex-col overflow-hidden`}>
        {file.data !== null ? (
          <>
            {file.data.truncated ? (
              <p className="px-3 py-1 text-xs text-warning-foreground">
                This file is large, so only the start is shown.
              </p>
            ) : null}
            {isSkillFile && !source ? (
              <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-sm break-words">
                <ReactMarkdown components={SKILL_MARKDOWN_COMPONENTS}>
                  {skillBody(file.data.contents)}
                </ReactMarkdown>
              </div>
            ) : (
              <ReadOnlySourcePreview
                name={path}
                text={file.data.contents}
                cacheKey={`${folder}/${path}`}
              />
            )}
          </>
        ) : file.isPending ? (
          <p role="status" className="px-3 py-3 text-xs text-muted-foreground">
            Loading {path}…
          </p>
        ) : (
          <p className="px-3 py-3 text-xs text-muted-foreground">
            {file.readError?.failure === "binary_file"
              ? "This file isn't text."
              : (file.error ?? "This file can't be previewed here.")}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * SKILL.md's body as text. Code wraps at phone width. Links and images stay
 * plain text, so reading a skill never opens a page or fetches anything.
 */
const SKILL_MARKDOWN_COMPONENTS = {
  pre: ({ children }) => (
    <pre className="my-2 rounded-md bg-muted/30 p-2 break-all whitespace-pre-wrap">{children}</pre>
  ),
  code: ({ children }) => <code className="font-mono text-xs">{children}</code>,
  h1: ({ children }) => <h1 className="my-3 text-lg font-semibold">{children}</h1>,
  h2: ({ children }) => <h2 className="my-2 font-semibold">{children}</h2>,
  h3: ({ children }) => <h3 className="my-2 font-medium">{children}</h3>,
  p: ({ children }) => <p className="my-2">{children}</p>,
  ul: ({ children }) => <ul className="my-2 list-disc pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal pl-5">{children}</ol>,
  a: ({ children }) => <span className="underline">{children}</span>,
  img: ({ alt }) => <span className="text-muted-foreground">{alt}</span>,
} satisfies Components;
