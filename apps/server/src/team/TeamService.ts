// @effect-diagnostics-next-line nodeBuiltinImport:off -- Synchronous SHA-256 digest for invite token hashing.
import * as NodeCrypto from "node:crypto";
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
  canManageTeamInvites,
  canManageTeamMembers,
  canManageTeamViews,
  canMemberCreateThreadInTeamView,
  canMemberReadTeamThread,
  canMemberReadTeamView,
  canModifyTeamMember,
  canToggleTeamThreadLock,
  EnvironmentAuthorizationError,
  isValidTeamPseudo,
  normalizeTeamPseudo,
  resolveTeamThreadPostBlockReason,
  shouldNotifyTeamMemberForThread,
  TEAM_ROLE_RANK,
  TeamId,
  TeamInviteId,
  TeamMemberId,
  TeamOperationError,
  TeamViewId,
  type AuthClientMetadata,
  type AuthEnvironmentScope,
  type AuthSessionId,
  type OrchestrationV2Command,
  type TeamAccessRule,
  type TeamCreateInviteInput,
  type TeamCreateViewInput,
  type TeamDeleteViewInput,
  type TeamDeleteViewResult,
  type TeamInitializeInput,
  type TeamInitializeResult,
  type TeamInvite,
  type TeamInviteCreatedResult,
  type TeamInvitePreviewResult,
  type TeamMember,
  type TeamPseudo,
  type TeamRedeemInviteResponse,
  type TeamRevokeInviteInput,
  type TeamRevokeInviteResult,
  type TeamRole,
  type TeamSetThreadLockedInput,
  type TeamSetThreadViewInput,
  type TeamStateSnapshot,
  type TeamStateStreamEvent,
  type TeamThreadAttribution,
  type TeamThreadFollowInput,
  type TeamThreadFollowResult,
  type TeamTurnAttribution,
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
import * as Stream from "effect/Stream";

import {
  PENDING_ATTACHMENT_THREAD_SEGMENT,
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment,
} from "../attachmentStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import { rpcInitialItems } from "../rpcInitialItems.ts";
import * as TeamRepository from "./TeamRepository.ts";

const DEFAULT_INVITE_EXPIRY_HOURS = 24 * 7;
const MAX_INVITE_EXPIRY_HOURS = 24 * 90;
const INVITE_TOKEN_PREFIX = "t3team_";
const RENEWABLE_ACCESS_TOKEN_TTL = Duration.hours(1);
const RENEWABLE_SESSION_WINDOW = Duration.days(30);

const hashInviteToken = (token: string): string =>
  NodeCrypto.createHash("sha256").update(token.trim()).digest("hex");

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
  | { readonly type: "threadView"; readonly threadId: ThreadId };

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
      readonly reuseExistingThread?: boolean;
      readonly viewId?: TeamViewId;
      readonly locked?: boolean;
    }) => Effect.Effect<void, EnvironmentAuthorizationError>;
    readonly assertCanDispatchCommand: (
      sessionId: AuthSessionId,
      command: OrchestrationV2Command,
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
      readonly viewId?: TeamViewId;
      readonly locked?: boolean;
    }) => Effect.Effect<void>;
    readonly prepareThreadAttribution: (input: {
      readonly sessionId: AuthSessionId;
      readonly threadId: ThreadId;
      readonly viewId?: TeamViewId;
      readonly locked?: boolean;
    }) => Effect.Effect<boolean>;
    readonly rollbackPreparedThreadAttribution: (threadId: ThreadId) => Effect.Effect<void>;
    readonly recordTurnAuthored: (input: {
      readonly sessionId: AuthSessionId;
      readonly threadId: ThreadId;
      readonly turnId: string;
    }) => Effect.Effect<void>;
    readonly recordThreadInheritedFromParent: (input: {
      readonly parentThreadId: ThreadId;
      readonly threadId: ThreadId;
      readonly turnId?: string;
    }) => Effect.Effect<void>;
  }
>()("t3/team/TeamService") {}

