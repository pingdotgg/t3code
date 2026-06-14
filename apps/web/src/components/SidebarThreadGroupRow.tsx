import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronRightIcon, FolderIcon } from "lucide-react";
import { memo, useCallback, useMemo, useRef } from "react";

import { SidebarMenuSubButton, SidebarMenuSubItem } from "./ui/sidebar";
import type { ThreadGroup } from "../uiStateStore";

/** dnd id namespace for a folder header (distinct from thread-row ids = threadKeys). */
export function groupHeaderDndId(groupId: string): string {
  return `group-header:${groupId}`;
}

interface SidebarThreadGroupRowProps {
  group: ThreadGroup;
  threadCount: number;
  expanded: boolean;
  isRenaming: boolean;
  renamingTitle: string;
  setRenamingTitle: (title: string) => void;
  onToggle: (groupId: string) => void;
  onContextMenu: (groupId: string, position: { x: number; y: number }) => void;
  commitRename: (groupId: string) => void;
  cancelRename: () => void;
}

const SidebarThreadGroupRow = memo(function SidebarThreadGroupRow(
  props: SidebarThreadGroupRowProps,
) {
  const {
    group,
    threadCount,
    expanded,
    isRenaming,
    renamingTitle,
    setRenamingTitle,
    onToggle,
    onContextMenu,
    commitRename,
    cancelRename,
  } = props;

  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver } =
    useSortable({ id: groupHeaderDndId(group.id), disabled: isRenaming });

  const headerButtonRender = useMemo(() => <div role="button" tabIndex={0} />, []);
  // Drag listeners are suppressed while renaming so typing in the input never
  // initiates a folder drag.
  const dragHandleProps = isRenaming ? {} : { ...attributes, ...listeners };

  const handleClick = useCallback(() => {
    onToggle(group.id);
  }, [group.id, onToggle]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      onToggle(group.id);
    },
    [group.id, onToggle],
  );

  const handleContextMenu = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      onContextMenu(group.id, { x: event.clientX, y: event.clientY });
    },
    [group.id, onContextMenu],
  );

  // Guards the input's onBlur from re-committing after Enter/Escape already
  // resolved the rename (otherwise Escape cancels then blur silently commits).
  const renameResolvedRef = useRef(false);

  const handleRenameRef = useCallback((element: HTMLInputElement | null) => {
    if (element) {
      renameResolvedRef.current = false;
      element.focus();
      element.select();
    }
  }, []);

  const handleRenameKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        renameResolvedRef.current = true;
        commitRename(group.id);
      } else if (event.key === "Escape") {
        event.preventDefault();
        renameResolvedRef.current = true;
        cancelRename();
      }
    },
    [cancelRename, commitRename, group.id],
  );

  const handleRenameBlur = useCallback(() => {
    if (!renameResolvedRef.current) {
      commitRename(group.id);
    }
  }, [commitRename, group.id]);

  return (
    <SidebarMenuSubItem
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={`w-full ${isDragging ? "z-20 opacity-80" : ""}`}
      data-thread-group-item
      data-thread-selection-safe
    >
      <SidebarMenuSubButton
        render={headerButtonRender}
        size="sm"
        data-thread-selection-safe
        data-testid={`thread-group-${group.id}`}
        className={`h-6 w-full translate-x-0 cursor-pointer justify-start gap-1.5 px-1.5 text-left text-[11px] font-medium text-muted-foreground/80 hover:bg-accent hover:text-foreground ${
          isOver ? "ring-1 ring-primary/50" : ""
        }`}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        onContextMenu={handleContextMenu}
        {...dragHandleProps}
      >
        <ChevronRightIcon
          className={`-ml-0.5 size-3 shrink-0 text-muted-foreground/60 transition-transform duration-150 ${
            expanded ? "rotate-90" : ""
          }`}
        />
        <FolderIcon className="size-3 shrink-0 text-muted-foreground/50" />
        {isRenaming ? (
          <input
            ref={handleRenameRef}
            className="min-w-0 flex-1 truncate rounded border border-ring bg-transparent px-0.5 text-[11px] outline-none"
            value={renamingTitle}
            onChange={(event) => setRenamingTitle(event.target.value)}
            onKeyDown={handleRenameKeyDown}
            onBlur={handleRenameBlur}
            onClick={(event) => event.stopPropagation()}
          />
        ) : (
          <span className="min-w-0 flex-1 truncate">{group.name}</span>
        )}
        <span className="ml-auto shrink-0 tabular-nums text-[10px] text-muted-foreground/40">
          {threadCount}
        </span>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );
});

export default SidebarThreadGroupRow;
