// @effect-diagnostics-next-line nodeBuiltinImport:off -- Synchronous SHA-256 digest for invite token hashing.
import * as NodeCrypto from "node:crypto";
import { derive as deriveOrchestrationId } from "@t3tools/provider-core/server/IdAllocator";
import {
  ALL_TEAM_ROLES,
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthEnvironmentMaintainScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthProvidersManageScope,
  AuthRelayWriteScope,
  AuthStandardClientScopes,
  canAssignTeamRole,
  canChangeTeamMemberRole,
  canChangeThreadTeamView,
  canManagePrivilegedTeamScheduledTasks,
  canManageTeamAutomationGitHub,
  canManageTeamDisplayName,
  canManageTeamEnvironments,
  canManageTeamGitHubAppConfig,
  canManageTeamInvites,
  canManageTeamMembers,
  canManageTeamPreprompts,
  canManageTeamProjects,
  canManageTeamProviders,
  canManageTeamScheduledTasks,
  canManageTeamSkills,
  canManageTeamViews,
  canMemberAccessTeamEnvironment,
  canMemberCreateThreadInTeamView,
  canMemberInterruptTeamTurn,
  canMemberLeaveTeamThreadNote,
  canMemberManageTeamQueuedRun,
  canMemberMutateTeamScheduledTask,
  canMemberPromoteTeamQueuedRun,
  canMemberReadTeamScheduledTask,
  canMemberReadTeamThread,
  canMemberReadTeamView,
  canMemberRespondToTeamRuntimeRequest,
  canMemberSeeTeamScheduledTaskWebhook,
  canMemberSteerActiveTeamTurn,
  canModifyTeamMember,
  canToggleTeamThreadLock,
  effectiveTeamThreadNoteHash,
  effectiveUpstreamClientThreadVisibility,
  EnvironmentAuthorizationError,
  EnvironmentId,
  formatAcceptedTeamNoteForPrompt,
  isTeamOwnedThreadAttribution,
  isTeamProviderInstanceId,
  isValidTeamPseudo,
  normalizeTeamPseudo,
  resolveScheduledTaskEffectiveThreadId,
  resolveTeamDisplayName,
  resolveTeamQueuedMessageNotificationRecipients,
  resolveTeamThreadEnvironmentAccess,
  resolveTeamThreadPostBlockReason,
  shouldNotifyTeamMemberForThread,
  DEFAULT_GITHUB_API_BASE_URL,
  DEFAULT_GITHUB_OAUTH_SCOPES,
  DEFAULT_GITHUB_WEB_BASE_URL,
  NonNegativeInt,
  PositiveInt,
  TEAM_ROLE_RANK,
  TeamEnvironmentRecordId,
  TeamId,
  TeamInviteId,
  TeamMemberId,
  TeamOperationError,
  TeamPrepromptId,
  TeamProviderId,
  TeamSkillId,
  TeamThreadNoteId,
  TeamViewId,
  ThreadId,
  TrimmedNonEmptyString,
  defaultTeamProviderDeliveryStrategy,
  type AuthClientMetadata,
  type AuthEnvironmentScope,
  type AuthSessionId,
  type OrchestrationV2Command,
  type ProjectId,
  type ScheduledTask,
  type ScheduledTaskId,
  type ScheduledTaskUpsertInput,
  type TeamAcceptedNoteRef,
  type TeamAccessRule,
  type TeamAssignProjectInput,
  type TeamAttachEnvironmentInput,
  type TeamAutomationGitHubIdentity,
  type TeamCancelGitHubDeviceFlowInput,
  type TeamCancelGitHubDeviceFlowResult,
  type TeamClearAutomationGitHubResult,
  type TeamClearGitHubAppConfigResult,
  type TeamCompleteGitHubOAuthInput,
  type TeamConnectMyGitHubInput,
  type TeamConsumeAcceptedNotesInput,
  type TeamConsumeAcceptedNotesResult,
  type TeamCreateInviteInput,
  type TeamCreateMobilePairingLinkInput,
  type TeamCreateMobilePairingLinkResult,
  type TeamCreateThreadNoteInput,
  type TeamCreateViewInput,
  type TeamDeletePrepromptInput,
  type TeamDeletePrepromptResult,
  type TeamDeleteInput,
  type TeamDeleteProviderInput,
  type TeamDeleteProviderResult,
  type TeamDeleteResult,
  type TeamDeleteSkillInput,
  type TeamDeleteSkillResult,
  type TeamDeleteThreadNoteInput,
  type TeamDeleteThreadNoteResult,
  type TeamDeleteViewInput,
  type TeamDeleteViewResult,
  type TeamDetachEnvironmentInput,
  type TeamDetachEnvironmentResult,
  type TeamDisconnectMyGitHubResult,
  type TeamEditThreadNoteInput,
  type TeamEnvironment,
  type TeamGitHubAppConfig,
  type TeamGitHubIdentity,
  type TeamGitHubOAuthMode,
  type TeamInitializeInput,
  type TeamInitializeResult,
  type TeamInvite,
  type TeamInviteCreatedResult,
  type TeamInvitePreviewResult,
  type TeamIssueLocalSyncTokenResult,
  type TeamLeaveResult,
  type TeamListThreadNotesInput,
  type TeamMember,
  type TeamMobilePairingLinkSummary,
  type TeamPollGitHubDeviceFlowInput,
  type TeamPollGitHubDeviceFlowResult,
  type TeamPreprompt,
  type TeamProjectAssignment,
  type TeamProvider,
  type TeamProviderUsageSummary,
  type TeamPseudo,
  type TeamRedeemInviteResponse,
  type TeamReleaseAcceptedNotesInput,
  type TeamReleaseAcceptedNotesResult,
  type TeamReserveAcceptedNotesInput,
  type TeamReserveAcceptedNotesResult,
  type TeamResolveThreadNoteInput,
  type TeamRevokeInviteInput,
  type TeamRevokeInviteResult,
  type TeamRevokeMobilePairingLinkInput,
  type TeamRevokeMobilePairingLinkResult,
  type TeamRole,
  type TeamScheduledTaskMcpAccessLevel,
  type TeamScheduledTaskMeta,
  type TeamSetAutomationGitHubInput,
  type TeamSetGitHubAppConfigInput,
  type TeamSetThreadLockedInput,
  type TeamSetThreadViewInput,
  type TeamSkill,
  type TeamStartGitHubDeviceFlowInput,
  type TeamStartGitHubDeviceFlowResult,
  type TeamStartGitHubOAuthInput,
  type TeamStartGitHubOAuthResult,
  type TeamStateSnapshot,
  type TeamStateStreamEvent,
  type TeamSyncLocalThreadInput,
  type TeamSyncLocalThreadResult,
  type TeamThreadAttribution,
  type TeamThreadFollowInput,
  type TeamThreadFollowResult,
  type TeamThreadNote,
  type TeamTurnAttribution,
  type TeamTurnAuthorKind,
  type TeamUnassignProjectInput,
  type TeamUnassignProjectResult,
  type TeamUpdateDisplayNameInput,
  type TeamUpdateEnvironmentInput,
  type TeamUpdateMemberRoleInput,
  type TeamUpdateMemberStatusInput,
  type TeamUpdateMyMobileVisibilityInput,
  type TeamUpdateMyPseudoInput,
  type TeamUpdateViewInput,
  type TeamUpsertPrepromptInput,
  type TeamUpsertProviderInput,
  type TeamUpsertSkillInput,
  type TeamView,
  type TeamWorkspace,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient } from "effect/http";

import {
  PENDING_ATTACHMENT_THREAD_SEGMENT,
  parseThreadSegmentFromAttachmentId,
} from "../attachmentStore.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as PairingGrantStore from "../auth/PairingGrantStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import type { McpTeamAutomationPrincipal } from "../mcp/McpInvocationContext.ts";
import type * as EventSink from "../orchestration-v2/EventSink.ts";
import type * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as PeerClientPairing from "../peer/PeerClientPairing.ts";
import type * as PeerLinks from "../peer/PeerLinks.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import type * as ProjectService from "../project/ProjectService.ts";
import { rpcInitialItems } from "../rpcInitialItems.ts";
import type * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TeamAssetsRepository from "./TeamAssetsRepository.ts";
import * as TeamGitHubOAuth from "./TeamGitHubOAuth.ts";
import * as TeamGitHubRepository from "./TeamGitHubRepository.ts";
import {
  localSyncMirroredMessageId,
  localSyncMirroredRunId,
  mirrorLocalThreadSnapshotToEventSink,
} from "./TeamLocalSyncService.ts";
import {
  clearTeamProviderRefreshLock,
  readTeamProviderSecret,
  removeTeamProviderSecret,
  resolveLinkedServerProviderProfileDir,
  teamProviderSecretKey,
  writeTeamProviderSecret,
  type StoredTeamProviderSecret,
} from "./TeamProviderLeaseService.ts";
import * as TeamProviderManager from "./TeamProviderManager.ts";
import * as TeamRepository from "./TeamRepository.ts";
import { validateTeamPrepromptPayload, validateTeamSkillPayload } from "./TeamSkillValidation.ts";
import {
  formatUpstreamCompatLocalEnvironmentBlockedMessage,
  formatUpstreamCompatLockedThreadBlockedMessage,
  formatUpstreamCompatReadOnlyViewBlockedMessage,
  formatUpstreamCompatRemoteEnvironmentBlockedMessage,
  formatUpstreamCompatThreadTitle as formatUpstreamCompatThreadTitlePure,
  stripTitlePrefixOnCompatCommand,
  type TeamThreadTitlePrefixContext,
} from "./upstreamMobileCompat.ts";

const DEFAULT_INVITE_EXPIRY_HOURS = 24 * 7;
const MAX_INVITE_EXPIRY_HOURS = 24 * 90;
const INVITE_TOKEN_PREFIX = "t3team_";
const RENEWABLE_ACCESS_TOKEN_TTL = Duration.hours(1);
const RENEWABLE_SESSION_WINDOW = Duration.days(30);

const hashInviteToken = (token: string): string =>
  NodeCrypto.createHash("sha256").update(token.trim()).digest("hex");

const hashNoteContent = (body: string): string =>
  NodeCrypto.createHash("sha256").update(body, "utf8").digest("hex");

const ADMIN_ONLY_SESSION_SCOPES: ReadonlySet<AuthEnvironmentScope> = new Set([
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthProvidersManageScope,
  AuthRelayWriteScope,
  AuthEnvironmentMaintainScope,
]);

function scopesForTeamRole(role: TeamRole): ReadonlyArray<AuthEnvironmentScope> {
  if (role === "owner" || role === "admin") {
    return AuthStandardClientScopes;
  }
  return AuthStandardClientScopes.filter((scope) => !ADMIN_ONLY_SESSION_SCOPES.has(scope));
}

const toInternalError = (_cause: unknown) =>
  new TeamOperationError({
    code: "internal",
    message: "An internal team service error occurred.",
  });

const logAndMapInternalError =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.tapError((cause) => Effect.logWarning(`TeamService.${operation} failed`, { cause })),
      Effect.mapError(toInternalError),
    );

const stripInviteHash = (invite: TeamRepository.StoredTeamInviteRecord): TeamInvite => ({
  id: invite.id,
  teamId: invite.teamId,
  role: invite.role,
  prefilledPseudo: invite.prefilledPseudo,
  maxUses: invite.maxUses,
  uses: invite.uses,
  expiresAt: invite.expiresAt,
  createdByMemberId: invite.createdByMemberId,
  revokedAt: invite.revokedAt,
  createdAt: invite.createdAt,
});

export type TeamNotificationTriggerEvent =
  | { readonly type: "thread"; readonly threadId: ThreadId }
  | { readonly type: "relayBinding" }
  | {
      readonly type: "queuedMessage";
      readonly threadId: ThreadId;
      readonly queuedRunId: string;
      readonly senderMemberId: TeamMemberId | null;
      readonly senderPseudo: string;
      readonly recipientMemberIds: ReadonlyArray<TeamMemberId>;
      readonly messagePreview: string;
      readonly createdAt: string;
    };

export type TeamAccessChangeEvent =
  | { readonly type: "workspace" }
  | { readonly type: "view"; readonly viewId: TeamViewId }
  | { readonly type: "member"; readonly memberId: TeamMemberId }
  | { readonly type: "memberVisibility"; readonly memberId: TeamMemberId }
  | { readonly type: "memberFollow"; readonly memberId: TeamMemberId; readonly threadId: ThreadId }
  | { readonly type: "memberPseudo"; readonly memberId: TeamMemberId }
  | { readonly type: "threadView"; readonly threadId: ThreadId }
  | { readonly type: "environment"; readonly environmentId: EnvironmentId }
  | { readonly type: "scheduledTaskMeta"; readonly taskId: ScheduledTaskId };

export type TeamActor =
  | { readonly kind: "session"; readonly sessionId: AuthSessionId }
  | { readonly kind: "member"; readonly memberId: TeamMemberId | null }
  | { readonly kind: "team_automation"; readonly principal: McpTeamAutomationPrincipal };

export type TeamTurnPrincipal =
  | { readonly kind: "member"; readonly memberId: TeamMemberId }
  | { readonly kind: "team_automation"; readonly principal: McpTeamAutomationPrincipal };

export interface AuthorizedTeamScheduledTaskUpsert {
  readonly teamId: TeamId;
  readonly environmentId: EnvironmentId;
  readonly viewId: TeamViewId;
  readonly locked: boolean;
  readonly mcpAccessLevel: TeamScheduledTaskMcpAccessLevel;
  readonly actorMemberId: TeamMemberId | null;
}

export interface TeamTurnInterruptEvent {
  readonly threadId: ThreadId;
  readonly runId: string | null;
  readonly actorMemberId: TeamMemberId;
  readonly activeTurnAuthorMemberId: TeamMemberId | null;
  readonly reason: "interrupt" | "stop" | "force_stop" | "mcp_interrupt" | "promote_to_steer";
}

export type TeamTurnInterruptHook = (event: TeamTurnInterruptEvent) => Effect.Effect<void>;

export type TeamGitHubCredentialChangeEvent =
  | { readonly kind: "member"; readonly teamId: TeamId; readonly memberId: TeamMemberId }
  | { readonly kind: "automation"; readonly teamId: TeamId }
  | {
      readonly kind: "environment";
      readonly teamId: TeamId;
      readonly environmentId: EnvironmentId;
      readonly revokedMemberIds?: ReadonlyArray<TeamMemberId>;
    };

export type TeamGitHubCredentialChangeHook = (
  event: TeamGitHubCredentialChangeEvent,
) => Effect.Effect<void>;

const normalizeAccessRule = (rule: TeamAccessRule): TeamAccessRule => ({
  roles: [...new Set(rule.roles)],
  memberIds: [...new Set(rule.memberIds)],
});

const teamReadAuthError = (message = "You do not have permission to view this thread.") =>
  new EnvironmentAuthorizationError({
    message,
    requiredScope: AuthOrchestrationReadScope,
    requiredPermission: "team:thread:read",
  });

const teamPostAuthError = (message = "You do not have permission to post in this thread.") =>
  new EnvironmentAuthorizationError({
    message,
    requiredScope: AuthOrchestrationOperateScope,
    requiredPermission: "team:thread:post",
  });

const teamAdminAuthError = (
  message = "Only owner and admin members can perform this operation.",
  requiredPermission = "team:admin",
) =>
  new EnvironmentAuthorizationError({
    message,
    requiredScope: AuthAccessWriteScope,
    requiredPermission,
  });

const isPreTeamLegacyTimestamp = (
  team: TeamWorkspace,
  threadCreatedAt: string | undefined,
): boolean => {
  if (threadCreatedAt === undefined) return false;
  const threadCreatedMs = Date.parse(threadCreatedAt);
  const teamCreatedMs = Date.parse(team.createdAt);
  return (
    Number.isFinite(threadCreatedMs) &&
    Number.isFinite(teamCreatedMs) &&
    threadCreatedMs < teamCreatedMs
  );
};

const isTeamAdminOrOwner = (member: TeamMember | null): boolean =>
  member !== null &&
  member.status === "active" &&
  (member.role === "owner" || member.role === "admin");

export class TeamService extends Context.Service<
  TeamService,
  {
    readonly isTeamConfigured: () => Effect.Effect<boolean>;
    readonly getState: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<TeamStateSnapshot, TeamOperationError>;
    readonly streamState: (
      sessionId: AuthSessionId,
    ) => Stream.Stream<TeamStateStreamEvent, TeamOperationError>;
    readonly subscribeAccessChanges: () => Stream.Stream<TeamAccessChangeEvent>;
    readonly openAccessChangeSubscription: () => Effect.Effect<
      Stream.Stream<TeamAccessChangeEvent>,
      never,
      Scope.Scope
    >;
    readonly initializeTeam: (input: {
      readonly sessionId: AuthSessionId;
      readonly payload: TeamInitializeInput;
    }) => Effect.Effect<TeamInitializeResult, TeamOperationError>;
    readonly leaveTeam: (input: {
      readonly sessionId: AuthSessionId;
      readonly deferCallerSessionRevocation?:
        | boolean
        | {
            readonly awaitDisconnect?: Effect.Effect<void>;
            readonly fallbackDelay?: Duration.Duration;
          };
      readonly peerClientPairing?: PeerClientPairing.PeerClientPairing["Service"];
      readonly peerLinks?: PeerLinks.PeerLinks["Service"];
    }) => Effect.Effect<TeamLeaveResult, TeamOperationError>;
    readonly deleteTeam: (input: {
      readonly sessionId: AuthSessionId;
      readonly payload: TeamDeleteInput;
      readonly peerClientPairing?: PeerClientPairing.PeerClientPairing["Service"];
      readonly peerLinks?: PeerLinks.PeerLinks["Service"];
      readonly teamProviderManager?: TeamProviderManager.TeamProviderManager["Service"];
      readonly scheduledTaskService?: ScheduledTasks.ScheduledTaskService["Service"];
    }) => Effect.Effect<TeamDeleteResult, TeamOperationError>;
    readonly updateDisplayName: (input: {
      readonly sessionId: AuthSessionId;
      readonly payload: TeamUpdateDisplayNameInput;
    }) => Effect.Effect<TeamWorkspace, TeamOperationError>;
    readonly updateMyPseudo: (input: {
      readonly sessionId: AuthSessionId;
      readonly payload: TeamUpdateMyPseudoInput;
    }) => Effect.Effect<TeamMember, TeamOperationError>;
    readonly updateMemberRole: (input: {
      readonly sessionId: AuthSessionId;
      readonly payload: TeamUpdateMemberRoleInput;
      readonly peerClientPairing?: PeerClientPairing.PeerClientPairing["Service"];
      readonly peerLinks?: PeerLinks.PeerLinks["Service"];
    }) => Effect.Effect<TeamMember, TeamOperationError>;
    readonly updateMemberStatus: (input: {
      readonly sessionId: AuthSessionId;
      readonly payload: TeamUpdateMemberStatusInput;
      readonly peerClientPairing?: PeerClientPairing.PeerClientPairing["Service"];
      readonly peerLinks?: PeerLinks.PeerLinks["Service"];
    }) => Effect.Effect<TeamMember, TeamOperationError>;
    readonly createInvite: (input: {
      readonly sessionId: AuthSessionId;
      readonly payload: TeamCreateInviteInput;
    }) => Effect.Effect<TeamInviteCreatedResult, TeamOperationError>;
    readonly revokeInvite: (input: {
      readonly sessionId: AuthSessionId;
      readonly payload: TeamRevokeInviteInput;
    }) => Effect.Effect<TeamRevokeInviteResult, TeamOperationError>;
    readonly previewInvite: (
      token: string,
    ) => Effect.Effect<TeamInvitePreviewResult, TeamOperationError>;
    readonly redeemInvite: (input: {
      readonly token: string;
      readonly pseudo: string;
      readonly client: AuthClientMetadata;
      readonly proofKeyThumbprint?: string;
    }) => Effect.Effect<TeamRedeemInviteResponse, TeamOperationError>;
    readonly createView: (input: {
      readonly sessionId: AuthSessionId;
      readonly payload: TeamCreateViewInput;
    }) => Effect.Effect<TeamView, TeamOperationError>;
    readonly updateView: (input: {
      readonly sessionId: AuthSessionId;
      readonly payload: TeamUpdateViewInput;
    }) => Effect.Effect<TeamView, TeamOperationError>;
    readonly deleteView: (input: {
      readonly sessionId: AuthSessionId;
      readonly payload: TeamDeleteViewInput;
    }) => Effect.Effect<TeamDeleteViewResult, TeamOperationError>;
    readonly setThreadView: (input: {
      readonly sessionId: AuthSessionId;
      readonly payload: TeamSetThreadViewInput;
    }) => Effect.Effect<TeamThreadAttribution, TeamOperationError>;
    readonly setThreadLocked: (input: {
      readonly sessionId: AuthSessionId;
      readonly payload: TeamSetThreadLockedInput;
    }) => Effect.Effect<TeamThreadAttribution, TeamOperationError>;
    readonly listThreadAttributions: (
      sessionId?: AuthSessionId,
    ) => Effect.Effect<ReadonlyArray<TeamThreadAttribution>, TeamOperationError>;
    readonly canReadThread: (
      sessionId: AuthSessionId,
      threadId: ThreadId,
    ) => Effect.Effect<boolean>;
    readonly assertCanReadThread: (
      sessionId: AuthSessionId,
      threadId: ThreadId,
    ) => Effect.Effect<void, EnvironmentAuthorizationError>;
    readonly canReadAttachment: (
      sessionId: AuthSessionId,
      attachmentId: string,
    ) => Effect.Effect<boolean>;
    readonly assertCanReadAttachment: (
      sessionId: AuthSessionId,
      attachmentId: string,
    ) => Effect.Effect<void, EnvironmentAuthorizationError>;
    readonly filterReadableThreadIds: (
      sessionId: AuthSessionId,
      threadIds: ReadonlyArray<ThreadId>,
    ) => Effect.Effect<ReadonlySet<ThreadId>>;
    readonly canPostInThread: (
      sessionId: AuthSessionId,
      threadId: ThreadId,
    ) => Effect.Effect<boolean>;
    readonly assertCanPostInThread: (
      sessionId: AuthSessionId,
      threadId: ThreadId,
    ) => Effect.Effect<void, EnvironmentAuthorizationError>;
    readonly assertCanLaunchThread: (input: {
      readonly sessionId: AuthSessionId;
      readonly threadId?: ThreadId;
      readonly projectId?: ProjectId;
      readonly reuseExistingThread?: boolean;
      readonly viewId?: TeamViewId;
      readonly locked?: boolean;
    }) => Effect.Effect<void, EnvironmentAuthorizationError>;
    readonly assertCanDispatchCommand: (
      sessionId: AuthSessionId,
      command: OrchestrationV2Command,
    ) => Effect.Effect<void, EnvironmentAuthorizationError>;
    readonly assertAndNormalizeDispatchCommand: (
      sessionId: AuthSessionId,
      command: OrchestrationV2Command,
      options?: { readonly upstreamCompat?: boolean },
    ) => Effect.Effect<OrchestrationV2Command, EnvironmentAuthorizationError>;
    readonly assertCanInterruptThread: (
      sessionId: AuthSessionId,
      threadId: ThreadId,
      runId?: string | null,
    ) => Effect.Effect<void, EnvironmentAuthorizationError>;
    readonly assertCanPromoteQueuedRun: (
      sessionId: AuthSessionId,
      threadId: ThreadId,
    ) => Effect.Effect<void, EnvironmentAuthorizationError>;
    readonly assertCanCreateGuestShare: (
      sessionId: AuthSessionId,
      threadId: ThreadId,
    ) => Effect.Effect<void, EnvironmentAuthorizationError>;
    readonly assertCanUseWorkflows: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<void, EnvironmentAuthorizationError>;
    readonly assertCanUseScheduledTasks: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<void, EnvironmentAuthorizationError>;
    readonly getScheduledTaskMeta: (
      taskId: ScheduledTaskId,
    ) => Effect.Effect<Option.Option<TeamScheduledTaskMeta>>;
    readonly filterReadableScheduledTasksForActor: (
      actor: TeamActor,
      tasks: ReadonlyArray<ScheduledTask>,
    ) => Effect.Effect<ReadonlyArray<ScheduledTask>>;
    readonly filterReadableScheduledTasks: (
      sessionId: AuthSessionId,
      tasks: ReadonlyArray<ScheduledTask>,
    ) => Effect.Effect<ReadonlyArray<ScheduledTask>>;
    readonly assertActorCanReadScheduledTask: (
      actor: TeamActor,
      taskId: ScheduledTaskId,
      boundThreadId?: ThreadId | null,
      projectId?: ProjectId | null,
    ) => Effect.Effect<void, EnvironmentAuthorizationError>;
    readonly assertCanReadScheduledTask: (
      sessionId: AuthSessionId,
      taskId: ScheduledTaskId,
      boundThreadId?: ThreadId | null,
      projectId?: ProjectId | null,
    ) => Effect.Effect<void, EnvironmentAuthorizationError>;
    readonly assertActorCanReadScheduledTaskWebhooks: (
      actor: TeamActor,
      taskId: ScheduledTaskId,
      boundThreadId?: ThreadId | null,
    ) => Effect.Effect<void, EnvironmentAuthorizationError>;
    readonly assertCanReadScheduledTaskWebhooks: (
      sessionId: AuthSessionId,
      taskId: ScheduledTaskId,
      boundThreadId?: ThreadId | null,
    ) => Effect.Effect<void, EnvironmentAuthorizationError>;
    readonly authorizeScheduledTaskUpsertForActor: (input: {
      readonly actor: TeamActor;
      readonly input: ScheduledTaskUpsertInput;
      readonly existingTask: ScheduledTask | null;
    }) => Effect.Effect<
      Option.Option<AuthorizedTeamScheduledTaskUpsert>,
      EnvironmentAuthorizationError
    >;
    readonly authorizeScheduledTaskUpsert: (input: {
      readonly sessionId: AuthSessionId;
      readonly input: ScheduledTaskUpsertInput;
      readonly existingTask: ScheduledTask | null;
    }) => Effect.Effect<
      Option.Option<AuthorizedTeamScheduledTaskUpsert>,
      EnvironmentAuthorizationError
    >;
    readonly persistScheduledTaskMeta: (
      input: AuthorizedTeamScheduledTaskUpsert & { readonly taskId: ScheduledTaskId },
    ) => Effect.Effect<TeamScheduledTaskMeta, TeamRepository.TeamRepositoryError>;
    readonly withScheduledTaskWorkspaceGate: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    readonly publishScheduledTaskMeta: (meta: TeamScheduledTaskMeta) => Effect.Effect<void>;
    readonly saveScheduledTaskMeta: (
      input: AuthorizedTeamScheduledTaskUpsert & { readonly taskId: ScheduledTaskId },
    ) => Effect.Effect<TeamScheduledTaskMeta, TeamRepository.TeamRepositoryError>;
    readonly deleteScheduledTaskMeta: (taskId: ScheduledTaskId) => Effect.Effect<void>;
    readonly assertActorCanMutateScheduledTask: (
      actor: TeamActor,
      taskId: ScheduledTaskId,
      boundThreadId?: ThreadId | null,
      options?: { readonly isRunNow?: boolean },
    ) => Effect.Effect<void, EnvironmentAuthorizationError>;
    readonly assertCanMutateScheduledTask: (
      sessionId: AuthSessionId,
      taskId: ScheduledTaskId,
      boundThreadId?: ThreadId | null,
      options?: { readonly isRunNow?: boolean },
    ) => Effect.Effect<void, EnvironmentAuthorizationError>;
    readonly followThread: (input: {
      readonly sessionId: AuthSessionId;
      readonly payload: TeamThreadFollowInput;
    }) => Effect.Effect<TeamThreadFollowResult, TeamOperationError>;
    readonly unfollowThread: (input: {
      readonly sessionId: AuthSessionId;
      readonly payload: TeamThreadFollowInput;
    }) => Effect.Effect<TeamThreadFollowResult, TeamOperationError>;
    readonly listFollowedThreads: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<ReadonlyArray<ThreadId>, TeamOperationError>;
    readonly shouldNotifyMemberForThread: (input: {
      readonly memberId: TeamMemberId;
      readonly threadId: ThreadId;
      readonly turnId?: string;
    }) => Effect.Effect<boolean>;
    readonly listNotificationRecipientsForThread: (input: {
      readonly threadId: ThreadId;
      readonly turnId?: string;
    }) => Effect.Effect<{
      readonly isTeamThread: boolean;
      readonly recipientMemberIds: ReadonlyArray<TeamMemberId> | null;
    }>;
    readonly shouldPublishRelayNotificationForThread: (input: {
      readonly threadId: ThreadId;
      readonly turnId?: string;
      readonly threadCreatedAt?: string;
      readonly cloudUserId?: string | null;
    }) => Effect.Effect<boolean>;
    readonly shouldPublishRelayQueuedMessageNotification?: (input: {
      readonly threadId: ThreadId;
      readonly recipientMemberIds: ReadonlyArray<TeamMemberId>;
      readonly cloudUserId?: string | null;
    }) => Effect.Effect<boolean>;
    readonly bindRelayRecipientForSession: (input: {
      readonly sessionId: AuthSessionId;
      readonly cloudUserId?: string | null;
    }) => Effect.Effect<void>;
    readonly clearRelayRecipientBinding: () => Effect.Effect<void>;
    readonly subscribeNotificationEvents?: () => Stream.Stream<TeamNotificationTriggerEvent>;
    readonly recordThreadCreated: (input: {
      readonly sessionId: AuthSessionId;
      readonly threadId: ThreadId;
      readonly projectId?: ProjectId;
      readonly viewId?: TeamViewId;
      readonly locked?: boolean;
    }) => Effect.Effect<void>;
    readonly prepareThreadAttribution: (input: {
      readonly sessionId: AuthSessionId;
      readonly threadId: ThreadId;
      readonly projectId?: ProjectId;
      readonly viewId?: TeamViewId;
      readonly locked?: boolean;
    }) => Effect.Effect<boolean, EnvironmentAuthorizationError>;
    readonly prepareThreadInheritedFromParent: (input: {
      readonly parentThreadId: ThreadId;
      readonly threadId: ThreadId;
      readonly creatorSessionId?: AuthSessionId;
      readonly creatorMemberId?: TeamMemberId;
      readonly teamAutomation?: McpTeamAutomationPrincipal;
    }) => Effect.Effect<boolean, EnvironmentAuthorizationError>;
    readonly prepareTeamAutomationThreadAttribution: (input: {
      readonly threadId: ThreadId;
      readonly taskId: ScheduledTaskId;
      readonly projectId: ProjectId;
      readonly viewId?: TeamViewId;
      readonly locked?: boolean;
      readonly environmentId?: EnvironmentId;
    }) => Effect.Effect<boolean, EnvironmentAuthorizationError>;
    readonly publishTeamAutomationThreadAttributed: (threadId: ThreadId) => Effect.Effect<void>;
    readonly recordTeamAutomationTurn: (input: {
      readonly threadId: ThreadId;
      readonly turnId: string;
      readonly taskId?: ScheduledTaskId;
      readonly projectId?: ProjectId;
      readonly principal?: McpTeamAutomationPrincipal;
    }) => Effect.Effect<Option.Option<McpTeamAutomationPrincipal>>;
    readonly requireTeamAutomationTurn: (input: {
      readonly threadId: ThreadId;
      readonly turnId: string;
      readonly taskId?: ScheduledTaskId;
      readonly projectId?: ProjectId;
      readonly principal?: McpTeamAutomationPrincipal;
    }) => Effect.Effect<Option.Option<McpTeamAutomationPrincipal>, EnvironmentAuthorizationError>;
    readonly rollbackPreparedThreadAttribution: (threadId: ThreadId) => Effect.Effect<void>;
    readonly rollbackRecordedTurnAttribution: (input: {
      readonly threadId: ThreadId;
      readonly turnId: string;
    }) => Effect.Effect<void>;
    readonly recordTurnAuthored: (input: {
      readonly sessionId: AuthSessionId;
      readonly threadId: ThreadId;
      readonly turnId: string;
    }) => Effect.Effect<void>;
    readonly recordTurnAuthoredByMember: (input: {
      readonly memberId: TeamMemberId;
      readonly threadId: ThreadId;
      readonly turnId: string;
    }) => Effect.Effect<void>;
    readonly requireTurnAuthoredBySession: (input: {
      readonly sessionId: AuthSessionId;
      readonly threadId: ThreadId;
      readonly turnId: string;
    }) => Effect.Effect<void, EnvironmentAuthorizationError>;
    readonly requireTurnAuthoredByMember: (input: {
      readonly memberId: TeamMemberId;
      readonly threadId: ThreadId;
      readonly turnId: string;
    }) => Effect.Effect<void, EnvironmentAuthorizationError>;
    readonly prepareTurnAttributionForCommand: (
      sessionId: AuthSessionId,
      command: OrchestrationV2Command,
    ) => Effect.Effect<void, EnvironmentAuthorizationError>;
    readonly prepareThreadAttributionForMember: (input: {
      readonly memberId: TeamMemberId;
      readonly threadId: ThreadId;
      readonly viewId?: TeamViewId;
      readonly locked?: boolean;
    }) => Effect.Effect<boolean, EnvironmentAuthorizationError>;
    readonly recordThreadCreatedByMember: (input: {
      readonly memberId: TeamMemberId;
      readonly threadId: ThreadId;
      readonly viewId?: TeamViewId;
      readonly locked?: boolean;
    }) => Effect.Effect<void>;
    readonly recordThreadInheritedFromParent: (input: {
      readonly parentThreadId: ThreadId;
      readonly threadId: ThreadId;
      readonly turnId?: string;
      readonly creatorMemberId?: TeamMemberId;
      readonly teamAutomation?: McpTeamAutomationPrincipal;
    }) => Effect.Effect<void>;
    readonly getThreadAttribution: (
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<TeamThreadAttribution>>;
    readonly resolveMemberIdForSession: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<Option.Option<TeamMemberId>>;
    readonly resolveTurnPrincipal: (input: {
      readonly threadId: ThreadId;
      readonly runId?: string | null;
      readonly userMessageId?: string | null;
      readonly continuedFromRunId?: string | null;
    }) => Effect.Effect<Option.Option<TeamTurnPrincipal>>;
    readonly resolveTurnAuthorMemberId: (input: {
      readonly threadId: ThreadId;
      readonly runId?: string | null;
      readonly userMessageId?: string | null;
      readonly continuedFromRunId?: string | null;
    }) => Effect.Effect<Option.Option<TeamMemberId>>;
    readonly assertActorIsActiveMember: (
      actor: TeamActor,
    ) => Effect.Effect<void, EnvironmentAuthorizationError>;
    readonly canActorReadThread: (actor: TeamActor, threadId: ThreadId) => Effect.Effect<boolean>;
    readonly assertActorCanReadThread: (
      actor: TeamActor,
      threadId: ThreadId,
    ) => Effect.Effect<void, EnvironmentAuthorizationError>;
    readonly filterReadableThreadIdsForActor: (
      actor: TeamActor,
      threadIds: ReadonlyArray<ThreadId>,
    ) => Effect.Effect<ReadonlySet<ThreadId>>;
    readonly canActorPostInThread: (actor: TeamActor, threadId: ThreadId) => Effect.Effect<boolean>;
    readonly assertActorCanPostInThread: (
      actor: TeamActor,
      threadId: ThreadId,
    ) => Effect.Effect<void, EnvironmentAuthorizationError>;
    readonly assertActorCanCreateThreadInView: (input: {
      readonly actor: TeamActor;
      readonly viewId?: TeamViewId;
      readonly locked?: boolean;
      readonly projectId?: ProjectId;
    }) => Effect.Effect<void, EnvironmentAuthorizationError>;
    readonly canActorSteerActiveTurn: (
      actor: TeamActor,
      threadId: ThreadId,
    ) => Effect.Effect<boolean>;
    readonly assertActorCanSteerActiveTurn: (
      actor: TeamActor,
      threadId: ThreadId,
    ) => Effect.Effect<void, EnvironmentAuthorizationError>;
    readonly assertActorCanPromoteQueuedRun: (
      actor: TeamActor,
      threadId: ThreadId,
    ) => Effect.Effect<void, EnvironmentAuthorizationError>;
    readonly assertActorCanInterruptThread: (
      actor: TeamActor,
      threadId: ThreadId,
      runId?: string | null,
    ) => Effect.Effect<void, EnvironmentAuthorizationError>;
    readonly assertActorCanRespondToRuntimeRequest: (
      actor: TeamActor,
      threadId: ThreadId,
      runId?: string | null,
    ) => Effect.Effect<void, EnvironmentAuthorizationError>;
    readonly assertActorCanManageQueuedRun: (
      actor: TeamActor,
      threadId: ThreadId,
      runId: string,
    ) => Effect.Effect<void, EnvironmentAuthorizationError>;
    readonly assertActorCanUseWorkflows: (
      actor: TeamActor,
    ) => Effect.Effect<void, EnvironmentAuthorizationError>;
    readonly assertActorCanUseScheduledTasks: (
      actor: TeamActor,
    ) => Effect.Effect<void, EnvironmentAuthorizationError>;
    readonly assertActorIsAdmin: (
      actor: TeamActor,
      message?: string,
      requiredPermission?: string,
    ) => Effect.Effect<void, EnvironmentAuthorizationError>;
    readonly registerTurnInterruptHook: (hook: TeamTurnInterruptHook) => Effect.Effect<() => void>;
    readonly registerGitHubCredentialChangeHook: (
      hook: TeamGitHubCredentialChangeHook,
    ) => Effect.Effect<() => void>;
    readonly notifyTurnInterrupted: (input: {
      readonly actor: TeamActor;
      readonly threadId: ThreadId;
      readonly runId?: string | null;
      readonly reason: TeamTurnInterruptEvent["reason"];
    }) => Effect.Effect<void>;
    readonly notifyQueuedMessage: (input: {
      readonly actor: TeamActor;
      readonly threadId: ThreadId;
      readonly queuedRunId: string;
      readonly commandId?: string | null;
      readonly activeRunId?: string | null;
      readonly messageText?: string | null;
    }) => Effect.Effect<{ readonly notifiedMemberIds: ReadonlyArray<TeamMemberId> }>;
    readonly assignProject: (input: {
      readonly sessionId: AuthSessionId;
      readonly payload: TeamAssignProjectInput;
      readonly projectService?: ProjectService.ProjectService["Service"];
    }) => Effect.Effect<TeamProjectAssignment, TeamOperationError>;
    readonly unassignProject: (input: {
      readonly sessionId: AuthSessionId;
      readonly payload: TeamUnassignProjectInput;
    }) => Effect.Effect<TeamUnassignProjectResult, TeamOperationError>;
    readonly attachEnvironment: (input: {
      readonly sessionId: AuthSessionId;
      readonly payload: TeamAttachEnvironmentInput;
      readonly peerLinks?: PeerLinks.PeerLinks["Service"];
    }) => Effect.Effect<TeamEnvironment, TeamOperationError>;
    readonly updateEnvironment: (input: {
      readonly sessionId: AuthSessionId;
      readonly payload: TeamUpdateEnvironmentInput;
      readonly peerClientPairing?: PeerClientPairing.PeerClientPairing["Service"];
    }) => Effect.Effect<TeamEnvironment, TeamOperationError>;
    readonly detachEnvironment: (input: {
      readonly sessionId: AuthSessionId;
      readonly payload: TeamDetachEnvironmentInput;
      readonly peerLinks?: PeerLinks.PeerLinks["Service"];
      readonly peerClientPairing?: PeerClientPairing.PeerClientPairing["Service"];
    }) => Effect.Effect<TeamDetachEnvironmentResult, TeamOperationError>;
    readonly getRemotePairingSubject: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<Option.Option<string>, EnvironmentAuthorizationError>;
    readonly assertCanAccessLocalEnvironment: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<void, EnvironmentAuthorizationError>;
    readonly unlinkRemoteEnvironment: (input: {
      readonly environmentId: EnvironmentId;
      readonly peerClientPairing?: PeerClientPairing.PeerClientPairing["Service"];
      readonly peerLinks: PeerLinks.PeerLinks["Service"];
    }) => ReturnType<PeerLinks.PeerLinks["Service"]["unlink"]>;
    readonly pairRemoteEnvironmentForSession: (input: {
      readonly sessionId: AuthSessionId;
      readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
      readonly pairingInput: Parameters<
        PeerClientPairing.PeerClientPairing["Service"]["request"]
      >[0];
      readonly peerClientPairing: PeerClientPairing.PeerClientPairing["Service"];
      readonly peerLinks?: PeerLinks.PeerLinks["Service"];
    }) => Effect.Effect<
      Effect.Success<ReturnType<PeerClientPairing.PeerClientPairing["Service"]["request"]>>,
      | EnvironmentAuthorizationError
      | Effect.Error<ReturnType<PeerClientPairing.PeerClientPairing["Service"]["request"]>>
    >;
    readonly drainPendingRemoteRevocations: (input: {
      readonly environmentId?: EnvironmentId;
      readonly peerClientPairing?: PeerClientPairing.PeerClientPairing["Service"];
      readonly peerLinks?: PeerLinks.PeerLinks["Service"];
    }) => Effect.Effect<void>;
    readonly canActorAccessEnvironment: (
      actor: TeamActor,
      environmentId: EnvironmentId,
    ) => Effect.Effect<boolean>;
    readonly assertActorCanAccessEnvironment: (
      actor: TeamActor,
      environmentId: EnvironmentId,
    ) => Effect.Effect<void, EnvironmentAuthorizationError>;
    readonly assertCanAccessEnvironment: (
      sessionId: AuthSessionId,
      environmentId: EnvironmentId,
    ) => Effect.Effect<void, EnvironmentAuthorizationError>;
    readonly filterAccessibleEnvironmentIdsForActor: (
      actor: TeamActor,
      environmentIds: ReadonlyArray<EnvironmentId>,
    ) => Effect.Effect<ReadonlySet<EnvironmentId>>;
    readonly filterAccessibleEnvironmentIds: (
      sessionId: AuthSessionId,
      environmentIds: ReadonlyArray<EnvironmentId>,
    ) => Effect.Effect<ReadonlySet<EnvironmentId>>;
    readonly assertActorCanExecuteOnThreadEnvironment: (
      actor: TeamActor,
      threadId: ThreadId,
      options?: { readonly upstreamCompat?: boolean },
    ) => Effect.Effect<void, EnvironmentAuthorizationError>;
    readonly assertCanExecuteOnThreadEnvironment: (
      sessionId: AuthSessionId,
      threadId: ThreadId,
      options?: { readonly upstreamCompat?: boolean },
    ) => Effect.Effect<void, EnvironmentAuthorizationError>;
    readonly syncLocalThread: (input: {
      readonly sessionId: AuthSessionId;
      readonly payload: TeamSyncLocalThreadInput;
      readonly eventSink?: EventSink.EventSinkV2["Service"];
      readonly projectionStore?: ProjectionStore.ProjectionStoreV2["Service"];
    }) => Effect.Effect<TeamSyncLocalThreadResult, TeamOperationError>;
    readonly createThreadNote: (input: {
      readonly sessionId: AuthSessionId;
      readonly payload: TeamCreateThreadNoteInput;
    }) => Effect.Effect<TeamThreadNote, TeamOperationError>;
    readonly deleteThreadNote: (input: {
      readonly sessionId: AuthSessionId;
      readonly payload: TeamDeleteThreadNoteInput;
    }) => Effect.Effect<TeamDeleteThreadNoteResult, TeamOperationError>;
    readonly resolveThreadNote: (input: {
      readonly sessionId: AuthSessionId;
      readonly payload: TeamResolveThreadNoteInput;
    }) => Effect.Effect<TeamThreadNote, TeamOperationError>;
    readonly editThreadNote: (input: {
      readonly sessionId: AuthSessionId;
      readonly payload: TeamEditThreadNoteInput;
    }) => Effect.Effect<TeamThreadNote, TeamOperationError>;
    readonly reserveAcceptedNotes: (input: {
      readonly sessionId: AuthSessionId;
      readonly payload: TeamReserveAcceptedNotesInput;
    }) => Effect.Effect<TeamReserveAcceptedNotesResult, TeamOperationError>;
    readonly releaseAcceptedNotes: (input: {
      readonly sessionId: AuthSessionId;
      readonly payload: TeamReleaseAcceptedNotesInput;
    }) => Effect.Effect<TeamReleaseAcceptedNotesResult, TeamOperationError>;
    readonly consumeAcceptedNotes: (input: {
      readonly sessionId: AuthSessionId;
      readonly payload: TeamConsumeAcceptedNotesInput;
    }) => Effect.Effect<TeamConsumeAcceptedNotesResult, TeamOperationError>;
    readonly listThreadNotes: (input: {
      readonly sessionId: AuthSessionId;
      readonly payload: TeamListThreadNotesInput;
    }) => Effect.Effect<ReadonlyArray<TeamThreadNote>, TeamOperationError>;
    readonly prepareNotesForDispatchCommand: (input: {
      readonly sessionId: AuthSessionId;
      readonly command: OrchestrationV2Command;
    }) => Effect.Effect<
      {
        readonly command: OrchestrationV2Command;
        readonly reservationToken: string | null;
      },
      EnvironmentAuthorizationError
    >;
    readonly releaseNoteReservationByToken: (reservationToken: string) => Effect.Effect<void>;
    readonly verifyAcceptedNotesForDispatch: (input: {
      readonly sessionId: AuthSessionId;
      readonly threadId: ThreadId;
      readonly acceptedNotes: ReadonlyArray<TeamAcceptedNoteRef>;
    }) => Effect.Effect<string, EnvironmentAuthorizationError>;
    readonly finalizeNotesForDispatchedTurn: (input: {
      readonly sessionId: AuthSessionId;
      readonly threadId: ThreadId;
      readonly targetTurnId: string;
      readonly acceptedNotes: ReadonlyArray<TeamAcceptedNoteRef>;
      readonly reservationToken?: string | null;
    }) => Effect.Effect<void>;
    readonly upsertProvider: (input: {
      readonly sessionId: AuthSessionId;
      readonly payload: TeamUpsertProviderInput;
    }) => Effect.Effect<TeamProvider, TeamOperationError>;
    readonly deleteProvider: (input: {
      readonly sessionId: AuthSessionId;
      readonly payload: TeamDeleteProviderInput;
    }) => Effect.Effect<TeamDeleteProviderResult, TeamOperationError>;
    readonly listProviderUsage: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<ReadonlyArray<TeamProviderUsageSummary>, TeamOperationError>;
    readonly upsertSkill: (input: {
      readonly sessionId: AuthSessionId;
      readonly payload: TeamUpsertSkillInput;
    }) => Effect.Effect<TeamSkill, TeamOperationError>;
    readonly deleteSkill: (input: {
      readonly sessionId: AuthSessionId;
      readonly payload: TeamDeleteSkillInput;
    }) => Effect.Effect<TeamDeleteSkillResult, TeamOperationError>;
    readonly upsertPreprompt: (input: {
      readonly sessionId: AuthSessionId;
      readonly payload: TeamUpsertPrepromptInput;
    }) => Effect.Effect<TeamPreprompt, TeamOperationError>;
    readonly deletePreprompt: (input: {
      readonly sessionId: AuthSessionId;
      readonly payload: TeamDeletePrepromptInput;
    }) => Effect.Effect<TeamDeletePrepromptResult, TeamOperationError>;
    readonly issueLocalSyncToken: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<TeamIssueLocalSyncTokenResult, TeamOperationError>;
    readonly assertCanManageServerProviders: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<void, EnvironmentAuthorizationError>;
    readonly assertLocalBindingHostAllowed: () => Effect.Effect<void, TeamOperationError>;
    readonly updateMyMobileVisibility: (input: {
      readonly sessionId: AuthSessionId;
      readonly payload: TeamUpdateMyMobileVisibilityInput;
    }) => Effect.Effect<TeamMember, TeamOperationError>;
    readonly assertCanCreateStandardPairingLink: (input: {
      readonly sessionId: AuthSessionId;
      readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
    }) => Effect.Effect<void, TeamOperationError>;
    readonly bindPairingLinkToSessionMember: (input: {
      readonly sessionId: AuthSessionId;
      readonly pairingLinkId: string;
    }) => Effect.Effect<{ readonly bound: boolean }, TeamOperationError>;
    readonly createMobilePairingLink: (input: {
      readonly sessionId: AuthSessionId;
      readonly callerScopes: ReadonlyArray<AuthEnvironmentScope>;
      readonly payload: TeamCreateMobilePairingLinkInput;
      readonly serverAuth?: EnvironmentAuth.EnvironmentAuth["Service"];
    }) => Effect.Effect<TeamCreateMobilePairingLinkResult, TeamOperationError>;
    readonly listMyMobilePairingLinks: (input: {
      readonly sessionId: AuthSessionId;
      readonly serverAuth?: EnvironmentAuth.EnvironmentAuth["Service"];
    }) => Effect.Effect<ReadonlyArray<TeamMobilePairingLinkSummary>, TeamOperationError>;
    readonly revokeMyMobilePairingLink: (input: {
      readonly sessionId: AuthSessionId;
      readonly payload: TeamRevokeMobilePairingLinkInput;
      readonly serverAuth?: EnvironmentAuth.EnvironmentAuth["Service"];
    }) => Effect.Effect<TeamRevokeMobilePairingLinkResult, TeamOperationError>;
    readonly markPairingLinkRevoked: (pairingLinkId: string) => Effect.Effect<void>;
    readonly getThreadTitlePrefixContextMap: (
      threadIds: ReadonlyArray<ThreadId>,
    ) => Effect.Effect<ReadonlyMap<ThreadId, TeamThreadTitlePrefixContext>>;
    readonly formatUpstreamCompatThreadTitle: (
      threadId: ThreadId,
      rawTitle: string,
    ) => Effect.Effect<string>;
    readonly filterVisibleShellThreadIds: (
      sessionId: AuthSessionId,
      threadIds: ReadonlyArray<ThreadId>,
      options?: { readonly upstreamCompat?: boolean },
    ) => Effect.Effect<ReadonlySet<ThreadId>>;
    readonly canShowThreadInShell: (
      sessionId: AuthSessionId,
      threadId: ThreadId,
      options?: { readonly upstreamCompat?: boolean },
    ) => Effect.Effect<boolean>;
    readonly shouldRefreshShellForAccessChange: (
      sessionId: AuthSessionId,
      change: TeamAccessChangeEvent,
      options?: { readonly upstreamCompat?: boolean },
    ) => Effect.Effect<boolean>;
    readonly connectMyGitHub: (input: {
      readonly sessionId: AuthSessionId;
      readonly payload: TeamConnectMyGitHubInput;
    }) => Effect.Effect<TeamGitHubIdentity, TeamOperationError>;
    readonly disconnectMyGitHub: (input: {
      readonly sessionId: AuthSessionId;
    }) => Effect.Effect<TeamDisconnectMyGitHubResult, TeamOperationError>;
    readonly setAutomationGitHub: (input: {
      readonly sessionId: AuthSessionId;
      readonly payload: TeamSetAutomationGitHubInput;
    }) => Effect.Effect<TeamAutomationGitHubIdentity, TeamOperationError>;
    readonly clearAutomationGitHub: (input: {
      readonly sessionId: AuthSessionId;
    }) => Effect.Effect<TeamClearAutomationGitHubResult, TeamOperationError>;
    readonly setGitHubAppConfig: (input: {
      readonly sessionId: AuthSessionId;
      readonly payload: TeamSetGitHubAppConfigInput;
    }) => Effect.Effect<TeamGitHubAppConfig, TeamOperationError>;
    readonly clearGitHubAppConfig: (input: {
      readonly sessionId: AuthSessionId;
    }) => Effect.Effect<TeamClearGitHubAppConfigResult, TeamOperationError>;
    readonly startGitHubOAuth: (input: {
      readonly sessionId: AuthSessionId;
      readonly payload: TeamStartGitHubOAuthInput;
    }) => Effect.Effect<TeamStartGitHubOAuthResult, TeamOperationError>;
    readonly completeGitHubOAuthCallback: (input: {
      readonly code?: string | null;
      readonly state?: string | null;
      readonly error?: string | null;
      readonly errorDescription?: string | null;
      readonly callbackSessionId: AuthSessionId | null;
    }) => Effect.Effect<
      | {
          readonly status: "connected";
          readonly identity: TeamGitHubIdentity;
          readonly mode: TeamGitHubOAuthMode;
        }
      | {
          readonly status: "confirmation_required";
          readonly confirmationCode: string;
        },
      TeamOperationError
    >;
    readonly completeGitHubOAuth: (input: {
      readonly sessionId: AuthSessionId;
      readonly payload: TeamCompleteGitHubOAuthInput;
    }) => Effect.Effect<TeamGitHubIdentity, TeamOperationError>;
    readonly startGitHubDeviceFlow: (input: {
      readonly sessionId: AuthSessionId;
      readonly payload: TeamStartGitHubDeviceFlowInput;
    }) => Effect.Effect<TeamStartGitHubDeviceFlowResult, TeamOperationError>;
    readonly pollGitHubDeviceFlow: (input: {
      readonly sessionId: AuthSessionId;
      readonly payload: TeamPollGitHubDeviceFlowInput;
    }) => Effect.Effect<TeamPollGitHubDeviceFlowResult, TeamOperationError>;
    readonly cancelGitHubDeviceFlow: (input: {
      readonly sessionId: AuthSessionId;
      readonly payload: TeamCancelGitHubDeviceFlowInput;
    }) => Effect.Effect<TeamCancelGitHubDeviceFlowResult, TeamOperationError>;
    readonly publishMemberGitHubIdentityUpdate: (input: {
      readonly memberId: TeamMemberId;
      readonly identity: TeamGitHubIdentity | null;
    }) => Effect.Effect<void>;
  }
>()("t3/team/TeamService") {}

const make = Effect.gen(function* () {
  const repository = yield* TeamRepository.TeamRepository;
  const sessionStore = yield* SessionStore.SessionStore;
  const random = yield* SecureRandom.SecureRandom;
  const serverEnvironmentOption = yield* Effect.serviceOption(ServerEnvironment.ServerEnvironment);
  const assetsRepositoryOption = yield* Effect.serviceOption(
    TeamAssetsRepository.TeamAssetsRepository,
  );
  const githubRepositoryOption = yield* Effect.serviceOption(
    TeamGitHubRepository.TeamGitHubRepository,
  );
  const httpClientOption = yield* Effect.serviceOption(HttpClient.HttpClient);
  const secretStoreOption = yield* Effect.serviceOption(ServerSecretStore.ServerSecretStore);
  const serverConfigOption = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  const authSessionsOption = yield* Effect.serviceOption(AuthSessions.AuthSessionRepository);
  const environmentAuthOption = yield* Effect.serviceOption(EnvironmentAuth.EnvironmentAuth);
  const pairingGrantStoreOption = yield* Effect.serviceOption(PairingGrantStore.PairingGrantStore);
  const serverSettingsOption = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
  const providerManagerOption = yield* Effect.serviceOption(
    TeamProviderManager.TeamProviderManager,
  );
  const githubOAuthFlowStore = TeamGitHubOAuth.createGitHubOAuthFlowStore();
  const eventsPubSub = yield* PubSub.unbounded<TeamStateStreamEvent>();
  const notificationTriggersPubSub = yield* PubSub.unbounded<TeamNotificationTriggerEvent>();
  const accessChangesPubSub = yield* PubSub.unbounded<TeamAccessChangeEvent>();
  const turnInterruptHooks = new Set<TeamTurnInterruptHook>();
  const githubCredentialChangeHooks = new Set<TeamGitHubCredentialChangeHook>();
  const MAX_NOTIFIED_QUEUED_RUN_KEYS = 2_000;
  const notifiedQueuedRunKeys = new Set<string>();
  const rememberNotifiedQueuedKey = (key: string) => {
    notifiedQueuedRunKeys.delete(key);
    notifiedQueuedRunKeys.add(key);
    while (notifiedQueuedRunKeys.size > MAX_NOTIFIED_QUEUED_RUN_KEYS) {
      const oldest = notifiedQueuedRunKeys.values().next().value;
      if (oldest === undefined) break;
      notifiedQueuedRunKeys.delete(oldest);
    }
  };
  const noteStateLock = yield* Semaphore.make(1);
  const notifyQueuedMessageLock = yield* Semaphore.make(1);
  const MAX_REMOTE_PAIRING_PERMITS = 1024;
  // Shared (1 permit) for remote pairing issuance, exclusive (all permits) for ACL/member/detach
  // revocations so in-flight pairing calls finish before revokeSubject/unlink run.
  const remotePairingGate = yield* Semaphore.make(MAX_REMOTE_PAIRING_PERMITS);
  const withRemotePairingPermit = remotePairingGate.withPermits(1);
  const withRemoteRevocationBarrier = remotePairingGate.withPermits(MAX_REMOTE_PAIRING_PERMITS);
  const remoteEnvLifecycleLock = yield* Semaphore.make(1);
  // Serializes member role/status/pairing-link revocations against pairing redemption so
  // beforeIssueSession -> sessions.issue -> afterIssueSession is atomic with suspension/demotion.
  const membershipMutationGate = yield* Semaphore.make(1);
  const withMembershipMutationGate = membershipMutationGate.withPermits(1);
  const NOTE_RESERVATION_TTL_MS = 60_000;
  const activeNoteReservations = new Map<
    TeamThreadNoteId,
    {
      readonly reservationToken: string;
      readonly threadId: ThreadId;
      readonly memberId: TeamMemberId;
      readonly contentHash: string;
      readonly expiresAtMs: number;
    }
  >();

  const pruneExpiredNoteReservations = (nowMs: number) => {
    for (const [noteId, reservation] of activeNoteReservations) {
      if (reservation.expiresAtMs <= nowMs) {
        activeNoteReservations.delete(noteId);
      }
    }
  };

  const revokePairingLinksForMember = Effect.fn("TeamService.revokePairingLinksForMember")(
    function* (memberId: TeamMemberId) {
      const revokedAt = DateTime.formatIso(yield* DateTime.now);
      const pairingLinkIds = yield* repository
        .listPairingLinkIdsForMember(memberId)
        .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
      // Tombstone metadata first so an in-flight redemption still sees revoked_at != null and fails closed.
      yield* repository
        .markAllPairingLinkMetaRevokedForMember({ memberId, revokedAt })
        .pipe(Effect.ignore);
      for (const pairingLinkId of pairingLinkIds) {
        if (Option.isSome(pairingGrantStoreOption)) {
          yield* pairingGrantStoreOption.value.revoke(pairingLinkId).pipe(Effect.ignore);
        } else if (Option.isSome(environmentAuthOption)) {
          yield* environmentAuthOption.value.revokePairingLink(pairingLinkId).pipe(Effect.ignore);
        }
      }
    },
  );

  const getThreadTitlePrefixContextMap = Effect.fn("TeamService.getThreadTitlePrefixContextMap")(
    function* (
      threadIds: ReadonlyArray<ThreadId>,
    ): Effect.fn.Return<ReadonlyMap<ThreadId, TeamThreadTitlePrefixContext>> {
      const result = new Map<ThreadId, TeamThreadTitlePrefixContext>();
      if (threadIds.length === 0) return result;
      const workspaceOption = yield* repository
        .getWorkspace()
        .pipe(Effect.orElseSucceed(() => Option.none<TeamWorkspace>()));
      if (Option.isNone(workspaceOption)) return result;
      const team = workspaceOption.value;
      const uniqueIds = [...new Set(threadIds)];
      // Single-thread fast path avoids full-table scans on live WS events and push notifications.
      if (uniqueIds.length === 1) {
        const threadId = uniqueIds[0]!;
        const attributionOption = yield* repository
          .getThreadAttribution(threadId)
          .pipe(Effect.orElseSucceed(() => Option.none<TeamThreadAttribution>()));
        if (Option.isSome(attributionOption)) {
          const attribution = attributionOption.value;
          result.set(threadId, {
            ownerKind:
              attribution.ownerKind ?? (attribution.creatorMemberId === null ? "team" : "member"),
            creatorPseudo: attribution.creatorPseudo,
            teamDisplayName: team.displayName,
          });
        }
        return result;
      }
      const attributions = yield* repository
        .listThreadAttributions(team.id)
        .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<TeamThreadAttribution>));
      const attributionByThreadId = new Map<ThreadId, TeamThreadAttribution>(
        attributions.map((entry) => [entry.threadId, entry] as const),
      );
      for (const threadId of uniqueIds) {
        const attribution = attributionByThreadId.get(threadId);
        if (!attribution) continue;
        result.set(threadId, {
          ownerKind:
            attribution.ownerKind ?? (attribution.creatorMemberId === null ? "team" : "member"),
          creatorPseudo: attribution.creatorPseudo,
          teamDisplayName: team.displayName,
        });
      }
      return result;
    },
  );

  const formatUpstreamCompatThreadTitle = Effect.fn("TeamService.formatUpstreamCompatThreadTitle")(
    function* (threadId: ThreadId, rawTitle: string) {
      const prefixByThreadId = yield* getThreadTitlePrefixContextMap([threadId]);
      return formatUpstreamCompatThreadTitlePure(rawTitle, prefixByThreadId.get(threadId));
    },
  );

  const remoteSubjectForMember = (teamId: TeamId, memberId: TeamMemberId): string =>
    `${PeerClientPairing.TEAM_MEMBER_REMOTE_SUBJECT_PREFIX}${teamId}:${memberId}:`;

  const remoteSubjectPrefixForTeam = (teamId: TeamId): string =>
    `${PeerClientPairing.TEAM_MEMBER_REMOTE_SUBJECT_PREFIX}${teamId}:`;

  const drainPendingRemoteRevocations = Effect.fn("TeamService.drainPendingRemoteRevocations")(
    function* (input: {
      readonly environmentId?: EnvironmentId;
      readonly peerClientPairing?: PeerClientPairing.PeerClientPairing["Service"];
      readonly peerLinks?: PeerLinks.PeerLinks["Service"];
    }) {
      if (!input.peerClientPairing) return;
      // Drain across both active and deleted team workspaces so offline peers still
      // have their team-member grants revoked even after team.delete returns to personal mode.
      const pending = yield* repository
        .listPendingRemoteRevocations()
        .pipe(Effect.orElseSucceed(() => []));
      for (const item of pending) {
        if (input.environmentId !== undefined && item.environmentId !== input.environmentId) {
          continue;
        }
        if (item.unlinkAfterRevoke && !input.peerLinks) {
          continue;
        }
        yield* withRemoteRevocationBarrier(
          Effect.gen(function* () {
            const result = yield* input.peerClientPairing!.revokeSubject(
              item.environmentId,
              item.subjectPrefix,
            );
            if (result.ok || result.reason === "unknown_link") {
              // Serialize unlink decisions with attachEnvironment so a concurrent re-attach during
              // remote revocation never loses its newly attached peer link.
              yield* remoteEnvLifecycleLock.withPermits(1)(
                Effect.gen(function* () {
                  const currentRows = yield* repository
                    .listPendingRemoteRevocations(item.teamId)
                    .pipe(Effect.orElseSucceed(() => []));
                  const currentItem = currentRows.find((candidate) => candidate.id === item.id);
                  if (!currentItem) return;
                  const attachedEnv = yield* repository
                    .getEnvironmentByEnvironmentId({
                      teamId: item.teamId,
                      environmentId: item.environmentId,
                    })
                    .pipe(Effect.orElseSucceed(() => Option.none<TeamEnvironment>()));
                  if (
                    currentItem.unlinkAfterRevoke &&
                    Option.isNone(attachedEnv) &&
                    result.ok &&
                    input.peerLinks
                  ) {
                    const unlinked = yield* input.peerLinks.unlink(item.environmentId).pipe(
                      Effect.as(true),
                      Effect.orElseSucceed(() => false),
                    );
                    if (!unlinked) return;
                  }
                  yield* repository.deletePendingRemoteRevocation(item.id).pipe(Effect.ignore);
                }),
              );
            }
          }),
        );
      }
    },
  );

  const revokeRemoteMemberGrantsForEnvironments = Effect.fn(
    "TeamService.revokeRemoteMemberGrantsForEnvironments",
  )(function* (input: {
    readonly teamId: TeamId;
    readonly peerClientPairing: PeerClientPairing.PeerClientPairing["Service"] | undefined;
    readonly environmentIds: ReadonlyArray<EnvironmentId>;
    readonly subjectPrefixes: ReadonlyArray<string>;
    readonly unlinkAfterRevoke?: boolean;
  }) {
    const {
      teamId,
      peerClientPairing,
      environmentIds,
      subjectPrefixes,
      unlinkAfterRevoke = false,
    } = input;
    if (!peerClientPairing || environmentIds.length === 0 || subjectPrefixes.length === 0) {
      return { allSucceeded: true, enqueueFailed: false };
    }
    let allSucceeded = true;
    let enqueueFailed = false;
    const nowIso = DateTime.formatIso(yield* DateTime.now);
    const uniqueEnvIds = Array.from(new Set(environmentIds));
    for (const environmentId of uniqueEnvIds) {
      for (const subjectPrefix of subjectPrefixes) {
        const result = yield* peerClientPairing.revokeSubject(environmentId, subjectPrefix);
        if (!result.ok && result.reason !== "unknown_link") {
          allSucceeded = false;
          const pendingId = yield* random
            .uuidV4()
            .pipe(Effect.orElseSucceed(() => `${environmentId}:${subjectPrefix}`));
          yield* remoteEnvLifecycleLock.withPermits(1)(
            Effect.gen(function* () {
              const attachedEnv = unlinkAfterRevoke
                ? yield* repository
                    .getEnvironmentByEnvironmentId({ teamId, environmentId })
                    .pipe(Effect.orElseSucceed(() => Option.none<TeamEnvironment>()))
                : Option.none<TeamEnvironment>();
              const enqueued = yield* repository
                .enqueuePendingRemoteRevocation({
                  id: pendingId,
                  teamId,
                  environmentId,
                  subjectPrefix,
                  unlinkAfterRevoke: unlinkAfterRevoke && Option.isNone(attachedEnv),
                  createdAt: nowIso,
                })
                .pipe(
                  Effect.as(true),
                  Effect.catch((cause) =>
                    Effect.logWarning(
                      "TeamService.revokeRemoteMemberGrantsForEnvironments failed to persist pending revocation",
                      { teamId, environmentId, subjectPrefix, cause },
                    ).pipe(Effect.as(false)),
                  ),
                );
              if (!enqueued) {
                enqueueFailed = true;
              }
            }),
          );
        }
      }
    }
    return { allSucceeded, enqueueFailed };
  });

  const resolveLocalEnvironmentIdentity = Effect.fn("TeamService.resolveLocalEnvironmentIdentity")(
    function* () {
      if (Option.isSome(serverEnvironmentOption)) {
        const descriptor = yield* serverEnvironmentOption.value.getDescriptor;
        return {
          environmentId: descriptor.environmentId,
          name: descriptor.label.trim().length > 0 ? descriptor.label : "Default Team Environment",
        };
      }
      return {
        environmentId: EnvironmentId.make("default-team-environment"),
        name: "Default Team Environment",
      };
    },
  );

  const ensureDefaultEnvironmentForTeam = Effect.fn("TeamService.ensureDefaultEnvironmentForTeam")(
    function* (team: TeamWorkspace) {
      const local = yield* resolveLocalEnvironmentIdentity();
      const recordId = TeamEnvironmentRecordId.make(
        yield* random.uuidV4().pipe(Effect.mapError(toInternalError)),
      );
      return yield* repository
        .ensureDefaultEnvironment({
          id: recordId,
          teamId: team.id,
          environmentId: local.environmentId,
          name: local.name,
          createdAt: team.createdAt,
        })
        .pipe(Effect.mapError(toInternalError));
    },
  );

  const publishAccessChange = (event: TeamAccessChangeEvent) =>
    PubSub.publish(accessChangesPubSub, event).pipe(Effect.asVoid);

  const publish = (event: TeamStateStreamEvent) =>
    PubSub.publish(eventsPubSub, event).pipe(
      Effect.andThen(
        event.type === "threadFollowChanged" ||
          event.type === "threadAttributed" ||
          event.type === "turnAttributed"
          ? PubSub.publish(notificationTriggersPubSub, {
              type: "thread" as const,
              threadId: event.payload.threadId,
            })
          : Effect.void,
      ),
      Effect.asVoid,
    );

  const isTeamConfigured = Effect.fn("TeamService.isTeamConfigured")(function* () {
    const workspace = yield* repository.getWorkspace().pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("TeamService.isTeamConfigured lookup failed; failing closed", { cause }),
      ),
      Effect.match({
        onFailure: () => true,
        onSuccess: (option) => Option.isSome(option),
      }),
    );
    return workspace;
  });

  const openAccessChangeSubscription = () =>
    PubSub.subscribe(accessChangesPubSub).pipe(
      Effect.map((subscription) => Stream.fromSubscription(subscription)),
    );

  const subscribeAccessChanges = () => Stream.unwrap(openAccessChangeSubscription());

  const validatePseudo = Effect.fn("TeamService.validatePseudo")(function* (raw: string) {
    const normalized = normalizeTeamPseudo(raw);
    if (!isValidTeamPseudo(normalized)) {
      return yield* new TeamOperationError({
        code: "invalid_pseudo",
        message:
          "Pseudo must be 2–32 characters using letters, numbers, dots, underscores, or hyphens.",
      });
    }
    return normalized as TeamPseudo;
  });

  const requireWorkspace = Effect.fn("TeamService.requireWorkspace")(function* () {
    const workspace = yield* repository.getWorkspace().pipe(Effect.mapError(toInternalError));
    if (Option.isNone(workspace)) {
      return yield* new TeamOperationError({
        code: "not_configured",
        message: "No team is configured on this server.",
      });
    }
    return workspace.value;
  });

  const requireActiveMember = Effect.fn("TeamService.requireActiveMember")(function* (
    sessionId: AuthSessionId,
  ) {
    const member = yield* repository
      .getMemberForSession(sessionId)
      .pipe(Effect.mapError(toInternalError));
    if (Option.isNone(member) || member.value.status !== "active") {
      return yield* new TeamOperationError({
        code: "forbidden",
        message: "This session is not bound to an active team member.",
      });
    }
    return member.value;
  });

  const validateInviteRecord = Effect.fn("TeamService.validateInviteRecord")(function* (
    invite: TeamRepository.StoredTeamInviteRecord,
  ) {
    if (invite.revokedAt !== null) {
      return yield* new TeamOperationError({
        code: "invite_revoked",
        message: "This team invite has been revoked.",
      });
    }
    const now = yield* DateTime.now;
    const expiresAtMs = Date.parse(invite.expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now.epochMilliseconds) {
      return yield* new TeamOperationError({
        code: "invite_expired",
        message: "This team invite has expired.",
      });
    }
    if (invite.uses >= invite.maxUses) {
      return yield* new TeamOperationError({
        code: "invite_exhausted",
        message: "This team invite has already reached its maximum uses.",
      });
    }
    return invite;
  });

  const getState = Effect.fn("TeamService.getState")(function* (sessionId: AuthSessionId) {
    const workspaceOption = yield* repository.getWorkspace().pipe(Effect.mapError(toInternalError));
    if (Option.isNone(workspaceOption)) {
      return {
        team: null,
        currentMember: null,
        members: [],
        invites: [],
        views: [],
        threadAttributions: [],
        followedThreadIds: [],
        latestTurnAttributions: [],
        teamProjects: [],
        environments: [],
        threadNotes: [],
        providers: [],
        skills: [],
        preprompts: [],
        assetsRevision: NonNegativeInt.make(0),
        myGitHubIdentity: null,
        automationGitHubIdentity: null,
        githubAppConfig: null,
        scheduledTaskMetas: [],
      } satisfies TeamStateSnapshot;
    }
    const team = workspaceOption.value;
    const [
      currentMemberOption,
      members,
      allViews,
      allThreadAttributions,
      allLatestTurnAttributions,
      teamProjects,
      rawEnvironments,
      allThreadNotes,
      allScheduledTaskMetas,
    ] = yield* Effect.all([
      repository.getMemberForSession(sessionId).pipe(Effect.mapError(toInternalError)),
      repository.listMembers(team.id).pipe(Effect.mapError(toInternalError)),
      repository.listViews(team.id).pipe(Effect.mapError(toInternalError)),
      repository.listThreadAttributions(team.id).pipe(Effect.mapError(toInternalError)),
      repository.listLatestTurnAttributions(team.id).pipe(Effect.mapError(toInternalError)),
      repository.listProjectAssignments(team.id).pipe(Effect.mapError(toInternalError)),
      repository.listEnvironments(team.id).pipe(Effect.mapError(toInternalError)),
      repository.listThreadNotes({ teamId: team.id }).pipe(Effect.mapError(toInternalError)),
      repository.listScheduledTaskMetas(team.id).pipe(Effect.mapError(toInternalError)),
    ]);
    const allEnvironments =
      rawEnvironments.length > 0 ? rawEnvironments : [yield* ensureDefaultEnvironmentForTeam(team)];
    const currentMember = Option.getOrNull(currentMemberOption);
    const viewById = new Map(allViews.map((view) => [view.id, view] as const));
    const defaultView = viewById.get(team.defaultViewId) ?? null;
    const envById = new Map(allEnvironments.map((env) => [env.environmentId, env] as const));

    const visibleViews = allViews.filter((view) => canMemberReadTeamView(currentMember, view));
    const readableThreadIds = new Set<ThreadId>();
    const threadAttributions = allThreadAttributions.filter((attribution) => {
      const view = viewById.get(attribution.viewId) ?? defaultView;
      const readable = canMemberReadTeamThread({ member: currentMember, view });
      if (readable) {
        readableThreadIds.add(attribution.threadId);
      }
      return readable;
    });
    const latestTurnAttributions = allLatestTurnAttributions.filter((turn) =>
      readableThreadIds.has(turn.threadId),
    );
    const visibleEnvironments =
      currentMember !== null &&
      currentMember.status === "active" &&
      canManageTeamEnvironments(currentMember.role)
        ? allEnvironments
        : allEnvironments.filter((env) => canMemberAccessTeamEnvironment(currentMember, env));
    const visibleThreadNotes = allThreadNotes.filter((note) =>
      readableThreadIds.has(note.threadId),
    );
    const visibleScheduledTaskMetas = allScheduledTaskMetas.filter((meta) =>
      canMemberReadTeamScheduledTask({
        member: currentMember,
        environment: envById.get(meta.environmentId) ?? null,
        view: viewById.get(meta.viewId) ?? defaultView,
      }),
    );

    const [
      invites,
      rawFollowedThreadIds,
      providers,
      skills,
      preprompts,
      assetsRevision,
      myGitHubIdentity,
      automationGitHubIdentity,
      githubAppConfig,
    ] = yield* Effect.all([
      currentMember !== null &&
      currentMember.status === "active" &&
      canManageTeamInvites(currentMember.role)
        ? repository.listInvites(team.id).pipe(Effect.mapError(toInternalError))
        : Effect.succeed<ReadonlyArray<TeamInvite>>([]),
      currentMember !== null && currentMember.status === "active"
        ? repository.listFollowedThreadIds(currentMember.id).pipe(Effect.mapError(toInternalError))
        : Effect.succeed<ReadonlyArray<ThreadId>>([]),
      currentMember !== null &&
      currentMember.status === "active" &&
      Option.isSome(assetsRepositoryOption)
        ? assetsRepositoryOption.value.listProviders(team.id).pipe(
            Effect.map((rows) => rows.map(TeamAssetsRepository.stripProviderSecretKey)),
            Effect.mapError(toInternalError),
          )
        : Effect.succeed<ReadonlyArray<TeamProvider>>([]),
      currentMember !== null &&
      currentMember.status === "active" &&
      Option.isSome(assetsRepositoryOption)
        ? assetsRepositoryOption.value.listSkills(team.id).pipe(Effect.mapError(toInternalError))
        : Effect.succeed<ReadonlyArray<TeamSkill>>([]),
      currentMember !== null &&
      currentMember.status === "active" &&
      Option.isSome(assetsRepositoryOption)
        ? assetsRepositoryOption.value
            .listPreprompts(team.id)
            .pipe(Effect.mapError(toInternalError))
        : Effect.succeed<ReadonlyArray<TeamPreprompt>>([]),
      currentMember !== null &&
      currentMember.status === "active" &&
      Option.isSome(assetsRepositoryOption)
        ? assetsRepositoryOption.value
            .getAssetsRevision(team.id)
            .pipe(Effect.mapError(toInternalError))
        : Effect.succeed(0),
      // Strictly scoped to `currentMember` so GitHub identity metadata is never exposed to other members.
      currentMember !== null &&
      currentMember.status === "active" &&
      Option.isSome(githubRepositoryOption)
        ? githubRepositoryOption.value.getMemberCredential(currentMember.id).pipe(
            Effect.map((opt) =>
              Option.isSome(opt) && opt.value.teamId === team.id
                ? TeamGitHubRepository.stripMemberGitHubSecretKey(opt.value)
                : null,
            ),
            Effect.mapError(toInternalError),
          )
        : Effect.succeed<TeamGitHubIdentity | null>(null),
      currentMember !== null &&
      currentMember.status === "active" &&
      canManageTeamAutomationGitHub(currentMember.role) &&
      Option.isSome(githubRepositoryOption)
        ? githubRepositoryOption.value.getAutomationCredential(team.id).pipe(
            Effect.map((opt) =>
              Option.isSome(opt)
                ? TeamGitHubRepository.stripAutomationGitHubSecretKey(opt.value)
                : null,
            ),
            Effect.mapError(toInternalError),
          )
        : Effect.succeed<TeamAutomationGitHubIdentity | null>(null),
      currentMember !== null &&
      currentMember.status === "active" &&
      Option.isSome(githubRepositoryOption)
        ? githubRepositoryOption.value.getGitHubAppConfig(team.id).pipe(
            Effect.map((opt) => {
              if (Option.isNone(opt)) return null;
              const isAdmin = canManageTeamGitHubAppConfig(currentMember.role);
              if (!isAdmin && !opt.value.enabled) return null;
              return TeamGitHubRepository.stripGitHubAppClientSecretKey(opt.value, {
                includeUpdatedBy: isAdmin,
              });
            }),
            Effect.mapError(toInternalError),
          )
        : Effect.succeed<TeamGitHubAppConfig | null>(null),
    ]);
    const attributedThreadIds = new Set(allThreadAttributions.map((item) => item.threadId));
    const followedThreadIds = rawFollowedThreadIds.filter(
      (threadId) => !attributedThreadIds.has(threadId) || readableThreadIds.has(threadId),
    );

    return {
      team,
      currentMember,
      members,
      invites,
      views: visibleViews,
      threadAttributions,
      followedThreadIds,
      latestTurnAttributions,
      teamProjects,
      environments: visibleEnvironments,
      threadNotes: visibleThreadNotes,
      providers,
      skills,
      preprompts,
      assetsRevision: NonNegativeInt.make(Math.max(0, assetsRevision)),
      myGitHubIdentity,
      automationGitHubIdentity,
      githubAppConfig,
      scheduledTaskMetas: visibleScheduledTaskMetas,
    } satisfies TeamStateSnapshot;
  });

  const streamState = (sessionId: AuthSessionId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe before reading the snapshot so live events during bootstrap are never missed.
        const subscription = yield* PubSub.subscribe(eventsPubSub);
        const snapshot = yield* getState(sessionId);
        let currentMember = snapshot.currentMember;
        let knownReadableThreadIds = new Set<ThreadId>(
          snapshot.threadAttributions.map((attribution) => attribution.threadId),
        );
        let knownReadableScheduledTaskIds = new Set<ScheduledTaskId>(
          (snapshot.scheduledTaskMetas ?? []).map((meta) => meta.taskId),
        );
        const liveEvents = Stream.fromSubscription(subscription).pipe(
          Stream.mapEffect((event) =>
            Effect.gen(function* () {
              if (event.type === "teamDeleted") {
                currentMember = null;
                knownReadableThreadIds.clear();
                knownReadableScheduledTaskIds.clear();
                return Option.some<TeamStateStreamEvent>(event);
              }
              if (
                event.type === "teamUpdated" ||
                event.type === "viewUpserted" ||
                event.type === "viewDeleted" ||
                event.type === "environmentUpserted" ||
                event.type === "environmentRemoved"
              ) {
                if (
                  event.type !== "teamUpdated" &&
                  currentMember !== null &&
                  currentMember.status !== "active"
                ) {
                  return Option.none<TeamStateStreamEvent>();
                }
                const fresh = yield* getState(sessionId);
                currentMember = fresh.currentMember;
                knownReadableThreadIds = new Set<ThreadId>(
                  fresh.threadAttributions.map((attribution) => attribution.threadId),
                );
                knownReadableScheduledTaskIds = new Set<ScheduledTaskId>(
                  (fresh.scheduledTaskMetas ?? []).map((meta) => meta.taskId),
                );
                return Option.some<TeamStateStreamEvent>({
                  version: 1 as const,
                  type: "snapshot" as const,
                  payload: fresh,
                });
              }
              if (event.type === "memberUpserted") {
                if (currentMember?.id === event.payload.id) {
                  const accessChanged =
                    currentMember.role !== event.payload.role ||
                    currentMember.status !== event.payload.status;
                  currentMember = event.payload;
                  if (accessChanged) {
                    const fresh = yield* getState(sessionId);
                    currentMember = fresh.currentMember;
                    knownReadableThreadIds = new Set<ThreadId>(
                      fresh.threadAttributions.map((attribution) => attribution.threadId),
                    );
                    knownReadableScheduledTaskIds = new Set<ScheduledTaskId>(
                      (fresh.scheduledTaskMetas ?? []).map((meta) => meta.taskId),
                    );
                    return Option.some<TeamStateStreamEvent>({
                      version: 1 as const,
                      type: "snapshot" as const,
                      payload: fresh,
                    });
                  }
                }
                return Option.some<TeamStateStreamEvent>(event);
              }
              if (event.type === "inviteUpserted") {
                // Only active modo+ sessions observe invite metadata.
                return currentMember !== null &&
                  currentMember.status === "active" &&
                  canManageTeamInvites(currentMember.role)
                  ? Option.some<TeamStateStreamEvent>(event)
                  : Option.none<TeamStateStreamEvent>();
              }
              if (event.type === "threadFollowChanged") {
                // Keep each member's follow updates scoped to their own connected sessions.
                return currentMember !== null &&
                  currentMember.status === "active" &&
                  event.payload.memberId === currentMember.id
                  ? Option.some<TeamStateStreamEvent>(event)
                  : Option.none<TeamStateStreamEvent>();
              }
              if (event.type === "threadAttributed") {
                const readable = yield* canReadThread(sessionId, event.payload.threadId);
                if (readable) {
                  knownReadableThreadIds.add(event.payload.threadId);
                  return Option.some<TeamStateStreamEvent>(event);
                }
                // Only emit threadRemoved when revoking a thread this subscriber already knew about.
                if (knownReadableThreadIds.delete(event.payload.threadId)) {
                  return Option.some<TeamStateStreamEvent>({
                    version: 1 as const,
                    type: "threadRemoved" as const,
                    payload: { threadId: event.payload.threadId },
                  });
                }
                return Option.none<TeamStateStreamEvent>();
              }
              if (event.type === "turnAttributed") {
                const readable = yield* canReadThread(sessionId, event.payload.threadId);
                return readable
                  ? Option.some<TeamStateStreamEvent>(event)
                  : Option.none<TeamStateStreamEvent>();
              }
              if (event.type === "threadNoteUpserted" || event.type === "threadNoteDeleted") {
                const readable = yield* canReadThread(sessionId, event.payload.threadId);
                return readable
                  ? Option.some<TeamStateStreamEvent>(event)
                  : Option.none<TeamStateStreamEvent>();
              }
              if (event.type === "queuedMessageNotification") {
                if (
                  currentMember === null ||
                  currentMember.status !== "active" ||
                  !event.payload.recipientMemberIds.includes(currentMember.id)
                ) {
                  return Option.none<TeamStateStreamEvent>();
                }
                const readable = yield* canReadThread(sessionId, event.payload.threadId);
                return readable
                  ? Option.some<TeamStateStreamEvent>(event)
                  : Option.none<TeamStateStreamEvent>();
              }
              if (event.type === "myGitHubIdentityUpdated") {
                return currentMember !== null &&
                  currentMember.status === "active" &&
                  event.payload.memberId === currentMember.id
                  ? Option.some<TeamStateStreamEvent>(event)
                  : Option.none<TeamStateStreamEvent>();
              }
              if (event.type === "automationGitHubIdentityUpdated") {
                return currentMember !== null &&
                  currentMember.status === "active" &&
                  canManageTeamAutomationGitHub(currentMember.role)
                  ? Option.some<TeamStateStreamEvent>(event)
                  : Option.none<TeamStateStreamEvent>();
              }
              if (event.type === "githubAppConfigUpdated") {
                if (currentMember === null || currentMember.status !== "active") {
                  return Option.none<TeamStateStreamEvent>();
                }
                if (canManageTeamGitHubAppConfig(currentMember.role)) {
                  return Option.some<TeamStateStreamEvent>(event);
                }
                const config = event.payload.config;
                if (config === null || !config.enabled) {
                  return Option.some<TeamStateStreamEvent>({
                    version: 1,
                    type: "githubAppConfigUpdated",
                    payload: { config: null },
                  });
                }
                const { updatedByMemberId: _omit, ...publicConfig } = config;
                return Option.some<TeamStateStreamEvent>({
                  version: 1,
                  type: "githubAppConfigUpdated",
                  payload: { config: publicConfig },
                });
              }
              if (event.type === "scheduledTaskMetaUpserted") {
                const readable = yield* assertCanReadScheduledTask(
                  sessionId,
                  event.payload.taskId,
                ).pipe(
                  Effect.as(true),
                  Effect.orElseSucceed(() => false),
                );
                if (readable) {
                  knownReadableScheduledTaskIds.add(event.payload.taskId);
                  return Option.some<TeamStateStreamEvent>(event);
                }
                if (knownReadableScheduledTaskIds.delete(event.payload.taskId)) {
                  return Option.some<TeamStateStreamEvent>({
                    version: 1 as const,
                    type: "scheduledTaskMetaDeleted" as const,
                    payload: { taskId: event.payload.taskId },
                  });
                }
                return Option.none<TeamStateStreamEvent>();
              }
              if (event.type === "scheduledTaskMetaDeleted") {
                if (knownReadableScheduledTaskIds.delete(event.payload.taskId)) {
                  return Option.some<TeamStateStreamEvent>(event);
                }
                return Option.none<TeamStateStreamEvent>();
              }
              if (
                event.type === "providerUpserted" ||
                event.type === "providerDeleted" ||
                event.type === "skillUpserted" ||
                event.type === "skillDeleted" ||
                event.type === "prepromptUpserted" ||
                event.type === "prepromptDeleted" ||
                event.type === "assetsUpdated"
              ) {
                return currentMember !== null && currentMember.status === "active"
                  ? Option.some<TeamStateStreamEvent>(event)
                  : Option.none<TeamStateStreamEvent>();
              }
              return Option.some<TeamStateStreamEvent>(event);
            }),
          ),
          Stream.filter(Option.isSome),
          Stream.map((maybeEvent) => maybeEvent.value),
        );
        return Stream.concat(
          rpcInitialItems([
            {
              version: 1 as const,
              type: "snapshot" as const,
              payload: snapshot,
            },
          ]),
          liveEvents,
        );
      }),
    );

  const initializeTeam = Effect.fn("TeamService.initializeTeam")(function* (input: {
    readonly sessionId: AuthSessionId;
    readonly payload: TeamInitializeInput;
  }) {
    const existing = yield* repository.getWorkspace().pipe(Effect.mapError(toInternalError));
    if (Option.isSome(existing)) {
      return yield* new TeamOperationError({
        code: "already_configured",
        message: "A team is already configured on this server.",
      });
    }
    const ownerPseudo = yield* validatePseudo(input.payload.ownerPseudo);
    const nowIso = DateTime.formatIso(yield* DateTime.now);
    const teamId = TeamId.make(yield* random.uuidV4().pipe(Effect.mapError(toInternalError)));
    const defaultViewId = TeamViewId.make(
      `view_${yield* random.uuidV4().pipe(Effect.mapError(toInternalError))}`,
    );
    const ownerId = TeamMemberId.make(
      yield* random.uuidV4().pipe(Effect.mapError(toInternalError)),
    );

    const trimmedName = input.payload.name.trim();
    const displayName = resolveTeamDisplayName(trimmedName, input.payload.displayName);
    const team: TeamWorkspace = {
      id: teamId,
      name: trimmedName,
      displayName,
      defaultViewId,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    const owner: TeamMember = {
      id: ownerId,
      teamId,
      pseudo: ownerPseudo,
      role: "owner",
      status: "active",
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    const defaultEnvironment = yield* withMembershipMutationGate(
      withRemoteRevocationBarrier(
        Effect.gen(function* () {
          yield* repository
            .initializeWorkspace({
              team,
              owner,
              ownerSessionId: input.sessionId,
            })
            .pipe(
              Effect.catchTags({
                TeamAlreadyConfiguredError: (error) =>
                  Effect.fail(
                    new TeamOperationError({
                      code: "already_configured",
                      message: error.message,
                    }),
                  ),
                TeamPseudoAlreadyTakenError: (error) =>
                  Effect.fail(
                    new TeamOperationError({
                      code: "pseudo_taken",
                      message: error.message,
                    }),
                  ),
                TeamRepositoryError: (error) =>
                  Effect.logWarning("TeamService.initializeTeam failed", { cause: error }).pipe(
                    Effect.andThen(Effect.fail(toInternalError(error))),
                  ),
              }),
            );
          return yield* ensureDefaultEnvironmentForTeam(team);
        }),
      ),
    );

    yield* publish({ version: 1, type: "teamUpdated", payload: team });
    yield* publish({ version: 1, type: "memberUpserted", payload: owner });
    yield* publish({ version: 1, type: "environmentUpserted", payload: defaultEnvironment });
    yield* publishAccessChange({ type: "workspace" });

    return { team, owner } satisfies TeamInitializeResult;
  });

  const updateDisplayName = Effect.fn("TeamService.updateDisplayName")(function* (input: {
    readonly sessionId: AuthSessionId;
    readonly payload: TeamUpdateDisplayNameInput;
  }) {
    const team = yield* requireWorkspace();
    const actor = yield* requireActiveMember(input.sessionId);
    if (actor.teamId !== team.id || !canManageTeamDisplayName(actor.role)) {
      return yield* new TeamOperationError({
        code: "forbidden",
        message: "Only owner and admin members can edit the team display name.",
      });
    }
    const nextDisplayName = input.payload.displayName.trim();
    if (nextDisplayName.length === 0) {
      return yield* new TeamOperationError({
        code: "invalid_input",
        message: "Team display name cannot be empty.",
      });
    }
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    const updated = yield* repository
      .updateWorkspaceDisplayName({
        teamId: team.id,
        displayName: nextDisplayName,
        updatedAt,
      })
      .pipe(Effect.mapError(toInternalError));
    if (Option.isNone(updated)) {
      return yield* new TeamOperationError({
        code: "not_found",
        message: "Team workspace could not be found.",
      });
    }
    yield* publish({ version: 1, type: "teamUpdated", payload: updated.value });
    yield* publishAccessChange({ type: "workspace" });
    return updated.value;
  });

  const revokeSessionsForMember = Effect.fn("TeamService.revokeSessionsForMember")(function* (
    memberId: TeamMemberId,
  ) {
    const sessionIds = yield* repository.listSessionIdsForMember(memberId).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("TeamService.revokeSessionsForMember list failed", {
          memberId,
          cause,
        }),
      ),
      Effect.orElseSucceed(() => [] as ReadonlyArray<AuthSessionId>),
    );
    const proofKeys = new Set<string>();
    yield* Effect.forEach(
      sessionIds,
      (memberSessionId) =>
        Effect.gen(function* () {
          const maybeJkt = yield* sessionStore
            .proofKeyThumbprintOf(memberSessionId)
            .pipe(Effect.orElseSucceed(() => Option.none<string>()));
          if (Option.isSome(maybeJkt)) {
            proofKeys.add(maybeJkt.value);
          }
          yield* sessionStore.revoke(memberSessionId).pipe(Effect.ignore);
        }),
      { discard: true },
    );
    yield* Effect.forEach(
      [...proofKeys],
      (proofKeyThumbprint) => sessionStore.revokeByProofKey(proofKeyThumbprint).pipe(Effect.ignore),
      { discard: true },
    );
  });

  const reconcileMemberSessionScopes = Effect.fn("TeamService.reconcileMemberSessionScopes")(
    function* (memberId: TeamMemberId, nextRole: TeamRole) {
      const nextRoleScopes = scopesForTeamRole(nextRole);
      const sessionIds = yield* repository.listSessionIdsForMember(memberId).pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("TeamService.reconcileMemberSessionScopes list failed", {
            memberId,
            cause,
          }),
        ),
        Effect.orElseSucceed(() => [] as ReadonlyArray<AuthSessionId>),
      );
      yield* Effect.forEach(
        sessionIds,
        Effect.fnUntraced(function* (memberSessionId) {
          const ceilingExit = yield* Effect.exit(
            repository.getSessionScopeCeiling(memberSessionId),
          );
          if (Exit.isFailure(ceilingExit)) {
            yield* Effect.logWarning(
              "TeamService.reconcileMemberSessionScopes ceiling lookup failed; revoking session to fail closed",
              { memberId, memberSessionId, cause: ceilingExit.cause },
            );
            yield* sessionStore.revoke(memberSessionId).pipe(Effect.ignore);
            return;
          }
          const ceilingOption = ceilingExit.value;
          const targetScopes = Option.isSome(ceilingOption)
            ? nextRoleScopes.filter((scope) => ceilingOption.value.includes(scope))
            : nextRoleScopes;
          if (targetScopes.length === 0) {
            yield* sessionStore.revoke(memberSessionId).pipe(Effect.ignore);
            return;
          }
          yield* sessionStore.updateScopes(memberSessionId, targetScopes).pipe(
            Effect.tapError((cause) =>
              Effect.logWarning("TeamService.reconcileMemberSessionScopes update failed", {
                memberId,
                memberSessionId,
                cause,
              }),
            ),
            Effect.ignore,
          );
        }),
        { discard: true },
      );
    },
  );

  const validateAccessRuleMemberIds = Effect.fn("TeamService.validateAccessRuleMemberIds")(
    function* (teamId: TeamId, rules: ReadonlyArray<TeamAccessRule | undefined>) {
      const requestedIds = new Set<TeamMemberId>();
      for (const rule of rules) {
        if (!rule) continue;
        for (const memberId of rule.memberIds) {
          requestedIds.add(memberId);
        }
      }
      if (requestedIds.size === 0) return;
      const members = yield* repository.listMembers(teamId).pipe(Effect.mapError(toInternalError));
      const validIds = new Set(
        members.filter((member) => member.status !== "removed").map((member) => member.id),
      );
      for (const memberId of requestedIds) {
        if (!validIds.has(memberId)) {
          return yield* new TeamOperationError({
            code: "invalid_input",
            message: `Unknown team member ID "${memberId}" in view access rule.`,
          });
        }
      }
    },
  );

  const updateMemberRole = Effect.fn("TeamService.updateMemberRole")(function* (input: {
    readonly sessionId: AuthSessionId;
    readonly payload: TeamUpdateMemberRoleInput;
    readonly peerClientPairing?: PeerClientPairing.PeerClientPairing["Service"];
    readonly peerLinks?: PeerLinks.PeerLinks["Service"];
  }) {
    const team = yield* requireWorkspace();
    const actor = yield* requireActiveMember(input.sessionId);
    if (actor.teamId !== team.id) {
      return yield* new TeamOperationError({
        code: "forbidden",
        message: "This session does not belong to the active team.",
      });
    }
    if (!canManageTeamMembers(actor.role)) {
      return yield* new TeamOperationError({
        code: "forbidden",
        message: "Only modo, admin, and owner members can manage member roles.",
      });
    }
    const targetOption = yield* repository
      .getMemberById(input.payload.memberId)
      .pipe(Effect.mapError(toInternalError));
    if (Option.isNone(targetOption) || targetOption.value.teamId !== team.id) {
      return yield* new TeamOperationError({
        code: "not_found",
        message: "Team member could not be found.",
      });
    }
    const target = targetOption.value;
    if (target.status === "removed") {
      return yield* new TeamOperationError({
        code: "forbidden",
        message: "Cannot change the role of a removed member.",
      });
    }
    if (!canModifyTeamMember(actor.role, target.role)) {
      return yield* new TeamOperationError({
        code: "forbidden",
        message: `You cannot modify a member whose role "${target.role}" is higher than your own "${actor.role}".`,
      });
    }
    if (!canChangeTeamMemberRole(actor.role, target.role, input.payload.role)) {
      return yield* new TeamOperationError({
        code: "forbidden",
        message: `You cannot assign role "${input.payload.role}" above your own role "${actor.role}".`,
      });
    }
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    const { previousRole, member: updatedMember } = yield* withMembershipMutationGate(
      Effect.gen(function* () {
        const updated = yield* repository
          .updateMemberRole({
            teamId: team.id,
            actorMemberId: actor.id,
            memberId: target.id,
            role: input.payload.role,
            updatedAt,
          })
          .pipe(
            Effect.catchTags({
              TeamLastOwnerProtectedError: (error) =>
                Effect.fail(
                  new TeamOperationError({
                    code: "last_owner",
                    message: error.message,
                  }),
                ),
              TeamMemberForbiddenError: (error) =>
                Effect.fail(
                  new TeamOperationError({
                    code: "forbidden",
                    message: error.message,
                  }),
                ),
              TeamRepositoryError: (error) => Effect.fail(toInternalError(error)),
            }),
          );
        if (Option.isNone(updated)) {
          return yield* new TeamOperationError({
            code: "not_found",
            message: "Team member could not be found.",
          });
        }
        const prevIsAdminTier =
          updated.value.previousRole === "owner" || updated.value.previousRole === "admin";
        const nextIsAdminTier =
          updated.value.member.role === "owner" || updated.value.member.role === "admin";
        if (prevIsAdminTier !== nextIsAdminTier) {
          yield* reconcileMemberSessionScopes(updated.value.member.id, updated.value.member.role);
        }
        return updated.value;
      }),
    );
    const prevIsAdminTier = previousRole === "owner" || previousRole === "admin";
    const nextIsAdminTier = updatedMember.role === "owner" || updatedMember.role === "admin";
    const envs = yield* repository
      .listEnvironments(team.id)
      .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<TeamEnvironment>));
    const demotedFromAdminTier = prevIsAdminTier && !nextIsAdminTier;
    for (const env of envs) {
      if (demotedFromAdminTier || !canMemberAccessTeamEnvironment(updatedMember, env)) {
        yield* notifyGitHubCredentialChanged({
          kind: "environment",
          teamId: team.id,
          environmentId: env.environmentId,
          revokedMemberIds: [updatedMember.id],
        });
      }
    }
    if (input.peerClientPairing) {
      const registeredEnvIds = new Set(envs.map((env) => env.environmentId));
      // Demoting from owner/admin strips admin-only session scopes, so revoke remote grants on
      // ALL non-default environments (including still-accessible ones) to clear over-privileged sessions.
      const revokedEnvIds = envs
        .filter(
          (env) =>
            !env.isDefault &&
            (demotedFromAdminTier || !canMemberAccessTeamEnvironment(updatedMember, env)),
        )
        .map((env) => env.environmentId);
      // Demoting an admin/owner also revokes their sessions on unregistered peer links.
      if (input.peerLinks && !isTeamAdminOrOwner(updatedMember)) {
        const allPeers = yield* input.peerLinks.list.pipe(Effect.orElseSucceed(() => []));
        for (const peer of allPeers) {
          if (!registeredEnvIds.has(peer.environmentId)) {
            revokedEnvIds.push(peer.environmentId);
          }
        }
      }
      yield* withRemoteRevocationBarrier(
        revokeRemoteMemberGrantsForEnvironments({
          teamId: team.id,
          peerClientPairing: input.peerClientPairing,
          environmentIds: revokedEnvIds,
          subjectPrefixes: [remoteSubjectForMember(team.id, updatedMember.id)],
        }),
      );
    }
    yield* publish({ version: 1, type: "memberUpserted", payload: updatedMember });
    yield* publishAccessChange({ type: "member", memberId: updatedMember.id });
    return updatedMember;
  });

  const updateMemberStatus = Effect.fn("TeamService.updateMemberStatus")(function* (input: {
    readonly sessionId: AuthSessionId;
    readonly payload: TeamUpdateMemberStatusInput;
    readonly peerClientPairing?: PeerClientPairing.PeerClientPairing["Service"];
    readonly peerLinks?: PeerLinks.PeerLinks["Service"];
  }) {
    const team = yield* requireWorkspace();
    const actor = yield* requireActiveMember(input.sessionId);
    if (actor.teamId !== team.id) {
      return yield* new TeamOperationError({
        code: "forbidden",
        message: "This session does not belong to the active team.",
      });
    }
    if (!canManageTeamMembers(actor.role)) {
      return yield* new TeamOperationError({
        code: "forbidden",
        message: "Only modo, admin, and owner members can suspend or remove members.",
      });
    }
    const targetOption = yield* repository
      .getMemberById(input.payload.memberId)
      .pipe(Effect.mapError(toInternalError));
    if (Option.isNone(targetOption) || targetOption.value.teamId !== team.id) {
      return yield* new TeamOperationError({
        code: "not_found",
        message: "Team member could not be found.",
      });
    }
    const target = targetOption.value;
    if (!canModifyTeamMember(actor.role, target.role)) {
      return yield* new TeamOperationError({
        code: "forbidden",
        message: `You cannot modify a member whose role "${target.role}" is higher than your own "${actor.role}".`,
      });
    }
    if (target.status === "removed" && input.payload.status !== "removed") {
      return yield* new TeamOperationError({
        code: "forbidden",
        message: "Removed members cannot be reactivated; send a new invite instead.",
      });
    }
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    const updatedResult = yield* withMembershipMutationGate(
      Effect.gen(function* () {
        const updated = yield* repository
          .updateMemberStatus({
            teamId: team.id,
            actorMemberId: actor.id,
            memberId: target.id,
            status: input.payload.status,
            updatedAt,
          })
          .pipe(
            Effect.catchTags({
              TeamLastOwnerProtectedError: (error) =>
                Effect.fail(
                  new TeamOperationError({
                    code: "last_owner",
                    message: error.message,
                  }),
                ),
              TeamMemberForbiddenError: (error) =>
                Effect.fail(
                  new TeamOperationError({
                    code: "forbidden",
                    message: error.message,
                  }),
                ),
              TeamRepositoryError: (error) => Effect.fail(toInternalError(error)),
            }),
          );
        if (Option.isNone(updated)) {
          return yield* new TeamOperationError({
            code: "not_found",
            message: "Team member could not be found.",
          });
        }
        yield* publish({ version: 1, type: "memberUpserted", payload: updated.value.member });
        // Coalesce scrubbed view/environment ACL notifications into a single snapshot trigger so
        // each subscriber refreshes getState(sessionId) at most once regardless of ACL count.
        const firstUpdatedView = updated.value.updatedViews[0];
        const firstUpdatedEnv = updated.value.updatedEnvironments[0];
        if (firstUpdatedView !== undefined) {
          yield* publish({ version: 1, type: "viewUpserted", payload: firstUpdatedView });
        } else if (firstUpdatedEnv !== undefined) {
          yield* publish({ version: 1, type: "environmentUpserted", payload: firstUpdatedEnv });
        }
        yield* publishAccessChange({ type: "member", memberId: updated.value.member.id });
        if (updated.value.member.status !== "active") {
          yield* revokeSessionsForMember(updated.value.member.id);
          yield* revokePairingLinksForMember(updated.value.member.id);
        }
        return updated.value;
      }),
    );
    const updatedMember = updatedResult.member;
    if (updatedMember.status !== "active") {
      if (Option.isSome(assetsRepositoryOption)) {
        yield* assetsRepositoryOption.value
          .revokeLocalSyncTokensForMember(updatedMember.id, updatedAt)
          .pipe(Effect.ignore);
      }
      yield* TeamGitHubOAuth.withMemberGitHubCredentialMutationLock(
        team.id,
        updatedMember.id,
        Effect.gen(function* () {
          TeamGitHubOAuth.purgeMemberPendingGitHubOAuthFlows(
            githubOAuthFlowStore,
            updatedMember.id,
          );
          if (updatedMember.status === "removed" && Option.isSome(githubRepositoryOption)) {
            const removedSecretKeyOpt = yield* githubRepositoryOption.value
              .deleteMemberCredential(updatedMember.id)
              .pipe(Effect.orElseSucceed(() => Option.none<string>()));
            if (Option.isSome(removedSecretKeyOpt) && Option.isSome(secretStoreOption)) {
              yield* TeamGitHubRepository.removeTeamGitHubSecret(
                secretStoreOption.value,
                removedSecretKeyOpt.value,
              ).pipe(Effect.ignore);
            }
          }
          yield* notifyGitHubCredentialChanged({
            kind: "member",
            teamId: team.id,
            memberId: updatedMember.id,
          });
        }),
      );
      if (input.peerClientPairing) {
        const envs = yield* repository
          .listEnvironments(team.id)
          .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<TeamEnvironment>));
        const targetEnvIds = envs.filter((env) => !env.isDefault).map((env) => env.environmentId);
        if (input.peerLinks) {
          const allPeers = yield* input.peerLinks.list.pipe(Effect.orElseSucceed(() => []));
          for (const peer of allPeers) {
            targetEnvIds.push(peer.environmentId);
          }
        }
        yield* withRemoteRevocationBarrier(
          revokeRemoteMemberGrantsForEnvironments({
            teamId: team.id,
            peerClientPairing: input.peerClientPairing,
            environmentIds: targetEnvIds,
            subjectPrefixes: [remoteSubjectForMember(team.id, updatedMember.id)],
          }),
        );
      }
    }
    return updatedMember;
  });

  const leaveTeam = Effect.fn("TeamService.leaveTeam")(function* (input: {
    readonly sessionId: AuthSessionId;
    readonly deferCallerSessionRevocation?:
      | boolean
      | {
          readonly awaitDisconnect?: Effect.Effect<void>;
          readonly fallbackDelay?: Duration.Duration;
        };
    readonly peerClientPairing?: PeerClientPairing.PeerClientPairing["Service"];
    readonly peerLinks?: PeerLinks.PeerLinks["Service"];
  }) {
    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const updatedAt = DateTime.formatIso(yield* DateTime.now);
        const deferSpec = input.deferCallerSessionRevocation;
        const isDeferredRevocation =
          deferSpec === true || (deferSpec !== undefined && deferSpec !== false);
        const cleanupDone = yield* Deferred.make<void>();
        const { team, leftResult, otherSessionIds, revokeCallerSession, callerJkt } =
          yield* withMembershipMutationGate(
            Effect.gen(function* () {
              const activeTeam = yield* requireWorkspace();
              const actor = yield* requireActiveMember(input.sessionId);
              if (actor.teamId !== activeTeam.id) {
                return yield* new TeamOperationError({
                  code: "forbidden",
                  message: "This session does not belong to the active team.",
                });
              }
              const memberSessionIds = yield* repository
                .listSessionIdsForMember(actor.id)
                .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<AuthSessionId>));
              const left = yield* repository
                .leaveTeam({
                  teamId: activeTeam.id,
                  memberId: actor.id,
                  updatedAt,
                })
                .pipe(
                  Effect.catchTags({
                    TeamLastOwnerProtectedError: () =>
                      Effect.fail(
                        new TeamOperationError({
                          code: "last_owner",
                          message:
                            "You are the last active owner. Transfer ownership to another member before leaving the team.",
                        }),
                      ),
                    TeamRepositoryError: (error) => Effect.fail(toInternalError(error)),
                  }),
                );
              if (Option.isNone(left)) {
                return yield* new TeamOperationError({
                  code: "not_found",
                  message: "Team member could not be found.",
                });
              }
              // Publish removal and a single coalesced ACL snapshot trigger immediately after
              // committing to SQLite so live streamState subscribers flip currentMember.status
              // to "removed" and refresh scrubbed views/environments once per subscriber.
              yield* publish({ version: 1, type: "memberUpserted", payload: left.value.member });
              const firstUpdatedView = left.value.updatedViews[0];
              const firstUpdatedEnv = left.value.updatedEnvironments[0];
              if (firstUpdatedView !== undefined) {
                yield* publish({ version: 1, type: "viewUpserted", payload: firstUpdatedView });
              } else if (firstUpdatedEnv !== undefined) {
                yield* publish({
                  version: 1,
                  type: "environmentUpserted",
                  payload: firstUpdatedEnv,
                });
              }
              yield* publishAccessChange({ type: "member", memberId: left.value.member.id });

              // Arm disconnect-driven caller session revocation BEFORE async pairing/peer cleanup
              // so disconnecting during any cleanup phase revokes the caller immediately.
              const callerJkt = yield* sessionStore
                .proofKeyThumbprintOf(input.sessionId)
                .pipe(Effect.orElseSucceed(() => Option.none<string>()));
              const revokeCaller = Effect.gen(function* () {
                if (Option.isSome(callerJkt)) {
                  yield* sessionStore.revokeByProofKey(callerJkt.value).pipe(Effect.ignore);
                }
                yield* sessionStore.revoke(input.sessionId).pipe(Effect.ignore);
              });
              if (isDeferredRevocation) {
                const fallbackDelay =
                  typeof deferSpec === "object" && deferSpec.fallbackDelay !== undefined
                    ? deferSpec.fallbackDelay
                    : Duration.millis(500);
                const awaitDisconnect =
                  typeof deferSpec === "object" ? deferSpec.awaitDisconnect : undefined;
                const graceAfterCleanup = Deferred.await(cleanupDone).pipe(
                  Effect.andThen(Effect.sleep(fallbackDelay)),
                );
                const waitForTrigger =
                  awaitDisconnect !== undefined
                    ? Effect.race(awaitDisconnect, graceAfterCleanup)
                    : graceAfterCleanup;
                yield* Effect.forkDetach(waitForTrigger.pipe(Effect.andThen(revokeCaller)));
              }

              yield* revokePairingLinksForMember(left.value.member.id).pipe(
                Effect.onError(() =>
                  isDeferredRevocation
                    ? Deferred.succeed(cleanupDone, undefined).pipe(Effect.asVoid)
                    : Effect.void,
                ),
              );
              return {
                team: activeTeam,
                leftResult: left.value,
                otherSessionIds: memberSessionIds.filter((sid) => sid !== input.sessionId),
                revokeCallerSession: revokeCaller,
                callerJkt,
              };
            }),
          );

        const updatedMember = leftResult.member;

        yield* Effect.gen(function* () {
          const otherProofKeys = new Set<string>();
          for (const sid of otherSessionIds) {
            const maybeJkt = yield* sessionStore
              .proofKeyThumbprintOf(sid)
              .pipe(Effect.orElseSucceed(() => Option.none<string>()));
            if (
              Option.isSome(maybeJkt) &&
              (Option.isNone(callerJkt) || maybeJkt.value !== callerJkt.value)
            ) {
              otherProofKeys.add(maybeJkt.value);
            }
            yield* sessionStore.revoke(sid).pipe(Effect.ignore);
          }
          for (const jkt of otherProofKeys) {
            yield* sessionStore.revokeByProofKey(jkt).pipe(Effect.ignore);
          }

          if (Option.isSome(assetsRepositoryOption)) {
            yield* assetsRepositoryOption.value
              .revokeLocalSyncTokensForMember(updatedMember.id, updatedAt)
              .pipe(Effect.ignore);
          }
          yield* TeamGitHubOAuth.withMemberGitHubCredentialMutationLock(
            team.id,
            updatedMember.id,
            Effect.gen(function* () {
              TeamGitHubOAuth.purgeMemberPendingGitHubOAuthFlows(
                githubOAuthFlowStore,
                updatedMember.id,
              );
              if (Option.isSome(githubRepositoryOption)) {
                const removedSecretKeyOpt = yield* githubRepositoryOption.value
                  .deleteMemberCredential(updatedMember.id)
                  .pipe(Effect.orElseSucceed(() => Option.none<string>()));
                if (Option.isSome(removedSecretKeyOpt) && Option.isSome(secretStoreOption)) {
                  yield* TeamGitHubRepository.removeTeamGitHubSecret(
                    secretStoreOption.value,
                    removedSecretKeyOpt.value,
                  ).pipe(Effect.ignore);
                }
              }
              yield* notifyGitHubCredentialChanged({
                kind: "member",
                teamId: team.id,
                memberId: updatedMember.id,
              });
            }),
          );
          if (input.peerClientPairing) {
            const envs = yield* repository
              .listEnvironments(team.id)
              .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<TeamEnvironment>));
            const targetEnvIds = envs
              .filter((env) => !env.isDefault)
              .map((env) => env.environmentId);
            if (input.peerLinks) {
              const allPeers = yield* input.peerLinks.list.pipe(Effect.orElseSucceed(() => []));
              for (const peer of allPeers) {
                targetEnvIds.push(peer.environmentId);
              }
            }
            const uniqueEnvIds = [...new Set(targetEnvIds)];
            if (uniqueEnvIds.length > 0) {
              yield* withRemoteRevocationBarrier(
                revokeRemoteMemberGrantsForEnvironments({
                  teamId: team.id,
                  peerClientPairing: input.peerClientPairing,
                  environmentIds: uniqueEnvIds,
                  subjectPrefixes: [remoteSubjectForMember(team.id, updatedMember.id)],
                }),
              );
            }
          }
        }).pipe(
          Effect.ensuring(
            isDeferredRevocation
              ? Deferred.succeed(cleanupDone, undefined).pipe(Effect.asVoid)
              : Effect.void,
          ),
        );

        if (!isDeferredRevocation) {
          yield* revokeCallerSession;
        }

        return {
          left: true,
          teamId: team.id,
          memberId: updatedMember.id,
        } satisfies TeamLeaveResult;
      }),
    );
  });

  const deleteTeam = Effect.fn("TeamService.deleteTeam")(function* (input: {
    readonly sessionId: AuthSessionId;
    readonly payload: TeamDeleteInput;
    readonly peerClientPairing?: PeerClientPairing.PeerClientPairing["Service"];
    readonly peerLinks?: PeerLinks.PeerLinks["Service"];
    readonly teamProviderManager?: TeamProviderManager.TeamProviderManager["Service"];
    readonly scheduledTaskService?: ScheduledTasks.ScheduledTaskService["Service"];
  }) {
    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const { team, members, providers, cleanupResult } = yield* withMembershipMutationGate(
          Effect.gen(function* () {
            const activeTeam = yield* requireWorkspace();
            const actor = yield* requireActiveMember(input.sessionId);
            if (actor.teamId !== activeTeam.id || actor.role !== "owner") {
              return yield* new TeamOperationError({
                code: "forbidden",
                message: "Only a team owner can delete the team.",
              });
            }
            if (input.payload.confirmTeamName.trim() !== activeTeam.name) {
              return yield* new TeamOperationError({
                code: "invalid_input",
                message: `Confirmation text must match the team name "${activeTeam.name}".`,
              });
            }

            const targets = yield* repository
              .collectDeleteCleanupTargets(activeTeam.id)
              .pipe(Effect.mapError(toInternalError));
            if (!targets.exists) {
              return yield* new TeamOperationError({
                code: "not_found",
                message: "Team workspace could not be found.",
              });
            }

            const currentMembers = yield* repository
              .listMembers(activeTeam.id)
              .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<TeamMember>));
            const currentEnvs = yield* repository
              .listEnvironments(activeTeam.id)
              .pipe(Effect.mapError(toInternalError));
            const allLinkedPeers =
              input.peerClientPairing && input.peerLinks
                ? yield* input.peerLinks.list.pipe(
                    Effect.mapError(
                      (cause) =>
                        new TeamOperationError({
                          code: "internal",
                          message: `Failed to list peer links before deleting team: ${String(cause)}`,
                        }),
                    ),
                  )
                : [];
            const currentProviders = Option.isSome(assetsRepositoryOption)
              ? yield* assetsRepositoryOption.value
                  .listProviders(activeTeam.id)
                  .pipe(Effect.orElseSucceed(() => []))
              : [];

            // 1. Delete team scheduled tasks (and revoke their webhooks) BEFORE removing
            //    team_workspaces so no team schedule can survive into personal mode.
            if (targets.scheduledTaskIds.length > 0) {
              if (!input.scheduledTaskService) {
                return yield* new TeamOperationError({
                  code: "internal",
                  message:
                    "Scheduled task service is unavailable; cannot safely delete team scheduled tasks.",
                });
              }
              for (const taskId of targets.scheduledTaskIds) {
                yield* input.scheduledTaskService.delete({ id: taskId }).pipe(
                  Effect.mapError(
                    (cause) =>
                      new TeamOperationError({
                        code: "internal",
                        message: `Failed to delete team scheduled task before deleting team: ${String(cause)}`,
                      }),
                  ),
                );
              }
            }

            // 2. Revoke every team-bound pairing grant BEFORE deleting team_pairing_meta so
            //    no surviving pairing grant can be treated as an ordinary personal pairing grant.
            if (targets.pairingLinkIds.length > 0) {
              for (const pairingLinkId of targets.pairingLinkIds) {
                if (Option.isSome(pairingGrantStoreOption)) {
                  yield* pairingGrantStoreOption.value.revoke(pairingLinkId).pipe(
                    Effect.mapError(
                      (cause) =>
                        new TeamOperationError({
                          code: "internal",
                          message: `Failed to revoke team pairing grant before deleting team: ${String(cause)}`,
                        }),
                    ),
                  );
                } else if (Option.isSome(environmentAuthOption)) {
                  yield* environmentAuthOption.value.revokePairingLink(pairingLinkId).pipe(
                    Effect.mapError(
                      (cause) =>
                        new TeamOperationError({
                          code: "internal",
                          message: `Failed to revoke team pairing grant before deleting team: ${String(cause)}`,
                        }),
                    ),
                  );
                }
              }
            }

            // 3. Revoke every other team-bound session and proof key BEFORE deleting workspace rows;
            //    keep the owner's current session so the server returns cleanly to personal mode.
            const proofKeysToRevoke = new Set<string>();
            const callerJkt = yield* sessionStore.proofKeyThumbprintOf(input.sessionId).pipe(
              Effect.mapError(
                (cause) =>
                  new TeamOperationError({
                    code: "internal",
                    message: `Failed to inspect caller session before deleting team: ${String(cause)}`,
                  }),
              ),
            );
            for (const boundSessionId of targets.sessionIds) {
              if (boundSessionId === input.sessionId) continue;
              const maybeJkt = yield* sessionStore.proofKeyThumbprintOf(boundSessionId).pipe(
                Effect.mapError(
                  (cause) =>
                    new TeamOperationError({
                      code: "internal",
                      message: `Failed to inspect team session before deleting team: ${String(cause)}`,
                    }),
                ),
              );
              if (
                Option.isSome(maybeJkt) &&
                (Option.isNone(callerJkt) || maybeJkt.value !== callerJkt.value)
              ) {
                proofKeysToRevoke.add(maybeJkt.value);
              }
              yield* sessionStore.revoke(boundSessionId).pipe(
                Effect.mapError(
                  (cause) =>
                    new TeamOperationError({
                      code: "internal",
                      message: `Failed to revoke team session before deleting team: ${String(cause)}`,
                    }),
                ),
              );
            }
            for (const proofKeyThumbprint of proofKeysToRevoke) {
              yield* sessionStore.revokeByProofKey(proofKeyThumbprint).pipe(
                Effect.mapError(
                  (cause) =>
                    new TeamOperationError({
                      code: "internal",
                      message: `Failed to revoke team proof key before deleting team: ${String(cause)}`,
                    }),
                ),
              );
            }

            // 4 & 5. Hold the remote revocation barrier across remote peer revocation AND atomic
            //        workspace deletion so no concurrent remote pairing grant can be issued between
            //        revocation and removing team_workspaces.
            const deleted = yield* withRemoteRevocationBarrier(
              Effect.gen(function* () {
                if (input.peerClientPairing) {
                  const remoteEnvIds = currentEnvs
                    .filter((env) => !env.isDefault)
                    .map((env) => env.environmentId);
                  for (const peer of allLinkedPeers) {
                    remoteEnvIds.push(peer.environmentId);
                  }
                  const uniqueRemoteEnvIds = [...new Set(remoteEnvIds)];
                  if (uniqueRemoteEnvIds.length > 0) {
                    const remoteOutcome = yield* revokeRemoteMemberGrantsForEnvironments({
                      teamId: activeTeam.id,
                      peerClientPairing: input.peerClientPairing,
                      environmentIds: uniqueRemoteEnvIds,
                      subjectPrefixes: [remoteSubjectPrefixForTeam(activeTeam.id)],
                    });
                    if (remoteOutcome.enqueueFailed) {
                      return yield* new TeamOperationError({
                        code: "internal",
                        message:
                          "Failed to persist pending remote peer revocations before deleting team.",
                      });
                    }
                  }
                }
                return yield* repository
                  .deleteTeam(activeTeam.id)
                  .pipe(Effect.mapError(toInternalError));
              }),
            );
            return {
              team: activeTeam,
              members: currentMembers,
              providers: currentProviders.map((provider) => ({
                providerInstanceId: provider.providerInstanceId,
                driver: provider.driver,
              })),
              cleanupResult: deleted,
            };
          }),
        );

        if (!cleanupResult.deleted) {
          return yield* new TeamOperationError({
            code: "not_found",
            message: "Team workspace could not be found.",
          });
        }

        for (const member of members) {
          TeamGitHubOAuth.purgeMemberPendingGitHubOAuthFlows(githubOAuthFlowStore, member.id);
          yield* notifyGitHubCredentialChanged({
            kind: "member",
            teamId: team.id,
            memberId: member.id,
          });
        }
        yield* notifyGitHubCredentialChanged({
          kind: "automation",
          teamId: team.id,
        });

        if (Option.isSome(secretStoreOption)) {
          const secrets = secretStoreOption.value;
          for (const secretKey of cleanupResult.providerSecretKeys) {
            yield* removeTeamProviderSecret(secrets, secretKey).pipe(Effect.ignore);
            clearTeamProviderRefreshLock(secretKey);
          }
          for (const secretKey of cleanupResult.githubSecretKeys) {
            yield* TeamGitHubRepository.removeTeamGitHubSecret(secrets, secretKey).pipe(
              Effect.ignore,
            );
          }
          if (cleanupResult.githubAppClientSecretKey) {
            yield* TeamGitHubRepository.removeTeamGitHubSecret(
              secrets,
              cleanupResult.githubAppClientSecretKey,
            ).pipe(Effect.ignore);
          }
        }

        const activeProviderManager =
          input.teamProviderManager ?? Option.getOrUndefined(providerManagerOption);
        if (activeProviderManager) {
          yield* activeProviderManager.removeLocalTeamBinding(team.id).pipe(Effect.ignore);
          if (providers.length > 0) {
            yield* activeProviderManager
              .purgeTeamWorkspaceProfiles({
                teamId: team.id,
                providers,
              })
              .pipe(Effect.ignore);
          }
        }

        yield* publish({ version: 1, type: "teamDeleted", payload: { teamId: team.id } });
        yield* publishAccessChange({ type: "workspace" });
        yield* notifyProviderManagerChanged();

        return {
          deleted: true,
          teamId: team.id,
        } satisfies TeamDeleteResult;
      }),
    );
  });

  const createView = Effect.fn("TeamService.createView")(function* (input: {
    readonly sessionId: AuthSessionId;
    readonly payload: TeamCreateViewInput;
  }) {
    const team = yield* requireWorkspace();
    const actor = yield* requireActiveMember(input.sessionId);
    if (actor.teamId !== team.id || !canManageTeamViews(actor.role)) {
      return yield* new TeamOperationError({
        code: "forbidden",
        message: "Only owner and admin members can create team views.",
      });
    }
    const name = input.payload.name.trim();
    if (name.length === 0) {
      return yield* new TeamOperationError({
        code: "invalid_input",
        message: "View name cannot be empty.",
      });
    }
    const description =
      input.payload.description !== undefined && input.payload.description !== null
        ? input.payload.description.trim() || null
        : null;
    const readRule = normalizeAccessRule(input.payload.readRule);
    const postRule = normalizeAccessRule(input.payload.postRule);
    const view = yield* withMembershipMutationGate(
      Effect.gen(function* () {
        const activeTeam = yield* requireWorkspace();
        if (activeTeam.id !== team.id) {
          return yield* new TeamOperationError({
            code: "not_found",
            message: "The target team workspace changed before creating the view.",
          });
        }
        const activeActor = yield* requireActiveMember(input.sessionId);
        if (activeActor.teamId !== activeTeam.id || !canManageTeamViews(activeActor.role)) {
          return yield* new TeamOperationError({
            code: "forbidden",
            message: "Only owner and admin members can create team views.",
          });
        }
        yield* validateAccessRuleMemberIds(activeTeam.id, [readRule, postRule]);
        const nowIso = DateTime.formatIso(yield* DateTime.now);
        const viewId = TeamViewId.make(
          `view_${yield* random.uuidV4().pipe(Effect.mapError(toInternalError))}`,
        );
        const nextView: TeamView = {
          id: viewId,
          teamId: activeTeam.id,
          name,
          description,
          isDefault: false,
          readRule,
          postRule,
          createdAt: nowIso,
          updatedAt: nowIso,
        };
        yield* repository.createView(nextView).pipe(
          Effect.catchTags({
            TeamViewNameAlreadyTakenError: (error) =>
              Effect.fail(
                new TeamOperationError({
                  code: "view_name_taken",
                  message: error.message,
                }),
              ),
            TeamRepositoryError: (error) => Effect.fail(toInternalError(error)),
          }),
        );
        return nextView;
      }),
    );
    yield* publish({ version: 1, type: "viewUpserted", payload: view });
    yield* publishAccessChange({ type: "view", viewId: view.id });
    return view;
  });

  const updateView = Effect.fn("TeamService.updateView")(function* (input: {
    readonly sessionId: AuthSessionId;
    readonly payload: TeamUpdateViewInput;
  }) {
    const team = yield* requireWorkspace();
    const actor = yield* requireActiveMember(input.sessionId);
    if (actor.teamId !== team.id || !canManageTeamViews(actor.role)) {
      return yield* new TeamOperationError({
        code: "forbidden",
        message: "Only owner and admin members can edit team views.",
      });
    }
    const existingOption = yield* repository
      .getViewById(input.payload.viewId)
      .pipe(Effect.mapError(toInternalError));
    if (Option.isNone(existingOption) || existingOption.value.teamId !== team.id) {
      return yield* new TeamOperationError({
        code: "not_found",
        message: "Team view could not be found.",
      });
    }
    const existing = existingOption.value;
    if (existing.isDefault && input.payload.readRule !== undefined) {
      const normalizedRead = normalizeAccessRule(input.payload.readRule);
      const allowsAllRoles = ALL_TEAM_ROLES.every((role) => normalizedRead.roles.includes(role));
      if (!allowsAllRoles) {
        return yield* new TeamOperationError({
          code: "default_view_protected",
          message: "The Default View must remain readable by all team roles.",
        });
      }
    }
    const nextName = input.payload.name !== undefined ? input.payload.name.trim() : undefined;
    if (nextName !== undefined && nextName.length === 0) {
      return yield* new TeamOperationError({
        code: "invalid_input",
        message: "View name cannot be empty.",
      });
    }
    const nextDescription =
      input.payload.description === undefined
        ? undefined
        : input.payload.description === null
          ? null
          : input.payload.description.trim() || null;
    const nextReadRule =
      input.payload.readRule !== undefined
        ? normalizeAccessRule(input.payload.readRule)
        : undefined;
    const nextPostRule =
      input.payload.postRule !== undefined
        ? normalizeAccessRule(input.payload.postRule)
        : undefined;
    const updated = yield* withMembershipMutationGate(
      Effect.gen(function* () {
        const activeTeam = yield* requireWorkspace();
        if (activeTeam.id !== team.id) {
          return yield* new TeamOperationError({
            code: "not_found",
            message: "The target team workspace changed before updating the view.",
          });
        }
        const activeActor = yield* requireActiveMember(input.sessionId);
        if (activeActor.teamId !== activeTeam.id || !canManageTeamViews(activeActor.role)) {
          return yield* new TeamOperationError({
            code: "forbidden",
            message: "Only owner and admin members can edit team views.",
          });
        }
        yield* validateAccessRuleMemberIds(activeTeam.id, [nextReadRule, nextPostRule]);
        const updatedAt = DateTime.formatIso(yield* DateTime.now);
        return yield* repository
          .updateView({
            teamId: activeTeam.id,
            viewId: existing.id,
            ...(nextName !== undefined ? { name: nextName } : {}),
            ...(nextDescription !== undefined ? { description: nextDescription } : {}),
            ...(nextReadRule !== undefined ? { readRule: nextReadRule } : {}),
            ...(nextPostRule !== undefined ? { postRule: nextPostRule } : {}),
            updatedAt,
          })
          .pipe(
            Effect.catchTags({
              TeamViewNameAlreadyTakenError: (error) =>
                Effect.fail(
                  new TeamOperationError({
                    code: "view_name_taken",
                    message: error.message,
                  }),
                ),
              TeamRepositoryError: (error) => Effect.fail(toInternalError(error)),
            }),
          );
      }),
    );
    if (Option.isNone(updated)) {
      return yield* new TeamOperationError({
        code: "not_found",
        message: "Team view could not be found.",
      });
    }
    yield* publish({ version: 1, type: "viewUpserted", payload: updated.value });
    yield* publishAccessChange({ type: "view", viewId: updated.value.id });
    return updated.value;
  });

  const deleteView = Effect.fn("TeamService.deleteView")(function* (input: {
    readonly sessionId: AuthSessionId;
    readonly payload: TeamDeleteViewInput;
  }) {
    const team = yield* requireWorkspace();
    const actor = yield* requireActiveMember(input.sessionId);
    if (actor.teamId !== team.id || !canManageTeamViews(actor.role)) {
      return yield* new TeamOperationError({
        code: "forbidden",
        message: "Only owner and admin members can delete team views.",
      });
    }
    const existingOption = yield* repository
      .getViewById(input.payload.viewId)
      .pipe(Effect.mapError(toInternalError));
    if (Option.isNone(existingOption) || existingOption.value.teamId !== team.id) {
      return {
        deleted: false,
        fallbackViewId: team.defaultViewId,
      } satisfies TeamDeleteViewResult;
    }
    if (existingOption.value.isDefault) {
      return yield* new TeamOperationError({
        code: "default_view_protected",
        message: "The built-in Default View cannot be deleted.",
      });
    }
    const deleted = yield* repository
      .deleteViewAndReassignThreads({
        teamId: team.id,
        viewId: existingOption.value.id,
        fallbackViewId: team.defaultViewId,
      })
      .pipe(
        Effect.catchTags({
          TeamDefaultViewProtectedError: (error) =>
            Effect.fail(
              new TeamOperationError({
                code: "default_view_protected",
                message: error.message,
              }),
            ),
          TeamRepositoryError: (error) => Effect.fail(toInternalError(error)),
        }),
      );
    if (deleted) {
      yield* publish({
        version: 1,
        type: "viewDeleted",
        payload: {
          viewId: existingOption.value.id,
          fallbackViewId: team.defaultViewId,
        },
      });
      yield* publishAccessChange({ type: "view", viewId: existingOption.value.id });
    }
    return {
      deleted,
      fallbackViewId: team.defaultViewId,
    } satisfies TeamDeleteViewResult;
  });

  const setThreadView = Effect.fn("TeamService.setThreadView")(function* (input: {
    readonly sessionId: AuthSessionId;
    readonly payload: TeamSetThreadViewInput;
  }) {
    const team = yield* requireWorkspace();
    const actor = yield* requireActiveMember(input.sessionId);
    if (actor.teamId !== team.id || !canChangeThreadTeamView(actor.role)) {
      return yield* new TeamOperationError({
        code: "forbidden",
        message: "Only modo, admin, and owner members can change a thread's view.",
      });
    }
    const targetViewOption = yield* repository
      .getViewById(input.payload.viewId)
      .pipe(Effect.mapError(toInternalError));
    if (Option.isNone(targetViewOption) || targetViewOption.value.teamId !== team.id) {
      return yield* new TeamOperationError({
        code: "not_found",
        message: "Target team view could not be found.",
      });
    }
    if (!canMemberReadTeamView(actor, targetViewOption.value)) {
      return yield* new TeamOperationError({
        code: "forbidden",
        message: "You do not have access to the target view.",
      });
    }
    const readable = yield* canReadThread(input.sessionId, input.payload.threadId);
    if (!readable) {
      return yield* new TeamOperationError({
        code: "forbidden",
        message: "You do not have permission to view this thread.",
      });
    }
    const deleted = yield* repository
      .isThreadDeletedInProjection(input.payload.threadId)
      .pipe(Effect.mapError(toInternalError));
    if (deleted) {
      return yield* new TeamOperationError({
        code: "not_found",
        message: "Thread not found.",
      });
    }
    const updated = yield* repository
      .updateThreadView({
        teamId: team.id,
        threadId: input.payload.threadId,
        viewId: targetViewOption.value.id,
      })
      .pipe(Effect.mapError(toInternalError));
    if (Option.isNone(updated)) {
      return yield* new TeamOperationError({
        code: "not_found",
        message: "Team thread attribution could not be found.",
      });
    }
    yield* publish({ version: 1, type: "threadAttributed", payload: updated.value });
    yield* publishAccessChange({ type: "threadView", threadId: input.payload.threadId });
    return updated.value;
  }, withMembershipMutationGate);

  const setThreadLocked = Effect.fn("TeamService.setThreadLocked")(function* (input: {
    readonly sessionId: AuthSessionId;
    readonly payload: TeamSetThreadLockedInput;
  }) {
    const team = yield* requireWorkspace();
    const actor = yield* requireActiveMember(input.sessionId);
    if (actor.teamId !== team.id || !canToggleTeamThreadLock(actor.role)) {
      return yield* new TeamOperationError({
        code: "forbidden",
        message: "Only owner and admin members can lock or unlock threads.",
      });
    }
    const deleted = yield* repository
      .isThreadDeletedInProjection(input.payload.threadId)
      .pipe(Effect.mapError(toInternalError));
    if (deleted) {
      return yield* new TeamOperationError({
        code: "not_found",
        message: "Thread not found.",
      });
    }
    const updated = yield* repository
      .updateThreadLocked({
        teamId: team.id,
        threadId: input.payload.threadId,
        locked: input.payload.locked,
        lockedByMemberId: input.payload.locked ? actor.id : null,
      })
      .pipe(Effect.mapError(toInternalError));
    if (Option.isNone(updated)) {
      return yield* new TeamOperationError({
        code: "not_found",
        message: "Team thread attribution could not be found.",
      });
    }
    yield* publish({ version: 1, type: "threadAttributed", payload: updated.value });
    yield* publishAccessChange({ type: "threadView", threadId: input.payload.threadId });
    return updated.value;
  }, withMembershipMutationGate);

  const updateMyPseudo = Effect.fn("TeamService.updateMyPseudo")(function* (input: {
    readonly sessionId: AuthSessionId;
    readonly payload: TeamUpdateMyPseudoInput;
  }) {
    const team = yield* requireWorkspace();
    const actor = yield* requireActiveMember(input.sessionId);
    const nextPseudo = yield* validatePseudo(input.payload.pseudo);
    const updatedAt = DateTime.formatIso(yield* DateTime.now);

    const updated = yield* repository
      .updateMemberPseudo({
        teamId: team.id,
        memberId: actor.id,
        pseudo: nextPseudo,
        updatedAt,
      })
      .pipe(
        Effect.catchTags({
          TeamPseudoAlreadyTakenError: (error) =>
            Effect.fail(
              new TeamOperationError({
                code: "pseudo_taken",
                message: error.message,
              }),
            ),
          TeamRepositoryError: (error) => Effect.fail(toInternalError(error)),
        }),
      );

    if (Option.isNone(updated)) {
      return yield* new TeamOperationError({
        code: "not_found",
        message: "Team member could not be found.",
      });
    }

    yield* publish({ version: 1, type: "memberUpserted", payload: updated.value });
    yield* publishAccessChange({ type: "memberPseudo", memberId: updated.value.id });
    return updated.value;
  });

  const createInvite = Effect.fn("TeamService.createInvite")(function* (input: {
    readonly sessionId: AuthSessionId;
    readonly payload: TeamCreateInviteInput;
  }) {
    const team = yield* requireWorkspace();
    const actor = yield* requireActiveMember(input.sessionId);
    if (!canManageTeamInvites(actor.role)) {
      return yield* new TeamOperationError({
        code: "forbidden",
        message: "Only modo, admin, and owner members can create team invites.",
      });
    }
    if (!canAssignTeamRole(actor.role, input.payload.role)) {
      return yield* new TeamOperationError({
        code: "forbidden",
        message: `You cannot create an invite with role "${input.payload.role}" above your own role "${actor.role}".`,
      });
    }

    const prefilledPseudo =
      input.payload.prefilledPseudo !== undefined && input.payload.prefilledPseudo !== null
        ? yield* validatePseudo(input.payload.prefilledPseudo)
        : null;

    const now = yield* DateTime.now;
    const expiresInHours = Math.min(
      input.payload.expiresInHours ?? DEFAULT_INVITE_EXPIRY_HOURS,
      MAX_INVITE_EXPIRY_HOURS,
    );
    const expiresAt = DateTime.add(now, { hours: expiresInHours });
    const rawSecretBytes = yield* random.randomBytes(24).pipe(Effect.mapError(toInternalError));
    const token = `${INVITE_TOKEN_PREFIX}${Buffer.from(rawSecretBytes).toString("base64url")}`;
    const inviteId = TeamInviteId.make(
      yield* random.uuidV4().pipe(Effect.mapError(toInternalError)),
    );

    const record: TeamRepository.StoredTeamInviteRecord = {
      id: inviteId,
      teamId: team.id,
      tokenHash: hashInviteToken(token),
      role: input.payload.role,
      prefilledPseudo,
      maxUses: input.payload.maxUses ?? 1,
      uses: 0,
      expiresAt: DateTime.formatIso(expiresAt),
      createdByMemberId: actor.id,
      revokedAt: null,
      createdAt: DateTime.formatIso(now),
    };

    yield* repository.createInvite(record).pipe(Effect.mapError(toInternalError));
    const invite = stripInviteHash(record);
    yield* publish({ version: 1, type: "inviteUpserted", payload: invite });
    return { invite, token } satisfies TeamInviteCreatedResult;
  });

  const revokeInvite = Effect.fn("TeamService.revokeInvite")(function* (input: {
    readonly sessionId: AuthSessionId;
    readonly payload: TeamRevokeInviteInput;
  }) {
    yield* requireWorkspace();
    const actor = yield* requireActiveMember(input.sessionId);
    if (!canManageTeamInvites(actor.role)) {
      return yield* new TeamOperationError({
        code: "forbidden",
        message: "Only modo, admin, and owner members can revoke team invites.",
      });
    }
    const existing = yield* repository
      .getInviteById(input.payload.inviteId)
      .pipe(Effect.mapError(toInternalError));
    if (Option.isNone(existing)) {
      return { revoked: false };
    }
    if (TEAM_ROLE_RANK[existing.value.role] > TEAM_ROLE_RANK[actor.role]) {
      return yield* new TeamOperationError({
        code: "forbidden",
        message: "You cannot revoke an invite for a role higher than your own.",
      });
    }
    const revokedAt = DateTime.formatIso(yield* DateTime.now);
    const revoked = yield* repository
      .revokeInvite({ inviteId: input.payload.inviteId, revokedAt })
      .pipe(Effect.mapError(toInternalError));
    if (revoked) {
      yield* publish({
        version: 1,
        type: "inviteUpserted",
        payload: { ...stripInviteHash(existing.value), revokedAt },
      });
    }
    return { revoked };
  });

  const previewInvite = Effect.fn("TeamService.previewInvite")(function* (token: string) {
    const team = yield* requireWorkspace();
    const inviteOption = yield* repository
      .getInviteByTokenHash(hashInviteToken(token))
      .pipe(Effect.mapError(toInternalError));
    if (Option.isNone(inviteOption)) {
      return yield* new TeamOperationError({
        code: "invite_invalid",
        message: "This team invite link is invalid.",
      });
    }
    const invite = yield* validateInviteRecord(inviteOption.value);
    return {
      teamId: team.id,
      teamName: team.name,
      role: invite.role,
      prefilledPseudo: invite.prefilledPseudo,
      expiresAt: invite.expiresAt,
    } satisfies TeamInvitePreviewResult;
  });

  const redeemInvite = Effect.fn("TeamService.redeemInvite")(function* (input: {
    readonly token: string;
    readonly pseudo: string;
    readonly client: AuthClientMetadata;
    readonly proofKeyThumbprint?: string;
  }) {
    const team = yield* requireWorkspace();
    const pseudo = yield* validatePseudo(input.pseudo);
    const inviteOption = yield* repository
      .getInviteByTokenHash(hashInviteToken(input.token))
      .pipe(Effect.mapError(toInternalError));
    if (Option.isNone(inviteOption)) {
      return yield* new TeamOperationError({
        code: "invite_invalid",
        message: "This team invite link is invalid.",
      });
    }
    const invite = yield* validateInviteRecord(inviteOption.value);
    const now = yield* DateTime.now;
    const nowIso = DateTime.formatIso(now);
    const memberId = TeamMemberId.make(
      yield* random.uuidV4().pipe(Effect.mapError(toInternalError)),
    );
    const member: TeamMember = {
      id: memberId,
      teamId: team.id,
      pseudo,
      role: invite.role,
      status: "active",
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    const consumed = yield* repository
      .consumeInviteAndCreateMember({
        inviteId: invite.id,
        member,
        nowIso,
      })
      .pipe(
        Effect.catchTags({
          TeamPseudoAlreadyTakenError: (error) =>
            Effect.fail(
              new TeamOperationError({
                code: "pseudo_taken",
                message: error.message,
              }),
            ),
          TeamRepositoryError: (error) =>
            Effect.logWarning("TeamService.redeemInvite consume failed", { cause: error }).pipe(
              Effect.andThen(Effect.fail(toInternalError(error))),
            ),
        }),
      );

    if (!consumed) {
      return yield* new TeamOperationError({
        code: "invite_exhausted",
        message: "This team invite has expired, been revoked, or reached its maximum uses.",
      });
    }

    const rollbackConsumedInvite = repository
      .rollbackInviteConsumption({ inviteId: invite.id, memberId: member.id })
      .pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("TeamService.redeemInvite rollback failed", {
            inviteId: invite.id,
            memberId: member.id,
            cause,
          }),
        ),
        Effect.ignore,
      );

    const useDpop = input.proofKeyThumbprint !== undefined;
    const issued = yield* sessionStore
      .issue({
        subject: `team-member:${member.id}`,
        method: useDpop ? "dpop-access-token" : "bearer-access-token",
        scopes: scopesForTeamRole(member.role),
        client: {
          ...input.client,
          label: input.client.label ?? `${member.pseudo} (Team)`,
        },
        ...(useDpop
          ? {
              proofKeyThumbprint: input.proofKeyThumbprint,
              ttl: RENEWABLE_ACCESS_TOKEN_TTL,
              renewalWindow: RENEWABLE_SESSION_WINDOW,
            }
          : {}),
      })
      .pipe(
        Effect.onError(() => rollbackConsumedInvite),
        logAndMapInternalError("redeemInvite.issueSession"),
      );

    yield* repository
      .bindSession({
        sessionId: issued.sessionId,
        teamId: team.id,
        memberId: member.id,
        boundAt: nowIso,
      })
      .pipe(
        Effect.onError(() =>
          sessionStore
            .revoke(issued.sessionId)
            .pipe(Effect.ignore, Effect.andThen(rollbackConsumedInvite)),
        ),
        logAndMapInternalError("redeemInvite.bindSession"),
      );

    const updatedInvite = yield* repository.getInviteById(invite.id).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("TeamService.redeemInvite post-commit invite read failed", {
          inviteId: invite.id,
          cause,
        }),
      ),
      Effect.orElseSucceed(() => Option.none<TeamRepository.StoredTeamInviteRecord>()),
    );
    yield* publish({ version: 1, type: "memberUpserted", payload: member });
    yield* publish({
      version: 1,
      type: "inviteUpserted",
      payload: Option.isSome(updatedInvite)
        ? stripInviteHash(updatedInvite.value)
        : { ...stripInviteHash(invite), uses: invite.uses + 1 },
    });

    const expiresInSeconds = Math.max(
      1,
      Math.floor((issued.expiresAt.epochMilliseconds - now.epochMilliseconds) / 1000),
    );
    return {
      team,
      member,
      accessToken: issued.token,
      tokenType: useDpop ? "DPoP" : "Bearer",
      expiresIn: expiresInSeconds,
      scopes: [...issued.scopes],
    } satisfies TeamRedeemInviteResponse;
  });

  const syntheticAutomationMember = (
    teamId: TeamId,
    principal: McpTeamAutomationPrincipal,
  ): TeamMember => ({
    id: TeamMemberId.make(`team-automation:${principal.taskId}`),
    teamId,
    pseudo: "team-automation",
    role: principal.mcpAccessLevel === "elevated" ? "admin" : "regular",
    status: "active",
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
  });

  const isMinimalAutomationActor = (
    actor: TeamActor,
  ): actor is {
    readonly kind: "team_automation";
    readonly principal: McpTeamAutomationPrincipal & { readonly mcpAccessLevel: "minimal" };
  } => actor.kind === "team_automation" && actor.principal.mcpAccessLevel === "minimal";

  const resolveMemberForActor = Effect.fn("TeamService.resolveMemberForActor")(function* (
    actor: TeamActor,
  ) {
    if (actor.kind === "session") {
      return yield* repository.getMemberForSession(actor.sessionId);
    }
    if (actor.kind === "team_automation") {
      const workspaceOption = yield* repository.getWorkspace();
      if (Option.isNone(workspaceOption) || workspaceOption.value.id !== actor.principal.teamId) {
        return Option.none<TeamMember>();
      }
      return Option.some(syntheticAutomationMember(workspaceOption.value.id, actor.principal));
    }
    if (actor.memberId === null) {
      return Option.none<TeamMember>();
    }
    return yield* repository.getMemberById(actor.memberId);
  });

  const sessionActor = (sessionId: AuthSessionId): TeamActor => ({
    kind: "session",
    sessionId,
  });

  const getThreadAttribution = Effect.fn("TeamService.getThreadAttribution")(function* (
    threadId: ThreadId,
  ) {
    return yield* repository.getThreadAttribution(threadId).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("TeamService.getThreadAttribution failed", { threadId, cause }),
      ),
      Effect.orElseSucceed(() => Option.none<TeamThreadAttribution>()),
    );
  });

  const resolveMemberIdForSession = Effect.fn("TeamService.resolveMemberIdForSession")(function* (
    sessionId: AuthSessionId,
  ) {
    const workspaceOption = yield* repository
      .getWorkspace()
      .pipe(Effect.orElseSucceed(() => Option.none<TeamWorkspace>()));
    if (Option.isNone(workspaceOption)) return Option.none<TeamMemberId>();
    const memberOption = yield* repository
      .getMemberForSession(sessionId)
      .pipe(Effect.orElseSucceed(() => Option.none<TeamMember>()));
    if (
      Option.isNone(memberOption) ||
      memberOption.value.teamId !== workspaceOption.value.id ||
      memberOption.value.status !== "active"
    ) {
      return Option.none<TeamMemberId>();
    }
    return Option.some(memberOption.value.id);
  });

  const ACTIVE_RUN_STATUSES = new Set<string>(["preparing", "starting", "running", "waiting"]);

  const resolveTurnPrincipal = Effect.fn("TeamService.resolveTurnPrincipal")(function* (input: {
    readonly threadId: ThreadId;
    readonly runId?: string | null;
    readonly userMessageId?: string | null;
    readonly continuedFromRunId?: string | null;
  }) {
    return yield* Effect.gen(function* () {
      const workspaceOption = yield* repository.getWorkspace();
      if (Option.isNone(workspaceOption)) return Option.none<TeamTurnPrincipal>();
      const resolveScopeForTurn = Effect.fnUntraced(function* (
        turnId: string,
        fallbackMessageId: string | null,
      ) {
        const directScope = yield* repository.getAutomationTurnScope(turnId);
        if (Option.isSome(directScope) && directScope.value.threadId === input.threadId) {
          return Option.some<McpTeamAutomationPrincipal>({
            taskId: directScope.value.taskId,
            teamId: directScope.value.teamId,
            projectId: directScope.value.projectId,
            environmentId: directScope.value.environmentId,
            viewId: directScope.value.viewId,
            mcpAccessLevel: directScope.value.mcpAccessLevel,
          });
        }
        if (fallbackMessageId !== null) {
          const msgScope = yield* repository.getAutomationTurnScope(`msg:${fallbackMessageId}`);
          if (Option.isSome(msgScope) && msgScope.value.threadId === input.threadId) {
            return Option.some<McpTeamAutomationPrincipal>({
              taskId: msgScope.value.taskId,
              teamId: msgScope.value.teamId,
              projectId: msgScope.value.projectId,
              environmentId: msgScope.value.environmentId,
              viewId: msgScope.value.viewId,
              mcpAccessLevel: msgScope.value.mcpAccessLevel,
            });
          }
        }
        // Fail closed: never inherit another turn's scope from the same thread.
        return Option.none<McpTeamAutomationPrincipal>();
      });
      const resolveByRunOrMessage = Effect.fnUntraced(function* (
        candidateRunId: string | null,
        candidateMessageId: string | null,
      ) {
        let messageId = candidateMessageId;
        if (candidateRunId !== null) {
          const byRun = yield* repository.getTurnAttribution(candidateRunId);
          if (Option.isSome(byRun) && byRun.value.threadId === input.threadId) {
            if (
              byRun.value.authorKind === "team_automation" ||
              byRun.value.authorMemberId === null
            ) {
              if (messageId === null) {
                const runRecord = yield* repository
                  .getRunInProjection(input.threadId, candidateRunId)
                  .pipe(Effect.orElseSucceed(() => Option.none()));
                if (Option.isSome(runRecord)) {
                  messageId = runRecord.value.userMessageId;
                }
              }
              const scope = yield* resolveScopeForTurn(candidateRunId, messageId);
              if (Option.isSome(scope)) {
                return Option.some<TeamTurnPrincipal>({
                  kind: "team_automation",
                  principal: scope.value,
                });
              }
              return Option.none<TeamTurnPrincipal>();
            }
            return Option.some<TeamTurnPrincipal>({
              kind: "member",
              memberId: byRun.value.authorMemberId,
            });
          }
        }
        if (messageId === null && candidateRunId !== null) {
          const runRecord = yield* repository
            .getRunInProjection(input.threadId, candidateRunId)
            .pipe(Effect.orElseSucceed(() => Option.none()));
          if (Option.isSome(runRecord)) {
            messageId = runRecord.value.userMessageId;
          }
        }
        if (messageId !== null) {
          const msgTurnId = `msg:${messageId}`;
          const byMessage = yield* repository.getTurnAttribution(msgTurnId);
          if (Option.isSome(byMessage) && byMessage.value.threadId === input.threadId) {
            if (
              byMessage.value.authorKind === "team_automation" ||
              byMessage.value.authorMemberId === null
            ) {
              const scope = yield* resolveScopeForTurn(msgTurnId, messageId);
              if (Option.isSome(scope)) {
                return Option.some<TeamTurnPrincipal>({
                  kind: "team_automation",
                  principal: scope.value,
                });
              }
              return Option.none<TeamTurnPrincipal>();
            }
            return Option.some<TeamTurnPrincipal>({
              kind: "member",
              memberId: byMessage.value.authorMemberId,
            });
          }
        }
        return Option.none<TeamTurnPrincipal>();
      });

      const runId = input.runId ?? null;
      const userMessageId = input.userMessageId ?? null;
      const continuedFromRunId = input.continuedFromRunId ?? null;
      const direct = yield* resolveByRunOrMessage(runId, userMessageId);
      if (Option.isSome(direct)) return direct;
      if (continuedFromRunId !== null) {
        const fromContinued = yield* resolveByRunOrMessage(continuedFromRunId, null);
        if (Option.isSome(fromContinued)) return fromContinued;
      }
      if (runId === null && userMessageId === null && continuedFromRunId === null) {
        const activeRun = yield* repository
          .getActiveRunInProjection(input.threadId)
          .pipe(Effect.orElseSucceed(() => Option.none()));
        if (Option.isSome(activeRun)) {
          const fromActive = yield* resolveByRunOrMessage(
            activeRun.value.runId,
            activeRun.value.userMessageId,
          );
          if (Option.isSome(fromActive)) return fromActive;
        }
      }
      return Option.none<TeamTurnPrincipal>();
    }).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("TeamService.resolveTurnPrincipal failed", {
          threadId: input.threadId,
          runId: input.runId,
          cause,
        }),
      ),
      Effect.orElseSucceed(() => Option.none<TeamTurnPrincipal>()),
    );
  });

  const resolveTurnAuthorMemberId = Effect.fn("TeamService.resolveTurnAuthorMemberId")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly runId?: string | null;
      readonly userMessageId?: string | null;
      readonly continuedFromRunId?: string | null;
    }) {
      const resolved = yield* resolveTurnPrincipal(input);
      if (Option.isSome(resolved) && resolved.value.kind === "member") {
        return Option.some(resolved.value.memberId);
      }
      // Fail closed: team_automation turns and unattributed runs never resolve to a human memberId.
      return Option.none<TeamMemberId>();
    },
  );

  const resolveActiveTurnAuthorKind = Effect.fn("TeamService.resolveActiveTurnAuthorKind")(
    function* (threadId: ThreadId): Effect.fn.Return<TeamTurnAuthorKind | null> {
      const activeRun = yield* repository
        .getActiveRunInProjection(threadId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isNone(activeRun)) return null;
      const byRun = yield* repository
        .getTurnAttribution(activeRun.value.runId)
        .pipe(Effect.orElseSucceed(() => Option.none<TeamTurnAttribution>()));
      if (Option.isSome(byRun) && byRun.value.threadId === threadId) {
        return (
          byRun.value.authorKind ??
          (byRun.value.authorMemberId === null ? "team_automation" : "member")
        );
      }
      if (activeRun.value.userMessageId !== null) {
        const byMsg = yield* repository
          .getTurnAttribution(`msg:${activeRun.value.userMessageId}`)
          .pipe(Effect.orElseSucceed(() => Option.none<TeamTurnAttribution>()));
        if (Option.isSome(byMsg) && byMsg.value.threadId === threadId) {
          return (
            byMsg.value.authorKind ??
            (byMsg.value.authorMemberId === null ? "team_automation" : "member")
          );
        }
      }
      return null;
    },
  );

  const resolveThreadAccessContextForActor = Effect.fn(
    "TeamService.resolveThreadAccessContextForActor",
  )(function* (actor: TeamActor, threadId: ThreadId) {
    const workspaceOption = yield* repository.getWorkspace();
    if (Option.isNone(workspaceOption)) {
      return { kind: "personal" as const };
    }
    const team = workspaceOption.value;
    const [attributionOption, memberOption] = yield* Effect.all([
      repository.getThreadAttribution(threadId),
      resolveMemberForActor(actor),
    ]);
    const member =
      Option.isSome(memberOption) && memberOption.value.teamId === team.id
        ? memberOption.value
        : null;
    if (Option.isNone(attributionOption)) {
      const createdAtOption = yield* repository.getThreadCreatedAtInProjection(threadId);
      const isLegacyPreTeam = isPreTeamLegacyTimestamp(
        team,
        Option.getOrUndefined(createdAtOption),
      );
      return { kind: "unattributed" as const, team, member, isLegacyPreTeam };
    }
    if (attributionOption.value.teamId !== team.id) {
      return { kind: "wrong_team" as const };
    }
    const [viewOption, defaultViewOption] = yield* Effect.all([
      repository.getViewById(attributionOption.value.viewId),
      attributionOption.value.viewId === team.defaultViewId
        ? Effect.succeed(Option.none<TeamView>())
        : repository.getViewById(team.defaultViewId),
    ]);
    const view = Option.getOrNull(viewOption) ?? Option.getOrNull(defaultViewOption);
    return {
      kind: "team_thread" as const,
      team,
      member,
      attribution: attributionOption.value,
      view,
    };
  });

  const resolveThreadAccessContext = (sessionId: AuthSessionId, threadId: ThreadId) =>
    resolveThreadAccessContextForActor(sessionActor(sessionId), threadId);

  const assertActorIsActiveMember = Effect.fn("TeamService.assertActorIsActiveMember")(function* (
    actor: TeamActor,
  ) {
    const workspaceOption = yield* repository.getWorkspace().pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("TeamService.assertActorIsActiveMember workspace lookup failed", {
          cause,
        }),
      ),
      Effect.mapError(() =>
        teamReadAuthError("This caller is not bound to an active team member."),
      ),
    );
    if (Option.isNone(workspaceOption)) {
      return;
    }
    const memberOption = yield* resolveMemberForActor(actor).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("TeamService.assertActorIsActiveMember member lookup failed", { cause }),
      ),
      Effect.mapError(() =>
        teamReadAuthError("This caller is not bound to an active team member."),
      ),
    );
    const member =
      Option.isSome(memberOption) && memberOption.value.teamId === workspaceOption.value.id
        ? memberOption.value
        : null;
    if (!member || member.status !== "active") {
      return yield* teamReadAuthError("This caller is not bound to an active team member.");
    }
  });

  const matchesMinimalAutomationThreadScope = Effect.fn(
    "TeamService.matchesMinimalAutomationThreadScope",
  )(function* (
    principal: McpTeamAutomationPrincipal,
    attribution: TeamThreadAttribution,
    projectId: ProjectId | undefined,
  ) {
    if (attribution.teamId !== principal.teamId) return false;
    if (attribution.viewId !== principal.viewId) return false;
    if (attribution.isLocalSynced === true) return false;
    if (projectId !== principal.projectId) return false;
    const localEnv = yield* resolveLocalEnvironmentIdentity();
    const threadEnvId = attribution.executionEnvironmentId ?? localEnv.environmentId;
    return threadEnvId === principal.environmentId;
  });

  const isMinimalAutomationOwnerOfThread = Effect.fn(
    "TeamService.isMinimalAutomationOwnerOfThread",
  )(function* (
    principal: McpTeamAutomationPrincipal,
    threadId: ThreadId,
    attribution: TeamThreadAttribution,
  ) {
    if (!isTeamOwnedThreadAttribution(attribution)) return false;
    const ownerScope = yield* repository
      .getAutomationTurnScope(`thread-owner:${threadId}`)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    return (
      Option.isSome(ownerScope) &&
      ownerScope.value.threadId === threadId &&
      ownerScope.value.taskId === principal.taskId &&
      ownerScope.value.mcpAccessLevel === "minimal"
    );
  });

  const canMinimalAutomationPostInThread = Effect.fn(
    "TeamService.canMinimalAutomationPostInThread",
  )(function* (
    principal: McpTeamAutomationPrincipal,
    threadId: ThreadId,
    attribution: TeamThreadAttribution,
    projectId: ProjectId | undefined,
  ) {
    const inScope = yield* matchesMinimalAutomationThreadScope(principal, attribution, projectId);
    if (!inScope) return false;
    if (!attribution.locked) return true;
    if (yield* isMinimalAutomationOwnerOfThread(principal, threadId, attribution)) {
      return true;
    }
    // Preserve in-turn MCP writes when an admin explicitly bound a minimal task to a locked thread,
    // without allowing stale historical scopes to bypass later admin locks.
    const activePrincipal = yield* resolveTurnPrincipal({ threadId });
    return (
      Option.isSome(activePrincipal) &&
      activePrincipal.value.kind === "team_automation" &&
      activePrincipal.value.principal.taskId === principal.taskId &&
      activePrincipal.value.principal.mcpAccessLevel === "minimal"
    );
  });

  const canActorReadThread = Effect.fn("TeamService.canActorReadThread")(function* (
    actor: TeamActor,
    threadId: ThreadId,
  ) {
    return yield* Effect.gen(function* () {
      const ctx = yield* resolveThreadAccessContextForActor(actor, threadId);
      if (ctx.kind === "personal") return true;
      if (ctx.kind === "wrong_team") return false;
      if (ctx.kind === "unattributed") {
        if (isMinimalAutomationActor(actor)) return false;
        if (!ctx.member || ctx.member.status !== "active") return false;
        // Post-team unattributed threads fail closed for non-admin members; pre-team legacy threads stay readable.
        return ctx.isLegacyPreTeam || isTeamAdminOrOwner(ctx.member);
      }
      if (isMinimalAutomationActor(actor)) {
        const projectIdOption = yield* repository.getThreadProjectIdInProjection(threadId);
        return yield* matchesMinimalAutomationThreadScope(
          actor.principal,
          ctx.attribution,
          Option.getOrUndefined(projectIdOption),
        );
      }
      if (!canMemberReadTeamThread({ member: ctx.member, view: ctx.view })) {
        return false;
      }
      return true;
    }).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("TeamService.canActorReadThread failed; denying access", {
          threadId,
          cause,
        }),
      ),
      Effect.orElseSucceed(() => false),
    );
  });

  const canReadThread = (sessionId: AuthSessionId, threadId: ThreadId) =>
    canActorReadThread(sessionActor(sessionId), threadId);

  const assertActorCanReadThread = Effect.fn("TeamService.assertActorCanReadThread")(function* (
    actor: TeamActor,
    threadId: ThreadId,
  ) {
    const allowed = yield* canActorReadThread(actor, threadId);
    if (!allowed) {
      return yield* teamReadAuthError();
    }
  });

  const assertCanReadThread = (sessionId: AuthSessionId, threadId: ThreadId) =>
    assertActorCanReadThread(sessionActor(sessionId), threadId);

  const canReadAttachment = Effect.fn("TeamService.canReadAttachment")(function* (
    sessionId: AuthSessionId,
    attachmentId: string,
  ) {
    return yield* Effect.gen(function* () {
      const workspaceOption = yield* repository.getWorkspace();
      if (Option.isNone(workspaceOption)) {
        return true;
      }
      const team = workspaceOption.value;
      const memberOption = yield* repository.getMemberForSession(sessionId);
      const member =
        Option.isSome(memberOption) && memberOption.value.teamId === team.id
          ? memberOption.value
          : null;
      if (!member || member.status !== "active") {
        return false;
      }
      const segment = parseThreadSegmentFromAttachmentId(attachmentId);
      if (segment === null || segment === PENDING_ATTACHMENT_THREAD_SEGMENT) {
        return true;
      }
      const matchedThreadId = yield* repository.findThreadIdByAttachmentSegment({
        teamId: team.id,
        segment,
      });
      if (Option.isNone(matchedThreadId)) {
        // Check projection for pre-team legacy threads when no attribution exists yet.
        const createdAtOption = yield* repository.getThreadCreatedAtInProjection(
          segment as ThreadId,
        );
        return (
          isPreTeamLegacyTimestamp(team, Option.getOrUndefined(createdAtOption)) ||
          isTeamAdminOrOwner(member)
        );
      }
      return yield* canReadThread(sessionId, matchedThreadId.value);
    }).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("TeamService.canReadAttachment failed; denying access", {
          attachmentId,
          cause,
        }),
      ),
      Effect.orElseSucceed(() => false),
    );
  });

  const assertCanReadAttachment = Effect.fn("TeamService.assertCanReadAttachment")(function* (
    sessionId: AuthSessionId,
    attachmentId: string,
  ) {
    const allowed = yield* canReadAttachment(sessionId, attachmentId);
    if (!allowed) {
      return yield* teamReadAuthError(
        "You do not have permission to access this thread attachment.",
      );
    }
  });

  const filterReadableThreadIdsForActor = Effect.fn("TeamService.filterReadableThreadIdsForActor")(
    function* (actor: TeamActor, threadIds: ReadonlyArray<ThreadId>) {
      if (threadIds.length === 0) {
        return new Set<ThreadId>() as ReadonlySet<ThreadId>;
      }
      return yield* Effect.gen(function* () {
        const workspaceOption = yield* repository.getWorkspace();
        if (Option.isNone(workspaceOption)) {
          return new Set<ThreadId>(threadIds) as ReadonlySet<ThreadId>;
        }
        const team = workspaceOption.value;
        const [memberOption, views, attributions] = yield* Effect.all([
          resolveMemberForActor(actor),
          repository.listViews(team.id),
          repository.listThreadAttributions(team.id),
        ]);
        const member =
          Option.isSome(memberOption) && memberOption.value.teamId === team.id
            ? memberOption.value
            : null;
        if (!member || member.status !== "active") {
          return new Set<ThreadId>() as ReadonlySet<ThreadId>;
        }
        const viewById = new Map(views.map((view) => [view.id, view] as const));
        const defaultView = viewById.get(team.defaultViewId) ?? null;
        const attributionByThreadId = new Map(
          attributions.map((attribution) => [attribution.threadId, attribution] as const),
        );
        const unattributedIds = threadIds.filter(
          (threadId) => !attributionByThreadId.has(threadId),
        );
        const createdAtByThreadId =
          unattributedIds.length > 0 &&
          !isTeamAdminOrOwner(member) &&
          !isMinimalAutomationActor(actor)
            ? yield* repository.listThreadCreatedAtInProjection(unattributedIds)
            : new Map<ThreadId, string>();
        const projectIdByThreadId = isMinimalAutomationActor(actor)
          ? yield* repository.listThreadProjectIdsInProjection(threadIds)
          : new Map<ThreadId, ProjectId>();
        const localEnv = isMinimalAutomationActor(actor)
          ? yield* resolveLocalEnvironmentIdentity()
          : null;
        const allowed = new Set<ThreadId>();
        for (const threadId of threadIds) {
          const attribution = attributionByThreadId.get(threadId);
          if (!attribution) {
            if (isMinimalAutomationActor(actor)) continue;
            if (
              isTeamAdminOrOwner(member) ||
              isPreTeamLegacyTimestamp(team, createdAtByThreadId.get(threadId))
            ) {
              allowed.add(threadId);
            }
            continue;
          }
          if (isMinimalAutomationActor(actor)) {
            const threadEnvId = attribution.executionEnvironmentId ?? localEnv!.environmentId;
            if (
              attribution.isLocalSynced === true ||
              attribution.viewId !== actor.principal.viewId ||
              threadEnvId !== actor.principal.environmentId ||
              projectIdByThreadId.get(threadId) !== actor.principal.projectId
            ) {
              continue;
            }
            allowed.add(threadId);
            continue;
          }
          const view = viewById.get(attribution.viewId) ?? defaultView;
          if (!canMemberReadTeamThread({ member, view })) {
            continue;
          }
          allowed.add(threadId);
        }
        return allowed as ReadonlySet<ThreadId>;
      }).pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("TeamService.filterReadableThreadIdsForActor failed; failing closed", {
            cause,
          }),
        ),
        Effect.orElseSucceed(() => new Set<ThreadId>() as ReadonlySet<ThreadId>),
      );
    },
  );

  const filterReadableThreadIds = (sessionId: AuthSessionId, threadIds: ReadonlyArray<ThreadId>) =>
    filterReadableThreadIdsForActor(sessionActor(sessionId), threadIds);

  const canActorPostInThread = Effect.fn("TeamService.canActorPostInThread")(function* (
    actor: TeamActor,
    threadId: ThreadId,
  ) {
    return yield* Effect.gen(function* () {
      const ctx = yield* resolveThreadAccessContextForActor(actor, threadId);
      if (ctx.kind === "personal") return true;
      if (ctx.kind === "wrong_team") return false;
      if (ctx.kind === "unattributed") {
        if (isMinimalAutomationActor(actor)) return false;
        if (!ctx.member || ctx.member.status !== "active") return false;
        return ctx.isLegacyPreTeam || isTeamAdminOrOwner(ctx.member);
      }
      if (isMinimalAutomationActor(actor)) {
        const projectIdOption = yield* repository.getThreadProjectIdInProjection(threadId);
        return yield* canMinimalAutomationPostInThread(
          actor.principal,
          threadId,
          ctx.attribution,
          Option.getOrUndefined(projectIdOption),
        );
      }
      return (
        resolveTeamThreadPostBlockReason({
          member: ctx.member,
          attribution: ctx.attribution,
          view: ctx.view,
        }) === "ok"
      );
    }).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("TeamService.canActorPostInThread failed; denying access", {
          threadId,
          cause,
        }),
      ),
      Effect.orElseSucceed(() => false),
    );
  });

  const canPostInThread = (sessionId: AuthSessionId, threadId: ThreadId) =>
    canActorPostInThread(sessionActor(sessionId), threadId);

  const assertActorCanPostInThread = Effect.fn("TeamService.assertActorCanPostInThread")(function* (
    actor: TeamActor,
    threadId: ThreadId,
    options?: { readonly upstreamCompat?: boolean },
  ) {
    const ctx = yield* resolveThreadAccessContextForActor(actor, threadId).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("TeamService.assertActorCanPostInThread failed; denying access", {
          threadId,
          cause,
        }),
      ),
      Effect.mapError(() => teamPostAuthError()),
    );
    if (ctx.kind === "personal") {
      return;
    }
    if (ctx.kind === "wrong_team") {
      return yield* teamPostAuthError();
    }
    if (ctx.kind === "unattributed") {
      if (isMinimalAutomationActor(actor)) {
        return yield* teamPostAuthError(
          "Minimal team automations can only act on threads within their configured project, environment, and view.",
        );
      }
      if (!ctx.member || ctx.member.status !== "active") {
        return yield* teamPostAuthError("This session is not bound to an active team member.");
      }
      if (!ctx.isLegacyPreTeam && !isTeamAdminOrOwner(ctx.member)) {
        return yield* teamPostAuthError();
      }
      return;
    }
    if (isMinimalAutomationActor(actor)) {
      const projectIdOption = yield* repository
        .getThreadProjectIdInProjection(threadId)
        .pipe(Effect.mapError(() => teamPostAuthError()));
      const canPost = yield* canMinimalAutomationPostInThread(
        actor.principal,
        threadId,
        ctx.attribution,
        Option.getOrUndefined(projectIdOption),
      );
      if (!canPost) {
        return yield* teamPostAuthError(
          ctx.attribution.locked
            ? "Minimal team automations cannot post into another member's locked thread."
            : "Minimal team automations can only act on threads within their configured project, environment, and view.",
        );
      }
      return;
    }
    const reason = resolveTeamThreadPostBlockReason({
      member: ctx.member,
      attribution: ctx.attribution,
      view: ctx.view,
    });
    if (reason === "ok") return;
    if (reason === "locked") {
      return yield* teamPostAuthError(
        options?.upstreamCompat === true
          ? formatUpstreamCompatLockedThreadBlockedMessage()
          : "This thread is locked. Only owners and admins can post.",
      );
    }
    if (reason === "view_read_only") {
      return yield* teamPostAuthError(
        options?.upstreamCompat === true
          ? formatUpstreamCompatReadOnlyViewBlockedMessage()
          : "You have read-only access to this view and cannot post in colleagues' threads.",
      );
    }
    return yield* teamPostAuthError();
  });

  const assertCanPostInThread = (sessionId: AuthSessionId, threadId: ThreadId) =>
    assertActorCanPostInThread(sessionActor(sessionId), threadId);

  const canActorSteerActiveTurn = Effect.fn("TeamService.canActorSteerActiveTurn")(function* (
    actor: TeamActor,
    threadId: ThreadId,
  ) {
    return yield* Effect.gen(function* () {
      const ctx = yield* resolveThreadAccessContextForActor(actor, threadId);
      if (ctx.kind === "personal") return true;
      if (ctx.kind === "wrong_team") return false;
      if (ctx.kind === "unattributed") {
        if (isMinimalAutomationActor(actor)) return false;
        if (!ctx.member || ctx.member.status !== "active") return false;
        return ctx.isLegacyPreTeam || isTeamAdminOrOwner(ctx.member);
      }
      const activeTurnAuthorKind = yield* resolveActiveTurnAuthorKind(threadId);
      return canMemberSteerActiveTeamTurn({
        member: ctx.member,
        attribution: ctx.attribution,
        view: ctx.view,
        activeTurnAuthorKind,
      });
    }).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("TeamService.canActorSteerActiveTurn failed; denying steer", {
          threadId,
          cause,
        }),
      ),
      Effect.orElseSucceed(() => false),
    );
  });

  const assertActorCanSteerActiveTurn = Effect.fn("TeamService.assertActorCanSteerActiveTurn")(
    function* (actor: TeamActor, threadId: ThreadId) {
      const allowed = yield* canActorSteerActiveTurn(actor, threadId);
      if (!allowed) {
        return yield* teamPostAuthError(
          "Only the thread creator can steer an active turn. Queue your message instead.",
        );
      }
    },
  );

  const assertActorCanPromoteQueuedRun = Effect.fn("TeamService.assertActorCanPromoteQueuedRun")(
    function* (actor: TeamActor, threadId: ThreadId) {
      const ctx = yield* resolveThreadAccessContextForActor(actor, threadId).pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("TeamService.assertActorCanPromoteQueuedRun failed; denying", {
            threadId,
            cause,
          }),
        ),
        Effect.mapError(() =>
          teamPostAuthError("Only the thread creator can send a queued message now."),
        ),
      );
      if (ctx.kind === "personal") return;
      if (ctx.kind === "wrong_team") {
        return yield* teamPostAuthError("Only the thread creator can send a queued message now.");
      }
      if (ctx.kind === "unattributed") {
        if (isMinimalAutomationActor(actor)) {
          return yield* teamPostAuthError(
            "Minimal team automations cannot promote queued messages on unattributed threads.",
          );
        }
        if (!ctx.member || ctx.member.status !== "active") {
          return yield* teamPostAuthError("This session is not bound to an active team member.");
        }
        if (!ctx.isLegacyPreTeam && !isTeamAdminOrOwner(ctx.member)) {
          return yield* teamPostAuthError("Only the thread creator can send a queued message now.");
        }
        return;
      }
      const activeTurnAuthorKind = yield* resolveActiveTurnAuthorKind(threadId);
      if (
        !canMemberPromoteTeamQueuedRun({
          member: ctx.member,
          attribution: ctx.attribution,
          view: ctx.view,
          activeTurnAuthorKind,
        })
      ) {
        return yield* teamPostAuthError(
          ctx.attribution.locked
            ? "This thread is locked. Only owners and admins can post, and queued messages cannot be promoted by non-creators."
            : "Only the thread creator can send a queued message now.",
        );
      }
    },
  );

  const assertCanPromoteQueuedRun = (sessionId: AuthSessionId, threadId: ThreadId) =>
    assertActorCanPromoteQueuedRun(sessionActor(sessionId), threadId);

  const assertActorCanInterruptThread = Effect.fn("TeamService.assertActorCanInterruptThread")(
    function* (actor: TeamActor, threadId: ThreadId, runId?: string | null) {
      const ctx = yield* resolveThreadAccessContextForActor(actor, threadId).pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("TeamService.assertActorCanInterruptThread failed; denying", {
            threadId,
            runId,
            cause,
          }),
        ),
        Effect.mapError(() =>
          teamPostAuthError(
            "Only the thread creator, active turn author, admins, or owners can interrupt this turn.",
          ),
        ),
      );
      if (ctx.kind === "personal") return;
      if (ctx.kind === "wrong_team") {
        return yield* teamPostAuthError(
          "Only the thread creator, active turn author, admins, or owners can interrupt this turn.",
        );
      }
      if (ctx.kind === "unattributed") {
        if (isMinimalAutomationActor(actor)) {
          return yield* teamPostAuthError(
            "Minimal team automations cannot interrupt unattributed threads.",
          );
        }
        if (!ctx.member || ctx.member.status !== "active") {
          return yield* teamPostAuthError("This session is not bound to an active team member.");
        }
        if (!ctx.isLegacyPreTeam && !isTeamAdminOrOwner(ctx.member)) {
          return yield* teamPostAuthError(
            "Only the thread creator, active turn author, admins, or owners can interrupt this turn.",
          );
        }
        return;
      }
      if (isMinimalAutomationActor(actor)) {
        const projectIdOption = yield* repository
          .getThreadProjectIdInProjection(threadId)
          .pipe(Effect.orElseSucceed(() => Option.none<ProjectId>()));
        const inScope = yield* matchesMinimalAutomationThreadScope(
          actor.principal,
          ctx.attribution,
          Option.getOrUndefined(projectIdOption),
        );
        if (!inScope) {
          return yield* teamPostAuthError(
            "Minimal team automations can only interrupt runs within their configured scope.",
          );
        }
        if (runId != null) {
          let activePrincipal: Option.Option<TeamTurnPrincipal> = Option.none();
          const targetRun = yield* repository
            .getRunInProjection(threadId, runId)
            .pipe(Effect.orElseSucceed(() => Option.none()));
          if (Option.isSome(targetRun) && ACTIVE_RUN_STATUSES.has(targetRun.value.status)) {
            activePrincipal = yield* resolveTurnPrincipal({
              threadId,
              runId: targetRun.value.runId,
              userMessageId: targetRun.value.userMessageId,
            });
          }
          if (
            Option.isNone(activePrincipal) ||
            activePrincipal.value.kind !== "team_automation" ||
            activePrincipal.value.principal.taskId !== actor.principal.taskId ||
            activePrincipal.value.principal.mcpAccessLevel !== "minimal"
          ) {
            return yield* teamPostAuthError(
              "Minimal team automations can only interrupt their own automation runs.",
            );
          }
          return;
        }
        const activeRun = yield* repository
          .getActiveRunInProjection(threadId)
          .pipe(Effect.orElseSucceed(() => Option.none()));
        if (Option.isSome(activeRun)) {
          const activePrincipal = yield* resolveTurnPrincipal({
            threadId,
            runId: activeRun.value.runId,
            userMessageId: activeRun.value.userMessageId,
          });
          if (
            Option.isNone(activePrincipal) ||
            activePrincipal.value.kind !== "team_automation" ||
            activePrincipal.value.principal.taskId !== actor.principal.taskId ||
            activePrincipal.value.principal.mcpAccessLevel !== "minimal"
          ) {
            return yield* teamPostAuthError(
              "Minimal team automations can only interrupt their own automation runs.",
            );
          }
          return;
        }
        // When no run is active (e.g. waiting_for_children, queued, or idle with PR watch), allow
        // stopping/cancelling only team-owned threads created by this same minimal automation task.
        if (yield* isMinimalAutomationOwnerOfThread(actor.principal, threadId, ctx.attribution)) {
          return;
        }
        return yield* teamPostAuthError(
          "Minimal team automations can only interrupt their own automation runs.",
        );
      }
      let activeTurnAuthorOption: Option.Option<TeamMemberId> = Option.none();
      if (runId != null) {
        const targetRun = yield* repository
          .getRunInProjection(threadId, runId)
          .pipe(Effect.orElseSucceed(() => Option.none()));
        // Only an actually active run grants active-turn-author interrupt rights; a past or queued run cannot.
        if (Option.isSome(targetRun) && ACTIVE_RUN_STATUSES.has(targetRun.value.status)) {
          activeTurnAuthorOption = yield* resolveTurnAuthorMemberId({
            threadId,
            runId: targetRun.value.runId,
            userMessageId: targetRun.value.userMessageId,
          });
        }
      } else {
        activeTurnAuthorOption = yield* resolveTurnAuthorMemberId({ threadId });
      }
      if (
        !canMemberInterruptTeamTurn({
          member: ctx.member,
          attribution: ctx.attribution,
          view: ctx.view,
          activeTurnAuthorMemberId: Option.getOrNull(activeTurnAuthorOption),
        })
      ) {
        return yield* teamPostAuthError(
          "Only the thread creator, active turn author, moderators (on unlocked threads), admins, or owners can interrupt this turn.",
        );
      }
    },
  );

  const assertActorCanRespondToRuntimeRequest = Effect.fn(
    "TeamService.assertActorCanRespondToRuntimeRequest",
  )(function* (actor: TeamActor, threadId: ThreadId, runId?: string | null) {
    const ctx = yield* resolveThreadAccessContextForActor(actor, threadId).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("TeamService.assertActorCanRespondToRuntimeRequest failed; denying", {
          threadId,
          cause,
        }),
      ),
      Effect.mapError(() =>
        teamPostAuthError("You do not have permission to respond to requests in this turn."),
      ),
    );
    if (ctx.kind === "personal") return;
    if (ctx.kind === "wrong_team") {
      return yield* teamPostAuthError(
        "You do not have permission to respond to requests in this turn.",
      );
    }
    if (ctx.kind === "unattributed") {
      if (isMinimalAutomationActor(actor)) {
        return yield* teamPostAuthError(
          "Minimal team automations cannot respond to requests on unattributed threads.",
        );
      }
      if (!ctx.member || ctx.member.status !== "active") {
        return yield* teamPostAuthError("This session is not bound to an active team member.");
      }
      if (!ctx.isLegacyPreTeam && !isTeamAdminOrOwner(ctx.member)) {
        return yield* teamPostAuthError(
          "You do not have permission to respond to requests in this turn.",
        );
      }
      return;
    }
    if (isMinimalAutomationActor(actor)) {
      yield* assertActorCanInterruptThread(actor, threadId, runId);
      return;
    }
    let activeTurnAuthorOption: Option.Option<TeamMemberId> = Option.none();
    if (runId != null) {
      const targetRun = yield* repository
        .getRunInProjection(threadId, runId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isSome(targetRun) && ACTIVE_RUN_STATUSES.has(targetRun.value.status)) {
        activeTurnAuthorOption = yield* resolveTurnAuthorMemberId({
          threadId,
          runId: targetRun.value.runId,
          userMessageId: targetRun.value.userMessageId,
        });
      }
    } else {
      activeTurnAuthorOption = yield* resolveTurnAuthorMemberId({ threadId });
    }
    if (
      !canMemberRespondToTeamRuntimeRequest({
        member: ctx.member,
        attribution: ctx.attribution,
        view: ctx.view,
        activeTurnAuthorMemberId: Option.getOrNull(activeTurnAuthorOption),
      })
    ) {
      return yield* teamPostAuthError(
        "Only the thread creator, active turn author, admins, or owners can respond to requests in this turn.",
      );
    }
  });

  const assertCanInterruptThread = (
    sessionId: AuthSessionId,
    threadId: ThreadId,
    runId?: string | null,
  ) => assertActorCanInterruptThread(sessionActor(sessionId), threadId, runId);

  const assertActorCanManageQueuedRun = Effect.fn("TeamService.assertActorCanManageQueuedRun")(
    function* (actor: TeamActor, threadId: ThreadId, runId: string) {
      const ctx = yield* resolveThreadAccessContextForActor(actor, threadId).pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("TeamService.assertActorCanManageQueuedRun failed; denying", {
            threadId,
            runId,
            cause,
          }),
        ),
        Effect.mapError(() =>
          teamPostAuthError("You do not have permission to modify this queued message."),
        ),
      );
      if (ctx.kind === "personal") return;
      if (ctx.kind === "wrong_team") {
        return yield* teamPostAuthError(
          "You do not have permission to modify this queued message.",
        );
      }
      if (ctx.kind === "unattributed") {
        if (isMinimalAutomationActor(actor)) {
          return yield* teamPostAuthError(
            "Minimal team automations cannot manage queued messages on unattributed threads.",
          );
        }
        if (!ctx.member || ctx.member.status !== "active") {
          return yield* teamPostAuthError("This session is not bound to an active team member.");
        }
        if (!ctx.isLegacyPreTeam && !isTeamAdminOrOwner(ctx.member)) {
          return yield* teamPostAuthError(
            "You do not have permission to modify this queued message.",
          );
        }
        return;
      }
      if (isMinimalAutomationActor(actor)) {
        const projectIdOption = yield* repository
          .getThreadProjectIdInProjection(threadId)
          .pipe(Effect.orElseSucceed(() => Option.none<ProjectId>()));
        const inScope = yield* matchesMinimalAutomationThreadScope(
          actor.principal,
          ctx.attribution,
          Option.getOrUndefined(projectIdOption),
        );
        if (!inScope) {
          return yield* teamPostAuthError(
            "Minimal team automations can only manage queued runs within their configured scope.",
          );
        }
        const queuedPrincipal = yield* resolveTurnPrincipal({ threadId, runId });
        if (
          Option.isNone(queuedPrincipal) ||
          queuedPrincipal.value.kind !== "team_automation" ||
          queuedPrincipal.value.principal.taskId !== actor.principal.taskId ||
          queuedPrincipal.value.principal.mcpAccessLevel !== "minimal"
        ) {
          return yield* teamPostAuthError(
            "Minimal team automations can only edit or cancel their own queued runs.",
          );
        }
        return;
      }
      const queuedRunAuthorOption = yield* resolveTurnAuthorMemberId({ threadId, runId });
      if (
        !canMemberManageTeamQueuedRun({
          member: ctx.member,
          attribution: ctx.attribution,
          view: ctx.view,
          queuedRunAuthorMemberId: Option.getOrNull(queuedRunAuthorOption),
        })
      ) {
        return yield* teamPostAuthError(
          "You can only edit or cancel your own queued messages unless you are the thread creator, an admin, or an owner.",
        );
      }
    },
  );

  const registerTurnInterruptHook = (hook: TeamTurnInterruptHook) =>
    Effect.sync(() => {
      turnInterruptHooks.add(hook);
      return () => {
        turnInterruptHooks.delete(hook);
      };
    });

  const registerGitHubCredentialChangeHook = (hook: TeamGitHubCredentialChangeHook) =>
    Effect.sync(() => {
      githubCredentialChangeHooks.add(hook);
      return () => {
        githubCredentialChangeHooks.delete(hook);
      };
    });

  const notifyGitHubCredentialChanged = Effect.fn("TeamService.notifyGitHubCredentialChanged")(
    function* (event: TeamGitHubCredentialChangeEvent) {
      if (githubCredentialChangeHooks.size === 0) return;
      yield* Effect.forEach(
        [...githubCredentialChangeHooks],
        (hook) =>
          hook(event).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("TeamService.githubCredentialChangeHook failed", {
                event,
                cause,
              }),
            ),
          ),
        { discard: true },
      );
    },
  );

  const notifyTurnInterrupted = Effect.fn("TeamService.notifyTurnInterrupted")(function* (input: {
    readonly actor: TeamActor;
    readonly threadId: ThreadId;
    readonly runId?: string | null;
    readonly reason: TeamTurnInterruptEvent["reason"];
  }) {
    if (turnInterruptHooks.size === 0) return;
    const workspaceOption = yield* repository
      .getWorkspace()
      .pipe(Effect.orElseSucceed(() => Option.none<TeamWorkspace>()));
    if (Option.isNone(workspaceOption)) return;
    const actorOption = yield* resolveMemberForActor(input.actor).pipe(
      Effect.orElseSucceed(() => Option.none<TeamMember>()),
    );
    if (Option.isNone(actorOption) || actorOption.value.teamId !== workspaceOption.value.id) {
      return;
    }
    const activeTurnAuthorOption = yield* resolveTurnAuthorMemberId({
      threadId: input.threadId,
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
    });
    const event: TeamTurnInterruptEvent = {
      threadId: input.threadId,
      runId: input.runId ?? null,
      actorMemberId: actorOption.value.id,
      activeTurnAuthorMemberId: Option.getOrNull(activeTurnAuthorOption),
      reason: input.reason,
    };
    yield* Effect.forEach(
      [...turnInterruptHooks],
      (hook) =>
        hook(event).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("TeamService.turnInterruptHook failed", {
              threadId: input.threadId,
              reason: input.reason,
              cause,
            }),
          ),
        ),
      { discard: true },
    );
  });

  const notifyQueuedMessage = Effect.fn("TeamService.notifyQueuedMessage")(function* (input: {
    readonly actor: TeamActor;
    readonly threadId: ThreadId;
    readonly queuedRunId: string;
    readonly commandId?: string | null;
    readonly activeRunId?: string | null;
    readonly messageText?: string | null;
  }) {
    return yield* notifyQueuedMessageLock.withPermits(1)(
      Effect.gen(function* () {
        const empty = { notifiedMemberIds: [] as ReadonlyArray<TeamMemberId> };
        const queuedRunId = input.queuedRunId.trim();
        if (queuedRunId.length === 0) return empty;
        const runKey = `run:${queuedRunId}`;
        const commandId = input.commandId?.trim() || undefined;
        const cmdKey = commandId !== undefined ? `cmd:${commandId}` : null;
        if (
          notifiedQueuedRunKeys.has(runKey) ||
          (cmdKey !== null && notifiedQueuedRunKeys.has(cmdKey))
        ) {
          return empty;
        }

        const workspaceOption = yield* repository
          .getWorkspace()
          .pipe(Effect.orElseSucceed(() => Option.none<TeamWorkspace>()));
        if (Option.isNone(workspaceOption)) return empty;
        const workspace = workspaceOption.value;

        const attributionOption = yield* repository
          .getThreadAttribution(input.threadId)
          .pipe(Effect.orElseSucceed(() => Option.none<TeamThreadAttribution>()));
        if (Option.isNone(attributionOption) || attributionOption.value.teamId !== workspace.id) {
          return empty;
        }
        const attribution = attributionOption.value;

        // Only notify when a turn was active when the message was queued. Prefer the run captured
        // at acceptance time so a fast turn finish cannot attribute recipients to the next run.
        const suppliedActiveRunId = input.activeRunId?.trim() || null;
        const effectiveSuppliedActiveRunId =
          suppliedActiveRunId !== null && suppliedActiveRunId !== queuedRunId
            ? suppliedActiveRunId
            : null;
        const activeRunOption =
          effectiveSuppliedActiveRunId !== null
            ? Option.none()
            : yield* repository
                .getActiveRunInProjection(input.threadId)
                .pipe(Effect.orElseSucceed(() => Option.none()));
        const resolvedActiveRun =
          Option.isSome(activeRunOption) && activeRunOption.value.runId !== queuedRunId
            ? activeRunOption.value
            : null;
        if (effectiveSuppliedActiveRunId === null && resolvedActiveRun === null) {
          return empty;
        }

        const activeTurnAuthorOption =
          effectiveSuppliedActiveRunId !== null
            ? yield* resolveTurnAuthorMemberId({
                threadId: input.threadId,
                runId: effectiveSuppliedActiveRunId,
              })
            : yield* resolveTurnAuthorMemberId({
                threadId: input.threadId,
                runId: resolvedActiveRun!.runId,
                userMessageId: resolvedActiveRun!.userMessageId,
              });

        const senderOption = yield* resolveMemberForActor(input.actor).pipe(
          Effect.orElseSucceed(() => Option.none<TeamMember>()),
        );
        const senderMember =
          Option.isSome(senderOption) && senderOption.value.teamId === workspace.id
            ? senderOption.value
            : null;
        const senderMemberId = senderMember?.id ?? null;

        const candidateRecipientIds = resolveTeamQueuedMessageNotificationRecipients({
          senderMemberId,
          attribution,
          activeTurnAuthorMemberId: Option.getOrNull(activeTurnAuthorOption),
        });
        if (candidateRecipientIds.length === 0) return empty;

        const [viewOption, defaultViewOption] = yield* Effect.all([
          repository
            .getViewById(attribution.viewId)
            .pipe(Effect.orElseSucceed(() => Option.none<TeamView>())),
          attribution.viewId === workspace.defaultViewId
            ? Effect.succeed(Option.none<TeamView>())
            : repository
                .getViewById(workspace.defaultViewId)
                .pipe(Effect.orElseSucceed(() => Option.none<TeamView>())),
        ]);
        const threadView = Option.getOrNull(viewOption) ?? Option.getOrNull(defaultViewOption);

        const authorizedRecipients: Array<TeamMemberId> = [];
        for (const candidateId of candidateRecipientIds) {
          const candidateOption = yield* repository
            .getMemberById(candidateId)
            .pipe(Effect.orElseSucceed(() => Option.none<TeamMember>()));
          if (
            Option.isSome(candidateOption) &&
            candidateOption.value.teamId === workspace.id &&
            candidateOption.value.status === "active" &&
            canMemberReadTeamThread({ member: candidateOption.value, view: threadView })
          ) {
            authorizedRecipients.push(candidateOption.value.id);
          }
        }
        if (authorizedRecipients.length === 0) return empty;

        rememberNotifiedQueuedKey(runKey);
        if (cmdKey !== null) rememberNotifiedQueuedKey(cmdKey);

        const senderPseudo = TrimmedNonEmptyString.make(
          senderMember?.pseudo ?? (workspace.displayName || workspace.name),
        );
        const rawPreview = (input.messageText ?? "").trim().replace(/\s+/g, " ");
        const messagePreview =
          rawPreview.length > 160 ? `${rawPreview.slice(0, 157)}…` : rawPreview;
        const createdAt = DateTime.formatIso(yield* DateTime.now);

        yield* publish({
          version: 1,
          type: "queuedMessageNotification",
          payload: {
            threadId: input.threadId,
            queuedRunId: TrimmedNonEmptyString.make(queuedRunId),
            ...(commandId !== undefined
              ? { commandId: TrimmedNonEmptyString.make(commandId) }
              : {}),
            senderMemberId,
            senderPseudo,
            recipientMemberIds: authorizedRecipients,
            messagePreview,
            createdAt,
          },
        });
        yield* PubSub.publish(notificationTriggersPubSub, {
          type: "queuedMessage",
          threadId: input.threadId,
          queuedRunId,
          senderMemberId,
          senderPseudo,
          recipientMemberIds: authorizedRecipients,
          messagePreview,
          createdAt,
        }).pipe(Effect.asVoid);

        return { notifiedMemberIds: authorizedRecipients };
      }),
    );
  });

  const assertCanCreateGuestShare = Effect.fn("TeamService.assertCanCreateGuestShare")(function* (
    sessionId: AuthSessionId,
    threadId: ThreadId,
  ) {
    const ctx = yield* resolveThreadAccessContext(sessionId, threadId).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("TeamService.assertCanCreateGuestShare failed; denying access", {
          threadId,
          cause,
        }),
      ),
      Effect.mapError(() =>
        teamAdminAuthError(
          "You do not have permission to create a guest share for this thread.",
          "team:guest_share:create",
        ),
      ),
    );
    if (ctx.kind === "personal") {
      return;
    }
    if (ctx.kind === "wrong_team") {
      return yield* teamAdminAuthError(
        "You do not have permission to create a guest share for this thread.",
        "team:guest_share:create",
      );
    }
    if (!ctx.member || ctx.member.status !== "active") {
      return yield* teamAdminAuthError(
        "This session is not bound to an active team member.",
        "team:guest_share:create",
      );
    }
    if (ctx.kind === "unattributed") {
      if (!ctx.isLegacyPreTeam && !isTeamAdminOrOwner(ctx.member)) {
        return yield* teamAdminAuthError(
          "You do not have permission to create a guest share for this thread.",
          "team:guest_share:create",
        );
      }
      return;
    }
    if (!canMemberReadTeamThread({ member: ctx.member, view: ctx.view })) {
      return yield* teamReadAuthError();
    }
    const reason = resolveTeamThreadPostBlockReason({
      member: ctx.member,
      attribution: ctx.attribution,
      view: ctx.view,
    });
    if (reason !== "ok") {
      return yield* teamPostAuthError(
        "You do not have permission to create a guest share for this thread.",
      );
    }
    const viewReadableByAllRoles =
      ctx.view !== null && ALL_TEAM_ROLES.every((role) => ctx.view!.readRule.roles.includes(role));
    if (!viewReadableByAllRoles && !isTeamAdminOrOwner(ctx.member)) {
      return yield* teamAdminAuthError(
        "Only owner and admin members can share threads from restricted views.",
        "team:guest_share:create",
      );
    }
  });

  const assertActorIsAdmin = Effect.fn("TeamService.assertActorIsAdmin")(function* (
    actor: TeamActor,
    message = "Only owner and admin members can perform this operation.",
    requiredPermission = "team:admin",
  ) {
    const workspaceOption = yield* repository.getWorkspace().pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("TeamService.assertActorIsAdmin workspace lookup failed", { cause }),
      ),
      Effect.mapError(() => teamAdminAuthError(message, requiredPermission)),
    );
    if (Option.isNone(workspaceOption)) {
      return;
    }
    const memberOption = yield* resolveMemberForActor(actor).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("TeamService.assertActorIsAdmin member lookup failed", { cause }),
      ),
      Effect.mapError(() => teamAdminAuthError(message, requiredPermission)),
    );
    const member =
      Option.isSome(memberOption) && memberOption.value.teamId === workspaceOption.value.id
        ? memberOption.value
        : null;
    if (!isTeamAdminOrOwner(member)) {
      return yield* teamAdminAuthError(message, requiredPermission);
    }
  });

  const assertActorCanUseWorkflows = (actor: TeamActor) =>
    assertActorIsAdmin(
      actor,
      "Only owner and admin members can access team workflows.",
      "team:workflows",
    );

  const assertCanUseWorkflows = (sessionId: AuthSessionId) =>
    assertActorCanUseWorkflows(sessionActor(sessionId));

  const assertActorCanUseScheduledTasks = Effect.fn("TeamService.assertActorCanUseScheduledTasks")(
    function* (actor: TeamActor) {
      const workspaceOption = yield* repository.getWorkspace().pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("TeamService.assertActorCanUseScheduledTasks workspace lookup failed", {
            cause,
          }),
        ),
        Effect.mapError(() =>
          teamAdminAuthError(
            "Only modo, admin, and owner members can manage team scheduled tasks.",
            "team:scheduled_tasks",
          ),
        ),
      );
      if (Option.isNone(workspaceOption)) return;
      if (isMinimalAutomationActor(actor)) {
        return yield* teamAdminAuthError(
          "Minimal team automations cannot manage team scheduled tasks.",
          "team:scheduled_tasks",
        );
      }
      const memberOption = yield* resolveMemberForActor(actor).pipe(
        Effect.mapError(() =>
          teamAdminAuthError(
            "Only modo, admin, and owner members can manage team scheduled tasks.",
            "team:scheduled_tasks",
          ),
        ),
      );
      const member =
        Option.isSome(memberOption) && memberOption.value.teamId === workspaceOption.value.id
          ? memberOption.value
          : null;
      if (!member || member.status !== "active" || !canManageTeamScheduledTasks(member.role)) {
        return yield* teamAdminAuthError(
          "Only modo, admin, and owner members can manage team scheduled tasks.",
          "team:scheduled_tasks",
        );
      }
    },
  );

  const assertCanUseScheduledTasks = (sessionId: AuthSessionId) =>
    assertActorCanUseScheduledTasks(sessionActor(sessionId));

  const getScheduledTaskMeta = Effect.fn("TeamService.getScheduledTaskMeta")(function* (
    taskId: ScheduledTaskId,
  ) {
    return yield* repository
      .getScheduledTaskMeta(taskId)
      .pipe(Effect.orElseSucceed(() => Option.none<TeamScheduledTaskMeta>()));
  });

  const filterReadableScheduledTasksForActor = Effect.fn(
    "TeamService.filterReadableScheduledTasksForActor",
  )(function* (actor: TeamActor, tasks: ReadonlyArray<ScheduledTask>) {
    if (tasks.length === 0) return tasks;
    return yield* Effect.gen(function* () {
      const workspaceOption = yield* repository.getWorkspace();
      if (Option.isNone(workspaceOption)) return tasks;
      const team = workspaceOption.value;
      const memberOption = yield* resolveMemberForActor(actor);
      const member =
        Option.isSome(memberOption) && memberOption.value.teamId === team.id
          ? memberOption.value
          : null;
      if (!member || member.status !== "active") return [] as ReadonlyArray<ScheduledTask>;
      yield* ensureDefaultEnvironmentForTeam(team).pipe(Effect.ignore);
      const [views, environments, metas, localEnv] = yield* Effect.all([
        repository.listViews(team.id),
        repository.listEnvironments(team.id),
        repository.listScheduledTaskMetas(team.id),
        resolveLocalEnvironmentIdentity(),
      ]);
      const viewById = new Map(views.map((view) => [view.id, view] as const));
      const defaultView = viewById.get(team.defaultViewId) ?? null;
      const envById = new Map(environments.map((env) => [env.environmentId, env] as const));
      const metaByTaskId = new Map(metas.map((meta) => [meta.taskId, meta] as const));

      const boundThreadIds = tasks.flatMap((task) =>
        task.threadId == null ? [] : [ThreadId.make(task.threadId)],
      );
      const readableBoundThreads =
        boundThreadIds.length > 0
          ? yield* filterReadableThreadIdsForActor(actor, boundThreadIds)
          : new Set<ThreadId>();

      const result: Array<ScheduledTask> = [];
      const localEnvironment = envById.get(localEnv.environmentId) ?? null;
      for (const task of tasks) {
        const meta = metaByTaskId.get(task.id);
        if (!meta) {
          // Pre-Milestone 8 / unattributed team tasks fail closed to owner/admin only.
          if (isMinimalAutomationActor(actor) || !isTeamAdminOrOwner(member)) {
            continue;
          }
          if (task.threadId !== null && !readableBoundThreads.has(ThreadId.make(task.threadId))) {
            continue;
          }
          result.push(task);
          continue;
        }
        const environmentId = meta.environmentId;
        const viewId = meta.viewId;
        const locked = meta.locked;
        const mcpAccessLevel = meta.mcpAccessLevel;
        if (isMinimalAutomationActor(actor)) {
          if (
            task.projectId !== actor.principal.projectId ||
            environmentId !== actor.principal.environmentId ||
            viewId !== actor.principal.viewId
          ) {
            continue;
          }
          if (task.threadId !== null && !readableBoundThreads.has(ThreadId.make(task.threadId))) {
            continue;
          }
          if (task.webhook !== undefined) {
            const { webhook: _redacted, ...withoutWebhook } = task;
            result.push(withoutWebhook);
          } else {
            result.push(task);
          }
          continue;
        }
        const environment = envById.get(environmentId) ?? null;
        const view = viewById.get(viewId) ?? defaultView;
        if (!canMemberReadTeamScheduledTask({ member, environment, view })) {
          continue;
        }
        if (task.threadId !== null && !readableBoundThreads.has(ThreadId.make(task.threadId))) {
          continue;
        }
        let canSeeWebhook =
          canMemberAccessTeamEnvironment(member, localEnvironment) &&
          canMemberSeeTeamScheduledTaskWebhook({
            member,
            environment,
            view,
            meta: { locked, mcpAccessLevel },
          });
        if (canSeeWebhook && task.threadId !== null && !isTeamAdminOrOwner(member)) {
          const boundThreadId = ThreadId.make(task.threadId);
          const canPostBound = yield* canActorPostInThread(actor, boundThreadId);
          const canExecBound = canPostBound
            ? yield* assertActorCanExecuteOnThreadEnvironment(actor, boundThreadId).pipe(
                Effect.as(true),
                Effect.orElseSucceed(() => false),
              )
            : false;
          canSeeWebhook = canPostBound && canExecBound;
        }
        if (!canSeeWebhook && task.webhook !== undefined) {
          const { webhook: _redacted, ...withoutWebhook } = task;
          result.push(withoutWebhook);
        } else {
          result.push(task);
        }
      }
      return result as ReadonlyArray<ScheduledTask>;
    }).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning(
          "TeamService.filterReadableScheduledTasksForActor failed; failing closed",
          {
            cause,
          },
        ),
      ),
      Effect.orElseSucceed(() => [] as ReadonlyArray<ScheduledTask>),
    );
  });

  const filterReadableScheduledTasks = (
    sessionId: AuthSessionId,
    tasks: ReadonlyArray<ScheduledTask>,
  ) => filterReadableScheduledTasksForActor(sessionActor(sessionId), tasks);

  const assertActorCanReadScheduledTask = Effect.fn("TeamService.assertActorCanReadScheduledTask")(
    function* (
      actor: TeamActor,
      taskId: ScheduledTaskId,
      boundThreadId?: ThreadId | null,
      projectId?: ProjectId | null,
    ) {
      const workspaceOption = yield* repository
        .getWorkspace()
        .pipe(Effect.mapError(() => teamReadAuthError("You cannot view this scheduled task.")));
      if (Option.isNone(workspaceOption)) return;
      const team = workspaceOption.value;
      const memberOption = yield* resolveMemberForActor(actor).pipe(
        Effect.mapError(() => teamReadAuthError("You cannot view this scheduled task.")),
      );
      const member =
        Option.isSome(memberOption) && memberOption.value.teamId === team.id
          ? memberOption.value
          : null;
      if (!member || member.status !== "active") {
        return yield* teamReadAuthError("This caller is not bound to an active team member.");
      }
      yield* ensureDefaultEnvironmentForTeam(team).pipe(Effect.ignore);
      const metaOption = yield* repository
        .getScheduledTaskMeta(taskId)
        .pipe(Effect.mapError(() => teamReadAuthError("You cannot view this scheduled task.")));
      const meta =
        Option.isSome(metaOption) && metaOption.value.teamId === team.id ? metaOption.value : null;
      if (meta === null) {
        if (isMinimalAutomationActor(actor) || !isTeamAdminOrOwner(member)) {
          return yield* teamReadAuthError(
            "You do not have permission to view this scheduled task.",
          );
        }
        if (boundThreadId !== undefined && boundThreadId !== null) {
          yield* assertActorCanReadThread(actor, boundThreadId);
        }
        return;
      }
      const environmentId = meta.environmentId;
      const viewId = meta.viewId;
      if (isMinimalAutomationActor(actor)) {
        if (
          environmentId !== actor.principal.environmentId ||
          viewId !== actor.principal.viewId ||
          (projectId !== undefined && projectId !== actor.principal.projectId)
        ) {
          return yield* teamReadAuthError(
            "Minimal team automations can only view scheduled tasks in their configured scope.",
          );
        }
        if (boundThreadId !== undefined && boundThreadId !== null) {
          yield* assertActorCanReadThread(actor, boundThreadId);
        }
        return;
      }
      const [envOption, viewOption, defaultViewOption] = yield* Effect.all([
        repository
          .getEnvironmentByEnvironmentId({ teamId: team.id, environmentId })
          .pipe(Effect.mapError(() => teamReadAuthError("You cannot view this scheduled task."))),
        repository
          .getViewById(viewId)
          .pipe(Effect.mapError(() => teamReadAuthError("You cannot view this scheduled task."))),
        viewId === team.defaultViewId
          ? Effect.succeed(Option.none<TeamView>())
          : repository
              .getViewById(team.defaultViewId)
              .pipe(
                Effect.mapError(() => teamReadAuthError("You cannot view this scheduled task.")),
              ),
      ]);
      const environment = Option.getOrNull(envOption);
      const view = Option.getOrNull(viewOption) ?? Option.getOrNull(defaultViewOption);
      if (!canMemberReadTeamScheduledTask({ member, environment, view })) {
        return yield* teamReadAuthError("You do not have permission to view this scheduled task.");
      }
      if (boundThreadId !== undefined && boundThreadId !== null) {
        yield* assertActorCanReadThread(actor, boundThreadId);
      }
    },
  );

  const assertCanReadScheduledTask = (
    sessionId: AuthSessionId,
    taskId: ScheduledTaskId,
    boundThreadId?: ThreadId | null,
    projectId?: ProjectId | null,
  ) => assertActorCanReadScheduledTask(sessionActor(sessionId), taskId, boundThreadId, projectId);

  const assertActorCanReadScheduledTaskWebhooks = Effect.fn(
    "TeamService.assertActorCanReadScheduledTaskWebhooks",
  )(function* (actor: TeamActor, taskId: ScheduledTaskId, boundThreadId?: ThreadId | null) {
    const workspaceOption = yield* repository
      .getWorkspace()
      .pipe(
        Effect.mapError(() =>
          teamReadAuthError("You cannot view webhook deliveries for this scheduled task."),
        ),
      );
    if (Option.isNone(workspaceOption)) return;
    const team = workspaceOption.value;
    if (isMinimalAutomationActor(actor)) {
      return yield* teamReadAuthError(
        "Minimal team automations cannot inspect scheduled task webhook deliveries.",
      );
    }
    const memberOption = yield* resolveMemberForActor(actor).pipe(
      Effect.mapError(() =>
        teamReadAuthError("You cannot view webhook deliveries for this scheduled task."),
      ),
    );
    const member =
      Option.isSome(memberOption) && memberOption.value.teamId === team.id
        ? memberOption.value
        : null;
    if (!member || member.status !== "active") {
      return yield* teamReadAuthError("This caller is not bound to an active team member.");
    }
    yield* ensureDefaultEnvironmentForTeam(team).pipe(Effect.ignore);
    const [metaOption, localEnv] = yield* Effect.all([
      repository
        .getScheduledTaskMeta(taskId)
        .pipe(
          Effect.mapError(() =>
            teamReadAuthError("You cannot view webhook deliveries for this scheduled task."),
          ),
        ),
      resolveLocalEnvironmentIdentity(),
    ]);
    const meta =
      Option.isSome(metaOption) && metaOption.value.teamId === team.id ? metaOption.value : null;
    if (meta === null) {
      if (!isTeamAdminOrOwner(member)) {
        return yield* teamReadAuthError(
          "You do not have permission to view webhook deliveries for this scheduled task.",
        );
      }
      if (boundThreadId !== undefined && boundThreadId !== null) {
        yield* assertActorCanReadThread(actor, boundThreadId);
      }
      return;
    }
    const [localEnvOpt, metaEnvOpt, viewOption, defaultViewOption] = yield* Effect.all([
      repository
        .getEnvironmentByEnvironmentId({ teamId: team.id, environmentId: localEnv.environmentId })
        .pipe(
          Effect.mapError(() =>
            teamReadAuthError("You cannot view webhook deliveries for this scheduled task."),
          ),
        ),
      meta.environmentId === localEnv.environmentId
        ? Effect.succeed(Option.none<TeamEnvironment>())
        : repository
            .getEnvironmentByEnvironmentId({ teamId: team.id, environmentId: meta.environmentId })
            .pipe(
              Effect.mapError(() =>
                teamReadAuthError("You cannot view webhook deliveries for this scheduled task."),
              ),
            ),
      repository
        .getViewById(meta.viewId)
        .pipe(
          Effect.mapError(() =>
            teamReadAuthError("You cannot view webhook deliveries for this scheduled task."),
          ),
        ),
      meta.viewId === team.defaultViewId
        ? Effect.succeed(Option.none<TeamView>())
        : repository
            .getViewById(team.defaultViewId)
            .pipe(
              Effect.mapError(() =>
                teamReadAuthError("You cannot view webhook deliveries for this scheduled task."),
              ),
            ),
    ]);
    const localEnvironment = Option.getOrNull(localEnvOpt);
    const metaEnvironment =
      meta.environmentId === localEnv.environmentId
        ? localEnvironment
        : Option.getOrNull(metaEnvOpt);
    const view = Option.getOrNull(viewOption) ?? Option.getOrNull(defaultViewOption);
    if (
      !canMemberAccessTeamEnvironment(member, localEnvironment) ||
      !canMemberSeeTeamScheduledTaskWebhook({
        member,
        environment: metaEnvironment,
        view,
        meta,
      })
    ) {
      return yield* teamAdminAuthError(
        "You do not have permission to view webhook deliveries for this scheduled task.",
        "team:scheduled_tasks:webhook",
      );
    }
    if (boundThreadId !== undefined && boundThreadId !== null) {
      yield* assertActorCanReadThread(actor, boundThreadId);
      yield* assertActorCanPostInThread(actor, boundThreadId);
      yield* assertActorCanExecuteOnThreadEnvironment(actor, boundThreadId);
    }
  });

  const assertCanReadScheduledTaskWebhooks = (
    sessionId: AuthSessionId,
    taskId: ScheduledTaskId,
    boundThreadId?: ThreadId | null,
  ) => assertActorCanReadScheduledTaskWebhooks(sessionActor(sessionId), taskId, boundThreadId);

  const authorizeScheduledTaskUpsertForActor = Effect.fn(
    "TeamService.authorizeScheduledTaskUpsertForActor",
  )(function* (args: {
    readonly actor: TeamActor;
    readonly input: ScheduledTaskUpsertInput;
    readonly existingTask: ScheduledTask | null;
  }): Effect.fn.Return<
    Option.Option<AuthorizedTeamScheduledTaskUpsert>,
    EnvironmentAuthorizationError
  > {
    const workspaceOption = yield* repository
      .getWorkspace()
      .pipe(
        Effect.mapError(() =>
          teamPostAuthError("Could not verify team permissions for scheduled task."),
        ),
      );
    if (Option.isNone(workspaceOption)) {
      return Option.none<AuthorizedTeamScheduledTaskUpsert>();
    }
    const team = workspaceOption.value;
    if (isMinimalAutomationActor(args.actor)) {
      return yield* teamPostAuthError(
        "Minimal team automations cannot create or modify team scheduled tasks.",
      );
    }
    const memberOption = yield* resolveMemberForActor(args.actor).pipe(
      Effect.mapError(() =>
        teamPostAuthError("Could not verify team membership for scheduled task."),
      ),
    );
    const member =
      Option.isSome(memberOption) && memberOption.value.teamId === team.id
        ? memberOption.value
        : null;
    if (!member || member.status !== "active") {
      return yield* teamPostAuthError("This caller is not bound to an active team member.");
    }
    if (!canManageTeamScheduledTasks(member.role)) {
      return yield* teamPostAuthError(
        "Only modo, admin, and owner members can create or edit team scheduled tasks.",
      );
    }
    yield* ensureDefaultEnvironmentForTeam(team).pipe(Effect.ignore);
    const localEnv = yield* resolveLocalEnvironmentIdentity();
    if (
      args.input.teamMeta?.environmentId !== undefined &&
      args.input.teamMeta.environmentId !== localEnv.environmentId
    ) {
      return yield* teamPostAuthError(
        "Scheduled tasks can only be configured for the host environment handling this request.",
      );
    }
    const localEnvOpt = yield* repository
      .getEnvironmentByEnvironmentId({ teamId: team.id, environmentId: localEnv.environmentId })
      .pipe(
        Effect.mapError(() =>
          teamPostAuthError("Could not verify host environment permissions for scheduled task."),
        ),
      );
    const targetEnv = Option.getOrNull(localEnvOpt);
    if (targetEnv === null || !canMemberAccessTeamEnvironment(member, targetEnv)) {
      return yield* teamPostAuthError(
        "You do not have permission to schedule tasks on this team environment.",
      );
    }
    const existingMetaOption =
      args.existingTask !== null
        ? yield* repository
            .getScheduledTaskMeta(args.existingTask.id)
            .pipe(
              Effect.mapError(() =>
                teamPostAuthError("Could not verify existing scheduled task permissions."),
              ),
            )
        : Option.none<TeamScheduledTaskMeta>();
    const existingMeta =
      Option.isSome(existingMetaOption) && existingMetaOption.value.teamId === team.id
        ? existingMetaOption.value
        : null;

    if (args.existingTask !== null) {
      if (existingMeta === null) {
        if (!isTeamAdminOrOwner(member)) {
          return yield* teamAdminAuthError(
            "Only owner and admin members can modify unattributed scheduled tasks.",
            "team:scheduled_tasks:write",
          );
        }
      } else {
        const existingEnvId = existingMeta.environmentId;
        const existingViewId = existingMeta.viewId;
        const [existingEnvOpt, existingViewOpt, defaultViewOpt] = yield* Effect.all([
          existingEnvId === localEnv.environmentId
            ? Effect.succeed(localEnvOpt)
            : repository
                .getEnvironmentByEnvironmentId({ teamId: team.id, environmentId: existingEnvId })
                .pipe(
                  Effect.mapError(() =>
                    teamPostAuthError("Could not verify existing scheduled task environment."),
                  ),
                ),
          repository
            .getViewById(existingViewId)
            .pipe(
              Effect.mapError(() =>
                teamPostAuthError("Could not verify existing scheduled task view."),
              ),
            ),
          existingViewId === team.defaultViewId
            ? Effect.succeed(Option.none<TeamView>())
            : repository
                .getViewById(team.defaultViewId)
                .pipe(
                  Effect.mapError(() =>
                    teamPostAuthError("Could not verify existing scheduled task default view."),
                  ),
                ),
        ]);
        const existingEnv = Option.getOrNull(existingEnvOpt);
        const existingView = Option.getOrNull(existingViewOpt) ?? Option.getOrNull(defaultViewOpt);
        if (
          !canMemberMutateTeamScheduledTask({
            member,
            environment: existingEnv,
            view: existingView,
            existingMeta,
          })
        ) {
          return yield* teamAdminAuthError(
            existingMeta.locked === true || existingMeta.mcpAccessLevel === "elevated"
              ? "Only owner and admin members can modify locked or elevated scheduled tasks."
              : "You do not have permission to edit this team scheduled task.",
            "team:scheduled_tasks:write",
          );
        }
      }
      if (args.existingTask.threadId !== null) {
        const existingBoundThreadId = ThreadId.make(args.existingTask.threadId);
        yield* assertActorCanReadThread(args.actor, existingBoundThreadId);
        yield* assertActorCanPostInThread(args.actor, existingBoundThreadId);
        yield* assertActorCanExecuteOnThreadEnvironment(args.actor, existingBoundThreadId);
      }
    }

    const resolvedViewId =
      args.input.teamMeta?.viewId ??
      existingMeta?.viewId ??
      (yield* resolveDefaultViewIdForProject(team, args.input.projectId));
    const targetViewOpt = yield* repository
      .getViewById(resolvedViewId)
      .pipe(
        Effect.mapError(() =>
          teamPostAuthError("Could not verify target view for scheduled task."),
        ),
      );
    const targetView =
      Option.isSome(targetViewOpt) && targetViewOpt.value.teamId === team.id
        ? targetViewOpt.value
        : null;
    if (targetView === null || !canMemberReadTeamView(member, targetView)) {
      return yield* teamPostAuthError(
        "You do not have access to the selected target view for this scheduled task.",
      );
    }

    const nextLocked = args.input.teamMeta?.locked ?? existingMeta?.locked ?? false;
    const nextMcpAccessLevel =
      args.input.teamMeta?.mcpAccessLevel ?? existingMeta?.mcpAccessLevel ?? "minimal";
    if (
      (nextLocked || nextMcpAccessLevel === "elevated") &&
      !canManagePrivilegedTeamScheduledTasks(member.role)
    ) {
      return yield* teamAdminAuthError(
        "Only owner and admin members can configure locked threads or elevated MCP access on scheduled tasks.",
        "team:scheduled_tasks:privileged",
      );
    }

    const effectiveBoundThreadId = resolveScheduledTaskEffectiveThreadId(
      args.input,
      args.existingTask,
    );
    if (effectiveBoundThreadId !== null && effectiveBoundThreadId !== args.existingTask?.threadId) {
      const boundThreadId = ThreadId.make(effectiveBoundThreadId);
      yield* assertActorCanReadThread(args.actor, boundThreadId);
      yield* assertActorCanPostInThread(args.actor, boundThreadId);
      yield* assertActorCanExecuteOnThreadEnvironment(args.actor, boundThreadId);
    }

    return Option.some<AuthorizedTeamScheduledTaskUpsert>({
      teamId: team.id,
      environmentId: targetEnv.environmentId,
      viewId: targetView.id,
      locked: nextLocked,
      mcpAccessLevel: nextMcpAccessLevel,
      actorMemberId: args.actor.kind === "team_automation" ? null : member.id,
    });
  });

  const authorizeScheduledTaskUpsert = (input: {
    readonly sessionId: AuthSessionId;
    readonly input: ScheduledTaskUpsertInput;
    readonly existingTask: ScheduledTask | null;
  }) =>
    authorizeScheduledTaskUpsertForActor({
      actor: sessionActor(input.sessionId),
      input: input.input,
      existingTask: input.existingTask,
    });

  const persistScheduledTaskMeta = Effect.fn("TeamService.persistScheduledTaskMeta")(function* (
    input: AuthorizedTeamScheduledTaskUpsert & { readonly taskId: ScheduledTaskId },
  ) {
    const nowIso = DateTime.formatIso(yield* DateTime.now);
    return yield* repository.upsertScheduledTaskMeta({
      taskId: input.taskId,
      teamId: input.teamId,
      environmentId: input.environmentId,
      viewId: input.viewId,
      locked: input.locked,
      mcpAccessLevel: input.mcpAccessLevel,
      createdByMemberId: input.actorMemberId,
      updatedByMemberId: input.actorMemberId,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
  });

  const publishScheduledTaskMeta = Effect.fn("TeamService.publishScheduledTaskMeta")(function* (
    meta: TeamScheduledTaskMeta,
  ) {
    yield* publish({
      version: 1,
      type: "scheduledTaskMetaUpserted",
      payload: meta,
    });
    yield* publishAccessChange({ type: "scheduledTaskMeta", taskId: meta.taskId });
  });

  const saveScheduledTaskMeta = Effect.fn("TeamService.saveScheduledTaskMeta")(function* (
    input: AuthorizedTeamScheduledTaskUpsert & { readonly taskId: ScheduledTaskId },
  ) {
    const saved = yield* persistScheduledTaskMeta(input);
    yield* publishScheduledTaskMeta(saved);
    return saved;
  });

  const deleteScheduledTaskMeta = Effect.fn("TeamService.deleteScheduledTaskMeta")(function* (
    taskId: ScheduledTaskId,
  ) {
    const deleted = yield* repository
      .deleteScheduledTaskMeta(taskId)
      .pipe(Effect.orElseSucceed(() => false));
    if (deleted) {
      yield* publish({
        version: 1,
        type: "scheduledTaskMetaDeleted",
        payload: { taskId },
      });
      yield* publishAccessChange({ type: "scheduledTaskMeta", taskId });
    }
  });

  const assertActorCanMutateScheduledTask = Effect.fn(
    "TeamService.assertActorCanMutateScheduledTask",
  )(function* (
    actor: TeamActor,
    taskId: ScheduledTaskId,
    boundThreadId?: ThreadId | null,
    _options?: { readonly isRunNow?: boolean },
  ) {
    const workspaceOption = yield* repository
      .getWorkspace()
      .pipe(
        Effect.mapError(() =>
          teamPostAuthError("Could not verify team permissions for scheduled task."),
        ),
      );
    if (Option.isNone(workspaceOption)) return;
    const team = workspaceOption.value;
    if (isMinimalAutomationActor(actor)) {
      return yield* teamPostAuthError(
        "Minimal team automations cannot modify or run team scheduled tasks.",
      );
    }
    const memberOption = yield* resolveMemberForActor(actor).pipe(
      Effect.mapError(() =>
        teamPostAuthError("Could not verify team membership for scheduled task."),
      ),
    );
    const member =
      Option.isSome(memberOption) && memberOption.value.teamId === team.id
        ? memberOption.value
        : null;
    if (!member || member.status !== "active") {
      return yield* teamPostAuthError("This caller is not bound to an active team member.");
    }
    if (!canManageTeamScheduledTasks(member.role)) {
      return yield* teamPostAuthError(
        "Only modo, admin, and owner members can modify or run team scheduled tasks.",
      );
    }
    yield* ensureDefaultEnvironmentForTeam(team).pipe(Effect.ignore);
    const [metaOption, localEnv] = yield* Effect.all([
      repository
        .getScheduledTaskMeta(taskId)
        .pipe(
          Effect.mapError(() =>
            teamPostAuthError("Could not verify team scheduled task metadata."),
          ),
        ),
      resolveLocalEnvironmentIdentity(),
    ]);
    const localEnvOption = yield* repository
      .getEnvironmentByEnvironmentId({ teamId: team.id, environmentId: localEnv.environmentId })
      .pipe(
        Effect.mapError(() =>
          teamPostAuthError("Could not verify host environment permissions for scheduled task."),
        ),
      );
    const localEnvironment = Option.getOrNull(localEnvOption);
    if (!canMemberAccessTeamEnvironment(member, localEnvironment)) {
      return yield* teamAdminAuthError(
        "You do not have permission to manage scheduled tasks on this team environment.",
        "team:scheduled_tasks:write",
      );
    }
    const meta =
      Option.isSome(metaOption) && metaOption.value.teamId === team.id ? metaOption.value : null;
    if (meta === null) {
      if (!isTeamAdminOrOwner(member)) {
        return yield* teamAdminAuthError(
          "Only owner and admin members can manage unattributed scheduled tasks.",
          "team:scheduled_tasks:write",
        );
      }
      if (boundThreadId !== undefined && boundThreadId !== null) {
        yield* assertActorCanReadThread(actor, boundThreadId);
        yield* assertActorCanPostInThread(actor, boundThreadId);
        yield* assertActorCanExecuteOnThreadEnvironment(actor, boundThreadId);
      }
      return;
    }
    const environmentId = meta.environmentId;
    const viewId = meta.viewId;
    const [envOption, viewOption, defaultViewOption] = yield* Effect.all([
      environmentId === localEnv.environmentId
        ? Effect.succeed(localEnvOption)
        : repository
            .getEnvironmentByEnvironmentId({ teamId: team.id, environmentId })
            .pipe(
              Effect.mapError(() =>
                teamPostAuthError("Could not verify scheduled task environment permissions."),
              ),
            ),
      repository
        .getViewById(viewId)
        .pipe(
          Effect.mapError(() =>
            teamPostAuthError("Could not verify scheduled task view permissions."),
          ),
        ),
      viewId === team.defaultViewId
        ? Effect.succeed(Option.none<TeamView>())
        : repository
            .getViewById(team.defaultViewId)
            .pipe(
              Effect.mapError(() =>
                teamPostAuthError("Could not verify scheduled task default view permissions."),
              ),
            ),
    ]);
    const environment = Option.getOrNull(envOption);
    const view = Option.getOrNull(viewOption) ?? Option.getOrNull(defaultViewOption);
    if (
      !canMemberMutateTeamScheduledTask({
        member,
        environment,
        view,
        existingMeta: meta,
      })
    ) {
      return yield* teamAdminAuthError(
        meta.locked === true || meta.mcpAccessLevel === "elevated"
          ? "Only owner and admin members can manage locked or elevated scheduled tasks."
          : "You do not have permission to manage this team scheduled task.",
        "team:scheduled_tasks:write",
      );
    }
    if (boundThreadId !== undefined && boundThreadId !== null) {
      yield* assertActorCanReadThread(actor, boundThreadId);
      yield* assertActorCanPostInThread(actor, boundThreadId);
      yield* assertActorCanExecuteOnThreadEnvironment(actor, boundThreadId);
    }
  });

  const assertCanMutateScheduledTask = (
    sessionId: AuthSessionId,
    taskId: ScheduledTaskId,
    boundThreadId?: ThreadId | null,
    options?: { readonly isRunNow?: boolean },
  ) => assertActorCanMutateScheduledTask(sessionActor(sessionId), taskId, boundThreadId, options);

  const assertActorCanCreateThreadInView = Effect.fn(
    "TeamService.assertActorCanCreateThreadInView",
  )(function* (input: {
    readonly actor: TeamActor;
    readonly viewId?: TeamViewId;
    readonly locked?: boolean;
    readonly projectId?: ProjectId;
  }) {
    const workspaceOption = yield* repository.getWorkspace().pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("TeamService.assertActorCanCreateThreadInView workspace lookup failed", {
          cause,
        }),
      ),
      Effect.mapError(() => teamPostAuthError()),
    );
    if (Option.isNone(workspaceOption)) {
      return;
    }
    const team = workspaceOption.value;
    const memberOption = yield* resolveMemberForActor(input.actor).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("TeamService.assertActorCanCreateThreadInView member lookup failed", {
          cause,
        }),
      ),
      Effect.mapError(() => teamPostAuthError()),
    );
    const member =
      Option.isSome(memberOption) && memberOption.value.teamId === team.id
        ? memberOption.value
        : null;
    if (!member || member.status !== "active") {
      return yield* teamPostAuthError("This session is not bound to an active team member.");
    }
    const targetViewId = input.viewId ?? team.defaultViewId;
    if (isMinimalAutomationActor(input.actor)) {
      if (targetViewId !== input.actor.principal.viewId) {
        return yield* teamPostAuthError(
          "Minimal team automations can only launch threads in their configured view.",
        );
      }
      if (input.projectId !== undefined && input.projectId !== input.actor.principal.projectId) {
        return yield* teamPostAuthError(
          "Minimal team automations can only launch threads in their configured project.",
        );
      }
      const viewOption = yield* repository.getViewById(targetViewId).pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("TeamService.assertActorCanCreateThreadInView view lookup failed", {
            targetViewId,
            cause,
          }),
        ),
        Effect.mapError(() => teamPostAuthError()),
      );
      if (Option.isNone(viewOption) || viewOption.value.teamId !== team.id) {
        return yield* teamPostAuthError(
          "You do not have permission to create a thread in this view.",
        );
      }
      return;
    }
    if (input.locked === true && !canToggleTeamThreadLock(member.role)) {
      return yield* teamPostAuthError("Only owner and admin members can create locked threads.");
    }
    const viewOption = yield* repository.getViewById(targetViewId).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("TeamService.assertActorCanCreateThreadInView view lookup failed", {
          targetViewId,
          cause,
        }),
      ),
      Effect.mapError(() => teamPostAuthError()),
    );
    const view =
      Option.isSome(viewOption) && viewOption.value.teamId === team.id ? viewOption.value : null;
    if (!canMemberCreateThreadInTeamView(member, view, input.locked === true)) {
      return yield* teamPostAuthError(
        "You do not have permission to create a thread in this view.",
      );
    }
  });

  const assertCanCreateThreadInView = (input: {
    readonly sessionId: AuthSessionId;
    readonly viewId?: TeamViewId;
    readonly locked?: boolean;
  }) =>
    assertActorCanCreateThreadInView({
      actor: sessionActor(input.sessionId),
      ...(input.viewId !== undefined ? { viewId: input.viewId } : {}),
      ...(input.locked !== undefined ? { locked: input.locked } : {}),
    });

  const assertCanLaunchThread = Effect.fn("TeamService.assertCanLaunchThread")(function* (input: {
    readonly sessionId: AuthSessionId;
    readonly threadId?: ThreadId;
    readonly projectId?: ProjectId;
    readonly reuseExistingThread?: boolean;
    readonly viewId?: TeamViewId;
    readonly locked?: boolean;
  }) {
    if (input.reuseExistingThread === true && input.threadId !== undefined) {
      yield* assertCanPostInThread(input.sessionId, input.threadId);
      yield* assertCanExecuteOnThreadEnvironment(input.sessionId, input.threadId);
      return;
    }
    const workspaceOption = yield* repository.getWorkspace().pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("TeamService.assertCanLaunchThread(getWorkspace) failed", { cause }),
      ),
      Effect.mapError(() => teamPostAuthError("Could not verify team environment permissions.")),
    );
    if (Option.isSome(workspaceOption)) {
      const localEnv = yield* resolveLocalEnvironmentIdentity();
      yield* assertActorCanAccessEnvironment(sessionActor(input.sessionId), localEnv.environmentId);
    }
    let resolvedViewId = input.viewId;
    if (resolvedViewId === undefined && input.projectId !== undefined) {
      const projectAssignment = yield* repository.getProjectAssignment(input.projectId).pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("TeamService.assertCanLaunchThread(getProjectAssignment) failed", {
            projectId: input.projectId,
            cause,
          }),
        ),
        Effect.mapError(() => teamPostAuthError("Could not verify team project view permissions.")),
      );
      if (Option.isSome(projectAssignment) && projectAssignment.value.defaultViewId !== null) {
        resolvedViewId = projectAssignment.value.defaultViewId;
      }
    }
    yield* assertCanCreateThreadInView({
      sessionId: input.sessionId,
      ...(resolvedViewId !== undefined ? { viewId: resolvedViewId } : {}),
      ...(input.locked !== undefined ? { locked: input.locked } : {}),
    });
  });

  const assertAndNormalizeDispatchCommand = Effect.fn(
    "TeamService.assertAndNormalizeDispatchCommand",
  )(function* (
    sessionId: AuthSessionId,
    command: OrchestrationV2Command,
    options?: { readonly upstreamCompat?: boolean },
  ): Effect.fn.Return<OrchestrationV2Command, EnvironmentAuthorizationError> {
    if (!(yield* isTeamConfigured())) {
      return command;
    }
    const actor = sessionActor(sessionId);
    const upstreamCompat = options?.upstreamCompat === true;
    const compatOptions = upstreamCompat ? { upstreamCompat: true as const } : undefined;
    const normalizeCompatTitle = (cmd: OrchestrationV2Command) =>
      stripTitlePrefixOnCompatCommand(
        { isTeamConfigured, getThreadTitlePrefixContextMap },
        cmd,
        upstreamCompat,
      );
    switch (command.type) {
      case "thread.create": {
        const localEnv = yield* resolveLocalEnvironmentIdentity();
        yield* assertActorCanAccessEnvironment(actor, localEnv.environmentId);
        const projectAssignment = yield* repository.getProjectAssignment(command.projectId).pipe(
          Effect.tapError((cause) =>
            Effect.logWarning(
              "TeamService.assertAndNormalizeDispatchCommand(thread.create) failed",
              { projectId: command.projectId, cause },
            ),
          ),
          Effect.mapError(() =>
            teamPostAuthError("Could not verify team project view permissions."),
          ),
        );
        const defaultViewId =
          Option.isSome(projectAssignment) && projectAssignment.value.defaultViewId !== null
            ? projectAssignment.value.defaultViewId
            : undefined;
        yield* assertActorCanCreateThreadInView({
          actor,
          ...(defaultViewId !== undefined ? { viewId: defaultViewId } : {}),
        });
        return command;
      }
      case "thread.visit":
      case "thread.mark-unread":
        yield* assertActorCanReadThread(actor, command.threadId);
        return command;
      case "thread.delete": {
        const ctx = yield* resolveThreadAccessContextForActor(actor, command.threadId).pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("TeamService.assertCanDispatchCommand(thread.delete) failed", {
              threadId: command.threadId,
              cause,
            }),
          ),
          Effect.mapError(() =>
            teamPostAuthError("You do not have permission to delete this thread."),
          ),
        );
        if (ctx.kind === "personal") return command;
        if (ctx.kind === "wrong_team") {
          return yield* teamPostAuthError("You do not have permission to delete this thread.");
        }
        if (!ctx.member || ctx.member.status !== "active") {
          return yield* teamPostAuthError("This session is not bound to an active team member.");
        }
        if (ctx.kind === "unattributed") {
          if (!ctx.isLegacyPreTeam && !isTeamAdminOrOwner(ctx.member)) {
            return yield* teamPostAuthError("You do not have permission to delete this thread.");
          }
          return command;
        }
        if (!isTeamAdminOrOwner(ctx.member) && ctx.attribution.creatorMemberId !== ctx.member.id) {
          return yield* teamPostAuthError(
            "Only the thread creator, admins, or owners can delete this thread.",
          );
        }
        if (!isTeamAdminOrOwner(ctx.member) && ctx.attribution.locked) {
          return yield* teamPostAuthError(
            "This thread is locked. Only owners and admins can delete it.",
          );
        }
        return command;
      }
      case "thread.fork": {
        const sourceCtx = yield* resolveThreadAccessContextForActor(
          actor,
          command.sourceThreadId,
        ).pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("TeamService.assertCanDispatchCommand(thread.fork) failed", {
              sourceThreadId: command.sourceThreadId,
              cause,
            }),
          ),
          Effect.mapError(() => teamReadAuthError()),
        );
        if (sourceCtx.kind === "personal") return command;
        const localEnv = yield* resolveLocalEnvironmentIdentity();
        yield* assertActorCanAccessEnvironment(actor, localEnv.environmentId);
        yield* assertActorCanReadThread(actor, command.sourceThreadId);
        const inheritedViewId =
          sourceCtx.kind === "team_thread" ? sourceCtx.attribution.viewId : undefined;
        yield* assertActorCanCreateThreadInView({
          actor,
          ...(inheritedViewId !== undefined ? { viewId: inheritedViewId } : {}),
        });
        return yield* normalizeCompatTitle(command);
      }
      case "thread.merge_back":
        yield* assertActorCanReadThread(actor, command.sourceThreadId);
        yield* assertActorCanPostInThread(actor, command.targetThreadId, compatOptions);
        yield* assertActorCanExecuteOnThreadEnvironment(
          actor,
          command.targetThreadId,
          compatOptions,
        );
        return command;
      case "message.dispatch": {
        yield* assertActorCanPostInThread(actor, command.threadId, compatOptions);
        yield* assertActorCanExecuteOnThreadEnvironment(actor, command.threadId, compatOptions);
        const effectiveCommand = command;
        if (
          effectiveCommand.dispatchMode.type === "steer_active" ||
          effectiveCommand.dispatchMode.type === "restart_active" ||
          effectiveCommand.deliveryIntent === "steer" ||
          effectiveCommand.deliveryIntent === "restart"
        ) {
          yield* assertActorCanSteerActiveTurn(actor, effectiveCommand.threadId);
          return effectiveCommand;
        }
        const canSteer = yield* canActorSteerActiveTurn(actor, effectiveCommand.threadId);
        if (!canSteer) {
          // Strip deliveryIntent and force queue_after_active so non-creators never auto-steer or restart.
          const { deliveryIntent: _stripped, ...withoutDeliveryIntent } = effectiveCommand;
          return {
            ...withoutDeliveryIntent,
            dispatchMode: { type: "queue_after_active" },
          };
        }
        return effectiveCommand;
      }
      case "queued-message.promote-to-steer":
      case "queued-run.start":
        yield* assertActorCanExecuteOnThreadEnvironment(actor, command.threadId, compatOptions);
        yield* assertActorCanPromoteQueuedRun(actor, command.threadId);
        return command;
      case "run.interrupt":
      case "subagent.stop":
        yield* assertActorCanExecuteOnThreadEnvironment(actor, command.threadId, compatOptions);
        yield* assertActorCanInterruptThread(actor, command.threadId, command.runId);
        return command;
      case "thread.stop":
        yield* assertActorCanExecuteOnThreadEnvironment(actor, command.threadId, compatOptions);
        yield* assertActorCanInterruptThread(actor, command.threadId);
        return command;
      case "runtime-request.respond":
      case "thread.user-input.dismiss":
        yield* assertActorCanExecuteOnThreadEnvironment(actor, command.threadId, compatOptions);
        yield* assertActorCanRespondToRuntimeRequest(actor, command.threadId);
        return command;
      case "queued-run.edit":
      case "queued-run.cancel":
      case "queued-run.reorder":
        yield* assertActorCanPostInThread(actor, command.threadId, compatOptions);
        yield* assertActorCanExecuteOnThreadEnvironment(actor, command.threadId, compatOptions);
        yield* assertActorCanManageQueuedRun(actor, command.threadId, command.runId);
        return command;
      case "delegated_task.request":
      case "delegated_task.wake-policy":
      case "delegated_task.completion-delivery.acknowledge":
      case "delegated_task.completion-delivery.dispose":
      case "thread.created.record":
        yield* assertActorCanPostInThread(actor, command.parentThreadId, compatOptions);
        yield* assertActorCanExecuteOnThreadEnvironment(
          actor,
          command.parentThreadId,
          compatOptions,
        );
        return command;
      case "thread.metadata.update":
        yield* assertActorCanPostInThread(actor, command.threadId, compatOptions);
        if (command.continuation !== undefined) {
          yield* assertActorCanExecuteOnThreadEnvironment(actor, command.threadId, compatOptions);
        }
        return yield* normalizeCompatTitle(command);
      case "thread.archive":
      case "thread.unarchive":
      case "thread.unsettle":
      case "thread.snooze":
      case "thread.unsnooze":
      case "thread.auto-settle.set":
      case "thread.pin":
      case "thread.unpin":
      case "thread.tag.set":
      case "thread.pin.reorder":
      case "thread.active.reorder":
      case "thread.pull-request.link":
      case "thread.pull-request.unlink":
      case "thread.pull-request-link.sync":
      case "thread.issue.link":
      case "thread.issue.unlink":
      case "thread.title.regeneration.complete":
      case "thread.guest-share.close":
      case "thread.guest-message.dismiss":
        yield* assertActorCanPostInThread(actor, command.threadId, compatOptions);
        return command;
      default:
        // Fail closed for all remaining execution-capable commands (including thread.settle /
        // thread.auto-settle which close terminals and execute project settle scripts,
        // prepared-run.retry, queue.resume, checkpoint.rollback, provider.switch, etc.).
        yield* assertActorCanPostInThread(actor, command.threadId, compatOptions);
        yield* assertActorCanExecuteOnThreadEnvironment(actor, command.threadId, compatOptions);
        return command;
    }
  });

  const assertCanDispatchCommand = (sessionId: AuthSessionId, command: OrchestrationV2Command) =>
    assertAndNormalizeDispatchCommand(sessionId, command).pipe(Effect.asVoid);

  const listThreadAttributions = Effect.fn("TeamService.listThreadAttributions")(function* (
    sessionId?: AuthSessionId,
  ) {
    const workspaceOption = yield* repository.getWorkspace();
    if (Option.isNone(workspaceOption)) {
      return [];
    }
    const attributions = yield* repository.listThreadAttributions(workspaceOption.value.id);
    if (sessionId === undefined) {
      return attributions;
    }
    const readableIds = yield* filterReadableThreadIds(
      sessionId,
      attributions.map((item) => item.threadId),
    );
    return attributions.filter((item) => readableIds.has(item.threadId));
  }, Effect.mapError(toInternalError));

  const followThread = Effect.fn("TeamService.followThread")(function* (input: {
    readonly sessionId: AuthSessionId;
    readonly payload: TeamThreadFollowInput;
  }) {
    const team = yield* requireWorkspace();
    const actor = yield* requireActiveMember(input.sessionId);
    if (actor.teamId !== team.id) {
      return yield* new TeamOperationError({
        code: "forbidden",
        message: "This session does not belong to the active team.",
      });
    }
    const attribution = yield* repository
      .getThreadAttribution(input.payload.threadId)
      .pipe(Effect.mapError(toInternalError));
    if (Option.isSome(attribution)) {
      if (attribution.value.teamId !== team.id) {
        return yield* new TeamOperationError({
          code: "forbidden",
          message: "You cannot follow a thread belonging to another team.",
        });
      }
      const readable = yield* canReadThread(input.sessionId, input.payload.threadId);
      if (!readable) {
        return yield* new TeamOperationError({
          code: "forbidden",
          message: "You do not have permission to view this thread.",
        });
      }
      if (attribution.value.creatorMemberId === actor.id) {
        return yield* new TeamOperationError({
          code: "forbidden",
          message: "You already receive notifications for threads you created.",
        });
      }
      const deleted = yield* repository
        .isThreadDeletedInProjection(input.payload.threadId)
        .pipe(Effect.mapError(toInternalError));
      if (deleted) {
        return yield* new TeamOperationError({
          code: "not_found",
          message: "Thread not found.",
        });
      }
    } else {
      const exists = yield* repository
        .threadExistsInProjection(input.payload.threadId)
        .pipe(Effect.mapError(toInternalError));
      if (!exists) {
        return yield* new TeamOperationError({
          code: "not_found",
          message: "Thread not found.",
        });
      }
      const readable = yield* canReadThread(input.sessionId, input.payload.threadId);
      if (!readable) {
        return yield* new TeamOperationError({
          code: "forbidden",
          message: "You do not have permission to view this thread.",
        });
      }
    }
    const nowIso = DateTime.formatIso(yield* DateTime.now);
    const inserted = yield* repository
      .followThread({
        threadId: input.payload.threadId,
        memberId: actor.id,
        createdAt: nowIso,
      })
      .pipe(Effect.mapError(toInternalError));
    if (inserted) {
      yield* publish({
        version: 1,
        type: "threadFollowChanged",
        payload: {
          threadId: input.payload.threadId,
          memberId: actor.id,
          isFollowing: true,
        },
      });
      yield* publishAccessChange({
        type: "memberFollow",
        memberId: actor.id,
        threadId: input.payload.threadId,
      });
    }
    return { threadId: input.payload.threadId, isFollowing: true } satisfies TeamThreadFollowResult;
  });

  const unfollowThread = Effect.fn("TeamService.unfollowThread")(function* (input: {
    readonly sessionId: AuthSessionId;
    readonly payload: TeamThreadFollowInput;
  }) {
    const team = yield* requireWorkspace();
    const actor = yield* requireActiveMember(input.sessionId);
    if (actor.teamId !== team.id) {
      return yield* new TeamOperationError({
        code: "forbidden",
        message: "This session does not belong to the active team.",
      });
    }
    const attribution = yield* repository
      .getThreadAttribution(input.payload.threadId)
      .pipe(Effect.mapError(toInternalError));
    if (Option.isSome(attribution) && attribution.value.teamId !== team.id) {
      return yield* new TeamOperationError({
        code: "forbidden",
        message: "You cannot unfollow a thread belonging to another team.",
      });
    }
    const removed = yield* repository
      .unfollowThread({
        threadId: input.payload.threadId,
        memberId: actor.id,
      })
      .pipe(Effect.mapError(toInternalError));
    if (removed) {
      yield* publish({
        version: 1,
        type: "threadFollowChanged",
        payload: {
          threadId: input.payload.threadId,
          memberId: actor.id,
          isFollowing: false,
        },
      });
      yield* publishAccessChange({
        type: "memberFollow",
        memberId: actor.id,
        threadId: input.payload.threadId,
      });
    }
    return {
      threadId: input.payload.threadId,
      isFollowing: false,
    } satisfies TeamThreadFollowResult;
  });

  const listFollowedThreads = Effect.fn("TeamService.listFollowedThreads")(function* (
    sessionId: AuthSessionId,
  ) {
    const workspaceOption = yield* repository.getWorkspace();
    if (Option.isNone(workspaceOption)) {
      return [];
    }
    const memberOption = yield* repository.getMemberForSession(sessionId);
    if (
      Option.isNone(memberOption) ||
      memberOption.value.status !== "active" ||
      memberOption.value.teamId !== workspaceOption.value.id
    ) {
      return [];
    }
    return yield* repository.listFollowedThreadIds(memberOption.value.id);
  }, Effect.mapError(toInternalError));

  const shouldNotifyMemberForThread = Effect.fn("TeamService.shouldNotifyMemberForThread")(
    function* (input: {
      readonly memberId: TeamMemberId;
      readonly threadId: ThreadId;
      readonly turnId?: string;
    }) {
      const workspaceOption = yield* repository.getWorkspace().pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("TeamService.shouldNotifyMemberForThread workspace lookup failed", {
            cause,
          }),
        ),
        Effect.orElseSucceed(() => Option.none<TeamWorkspace>()),
      );
      if (Option.isNone(workspaceOption)) return true;
      const attributionOption = yield* repository.getThreadAttribution(input.threadId).pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("TeamService.shouldNotifyMemberForThread attribution lookup failed", {
            threadId: input.threadId,
            cause,
          }),
        ),
        Effect.orElseSucceed(() => Option.none<TeamThreadAttribution>()),
      );
      if (Option.isNone(attributionOption)) return true;
      if (attributionOption.value.teamId !== workspaceOption.value.id) return false;

      const [memberOption, viewOption, defaultViewOption] = yield* Effect.all([
        repository.getMemberById(input.memberId).pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("TeamService.shouldNotifyMemberForThread member lookup failed", {
              memberId: input.memberId,
              cause,
            }),
          ),
          Effect.orElseSucceed(() => Option.none<TeamMember>()),
        ),
        repository
          .getViewById(attributionOption.value.viewId)
          .pipe(Effect.orElseSucceed(() => Option.none<TeamView>())),
        attributionOption.value.viewId === workspaceOption.value.defaultViewId
          ? Effect.succeed(Option.none<TeamView>())
          : repository
              .getViewById(workspaceOption.value.defaultViewId)
              .pipe(Effect.orElseSucceed(() => Option.none<TeamView>())),
      ]);
      if (
        Option.isNone(memberOption) ||
        memberOption.value.status !== "active" ||
        memberOption.value.teamId !== workspaceOption.value.id
      ) {
        return false;
      }
      const threadView = Option.getOrNull(viewOption) ?? Option.getOrNull(defaultViewOption);
      if (!canMemberReadTeamThread({ member: memberOption.value, view: threadView })) {
        return false;
      }

      const [isFollowing, turnAttribution] = yield* Effect.all([
        repository
          .isFollowingThread({ threadId: input.threadId, memberId: input.memberId })
          .pipe(Effect.orElseSucceed(() => false)),
        input.turnId !== undefined
          ? repository
              .getTurnAttribution(input.turnId)
              .pipe(Effect.orElseSucceed(() => Option.none<TeamTurnAttribution>()))
          : Effect.succeed(Option.none<TeamTurnAttribution>()),
      ]);

      const activeTurnAuthorMemberId =
        Option.isSome(turnAttribution) && turnAttribution.value.threadId === input.threadId
          ? turnAttribution.value.authorMemberId
          : null;

      return shouldNotifyTeamMemberForThread({
        hasTeam: true,
        memberId: memberOption.value.id,
        ownerKind:
          attributionOption.value.ownerKind ??
          (attributionOption.value.creatorMemberId === null ? "team" : "member"),
        creatorMemberId: attributionOption.value.creatorMemberId,
        isFollowing,
        activeTurnAuthorMemberId,
      });
    },
  );

  const listNotificationRecipientsForThread = Effect.fn(
    "TeamService.listNotificationRecipientsForThread",
  )(function* (input: { readonly threadId: ThreadId; readonly turnId?: string }) {
    const workspaceOption = yield* repository.getWorkspace().pipe(
      Effect.tapError((cause) =>
        Effect.logWarning(
          "TeamService.listNotificationRecipientsForThread workspace lookup failed",
          { cause },
        ),
      ),
      Effect.orElseSucceed(() => Option.none<TeamWorkspace>()),
    );
    if (Option.isNone(workspaceOption)) {
      return { isTeamThread: false, recipientMemberIds: null };
    }
    const attributionOption = yield* repository.getThreadAttribution(input.threadId).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning(
          "TeamService.listNotificationRecipientsForThread attribution lookup failed",
          { threadId: input.threadId, cause },
        ),
      ),
      Effect.orElseSucceed(() => Option.none<TeamThreadAttribution>()),
    );
    if (Option.isNone(attributionOption)) {
      return { isTeamThread: false, recipientMemberIds: null };
    }
    if (attributionOption.value.teamId !== workspaceOption.value.id) {
      return { isTeamThread: true, recipientMemberIds: [] };
    }

    const [members, followerIds, turnAttribution, viewOption, defaultViewOption] =
      yield* Effect.all([
        repository
          .listMembers(workspaceOption.value.id)
          .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<TeamMember>)),
        repository
          .listFollowersForThread(input.threadId)
          .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<TeamMemberId>)),
        input.turnId !== undefined
          ? repository
              .getTurnAttribution(input.turnId)
              .pipe(Effect.orElseSucceed(() => Option.none<TeamTurnAttribution>()))
          : Effect.succeed(Option.none<TeamTurnAttribution>()),
        repository
          .getViewById(attributionOption.value.viewId)
          .pipe(Effect.orElseSucceed(() => Option.none<TeamView>())),
        attributionOption.value.viewId === workspaceOption.value.defaultViewId
          ? Effect.succeed(Option.none<TeamView>())
          : repository
              .getViewById(workspaceOption.value.defaultViewId)
              .pipe(Effect.orElseSucceed(() => Option.none<TeamView>())),
      ]);
    const threadView = Option.getOrNull(viewOption) ?? Option.getOrNull(defaultViewOption);

    const followerSet = new Set(followerIds);
    const activeTurnAuthorMemberId =
      Option.isSome(turnAttribution) && turnAttribution.value.threadId === input.threadId
        ? turnAttribution.value.authorMemberId
        : null;

    const recipientMemberIds = members
      .filter(
        (member) =>
          member.status === "active" &&
          canMemberReadTeamThread({ member, view: threadView }) &&
          shouldNotifyTeamMemberForThread({
            hasTeam: true,
            memberId: member.id,
            ownerKind:
              attributionOption.value.ownerKind ??
              (attributionOption.value.creatorMemberId === null ? "team" : "member"),
            creatorMemberId: attributionOption.value.creatorMemberId,
            isFollowing: followerSet.has(member.id),
            activeTurnAuthorMemberId,
          }),
      )
      .map((member) => member.id);

    return { isTeamThread: true, recipientMemberIds };
  });

  const bindRelayRecipientForSession = Effect.fn("TeamService.bindRelayRecipientForSession")(
    function* (input: { readonly sessionId: AuthSessionId; readonly cloudUserId?: string | null }) {
      const workspaceOption = yield* repository.getWorkspace().pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("TeamService.bindRelayRecipientForSession workspace lookup failed", {
            cause,
          }),
        ),
        Effect.orElseSucceed(() => Option.none<TeamWorkspace>()),
      );
      if (Option.isNone(workspaceOption)) return;
      const memberOption = yield* repository.getMemberForSession(input.sessionId).pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("TeamService.bindRelayRecipientForSession member lookup failed", {
            cause,
          }),
        ),
        Effect.orElseSucceed(() => Option.none<TeamMember>()),
      );
      if (
        Option.isNone(memberOption) ||
        memberOption.value.status !== "active" ||
        memberOption.value.teamId !== workspaceOption.value.id
      ) {
        yield* clearRelayRecipientBinding();
        return;
      }
      const boundAt = DateTime.formatIso(yield* DateTime.now);
      yield* repository
        .setRelayRecipientBinding({
          teamId: workspaceOption.value.id,
          memberId: memberOption.value.id,
          cloudUserId: input.cloudUserId ?? null,
          boundAt,
        })
        .pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("TeamService.bindRelayRecipientForSession write failed", { cause }),
          ),
          Effect.ignore,
        );
      yield* PubSub.publish(notificationTriggersPubSub, { type: "relayBinding" as const }).pipe(
        Effect.asVoid,
      );
    },
  );

  const clearRelayRecipientBinding = Effect.fn("TeamService.clearRelayRecipientBinding")(
    function* () {
      yield* repository.clearRelayRecipientBinding().pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("TeamService.clearRelayRecipientBinding failed", { cause }),
        ),
        Effect.ignore,
      );
      yield* PubSub.publish(notificationTriggersPubSub, { type: "relayBinding" as const }).pipe(
        Effect.asVoid,
      );
    },
  );

  const shouldPublishRelayNotificationForThread = Effect.fn(
    "TeamService.shouldPublishRelayNotificationForThread",
  )(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId?: string;
    readonly threadCreatedAt?: string;
    readonly cloudUserId?: string | null;
  }) {
    const workspaceOption = yield* repository.getWorkspace().pipe(
      Effect.tapError((cause) =>
        Effect.logWarning(
          "TeamService.shouldPublishRelayNotificationForThread workspace lookup failed",
          { cause },
        ),
      ),
      Effect.orElseSucceed(() => Option.none<TeamWorkspace>()),
    );
    if (Option.isNone(workspaceOption)) return true;

    const [attributionOption, relayBindingOption] = yield* Effect.all([
      repository.getThreadAttribution(input.threadId).pipe(
        Effect.tapError((cause) =>
          Effect.logWarning(
            "TeamService.shouldPublishRelayNotificationForThread attribution lookup failed",
            { threadId: input.threadId, cause },
          ),
        ),
        Effect.orElseSucceed(() => Option.none<TeamThreadAttribution>()),
      ),
      repository.getRelayRecipientBinding().pipe(
        Effect.tapError((cause) =>
          Effect.logWarning(
            "TeamService.shouldPublishRelayNotificationForThread relay binding lookup failed",
            { cause },
          ),
        ),
        Effect.orElseSucceed(() => Option.none<TeamRepository.TeamRelayRecipientBinding>()),
      ),
    ]);

    if (Option.isNone(attributionOption)) {
      // Do not fail open for post-team threads whose attribution write may still be in flight.
      const resolvedCreatedAt =
        input.threadCreatedAt !== undefined
          ? Option.some(input.threadCreatedAt)
          : yield* repository
              .getThreadCreatedAtInProjection(input.threadId)
              .pipe(Effect.orElseSucceed(() => Option.none<string>()));
      if (Option.isSome(resolvedCreatedAt)) {
        const threadCreatedMs = Date.parse(resolvedCreatedAt.value);
        const teamCreatedMs = Date.parse(workspaceOption.value.createdAt);
        if (
          Number.isFinite(threadCreatedMs) &&
          Number.isFinite(teamCreatedMs) &&
          threadCreatedMs >= teamCreatedMs
        ) {
          return false;
        }
      }
      return true;
    }
    if (attributionOption.value.teamId !== workspaceOption.value.id) {
      return false;
    }

    // Require an explicit relay-to-member binding matching the linked cloud user ID rather than guessing an owner.
    if (
      Option.isNone(relayBindingOption) ||
      relayBindingOption.value.teamId !== workspaceOption.value.id
    ) {
      return false;
    }
    if (
      input.cloudUserId !== undefined &&
      relayBindingOption.value.cloudUserId !== input.cloudUserId
    ) {
      return false;
    }

    const recipientMemberId = relayBindingOption.value.memberId;
    const [memberOption, isFollowing, turnAttribution, viewOption, defaultViewOption] =
      yield* Effect.all([
        repository
          .getMemberById(recipientMemberId)
          .pipe(Effect.orElseSucceed(() => Option.none<TeamMember>())),
        repository
          .isFollowingThread({ threadId: input.threadId, memberId: recipientMemberId })
          .pipe(Effect.orElseSucceed(() => false)),
        input.turnId !== undefined
          ? repository
              .getTurnAttribution(input.turnId)
              .pipe(Effect.orElseSucceed(() => Option.none<TeamTurnAttribution>()))
          : Effect.succeed(Option.none<TeamTurnAttribution>()),
        repository
          .getViewById(attributionOption.value.viewId)
          .pipe(Effect.orElseSucceed(() => Option.none<TeamView>())),
        attributionOption.value.viewId === workspaceOption.value.defaultViewId
          ? Effect.succeed(Option.none<TeamView>())
          : repository
              .getViewById(workspaceOption.value.defaultViewId)
              .pipe(Effect.orElseSucceed(() => Option.none<TeamView>())),
      ]);
    if (
      Option.isNone(memberOption) ||
      memberOption.value.status !== "active" ||
      memberOption.value.teamId !== workspaceOption.value.id
    ) {
      return false;
    }
    const threadView = Option.getOrNull(viewOption) ?? Option.getOrNull(defaultViewOption);
    if (!canMemberReadTeamThread({ member: memberOption.value, view: threadView })) {
      return false;
    }

    const activeTurnAuthorMemberId =
      Option.isSome(turnAttribution) && turnAttribution.value.threadId === input.threadId
        ? turnAttribution.value.authorMemberId
        : null;

    return shouldNotifyTeamMemberForThread({
      hasTeam: true,
      memberId: memberOption.value.id,
      ownerKind:
        attributionOption.value.ownerKind ??
        (attributionOption.value.creatorMemberId === null ? "team" : "member"),
      creatorMemberId: attributionOption.value.creatorMemberId,
      isFollowing,
      activeTurnAuthorMemberId,
    });
  });

  const shouldPublishRelayQueuedMessageNotification = Effect.fn(
    "TeamService.shouldPublishRelayQueuedMessageNotification",
  )(function* (input: {
    readonly threadId: ThreadId;
    readonly recipientMemberIds: ReadonlyArray<TeamMemberId>;
    readonly cloudUserId?: string | null;
  }) {
    const workspaceOption = yield* repository
      .getWorkspace()
      .pipe(Effect.orElseSucceed(() => Option.none<TeamWorkspace>()));
    if (Option.isNone(workspaceOption)) return false;
    const relayBindingOption = yield* repository
      .getRelayRecipientBinding()
      .pipe(Effect.orElseSucceed(() => Option.none<TeamRepository.TeamRelayRecipientBinding>()));
    if (
      Option.isNone(relayBindingOption) ||
      relayBindingOption.value.teamId !== workspaceOption.value.id
    ) {
      return false;
    }
    if (
      input.cloudUserId !== undefined &&
      relayBindingOption.value.cloudUserId !== input.cloudUserId
    ) {
      return false;
    }
    const recipientMemberId = relayBindingOption.value.memberId;
    if (!input.recipientMemberIds.includes(recipientMemberId)) {
      return false;
    }
    return yield* canActorReadThread(
      { kind: "member", memberId: recipientMemberId },
      input.threadId,
    );
  });

  const subscribeNotificationEvents = () =>
    Stream.unwrap(
      PubSub.subscribe(notificationTriggersPubSub).pipe(
        Effect.map((subscription) => Stream.fromSubscription(subscription)),
      ),
    );

  const resolveDefaultViewIdForProject = Effect.fn("TeamService.resolveDefaultViewIdForProject")(
    function* (team: TeamWorkspace, projectId: ProjectId | undefined, explicitViewId?: TeamViewId) {
      if (explicitViewId !== undefined) return explicitViewId;
      if (projectId === undefined) return team.defaultViewId;
      const assignment = yield* repository
        .getProjectAssignment(projectId)
        .pipe(Effect.orElseSucceed(() => Option.none<TeamProjectAssignment>()));
      if (
        Option.isSome(assignment) &&
        assignment.value.teamId === team.id &&
        assignment.value.defaultViewId !== null
      ) {
        return assignment.value.defaultViewId;
      }
      return team.defaultViewId;
    },
  );

  const recordThreadCreated = Effect.fn("TeamService.recordThreadCreated")(function* (input: {
    readonly sessionId: AuthSessionId;
    readonly threadId: ThreadId;
    readonly projectId?: ProjectId;
    readonly viewId?: TeamViewId;
    readonly locked?: boolean;
  }) {
    const workspaceOption = yield* repository.getWorkspace().pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("TeamService.recordThreadCreated workspace lookup failed", { cause }),
      ),
      Effect.orElseSucceed(() => Option.none<TeamWorkspace>()),
    );
    if (Option.isNone(workspaceOption)) return;
    const memberOption = yield* repository.getMemberForSession(input.sessionId).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("TeamService.recordThreadCreated member lookup failed", { cause }),
      ),
      Effect.orElseSucceed(() => Option.none<TeamMember>()),
    );
    if (Option.isNone(memberOption)) return;
    const locked = input.locked === true && canToggleTeamThreadLock(memberOption.value.role);
    const resolvedViewId = yield* resolveDefaultViewIdForProject(
      workspaceOption.value,
      input.projectId,
      input.viewId,
    );
    const nowIso = DateTime.formatIso(yield* DateTime.now);
    const attribution = yield* repository
      .recordThreadAttribution({
        threadId: input.threadId,
        teamId: workspaceOption.value.id,
        creatorMemberId: memberOption.value.id,
        viewId: resolvedViewId,
        locked,
        lockedByMemberId: locked ? memberOption.value.id : null,
        createdAt: nowIso,
      })
      .pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("TeamService.recordThreadCreated attribution write failed", {
            threadId: input.threadId,
            cause,
          }),
        ),
        Effect.orElseSucceed(() => Option.none<TeamThreadAttribution>()),
      );
    if (Option.isSome(attribution)) {
      yield* publish({
        version: 1,
        type: "threadAttributed",
        payload: attribution.value,
      });
    }
  });

  const prepareThreadAttribution = Effect.fn("TeamService.prepareThreadAttribution")(
    function* (input: {
      readonly sessionId: AuthSessionId;
      readonly threadId: ThreadId;
      readonly projectId?: ProjectId;
      readonly viewId?: TeamViewId;
      readonly locked?: boolean;
    }) {
      return yield* Effect.gen(function* () {
        const workspaceOption = yield* repository.getWorkspace();
        if (Option.isNone(workspaceOption)) return false;
        const existing = yield* repository.getThreadAttribution(input.threadId);
        if (Option.isSome(existing)) return false;
        const memberOption = yield* repository.getMemberForSession(input.sessionId);
        if (
          Option.isNone(memberOption) ||
          memberOption.value.teamId !== workspaceOption.value.id ||
          memberOption.value.status !== "active"
        ) {
          return yield* teamPostAuthError("This session is not bound to an active team member.");
        }
        const locked = input.locked === true && canToggleTeamThreadLock(memberOption.value.role);
        const resolvedViewId = yield* resolveDefaultViewIdForProject(
          workspaceOption.value,
          input.projectId,
          input.viewId,
        );
        const nowIso = DateTime.formatIso(yield* DateTime.now);
        const inserted = yield* repository.recordThreadAttribution({
          threadId: input.threadId,
          teamId: workspaceOption.value.id,
          creatorMemberId: memberOption.value.id,
          viewId: resolvedViewId,
          locked,
          lockedByMemberId: locked ? memberOption.value.id : null,
          createdAt: nowIso,
        });
        if (Option.isNone(inserted)) {
          return yield* teamPostAuthError("Failed to prepare team thread attribution.");
        }
        return true;
      }).pipe(
        Effect.tapError((cause) =>
          cause._tag === "EnvironmentAuthorizationError"
            ? Effect.void
            : Effect.logWarning("TeamService.prepareThreadAttribution failed", {
                threadId: input.threadId,
                cause,
              }),
        ),
        Effect.mapError((cause) =>
          cause._tag === "EnvironmentAuthorizationError"
            ? cause
            : teamPostAuthError("Failed to prepare team thread attribution."),
        ),
      );
    },
  );

  const prepareThreadAttributionForMember = Effect.fn(
    "TeamService.prepareThreadAttributionForMember",
  )(function* (input: {
    readonly memberId: TeamMemberId;
    readonly threadId: ThreadId;
    readonly viewId?: TeamViewId;
    readonly locked?: boolean;
  }) {
    return yield* Effect.gen(function* () {
      const workspaceOption = yield* repository.getWorkspace();
      if (Option.isNone(workspaceOption)) return false;
      const existing = yield* repository.getThreadAttribution(input.threadId);
      if (Option.isSome(existing)) return false;
      const memberOption = yield* repository.getMemberById(input.memberId);
      if (
        Option.isNone(memberOption) ||
        memberOption.value.teamId !== workspaceOption.value.id ||
        memberOption.value.status !== "active"
      ) {
        return yield* teamPostAuthError("This caller is not bound to an active team member.");
      }
      const locked = input.locked === true && canToggleTeamThreadLock(memberOption.value.role);
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      const inserted = yield* repository.recordThreadAttribution({
        threadId: input.threadId,
        teamId: workspaceOption.value.id,
        creatorMemberId: memberOption.value.id,
        viewId: input.viewId ?? workspaceOption.value.defaultViewId,
        locked,
        lockedByMemberId: locked ? memberOption.value.id : null,
        createdAt: nowIso,
      });
      if (Option.isNone(inserted)) {
        return yield* teamPostAuthError("Failed to prepare team thread attribution.");
      }
      return true;
    }).pipe(
      Effect.tapError((cause) =>
        cause._tag === "EnvironmentAuthorizationError"
          ? Effect.void
          : Effect.logWarning("TeamService.prepareThreadAttributionForMember failed", {
              threadId: input.threadId,
              memberId: input.memberId,
              cause,
            }),
      ),
      Effect.mapError((cause) =>
        cause._tag === "EnvironmentAuthorizationError"
          ? cause
          : teamPostAuthError("Failed to prepare team thread attribution."),
      ),
    );
  });

  const recordThreadCreatedByMember = Effect.fn("TeamService.recordThreadCreatedByMember")(
    function* (input: {
      readonly memberId: TeamMemberId;
      readonly threadId: ThreadId;
      readonly viewId?: TeamViewId;
      readonly locked?: boolean;
    }) {
      const workspaceOption = yield* repository.getWorkspace().pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("TeamService.recordThreadCreatedByMember workspace lookup failed", {
            cause,
          }),
        ),
        Effect.orElseSucceed(() => Option.none<TeamWorkspace>()),
      );
      if (Option.isNone(workspaceOption)) return;
      const memberOption = yield* repository.getMemberById(input.memberId).pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("TeamService.recordThreadCreatedByMember member lookup failed", {
            memberId: input.memberId,
            cause,
          }),
        ),
        Effect.orElseSucceed(() => Option.none<TeamMember>()),
      );
      if (
        Option.isNone(memberOption) ||
        memberOption.value.teamId !== workspaceOption.value.id ||
        memberOption.value.status !== "active"
      ) {
        return;
      }
      const locked = input.locked === true && canToggleTeamThreadLock(memberOption.value.role);
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      const attribution = yield* repository
        .recordThreadAttribution({
          threadId: input.threadId,
          teamId: workspaceOption.value.id,
          creatorMemberId: memberOption.value.id,
          viewId: input.viewId ?? workspaceOption.value.defaultViewId,
          locked,
          lockedByMemberId: locked ? memberOption.value.id : null,
          createdAt: nowIso,
        })
        .pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("TeamService.recordThreadCreatedByMember write failed", {
              threadId: input.threadId,
              cause,
            }),
          ),
          Effect.orElseSucceed(() => Option.none<TeamThreadAttribution>()),
        );
      if (Option.isSome(attribution)) {
        yield* publish({
          version: 1,
          type: "threadAttributed",
          payload: attribution.value,
        });
        yield* publishAccessChange({ type: "threadView", threadId: input.threadId });
      }
    },
  );

  const prepareThreadInheritedFromParent = Effect.fn(
    "TeamService.prepareThreadInheritedFromParent",
  )(function* (input: {
    readonly parentThreadId: ThreadId;
    readonly threadId: ThreadId;
    readonly creatorSessionId?: AuthSessionId;
    readonly creatorMemberId?: TeamMemberId;
    readonly teamAutomation?: McpTeamAutomationPrincipal;
  }) {
    return yield* Effect.gen(function* () {
      const workspaceOption = yield* repository.getWorkspace();
      if (Option.isNone(workspaceOption)) return false;
      const team = workspaceOption.value;
      const existing = yield* repository.getThreadAttribution(input.threadId);
      if (Option.isSome(existing)) return false;
      const parentAttribution = yield* repository.getThreadAttribution(input.parentThreadId);
      let ownerKind: "member" | "team" = "member";
      let creatorMemberId: TeamMemberId | null = null;
      let viewId = team.defaultViewId;
      let parentLocked = false;
      let parentLockedByMemberId: TeamMemberId | null = null;
      let executionEnvironmentId: EnvironmentId | null = null;
      let executionEnvironmentLabel: string | null = null;
      if (Option.isSome(parentAttribution) && parentAttribution.value.teamId === team.id) {
        ownerKind =
          parentAttribution.value.ownerKind ??
          (parentAttribution.value.creatorMemberId === null ? "team" : "member");
        creatorMemberId = parentAttribution.value.creatorMemberId;
        viewId = parentAttribution.value.viewId;
        parentLocked = parentAttribution.value.locked;
        parentLockedByMemberId = parentAttribution.value.locked
          ? parentAttribution.value.lockedByMemberId
          : null;
        executionEnvironmentId = parentAttribution.value.executionEnvironmentId ?? null;
        executionEnvironmentLabel = parentAttribution.value.executionEnvironmentLabel ?? null;
      }
      if (input.teamAutomation !== undefined) {
        if (input.teamAutomation.teamId !== team.id) {
          return yield* teamPostAuthError("Automation principal does not belong to this team.");
        }
        ownerKind = "team";
        creatorMemberId = null;
        if (input.teamAutomation.mcpAccessLevel === "minimal") {
          viewId = input.teamAutomation.viewId;
        }
        executionEnvironmentId = input.teamAutomation.environmentId;
        if (Option.isNone(parentAttribution)) {
          const taskMetaOpt = yield* repository.getScheduledTaskMeta(input.teamAutomation.taskId);
          if (Option.isSome(taskMetaOpt) && taskMetaOpt.value.teamId === team.id) {
            parentLocked = taskMetaOpt.value.locked;
          }
        }
      } else if (input.creatorMemberId !== undefined) {
        const actorOption = yield* repository.getMemberById(input.creatorMemberId);
        if (
          Option.isNone(actorOption) ||
          actorOption.value.teamId !== team.id ||
          actorOption.value.status !== "active"
        ) {
          return yield* teamPostAuthError("This caller is not bound to an active team member.");
        }
        ownerKind = "member";
        creatorMemberId = actorOption.value.id;
      } else if (input.creatorSessionId !== undefined) {
        const actorOption = yield* repository.getMemberForSession(input.creatorSessionId);
        if (
          Option.isNone(actorOption) ||
          actorOption.value.teamId !== team.id ||
          actorOption.value.status !== "active"
        ) {
          return yield* teamPostAuthError("This session is not bound to an active team member.");
        }
        ownerKind = "member";
        creatorMemberId = actorOption.value.id;
      }
      const locked = ownerKind === "team" ? parentLocked : false;
      const lockedByMemberId = locked ? parentLockedByMemberId : null;
      if (ownerKind === "member" && creatorMemberId === null) {
        // Pre-team legacy parents legitimately lack attribution; anchor their MCP children to Default View.
        const parentCreatedAt = yield* repository.getThreadCreatedAtInProjection(
          input.parentThreadId,
        );
        if (!isPreTeamLegacyTimestamp(team, Option.getOrUndefined(parentCreatedAt))) {
          return false;
        }
        const members = yield* repository.listMembers(team.id);
        const activeOwner = members.find(
          (member) => member.role === "owner" && member.status === "active",
        );
        if (!activeOwner) {
          return false;
        }
        creatorMemberId = activeOwner.id;
        viewId = team.defaultViewId;
      }
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      const inserted = yield* repository.recordThreadAttribution({
        threadId: input.threadId,
        teamId: team.id,
        ownerKind,
        creatorMemberId: ownerKind === "team" ? null : creatorMemberId,
        viewId,
        locked,
        lockedByMemberId,
        ...(executionEnvironmentId !== null ? { executionEnvironmentId } : {}),
        ...(executionEnvironmentLabel !== null ? { executionEnvironmentLabel } : {}),
        createdAt: nowIso,
        ...(ownerKind === "team" && input.teamAutomation !== undefined
          ? {
              ownerAutomationScope: {
                turnId: `thread-owner:${input.threadId}`,
                threadId: input.threadId,
                taskId: input.teamAutomation.taskId,
                teamId: team.id,
                projectId: input.teamAutomation.projectId,
                environmentId: executionEnvironmentId ?? input.teamAutomation.environmentId,
                viewId,
                mcpAccessLevel: input.teamAutomation.mcpAccessLevel,
                createdAt: nowIso,
              },
            }
          : {}),
      });
      if (Option.isNone(inserted)) {
        return yield* teamPostAuthError("Failed to prepare inherited team thread attribution.");
      }
      return true;
    }).pipe(
      Effect.tapError((cause) =>
        cause._tag === "EnvironmentAuthorizationError"
          ? Effect.void
          : Effect.logWarning("TeamService.prepareThreadInheritedFromParent failed", {
              parentThreadId: input.parentThreadId,
              threadId: input.threadId,
              cause,
            }),
      ),
      Effect.mapError((cause) =>
        cause._tag === "EnvironmentAuthorizationError"
          ? cause
          : teamPostAuthError("Failed to prepare inherited team thread attribution."),
      ),
    );
  });

  const prepareTeamAutomationThreadAttribution = Effect.fn(
    "TeamService.prepareTeamAutomationThreadAttribution",
  )(function* (input: {
    readonly threadId: ThreadId;
    readonly taskId: ScheduledTaskId;
    readonly projectId: ProjectId;
    readonly viewId?: TeamViewId;
    readonly locked?: boolean;
    readonly environmentId?: EnvironmentId;
  }) {
    return yield* Effect.gen(function* () {
      const workspaceOption = yield* repository.getWorkspace();
      if (Option.isNone(workspaceOption)) return false;
      const team = workspaceOption.value;
      const existing = yield* repository.getThreadAttribution(input.threadId);
      if (Option.isSome(existing)) return false;
      const taskMetaOption = yield* repository.getScheduledTaskMeta(input.taskId);
      const taskMeta =
        Option.isSome(taskMetaOption) && taskMetaOption.value.teamId === team.id
          ? taskMetaOption.value
          : null;
      const resolvedViewId =
        input.viewId ??
        taskMeta?.viewId ??
        (yield* resolveDefaultViewIdForProject(team, input.projectId));
      const locked = input.locked ?? taskMeta?.locked ?? true;
      const localEnv = yield* resolveLocalEnvironmentIdentity();
      const executionEnvironmentId =
        input.environmentId ?? taskMeta?.environmentId ?? localEnv.environmentId;
      const envOption = yield* repository.getEnvironmentByEnvironmentId({
        teamId: team.id,
        environmentId: executionEnvironmentId,
      });
      const executionEnvironmentLabel = Option.isSome(envOption)
        ? envOption.value.name
        : localEnv.name;
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      const inserted = yield* repository.recordThreadAttribution({
        threadId: input.threadId,
        teamId: team.id,
        ownerKind: "team",
        creatorMemberId: null,
        viewId: resolvedViewId,
        locked,
        lockedByMemberId: null,
        executionEnvironmentId,
        executionEnvironmentLabel,
        isLocalSynced: false,
        createdAt: nowIso,
        ownerAutomationScope: {
          turnId: `thread-owner:${input.threadId}`,
          threadId: input.threadId,
          taskId: input.taskId,
          teamId: team.id,
          projectId: input.projectId,
          environmentId: executionEnvironmentId,
          viewId: resolvedViewId,
          mcpAccessLevel: taskMeta?.mcpAccessLevel ?? "minimal",
          createdAt: nowIso,
        },
      });
      if (Option.isNone(inserted)) {
        return yield* teamPostAuthError("Failed to prepare team automation thread attribution.");
      }
      return true;
    }).pipe(
      Effect.tapError((cause) =>
        cause._tag === "EnvironmentAuthorizationError"
          ? Effect.void
          : Effect.logWarning("TeamService.prepareTeamAutomationThreadAttribution failed", {
              threadId: input.threadId,
              taskId: input.taskId,
              cause,
            }),
      ),
      Effect.mapError((cause) =>
        cause._tag === "EnvironmentAuthorizationError"
          ? cause
          : teamPostAuthError("Failed to prepare team automation thread attribution."),
      ),
    );
  });

  const publishTeamAutomationThreadAttributed = Effect.fn(
    "TeamService.publishTeamAutomationThreadAttributed",
  )(function* (threadId: ThreadId) {
    const attribution = yield* repository
      .getThreadAttribution(threadId)
      .pipe(Effect.orElseSucceed(() => Option.none<TeamThreadAttribution>()));
    if (Option.isSome(attribution)) {
      yield* publish({
        version: 1,
        type: "threadAttributed",
        payload: attribution.value,
      });
      yield* publishAccessChange({ type: "threadView", threadId });
    }
  });

  const persistTeamAutomationTurn = Effect.fn("TeamService.persistTeamAutomationTurn")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly turnId: string;
      readonly taskId?: ScheduledTaskId;
      readonly projectId?: ProjectId;
      readonly principal?: McpTeamAutomationPrincipal;
    }) {
      const workspaceOption = yield* repository.getWorkspace();
      if (Option.isNone(workspaceOption)) return Option.none<McpTeamAutomationPrincipal>();
      const team = workspaceOption.value;
      let principal = input.principal;
      if (principal !== undefined) {
        if (principal.teamId !== team.id) {
          return Option.none<McpTeamAutomationPrincipal>();
        }
      } else {
        const taskId = input.taskId;
        if (taskId === undefined) return Option.none<McpTeamAutomationPrincipal>();
        const [taskMetaOpt, threadAttrOpt, threadProjectOpt] = yield* Effect.all([
          repository.getScheduledTaskMeta(taskId),
          repository.getThreadAttribution(input.threadId),
          input.projectId !== undefined
            ? Effect.succeedSome(input.projectId)
            : repository.getThreadProjectIdInProjection(input.threadId),
        ]);
        const taskMeta =
          Option.isSome(taskMetaOpt) && taskMetaOpt.value.teamId === team.id
            ? taskMetaOpt.value
            : null;
        const localEnv = yield* resolveLocalEnvironmentIdentity();
        const projectId = Option.getOrUndefined(threadProjectOpt);
        if (projectId === undefined) {
          return Option.none<McpTeamAutomationPrincipal>();
        }
        const viewId =
          taskMeta?.viewId ??
          (Option.isSome(threadAttrOpt) && threadAttrOpt.value.teamId === team.id
            ? threadAttrOpt.value.viewId
            : team.defaultViewId);
        const environmentId =
          taskMeta?.environmentId ??
          (Option.isSome(threadAttrOpt) && threadAttrOpt.value.executionEnvironmentId
            ? threadAttrOpt.value.executionEnvironmentId
            : localEnv.environmentId);
        principal = {
          taskId,
          teamId: team.id,
          projectId,
          environmentId,
          viewId,
          mcpAccessLevel: taskMeta?.mcpAccessLevel ?? "minimal",
        };
      }
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      const { turnInserted } = yield* repository.recordAutomationTurnWithScope({
        scope: {
          turnId: input.turnId,
          threadId: input.threadId,
          taskId: principal.taskId,
          teamId: team.id,
          projectId: principal.projectId,
          environmentId: principal.environmentId,
          viewId: principal.viewId,
          mcpAccessLevel: principal.mcpAccessLevel,
          createdAt: nowIso,
        },
      });
      if (turnInserted && !input.turnId.startsWith("msg:")) {
        yield* publish({
          version: 1,
          type: "turnAttributed",
          payload: {
            turnId: input.turnId,
            threadId: input.threadId,
            authorKind: "team_automation",
            authorMemberId: null,
            authorPseudo: null,
            createdAt: nowIso,
          },
        });
      }
      return Option.some(principal);
    },
  );

  const recordTeamAutomationTurn = Effect.fn("TeamService.recordTeamAutomationTurn")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly turnId: string;
      readonly taskId?: ScheduledTaskId;
      readonly projectId?: ProjectId;
      readonly principal?: McpTeamAutomationPrincipal;
    }) {
      return yield* persistTeamAutomationTurn(input).pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("TeamService.recordTeamAutomationTurn failed", {
            threadId: input.threadId,
            turnId: input.turnId,
            cause,
          }),
        ),
        Effect.orElseSucceed(() => Option.none<McpTeamAutomationPrincipal>()),
      );
    },
  );

  const requireTeamAutomationTurn = Effect.fn("TeamService.requireTeamAutomationTurn")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly turnId: string;
      readonly taskId?: ScheduledTaskId;
      readonly projectId?: ProjectId;
      readonly principal?: McpTeamAutomationPrincipal;
    }) {
      const workspaceOption = yield* repository
        .getWorkspace()
        .pipe(
          Effect.mapError(() =>
            teamPostAuthError("Unable to verify team workspace for automation turn attribution."),
          ),
        );
      if (Option.isNone(workspaceOption)) return Option.none<McpTeamAutomationPrincipal>();
      const persisted = yield* persistTeamAutomationTurn(input).pipe(
        Effect.mapError(() =>
          teamPostAuthError("Unable to persist authoritative team automation turn scope."),
        ),
      );
      if (Option.isNone(persisted)) {
        return yield* teamPostAuthError(
          "Unable to resolve authoritative team automation turn scope.",
        );
      }
      return persisted;
    },
  );

  const rollbackPreparedThreadAttribution = Effect.fn(
    "TeamService.rollbackPreparedThreadAttribution",
  )(function* (threadId: ThreadId) {
    yield* repository.deleteThreadAttribution(threadId).pipe(Effect.ignore);
  });

  const rollbackRecordedTurnAttribution = Effect.fn("TeamService.rollbackRecordedTurnAttribution")(
    function* (input: { readonly threadId: ThreadId; readonly turnId: string }) {
      yield* repository.deleteTurnAttribution(input).pipe(Effect.ignore);
    },
  );

  const recordTurnAuthoredByMember = Effect.fn("TeamService.recordTurnAuthoredByMember")(
    function* (input: {
      readonly memberId: TeamMemberId;
      readonly threadId: ThreadId;
      readonly turnId: string;
    }) {
      const workspaceOption = yield* repository.getWorkspace().pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("TeamService.recordTurnAuthoredByMember workspace lookup failed", {
            cause,
          }),
        ),
        Effect.orElseSucceed(() => Option.none<TeamWorkspace>()),
      );
      if (Option.isNone(workspaceOption)) return;
      const memberOption = yield* repository.getMemberById(input.memberId).pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("TeamService.recordTurnAuthoredByMember member lookup failed", {
            memberId: input.memberId,
            cause,
          }),
        ),
        Effect.orElseSucceed(() => Option.none<TeamMember>()),
      );
      if (
        Option.isNone(memberOption) ||
        memberOption.value.teamId !== workspaceOption.value.id ||
        memberOption.value.status !== "active"
      ) {
        return;
      }
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      const inserted = yield* repository
        .recordTurnAttribution({
          turnId: input.turnId,
          threadId: input.threadId,
          authorMemberId: memberOption.value.id,
          createdAt: nowIso,
        })
        .pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("TeamService.recordTurnAuthoredByMember attribution write failed", {
              threadId: input.threadId,
              turnId: input.turnId,
              cause,
            }),
          ),
          Effect.orElseSucceed(() => false),
        );
      if (inserted && !input.turnId.startsWith("msg:")) {
        yield* publish({
          version: 1,
          type: "turnAttributed",
          payload: {
            turnId: input.turnId,
            threadId: input.threadId,
            authorMemberId: memberOption.value.id,
            authorPseudo: memberOption.value.pseudo,
            createdAt: nowIso,
          },
        });
      }
    },
  );

  const recordTurnAuthored = Effect.fn("TeamService.recordTurnAuthored")(function* (input: {
    readonly sessionId: AuthSessionId;
    readonly threadId: ThreadId;
    readonly turnId: string;
  }) {
    const memberId = yield* resolveMemberIdForSession(input.sessionId);
    if (Option.isNone(memberId)) return;
    yield* recordTurnAuthoredByMember({
      memberId: memberId.value,
      threadId: input.threadId,
      turnId: input.turnId,
    });
  });

  const requireTurnAuthoredByMember = Effect.fn("TeamService.requireTurnAuthoredByMember")(
    function* (input: {
      readonly memberId: TeamMemberId;
      readonly threadId: ThreadId;
      readonly turnId: string;
    }) {
      const workspaceOption = yield* repository
        .getWorkspace()
        .pipe(
          Effect.mapError(() =>
            teamPostAuthError("Unable to verify team workspace for turn attribution."),
          ),
        );
      if (Option.isNone(workspaceOption)) return;
      const memberOption = yield* repository
        .getMemberById(input.memberId)
        .pipe(
          Effect.mapError(() =>
            teamPostAuthError("Unable to verify team member for turn attribution."),
          ),
        );
      if (
        Option.isNone(memberOption) ||
        memberOption.value.teamId !== workspaceOption.value.id ||
        memberOption.value.status !== "active"
      ) {
        return yield* teamPostAuthError("This session is not bound to an active team member.");
      }
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      const inserted = yield* repository
        .recordTurnAttribution({
          turnId: input.turnId,
          threadId: input.threadId,
          authorMemberId: memberOption.value.id,
          createdAt: nowIso,
        })
        .pipe(
          Effect.mapError(() =>
            teamPostAuthError("Unable to persist authoritative team turn attribution."),
          ),
        );
      if (inserted && !input.turnId.startsWith("msg:")) {
        yield* publish({
          version: 1,
          type: "turnAttributed",
          payload: {
            turnId: input.turnId,
            threadId: input.threadId,
            authorMemberId: memberOption.value.id,
            authorPseudo: memberOption.value.pseudo,
            createdAt: nowIso,
          },
        });
      }
    },
  );

  const requireTurnAuthoredBySession = Effect.fn("TeamService.requireTurnAuthoredBySession")(
    function* (input: {
      readonly sessionId: AuthSessionId;
      readonly threadId: ThreadId;
      readonly turnId: string;
    }) {
      const workspaceOption = yield* repository
        .getWorkspace()
        .pipe(
          Effect.mapError(() =>
            teamPostAuthError("Unable to verify team workspace for turn attribution."),
          ),
        );
      if (Option.isNone(workspaceOption)) return;
      const memberId = yield* resolveMemberIdForSession(input.sessionId);
      if (Option.isNone(memberId)) {
        return yield* teamPostAuthError("This session is not bound to an active team member.");
      }
      yield* requireTurnAuthoredByMember({
        memberId: memberId.value,
        threadId: input.threadId,
        turnId: input.turnId,
      });
    },
  );

  const prepareTurnAttributionForCommand = Effect.fn(
    "TeamService.prepareTurnAttributionForCommand",
  )(function* (sessionId: AuthSessionId, command: OrchestrationV2Command) {
    if (command.type === "message.dispatch") {
      yield* requireTurnAuthoredBySession({
        sessionId,
        threadId: command.threadId,
        turnId: `msg:${command.messageId}`,
      });
      return;
    }
    if (command.type === "delegated_task.request") {
      yield* requireTurnAuthoredBySession({
        sessionId,
        threadId: deriveOrchestrationId.delegatedTaskThread({ commandId: command.commandId }),
        turnId: `msg:${deriveOrchestrationId.delegatedTaskMessage({ commandId: command.commandId })}`,
      });
      return;
    }
    if (command.type === "thread.metadata.update" && command.continuation !== undefined) {
      yield* requireTurnAuthoredBySession({
        sessionId,
        threadId: command.threadId,
        turnId: `msg:${command.continuation.messageId}`,
      });
    }
  });

  const recordThreadInheritedFromParent = Effect.fn("TeamService.recordThreadInheritedFromParent")(
    function* (input: {
      readonly parentThreadId: ThreadId;
      readonly threadId: ThreadId;
      readonly turnId?: string;
      readonly creatorMemberId?: TeamMemberId;
      readonly teamAutomation?: McpTeamAutomationPrincipal;
    }) {
      const workspaceOption = yield* repository.getWorkspace().pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("TeamService.recordThreadInheritedFromParent workspace lookup failed", {
            cause,
          }),
        ),
        Effect.orElseSucceed(() => Option.none<TeamWorkspace>()),
      );
      if (Option.isNone(workspaceOption)) return;
      const team = workspaceOption.value;
      const parentAttribution = yield* repository.getThreadAttribution(input.parentThreadId).pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("TeamService.recordThreadInheritedFromParent parent lookup failed", {
            parentThreadId: input.parentThreadId,
            cause,
          }),
        ),
        Effect.orElseSucceed(() => Option.none<TeamThreadAttribution>()),
      );
      let inheritedOwnerKind: "member" | "team" = "member";
      let inheritedCreatorMemberId: TeamMemberId | null = null;
      let inheritedCreatorPseudo: TeamPseudo | null = null;
      let inheritedViewId: TeamViewId = team.defaultViewId;
      let inheritedParentLocked = false;
      let inheritedParentLockedByMemberId: TeamMemberId | null = null;
      let inheritedExecutionEnvironmentId: EnvironmentId | null = null;
      let inheritedExecutionEnvironmentLabel: string | null = null;
      if (Option.isSome(parentAttribution) && parentAttribution.value.teamId === team.id) {
        inheritedOwnerKind =
          parentAttribution.value.ownerKind ??
          (parentAttribution.value.creatorMemberId === null ? "team" : "member");
        inheritedCreatorMemberId = parentAttribution.value.creatorMemberId;
        inheritedCreatorPseudo = parentAttribution.value.creatorPseudo;
        inheritedViewId = parentAttribution.value.viewId;
        inheritedParentLocked = parentAttribution.value.locked;
        inheritedParentLockedByMemberId = parentAttribution.value.locked
          ? parentAttribution.value.lockedByMemberId
          : null;
        inheritedExecutionEnvironmentId = parentAttribution.value.executionEnvironmentId ?? null;
        inheritedExecutionEnvironmentLabel =
          parentAttribution.value.executionEnvironmentLabel ?? null;
      } else if (input.teamAutomation === undefined) {
        const parentCreatedAt = yield* repository
          .getThreadCreatedAtInProjection(input.parentThreadId)
          .pipe(Effect.orElseSucceed(() => Option.none<string>()));
        if (!isPreTeamLegacyTimestamp(team, Option.getOrUndefined(parentCreatedAt))) {
          return;
        }
        const members = yield* repository
          .listMembers(team.id)
          .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<TeamMember>));
        const activeOwner = members.find(
          (member) => member.role === "owner" && member.status === "active",
        );
        if (!activeOwner) return;
        inheritedCreatorMemberId = activeOwner.id;
        inheritedCreatorPseudo = activeOwner.pseudo;
        inheritedViewId = team.defaultViewId;
      }
      if (input.teamAutomation !== undefined) {
        if (input.teamAutomation.teamId !== team.id) return;
        inheritedOwnerKind = "team";
        inheritedCreatorMemberId = null;
        inheritedCreatorPseudo = null;
        if (input.teamAutomation.mcpAccessLevel === "minimal") {
          inheritedViewId = input.teamAutomation.viewId;
        }
        inheritedExecutionEnvironmentId = input.teamAutomation.environmentId;
        if (Option.isNone(parentAttribution)) {
          const taskMetaOpt = yield* repository
            .getScheduledTaskMeta(input.teamAutomation.taskId)
            .pipe(Effect.orElseSucceed(() => Option.none<TeamScheduledTaskMeta>()));
          if (Option.isSome(taskMetaOpt) && taskMetaOpt.value.teamId === team.id) {
            inheritedParentLocked = taskMetaOpt.value.locked;
          }
        }
      } else if (input.creatorMemberId !== undefined) {
        const explicitMember = yield* repository
          .getMemberById(input.creatorMemberId)
          .pipe(Effect.orElseSucceed(() => Option.none<TeamMember>()));
        if (
          Option.isNone(explicitMember) ||
          explicitMember.value.teamId !== team.id ||
          explicitMember.value.status !== "active"
        ) {
          return;
        }
        inheritedOwnerKind = "member";
        inheritedCreatorMemberId = explicitMember.value.id;
        inheritedCreatorPseudo = explicitMember.value.pseudo;
      }
      const inheritedLocked = inheritedOwnerKind === "team" ? inheritedParentLocked : false;
      const inheritedLockedByMemberId = inheritedLocked ? inheritedParentLockedByMemberId : null;
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      const attribution = yield* repository
        .recordThreadAttribution({
          threadId: input.threadId,
          teamId: team.id,
          ownerKind: inheritedOwnerKind,
          creatorMemberId: inheritedOwnerKind === "team" ? null : inheritedCreatorMemberId,
          viewId: inheritedViewId,
          locked: inheritedLocked,
          lockedByMemberId: inheritedLockedByMemberId,
          ...(inheritedExecutionEnvironmentId !== null
            ? { executionEnvironmentId: inheritedExecutionEnvironmentId }
            : {}),
          ...(inheritedExecutionEnvironmentLabel !== null
            ? { executionEnvironmentLabel: inheritedExecutionEnvironmentLabel }
            : {}),
          createdAt: nowIso,
          ...(inheritedOwnerKind === "team" && input.teamAutomation !== undefined
            ? {
                ownerAutomationScope: {
                  turnId: `thread-owner:${input.threadId}`,
                  threadId: input.threadId,
                  taskId: input.teamAutomation.taskId,
                  teamId: team.id,
                  projectId: input.teamAutomation.projectId,
                  environmentId:
                    inheritedExecutionEnvironmentId ?? input.teamAutomation.environmentId,
                  viewId: inheritedViewId,
                  mcpAccessLevel: input.teamAutomation.mcpAccessLevel,
                  createdAt: nowIso,
                },
              }
            : {}),
        })
        .pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("TeamService.recordThreadInheritedFromParent write failed", {
              threadId: input.threadId,
              cause,
            }),
          ),
          Effect.orElseSucceed(() => Option.none<TeamThreadAttribution>()),
        );
      if (Option.isSome(attribution)) {
        yield* publish({
          version: 1,
          type: "threadAttributed",
          payload: attribution.value,
        });
        yield* publishAccessChange({ type: "threadView", threadId: input.threadId });
      }
      if (input.turnId) {
        if (input.teamAutomation !== undefined) {
          yield* recordTeamAutomationTurn({
            threadId: input.threadId,
            turnId: input.turnId,
            principal: input.teamAutomation,
          });
        } else if (inheritedOwnerKind === "member" && inheritedCreatorMemberId !== null) {
          const inserted = yield* repository
            .recordTurnAttribution({
              turnId: input.turnId,
              threadId: input.threadId,
              authorKind: "member",
              authorMemberId: inheritedCreatorMemberId,
              createdAt: nowIso,
            })
            .pipe(
              Effect.tapError((cause) =>
                Effect.logWarning("TeamService.recordThreadInheritedFromParent turn write failed", {
                  threadId: input.threadId,
                  turnId: input.turnId,
                  cause,
                }),
              ),
              Effect.orElseSucceed(() => false),
            );
          if (inserted && !input.turnId.startsWith("msg:")) {
            yield* publish({
              version: 1,
              type: "turnAttributed",
              payload: {
                turnId: input.turnId,
                threadId: input.threadId,
                authorKind: "member",
                authorMemberId: inheritedCreatorMemberId,
                authorPseudo: inheritedCreatorPseudo,
                createdAt: nowIso,
              },
            });
          }
        }
      }
    },
  );

  const assignProject = Effect.fn("TeamService.assignProject")(function* (input: {
    readonly sessionId: AuthSessionId;
    readonly payload: TeamAssignProjectInput;
    readonly projectService?: ProjectService.ProjectService["Service"];
  }) {
    const team = yield* requireWorkspace();
    const actor = yield* requireActiveMember(input.sessionId);
    if (actor.teamId !== team.id || !canManageTeamProjects(actor.role)) {
      return yield* new TeamOperationError({
        code: "forbidden",
        message: "Only owner and admin members can assign projects to a team.",
      });
    }
    const defaultViewId = input.payload.defaultViewId ?? null;
    if (defaultViewId !== null) {
      const viewOption = yield* repository
        .getViewById(defaultViewId)
        .pipe(Effect.mapError(toInternalError));
      if (Option.isNone(viewOption) || viewOption.value.teamId !== team.id) {
        return yield* new TeamOperationError({
          code: "not_found",
          message: "Selected default team view could not be found.",
        });
      }
    }
    let repoIdentityKey: string | null = input.payload.repoIdentityKey ?? null;
    if (repoIdentityKey === null && input.projectService !== undefined) {
      const projectOption = yield* input.projectService
        .getById(input.payload.projectId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isSome(projectOption)) {
        repoIdentityKey =
          projectOption.value.repositoryIdentity?.origin?.canonicalKey ??
          projectOption.value.repositoryIdentity?.canonicalKey ??
          null;
      }
    }
    const nowIso = DateTime.formatIso(yield* DateTime.now);
    const saved = yield* repository
      .upsertProjectAssignment({
        projectId: input.payload.projectId,
        teamId: team.id,
        defaultViewId,
        repoIdentityKey,
        assignedByMemberId: actor.id,
        createdAt: nowIso,
        updatedAt: nowIso,
      })
      .pipe(Effect.mapError(toInternalError));
    yield* publish({ version: 1, type: "projectAssigned", payload: saved });
    return saved;
  });

  const unassignProject = Effect.fn("TeamService.unassignProject")(function* (input: {
    readonly sessionId: AuthSessionId;
    readonly payload: TeamUnassignProjectInput;
  }) {
    const team = yield* requireWorkspace();
    const actor = yield* requireActiveMember(input.sessionId);
    if (actor.teamId !== team.id || !canManageTeamProjects(actor.role)) {
      return yield* new TeamOperationError({
        code: "forbidden",
        message: "Only owner and admin members can unassign projects from a team.",
      });
    }
    const unassigned = yield* repository
      .deleteProjectAssignment({
        teamId: team.id,
        projectId: input.payload.projectId,
      })
      .pipe(Effect.mapError(toInternalError));
    if (unassigned) {
      yield* publish({
        version: 1,
        type: "projectUnassigned",
        payload: { projectId: input.payload.projectId },
      });
    }
    return { unassigned } satisfies TeamUnassignProjectResult;
  });

  const attachEnvironment = Effect.fn("TeamService.attachEnvironment")(function* (input: {
    readonly sessionId: AuthSessionId;
    readonly payload: TeamAttachEnvironmentInput;
    readonly peerLinks?: PeerLinks.PeerLinks["Service"];
  }) {
    const team = yield* requireWorkspace();
    const actor = yield* requireActiveMember(input.sessionId);
    if (actor.teamId !== team.id || !canManageTeamEnvironments(actor.role)) {
      return yield* new TeamOperationError({
        code: "forbidden",
        message: "Only owner and admin members can attach remote team environments.",
      });
    }
    yield* ensureDefaultEnvironmentForTeam(team);
    if (
      (input.payload.url === undefined || input.payload.pairingCode === undefined) &&
      input.payload.environmentId === undefined
    ) {
      return yield* new TeamOperationError({
        code: "invalid_input",
        message: "Provide either an existing environmentId or a remote URL and pairing code.",
      });
    }
    const accessRule = normalizeAccessRule(
      input.payload.accessRule ?? { roles: [...ALL_TEAM_ROLES], memberIds: [] },
    );
    yield* validateAccessRuleMemberIds(team.id, [accessRule]);

    // Serialize attachment with deleteTeam (withMembershipMutationGate) and pending revocation
    // drains (remoteEnvLifecycleLock) while preserving lock order:
    // withMembershipMutationGate -> remoteEnvLifecycleLock.
    const environment = yield* withMembershipMutationGate(
      remoteEnvLifecycleLock.withPermits(1)(
        Effect.gen(function* () {
          const activeTeam = yield* requireWorkspace();
          if (activeTeam.id !== team.id) {
            return yield* new TeamOperationError({
              code: "not_found",
              message: "The target team workspace changed before attachment completed.",
            });
          }
          const activeActor = yield* requireActiveMember(input.sessionId);
          if (
            activeActor.teamId !== activeTeam.id ||
            !canManageTeamEnvironments(activeActor.role)
          ) {
            return yield* new TeamOperationError({
              code: "forbidden",
              message: "Only owner and admin members can attach remote team environments.",
            });
          }
          yield* validateAccessRuleMemberIds(activeTeam.id, [accessRule]);
          let environmentId = input.payload.environmentId;
          let resolvedName = input.payload.name?.trim();
          let peerLinkId: string | null = null;

          if (input.payload.url !== undefined && input.payload.pairingCode !== undefined) {
            if (input.peerLinks === undefined) {
              return yield* new TeamOperationError({
                code: "environment_unavailable",
                message: "Peer environment linking is unavailable on this server.",
              });
            }
            const linked = yield* input.peerLinks
              .linkUnlessLinked({
                url: input.payload.url,
                pairingCode: input.payload.pairingCode,
                access: input.payload.access ?? "full-access",
              })
              .pipe(
                Effect.mapError(
                  (error) =>
                    new TeamOperationError({
                      code: "environment_unavailable",
                      message: error.message,
                    }),
                ),
              );
            environmentId = linked.link.environmentId;
            peerLinkId = linked.link.environmentId;
            resolvedName = resolvedName || linked.link.label;
          } else if (environmentId !== undefined) {
            peerLinkId = environmentId;
            if (input.peerLinks !== undefined && !resolvedName) {
              const existingPeer = yield* input.peerLinks
                .get(environmentId)
                .pipe(Effect.orElseSucceed(() => Option.none()));
              if (Option.isSome(existingPeer)) {
                resolvedName = existingPeer.value.label;
              }
            }
          } else {
            return yield* new TeamOperationError({
              code: "invalid_input",
              message: "Provide either an existing environmentId or a remote URL and pairing code.",
            });
          }

          const nowIso = DateTime.formatIso(yield* DateTime.now);
          const recordId = TeamEnvironmentRecordId.make(
            yield* random.uuidV4().pipe(Effect.mapError(toInternalError)),
          );
          const nextEnvironment: TeamEnvironment = {
            id: recordId,
            teamId: activeTeam.id,
            environmentId,
            name: resolvedName && resolvedName.length > 0 ? resolvedName : environmentId,
            isDefault: false,
            peerLinkId,
            accessRule,
            createdAt: nowIso,
            updatedAt: nowIso,
          };
          yield* repository.createEnvironment(nextEnvironment).pipe(
            Effect.catchTags({
              TeamEnvironmentAlreadyAttachedError: (error) =>
                Effect.fail(
                  new TeamOperationError({
                    code: "environment_already_attached",
                    message: error.message,
                  }),
                ),
              TeamRepositoryError: (error) => Effect.fail(toInternalError(error)),
            }),
          );
          // Clear any stale unlink_after_revoke flag from an earlier offline detach so background
          // revocation drain revokes old sessions without tearing down this re-attached environment.
          yield* repository
            .clearPendingRemoteRevocationUnlinkFlag({ teamId: activeTeam.id, environmentId })
            .pipe(Effect.mapError(toInternalError));
          return nextEnvironment;
        }),
      ),
    );
    yield* publish({ version: 1, type: "environmentUpserted", payload: environment });
    yield* publishAccessChange({ type: "environment", environmentId: environment.environmentId });
    return environment;
  });

  const updateEnvironment = Effect.fn("TeamService.updateEnvironment")(function* (input: {
    readonly sessionId: AuthSessionId;
    readonly payload: TeamUpdateEnvironmentInput;
    readonly peerClientPairing?: PeerClientPairing.PeerClientPairing["Service"];
  }) {
    const team = yield* requireWorkspace();
    const actor = yield* requireActiveMember(input.sessionId);
    if (actor.teamId !== team.id || !canManageTeamEnvironments(actor.role)) {
      return yield* new TeamOperationError({
        code: "forbidden",
        message: "Only owner and admin members can update team environment ACLs.",
      });
    }
    yield* ensureDefaultEnvironmentForTeam(team);
    const nextName = input.payload.name !== undefined ? input.payload.name.trim() : undefined;
    if (nextName !== undefined && nextName.length === 0) {
      return yield* new TeamOperationError({
        code: "invalid_input",
        message: "Environment name cannot be empty.",
      });
    }
    const nextAccessRule =
      input.payload.accessRule !== undefined
        ? normalizeAccessRule(input.payload.accessRule)
        : undefined;
    const updated = yield* withMembershipMutationGate(
      Effect.gen(function* () {
        const activeTeam = yield* requireWorkspace();
        if (activeTeam.id !== team.id) {
          return yield* new TeamOperationError({
            code: "not_found",
            message: "The target team workspace changed before updating the environment.",
          });
        }
        const activeActor = yield* requireActiveMember(input.sessionId);
        if (activeActor.teamId !== activeTeam.id || !canManageTeamEnvironments(activeActor.role)) {
          return yield* new TeamOperationError({
            code: "forbidden",
            message: "Only owner and admin members can update team environment ACLs.",
          });
        }
        yield* validateAccessRuleMemberIds(activeTeam.id, [nextAccessRule]);
        const updatedAt = DateTime.formatIso(yield* DateTime.now);
        return yield* repository
          .updateEnvironment({
            teamId: activeTeam.id,
            environmentId: input.payload.environmentId,
            ...(nextName !== undefined ? { name: nextName } : {}),
            ...(nextAccessRule !== undefined ? { accessRule: nextAccessRule } : {}),
            updatedAt,
          })
          .pipe(Effect.mapError(toInternalError));
      }),
    );
    if (Option.isNone(updated)) {
      return yield* new TeamOperationError({
        code: "not_found",
        message: "Team environment could not be found.",
      });
    }
    if (nextAccessRule !== undefined) {
      const members = yield* repository
        .listMembers(team.id)
        .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<TeamMember>));
      const revokedMembers = members.filter(
        (member) => !canMemberAccessTeamEnvironment(member, updated.value),
      );
      yield* notifyGitHubCredentialChanged({
        kind: "environment",
        teamId: team.id,
        environmentId: updated.value.environmentId,
        revokedMemberIds: revokedMembers.map((member) => member.id),
      });
      if (input.peerClientPairing && !updated.value.isDefault) {
        const revokedSubjects = revokedMembers.map((member) =>
          remoteSubjectForMember(team.id, member.id),
        );
        yield* withRemoteRevocationBarrier(
          revokeRemoteMemberGrantsForEnvironments({
            teamId: team.id,
            peerClientPairing: input.peerClientPairing,
            environmentIds: [updated.value.environmentId],
            subjectPrefixes: revokedSubjects,
          }),
        );
      }
    }
    yield* publish({ version: 1, type: "environmentUpserted", payload: updated.value });
    yield* publishAccessChange({
      type: "environment",
      environmentId: updated.value.environmentId,
    });
    return updated.value;
  });

  const detachEnvironment = Effect.fn("TeamService.detachEnvironment")(function* (input: {
    readonly sessionId: AuthSessionId;
    readonly payload: TeamDetachEnvironmentInput;
    readonly peerLinks?: PeerLinks.PeerLinks["Service"];
    readonly peerClientPairing?: PeerClientPairing.PeerClientPairing["Service"];
  }) {
    const team = yield* requireWorkspace();
    const actor = yield* requireActiveMember(input.sessionId);
    if (actor.teamId !== team.id || !canManageTeamEnvironments(actor.role)) {
      return yield* new TeamOperationError({
        code: "forbidden",
        message: "Only owner and admin members can detach team environments.",
      });
    }
    yield* ensureDefaultEnvironmentForTeam(team);
    const detached = yield* repository
      .deleteEnvironment({
        teamId: team.id,
        environmentId: input.payload.environmentId,
      })
      .pipe(
        Effect.catchTags({
          TeamDefaultEnvironmentProtectedError: (error) =>
            Effect.fail(
              new TeamOperationError({
                code: "default_environment_protected",
                message: error.message,
              }),
            ),
          TeamRepositoryError: (error) => Effect.fail(toInternalError(error)),
        }),
      );
    if (detached) {
      yield* notifyGitHubCredentialChanged({
        kind: "environment",
        teamId: team.id,
        environmentId: input.payload.environmentId,
      });
      const shouldUnlink = input.payload.unlinkPeer !== false;
      yield* withRemoteRevocationBarrier(
        Effect.gen(function* () {
          let revocationComplete = true;
          if (input.peerClientPairing) {
            const outcome = yield* revokeRemoteMemberGrantsForEnvironments({
              teamId: team.id,
              peerClientPairing: input.peerClientPairing,
              environmentIds: [input.payload.environmentId],
              subjectPrefixes: [remoteSubjectPrefixForTeam(team.id)],
              unlinkAfterRevoke: shouldUnlink,
            });
            revocationComplete = outcome.allSucceeded;
          }
          // Retain the peer link when the remote is unreachable so pending revocations can drain later.
          if (shouldUnlink && revocationComplete && input.peerLinks !== undefined) {
            const peerLinks = input.peerLinks;
            yield* remoteEnvLifecycleLock.withPermits(1)(
              Effect.gen(function* () {
                const reattached = yield* repository
                  .getEnvironmentByEnvironmentId({
                    teamId: team.id,
                    environmentId: input.payload.environmentId,
                  })
                  .pipe(Effect.orElseSucceed(() => Option.none<TeamEnvironment>()));
                if (Option.isNone(reattached)) {
                  yield* peerLinks.unlink(input.payload.environmentId).pipe(Effect.ignore);
                }
              }),
            );
          }
        }),
      );
      yield* publish({
        version: 1,
        type: "environmentRemoved",
        payload: { environmentId: input.payload.environmentId },
      });
      yield* publishAccessChange({
        type: "environment",
        environmentId: input.payload.environmentId,
      });
    }
    return { detached } satisfies TeamDetachEnvironmentResult;
  });

  const unlinkRemoteEnvironment = Effect.fn("TeamService.unlinkRemoteEnvironment")(
    function* (input: {
      readonly environmentId: EnvironmentId;
      readonly peerClientPairing?: PeerClientPairing.PeerClientPairing["Service"];
      readonly peerLinks: PeerLinks.PeerLinks["Service"];
    }) {
      const workspaceOption = yield* repository
        .getWorkspace()
        .pipe(Effect.orElseSucceed(() => Option.none<TeamWorkspace>()));
      if (Option.isNone(workspaceOption) || !input.peerClientPairing) {
        return yield* input.peerLinks.unlink(input.environmentId);
      }
      const teamId = workspaceOption.value.id;
      const peerClientPairing = input.peerClientPairing;
      return yield* withRemoteRevocationBarrier(
        Effect.gen(function* () {
          const outcome = yield* revokeRemoteMemberGrantsForEnvironments({
            teamId,
            peerClientPairing,
            environmentIds: [input.environmentId],
            subjectPrefixes: [remoteSubjectPrefixForTeam(teamId)],
            unlinkAfterRevoke: true,
          });
          if (!outcome.allSucceeded) {
            return { removed: false, endedThere: false };
          }
          return yield* remoteEnvLifecycleLock.withPermits(1)(
            input.peerLinks.unlink(input.environmentId),
          );
        }),
      );
    },
  );

  const pairRemoteEnvironmentForSession = Effect.fn("TeamService.pairRemoteEnvironmentForSession")(
    function* (input: {
      readonly sessionId: AuthSessionId;
      readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
      readonly pairingInput: Parameters<
        PeerClientPairing.PeerClientPairing["Service"]["request"]
      >[0];
      readonly peerClientPairing: PeerClientPairing.PeerClientPairing["Service"];
      readonly peerLinks?: PeerLinks.PeerLinks["Service"];
    }) {
      const admittedWorkspaceId = yield* repository.getWorkspace().pipe(
        Effect.map((workspace) => Option.map(workspace, (w) => w.id)),
        Effect.mapError(() =>
          teamPostAuthError(
            "Could not resolve team workspace state for remote environment pairing.",
          ),
        ),
      );
      yield* assertCanAccessEnvironment(input.sessionId, input.pairingInput.environmentId);
      yield* drainPendingRemoteRevocations({
        environmentId: input.pairingInput.environmentId,
        peerClientPairing: input.peerClientPairing,
        ...(input.peerLinks !== undefined ? { peerLinks: input.peerLinks } : {}),
      }).pipe(Effect.ignore);
      return yield* withRemotePairingPermit(
        Effect.gen(function* () {
          const currentWorkspaceId = yield* repository.getWorkspace().pipe(
            Effect.map((workspace) => Option.map(workspace, (w) => w.id)),
            Effect.mapError(() =>
              teamPostAuthError(
                "Could not verify team workspace state for remote environment pairing.",
              ),
            ),
          );
          if (Option.getOrNull(currentWorkspaceId) !== Option.getOrNull(admittedWorkspaceId)) {
            return yield* teamPostAuthError(
              "Team workspace state changed while preparing remote environment pairing; retry the request.",
            );
          }
          yield* assertCanAccessEnvironment(input.sessionId, input.pairingInput.environmentId);
          const subjectOption = yield* getRemotePairingSubject(input.sessionId);
          const memberBefore = Option.isSome(subjectOption)
            ? yield* repository
                .getMemberForSession(input.sessionId)
                .pipe(
                  Effect.mapError(() =>
                    teamPostAuthError(
                      "Could not resolve team membership for remote environment pairing.",
                    ),
                  ),
                )
            : Option.none<TeamMember>();
          const effectiveScopes =
            Option.isSome(memberBefore) && !isTeamAdminOrOwner(memberBefore.value)
              ? input.scopes.filter((scope) => !ADMIN_ONLY_SESSION_SCOPES.has(scope))
              : input.scopes;
          const requestedAdminScopes = effectiveScopes.some((scope) =>
            ADMIN_ONLY_SESSION_SCOPES.has(scope),
          );
          const result = yield* input.peerClientPairing.request(input.pairingInput, {
            sessionId: input.sessionId,
            scopes: effectiveScopes,
            ...(Option.isSome(subjectOption) ? { teamMemberSubject: subjectOption.value } : {}),
          });
          if (Option.isSome(subjectOption) && result.type === "credential") {
            yield* assertCanAccessEnvironment(input.sessionId, input.pairingInput.environmentId);
            yield* getRemotePairingSubject(input.sessionId);
            if (requestedAdminScopes) {
              const memberAfter = yield* repository
                .getMemberForSession(input.sessionId)
                .pipe(
                  Effect.mapError(() =>
                    teamPostAuthError(
                      "Could not verify team membership after remote environment pairing.",
                    ),
                  ),
                );
              if (Option.isNone(memberAfter) || !isTeamAdminOrOwner(memberAfter.value)) {
                return yield* teamPostAuthError(
                  "Your team role changed while pairing with this remote environment. Please retry.",
                );
              }
            }
          }
          return result;
        }),
      );
    },
  );

  const getRemotePairingSubject = Effect.fn("TeamService.getRemotePairingSubject")(function* (
    sessionId: AuthSessionId,
  ) {
    const workspaceOption = yield* repository.getWorkspace().pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("TeamService.getRemotePairingSubject(getWorkspace) failed", { cause }),
      ),
      Effect.mapError(() =>
        teamPostAuthError("Could not resolve team membership for remote environment pairing."),
      ),
    );
    if (Option.isNone(workspaceOption)) return Option.none<string>();
    const team = workspaceOption.value;
    const memberOption = yield* repository.getMemberForSession(sessionId).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("TeamService.getRemotePairingSubject(getMemberForSession) failed", {
          cause,
        }),
      ),
      Effect.mapError(() =>
        teamPostAuthError("Could not resolve team membership for remote environment pairing."),
      ),
    );
    if (
      Option.isNone(memberOption) ||
      memberOption.value.teamId !== team.id ||
      memberOption.value.status !== "active"
    ) {
      return yield* teamPostAuthError("This session is not bound to an active team member.");
    }
    return Option.some(remoteSubjectForMember(team.id, memberOption.value.id));
  });

  const assertCanAccessLocalEnvironment = Effect.fn("TeamService.assertCanAccessLocalEnvironment")(
    function* (sessionId: AuthSessionId) {
      const workspaceOption = yield* repository.getWorkspace().pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("TeamService.assertCanAccessLocalEnvironment(getWorkspace) failed", {
            cause,
          }),
        ),
        Effect.mapError(() => teamPostAuthError("Could not verify team environment permissions.")),
      );
      if (Option.isNone(workspaceOption)) return;
      const localEnv = yield* resolveLocalEnvironmentIdentity();
      yield* assertActorCanAccessEnvironment(sessionActor(sessionId), localEnv.environmentId);
    },
  );

  const canActorAccessEnvironment = Effect.fn("TeamService.canActorAccessEnvironment")(function* (
    actor: TeamActor,
    environmentId: EnvironmentId,
  ) {
    return yield* Effect.gen(function* () {
      const workspaceOption = yield* repository.getWorkspace();
      if (Option.isNone(workspaceOption)) return true;
      const team = workspaceOption.value;
      const memberOption = yield* resolveMemberForActor(actor);
      const member =
        Option.isSome(memberOption) && memberOption.value.teamId === team.id
          ? memberOption.value
          : null;
      if (!member || member.status !== "active") return false;
      yield* ensureDefaultEnvironmentForTeam(team).pipe(Effect.ignore);
      const envOption = yield* repository.getEnvironmentByEnvironmentId({
        teamId: team.id,
        environmentId,
      });
      if (isMinimalAutomationActor(actor)) {
        return environmentId === actor.principal.environmentId && Option.isSome(envOption);
      }
      if (Option.isNone(envOption)) {
        // Unregistered peer environments are restricted to owner/admin only (fail closed for regular/modo).
        return isTeamAdminOrOwner(member);
      }
      return canMemberAccessTeamEnvironment(member, envOption.value);
    }).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("TeamService.canActorAccessEnvironment failed; denying", {
          environmentId,
          cause,
        }),
      ),
      Effect.orElseSucceed(() => false),
    );
  });

  const assertActorCanAccessEnvironment = Effect.fn("TeamService.assertActorCanAccessEnvironment")(
    function* (actor: TeamActor, environmentId: EnvironmentId) {
      const allowed = yield* canActorAccessEnvironment(actor, environmentId);
      if (!allowed) {
        return yield* new EnvironmentAuthorizationError({
          message: "You do not have permission to access this team environment.",
          requiredScope: AuthOrchestrationOperateScope,
          requiredPermission: "team:environment:access",
        });
      }
    },
  );

  const assertCanAccessEnvironment = (sessionId: AuthSessionId, environmentId: EnvironmentId) =>
    assertActorCanAccessEnvironment(sessionActor(sessionId), environmentId);

  const filterAccessibleEnvironmentIdsForActor = Effect.fn(
    "TeamService.filterAccessibleEnvironmentIdsForActor",
  )(function* (actor: TeamActor, environmentIds: ReadonlyArray<EnvironmentId>) {
    if (environmentIds.length === 0) {
      return new Set<EnvironmentId>() as ReadonlySet<EnvironmentId>;
    }
    return yield* Effect.gen(function* () {
      const workspaceOption = yield* repository.getWorkspace();
      if (Option.isNone(workspaceOption)) {
        return new Set<EnvironmentId>(environmentIds) as ReadonlySet<EnvironmentId>;
      }
      const team = workspaceOption.value;
      const memberOption = yield* resolveMemberForActor(actor);
      const member =
        Option.isSome(memberOption) && memberOption.value.teamId === team.id
          ? memberOption.value
          : null;
      if (!member || member.status !== "active") {
        return new Set<EnvironmentId>() as ReadonlySet<EnvironmentId>;
      }
      yield* ensureDefaultEnvironmentForTeam(team).pipe(Effect.ignore);
      const envs = yield* repository.listEnvironments(team.id);
      const envById = new Map(envs.map((env) => [env.environmentId, env] as const));
      const allowed = new Set<EnvironmentId>();
      for (const envId of environmentIds) {
        if (isMinimalAutomationActor(actor)) {
          if (envId === actor.principal.environmentId && envById.has(envId)) {
            allowed.add(envId);
          }
          continue;
        }
        const registered = envById.get(envId);
        if (registered !== undefined) {
          if (canMemberAccessTeamEnvironment(member, registered)) {
            allowed.add(envId);
          }
        } else if (isTeamAdminOrOwner(member)) {
          allowed.add(envId);
        }
      }
      return allowed as ReadonlySet<EnvironmentId>;
    }).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning(
          "TeamService.filterAccessibleEnvironmentIdsForActor failed; failing closed",
          {
            cause,
          },
        ),
      ),
      Effect.orElseSucceed(() => new Set<EnvironmentId>() as ReadonlySet<EnvironmentId>),
    );
  });

  const filterAccessibleEnvironmentIds = (
    sessionId: AuthSessionId,
    environmentIds: ReadonlyArray<EnvironmentId>,
  ) => filterAccessibleEnvironmentIdsForActor(sessionActor(sessionId), environmentIds);

  const assertActorCanExecuteOnThreadEnvironment = Effect.fn(
    "TeamService.assertActorCanExecuteOnThreadEnvironment",
  )(function* (
    actor: TeamActor,
    threadId: ThreadId,
    options?: { readonly upstreamCompat?: boolean },
  ) {
    const failClosed =
      <A, E, R>(label: string) =>
      (effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.tapError((cause) =>
            Effect.logWarning(
              `TeamService.assertActorCanExecuteOnThreadEnvironment(${label}) failed`,
              {
                threadId,
                cause,
              },
            ),
          ),
          Effect.mapError(() =>
            teamPostAuthError("Could not verify thread environment execution permissions."),
          ),
        );
    const workspaceOption = yield* repository.getWorkspace().pipe(failClosed("getWorkspace"));
    if (Option.isNone(workspaceOption)) return;
    const team = workspaceOption.value;
    const [memberOption, attributionOption] = yield* Effect.all([
      resolveMemberForActor(actor).pipe(failClosed("resolveMemberForActor")),
      repository.getThreadAttribution(threadId).pipe(failClosed("getThreadAttribution")),
    ]);
    const member =
      Option.isSome(memberOption) && memberOption.value.teamId === team.id
        ? memberOption.value
        : null;
    if (!member || member.status !== "active") {
      return yield* teamPostAuthError("This session is not bound to an active team member.");
    }
    if (Option.isNone(attributionOption)) {
      if (isMinimalAutomationActor(actor)) {
        return yield* teamPostAuthError(
          "Minimal team automations can only execute on attributed threads within their configured environment.",
        );
      }
      const localEnv = yield* resolveLocalEnvironmentIdentity();
      yield* assertActorCanAccessEnvironment(actor, localEnv.environmentId);
      return;
    }
    const attribution = attributionOption.value;
    if (attribution.isLocalSynced === true) {
      const label =
        attribution.executionEnvironmentLabel ?? `${attribution.creatorPseudo}'s local environment`;
      return yield* teamPostAuthError(
        options?.upstreamCompat === true
          ? formatUpstreamCompatLocalEnvironmentBlockedMessage(label)
          : `Cannot execute turns on "${label}". Local-environment threads run exclusively on their owner's machine; fork the thread or leave a note instead.`,
      );
    }
    yield* ensureDefaultEnvironmentForTeam(team).pipe(
      failClosed("ensureDefaultEnvironmentForTeam"),
    );
    const environments = yield* repository
      .listEnvironments(team.id)
      .pipe(failClosed("listEnvironments"));
    if (isMinimalAutomationActor(actor)) {
      const localEnv = yield* resolveLocalEnvironmentIdentity();
      const threadEnvId = attribution.executionEnvironmentId ?? localEnv.environmentId;
      if (
        threadEnvId !== actor.principal.environmentId ||
        !environments.some((env) => env.environmentId === threadEnvId)
      ) {
        return yield* teamPostAuthError(
          "Minimal team automations can only execute on their configured environment.",
        );
      }
      return;
    }
    const access = resolveTeamThreadEnvironmentAccess({
      member,
      attribution,
      environments,
    });
    if (!access.canExecute) {
      return yield* teamPostAuthError(
        options?.upstreamCompat === true
          ? formatUpstreamCompatRemoteEnvironmentBlockedMessage(access.environmentLabel)
          : `You do not have permission to execute turns on environment "${access.environmentLabel}". Fork the thread or leave a note instead.`,
      );
    }
  });

  const assertCanExecuteOnThreadEnvironment = (
    sessionId: AuthSessionId,
    threadId: ThreadId,
    options?: { readonly upstreamCompat?: boolean },
  ) => assertActorCanExecuteOnThreadEnvironment(sessionActor(sessionId), threadId, options);

  const syncLocalThread = Effect.fn("TeamService.syncLocalThread")(function* (input: {
    readonly sessionId: AuthSessionId;
    readonly payload: TeamSyncLocalThreadInput;
    readonly eventSink?: EventSink.EventSinkV2["Service"];
    readonly projectionStore?: ProjectionStore.ProjectionStoreV2["Service"];
  }) {
    const team = yield* requireWorkspace();
    const actor = yield* requireActiveMember(input.sessionId);
    if (actor.teamId !== team.id) {
      return yield* new TeamOperationError({
        code: "forbidden",
        message: "This session does not belong to the active team.",
      });
    }
    yield* ensureDefaultEnvironmentForTeam(team);
    const localEnv = yield* resolveLocalEnvironmentIdentity();
    const registeredEnvironments = yield* repository
      .listEnvironments(team.id)
      .pipe(Effect.mapError(toInternalError));
    if (
      input.payload.executionEnvironmentId === localEnv.environmentId ||
      registeredEnvironments.some(
        (env) => env.environmentId === input.payload.executionEnvironmentId,
      )
    ) {
      return yield* new TeamOperationError({
        code: "invalid_input",
        message:
          "Local-synced threads cannot use the Team Server or a registered team environment ID.",
      });
    }
    const projectAssignment = yield* repository
      .getProjectAssignment(input.payload.projectId)
      .pipe(Effect.mapError(toInternalError));
    if (Option.isNone(projectAssignment) || projectAssignment.value.teamId !== team.id) {
      return yield* new TeamOperationError({
        code: "forbidden",
        message: "Local threads can only be synced to projects assigned to this team.",
      });
    }
    const existingAttribution = yield* repository
      .getThreadAttribution(input.payload.threadId)
      .pipe(Effect.mapError(toInternalError));
    const incomingUpdatedMs = DateTime.toEpochMillis(DateTime.makeUnsafe(input.payload.updatedAt));
    const incomingSyncSeq = input.payload.syncSeq;

    let resolvedViewId: TeamViewId;
    let locked: boolean;
    let existingWatermark: TeamRepository.TeamLocalSyncWatermark | null = null;

    if (Option.isSome(existingAttribution)) {
      const existing = existingAttribution.value;
      if (
        existing.teamId !== team.id ||
        existing.isLocalSynced !== true ||
        existing.creatorMemberId !== actor.id ||
        (existing.executionEnvironmentId !== null &&
          existing.executionEnvironmentId !== input.payload.executionEnvironmentId)
      ) {
        return yield* new TeamOperationError({
          code: "forbidden",
          message: "Only the owner of a local-synced thread can update its synced state.",
        });
      }
      const persistedViewOption = yield* repository
        .getViewById(existing.viewId)
        .pipe(Effect.mapError(toInternalError));
      const persistedView =
        Option.isSome(persistedViewOption) && persistedViewOption.value.teamId === team.id
          ? persistedViewOption.value
          : null;
      const postBlockReason = resolveTeamThreadPostBlockReason({
        member: actor,
        attribution: existing,
        view: persistedView,
      });
      if (postBlockReason !== "ok") {
        return yield* new TeamOperationError({
          code: "forbidden",
          message:
            postBlockReason === "locked"
              ? "This thread is locked. Only team owners and admins can sync updates."
              : "You do not have permission to sync updates to this thread in its current view.",
        });
      }
      if (
        yield* repository
          .isThreadDeletedInProjection(input.payload.threadId)
          .pipe(Effect.mapError(toInternalError))
      ) {
        return { attribution: existing } satisfies TeamSyncLocalThreadResult;
      }
      const watermarkOption = yield* repository
        .getLocalSyncWatermark(input.payload.threadId)
        .pipe(Effect.mapError(toInternalError));
      if (Option.isSome(watermarkOption)) {
        existingWatermark = watermarkOption.value;
        const lastUpdatedMs = DateTime.toEpochMillis(
          DateTime.makeUnsafe(existingWatermark.lastUpdatedAt),
        );
        const isStaleTimestamp = incomingUpdatedMs < lastUpdatedMs;
        const isStaleSeq =
          incomingUpdatedMs === lastUpdatedMs &&
          existingWatermark.lastSyncSeq > 0 &&
          (incomingSyncSeq ?? 0) < existingWatermark.lastSyncSeq;
        if (isStaleTimestamp || isStaleSeq) {
          return { attribution: existing } satisfies TeamSyncLocalThreadResult;
        }
      }
      resolvedViewId = existing.viewId;
      locked = existing.locked;
    } else {
      if (input.projectionStore !== undefined) {
        const existingProjection = yield* input.projectionStore
          .getThreadProjection(input.payload.threadId)
          .pipe(
            Effect.catchTags({
              ProjectionStoreThreadNotFoundError: () => Effect.succeed(null),
            }),
            Effect.mapError(toInternalError),
          );
        if (existingProjection !== null) {
          return yield* new TeamOperationError({
            code: "forbidden",
            message: "Cannot overwrite an existing Team Server thread via local sync.",
          });
        }
      }
      resolvedViewId = yield* resolveDefaultViewIdForProject(
        team,
        input.payload.projectId,
        input.payload.viewId,
      );
      const viewOption = yield* repository
        .getViewById(resolvedViewId)
        .pipe(Effect.mapError(toInternalError));
      const view =
        Option.isSome(viewOption) && viewOption.value.teamId === team.id ? viewOption.value : null;
      locked = input.payload.locked === true;
      if (view === null || !canMemberCreateThreadInTeamView(actor, view, locked)) {
        return yield* new TeamOperationError({
          code: "forbidden",
          message: "You do not have permission to sync a thread into this view.",
        });
      }
    }

    const label =
      input.payload.executionEnvironmentLabel?.trim() || `${actor.pseudo}'s local environment`;
    const attributionOption = yield* repository
      .upsertLocalSyncedThreadAttribution({
        threadId: input.payload.threadId,
        teamId: team.id,
        creatorMemberId: actor.id,
        viewId: resolvedViewId,
        locked,
        lockedByMemberId: locked ? actor.id : null,
        executionEnvironmentId: input.payload.executionEnvironmentId,
        executionEnvironmentLabel: label,
        createdAt: input.payload.createdAt,
      })
      .pipe(
        Effect.catchTags({
          TeamMemberForbiddenError: (error) =>
            Effect.fail(
              new TeamOperationError({
                code: "forbidden",
                message: error.message,
              }),
            ),
          TeamRepositoryError: (error) => Effect.fail(toInternalError(error)),
        }),
      );
    if (Option.isNone(attributionOption)) {
      return yield* new TeamOperationError({
        code: "internal",
        message: "Failed to persist local-synced thread metadata.",
      });
    }
    if (input.eventSink !== undefined && input.projectionStore !== undefined) {
      yield* mirrorLocalThreadSnapshotToEventSink({
        eventSink: input.eventSink,
        projectionStore: input.projectionStore,
        random,
        sync: input.payload,
      }).pipe(Effect.mapError(toInternalError));
    }
    const nowIso = DateTime.formatIso(yield* DateTime.now);
    const nextSyncSeq =
      existingWatermark !== null &&
      DateTime.toEpochMillis(DateTime.makeUnsafe(existingWatermark.lastUpdatedAt)) ===
        incomingUpdatedMs
        ? Math.max(existingWatermark.lastSyncSeq, incomingSyncSeq ?? 0)
        : (incomingSyncSeq ?? 0);
    yield* repository
      .upsertLocalSyncWatermark({
        threadId: input.payload.threadId,
        teamId: team.id,
        lastUpdatedAt: input.payload.updatedAt,
        lastSyncSeq: nextSyncSeq,
        updatedAt: nowIso,
      })
      .pipe(Effect.mapError(toInternalError));
    // Record turn attributions, relink msg:<userMessageId> note anchors to mirrored run IDs, and
    // re-anchor pending notes once for the highest-ordinal brand-new local run.
    let highestInsertedRun: {
      readonly ordinal: number;
      readonly mirroredRunId: string;
    } | null = null;
    for (const run of input.payload.runs) {
      const mirroredRunId = localSyncMirroredRunId(input.payload.threadId, run.id);
      const mirroredMessageId = localSyncMirroredMessageId(
        input.payload.threadId,
        run.userMessageId,
      );
      const inserted = yield* repository
        .recordTurnAttribution({
          turnId: mirroredRunId,
          threadId: input.payload.threadId,
          authorMemberId: actor.id,
          createdAt: run.createdAt,
        })
        .pipe(Effect.orElseSucceed(() => false));
      if (inserted) {
        if (highestInsertedRun === null || run.ordinal >= highestInsertedRun.ordinal) {
          highestInsertedRun = { ordinal: run.ordinal, mirroredRunId };
        }
        yield* publish({
          version: 1,
          type: "turnAttributed",
          payload: {
            turnId: mirroredRunId,
            threadId: input.payload.threadId,
            authorMemberId: actor.id,
            authorPseudo: actor.pseudo,
            createdAt: run.createdAt,
          },
        });
      }
      const relinkedRaw = yield* repository
        .relinkNoteTurnId({
          teamId: team.id,
          threadId: input.payload.threadId,
          fromTurnId: `msg:${run.userMessageId}`,
          toTurnId: mirroredRunId,
        })
        .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<TeamThreadNote>));
      const relinkedMirrored = yield* repository
        .relinkNoteTurnId({
          teamId: team.id,
          threadId: input.payload.threadId,
          fromTurnId: `msg:${mirroredMessageId}`,
          toTurnId: mirroredRunId,
        })
        .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<TeamThreadNote>));
      for (const note of [...relinkedRaw, ...relinkedMirrored]) {
        yield* publish({ version: 1, type: "threadNoteUpserted", payload: note });
      }
    }
    if (highestInsertedRun !== null) {
      const reanchored = yield* repository
        .reanchorPendingNotesForNewTurn({
          teamId: team.id,
          threadId: input.payload.threadId,
          targetTurnId: highestInsertedRun.mirroredRunId,
        })
        .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<TeamThreadNote>));
      for (const note of reanchored) {
        yield* publish({ version: 1, type: "threadNoteUpserted", payload: note });
      }
    }
    yield* publish({
      version: 1,
      type: "threadAttributed",
      payload: attributionOption.value,
    });
    return { attribution: attributionOption.value } satisfies TeamSyncLocalThreadResult;
  }, withMembershipMutationGate);

  const assertActorCanResolveNotesOnThread = Effect.fn(
    "TeamService.assertActorCanResolveNotesOnThread",
  )(function* (team: TeamWorkspace, actor: TeamMember, threadId: ThreadId) {
    const attributionOption = yield* repository
      .getThreadAttribution(threadId)
      .pipe(Effect.mapError(toInternalError));
    if (Option.isNone(attributionOption) || attributionOption.value.teamId !== team.id) {
      return yield* new TeamOperationError({
        code: "not_found",
        message: "Team thread could not be found.",
      });
    }
    const attribution = attributionOption.value;
    if (attribution.isLocalSynced === true) {
      if (attribution.creatorMemberId !== actor.id) {
        return yield* new TeamOperationError({
          code: "forbidden",
          message: "Only the local thread owner can accept, edit, or reject notes on this thread.",
        });
      }
      return attribution;
    }
    const viewOption = yield* repository
      .getViewById(attribution.viewId)
      .pipe(Effect.mapError(toInternalError));
    const defaultViewOption =
      attribution.viewId === team.defaultViewId
        ? viewOption
        : yield* repository.getViewById(team.defaultViewId).pipe(Effect.mapError(toInternalError));
    const view = Option.getOrNull(viewOption) ?? Option.getOrNull(defaultViewOption);
    if (
      resolveTeamThreadPostBlockReason({
        member: actor,
        attribution,
        view,
      }) !== "ok"
    ) {
      return yield* new TeamOperationError({
        code: "forbidden",
        message: "You do not have permission to resolve notes on this thread.",
      });
    }
    yield* ensureDefaultEnvironmentForTeam(team);
    const environments = yield* repository
      .listEnvironments(team.id)
      .pipe(Effect.mapError(toInternalError));
    const envAccess = resolveTeamThreadEnvironmentAccess({
      member: actor,
      attribution,
      environments,
    });
    if (!envAccess.canExecute) {
      return yield* new TeamOperationError({
        code: "forbidden",
        message:
          "Only members with execution access to this thread's environment can resolve notes.",
      });
    }
    return attribution;
  });

  const createThreadNote = Effect.fn("TeamService.createThreadNote")(function* (input: {
    readonly sessionId: AuthSessionId;
    readonly payload: TeamCreateThreadNoteInput;
  }) {
    const team = yield* requireWorkspace();
    const actor = yield* requireActiveMember(input.sessionId);
    if (actor.teamId !== team.id) {
      return yield* new TeamOperationError({
        code: "forbidden",
        message: "This session does not belong to the active team.",
      });
    }
    const body = input.payload.body.trim();
    if (body.length === 0) {
      return yield* new TeamOperationError({
        code: "invalid_input",
        message: "Note body cannot be empty.",
      });
    }
    const attributionOption = yield* repository
      .getThreadAttribution(input.payload.threadId)
      .pipe(Effect.mapError(toInternalError));
    if (Option.isNone(attributionOption) || attributionOption.value.teamId !== team.id) {
      return yield* new TeamOperationError({
        code: "not_found",
        message: "Team thread could not be found.",
      });
    }
    const attribution = attributionOption.value;
    const viewOption = yield* repository
      .getViewById(attribution.viewId)
      .pipe(Effect.mapError(toInternalError));
    const defaultViewOption =
      attribution.viewId === team.defaultViewId
        ? viewOption
        : yield* repository.getViewById(team.defaultViewId).pipe(Effect.mapError(toInternalError));
    const view = Option.getOrNull(viewOption) ?? Option.getOrNull(defaultViewOption);
    if (
      !canMemberLeaveTeamThreadNote({
        member: actor,
        attribution,
        view,
      })
    ) {
      return yield* new TeamOperationError({
        code: "forbidden",
        message: attribution.locked
          ? "This thread is locked. Only owners and admins can leave notes."
          : "You do not have permission to leave notes on this thread.",
      });
    }
    const latestRun = yield* repository
      .getLatestRunInProjection(input.payload.threadId)
      .pipe(Effect.mapError(toInternalError));
    // Anchor server-authoritatively to the thread's latest non-queued run; ignore arbitrary client anchorTurnId.
    const anchorTurnId = Option.isSome(latestRun) ? latestRun.value.runId : null;
    const noteId = TeamThreadNoteId.make(
      yield* random.uuidV4().pipe(Effect.mapError(toInternalError)),
    );
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const created = yield* repository
      .createThreadNote({
        id: noteId,
        threadId: input.payload.threadId,
        teamId: team.id,
        authorMemberId: actor.id,
        originalBody: body,
        originalContentHash: hashNoteContent(body),
        anchorTurnId,
        createdAt,
      })
      .pipe(Effect.mapError(toInternalError));
    if (Option.isNone(created)) {
      return yield* new TeamOperationError({
        code: "internal",
        message: "Failed to create thread note.",
      });
    }
    yield* publish({ version: 1, type: "threadNoteUpserted", payload: created.value });
    yield* PubSub.publish(notificationTriggersPubSub, {
      type: "thread",
      threadId: input.payload.threadId,
    }).pipe(Effect.asVoid);
    return created.value;
  });

  const deleteThreadNote = Effect.fn("TeamService.deleteThreadNote")(function* (input: {
    readonly sessionId: AuthSessionId;
    readonly payload: TeamDeleteThreadNoteInput;
  }) {
    const team = yield* requireWorkspace();
    const actor = yield* requireActiveMember(input.sessionId);
    if (actor.teamId !== team.id) {
      return yield* new TeamOperationError({
        code: "forbidden",
        message: "This session does not belong to the active team.",
      });
    }
    const existing = yield* repository
      .getThreadNoteById(input.payload.noteId)
      .pipe(Effect.mapError(toInternalError));
    if (Option.isNone(existing) || existing.value.teamId !== team.id) {
      return { deleted: false } satisfies TeamDeleteThreadNoteResult;
    }
    const deleted = yield* repository
      .deletePendingThreadNoteByAuthor({
        teamId: team.id,
        noteId: input.payload.noteId,
        authorMemberId: actor.id,
      })
      .pipe(
        Effect.catchTags({
          TeamMemberForbiddenError: (error) =>
            Effect.fail(new TeamOperationError({ code: "forbidden", message: error.message })),
          TeamNoteStateConflictError: (error) =>
            Effect.fail(new TeamOperationError({ code: error.code, message: error.message })),
          TeamRepositoryError: (error) => Effect.fail(toInternalError(error)),
        }),
      );
    if (deleted) {
      yield* publish({
        version: 1,
        type: "threadNoteDeleted",
        payload: { noteId: existing.value.id, threadId: existing.value.threadId },
      });
    }
    return { deleted } satisfies TeamDeleteThreadNoteResult;
  });

  const resolveThreadNote = Effect.fn("TeamService.resolveThreadNote")(function* (input: {
    readonly sessionId: AuthSessionId;
    readonly payload: TeamResolveThreadNoteInput;
  }) {
    const team = yield* requireWorkspace();
    const actor = yield* requireActiveMember(input.sessionId);
    const existing = yield* repository
      .getThreadNoteById(input.payload.noteId)
      .pipe(Effect.mapError(toInternalError));
    if (Option.isNone(existing) || existing.value.teamId !== team.id) {
      return yield* new TeamOperationError({
        code: "not_found",
        message: "Thread note could not be found.",
      });
    }
    yield* assertActorCanResolveNotesOnThread(team, actor, existing.value.threadId);
    const updated = yield* noteStateLock.withPermits(1)(
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        pruneExpiredNoteReservations(DateTime.toEpochMillis(now));
        if (activeNoteReservations.has(input.payload.noteId)) {
          return yield* new TeamOperationError({
            code: "note_already_consumed",
            message: "This note is currently being dispatched in an active send.",
          });
        }
        const resolvedAt = DateTime.formatIso(now);
        return yield* repository
          .resolveThreadNote({
            teamId: team.id,
            noteId: input.payload.noteId,
            status: input.payload.status,
            ...(input.payload.expectedContentHash !== undefined
              ? { expectedContentHash: input.payload.expectedContentHash }
              : {}),
            resolvedByMemberId: actor.id,
            resolvedAt,
          })
          .pipe(
            Effect.catchTags({
              TeamNoteStateConflictError: (error) =>
                Effect.fail(new TeamOperationError({ code: error.code, message: error.message })),
              TeamRepositoryError: (error) => Effect.fail(toInternalError(error)),
            }),
          );
      }),
    );
    if (Option.isNone(updated)) {
      return yield* new TeamOperationError({
        code: "not_found",
        message: "Thread note could not be found.",
      });
    }
    yield* publish({ version: 1, type: "threadNoteUpserted", payload: updated.value });
    return updated.value;
  });

  const editThreadNote = Effect.fn("TeamService.editThreadNote")(function* (input: {
    readonly sessionId: AuthSessionId;
    readonly payload: TeamEditThreadNoteInput;
  }) {
    const team = yield* requireWorkspace();
    const actor = yield* requireActiveMember(input.sessionId);
    const existing = yield* repository
      .getThreadNoteById(input.payload.noteId)
      .pipe(Effect.mapError(toInternalError));
    if (Option.isNone(existing) || existing.value.teamId !== team.id) {
      return yield* new TeamOperationError({
        code: "not_found",
        message: "Thread note could not be found.",
      });
    }
    yield* assertActorCanResolveNotesOnThread(team, actor, existing.value.threadId);
    const editedBody = input.payload.editedBody.trim();
    if (editedBody.length === 0) {
      return yield* new TeamOperationError({
        code: "invalid_input",
        message: "Edited note body cannot be empty.",
      });
    }
    const updated = yield* noteStateLock.withPermits(1)(
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        pruneExpiredNoteReservations(DateTime.toEpochMillis(now));
        if (activeNoteReservations.has(input.payload.noteId)) {
          return yield* new TeamOperationError({
            code: "note_already_consumed",
            message: "This note is currently being dispatched in an active send.",
          });
        }
        const resolvedAt = DateTime.formatIso(now);
        return yield* repository
          .editThreadNote({
            teamId: team.id,
            noteId: input.payload.noteId,
            editedBody,
            editedContentHash: hashNoteContent(editedBody),
            ...(input.payload.expectedOriginalContentHash !== undefined
              ? { expectedOriginalContentHash: input.payload.expectedOriginalContentHash }
              : {}),
            status: input.payload.status ?? "accepted",
            resolvedByMemberId: actor.id,
            resolvedAt,
          })
          .pipe(
            Effect.catchTags({
              TeamNoteStateConflictError: (error) =>
                Effect.fail(new TeamOperationError({ code: error.code, message: error.message })),
              TeamRepositoryError: (error) => Effect.fail(toInternalError(error)),
            }),
          );
      }),
    );
    if (Option.isNone(updated)) {
      return yield* new TeamOperationError({
        code: "not_found",
        message: "Thread note could not be found.",
      });
    }
    yield* publish({ version: 1, type: "threadNoteUpserted", payload: updated.value });
    return updated.value;
  });

  const reserveAcceptedNotesLocked = Effect.fn("TeamService.reserveAcceptedNotesLocked")(
    function* (input: {
      readonly team: TeamWorkspace;
      readonly actor: TeamMember;
      readonly threadId: ThreadId;
      readonly acceptedNotes: ReadonlyArray<TeamAcceptedNoteRef>;
    }) {
      const now = yield* DateTime.now;
      const nowMs = DateTime.toEpochMillis(now);
      pruneExpiredNoteReservations(nowMs);
      const token = yield* random.uuidV4().pipe(Effect.mapError(toInternalError));
      const blocks: Array<string> = [];
      const reserved: Array<{ readonly noteId: TeamThreadNoteId; readonly contentHash: string }> =
        [];
      const seen = new Set<string>();
      for (const ref of input.acceptedNotes) {
        if (seen.has(ref.noteId)) continue;
        seen.add(ref.noteId);
        if (activeNoteReservations.has(ref.noteId)) {
          return yield* new TeamOperationError({
            code: "note_already_consumed",
            message: `Accepted note "${ref.noteId}" is already reserved by an in-flight dispatch.`,
          });
        }
        const noteOption = yield* repository
          .getThreadNoteById(ref.noteId)
          .pipe(Effect.mapError(toInternalError));
        if (
          Option.isNone(noteOption) ||
          noteOption.value.teamId !== input.team.id ||
          noteOption.value.threadId !== input.threadId
        ) {
          return yield* new TeamOperationError({
            code: "note_hash_mismatch",
            message: `Accepted note "${ref.noteId}" was not found on this thread.`,
          });
        }
        const note = noteOption.value;
        if (note.status === "consumed") {
          return yield* new TeamOperationError({
            code: "note_already_consumed",
            message: `Accepted note "${ref.noteId}" was already consumed by an earlier turn.`,
          });
        }
        if (note.status !== "accepted") {
          return yield* new TeamOperationError({
            code: "note_not_pending",
            message: `Note "${ref.noteId}" has status "${note.status}" and cannot be injected without explicit acceptance.`,
          });
        }
        const effectiveHash = effectiveTeamThreadNoteHash(note);
        if (effectiveHash !== ref.contentHash) {
          return yield* new TeamOperationError({
            code: "note_hash_mismatch",
            message: `Content hash mismatch for accepted note "${ref.noteId}".`,
          });
        }
        reserved.push({ noteId: note.id, contentHash: effectiveHash });
        blocks.push(
          formatAcceptedTeamNoteForPrompt({
            authorPseudo: note.authorPseudo,
            approverPseudo: note.resolvedByPseudo ?? input.actor.pseudo,
            originalBody: note.originalBody,
            editedBody: note.editedBody,
          }),
        );
      }
      const expiresAtMs = nowMs + NOTE_RESERVATION_TTL_MS;
      for (const item of reserved) {
        activeNoteReservations.set(item.noteId, {
          reservationToken: token,
          threadId: input.threadId,
          memberId: input.actor.id,
          contentHash: item.contentHash,
          expiresAtMs,
        });
      }
      return {
        reservationToken: token,
        noteIds: reserved.map((item) => item.noteId),
        formattedPromptPrefix: blocks.join("\n\n"),
      } satisfies TeamReserveAcceptedNotesResult;
    },
  );

  const reserveAcceptedNotes = Effect.fn("TeamService.reserveAcceptedNotes")(function* (input: {
    readonly sessionId: AuthSessionId;
    readonly payload: TeamReserveAcceptedNotesInput;
  }) {
    const team = yield* requireWorkspace();
    const actor = yield* requireActiveMember(input.sessionId);
    yield* assertActorCanResolveNotesOnThread(team, actor, input.payload.threadId);
    return yield* noteStateLock.withPermits(1)(
      reserveAcceptedNotesLocked({
        team,
        actor,
        threadId: input.payload.threadId,
        acceptedNotes: input.payload.acceptedNotes,
      }),
    );
  });

  const releaseNoteReservationByToken = Effect.fn("TeamService.releaseNoteReservationByToken")(
    function* (reservationToken: string) {
      yield* noteStateLock.withPermits(1)(
        Effect.sync(() => {
          for (const [noteId, reservation] of activeNoteReservations) {
            if (reservation.reservationToken === reservationToken) {
              activeNoteReservations.delete(noteId);
            }
          }
        }),
      );
    },
  );

  const releaseAcceptedNotes = Effect.fn("TeamService.releaseAcceptedNotes")(function* (input: {
    readonly sessionId: AuthSessionId;
    readonly payload: TeamReleaseAcceptedNotesInput;
  }) {
    const team = yield* requireWorkspace();
    const actor = yield* requireActiveMember(input.sessionId);
    yield* assertActorCanResolveNotesOnThread(team, actor, input.payload.threadId);
    const releasedCount = yield* noteStateLock.withPermits(1)(
      Effect.sync(() => {
        let count = 0;
        for (const [noteId, reservation] of activeNoteReservations) {
          if (
            reservation.reservationToken === input.payload.reservationToken &&
            reservation.threadId === input.payload.threadId &&
            reservation.memberId === actor.id
          ) {
            activeNoteReservations.delete(noteId);
            count += 1;
          }
        }
        return count;
      }),
    );
    return { releasedCount } satisfies TeamReleaseAcceptedNotesResult;
  });

  const consumeAcceptedNotes = Effect.fn("TeamService.consumeAcceptedNotes")(function* (input: {
    readonly sessionId: AuthSessionId;
    readonly payload: TeamConsumeAcceptedNotesInput;
  }) {
    const team = yield* requireWorkspace();
    const actor = yield* requireActiveMember(input.sessionId);
    yield* assertActorCanResolveNotesOnThread(team, actor, input.payload.threadId);
    const { consumedNotes, reanchoredNotes } = yield* noteStateLock.withPermits(1)(
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        pruneExpiredNoteReservations(DateTime.toEpochMillis(now));
        for (const ref of input.payload.acceptedNotes) {
          const existingReservation = activeNoteReservations.get(ref.noteId);
          if (
            existingReservation !== undefined &&
            existingReservation.reservationToken !== input.payload.reservationToken
          ) {
            return yield* new TeamOperationError({
              code: "note_already_consumed",
              message: `Accepted note "${ref.noteId}" is already reserved by another dispatch.`,
            });
          }
        }
        const resolvedAt = DateTime.formatIso(now);
        const result = yield* repository
          .consumeAcceptedNotesAndReanchorPending({
            teamId: team.id,
            threadId: input.payload.threadId,
            targetTurnId: input.payload.targetTurnId,
            acceptedNotes: input.payload.acceptedNotes,
            resolvedByMemberId: actor.id,
            resolvedAt,
          })
          .pipe(
            Effect.catchTags({
              TeamNoteStateConflictError: (error) =>
                Effect.fail(new TeamOperationError({ code: error.code, message: error.message })),
              TeamRepositoryError: (error) => Effect.fail(toInternalError(error)),
            }),
          );
        for (const note of result.consumedNotes) {
          activeNoteReservations.delete(note.id);
        }
        if (input.payload.reservationToken !== undefined) {
          for (const [noteId, reservation] of activeNoteReservations) {
            if (reservation.reservationToken === input.payload.reservationToken) {
              activeNoteReservations.delete(noteId);
            }
          }
        }
        return result;
      }),
    );
    for (const note of [...consumedNotes, ...reanchoredNotes]) {
      yield* publish({ version: 1, type: "threadNoteUpserted", payload: note });
    }
    const formattedPromptPrefix = consumedNotes
      .map((note) =>
        formatAcceptedTeamNoteForPrompt({
          authorPseudo: note.authorPseudo,
          approverPseudo: note.resolvedByPseudo ?? actor.pseudo,
          originalBody: note.originalBody,
          editedBody: note.editedBody,
        }),
      )
      .join("\n\n");
    return {
      consumedNotes: [...consumedNotes],
      reanchoredNoteIds: reanchoredNotes.map((note) => note.id),
      formattedPromptPrefix,
    } satisfies TeamConsumeAcceptedNotesResult;
  });

  const listThreadNotes = Effect.fn("TeamService.listThreadNotes")(function* (input: {
    readonly sessionId: AuthSessionId;
    readonly payload: TeamListThreadNotesInput;
  }) {
    const workspaceOption = yield* repository.getWorkspace().pipe(Effect.mapError(toInternalError));
    if (Option.isNone(workspaceOption)) return [];
    const readable = yield* canReadThread(input.sessionId, input.payload.threadId);
    if (!readable) {
      return yield* new TeamOperationError({
        code: "forbidden",
        message: "You do not have permission to view notes on this thread.",
      });
    }
    return yield* repository
      .listThreadNotes({ teamId: workspaceOption.value.id, threadId: input.payload.threadId })
      .pipe(Effect.mapError(toInternalError));
  });

  const verifyAcceptedNotesForDispatch = Effect.fn("TeamService.verifyAcceptedNotesForDispatch")(
    function* (input: {
      readonly sessionId: AuthSessionId;
      readonly threadId: ThreadId;
      readonly acceptedNotes: ReadonlyArray<TeamAcceptedNoteRef>;
    }) {
      if (input.acceptedNotes.length === 0) return "";
      const workspaceOption = yield* repository
        .getWorkspace()
        .pipe(Effect.mapError(() => teamPostAuthError("Failed to verify accepted notes.")));
      if (Option.isNone(workspaceOption)) return "";
      const memberOption = yield* repository
        .getMemberForSession(input.sessionId)
        .pipe(Effect.mapError(() => teamPostAuthError("Failed to verify accepted notes.")));
      if (
        Option.isNone(memberOption) ||
        memberOption.value.teamId !== workspaceOption.value.id ||
        memberOption.value.status !== "active"
      ) {
        return yield* teamPostAuthError("This session is not bound to an active team member.");
      }
      const actor = memberOption.value;
      const blocks: Array<string> = [];
      const seen = new Set<string>();
      for (const ref of input.acceptedNotes) {
        if (seen.has(ref.noteId)) continue;
        seen.add(ref.noteId);
        const noteOption = yield* repository
          .getThreadNoteById(ref.noteId)
          .pipe(Effect.mapError(() => teamPostAuthError("Failed to verify accepted note.")));
        if (
          Option.isNone(noteOption) ||
          noteOption.value.teamId !== workspaceOption.value.id ||
          noteOption.value.threadId !== input.threadId
        ) {
          return yield* teamPostAuthError(`Accepted note "${ref.noteId}" was not found.`);
        }
        const note = noteOption.value;
        if (note.status !== "accepted") {
          return yield* teamPostAuthError(
            `Note "${ref.noteId}" has status "${note.status}" and cannot be injected without explicit acceptance.`,
          );
        }
        if (effectiveTeamThreadNoteHash(note) !== ref.contentHash) {
          return yield* teamPostAuthError(
            `Content hash mismatch for accepted note "${ref.noteId}".`,
          );
        }
        blocks.push(
          formatAcceptedTeamNoteForPrompt({
            authorPseudo: note.authorPseudo,
            approverPseudo: note.resolvedByPseudo ?? actor.pseudo,
            originalBody: note.originalBody,
            editedBody: note.editedBody,
          }),
        );
      }
      return blocks.join("\n\n");
    },
  );

  const prepareNotesForDispatchCommand = Effect.fn("TeamService.prepareNotesForDispatchCommand")(
    function* (input: {
      readonly sessionId: AuthSessionId;
      readonly command: OrchestrationV2Command;
    }) {
      if (
        input.command.type !== "message.dispatch" ||
        input.command.teamAcceptedNotes === undefined ||
        input.command.teamAcceptedNotes.length === 0
      ) {
        return { command: input.command, reservationToken: null };
      }
      const workspaceOption = yield* repository
        .getWorkspace()
        .pipe(Effect.mapError(() => teamPostAuthError("Failed to verify accepted notes.")));
      if (Option.isNone(workspaceOption)) {
        return { command: input.command, reservationToken: null };
      }
      const memberOption = yield* repository
        .getMemberForSession(input.sessionId)
        .pipe(Effect.mapError(() => teamPostAuthError("Failed to verify accepted notes.")));
      if (
        Option.isNone(memberOption) ||
        memberOption.value.teamId !== workspaceOption.value.id ||
        memberOption.value.status !== "active"
      ) {
        return yield* teamPostAuthError("This session is not bound to an active team member.");
      }
      const reserved = yield* noteStateLock
        .withPermits(1)(
          reserveAcceptedNotesLocked({
            team: workspaceOption.value,
            actor: memberOption.value,
            threadId: input.command.threadId,
            acceptedNotes: input.command.teamAcceptedNotes,
          }),
        )
        .pipe(Effect.mapError((error) => teamPostAuthError(error.message)));
      const trimmedPrompt = input.command.text.trim();
      const effectiveCommand: OrchestrationV2Command =
        reserved.formattedPromptPrefix.length > 0
          ? {
              ...input.command,
              text:
                trimmedPrompt.length === 0
                  ? reserved.formattedPromptPrefix
                  : `${reserved.formattedPromptPrefix}\n\n${input.command.text}`,
            }
          : input.command;
      return {
        command: effectiveCommand,
        reservationToken: reserved.reservationToken,
      };
    },
  );

  const finalizeNotesForDispatchedTurn = Effect.fn("TeamService.finalizeNotesForDispatchedTurn")(
    function* (input: {
      readonly sessionId: AuthSessionId;
      readonly threadId: ThreadId;
      readonly targetTurnId: string;
      readonly acceptedNotes: ReadonlyArray<TeamAcceptedNoteRef>;
      readonly reservationToken?: string | null;
    }) {
      const workspaceOption = yield* repository
        .getWorkspace()
        .pipe(Effect.orElseSucceed(() => Option.none<TeamWorkspace>()));
      if (Option.isNone(workspaceOption)) return;
      const memberOption = yield* repository
        .getMemberForSession(input.sessionId)
        .pipe(Effect.orElseSucceed(() => Option.none<TeamMember>()));
      if (
        Option.isNone(memberOption) ||
        memberOption.value.teamId !== workspaceOption.value.id ||
        memberOption.value.status !== "active"
      ) {
        return;
      }
      const outcome = yield* noteStateLock.withPermits(1)(
        Effect.gen(function* () {
          const resolvedAt = DateTime.formatIso(yield* DateTime.now);
          const result = yield* repository
            .consumeAcceptedNotesAndReanchorPending({
              teamId: workspaceOption.value.id,
              threadId: input.threadId,
              targetTurnId: input.targetTurnId,
              acceptedNotes: input.acceptedNotes,
              resolvedByMemberId: memberOption.value.id,
              resolvedAt,
            })
            .pipe(
              Effect.tapError((cause) =>
                Effect.logError("TeamService.finalizeNotesForDispatchedTurn failed", {
                  threadId: input.threadId,
                  targetTurnId: input.targetTurnId,
                  cause,
                }),
              ),
              Effect.orElseSucceed(() => ({
                consumedNotes: [] as ReadonlyArray<TeamThreadNote>,
                reanchoredNotes: [] as ReadonlyArray<TeamThreadNote>,
              })),
            );
          for (const note of result.consumedNotes) {
            activeNoteReservations.delete(note.id);
          }
          if (input.reservationToken) {
            for (const [noteId, reservation] of activeNoteReservations) {
              if (reservation.reservationToken === input.reservationToken) {
                activeNoteReservations.delete(noteId);
              }
            }
          }
          return result;
        }),
      );
      for (const note of [...outcome.consumedNotes, ...outcome.reanchoredNotes]) {
        yield* publish({ version: 1, type: "threadNoteUpserted", payload: note });
      }
    },
  );

  const requireAssetsRepository = () =>
    Effect.fromOption(assetsRepositoryOption).pipe(
      Effect.mapError(
        () =>
          new TeamOperationError({
            code: "internal",
            message: "Team assets repository is not available on this server.",
          }),
      ),
    );

  const notifyProviderManagerChanged = () =>
    Option.isSome(providerManagerOption)
      ? providerManagerOption.value.notifyTeamServerAssetsOrProvidersChanged()
      : Effect.void;

  const isValidHttpUrl = (value: string): boolean => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  };

  const upsertProvider = Effect.fn("TeamService.upsertProvider")(function* (input: {
    readonly sessionId: AuthSessionId;
    readonly payload: TeamUpsertProviderInput;
  }) {
    const team = yield* requireWorkspace();
    const actor = yield* requireActiveMember(input.sessionId);
    if (actor.teamId !== team.id || !canManageTeamProviders(actor.role)) {
      return yield* new TeamOperationError({
        code: "forbidden",
        message: "Only team owners and admins can configure team providers.",
      });
    }
    const assetsRepo = yield* requireAssetsRepository();
    if (isTeamProviderInstanceId(input.payload.providerInstanceId)) {
      return yield* new TeamOperationError({
        code: "invalid_input",
        message: "Team provider instance IDs must not already use the virtual team: prefix.",
      });
    }
    const deliveryStrategy =
      input.payload.deliveryStrategy ?? defaultTeamProviderDeliveryStrategy(input.payload.driver);
    const upstreamBaseUrl =
      input.payload.upstreamBaseUrl !== undefined && input.payload.upstreamBaseUrl !== null
        ? input.payload.upstreamBaseUrl.trim()
        : null;
    if (deliveryStrategy === "proxy") {
      if (!upstreamBaseUrl || !isValidHttpUrl(upstreamBaseUrl)) {
        return yield* new TeamOperationError({
          code: "invalid_input",
          message: "Proxy providers require a valid http:// or https:// upstream base URL.",
        });
      }
    } else if (
      upstreamBaseUrl !== null &&
      upstreamBaseUrl.length > 0 &&
      !isValidHttpUrl(upstreamBaseUrl)
    ) {
      return yield* new TeamOperationError({
        code: "invalid_input",
        message: "Upstream base URL must be a valid http:// or https:// URL.",
      });
    }
    const oauthTokenEndpoint =
      input.payload.oauthTokenEndpoint !== undefined && input.payload.oauthTokenEndpoint !== null
        ? input.payload.oauthTokenEndpoint.trim()
        : null;
    if (
      oauthTokenEndpoint !== null &&
      oauthTokenEndpoint.length > 0 &&
      !isValidHttpUrl(oauthTokenEndpoint)
    ) {
      return yield* new TeamOperationError({
        code: "invalid_input",
        message: "OAuth token endpoint must be a valid http:// or https:// URL.",
      });
    }

    const existingOpt = yield* assetsRepo
      .getProviderByInstanceId(team.id, input.payload.providerInstanceId)
      .pipe(Effect.mapError(toInternalError));
    const existing = Option.getOrNull(existingOpt);
    const nowIso = DateTime.formatIso(yield* DateTime.now);
    const id = existing?.id ?? TeamProviderId.make(yield* random.uuidV4().pipe(Effect.orDie));

    const rawConfigLinkedId =
      input.payload.config && "linkedServerInstanceId" in input.payload.config
        ? input.payload.config.linkedServerInstanceId
        : undefined;
    if (
      rawConfigLinkedId !== undefined &&
      rawConfigLinkedId !== null &&
      (typeof rawConfigLinkedId !== "string" || isTeamProviderInstanceId(rawConfigLinkedId.trim()))
    ) {
      return yield* new TeamOperationError({
        code: "invalid_input",
        message: "Cannot link a team provider to a virtual team: provider instance.",
      });
    }

    const sourceServerProviderInstanceId = input.payload.sourceServerProviderInstanceId;
    if (
      sourceServerProviderInstanceId !== undefined &&
      sourceServerProviderInstanceId !== null &&
      isTeamProviderInstanceId(sourceServerProviderInstanceId)
    ) {
      return yield* new TeamOperationError({
        code: "invalid_input",
        message: "Cannot link a team provider to a virtual team: provider instance.",
      });
    }

    if (
      input.payload.clearSecret === true &&
      sourceServerProviderInstanceId !== undefined &&
      sourceServerProviderInstanceId !== null
    ) {
      return yield* new TeamOperationError({
        code: "invalid_input",
        message: "Cannot link a server provider while clearing stored credentials.",
      });
    }

    const baseConfig: Record<string, unknown> = {
      ...(input.payload.config ?? existing?.config),
    };
    if (input.payload.clearSecret === true || deliveryStrategy !== "token-lease") {
      delete baseConfig.linkedServerInstanceId;
    } else if (sourceServerProviderInstanceId !== undefined) {
      if (sourceServerProviderInstanceId === null) {
        delete baseConfig.linkedServerInstanceId;
      } else {
        baseConfig.linkedServerInstanceId = sourceServerProviderInstanceId;
      }
    }

    const effectiveLinkedServerInstanceId =
      typeof baseConfig.linkedServerInstanceId === "string" &&
      baseConfig.linkedServerInstanceId.trim().length > 0
        ? baseConfig.linkedServerInstanceId.trim()
        : null;
    if (
      effectiveLinkedServerInstanceId !== null &&
      isTeamProviderInstanceId(effectiveLinkedServerInstanceId)
    ) {
      return yield* new TeamOperationError({
        code: "invalid_input",
        message: "Cannot link a team provider to a virtual team: provider instance.",
      });
    }

    const hasIncomingManualOAuthSecret =
      input.payload.oauthAccessToken !== undefined ||
      input.payload.oauthRefreshToken !== undefined ||
      input.payload.oauthTokenEndpoint !== undefined ||
      input.payload.oauthClientId !== undefined ||
      input.payload.oauthClientSecret !== undefined ||
      input.payload.oauthExpiresAt !== undefined ||
      input.payload.oauthEmail !== undefined ||
      input.payload.oauthAuthMethod !== undefined;

    if (effectiveLinkedServerInstanceId !== null && hasIncomingManualOAuthSecret) {
      return yield* new TeamOperationError({
        code: "invalid_input",
        message:
          "Linked server providers cannot be combined with manual OAuth credentials or custom token endpoints.",
      });
    }

    if (effectiveLinkedServerInstanceId !== null && Option.isSome(serverConfigOption)) {
      const resolvedSettings = Option.isSome(serverSettingsOption)
        ? yield* serverSettingsOption.value.getSettings.pipe(
            Effect.mapError(
              (cause) =>
                new TeamOperationError({
                  code: "internal",
                  message: `Could not read server provider settings: ${String(cause)}`,
                }),
            ),
          )
        : undefined;
      const profileDir = resolveLinkedServerProviderProfileDir({
        stateDir: serverConfigOption.value.stateDir,
        driver: input.payload.driver,
        linkedServerInstanceId: effectiveLinkedServerInstanceId,
        ...(resolvedSettings !== undefined ? { serverSettings: resolvedSettings } : {}),
      });
      if (profileDir === null) {
        return yield* new TeamOperationError({
          code: "invalid_input",
          message: `Server provider instance "${effectiveLinkedServerInstanceId}" does not exist for driver "${input.payload.driver}".`,
        });
      }
    }

    const hasIncomingSecret = input.payload.apiKey !== undefined || hasIncomingManualOAuthSecret;

    // Keep linked server profile credentials strictly separate from manual ServerSecretStore
    // secrets so linked refresh tokens are never persisted or sent to custom endpoints.
    let secretKey: string | null = existing?.secretKey ?? null;
    if (input.payload.clearSecret === true || effectiveLinkedServerInstanceId !== null) {
      if (secretKey !== null && Option.isSome(secretStoreOption)) {
        yield* removeTeamProviderSecret(secretStoreOption.value, secretKey).pipe(Effect.ignore);
        clearTeamProviderRefreshLock(secretKey);
      }
      secretKey = null;
    }
    if (hasIncomingSecret && effectiveLinkedServerInstanceId === null) {
      if (Option.isNone(secretStoreOption)) {
        return yield* new TeamOperationError({
          code: "internal",
          message: "Secret store is unavailable; cannot persist provider credentials.",
        });
      }
      const key = secretKey ?? teamProviderSecretKey(team.id, input.payload.providerInstanceId);
      const previousSecret =
        secretKey !== null
          ? yield* readTeamProviderSecret(secretStoreOption.value, secretKey).pipe(
              Effect.orElseSucceed(() => null),
            )
          : null;
      const nextSecret: StoredTeamProviderSecret = {
        ...previousSecret,
        ...(input.payload.apiKey !== undefined ? { apiKey: input.payload.apiKey } : {}),
        ...(input.payload.oauthAccessToken !== undefined
          ? { oauthAccessToken: input.payload.oauthAccessToken }
          : {}),
        ...(input.payload.oauthRefreshToken !== undefined
          ? { oauthRefreshToken: input.payload.oauthRefreshToken }
          : {}),
        ...(input.payload.oauthExpiresAt !== undefined && input.payload.oauthExpiresAt !== null
          ? { oauthExpiresAt: input.payload.oauthExpiresAt }
          : {}),
        ...(oauthTokenEndpoint !== null && oauthTokenEndpoint.length > 0
          ? { oauthTokenEndpoint }
          : {}),
        ...(input.payload.oauthClientId !== undefined && input.payload.oauthClientId !== null
          ? { oauthClientId: input.payload.oauthClientId }
          : {}),
        ...(input.payload.oauthClientSecret !== undefined
          ? { oauthClientSecret: input.payload.oauthClientSecret }
          : {}),
        ...(input.payload.oauthEmail !== undefined && input.payload.oauthEmail !== null
          ? { oauthEmail: input.payload.oauthEmail }
          : {}),
        ...(input.payload.oauthAuthMethod !== undefined && input.payload.oauthAuthMethod !== null
          ? { oauthAuthMethod: input.payload.oauthAuthMethod }
          : {}),
      };
      yield* writeTeamProviderSecret(secretStoreOption.value, key, nextSecret).pipe(
        Effect.mapError(toInternalError),
      );
      secretKey = key;
    }

    const stored = yield* assetsRepo
      .upsertProvider({
        id,
        teamId: team.id,
        providerInstanceId: input.payload.providerInstanceId,
        driver: input.payload.driver,
        displayName:
          input.payload.displayName !== undefined
            ? input.payload.displayName?.trim() || null
            : (existing?.displayName ?? null),
        deliveryStrategy,
        upstreamBaseUrl: upstreamBaseUrl && upstreamBaseUrl.length > 0 ? upstreamBaseUrl : null,
        apiKeyHeader:
          input.payload.apiKeyHeader !== undefined
            ? input.payload.apiKeyHeader?.trim() || null
            : (existing?.apiKeyHeader ?? null),
        apiKeyPrefix:
          input.payload.apiKeyPrefix !== undefined
            ? input.payload.apiKeyPrefix
            : (existing?.apiKeyPrefix ?? null),
        secretKey,
        config: baseConfig,
        enabled: input.payload.enabled ?? existing?.enabled ?? true,
        updatedByMemberId: actor.id,
        now: nowIso,
      })
      .pipe(Effect.mapError(toInternalError));

    const publicProvider = TeamAssetsRepository.stripProviderSecretKey(stored);
    yield* publish({ version: 1, type: "providerUpserted", payload: publicProvider });
    yield* notifyProviderManagerChanged();
    return publicProvider;
  });

  const deleteProvider = Effect.fn("TeamService.deleteProvider")(function* (input: {
    readonly sessionId: AuthSessionId;
    readonly payload: TeamDeleteProviderInput;
  }) {
    const team = yield* requireWorkspace();
    const actor = yield* requireActiveMember(input.sessionId);
    if (actor.teamId !== team.id || !canManageTeamProviders(actor.role)) {
      return yield* new TeamOperationError({
        code: "forbidden",
        message: "Only team owners and admins can remove team providers.",
      });
    }
    const assetsRepo = yield* requireAssetsRepository();
    const removedOpt = yield* assetsRepo
      .deleteProvider(team.id, input.payload.providerInstanceId)
      .pipe(Effect.mapError(toInternalError));
    if (Option.isNone(removedOpt)) {
      return {
        deleted: false,
      } satisfies TeamDeleteProviderResult;
    }
    if (removedOpt.value.secretKey !== null && Option.isSome(secretStoreOption)) {
      yield* removeTeamProviderSecret(secretStoreOption.value, removedOpt.value.secretKey).pipe(
        Effect.ignore,
      );
      clearTeamProviderRefreshLock(removedOpt.value.secretKey);
    }
    yield* publish({
      version: 1,
      type: "providerDeleted",
      payload: { providerInstanceId: input.payload.providerInstanceId },
    });
    yield* notifyProviderManagerChanged();
    return {
      deleted: true,
    } satisfies TeamDeleteProviderResult;
  });

  const listProviderUsage = Effect.fn("TeamService.listProviderUsage")(function* (
    sessionId: AuthSessionId,
  ) {
    const team = yield* requireWorkspace();
    const actor = yield* requireActiveMember(sessionId);
    if (actor.teamId !== team.id || !canManageTeamProviders(actor.role)) {
      return yield* new TeamOperationError({
        code: "forbidden",
        message: "Only team owners and admins can inspect team provider usage.",
      });
    }
    const assetsRepo = yield* requireAssetsRepository();
    return yield* assetsRepo
      .listProviderUsageSummary(team.id)
      .pipe(Effect.mapError(toInternalError));
  });

  const upsertSkill = Effect.fn("TeamService.upsertSkill")(function* (input: {
    readonly sessionId: AuthSessionId;
    readonly payload: TeamUpsertSkillInput;
  }) {
    const team = yield* requireWorkspace();
    const actor = yield* requireActiveMember(input.sessionId);
    if (actor.teamId !== team.id || !canManageTeamSkills(actor.role)) {
      return yield* new TeamOperationError({
        code: "forbidden",
        message: "Only modo, admin, and owner members can create or edit team skills.",
      });
    }
    const validated = yield* validateTeamSkillPayload({
      slug: input.payload.slug,
      providerDriver: input.payload.providerDriver ?? "*",
      skillMd: input.payload.skillMd,
      enabled: input.payload.enabled ?? true,
      ...(input.payload.references !== undefined ? { references: input.payload.references } : {}),
    }).pipe(
      Effect.mapError(
        (error) => new TeamOperationError({ code: "invalid_input", message: error.message }),
      ),
    );
    const assetsRepo = yield* requireAssetsRepository();
    const nowIso = DateTime.formatIso(yield* DateTime.now);
    const id = input.payload.skillId ?? TeamSkillId.make(yield* random.uuidV4().pipe(Effect.orDie));
    const { skill, revision } = yield* assetsRepo
      .upsertSkill({
        id,
        teamId: team.id,
        slug: validated.slug,
        providerDriver: input.payload.providerDriver ?? "*",
        skillMd: validated.skillMd,
        references: validated.references,
        enabled: input.payload.enabled ?? true,
        contentHash: validated.contentHash,
        updatedByMemberId: actor.id,
        now: nowIso,
      })
      .pipe(
        Effect.catchTags({
          TeamSkillSlugConflictError: (error) =>
            Effect.fail(
              new TeamOperationError({ code: "skill_slug_taken", message: error.message }),
            ),
          TeamAssetsRepositoryError: (error) => Effect.fail(toInternalError(error)),
        }),
      );
    yield* publish({ version: 1, type: "skillUpserted", payload: skill });
    yield* publish({
      version: 1,
      type: "assetsUpdated",
      payload: { teamId: team.id, revision: NonNegativeInt.make(revision) },
    });
    yield* notifyProviderManagerChanged();
    return skill;
  });

  const deleteSkill = Effect.fn("TeamService.deleteSkill")(function* (input: {
    readonly sessionId: AuthSessionId;
    readonly payload: TeamDeleteSkillInput;
  }) {
    const team = yield* requireWorkspace();
    const actor = yield* requireActiveMember(input.sessionId);
    if (actor.teamId !== team.id || !canManageTeamSkills(actor.role)) {
      return yield* new TeamOperationError({
        code: "forbidden",
        message: "Only modo, admin, and owner members can delete team skills.",
      });
    }
    const assetsRepo = yield* requireAssetsRepository();
    const nowIso = DateTime.formatIso(yield* DateTime.now);
    const tombstoneId = yield* random.uuidV4().pipe(Effect.orDie);
    const result = yield* assetsRepo
      .deleteSkill({
        teamId: team.id,
        skillId: input.payload.skillId,
        tombstoneId,
        now: nowIso,
      })
      .pipe(Effect.mapError(toInternalError));
    if (result.deleted) {
      yield* publish({
        version: 1,
        type: "skillDeleted",
        payload: {
          skillId: input.payload.skillId,
          revision: NonNegativeInt.make(result.revision),
        },
      });
      yield* publish({
        version: 1,
        type: "assetsUpdated",
        payload: { teamId: team.id, revision: NonNegativeInt.make(result.revision) },
      });
      yield* notifyProviderManagerChanged();
    }
    return {
      deleted: result.deleted,
      revision: NonNegativeInt.make(result.revision),
    } satisfies TeamDeleteSkillResult;
  });

  const upsertPreprompt = Effect.fn("TeamService.upsertPreprompt")(function* (input: {
    readonly sessionId: AuthSessionId;
    readonly payload: TeamUpsertPrepromptInput;
  }) {
    const team = yield* requireWorkspace();
    const actor = yield* requireActiveMember(input.sessionId);
    if (actor.teamId !== team.id || !canManageTeamPreprompts(actor.role)) {
      return yield* new TeamOperationError({
        code: "forbidden",
        message: "Only modo, admin, and owner members can create or edit team pre-prompts.",
      });
    }
    const validated = yield* validateTeamPrepromptPayload({
      name: input.payload.name,
      providerDriver: input.payload.providerDriver ?? "*",
      injectionScope: input.payload.injectionScope ?? "thread",
      content: input.payload.content,
      enabled: input.payload.enabled ?? true,
    }).pipe(
      Effect.mapError(
        (error) => new TeamOperationError({ code: "invalid_input", message: error.message }),
      ),
    );
    const assetsRepo = yield* requireAssetsRepository();
    const nowIso = DateTime.formatIso(yield* DateTime.now);
    const id =
      input.payload.prepromptId ?? TeamPrepromptId.make(yield* random.uuidV4().pipe(Effect.orDie));
    const { preprompt, revision } = yield* assetsRepo
      .upsertPreprompt({
        id,
        teamId: team.id,
        name: validated.name,
        providerDriver: input.payload.providerDriver ?? "*",
        injectionScope: input.payload.injectionScope ?? "thread",
        content: validated.content,
        enabled: input.payload.enabled ?? true,
        contentHash: validated.contentHash,
        updatedByMemberId: actor.id,
        now: nowIso,
      })
      .pipe(Effect.mapError(toInternalError));
    yield* publish({ version: 1, type: "prepromptUpserted", payload: preprompt });
    yield* publish({
      version: 1,
      type: "assetsUpdated",
      payload: { teamId: team.id, revision: NonNegativeInt.make(revision) },
    });
    yield* notifyProviderManagerChanged();
    return preprompt;
  });

  const deletePreprompt = Effect.fn("TeamService.deletePreprompt")(function* (input: {
    readonly sessionId: AuthSessionId;
    readonly payload: TeamDeletePrepromptInput;
  }) {
    const team = yield* requireWorkspace();
    const actor = yield* requireActiveMember(input.sessionId);
    if (actor.teamId !== team.id || !canManageTeamPreprompts(actor.role)) {
      return yield* new TeamOperationError({
        code: "forbidden",
        message: "Only modo, admin, and owner members can delete team pre-prompts.",
      });
    }
    const assetsRepo = yield* requireAssetsRepository();
    const nowIso = DateTime.formatIso(yield* DateTime.now);
    const tombstoneId = yield* random.uuidV4().pipe(Effect.orDie);
    const result = yield* assetsRepo
      .deletePreprompt({
        teamId: team.id,
        prepromptId: input.payload.prepromptId,
        tombstoneId,
        now: nowIso,
      })
      .pipe(Effect.mapError(toInternalError));
    if (result.deleted) {
      yield* publish({
        version: 1,
        type: "prepromptDeleted",
        payload: {
          prepromptId: input.payload.prepromptId,
          revision: NonNegativeInt.make(result.revision),
        },
      });
      yield* publish({
        version: 1,
        type: "assetsUpdated",
        payload: { teamId: team.id, revision: NonNegativeInt.make(result.revision) },
      });
      yield* notifyProviderManagerChanged();
    }
    return {
      deleted: result.deleted,
      revision: NonNegativeInt.make(result.revision),
    } satisfies TeamDeletePrepromptResult;
  });

  const issueLocalSyncToken = Effect.fn("TeamService.issueLocalSyncToken")(function* (
    sessionId: AuthSessionId,
  ) {
    const team = yield* requireWorkspace();
    const actor = yield* requireActiveMember(sessionId);
    if (actor.teamId !== team.id) {
      return yield* new TeamOperationError({
        code: "forbidden",
        message: "This session does not belong to the active team.",
      });
    }
    const assetsRepo = yield* requireAssetsRepository();
    const now = yield* DateTime.now;
    const nowIso = DateTime.formatIso(now);
    const expiresAt = DateTime.formatIso(DateTime.addDuration(now, RENEWABLE_SESSION_WINDOW));
    // Mint a dedicated opaque token accepted ONLY by /api/team/{provider-proxy,provider-lease,assets},
    // never registered in SessionStore (so spawned agents reading env vars cannot access WS/HTTP APIs).
    const token = `t3teamsync_${NodeCrypto.randomBytes(32).toString("base64url")}`;
    yield* assetsRepo
      .insertLocalSyncToken({
        tokenHash: hashInviteToken(token),
        teamId: team.id,
        memberId: actor.id,
        sessionId,
        createdAt: nowIso,
      })
      .pipe(Effect.mapError(toInternalError));
    return {
      token,
      teamId: team.id,
      memberId: actor.id,
      expiresAt,
    } satisfies TeamIssueLocalSyncTokenResult;
  });

  const assertLocalBindingHostAllowed = Effect.fn("TeamService.assertLocalBindingHostAllowed")(
    function* () {
      const workspaceOpt = yield* repository
        .getWorkspace()
        .pipe(Effect.orElseSucceed(() => Option.none<TeamWorkspace>()));
      if (Option.isSome(workspaceOpt)) {
        return yield* new TeamOperationError({
          code: "forbidden",
          message: "Local team provider bindings cannot be configured on a Team Server.",
        });
      }
    },
  );

  const assertCanManageServerProviders = Effect.fn("TeamService.assertCanManageServerProviders")(
    function* (sessionId: AuthSessionId) {
      const workspaceOpt = yield* repository
        .getWorkspace()
        .pipe(Effect.orElseSucceed(() => Option.none<TeamWorkspace>()));
      if (Option.isNone(workspaceOpt)) return;
      const memberOpt = yield* repository
        .getMemberForSession(sessionId)
        .pipe(Effect.orElseSucceed(() => Option.none<TeamMember>()));
      const member = Option.getOrNull(memberOpt);
      if (
        member === null ||
        member.teamId !== workspaceOpt.value.id ||
        member.status !== "active" ||
        !canManageTeamProviders(member.role)
      ) {
        return yield* teamAdminAuthError(
          "Only team owners and admins can configure or authenticate providers on a Team Server.",
          "team:provider:write",
        );
      }
    },
  );

  const updateMyMobileVisibility = Effect.fn("TeamService.updateMyMobileVisibility")(
    function* (input: {
      readonly sessionId: AuthSessionId;
      readonly payload: TeamUpdateMyMobileVisibilityInput;
    }) {
      const team = yield* requireWorkspace();
      const actor = yield* requireActiveMember(input.sessionId);
      if (actor.teamId !== team.id) {
        return yield* new TeamOperationError({
          code: "forbidden",
          message: "This session does not belong to the active team.",
        });
      }
      const updatedAt = DateTime.formatIso(yield* DateTime.now);
      const updated = yield* repository
        .setMemberMobileVisibility({
          memberId: actor.id,
          teamId: team.id,
          visibility: input.payload.upstreamClientThreadVisibility,
          updatedAt,
        })
        .pipe(logAndMapInternalError("updateMyMobileVisibility"));
      if (Option.isNone(updated)) {
        return yield* new TeamOperationError({
          code: "not_found",
          message: "Team member could not be found.",
        });
      }
      yield* publish({ version: 1, type: "memberUpserted", payload: updated.value });
      yield* publishAccessChange({ type: "memberVisibility", memberId: actor.id });
      return updated.value;
    },
  );

  const assertCanCreateStandardPairingLink = Effect.fn(
    "TeamService.assertCanCreateStandardPairingLink",
  )(function* (input: {
    readonly sessionId: AuthSessionId;
    readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  }) {
    const workspaceOption = yield* repository
      .getWorkspace()
      .pipe(logAndMapInternalError("assertCanCreateStandardPairingLink.getWorkspace"));
    if (Option.isNone(workspaceOption)) return;
    const bindingOption = yield* repository
      .getSessionBinding(input.sessionId)
      .pipe(logAndMapInternalError("assertCanCreateStandardPairingLink.getSessionBinding"));
    if (Option.isNone(bindingOption)) {
      return yield* new TeamOperationError({
        code: "forbidden",
        message: "Only active team members can create standard pairing links on a team server.",
      });
    }
    const memberOption = yield* repository
      .getMemberById(bindingOption.value.memberId)
      .pipe(logAndMapInternalError("assertCanCreateStandardPairingLink.getMemberById"));
    if (
      Option.isNone(memberOption) ||
      memberOption.value.teamId !== workspaceOption.value.id ||
      memberOption.value.status !== "active"
    ) {
      return yield* new TeamOperationError({
        code: "forbidden",
        message: "Your team membership is no longer active.",
      });
    }
    const roleAllowedScopes = new Set(scopesForTeamRole(memberOption.value.role));
    for (const scope of input.scopes) {
      if (!roleAllowedScopes.has(scope)) {
        return yield* new TeamOperationError({
          code: "forbidden",
          message: "Cannot create a pairing link with broader scopes than your team role.",
        });
      }
    }
  });

  const bindPairingLinkToSessionMember = Effect.fn("TeamService.bindPairingLinkToSessionMember")(
    function* (input: { readonly sessionId: AuthSessionId; readonly pairingLinkId: string }) {
      return yield* withMembershipMutationGate(
        Effect.gen(function* () {
          const workspaceOption = yield* repository
            .getWorkspace()
            .pipe(logAndMapInternalError("bindPairingLinkToSessionMember.getWorkspace"));
          if (Option.isNone(workspaceOption)) {
            return { bound: false };
          }
          const bindingOption = yield* repository
            .getSessionBinding(input.sessionId)
            .pipe(logAndMapInternalError("bindPairingLinkToSessionMember.getSessionBinding"));
          if (Option.isNone(bindingOption)) {
            return yield* new TeamOperationError({
              code: "forbidden",
              message:
                "Only active team members can create standard pairing links on a team server.",
            });
          }
          const memberOption = yield* repository
            .getMemberById(bindingOption.value.memberId)
            .pipe(logAndMapInternalError("bindPairingLinkToSessionMember.getMemberById"));
          if (
            Option.isNone(memberOption) ||
            memberOption.value.teamId !== workspaceOption.value.id ||
            memberOption.value.status !== "active"
          ) {
            return yield* new TeamOperationError({
              code: "forbidden",
              message: "Your team membership is no longer active.",
            });
          }
          const createdAt = DateTime.formatIso(yield* DateTime.now);
          yield* repository
            .bindPairingLinkMeta({
              pairingLinkId: input.pairingLinkId,
              teamId: workspaceOption.value.id,
              memberId: memberOption.value.id,
              createdAt,
            })
            .pipe(logAndMapInternalError("bindPairingLinkToSessionMember.bind"));
          return { bound: true };
        }),
      );
    },
  );

  const createMobilePairingLink = Effect.fn("TeamService.createMobilePairingLink")(
    function* (input: {
      readonly sessionId: AuthSessionId;
      readonly callerScopes: ReadonlyArray<AuthEnvironmentScope>;
      readonly payload: TeamCreateMobilePairingLinkInput;
      readonly serverAuth?: EnvironmentAuth.EnvironmentAuth["Service"];
    }) {
      const team = yield* requireWorkspace();
      const actor = yield* requireActiveMember(input.sessionId);
      if (actor.teamId !== team.id) {
        return yield* new TeamOperationError({
          code: "forbidden",
          message: "This session does not belong to the active team.",
        });
      }
      const auth = input.serverAuth ?? Option.getOrUndefined(environmentAuthOption);
      if (!auth) {
        return yield* new TeamOperationError({
          code: "internal",
          message: "Pairing link service is unavailable on this server.",
        });
      }
      const roleScopes = scopesForTeamRole(actor.role);
      const callerScopeSet = new Set(input.callerScopes);
      const maxAllowedScopes = roleScopes.filter((scope) => callerScopeSet.has(scope));
      if (maxAllowedScopes.length === 0) {
        return yield* new TeamOperationError({
          code: "forbidden",
          message:
            "Your current session has no delegatable scopes to create a mobile pairing link.",
        });
      }
      const maxAllowedSet = new Set(maxAllowedScopes);
      let requestedScopes: ReadonlyArray<AuthEnvironmentScope>;
      if (input.payload.scopes !== undefined) {
        const deduped = [...new Set(input.payload.scopes)];
        if (deduped.length === 0) {
          return yield* new TeamOperationError({
            code: "invalid_input",
            message: "At least one scope is required for a pairing link.",
          });
        }
        for (const scope of deduped) {
          if (!maxAllowedSet.has(scope)) {
            return yield* new TeamOperationError({
              code: "forbidden",
              message:
                "Cannot create a pairing link with broader scopes than your own team member session.",
            });
          }
        }
        requestedScopes = deduped;
      } else {
        requestedScopes = maxAllowedScopes;
      }
      const label = input.payload.label?.trim() || `${actor.pseudo} (mobile)`;
      const issued = yield* auth
        .createPairingLink({
          scopes: requestedScopes,
          subject: "one-time-token",
          label,
        })
        .pipe(
          Effect.catch(
            Effect.fnUntraced(function* (error) {
              if (error._tag === "ManagedPolicyRefusedError") {
                return yield* new TeamOperationError({
                  code: "forbidden",
                  message: error.message,
                });
              }
              yield* Effect.logWarning("TeamService.createMobilePairingLink failed", {
                cause: error,
              });
              return yield* toInternalError(error);
            }),
          ),
        );
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      yield* withMembershipMutationGate(
        Effect.gen(function* () {
          const freshMember = yield* repository
            .getMemberById(actor.id)
            .pipe(logAndMapInternalError("createMobilePairingLink.recheckMember"));
          if (
            Option.isNone(freshMember) ||
            freshMember.value.teamId !== team.id ||
            freshMember.value.status !== "active"
          ) {
            return yield* new TeamOperationError({
              code: "forbidden",
              message: "Your team membership is no longer active.",
            });
          }
          yield* repository
            .bindPairingLinkMeta({
              pairingLinkId: issued.id,
              teamId: team.id,
              memberId: actor.id,
              createdAt,
            })
            .pipe(logAndMapInternalError("createMobilePairingLink.bindMeta"));
        }),
      ).pipe(Effect.onError(() => auth.revokePairingLink(issued.id).pipe(Effect.ignore)));
      return {
        id: issued.id,
        credential: issued.credential,
        ...(issued.label !== undefined ? { label: issued.label } : {}),
        scopes: [...issued.scopes],
        expiresAt: DateTime.formatIso(issued.expiresAt),
      } satisfies TeamCreateMobilePairingLinkResult;
    },
  );

  const listMyMobilePairingLinks = Effect.fn("TeamService.listMyMobilePairingLinks")(
    function* (input: {
      readonly sessionId: AuthSessionId;
      readonly serverAuth?: EnvironmentAuth.EnvironmentAuth["Service"];
    }) {
      const team = yield* requireWorkspace();
      const actor = yield* requireActiveMember(input.sessionId);
      if (actor.teamId !== team.id) {
        return yield* new TeamOperationError({
          code: "forbidden",
          message: "This session does not belong to the active team.",
        });
      }
      const auth = input.serverAuth ?? Option.getOrUndefined(environmentAuthOption);
      if (!auth) {
        return [] as ReadonlyArray<TeamMobilePairingLinkSummary>;
      }
      const ownedIds = new Set(
        yield* repository
          .listPairingLinkIdsForMember(actor.id)
          .pipe(logAndMapInternalError("listMyMobilePairingLinks.listIds")),
      );
      if (ownedIds.size === 0) return [] as ReadonlyArray<TeamMobilePairingLinkSummary>;
      const activeLinks = yield* auth
        .listPairingLinks()
        .pipe(logAndMapInternalError("listMyMobilePairingLinks.listActive"));
      return activeLinks
        .filter((link) => ownedIds.has(link.id))
        .map((link): TeamMobilePairingLinkSummary => ({
          id: link.id,
          label: link.label ?? null,
          scopes: [...link.scopes],
          createdAt: DateTime.formatIso(link.createdAt),
          expiresAt: DateTime.formatIso(link.expiresAt),
        }));
    },
  );

  const revokeMyMobilePairingLink = Effect.fn("TeamService.revokeMyMobilePairingLink")(
    function* (input: {
      readonly sessionId: AuthSessionId;
      readonly payload: TeamRevokeMobilePairingLinkInput;
      readonly serverAuth?: EnvironmentAuth.EnvironmentAuth["Service"];
    }) {
      const team = yield* requireWorkspace();
      const actor = yield* requireActiveMember(input.sessionId);
      if (actor.teamId !== team.id) {
        return yield* new TeamOperationError({
          code: "forbidden",
          message: "This session does not belong to the active team.",
        });
      }
      const auth = input.serverAuth ?? Option.getOrUndefined(environmentAuthOption);
      return yield* withMembershipMutationGate(
        Effect.gen(function* () {
          const metaOption = yield* repository
            .getPairingLinkMeta(input.payload.id)
            .pipe(logAndMapInternalError("revokeMyMobilePairingLink.getMeta"));
          if (
            Option.isNone(metaOption) ||
            metaOption.value.teamId !== team.id ||
            metaOption.value.memberId !== actor.id
          ) {
            return yield* new TeamOperationError({
              code: "forbidden",
              message: "You can only revoke your own mobile pairing links.",
            });
          }
          const revokedAt = DateTime.formatIso(yield* DateTime.now);
          yield* repository
            .markPairingLinkMetaRevoked({
              pairingLinkId: input.payload.id,
              revokedAt,
            })
            .pipe(logAndMapInternalError("revokeMyMobilePairingLink.tombstone"));
          const revoked = auth
            ? yield* auth
                .revokePairingLink(input.payload.id)
                .pipe(logAndMapInternalError("revokeMyMobilePairingLink.revoke"))
            : false;
          return { revoked } satisfies TeamRevokeMobilePairingLinkResult;
        }),
      );
    },
  );

  const markPairingLinkRevoked = Effect.fn("TeamService.markPairingLinkRevoked")(function* (
    pairingLinkId: string,
  ) {
    yield* withMembershipMutationGate(
      Effect.gen(function* () {
        const revokedAt = DateTime.formatIso(yield* DateTime.now);
        yield* repository
          .markPairingLinkMetaRevoked({ pairingLinkId, revokedAt })
          .pipe(Effect.ignore);
      }),
    );
  });

  const filterVisibleShellThreadIds = Effect.fn("TeamService.filterVisibleShellThreadIds")(
    function* (
      sessionId: AuthSessionId,
      threadIds: ReadonlyArray<ThreadId>,
      options?: { readonly upstreamCompat?: boolean },
    ): Effect.fn.Return<ReadonlySet<ThreadId>> {
      const readableIds = yield* filterReadableThreadIds(sessionId, threadIds);
      if (!options?.upstreamCompat || readableIds.size === 0) {
        return readableIds;
      }
      const workspaceOption = yield* repository
        .getWorkspace()
        .pipe(Effect.orElseSucceed(() => Option.none<TeamWorkspace>()));
      if (Option.isNone(workspaceOption)) {
        return readableIds;
      }
      const team = workspaceOption.value;
      const memberOption = yield* repository
        .getMemberForSession(sessionId)
        .pipe(Effect.orElseSucceed(() => Option.none<TeamMember>()));
      if (
        Option.isNone(memberOption) ||
        memberOption.value.teamId !== team.id ||
        memberOption.value.status !== "active"
      ) {
        return new Set<ThreadId>();
      }
      const member = memberOption.value;
      const visibility = effectiveUpstreamClientThreadVisibility(member);
      if (visibility === "all_accessible") {
        return readableIds;
      }
      if (readableIds.size === 1) {
        const [onlyThreadId] = readableIds;
        if (onlyThreadId === undefined) return new Set<ThreadId>();
        const attributionOption = yield* repository
          .getThreadAttribution(onlyThreadId)
          .pipe(Effect.orElseSucceed(() => Option.none<TeamThreadAttribution>()));
        if (Option.isNone(attributionOption)) {
          return readableIds;
        }
        if (attributionOption.value.creatorMemberId === member.id) {
          return readableIds;
        }
        const followed = yield* repository
          .isFollowingThread({ threadId: onlyThreadId, memberId: member.id })
          .pipe(Effect.orElseSucceed(() => false));
        return followed ? readableIds : new Set<ThreadId>();
      }
      const [attributions, followedIds] = yield* Effect.all([
        repository
          .listThreadAttributions(team.id)
          .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<TeamThreadAttribution>)),
        repository
          .listFollowedThreadIds(member.id)
          .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<ThreadId>)),
      ]);
      const attributionByThreadId = new Map<ThreadId, TeamThreadAttribution>(
        attributions.map((entry) => [entry.threadId, entry] as const),
      );
      const followedSet = new Set<ThreadId>(followedIds);
      const visible = new Set<ThreadId>();
      for (const threadId of readableIds) {
        const attribution = attributionByThreadId.get(threadId);
        if (!attribution) {
          // Legacy pre-team unattributed thread that passed readability check stays visible.
          visible.add(threadId);
          continue;
        }
        if (attribution.creatorMemberId === member.id || followedSet.has(threadId)) {
          visible.add(threadId);
        }
      }
      return visible;
    },
  );

  const canShowThreadInShell = Effect.fn("TeamService.canShowThreadInShell")(function* (
    sessionId: AuthSessionId,
    threadId: ThreadId,
    options?: { readonly upstreamCompat?: boolean },
  ) {
    // Single-thread O(1) path avoids full-table scans on live shell stream events.
    const readable = yield* canReadThread(sessionId, threadId);
    if (!readable) return false;
    if (!options?.upstreamCompat) return true;
    const workspaceOption = yield* repository
      .getWorkspace()
      .pipe(Effect.orElseSucceed(() => Option.none<TeamWorkspace>()));
    if (Option.isNone(workspaceOption)) return true;
    const team = workspaceOption.value;
    const memberOption = yield* repository
      .getMemberForSession(sessionId)
      .pipe(Effect.orElseSucceed(() => Option.none<TeamMember>()));
    if (
      Option.isNone(memberOption) ||
      memberOption.value.teamId !== team.id ||
      memberOption.value.status !== "active"
    ) {
      return false;
    }
    const member = memberOption.value;
    const visibility = effectiveUpstreamClientThreadVisibility(member);
    if (visibility === "all_accessible") return true;
    const attributionOption = yield* repository
      .getThreadAttribution(threadId)
      .pipe(Effect.orElseSucceed(() => Option.none<TeamThreadAttribution>()));
    if (Option.isNone(attributionOption)) return true;
    if (attributionOption.value.creatorMemberId === member.id) return true;
    return yield* repository
      .isFollowingThread({ threadId, memberId: member.id })
      .pipe(Effect.orElseSucceed(() => false));
  });

  const shouldRefreshShellForAccessChange = Effect.fn(
    "TeamService.shouldRefreshShellForAccessChange",
  )(function* (
    sessionId: AuthSessionId,
    change: TeamAccessChangeEvent,
    options?: { readonly upstreamCompat?: boolean },
  ) {
    const upstreamCompat = options?.upstreamCompat === true;
    if (change.type === "memberVisibility" || change.type === "memberFollow") {
      if (!upstreamCompat) return false;
      const memberIdOption = yield* resolveMemberIdForSession(sessionId);
      return Option.isSome(memberIdOption) && memberIdOption.value === change.memberId;
    }
    if (change.type === "scheduledTaskMeta") {
      return false;
    }
    if (change.type === "memberPseudo") {
      return upstreamCompat;
    }
    return true;
  });

  // Register member-bound pairing redemption hook on EnvironmentAuth so standard pairing links
  // minted by active team members fail closed if suspended/removed and auto-bind team_session_meta.
  if (
    Option.isSome(environmentAuthOption) &&
    typeof environmentAuthOption.value.registerPairingRedemptionHook === "function"
  ) {
    const unregisterPairingHook = yield* environmentAuthOption.value.registerPairingRedemptionHook({
      wrapPairingRedemption: withMembershipMutationGate,
      beforeIssueSession: Effect.fn("TeamService.pairingHook.beforeIssueSession")(function* ({
        pairingLinkId,
        grantedScopes,
      }) {
        const metaOption = yield* repository
          .getPairingLinkMeta(pairingLinkId)
          .pipe(
            Effect.mapError(
              (cause) =>
                new EnvironmentAuth.ServerAuthBootstrapCredentialValidationError({ cause }),
            ),
          );
        if (Option.isNone(metaOption)) {
          return null;
        }
        const meta = metaOption.value;
        if (meta.revokedAt !== null) {
          return yield* new EnvironmentAuth.ServerAuthInvalidCredentialError({
            diagnostic: "This pairing link has been revoked.",
          });
        }
        const [workspaceOption, memberOption] = yield* Effect.all([
          repository.getWorkspace(),
          repository.getMemberById(meta.memberId),
        ]).pipe(
          Effect.mapError(
            (cause) => new EnvironmentAuth.ServerAuthBootstrapCredentialValidationError({ cause }),
          ),
        );
        if (
          Option.isNone(workspaceOption) ||
          workspaceOption.value.id !== meta.teamId ||
          Option.isNone(memberOption) ||
          memberOption.value.teamId !== meta.teamId ||
          memberOption.value.status !== "active"
        ) {
          return yield* new EnvironmentAuth.ServerAuthInvalidCredentialError({
            diagnostic: "The team member who created this pairing link is no longer active.",
          });
        }
        const roleScopes = new Set(scopesForTeamRole(memberOption.value.role));
        const effectiveScopes = grantedScopes.filter((scope) => roleScopes.has(scope));
        return {
          teamId: meta.teamId,
          memberId: meta.memberId,
          effectiveScopes,
        };
      }),
      afterIssueSession: Effect.fn("TeamService.pairingHook.afterIssueSession")(function* ({
        pairingLinkId,
        sessionId,
        teamId,
        memberId,
        grantedScopes,
      }) {
        const boundAt = DateTime.formatIso(yield* DateTime.now);
        const [metaOption, workspaceOption, memberOption] = yield* Effect.all([
          repository.getPairingLinkMeta(pairingLinkId),
          repository.getWorkspace(),
          repository.getMemberById(TeamMemberId.make(memberId)),
        ]).pipe(
          Effect.mapError(
            (cause) => new EnvironmentAuth.ServerAuthAuthenticatedSessionIssueError({ cause }),
          ),
        );
        if (
          Option.isNone(metaOption) ||
          metaOption.value.revokedAt !== null ||
          Option.isNone(workspaceOption) ||
          workspaceOption.value.id !== teamId ||
          Option.isNone(memberOption) ||
          memberOption.value.teamId !== teamId ||
          memberOption.value.status !== "active"
        ) {
          return yield* new EnvironmentAuth.ServerAuthInvalidCredentialError({
            diagnostic: "The pairing link or originating team member is no longer active.",
          });
        }
        yield* repository
          .bindSession({
            sessionId,
            teamId: TeamId.make(teamId),
            memberId: TeamMemberId.make(memberId),
            boundAt,
          })
          .pipe(
            Effect.mapError(
              (cause) => new EnvironmentAuth.ServerAuthAuthenticatedSessionIssueError({ cause }),
            ),
          );
        yield* repository
          .setSessionScopeCeiling({
            sessionId,
            maxScopes: grantedScopes,
            createdAt: boundAt,
          })
          .pipe(
            Effect.mapError(
              (cause) => new EnvironmentAuth.ServerAuthAuthenticatedSessionIssueError({ cause }),
            ),
          );
        yield* repository
          .markPairingLinkMetaRevoked({ pairingLinkId, revokedAt: boundAt })
          .pipe(Effect.ignore);
      }),
    });
    yield* Effect.addFinalizer(() => Effect.sync(unregisterPairingHook));
  }

  const requireGitHubDeps = Effect.fn("TeamService.requireGitHubDeps")(function* () {
    if (Option.isNone(githubRepositoryOption) || Option.isNone(secretStoreOption)) {
      return yield* new TeamOperationError({
        code: "internal",
        message: "GitHub identity storage is unavailable on this server.",
      });
    }
    const httpClient = Option.isSome(httpClientOption)
      ? httpClientOption.value
      : yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer));
    return {
      githubRepo: githubRepositoryOption.value,
      secrets: secretStoreOption.value,
      httpClient,
    };
  });

  const connectMyGitHub = Effect.fn("TeamService.connectMyGitHub")(function* (input: {
    readonly sessionId: AuthSessionId;
    readonly payload: TeamConnectMyGitHubInput;
  }) {
    const team = yield* requireWorkspace();
    const actor = yield* requireActiveMember(input.sessionId);
    if (actor.teamId !== team.id) {
      return yield* new TeamOperationError({
        code: "forbidden",
        message: "This session does not belong to the active team.",
      });
    }
    const authMethod = input.payload.authMethod ?? "pat";
    const { githubRepo, secrets, httpClient } = yield* requireGitHubDeps();
    const verified = yield* TeamGitHubRepository.verifyGitHubToken({
      httpClient,
      token: input.payload.token,
      apiBaseUrl: input.payload.apiBaseUrl ?? null,
      githubNameOverride: input.payload.githubName ?? null,
      githubEmailOverride: input.payload.githubEmail ?? null,
    });
    return yield* TeamGitHubOAuth.withMemberGitHubCredentialMutationLock(
      team.id,
      actor.id,
      Effect.gen(function* () {
        const latestActor = yield* requireActiveMember(input.sessionId);
        if (latestActor.teamId !== team.id) {
          return yield* new TeamOperationError({
            code: "forbidden",
            message: "This session does not belong to the active team.",
          });
        }
        TeamGitHubOAuth.purgeMemberPendingGitHubOAuthFlows(githubOAuthFlowStore, actor.id);
        const nowIso = DateTime.formatIso(yield* DateTime.now);
        const existingOpt = yield* githubRepo
          .getMemberCredential(actor.id)
          .pipe(Effect.mapError(toInternalError));
        const secretRevision = (yield* random.uuidV4()).replaceAll("-", "").slice(0, 12);
        const secretKey = `${TeamGitHubRepository.teamMemberGitHubSecretKey(team.id, actor.id)}-${secretRevision}`;
        yield* TeamGitHubRepository.writeTeamGitHubSecret(secrets, secretKey, {
          authMethod,
          accessToken: input.payload.token.trim(),
          apiBaseUrl: verified.apiBaseUrl,
          githubLogin: verified.githubLogin,
          githubName: verified.githubName,
          githubEmail: verified.githubEmail,
        });
        const stored = yield* githubRepo
          .upsertMemberCredential({
            memberId: actor.id,
            teamId: team.id,
            authMethod,
            githubLogin: verified.githubLogin,
            githubName: verified.githubName,
            githubEmail: verified.githubEmail,
            apiBaseUrl: verified.apiBaseUrl,
            secretKey,
            connectedAt: Option.isSome(existingOpt) ? existingOpt.value.connectedAt : nowIso,
            updatedAt: nowIso,
            tokenExpiresAt: null,
            hasRefreshToken: false,
            needsReconnect: false,
            reconnectReason: null,
          })
          .pipe(
            Effect.onError(() =>
              TeamGitHubRepository.removeTeamGitHubSecret(secrets, secretKey).pipe(Effect.ignore),
            ),
            Effect.mapError(toInternalError),
          );
        // Immediately invalidate prior active turn leases & recycle warm sessions on PAT rotation,
        // then remove the superseded secret key after the DB commit has flipped to the new revision.
        yield* notifyGitHubCredentialChanged({
          kind: "member",
          teamId: team.id,
          memberId: actor.id,
        });
        if (Option.isSome(existingOpt) && existingOpt.value.secretKey !== secretKey) {
          yield* TeamGitHubRepository.removeTeamGitHubSecret(
            secrets,
            existingOpt.value.secretKey,
          ).pipe(Effect.ignore);
        }
        const identity = TeamGitHubRepository.stripMemberGitHubSecretKey(stored);
        yield* publish({
          version: 1,
          type: "myGitHubIdentityUpdated",
          payload: { memberId: actor.id, identity },
        });
        return identity;
      }),
    );
  });

  const disconnectMyGitHub = Effect.fn("TeamService.disconnectMyGitHub")(function* (input: {
    readonly sessionId: AuthSessionId;
  }) {
    const team = yield* requireWorkspace();
    const actor = yield* requireActiveMember(input.sessionId);
    if (actor.teamId !== team.id) {
      return yield* new TeamOperationError({
        code: "forbidden",
        message: "This session does not belong to the active team.",
      });
    }
    const { githubRepo, secrets } = yield* requireGitHubDeps();
    return yield* TeamGitHubOAuth.withMemberGitHubCredentialMutationLock(
      team.id,
      actor.id,
      Effect.gen(function* () {
        const latestActor = yield* requireActiveMember(input.sessionId);
        if (latestActor.teamId !== team.id) {
          return yield* new TeamOperationError({
            code: "forbidden",
            message: "This session does not belong to the active team.",
          });
        }
        TeamGitHubOAuth.purgeMemberPendingGitHubOAuthFlows(githubOAuthFlowStore, actor.id);
        const nowIso = DateTime.formatIso(yield* DateTime.now);
        const removedSecretKeyOpt = yield* githubRepo
          .deleteMemberCredential(actor.id, nowIso)
          .pipe(Effect.mapError(toInternalError));
        const fallbackSecretKey = TeamGitHubRepository.teamMemberGitHubSecretKey(team.id, actor.id);
        yield* TeamGitHubRepository.removeTeamGitHubSecret(
          secrets,
          Option.getOrElse(removedSecretKeyOpt, () => fallbackSecretKey),
        ).pipe(Effect.ignore);
        yield* notifyGitHubCredentialChanged({
          kind: "member",
          teamId: team.id,
          memberId: actor.id,
        });
        yield* publish({
          version: 1,
          type: "myGitHubIdentityUpdated",
          payload: { memberId: actor.id, identity: null },
        });
        return { disconnected: Option.isSome(removedSecretKeyOpt) };
      }),
    );
  });

  const setAutomationGitHub = Effect.fn("TeamService.setAutomationGitHub")(function* (input: {
    readonly sessionId: AuthSessionId;
    readonly payload: TeamSetAutomationGitHubInput;
  }) {
    const team = yield* requireWorkspace();
    const actor = yield* requireActiveMember(input.sessionId);
    if (actor.teamId !== team.id || !canManageTeamAutomationGitHub(actor.role)) {
      return yield* new TeamOperationError({
        code: "forbidden",
        message: "Only owner and admin members can configure the team automation GitHub account.",
      });
    }
    const authMethod = input.payload.authMethod ?? "pat";
    const { githubRepo, secrets, httpClient } = yield* requireGitHubDeps();
    const verified = yield* TeamGitHubRepository.verifyGitHubToken({
      httpClient,
      token: input.payload.token,
      apiBaseUrl: input.payload.apiBaseUrl ?? null,
      githubNameOverride: input.payload.githubName ?? null,
      githubEmailOverride: input.payload.githubEmail ?? null,
    });
    const nowIso = DateTime.formatIso(yield* DateTime.now);
    const existingOpt = yield* githubRepo
      .getAutomationCredential(team.id)
      .pipe(Effect.mapError(toInternalError));
    const secretRevision = (yield* random.uuidV4()).replaceAll("-", "").slice(0, 12);
    const secretKey = `${TeamGitHubRepository.teamAutomationGitHubSecretKey(team.id)}-${secretRevision}`;
    yield* TeamGitHubRepository.writeTeamGitHubSecret(secrets, secretKey, {
      authMethod,
      accessToken: input.payload.token.trim(),
      apiBaseUrl: verified.apiBaseUrl,
      githubLogin: verified.githubLogin,
      githubName: verified.githubName,
      githubEmail: verified.githubEmail,
    });
    const stored = yield* githubRepo
      .upsertAutomationCredential({
        teamId: team.id,
        authMethod,
        githubLogin: verified.githubLogin,
        githubName: verified.githubName,
        githubEmail: verified.githubEmail,
        apiBaseUrl: verified.apiBaseUrl,
        secretKey,
        updatedByMemberId: actor.id,
        connectedAt: Option.isSome(existingOpt) ? existingOpt.value.connectedAt : nowIso,
        updatedAt: nowIso,
      })
      .pipe(
        Effect.onError(() =>
          TeamGitHubRepository.removeTeamGitHubSecret(secrets, secretKey).pipe(Effect.ignore),
        ),
        Effect.mapError(toInternalError),
      );
    yield* notifyGitHubCredentialChanged({
      kind: "automation",
      teamId: team.id,
    });
    if (Option.isSome(existingOpt) && existingOpt.value.secretKey !== secretKey) {
      yield* TeamGitHubRepository.removeTeamGitHubSecret(secrets, existingOpt.value.secretKey).pipe(
        Effect.ignore,
      );
    }
    const identity = TeamGitHubRepository.stripAutomationGitHubSecretKey(stored);
    yield* publish({
      version: 1,
      type: "automationGitHubIdentityUpdated",
      payload: { identity },
    });
    return identity;
  });

  const clearAutomationGitHub = Effect.fn("TeamService.clearAutomationGitHub")(function* (input: {
    readonly sessionId: AuthSessionId;
  }) {
    const team = yield* requireWorkspace();
    const actor = yield* requireActiveMember(input.sessionId);
    if (actor.teamId !== team.id || !canManageTeamAutomationGitHub(actor.role)) {
      return yield* new TeamOperationError({
        code: "forbidden",
        message: "Only owner and admin members can clear the team automation GitHub account.",
      });
    }
    const { githubRepo, secrets } = yield* requireGitHubDeps();
    const removedSecretKeyOpt = yield* githubRepo
      .deleteAutomationCredential(team.id)
      .pipe(Effect.mapError(toInternalError));
    const fallbackSecretKey = TeamGitHubRepository.teamAutomationGitHubSecretKey(team.id);
    yield* TeamGitHubRepository.removeTeamGitHubSecret(
      secrets,
      Option.getOrElse(removedSecretKeyOpt, () => fallbackSecretKey),
    ).pipe(Effect.ignore);
    yield* notifyGitHubCredentialChanged({
      kind: "automation",
      teamId: team.id,
    });
    yield* publish({
      version: 1,
      type: "automationGitHubIdentityUpdated",
      payload: { identity: null },
    });
    return { cleared: Option.isSome(removedSecretKeyOpt) };
  });

  const assertOAuthFlowStillAuthorized = Effect.fn("TeamService.assertOAuthFlowStillAuthorized")(
    function* (input: {
      readonly teamId: TeamId;
      readonly memberId: TeamMemberId;
      readonly sessionId: AuthSessionId;
      readonly mode: TeamGitHubOAuthMode;
      readonly clientId: string;
      readonly webBaseUrl: string;
      readonly apiBaseUrl: string;
      readonly memberGeneration: number;
      readonly teamGeneration: number;
      readonly isCancelled?: () => boolean;
    }): Effect.fn.Return<TeamGitHubRepository.StoredGitHubAppConfigRecord, TeamOperationError> {
      if (
        input.isCancelled?.() === true ||
        TeamGitHubOAuth.getMemberOAuthGeneration(githubOAuthFlowStore, input.memberId) !==
          input.memberGeneration ||
        TeamGitHubOAuth.getTeamOAuthGeneration(githubOAuthFlowStore, input.teamId) !==
          input.teamGeneration
      ) {
        return yield* new TeamOperationError({
          code: "github_oauth_state_invalid",
          message: "GitHub sign-in was cancelled or superseded before completion.",
        });
      }
      const team = yield* requireWorkspace();
      if (team.id !== input.teamId) {
        return yield* new TeamOperationError({
          code: "github_oauth_state_invalid",
          message: "GitHub OAuth state does not match the active team.",
        });
      }
      if (Option.isSome(authSessionsOption)) {
        const sessionOpt = yield* authSessionsOption.value
          .getById({ sessionId: input.sessionId })
          .pipe(Effect.orElseSucceed(() => Option.none()));
        const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
        if (
          Option.isNone(sessionOpt) ||
          sessionOpt.value.revokedAt !== null ||
          DateTime.toEpochMillis(sessionOpt.value.expiresAt) <= nowMs
        ) {
          return yield* new TeamOperationError({
            code: "forbidden",
            message: "The session that initiated GitHub sign-in has expired or been revoked.",
          });
        }
      }
      const bindingOpt = yield* repository
        .getSessionBinding(input.sessionId)
        .pipe(Effect.mapError(toInternalError));
      if (
        Option.isNone(bindingOpt) ||
        bindingOpt.value.teamId !== input.teamId ||
        bindingOpt.value.memberId !== input.memberId
      ) {
        return yield* new TeamOperationError({
          code: "forbidden",
          message:
            "The session that initiated GitHub sign-in is no longer bound to your member account.",
        });
      }
      const memberOpt = yield* repository
        .getMemberById(input.memberId)
        .pipe(Effect.mapError(toInternalError));
      if (
        Option.isNone(memberOpt) ||
        memberOpt.value.teamId !== input.teamId ||
        memberOpt.value.status !== "active"
      ) {
        return yield* new TeamOperationError({
          code: "forbidden",
          message: "Your team membership is no longer active.",
        });
      }
      const { githubRepo } = yield* requireGitHubDeps();
      const configOpt = yield* githubRepo
        .getGitHubAppConfig(team.id)
        .pipe(Effect.mapError(toInternalError));
      if (
        Option.isNone(configOpt) ||
        !configOpt.value.enabled ||
        configOpt.value.clientId !== input.clientId ||
        configOpt.value.mode !== input.mode ||
        configOpt.value.webBaseUrl !== input.webBaseUrl ||
        configOpt.value.apiBaseUrl !== input.apiBaseUrl
      ) {
        return yield* new TeamOperationError({
          code: "github_oauth_not_configured",
          message: "Team GitHub OAuth / GitHub App configuration was changed or disabled.",
        });
      }
      return configOpt.value;
    },
  );

  const persistMemberOAuthCredential = Effect.fn("TeamService.persistMemberOAuthCredential")(
    function* (input: {
      readonly teamId: TeamId;
      readonly memberId: TeamMemberId;
      readonly mode: TeamGitHubOAuthMode;
      readonly clientId: string;
      readonly webBaseUrl: string;
      readonly apiBaseUrl: string;
      readonly tokenSet: TeamGitHubOAuth.ExchangedGitHubTokenSet;
      readonly githubNameOverride: string | null;
      readonly githubEmailOverride: string | null;
      readonly verifyStillAuthorized: Effect.Effect<unknown, TeamOperationError>;
      readonly onCommitted?: () => void;
    }) {
      const { githubRepo, secrets, httpClient } = yield* requireGitHubDeps();
      const verified = yield* TeamGitHubRepository.verifyGitHubToken({
        httpClient,
        token: input.tokenSet.accessToken,
        apiBaseUrl: input.apiBaseUrl,
        githubNameOverride: input.githubNameOverride,
        githubEmailOverride: input.githubEmailOverride,
      });
      // Serialize authorization re-check + secret write + DB upsert + lease invalidation + publish
      // with disconnect/PAT/refresh mutations so an in-flight OAuth completion can never resurrect
      // a disconnected credential or overwrite a newer PAT/OAuth revision.
      return yield* TeamGitHubOAuth.withMemberGitHubCredentialMutationLock(
        input.teamId,
        input.memberId,
        Effect.gen(function* () {
          yield* input.verifyStillAuthorized;
          const nowIso = DateTime.formatIso(yield* DateTime.now);
          const existingOpt = yield* githubRepo
            .getMemberCredential(input.memberId)
            .pipe(Effect.mapError(toInternalError));
          const secretRevision = (yield* random.uuidV4()).replaceAll("-", "").slice(0, 12);
          const secretKey = `${TeamGitHubRepository.teamMemberGitHubSecretKey(input.teamId, input.memberId)}-${secretRevision}`;
          yield* TeamGitHubRepository.writeTeamGitHubSecret(secrets, secretKey, {
            authMethod: input.mode,
            accessToken: input.tokenSet.accessToken,
            ...(input.tokenSet.refreshToken !== null
              ? { refreshToken: input.tokenSet.refreshToken }
              : {}),
            ...(input.tokenSet.expiresAt !== null ? { expiresAt: input.tokenSet.expiresAt } : {}),
            ...(input.tokenSet.refreshTokenExpiresAt !== null
              ? { refreshTokenExpiresAt: input.tokenSet.refreshTokenExpiresAt }
              : {}),
            tokenEndpoint: `${input.webBaseUrl}/login/oauth/access_token`,
            webBaseUrl: input.webBaseUrl,
            clientId: input.clientId,
            apiBaseUrl: verified.apiBaseUrl,
            githubLogin: verified.githubLogin,
            githubName: verified.githubName,
            githubEmail: verified.githubEmail,
          });
          const stored = yield* githubRepo
            .upsertMemberCredential({
              memberId: input.memberId,
              teamId: input.teamId,
              authMethod: input.mode,
              githubLogin: verified.githubLogin,
              githubName: verified.githubName,
              githubEmail: verified.githubEmail,
              apiBaseUrl: verified.apiBaseUrl,
              secretKey,
              connectedAt: Option.isSome(existingOpt) ? existingOpt.value.connectedAt : nowIso,
              updatedAt: nowIso,
              tokenExpiresAt: input.tokenSet.expiresAt,
              hasRefreshToken: input.tokenSet.refreshToken !== null,
              needsReconnect: false,
              reconnectReason: null,
            })
            .pipe(
              Effect.onError(() =>
                TeamGitHubRepository.removeTeamGitHubSecret(secrets, secretKey).pipe(Effect.ignore),
              ),
              Effect.mapError(toInternalError),
            );
          yield* notifyGitHubCredentialChanged({
            kind: "member",
            teamId: input.teamId,
            memberId: input.memberId,
          });
          if (Option.isSome(existingOpt) && existingOpt.value.secretKey !== secretKey) {
            yield* TeamGitHubRepository.removeTeamGitHubSecret(
              secrets,
              existingOpt.value.secretKey,
            ).pipe(Effect.ignore);
          }
          const identity = TeamGitHubRepository.stripMemberGitHubSecretKey(stored);
          input.onCommitted?.();
          yield* publish({
            version: 1,
            type: "myGitHubIdentityUpdated",
            payload: { memberId: input.memberId, identity },
          });
          return identity;
        }),
      );
    },
  );

  const setGitHubAppConfig = Effect.fn("TeamService.setGitHubAppConfig")(function* (input: {
    readonly sessionId: AuthSessionId;
    readonly payload: TeamSetGitHubAppConfigInput;
  }) {
    const team = yield* requireWorkspace();
    const actor = yield* requireActiveMember(input.sessionId);
    if (actor.teamId !== team.id || !canManageTeamGitHubAppConfig(actor.role)) {
      return yield* new TeamOperationError({
        code: "forbidden",
        message:
          "Only owner and admin members can configure team GitHub OAuth / GitHub App settings.",
      });
    }
    const { githubRepo, secrets } = yield* requireGitHubDeps();
    const webBaseUrl = yield* TeamGitHubRepository.normalizeGitHubWebBaseUrl(
      input.payload.webBaseUrl ?? null,
    );
    const rawApiBase = input.payload.apiBaseUrl?.trim() ?? "";
    const defaultApiBase =
      webBaseUrl === DEFAULT_GITHUB_WEB_BASE_URL
        ? DEFAULT_GITHUB_API_BASE_URL
        : `${webBaseUrl}/api/v3`;
    const apiBaseUrl = yield* TeamGitHubRepository.normalizeGitHubApiBaseUrl(
      rawApiBase.length > 0 ? rawApiBase : defaultApiBase,
    );
    const scopes =
      input.payload.mode === "github_app"
        ? ""
        : input.payload.scopes !== undefined && input.payload.scopes !== null
          ? input.payload.scopes.trim()
          : DEFAULT_GITHUB_OAUTH_SCOPES;
    const enabled = input.payload.enabled ?? true;
    const existingOpt = yield* githubRepo
      .getGitHubAppConfig(team.id)
      .pipe(Effect.mapError(toInternalError));
    const existingSecretKey = Option.isSome(existingOpt) ? existingOpt.value.clientSecretKey : null;

    const incomingSecret = input.payload.clientSecret?.trim() ?? "";
    let nextSecretKey: string | null = existingSecretKey;
    let newlyWrittenSecretKey: string | null = null;
    if (input.payload.clearClientSecret === true) {
      nextSecretKey = null;
    } else if (incomingSecret.length > 0) {
      const secretRevision = (yield* random.uuidV4()).replaceAll("-", "").slice(0, 12);
      nextSecretKey = `${TeamGitHubRepository.teamGitHubAppClientSecretKey(team.id)}-${secretRevision}`;
      yield* TeamGitHubRepository.writeTeamGitHubAppClientSecret(
        secrets,
        nextSecretKey,
        incomingSecret,
      );
      newlyWrittenSecretKey = nextSecretKey;
    }

    const nowIso = DateTime.formatIso(yield* DateTime.now);
    const stored = yield* githubRepo
      .upsertGitHubAppConfig({
        teamId: team.id,
        mode: input.payload.mode,
        clientId: input.payload.clientId.trim(),
        webBaseUrl,
        apiBaseUrl,
        scopes,
        enabled,
        clientSecretKey: nextSecretKey,
        updatedByMemberId: actor.id,
        updatedAt: nowIso,
      })
      .pipe(
        Effect.onError(() =>
          newlyWrittenSecretKey !== null
            ? TeamGitHubRepository.removeTeamGitHubSecret(secrets, newlyWrittenSecretKey).pipe(
                Effect.ignore,
              )
            : Effect.void,
        ),
        Effect.mapError(toInternalError),
      );

    if (existingSecretKey !== null && existingSecretKey !== nextSecretKey) {
      yield* TeamGitHubRepository.removeTeamGitHubSecret(secrets, existingSecretKey).pipe(
        Effect.ignore,
      );
    }
    TeamGitHubOAuth.purgeTeamPendingGitHubOAuthFlows(githubOAuthFlowStore, team.id);

    const config = TeamGitHubRepository.stripGitHubAppClientSecretKey(stored, {
      includeUpdatedBy: true,
    });
    yield* publish({
      version: 1,
      type: "githubAppConfigUpdated",
      payload: { config },
    });
    return config;
  });

  const clearGitHubAppConfig = Effect.fn("TeamService.clearGitHubAppConfig")(function* (input: {
    readonly sessionId: AuthSessionId;
  }) {
    const team = yield* requireWorkspace();
    const actor = yield* requireActiveMember(input.sessionId);
    if (actor.teamId !== team.id || !canManageTeamGitHubAppConfig(actor.role)) {
      return yield* new TeamOperationError({
        code: "forbidden",
        message: "Only owner and admin members can clear team GitHub OAuth / GitHub App settings.",
      });
    }
    const { githubRepo, secrets } = yield* requireGitHubDeps();
    const removedOpt = yield* githubRepo
      .deleteGitHubAppConfig(team.id)
      .pipe(Effect.mapError(toInternalError));
    if (Option.isSome(removedOpt) && removedOpt.value.clientSecretKey !== null) {
      yield* TeamGitHubRepository.removeTeamGitHubSecret(
        secrets,
        removedOpt.value.clientSecretKey,
      ).pipe(Effect.ignore);
    }
    TeamGitHubOAuth.purgeTeamPendingGitHubOAuthFlows(githubOAuthFlowStore, team.id);
    yield* publish({
      version: 1,
      type: "githubAppConfigUpdated",
      payload: { config: null },
    });
    return { cleared: Option.isSome(removedOpt) };
  });

  const startGitHubOAuth = Effect.fn("TeamService.startGitHubOAuth")(function* (input: {
    readonly sessionId: AuthSessionId;
    readonly payload: TeamStartGitHubOAuthInput;
  }) {
    const team = yield* requireWorkspace();
    const actor = yield* requireActiveMember(input.sessionId);
    if (actor.teamId !== team.id) {
      return yield* new TeamOperationError({
        code: "forbidden",
        message: "This session does not belong to the active team.",
      });
    }
    const { githubRepo } = yield* requireGitHubDeps();
    const configOpt = yield* githubRepo
      .getGitHubAppConfig(team.id)
      .pipe(Effect.mapError(toInternalError));
    if (Option.isNone(configOpt) || !configOpt.value.enabled) {
      return yield* new TeamOperationError({
        code: "github_oauth_not_configured",
        message: "GitHub OAuth / GitHub App sign-in is not enabled on this team server.",
      });
    }
    const explicitRedirectBase = input.payload.redirectBaseUrl?.trim() ?? "";
    let redirectBaseUrl = explicitRedirectBase;
    if (redirectBaseUrl.length === 0) {
      if (Option.isSome(serverConfigOption)) {
        const rawHost = serverConfigOption.value.host?.trim() ?? "127.0.0.1";
        const host =
          rawHost === "0.0.0.0" || rawHost === "::" || rawHost === "[::]" ? "127.0.0.1" : rawHost;
        const formattedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
        redirectBaseUrl = `http://${formattedHost}:${serverConfigOption.value.port}`;
      } else {
        return yield* new TeamOperationError({
          code: "invalid_input",
          message: "Missing Team Server base URL for GitHub OAuth callback.",
        });
      }
    }
    return yield* TeamGitHubOAuth.startBrowserOAuthFlow({
      store: githubOAuthFlowStore,
      teamId: team.id,
      memberId: actor.id,
      sessionId: input.sessionId,
      config: configOpt.value,
      redirectBaseUrl,
      githubNameOverride: input.payload.githubName ?? null,
      githubEmailOverride: input.payload.githubEmail ?? null,
    });
  });

  const exchangeAndPersistBrowserOAuth = Effect.fn("TeamService.exchangeAndPersistBrowserOAuth")(
    function* (input: {
      readonly pending: TeamGitHubOAuth.PendingBrowserOAuthState;
      readonly code: string;
    }) {
      const verifyStillAuthorized = assertOAuthFlowStillAuthorized({
        teamId: input.pending.teamId,
        memberId: input.pending.memberId,
        sessionId: input.pending.sessionId,
        mode: input.pending.mode,
        clientId: input.pending.clientId,
        webBaseUrl: input.pending.webBaseUrl,
        apiBaseUrl: input.pending.apiBaseUrl,
        memberGeneration: input.pending.memberGeneration,
        teamGeneration: input.pending.teamGeneration,
      });
      const currentConfig = yield* verifyStillAuthorized;
      const { secrets, httpClient } = yield* requireGitHubDeps();
      const clientSecret = currentConfig.clientSecretKey
        ? yield* TeamGitHubRepository.readTeamGitHubAppClientSecret(
            secrets,
            currentConfig.clientSecretKey,
          )
        : null;
      const tokenSet = yield* TeamGitHubOAuth.exchangeGitHubAuthorizationCode({
        httpClient,
        webBaseUrl: input.pending.webBaseUrl,
        clientId: input.pending.clientId,
        clientSecret,
        code: input.code,
        redirectUri: input.pending.redirectUri,
        codeVerifier: input.pending.codeVerifier,
      });
      return yield* persistMemberOAuthCredential({
        teamId: input.pending.teamId,
        memberId: input.pending.memberId,
        mode: input.pending.mode,
        clientId: input.pending.clientId,
        webBaseUrl: input.pending.webBaseUrl,
        apiBaseUrl: input.pending.apiBaseUrl,
        tokenSet,
        githubNameOverride: input.pending.githubNameOverride,
        githubEmailOverride: input.pending.githubEmailOverride,
        verifyStillAuthorized,
      });
    },
  );

  const completeGitHubOAuthCallback = Effect.fn("TeamService.completeGitHubOAuthCallback")(
    function* (input: {
      readonly code?: string | null;
      readonly state?: string | null;
      readonly error?: string | null;
      readonly errorDescription?: string | null;
      readonly callbackSessionId: AuthSessionId | null;
    }) {
      const pending = yield* TeamGitHubOAuth.consumePendingBrowserOAuthState(
        githubOAuthFlowStore,
        input.state,
      );
      if (input.error && input.error.trim().length > 0) {
        return yield* new TeamOperationError({
          code: "github_oauth_failed",
          message:
            input.errorDescription?.trim() ||
            `GitHub authorization failed (${input.error.trim()}).`,
        });
      }
      const code = input.code?.trim() ?? "";
      if (code.length === 0) {
        return yield* new TeamOperationError({
          code: "github_oauth_failed",
          message: "Missing GitHub OAuth authorization code.",
        });
      }
      yield* assertOAuthFlowStillAuthorized({
        teamId: pending.teamId,
        memberId: pending.memberId,
        sessionId: pending.sessionId,
        mode: pending.mode,
        clientId: pending.clientId,
        webBaseUrl: pending.webBaseUrl,
        apiBaseUrl: pending.apiBaseUrl,
        memberGeneration: pending.memberGeneration,
        teamGeneration: pending.teamGeneration,
      });

      // Prevent cross-user OAuth login CSRF: reject callbacks from a different authenticated browser
      // session, and require explicit authenticated confirmation when no matching browser cookie is present.
      if (input.callbackSessionId !== null && input.callbackSessionId !== pending.sessionId) {
        return yield* new TeamOperationError({
          code: "forbidden",
          message:
            "GitHub OAuth callback session does not match the member session that started sign-in.",
        });
      }
      if (input.callbackSessionId === null) {
        const { confirmationCode } = yield* TeamGitHubOAuth.createPendingBrowserOAuthConfirmation({
          store: githubOAuthFlowStore,
          pending,
          authorizationCode: code,
        });
        return {
          status: "confirmation_required" as const,
          confirmationCode,
        };
      }

      const identity = yield* exchangeAndPersistBrowserOAuth({ pending, code });
      return {
        status: "connected" as const,
        identity,
        mode: pending.mode,
      };
    },
  );

  const completeGitHubOAuth = Effect.fn("TeamService.completeGitHubOAuth")(function* (input: {
    readonly sessionId: AuthSessionId;
    readonly payload: TeamCompleteGitHubOAuthInput;
  }) {
    const team = yield* requireWorkspace();
    const actor = yield* requireActiveMember(input.sessionId);
    if (actor.teamId !== team.id) {
      return yield* new TeamOperationError({
        code: "forbidden",
        message: "This session does not belong to the active team.",
      });
    }
    const confirmed = yield* TeamGitHubOAuth.consumePendingBrowserOAuthConfirmation({
      store: githubOAuthFlowStore,
      state: input.payload.state,
      confirmationCode: input.payload.confirmationCode,
      teamId: team.id,
      memberId: actor.id,
      sessionId: input.sessionId,
    });
    return yield* exchangeAndPersistBrowserOAuth({
      pending: confirmed.pending,
      code: confirmed.authorizationCode,
    });
  });

  const startGitHubDeviceFlow = Effect.fn("TeamService.startGitHubDeviceFlow")(function* (input: {
    readonly sessionId: AuthSessionId;
    readonly payload: TeamStartGitHubDeviceFlowInput;
  }) {
    const team = yield* requireWorkspace();
    const actor = yield* requireActiveMember(input.sessionId);
    if (actor.teamId !== team.id) {
      return yield* new TeamOperationError({
        code: "forbidden",
        message: "This session does not belong to the active team.",
      });
    }
    const { githubRepo, httpClient } = yield* requireGitHubDeps();
    const configOpt = yield* githubRepo
      .getGitHubAppConfig(team.id)
      .pipe(Effect.mapError(toInternalError));
    if (Option.isNone(configOpt) || !configOpt.value.enabled) {
      return yield* new TeamOperationError({
        code: "github_oauth_not_configured",
        message: "GitHub OAuth / GitHub App sign-in is not enabled on this team server.",
      });
    }
    return yield* TeamGitHubOAuth.startDeviceAuthorizationFlow({
      store: githubOAuthFlowStore,
      httpClient,
      teamId: team.id,
      memberId: actor.id,
      sessionId: input.sessionId,
      config: configOpt.value,
      githubNameOverride: input.payload.githubName ?? null,
      githubEmailOverride: input.payload.githubEmail ?? null,
    });
  });

  const pollGitHubDeviceFlow = Effect.fn("TeamService.pollGitHubDeviceFlow")(function* (input: {
    readonly sessionId: AuthSessionId;
    readonly payload: TeamPollGitHubDeviceFlowInput;
  }) {
    const team = yield* requireWorkspace();
    const actor = yield* requireActiveMember(input.sessionId);
    if (actor.teamId !== team.id) {
      return yield* new TeamOperationError({
        code: "forbidden",
        message: "This session does not belong to the active team.",
      });
    }
    const { githubRepo, httpClient } = yield* requireGitHubDeps();
    const configOpt = yield* githubRepo
      .getGitHubAppConfig(team.id)
      .pipe(Effect.mapError(toInternalError));
    const outcome = yield* TeamGitHubOAuth.pollDeviceAuthorizationFlow({
      store: githubOAuthFlowStore,
      httpClient,
      teamId: team.id,
      memberId: actor.id,
      sessionId: input.sessionId,
      deviceFlowId: input.payload.deviceFlowId,
      currentConfig: Option.getOrNull(configOpt),
    });
    if (outcome.kind === "result") {
      return outcome.result;
    }
    const identity = yield* persistMemberOAuthCredential({
      teamId: team.id,
      memberId: actor.id,
      mode: outcome.flow.mode,
      clientId: outcome.flow.clientId,
      webBaseUrl: outcome.flow.webBaseUrl,
      apiBaseUrl: outcome.flow.apiBaseUrl,
      tokenSet: outcome.tokenSet,
      githubNameOverride: outcome.flow.githubNameOverride,
      githubEmailOverride: outcome.flow.githubEmailOverride,
      verifyStillAuthorized: assertOAuthFlowStillAuthorized({
        teamId: outcome.flow.teamId,
        memberId: outcome.flow.memberId,
        sessionId: outcome.flow.sessionId,
        mode: outcome.flow.mode,
        clientId: outcome.flow.clientId,
        webBaseUrl: outcome.flow.webBaseUrl,
        apiBaseUrl: outcome.flow.apiBaseUrl,
        memberGeneration: outcome.flow.memberGeneration,
        teamGeneration: outcome.flow.teamGeneration,
        isCancelled: () => outcome.flow.cancelled,
      }),
      onCommitted: () => {
        githubOAuthFlowStore.deviceFlows.delete(outcome.flow.deviceFlowId);
      },
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          githubOAuthFlowStore.deviceFlows.delete(outcome.flow.deviceFlowId);
        }),
      ),
    );
    return {
      status: "completed" as const,
      intervalSeconds: PositiveInt.make(outcome.flow.intervalSeconds),
      identity,
    } satisfies TeamPollGitHubDeviceFlowResult;
  });

  const cancelGitHubDeviceFlow = Effect.fn("TeamService.cancelGitHubDeviceFlow")(function* (input: {
    readonly sessionId: AuthSessionId;
    readonly payload: TeamCancelGitHubDeviceFlowInput;
  }) {
    const team = yield* requireWorkspace();
    const actor = yield* requireActiveMember(input.sessionId);
    if (actor.teamId !== team.id) {
      return yield* new TeamOperationError({
        code: "forbidden",
        message: "This session does not belong to the active team.",
      });
    }
    return yield* TeamGitHubOAuth.withMemberGitHubCredentialMutationLock(
      team.id,
      actor.id,
      Effect.sync(() => {
        const flow = githubOAuthFlowStore.deviceFlows.get(input.payload.deviceFlowId);
        if (
          flow !== undefined &&
          flow.teamId === team.id &&
          flow.memberId === actor.id &&
          flow.sessionId === input.sessionId
        ) {
          flow.cancelled = true;
          githubOAuthFlowStore.deviceFlows.delete(input.payload.deviceFlowId);
          return { cancelled: true };
        }
        return { cancelled: false };
      }),
    );
  });

  const publishMemberGitHubIdentityUpdate = Effect.fn(
    "TeamService.publishMemberGitHubIdentityUpdate",
  )(function* (input: {
    readonly memberId: TeamMemberId;
    readonly identity: TeamGitHubIdentity | null;
  }) {
    yield* publish({
      version: 1,
      type: "myGitHubIdentityUpdated",
      payload: { memberId: input.memberId, identity: input.identity },
    });
  });

  return TeamService.of({
    isTeamConfigured,
    getState,
    streamState,
    subscribeAccessChanges,
    openAccessChangeSubscription,
    initializeTeam,
    leaveTeam,
    deleteTeam,
    updateDisplayName,
    updateMyPseudo,
    updateMemberRole,
    updateMemberStatus,
    createInvite,
    revokeInvite,
    previewInvite,
    redeemInvite,
    createView,
    updateView,
    deleteView,
    setThreadView,
    setThreadLocked,
    listThreadAttributions,
    canReadThread,
    assertCanReadThread,
    canReadAttachment,
    assertCanReadAttachment,
    filterReadableThreadIds,
    canPostInThread,
    assertCanPostInThread,
    assertCanLaunchThread,
    assertCanDispatchCommand,
    assertAndNormalizeDispatchCommand,
    assertCanInterruptThread,
    assertCanPromoteQueuedRun,
    assertCanCreateGuestShare,
    assertCanUseWorkflows,
    assertCanUseScheduledTasks,
    getScheduledTaskMeta,
    filterReadableScheduledTasksForActor,
    filterReadableScheduledTasks,
    assertActorCanReadScheduledTask,
    assertCanReadScheduledTask,
    assertActorCanReadScheduledTaskWebhooks,
    assertCanReadScheduledTaskWebhooks,
    authorizeScheduledTaskUpsertForActor,
    authorizeScheduledTaskUpsert,
    persistScheduledTaskMeta,
    withScheduledTaskWorkspaceGate: withMembershipMutationGate,
    publishScheduledTaskMeta,
    saveScheduledTaskMeta,
    deleteScheduledTaskMeta,
    assertActorCanMutateScheduledTask,
    assertCanMutateScheduledTask,
    followThread,
    unfollowThread,
    listFollowedThreads,
    shouldNotifyMemberForThread,
    listNotificationRecipientsForThread,
    shouldPublishRelayNotificationForThread,
    shouldPublishRelayQueuedMessageNotification,
    bindRelayRecipientForSession,
    clearRelayRecipientBinding,
    subscribeNotificationEvents,
    recordThreadCreated,
    prepareThreadAttribution,
    prepareThreadInheritedFromParent,
    prepareTeamAutomationThreadAttribution,
    publishTeamAutomationThreadAttributed,
    recordTeamAutomationTurn,
    requireTeamAutomationTurn,
    rollbackPreparedThreadAttribution,
    rollbackRecordedTurnAttribution,
    recordTurnAuthored,
    recordTurnAuthoredByMember,
    requireTurnAuthoredBySession,
    requireTurnAuthoredByMember,
    prepareTurnAttributionForCommand,
    prepareThreadAttributionForMember,
    recordThreadCreatedByMember,
    recordThreadInheritedFromParent,
    getThreadAttribution,
    resolveMemberIdForSession,
    resolveTurnPrincipal,
    resolveTurnAuthorMemberId,
    assertActorIsActiveMember,
    canActorReadThread,
    assertActorCanReadThread,
    filterReadableThreadIdsForActor,
    canActorPostInThread,
    assertActorCanPostInThread,
    assertActorCanCreateThreadInView,
    canActorSteerActiveTurn,
    assertActorCanSteerActiveTurn,
    assertActorCanPromoteQueuedRun,
    assertActorCanInterruptThread,
    assertActorCanRespondToRuntimeRequest,
    assertActorCanManageQueuedRun,
    assertActorCanUseWorkflows,
    assertActorCanUseScheduledTasks,
    assertActorIsAdmin,
    registerTurnInterruptHook,
    registerGitHubCredentialChangeHook,
    notifyTurnInterrupted,
    notifyQueuedMessage,
    assignProject,
    unassignProject,
    attachEnvironment,
    updateEnvironment,
    detachEnvironment,
    getRemotePairingSubject,
    assertCanAccessLocalEnvironment,
    unlinkRemoteEnvironment,
    pairRemoteEnvironmentForSession,
    drainPendingRemoteRevocations,
    canActorAccessEnvironment,
    assertActorCanAccessEnvironment,
    assertCanAccessEnvironment,
    filterAccessibleEnvironmentIdsForActor,
    filterAccessibleEnvironmentIds,
    assertActorCanExecuteOnThreadEnvironment,
    assertCanExecuteOnThreadEnvironment,
    syncLocalThread,
    createThreadNote,
    deleteThreadNote,
    resolveThreadNote,
    editThreadNote,
    reserveAcceptedNotes,
    releaseAcceptedNotes,
    consumeAcceptedNotes,
    listThreadNotes,
    prepareNotesForDispatchCommand,
    releaseNoteReservationByToken,
    verifyAcceptedNotesForDispatch,
    finalizeNotesForDispatchedTurn,
    upsertProvider,
    deleteProvider,
    listProviderUsage,
    upsertSkill,
    deleteSkill,
    upsertPreprompt,
    deletePreprompt,
    issueLocalSyncToken,
    assertCanManageServerProviders,
    assertLocalBindingHostAllowed,
    updateMyMobileVisibility,
    assertCanCreateStandardPairingLink,
    bindPairingLinkToSessionMember,
    createMobilePairingLink,
    listMyMobilePairingLinks,
    revokeMyMobilePairingLink,
    markPairingLinkRevoked,
    getThreadTitlePrefixContextMap,
    formatUpstreamCompatThreadTitle,
    filterVisibleShellThreadIds,
    canShowThreadInShell,
    shouldRefreshShellForAccessChange,
    connectMyGitHub,
    disconnectMyGitHub,
    setAutomationGitHub,
    clearAutomationGitHub,
    setGitHubAppConfig,
    clearGitHubAppConfig,
    startGitHubOAuth,
    completeGitHubOAuthCallback,
    completeGitHubOAuth,
    startGitHubDeviceFlow,
    pollGitHubDeviceFlow,
    cancelGitHubDeviceFlow,
    publishMemberGitHubIdentityUpdate,
  });
});

export const layer = Layer.effect(TeamService, make);
