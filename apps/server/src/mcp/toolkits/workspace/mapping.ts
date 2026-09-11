import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  type ModelSelection,
  type OrchestrationMessage,
  type OrchestrationProjectShell,
  type OrchestrationProposedPlan,
  type OrchestrationThreadActivity,
  type OrchestrationThreadDetailPage,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadShell,
  type ServerProvider,
} from "@t3tools/contracts";

export const WORKSPACE_THREAD_SHELVES = ["active", "settled", "snoozed", "archived"] as const;
export type WorkspaceThreadShelf = (typeof WORKSPACE_THREAD_SHELVES)[number];

export const WORKSPACE_THREAD_STATUSES = [
  "pending-approval",
  "awaiting-input",
  "working",
  "connecting",
  "error",
  "plan-ready",
  "monitoring",
  "completed",
  "idle",
] as const;
export type WorkspaceThreadStatus = (typeof WORKSPACE_THREAD_STATUSES)[number];

export interface WorkspaceProjectBrief {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly defaultProvider: string | null;
  readonly defaultModel: string | null;
}

export interface WorkspaceThreadBrief {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly shelf: WorkspaceThreadShelf;
  readonly status: WorkspaceThreadStatus;
  readonly provider: string | null;
  readonly model: string;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly sessionStatus: string | null;
  readonly latestTurnState: string | null;
  readonly planStep: string | null;
  readonly updatedAt: string;
  readonly createdAt: string;
}

export interface WorkspaceThreadMessage {
  readonly id: string;
  readonly role: OrchestrationMessage["role"];
  readonly text: string;
  readonly turnId: string | null;
  readonly streaming: boolean;
  readonly createdAt: string;
}

export interface WorkspacePendingApproval {
  readonly requestId: string;
  readonly detail: string | null;
  readonly createdAt: string;
}

export interface WorkspaceThreadDetail {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly shelf: WorkspaceThreadShelf;
  readonly status: WorkspaceThreadStatus;
  readonly provider: string | null;
  readonly model: string;
  readonly runtimeMode: string;
  readonly interactionMode: string;
  readonly sessionStatus: string | null;
  readonly latestTurnState: string | null;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly pendingApprovals: ReadonlyArray<WorkspacePendingApproval>;
  readonly messages: ReadonlyArray<WorkspaceThreadMessage>;
  readonly activities: ReadonlyArray<{
    readonly kind: string;
    readonly tone: string;
    readonly summary: string;
    readonly createdAt: string;
  }>;
  readonly proposedPlans: ReadonlyArray<{
    readonly id: string;
    readonly planMarkdown: string;
    readonly createdAt: string;
  }>;
  readonly hasMore: boolean;
  readonly beforeCursor: string | null;
}

export interface WorkspaceProviderBrief {
  readonly instanceId: string;
  readonly driver: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly installed: boolean;
  readonly models: ReadonlyArray<{
    readonly slug: string;
    readonly name: string;
    readonly isDefault: boolean;
  }>;
}

const DRIVER_ALIASES: Readonly<Record<string, string>> = {
  claude: "claudeAgent",
  "claude-code": "claudeAgent",
  "claude agent": "claudeAgent",
  gpt: "codex",
  openai: "codex",
};

export function isLoopbackRemoteAddress(address: string | null | undefined): boolean {
  if (address == null || address.length === 0) {
    return false;
  }
  const normalized = address
    .trim()
    .toLowerCase()
    .replace(/^::ffff:/, "")
    .replace(/^\[(.*)\]$/, "$1");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized.startsWith("127.");
}

export function projectBrief(project: OrchestrationProjectShell): WorkspaceProjectBrief {
  return {
    id: project.id,
    title: project.title,
    workspaceRoot: project.workspaceRoot,
    defaultProvider: project.defaultModelSelection?.instanceId ?? null,
    defaultModel: project.defaultModelSelection?.model ?? null,
  };
}

export function threadShelf(
  thread: Pick<
    OrchestrationThreadShell,
    | "archivedAt"
    | "settledAt"
    | "settledOverride"
    | "snoozedUntil"
    | "hasPendingApprovals"
    | "hasPendingUserInput"
  >,
  nowMs: number,
): WorkspaceThreadShelf {
  if (thread.archivedAt != null) {
    return "archived";
  }
  if (
    thread.snoozedUntil != null &&
    Date.parse(thread.snoozedUntil) > nowMs &&
    !thread.hasPendingApprovals &&
    !thread.hasPendingUserInput
  ) {
    return "snoozed";
  }
  if (thread.settledOverride === "settled") {
    return "settled";
  }
  if (thread.settledAt != null && thread.settledOverride !== "active") {
    return "settled";
  }
  return "active";
}

