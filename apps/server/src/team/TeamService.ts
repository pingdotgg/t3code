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
  AuthRelayWriteScope,
  AuthStandardClientScopes,
  canAssignTeamRole,
  canChangeTeamMemberRole,
  canChangeThreadTeamView,
  canManageTeamEnvironments,
  canManageTeamInvites,
  canManageTeamMembers,
  canManageTeamProjects,
  canManageTeamViews,
  canMemberAccessTeamEnvironment,
  canMemberCreateThreadInTeamView,
  canMemberInterruptTeamTurn,
  canMemberLeaveTeamThreadNote,
  canMemberManageTeamQueuedRun,
  canMemberPromoteTeamQueuedRun,
  canMemberReadTeamThread,
  canMemberReadTeamView,
  canMemberSteerActiveTeamTurn,
  canModifyTeamMember,
  canToggleTeamThreadLock,
  effectiveTeamThreadNoteHash,
  EnvironmentAuthorizationError,
  EnvironmentId,
  formatAcceptedTeamNoteForPrompt,
  isValidTeamPseudo,
  normalizeTeamPseudo,
  resolveTeamThreadEnvironmentAccess,
  resolveTeamThreadPostBlockReason,
  shouldNotifyTeamMemberForThread,
  TEAM_ROLE_RANK,
  TeamEnvironmentRecordId,
  TeamId,
  TeamInviteId,
  TeamMemberId,
  TeamOperationError,
  TeamThreadNoteId,
  TeamViewId,
  type AuthClientMetadata,
  type AuthEnvironmentScope,
  type AuthSessionId,
  type OrchestrationV2Command,
  type ProjectId,
  type TeamAcceptedNoteRef,
  type TeamAccessRule,
  type TeamAssignProjectInput,
  type TeamAttachEnvironmentInput,
  type TeamConsumeAcceptedNotesInput,
  type TeamConsumeAcceptedNotesResult,
  type TeamCreateInviteInput,
  type TeamCreateThreadNoteInput,
  type TeamCreateViewInput,
  type TeamDeleteThreadNoteInput,
  type TeamDeleteThreadNoteResult,
  type TeamDeleteViewInput,
  type TeamDeleteViewResult,
  type TeamDetachEnvironmentInput,
  type TeamDetachEnvironmentResult,
  type TeamEditThreadNoteInput,
  type TeamEnvironment,
  type TeamInitializeInput,
  type TeamInitializeResult,
  type TeamInvite,
  type TeamInviteCreatedResult,
  type TeamInvitePreviewResult,
  type TeamListThreadNotesInput,
  type TeamMember,
  type TeamProjectAssignment,
  type TeamPseudo,
  type TeamRedeemInviteResponse,
  type TeamResolveThreadNoteInput,
  type TeamRevokeInviteInput,
  type TeamRevokeInviteResult,
  type TeamRole,
  type TeamSetThreadLockedInput,
  type TeamSetThreadViewInput,
  type TeamStateSnapshot,
  type TeamStateStreamEvent,
  type TeamSyncLocalThreadInput,
  type TeamSyncLocalThreadResult,
  type TeamThreadAttribution,
  type TeamThreadFollowInput,
  type TeamThreadFollowResult,
  type TeamThreadNote,
  type TeamTurnAttribution,
  type TeamUnassignProjectInput,
  type TeamUnassignProjectResult,
  type TeamUpdateEnvironmentInput,
  type TeamUpdateMemberRoleInput,
  type TeamUpdateMemberStatusInput,
  type TeamUpdateMyPseudoInput,
  type TeamUpdateViewInput,
  type TeamView,
  type TeamWorkspace,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import {
  PENDING_ATTACHMENT_THREAD_SEGMENT,
  parseThreadSegmentFromAttachmentId,
} from "../attachmentStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import type * as EventSink from "../orchestration-v2/EventSink.ts";
import type * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import type * as PeerLinks from "../peer/PeerLinks.ts";
import type * as ProjectService from "../project/ProjectService.ts";
import { rpcInitialItems } from "../rpcInitialItems.ts";
import { mirrorLocalThreadSnapshotToEventSink } from "./TeamLocalSyncService.ts";
import * as TeamRepository from "./TeamRepository.ts";

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
  | { readonly type: "relayBinding" };

export type TeamAccessChangeEvent =
  | { readonly type: "workspace" }
  | { readonly type: "view"; readonly viewId: TeamViewId }
  | { readonly type: "member"; readonly memberId: TeamMemberId }
  | { readonly type: "threadView"; readonly threadId: ThreadId }
  | { readonly type: "environment"; readonly environmentId: EnvironmentId };

export type TeamActor =
  | { readonly kind: "session"; readonly sessionId: AuthSessionId }
  | { readonly kind: "member"; readonly memberId: TeamMemberId | null };

