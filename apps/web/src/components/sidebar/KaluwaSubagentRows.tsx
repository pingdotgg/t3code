// Fork: Kaluwa's sub-agents in the folder tree: rows nested under their parent thread, the
// "⑂ N" fold toggle on the parent, and the marker for a child that needs the user. Sizes and
// connectors live in the "Kaluwa folder tree" block of index.css.
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { CheckIcon, ChevronDownIcon, EyeIcon, GitForkIcon } from "lucide-react";
import { T, useGT } from "gt-react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";

import { cn } from "~/lib/utils";
import { useClientSettings } from "../../hooks/useSettings";
import { shouldShowInstanceBadge } from "../../providerInstances";
import {
  isKaluwaSubagentFoldOpen,
  kaluwaSubagentIndexAtom,
  useKaluwaSubagentChildren,
  useKaluwaSubagentFolds,
} from "../../state/kaluwaSubagents";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { KaluwaThreadAvatar } from "./KaluwaThreadAvatar";
import {
  type KaluwaChildAttention,
  type KaluwaChildStatus,
  type KaluwaSubagentChild,
  resolveKaluwaChildAttention,
} from "./kaluwaSidebarTree.logic";
import type { SidebarProviderEntry } from "./SidebarThreadRow";

const NO_PROVIDER_ENTRIES: ReadonlyMap<string, SidebarProviderEntry> = new Map();

function useSubagentMode() {
  return useClientSettings((settings) => settings.kaluwaSidebarSubagents);
}

/**
 * What the parent's avatar marks, or null. With the marker on, the parent row shows its own
 * status and the marker carries the child's, so the caller drops the rolled-up request.
 */
export function useKaluwaChildAttention(
  parentKey: string | null,
  pendingSubagentRequest: EnvironmentThreadShell["pendingSubagentRequest"],
): { readonly attention: KaluwaChildAttention | null; readonly ownStatus: boolean } {
  const mode = useSubagentMode();
  const marker = useClientSettings((settings) => settings.kaluwaSidebarChildAttention);
  const children = useKaluwaSubagentChildren(
    parentKey === null || mode === "off" ? null : parentKey,
  );
  if (parentKey === null || mode === "off" || marker === "off") {
    return { attention: null, ownStatus: false };
  }
  return {
    attention: resolveKaluwaChildAttention(children, pendingSubagentRequest ?? null),
    ownStatus: true,
  };
}

export function useKaluwaChildAttentionLabel(): boolean {
  return useClientSettings((settings) => settings.kaluwaSidebarChildAttention) === "label";
}

/**
 * The listed thread whose nested row stands for the open thread, so that parent's own row is
 * not highlighted too. Null when the open thread is not a nested sub-agent.
 */
export function useKaluwaRouteChildParent(routeThreadKey: string | null): string | null {
  const mode = useSubagentMode();
  const index = useAtomValue(kaluwaSubagentIndexAtom);
  if (routeThreadKey === null || mode === "off") return null;
  for (const [parentKey, children] of index) {
    if (children.some((child) => child.key === routeThreadKey)) return parentKey;
  }
  return null;
}

/** The "↳ Approval" label that replaces the parent's quiet meta while a child needs the user. */
export function KaluwaChildAttentionLabel(props: { readonly attention: KaluwaChildAttention }) {
  const gt = useGT();
  const label =
    props.attention === "approval"
      ? gt("Approval", { $context: "thread status: needs approval" })
      : props.attention === "input"
        ? gt("Input", { $context: "thread status: needs user input" })
        : gt("Failed", { $context: "thread status" });
  return (
    <span className="kaluwa-folder-status" data-kaluwa-status={props.attention}>
      <span aria-hidden>↳ </span>
      <span className="sr-only">{gt("A sub-agent needs you:")} </span>
      {label}
    </span>
  );
}

