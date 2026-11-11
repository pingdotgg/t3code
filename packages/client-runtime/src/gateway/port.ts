import type {
  AgentSkill,
  ScheduledTask,
  ScheduledTaskSchedule,
  Todo,
  TodoListResult,
  ThreadSettleAfterTurnInput,
  ThreadTaskRemoteAssignInput,
  ThreadTaskRemoteDeliverInput,
  ThreadTaskRemoteDeliverResult,
  ThreadTaskBoard,
  ThreadTaskBoardInput,
  ThreadTaskProjectSnapshot,
  ThreadTaskProjectSnapshotInput,
  ThreadTaskRemoteOwnerActionInput,
  ThreadSettleRequest,
  ThreadTaskAssignInput,
  ThreadTaskListResult,
  ThreadTaskReadInput,
  ThreadTaskUpdateInput,
  ThreadTaskView,
  ThreadTaskWatchInput,
} from "@t3tools/contracts";
import { GATEWAY_SCOPE_VALUES, type GatewayScope } from "@t3tools/contracts";
import type { AgentHandoffInput, AgentHandoffResult } from "./handoff.ts";

export { GATEWAY_SCOPE_VALUES, type GatewayScope };

export function hasGatewayScopes(
  grants: Readonly<Record<string, ReadonlyArray<GatewayScope>>>,
  environmentId: string,
  required: ReadonlyArray<GatewayScope>,
): boolean {
  const scopes = grants[environmentId];
  return scopes !== undefined && required.every((scope) => scopes.includes(scope));
}
export type GatewayThreadControlAction =
  | "cancel"
  | "stop"
  | "pause"
  | "resume"
  | "retry"
  | "restart";
export type GatewayApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

/** Derived from authoritative session/turn and pending requests; reads call it status,
 * filters/waits call it executionState. Waiting states mean blocked on an answer/permission;
 * queued means a user message was sent but no session has adopted its turn. */
export const GATEWAY_THREAD_EXECUTION_STATES = [
  "running",
  "queued",
  "waiting-approval",
  "waiting-input",
  "completed",
  "failed",
  "interrupted",
  "stopped",
  "idle",
] as const;
export type GatewayThreadExecutionState = (typeof GATEWAY_THREAD_EXECUTION_STATES)[number];

export interface GatewayProfile {
  readonly description?: string | undefined;
  readonly color?: string | undefined;
  readonly icon?:
    | "orb"
    | "bot"
    | "code"
    | "pen"
    | "search"
    | "shield"
    | "sparkles"
    | "terminal"
    | undefined;
  readonly skillIds?: ReadonlyArray<string> | undefined;
  readonly systemPrompt?: string | undefined;
  readonly profileId?: string | undefined;
  readonly name: string;
  /**
   * Readable selection text persisted with the profile. The label pair is
   * the agent-facing representation; `modelSelection` below is a transient
   * routing snapshot resolved against the live catalog and is not profile
   * identity.
   */
  readonly providerLabel?: string | undefined;
  readonly modelLabel?: string | undefined;
  readonly modelSelection?: GatewayProfileModelSelection | undefined;
  readonly reasoningEffort?: string | undefined;
  readonly runtimeMode:
    | "approval-required"
    | "auto-accept-edits"
    | "auto"
    | "full-access"
    | "read-only";
  readonly interactionMode: "default" | "plan";
  readonly environmentIds?: ReadonlyArray<string> | undefined;
  readonly revision?: number | undefined;
  readonly createdAt?: string | undefined;
  readonly updatedAt?: string | undefined;
}

export type GatewayProfileInput = Pick<
  GatewayProfile,
  | "name"
  | "description"
  | "providerLabel"
  | "modelLabel"
  | "reasoningEffort"
  | "skillIds"
  | "systemPrompt"
  | "color"
  | "icon"
  | "runtimeMode"
  | "interactionMode"
  | "environmentIds"
>;

export interface GatewayProfileModelSelection {
  readonly instanceId: string;
  readonly model: string;
  readonly options?:
    | ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>
    | undefined;
}

export interface GatewayEnvironmentSummary {
  readonly environmentId: string;
  readonly label: string;
  readonly targetKind: string;
  readonly connectionState: string;
  readonly serverVersion?: string;
  readonly grantedScopes?: ReadonlyArray<string>;
}

