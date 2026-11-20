import { ChevronDown, ChevronRight, Folder } from "lucide-react";
import { useState } from "react";

import { FileRow, ROW } from "./ChangeFileRow";
import type { ChangeFile, ChangeNode, ChangeSet } from "./changeSet";
import { Counts } from "./Counts";

/** A change set as Orca lists it: a flat list with each file's folder beside its name, or a tree of folders. */
export function ChangeRows({
  set,
  asTree,
  selectedPath,
  onOpen,
}: {
  set: ChangeSet;
  asTree: boolean;
  selectedPath: string | null;
  onOpen: (file: ChangeFile) => void;
}) {
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const toggle = (path: string) =>
    setClosed((before) => {
      const next = new Set(before);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  const rows = (nodes: ReadonlyArray<ChangeNode>, depth: number) =>
    nodes.map((node) => {
      if (node.kind === "file") {
        return (
          <FileRow
            key={node.path}
            file={node}
            indent={depth}
            flat={false}
            selected={node.path === selectedPath}
            onOpen={onOpen}
          />
        );
      }
      const open = !closed.has(node.path);
      const Chevron = open ? ChevronDown : ChevronRight;
      return (
        <div key={node.path}>
          <button
            type="button"
            aria-expanded={open}
            onClick={() => toggle(node.path)}
            style={{ paddingLeft: 8 + depth * 12 }}
            className={ROW}
          >
            <Chevron className="size-3.5 shrink-0 text-faint" aria-hidden />
            <Folder className="size-3.5 shrink-0 text-muted" aria-hidden />
            <span className="min-w-0 truncate text-fg">{node.name}</span>
            <span className="flex-1" />
            <Counts additions={node.additions} deletions={node.deletions} />
          </button>
          {open && rows(node.children, depth + 1)}
        </div>
      );
    });
  return (
    <div role="list" className="flex flex-col px-1">
      {asTree
        ? rows(set.tree, 0)
        : set.files.map((file) => (
            <FileRow
              key={file.path}
              file={file}
              indent={0}
              flat
              selected={file.path === selectedPath}
              onOpen={onOpen}
            />
          ))}
    </div>
  );
}
