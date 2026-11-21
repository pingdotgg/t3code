import type { AcpAdapterV2SubagentUpdate } from "@t3tools/provider-acp/server/adapter";
import * as Schema from "effect/Schema";

export const ANTIGRAVITY_SWARM_CAPABILITIES_META = {
  antigravity: {
    swarm: true,
  },
} as const;

export const ANTIGRAVITY_SWARM_NOTIFICATION_METHOD = "_antigravity/swarm";

const ANTIGRAVITY_SWARM_TASK_PREFIX = "swarm:";

export const AntigravitySwarmMember = Schema.Struct({
  name: Schema.String,
  role: Schema.String,
  conversationId: Schema.String,
  toolCallId: Schema.optional(Schema.String),
  brief: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  modelLabel: Schema.optional(Schema.String),
  state: Schema.String,
  failure: Schema.optional(Schema.String),
  workspace: Schema.optional(Schema.String),
  addedBy: Schema.optional(Schema.String),
});
export type AntigravitySwarmMember = Schema.Schema.Type<typeof AntigravitySwarmMember>;

export const AntigravitySwarmPost = Schema.Struct({
  seq: Schema.Number,
  time: Schema.optional(Schema.String),
  agent: Schema.String,
  channel: Schema.optional(Schema.String),
  kind: Schema.optional(Schema.String),
  text: Schema.String,
});
export type AntigravitySwarmPost = Schema.Schema.Type<typeof AntigravitySwarmPost>;

export const AntigravitySwarmNotification = Schema.Struct({
  sessionId: Schema.String,
  title: Schema.optional(Schema.String),
  head: Schema.Number,
  channels: Schema.optional(Schema.Array(Schema.String)),
  activeWorkers: Schema.Number,
  workingWorkers: Schema.Number,
  waitingWorkers: Schema.Number,
  coordinatorPendingWake: Schema.optional(Schema.Boolean),
  members: Schema.Array(AntigravitySwarmMember),
  posts: Schema.optional(Schema.Array(AntigravitySwarmPost)),
});
export type AntigravitySwarmNotification = Schema.Schema.Type<typeof AntigravitySwarmNotification>;

const MAX_BOARD_REPORT_CHARS = 8_000;

interface TrackedSwarmMember {
  nativeTaskId: string;
  name: string;
  conversationId: string;
  toolCallId: string | null;
  status: AcpAdapterV2SubagentUpdate["status"];
  latestReport: string | null;
  lastBrief: string;
  sawIdleOrReport: boolean;
}

