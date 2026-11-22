import type * as EffectAcpSchema from "effect-acp/compat";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { AcpAdapterV2ExtensionContext, AcpAdapterV2SubagentUpdate } from "./adapter.ts";
import { extractAcpChildRequestTarget } from "./runtimeModel.ts";

export const ANTIGRAVITY_SWARM_CAPABILITIES_META = {
  antigravity: {
    swarm: true,
  },
} as const;

const ANTIGRAVITY_SWARM_NOTIFICATION_METHOD = "_antigravity/swarm";

const ANTIGRAVITY_SWARM_TASK_PREFIX = "swarm:";

const HOUSEKEEPING_SWARM_ROLES = new Set(["monitor", "narrator"]);

export const AntigravitySwarmMember = Schema.Struct({
  name: Schema.String,
  role: Schema.String,
  conversationId: Schema.String,
  toolCallId: Schema.optional(Schema.String),
  brief: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  modelLabel: Schema.optional(Schema.String),
  state: Schema.String,
  hadActivity: Schema.optional(Schema.Boolean),
  failure: Schema.optional(Schema.String),
  workspace: Schema.optional(Schema.String),
  workspaces: Schema.optional(Schema.Array(Schema.String)),
  addedBy: Schema.optional(Schema.String),
});
export type AntigravitySwarmMember = Schema.Schema.Type<typeof AntigravitySwarmMember>;

const AntigravitySwarmControl = Schema.Struct({
  op: Schema.String,
  channel: Schema.optional(Schema.String),
  topic: Schema.optional(Schema.String),
  channels: Schema.optional(Schema.Array(Schema.String)),
  members: Schema.optional(Schema.Array(Schema.String)),
});

export const AntigravitySwarmPost = Schema.Struct({
  seq: Schema.Number,
  time: Schema.optional(Schema.String),
  agent: Schema.String,
  channel: Schema.optional(Schema.String),
  kind: Schema.optional(Schema.String),
  text: Schema.String,
  control: Schema.optional(AntigravitySwarmControl),
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
  coordinatorWorking: Schema.optional(Schema.Boolean),
  coordinatorPendingWake: Schema.optional(Schema.Boolean),
  members: Schema.Array(AntigravitySwarmMember),
  posts: Schema.optional(Schema.Array(AntigravitySwarmPost)),
});
export type AntigravitySwarmNotification = Schema.Schema.Type<typeof AntigravitySwarmNotification>;

const MAX_BOARD_REPORT_CHARS = 8_000;

