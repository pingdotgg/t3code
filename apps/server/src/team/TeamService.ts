// @effect-diagnostics-next-line nodeBuiltinImport:off -- Synchronous SHA-256 digest for invite token hashing.
import * as NodeCrypto from "node:crypto";
import {
  AuthStandardClientScopes,
  canAssignTeamRole,
  canManageTeamInvites,
  isValidTeamPseudo,
  normalizeTeamPseudo,
  TEAM_ROLE_RANK,
  TeamId,
  TeamInviteId,
  TeamMemberId,
  TeamOperationError,
  TeamViewId,
  type AuthClientMetadata,
  type AuthSessionId,
  type TeamCreateInviteInput,
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
  type TeamStateSnapshot,
  type TeamStateStreamEvent,
  type TeamThreadAttribution,
  type TeamUpdateMyPseudoInput,
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
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

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

const toInternalError = (cause: unknown) =>
  new TeamOperationError({
    code: "internal",
    message: cause instanceof Error ? cause.message : "An internal team error occurred.",
  });

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

export class TeamService extends Context.Service<
  TeamService,
  {
    readonly getState: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<TeamStateSnapshot, TeamOperationError>;
    readonly streamState: (
      sessionId: AuthSessionId,
    ) => Stream.Stream<TeamStateStreamEvent, TeamOperationError>;
    readonly initializeTeam: (input: {
      readonly sessionId: AuthSessionId;
      readonly payload: TeamInitializeInput;
    }) => Effect.Effect<TeamInitializeResult, TeamOperationError>;
    readonly updateMyPseudo: (input: {
      readonly sessionId: AuthSessionId;
      readonly payload: TeamUpdateMyPseudoInput;
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
    readonly listThreadAttributions: () => Effect.Effect<
      ReadonlyArray<TeamThreadAttribution>,
      TeamOperationError
    >;
    readonly recordThreadCreated: (input: {
      readonly sessionId: AuthSessionId;
      readonly threadId: ThreadId;
    }) => Effect.Effect<void>;
    readonly recordTurnAuthored: (input: {
      readonly sessionId: AuthSessionId;
      readonly threadId: ThreadId;
      readonly turnId: string;
    }) => Effect.Effect<void>;
  }
>()("t3/team/TeamService") {}

const make = Effect.gen(function* () {
  const repository = yield* TeamRepository.TeamRepository;
  const sessionStore = yield* SessionStore.SessionStore;
  const random = yield* SecureRandom.SecureRandom;
  const eventsPubSub = yield* PubSub.unbounded<TeamStateStreamEvent>();

  const publish = (event: TeamStateStreamEvent) =>
    PubSub.publish(eventsPubSub, event).pipe(Effect.asVoid);

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
        threadAttributions: [],
      } satisfies TeamStateSnapshot;
    }
    const team = workspaceOption.value;
    const [currentMemberOption, members, threadAttributions] = yield* Effect.all([
      repository.getMemberForSession(sessionId).pipe(Effect.mapError(toInternalError)),
      repository.listMembers(team.id).pipe(Effect.mapError(toInternalError)),
      repository.listThreadAttributions(team.id).pipe(Effect.mapError(toInternalError)),
    ]);
    const currentMember = Option.getOrNull(currentMemberOption);
    const invites =
      currentMember !== null &&
      currentMember.status === "active" &&
      canManageTeamInvites(currentMember.role)
        ? yield* repository.listInvites(team.id).pipe(Effect.mapError(toInternalError))
        : [];

    return {
      team,
      currentMember,
      members,
      invites,
      threadAttributions,
    } satisfies TeamStateSnapshot;
  });

  const streamState = (sessionId: AuthSessionId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const buffer = yield* Queue.unbounded<TeamStateStreamEvent>();
        yield* Effect.forkScoped(
          Stream.fromPubSub(eventsPubSub).pipe(
            Stream.runForEach((event) => Queue.offer(buffer, event)),
          ),
          { startImmediately: true },
        );
        const snapshot = yield* getState(sessionId);
        let currentMember = snapshot.currentMember;
        const liveEvents = Stream.fromQueue(buffer).pipe(
          Stream.mapEffect((event) =>
            Effect.gen(function* () {
              if (event.type === "teamUpdated") {
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
                  currentMember = event.payload;
                }
                return Option.some<TeamStateStreamEvent>(event);
              }
              if (event.type === "inviteUpserted") {
                // Only modo+ sessions observe invite metadata.
                return currentMember !== null && canManageTeamInvites(currentMember.role)
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

    yield* publish({ version: 1, type: "teamUpdated", payload: team });
    yield* publish({ version: 1, type: "memberUpserted", payload: owner });

    return { team, owner } satisfies TeamInitializeResult;
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

    if (!consumed) {
      return yield* new TeamOperationError({
        code: "invite_exhausted",
        message: "This team invite has already been used or revoked.",
      });
    }

    const useDpop = input.proofKeyThumbprint !== undefined;
    const issued = yield* sessionStore
      .issue({
        subject: `team-member:${member.id}`,
        method: useDpop ? "dpop-access-token" : "bearer-access-token",
        scopes: AuthStandardClientScopes,
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
      .pipe(Effect.mapError(toInternalError));

    yield* repository
      .bindSession({
        sessionId: issued.sessionId,
        teamId: team.id,
        memberId: member.id,
        boundAt: nowIso,
      })
      .pipe(Effect.mapError(toInternalError));

    const updatedInvite = yield* repository
      .getInviteById(invite.id)
      .pipe(Effect.mapError(toInternalError));
    yield* publish({ version: 1, type: "memberUpserted", payload: member });
    if (Option.isSome(updatedInvite)) {
      yield* publish({
        version: 1,
        type: "inviteUpserted",
        payload: stripInviteHash(updatedInvite.value),
      });
    }

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

  const listThreadAttributions = Effect.fn("TeamService.listThreadAttributions")(function* () {
    const workspaceOption = yield* repository.getWorkspace();
    if (Option.isNone(workspaceOption)) {
      return [];
    }
    return yield* repository.listThreadAttributions(workspaceOption.value.id);
  }, Effect.mapError(toInternalError));

  const recordThreadCreated = Effect.fn("TeamService.recordThreadCreated")(function* (input: {
    readonly sessionId: AuthSessionId;
    readonly threadId: ThreadId;
  }) {
    const workspaceOption = yield* repository
      .getWorkspace()
      .pipe(Effect.orElseSucceed(() => Option.none<TeamWorkspace>()));
    if (Option.isNone(workspaceOption)) return;
    const memberOption = yield* repository
      .getMemberForSession(input.sessionId)
      .pipe(Effect.orElseSucceed(() => Option.none<TeamMember>()));
    if (Option.isNone(memberOption)) return;
    const nowIso = DateTime.formatIso(yield* DateTime.now);
    const attribution = yield* repository
      .recordThreadAttribution({
        threadId: input.threadId,
        teamId: workspaceOption.value.id,
        creatorMemberId: memberOption.value.id,
        viewId: workspaceOption.value.defaultViewId,
        createdAt: nowIso,
      })
      .pipe(Effect.orElseSucceed(() => Option.none<TeamThreadAttribution>()));
    if (Option.isSome(attribution)) {
      yield* publish({
        version: 1,
        type: "threadAttributed",
        payload: attribution.value,
      });
    }
  });

  const recordTurnAuthored = Effect.fn("TeamService.recordTurnAuthored")(function* (input: {
    readonly sessionId: AuthSessionId;
    readonly threadId: ThreadId;
    readonly turnId: string;
  }) {
    const workspaceOption = yield* repository
      .getWorkspace()
      .pipe(Effect.orElseSucceed(() => Option.none<TeamWorkspace>()));
    if (Option.isNone(workspaceOption)) return;
    const memberOption = yield* repository
      .getMemberForSession(input.sessionId)
      .pipe(Effect.orElseSucceed(() => Option.none<TeamMember>()));
    if (Option.isNone(memberOption)) return;
    const nowIso = DateTime.formatIso(yield* DateTime.now);
    yield* repository
      .recordTurnAttribution({
        turnId: input.turnId,
        threadId: input.threadId,
        authorMemberId: memberOption.value.id,
        createdAt: nowIso,
      })
      .pipe(Effect.ignore);
  });

  return TeamService.of({
    getState,
    streamState,
    initializeTeam,
    updateMyPseudo,
    createInvite,
    revokeInvite,
    previewInvite,
    redeemInvite,
    listThreadAttributions,
    recordThreadCreated,
    recordTurnAuthored,
  });
});

export const layer = Layer.effect(TeamService, make);
