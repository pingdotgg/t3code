import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  CheckIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  CircleDashedIcon,
  MessageCircleQuestionIcon,
  PowerIcon,
  ShieldQuestionIcon,
  UserRoundIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { resolveSidebarThreadStatus, type SidebarSection } from "../../Sidebar.logic";
import { sidebarFolderRowId } from "../SidebarProjectFolderHeader";
import { workerBucket, type DetailedFolderItem, type WorkerBucket } from "./sidebarVariant.logic";

const WORKER_BUCKETS: readonly WorkerBucket[] = ["need", "failed", "working", "done", "idle"];

const BUCKET_BAR: Record<WorkerBucket, string> = {
  need: "bg-warning-foreground",
  failed: "bg-error-foreground",
  working: "bg-info-foreground",
  done: "bg-success-foreground",
  idle: "bg-secondary-label",
};

const BUCKET_TEXT: Record<WorkerBucket, string> = {
  need: "text-warning-foreground",
  failed: "text-error-foreground",
  working: "text-info-foreground",
  done: "text-success-foreground",
  idle: "text-secondary-label",
};

const BUCKET_LABEL: Record<WorkerBucket, string> = {
  need: "need you",
  failed: "failed",
  working: "working",
  done: "done",
  idle: "idle",
};

const BUCKET_ICON = {
  need: ShieldQuestionIcon,
  failed: CircleAlertIcon,
  working: CircleDashedIcon,
  done: CheckIcon,
  idle: PowerIcon,
} as const;

const SECONDARY_ROW_CLASS_NAME =
  "sidebar-variant-tokens w-full cursor-pointer rounded-md text-left text-xs outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

function WorkerStrip(props: {
  rowId: string;
  parentRow: string;
  workers: readonly EnvironmentThreadShell[];
  open: boolean;
  onToggle: () => void;
}) {
  const buckets = props.workers.map(workerBucket);
  const counts = WORKER_BUCKETS.flatMap((bucket) => {
    const count = buckets.filter((candidate) => candidate === bucket).length;
    return count > 0 ? [{ bucket, count }] : [];
  });
  const summary = counts.map(({ bucket, count }) => `${count} ${BUCKET_LABEL[bucket]}`).join(", ");
  return (
    <li className="list-none">
      <button
        type="button"
        data-sidebar-row={props.rowId}
        data-sidebar-parent={props.parentRow}
        aria-expanded={props.open}
        aria-label={`${props.workers.length} workers: ${summary}`}
        onClick={props.onToggle}
        className={cn(SECONDARY_ROW_CLASS_NAME, "flex flex-col gap-1 py-1 ps-9 pe-2.5")}
      >
        <span aria-hidden className="flex h-1 w-full gap-0.5">
          {buckets.map((bucket, index) => (
            <span
              key={props.workers[index]!.id}
              className={cn("h-1 min-w-px flex-1 rounded-full", BUCKET_BAR[bucket])}
            />
          ))}
        </span>
        <span className="flex h-4 items-center gap-2">
          {counts.map(({ bucket, count }) => {
            const Icon = BUCKET_ICON[bucket];
            return (
              <span
                key={bucket}
                className={cn(
                  "inline-flex items-center gap-1 font-medium tabular-nums",
                  BUCKET_TEXT[bucket],
                )}
              >
                <Icon aria-hidden className="size-3 shrink-0" />
                {count}
              </span>
            );
          })}
          <ChevronDownIcon
            aria-hidden
            className={cn(
              "ms-auto size-3 shrink-0 text-secondary-label transition-transform duration-150 motion-reduce:transition-none",
              !props.open && "-rotate-90",
            )}
          />
        </span>
      </button>
    </li>
  );
}

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
          "flex h-7 items-center gap-2.5 ps-9 pe-2.5 text-secondary-label hover:text-foreground",
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
  onToggleWorkers: (parentKey: string, open: boolean) => void;
  onToggleParked: (projectKey: string) => void;
  renderHeader: (folder: TFolder) => ReactNode;
  renderRow: (
    thread: EnvironmentThreadShell,
    section: SidebarSection,
    folderRow: string,
    nested: boolean,
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
                return props.renderRow(item.thread, item.section, folderRow, item.nested);
              case "workers":
                return (
                  <WorkerStrip
                    key={`workers:${item.parentKey}`}
                    rowId={`workers:${item.parentKey}`}
                    parentRow={folderRow}
                    workers={item.workers}
                    open={item.open}
                    onToggle={() => props.onToggleWorkers(item.parentKey, item.open)}
                  />
                );
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
