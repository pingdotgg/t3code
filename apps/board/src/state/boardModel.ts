import {
  isProviderNativeSubagentThread,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";

import type { Ticket, TicketStage } from "../domain/ticket";
import { ROLES } from "../orchestrator/roles";

/** What the board reads of a thread in the orchestrator's family, from the family read and the shell stream. */
export type FamilyRow = Pick<
  OrchestrationV2ThreadShell,
  | "id"
  | "title"
  | "providerInstanceId"
  | "status"
  | "branch"
  | "lineage"
  | "creationSource"
  | "activityRunStatus"
  | "pendingBackgroundTasks"
  | "pendingRuntimeRequest"
  | "pullRequests"
>;

export type RunState = "working" | "waiting" | "idle" | "failed" | "stopped";

export interface AgentView {
  readonly threadId: string;
  readonly title: string;
  /** The role in a `[<ticket key>] <role>` title, or the whole title when it has no such prefix. */
  readonly role: string;
  /** Whether the role is one of the registry's. An agent the orchestrator started outside it is flagged. */
  readonly registered: boolean;
  /** T3 made this thread from the provider's own subagent call, not from `delegate_task`, so no registry role started it. */
  readonly outsideRegistry: boolean;
  readonly ticketKey: string | null;
  readonly driver: string | null;
  readonly runState: RunState;
  /** The agent waits on a question or an approval from the user. */
  readonly pendingRequest: boolean;
  readonly branch: string | null;
  readonly parentThreadId: string | null;
  readonly round: number | null;
}

export interface TicketView {
  readonly ticket: Ticket;
  readonly agents: ReadonlyArray<AgentView>;
}

export interface BoardModel {
  readonly lanes: Readonly<Record<TicketStage, ReadonlyArray<TicketView>>>;
  /** Agents no ticket claims. */
  readonly unassigned: ReadonlyArray<AgentView>;
}

export interface AgentNode {
  readonly agent: AgentView;
  readonly children: ReadonlyArray<AgentNode>;
  /** Direct children that are working now. */
  readonly working: number;
}

const ROLE_NAMES: ReadonlySet<string> = new Set(ROLES.map((role) => role.name));
const TITLE = /^\[([^\]]+)\]\s*(.+)$/;
const LIVE_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "preparing",
  "starting",
  "running",
  "waiting",
]);

/** Run state from the shell row. An orchestrator's own run ends while its delegated tasks keep going, so those count as working. */
function runStateOf(row: FamilyRow): RunState {
  if (row.status === "waiting") return "waiting";
  if (
    LIVE_STATUSES.has(row.status) ||
    row.activityRunStatus != null ||
    (row.pendingBackgroundTasks?.length ?? 0) > 0
  ) {
    return "working";
  }
  if (row.status === "failed") return "failed";
  return row.status === "interrupted" || row.status === "cancelled" ? "stopped" : "idle";
}

function agentOf(
  row: FamilyRow,
  driverOf: (instanceId: string) => string | null,
  entry: { readonly role: string; readonly round?: number | null } | null,
): AgentView {
  const parts = TITLE.exec(row.title);
  const titled = parts?.[2]?.trim() ?? row.title;
  // A title can carry the delegate_task `role` argument, such as `implementation`, in place of the
  // registry role. The role the orchestrator recorded on the ticket then names the agent.
  const role =
    !ROLE_NAMES.has(titled) && entry !== null && ROLE_NAMES.has(entry.role) ? entry.role : titled;
  return {
    threadId: row.id,
    title: row.title,
    role,
    registered: ROLE_NAMES.has(role),
    outsideRegistry: isProviderNativeSubagentThread(row),
    ticketKey: parts?.[1] ?? null,
    driver: driverOf(row.providerInstanceId),
    runState: runStateOf(row),
    pendingRequest: row.pendingRuntimeRequest !== null,
    branch: row.branch,
    parentThreadId: row.lineage.parentThreadId,
    round: entry?.round ?? null,
  };
}

/**
 * Joins the orchestrator's tickets with its thread family. A ticket claims an agent through its
 * `threads`, or through the key in the agent's title, which is there as soon as the agent starts,
 * before the orchestrator has written it into the file.
 */
export function joinBoard(input: {
  readonly tickets: ReadonlyArray<Ticket>;
  readonly family: ReadonlyArray<FamilyRow>;
  readonly orchestratorThreadId: string;
  readonly driverOf: (instanceId: string) => string | null;
}): BoardModel {
  const rows = new Map<string, FamilyRow>(
    input.family.filter((row) => row.id !== input.orchestratorThreadId).map((row) => [row.id, row]),
  );
  const claimed = new Set<string>();
  const byTicket = new Map<string, AgentView[]>();
  for (const ticket of input.tickets) {
    const agents: AgentView[] = [];
    for (const entry of ticket.threads ?? []) {
      const row = rows.get(entry.threadId);
      if (row === undefined || claimed.has(row.id)) continue;
      claimed.add(row.id);
      agents.push(agentOf(row, input.driverOf, entry));
    }
    byTicket.set(ticket.key, agents);
  }
  const unassigned: AgentView[] = [];
  for (const row of rows.values()) {
    if (claimed.has(row.id)) continue;
    const agent = agentOf(row, input.driverOf, null);
    const owner = agent.ticketKey === null ? undefined : byTicket.get(agent.ticketKey);
    if (owner === undefined) unassigned.push(agent);
    else owner.push(agent);
  }

  const lane = (stage: TicketStage): ReadonlyArray<TicketView> =>
    input.tickets
      .filter((ticket) => ticket.stage === stage)
      .map((ticket) => ({ ticket, agents: byTicket.get(ticket.key) ?? [] }));
  return {
    lanes: {
      planned: lane("planned"),
      building: lane("building"),
      reviewing: lane("reviewing"),
      verifying: lane("verifying"),
      pr: lane("pr"),
      awaiting_approval: lane("awaiting_approval"),
      merged: lane("merged"),
      off_path: lane("off_path"),
    },
    unassigned,
  };
}

/** The family as a tree by `lineage.parentThreadId`. A thread whose parent is missing from the family hangs off the root. */
export function agentTree(input: {
  readonly family: ReadonlyArray<FamilyRow>;
  readonly orchestratorThreadId: string;
  readonly driverOf: (instanceId: string) => string | null;
}): ReadonlyArray<AgentNode> {
  const rows = input.family.filter((row) => row.id !== input.orchestratorThreadId);
  const present = new Set<string>(rows.map((row) => row.id));
  const childrenOf = new Map<string, FamilyRow[]>();
  for (const row of rows) {
    const parent = row.lineage.parentThreadId;
    const key = parent !== null && present.has(parent) ? parent : input.orchestratorThreadId;
    childrenOf.set(key, [...(childrenOf.get(key) ?? []), row]);
  }
  const build = (row: FamilyRow, seen: ReadonlySet<string>): AgentNode => {
    const children = (childrenOf.get(row.id) ?? [])
      .filter((child) => !seen.has(child.id))
      .map((child) => build(child, new Set(seen).add(child.id)));
    return {
      agent: agentOf(row, input.driverOf, null),
      children,
      working: children.filter((child) => child.agent.runState === "working").length,
    };
  };
  return (childrenOf.get(input.orchestratorThreadId) ?? []).map((row) =>
    build(row, new Set([row.id])),
  );
}