interface TrackedSwarmSession {
  busy: boolean;
  readonly membersByConversationId: Map<string, TrackedSwarmMember>;
  readonly membersByName: Map<string, TrackedSwarmMember>;
  readonly latestPostsByAgent: Map<string, string>;
  readonly briefsByMention: Map<string, string>;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

function cleanBoardReport(text: string): string | null {
  const withoutCoordinatorPrefix = text.trim().replace(/^@(?:coordinator|all)\b[:,\s-]*/i, "");
  const normalized = (withoutCoordinatorPrefix.length > 0 ? withoutCoordinatorPrefix : text).trim();
  if (normalized.length === 0) return null;
  return normalized.length <= MAX_BOARD_REPORT_CHARS
    ? normalized
    : `${normalized.slice(0, MAX_BOARD_REPORT_CHARS - 1)}…`;
}

function extractMentionedNames(text: string): ReadonlyArray<string> {
  const names: Array<string> = [];
  for (const match of text.matchAll(/(?:^|\s)@([a-z0-9][a-z0-9_-]*)\b/gi)) {
    const name = match[1]?.toLowerCase();
    if (name !== undefined && name !== "coordinator" && name !== "all") {
      names.push(name);
    }
  }
  return names;
}

function formatSwarmMemberTitle(member: AntigravitySwarmMember): string {
  const handle = `@${member.name.replace(/^@/, "")}`;
  const roleSuffix =
    member.role !== "worker" && member.role.trim().length > 0 ? ` (${member.role.trim()})` : "";
  const addedBy = nonEmpty(member.addedBy)?.replace(/^@/, "");
  const parentSuffix = addedBy !== undefined && addedBy !== "coordinator" ? ` via @${addedBy}` : "";
  return `${handle}${roleSuffix}${parentSuffix}`;
}

function mapSwarmMemberStatus(
  state: string,
  sawIdleOrReport: boolean,
): AcpAdapterV2SubagentUpdate["status"] {
  switch (state.trim().toLowerCase()) {
    case "working":
      return "running";
    case "waiting":
    case "stopped":
      return "idle";
    case "failed":
      return "failed";
    case "killed":
      return sawIdleOrReport ? "completed" : "cancelled";
    default:
      return "idle";
  }
}

export function agentAdvertisesAntigravitySwarm(agentCapabilities: unknown): boolean {
  if (typeof agentCapabilities !== "object" || agentCapabilities === null) return false;
  const meta = (agentCapabilities as { readonly _meta?: unknown })._meta;
  if (typeof meta !== "object" || meta === null) return false;
  const antigravity = (meta as { readonly antigravity?: unknown }).antigravity;
  if (typeof antigravity !== "object" || antigravity === null) return false;
  const swarm = (antigravity as { readonly swarm?: unknown }).swarm;
  if (swarm === true) return true;
  if (typeof swarm === "object" && swarm !== null) {
    const enabled = (swarm as { readonly enabled?: unknown }).enabled;
    return enabled !== false;
  }
  return false;
}

export function swarmWorkerConversationIdFromTaskId(nativeTaskId: string): string | undefined {
  return nativeTaskId.startsWith(ANTIGRAVITY_SWARM_TASK_PREFIX)
    ? nativeTaskId.slice(ANTIGRAVITY_SWARM_TASK_PREFIX.length)
    : undefined;
}

export interface AntigravitySwarmMutation {
  readonly sessionId: string;
  readonly activeBackgroundWork: boolean;
  readonly subagents: ReadonlyArray<AcpAdapterV2SubagentUpdate>;
}

export interface AntigravitySwarmTracker {
  readonly applyNotification: (
    notification: AntigravitySwarmNotification,
  ) => AntigravitySwarmMutation;
  readonly hasLiveSwarm: (sessionId: string) => boolean;
  readonly partitionTaskIds: (
    sessionId: string,
    nativeTaskIds: ReadonlyArray<string>,
  ) => {
    readonly runningSwarmTaskIds: ReadonlyArray<string>;
    readonly unmanagedTaskIds: ReadonlyArray<string>;
  };
}

export function makeAntigravitySwarmTracker(): AntigravitySwarmTracker {
  const sessions = new Map<string, TrackedSwarmSession>();

  const sessionFor = (sessionId: string): TrackedSwarmSession => {
    let session = sessions.get(sessionId);
    if (session === undefined) {
      session = {
        busy: false,
        membersByConversationId: new Map(),
        membersByName: new Map(),
        latestPostsByAgent: new Map(),
        briefsByMention: new Map(),
      };
      sessions.set(sessionId, session);
    }
    return session;
  };

  return {
    applyNotification(notification) {
      const session = sessionFor(notification.sessionId);

      for (const post of notification.posts ?? []) {
        const author = post.agent.trim().toLowerCase();
        if (post.kind === "brief") {
          const cleaned = cleanBoardReport(post.text);
          if (cleaned !== null) {
            for (const mentioned of extractMentionedNames(post.text)) {
              if (!session.briefsByMention.has(mentioned)) {
                session.briefsByMention.set(mentioned, cleaned);
              }
            }
          }
          continue;
        }
        if (author === "coordinator" || author.length === 0) continue;
        const report = cleanBoardReport(post.text);
        if (report === null) continue;
        session.latestPostsByAgent.set(author, report);
        const tracked = session.membersByName.get(author);
        if (tracked !== undefined) {
          tracked.latestReport = report;
          tracked.sawIdleOrReport = true;
        }
      }

      const subagents: Array<AcpAdapterV2SubagentUpdate> = [];
      let runningMemberCount = 0;

      for (const member of notification.members) {
        const conversationId = nonEmpty(member.conversationId);
        if (conversationId === undefined || member.role === "coordinator") continue;
        const nameKey = member.name.trim().toLowerCase();
        const callId = nonEmpty(member.toolCallId) ?? null;

        let tracked = session.membersByConversationId.get(conversationId);
        const nativeTaskId = `${ANTIGRAVITY_SWARM_TASK_PREFIX}${conversationId}`;
        if (tracked === undefined) {
          tracked = {
            nativeTaskId,
            name: member.name,
            conversationId,
            toolCallId: callId,
            status: "running",
            latestReport: session.latestPostsByAgent.get(nameKey) ?? null,
            lastBrief: "",
            sawIdleOrReport: session.latestPostsByAgent.has(nameKey),
          };
          session.membersByConversationId.set(conversationId, tracked);
          session.membersByName.set(nameKey, tracked);
        } else if (tracked.toolCallId === null && callId !== null) {
          tracked.toolCallId = callId;
        }

        const latestPost = session.latestPostsByAgent.get(nameKey) ?? tracked.latestReport;
        if (latestPost !== null) {
          tracked.latestReport = latestPost;
          tracked.sawIdleOrReport = true;
        }

        const nextStatus = mapSwarmMemberStatus(member.state, tracked.sawIdleOrReport);
        if (nextStatus === "idle") {
          tracked.sawIdleOrReport = true;
        }
        if (nextStatus === "running" || nextStatus === "pending") {
          runningMemberCount += 1;
        }
        tracked.status = nextStatus;

        const brief =
          nonEmpty(member.brief) ??
          nonEmpty(tracked.lastBrief) ??
          session.briefsByMention.get(nameKey) ??
          `Swarm ${member.role} @${member.name}`;
        tracked.lastBrief = brief;

        const model = nonEmpty(member.modelLabel) ?? nonEmpty(member.model) ?? null;
        const failureText = nonEmpty(member.failure) ?? null;
        const result =
          nextStatus === "running"
            ? null
            : nextStatus === "failed"
              ? (failureText ?? tracked.latestReport ?? "Swarm worker execution failed.")
              : tracked.latestReport;

        subagents.push({
          nativeTaskId: tracked.nativeTaskId,
          childSessionId: conversationId,
          title: formatSwarmMemberTitle(member),
          prompt: brief,
          model,
          status: nextStatus,
          result,
          suppressNormalTool: true,
        });
      }

      session.busy =
        runningMemberCount > 0 ||
        notification.workingWorkers > 0 ||
        notification.activeWorkers > 0 ||
        notification.coordinatorPendingWake === true;

      return {
        sessionId: notification.sessionId,
        activeBackgroundWork: session.busy,
        subagents,
      };
    },

    hasLiveSwarm(sessionId) {
      return sessions.has(sessionId);
    },

    partitionTaskIds(sessionId, nativeTaskIds) {
      const session = sessions.get(sessionId);
      if (session === undefined) {
        return { runningSwarmTaskIds: [], unmanagedTaskIds: nativeTaskIds };
      }
      const managedStatus = new Map<string, AcpAdapterV2SubagentUpdate["status"]>();
      for (const member of session.membersByConversationId.values()) {
        managedStatus.set(member.nativeTaskId, member.status);
        if (member.toolCallId !== null) {
          managedStatus.set(member.toolCallId, member.status);
        }
        managedStatus.set(
          `${ANTIGRAVITY_SWARM_TASK_PREFIX}${member.conversationId}`,
          member.status,
        );
      }
      const runningSwarmTaskIds: Array<string> = [];
      const unmanagedTaskIds: Array<string> = [];
      for (const id of nativeTaskIds) {
        const status = managedStatus.get(id);
        if (status === undefined) {
          unmanagedTaskIds.push(id);
        } else if (status === "running" || status === "pending") {
          runningSwarmTaskIds.push(id);
        }
      }
      return { runningSwarmTaskIds, unmanagedTaskIds };
    },
  };
}