export interface TeamTurnInterruptEvent {
  readonly threadId: ThreadId;
  readonly runId: string | null;
  readonly actorMemberId: TeamMemberId;
  readonly activeTurnAuthorMemberId: TeamMemberId | null;
  readonly reason: "interrupt" | "stop" | "force_stop" | "mcp_interrupt" | "promote_to_steer";
}

export type TeamTurnInterruptHook = (event: TeamTurnInterruptEvent) => Effect.Effect<void>;

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
    readonly updateMyPseudo: (input: {
      readonly sessionId: AuthSessionId;
      readonly payload: TeamUpdateMyPseudoInput;
    }) => Effect.Effect<TeamMember, TeamOperationError>;
    readonly updateMemberRole: (input: {
      readonly sessionId: AuthSessionId;
      readonly payload: TeamUpdateMemberRoleInput;
    }) => Effect.Effect<TeamMember, TeamOperationError>;
    readonly updateMemberStatus: (input: {
      readonly sessionId: AuthSessionId;
      readonly payload: TeamUpdateMemberStatusInput;
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
    }) => Effect.Effect<boolean, EnvironmentAuthorizationError>;
    readonly rollbackPreparedThreadAttribution: (threadId: ThreadId) => Effect.Effect<void>;
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
    }) => Effect.Effect<void>;
    readonly getThreadAttribution: (
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<TeamThreadAttribution>>;
    readonly resolveMemberIdForSession: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<Option.Option<TeamMemberId>>;
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
    readonly notifyTurnInterrupted: (input: {
      readonly actor: TeamActor;
      readonly threadId: ThreadId;
      readonly runId?: string | null;
      readonly reason: TeamTurnInterruptEvent["reason"];
    }) => Effect.Effect<void>;
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
    }) => Effect.Effect<TeamEnvironment, TeamOperationError>;
    readonly detachEnvironment: (input: {
      readonly sessionId: AuthSessionId;
      readonly payload: TeamDetachEnvironmentInput;
      readonly peerLinks?: PeerLinks.PeerLinks["Service"];
    }) => Effect.Effect<TeamDetachEnvironmentResult, TeamOperationError>;
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
    ) => Effect.Effect<void, EnvironmentAuthorizationError>;
    readonly assertCanExecuteOnThreadEnvironment: (
      sessionId: AuthSessionId,
      threadId: ThreadId,
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
    readonly consumeAcceptedNotes: (input: {
      readonly sessionId: AuthSessionId;
      readonly payload: TeamConsumeAcceptedNotesInput;
    }) => Effect.Effect<TeamConsumeAcceptedNotesResult, TeamOperationError>;
    readonly listThreadNotes: (input: {
      readonly sessionId: AuthSessionId;
      readonly payload: TeamListThreadNotesInput;
    }) => Effect.Effect<ReadonlyArray<TeamThreadNote>, TeamOperationError>;
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
    }) => Effect.Effect<void>;
  }
>()("t3/team/TeamService") {}