export interface GatewayDevice {
  readonly deviceId: string;
  readonly label: string;
  readonly kind: "web" | "desktop" | "mobile" | "unknown";
  readonly platform?: string;
  readonly visible: boolean;
  readonly focused: boolean;
  readonly connectedAt: string;
}

export type GatewayFocusTarget =
  | { readonly type: "thread"; readonly threadId: string }
  | {
      readonly type: "file";
      readonly threadId: string;
      readonly path: string;
      readonly line?: number;
    }
  | { readonly type: "agents" };

/** One scheduled-task operation; ids are plain strings the runtime brands. */
export type GatewayScheduledTaskRequest =
  | { readonly action: "list" }
  | { readonly action: "create"; readonly input: GatewayScheduledTaskCreate }
  | {
      readonly action: "update";
      readonly taskId: string;
      readonly patch: GatewayScheduledTaskPatch;
    }
  | { readonly action: "delete"; readonly taskId: string }
  | { readonly action: "run"; readonly taskId: string };

/** Agent-facing task fields; the runtime resolves the profile's model and modes. */
export interface GatewayScheduledTaskCreate {
  /** Defaults to the first line of the prompt. */
  readonly title?: string;
  readonly prompt: string;
  readonly profileId: string;
  readonly projectId: string;
  readonly schedule: ScheduledTaskSchedule;
  readonly enabled?: boolean;
}
export type GatewayScheduledTaskPatch = Partial<GatewayScheduledTaskCreate>;

export type GatewayTodoRequest =
  | { readonly action: "list"; readonly projectId: string }
  | { readonly action: "add"; readonly projectId: string; readonly text: string }
  | { readonly action: "update"; readonly todoId: string; readonly text: string }
  | { readonly action: "remove" | "settle" | "unsettle"; readonly todoId: string };

export type GatewayThreadTaskRequest =
  | { readonly action: "assign"; readonly input: ThreadTaskAssignInput }
  | { readonly action: "read"; readonly input: ThreadTaskReadInput }
  | { readonly action: "update"; readonly input: ThreadTaskUpdateInput }
  | { readonly action: "watch"; readonly input: ThreadTaskWatchInput }
  | { readonly action: "settleAfterTurn"; readonly input: ThreadSettleAfterTurnInput }
  // Environment-to-environment calls for a task split across machines (servers only).
  | { readonly action: "remoteAssign"; readonly input: ThreadTaskRemoteAssignInput }
  | { readonly action: "remoteDeliver"; readonly input: ThreadTaskRemoteDeliverInput }
  | { readonly action: "remoteOwnerAction"; readonly input: ThreadTaskRemoteOwnerActionInput }
  | { readonly action: "projectSnapshot"; readonly input: ThreadTaskProjectSnapshotInput }
  | { readonly action: "board"; readonly input: ThreadTaskBoardInput };

/**
 * The chat whose agent made a tool call, from the server's authenticated MCP credential.
 * Only a port hosted by the server for its own environment may act on it; every other
 * port ignores it and acts with the connected user's authority.
 */
export interface GatewayThreadTaskCaller {
  readonly environmentId: string;
  readonly threadId: string;
}

export interface GatewayPage<T> {
  readonly items: ReadonlyArray<T>;
  readonly nextCursor?: string;
  readonly snapshotAt: string;
}

export interface GatewayMutationResult {
  readonly requestId: string;
  readonly commandId?: string;
  readonly status: "accepted" | "queued" | "running" | "succeeded" | "failed" | "denied";
  readonly threadId: string;
  readonly messageId?: string;
}