/** "⑂ N ⌄" on a parent row: folds its sub-agents. Neutral unless a child needs the user. */
export function KaluwaSubagentToggle(props: {
  readonly parentKey: string;
  readonly pendingSubagentRequest: EnvironmentThreadShell["pendingSubagentRequest"];
}) {
  const gt = useGT();
  const mode = useSubagentMode();
  const children = useKaluwaSubagentChildren(mode === "off" ? null : props.parentKey);
  const open = useKaluwaSubagentFolds((state) =>
    mode === "off" ? false : isKaluwaSubagentFoldOpen(state.open, props.parentKey, mode),
  );
  const setOpen = useKaluwaSubagentFolds((state) => state.setOpen);
  if (mode === "off" || children.length === 0) return null;
  const attention = resolveKaluwaChildAttention(children, props.pendingSubagentRequest ?? null);
  const count = children.length;
  const label = open
    ? gt("{count, plural, one {Hide {count} sub-agent} other {Hide {count} sub-agents}}", { count })
    : gt("{count, plural, one {Show {count} sub-agent} other {Show {count} sub-agents}}", {
        count,
      });
  const handleClick = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setOpen(props.parentKey, !open);
  };
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label={label}
      data-kaluwa-mode={mode}
      data-kaluwa-status={attention ?? undefined}
      onClick={handleClick}
      onPointerDown={(event) => event.stopPropagation()}
      className="kaluwa-subtoggle"
    >
      <GitForkIcon aria-hidden className="kaluwa-subtoggle-icon" />
      <span className="tabular-nums">{count}</span>
      <ChevronDownIcon aria-hidden className="kaluwa-subtoggle-chevron" />
    </button>
  );
}

function childStatusLabel(
  child: Pick<KaluwaSubagentChild, "kind" | "status">,
  gt: ReturnType<typeof useGT>,
): string | null {
  if (child.kind === "native") {
    if (child.status === "failed") return gt("Failed", { $context: "thread status" });
    if (child.status === "working" || child.status === "waiting") {
      return gt("Running", { $context: "sub-agent status" });
    }
    return gt("Done", { $context: "thread status" });
  }
  switch (child.status) {
    case "working":
      return gt("Working", { $context: "thread status" });
    case "waiting":
      return gt("Waiting", { $context: "thread status" });
    case "approval":
      return gt("Approval", { $context: "thread status: needs approval" });
    case "input":
      return gt("Input", { $context: "thread status: needs user input" });
    case "failed":
      return gt("Failed", { $context: "thread status" });
    case "done":
      return gt("Done", { $context: "thread status" });
    case "idle":
      return null;
  }
}

const AVATAR_STATUS: Record<
  KaluwaChildStatus,
  "working" | "waiting" | "approval" | "input" | "failed" | "done" | null
> = {
  working: "working",
  waiting: "waiting",
  approval: "approval",
  input: "input",
  failed: "failed",
  done: "done",
  idle: null,
};

function splitSubagentTitle(title: string): {
  readonly lead: string;
  readonly rest: string | null;
} {
  const at = title.indexOf(" · ");
  return at === -1
    ? { lead: title, rest: null }
    : { lead: title.slice(0, at), rest: title.slice(at + 3) };
}