export function threadStatus(
  thread: Pick<
    OrchestrationThreadShell,
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "session"
    | "interactionMode"
    | "hasActionableProposedPlan"
    | "backgroundLiveness"
    | "latestTurn"
  >,
): WorkspaceThreadStatus {
  if (thread.hasPendingApprovals) {
    return "pending-approval";
  }
  if (thread.hasPendingUserInput) {
    return "awaiting-input";
  }
  if (thread.session?.status === "error") {
    return "error";
  }
  if (thread.session?.status === "running") {
    return "working";
  }
  if (thread.session?.status === "starting") {
    return "connecting";
  }
  const planReady =
    thread.interactionMode === "plan" &&
    thread.latestTurn?.startedAt != null &&
    thread.latestTurn.completedAt != null &&
    thread.hasActionableProposedPlan;
  if (planReady) {
    return "plan-ready";
  }
  if (thread.backgroundLiveness === "working") {
    return "working";
  }
  if (thread.backgroundLiveness === "monitoring") {
    return "monitoring";
  }
  if (thread.latestTurn?.state === "completed") {
    return "completed";
  }
  if (thread.latestTurn?.state === "error") {
    return "error";
  }
  return "idle";
}

export function threadBrief(thread: OrchestrationThreadShell, nowMs: number): WorkspaceThreadBrief {
  return {
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    shelf: threadShelf(thread, nowMs),
    status: threadStatus(thread),
    provider: thread.session?.providerName ?? thread.modelSelection.instanceId,
    model: thread.modelSelection.model,
    hasPendingApprovals: thread.hasPendingApprovals,
    hasPendingUserInput: thread.hasPendingUserInput,
    sessionStatus: thread.session?.status ?? null,
    latestTurnState: thread.latestTurn?.state ?? null,
    planStep: thread.planProgress?.step ?? null,
    updatedAt: thread.updatedAt,
    createdAt: thread.createdAt,
  };
}

function activityPayload(activity: OrchestrationThreadActivity): Record<string, unknown> | null {
  return activity.payload !== null &&
    typeof activity.payload === "object" &&
    !Array.isArray(activity.payload)
    ? (activity.payload as Record<string, unknown>)
    : null;
}

export function pendingApprovalsFromActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<WorkspacePendingApproval> {
  const open = new Map<string, WorkspacePendingApproval>();
  for (const activity of activities) {
    const payload = activityPayload(activity);
    if (payload == null) {
      continue;
    }
    const requestId = typeof payload.requestId === "string" ? payload.requestId : null;
    if (requestId == null) {
      continue;
    }
    if (activity.kind === "approval.requested") {
      open.set(requestId, {
        requestId,
        detail: typeof payload.detail === "string" ? payload.detail : activity.summary,
        createdAt: activity.createdAt,
      });
    } else if (
      activity.kind === "approval.resolved" ||
      activity.kind === "provider.approval.respond.failed"
    ) {
      open.delete(requestId);
    }
  }
  return [...open.values()];
}

export function threadDetail(
  snapshot: OrchestrationThreadDetailSnapshot,
  nowMs: number,
): WorkspaceThreadDetail {
  const thread = snapshot.thread;
  const page: OrchestrationThreadDetailPage | undefined = snapshot.page;
  const pendingApprovals = pendingApprovalsFromActivities(thread.activities);
  const hasPendingUserInput = thread.activities.some(
    (activity) => activity.kind === "user-input.requested",
  );
  const statusInput = {
    hasPendingApprovals: pendingApprovals.length > 0,
    hasPendingUserInput,
    session: thread.session,
    interactionMode: thread.interactionMode,
    hasActionableProposedPlan: thread.proposedPlans.some((plan) => plan.implementedAt == null),
    backgroundLiveness: undefined,
    latestTurn: thread.latestTurn,
  };
  const shelfInput = {
    archivedAt: thread.archivedAt,
    settledAt: thread.settledAt,
    settledOverride: thread.settledOverride,
    snoozedUntil: thread.snoozedUntil,
    hasPendingApprovals: pendingApprovals.length > 0,
    hasPendingUserInput,
  };
  return {
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    shelf: threadShelf(shelfInput, nowMs),
    status: threadStatus(statusInput),
    provider: thread.session?.providerName ?? thread.modelSelection.instanceId,
    model: thread.modelSelection.model,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    sessionStatus: thread.session?.status ?? null,
    latestTurnState: thread.latestTurn?.state ?? null,
    hasPendingApprovals: pendingApprovals.length > 0,
    hasPendingUserInput,
    pendingApprovals,
    messages: thread.messages.map(messageBrief),
    activities: thread.activities.map((activity) => ({
      kind: activity.kind,
      tone: activity.tone,
      summary: activity.summary,
      createdAt: activity.createdAt,
    })),
    proposedPlans: thread.proposedPlans.map(proposedPlanBrief),
    hasMore: page?.hasMore ?? false,
    beforeCursor: page?.beforeCursor ?? null,
  };
}

