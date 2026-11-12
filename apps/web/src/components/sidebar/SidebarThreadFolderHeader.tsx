import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentThreadFolder } from "@t3tools/client-runtime/state/thread-folders";
import { resolveThreadCurrentPullRequestLink } from "@t3tools/client-runtime/thread-pull-requests";
import { AuthOrchestrationOperateScope, type ProjectIconOverride } from "@t3tools/contracts";
import type { SidebarThreadFolderStyle } from "@t3tools/contracts/settings";
import {
  CheckIcon,
  ChevronDownIcon,
  FolderClosedIcon,
  FolderOpenIcon,
  Undo2Icon,
} from "lucide-react";
import {
  memo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";

import { cn } from "~/lib/utils";
import { projectIconColorClassName, projectIconTintClassName } from "../../projectIconColors";
import { useEnvironmentScope } from "../../state/session";
import { requestThreadFolderRename, useThreadFolderRenameKey } from "../../state/threadFolders";
import { useUiStateStore } from "../../uiStateStore";
import { ProjectIconOverrideGlyph } from "../ProjectFavicon";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { resolveSidebarFolderDot, resolveThreadLastVisitedAt } from "../Sidebar.logic";

const FOLDER_DOT_CLASS_NAME = {
  attention: "bg-warning",
  failed: "bg-error",
  unread: "bg-success",
  working: "bg-info",
} as const;

const FOLDER_DOT_LABEL = {
  attention: ", needs you",
  failed: ", failed",
  unread: ", done",
  working: ", working",
} as const;

const DOUBLE_CLICK_WINDOW_MS = 500;
const MAX_NAME_LENGTH = 80;

export function sidebarThreadFolderRowId(folderKey: string) {
  return `thread-folder:${folderKey}`;
}

export function threadFolderTintClassName(icon: ProjectIconOverride | null) {
  return icon && icon.kind !== "emoji"
    ? projectIconTintClassName(icon.color)
    : "bg-sidebar-foreground/[0.05]";
}

/** Cards tint each member row; tabs draw a line in the folder's color beside them instead. */
export function threadFolderMemberClassName(
  icon: ProjectIconOverride | null,
  style: SidebarThreadFolderStyle,
) {
  if (style === "cards") return threadFolderTintClassName(icon);
  // The row sets its own text color, so this color reaches only the line.
  // Rows clip paint (content-visibility), so -mt-px closes the list gap to join the lines.
  return cn(
    "relative -mt-px ps-5 before:pointer-events-none before:absolute before:inset-y-0 before:start-2.5 before:w-0.5 before:bg-current/50",
    icon && icon.kind !== "emoji"
      ? projectIconColorClassName(icon.color)
      : "text-sidebar-muted-foreground",
  );
}

function hasVisiblePullRequest(thread: EnvironmentThreadShell) {
  return (
    resolveThreadCurrentPullRequestLink(thread.pullRequests) !== null ||
    thread.linkedPullRequest != null ||
    thread.branchPullRequest != null
  );
}

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

// Mounted only while renaming, so each rename starts from the current name.
function FolderRenameInput(props: {
  name: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(props.name);
  // Enter and Escape blur the input as it unmounts; that blur must not commit again.
  const settledRef = useRef(false);
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter") {
      event.preventDefault();
      settledRef.current = true;
      props.onCommit(draft);
    } else if (event.key === "Escape") {
      event.preventDefault();
      settledRef.current = true;
      props.onCancel();
    }
  };
  return (
    <input
      autoFocus
      value={draft}
      dir="auto"
      maxLength={MAX_NAME_LENGTH}
      aria-label="Folder name"
      onChange={(event) => setDraft(event.target.value)}
      onFocus={(event) => event.currentTarget.select()}
      onKeyDown={handleKeyDown}
      onBlur={() => {
        if (!settledRef.current) props.onCommit(draft);
      }}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      className="min-w-0 flex-1 rounded-sm border border-input bg-card px-1 text-sm font-medium text-card-foreground outline-none focus:border-foreground"
    />
  );
}

/**
 * The top of a thread folder's card. It is one flat `<li>` carrying the tint; the
 * member rows that follow it in the list carry the same tint and close the card.
 */