export interface GatewayRuntimeEvent {
  readonly eventId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly environmentId: string;
  readonly type: string;
  readonly correlationId?: string;
  readonly threadId?: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface GatewayRuntimeEventSubscription {
  readonly environmentIds: ReadonlyArray<string>;
  readonly afterSequenceByEnvironment: Readonly<Record<string, number>>;
}

export interface GatewayRuntimeEventSource {
  subscribe(
    listener: (event: GatewayRuntimeEvent) => void,
    subscription: GatewayRuntimeEventSubscription,
  ): () => void;
}

export interface GatewayStatusSubscription {
  readonly subscriptionId: string;
  readonly ackedSequence: number;
  readonly pendingEventCount: number;
  readonly status: "active" | "caught-up" | "cursor-expired";
}

export interface GatewayStatusWebhook {
  readonly webhookId: string;
  readonly ackedSequence: number;
  readonly status: "healthy" | "pending" | "degraded";
  readonly deliveries: {
    readonly pending: number;
    readonly inFlight: number;
    readonly acked: number;
    readonly failed: number;
  };
}

export interface GatewayStatusEnvironment {
  readonly environmentId: string;
  readonly latestSequence: number;
  readonly oldestRetainedSequence: number | null;
  readonly retainedEventCount: number;
  readonly deliveryAccess: boolean;
  readonly subscriptions?: ReadonlyArray<GatewayStatusSubscription>;
  readonly subscriptionCount?: number;
  readonly subscriptionsTruncated?: boolean;
  readonly webhooks?: ReadonlyArray<GatewayStatusWebhook>;
  readonly webhookCount?: number;
  readonly webhooksTruncated?: boolean;
  readonly deliveries?: GatewayStatusWebhook["deliveries"];
  readonly deliveryFailureCount?: number;
}

export interface GatewayStatusSnapshot {
  readonly schemaVersion: "3";
  readonly capturedAt: string;
  readonly live: boolean;
  readonly stale: boolean;
  readonly retention: {
    readonly maxEventsPerEnvironment: number;
    readonly maxAgeDays: number;
  };
  readonly environments: ReadonlyArray<GatewayStatusEnvironment>;
}

const STATUS_ROW_LIMIT = 100;

function statusRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function statusString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}

function statusCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function statusDeliveryCounts(value: unknown): value is GatewayStatusWebhook["deliveries"] {
  const row = statusRecord(value);
  return (
    row !== undefined &&
    statusCount(row.pending) &&
    statusCount(row.inFlight) &&
    statusCount(row.acked) &&
    statusCount(row.failed)
  );
}

/** Fail-closed validator for additive sidecar status snapshots. */
export function parseGatewayStatusSnapshot(value: unknown): GatewayStatusSnapshot | undefined {
  const root = statusRecord(value);
  if (root === undefined || JSON.stringify(value).length > 256_000) return undefined;
  const retention = statusRecord(root.retention);
  if (
    root.schemaVersion !== "3" ||
    !statusString(root.capturedAt) ||
    typeof root.live !== "boolean" ||
    typeof root.stale !== "boolean" ||
    retention === undefined ||
    !statusCount(retention.maxEventsPerEnvironment) ||
    !statusCount(retention.maxAgeDays) ||
    !Array.isArray(root.environments) ||
    root.environments.length > STATUS_ROW_LIMIT
  ) {
    return undefined;
  }
  for (const candidate of root.environments) {
    const environment = statusRecord(candidate);
    if (
      environment === undefined ||
      !statusString(environment.environmentId) ||
      !statusCount(environment.latestSequence) ||
      (environment.oldestRetainedSequence !== null &&
        !statusCount(environment.oldestRetainedSequence)) ||
      !statusCount(environment.retainedEventCount) ||
      typeof environment.deliveryAccess !== "boolean"
    ) {
      return undefined;
    }
    if (!environment.deliveryAccess) {
      if (
        environment.subscriptions !== undefined ||
        environment.webhooks !== undefined ||
        environment.deliveries !== undefined
      )
        return undefined;
      continue;
    }
    if (
      !Array.isArray(environment.subscriptions) ||
      environment.subscriptions.length > STATUS_ROW_LIMIT ||
      !statusCount(environment.subscriptionCount) ||
      !Array.isArray(environment.webhooks) ||
      environment.webhooks.length > STATUS_ROW_LIMIT ||
      !statusCount(environment.webhookCount) ||
      !statusDeliveryCounts(environment.deliveries) ||
      !statusCount(environment.deliveryFailureCount)
    ) {
      return undefined;
    }
    for (const item of environment.subscriptions) {
      const subscription = statusRecord(item);
      if (
        subscription === undefined ||
        !statusString(subscription.subscriptionId) ||
        !statusCount(subscription.ackedSequence) ||
        !statusCount(subscription.pendingEventCount) ||
        (subscription.status !== "active" &&
          subscription.status !== "caught-up" &&
          subscription.status !== "cursor-expired")
      )
        return undefined;
    }
    for (const item of environment.webhooks) {
      const webhook = statusRecord(item);
      if (
        webhook === undefined ||
        !statusString(webhook.webhookId) ||
        !statusCount(webhook.ackedSequence) ||
        (webhook.status !== "healthy" &&
          webhook.status !== "pending" &&
          webhook.status !== "degraded") ||
        !statusDeliveryCounts(webhook.deliveries)
      )
        return undefined;
    }
  }
  return value as GatewayStatusSnapshot;
}