interface TrackedSwarmMember {
  nativeTaskId: string;
  name: string;
  role: string;
  conversationId: string;
  toolCallId: string | null;
  status: AcpAdapterV2SubagentUpdate["status"];
  latestReport: string | null;
  lastBrief: string;
  sawIdleOrReport: boolean;
  readonly workspaces: Set<string>;
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

function resolveMemberRole(name: string, rawRole: string): string {
  const trimmedRole = rawRole.trim().toLowerCase();
  if (trimmedRole.length > 0 && trimmedRole !== "worker") {
    return trimmedRole;
  }
  const normalizedName = name.trim().replace(/^@/, "").toLowerCase();
  const match = /^(narrator|monitor)(?:-\d+)?$/.exec(normalizedName);
  return match?.[1] ?? (trimmedRole || "worker");
}

function isHousekeepingRole(role: string): boolean {
  return HOUSEKEEPING_SWARM_ROLES.has(role);
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

function formatSwarmMemberTitle(member: AntigravitySwarmMember, role: string): string {
  const handle = `@${member.name.replace(/^@/, "")}`;
  const roleSuffix = role !== "worker" && role.length > 0 ? ` (${role})` : "";
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

export interface AntigravitySwarmSubagentEntry {
  readonly subagent: AcpAdapterV2SubagentUpdate;
  readonly wakeContinuation: boolean;
}

export interface AntigravitySwarmMutation {
  readonly sessionId: string;
  readonly activeBackgroundWork: boolean;
  readonly subagents: ReadonlyArray<AntigravitySwarmSubagentEntry>;
}

export interface AntigravitySwarmTracker {
  readonly applyNotification: (
    notification: AntigravitySwarmNotification,
  ) => AntigravitySwarmMutation;
  readonly setSessionProtocol: (sessionId: string, supported: boolean) => void;
  readonly usesNativeProtocol: (sessionId: string) => boolean;
  readonly clearSession: (sessionId: string) => void;
  readonly hasLiveSwarm: (sessionId: string) => boolean;
  readonly childPermissionWorkspaces: (
    request: EffectAcpSchema.RequestPermissionRequest,
  ) => ReadonlyArray<string>;
  readonly partitionTaskIds: (
    sessionId: string,
    nativeTaskIds: ReadonlyArray<string>,
  ) => {
    readonly runningSwarmTaskIds: ReadonlyArray<string>;
    readonly unmanagedTaskIds: ReadonlyArray<string>;
  };
}

export function registerAntigravitySwarmExtension(
  tracker: AntigravitySwarmTracker,
  context: AcpAdapterV2ExtensionContext,
) {
  return context.runtime.handleExtNotification(
    ANTIGRAVITY_SWARM_NOTIFICATION_METHOD,
    AntigravitySwarmNotification,
    (notification) =>
      Effect.gen(function* () {
        const mutation = tracker.applyNotification(notification);
        if (mutation.activeBackgroundWork) {
          yield* context.setExternalBackgroundWork({
            sessionId: mutation.sessionId,
            active: true,
          });
        }
        for (const entry of mutation.subagents) {
          yield* context.upsertSubagent({
            sessionId: mutation.sessionId,
            subagent: entry.subagent,
            allowReopenFromIdle: true,
            wakeContinuation: entry.wakeContinuation,
          });
        }
        if (!mutation.activeBackgroundWork) {
          yield* context.setExternalBackgroundWork({
            sessionId: mutation.sessionId,
            active: false,
          });
        }
      }),
  );
}

export function makeAntigravitySwarmTracker(): AntigravitySwarmTracker {
  const sessions = new Map<string, TrackedSwarmSession>();
  const nativeProtocolSessions = new Set<string>();

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
    setSessionProtocol(sessionId, supported) {
      if (supported) nativeProtocolSessions.add(sessionId);
      else nativeProtocolSessions.delete(sessionId);
    },

    usesNativeProtocol(sessionId) {
      return nativeProtocolSessions.has(sessionId) || sessions.has(sessionId);
    },

    clearSession(sessionId) {
      sessions.delete(sessionId);
      nativeProtocolSessions.delete(sessionId);
    },

    applyNotification(notification) {
      nativeProtocolSessions.add(notification.sessionId);
      const session = sessionFor(notification.sessionId);
      const postedNow = new Set<string>();

      for (const post of notification.posts ?? []) {
        if (post.control !== undefined) continue;
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
        postedNow.add(author);
        const tracked = session.membersByName.get(author);
        if (tracked !== undefined) {
          tracked.latestReport = report;
          tracked.sawIdleOrReport = true;
        }
      }

      const subagents: Array<AntigravitySwarmSubagentEntry> = [];
      let runningWorkerCount = 0;

      for (const member of notification.members) {
        const conversationId = nonEmpty(member.conversationId);
        const role = resolveMemberRole(member.name, member.role);
        if (conversationId === undefined || role === "coordinator") continue;
        const housekeeping = isHousekeepingRole(role);
        const nameKey = member.name.trim().toLowerCase();
        const callId = nonEmpty(member.toolCallId) ?? null;

        let tracked = session.membersByConversationId.get(conversationId);
        const nativeTaskId = `${ANTIGRAVITY_SWARM_TASK_PREFIX}${conversationId}`;
        if (tracked === undefined) {
          // A recreated worker reuses its name; reports from the old incarnation are not its own.
          const previous = session.membersByName.get(nameKey);
          if (previous !== undefined && !postedNow.has(nameKey)) {
            session.latestPostsByAgent.delete(nameKey);
          }
          tracked = {
            nativeTaskId,
            name: member.name,
            role,
            conversationId,
            toolCallId: callId,
            status: "running",
            latestReport: session.latestPostsByAgent.get(nameKey) ?? null,
            lastBrief: "",
            sawIdleOrReport: member.hadActivity === true || session.latestPostsByAgent.has(nameKey),
            workspaces: new Set(),
          };
          session.membersByConversationId.set(conversationId, tracked);
          session.membersByName.set(nameKey, tracked);
        } else {
          tracked.role = role;
          if (tracked.toolCallId === null && callId !== null) {
            tracked.toolCallId = callId;
          }
          if (member.hadActivity === true) {
            tracked.sawIdleOrReport = true;
          }
        }
        for (const extraWorkspace of member.workspaces ?? []) {
          const trimmed = nonEmpty(extraWorkspace);
          if (trimmed !== undefined) tracked.workspaces.add(trimmed);
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
        if (!housekeeping && (nextStatus === "running" || nextStatus === "pending")) {
          runningWorkerCount += 1;
        }
        // Rosters keep listing finished workers; re-emitting one would re-create it in a later turn.
        const alreadyReported =
          tracked.status === nextStatus &&
          (nextStatus === "completed" || nextStatus === "failed" || nextStatus === "cancelled");
        tracked.status = nextStatus;
        if (alreadyReported) continue;

        const brief =
          nonEmpty(member.brief) ??
          nonEmpty(tracked.lastBrief) ??
          session.briefsByMention.get(nameKey) ??
          `Swarm ${role} @${member.name}`;
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
          subagent: {
            nativeTaskId: tracked.nativeTaskId,
            childSessionId: conversationId,
            title: formatSwarmMemberTitle(member, role),
            prompt: brief,
            model,
            // Housekeeping pulses never hold the turn open.
            status: housekeeping && nextStatus === "running" ? "idle" : nextStatus,
            result,
            suppressNormalTool: true,
          },
          // Periodic `@monitor` / `@narrator` checks never wake empty parent continuation runs.
          wakeContinuation: !housekeeping,
        });
      }

      session.busy =
        runningWorkerCount > 0 ||
        notification.workingWorkers > 0 ||
        notification.activeWorkers > 0 ||
        notification.coordinatorWorking === true ||
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

    childPermissionWorkspaces(request) {
      // Same worker resolution as approval routing, so policy and cancellation agree.
      const target = extractAcpChildRequestTarget({
        meta: request._meta,
        toolCallMeta: request.toolCall._meta,
      });
      if (target === undefined) return [];
      const tracked = sessions
        .get(request.sessionId)
        ?.membersByConversationId.get(target.childSessionId);
      return tracked === undefined ? [] : [...tracked.workspaces];
    },

    partitionTaskIds(sessionId, nativeTaskIds) {
      const session = sessions.get(sessionId);
      if (session === undefined) {
        return { runningSwarmTaskIds: [], unmanagedTaskIds: nativeTaskIds };
      }
      const managedStatus = new Map<
        string,
        { readonly status: AcpAdapterV2SubagentUpdate["status"]; readonly housekeeping: boolean }
      >();
      for (const member of session.membersByConversationId.values()) {
        const entry = {
          status: member.status,
          housekeeping: isHousekeepingRole(member.role),
        };
        managedStatus.set(member.nativeTaskId, entry);
        if (member.toolCallId !== null) {
          managedStatus.set(member.toolCallId, entry);
        }
        managedStatus.set(`${ANTIGRAVITY_SWARM_TASK_PREFIX}${member.conversationId}`, entry);
      }
      const runningSwarmTaskIds: Array<string> = [];
      const unmanagedTaskIds: Array<string> = [];
      for (const id of nativeTaskIds) {
        const entry = managedStatus.get(id);
        if (entry === undefined) {
          unmanagedTaskIds.push(id);
        } else if (
          !entry.housekeeping &&
          (entry.status === "running" || entry.status === "pending")
        ) {
          runningSwarmTaskIds.push(id);
        }
      }
      return { runningSwarmTaskIds, unmanagedTaskIds };
    },
  };
}