const make = Effect.gen(function* () {
  const repository = yield* TeamRepository.TeamRepository;
  const sessionStore = yield* SessionStore.SessionStore;
  const random = yield* SecureRandom.SecureRandom;
  const eventsPubSub = yield* PubSub.unbounded<TeamStateStreamEvent>();
  const notificationTriggersPubSub = yield* PubSub.unbounded<TeamNotificationTriggerEvent>();
  const accessChangesPubSub = yield* PubSub.unbounded<TeamAccessChangeEvent>();

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
    const workspace = yield* repository
      .getWorkspace()
      .pipe(Effect.orElseSucceed(() => Option.none<TeamWorkspace>()));
    return Option.isSome(workspace);
  });

  const subscribeAccessChanges = () =>
    Stream.unwrap(
      PubSub.subscribe(accessChangesPubSub).pipe(
        Effect.map((subscription) => Stream.fromSubscription(subscription)),
      ),
    );

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
      } satisfies TeamStateSnapshot;
    }
    const team = workspaceOption.value;
    const [
      currentMemberOption,
      members,
      allViews,
      allThreadAttributions,
      allLatestTurnAttributions,
    ] = yield* Effect.all([
      repository.getMemberForSession(sessionId).pipe(Effect.mapError(toInternalError)),
      repository.listMembers(team.id).pipe(Effect.mapError(toInternalError)),
      repository.listViews(team.id).pipe(Effect.mapError(toInternalError)),
      repository.listThreadAttributions(team.id).pipe(Effect.mapError(toInternalError)),
      repository.listLatestTurnAttributions(team.id).pipe(Effect.mapError(toInternalError)),
    ]);
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
    } satisfies TeamStateSnapshot;
  });

  const streamState = (sessionId: AuthSessionId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe before reading the snapshot so live events during bootstrap are never missed.
        const subscription = yield* PubSub.subscribe(eventsPubSub);
        const snapshot = yield* getState(sessionId);
        let currentMember = snapshot.currentMember;
        const liveEvents = Stream.fromSubscription(subscription).pipe(
          Stream.mapEffect((event) =>
            Effect.gen(function* () {
              if (
                event.type === "teamUpdated" ||
                event.type === "viewUpserted" ||
                event.type === "viewDeleted"
              ) {
                const fresh = yield* getState(sessionId);
                currentMember = fresh.currentMember;
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
                return readable
                  ? Option.some<TeamStateStreamEvent>(event)
                  : Option.some<TeamStateStreamEvent>({
                      version: 1 as const,
                      type: "threadRemoved" as const,
                      payload: { threadId: event.payload.threadId },
                    });
              }
              if (event.type === "turnAttributed") {
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

    yield* publish({ version: 1, type: "teamUpdated", payload: team });
    yield* publish({ version: 1, type: "memberUpserted", payload: owner });
    yield* publishAccessChange({ type: "workspace" });

    return { team, owner } satisfies TeamInitializeResult;
  });

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
    yield* publishAccessChange({ type: "member", memberId: updated.value.id });
    return updated.value;
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
      const sessionIds = yield* repository
        .listSessionIdsForMember(updated.value.id)
        .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<AuthSessionId>));
      yield* Effect.forEach(
        sessionIds,
        (memberSessionId) => sessionStore.revoke(memberSessionId).pipe(Effect.ignore),
        { discard: true },
      );
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
      readRule: normalizeAccessRule(input.payload.readRule),
      postRule: normalizeAccessRule(input.payload.postRule),
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
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    const updated = yield* repository
      .updateView({
        teamId: team.id,
        viewId: existing.id,
        ...(nextName !== undefined ? { name: nextName } : {}),
        ...(nextDescription !== undefined ? { description: nextDescription } : {}),
        ...(input.payload.readRule !== undefined
          ? { readRule: normalizeAccessRule(input.payload.readRule) }
          : {}),
        ...(input.payload.postRule !== undefined
          ? { postRule: normalizeAccessRule(input.payload.postRule) }
          : {}),
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

  const resolveThreadAccessContext = Effect.fn("TeamService.resolveThreadAccessContext")(function* (
    sessionId: AuthSessionId,
    threadId: ThreadId,
  ) {
    const workspaceOption = yield* repository
      .getWorkspace()
      .pipe(Effect.orElseSucceed(() => Option.none<TeamWorkspace>()));
    if (Option.isNone(workspaceOption)) {
      return { kind: "personal" as const };
    }
    const team = workspaceOption.value;
    const attributionOption = yield* repository
      .getThreadAttribution(threadId)
      .pipe(Effect.orElseSucceed(() => Option.none<TeamThreadAttribution>()));
    if (Option.isNone(attributionOption)) {
      return { kind: "unattributed" as const, team };
    }
    if (attributionOption.value.teamId !== team.id) {
      return { kind: "wrong_team" as const };
    }
    const [memberOption, viewOption, defaultViewOption] = yield* Effect.all([
      repository
        .getMemberForSession(sessionId)
        .pipe(Effect.orElseSucceed(() => Option.none<TeamMember>())),
      repository
        .getViewById(attributionOption.value.viewId)
        .pipe(Effect.orElseSucceed(() => Option.none<TeamView>())),
      attributionOption.value.viewId === team.defaultViewId
        ? Effect.succeed(Option.none<TeamView>())
        : repository
            .getViewById(team.defaultViewId)
            .pipe(Effect.orElseSucceed(() => Option.none<TeamView>())),
    ]);
    const member =
      Option.isSome(memberOption) && memberOption.value.teamId === team.id
        ? memberOption.value
        : null;
    const view = Option.getOrNull(viewOption) ?? Option.getOrNull(defaultViewOption);
    return {
      kind: "team_thread" as const,
      team,
      member,
      attribution: attributionOption.value,
      view,
    };
  });

  const canReadThread = Effect.fn("TeamService.canReadThread")(function* (
    sessionId: AuthSessionId,
    threadId: ThreadId,
  ) {
    const ctx = yield* resolveThreadAccessContext(sessionId, threadId);
    if (ctx.kind === "personal" || ctx.kind === "unattributed") {
      return true;
    }
    if (ctx.kind === "wrong_team") {
      return false;
    }
    return canMemberReadTeamThread({ member: ctx.member, view: ctx.view });
  });

  const assertCanReadThread = Effect.fn("TeamService.assertCanReadThread")(function* (
    sessionId: AuthSessionId,
    threadId: ThreadId,
  ) {
    const allowed = yield* canReadThread(sessionId, threadId);
    if (!allowed) {
      return yield* teamReadAuthError();
    }
  });

  const canReadAttachment = Effect.fn("TeamService.canReadAttachment")(function* (
    sessionId: AuthSessionId,
    attachmentId: string,
  ) {
    const workspaceOption = yield* repository
      .getWorkspace()
      .pipe(Effect.orElseSucceed(() => Option.none<TeamWorkspace>()));
    if (Option.isNone(workspaceOption)) {
      return true;
    }
    const segment = parseThreadSegmentFromAttachmentId(attachmentId);
    if (segment === null || segment === PENDING_ATTACHMENT_THREAD_SEGMENT) {
      return true;
    }
    const team = workspaceOption.value;
    const attributions = yield* repository
      .listThreadAttributions(team.id)
      .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<TeamThreadAttribution>));
    const matched = attributions.find(
      (attribution) => toSafeThreadAttachmentSegment(attribution.threadId) === segment,
    );
    if (!matched) {
      return true;
    }
    return yield* canReadThread(sessionId, matched.threadId);
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

  const filterReadableThreadIds = Effect.fn("TeamService.filterReadableThreadIds")(function* (
    sessionId: AuthSessionId,
    threadIds: ReadonlyArray<ThreadId>,
  ) {
    if (threadIds.length === 0) {
      return new Set<ThreadId>() as ReadonlySet<ThreadId>;
    }
    const workspaceOption = yield* repository
      .getWorkspace()
      .pipe(Effect.orElseSucceed(() => Option.none<TeamWorkspace>()));
    if (Option.isNone(workspaceOption)) {
      return new Set<ThreadId>(threadIds) as ReadonlySet<ThreadId>;
    }
    const team = workspaceOption.value;
    const [memberOption, views, attributions] = yield* Effect.all([
      repository
        .getMemberForSession(sessionId)
        .pipe(Effect.orElseSucceed(() => Option.none<TeamMember>())),
      repository.listViews(team.id).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<TeamView>)),
      repository
        .listThreadAttributions(team.id)
        .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<TeamThreadAttribution>)),
    ]);
    const member =
      Option.isSome(memberOption) && memberOption.value.teamId === team.id
        ? memberOption.value
        : null;
    const viewById = new Map(views.map((view) => [view.id, view] as const));
    const defaultView = viewById.get(team.defaultViewId) ?? null;
    const attributionByThreadId = new Map(
      attributions.map((attribution) => [attribution.threadId, attribution] as const),
    );
    const allowed = new Set<ThreadId>();
    for (const threadId of threadIds) {
      const attribution = attributionByThreadId.get(threadId);
      if (!attribution) {
        allowed.add(threadId);
        continue;
      }
      const view = viewById.get(attribution.viewId) ?? defaultView;
      if (canMemberReadTeamThread({ member, view })) {
        allowed.add(threadId);
      }
    }
    return allowed as ReadonlySet<ThreadId>;
  });

  const canPostInThread = Effect.fn("TeamService.canPostInThread")(function* (
    sessionId: AuthSessionId,
    threadId: ThreadId,
  ) {
    const ctx = yield* resolveThreadAccessContext(sessionId, threadId);
    if (ctx.kind === "personal" || ctx.kind === "unattributed") {
      return true;
    }
    if (ctx.kind === "wrong_team") {
      return false;
    }
    return (
      resolveTeamThreadPostBlockReason({
        member: ctx.member,
        attribution: ctx.attribution,
        view: ctx.view,
      }) === "ok"
    );
  });

  const assertCanPostInThread = Effect.fn("TeamService.assertCanPostInThread")(function* (
    sessionId: AuthSessionId,
    threadId: ThreadId,
  ) {
    const ctx = yield* resolveThreadAccessContext(sessionId, threadId);
    if (ctx.kind === "personal" || ctx.kind === "unattributed") {
      return;
    }
    if (ctx.kind === "wrong_team") {
      return yield* teamPostAuthError();
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

  const assertCanCreateThreadInView = Effect.fn("TeamService.assertCanCreateThreadInView")(
    function* (input: {
      readonly sessionId: AuthSessionId;
      readonly viewId?: TeamViewId;
      readonly locked?: boolean;
    }) {
      const workspaceOption = yield* repository
        .getWorkspace()
        .pipe(Effect.orElseSucceed(() => Option.none<TeamWorkspace>()));
      if (Option.isNone(workspaceOption)) {
        return;
      }
      const team = workspaceOption.value;
      const memberOption = yield* repository
        .getMemberForSession(input.sessionId)
        .pipe(Effect.orElseSucceed(() => Option.none<TeamMember>()));
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
      const viewOption = yield* repository
        .getViewById(targetViewId)
        .pipe(Effect.orElseSucceed(() => Option.none<TeamView>()));
      const view =
        Option.isSome(viewOption) && viewOption.value.teamId === team.id ? viewOption.value : null;
      if (!canMemberCreateThreadInTeamView(member, view, input.locked === true)) {
        return yield* teamPostAuthError(
          "You do not have permission to create a thread in this view.",
        );
      }
    },
  );

  const assertCanLaunchThread = Effect.fn("TeamService.assertCanLaunchThread")(function* (input: {
    readonly sessionId: AuthSessionId;
    readonly threadId?: ThreadId;
    readonly reuseExistingThread?: boolean;
    readonly viewId?: TeamViewId;
    readonly locked?: boolean;
  }) {
    if (input.reuseExistingThread === true && input.threadId !== undefined) {
      yield* assertCanPostInThread(input.sessionId, input.threadId);
      return;
    }
    yield* assertCanCreateThreadInView({
      sessionId: input.sessionId,
      ...(input.viewId !== undefined ? { viewId: input.viewId } : {}),
      ...(input.locked !== undefined ? { locked: input.locked } : {}),
    });
  });

  const assertCanDispatchCommand = Effect.fn("TeamService.assertCanDispatchCommand")(function* (
    sessionId: AuthSessionId,
    command: OrchestrationV2Command,
  ) {
    if (!(yield* isTeamConfigured())) {
      return;
    }
    switch (command.type) {
      case "thread.create":
        yield* assertCanCreateThreadInView({ sessionId });
        return;
      case "thread.visit":
      case "thread.mark-unread":
        yield* assertCanReadThread(sessionId, command.threadId);
        return;
      case "thread.fork":
        yield* assertCanReadThread(sessionId, command.sourceThreadId);
        yield* assertCanCreateThreadInView({ sessionId });
        return;
      case "thread.merge_back":
        yield* assertCanReadThread(sessionId, command.sourceThreadId);
        yield* assertCanPostInThread(sessionId, command.targetThreadId);
        return;
      case "delegated_task.request":
      case "delegated_task.wake-policy":
      case "delegated_task.completion-delivery.acknowledge":
      case "delegated_task.completion-delivery.dispose":
      case "thread.created.record":
        yield* assertCanPostInThread(sessionId, command.parentThreadId);
        return;
      default:
        yield* assertCanPostInThread(sessionId, command.threadId);
        return;
    }
  });

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

  const recordThreadCreated = Effect.fn("TeamService.recordThreadCreated")(function* (input: {
    readonly sessionId: AuthSessionId;
    readonly threadId: ThreadId;
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
      readonly viewId?: TeamViewId;
      readonly locked?: boolean;
    }) {
      const workspaceOption = yield* repository
        .getWorkspace()
        .pipe(Effect.orElseSucceed(() => Option.none<TeamWorkspace>()));
      if (Option.isNone(workspaceOption)) return false;
      const existing = yield* repository
        .getThreadAttribution(input.threadId)
        .pipe(Effect.orElseSucceed(() => Option.none<TeamThreadAttribution>()));
      if (Option.isSome(existing)) return false;
      const memberOption = yield* repository
        .getMemberForSession(input.sessionId)
        .pipe(Effect.orElseSucceed(() => Option.none<TeamMember>()));
      if (Option.isNone(memberOption)) return false;
      const locked = input.locked === true && canToggleTeamThreadLock(memberOption.value.role);
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      const inserted = yield* repository
        .recordThreadAttribution({
          threadId: input.threadId,
          teamId: workspaceOption.value.id,
          creatorMemberId: memberOption.value.id,
          viewId: input.viewId ?? workspaceOption.value.defaultViewId,
          locked,
          lockedByMemberId: locked ? memberOption.value.id : null,
          createdAt: nowIso,
        })
        .pipe(Effect.orElseSucceed(() => Option.none<TeamThreadAttribution>()));
      return Option.isSome(inserted);
    },
  );

  const rollbackPreparedThreadAttribution = Effect.fn(
    "TeamService.rollbackPreparedThreadAttribution",
  )(function* (threadId: ThreadId) {
    yield* repository.deleteThreadAttribution(threadId).pipe(Effect.ignore);
  });

  const recordTurnAuthored = Effect.fn("TeamService.recordTurnAuthored")(function* (input: {
    readonly sessionId: AuthSessionId;
    readonly threadId: ThreadId;
    readonly turnId: string;
  }) {
    const workspaceOption = yield* repository.getWorkspace().pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("TeamService.recordTurnAuthored workspace lookup failed", { cause }),
      ),
      Effect.orElseSucceed(() => Option.none<TeamWorkspace>()),
    );
    if (Option.isNone(workspaceOption)) return;
    const memberOption = yield* repository.getMemberForSession(input.sessionId).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("TeamService.recordTurnAuthored member lookup failed", { cause }),
      ),
      Effect.orElseSucceed(() => Option.none<TeamMember>()),
    );
    if (Option.isNone(memberOption)) return;
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
          Effect.logWarning("TeamService.recordTurnAuthored attribution write failed", {
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
  });

  const recordThreadInheritedFromParent = Effect.fn("TeamService.recordThreadInheritedFromParent")(
    function* (input: {
      readonly parentThreadId: ThreadId;
      readonly threadId: ThreadId;
      readonly turnId?: string;
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
      if (Option.isNone(parentAttribution)) return;
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      const attribution = yield* repository
        .recordThreadAttribution({
          threadId: input.threadId,
          teamId: workspaceOption.value.id,
          creatorMemberId: parentAttribution.value.creatorMemberId,
          viewId: parentAttribution.value.viewId,
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
      }
      if (input.turnId) {
        const inserted = yield* repository
          .recordTurnAttribution({
            turnId: input.turnId,
            threadId: input.threadId,
            authorMemberId: parentAttribution.value.creatorMemberId,
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
              authorMemberId: parentAttribution.value.creatorMemberId,
              authorPseudo: parentAttribution.value.creatorPseudo,
              createdAt: nowIso,
            },
          });
        }
      }
    },
  );

  return TeamService.of({
    isTeamConfigured,
    getState,
    streamState,
    subscribeAccessChanges,
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
    rollbackPreparedThreadAttribution,
    recordTurnAuthored,
    recordThreadInheritedFromParent,
  });
});

export const layer = Layer.effect(TeamService, make);