function KaluwaSubagentRow(props: {
  readonly child: KaluwaSubagentChild;
  readonly parentKey: string;
  readonly first: boolean;
  readonly last: boolean;
  readonly parentLast: boolean;
  readonly isActive: boolean;
  readonly providerEntryByInstanceId: ReadonlyMap<string, SidebarProviderEntry>;
  readonly onOpen: (ref: ScopedThreadRef) => void;
}) {
  const gt = useGT();
  const { child } = props;
  const ref = scopeThreadRef(child.environmentId, child.threadId);
  const statusLabel = childStatusLabel(child, gt);
  const title = splitSubagentTitle(child.title);
  const providerEntry = props.providerEntryByInstanceId.get(child.providerInstanceId) ?? null;
  const showInstanceBadge =
    providerEntry !== null &&
    shouldShowInstanceBadge(providerEntry, props.providerEntryByInstanceId.values());
  const handleKeyDown = (event: ReactKeyboardEvent) => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    props.onOpen(ref);
  };
  return (
    <li
      className="kaluwa-sub list-none"
      data-kind={child.kind}
      data-kaluwa-status={child.status}
      data-first={props.first || undefined}
      data-last={props.last || undefined}
      data-pthru={!props.parentLast || undefined}
    >
      <span aria-hidden className="kaluwa-sub-ptrunk" />
      <span aria-hidden className="kaluwa-sub-elbow" />
      <span aria-hidden className="kaluwa-sub-trunk" />
      <div
        role="button"
        tabIndex={0}
        data-sidebar-row={child.key}
        data-sidebar-parent={props.parentKey}
        aria-current={props.isActive ? "page" : undefined}
        aria-label={[
          child.title,
          statusLabel,
          child.kind === "native" ? gt("read-only sub-agent") : gt("sub-agent thread"),
        ]
          .filter(Boolean)
          .join(", ")}
        onClick={() => props.onOpen(ref)}
        onKeyDown={handleKeyDown}
        className={cn(
          "kaluwa-sub-pill cursor-pointer outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          props.isActive
            ? "bg-sidebar-row-active text-sidebar-foreground"
            : "hover:bg-sidebar-row-hover",
        )}
      >
        {child.kind === "native" ? (
          <span aria-hidden className="kaluwa-nat">
            <span className="kaluwa-nat-ring" />
            {child.status === "done" ? <CheckIcon className="kaluwa-nat-check" /> : <i />}
          </span>
        ) : (
          <KaluwaThreadAvatar
            providerEntry={providerEntry}
            showInstanceBadge={showInstanceBadge}
            status={AVATAR_STATUS[child.status]}
            recede={child.status === "idle" || child.status === "done"}
          />
        )}
        <span className="kaluwa-sub-title">
          <b>{title.lead}</b>
          {title.rest === null ? null : <em> · {title.rest}</em>}
        </span>
        {child.kind === "native" ? (
          <Tooltip>
            <TooltipTrigger render={<span className="kaluwa-sub-ro" />}>
              <EyeIcon aria-hidden />
            </TooltipTrigger>
            <TooltipPopup side="top">
              <T>Read-only: runs inside its parent's turn</T>
            </TooltipPopup>
          </Tooltip>
        ) : null}
        {statusLabel === null ? null : <span className="kaluwa-sub-meta">{statusLabel}</span>}
      </div>
    </li>
  );
}

/**
 * A folder thread's sub-agents, as rows right after it. While the folder or the fold is closed,
 * only the open sub-agent stays, the way a closed folder keeps its open thread.
 */
export function KaluwaSubagentRows(props: {
  readonly parentKey: string;
  readonly parentLast: boolean;
  readonly collapsed: boolean;
  readonly routeThreadKey: string | null;
  readonly providerEntriesByEnvironment: ReadonlyMap<
    string,
    ReadonlyMap<string, SidebarProviderEntry>
  >;
  readonly onOpen: (ref: ScopedThreadRef) => void;
}) {
  const mode = useSubagentMode();
  const children = useKaluwaSubagentChildren(mode === "off" ? null : props.parentKey);
  const open = useKaluwaSubagentFolds((state) =>
    mode === "off" ? false : isKaluwaSubagentFoldOpen(state.open, props.parentKey, mode),
  );
  if (mode === "off" || children.length === 0) return null;
  const shown =
    open && !props.collapsed
      ? children
      : children.filter((child) => child.key === props.routeThreadKey);
  if (shown.length === 0) return null;
  return (
    <>
      {shown.map((child, index) => (
        <KaluwaSubagentRow
          key={child.key}
          child={child}
          parentKey={props.parentKey}
          first={index === 0}
          last={index === shown.length - 1}
          parentLast={props.parentLast}
          isActive={child.key === props.routeThreadKey}
          providerEntryByInstanceId={
            props.providerEntriesByEnvironment.get(child.environmentId) ?? NO_PROVIDER_ENTRIES
          }
          onOpen={props.onOpen}
        />
      ))}
    </>
  );
}
