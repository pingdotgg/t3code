import type { ProjectIgnoredFile } from "@t3tools/contracts";
import { ChevronDownIcon, ChevronRightIcon, FolderIcon } from "lucide-react";
import { useState } from "react";

import { COPYABLE_FILE_MAX_BYTES } from "../lib/addProjectToMachine";
import { formatBytes } from "../lib/formatBytes";
import {
  buildIgnoredFileTree,
  countSelectedIgnoredDescendants,
  getDefaultIgnoredFileExpansion,
  type IgnoredFileTreeNode,
} from "../lib/ignoredFileTree";
import { Checkbox } from "./ui/checkbox";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export function IgnoredFileTree({
  files,
  defaultFiles,
  searching,
  selected,
  atSelectionLimit,
  onCheckedChange,
}: {
  files: readonly ProjectIgnoredFile[];
  defaultFiles: readonly ProjectIgnoredFile[] | null;
  searching: boolean;
  selected: ReadonlyMap<string, ProjectIgnoredFile>;
  atSelectionLimit: boolean;
  onCheckedChange: (file: ProjectIgnoredFile, checked: boolean) => void;
}) {
  const tree = buildIgnoredFileTree(files);
  const [expanded, setExpanded] = useState<ReadonlySet<string> | null>(null);
  if (expanded === null && defaultFiles !== null) {
    setExpanded(getDefaultIgnoredFileExpansion(buildIgnoredFileTree(defaultFiles)));
  }

  const fileRow = (file: ProjectIgnoredFile, name: string) => (
    <IgnoredFileRow
      file={file}
      name={name}
      checked={selected.has(file.path)}
      atSelectionLimit={atSelectionLimit}
      onCheckedChange={(checked) => onCheckedChange(file, checked)}
    />
  );

  function renderNodes(nodes: readonly IgnoredFileTreeNode[]): React.ReactNode {
    return nodes.map((node) => {
      if (node.kind === "file") return <li key={node.path}>{fileRow(node.file, node.name)}</li>;
      const open = expanded?.has(node.path) ?? false;
      const selectedCount = countSelectedIgnoredDescendants(node.path, selected.keys());
      const ChevronIcon = open ? ChevronDownIcon : ChevronRightIcon;
      return (
        <li key={node.path}>
          <button
            type="button"
            aria-expanded={open}
            aria-label={`${node.path}, ${node.listedCount} listed${selectedCount ? `, ${selectedCount} selected` : ""}`}
            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2"
            onClick={() =>
              setExpanded((current) => {
                const next = new Set(current);
                if (open) next.delete(node.path);
                else next.add(node.path);
                return next;
              })
            }
          >
            <ChevronIcon className="size-3.5 shrink-0" aria-hidden />
            <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0 flex-1 truncate font-mono">{node.name}</span>
            <span className="shrink-0 text-muted-foreground tabular-nums">
              {node.listedCount} listed{selectedCount ? ` · ${selectedCount} selected` : ""}
            </span>
          </button>
          {open ? <ul className="ml-4 border-l">{renderNodes(node.children)}</ul> : null}
        </li>
      );
    });
  }

  if (files.length === 0) return null;
  return (
    <div className="max-h-52 overflow-y-auto rounded-md border">
      <ul>
        {searching
          ? files.map((file) => <li key={file.path}>{fileRow(file, file.path)}</li>)
          : renderNodes(tree)}
      </ul>
    </div>
  );
}

function IgnoredFileRow({
  file,
  name,
  checked,
  atSelectionLimit,
  onCheckedChange,
}: {
  file: ProjectIgnoredFile;
  name: string;
  checked: boolean;
  atSelectionLimit: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const tooLarge = file.byteLength > COPYABLE_FILE_MAX_BYTES;
  return (
    <label className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-sm has-disabled:cursor-not-allowed has-disabled:opacity-64">
      <Checkbox
        aria-label={file.path}
        checked={checked}
        disabled={tooLarge || (!checked && atSelectionLimit)}
        onCheckedChange={onCheckedChange}
      />
      <Tooltip>
        <TooltipTrigger render={<span className="min-w-0 flex-1 truncate font-mono text-xs" />}>
          {name}
        </TooltipTrigger>
        <TooltipPopup variant="code">{file.path}</TooltipPopup>
      </Tooltip>
      <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
        {tooLarge ? "Over 1 MB" : formatBytes(file.byteLength)}
      </span>
    </label>
  );
}
