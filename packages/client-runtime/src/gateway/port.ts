import type { AgentHandoffInput, AgentHandoffResult } from "./handoff.ts";
export const GATEWAY_SCOPE_VALUES = [
  "read",
  "create",
  "send",
  "control",
  "lifecycle",
  "approval",
  "artifact",
  "review",
  "admin",
  "delivery",
] as const;
export type GatewayScope = (typeof GATEWAY_SCOPE_VALUES)[number];

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

export interface GatewayProfile {
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
  | "providerLabel"
  | "modelLabel"
  | "reasoningEffort"
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

export interface GatewayRuntimePort {
  handoffThread?(input: AgentHandoffInput): Promise<AgentHandoffResult>;
  unsettleThread?(environmentId: string, threadId: string): Promise<{ status: "succeeded" }>;
  settleThread?(environmentId: string, threadId: string): Promise<{ status: "succeeded" }>;
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
  getEnvironmentStatus(environmentId: string): Promise<Record<string, unknown>>;
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
  createAssetUrl(
    environmentId: string,
    resource:
      | { readonly _tag: "attachment"; readonly attachmentId: string }
      | { readonly _tag: "workspace-file"; readonly threadId: string; readonly path: string },
  ): Promise<{
    readonly relativeUrl: string;
    readonly expiresAt: number;
  }>;
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
  respondToApprovals?(input: {
    readonly environmentId: string;
    readonly threadId: string;
    readonly responses: ReadonlyArray<{
      readonly approvalRequestId: string;
      readonly decision: GatewayApprovalDecision;
    }>;
    readonly expectedRevision: number;
    readonly requestId: string;
  }): Promise<GatewayMutationResult>;
  respondToApproval(input: {
    readonly environmentId: string;
    readonly threadId: string;
    readonly approvalRequestId: string;
    readonly decision: GatewayApprovalDecision;
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