function messageBrief(message: OrchestrationMessage): WorkspaceThreadMessage {
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    turnId: message.turnId,
    streaming: message.streaming,
    createdAt: message.createdAt,
  };
}

function proposedPlanBrief(plan: OrchestrationProposedPlan) {
  return {
    id: plan.id,
    planMarkdown: plan.planMarkdown,
    createdAt: plan.createdAt,
  };
}

export function providerBrief(provider: ServerProvider): WorkspaceProviderBrief {
  return {
    instanceId: provider.instanceId,
    driver: provider.driver,
    displayName: provider.displayName?.trim() || provider.driver,
    enabled: provider.enabled,
    installed: provider.installed,
    models: provider.models.map((model) => ({
      slug: model.slug,
      name: model.name,
      isDefault: model.isDefault === true,
    })),
  };
}

export function titleFromPrompt(prompt: string, fallback = "New thread"): string {
  const firstLine = prompt
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (firstLine == null) {
    return fallback;
  }
  return firstLine.length > 72 ? `${firstLine.slice(0, 71).trimEnd()}…` : firstLine;
}

export function resolveProviderSelection(
  input: {
    readonly provider?: string | undefined;
    readonly instanceId?: string | undefined;
    readonly model?: string | undefined;
  },
  providers: ReadonlyArray<ServerProvider>,
  projectDefault: ModelSelection | null | undefined,
): ModelSelection | { readonly error: string } {
  const enabled = providers.filter((provider) => provider.enabled);
  const requestedInstanceId = input.instanceId?.trim();
  if (requestedInstanceId) {
    const instance = enabled.find((provider) => provider.instanceId === requestedInstanceId);
    if (instance == null) {
      return { error: `No enabled provider instance named "${requestedInstanceId}".` };
    }
    return {
      instanceId: instance.instanceId,
      model: resolveModelSlug(input.model, instance, projectDefault),
    };
  }

  const requestedProvider = input.provider?.trim();
  if (requestedProvider) {
    const driver = normalizeDriverKind(requestedProvider);
    const instance =
      enabled.find((provider) => provider.driver === driver || provider.instanceId === driver) ??
      enabled.find(
        (provider) =>
          provider.displayName?.toLowerCase() === requestedProvider.toLowerCase() ||
          provider.driver.toLowerCase() === requestedProvider.toLowerCase(),
      );
    if (instance == null) {
      return {
        error: `No enabled provider matching "${requestedProvider}". Use list_providers.`,
      };
    }
    return {
      instanceId: instance.instanceId,
      model: resolveModelSlug(input.model, instance, projectDefault),
    };
  }

  if (projectDefault != null) {
    const instance = enabled.find((provider) => provider.instanceId === projectDefault.instanceId);
    if (instance != null) {
      return {
        instanceId: instance.instanceId,
        model: resolveModelSlug(input.model, instance, projectDefault),
      };
    }
  }

  const fallback = enabled[0];
  if (fallback == null) {
    return { error: "No enabled providers are configured on this T3 environment." };
  }
  return {
    instanceId: fallback.instanceId,
    model: resolveModelSlug(input.model, fallback, projectDefault),
  };
}

function normalizeDriverKind(value: string): string {
  const trimmed = value.trim();
  const alias = DRIVER_ALIASES[trimmed.toLowerCase()];
  if (alias) {
    return alias;
  }
  return trimmed;
}

function resolveModelSlug(
  requested: string | undefined,
  instance: ServerProvider,
  projectDefault: ModelSelection | null | undefined,
): string {
  if (requested != null && requested.trim().length > 0) {
    return requested.trim();
  }
  if (projectDefault != null && projectDefault.instanceId === instance.instanceId) {
    return projectDefault.model;
  }
  const markedDefault = instance.models.find((model) => model.isDefault);
  if (markedDefault) {
    return markedDefault.slug;
  }
  const driverDefault = DEFAULT_MODEL_BY_PROVIDER[instance.driver];
  if (driverDefault) {
    return driverDefault;
  }
  return instance.models[0]?.slug ?? DEFAULT_MODEL;
}

/** Local CLI clients are trusted; browser-origin requests must use normal session authentication. */
export function permitsUnauthenticatedWorkspaceClient(
  address: string | null | undefined,
  origin: string | undefined,
): boolean {
  return origin === undefined && isLoopbackRemoteAddress(address);
}
