import * as Schema from "effect/Schema";
import {
  AuthClientMetadataDeviceType,
  AuthEnvironmentScope,
  AuthMcpClientAccess,
} from "../auth.ts";
import {
  AuthSessionId,
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "../baseSchemas.ts";
import { ModelSelection } from "../modelSelection.ts";
import { ProviderInteractionMode, RuntimeMode } from "../providerPolicy.ts";

const makeTeamEntityId = <Brand extends string>(brand: Parameters<typeof Schema.brand<Brand>>[0]) =>
  TrimmedNonEmptyString.pipe(Schema.brand<Brand>(brand));

export const TeamId = makeTeamEntityId("TeamId");
export type TeamId = typeof TeamId.Type;

export const TeamMemberId = makeTeamEntityId("TeamMemberId");
export type TeamMemberId = typeof TeamMemberId.Type;

export const TeamInviteId = makeTeamEntityId("TeamInviteId");
export type TeamInviteId = typeof TeamInviteId.Type;

export const TeamViewId = makeTeamEntityId("TeamViewId");
export type TeamViewId = typeof TeamViewId.Type;

export const TeamEnvironmentRecordId = makeTeamEntityId("TeamEnvironmentRecordId");
export type TeamEnvironmentRecordId = typeof TeamEnvironmentRecordId.Type;

export const TeamThreadNoteId = makeTeamEntityId("TeamThreadNoteId");
export type TeamThreadNoteId = typeof TeamThreadNoteId.Type;

export const ALL_TEAM_ROLES = ["owner", "admin", "modo", "regular"] as const;
export const TeamRole = Schema.Literals(ALL_TEAM_ROLES);
export type TeamRole = typeof TeamRole.Type;

export const TEAM_ROLE_RANK: Readonly<Record<TeamRole, number>> = {
  owner: 4,
  admin: 3,
  modo: 2,
  regular: 1,
};

export function isTeamAdminRole(role: TeamRole): boolean {
  return role === "owner" || role === "admin";
}

/** Member invitations and role management start at `modo`. */
export function canManageTeamInvites(role: TeamRole): boolean {
  return TEAM_ROLE_RANK[role] >= TEAM_ROLE_RANK.modo;
}

/** Member role/status management starts at `modo`. */
export function canManageTeamMembers(role: TeamRole): boolean {
  return TEAM_ROLE_RANK[role] >= TEAM_ROLE_RANK.modo;
}

/** A member at `modo+` can invite or assign any role <= their own role. */
export function canAssignTeamRole(actorRole: TeamRole, targetRole: TeamRole): boolean {
  return canManageTeamInvites(actorRole) && TEAM_ROLE_RANK[targetRole] <= TEAM_ROLE_RANK[actorRole];
}

/** Cannot modify, demote, or remove a member whose current role is strictly higher than the actor's. */
export function canModifyTeamMember(actorRole: TeamRole, targetCurrentRole: TeamRole): boolean {
  return (
    canManageTeamMembers(actorRole) &&
    TEAM_ROLE_RANK[targetCurrentRole] <= TEAM_ROLE_RANK[actorRole]
  );
}

export function canChangeTeamMemberRole(
  actorRole: TeamRole,
  targetCurrentRole: TeamRole,
  nextRole: TeamRole,
): boolean {
  return (
    canModifyTeamMember(actorRole, targetCurrentRole) && canAssignTeamRole(actorRole, nextRole)
  );
}

export function assignableTeamRoles(actorRole: TeamRole): ReadonlyArray<TeamRole> {
  if (!canManageTeamInvites(actorRole)) return [];
  return ALL_TEAM_ROLES.filter((role) => TEAM_ROLE_RANK[role] <= TEAM_ROLE_RANK[actorRole]);
}

export function canManageTeamViews(role: TeamRole): boolean {
  return isTeamAdminRole(role);
}

export function canChangeThreadTeamView(role: TeamRole): boolean {
  return TEAM_ROLE_RANK[role] >= TEAM_ROLE_RANK.modo;
}

export function canToggleTeamThreadLock(role: TeamRole): boolean {
  return isTeamAdminRole(role);
}

export function canManageTeamEnvironments(role: TeamRole): boolean {
  return isTeamAdminRole(role);
}

export function canManageTeamProjects(role: TeamRole): boolean {
  return isTeamAdminRole(role);
}

/** Regular authors require an explicit UI confirmation dialog before note approval/edit-approval. */
export function requiresTeamNoteApprovalConfirmation(authorRole: TeamRole): boolean {
  return authorRole === "regular";
}

export const TeamMemberStatus = Schema.Literals(["active", "suspended", "removed"]);
export type TeamMemberStatus = typeof TeamMemberStatus.Type;

const TEAM_PSEUDO_PATTERN = /^[a-zA-Z0-9._-]{2,32}$/;

export function normalizeTeamPseudo(raw: string): string {
  return raw.trim();
}

export function isValidTeamPseudo(raw: string): boolean {
  return TEAM_PSEUDO_PATTERN.test(normalizeTeamPseudo(raw));
}

export const TeamPseudo = TrimmedNonEmptyString.check(Schema.isPattern(TEAM_PSEUDO_PATTERN));
export type TeamPseudo = typeof TeamPseudo.Type;

export const TeamWorkspace = Schema.Struct({
  id: TeamId,
  name: TrimmedNonEmptyString,
  defaultViewId: TeamViewId,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type TeamWorkspace = typeof TeamWorkspace.Type;

export const TeamMember = Schema.Struct({
  id: TeamMemberId,
  teamId: TeamId,
  pseudo: TeamPseudo,
  role: TeamRole,
  status: TeamMemberStatus,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type TeamMember = typeof TeamMember.Type;

export const TeamInvite = Schema.Struct({
  id: TeamInviteId,
  teamId: TeamId,
  role: TeamRole,
  prefilledPseudo: Schema.NullOr(TeamPseudo),
  maxUses: PositiveInt,
  uses: NonNegativeInt,
  expiresAt: IsoDateTime,
  createdByMemberId: TeamMemberId,
  revokedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
});
export type TeamInvite = typeof TeamInvite.Type;

export const TeamInviteCreatedResult = Schema.Struct({
  invite: TeamInvite,
  /** Raw invite secret, returned once at creation time and never stored in plaintext. */
  token: TrimmedNonEmptyString,
});
export type TeamInviteCreatedResult = typeof TeamInviteCreatedResult.Type;

export const TeamSessionBinding = Schema.Struct({
  sessionId: AuthSessionId,
  teamId: TeamId,
  memberId: TeamMemberId,
  boundAt: IsoDateTime,
});
export type TeamSessionBinding = typeof TeamSessionBinding.Type;

export const TeamAccessRule = Schema.Struct({
  roles: Schema.Array(TeamRole),
  memberIds: Schema.Array(TeamMemberId),
});
export type TeamAccessRule = typeof TeamAccessRule.Type;

export const TeamView = Schema.Struct({
  id: TeamViewId,
  teamId: TeamId,
  name: TrimmedNonEmptyString,
  description: Schema.NullOr(Schema.String),
  isDefault: Schema.Boolean,
  readRule: TeamAccessRule,
  postRule: TeamAccessRule,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type TeamView = typeof TeamView.Type;

export const TeamProjectAssignment = Schema.Struct({
  projectId: ProjectId,
  teamId: TeamId,
  defaultViewId: Schema.NullOr(TeamViewId),
  repoIdentityKey: Schema.NullOr(TrimmedNonEmptyString),
  assignedByMemberId: TeamMemberId,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type TeamProjectAssignment = typeof TeamProjectAssignment.Type;

export const TeamEnvironment = Schema.Struct({
  id: TeamEnvironmentRecordId,
  teamId: TeamId,
  environmentId: EnvironmentId,
  name: TrimmedNonEmptyString,
  isDefault: Schema.Boolean,
  peerLinkId: Schema.NullOr(TrimmedNonEmptyString),
  accessRule: TeamAccessRule,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type TeamEnvironment = typeof TeamEnvironment.Type;

export const TeamThreadNoteStatus = Schema.Literals([
  "pending",
  "accepted",
  "rejected",
  "consumed",
]);
export type TeamThreadNoteStatus = typeof TeamThreadNoteStatus.Type;

export const TeamThreadNote = Schema.Struct({
  id: TeamThreadNoteId,
  threadId: ThreadId,
  teamId: TeamId,
  authorMemberId: TeamMemberId,
  authorPseudo: TeamPseudo,
  authorRole: TeamRole,
  originalBody: Schema.String,
  originalContentHash: TrimmedNonEmptyString,
  editedBody: Schema.NullOr(Schema.String),
  editedContentHash: Schema.NullOr(TrimmedNonEmptyString),
  status: TeamThreadNoteStatus,
  anchorTurnId: Schema.NullOr(Schema.String),
  anchorSeq: NonNegativeInt,
  includedInTurnId: Schema.NullOr(Schema.String),
  resolvedByMemberId: Schema.NullOr(TeamMemberId),
  resolvedByPseudo: Schema.NullOr(TeamPseudo),
  resolvedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
});
export type TeamThreadNote = typeof TeamThreadNote.Type;

export const TeamAcceptedNoteRef = Schema.Struct({
  noteId: TeamThreadNoteId,
  contentHash: TrimmedNonEmptyString,
});
export type TeamAcceptedNoteRef = typeof TeamAcceptedNoteRef.Type;

/** Effective content hash pinned at approval time (`editedContentHash ?? originalContentHash`). */
export function effectiveTeamThreadNoteHash(
  note: Pick<TeamThreadNote, "originalContentHash" | "editedContentHash">,
): string {
  return note.editedContentHash ?? note.originalContentHash;
}

/** Effective body that will be passed to the agent when approved (`editedBody ?? originalBody`). */
export function effectiveTeamThreadNoteBody(
  note: Pick<TeamThreadNote, "originalBody" | "editedBody">,
): string {
  return note.editedBody ?? note.originalBody;
}

export function formatAcceptedTeamNoteForPrompt(input: {
  readonly authorPseudo: string;
  readonly approverPseudo: string;
  readonly originalBody: string;
  readonly editedBody: string | null;
}): string {
  const body = input.editedBody ?? input.originalBody;
  if (input.editedBody !== null) {
    return `[Note from ${input.authorPseudo} (edited & approved by ${input.approverPseudo})]: ${body}`;
  }
  return `[Note from ${input.authorPseudo} (approved by ${input.approverPseudo})]: ${body}`;
}

export function canMemberAccessTeamEnvironment(
  member: Pick<TeamMember, "id" | "role" | "status"> | null | undefined,
  environment: Pick<TeamEnvironment, "accessRule"> | null | undefined,
): boolean {
  if (!member || member.status !== "active") return false;
  if (!environment) return false;
  return matchesTeamAccessRule(environment.accessRule, member);
}

/**
 * Evaluates whether a member can leave a note on an inaccessible-environment thread:
 * requires read access, unlocked (or admin), and post permission under the View's `postRule`.
 */
export function canMemberLeaveTeamThreadNote(input: {
  readonly member: Pick<TeamMember, "id" | "role" | "status"> | null | undefined;
  readonly attribution: Pick<TeamThreadAttribution, "creatorMemberId" | "locked">;
  readonly view: Pick<TeamView, "readRule" | "postRule"> | null | undefined;
}): boolean {
  return canMemberPostInTeamThread(input);
}

export type TeamThreadEnvironmentAccess =
  | { readonly canExecute: true; readonly reason: "ok" }
  | {
      readonly canExecute: false;
      readonly reason: "other_member_local" | "environment_acl_denied";
      readonly environmentLabel: string;
    };

/**
 * Evaluates whether a member can execute turns on the environment attached to a team thread.
 * - Local-synced threads execute EXCLUSIVELY on the owner's local machine (never on the Team Server,
 *   and never by another member—not even owner or admin).
 * - Remote team environments enforce `team_environments.accessRule`.
 */
export function resolveTeamThreadEnvironmentAccess(input: {
  readonly member: Pick<TeamMember, "id" | "role" | "status"> | null | undefined;
  readonly attribution: Pick<
    TeamThreadAttribution,
    | "creatorMemberId"
    | "creatorPseudo"
    | "executionEnvironmentId"
    | "executionEnvironmentLabel"
    | "isLocalSynced"
  >;
  readonly environments: ReadonlyArray<
    Pick<TeamEnvironment, "environmentId" | "name" | "isDefault" | "accessRule">
  >;
  /** Set when evaluating on the member's own local execution environment rather than the Team Server. */
  readonly viewingOnLocalExecutionEnvironment?: boolean;
}): TeamThreadEnvironmentAccess {
  const { member, attribution, environments, viewingOnLocalExecutionEnvironment = false } = input;
  if (!member || member.status !== "active") {
    return {
      canExecute: false,
      reason: "environment_acl_denied",
      environmentLabel: attribution.executionEnvironmentLabel ?? "Team Environment",
    };
  }
  if (attribution.isLocalSynced === true) {
    const label =
      attribution.executionEnvironmentLabel ?? `${attribution.creatorPseudo}'s local environment`;
    if (viewingOnLocalExecutionEnvironment && attribution.creatorMemberId === member.id) {
      return { canExecute: true, reason: "ok" };
    }
    return {
      canExecute: false,
      reason: "other_member_local",
      environmentLabel: label,
    };
  }
  const targetEnvId = attribution.executionEnvironmentId ?? null;
  const matchedEnv =
    targetEnvId !== null
      ? (environments.find((env) => env.environmentId === targetEnvId) ?? null)
      : (environments.find((env) => env.isDefault) ?? null);
  if (matchedEnv === null) {
    if (targetEnvId !== null) {
      // Non-admin snapshots omit restricted environments; an unknown remote executionEnvironmentId fails closed.
      return {
        canExecute: false,
        reason: "environment_acl_denied",
        environmentLabel: attribution.executionEnvironmentLabel ?? targetEnvId,
      };
    }
    return { canExecute: true, reason: "ok" };
  }
  if (!canMemberAccessTeamEnvironment(member, matchedEnv)) {
    return {
      canExecute: false,
      reason: "environment_acl_denied",
      environmentLabel: attribution.executionEnvironmentLabel ?? matchedEnv.name,
    };
  }
  return { canExecute: true, reason: "ok" };
}

function matchesTeamAccessRule(
  rule: TeamAccessRule,
  member: Pick<TeamMember, "id" | "role">,
): boolean {
  return rule.roles.includes(member.role) || rule.memberIds.includes(member.id);
}

/**
 * `owner` and `admin` retain visibility over all views so threads cannot be orphaned.
 * Other active members must match `view.readRule`.
 */
export function canMemberReadTeamView(
  member: Pick<TeamMember, "id" | "role" | "status"> | null | undefined,
  view: Pick<TeamView, "readRule"> | null | undefined,
): boolean {
  if (!member || member.status !== "active") return false;
  if (isTeamAdminRole(member.role)) return true;
  if (!view) return false;
  return matchesTeamAccessRule(view.readRule, member);
}

/** Any member who can read a view may create a thread in it; creating a locked thread needs owner/admin. */
export function canMemberCreateThreadInTeamView(
  member: Pick<TeamMember, "id" | "role" | "status"> | null | undefined,
  view: Pick<TeamView, "readRule"> | null | undefined,
  locked = false,
): boolean {
  if (!member || member.status !== "active") return false;
  if (locked && !canToggleTeamThreadLock(member.role)) return false;
  return canMemberReadTeamView(member, view);
}

export function canMemberReadTeamThread(input: {
  readonly member: Pick<TeamMember, "id" | "role" | "status"> | null | undefined;
  readonly view: Pick<TeamView, "readRule"> | null | undefined;
}): boolean {
  return canMemberReadTeamView(input.member, input.view);
}

export type TeamThreadPostBlockReason = "ok" | "locked" | "view_read_only" | "no_access";

export function resolveTeamThreadPostBlockReason(input: {
  readonly member: Pick<TeamMember, "id" | "role" | "status"> | null | undefined;
  readonly attribution: Pick<TeamThreadAttribution, "creatorMemberId" | "locked">;
  readonly view: Pick<TeamView, "readRule" | "postRule"> | null | undefined;
}): TeamThreadPostBlockReason {
  const { member, attribution, view } = input;
  if (!canMemberReadTeamThread({ member, view }) || !member) {
    return "no_access";
  }
  if (attribution.locked) {
    return isTeamAdminRole(member.role) ? "ok" : "locked";
  }
  if (attribution.creatorMemberId === member.id) {
    return "ok";
  }
  if (view && matchesTeamAccessRule(view.postRule, member)) {
    return "ok";
  }
  return "view_read_only";
}

export function canMemberPostInTeamThread(input: {
  readonly member: Pick<TeamMember, "id" | "role" | "status"> | null | undefined;
  readonly attribution: Pick<TeamThreadAttribution, "creatorMemberId" | "locked">;
  readonly view: Pick<TeamView, "readRule" | "postRule"> | null | undefined;
}): boolean {
  return resolveTeamThreadPostBlockReason(input) === "ok";
}

/**
 * Only the thread creator may steer an active turn or promote a queued run (`Send now`).
 * Even `owner` and `admin` cannot steer/promote on someone else's thread.
 */
export function canMemberSteerActiveTeamTurn(input: {
  readonly member: Pick<TeamMember, "id" | "role" | "status"> | null | undefined;
  readonly attribution:
    | Pick<TeamThreadAttribution, "creatorMemberId" | "locked">
    | null
    | undefined;
  readonly view?: Pick<TeamView, "readRule" | "postRule"> | null | undefined;
}): boolean {
  const { member, attribution, view } = input;
  if (!member || member.status !== "active" || !attribution) return false;
  if (attribution.creatorMemberId !== member.id) return false;
  if (attribution.locked && !isTeamAdminRole(member.role)) return false;
  if (view !== undefined && !canMemberReadTeamThread({ member, view })) return false;
  return true;
}

export function canMemberPromoteTeamQueuedRun(
  input: Parameters<typeof canMemberSteerActiveTeamTurn>[0],
): boolean {
  return canMemberSteerActiveTeamTurn(input);
}

/**
 * Team turn interrupt rules: `owner`/`admin`, the thread creator, or the active turn author may
 * interrupt; `regular`/`modo` non-creators cannot interrupt another member's turn.
 */
export function canMemberInterruptTeamTurn(input: {
  readonly member: Pick<TeamMember, "id" | "role" | "status"> | null | undefined;
  readonly attribution:
    | Pick<TeamThreadAttribution, "creatorMemberId" | "locked">
    | null
    | undefined;
  readonly view?: Pick<TeamView, "readRule"> | null | undefined;
  readonly activeTurnAuthorMemberId?: TeamMemberId | null | undefined;
}): boolean {
  const { member, attribution, view, activeTurnAuthorMemberId } = input;
  if (!member || member.status !== "active") return false;
  if (view !== undefined && !canMemberReadTeamThread({ member, view })) return false;
  if (isTeamAdminRole(member.role)) return true;
  if (activeTurnAuthorMemberId != null && activeTurnAuthorMemberId === member.id) {
    return true;
  }
  if (attribution && attribution.creatorMemberId === member.id) {
    return true;
  }
  return false;
}

/**
 * Who may edit or cancel a queued run in a team thread (excluding `Send now` promotion,
 * which is strictly thread-creator-only via `canMemberPromoteTeamQueuedRun`).
 */
export function canMemberManageTeamQueuedRun(input: {
  readonly member: Pick<TeamMember, "id" | "role" | "status"> | null | undefined;
  readonly attribution:
    | Pick<TeamThreadAttribution, "creatorMemberId" | "locked">
    | null
    | undefined;
  readonly view?: Pick<TeamView, "readRule" | "postRule"> | null | undefined;
  readonly queuedRunAuthorMemberId?: TeamMemberId | null | undefined;
}): boolean {
  const { member, attribution, view, queuedRunAuthorMemberId } = input;
  if (!member || member.status !== "active") return false;
  if (view !== undefined && !canMemberReadTeamThread({ member, view })) return false;
  if (isTeamAdminRole(member.role)) return true;
  if (attribution?.locked) return false;
  if (attribution && attribution.creatorMemberId === member.id) return true;
  if (queuedRunAuthorMemberId != null && queuedRunAuthorMemberId === member.id) return true;
  return false;
}

export const TeamThreadAttribution = Schema.Struct({
  threadId: ThreadId,
  teamId: TeamId,
  creatorMemberId: TeamMemberId,
  creatorPseudo: TeamPseudo,
  viewId: TeamViewId,
  locked: Schema.Boolean,
  lockedByMemberId: Schema.NullOr(TeamMemberId),
  executionEnvironmentId: Schema.optionalKey(Schema.NullOr(EnvironmentId)),
  executionEnvironmentLabel: Schema.optionalKey(Schema.NullOr(Schema.String)),
  isLocalSynced: Schema.optionalKey(Schema.Boolean),
  createdAt: IsoDateTime,
});
export type TeamThreadAttribution = typeof TeamThreadAttribution.Type;

export const TeamTurnAttribution = Schema.Struct({
  turnId: TrimmedNonEmptyString,
  threadId: ThreadId,
  authorMemberId: TeamMemberId,
  authorPseudo: TeamPseudo,
  createdAt: IsoDateTime,
});
export type TeamTurnAttribution = typeof TeamTurnAttribution.Type;

export const TeamThreadFollowInput = Schema.Struct({
  threadId: ThreadId,
});
export type TeamThreadFollowInput = typeof TeamThreadFollowInput.Type;

export const TeamThreadFollowResult = Schema.Struct({
  threadId: ThreadId,
  isFollowing: Schema.Boolean,
});
export type TeamThreadFollowResult = typeof TeamThreadFollowResult.Type;

export const TeamListFollowedThreadsResult = Schema.Struct({
  followedThreadIds: Schema.Array(ThreadId),
});
export type TeamListFollowedThreadsResult = typeof TeamListFollowedThreadsResult.Type;

export const TeamThreadFollowChangedPayload = Schema.Struct({
  threadId: ThreadId,
  memberId: TeamMemberId,
  isFollowing: Schema.Boolean,
});
export type TeamThreadFollowChangedPayload = typeof TeamThreadFollowChangedPayload.Type;

export const TeamViewDeletedPayload = Schema.Struct({
  viewId: TeamViewId,
  fallbackViewId: TeamViewId,
});
export type TeamViewDeletedPayload = typeof TeamViewDeletedPayload.Type;

export const TeamThreadRemovedPayload = Schema.Struct({
  threadId: ThreadId,
});
export type TeamThreadRemovedPayload = typeof TeamThreadRemovedPayload.Type;

export const TeamProjectUnassignedPayload = Schema.Struct({
  projectId: ProjectId,
});
export type TeamProjectUnassignedPayload = typeof TeamProjectUnassignedPayload.Type;

export const TeamEnvironmentRemovedPayload = Schema.Struct({
  environmentId: EnvironmentId,
});
export type TeamEnvironmentRemovedPayload = typeof TeamEnvironmentRemovedPayload.Type;

export const TeamThreadNoteDeletedPayload = Schema.Struct({
  noteId: TeamThreadNoteId,
  threadId: ThreadId,
});
export type TeamThreadNoteDeletedPayload = typeof TeamThreadNoteDeletedPayload.Type;

export const TeamStateSnapshot = Schema.Struct({
  team: Schema.NullOr(TeamWorkspace),
  currentMember: Schema.NullOr(TeamMember),
  members: Schema.Array(TeamMember),
  invites: Schema.Array(TeamInvite),
  views: Schema.Array(TeamView),
  threadAttributions: Schema.Array(TeamThreadAttribution),
  followedThreadIds: Schema.Array(ThreadId),
  latestTurnAttributions: Schema.Array(TeamTurnAttribution),
  teamProjects: Schema.optionalKey(Schema.Array(TeamProjectAssignment)),
  environments: Schema.optionalKey(Schema.Array(TeamEnvironment)),
  threadNotes: Schema.optionalKey(Schema.Array(TeamThreadNote)),
});
export type TeamStateSnapshot = typeof TeamStateSnapshot.Type;

export const TeamStateStreamEvent = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("snapshot"),
    payload: TeamStateSnapshot,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("teamUpdated"),
    payload: TeamWorkspace,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("memberUpserted"),
    payload: TeamMember,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("inviteUpserted"),
    payload: TeamInvite,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("viewUpserted"),
    payload: TeamView,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("viewDeleted"),
    payload: TeamViewDeletedPayload,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("threadAttributed"),
    payload: TeamThreadAttribution,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("threadRemoved"),
    payload: TeamThreadRemovedPayload,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("turnAttributed"),
    payload: TeamTurnAttribution,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("threadFollowChanged"),
    payload: TeamThreadFollowChangedPayload,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("projectAssigned"),
    payload: TeamProjectAssignment,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("projectUnassigned"),
    payload: TeamProjectUnassignedPayload,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("environmentUpserted"),
    payload: TeamEnvironment,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("environmentRemoved"),
    payload: TeamEnvironmentRemovedPayload,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("threadNoteUpserted"),
    payload: TeamThreadNote,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("threadNoteDeleted"),
    payload: TeamThreadNoteDeletedPayload,
  }),
]);
export type TeamStateStreamEvent = typeof TeamStateStreamEvent.Type;

export interface TeamThreadNotificationEligibilityInput {
  readonly hasTeam: boolean;
  readonly memberId: TeamMemberId | null;
  readonly creatorMemberId: TeamMemberId | null;
  readonly isFollowing: boolean;
  readonly activeTurnAuthorMemberId: TeamMemberId | null;
}

/**
 * Determines whether a team member should be notified for a thread event.
 * Personal mode (`!hasTeam`) and unattributed threads always remain enabled.
 */
export function shouldNotifyTeamMemberForThread(
  input: TeamThreadNotificationEligibilityInput,
): boolean {
  if (!input.hasTeam || input.creatorMemberId === null) {
    return true;
  }
  if (input.memberId === null) {
    return false;
  }
  return (
    input.creatorMemberId === input.memberId ||
    input.isFollowing ||
    (input.activeTurnAuthorMemberId !== null && input.activeTurnAuthorMemberId === input.memberId)
  );
}

export const TeamInitializeInput = Schema.Struct({
  name: TrimmedNonEmptyString,
  ownerPseudo: TrimmedNonEmptyString,
});
export type TeamInitializeInput = typeof TeamInitializeInput.Type;

export const TeamInitializeResult = Schema.Struct({
  team: TeamWorkspace,
  owner: TeamMember,
});
export type TeamInitializeResult = typeof TeamInitializeResult.Type;

export const TeamUpdateMyPseudoInput = Schema.Struct({
  pseudo: TrimmedNonEmptyString,
});
export type TeamUpdateMyPseudoInput = typeof TeamUpdateMyPseudoInput.Type;

export const TeamUpdateMemberRoleInput = Schema.Struct({
  memberId: TeamMemberId,
  role: TeamRole,
});
export type TeamUpdateMemberRoleInput = typeof TeamUpdateMemberRoleInput.Type;

export const TeamUpdateMemberStatusInput = Schema.Struct({
  memberId: TeamMemberId,
  status: TeamMemberStatus,
});
export type TeamUpdateMemberStatusInput = typeof TeamUpdateMemberStatusInput.Type;

export const TeamCreateViewInput = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.optionalKey(Schema.NullOr(Schema.String)),
  readRule: TeamAccessRule,
  postRule: TeamAccessRule,
});
export type TeamCreateViewInput = typeof TeamCreateViewInput.Type;

export const TeamUpdateViewInput = Schema.Struct({
  viewId: TeamViewId,
  name: Schema.optionalKey(TrimmedNonEmptyString),
  description: Schema.optionalKey(Schema.NullOr(Schema.String)),
  readRule: Schema.optionalKey(TeamAccessRule),
  postRule: Schema.optionalKey(TeamAccessRule),
});
export type TeamUpdateViewInput = typeof TeamUpdateViewInput.Type;

export const TeamDeleteViewInput = Schema.Struct({
  viewId: TeamViewId,
});
export type TeamDeleteViewInput = typeof TeamDeleteViewInput.Type;

export const TeamDeleteViewResult = Schema.Struct({
  deleted: Schema.Boolean,
  fallbackViewId: TeamViewId,
});
export type TeamDeleteViewResult = typeof TeamDeleteViewResult.Type;

export const TeamSetThreadViewInput = Schema.Struct({
  threadId: ThreadId,
  viewId: TeamViewId,
});
export type TeamSetThreadViewInput = typeof TeamSetThreadViewInput.Type;

export const TeamSetThreadLockedInput = Schema.Struct({
  threadId: ThreadId,
  locked: Schema.Boolean,
});
export type TeamSetThreadLockedInput = typeof TeamSetThreadLockedInput.Type;

export const TeamCreateInviteInput = Schema.Struct({
  role: TeamRole,
  prefilledPseudo: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  maxUses: Schema.optionalKey(PositiveInt),
  expiresInHours: Schema.optionalKey(PositiveInt),
});
export type TeamCreateInviteInput = typeof TeamCreateInviteInput.Type;

export const TeamRevokeInviteInput = Schema.Struct({
  inviteId: TeamInviteId,
});
export type TeamRevokeInviteInput = typeof TeamRevokeInviteInput.Type;

export const TeamRevokeInviteResult = Schema.Struct({
  revoked: Schema.Boolean,
});
export type TeamRevokeInviteResult = typeof TeamRevokeInviteResult.Type;

export const TeamListThreadAttributionsResult = Schema.Struct({
  attributions: Schema.Array(TeamThreadAttribution),
});
export type TeamListThreadAttributionsResult = typeof TeamListThreadAttributionsResult.Type;

export const TeamInvitePreviewRequest = Schema.Struct({
  token: TrimmedNonEmptyString,
});
export type TeamInvitePreviewRequest = typeof TeamInvitePreviewRequest.Type;

export const TeamInvitePreviewResult = Schema.Struct({
  teamId: TeamId,
  teamName: TrimmedNonEmptyString,
  role: TeamRole,
  prefilledPseudo: Schema.NullOr(TeamPseudo),
  expiresAt: IsoDateTime,
});
export type TeamInvitePreviewResult = typeof TeamInvitePreviewResult.Type;

export const TeamRedeemInviteRequest = Schema.Struct({
  token: TrimmedNonEmptyString,
  pseudo: TrimmedNonEmptyString,
  clientLabel: Schema.optionalKey(TrimmedNonEmptyString),
  clientDeviceType: Schema.optionalKey(AuthClientMetadataDeviceType),
  clientOs: Schema.optionalKey(TrimmedNonEmptyString),
});
export type TeamRedeemInviteRequest = typeof TeamRedeemInviteRequest.Type;

export const TeamRedeemInviteResponse = Schema.Struct({
  team: TeamWorkspace,
  member: TeamMember,
  accessToken: TrimmedNonEmptyString,
  tokenType: Schema.Literals(["Bearer", "DPoP"]),
  expiresIn: Schema.Number,
  scopes: Schema.Array(AuthEnvironmentScope),
});
export type TeamRedeemInviteResponse = typeof TeamRedeemInviteResponse.Type;

export const TeamAssignProjectInput = Schema.Struct({
  projectId: ProjectId,
  defaultViewId: Schema.optionalKey(Schema.NullOr(TeamViewId)),
  repoIdentityKey: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
});
export type TeamAssignProjectInput = typeof TeamAssignProjectInput.Type;

export const TeamUnassignProjectInput = Schema.Struct({
  projectId: ProjectId,
});
export type TeamUnassignProjectInput = typeof TeamUnassignProjectInput.Type;

export const TeamUnassignProjectResult = Schema.Struct({
  unassigned: Schema.Boolean,
});
export type TeamUnassignProjectResult = typeof TeamUnassignProjectResult.Type;

export const TeamAttachEnvironmentInput = Schema.Struct({
  /** Existing peer environment id when attaching an already-linked peer. */
  environmentId: Schema.optionalKey(EnvironmentId),
  /** Remote server URL + pairing code when linking and attaching a remote t3server in one step. */
  url: Schema.optionalKey(TrimmedNonEmptyString),
  pairingCode: Schema.optionalKey(TrimmedNonEmptyString),
  access: Schema.optionalKey(AuthMcpClientAccess),
  name: Schema.optionalKey(TrimmedNonEmptyString),
  accessRule: Schema.optionalKey(TeamAccessRule),
});
export type TeamAttachEnvironmentInput = typeof TeamAttachEnvironmentInput.Type;

export const TeamUpdateEnvironmentInput = Schema.Struct({
  environmentId: EnvironmentId,
  name: Schema.optionalKey(TrimmedNonEmptyString),
  accessRule: Schema.optionalKey(TeamAccessRule),
});
export type TeamUpdateEnvironmentInput = typeof TeamUpdateEnvironmentInput.Type;

export const TeamDetachEnvironmentInput = Schema.Struct({
  environmentId: EnvironmentId,
  unlinkPeer: Schema.optionalKey(Schema.Boolean),
});
export type TeamDetachEnvironmentInput = typeof TeamDetachEnvironmentInput.Type;

export const TeamDetachEnvironmentResult = Schema.Struct({
  detached: Schema.Boolean,
});
export type TeamDetachEnvironmentResult = typeof TeamDetachEnvironmentResult.Type;

export const TeamSyncedMessageSnapshot = Schema.Struct({
  id: TrimmedNonEmptyString,
  role: Schema.Literals(["user", "assistant", "system"]),
  text: Schema.String,
  runId: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: Schema.optionalKey(IsoDateTime),
});
export type TeamSyncedMessageSnapshot = typeof TeamSyncedMessageSnapshot.Type;

export const TeamSyncedRunSnapshot = Schema.Struct({
  id: TrimmedNonEmptyString,
  ordinal: NonNegativeInt,
  status: Schema.Literals([
    "queued",
    "starting",
    "running",
    "waiting",
    "completed",
    "failed",
    "interrupted",
    "cancelled",
    "rolled_back",
  ]),
  userMessageId: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
});
export type TeamSyncedRunSnapshot = typeof TeamSyncedRunSnapshot.Type;

export const TeamSyncLocalThreadInput = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  branch: Schema.NullOr(Schema.String),
  executionEnvironmentId: EnvironmentId,
  executionEnvironmentLabel: Schema.optionalKey(TrimmedNonEmptyString),
  viewId: Schema.optionalKey(TeamViewId),
  locked: Schema.optionalKey(Schema.Boolean),
  modelSelection: ModelSelection,
  runtimeMode: Schema.optionalKey(RuntimeMode),
  interactionMode: Schema.optionalKey(ProviderInteractionMode),
  runs: Schema.Array(TeamSyncedRunSnapshot),
  messages: Schema.Array(TeamSyncedMessageSnapshot),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type TeamSyncLocalThreadInput = typeof TeamSyncLocalThreadInput.Type;

export const TeamSyncLocalThreadResult = Schema.Struct({
  attribution: TeamThreadAttribution,
});
export type TeamSyncLocalThreadResult = typeof TeamSyncLocalThreadResult.Type;

export const TeamCreateThreadNoteInput = Schema.Struct({
  threadId: ThreadId,
  body: TrimmedNonEmptyString,
  anchorTurnId: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type TeamCreateThreadNoteInput = typeof TeamCreateThreadNoteInput.Type;

export const TeamDeleteThreadNoteInput = Schema.Struct({
  noteId: TeamThreadNoteId,
});
export type TeamDeleteThreadNoteInput = typeof TeamDeleteThreadNoteInput.Type;

export const TeamDeleteThreadNoteResult = Schema.Struct({
  deleted: Schema.Boolean,
});
export type TeamDeleteThreadNoteResult = typeof TeamDeleteThreadNoteResult.Type;

export const TeamResolveThreadNoteInput = Schema.Struct({
  noteId: TeamThreadNoteId,
  status: Schema.Literals(["pending", "accepted", "rejected"]),
  expectedContentHash: Schema.optionalKey(TrimmedNonEmptyString),
});
export type TeamResolveThreadNoteInput = typeof TeamResolveThreadNoteInput.Type;

export const TeamEditThreadNoteInput = Schema.Struct({
  noteId: TeamThreadNoteId,
  editedBody: TrimmedNonEmptyString,
  expectedOriginalContentHash: Schema.optionalKey(TrimmedNonEmptyString),
  status: Schema.optionalKey(Schema.Literals(["pending", "accepted"])),
});
export type TeamEditThreadNoteInput = typeof TeamEditThreadNoteInput.Type;

export const TeamConsumeAcceptedNotesInput = Schema.Struct({
  threadId: ThreadId,
  targetTurnId: TrimmedNonEmptyString,
  acceptedNotes: Schema.Array(TeamAcceptedNoteRef),
});
export type TeamConsumeAcceptedNotesInput = typeof TeamConsumeAcceptedNotesInput.Type;

export const TeamConsumeAcceptedNotesResult = Schema.Struct({
  consumedNotes: Schema.Array(TeamThreadNote),
  reanchoredNoteIds: Schema.Array(TeamThreadNoteId),
  formattedPromptPrefix: Schema.String,
});
export type TeamConsumeAcceptedNotesResult = typeof TeamConsumeAcceptedNotesResult.Type;

export const TeamListThreadNotesInput = Schema.Struct({
  threadId: ThreadId,
});
export type TeamListThreadNotesInput = typeof TeamListThreadNotesInput.Type;

export const TeamListThreadNotesResult = Schema.Struct({
  notes: Schema.Array(TeamThreadNote),
});
export type TeamListThreadNotesResult = typeof TeamListThreadNotesResult.Type;

export const TeamOperationErrorCode = Schema.Literals([
  "not_configured",
  "already_configured",
  "forbidden",
  "invalid_pseudo",
  "pseudo_taken",
  "invite_invalid",
  "invite_expired",
  "invite_exhausted",
  "invite_revoked",
  "last_owner",
  "default_view_protected",
  "view_name_taken",
  "default_environment_protected",
  "environment_already_attached",
  "environment_unavailable",
  "note_hash_mismatch",
  "note_not_pending",
  "note_already_consumed",
  "invalid_input",
  "not_found",
  "internal",
]);
export type TeamOperationErrorCode = typeof TeamOperationErrorCode.Type;

export class TeamOperationError extends Schema.TaggedError<TeamOperationError>()(
  "TeamOperationError",
  {
    code: TeamOperationErrorCode,
    message: Schema.String,
  },
) {}

export interface TeamJoinLinkTarget {
  readonly serverUrl: string;
  readonly token: string;
  readonly prefilledPseudo: string | null;
}

const TEAM_JOIN_DEEP_LINK_SCHEMES = new Set(["t3code:", "t3code-dev:"]);

export function buildTeamJoinDeepLink(input: {
  readonly serverUrl: string;
  readonly token: string;
  readonly prefilledPseudo?: string | null;
}): string {
  const url = new URL("t3code://team/join");
  url.searchParams.set("server", input.serverUrl.trim());
  url.searchParams.set("token", input.token.trim());
  const pseudo = input.prefilledPseudo?.trim();
  if (pseudo) {
    url.searchParams.set("pseudo", pseudo);
  }
  return url.toString();
}

/**
 * Web/hosted join link keeps the invite secret in the URL fragment (`#token=...`)
 * so it is never transmitted to a hosted web origin.
 */
export function buildTeamJoinWebUrl(input: {
  readonly appBaseUrl: string;
  readonly serverUrl: string;
  readonly token: string;
  readonly prefilledPseudo?: string | null;
}): string {
  const url = new URL("/team/join", input.appBaseUrl);
  url.searchParams.set("server", input.serverUrl.trim());
  const fragment = new URLSearchParams();
  fragment.set("token", input.token.trim());
  const pseudo = input.prefilledPseudo?.trim();
  if (pseudo) {
    fragment.set("pseudo", pseudo);
  }
  url.hash = fragment.toString();
  return url.toString();
}

export function parseTeamJoinLink(rawUrl: string): TeamJoinLinkTarget | null {
  const trimmed = rawUrl.trim();
  if (!trimmed || !URL.canParse(trimmed)) return null;
  const parsed = new URL(trimmed);

  const isDesktopScheme =
    TEAM_JOIN_DEEP_LINK_SCHEMES.has(parsed.protocol.toLowerCase()) &&
    parsed.hostname.toLowerCase() === "team" &&
    parsed.pathname.replace(/\/+$/, "").toLowerCase() === "/join";

  const isWebJoinRoute =
    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    parsed.pathname.replace(/\/+$/, "").toLowerCase() === "/team/join";

  if (!isDesktopScheme && !isWebJoinRoute) return null;

  const fragmentParams = new URLSearchParams(parsed.hash.replace(/^#/, ""));
  const serverUrl = (
    parsed.searchParams.get("server") ??
    fragmentParams.get("server") ??
    ""
  ).trim();
  const token = (fragmentParams.get("token") ?? parsed.searchParams.get("token") ?? "").trim();
  const rawPseudo = (
    fragmentParams.get("pseudo") ??
    parsed.searchParams.get("pseudo") ??
    ""
  ).trim();

  if (!serverUrl || !token || !URL.canParse(serverUrl)) return null;
  const serverProtocol = new URL(serverUrl).protocol;
  if (serverProtocol !== "http:" && serverProtocol !== "https:") return null;

  return {
    serverUrl,
    token,
    prefilledPseudo: rawPseudo.length > 0 ? rawPseudo : null,
  };
}
