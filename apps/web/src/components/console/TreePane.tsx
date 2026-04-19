import type { TurnId } from "@workbench/contracts";
import { FileSearchIcon, FolderOpenIcon } from "lucide-react";

import { cn } from "~/lib/utils";

import type { WorkspaceTreeNode } from "../../lib/workspaceFileTree";
import type { WorkspaceArtifact } from "../../workspaceArtifacts";
import { Button } from "../ui/button";
import { VscodeEntryIcon } from "../chat/VscodeEntryIcon";

interface TreePaneProps {
  resolvedTheme: "light" | "dark";
  treeNodes: ReadonlyArray<WorkspaceTreeNode>;
  treeIsLoading: boolean;
  selectedPath: string | null;
  expandedDirectories: ReadonlySet<string>;
  selectedArtifact: WorkspaceArtifact | null;
  firstDiffCapableArtifact: WorkspaceArtifact | null;
  onSelectFile: (path: string) => void;
  onToggleDirectory: (path: string) => void;
  onOpenTurnDiff: ((turnId: TurnId, filePath?: string) => void) | undefined;
}

/**
 * Body content of the Files card. The card chrome (icon + title + collapse +
 * close X) is provided by the surrounding `PaneCard` in `ConsoleRail`.
 */
export function TreePane({
  resolvedTheme,
  treeNodes,
  treeIsLoading,
  selectedPath,
  expandedDirectories,
  selectedArtifact,
  firstDiffCapableArtifact,
  onSelectFile,
  onToggleDirectory,
  onOpenTurnDiff,
}: TreePaneProps) {
  return (
    <div className="min-h-0 flex-1">
      <div className="space-y-2 p-3">
        {treeNodes.length ? (
          <WorkspaceTree
            nodes={treeNodes}
            expandedDirectories={expandedDirectories}
            selectedPath={selectedPath}
            resolvedTheme={resolvedTheme}
            onToggleDirectory={onToggleDirectory}
            onSelectFile={onSelectFile}
          />
        ) : treeIsLoading ? (
          <p className="px-2 py-3 text-sm text-muted-foreground/72">
            Building the workspace tree...
          </p>
        ) : (
          <p className="px-2 py-3 text-sm leading-6 text-muted-foreground/72">
            Files will appear here once the workspace is available.
          </p>
        )}

        {(selectedArtifact?.turnId || firstDiffCapableArtifact?.turnId) && onOpenTurnDiff ? (
          <div className="border-t border-border/45 pt-3">
            <p className="text-[11px] font-semibold tracking-[0.16em] text-muted-foreground/55 uppercase">
              Advanced
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {selectedArtifact?.turnId ? (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => onOpenTurnDiff(selectedArtifact.turnId!, selectedArtifact.path)}
                >
                  <FileSearchIcon className="size-3.5" />
                  Selected file diff
                </Button>
              ) : null}
              {firstDiffCapableArtifact?.turnId ? (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => onOpenTurnDiff(firstDiffCapableArtifact.turnId!)}
                >
                  Full diff viewer
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * "Reveal in Finder" button for the Files card. Rendered as `headerActions`
 * on the surrounding `PaneCard` so it sits inline with the title bar.
 */
export function TreePaneRevealAction({
  workspaceRoot,
  onRevealWorkspaceRoot,
}: {
  workspaceRoot: string | undefined;
  onRevealWorkspaceRoot: () => void;
}) {
  return (
    <Button
      size="icon-xs"
      variant="ghost"
      onClick={onRevealWorkspaceRoot}
      disabled={!workspaceRoot}
      aria-label="Open workspace folder in Finder"
      title="Open workspace folder in Finder"
      className="text-muted-foreground/55 hover:text-foreground/80"
    >
      <FolderOpenIcon className="size-3.5" />
    </Button>
  );
}

// ----- inner tree primitives -----

function WorkspaceTree(props: {
  nodes: ReadonlyArray<WorkspaceTreeNode>;
  expandedDirectories: ReadonlySet<string>;
  selectedPath: string | null;
  resolvedTheme: "light" | "dark";
  onToggleDirectory: (path: string) => void;
  onSelectFile: (path: string) => void;
}) {
  return (
    <div className="space-y-0.5">
      {props.nodes.map((node) =>
        node.kind === "directory" ? (
          <WorkspaceTreeDirectory
            key={node.path}
            node={node}
            depth={0}
            expandedDirectories={props.expandedDirectories}
            selectedPath={props.selectedPath}
            resolvedTheme={props.resolvedTheme}
            onToggleDirectory={props.onToggleDirectory}
            onSelectFile={props.onSelectFile}
          />
        ) : (
          <WorkspaceTreeFile
            key={node.path}
            node={node}
            depth={0}
            selectedPath={props.selectedPath}
            resolvedTheme={props.resolvedTheme}
            onSelectFile={props.onSelectFile}
          />
        ),
      )}
    </div>
  );
}

function WorkspaceTreeDirectory(props: {
  node: Extract<WorkspaceTreeNode, { kind: "directory" }>;
  depth: number;
  expandedDirectories: ReadonlySet<string>;
  selectedPath: string | null;
  resolvedTheme: "light" | "dark";
  onToggleDirectory: (path: string) => void;
  onSelectFile: (path: string) => void;
}) {
  const isExpanded = props.expandedDirectories.has(props.node.path);
  return (
    <div>
      <button
        type="button"
        onClick={() => props.onToggleDirectory(props.node.path)}
        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-foreground/84 transition-colors hover:bg-background/70"
        style={{ paddingLeft: `${props.depth * 14 + 8}px` }}
      >
        <ChevronGlyph open={isExpanded} />
        <VscodeEntryIcon
          pathValue={props.node.path}
          kind="directory"
          theme={props.resolvedTheme}
          className="size-4 shrink-0 text-muted-foreground/75"
        />
        <span className="min-w-0 flex-1 truncate">{props.node.name}</span>
        {props.node.changed ? (
          <span className="size-1.5 shrink-0 rounded-full bg-blue-400" aria-hidden="true" />
        ) : null}
      </button>
      {isExpanded ? (
        <div>
          {props.node.children.map((child) =>
            child.kind === "directory" ? (
              <WorkspaceTreeDirectory
                key={child.path}
                node={child}
                depth={props.depth + 1}
                expandedDirectories={props.expandedDirectories}
                selectedPath={props.selectedPath}
                resolvedTheme={props.resolvedTheme}
                onToggleDirectory={props.onToggleDirectory}
                onSelectFile={props.onSelectFile}
              />
            ) : (
              <WorkspaceTreeFile
                key={child.path}
                node={child}
                depth={props.depth + 1}
                selectedPath={props.selectedPath}
                resolvedTheme={props.resolvedTheme}
                onSelectFile={props.onSelectFile}
              />
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}

function WorkspaceTreeFile(props: {
  node: Extract<WorkspaceTreeNode, { kind: "file" }>;
  depth: number;
  selectedPath: string | null;
  resolvedTheme: "light" | "dark";
  onSelectFile: (path: string) => void;
}) {
  const isSelected = props.selectedPath === props.node.path;
  return (
    <button
      type="button"
      onClick={() => props.onSelectFile(props.node.path)}
      className={cn(
        "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors",
        isSelected ? "bg-blue-500/12 text-foreground" : "text-foreground/82 hover:bg-background/70",
      )}
      style={{ paddingLeft: `${props.depth * 14 + 28}px` }}
    >
      <VscodeEntryIcon
        pathValue={props.node.path}
        kind="file"
        theme={props.resolvedTheme}
        className="size-4 shrink-0 text-muted-foreground/72"
      />
      <span className="min-w-0 flex-1 truncate">{props.node.name}</span>
      {props.node.changed ? (
        <span className="size-1.5 shrink-0 rounded-full bg-blue-400" aria-hidden="true" />
      ) : null}
    </button>
  );
}

function ChevronGlyph({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className={cn(
        "size-3.5 shrink-0 text-muted-foreground/65 transition-transform",
        open ? "rotate-90" : "rotate-0",
      )}
    >
      <path
        d="M5.5 3.5L10 8l-4.5 4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