const make = Effect.gen(function* () {
  const repository = yield* TeamRepository.TeamRepository;
  const sessionStore = yield* SessionStore.SessionStore;
  const random = yield* SecureRandom.SecureRandom;
  const serverEnvironmentOption = yield* Effect.serviceOption(ServerEnvironment.ServerEnvironment);
  const eventsPubSub = yield* PubSub.unbounded<TeamStateStreamEvent>();
  const notificationTriggersPubSub = yield* PubSub.unbounded<TeamNotificationTriggerEvent>();
  const accessChangesPubSub = yield* PubSub.unbounded<TeamAccessChangeEvent>();
  const turnInterruptHooks = new Set<TeamTurnInterruptHook>();

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
    ] = yield* Effect.all([
      repository.getMemberForSession(sessionId).pipe(Effect.mapError(toInternalError)),
      repository.listMembers(team.id).pipe(Effect.mapError(toInternalError)),
      repository.listViews(team.id).pipe(Effect.mapError(toInternalError)),
      repository.listThreadAttributions(team.id).pipe(Effect.mapError(toInternalError)),
      repository.listLatestTurnAttributions(team.id).pipe(Effect.mapError(toInternalError)),
      repository.listProjectAssignments(team.id).pipe(Effect.mapError(toInternalError)),
      repository.listEnvironments(team.id).pipe(Effect.mapError(toInternalError)),
      repository.listThreadNotes({ teamId: team.id }).pipe(Effect.mapError(toInternalError)),
    ]);
    const allEnvironments =
      rawEnvironments.length > 0 ? rawEnvironments : [yield* ensureDefaultEnvironmentForTeam(team)];
    const currentMember = Option.getOrNull(currentMemberOption);
    const viewById = new Map(allViews.map((view) => [view.id, view] as const));
    const defaultView = viewById.get(team.defaultViewId) ?? null;

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

    const [invites, rawFollowedThreadIds] = yield* Effect.all([
      currentMember !== null &&
      currentMember.status === "active" &&
      canManageTeamInvites(currentMember.role)
        ? repository.listInvites(team.id).pipe(Effect.mapError(toInternalError))
        : Effect.succeed<ReadonlyArray<TeamInvite>>([]),
      currentMember !== null && currentMember.status === "active"
        ? repository.listFollowedThreadIds(currentMember.id).pipe(Effect.mapError(toInternalError))
        : Effect.succeed<ReadonlyArray<ThreadId>>([]),
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
        const liveEvents = Stream.fromSubscription(subscription).pipe(
          Stream.mapEffect((event) =>
            Effect.gen(function* () {
              if (
                event.type === "teamUpdated" ||
                event.type === "viewUpserted" ||
                event.type === "viewDeleted" ||
                event.type === "environmentUpserted" ||
                event.type === "environmentRemoved"
              ) {
                const fresh = yield* getState(sessionId);
                currentMember = fresh.currentMember;
                knownReadableThreadIds = new Set<ThreadId>(
                  fresh.threadAttributions.map((attribution) => attribution.threadId),
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

    const team: TeamWorkspace = {
      id: teamId,
      name: input.payload.name.trim(),
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

    const defaultEnvironment = yield* ensureDefaultEnvironmentForTeam(team);

    yield* publish({ version: 1, type: "teamUpdated", payload: team });
    yield* publish({ version: 1, type: "memberUpserted", payload: owner });
    yield* publish({ version: 1, type: "environmentUpserted", payload: defaultEnvironment });
    yield* publishAccessChange({ type: "workspace" });

    return { team, owner } satisfies TeamInitializeResult;
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
      const nextScopes = scopesForTeamRole(nextRole);
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
        (memberSessionId) =>
          sessionStore.updateScopes(memberSessionId, nextScopes).pipe(
            Effect.tapError((cause) =>
              Effect.logWarning("TeamService.reconcileMemberSessionScopes update failed", {
                memberId,
                memberSessionId,
                cause,
              }),
            ),
            Effect.ignore,
          ),
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
      const validIds = new Set(members.map((member) => member.id));
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
    const { previousRole, member: updatedMember } = updated.value;
    const prevIsAdminTier = previousRole === "owner" || previousRole === "admin";
    const nextIsAdminTier = updatedMember.role === "owner" || updatedMember.role === "admin";
    if (prevIsAdminTier !== nextIsAdminTier) {
      yield* reconcileMemberSessionScopes(updatedMember.id, updatedMember.role);
    }
    yield* publish({ version: 1, type: "memberUpserted", payload: updatedMember });
    yield* publishAccessChange({ type: "member", memberId: updatedMember.id });
    return updatedMember;
  });

  const updateMemberStatus = Effect.fn("TeamService.updateMemberStatus")(function* (input: {
    readonly sessionId: AuthSessionId;
    readonly payload: TeamUpdateMemberStatusInput;
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
    if (updated.value.status !== "active") {
      yield* revokeSessionsForMember(updated.value.id);
    }
    yield* publish({ version: 1, type: "memberUpserted", payload: updated.value });
    yield* publishAccessChange({ type: "member", memberId: updated.value.id });
    return updated.value;
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
    yield* validateAccessRuleMemberIds(team.id, [readRule, postRule]);
    const nowIso = DateTime.formatIso(yield* DateTime.now);
    const viewId = TeamViewId.make(
      `view_${yield* random.uuidV4().pipe(Effect.mapError(toInternalError))}`,
    );
    const view: TeamView = {
      id: viewId,
      teamId: team.id,
      name,
      description,
      isDefault: false,
      readRule,
      postRule,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    yield* repository.createView(view).pipe(
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
    yield* validateAccessRuleMemberIds(team.id, [nextReadRule, nextPostRule]);
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    const updated = yield* repository
      .updateView({
        teamId: team.id,
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
  });

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
  });

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

  const resolveMemberForActor = Effect.fn("TeamService.resolveMemberForActor")(function* (
    actor: TeamActor,
  ) {
    if (actor.kind === "session") {
      return yield* repository.getMemberForSession(actor.sessionId);
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

  const resolveTurnAuthorMemberId = Effect.fn("TeamService.resolveTurnAuthorMemberId")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly runId?: string | null;
      readonly userMessageId?: string | null;
      readonly continuedFromRunId?: string | null;
    }) {
      return yield* Effect.gen(function* () {
        const workspaceOption = yield* repository.getWorkspace();
        if (Option.isNone(workspaceOption)) return Option.none<TeamMemberId>();
        const resolveByRunOrMessage = Effect.fnUntraced(function* (
          candidateRunId: string | null,
          candidateMessageId: string | null,
        ) {
          if (candidateRunId !== null) {
            const byRun = yield* repository.getTurnAttribution(candidateRunId);
            if (Option.isSome(byRun) && byRun.value.threadId === input.threadId) {
              return Option.some(byRun.value.authorMemberId);
            }
          }
          let messageId = candidateMessageId;
          if (messageId === null && candidateRunId !== null) {
            const runRecord = yield* repository
              .getRunInProjection(input.threadId, candidateRunId)
              .pipe(Effect.orElseSucceed(() => Option.none()));
            if (Option.isSome(runRecord)) {
              messageId = runRecord.value.userMessageId;
            }
          }
          if (messageId !== null) {
            const byMessage = yield* repository.getTurnAttribution(`msg:${messageId}`);
            if (Option.isSome(byMessage) && byMessage.value.threadId === input.threadId) {
              return Option.some(byMessage.value.authorMemberId);
            }
          }
          return Option.none<TeamMemberId>();
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
        // Fail closed: never escalate missing turn attribution to the thread creator's privileges.
        return Option.none<TeamMemberId>();
      }).pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("TeamService.resolveTurnAuthorMemberId failed", {
            threadId: input.threadId,
            runId: input.runId,
            cause,
          }),
        ),
        Effect.orElseSucceed(() => Option.none<TeamMemberId>()),
      );
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

  const canActorReadThread = Effect.fn("TeamService.canActorReadThread")(function* (
    actor: TeamActor,
    threadId: ThreadId,
  ) {
    return yield* resolveThreadAccessContextForActor(actor, threadId).pipe(
      Effect.map((ctx) => {
        if (ctx.kind === "personal") return true;
        if (ctx.kind === "wrong_team") return false;
        if (ctx.kind === "unattributed") {
          if (!ctx.member || ctx.member.status !== "active") return false;
          // Post-team unattributed threads fail closed for non-admin members; pre-team legacy threads stay readable.
          return ctx.isLegacyPreTeam || isTeamAdminOrOwner(ctx.member);
        }
        return canMemberReadTeamThread({ member: ctx.member, view: ctx.view });
      }),
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
          unattributedIds.length > 0 && !isTeamAdminOrOwner(member)
            ? yield* repository.listThreadCreatedAtInProjection(unattributedIds)
            : new Map<ThreadId, string>();
        const allowed = new Set<ThreadId>();
        for (const threadId of threadIds) {
          const attribution = attributionByThreadId.get(threadId);
          if (!attribution) {
            if (
              isTeamAdminOrOwner(member) ||
              isPreTeamLegacyTimestamp(team, createdAtByThreadId.get(threadId))
            ) {
              allowed.add(threadId);
            }
            continue;
          }
          const view = viewById.get(attribution.viewId) ?? defaultView;
          if (canMemberReadTeamThread({ member, view })) {
            allowed.add(threadId);
          }
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
    return yield* resolveThreadAccessContextForActor(actor, threadId).pipe(
      Effect.map((ctx) => {
        if (ctx.kind === "personal") return true;
        if (ctx.kind === "wrong_team") return false;
        if (ctx.kind === "unattributed") {
          if (!ctx.member || ctx.member.status !== "active") return false;
          return ctx.isLegacyPreTeam || isTeamAdminOrOwner(ctx.member);
        }
        return (
          resolveTeamThreadPostBlockReason({
            member: ctx.member,
            attribution: ctx.attribution,
            view: ctx.view,
          }) === "ok"
        );
      }),
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
      if (!ctx.member || ctx.member.status !== "active") {
        return yield* teamPostAuthError("This session is not bound to an active team member.");
      }
      if (!ctx.isLegacyPreTeam && !isTeamAdminOrOwner(ctx.member)) {
        return yield* teamPostAuthError();
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
      return yield* teamPostAuthError("This thread is locked. Only owners and admins can post.");
    }
    if (reason === "view_read_only") {
      return yield* teamPostAuthError(
        "You have read-only access to this view and cannot post in colleagues' threads.",
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
    return yield* resolveThreadAccessContextForActor(actor, threadId).pipe(
      Effect.map((ctx) => {
        if (ctx.kind === "personal") return true;
        if (ctx.kind === "wrong_team") return false;
        if (ctx.kind === "unattributed") {
          if (!ctx.member || ctx.member.status !== "active") return false;
          return ctx.isLegacyPreTeam || isTeamAdminOrOwner(ctx.member);
        }
        return canMemberSteerActiveTeamTurn({
          member: ctx.member,
          attribution: ctx.attribution,
          view: ctx.view,
        });
      }),
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
        if (!ctx.member || ctx.member.status !== "active") {
          return yield* teamPostAuthError("This session is not bound to an active team member.");
        }
        if (!ctx.isLegacyPreTeam && !isTeamAdminOrOwner(ctx.member)) {
          return yield* teamPostAuthError("Only the thread creator can send a queued message now.");
        }
        return;
      }
      if (
        !canMemberPromoteTeamQueuedRun({
          member: ctx.member,
          attribution: ctx.attribution,
          view: ctx.view,
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
          "Only the thread creator, active turn author, admins, or owners can interrupt this turn.",
        );
      }
    },
  );

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

  const assertActorCanUseScheduledTasks = (actor: TeamActor) =>
    assertActorIsAdmin(
      actor,
      "Only owner and admin members can manage team scheduled tasks.",
      "team:scheduled_tasks",
    );

  const assertCanUseScheduledTasks = (sessionId: AuthSessionId) =>
    assertActorCanUseScheduledTasks(sessionActor(sessionId));

  const assertActorCanCreateThreadInView = Effect.fn(
    "TeamService.assertActorCanCreateThreadInView",
  )(function* (input: {
    readonly actor: TeamActor;
    readonly viewId?: TeamViewId;
    readonly locked?: boolean;
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
    if (input.locked === true && !canToggleTeamThreadLock(member.role)) {
      return yield* teamPostAuthError("Only owner and admin members can create locked threads.");
    }
    const targetViewId = input.viewId ?? team.defaultViewId;
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
    const workspaceOption = yield* repository
      .getWorkspace()
      .pipe(Effect.orElseSucceed(() => Option.none<TeamWorkspace>()));
    if (Option.isSome(workspaceOption)) {
      const localEnv = yield* resolveLocalEnvironmentIdentity();
      yield* assertActorCanAccessEnvironment(sessionActor(input.sessionId), localEnv.environmentId);
    }
    let resolvedViewId = input.viewId;
    if (resolvedViewId === undefined && input.projectId !== undefined) {
      const projectAssignment = yield* repository
        .getProjectAssignment(input.projectId)
        .pipe(Effect.orElseSucceed(() => Option.none<TeamProjectAssignment>()));
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
  ): Effect.fn.Return<OrchestrationV2Command, EnvironmentAuthorizationError> {
    if (!(yield* isTeamConfigured())) {
      return command;
    }
    const actor = sessionActor(sessionId);
    switch (command.type) {
      case "thread.create":
        yield* assertActorCanCreateThreadInView({ actor });
        return command;
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
        yield* assertActorCanReadThread(actor, command.sourceThreadId);
        const inheritedViewId =
          sourceCtx.kind === "team_thread" ? sourceCtx.attribution.viewId : undefined;
        yield* assertActorCanCreateThreadInView({
          actor,
          ...(inheritedViewId !== undefined ? { viewId: inheritedViewId } : {}),
        });
        return command;
      }
      case "thread.merge_back":
        yield* assertActorCanReadThread(actor, command.sourceThreadId);
        yield* assertActorCanPostInThread(actor, command.targetThreadId);
        return command;
      case "message.dispatch": {
        yield* assertActorCanPostInThread(actor, command.threadId);
        yield* assertActorCanExecuteOnThreadEnvironment(actor, command.threadId);
        let effectiveCommand = command;
        if (command.teamAcceptedNotes !== undefined && command.teamAcceptedNotes.length > 0) {
          const formattedPrefix = yield* verifyAcceptedNotesForDispatch({
            sessionId,
            threadId: command.threadId,
            acceptedNotes: command.teamAcceptedNotes,
          });
          if (formattedPrefix.length > 0) {
            const trimmedPrompt = command.text.trim();
            effectiveCommand = {
              ...command,
              text:
                trimmedPrompt.length === 0
                  ? formattedPrefix
                  : `${formattedPrefix}\n\n${command.text}`,
            };
          }
        }
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
        yield* assertActorCanExecuteOnThreadEnvironment(actor, command.threadId);
        yield* assertActorCanPromoteQueuedRun(actor, command.threadId);
        return command;
      case "run.interrupt":
      case "subagent.stop":
        yield* assertActorCanExecuteOnThreadEnvironment(actor, command.threadId);
        yield* assertActorCanInterruptThread(actor, command.threadId, command.runId);
        return command;
      case "thread.stop":
        yield* assertActorCanExecuteOnThreadEnvironment(actor, command.threadId);
        yield* assertActorCanInterruptThread(actor, command.threadId);
        return command;
      case "runtime-request.respond":
      case "thread.user-input.dismiss":
        yield* assertActorCanExecuteOnThreadEnvironment(actor, command.threadId);
        yield* assertActorCanInterruptThread(actor, command.threadId);
        return command;
      case "queued-run.edit":
      case "queued-run.cancel":
      case "queued-run.reorder":
        yield* assertActorCanPostInThread(actor, command.threadId);
        yield* assertActorCanExecuteOnThreadEnvironment(actor, command.threadId);
        yield* assertActorCanManageQueuedRun(actor, command.threadId, command.runId);
        return command;
      case "delegated_task.request":
      case "delegated_task.wake-policy":
      case "delegated_task.completion-delivery.acknowledge":
      case "delegated_task.completion-delivery.dispose":
      case "thread.created.record":
        yield* assertActorCanPostInThread(actor, command.parentThreadId);
        yield* assertActorCanExecuteOnThreadEnvironment(actor, command.parentThreadId);
        return command;
      default:
        yield* assertActorCanPostInThread(actor, command.threadId);
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
      creatorMemberId: attributionOption.value.creatorMemberId,
      isFollowing,
      activeTurnAuthorMemberId,
    });
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
  }) {
    return yield* Effect.gen(function* () {
      const workspaceOption = yield* repository.getWorkspace();
      if (Option.isNone(workspaceOption)) return false;
      const team = workspaceOption.value;
      const existing = yield* repository.getThreadAttribution(input.threadId);
      if (Option.isSome(existing)) return false;
      const parentAttribution = yield* repository.getThreadAttribution(input.parentThreadId);
      let creatorMemberId: TeamMemberId | null = null;
      let viewId = team.defaultViewId;
      if (Option.isSome(parentAttribution) && parentAttribution.value.teamId === team.id) {
        creatorMemberId = parentAttribution.value.creatorMemberId;
        viewId = parentAttribution.value.viewId;
      }
      if (input.creatorMemberId !== undefined) {
        const actorOption = yield* repository.getMemberById(input.creatorMemberId);
        if (
          Option.isNone(actorOption) ||
          actorOption.value.teamId !== team.id ||
          actorOption.value.status !== "active"
        ) {
          return yield* teamPostAuthError("This caller is not bound to an active team member.");
        }
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
        creatorMemberId = actorOption.value.id;
      }
      if (creatorMemberId === null) {
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
        creatorMemberId,
        viewId,
        createdAt: nowIso,
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

  const rollbackPreparedThreadAttribution = Effect.fn(
    "TeamService.rollbackPreparedThreadAttribution",
  )(function* (threadId: ThreadId) {
    yield* repository.deleteThreadAttribution(threadId).pipe(Effect.ignore);
  });

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
      const parentAttribution = yield* repository.getThreadAttribution(input.parentThreadId).pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("TeamService.recordThreadInheritedFromParent parent lookup failed", {
            parentThreadId: input.parentThreadId,
            cause,
          }),
        ),
        Effect.orElseSucceed(() => Option.none<TeamThreadAttribution>()),
      );
      let inheritedCreatorMemberId: TeamMemberId;
      let inheritedCreatorPseudo: TeamPseudo;
      let inheritedViewId: TeamViewId;
      if (
        Option.isSome(parentAttribution) &&
        parentAttribution.value.teamId === workspaceOption.value.id
      ) {
        inheritedCreatorMemberId = parentAttribution.value.creatorMemberId;
        inheritedCreatorPseudo = parentAttribution.value.creatorPseudo;
        inheritedViewId = parentAttribution.value.viewId;
      } else {
        const parentCreatedAt = yield* repository
          .getThreadCreatedAtInProjection(input.parentThreadId)
          .pipe(Effect.orElseSucceed(() => Option.none<string>()));
        if (
          !isPreTeamLegacyTimestamp(workspaceOption.value, Option.getOrUndefined(parentCreatedAt))
        ) {
          return;
        }
        const members = yield* repository
          .listMembers(workspaceOption.value.id)
          .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<TeamMember>));
        const activeOwner = members.find(
          (member) => member.role === "owner" && member.status === "active",
        );
        if (!activeOwner) return;
        inheritedCreatorMemberId = activeOwner.id;
        inheritedCreatorPseudo = activeOwner.pseudo;
        inheritedViewId = workspaceOption.value.defaultViewId;
      }
      if (input.creatorMemberId !== undefined) {
        const explicitMember = yield* repository
          .getMemberById(input.creatorMemberId)
          .pipe(Effect.orElseSucceed(() => Option.none<TeamMember>()));
        if (
          Option.isNone(explicitMember) ||
          explicitMember.value.teamId !== workspaceOption.value.id ||
          explicitMember.value.status !== "active"
        ) {
          return;
        }
        inheritedCreatorMemberId = explicitMember.value.id;
        inheritedCreatorPseudo = explicitMember.value.pseudo;
      }
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      const attribution = yield* repository
        .recordThreadAttribution({
          threadId: input.threadId,
          teamId: workspaceOption.value.id,
          creatorMemberId: inheritedCreatorMemberId,
          viewId: inheritedViewId,
          createdAt: nowIso,
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
        const inserted = yield* repository
          .recordTurnAttribution({
            turnId: input.turnId,
            threadId: input.threadId,
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
              authorMemberId: inheritedCreatorMemberId,
              authorPseudo: inheritedCreatorPseudo,
              createdAt: nowIso,
            },
          });
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

    const accessRule = normalizeAccessRule(
      input.payload.accessRule ?? { roles: [...ALL_TEAM_ROLES], memberIds: [] },
    );
    yield* validateAccessRuleMemberIds(team.id, [accessRule]);
    const nowIso = DateTime.formatIso(yield* DateTime.now);
    const recordId = TeamEnvironmentRecordId.make(
      yield* random.uuidV4().pipe(Effect.mapError(toInternalError)),
    );
    const environment: TeamEnvironment = {
      id: recordId,
      teamId: team.id,
      environmentId,
      name: resolvedName && resolvedName.length > 0 ? resolvedName : environmentId,
      isDefault: false,
      peerLinkId,
      accessRule,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    yield* repository.createEnvironment(environment).pipe(
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
    yield* publish({ version: 1, type: "environmentUpserted", payload: environment });
    yield* publishAccessChange({ type: "environment", environmentId });
    return environment;
  });

  const updateEnvironment = Effect.fn("TeamService.updateEnvironment")(function* (input: {
    readonly sessionId: AuthSessionId;
    readonly payload: TeamUpdateEnvironmentInput;
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
    yield* validateAccessRuleMemberIds(team.id, [nextAccessRule]);
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    const updated = yield* repository
      .updateEnvironment({
        teamId: team.id,
        environmentId: input.payload.environmentId,
        ...(nextName !== undefined ? { name: nextName } : {}),
        ...(nextAccessRule !== undefined ? { accessRule: nextAccessRule } : {}),
        updatedAt,
      })
      .pipe(Effect.mapError(toInternalError));
    if (Option.isNone(updated)) {
      return yield* new TeamOperationError({
        code: "not_found",
        message: "Team environment could not be found.",
      });
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
      if (input.payload.unlinkPeer !== false && input.peerLinks !== undefined) {
        yield* input.peerLinks.unlink(input.payload.environmentId).pipe(Effect.ignore);
      }
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
  )(function* (actor: TeamActor, threadId: ThreadId) {
    const workspaceOption = yield* repository
      .getWorkspace()
      .pipe(Effect.orElseSucceed(() => Option.none<TeamWorkspace>()));
    if (Option.isNone(workspaceOption)) return;
    const team = workspaceOption.value;
    const [memberOption, attributionOption] = yield* Effect.all([
      resolveMemberForActor(actor).pipe(Effect.orElseSucceed(() => Option.none<TeamMember>())),
      repository
        .getThreadAttribution(threadId)
        .pipe(Effect.orElseSucceed(() => Option.none<TeamThreadAttribution>())),
    ]);
    const member =
      Option.isSome(memberOption) && memberOption.value.teamId === team.id
        ? memberOption.value
        : null;
    if (!member || member.status !== "active") {
      return yield* teamPostAuthError("This session is not bound to an active team member.");
    }
    if (Option.isNone(attributionOption)) {
      const localEnv = yield* resolveLocalEnvironmentIdentity();
      yield* assertActorCanAccessEnvironment(actor, localEnv.environmentId);
      return;
    }
    const attribution = attributionOption.value;
    if (attribution.isLocalSynced === true) {
      const label =
        attribution.executionEnvironmentLabel ?? `${attribution.creatorPseudo}'s local environment`;
      return yield* teamPostAuthError(
        `Cannot execute turns on "${label}". Local-environment threads run exclusively on their owner's machine; fork the thread or leave a note instead.`,
      );
    }
    yield* ensureDefaultEnvironmentForTeam(team).pipe(Effect.ignore);
    const environments = yield* repository
      .listEnvironments(team.id)
      .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<TeamEnvironment>));
    const access = resolveTeamThreadEnvironmentAccess({
      member,
      attribution,
      environments,
    });
    if (!access.canExecute) {
      return yield* teamPostAuthError(
        `You do not have permission to execute turns on environment "${access.environmentLabel}". Fork the thread or leave a note instead.`,
      );
    }
  });

  const assertCanExecuteOnThreadEnvironment = (sessionId: AuthSessionId, threadId: ThreadId) =>
    assertActorCanExecuteOnThreadEnvironment(sessionActor(sessionId), threadId);

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
    const resolvedViewId = yield* resolveDefaultViewIdForProject(
      team,
      input.payload.projectId,
      input.payload.viewId,
    );
    const viewOption = yield* repository
      .getViewById(resolvedViewId)
      .pipe(Effect.mapError(toInternalError));
    const view =
      Option.isSome(viewOption) && viewOption.value.teamId === team.id ? viewOption.value : null;
    const locked = input.payload.locked === true;
    if (!canMemberCreateThreadInTeamView(actor, view, locked)) {
      return yield* new TeamOperationError({
        code: "forbidden",
        message: "You do not have permission to sync a thread into this view.",
      });
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
    // Record turn attributions and relink any msg:<userMessageId> note anchors to canonical run IDs.
    for (const run of input.payload.runs) {
      const inserted = yield* repository
        .recordTurnAttribution({
          turnId: run.id,
          threadId: input.payload.threadId,
          authorMemberId: actor.id,
          createdAt: run.createdAt,
        })
        .pipe(Effect.orElseSucceed(() => false));
      if (inserted) {
        yield* publish({
          version: 1,
          type: "turnAttributed",
          payload: {
            turnId: run.id,
            threadId: input.payload.threadId,
            authorMemberId: actor.id,
            authorPseudo: actor.pseudo,
            createdAt: run.createdAt,
          },
        });
      }
      const relinked = yield* repository
        .relinkNoteTurnId({
          teamId: team.id,
          threadId: input.payload.threadId,
          fromTurnId: `msg:${run.userMessageId}`,
          toTurnId: run.id,
        })
        .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<TeamThreadNote>));
      for (const note of relinked) {
        yield* publish({ version: 1, type: "threadNoteUpserted", payload: note });
      }
    }
    yield* publish({
      version: 1,
      type: "threadAttributed",
      payload: attributionOption.value,
    });
    return { attribution: attributionOption.value } satisfies TeamSyncLocalThreadResult;
  });

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
    const view = Option.getOrNull(viewOption);
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
    const anchorTurnId =
      input.payload.anchorTurnId !== undefined
        ? input.payload.anchorTurnId
        : Option.isSome(latestRun)
          ? latestRun.value.runId
          : null;
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
    const resolvedAt = DateTime.formatIso(yield* DateTime.now);
    const updated = yield* repository
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
    const resolvedAt = DateTime.formatIso(yield* DateTime.now);
    const updated = yield* repository
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
    if (Option.isNone(updated)) {
      return yield* new TeamOperationError({
        code: "not_found",
        message: "Thread note could not be found.",
      });
    }
    yield* publish({ version: 1, type: "threadNoteUpserted", payload: updated.value });
    return updated.value;
  });

  const consumeAcceptedNotes = Effect.fn("TeamService.consumeAcceptedNotes")(function* (input: {
    readonly sessionId: AuthSessionId;
    readonly payload: TeamConsumeAcceptedNotesInput;
  }) {
    const team = yield* requireWorkspace();
    const actor = yield* requireActiveMember(input.sessionId);
    yield* assertActorCanResolveNotesOnThread(team, actor, input.payload.threadId);
    const resolvedAt = DateTime.formatIso(yield* DateTime.now);
    const { consumedNotes, reanchoredNotes } = yield* repository
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
    for (const note of [...consumedNotes, ...reanchoredNotes]) {
      yield* publish({ version: 1, type: "threadNoteUpserted", payload: note });
    }
    const formattedPromptPrefix = consumedNotes
      .map((note) =>
        formatAcceptedTeamNoteForPrompt({
          authorPseudo: note.authorPseudo,
          approverPseudo: actor.pseudo,
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
            approverPseudo: actor.pseudo,
            originalBody: note.originalBody,
            editedBody: note.editedBody,
          }),
        );
      }
      return blocks.join("\n\n");
    },
  );

  const finalizeNotesForDispatchedTurn = Effect.fn("TeamService.finalizeNotesForDispatchedTurn")(
    function* (input: {
      readonly sessionId: AuthSessionId;
      readonly threadId: ThreadId;
      readonly targetTurnId: string;
      readonly acceptedNotes: ReadonlyArray<TeamAcceptedNoteRef>;
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
      const resolvedAt = DateTime.formatIso(yield* DateTime.now);
      const outcome = yield* repository
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
            Effect.logWarning("TeamService.finalizeNotesForDispatchedTurn failed", {
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
      for (const note of [...outcome.consumedNotes, ...outcome.reanchoredNotes]) {
        yield* publish({ version: 1, type: "threadNoteUpserted", payload: note });
      }
    },
  );

  return TeamService.of({
    isTeamConfigured,
    getState,
    streamState,
    subscribeAccessChanges,
    openAccessChangeSubscription,
    initializeTeam,
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
    followThread,
    unfollowThread,
    listFollowedThreads,
    shouldNotifyMemberForThread,
    listNotificationRecipientsForThread,
    shouldPublishRelayNotificationForThread,
    bindRelayRecipientForSession,
    clearRelayRecipientBinding,
    subscribeNotificationEvents,
    recordThreadCreated,
    prepareThreadAttribution,
    prepareThreadInheritedFromParent,
    rollbackPreparedThreadAttribution,
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
    assertActorCanManageQueuedRun,
    assertActorCanUseWorkflows,
    assertActorCanUseScheduledTasks,
    assertActorIsAdmin,
    registerTurnInterruptHook,
    notifyTurnInterrupted,
    assignProject,
    unassignProject,
    attachEnvironment,
    updateEnvironment,
    detachEnvironment,
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
    consumeAcceptedNotes,
    listThreadNotes,
    verifyAcceptedNotesForDispatch,
    finalizeNotesForDispatchedTurn,
  });
});

export const layer = Layer.effect(TeamService, make);