export type GatewaySkillInput = Pick<AgentSkill, "name" | "description" | "content" | "resources">;

export interface GatewayPresenceClient {
  readonly clientKind: string;
  readonly visible: boolean;
  readonly focused: boolean;
  readonly recentlyInteracted: boolean;
  readonly appState?: string;
  readonly updatedAt: string;
  readonly expiresAt: string;
}

export interface GatewayPresence {
  readonly environmentId: string;
  /** A client is visible or focused right now. */
  readonly present: boolean;
  readonly anyVisible: boolean;
  readonly anyFocused: boolean;
  readonly anyRecentlyInteracted: boolean;
  /** Latest report from any live client, or null when none has reported. */
  readonly lastActivityAt: string | null;
  readonly clients: ReadonlyArray<GatewayPresenceClient>;
  readonly observedAt: string;
}

export interface GatewayRuntimePort {
  listSkills?(environmentId: string): Promise<ReadonlyArray<AgentSkill>>;
  createSkill?(environmentId: string, input: GatewaySkillInput): Promise<AgentSkill>;
  updateSkill?(
    environmentId: string,
    skillId: string,
    patch: { readonly [K in keyof GatewaySkillInput]?: GatewaySkillInput[K] | undefined },
  ): Promise<AgentSkill>;
  deleteSkill?(
    environmentId: string,
    skillId: string,
  ): Promise<{ skillId: string; status: "succeeded" }>;
  handoffThread?(input: AgentHandoffInput): Promise<AgentHandoffResult>;
  unsettleThread?(environmentId: string, threadId: string): Promise<{ status: "succeeded" }>;
  settleThread?(environmentId: string, threadId: string): Promise<{ status: "succeeded" }>;
  /** Links a chat under the chat that owns its work, which may be on another environment. */
  setThreadParent?(
    environmentId: string,
    threadId: string,
    parentThreadId: string | null,
    parentEnvironmentId?: string,
  ): Promise<{ status: "succeeded" }>;
  openAgents?(environmentId: string): Promise<{ status: "succeeded" }>;
  createProfile?(environmentId: string, profile: GatewayProfileInput): Promise<GatewayProfile>;
  updateProfile?(
    environmentId: string,
    profileId: string,
    patch: { readonly [K in keyof GatewayProfileInput]?: GatewayProfileInput[K] | undefined },
  ): Promise<GatewayProfile>;
  deleteProfile?(
    environmentId: string,
    profileId: string,
  ): Promise<{ profileId: string; status: "succeeded"; deletedAt?: string | undefined }>;
  syncAgentLibrary?(environmentId: string): Promise<void>;
  replicateProfiles?(
    environmentId: string,
    profiles: ReadonlyArray<GatewayProfile>,
    deletedAt?: Readonly<Record<string, string>>,
  ): Promise<void>;

