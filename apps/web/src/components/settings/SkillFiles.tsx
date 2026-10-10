import { FileTree, useFileTree } from "@pierre/trees/react";
import type { EnvironmentId, SkillFile } from "@t3tools/contracts";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useTheme } from "../../hooks/useTheme";
import { T3_PIERRE_ICONS } from "../../pierre-icons";
import { PIERRE_TREE_UNSAFE_CSS, pierreTreeStyle } from "../../pierre-tree-theme";
import { Button } from "../ui/button";
import { useProjectFileQuery } from "../files/projectFilesQueryState";
import ReadOnlySourcePreview from "../files/ReadOnlySourcePreview";
import { SkillMarkdown } from "./SkillMarkdown";
import { compareSkillFiles, scriptFiles, skillBody } from "./SkillsSettings.logic";

const SKILL_FILE = "SKILL.md";
/** The viewer and the tree share one height, so the page doesn't jump between files. */
const PANE_HEIGHT = "h-[26rem]";

export default function SkillFiles({
  environmentId,
  home,
  files,
  skillText,
}: {
  environmentId: EnvironmentId;
  /** Absolute path of the skill's folder. */
  home: string;
  files: readonly SkillFile[];
  /** SKILL.md text; null when it is missing or too large to show. */
  skillText: string | null;
}) {
  const { resolvedTheme } = useTheme();
  const fileSet = useMemo(() => new Set(files.map((file) => file.path)), [files]);
  const [current, setCurrent] = useState(
    fileSet.has(SKILL_FILE) ? SKILL_FILE : (files[0]?.path ?? ""),
  );
  const [treeOpen, setTreeOpen] = useState(false);
  const scripts = useMemo(() => new Set(scriptFiles(files)), [files]);
  const { model } = useFileTree({
    paths: [...fileSet],
    sort: compareSkillFiles,
    density: "compact",
    flattenEmptyDirectories: true,
    initialExpansion: "open",
    initialSelectedPaths: current ? [current] : [],
    icons: T3_PIERRE_ICONS,
    // Files an agent could run say so, matching "Includes scripts" in the skill's header.
    renderRowDecoration: ({ item }) =>
      scripts.has(item.path) ? { text: "script", title: "Agents can run this" } : null,
    search: false,
    unsafeCSS: PIERRE_TREE_UNSAFE_CSS,
    onSelectionChange: (selected) => {
      const path = selected.at(-1);
      // Folders end in a slash; only files open.
      if (path && fileSet.has(path)) {
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
        {/* The tree fills a flex column of fixed height, as it does in the file browser. */}
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
      <div className="min-w-0">
        {current === SKILL_FILE ? (
          <SkillTextPane skillText={skillText} />
        ) : (
          <OtherFilePane environmentId={environmentId} home={home} path={current} />
        )}
      </div>
    </div>
  );
}

/** SKILL.md as rendered text, or as the file reads with its header. */
function SkillTextPane({ skillText }: { skillText: string | null }) {
  const [source, setSource] = useState(false);
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-1.5">
        <span className="font-mono text-xs">{SKILL_FILE}</span>
        <span className="flex-1" />
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
      </div>
      <div className={`${PANE_HEIGHT} flex flex-col overflow-hidden`}>
        {skillText === null ? (
          <p className="px-4 py-3 text-sm text-warning-foreground">
            SKILL.md is missing or too large to show here.
          </p>
        ) : source ? (
          <ReadOnlySourcePreview name={SKILL_FILE} text={skillText} />
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-sm break-words">
            <SkillMarkdown text={skillBody(skillText)} />
          </div>
        )}
      </div>
    </div>
  );
}

/** Any other file, read from disk when it is clicked. */
function OtherFilePane({
  environmentId,
  home,
  path,
}: {
  environmentId: EnvironmentId;
  home: string;
  path: string;
}) {
  const file = useProjectFileQuery(environmentId, home, path);
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-1.5">
        <span className="min-w-0 truncate font-mono text-xs">{path}</span>
        <span className="flex-1" />
        <span className="text-xs text-muted-foreground">Read-only</span>
      </div>
      <div className={`${PANE_HEIGHT} flex flex-col overflow-hidden`}>
        {file.data ? (
          <>
            {file.data.truncated && (
              <p className="px-3 py-1 text-xs text-warning-foreground">
                This file is large, so only the start is shown.
              </p>
            )}
            <ReadOnlySourcePreview
              name={path}
              text={file.data.contents}
              cacheKey={`${home}/${path}`}
            />
          </>
        ) : file.isPending ? (
          <p role="status" className="px-3 py-3 text-xs text-muted-foreground">
            Loading {path}…
          </p>
        ) : (
          <p className="px-3 py-3 text-xs text-muted-foreground">
            {file.isNotFile ? "This is a folder." : "This file can't be previewed here."}
          </p>
        )}
      </div>
    </div>
  );
}
