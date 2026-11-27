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
  ScheduledTaskId,
  ThreadId,
  TrimmedNonEmptyString,
} from "../baseSchemas.ts";
import { ModelSelection } from "../modelSelection.ts";
import { ProviderDriverKind, ProviderInstanceId } from "../providerInstance.ts";
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

export const TeamProviderId = makeTeamEntityId("TeamProviderId");
export type TeamProviderId = typeof TeamProviderId.Type;

export const TeamSkillId = makeTeamEntityId("TeamSkillId");
export type TeamSkillId = typeof TeamSkillId.Type;

export const TeamPrepromptId = makeTeamEntityId("TeamPrepromptId");
export type TeamPrepromptId = typeof TeamPrepromptId.Type;

const TEAM_PROVIDER_INSTANCE_PREFIX = "team:";

const TEAM_VIRTUAL_INSTANCE_PATTERN = /^team:([a-zA-Z0-9_-]{1,64}):([a-zA-Z][a-zA-Z0-9_-]{0,63})$/;

export function makeTeamProviderInstanceId(
  teamId: TeamId,
  sourceInstanceId: ProviderInstanceId,
): ProviderInstanceId {
  return ProviderInstanceId.make(`${TEAM_PROVIDER_INSTANCE_PREFIX}${teamId}:${sourceInstanceId}`);
}

export function parseTeamProviderInstanceId(instanceId: string): {
  readonly teamId: TeamId;
  readonly sourceInstanceId: ProviderInstanceId;
} | null {
  const match = TEAM_VIRTUAL_INSTANCE_PATTERN.exec(instanceId);
  if (!match) return null;
  return {
    teamId: TeamId.make(match[1]!),
    sourceInstanceId: ProviderInstanceId.make(match[2]!),
  };
}

export function isTeamProviderInstanceId(instanceId: string): boolean {
  return parseTeamProviderInstanceId(instanceId) !== null;
}

export function isTeamProviderInstanceIdForTeam(instanceId: string, teamId: TeamId): boolean {
  const parsed = parseTeamProviderInstanceId(instanceId);
  return parsed !== null && parsed.teamId === teamId;
}

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

/** Provider auth and configuration is strictly restricted to owner/admin on the Team Server. */
export function canManageTeamProviders(role: TeamRole): boolean {
  return isTeamAdminRole(role);
}

/** Team skills & pre-prompts can be curated by owner, admin, and modo. */
export function canManageTeamSkills(role: TeamRole): boolean {
  return TEAM_ROLE_RANK[role] >= TEAM_ROLE_RANK.modo;
}

export function canManageTeamPreprompts(role: TeamRole): boolean {
  return TEAM_ROLE_RANK[role] >= TEAM_ROLE_RANK.modo;
}

/** Optional dedicated Team Automation GitHub account is configurable by owner/admin only. */
export function canManageTeamAutomationGitHub(role: TeamRole): boolean {
  return isTeamAdminRole(role);
}

/** Team GitHub OAuth / GitHub App configuration is restricted to owner/admin only. */
export function canManageTeamGitHubAppConfig(role: TeamRole): boolean {
  return isTeamAdminRole(role);
}

/** Editing team displayName is restricted to owner/admin. */
export function canManageTeamDisplayName(role: TeamRole): boolean {
  return isTeamAdminRole(role);
}

/** Creating/editing/toggling/deleting/running minimal unlocked team scheduled tasks starts at modo. */
export function canManageTeamScheduledTasks(role: TeamRole): boolean {
  return TEAM_ROLE_RANK[role] >= TEAM_ROLE_RANK.modo;
}

/** Creating/editing/deleting locked or elevated-MCP team scheduled tasks is restricted to owner/admin. */
export function canManagePrivilegedTeamScheduledTasks(role: TeamRole): boolean {
  return isTeamAdminRole(role);
}

/** Resolves effective team displayName: copies `name` when `displayName` is omitted or blank after trim. */
export function resolveTeamDisplayName(name: string, displayName?: string | null): string {
  const trimmedDisplay = displayName?.trim() ?? "";
  return trimmedDisplay.length > 0 ? trimmedDisplay : name.trim();
}

/** Regular authors require an explicit UI confirmation dialog before note approval/edit-approval. */
export function requiresTeamNoteApprovalConfirmation(authorRole: TeamRole): boolean {
  return authorRole === "regular";
}

export const TeamMemberStatus = Schema.Literals(["active", "suspended", "removed"]);
export type TeamMemberStatus = typeof TeamMemberStatus.Type;

export const TEAM_NOTIFICATION_SOUND_PRESETS = [
  "chime",
  "bell",
  "marimba",
  "pulse",
  "classic",
  "off",
] as const;
export const TeamNotificationSoundPreset = Schema.Literals(TEAM_NOTIFICATION_SOUND_PRESETS);
export type TeamNotificationSoundPreset = typeof TeamNotificationSoundPreset.Type;
export const DEFAULT_TEAM_NOTIFICATION_SOUND: TeamNotificationSoundPreset = "chime";

export const TEAM_CLIENT_CAPABILITY_HEADER = "x-t3-teams-client";
export const TEAM_CLIENT_CAPABILITY_QUERY_PARAM = "t3TeamsClient";
export const TEAM_CLIENT_CAPABILITY_VALUE = "1";

export const TeamUpstreamClientThreadVisibility = Schema.Literals([
  "owned_and_followed",
  "all_accessible",
]);
export type TeamUpstreamClientThreadVisibility = typeof TeamUpstreamClientThreadVisibility.Type;

export const DEFAULT_UPSTREAM_CLIENT_THREAD_VISIBILITY: TeamUpstreamClientThreadVisibility =
  "owned_and_followed";

export function effectiveUpstreamClientThreadVisibility(
  member: Pick<TeamMember, "upstreamClientThreadVisibility"> | null | undefined,
): TeamUpstreamClientThreadVisibility {
  return member?.upstreamClientThreadVisibility ?? DEFAULT_UPSTREAM_CLIENT_THREAD_VISIBILITY;
}

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
  displayName: TrimmedNonEmptyString,
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
  upstreamClientThreadVisibility: Schema.optionalKey(TeamUpstreamClientThreadVisibility),
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
export const TeamThreadOwnerKind = Schema.Literals(["member", "team"]);
export type TeamThreadOwnerKind = typeof TeamThreadOwnerKind.Type;

export const TeamTurnAuthorKind = Schema.Literals(["member", "team_automation"]);
export type TeamTurnAuthorKind = typeof TeamTurnAuthorKind.Type;

