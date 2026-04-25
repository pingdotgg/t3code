import { ChevronRightIcon, FolderClosedIcon, FolderIcon } from "lucide-react";
import { type ReactNode, memo, useCallback, useMemo, useState } from "react";

import {
  buildPreviewCatalogTree,
  collectPreviewCatalogDirectoryPaths,
  type PreviewCatalogTreeEntryLike,
  type PreviewCatalogTreeDirectoryNode,
  type PreviewCatalogTreeNode,
} from "~/lib/previewCatalogTree";
import { cn } from "~/lib/utils";
import { VscodeEntryIcon } from "../chat/VscodeEntryIcon";

const EMPTY_DIRECTORY_OVERRIDES: Record<string, boolean> = {};

export interface PreviewCatalogTreeSection {
  readonly key: string;
  readonly label: string;
  readonly description?: string | null;
  readonly entries: ReadonlyArray<PreviewCatalogTreeEntryLike>;
}

export const PreviewCatalogTree = memo(function PreviewCatalogTree(props: {
  readonly sections: ReadonlyArray<PreviewCatalogTreeSection>;
  readonly selectedPreviewId: string | null;
  readonly changedPreviewIds: ReadonlySet<string>;
  readonly searchQuery: string;
  readonly resolvedTheme: "light" | "dark";
  readonly emptyState: ReactNode;
  readonly onSelectPreview: (previewId: string) => void;
}) {
  const {
    changedPreviewIds,
    emptyState,
    onSelectPreview,
    resolvedTheme,
    searchQuery,
    selectedPreviewId,
    sections,
  } = props;
  const sectionTrees = useMemo(
    () =>
      sections.map((section) => ({
        section,
        nodes: buildPreviewCatalogTree({
          entries: section.entries,
          searchQuery,
          selectedPreviewId,
          changedPreviewIds,
        }),
      })),
    [changedPreviewIds, searchQuery, sections, selectedPreviewId],
  );
  const directoryPathsKey = useMemo(
    () =>
      sectionTrees
        .flatMap(({ nodes }) => collectPreviewCatalogDirectoryPaths(nodes))
        .join("\u0000"),
    [sectionTrees],
  );
  const [directoryExpansionState, setDirectoryExpansionState] = useState<{
    key: string;
    overrides: Record<string, boolean>;
  }>(() => ({
    key: directoryPathsKey,
    overrides: {},
  }));
  const expandedDirectories =
    directoryExpansionState.key === directoryPathsKey
      ? directoryExpansionState.overrides
      : EMPTY_DIRECTORY_OVERRIDES;
  const searchActive = searchQuery.trim().length > 0;

  const toggleDirectory = useCallback(
    (pathValue: string, nextDefaultExpanded: boolean) => {
      setDirectoryExpansionState((current) => {
        const nextOverrides = current.key === directoryPathsKey ? current.overrides : {};
        return {
          key: directoryPathsKey,
          overrides: {
            ...nextOverrides,
            [pathValue]: !(nextOverrides[pathValue] ?? nextDefaultExpanded),
          },
        };
      });
    },
    [directoryPathsKey],
  );

  const isDirectoryExpanded = useCallback(
    (node: PreviewCatalogTreeDirectoryNode, depth: number) => {
      if (searchActive || node.containsSelection) {
        return true;
      }
      const defaultExpanded = node.changedCount > 0 || depth === 0;
      return expandedDirectories[node.path] ?? defaultExpanded;
    },
    [expandedDirectories, searchActive],
  );

  const renderTreeNode = useCallback(
    (node: PreviewCatalogTreeNode, depth: number): ReactNode => {
      const leftPadding = 10 + depth * 14;
      if (node.kind === "directory") {
        const expanded = isDirectoryExpanded(node, depth);
        return (
          <div key={node.key}>
            <button
              type="button"
              className="group flex w-full items-center gap-1.5 rounded-md py-1.5 pr-2 text-left hover:bg-background/70"
              style={{ paddingLeft: `${leftPadding}px` }}
              onClick={() => toggleDirectory(node.path, expanded)}
            >
              <ChevronRightIcon
                className={cn(
                  "size-3.5 shrink-0 text-muted-foreground/60 transition-transform group-hover:text-foreground/75",
                  expanded && "rotate-90",
                )}
              />
              {expanded ? (
                <FolderIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
              ) : (
                <FolderClosedIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
              )}
              <span className="truncate font-mono text-[11px] text-muted-foreground/85 group-hover:text-foreground/90">
                {node.name}
              </span>
              {node.changedCount > 0 ? (
                <span className="ml-auto shrink-0 rounded-full bg-emerald-500/12 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400">
                  {node.changedCount}
                </span>
              ) : null}
            </button>
            {expanded ? (
              <div className="space-y-0.5">
                {node.children.map((child) => renderTreeNode(child, depth + 1))}
              </div>
            ) : null}
          </div>
        );
      }

      return (
        <button
          key={node.key}
          type="button"
          title={node.entry.componentPath}
          className={cn(
            "group flex w-full items-start gap-2 rounded-md py-1.5 pr-2 text-left transition-colors hover:bg-background/70",
            node.selected && "bg-accent/55 text-accent-foreground hover:bg-accent/65",
          )}
          style={{ paddingLeft: `${leftPadding}px` }}
          onClick={() => onSelectPreview(node.entry.id)}
        >
          <VscodeEntryIcon
            pathValue={node.entry.componentPath}
            kind="file"
            theme={resolvedTheme}
            className="mt-0.5 size-3.5 shrink-0"
          />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-[12px] font-medium text-foreground/90 group-hover:text-foreground">
                {node.entry.label}
              </span>
              {node.changed ? (
                <span className="size-1.5 shrink-0 rounded-full bg-emerald-400" />
              ) : null}
            </div>
            <div className="truncate font-mono text-[10px] text-muted-foreground/65">
              {node.fileName}
            </div>
          </div>
        </button>
      );
    },
    [isDirectoryExpanded, onSelectPreview, resolvedTheme, toggleDirectory],
  );

  const visibleSections = sectionTrees.filter(({ nodes }) => nodes.length > 0);

  if (visibleSections.length === 0) {
    return <>{emptyState}</>;
  }

  return (
    <div className="space-y-3 p-1">
      {visibleSections.map(({ section, nodes }) => (
        <section key={section.key} className="space-y-1">
          <div className="px-2 pt-1">
            <p className="text-[10px] font-semibold tracking-widest text-muted-foreground/55 uppercase">
              {section.label}
            </p>
            {section.description ? (
              <p className="text-[11px] text-muted-foreground/65">{section.description}</p>
            ) : null}
          </div>
          <div className="space-y-0.5">{nodes.map((node) => renderTreeNode(node, 0))}</div>
        </section>
      ))}
    </div>
  );
});
