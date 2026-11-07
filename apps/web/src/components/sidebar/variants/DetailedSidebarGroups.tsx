import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  ChevronDownIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
  UserRoundIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { resolveSidebarThreadStatus, type SidebarSection } from "../../Sidebar.logic";
import { sidebarFolderRowId } from "../SidebarProjectFolderHeader";
import type { DetailedFolderItem } from "./sidebarVariant.logic";

const SECONDARY_ROW_CLASS_NAME =
  "sidebar-variant-tokens w-full cursor-pointer rounded-md text-left text-xs outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

function ParkedToggle(props: {
  rowId: string;
  parentRow: string;
  label: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <li className="list-none">
      <button
        type="button"
        data-sidebar-row={props.rowId}
        data-sidebar-parent={props.parentRow}
        aria-expanded={props.open}
        onClick={props.onToggle}
        className={cn(
          SECONDARY_ROW_CLASS_NAME,
          "flex h-7 items-center gap-2.5 ps-11 pe-3 text-secondary-label hover:text-foreground",
        )}
      >
        <span className="min-w-0 flex-1 truncate">{props.label}</span>
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0 transition-transform duration-150 motion-reduce:transition-none",
            !props.open && "-rotate-90",
          )}
        />
      </button>
    </li>
  );
}

function waitingIcon(thread: EnvironmentThreadShell): ReactNode {
  const status = resolveSidebarThreadStatus(thread);
  if (status === "input") {
    return (
      <MessageCircleQuestionIcon aria-hidden className="sidebar-input-mark size-3.5 shrink-0" />
    );
  }
  if (status === "request") {
    return <UserRoundIcon aria-hidden className="size-3.5 shrink-0 text-guest-foreground" />;
  }
  return <ShieldQuestionIcon aria-hidden className="size-3.5 shrink-0 text-warning-foreground" />;
}

/** Sticks to the list's bottom edge, so a new ask moves no row above it. */
function WaitingOnYou(props: {
  threads: readonly EnvironmentThreadShell[];
  routeThreadKey: string | null;
  projectNameOf: (thread: EnvironmentThreadShell) => string | null;
  onNavigate: (ref: ScopedThreadRef) => void;
}) {
  if (props.threads.length === 0) return null;
  return (
    <li
      data-testid="sidebar-waiting-on-you"
      className="sidebar-variant-tokens surface-grain sticky bottom-0 z-20 mt-auto list-none border-t border-sidebar-border sidebar-waiting-surface pt-1"
    >
      <p className="flex h-7 items-center justify-between px-(--sidebar-row-content-inset) text-xs font-medium text-secondary-label">
        Waiting on you
        <span className="tabular-nums">{props.threads.length}</span>
      </p>
      <ul className="flex max-h-48 flex-col gap-px overflow-y-auto">
        {props.threads.map((thread) => {
          const ref = scopeThreadRef(thread.environmentId, thread.id);
          const key = scopedThreadKey(ref);
          return (
            <li key={key} className="list-none">
              <button
                type="button"
                data-sidebar-row={`waiting:${key}`}
                aria-current={props.routeThreadKey === key ? "page" : undefined}
                onClick={() => props.onNavigate(ref)}
                className={cn(
                  SECONDARY_ROW_CLASS_NAME,
                  "flex h-7 items-center gap-2.5 px-(--sidebar-row-content-inset) aria-[current=page]:bg-sidebar-row-active",
                )}
              >
                <span className="flex size-4 shrink-0 items-center justify-center">
                  {waitingIcon(thread)}
                </span>
                <span className="min-w-0 flex-1 truncate text-foreground">{thread.title}</span>
                <span className="max-w-16 shrink-0 truncate text-secondary-label">
                  {props.projectNameOf(thread)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </li>
  );
}

/** Project groups that hold their threads whatever their state, plus the Waiting on you list. */
export function DetailedSidebarGroups<
  TFolder extends {
    readonly group: { readonly projectKey: string };
    readonly items: readonly DetailedFolderItem[];
  },
>(props: {
  folders: readonly TFolder[];
  waiting: readonly EnvironmentThreadShell[];
  routeThreadKey: string | null;
  projectNameOf: (thread: EnvironmentThreadShell) => string | null;
  onNavigate: (ref: ScopedThreadRef) => void;
  onToggleParked: (projectKey: string) => void;
  renderHeader: (folder: TFolder) => ReactNode;
  renderRow: (
    thread: EnvironmentThreadShell,
    section: SidebarSection,
    folderRow: string,
    item: { nested: boolean; lastNested: boolean; workersOpen: boolean | null },
  ) => ReactNode;
}) {
  return (
    <>
      {props.folders.flatMap((folder) => {
        const projectKey = folder.group.projectKey;
        const folderRow = sidebarFolderRowId(projectKey);
        return [
          props.renderHeader(folder),
          ...folder.items.map((item) => {
            switch (item.kind) {
              case "thread":
                return props.renderRow(item.thread, item.section, folderRow, item);
              case "parked":
                return (
                  <ParkedToggle
                    key={`parked:${projectKey}`}
                    rowId={`parked:${projectKey}`}
                    parentRow={folderRow}
                    label={item.label}
                    open={item.open}
                    onToggle={() => props.onToggleParked(projectKey)}
                  />
                );
            }
          }),
        ];
      })}
      <WaitingOnYou
        threads={props.waiting}
        routeThreadKey={props.routeThreadKey}
        projectNameOf={props.projectNameOf}
        onNavigate={props.onNavigate}
      />
    </>
  );
}