export const SidebarThreadFolderHeader = memo(function SidebarThreadFolderHeader(props: {
  folder: EnvironmentThreadFolder;
  folderKey: string;
  style: SidebarThreadFolderStyle;
  collapsed: boolean;
  threads: readonly EnvironmentThreadShell[];
  hiddenThreads: readonly EnvironmentThreadShell[];
  hiddenLiveThreads: readonly EnvironmentThreadShell[];
  isDropTarget: boolean;
  isDragging: boolean;
  /** Where a dragged folder would land relative to this one. */
  reorderMark: "before" | "after" | null;
  onDragStart: (folder: EnvironmentThreadFolder, event: PointerEvent) => void;
  /** Settles every thread, or un-settles a settled folder; null hides the button. */
  settleAction: "settle" | "unsettle" | null;
  onSettle: (folder: EnvironmentThreadFolder, action: "settle" | "unsettle") => void;
  onToggle: (folderKey: string) => void;
  onRename: (folder: EnvironmentThreadFolder, name: string) => void;
  onContextMenu: (folder: EnvironmentThreadFolder, position: { x: number; y: number }) => void;
}) {
  const { folder, folderKey, collapsed, threads, hiddenThreads, onToggle } = props;
  const canOperate = useEnvironmentScope(folder.environmentId, AuthOrchestrationOperateScope);
  const isRenaming = useThreadFolderRenameKey() === folderKey;
  const localLastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const icon = folder.icon;
  const color = icon && icon.kind !== "emoji" ? icon.color : null;
  const nameClassName = color ? projectIconColorClassName(color) : "text-sidebar-foreground";
  const pullRequestCount = collapsed ? threads.filter(hasVisiblePullRequest).length : 0;
  const dot = collapsed
    ? resolveSidebarFolderDot(
        props.hiddenLiveThreads.map((thread) => ({
          ...thread,
          lastVisitedAt: resolveThreadLastVisitedAt(
            thread.lastVisitedAt,
            localLastVisitedAtById[
              scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
            ],
          ),
        })),
      )
    : null;
  const label = [
    `${folder.name} folder`,
    plural(threads.length, "thread"),
    ...(pullRequestCount > 0 ? [plural(pullRequestCount, "pull request")] : []),
  ].join(", ");
  const Icon = collapsed ? FolderClosedIcon : FolderOpenIcon;

  // Folds made by the clicks of a rename double-click, so the double-click can undo them.
  // Touch reports every tap as a first click, so this counts folds instead of `event.detail`.
  const foldClicksRef = useRef({ count: 0, at: 0 });
  const handleClick = (event: ReactMouseEvent) => {
    if (isRenaming || event.detail > 1) return;
    const now = event.timeStamp;
    const clicks = foldClicksRef.current;
    foldClicksRef.current = {
      count: now - clicks.at < DOUBLE_CLICK_WINDOW_MS ? clicks.count + 1 : 1,
      at: now,
    };
    onToggle(folderKey);
  };
  const handleDoubleClick = (event: ReactMouseEvent) => {
    if (isRenaming || !canOperate) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (foldClicksRef.current.count % 2 === 1) onToggle(folderKey);
    foldClicksRef.current = { count: 0, at: 0 };
    requestThreadFolderRename(folderKey);
  };
  const handleKeyDown = (event: ReactKeyboardEvent) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "F2" && canOperate) {
      event.preventDefault();
      requestThreadFolderRename(folderKey);
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onToggle(folderKey);
  };

  return (
    <li
      data-thread-selection-safe
      data-testid="sidebar-thread-folder"
      data-thread-folder-drop={folderKey}
      className={cn(
        "group/thread-folder list-none mt-2 first:mt-0",
        props.style === "tabs"
          ? "rounded-md"
          : [
              collapsed || threads.length === 0 ? "rounded-lg" : "rounded-t-lg",
              threadFolderTintClassName(icon),
            ],
        props.isDropTarget && "ring-2 ring-inset ring-primary/70",
        props.isDragging && "opacity-60",
        props.reorderMark !== null && "relative",
      )}
    >
      {props.reorderMark !== null ? (
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-x-1 h-0.5 rounded-full bg-primary",
            props.reorderMark === "before" ? "-top-1.5" : "-bottom-1.5",
          )}
        />
      ) : null}
      <div
        role={isRenaming ? undefined : "treeitem"}
        tabIndex={-1}
        data-sidebar-row={sidebarThreadFolderRowId(folderKey)}
        aria-expanded={isRenaming ? undefined : !collapsed}
        aria-label={isRenaming ? undefined : `${label}${dot ? FOLDER_DOT_LABEL[dot] : ""}`}
        className={cn(
          "mx-0.5 flex h-9 cursor-pointer items-center gap-2 rounded-md px-2 text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          props.style === "tabs"
            ? cn(nameClassName, "bg-current/15 hover:bg-current/22")
            : "hover:bg-sidebar-row-hover/70",
        )}
        onClick={handleClick}
        onPointerDown={(event) => {
          if (!isRenaming && canOperate) props.onDragStart(folder, event.nativeEvent);
        }}
        onDoubleClick={handleDoubleClick}
        onKeyDown={handleKeyDown}
        onContextMenu={(event) => {
          event.preventDefault();
          props.onContextMenu(folder, { x: event.clientX, y: event.clientY });
        }}
      >
        <span
          className={cn(
            "flex size-5 shrink-0 items-center justify-center rounded-[25%]",
            icon?.kind !== "monogram" && "bg-current/14",
            nameClassName,
          )}
        >
          {icon ? (
            <ProjectIconOverrideGlyph
              icon={icon}
              className={icon.kind === "monogram" ? "size-5" : "size-3.5"}
            />
          ) : (
            <Icon aria-hidden className="size-3.5" />
          )}
        </span>
        {isRenaming ? (
          <FolderRenameInput
            name={folder.name}
            onCommit={(name) => {
              const trimmed = name.trim();
              if (trimmed !== "" && trimmed !== folder.name) props.onRename(folder, trimmed);
              requestThreadFolderRename(null);
            }}
            onCancel={() => requestThreadFolderRename(null)}
          />
        ) : (
          <span className={cn("min-w-0 flex-1 truncate text-sm font-semibold", nameClassName)}>
            {folder.name}
          </span>
        )}
        {pullRequestCount > 0 ? (
          <span
            aria-hidden
            className="inline-flex shrink-0 items-center gap-0.5 text-2xs tabular-nums text-sidebar-muted-foreground"
          >
            <PullRequestGlyph.pullRequest aria-hidden className="size-3" />
            {pullRequestCount}
          </span>
        ) : null}
        {collapsed && hiddenThreads.length > 0 ? (
          <span
            aria-hidden
            className="shrink-0 text-xs tabular-nums text-sidebar-muted-foreground group-has-focus-visible/thread-folder:hidden group-hover/thread-folder:hidden"
          >
            {hiddenThreads.length}
          </span>
        ) : null}
        {dot ? (
          <span
            aria-hidden
            className={cn("size-1.5 shrink-0 rounded-full", FOLDER_DOT_CLASS_NAME[dot])}
          />
        ) : null}
        {isRenaming || props.settleAction === null || !canOperate ? null : (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={
                    props.settleAction === "settle" ? "Settle folder" : "Un-settle folder"
                  }
                  onClick={(event) => {
                    event.stopPropagation();
                    props.onSettle(folder, props.settleAction!);
                  }}
                  onPointerDown={(event) => event.stopPropagation()}
                  onDoubleClick={(event) => event.stopPropagation()}
                  className="hidden size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground hover:text-sidebar-foreground group-has-focus-visible/thread-folder:inline-flex group-hover/thread-folder:inline-flex pointer-coarse:inline-flex"
                />
              }
            >
              {props.settleAction === "settle" ? (
                <CheckIcon aria-hidden className="size-3.5" />
              ) : (
                <Undo2Icon aria-hidden className="size-3.5" />
              )}
            </TooltipTrigger>
            <TooltipPopup side="top">
              {props.settleAction === "settle" ? "Settle folder" : "Un-settle folder"}
            </TooltipPopup>
          </Tooltip>
        )}
        {isRenaming ? null : (
          <ChevronDownIcon
            aria-hidden
            className={cn(
              "hidden size-3 shrink-0 text-sidebar-muted-foreground transition-transform group-has-focus-visible/thread-folder:block group-hover/thread-folder:block pointer-coarse:block",
              collapsed && "-rotate-90",
            )}
          />
        )}
      </div>
    </li>
  );
});

export const SidebarThreadFolderEmptyRow = memo(function SidebarThreadFolderEmptyRow(props: {
  folder: EnvironmentThreadFolder;
  folderKey: string;
  style: SidebarThreadFolderStyle;
}) {
  return (
    <li
      aria-hidden
      data-thread-selection-safe
      data-thread-folder-drop={props.folderKey}
      className={cn(
        threadFolderMemberClassName(props.folder.icon, props.style),
        "list-none rounded-b-lg pb-2 ps-9 text-xs",
      )}
    >
      <span className="text-sidebar-muted-foreground">
        {props.folder.threadIds.length > 0 ? "No active threads" : "No threads yet"}
      </span>
    </li>
  );
});
