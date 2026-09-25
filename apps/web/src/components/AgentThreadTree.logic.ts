/**
 * Agents panel structure for child threads (toolboxmd/t3code#17): which
 * section a spawn belongs to, which threads nest under a row, and the
 * parent/sibling links for a child thread's header breadcrumb.
 *
 * Pure functions over thread shells and the subagent fold, so every client
 * can reuse them and tests need no rendering.
 */
import type {
  RuntimeSubagent,
  RuntimeSubagentStatus,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type { OrchestrationThreadShell } from "@t3tools/contracts";

import { parentThreadIdOf } from "./subagentThreads";

/**
 * Model Router (planned name Prism) opens every job thread with
 * `[model-router job <request id> <kind> on route <route>; planner thread <id>]`.
 */
export interface RouterJobTag {
  readonly requestId: string;
  readonly kind: string;
  readonly route: string;
  readonly plannerThreadId: string;
}

const ROUTER_JOB_TAG = /^\[model-router job (\S+) (.+?) on route (\S+); planner thread (\S+?)\]/;

export function parseRouterJobTag(text: string): RouterJobTag | null {
  const match = ROUTER_JOB_TAG.exec(text.trimStart());
  if (!match) return null;
  const [, requestId, kind, route, plannerThreadId] = match;
  return { requestId: requestId!, kind: kind!, route: route!, plannerThreadId: plannerThreadId! };
}

/** Recognizes a router thread from its loaded user messages, oldest first. */
export function routerJobTagOfMessages(
  messages: ReadonlyArray<{ readonly role: string; readonly text: string }>,
): RouterJobTag | null {
  for (const message of messages) {
    if (message.role !== "user") continue;
    const tag = parseRouterJobTag(message.text);
    if (tag) return tag;
  }
  return null;
}

/** Threads carry their parent in the `sub.<parent>.<suffix>` id; a real field wins. */
function parentThreadIdOfShell(shell: {
  readonly id: string;
  readonly parentThreadId?: string | null;
}): string | null {
  return shell.parentThreadId ?? parentThreadIdOf(shell.id);
}

interface TreeShell {
  readonly id: string;
  readonly createdAt: string;
  readonly archivedAt: string | null;
  readonly parentThreadId?: string | null;
}

/** Live child threads per parent id, in spawn order. */
export function childThreadsByParent<T extends TreeShell>(
  shells: ReadonlyArray<T>,
): ReadonlyMap<string, ReadonlyArray<T>> {
  const byParent = new Map<string, T[]>();
  for (const shell of shells) {
    if (shell.archivedAt !== null) continue;
    const parentId = parentThreadIdOfShell(shell);
    if (parentId === null) continue;
    const siblings = byParent.get(parentId);
    if (siblings) siblings.push(shell);
    else byParent.set(parentId, [shell]);
  }
  for (const siblings of byParent.values()) {
    siblings.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }
  return byParent;
}

export interface PrismJobGroup {
  readonly requestId: string;
  readonly route: string;
  readonly status: RuntimeSubagentStatus;
  readonly agents: ReadonlyArray<RuntimeSubagent>;
}

export interface AgentSections {
  readonly directAgents: ReadonlyArray<RuntimeSubagent>;
  readonly prismJobs: ReadonlyArray<PrismJobGroup>;
}

// Most urgent first: a job reads as working while any thread works.
const JOB_STATUS_PRECEDENCE: ReadonlyArray<RuntimeSubagentStatus> = [
  "running",
  "waiting",
  "pending",
  "failed",
  "interrupted",
  "cancelled",
  "idle",
  "completed",
];

function jobStatusOf(agents: ReadonlyArray<RuntimeSubagent>): RuntimeSubagentStatus {
  for (const status of JOB_STATUS_PRECEDENCE) {
    if (agents.some((agent) => agent.status === status)) return status;
  }
  return "pending";
}

/**
 * Splits the panel's direct spawns: threads Model Router started for this
 * thread go to "Prism spawns", grouped by job in first-seen order; everything
 * this thread started itself stays in "Direct spawns".
 */
export function assignAgentSections(
  directAgents: ReadonlyArray<RuntimeSubagent>,
  routerTags: ReadonlyMap<string, RouterJobTag | null>,
): AgentSections {
  const direct: RuntimeSubagent[] = [];
  const jobs = new Map<string, { tags: RouterJobTag[]; agents: RuntimeSubagent[] }>();
  for (const agent of directAgents) {
    const tag = routerTags.get(agent.id) ?? null;
    if (tag === null) {
      direct.push(agent);
      continue;
    }
    const job = jobs.get(tag.requestId);
    if (job) {
      job.tags.push(tag);
      job.agents.push(agent);
    } else {
      jobs.set(tag.requestId, { tags: [tag], agents: [agent] });
    }
  }
  return {
    directAgents: direct,
    prismJobs: [...jobs].map(([requestId, job]) => ({
      requestId,
      route: (job.tags.find((tag) => tag.kind === "dispatcher") ?? job.tags[0]!).route,
      status: jobStatusOf(job.agents),
      agents: job.agents,
    })),
  };
}

/** Coarse Agents-panel status for a thread known only by its shell. */
export function threadShellStatus(
  shell: Pick<OrchestrationThreadShell, "session" | "latestTurn">,
): RuntimeSubagentStatus {
  const session = shell.session?.status;
  const turn = shell.latestTurn?.state;
  if (session === "running" || session === "starting" || turn === "running") return "running";
  if (session === "error" || turn === "error") return "failed";
  if (session === "interrupted" || turn === "interrupted") return "interrupted";
  if (turn === "completed") return "idle";
  return "pending";
}

/** Toggles one row's children; nothing else changes, so nothing opens on its own. */
export function toggleExpandedThread(
  expanded: ReadonlySet<string>,
  threadId: string,
): ReadonlySet<string> {
  const next = new Set(expanded);
  if (!next.delete(threadId)) next.add(threadId);
  return next;
}

export interface ThreadBreadcrumbLinks<T> {
  readonly parent: T;
  readonly siblings: ReadonlyArray<T>;
}

/**
 * Parent and siblings (including the thread itself) for a child thread's
 * header, or null for a thread the user started or whose parent is gone.
 */
export function threadBreadcrumbLinks<T extends TreeShell>(
  threadId: string,
  shells: ReadonlyArray<T>,
): ThreadBreadcrumbLinks<T> | null {
  const self = shells.find((shell) => shell.id === threadId);
  const parentId = self ? parentThreadIdOfShell(self) : parentThreadIdOf(threadId);
  if (parentId === null) return null;
  const parent = shells.find((shell) => shell.id === parentId);
  if (!parent) return null;
  return { parent, siblings: childThreadsByParent(shells).get(parentId) ?? [] };
}