export const TeamScheduledTaskMcpAccessLevel = Schema.Literals(["minimal", "elevated"]);
export type TeamScheduledTaskMcpAccessLevel = typeof TeamScheduledTaskMcpAccessLevel.Type;

export const TeamScheduledTaskScope = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("personal"),
    teamId: Schema.Null,
    environmentId: EnvironmentId,
  }),
  Schema.Struct({
    kind: Schema.Literal("team"),
    teamId: TeamId,
    environmentId: EnvironmentId,
  }),
]);
export type TeamScheduledTaskScope = typeof TeamScheduledTaskScope.Type;

/**
 * Resolves internal `(teamScope, environmentId)` scoping for scheduled tasks.
 * Non-team environments map to a virtual `"personal"` scope in code (hidden in UI).
 */
export function resolveScheduledTaskScope(
  teamId: TeamId | null | undefined,
  environmentId: EnvironmentId,
): TeamScheduledTaskScope {
  if (teamId != null) {
    return { kind: "team", teamId, environmentId };
  }
  return { kind: "personal", teamId: null, environmentId };
}

export const TeamScheduledTaskMeta = Schema.Struct({
  taskId: ScheduledTaskId,
  teamId: TeamId,
  environmentId: EnvironmentId,
  viewId: TeamViewId,
  locked: Schema.Boolean,
  mcpAccessLevel: TeamScheduledTaskMcpAccessLevel,
  createdByMemberId: Schema.NullOr(TeamMemberId),
  updatedByMemberId: Schema.NullOr(TeamMemberId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type TeamScheduledTaskMeta = typeof TeamScheduledTaskMeta.Type;

export const TeamScheduledTaskMetaDeletedPayload = Schema.Struct({
  taskId: ScheduledTaskId,
});
export type TeamScheduledTaskMetaDeletedPayload = typeof TeamScheduledTaskMetaDeletedPayload.Type;

export const TeamScheduledTaskUpsertMetaInput = Schema.Struct({
  environmentId: Schema.optionalKey(EnvironmentId),
  viewId: Schema.optionalKey(TeamViewId),
  locked: Schema.optionalKey(Schema.Boolean),
  mcpAccessLevel: Schema.optionalKey(TeamScheduledTaskMcpAccessLevel),
});
export type TeamScheduledTaskUpsertMetaInput = typeof TeamScheduledTaskUpsertMetaInput.Type;

export function isTeamOwnedThreadAttribution(
  attribution: Pick<TeamThreadAttribution, "ownerKind" | "creatorMemberId"> | null | undefined,
): boolean {
  if (!attribution) return false;
  return attribution.ownerKind === "team" || attribution.creatorMemberId === null;
}

export function canMemberReadTeamScheduledTask(input: {
  readonly member: Pick<TeamMember, "id" | "role" | "status"> | null | undefined;
  readonly environment: Pick<TeamEnvironment, "accessRule"> | null | undefined;
  readonly view: Pick<TeamView, "readRule"> | null | undefined;
}): boolean {
  if (!input.member || input.member.status !== "active") return false;
  if (!canMemberAccessTeamEnvironment(input.member, input.environment)) return false;
  return canMemberReadTeamView(input.member, input.view);
}

export function canMemberMutateTeamScheduledTask(input: {
  readonly member: Pick<TeamMember, "id" | "role" | "status"> | null | undefined;
  readonly environment: Pick<TeamEnvironment, "accessRule"> | null | undefined;
  readonly view: Pick<TeamView, "readRule"> | null | undefined;
  readonly existingMeta?: Pick<TeamScheduledTaskMeta, "locked" | "mcpAccessLevel"> | null;
  readonly nextLocked?: boolean;
  readonly nextMcpAccessLevel?: TeamScheduledTaskMcpAccessLevel;
}): boolean {
  const { member, environment, view, existingMeta, nextLocked, nextMcpAccessLevel } = input;
  if (!member || member.status !== "active") return false;
  if (!canManageTeamScheduledTasks(member.role)) return false;
  if (!canMemberReadTeamScheduledTask({ member, environment, view })) return false;
  const existingPrivileged =
    existingMeta != null && (existingMeta.locked || existingMeta.mcpAccessLevel === "elevated");
  const nextPrivileged = nextLocked === true || nextMcpAccessLevel === "elevated";
  if (
    (existingPrivileged || nextPrivileged) &&
    !canManagePrivilegedTeamScheduledTasks(member.role)
  ) {
    return false;
  }
  return true;
}

/**
 * Webhook URLs/tokens can trigger automation runs, so they are redacted for `regular`
 * members and for `modo` on `elevated` or `locked` tasks.
 */
export function canMemberSeeTeamScheduledTaskWebhook(input: {
  readonly member: Pick<TeamMember, "id" | "role" | "status"> | null | undefined;
  readonly environment: Pick<TeamEnvironment, "accessRule"> | null | undefined;
  readonly view: Pick<TeamView, "readRule"> | null | undefined;
  readonly meta: Pick<TeamScheduledTaskMeta, "locked" | "mcpAccessLevel"> | null | undefined;
}): boolean {
  return canMemberMutateTeamScheduledTask({
    member: input.member,
    environment: input.environment,
    view: input.view,
    existingMeta: input.meta ?? null,
  });
}

export function canMemberLeaveTeamThreadNote(input: {
  readonly member: Pick<TeamMember, "id" | "role" | "status"> | null | undefined;
  readonly attribution: Pick<TeamThreadAttribution, "ownerKind" | "creatorMemberId" | "locked">;
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
      attribution.executionEnvironmentLabel ??
      `${attribution.creatorPseudo ?? "Member"}'s local environment`;
    if (
      viewingOnLocalExecutionEnvironment &&
      attribution.creatorMemberId !== null &&
      attribution.creatorMemberId === member.id
    ) {
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
  readonly attribution: Pick<TeamThreadAttribution, "ownerKind" | "creatorMemberId" | "locked">;
  readonly view: Pick<TeamView, "readRule" | "postRule"> | null | undefined;
}): TeamThreadPostBlockReason {
  const { member, attribution, view } = input;
  if (!canMemberReadTeamThread({ member, view }) || !member) {
    return "no_access";
  }
  if (attribution.locked) {
    return isTeamAdminRole(member.role) ? "ok" : "locked";
  }
  if (isTeamOwnedThreadAttribution(attribution)) {
    // Unlocked team-owned threads allow owner/admin/modo (who can read its View), plus regular per postRule.
    if (TEAM_ROLE_RANK[member.role] >= TEAM_ROLE_RANK.modo) {
      return "ok";
    }
    if (view && matchesTeamAccessRule(view.postRule, member)) {
      return "ok";
    }
    return "view_read_only";
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
  readonly attribution: Pick<TeamThreadAttribution, "ownerKind" | "creatorMemberId" | "locked">;
  readonly view: Pick<TeamView, "readRule" | "postRule"> | null | undefined;
}): boolean {
  return resolveTeamThreadPostBlockReason(input) === "ok";
}

/**
 * Only the thread creator may steer an active turn or promote a queued run (`Send now`).
 * Even `owner` and `admin` cannot steer/promote on someone else's thread, and nobody may
 * `Send now` / steer on team-owned threads or active automation runs.
 */
export function canMemberSteerActiveTeamTurn(input: {
  readonly member: Pick<TeamMember, "id" | "role" | "status"> | null | undefined;
  readonly attribution:
    | Pick<TeamThreadAttribution, "ownerKind" | "creatorMemberId" | "locked">
    | null
    | undefined;
  readonly view?: Pick<TeamView, "readRule" | "postRule"> | null | undefined;
  readonly activeTurnAuthorKind?: TeamTurnAuthorKind | null | undefined;
}): boolean {
  const { member, attribution, view, activeTurnAuthorKind } = input;
  if (!member || member.status !== "active" || !attribution) return false;
  if (isTeamOwnedThreadAttribution(attribution)) return false;
  if (activeTurnAuthorKind === "team_automation") return false;
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
 * Team turn interrupt rules:
 * - `owner` and `admin` can always interrupt (including locked and team-owned threads) when they can read the thread.
 * - `modo` can interrupt active turns on unlocked threads they can read (including colleagues' turns and unlocked team-owned runs).
 * - `regular` (or any active readable member) can interrupt their own active turn or their own unlocked member-owned thread.
 */
export function canMemberInterruptTeamTurn(input: {
  readonly member: Pick<TeamMember, "id" | "role" | "status"> | null | undefined;
  readonly attribution:
    | Pick<TeamThreadAttribution, "ownerKind" | "creatorMemberId" | "locked">
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
  if (!attribution || attribution.locked) {
    return false;
  }
  if (member.role === "modo") {
    return true;
  }
  if (!isTeamOwnedThreadAttribution(attribution) && attribution.creatorMemberId === member.id) {
    return true;
  }
  return false;
}

/**
 * Runtime approval / user-input response rules: restricted to `owner`/`admin`, the active turn
 * author, or the thread creator (on unlocked member-owned threads). `modo` may interrupt an
 * unlocked foreign turn, but cannot approve tool executions or answer prompts under another
 * member's credentials.
 */
export function canMemberRespondToTeamRuntimeRequest(input: {
  readonly member: Pick<TeamMember, "id" | "role" | "status"> | null | undefined;
  readonly attribution:
    | Pick<TeamThreadAttribution, "ownerKind" | "creatorMemberId" | "locked">
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
  if (!attribution || attribution.locked) {
    return false;
  }
  if (!isTeamOwnedThreadAttribution(attribution) && attribution.creatorMemberId === member.id) {
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
    | Pick<TeamThreadAttribution, "ownerKind" | "creatorMemberId" | "locked">
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
  if (
    attribution &&
    !isTeamOwnedThreadAttribution(attribution) &&
    attribution.creatorMemberId === member.id
  ) {
    return true;
  }
  if (queuedRunAuthorMemberId != null && queuedRunAuthorMemberId === member.id) return true;
  return false;
}

export const TeamThreadAttribution = Schema.Struct({
  threadId: ThreadId,
  teamId: TeamId,
  ownerKind: Schema.optionalKey(TeamThreadOwnerKind),
  creatorMemberId: Schema.NullOr(TeamMemberId),
  creatorPseudo: Schema.NullOr(TeamPseudo),
  teamDisplayName: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
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
  authorKind: Schema.optionalKey(TeamTurnAuthorKind),
  authorMemberId: Schema.NullOr(TeamMemberId),
  authorPseudo: Schema.NullOr(TeamPseudo),
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

export const TeamProviderDeliveryStrategy = Schema.Literals([
  "proxy",
  "token-lease",
  "remote-only",
]);
export type TeamProviderDeliveryStrategy = typeof TeamProviderDeliveryStrategy.Type;

const TEAM_TOKEN_LEASE_DRIVERS: ReadonlySet<string> = new Set([
  "antigravity",
  "codex",
  "claudeAgent",
]);

/**
 * Classifies the safe default local delivery strategy for a driver. Drivers that cannot be
 * safely proxied or leased without exposing a refresh token default to `remote-only`.
 */
export function defaultTeamProviderDeliveryStrategy(
  driver: ProviderDriverKind,
  options?: { readonly hasUpstreamBaseUrl?: boolean },
): TeamProviderDeliveryStrategy {
  if (options?.hasUpstreamBaseUrl) {
    return "proxy";
  }
  if (TEAM_TOKEN_LEASE_DRIVERS.has(driver)) {
    return "token-lease";
  }
  return "remote-only";
}

export const TeamProvider = Schema.Struct({
  id: TeamProviderId,
  teamId: TeamId,
  providerInstanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  displayName: Schema.NullOr(TrimmedNonEmptyString),
  deliveryStrategy: TeamProviderDeliveryStrategy,
  hasSecret: Schema.Boolean,
  upstreamBaseUrl: Schema.NullOr(TrimmedNonEmptyString),
  apiKeyHeader: Schema.NullOr(TrimmedNonEmptyString),
  apiKeyPrefix: Schema.NullOr(Schema.String),
  config: Schema.Record(Schema.String, Schema.Unknown),
  enabled: Schema.Boolean,
  updatedByMemberId: TeamMemberId,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type TeamProvider = typeof TeamProvider.Type;

export const TeamProviderDeletedPayload = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
});
export type TeamProviderDeletedPayload = typeof TeamProviderDeletedPayload.Type;

export const TeamProviderUsageSummary = Schema.Struct({
  memberId: TeamMemberId,
  memberPseudo: TeamPseudo,
  providerInstanceId: ProviderInstanceId,
  strategy: Schema.Literals(["proxy", "token-lease"]),
  requestCount: NonNegativeInt,
  lastUsedAt: IsoDateTime,
});
export type TeamProviderUsageSummary = typeof TeamProviderUsageSummary.Type;

export const TeamListProviderUsageResult = Schema.Struct({
  usage: Schema.Array(TeamProviderUsageSummary),
});
export type TeamListProviderUsageResult = typeof TeamListProviderUsageResult.Type;

const TEAM_SKILL_SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const TeamSkillSlug = TrimmedNonEmptyString.check(Schema.isPattern(TEAM_SKILL_SLUG_PATTERN));
export type TeamSkillSlug = typeof TeamSkillSlug.Type;

export const TeamAssetProviderDriver = Schema.Union([Schema.Literal("*"), ProviderDriverKind]);
export type TeamAssetProviderDriver = typeof TeamAssetProviderDriver.Type;

export const TeamSkillReference = Schema.Struct({
  path: TrimmedNonEmptyString,
  content: Schema.String,
});
export type TeamSkillReference = typeof TeamSkillReference.Type;

export const TeamSkill = Schema.Struct({
  id: TeamSkillId,
  teamId: TeamId,
  slug: TeamSkillSlug,
  providerDriver: TeamAssetProviderDriver,
  skillMd: Schema.String,
  references: Schema.Array(TeamSkillReference),
  enabled: Schema.Boolean,
  revision: NonNegativeInt,
  contentHash: TrimmedNonEmptyString,
  updatedByMemberId: TeamMemberId,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type TeamSkill = typeof TeamSkill.Type;

export const TeamSkillDeletedPayload = Schema.Struct({
  skillId: TeamSkillId,
  revision: NonNegativeInt,
});
export type TeamSkillDeletedPayload = typeof TeamSkillDeletedPayload.Type;

export const TeamPrepromptInjectionScope = Schema.Literals(["thread", "turn"]);
export type TeamPrepromptInjectionScope = typeof TeamPrepromptInjectionScope.Type;

export const TeamPreprompt = Schema.Struct({
  id: TeamPrepromptId,
  teamId: TeamId,
  name: TrimmedNonEmptyString,
  providerDriver: TeamAssetProviderDriver,
  injectionScope: TeamPrepromptInjectionScope,
  content: Schema.String,
  enabled: Schema.Boolean,
  revision: NonNegativeInt,
  contentHash: TrimmedNonEmptyString,
  updatedByMemberId: TeamMemberId,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type TeamPreprompt = typeof TeamPreprompt.Type;

export const TeamPrepromptDeletedPayload = Schema.Struct({
  prepromptId: TeamPrepromptId,
  revision: NonNegativeInt,
});
export type TeamPrepromptDeletedPayload = typeof TeamPrepromptDeletedPayload.Type;

export const TeamAssetsUpdatedPayload = Schema.Struct({
  teamId: TeamId,
  revision: NonNegativeInt,
});
export type TeamAssetsUpdatedPayload = typeof TeamAssetsUpdatedPayload.Type;

export const TeamAssetsDeltaResponse = Schema.Struct({
  teamId: TeamId,
  revision: NonNegativeInt,
  fullSync: Schema.Boolean,
  skills: Schema.Array(TeamSkill),
  preprompts: Schema.Array(TeamPreprompt),
  deletedSkillIds: Schema.Array(TeamSkillId),
  deletedPrepromptIds: Schema.Array(TeamPrepromptId),
});
export type TeamAssetsDeltaResponse = typeof TeamAssetsDeltaResponse.Type;

export const TeamProviderLeaseRequest = Schema.Struct({
  forceRefresh: Schema.optionalKey(Schema.Boolean),
});
export type TeamProviderLeaseRequest = typeof TeamProviderLeaseRequest.Type;

/**
 * Ephemeral OAuth access token lease returned by `POST /api/team/provider-lease/:providerInstanceId`.
 * Explicitly omits `refresh_token` / `refreshToken` so refresh credentials never leave the Team Server.
 */
export const TeamProviderLeaseResponse = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  accessToken: TrimmedNonEmptyString,
  tokenType: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
  expiresInSeconds: NonNegativeInt,
  email: Schema.optionalKey(Schema.NullOr(Schema.String)),
  authMethod: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type TeamProviderLeaseResponse = typeof TeamProviderLeaseResponse.Type;

export const TeamGitHubAuthMethod = Schema.Literals(["pat", "oauth", "github_app"]);
export type TeamGitHubAuthMethod = typeof TeamGitHubAuthMethod.Type;

export const TeamGitHubOAuthMode = Schema.Literals(["oauth", "github_app"]);
export type TeamGitHubOAuthMode = typeof TeamGitHubOAuthMode.Type;

export const DEFAULT_GITHUB_WEB_BASE_URL = "https://github.com";
export const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";
export const DEFAULT_GITHUB_OAUTH_SCOPES = "repo read:user user:email";

/**
 * Safe read model for a team's GitHub OAuth / GitHub App configuration.
 * Never exposes `clientSecret` — only a boolean `hasClientSecret` indicator.
 */
export const TeamGitHubAppConfig = Schema.Struct({
  enabled: Schema.Boolean,
  mode: TeamGitHubOAuthMode,
  clientId: TrimmedNonEmptyString,
  webBaseUrl: TrimmedNonEmptyString,
  apiBaseUrl: TrimmedNonEmptyString,
  scopes: Schema.String,
  hasClientSecret: Schema.Boolean,
  updatedByMemberId: Schema.optionalKey(TeamMemberId),
  updatedAt: IsoDateTime,
});
export type TeamGitHubAppConfig = typeof TeamGitHubAppConfig.Type;

export const TeamGitHubAppConfigUpdatedPayload = Schema.Struct({
  config: Schema.NullOr(TeamGitHubAppConfig),
});
export type TeamGitHubAppConfigUpdatedPayload = typeof TeamGitHubAppConfigUpdatedPayload.Type;

/**
 * Safe read model for a connected GitHub identity. Never includes raw tokens or secrets.
 */
export const TeamGitHubIdentity = Schema.Struct({
  authMethod: TeamGitHubAuthMethod,
  githubLogin: TrimmedNonEmptyString,
  githubName: Schema.NullOr(TrimmedNonEmptyString),
  githubEmail: Schema.NullOr(TrimmedNonEmptyString),
  apiBaseUrl: TrimmedNonEmptyString,
  connectedAt: IsoDateTime,
  updatedAt: IsoDateTime,
  tokenExpiresAt: Schema.optionalKey(Schema.NullOr(IsoDateTime)),
  hasRefreshToken: Schema.optionalKey(Schema.Boolean),
  needsReconnect: Schema.optionalKey(Schema.Boolean),
  reconnectReason: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type TeamGitHubIdentity = typeof TeamGitHubIdentity.Type;

export const TeamAutomationGitHubIdentity = Schema.Struct({
  authMethod: TeamGitHubAuthMethod,
  githubLogin: TrimmedNonEmptyString,
  githubName: Schema.NullOr(TrimmedNonEmptyString),
  githubEmail: Schema.NullOr(TrimmedNonEmptyString),
  apiBaseUrl: TrimmedNonEmptyString,
  updatedByMemberId: TeamMemberId,
  connectedAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type TeamAutomationGitHubIdentity = typeof TeamAutomationGitHubIdentity.Type;

export const TeamMyGitHubIdentityUpdatedPayload = Schema.Struct({
  memberId: TeamMemberId,
  identity: Schema.NullOr(TeamGitHubIdentity),
});
export type TeamMyGitHubIdentityUpdatedPayload = typeof TeamMyGitHubIdentityUpdatedPayload.Type;

export const TeamAutomationGitHubIdentityUpdatedPayload = Schema.Struct({
  identity: Schema.NullOr(TeamAutomationGitHubIdentity),
});
export type TeamAutomationGitHubIdentityUpdatedPayload =
  typeof TeamAutomationGitHubIdentityUpdatedPayload.Type;

export const TeamConnectMyGitHubInput = Schema.Struct({
  authMethod: Schema.optionalKey(TeamGitHubAuthMethod),
  /** Write-only GitHub token (fine-grained PAT in Phase 7a); encrypted in ServerSecretStore. */
  token: TrimmedNonEmptyString,
  /** Optional GitHub API base URL (defaults to https://api.github.com; supports GHE / testing). */
  apiBaseUrl: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  /** Optional git author display name override (defaults to verified GitHub profile name/login). */
  githubName: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  /** Optional git author email override (defaults to verified GitHub email or noreply address). */
  githubEmail: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
});
export type TeamConnectMyGitHubInput = typeof TeamConnectMyGitHubInput.Type;

export const TeamDisconnectMyGitHubResult = Schema.Struct({
  disconnected: Schema.Boolean,
});
export type TeamDisconnectMyGitHubResult = typeof TeamDisconnectMyGitHubResult.Type;

export const TeamSetAutomationGitHubInput = Schema.Struct({
  authMethod: Schema.optionalKey(TeamGitHubAuthMethod),
  token: TrimmedNonEmptyString,
  apiBaseUrl: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  githubName: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  githubEmail: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
});
export type TeamSetAutomationGitHubInput = typeof TeamSetAutomationGitHubInput.Type;

export const TeamClearAutomationGitHubResult = Schema.Struct({
  cleared: Schema.Boolean,
});
export type TeamClearAutomationGitHubResult = typeof TeamClearAutomationGitHubResult.Type;

export const TeamSetGitHubAppConfigInput = Schema.Struct({
  mode: TeamGitHubOAuthMode,
  clientId: TrimmedNonEmptyString,
  /** Write-only client secret; omit when updating to keep existing secret, or pass clearClientSecret: true. */
  clientSecret: Schema.optionalKey(Schema.NullOr(Schema.String)),
  clearClientSecret: Schema.optionalKey(Schema.Boolean),
  webBaseUrl: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  apiBaseUrl: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  scopes: Schema.optionalKey(Schema.NullOr(Schema.String)),
  enabled: Schema.optionalKey(Schema.Boolean),
});
export type TeamSetGitHubAppConfigInput = typeof TeamSetGitHubAppConfigInput.Type;

export const TeamClearGitHubAppConfigResult = Schema.Struct({
  cleared: Schema.Boolean,
});
export type TeamClearGitHubAppConfigResult = typeof TeamClearGitHubAppConfigResult.Type;

export const TeamStartGitHubOAuthInput = Schema.Struct({
  redirectBaseUrl: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  githubName: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  githubEmail: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
});
export type TeamStartGitHubOAuthInput = typeof TeamStartGitHubOAuthInput.Type;

export const TeamStartGitHubOAuthResult = Schema.Struct({
  authorizeUrl: TrimmedNonEmptyString,
  state: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
  callbackUrl: TrimmedNonEmptyString,
});
export type TeamStartGitHubOAuthResult = typeof TeamStartGitHubOAuthResult.Type;

export const TeamCompleteGitHubOAuthInput = Schema.Struct({
  state: TrimmedNonEmptyString,
  confirmationCode: TrimmedNonEmptyString,
});
export type TeamCompleteGitHubOAuthInput = typeof TeamCompleteGitHubOAuthInput.Type;

export const TeamStartGitHubDeviceFlowInput = Schema.Struct({
  githubName: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  githubEmail: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
});
export type TeamStartGitHubDeviceFlowInput = typeof TeamStartGitHubDeviceFlowInput.Type;

export const TeamStartGitHubDeviceFlowResult = Schema.Struct({
  deviceFlowId: TrimmedNonEmptyString,
  userCode: TrimmedNonEmptyString,
  verificationUri: TrimmedNonEmptyString,
  verificationUriComplete: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  expiresAt: IsoDateTime,
  intervalSeconds: PositiveInt,
});
export type TeamStartGitHubDeviceFlowResult = typeof TeamStartGitHubDeviceFlowResult.Type;

export const TeamPollGitHubDeviceFlowInput = Schema.Struct({
  deviceFlowId: TrimmedNonEmptyString,
});
export type TeamPollGitHubDeviceFlowInput = typeof TeamPollGitHubDeviceFlowInput.Type;

export const TeamGitHubDeviceFlowStatus = Schema.Literals([
  "pending",
  "completed",
  "expired",
  "denied",
  "failed",
]);
export type TeamGitHubDeviceFlowStatus = typeof TeamGitHubDeviceFlowStatus.Type;

export const TeamPollGitHubDeviceFlowResult = Schema.Struct({
  status: TeamGitHubDeviceFlowStatus,
  intervalSeconds: PositiveInt,
  identity: Schema.optionalKey(Schema.NullOr(TeamGitHubIdentity)),
  errorMessage: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type TeamPollGitHubDeviceFlowResult = typeof TeamPollGitHubDeviceFlowResult.Type;

export const TeamCancelGitHubDeviceFlowInput = Schema.Struct({
  deviceFlowId: TrimmedNonEmptyString,
});
export type TeamCancelGitHubDeviceFlowInput = typeof TeamCancelGitHubDeviceFlowInput.Type;

export const TeamCancelGitHubDeviceFlowResult = Schema.Struct({
  cancelled: Schema.Boolean,
});
export type TeamCancelGitHubDeviceFlowResult = typeof TeamCancelGitHubDeviceFlowResult.Type;

export const TeamGitHubTurnAuthorKind = Schema.Literals(["member", "team_automation"]);
export type TeamGitHubTurnAuthorKind = typeof TeamGitHubTurnAuthorKind.Type;

export const TeamGitHubRemoteLeaseIssueRequest = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  turnId: TrimmedNonEmptyString,
  authorKind: Schema.optionalKey(TeamGitHubTurnAuthorKind),
  authorMemberId: Schema.optionalKey(Schema.NullOr(TeamMemberId)),
});
export type TeamGitHubRemoteLeaseIssueRequest = typeof TeamGitHubRemoteLeaseIssueRequest.Type;

export const TeamGitHubRemoteLeaseIssueResponse = Schema.Struct({
  hasCredential: Schema.Boolean,
  leaseId: Schema.NullOr(TrimmedNonEmptyString),
  leaseToken: Schema.NullOr(TrimmedNonEmptyString),
  expiresAt: Schema.NullOr(IsoDateTime),
  identity: Schema.NullOr(TeamGitHubIdentity),
});
export type TeamGitHubRemoteLeaseIssueResponse = typeof TeamGitHubRemoteLeaseIssueResponse.Type;

export const TeamGitHubRemoteLeaseResolveRequest = Schema.Struct({
  leaseId: TrimmedNonEmptyString,
  leaseToken: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  turnId: TrimmedNonEmptyString,
});
export type TeamGitHubRemoteLeaseResolveRequest = typeof TeamGitHubRemoteLeaseResolveRequest.Type;

export const TeamGitHubRemoteLeaseResolveResponse = Schema.Struct({
  token: TrimmedNonEmptyString,
  authMethod: TeamGitHubAuthMethod,
  githubLogin: TrimmedNonEmptyString,
  githubName: Schema.NullOr(TrimmedNonEmptyString),
  githubEmail: Schema.NullOr(TrimmedNonEmptyString),
  apiBaseUrl: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
});
export type TeamGitHubRemoteLeaseResolveResponse = typeof TeamGitHubRemoteLeaseResolveResponse.Type;

export const TeamGitHubRemoteLeaseRevokeRequest = Schema.Struct({
  leaseId: Schema.optionalKey(TrimmedNonEmptyString),
  leaseToken: Schema.optionalKey(TrimmedNonEmptyString),
  environmentId: Schema.optionalKey(EnvironmentId),
  threadId: Schema.optionalKey(ThreadId),
  turnId: Schema.optionalKey(TrimmedNonEmptyString),
});
export type TeamGitHubRemoteLeaseRevokeRequest = typeof TeamGitHubRemoteLeaseRevokeRequest.Type;

export const TeamGitHubRemoteLeaseRevokeResponse = Schema.Struct({
  revoked: Schema.Boolean,
});
export type TeamGitHubRemoteLeaseRevokeResponse = typeof TeamGitHubRemoteLeaseRevokeResponse.Type;

export const TeamQueuedMessageNotification = Schema.Struct({
  threadId: ThreadId,
  queuedRunId: TrimmedNonEmptyString,
  commandId: Schema.optionalKey(TrimmedNonEmptyString),
  senderMemberId: Schema.NullOr(TeamMemberId),
  senderPseudo: TrimmedNonEmptyString,
  recipientMemberIds: Schema.Array(TeamMemberId),
  messagePreview: Schema.String,
  createdAt: IsoDateTime,
});
export type TeamQueuedMessageNotification = typeof TeamQueuedMessageNotification.Type;

/**
 * Resolves the human candidate recipients for a mid-turn queued-message notification:
 * - the thread creator (when member-owned and distinct from the queued-message sender), and
 * - the active turn author (when human and distinct from both the sender and the thread creator).
 * Callers must still verify each candidate is active and permitted to read the thread.
 */
export function resolveTeamQueuedMessageNotificationRecipients(input: {
  readonly senderMemberId: TeamMemberId | null | undefined;
  readonly attribution:
    | Pick<TeamThreadAttribution, "ownerKind" | "creatorMemberId">
    | null
    | undefined;
  readonly activeTurnAuthorMemberId?: TeamMemberId | null | undefined;
}): ReadonlyArray<TeamMemberId> {
  const { senderMemberId, attribution, activeTurnAuthorMemberId } = input;
  if (!attribution) return [];
  const recipients: Array<TeamMemberId> = [];
  if (
    !isTeamOwnedThreadAttribution(attribution) &&
    attribution.creatorMemberId !== null &&
    attribution.creatorMemberId !== senderMemberId
  ) {
    recipients.push(attribution.creatorMemberId);
  }
  if (
    activeTurnAuthorMemberId != null &&
    activeTurnAuthorMemberId !== senderMemberId &&
    !recipients.includes(activeTurnAuthorMemberId)
  ) {
    recipients.push(activeTurnAuthorMemberId);
  }
  return recipients;
}

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
  providers: Schema.optionalKey(Schema.Array(TeamProvider)),
  skills: Schema.optionalKey(Schema.Array(TeamSkill)),
  preprompts: Schema.optionalKey(Schema.Array(TeamPreprompt)),
  assetsRevision: Schema.optionalKey(NonNegativeInt),
  /** Strictly scoped to `currentMember` — never populated for other members. */
  myGitHubIdentity: Schema.optionalKey(Schema.NullOr(TeamGitHubIdentity)),
  /** Visible only to `owner`/`admin` — null for `modo`/`regular`. */
  automationGitHubIdentity: Schema.optionalKey(Schema.NullOr(TeamAutomationGitHubIdentity)),
  /** Safe team-level GitHub OAuth / GitHub App configuration (never includes `clientSecret`). */
  githubAppConfig: Schema.optionalKey(Schema.NullOr(TeamGitHubAppConfig)),
  /** Sidecar metadata for team scheduled tasks visible to `currentMember`. */
  scheduledTaskMetas: Schema.optionalKey(Schema.Array(TeamScheduledTaskMeta)),
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
    type: Schema.Literal("teamDeleted"),
    payload: Schema.Struct({
      teamId: TeamId,
    }),
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
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("providerUpserted"),
    payload: TeamProvider,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("providerDeleted"),
    payload: TeamProviderDeletedPayload,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("skillUpserted"),
    payload: TeamSkill,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("skillDeleted"),
    payload: TeamSkillDeletedPayload,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("prepromptUpserted"),
    payload: TeamPreprompt,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("prepromptDeleted"),
    payload: TeamPrepromptDeletedPayload,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("assetsUpdated"),
    payload: TeamAssetsUpdatedPayload,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("myGitHubIdentityUpdated"),
    payload: TeamMyGitHubIdentityUpdatedPayload,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("automationGitHubIdentityUpdated"),
    payload: TeamAutomationGitHubIdentityUpdatedPayload,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("githubAppConfigUpdated"),
    payload: TeamGitHubAppConfigUpdatedPayload,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("scheduledTaskMetaUpserted"),
    payload: TeamScheduledTaskMeta,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("scheduledTaskMetaDeleted"),
    payload: TeamScheduledTaskMetaDeletedPayload,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("queuedMessageNotification"),
    payload: TeamQueuedMessageNotification,
  }),
]);
export type TeamStateStreamEvent = typeof TeamStateStreamEvent.Type;

export interface TeamThreadNotificationEligibilityInput {
  readonly hasTeam: boolean;
  readonly memberId: TeamMemberId | null;
  readonly ownerKind?: TeamThreadOwnerKind | undefined;
  readonly creatorMemberId: TeamMemberId | null;
  readonly isFollowing: boolean;
  readonly activeTurnAuthorMemberId: TeamMemberId | null;
}

/**
 * Determines whether a team member should be notified for a thread event.
 * Personal mode (`!hasTeam`) and unattributed legacy threads (`ownerKind === undefined && creatorMemberId === null`)
 * always remain enabled. Team-owned threads (`ownerKind === "team"`) suppress default notifications
 * unless the member explicitly follows the thread or authored the completing turn.
 */
export function shouldNotifyTeamMemberForThread(
  input: TeamThreadNotificationEligibilityInput,
): boolean {
  if (!input.hasTeam) {
    return true;
  }
  if (input.ownerKind === undefined && input.creatorMemberId === null) {
    return true;
  }
  if (input.memberId === null) {
    return false;
  }
  return (
    (input.creatorMemberId !== null && input.creatorMemberId === input.memberId) ||
    input.isFollowing ||
    (input.activeTurnAuthorMemberId !== null && input.activeTurnAuthorMemberId === input.memberId)
  );
}

export const TeamInitializeInput = Schema.Struct({
  name: TrimmedNonEmptyString,
  displayName: Schema.optionalKey(Schema.NullOr(Schema.String)),
  ownerPseudo: TrimmedNonEmptyString,
});
export type TeamInitializeInput = typeof TeamInitializeInput.Type;

export const TeamUpdateDisplayNameInput = Schema.Struct({
  displayName: TrimmedNonEmptyString,
});
export type TeamUpdateDisplayNameInput = typeof TeamUpdateDisplayNameInput.Type;

export const TeamInitializeResult = Schema.Struct({
  team: TeamWorkspace,
  owner: TeamMember,
});
export type TeamInitializeResult = typeof TeamInitializeResult.Type;

export const TeamLeaveResult = Schema.Struct({
  left: Schema.Boolean,
  teamId: TeamId,
  memberId: TeamMemberId,
});
export type TeamLeaveResult = typeof TeamLeaveResult.Type;

export const TeamDeleteInput = Schema.Struct({
  confirmTeamName: TrimmedNonEmptyString,
});
export type TeamDeleteInput = typeof TeamDeleteInput.Type;

export const TeamDeleteResult = Schema.Struct({
  deleted: Schema.Boolean,
  teamId: TeamId,
});
export type TeamDeleteResult = typeof TeamDeleteResult.Type;

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
  archivedAt: Schema.optionalKey(Schema.NullOr(IsoDateTime)),
  deletedAt: Schema.optionalKey(Schema.NullOr(IsoDateTime)),
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

export const TeamReserveAcceptedNotesInput = Schema.Struct({
  threadId: ThreadId,
  acceptedNotes: Schema.Array(TeamAcceptedNoteRef),
});
export type TeamReserveAcceptedNotesInput = typeof TeamReserveAcceptedNotesInput.Type;

export const TeamReserveAcceptedNotesResult = Schema.Struct({
  reservationToken: TrimmedNonEmptyString,
  noteIds: Schema.Array(TeamThreadNoteId),
  formattedPromptPrefix: Schema.String,
});
export type TeamReserveAcceptedNotesResult = typeof TeamReserveAcceptedNotesResult.Type;

export const TeamReleaseAcceptedNotesInput = Schema.Struct({
  threadId: ThreadId,
  reservationToken: TrimmedNonEmptyString,
});
export type TeamReleaseAcceptedNotesInput = typeof TeamReleaseAcceptedNotesInput.Type;

export const TeamReleaseAcceptedNotesResult = Schema.Struct({
  releasedCount: Schema.Number,
});
export type TeamReleaseAcceptedNotesResult = typeof TeamReleaseAcceptedNotesResult.Type;

export const TeamConsumeAcceptedNotesInput = Schema.Struct({
  threadId: ThreadId,
  targetTurnId: TrimmedNonEmptyString,
  acceptedNotes: Schema.Array(TeamAcceptedNoteRef),
  reservationToken: Schema.optionalKey(TrimmedNonEmptyString),
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

export const TeamUpsertProviderInput = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  displayName: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  deliveryStrategy: TeamProviderDeliveryStrategy,
  upstreamBaseUrl: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  apiKeyHeader: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  apiKeyPrefix: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** Write-only company API key stored exclusively in Team Server's ServerSecretStore. */
  apiKey: Schema.optionalKey(Schema.String),
  /** Write-only OAuth credentials stored exclusively in Team Server's ServerSecretStore for token-lease. */
  oauthAccessToken: Schema.optionalKey(Schema.String),
  oauthRefreshToken: Schema.optionalKey(Schema.String),
  oauthExpiresAt: Schema.optionalKey(IsoDateTime),
  oauthTokenEndpoint: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  oauthClientId: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  oauthClientSecret: Schema.optionalKey(Schema.String),
  oauthEmail: Schema.optionalKey(Schema.NullOr(Schema.String)),
  oauthAuthMethod: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** Optional signed-in Team Server provider instance to import/link OAuth credentials from for `token-lease`. */
  sourceServerProviderInstanceId: Schema.optionalKey(Schema.NullOr(ProviderInstanceId)),
  clearSecret: Schema.optionalKey(Schema.Boolean),
  config: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  enabled: Schema.optionalKey(Schema.Boolean),
});
export type TeamUpsertProviderInput = typeof TeamUpsertProviderInput.Type;

export const TeamDeleteProviderInput = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
});
export type TeamDeleteProviderInput = typeof TeamDeleteProviderInput.Type;

export const TeamDeleteProviderResult = Schema.Struct({
  deleted: Schema.Boolean,
});
export type TeamDeleteProviderResult = typeof TeamDeleteProviderResult.Type;

export const TeamUpsertSkillInput = Schema.Struct({
  skillId: Schema.optionalKey(TeamSkillId),
  slug: TeamSkillSlug,
  providerDriver: TeamAssetProviderDriver,
  skillMd: Schema.String,
  references: Schema.optionalKey(Schema.Array(TeamSkillReference)),
  enabled: Schema.optionalKey(Schema.Boolean),
});
export type TeamUpsertSkillInput = typeof TeamUpsertSkillInput.Type;

export const TeamDeleteSkillInput = Schema.Struct({
  skillId: TeamSkillId,
});
export type TeamDeleteSkillInput = typeof TeamDeleteSkillInput.Type;

export const TeamDeleteSkillResult = Schema.Struct({
  deleted: Schema.Boolean,
  revision: NonNegativeInt,
});
export type TeamDeleteSkillResult = typeof TeamDeleteSkillResult.Type;

export const TeamUpsertPrepromptInput = Schema.Struct({
  prepromptId: Schema.optionalKey(TeamPrepromptId),
  name: TrimmedNonEmptyString,
  providerDriver: TeamAssetProviderDriver,
  injectionScope: Schema.optionalKey(TeamPrepromptInjectionScope),
  content: Schema.String,
  enabled: Schema.optionalKey(Schema.Boolean),
});
export type TeamUpsertPrepromptInput = typeof TeamUpsertPrepromptInput.Type;

export const TeamDeletePrepromptInput = Schema.Struct({
  prepromptId: TeamPrepromptId,
});
export type TeamDeletePrepromptInput = typeof TeamDeletePrepromptInput.Type;

export const TeamDeletePrepromptResult = Schema.Struct({
  deleted: Schema.Boolean,
  revision: NonNegativeInt,
});
export type TeamDeletePrepromptResult = typeof TeamDeletePrepromptResult.Type;

export const TeamIssueLocalSyncTokenResult = Schema.Struct({
  token: TrimmedNonEmptyString,
  teamId: TeamId,
  memberId: TeamMemberId,
  expiresAt: IsoDateTime,
});
export type TeamIssueLocalSyncTokenResult = typeof TeamIssueLocalSyncTokenResult.Type;

export const TeamLocalProjectMapping = Schema.Struct({
  localProjectId: ProjectId,
  teamProjectId: ProjectId,
  repoIdentityKey: Schema.NullOr(TrimmedNonEmptyString),
});
export type TeamLocalProjectMapping = typeof TeamLocalProjectMapping.Type;

export const TeamSyncLocalBindingInput = Schema.Struct({
  teamId: TeamId,
  teamName: TrimmedNonEmptyString,
  teamServerUrl: TrimmedNonEmptyString,
  memberToken: Schema.optionalKey(TrimmedNonEmptyString),
  providers: Schema.Array(TeamProvider),
  projects: Schema.Array(TeamLocalProjectMapping),
  assetsRevision: NonNegativeInt,
});
export type TeamSyncLocalBindingInput = typeof TeamSyncLocalBindingInput.Type;

export const TeamSyncLocalBindingResult = Schema.Struct({
  synced: Schema.Boolean,
  virtualInstanceIds: Schema.Array(ProviderInstanceId),
  assetsRevision: NonNegativeInt,
});
export type TeamSyncLocalBindingResult = typeof TeamSyncLocalBindingResult.Type;

export const TeamRemoveLocalBindingInput = Schema.Struct({
  teamId: TeamId,
});
export type TeamRemoveLocalBindingInput = typeof TeamRemoveLocalBindingInput.Type;

export const TeamRemoveLocalBindingResult = Schema.Struct({
  removed: Schema.Boolean,
});
export type TeamRemoveLocalBindingResult = typeof TeamRemoveLocalBindingResult.Type;

export const TeamNotifyLocalAssetsUpdatedInput = Schema.Struct({
  teamId: TeamId,
  revision: NonNegativeInt,
});
export type TeamNotifyLocalAssetsUpdatedInput = typeof TeamNotifyLocalAssetsUpdatedInput.Type;

export const TeamNotifyLocalAssetsUpdatedResult = Schema.Struct({
  syncedRevision: NonNegativeInt,
});
export type TeamNotifyLocalAssetsUpdatedResult = typeof TeamNotifyLocalAssetsUpdatedResult.Type;

export const TeamUpdateMyMobileVisibilityInput = Schema.Struct({
  upstreamClientThreadVisibility: TeamUpstreamClientThreadVisibility,
});
export type TeamUpdateMyMobileVisibilityInput = typeof TeamUpdateMyMobileVisibilityInput.Type;

export const TeamCreateMobilePairingLinkInput = Schema.Struct({
  label: Schema.optionalKey(TrimmedNonEmptyString),
  scopes: Schema.optionalKey(Schema.Array(AuthEnvironmentScope)),
});
export type TeamCreateMobilePairingLinkInput = typeof TeamCreateMobilePairingLinkInput.Type;

export const TeamCreateMobilePairingLinkResult = Schema.Struct({
  id: TrimmedNonEmptyString,
  credential: TrimmedNonEmptyString,
  label: Schema.optionalKey(TrimmedNonEmptyString),
  scopes: Schema.Array(AuthEnvironmentScope),
  expiresAt: IsoDateTime,
});
export type TeamCreateMobilePairingLinkResult = typeof TeamCreateMobilePairingLinkResult.Type;

export const TeamMobilePairingLinkSummary = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: Schema.NullOr(Schema.String),
  scopes: Schema.Array(AuthEnvironmentScope),
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
});
export type TeamMobilePairingLinkSummary = typeof TeamMobilePairingLinkSummary.Type;

export const TeamListMyMobilePairingLinksResult = Schema.Struct({
  pairingLinks: Schema.Array(TeamMobilePairingLinkSummary),
});
export type TeamListMyMobilePairingLinksResult = typeof TeamListMyMobilePairingLinksResult.Type;

export const TeamRevokeMobilePairingLinkInput = Schema.Struct({
  id: TrimmedNonEmptyString,
});
export type TeamRevokeMobilePairingLinkInput = typeof TeamRevokeMobilePairingLinkInput.Type;

export const TeamRevokeMobilePairingLinkResult = Schema.Struct({
  revoked: Schema.Boolean,
});
export type TeamRevokeMobilePairingLinkResult = typeof TeamRevokeMobilePairingLinkResult.Type;

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
  "provider_not_allowed",
  "team_access_revoked",
  "skill_slug_taken",
  "remote_only_provider",
  "github_verification_failed",
  "github_oauth_not_configured",
  "github_oauth_failed",
  "github_oauth_state_invalid",
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