  openThread(
    environmentId: string,
    threadId: string,
  ): Promise<{ environmentId: string; threadId: string; status: "succeeded" }>;
  listEnvironments(): Promise<ReadonlyArray<GatewayEnvironmentSummary>>;
  /** Clients (desktop, web, mobile) connected to the environment that can be focused. */
  listDevices?(environmentId: string): Promise<ReadonlyArray<GatewayDevice>>;
  /** Bring a thread, file, or the Agents board on screen on one connected client. */
  focusDevice?(
    environmentId: string,
    device: string,
    target: GatewayFocusTarget,
  ): Promise<{ readonly deviceId: string; readonly label: string; readonly status: "delivered" }>;
  /** List, create, update, delete, or run now the environment's scheduled tasks. */
  scheduledTask?(
    environmentId: string,
    request: GatewayScheduledTaskRequest,
  ): Promise<
    { readonly tasks: ReadonlyArray<ScheduledTask> } | ScheduledTask | { readonly deleted: string }
  >;
  /** List, add, update, remove, settle, or unsettle a project's todos. */
  todo?(
    environmentId: string,
    request: GatewayTodoRequest,
  ): Promise<TodoListResult | Todo | { readonly removed: string }>;
  /** Assign, read, update, or watch thread tasks, or ask a chat to settle once its turn ends. */
  threadTask?(
    environmentId: string,
    request: GatewayThreadTaskRequest,
    caller?: GatewayThreadTaskCaller,
  ): Promise<
    | ThreadTaskView
    | ThreadTaskListResult
    | ThreadSettleRequest
    | ThreadTaskRemoteDeliverResult
    | ThreadTaskProjectSnapshot
    | ThreadTaskBoard
  >;
  getEnvironmentStatus(environmentId: string): Promise<Record<string, unknown>>;
  /** Whether a person is at a client of this environment, from its client activity leases. */
  getPresence?(environmentId: string): Promise<GatewayPresence>;
  listProfiles?(environmentId: string): Promise<ReadonlyArray<GatewayProfile>>;
  /** Resolve readable profile labels against the environment's live provider catalog. */
  resolveProfileModelSelection?(
    environmentId: string,
    profile: GatewayProfile,
  ): Promise<GatewayProfileModelSelection | undefined>;
  listProjects(environmentId: string): Promise<GatewayPage<Record<string, unknown>>>;
  listThreads(environmentId: string): Promise<GatewayPage<Record<string, unknown>>>;
  getThread(environmentId: string, threadId: string): Promise<Record<string, unknown>>;
  /** Check complete authoritative thread state rather than the bounded display projection. */
  hasThreadMessage?(environmentId: string, threadId: string, messageId: string): Promise<boolean>;
  getPullRequest(
    environmentId: string,
    ref: { readonly projectId: string; readonly repository: string; readonly number: number },
  ): Promise<Record<string, unknown>>;
  getPullRequestActivity(
    environmentId: string,
    ref: { readonly projectId: string; readonly repository: string; readonly number: number },
  ): Promise<Record<string, unknown>>;
  /** Read authoritative receipts without redispatching an ambiguous legacy command. */
  getCommandReceipts?(
    environmentId: string,
    commandIds: ReadonlyArray<string>,
  ): Promise<
    ReadonlyArray<{
      readonly commandId: string;
      readonly aggregateKind: string;
      readonly aggregateId: string;
      readonly status: "accepted" | "rejected";
      readonly resultSequence: number;
      readonly error: string | null;
    }>
  >;
  createThread(input: {
    readonly environmentId: string;
    readonly projectId: string;
    readonly threadId: string;
    readonly title: string;
    readonly modelSelection?: {
      readonly instanceId: string;
      readonly model: string;
      readonly options?: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>;
    };
    readonly runtimeMode?: "approval-required" | "auto-accept-edits" | "auto" | "full-access";
    readonly interactionMode?: "default" | "plan";
    readonly workspaceMode?: "checkout" | "worktree";
    readonly baseBranch?: string;
    readonly parentThreadId?: string;
    /** Environment of `parentThreadId` when it is another machine's chat. */
    readonly parentEnvironmentId?: string;
    readonly requestId: string;
    readonly profileSelection?: {
      readonly profileId: string;
      readonly revision: number;
      readonly overrideFields: ReadonlyArray<
        "modelSelection" | "runtimeMode" | "interactionMode" | "reasoningEffort"
      >;
    };
  }): Promise<GatewayMutationResult>;
  sendMessage(input: {
    readonly environmentId: string;
    readonly threadId: string;
    readonly text: string;
    readonly messageId: string;
    readonly requestId: string;
  }): Promise<GatewayMutationResult>;
  controlThread(input: {
    readonly environmentId: string;
    readonly threadId: string;
    readonly action: GatewayThreadControlAction;
    readonly requestId: string;
    readonly messageId: string;
  }): Promise<GatewayMutationResult>;
  respondToApproval(input: {
    readonly environmentId: string;
    readonly threadId: string;
    readonly approvalRequestId: string;
    readonly decision: GatewayApprovalDecision;
    readonly requestId: string;
  }): Promise<GatewayMutationResult>;
  /**
   * Answers a question the agent is waiting on. `answers` maps each question id
   * to an option value, several values for multi-select, or free text.
   */
  respondToUserInput?(input: {
    readonly environmentId: string;
    readonly threadId: string;
    readonly userInputRequestId: string;
    readonly answers: Readonly<Record<string, string | ReadonlyArray<string>>>;
    readonly requestId: string;
  }): Promise<GatewayMutationResult>;
  /** Extended v3 operations that map directly to authoritative server RPCs.
   * Kept behind one transport method so older bridge clients fail closed. */
  executeOperation?(input: {
    readonly operation: string;
    readonly environmentId: string;
    readonly requestId?: string;
    readonly payload: Readonly<Record<string, unknown>>;
  }): Promise<Record<string, unknown>>;
}
