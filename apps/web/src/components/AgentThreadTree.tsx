/**
 * Agents panel tree for child threads (toolboxmd/t3code#17): the Prism job
 * tags, the per-row child-count chevron, and the compact nested rows.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  formatSubagentModelLabel,
  type RuntimeSubagent,
  type RuntimeSubagentStatus,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useMemo, type ReactNode } from "react";
import { create } from "zustand";

import { cn } from "~/lib/utils";
import { useThreadDetail, useThreadShells } from "~/state/entities";
import { AgentThreadLink } from "./AgentThreadLink";
import {
  assignAgentSections,
  childThreadsByParent,
  routerJobTagOfMessages,
  threadShellStatus,
  type AgentSections,
  type RouterJobTag,
} from "./AgentThreadTree.logic";
import { isSubagentThreadId } from "./subagentThreads";

/**
 * Router tags never change once a thread's first message lands, so each
 * child thread is read once per session and then released.
 */
const useRouterJobTagStore = create<{
  readonly tags: Readonly<Record<string, RouterJobTag | null>>;
  readonly record: (key: string, tag: RouterJobTag | null) => void;
}>()((set) => ({
  tags: {},
  record: (key, tag) => set((state) => ({ tags: { ...state.tags, [key]: tag } })),
}));

const tagKey = (environmentId: EnvironmentId, threadId: string) =>
  `${environmentId}\u0000${threadId}`;

function RouterJobTagProbe({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: string;
}) {
  const detail = useThreadDetail(scopeThreadRef(environmentId, threadId as ThreadId));
  const record = useRouterJobTagStore((state) => state.record);
  useEffect(() => {
    // A thread with no user message yet may still receive its tag.
    if (!detail?.messages.some((message) => message.role === "user")) return;
    record(tagKey(environmentId, threadId), routerJobTagOfMessages(detail.messages));
  }, [detail, environmentId, record, threadId]);
  return null;
}

export interface AgentThreadTree {
  readonly sections: AgentSections;
  readonly childrenByParent: ReadonlyMap<string, ReadonlyArray<EnvironmentThreadShell>>;
  /** Mount once so unknown child threads get their router tag read. */
  readonly probes: ReactNode;
}

export function useAgentThreadTree(
  environmentId: EnvironmentId | null,
  directAgents: ReadonlyArray<RuntimeSubagent>,
): AgentThreadTree {
  const shells = useThreadShells();
  const tags = useRouterJobTagStore((state) => state.tags);
  const childrenByParent = useMemo(
    () => childThreadsByParent(shells.filter((shell) => shell.environmentId === environmentId)),
    [environmentId, shells],
  );
  return useMemo(() => {
    const known = new Map<string, RouterJobTag | null>();
    const unknown: string[] = [];
    if (environmentId !== null) {
      for (const agent of directAgents) {
        if (!isSubagentThreadId(agent.id)) continue;
        const key = tagKey(environmentId, agent.id);
        if (key in tags) known.set(agent.id, tags[key] ?? null);
        else unknown.push(agent.id);
      }
    }
    return {
      sections: assignAgentSections(directAgents, known),
      childrenByParent,
      probes:
        environmentId === null
          ? null
          : unknown.map((threadId) => (
              <RouterJobTagProbe key={threadId} environmentId={environmentId} threadId={threadId} />
            )),
    };
  }, [childrenByParent, directAgents, environmentId, tags]);
}

function ChildThreadToggle({
  count,
  open,
  onToggle,
}: {
  count: number;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={`${open ? "Hide" : "Show"} ${count} child ${count === 1 ? "thread" : "threads"}`}
      className="flex shrink-0 items-center gap-0.5 rounded-sm px-1 font-mono text-3xs text-muted-foreground hover:bg-accent/50 hover:text-foreground"
      data-testid="agents-panel-child-toggle"
    >
      {open ? (
        <ChevronDown aria-hidden className="size-3" />
      ) : (
        <ChevronRight aria-hidden className="size-3" />
      )}
      {count}
    </button>
  );
}

const COMPACT_DOT_CLASS: Record<RuntimeSubagentStatus, string> = {
  pending: "bg-info",
  running: "bg-info",
  waiting: "bg-info",
  idle: "bg-muted-foreground/50",
  completed: "bg-success",
  failed: "bg-destructive",
  cancelled: "bg-muted-foreground/60",
  interrupted: "bg-muted-foreground/60",
};

function shellModelLabel(shell: EnvironmentThreadShell): string | null {
  const effort = shell.modelSelection.options?.find((option) =>
    ["effort", "reasoningEffort", "variant"].includes(option.id),
  )?.value;
  return formatSubagentModelLabel(
    shell.modelSelection.model,
    typeof effort === "string" ? effort : null,
  );
}

interface TreeProps {
  environmentId: EnvironmentId | null;
  childrenByParent: ReadonlyMap<string, ReadonlyArray<EnvironmentThreadShell>>;
  expanded: ReadonlySet<string>;
  onToggle: (threadId: string) => void;
}

/** Compact one-line rows for a thread's children, each with its own chevron. */
function ChildThreadRows({
  parentId,
  depth,
  ...tree
}: TreeProps & { parentId: string; depth: number }) {
  const children = tree.childrenByParent.get(parentId) ?? [];
  return children.map((child) => {
    const grandchildren = tree.childrenByParent.get(child.id)?.length ?? 0;
    const open = tree.expanded.has(child.id);
    const status = threadShellStatus(child);
    return (
      <div key={child.id}>
        <div className="flex items-center gap-1" style={{ paddingLeft: `${depth * 0.75}rem` }}>
          <Link
            to="/$environmentId/$threadId"
            params={{ environmentId: child.environmentId, threadId: child.id }}
            className="flex h-6 min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 hover:bg-accent/50"
            data-testid="agents-panel-child-thread"
          >
            <span
              aria-hidden
              className={cn("size-1.5 shrink-0 rounded-full", COMPACT_DOT_CLASS[status])}
            />
            <span className="min-w-0 truncate text-xs">{child.title}</span>
            <span className="ml-auto shrink-0 font-mono text-3xs text-muted-foreground/80">
              {shellModelLabel(child)}
            </span>
          </Link>
          {grandchildren > 0 ? (
            <ChildThreadToggle
              count={grandchildren}
              open={open}
              onToggle={() => tree.onToggle(child.id)}
            />
          ) : null}
        </div>
        {open ? <ChildThreadRows {...tree} parentId={child.id} depth={depth + 1} /> : null}
      </div>
    );
  });
}

/** An agent row that opens its thread and can reveal that thread's children. */
export function AgentThreadEntry({
  agentId,
  children,
  ...tree
}: TreeProps & { agentId: string; children: ReactNode }) {
  const childCount = tree.childrenByParent.get(agentId)?.length ?? 0;
  const open = tree.expanded.has(agentId);
  return (
    <div>
      <div className="flex items-start">
        <div className="min-w-0 flex-1">
          <AgentThreadLink agentId={agentId} environmentId={tree.environmentId}>
            {children}
          </AgentThreadLink>
        </div>
        {childCount > 0 ? (
          <div className="pt-1.5">
            <ChildThreadToggle
              count={childCount}
              open={open}
              onToggle={() => tree.onToggle(agentId)}
            />
          </div>
        ) : null}
      </div>
      {open ? <ChildThreadRows {...tree} parentId={agentId} depth={1} /> : null}
    </div>
  );
}
