import {
  ALL_TEAM_ROLES,
  DEFAULT_UPSTREAM_CLIENT_THREAD_VISIBILITY,
  canChangeTeamMemberRole,
  canManageTeamMembers,
  canModifyTeamMember,
  EnvironmentId,
  ProjectId,
  ScheduledTaskId,
  TeamEnvironmentRecordId,
  TeamId,
  TeamInviteId,
  TeamMemberId,
  TeamThreadNoteId,
  TeamViewId,
  ThreadId,
  type AuthEnvironmentScope,
  type AuthSessionId,
  type TeamAcceptedNoteRef,
  type TeamAccessRule,
  type TeamEnvironment,
  type TeamInvite,
  type TeamMember,
  type TeamMemberStatus,
  type TeamProjectAssignment,
  type TeamPseudo,
  type TeamRole,
  type TeamScheduledTaskMcpAccessLevel,
  type TeamScheduledTaskMeta,
  type TeamSessionBinding,
  type TeamThreadAttribution,
  type TeamThreadNote,
  type TeamThreadNoteStatus,
  type TeamThreadOwnerKind,
  type TeamTurnAttribution,
  type TeamTurnAuthorKind,
  type TeamUpstreamClientThreadVisibility,
  type TeamView,
  type TeamWorkspace,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { toSafeThreadAttachmentSegment } from "../attachmentStore.ts";
import { runTeamMigrations } from "./migrations.ts";
import {
  getTeamPairingMeta,
  getTeamSessionScopeCeiling,
  listTeamPairingLinkIdsForMember,
  markAllTeamPairingMetaRevokedForMember,
  markTeamPairingMetaRevoked,
  setMemberUpstreamMobileVisibility,
  upsertTeamPairingMeta,
  upsertTeamSessionScopeCeiling,
  type TeamPairingMetaRecord,
} from "./upstreamMobileCompat.ts";

export class TeamRepositoryError extends Schema.TaggedError<TeamRepositoryError>()(
  "TeamRepositoryError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Team database operation failed (${this.operation}).`;
  }
}

export class TeamPseudoAlreadyTakenError extends Schema.TaggedError<TeamPseudoAlreadyTakenError>()(
  "TeamPseudoAlreadyTakenError",
  {
    pseudo: Schema.String,
  },
) {
  override get message(): string {
    return `The pseudo "${this.pseudo}" is already taken in this team.`;
  }
}

export class TeamAlreadyConfiguredError extends Schema.TaggedError<TeamAlreadyConfiguredError>()(
  "TeamAlreadyConfiguredError",
  {},
) {
  override get message(): string {
    return "A team is already configured on this server.";
  }
}

export class TeamLastOwnerProtectedError extends Schema.TaggedError<TeamLastOwnerProtectedError>()(
  "TeamLastOwnerProtectedError",
  {},
) {
  override get message(): string {
    return "A team must always retain at least one active owner.";
  }
}

export class TeamViewNameAlreadyTakenError extends Schema.TaggedError<TeamViewNameAlreadyTakenError>()(
  "TeamViewNameAlreadyTakenError",
  {
    viewName: Schema.String,
  },
) {
  override get message(): string {
    return `A view named "${this.viewName}" already exists in this team.`;
  }
}

export class TeamDefaultViewProtectedError extends Schema.TaggedError<TeamDefaultViewProtectedError>()(
  "TeamDefaultViewProtectedError",
  {},
) {
  override get message(): string {
    return "The built-in Default View cannot be deleted.";
  }
}

export class TeamMemberForbiddenError extends Schema.TaggedError<TeamMemberForbiddenError>()(
  "TeamMemberForbiddenError",
  {
    reason: Schema.String,
  },
) {
  override get message(): string {
    return this.reason;
  }
}

export class TeamDefaultEnvironmentProtectedError extends Schema.TaggedError<TeamDefaultEnvironmentProtectedError>()(
  "TeamDefaultEnvironmentProtectedError",
  {},
) {
  override get message(): string {
    return "The Default Team Environment cannot be detached.";
  }
}

export class TeamEnvironmentAlreadyAttachedError extends Schema.TaggedError<TeamEnvironmentAlreadyAttachedError>()(
  "TeamEnvironmentAlreadyAttachedError",
  {
    environmentId: Schema.String,
  },
) {
  override get message(): string {
    return `Environment "${this.environmentId}" is already attached to this team.`;
  }
}

export class TeamNoteStateConflictError extends Schema.TaggedError<TeamNoteStateConflictError>()(
  "TeamNoteStateConflictError",
  {
    code: Schema.Literals(["note_hash_mismatch", "note_not_pending", "note_already_consumed"]),
    reason: Schema.String,
  },
) {
  override get message(): string {
    return this.reason;
  }
}

const isTeamAlreadyConfiguredError = Schema.is(TeamAlreadyConfiguredError);
const isTeamLastOwnerProtectedError = Schema.is(TeamLastOwnerProtectedError);
const isTeamDefaultViewProtectedError = Schema.is(TeamDefaultViewProtectedError);
const isTeamMemberForbiddenError = Schema.is(TeamMemberForbiddenError);
const isTeamDefaultEnvironmentProtectedError = Schema.is(TeamDefaultEnvironmentProtectedError);
const isTeamNoteStateConflictError = Schema.is(TeamNoteStateConflictError);

export interface StoredTeamInviteRecord extends TeamInvite {
  readonly tokenHash: string;
}

export interface TeamRelayRecipientBinding {
  readonly teamId: TeamId;
  readonly memberId: TeamMemberId;
  readonly cloudUserId: string | null;
  readonly boundAt: string;
}

export interface StoredTeamAutomationTurnScope {
  readonly turnId: string;
  readonly threadId: ThreadId;
  readonly taskId: ScheduledTaskId;
  readonly teamId: TeamId;
  readonly projectId: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly viewId: TeamViewId;
  readonly mcpAccessLevel: TeamScheduledTaskMcpAccessLevel;
  readonly createdAt: string;
}

interface WorkspaceRow {
  readonly id: string;
  readonly name: string;
  readonly display_name: string | null;
  readonly default_view_id: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface MemberRow {
  readonly id: string;
  readonly team_id: string;
  readonly pseudo: string;
  readonly role: TeamRole;
  readonly status: TeamMemberStatus;
  readonly upstream_client_thread_visibility?: TeamUpstreamClientThreadVisibility | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface InviteRow {
  readonly id: string;
  readonly team_id: string;
  readonly token_hash: string;
  readonly role: TeamRole;
  readonly prefilled_pseudo: string | null;
  readonly max_uses: number;
  readonly uses: number;
  readonly expires_at: string;
  readonly created_by_member_id: string;
  readonly revoked_at: string | null;
  readonly created_at: string;
}

interface SessionMetaRow {
  readonly session_id: string;
  readonly team_id: string;
  readonly member_id: string;
  readonly bound_at: string;
}

interface ThreadMetaRow {
  readonly thread_id: string;
  readonly team_id: string;
  readonly owner_kind: TeamThreadOwnerKind;
  readonly creator_member_id: string | null;
  readonly creator_pseudo: string | null;
  readonly team_display_name: string | null;
  readonly view_id: string;
  readonly locked: number;
  readonly locked_by_member_id: string | null;
  readonly execution_environment_id: string | null;
  readonly execution_environment_label: string | null;
  readonly is_local_synced: number;
  readonly created_at: string;
}

interface ProjectMetaRow {
  readonly project_id: string;
  readonly team_id: string;
  readonly default_view_id: string | null;
  readonly repo_identity_key: string | null;
  readonly assigned_by_member_id: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface TeamEnvironmentRow {
  readonly id: string;
  readonly team_id: string;
  readonly environment_id: string;
  readonly name: string;
  readonly is_default: number;
  readonly peer_link_id: string | null;
  readonly access_roles_json: string;
  readonly access_member_ids_json: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface ThreadNoteRow {
  readonly id: string;
  readonly thread_id: string;
  readonly team_id: string;
  readonly author_member_id: string;
  readonly author_pseudo: string;
  readonly author_role: TeamRole;
  readonly original_body: string;
  readonly original_content_hash: string;
  readonly edited_body: string | null;
  readonly edited_content_hash: string | null;
  readonly status: TeamThreadNoteStatus;
  readonly anchor_turn_id: string | null;
  readonly anchor_seq: number;
  readonly included_in_turn_id: string | null;
  readonly resolved_by_member_id: string | null;
  readonly resolved_by_pseudo: string | null;
  readonly resolved_at: string | null;
  readonly created_at: string;
}

interface ViewRow {
  readonly id: string;
  readonly team_id: string;
  readonly name: string;
  readonly description: string | null;
  readonly is_default: number;
  readonly read_roles_json: string;
  readonly read_member_ids_json: string;
  readonly post_roles_json: string;
  readonly post_member_ids_json: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface TurnMetaRow {
  readonly turn_id: string;
  readonly thread_id: string;
  readonly author_kind: TeamTurnAuthorKind;
  readonly author_member_id: string | null;
  readonly author_pseudo: string | null;
  readonly created_at: string;
}

interface ScheduledTaskMetaRow {
  readonly task_id: string;
  readonly team_id: string;
  readonly environment_id: string;
  readonly view_id: string;
  readonly locked: number;
  readonly mcp_access_level: TeamScheduledTaskMcpAccessLevel;
  readonly created_by_member_id: string | null;
  readonly updated_by_member_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface AutomationTurnScopeRow {
  readonly turn_id: string;
  readonly thread_id: string;
  readonly task_id: string;
  readonly team_id: string;
  readonly project_id: string;
  readonly environment_id: string;
  readonly view_id: string;
  readonly mcp_access_level: TeamScheduledTaskMcpAccessLevel;
  readonly created_at: string;
}

const mapWorkspaceRow = (row: WorkspaceRow): TeamWorkspace => {
  const displayName =
    row.display_name !== null && row.display_name.trim().length > 0
      ? row.display_name.trim()
      : row.name;
  return {
    id: TeamId.make(row.id),
    name: row.name,
    displayName,
    defaultViewId: TeamViewId.make(row.default_view_id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

const mapMemberRow = (row: MemberRow): TeamMember => ({
  id: TeamMemberId.make(row.id),
  teamId: TeamId.make(row.team_id),
  pseudo: row.pseudo as TeamPseudo,
  role: row.role,
  status: row.status,
  upstreamClientThreadVisibility:
    row.upstream_client_thread_visibility ?? DEFAULT_UPSTREAM_CLIENT_THREAD_VISIBILITY,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapInviteRow = (row: InviteRow): StoredTeamInviteRecord => ({
  id: TeamInviteId.make(row.id),
  teamId: TeamId.make(row.team_id),
  tokenHash: row.token_hash,
  role: row.role,
  prefilledPseudo: row.prefilled_pseudo as TeamPseudo | null,
  maxUses: row.max_uses,
  uses: row.uses,
  expiresAt: row.expires_at,
  createdByMemberId: TeamMemberId.make(row.created_by_member_id),
  revokedAt: row.revoked_at,
  createdAt: row.created_at,
});

const parseRoleArray = (json: string): ReadonlyArray<TeamRole> => {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    const allowed = new Set<string>(ALL_TEAM_ROLES);
    return parsed.filter(
      (value): value is TeamRole => typeof value === "string" && allowed.has(value),
    );
  } catch {
    return [];
  }
};

const parseMemberIdArray = (json: string): ReadonlyArray<TeamMemberId> => {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => TeamMemberId.make(value));
  } catch {
    return [];
  }
};

const mapViewRow = (row: ViewRow): TeamView => ({
  id: TeamViewId.make(row.id),
  teamId: TeamId.make(row.team_id),
  name: row.name,
  description: row.description,
  isDefault: row.is_default === 1,
  readRule: {
    roles: [...parseRoleArray(row.read_roles_json)],
    memberIds: [...parseMemberIdArray(row.read_member_ids_json)],
  },
  postRule: {
    roles: [...parseRoleArray(row.post_roles_json)],
    memberIds: [...parseMemberIdArray(row.post_member_ids_json)],
  },
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapThreadMetaRow = (row: ThreadMetaRow): TeamThreadAttribution => ({
  threadId: ThreadId.make(row.thread_id),
  teamId: TeamId.make(row.team_id),
  ownerKind: row.owner_kind,
  creatorMemberId: row.creator_member_id !== null ? TeamMemberId.make(row.creator_member_id) : null,
  creatorPseudo: row.creator_pseudo !== null ? (row.creator_pseudo as TeamPseudo) : null,
  ...(row.team_display_name !== null ? { teamDisplayName: row.team_display_name } : {}),
  viewId: TeamViewId.make(row.view_id),
  locked: row.locked === 1,
  lockedByMemberId:
    row.locked_by_member_id !== null ? TeamMemberId.make(row.locked_by_member_id) : null,
  executionEnvironmentId:
    row.execution_environment_id !== null ? EnvironmentId.make(row.execution_environment_id) : null,
  executionEnvironmentLabel: row.execution_environment_label,
  isLocalSynced: row.is_local_synced === 1,
  createdAt: row.created_at,
});

const mapProjectMetaRow = (row: ProjectMetaRow): TeamProjectAssignment => ({
  projectId: ProjectId.make(row.project_id),
  teamId: TeamId.make(row.team_id),
  defaultViewId: row.default_view_id !== null ? TeamViewId.make(row.default_view_id) : null,
  repoIdentityKey: row.repo_identity_key,
  assignedByMemberId: TeamMemberId.make(row.assigned_by_member_id),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapEnvironmentRow = (row: TeamEnvironmentRow): TeamEnvironment => ({
  id: TeamEnvironmentRecordId.make(row.id),
  teamId: TeamId.make(row.team_id),
  environmentId: EnvironmentId.make(row.environment_id),
  name: row.name,
  isDefault: row.is_default === 1,
  peerLinkId: row.peer_link_id,
  accessRule: {
    roles: [...parseRoleArray(row.access_roles_json)],
    memberIds: [...parseMemberIdArray(row.access_member_ids_json)],
  },
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapThreadNoteRow = (row: ThreadNoteRow): TeamThreadNote => ({
  id: TeamThreadNoteId.make(row.id),
  threadId: ThreadId.make(row.thread_id),
  teamId: TeamId.make(row.team_id),
  authorMemberId: TeamMemberId.make(row.author_member_id),
  authorPseudo: row.author_pseudo as TeamPseudo,
  authorRole: row.author_role,
  originalBody: row.original_body,
  originalContentHash: row.original_content_hash,
  editedBody: row.edited_body,
  editedContentHash: row.edited_content_hash,
  status: row.status,
  anchorTurnId: row.anchor_turn_id,
  anchorSeq: row.anchor_seq,
  includedInTurnId: row.included_in_turn_id,
  resolvedByMemberId:
    row.resolved_by_member_id !== null ? TeamMemberId.make(row.resolved_by_member_id) : null,
  resolvedByPseudo: row.resolved_by_pseudo as TeamPseudo | null,
  resolvedAt: row.resolved_at,
  createdAt: row.created_at,
});

const mapTurnMetaRow = (row: TurnMetaRow): TeamTurnAttribution => ({
  turnId: row.turn_id,
  threadId: ThreadId.make(row.thread_id),
  authorKind: row.author_kind,
  authorMemberId: row.author_member_id !== null ? TeamMemberId.make(row.author_member_id) : null,
  authorPseudo: row.author_pseudo !== null ? (row.author_pseudo as TeamPseudo) : null,
  createdAt: row.created_at,
});

const mapScheduledTaskMetaRow = (row: ScheduledTaskMetaRow): TeamScheduledTaskMeta => ({
  taskId: ScheduledTaskId.make(row.task_id),
  teamId: TeamId.make(row.team_id),
  environmentId: EnvironmentId.make(row.environment_id),
  viewId: TeamViewId.make(row.view_id),
  locked: row.locked === 1,
  mcpAccessLevel: row.mcp_access_level,
  createdByMemberId:
    row.created_by_member_id !== null ? TeamMemberId.make(row.created_by_member_id) : null,
  updatedByMemberId:
    row.updated_by_member_id !== null ? TeamMemberId.make(row.updated_by_member_id) : null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapAutomationTurnScopeRow = (row: AutomationTurnScopeRow): StoredTeamAutomationTurnScope => ({
  turnId: row.turn_id,
  threadId: ThreadId.make(row.thread_id),
  taskId: ScheduledTaskId.make(row.task_id),
  teamId: TeamId.make(row.team_id),
  projectId: ProjectId.make(row.project_id),
  environmentId: EnvironmentId.make(row.environment_id),
  viewId: TeamViewId.make(row.view_id),
  mcpAccessLevel: row.mcp_access_level,
  createdAt: row.created_at,
});

const StringArrayJsonSchema = Schema.fromJsonString(Schema.Array(Schema.String));
const encodeStringArrayJson = Schema.encodeSync(StringArrayJsonSchema);

const errorChainIncludes = (cause: unknown, needle: string): boolean => {
  const seen = new Set<unknown>();
  const stack: Array<unknown> = [cause];
  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current !== "object" || current === null || seen.has(current)) continue;
    seen.add(current);
    const message =
      "message" in current && typeof current.message === "string" ? current.message : "";
    if (message.includes(needle)) return true;
    if ("cause" in current && current.cause !== undefined && current.cause !== null) {
      stack.push(current.cause);
    }
    if ("reason" in current && current.reason !== undefined && current.reason !== null) {
      stack.push(current.reason);
    }
  }
  return false;
};

const isUniqueConstraintError = (cause: unknown): boolean =>
  errorChainIncludes(cause, "UNIQUE constraint failed");

const RunPayloadUserMessageSchema = Schema.fromJsonString(
  Schema.Struct({
    userMessageId: Schema.optional(Schema.String),
  }),
);
const decodeRunPayloadUserMessage = Schema.decodeUnknownOption(RunPayloadUserMessageSchema);

const extractRunUserMessageId = (payloadJson: string): string | null => {
  const decoded = decodeRunPayloadUserMessage(payloadJson);
  if (Option.isNone(decoded)) return null;
  const id = decoded.value.userMessageId;
  return typeof id === "string" && id.length > 0 ? id : null;
};

export class TeamRepository extends Context.Service<
  TeamRepository,
  {
    readonly getWorkspace: () => Effect.Effect<Option.Option<TeamWorkspace>, TeamRepositoryError>;
    readonly initializeWorkspace: (input: {
      readonly team: TeamWorkspace;
      readonly owner: TeamMember;
      readonly ownerSessionId: AuthSessionId;
    }) => Effect.Effect<
      void,
      TeamRepositoryError | TeamPseudoAlreadyTakenError | TeamAlreadyConfiguredError
    >;
    readonly updateWorkspaceDisplayName: (input: {
      readonly teamId: TeamId;
      readonly displayName: string;
      readonly updatedAt: string;
    }) => Effect.Effect<Option.Option<TeamWorkspace>, TeamRepositoryError>;
    readonly listMembers: (
      teamId: TeamId,
    ) => Effect.Effect<ReadonlyArray<TeamMember>, TeamRepositoryError>;
    readonly getMemberById: (
      memberId: TeamMemberId,
    ) => Effect.Effect<Option.Option<TeamMember>, TeamRepositoryError>;
    readonly getMemberForSession: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<Option.Option<TeamMember>, TeamRepositoryError>;
    readonly getSessionBinding: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<Option.Option<TeamSessionBinding>, TeamRepositoryError>;
    readonly bindSession: (input: TeamSessionBinding) => Effect.Effect<void, TeamRepositoryError>;
    readonly updateMemberPseudo: (input: {
      readonly teamId: TeamId;
      readonly memberId: TeamMemberId;
      readonly pseudo: TeamPseudo;
      readonly updatedAt: string;
    }) => Effect.Effect<
      Option.Option<TeamMember>,
      TeamRepositoryError | TeamPseudoAlreadyTakenError
    >;
    readonly updateMemberRole: (input: {
      readonly teamId: TeamId;
      readonly actorMemberId: TeamMemberId;
      readonly memberId: TeamMemberId;
      readonly role: TeamRole;
      readonly updatedAt: string;
    }) => Effect.Effect<
      Option.Option<{ readonly previousRole: TeamRole; readonly member: TeamMember }>,
      TeamRepositoryError | TeamLastOwnerProtectedError | TeamMemberForbiddenError
    >;
    readonly updateMemberStatus: (input: {
      readonly teamId: TeamId;
      readonly actorMemberId: TeamMemberId;
      readonly memberId: TeamMemberId;
      readonly status: TeamMemberStatus;
      readonly updatedAt: string;
    }) => Effect.Effect<
      Option.Option<{
        readonly member: TeamMember;
        readonly updatedViews: ReadonlyArray<TeamView>;
        readonly updatedEnvironments: ReadonlyArray<TeamEnvironment>;
      }>,
      TeamRepositoryError | TeamLastOwnerProtectedError | TeamMemberForbiddenError
    >;
    readonly leaveTeam: (input: {
      readonly teamId: TeamId;
      readonly memberId: TeamMemberId;
      readonly updatedAt: string;
    }) => Effect.Effect<
      Option.Option<{
        readonly member: TeamMember;
        readonly updatedViews: ReadonlyArray<TeamView>;
        readonly updatedEnvironments: ReadonlyArray<TeamEnvironment>;
      }>,
      TeamRepositoryError | TeamLastOwnerProtectedError
    >;
    readonly collectDeleteCleanupTargets: (teamId: TeamId) => Effect.Effect<
      {
        readonly exists: boolean;
        readonly sessionIds: ReadonlyArray<AuthSessionId>;
        readonly pairingLinkIds: ReadonlyArray<string>;
        readonly providerSecretKeys: ReadonlyArray<string>;
        readonly githubSecretKeys: ReadonlyArray<string>;
        readonly githubAppClientSecretKey: string | null;
        readonly scheduledTaskIds: ReadonlyArray<ScheduledTaskId>;
      },
      TeamRepositoryError
    >;
    readonly deleteTeam: (teamId: TeamId) => Effect.Effect<
      {
        readonly deleted: boolean;
        readonly sessionIds: ReadonlyArray<AuthSessionId>;
        readonly pairingLinkIds: ReadonlyArray<string>;
        readonly providerSecretKeys: ReadonlyArray<string>;
        readonly githubSecretKeys: ReadonlyArray<string>;
        readonly githubAppClientSecretKey: string | null;
      },
      TeamRepositoryError
    >;
    readonly listSessionIdsForMember: (
      memberId: TeamMemberId,
    ) => Effect.Effect<ReadonlyArray<AuthSessionId>, TeamRepositoryError>;
    readonly listViews: (
      teamId: TeamId,
    ) => Effect.Effect<ReadonlyArray<TeamView>, TeamRepositoryError>;
    readonly getViewById: (
      viewId: TeamViewId,
    ) => Effect.Effect<Option.Option<TeamView>, TeamRepositoryError>;
    readonly createView: (
      view: TeamView,
    ) => Effect.Effect<void, TeamRepositoryError | TeamViewNameAlreadyTakenError>;
    readonly updateView: (input: {
      readonly teamId: TeamId;
      readonly viewId: TeamViewId;
      readonly name?: string;
      readonly description?: string | null;
      readonly readRule?: TeamAccessRule;
      readonly postRule?: TeamAccessRule;
      readonly updatedAt: string;
    }) => Effect.Effect<
      Option.Option<TeamView>,
      TeamRepositoryError | TeamViewNameAlreadyTakenError
    >;
    readonly deleteViewAndReassignThreads: (input: {
      readonly teamId: TeamId;
      readonly viewId: TeamViewId;
      readonly fallbackViewId: TeamViewId;
    }) => Effect.Effect<boolean, TeamRepositoryError | TeamDefaultViewProtectedError>;
    readonly createInvite: (
      invite: StoredTeamInviteRecord,
    ) => Effect.Effect<void, TeamRepositoryError>;
    readonly listInvites: (
      teamId: TeamId,
    ) => Effect.Effect<ReadonlyArray<TeamInvite>, TeamRepositoryError>;
    readonly getInviteById: (
      inviteId: TeamInviteId,
    ) => Effect.Effect<Option.Option<StoredTeamInviteRecord>, TeamRepositoryError>;
    readonly getInviteByTokenHash: (
      tokenHash: string,
    ) => Effect.Effect<Option.Option<StoredTeamInviteRecord>, TeamRepositoryError>;
    readonly revokeInvite: (input: {
      readonly inviteId: TeamInviteId;
      readonly revokedAt: string;
    }) => Effect.Effect<boolean, TeamRepositoryError>;
    readonly consumeInviteAndCreateMember: (input: {
      readonly inviteId: TeamInviteId;
      readonly member: TeamMember;
      readonly nowIso: string;
    }) => Effect.Effect<boolean, TeamRepositoryError | TeamPseudoAlreadyTakenError>;
    readonly rollbackInviteConsumption: (input: {
      readonly inviteId: TeamInviteId;
      readonly memberId: TeamMemberId;
    }) => Effect.Effect<void, TeamRepositoryError>;
    readonly recordThreadAttribution: (input: {
      readonly threadId: ThreadId;
      readonly teamId: TeamId;
      readonly ownerKind?: TeamThreadOwnerKind;
      readonly creatorMemberId: TeamMemberId | null;
      readonly viewId: TeamViewId;
      readonly locked?: boolean;
      readonly lockedByMemberId?: TeamMemberId | null;
      readonly executionEnvironmentId?: EnvironmentId | null;
      readonly executionEnvironmentLabel?: string | null;
      readonly isLocalSynced?: boolean;
      readonly createdAt: string;
      readonly ownerAutomationScope?: StoredTeamAutomationTurnScope;
    }) => Effect.Effect<Option.Option<TeamThreadAttribution>, TeamRepositoryError>;
    readonly upsertLocalSyncedThreadAttribution: (input: {
      readonly threadId: ThreadId;
      readonly teamId: TeamId;
      readonly creatorMemberId: TeamMemberId;
      readonly viewId: TeamViewId;
      readonly locked?: boolean;
      readonly lockedByMemberId?: TeamMemberId | null;
      readonly executionEnvironmentId: EnvironmentId;
      readonly executionEnvironmentLabel: string;
      readonly createdAt: string;
    }) => Effect.Effect<
      Option.Option<TeamThreadAttribution>,
      TeamRepositoryError | TeamMemberForbiddenError
    >;
    readonly updateThreadView: (input: {
      readonly teamId: TeamId;
      readonly threadId: ThreadId;
      readonly viewId: TeamViewId;
    }) => Effect.Effect<Option.Option<TeamThreadAttribution>, TeamRepositoryError>;
    readonly updateThreadLocked: (input: {
      readonly teamId: TeamId;
      readonly threadId: ThreadId;
      readonly locked: boolean;
      readonly lockedByMemberId: TeamMemberId | null;
    }) => Effect.Effect<Option.Option<TeamThreadAttribution>, TeamRepositoryError>;
    readonly deleteThreadAttribution: (
      threadId: ThreadId,
    ) => Effect.Effect<void, TeamRepositoryError>;
    readonly deleteTurnAttribution: (input: {
      readonly threadId: ThreadId;
      readonly turnId: string;
    }) => Effect.Effect<void, TeamRepositoryError>;
    readonly listThreadAttributions: (
      teamId: TeamId,
    ) => Effect.Effect<ReadonlyArray<TeamThreadAttribution>, TeamRepositoryError>;
    readonly getThreadAttribution: (
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<TeamThreadAttribution>, TeamRepositoryError>;
    readonly recordTurnAttribution: (input: {
      readonly turnId: string;
      readonly threadId: ThreadId;
      readonly authorKind?: TeamTurnAuthorKind;
      readonly authorMemberId: TeamMemberId | null;
      readonly createdAt: string;
    }) => Effect.Effect<boolean, TeamRepositoryError>;
    readonly listTurnAttributionsForThread: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<TeamTurnAttribution>, TeamRepositoryError>;
    readonly getTurnAttribution: (
      turnId: string,
    ) => Effect.Effect<Option.Option<TeamTurnAttribution>, TeamRepositoryError>;
    readonly listLatestTurnAttributions: (
      teamId: TeamId,
    ) => Effect.Effect<ReadonlyArray<TeamTurnAttribution>, TeamRepositoryError>;
    readonly threadExistsInProjection: (
      threadId: ThreadId,
    ) => Effect.Effect<boolean, TeamRepositoryError>;
    readonly isThreadDeletedInProjection: (
      threadId: ThreadId,
    ) => Effect.Effect<boolean, TeamRepositoryError>;
    readonly getThreadCreatedAtInProjection: (
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<string>, TeamRepositoryError>;
    readonly getActiveRunInProjection: (threadId: ThreadId) => Effect.Effect<
      Option.Option<{
        readonly runId: string;
        readonly status: string;
        readonly userMessageId: string | null;
      }>,
      TeamRepositoryError
    >;
    readonly getRunInProjection: (
      threadId: ThreadId,
      runId: string,
    ) => Effect.Effect<
      Option.Option<{
        readonly runId: string;
        readonly status: string;
        readonly userMessageId: string | null;
      }>,
      TeamRepositoryError
    >;
    readonly listThreadCreatedAtInProjection: (
      threadIds: ReadonlyArray<ThreadId>,
    ) => Effect.Effect<ReadonlyMap<ThreadId, string>, TeamRepositoryError>;
    readonly getThreadProjectIdInProjection: (
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<ProjectId>, TeamRepositoryError>;
    readonly listThreadProjectIdsInProjection: (
      threadIds: ReadonlyArray<ThreadId>,
    ) => Effect.Effect<ReadonlyMap<ThreadId, ProjectId>, TeamRepositoryError>;
    readonly findThreadIdByAttachmentSegment: (input: {
      readonly teamId: TeamId;
      readonly segment: string;
    }) => Effect.Effect<Option.Option<ThreadId>, TeamRepositoryError>;
    readonly followThread: (input: {
      readonly threadId: ThreadId;
      readonly memberId: TeamMemberId;
      readonly createdAt: string;
    }) => Effect.Effect<boolean, TeamRepositoryError>;
    readonly unfollowThread: (input: {
      readonly threadId: ThreadId;
      readonly memberId: TeamMemberId;
    }) => Effect.Effect<boolean, TeamRepositoryError>;
    readonly isFollowingThread: (input: {
      readonly threadId: ThreadId;
      readonly memberId: TeamMemberId;
    }) => Effect.Effect<boolean, TeamRepositoryError>;
    readonly listFollowedThreadIds: (
      memberId: TeamMemberId,
    ) => Effect.Effect<ReadonlyArray<ThreadId>, TeamRepositoryError>;
    readonly listFollowersForThread: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<TeamMemberId>, TeamRepositoryError>;
    readonly setRelayRecipientBinding: (
      input: TeamRelayRecipientBinding,
    ) => Effect.Effect<void, TeamRepositoryError>;
    readonly getRelayRecipientBinding: () => Effect.Effect<
      Option.Option<TeamRelayRecipientBinding>,
      TeamRepositoryError
    >;
    readonly clearRelayRecipientBinding: () => Effect.Effect<void, TeamRepositoryError>;
    readonly listProjectAssignments: (
      teamId: TeamId,
    ) => Effect.Effect<ReadonlyArray<TeamProjectAssignment>, TeamRepositoryError>;
    readonly getProjectAssignment: (
      projectId: ProjectId,
    ) => Effect.Effect<Option.Option<TeamProjectAssignment>, TeamRepositoryError>;
    readonly upsertProjectAssignment: (
      assignment: TeamProjectAssignment,
    ) => Effect.Effect<TeamProjectAssignment, TeamRepositoryError>;
    readonly deleteProjectAssignment: (input: {
      readonly teamId: TeamId;
      readonly projectId: ProjectId;
    }) => Effect.Effect<boolean, TeamRepositoryError>;
    readonly listEnvironments: (
      teamId: TeamId,
    ) => Effect.Effect<ReadonlyArray<TeamEnvironment>, TeamRepositoryError>;
    readonly getEnvironmentByEnvironmentId: (input: {
      readonly teamId: TeamId;
      readonly environmentId: EnvironmentId;
    }) => Effect.Effect<Option.Option<TeamEnvironment>, TeamRepositoryError>;
    readonly ensureDefaultEnvironment: (input: {
      readonly id: TeamEnvironmentRecordId;
      readonly teamId: TeamId;
      readonly environmentId: EnvironmentId;
      readonly name: string;
      readonly createdAt: string;
    }) => Effect.Effect<TeamEnvironment, TeamRepositoryError>;
    readonly createEnvironment: (
      environment: TeamEnvironment,
    ) => Effect.Effect<void, TeamRepositoryError | TeamEnvironmentAlreadyAttachedError>;
    readonly updateEnvironment: (input: {
      readonly teamId: TeamId;
      readonly environmentId: EnvironmentId;
      readonly name?: string;
      readonly accessRule?: TeamAccessRule;
      readonly updatedAt: string;
    }) => Effect.Effect<Option.Option<TeamEnvironment>, TeamRepositoryError>;
    readonly deleteEnvironment: (input: {
      readonly teamId: TeamId;
      readonly environmentId: EnvironmentId;
    }) => Effect.Effect<boolean, TeamRepositoryError | TeamDefaultEnvironmentProtectedError>;
    readonly getLatestRunInProjection: (threadId: ThreadId) => Effect.Effect<
      Option.Option<{
        readonly runId: string;
        readonly status: string;
        readonly userMessageId: string | null;
      }>,
      TeamRepositoryError
    >;
    readonly listThreadNotes: (input: {
      readonly teamId: TeamId;
      readonly threadId?: ThreadId;
    }) => Effect.Effect<ReadonlyArray<TeamThreadNote>, TeamRepositoryError>;
    readonly getThreadNoteById: (
      noteId: TeamThreadNoteId,
    ) => Effect.Effect<Option.Option<TeamThreadNote>, TeamRepositoryError>;
    readonly createThreadNote: (input: {
      readonly id: TeamThreadNoteId;
      readonly threadId: ThreadId;
      readonly teamId: TeamId;
      readonly authorMemberId: TeamMemberId;
      readonly originalBody: string;
      readonly originalContentHash: string;
      readonly anchorTurnId: string | null;
      readonly createdAt: string;
    }) => Effect.Effect<Option.Option<TeamThreadNote>, TeamRepositoryError>;
    readonly deletePendingThreadNoteByAuthor: (input: {
      readonly teamId: TeamId;
      readonly noteId: TeamThreadNoteId;
      readonly authorMemberId: TeamMemberId;
    }) => Effect.Effect<
      boolean,
      TeamRepositoryError | TeamMemberForbiddenError | TeamNoteStateConflictError
    >;
    readonly resolveThreadNote: (input: {
      readonly teamId: TeamId;
      readonly noteId: TeamThreadNoteId;
      readonly status: "pending" | "accepted" | "rejected";
      readonly expectedContentHash?: string;
      readonly resolvedByMemberId: TeamMemberId;
      readonly resolvedAt: string;
    }) => Effect.Effect<
      Option.Option<TeamThreadNote>,
      TeamRepositoryError | TeamNoteStateConflictError
    >;
    readonly editThreadNote: (input: {
      readonly teamId: TeamId;
      readonly noteId: TeamThreadNoteId;
      readonly editedBody: string;
      readonly editedContentHash: string;
      readonly expectedOriginalContentHash?: string;
      readonly status: "pending" | "accepted";
      readonly resolvedByMemberId: TeamMemberId;
      readonly resolvedAt: string;
    }) => Effect.Effect<
      Option.Option<TeamThreadNote>,
      TeamRepositoryError | TeamNoteStateConflictError
    >;
    readonly consumeAcceptedNotesAndReanchorPending: (input: {
      readonly teamId: TeamId;
      readonly threadId: ThreadId;
      readonly targetTurnId: string;
      readonly acceptedNotes: ReadonlyArray<TeamAcceptedNoteRef>;
      readonly resolvedByMemberId: TeamMemberId;
      readonly resolvedAt: string;
    }) => Effect.Effect<
      {
        readonly consumedNotes: ReadonlyArray<TeamThreadNote>;
        readonly reanchoredNotes: ReadonlyArray<TeamThreadNote>;
      },
      TeamRepositoryError | TeamNoteStateConflictError
    >;
    readonly relinkNoteTurnId: (input: {
      readonly teamId: TeamId;
      readonly threadId: ThreadId;
      readonly fromTurnId: string;
      readonly toTurnId: string;
    }) => Effect.Effect<ReadonlyArray<TeamThreadNote>, TeamRepositoryError>;
    readonly reanchorPendingNotesForNewTurn: (input: {
      readonly teamId: TeamId;
      readonly threadId: ThreadId;
      readonly targetTurnId: string;
    }) => Effect.Effect<ReadonlyArray<TeamThreadNote>, TeamRepositoryError>;
    readonly enqueuePendingRemoteRevocation: (input: {
      readonly id: string;
      readonly teamId: TeamId;
      readonly environmentId: EnvironmentId;
      readonly subjectPrefix: string;
      readonly unlinkAfterRevoke: boolean;
      readonly createdAt: string;
    }) => Effect.Effect<void, TeamRepositoryError>;
    readonly listPendingRemoteRevocations: (teamId?: TeamId) => Effect.Effect<
      ReadonlyArray<{
        readonly id: string;
        readonly teamId: TeamId;
        readonly environmentId: EnvironmentId;
        readonly subjectPrefix: string;
        readonly unlinkAfterRevoke: boolean;
        readonly createdAt: string;
      }>,
      TeamRepositoryError
    >;
    readonly clearPendingRemoteRevocationUnlinkFlag: (input: {
      readonly teamId: TeamId;
      readonly environmentId: EnvironmentId;
    }) => Effect.Effect<void, TeamRepositoryError>;
    readonly deletePendingRemoteRevocation: (
      id: string,
    ) => Effect.Effect<void, TeamRepositoryError>;
    readonly bindPairingLinkMeta: (
      input: Omit<TeamPairingMetaRecord, "revokedAt">,
    ) => Effect.Effect<void, TeamRepositoryError>;
    readonly getPairingLinkMeta: (
      pairingLinkId: string,
    ) => Effect.Effect<Option.Option<TeamPairingMetaRecord>, TeamRepositoryError>;
    readonly listPairingLinkIdsForMember: (
      memberId: TeamMemberId,
    ) => Effect.Effect<ReadonlyArray<string>, TeamRepositoryError>;
    readonly markPairingLinkMetaRevoked: (input: {
      readonly pairingLinkId: string;
      readonly revokedAt: string;
    }) => Effect.Effect<void, TeamRepositoryError>;
    readonly markAllPairingLinkMetaRevokedForMember: (input: {
      readonly memberId: TeamMemberId;
      readonly revokedAt: string;
    }) => Effect.Effect<void, TeamRepositoryError>;
    readonly setSessionScopeCeiling: (input: {
      readonly sessionId: AuthSessionId;
      readonly maxScopes: ReadonlyArray<AuthEnvironmentScope>;
      readonly createdAt: string;
    }) => Effect.Effect<void, TeamRepositoryError>;
    readonly getSessionScopeCeiling: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<Option.Option<ReadonlyArray<AuthEnvironmentScope>>, TeamRepositoryError>;
    readonly setMemberMobileVisibility: (input: {
      readonly memberId: TeamMemberId;
      readonly teamId: TeamId;
      readonly visibility: TeamUpstreamClientThreadVisibility;
      readonly updatedAt: string;
    }) => Effect.Effect<Option.Option<TeamMember>, TeamRepositoryError>;
    readonly upsertScheduledTaskMeta: (
      meta: TeamScheduledTaskMeta,
    ) => Effect.Effect<TeamScheduledTaskMeta, TeamRepositoryError>;
    readonly getScheduledTaskMeta: (
      taskId: ScheduledTaskId,
    ) => Effect.Effect<Option.Option<TeamScheduledTaskMeta>, TeamRepositoryError>;
    readonly listScheduledTaskMetas: (
      teamId: TeamId,
    ) => Effect.Effect<ReadonlyArray<TeamScheduledTaskMeta>, TeamRepositoryError>;
    readonly deleteScheduledTaskMeta: (
      taskId: ScheduledTaskId,
    ) => Effect.Effect<boolean, TeamRepositoryError>;
    readonly recordAutomationTurnScope: (
      scope: StoredTeamAutomationTurnScope,
    ) => Effect.Effect<boolean, TeamRepositoryError>;
    readonly recordAutomationTurnWithScope: (input: {
      readonly scope: StoredTeamAutomationTurnScope;
    }) => Effect.Effect<
      { readonly turnInserted: boolean; readonly scopeInserted: boolean },
      TeamRepositoryError
    >;
    readonly getAutomationTurnScope: (
      turnId: string,
    ) => Effect.Effect<Option.Option<StoredTeamAutomationTurnScope>, TeamRepositoryError>;
  }
>()("t3/team/TeamRepository") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runTeamMigrations().pipe(
    Effect.mapError((cause) => new TeamRepositoryError({ operation: "migrate", cause })),
  );

  const runSql = <A, E>(operation: string, effect: Effect.Effect<A, E>) =>
    effect.pipe(Effect.mapError((cause) => new TeamRepositoryError({ operation, cause })));

  return TeamRepository.of({
    getWorkspace: Effect.fn("TeamRepository.getWorkspace")(function* () {
      const rows = yield* runSql(
        "getWorkspace",
        sql<WorkspaceRow>`
          SELECT id, name, display_name, default_view_id, created_at, updated_at
          FROM team_workspaces
          ORDER BY created_at ASC
          LIMIT 1
        `,
      );
      return rows[0] ? Option.some(mapWorkspaceRow(rows[0])) : Option.none();
    }),

    initializeWorkspace: Effect.fn("TeamRepository.initializeWorkspace")(function* (input) {
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const existing = yield* sql<{ readonly id: string }>`
              SELECT id FROM team_workspaces LIMIT 1
            `;
            if (existing.length > 0) {
              return yield* new TeamAlreadyConfiguredError({});
            }
            yield* sql`
              INSERT INTO team_workspaces (id, singleton, name, display_name, default_view_id, created_at, updated_at)
              VALUES (
                ${input.team.id},
                1,
                ${input.team.name},
                ${input.team.displayName},
                ${input.team.defaultViewId},
                ${input.team.createdAt},
                ${input.team.updatedAt}
              )
            `;
            yield* sql`
              INSERT INTO team_views (
                id, team_id, name, description, is_default,
                read_roles_json, read_member_ids_json,
                post_roles_json, post_member_ids_json,
                created_at, updated_at
              )
              VALUES (
                ${input.team.defaultViewId},
                ${input.team.id},
                'Default',
                NULL,
                1,
                ${encodeStringArrayJson(ALL_TEAM_ROLES)},
                '[]',
                ${encodeStringArrayJson(ALL_TEAM_ROLES)},
                '[]',
                ${input.team.createdAt},
                ${input.team.updatedAt}
              )
            `;
            yield* sql`
              INSERT INTO team_members (id, team_id, pseudo, role, status, created_at, updated_at)
              VALUES (
                ${input.owner.id},
                ${input.owner.teamId},
                ${input.owner.pseudo},
                ${input.owner.role},
                ${input.owner.status},
                ${input.owner.createdAt},
                ${input.owner.updatedAt}
              )
            `;
            yield* sql`
              INSERT OR REPLACE INTO team_session_meta (session_id, team_id, member_id, bound_at)
              VALUES (
                ${input.ownerSessionId},
                ${input.team.id},
                ${input.owner.id},
                ${input.team.createdAt}
              )
            `;
          }),
        )
        .pipe(
          Effect.mapError((cause) => {
            if (isTeamAlreadyConfiguredError(cause)) return cause;
            if (isUniqueConstraintError(cause)) {
              if (errorChainIncludes(cause, "team_workspaces")) {
                return new TeamAlreadyConfiguredError({});
              }
              return new TeamPseudoAlreadyTakenError({ pseudo: input.owner.pseudo });
            }
            return new TeamRepositoryError({ operation: "initializeWorkspace", cause });
          }),
        );
    }),

    updateWorkspaceDisplayName: Effect.fn("TeamRepository.updateWorkspaceDisplayName")(
      function* (input) {
        const rows = yield* runSql(
          "updateWorkspaceDisplayName",
          sql<WorkspaceRow>`
            UPDATE team_workspaces
            SET display_name = ${input.displayName}, updated_at = ${input.updatedAt}
            WHERE id = ${input.teamId}
            RETURNING id, name, display_name, default_view_id, created_at, updated_at
          `,
        );
        return rows[0] ? Option.some(mapWorkspaceRow(rows[0])) : Option.none();
      },
    ),

    listMembers: Effect.fn("TeamRepository.listMembers")(function* (teamId) {
      const rows = yield* runSql(
        "listMembers",
        sql<MemberRow>`
          SELECT
            m.id,
            m.team_id,
            m.pseudo,
            m.role,
            m.status,
            p.upstream_client_thread_visibility,
            m.created_at,
            m.updated_at
          FROM team_members m
          LEFT JOIN team_member_preferences p ON p.member_id = m.id
          WHERE m.team_id = ${teamId}
          ORDER BY m.created_at ASC
        `,
      );
      return rows.map(mapMemberRow);
    }),

    getMemberById: Effect.fn("TeamRepository.getMemberById")(function* (memberId) {
      const rows = yield* runSql(
        "getMemberById",
        sql<MemberRow>`
          SELECT
            m.id,
            m.team_id,
            m.pseudo,
            m.role,
            m.status,
            p.upstream_client_thread_visibility,
            m.created_at,
            m.updated_at
          FROM team_members m
          LEFT JOIN team_member_preferences p ON p.member_id = m.id
          WHERE m.id = ${memberId}
          LIMIT 1
        `,
      );
      return rows[0] ? Option.some(mapMemberRow(rows[0])) : Option.none();
    }),

    getMemberForSession: Effect.fn("TeamRepository.getMemberForSession")(function* (sessionId) {
      const rows = yield* runSql(
        "getMemberForSession",
        sql<MemberRow>`
          SELECT
            m.id,
            m.team_id,
            m.pseudo,
            m.role,
            m.status,
            p.upstream_client_thread_visibility,
            m.created_at,
            m.updated_at
          FROM team_session_meta s
          INNER JOIN team_members m ON m.id = s.member_id
          LEFT JOIN team_member_preferences p ON p.member_id = m.id
          WHERE s.session_id = ${sessionId}
          LIMIT 1
        `,
      );
      return rows[0] ? Option.some(mapMemberRow(rows[0])) : Option.none();
    }),

    getSessionBinding: Effect.fn("TeamRepository.getSessionBinding")(function* (sessionId) {
      const rows = yield* runSql(
        "getSessionBinding",
        sql<SessionMetaRow>`
          SELECT session_id, team_id, member_id, bound_at
          FROM team_session_meta
          WHERE session_id = ${sessionId}
          LIMIT 1
        `,
      );
      const row = rows[0];
      return row
        ? Option.some({
            sessionId: row.session_id as AuthSessionId,
            teamId: TeamId.make(row.team_id),
            memberId: TeamMemberId.make(row.member_id),
            boundAt: row.bound_at,
          })
        : Option.none();
    }),

    bindSession: Effect.fn("TeamRepository.bindSession")(function* (input) {
      yield* runSql(
        "bindSession",
        sql`
          INSERT OR REPLACE INTO team_session_meta (session_id, team_id, member_id, bound_at)
          VALUES (${input.sessionId}, ${input.teamId}, ${input.memberId}, ${input.boundAt})
        `,
      );
    }),

    updateMemberPseudo: Effect.fn("TeamRepository.updateMemberPseudo")(function* (input) {
      const updated = yield* sql<{ readonly id: string }>`
        UPDATE team_members
        SET pseudo = ${input.pseudo}, updated_at = ${input.updatedAt}
        WHERE id = ${input.memberId} AND team_id = ${input.teamId} AND status != 'removed'
        RETURNING id
      `.pipe(
        Effect.mapError((cause) =>
          isUniqueConstraintError(cause)
            ? new TeamPseudoAlreadyTakenError({ pseudo: input.pseudo })
            : new TeamRepositoryError({ operation: "updateMemberPseudo", cause }),
        ),
      );
      if (!updated[0]) {
        return Option.none<TeamMember>();
      }
      const rows = yield* runSql(
        "updateMemberPseudo.load",
        sql<MemberRow>`
          SELECT
            m.id,
            m.team_id,
            m.pseudo,
            m.role,
            m.status,
            p.upstream_client_thread_visibility,
            m.created_at,
            m.updated_at
          FROM team_members m
          LEFT JOIN team_member_preferences p ON p.member_id = m.id
          WHERE m.id = ${input.memberId} AND m.team_id = ${input.teamId}
          LIMIT 1
        `,
      );
      return rows[0] ? Option.some(mapMemberRow(rows[0])) : Option.none();
    }),

    updateMemberRole: Effect.fn("TeamRepository.updateMemberRole")(function* (input) {
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const actorRows = yield* sql<MemberRow>`
              SELECT id, team_id, pseudo, role, status, created_at, updated_at
              FROM team_members
              WHERE id = ${input.actorMemberId} AND team_id = ${input.teamId}
              LIMIT 1
            `;
            const actor = actorRows[0];
            if (!actor || actor.status !== "active" || !canManageTeamMembers(actor.role)) {
              return yield* new TeamMemberForbiddenError({
                reason: "Only active modo, admin, and owner members can manage member roles.",
              });
            }
            const currentRows = yield* sql<MemberRow>`
              SELECT id, team_id, pseudo, role, status, created_at, updated_at
              FROM team_members
              WHERE id = ${input.memberId} AND team_id = ${input.teamId}
              LIMIT 1
            `;
            const current = currentRows[0];
            if (!current) {
              return Option.none<{
                readonly previousRole: TeamRole;
                readonly member: TeamMember;
              }>();
            }
            if (current.status === "removed") {
              return yield* new TeamMemberForbiddenError({
                reason: "Cannot change the role of a removed member.",
              });
            }
            if (!canModifyTeamMember(actor.role, current.role)) {
              return yield* new TeamMemberForbiddenError({
                reason: `You cannot modify a member whose role "${current.role}" is higher than your own "${actor.role}".`,
              });
            }
            if (!canChangeTeamMemberRole(actor.role, current.role, input.role)) {
              return yield* new TeamMemberForbiddenError({
                reason: `You cannot assign role "${input.role}" above your own role "${actor.role}".`,
              });
            }
            if (current.role === "owner" && current.status === "active" && input.role !== "owner") {
              const owners = yield* sql<{ readonly count: number }>`
                SELECT COUNT(*) AS count
                FROM team_members
                WHERE team_id = ${input.teamId} AND role = 'owner' AND status = 'active'
              `;
              if ((owners[0]?.count ?? 0) <= 1) {
                return yield* new TeamLastOwnerProtectedError({});
              }
            }
            const updatedIds = yield* sql<{ readonly id: string }>`
              UPDATE team_members
              SET role = ${input.role}, updated_at = ${input.updatedAt}
              WHERE id = ${input.memberId} AND team_id = ${input.teamId} AND status != 'removed'
              RETURNING id
            `;
            if (!updatedIds[0]) {
              return Option.none<{
                readonly previousRole: TeamRole;
                readonly member: TeamMember;
              }>();
            }
            const updatedRows = yield* sql<MemberRow>`
              SELECT
                m.id,
                m.team_id,
                m.pseudo,
                m.role,
                m.status,
                p.upstream_client_thread_visibility,
                m.created_at,
                m.updated_at
              FROM team_members m
              LEFT JOIN team_member_preferences p ON p.member_id = m.id
              WHERE m.id = ${input.memberId} AND m.team_id = ${input.teamId}
              LIMIT 1
            `;
            return updatedRows[0]
              ? Option.some({
                  previousRole: current.role,
                  member: mapMemberRow(updatedRows[0]),
                })
              : Option.none<{ readonly previousRole: TeamRole; readonly member: TeamMember }>();
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            isTeamLastOwnerProtectedError(cause) || isTeamMemberForbiddenError(cause)
              ? cause
              : new TeamRepositoryError({ operation: "updateMemberRole", cause }),
          ),
        );
    }),

    updateMemberStatus: Effect.fn("TeamRepository.updateMemberStatus")(function* (input) {
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const actorRows = yield* sql<MemberRow>`
              SELECT id, team_id, pseudo, role, status, created_at, updated_at
              FROM team_members
              WHERE id = ${input.actorMemberId} AND team_id = ${input.teamId}
              LIMIT 1
            `;
            const actor = actorRows[0];
            if (!actor || actor.status !== "active" || !canManageTeamMembers(actor.role)) {
              return yield* new TeamMemberForbiddenError({
                reason: "Only active modo, admin, and owner members can suspend or remove members.",
              });
            }
            const currentRows = yield* sql<MemberRow>`
              SELECT id, team_id, pseudo, role, status, created_at, updated_at
              FROM team_members
              WHERE id = ${input.memberId} AND team_id = ${input.teamId}
              LIMIT 1
            `;
            const current = currentRows[0];
            if (!current) {
              return Option.none();
            }
            if (!canModifyTeamMember(actor.role, current.role)) {
              return yield* new TeamMemberForbiddenError({
                reason: `You cannot modify a member whose role "${current.role}" is higher than your own "${actor.role}".`,
              });
            }
            if (current.status === "removed" && input.status !== "removed") {
              return yield* new TeamMemberForbiddenError({
                reason: "Removed members cannot be reactivated; send a new invite instead.",
              });
            }
            if (
              current.role === "owner" &&
              current.status === "active" &&
              input.status !== "active"
            ) {
              const owners = yield* sql<{ readonly count: number }>`
                SELECT COUNT(*) AS count
                FROM team_members
                WHERE team_id = ${input.teamId} AND role = 'owner' AND status = 'active'
              `;
              if ((owners[0]?.count ?? 0) <= 1) {
                return yield* new TeamLastOwnerProtectedError({});
              }
            }
            const updatedIds = yield* sql<{ readonly id: string }>`
              UPDATE team_members
              SET status = ${input.status}, updated_at = ${input.updatedAt}
              WHERE id = ${input.memberId} AND team_id = ${input.teamId}
              RETURNING id
            `;
            if (!updatedIds[0]) {
              return Option.none();
            }
            const updatedViews: Array<TeamView> = [];
            const updatedEnvironments: Array<TeamEnvironment> = [];
            if (input.status === "removed") {
              const views = yield* sql<ViewRow>`
                SELECT id, team_id, name, description, is_default,
                       read_roles_json, read_member_ids_json,
                       post_roles_json, post_member_ids_json,
                       created_at, updated_at
                FROM team_views
                WHERE team_id = ${input.teamId}
              `;
              for (const view of views) {
                const readIds = parseMemberIdArray(view.read_member_ids_json);
                const postIds = parseMemberIdArray(view.post_member_ids_json);
                const nextReadIds = readIds.filter((id) => id !== input.memberId);
                const nextPostIds = postIds.filter((id) => id !== input.memberId);
                if (
                  nextReadIds.length !== readIds.length ||
                  nextPostIds.length !== postIds.length
                ) {
                  const nextReadJson = encodeStringArrayJson(nextReadIds);
                  const nextPostJson = encodeStringArrayJson(nextPostIds);
                  yield* sql`
                    UPDATE team_views
                    SET
                      read_member_ids_json = ${nextReadJson},
                      post_member_ids_json = ${nextPostJson},
                      updated_at = ${input.updatedAt}
                    WHERE id = ${view.id}
                  `;
                  updatedViews.push(
                    mapViewRow({
                      ...view,
                      read_member_ids_json: nextReadJson,
                      post_member_ids_json: nextPostJson,
                      updated_at: input.updatedAt,
                    }),
                  );
                }
              }
              const envs = yield* sql<TeamEnvironmentRow>`
                SELECT id, team_id, environment_id, name, is_default, peer_link_id,
                       access_roles_json, access_member_ids_json, created_at, updated_at
                FROM team_environments
                WHERE team_id = ${input.teamId}
              `;
              for (const env of envs) {
                const accessIds = parseMemberIdArray(env.access_member_ids_json);
                const nextAccessIds = accessIds.filter((id) => id !== input.memberId);
                if (nextAccessIds.length !== accessIds.length) {
                  const nextAccessJson = encodeStringArrayJson(nextAccessIds);
                  yield* sql`
                    UPDATE team_environments
                    SET
                      access_member_ids_json = ${nextAccessJson},
                      updated_at = ${input.updatedAt}
                    WHERE id = ${env.id}
                  `;
                  updatedEnvironments.push(
                    mapEnvironmentRow({
                      ...env,
                      access_member_ids_json: nextAccessJson,
                      updated_at: input.updatedAt,
                    }),
                  );
                }
              }
            }
            const updatedRows = yield* sql<MemberRow>`
              SELECT
                m.id,
                m.team_id,
                m.pseudo,
                m.role,
                m.status,
                p.upstream_client_thread_visibility,
                m.created_at,
                m.updated_at
              FROM team_members m
              LEFT JOIN team_member_preferences p ON p.member_id = m.id
              WHERE m.id = ${input.memberId} AND m.team_id = ${input.teamId}
              LIMIT 1
            `;
            return updatedRows[0]
              ? Option.some({
                  member: mapMemberRow(updatedRows[0]),
                  updatedViews,
                  updatedEnvironments,
                })
              : Option.none();
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            isTeamLastOwnerProtectedError(cause) || isTeamMemberForbiddenError(cause)
              ? cause
              : new TeamRepositoryError({ operation: "updateMemberStatus", cause }),
          ),
        );
    }),

    listSessionIdsForMember: Effect.fn("TeamRepository.listSessionIdsForMember")(
      function* (memberId) {
        const rows = yield* runSql(
          "listSessionIdsForMember",
          sql<{ readonly session_id: string }>`
            SELECT session_id
            FROM team_session_meta
            WHERE member_id = ${memberId}
          `,
        );
        return rows.map((row) => row.session_id as AuthSessionId);
      },
    ),

    leaveTeam: Effect.fn("TeamRepository.leaveTeam")(function* (input) {
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const existingRows = yield* sql<MemberRow>`
              SELECT
                m.id,
                m.team_id,
                m.pseudo,
                m.role,
                m.status,
                p.upstream_client_thread_visibility,
                m.created_at,
                m.updated_at
              FROM team_members m
              LEFT JOIN team_member_preferences p ON p.member_id = m.id
              WHERE m.id = ${input.memberId} AND m.team_id = ${input.teamId}
              LIMIT 1
            `;
            const current = existingRows[0];
            if (!current || current.status !== "active") {
              return Option.none();
            }
            if (current.role === "owner") {
              const owners = yield* sql<{ readonly count: number }>`
                SELECT COUNT(*) AS count
                FROM team_members
                WHERE team_id = ${input.teamId} AND role = 'owner' AND status = 'active'
              `;
              if ((owners[0]?.count ?? 0) <= 1) {
                return yield* new TeamLastOwnerProtectedError({});
              }
            }
            yield* sql`
              UPDATE team_members
              SET status = 'removed', updated_at = ${input.updatedAt}
              WHERE id = ${input.memberId} AND team_id = ${input.teamId}
            `;
            yield* sql`
              DELETE FROM team_thread_follows
              WHERE member_id = ${input.memberId}
            `;
            yield* sql`
              DELETE FROM team_member_preferences
              WHERE member_id = ${input.memberId}
            `;
            yield* sql`
              DELETE FROM team_relay_binding
              WHERE member_id = ${input.memberId}
            `;
            const views = yield* sql<ViewRow>`
              SELECT id, team_id, name, description, is_default,
                     read_roles_json, read_member_ids_json,
                     post_roles_json, post_member_ids_json,
                     created_at, updated_at
              FROM team_views
              WHERE team_id = ${input.teamId}
            `;
            const updatedViews: Array<TeamView> = [];
            for (const view of views) {
              const readIds = parseMemberIdArray(view.read_member_ids_json);
              const postIds = parseMemberIdArray(view.post_member_ids_json);
              const nextReadIds = readIds.filter((id) => id !== input.memberId);
              const nextPostIds = postIds.filter((id) => id !== input.memberId);
              if (nextReadIds.length !== readIds.length || nextPostIds.length !== postIds.length) {
                const nextReadJson = encodeStringArrayJson(nextReadIds);
                const nextPostJson = encodeStringArrayJson(nextPostIds);
                yield* sql`
                  UPDATE team_views
                  SET
                    read_member_ids_json = ${nextReadJson},
                    post_member_ids_json = ${nextPostJson},
                    updated_at = ${input.updatedAt}
                  WHERE id = ${view.id}
                `;
                updatedViews.push(
                  mapViewRow({
                    ...view,
                    read_member_ids_json: nextReadJson,
                    post_member_ids_json: nextPostJson,
                    updated_at: input.updatedAt,
                  }),
                );
              }
            }
            const envs = yield* sql<TeamEnvironmentRow>`
              SELECT id, team_id, environment_id, name, is_default, peer_link_id,
                     access_roles_json, access_member_ids_json, created_at, updated_at
              FROM team_environments
              WHERE team_id = ${input.teamId}
            `;
            const updatedEnvironments: Array<TeamEnvironment> = [];
            for (const env of envs) {
              const accessIds = parseMemberIdArray(env.access_member_ids_json);
              const nextAccessIds = accessIds.filter((id) => id !== input.memberId);
              if (nextAccessIds.length !== accessIds.length) {
                const nextAccessJson = encodeStringArrayJson(nextAccessIds);
                yield* sql`
                  UPDATE team_environments
                  SET
                    access_member_ids_json = ${nextAccessJson},
                    updated_at = ${input.updatedAt}
                  WHERE id = ${env.id}
                `;
                updatedEnvironments.push(
                  mapEnvironmentRow({
                    ...env,
                    access_member_ids_json: nextAccessJson,
                    updated_at: input.updatedAt,
                  }),
                );
              }
            }
            const updatedRows = yield* sql<MemberRow>`
              SELECT
                m.id,
                m.team_id,
                m.pseudo,
                m.role,
                m.status,
                p.upstream_client_thread_visibility,
                m.created_at,
                m.updated_at
              FROM team_members m
              LEFT JOIN team_member_preferences p ON p.member_id = m.id
              WHERE m.id = ${input.memberId} AND m.team_id = ${input.teamId}
              LIMIT 1
            `;
            return updatedRows[0]
              ? Option.some({
                  member: mapMemberRow(updatedRows[0]),
                  updatedViews,
                  updatedEnvironments,
                })
              : Option.none();
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            isTeamLastOwnerProtectedError(cause)
              ? cause
              : new TeamRepositoryError({ operation: "leaveTeam", cause }),
          ),
        );
    }),

    collectDeleteCleanupTargets: Effect.fn("TeamRepository.collectDeleteCleanupTargets")(
      function* (teamId) {
        return yield* Effect.gen(function* () {
          const existing = yield* sql<{ readonly id: string }>`
            SELECT id FROM team_workspaces WHERE id = ${teamId} LIMIT 1
          `;
          if (existing.length === 0) {
            return {
              exists: false,
              sessionIds: [],
              pairingLinkIds: [],
              providerSecretKeys: [],
              githubSecretKeys: [],
              githubAppClientSecretKey: null,
              scheduledTaskIds: [],
            };
          }
          const sessionRows = yield* sql<{ readonly session_id: string }>`
            SELECT session_id FROM team_session_meta WHERE team_id = ${teamId}
          `;
          const pairingRows = yield* sql<{ readonly pairing_link_id: string }>`
            SELECT pairing_link_id FROM team_pairing_meta WHERE team_id = ${teamId}
          `;
          const providerSecretRows = yield* sql<{ readonly secret_key: string | null }>`
            SELECT secret_key FROM team_providers WHERE team_id = ${teamId} AND secret_key IS NOT NULL
          `;
          const memberGhSecretRows = yield* sql<{ readonly secret_key: string }>`
            SELECT secret_key FROM team_github_member_credentials WHERE team_id = ${teamId}
          `;
          const autoGhSecretRows = yield* sql<{ readonly secret_key: string }>`
            SELECT secret_key FROM team_github_automation_credentials WHERE team_id = ${teamId}
          `;
          const appGhSecretRows = yield* sql<{ readonly client_secret_key: string | null }>`
            SELECT client_secret_key FROM team_github_app_config WHERE team_id = ${teamId}
          `;
          const scheduledTaskRows = yield* sql<{ readonly task_id: string }>`
            SELECT task_id FROM team_scheduled_task_meta WHERE team_id = ${teamId}
          `;
          return {
            exists: true,
            sessionIds: sessionRows.map((row) => row.session_id as AuthSessionId),
            pairingLinkIds: pairingRows.map((row) => row.pairing_link_id),
            providerSecretKeys: providerSecretRows.flatMap((row) =>
              row.secret_key ? [row.secret_key] : [],
            ),
            githubSecretKeys: [
              ...memberGhSecretRows.map((row) => row.secret_key),
              ...autoGhSecretRows.map((row) => row.secret_key),
            ],
            githubAppClientSecretKey: appGhSecretRows[0]?.client_secret_key ?? null,
            scheduledTaskIds: scheduledTaskRows.map((row) => ScheduledTaskId.make(row.task_id)),
          };
        }).pipe(
          Effect.mapError(
            (cause) => new TeamRepositoryError({ operation: "collectDeleteCleanupTargets", cause }),
          ),
        );
      },
    ),

    deleteTeam: Effect.fn("TeamRepository.deleteTeam")(function* (teamId) {
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const existing = yield* sql<{ readonly id: string }>`
              SELECT id FROM team_workspaces WHERE id = ${teamId} LIMIT 1
            `;
            if (existing.length === 0) {
              return {
                deleted: false,
                sessionIds: [],
                pairingLinkIds: [],
                providerSecretKeys: [],
                githubSecretKeys: [],
                githubAppClientSecretKey: null,
              };
            }
            const sessionRows = yield* sql<{ readonly session_id: string }>`
              SELECT session_id FROM team_session_meta WHERE team_id = ${teamId}
            `;
            const pairingRows = yield* sql<{ readonly pairing_link_id: string }>`
              SELECT pairing_link_id FROM team_pairing_meta WHERE team_id = ${teamId}
            `;
            const providerSecretRows = yield* sql<{ readonly secret_key: string | null }>`
              SELECT secret_key FROM team_providers WHERE team_id = ${teamId} AND secret_key IS NOT NULL
            `;
            const memberGhSecretRows = yield* sql<{ readonly secret_key: string }>`
              SELECT secret_key FROM team_github_member_credentials WHERE team_id = ${teamId}
            `;
            const autoGhSecretRows = yield* sql<{ readonly secret_key: string }>`
              SELECT secret_key FROM team_github_automation_credentials WHERE team_id = ${teamId}
            `;
            const appGhSecretRows = yield* sql<{ readonly client_secret_key: string | null }>`
              SELECT client_secret_key FROM team_github_app_config WHERE team_id = ${teamId}
            `;

            // Delete leaf/referencing tables first to respect all FK constraints cleanly.
            yield* sql`DELETE FROM team_automation_turn_scopes WHERE team_id = ${teamId}`;
            yield* sql`DELETE FROM team_scheduled_task_meta WHERE team_id = ${teamId}`;
            yield* sql`DELETE FROM team_github_app_config WHERE team_id = ${teamId}`;
            yield* sql`DELETE FROM team_github_automation_credentials WHERE team_id = ${teamId}`;
            yield* sql`DELETE FROM team_github_member_credentials WHERE team_id = ${teamId}`;
            yield* sql`
              DELETE FROM team_session_scope_ceilings
              WHERE session_id IN (SELECT session_id FROM team_session_meta WHERE team_id = ${teamId})
            `;
            yield* sql`DELETE FROM team_member_preferences WHERE team_id = ${teamId}`;
            yield* sql`DELETE FROM team_pairing_meta WHERE team_id = ${teamId}`;
            yield* sql`DELETE FROM team_local_sync_tokens WHERE team_id = ${teamId}`;
            yield* sql`DELETE FROM team_asset_tombstones WHERE team_id = ${teamId}`;
            yield* sql`DELETE FROM team_asset_revisions WHERE team_id = ${teamId}`;
            yield* sql`DELETE FROM team_preprompts WHERE team_id = ${teamId}`;
            yield* sql`DELETE FROM team_skills WHERE team_id = ${teamId}`;
            yield* sql`DELETE FROM team_provider_usage WHERE team_id = ${teamId}`;
            yield* sql`DELETE FROM team_providers WHERE team_id = ${teamId}`;
            // Preserve team_pending_remote_revocations so offline peer revocations
            // enqueued before/during team deletion still drain when those peers reconnect.
            yield* sql`
              DELETE FROM team_thread_env_labels
              WHERE thread_id IN (SELECT thread_id FROM team_thread_meta WHERE team_id = ${teamId})
            `;
            yield* sql`DELETE FROM team_thread_notes WHERE team_id = ${teamId}`;
            yield* sql`DELETE FROM team_environments WHERE team_id = ${teamId}`;
            yield* sql`DELETE FROM team_project_meta WHERE team_id = ${teamId}`;
            yield* sql`DELETE FROM team_views WHERE team_id = ${teamId}`;
            yield* sql`DELETE FROM team_relay_binding WHERE team_id = ${teamId}`;
            yield* sql`
              DELETE FROM team_thread_follows
              WHERE member_id IN (SELECT id FROM team_members WHERE team_id = ${teamId})
            `;
            yield* sql`
              DELETE FROM team_turn_meta
              WHERE thread_id IN (SELECT thread_id FROM team_thread_meta WHERE team_id = ${teamId})
                 OR author_member_id IN (SELECT id FROM team_members WHERE team_id = ${teamId})
            `;
            yield* sql`DELETE FROM team_thread_meta WHERE team_id = ${teamId}`;
            yield* sql`DELETE FROM team_session_meta WHERE team_id = ${teamId}`;
            yield* sql`DELETE FROM team_invites WHERE team_id = ${teamId}`;
            yield* sql`DELETE FROM team_members WHERE team_id = ${teamId}`;
            yield* sql`DELETE FROM team_workspaces WHERE id = ${teamId}`;

            return {
              deleted: true,
              sessionIds: sessionRows.map((row) => row.session_id as AuthSessionId),
              pairingLinkIds: pairingRows.map((row) => row.pairing_link_id),
              providerSecretKeys: providerSecretRows.flatMap((row) =>
                row.secret_key ? [row.secret_key] : [],
              ),
              githubSecretKeys: [
                ...memberGhSecretRows.map((row) => row.secret_key),
                ...autoGhSecretRows.map((row) => row.secret_key),
              ],
              githubAppClientSecretKey: appGhSecretRows[0]?.client_secret_key ?? null,
            };
          }),
        )
        .pipe(
          Effect.mapError((cause) => new TeamRepositoryError({ operation: "deleteTeam", cause })),
        );
    }),

    listViews: Effect.fn("TeamRepository.listViews")(function* (teamId) {
      const rows = yield* runSql(
        "listViews",
        sql<ViewRow>`
          SELECT id, team_id, name, description, is_default,
                 read_roles_json, read_member_ids_json,
                 post_roles_json, post_member_ids_json,
                 created_at, updated_at
          FROM team_views
          WHERE team_id = ${teamId}
          ORDER BY is_default DESC, created_at ASC
        `,
      );
      return rows.map(mapViewRow);
    }),

    getViewById: Effect.fn("TeamRepository.getViewById")(function* (viewId) {
      const rows = yield* runSql(
        "getViewById",
        sql<ViewRow>`
          SELECT id, team_id, name, description, is_default,
                 read_roles_json, read_member_ids_json,
                 post_roles_json, post_member_ids_json,
                 created_at, updated_at
          FROM team_views
          WHERE id = ${viewId}
          LIMIT 1
        `,
      );
      return rows[0] ? Option.some(mapViewRow(rows[0])) : Option.none();
    }),

    createView: Effect.fn("TeamRepository.createView")(function* (view) {
      yield* sql`
        INSERT INTO team_views (
          id, team_id, name, description, is_default,
          read_roles_json, read_member_ids_json,
          post_roles_json, post_member_ids_json,
          created_at, updated_at
        )
        VALUES (
          ${view.id},
          ${view.teamId},
          ${view.name},
          ${view.description},
          ${view.isDefault ? 1 : 0},
          ${encodeStringArrayJson(view.readRule.roles)},
          ${encodeStringArrayJson(view.readRule.memberIds)},
          ${encodeStringArrayJson(view.postRule.roles)},
          ${encodeStringArrayJson(view.postRule.memberIds)},
          ${view.createdAt},
          ${view.updatedAt}
        )
      `.pipe(
        Effect.mapError((cause) =>
          isUniqueConstraintError(cause)
            ? new TeamViewNameAlreadyTakenError({ viewName: view.name })
            : new TeamRepositoryError({ operation: "createView", cause }),
        ),
      );
    }),

    updateView: Effect.fn("TeamRepository.updateView")(function* (input) {
      const existing = yield* runSql(
        "updateView.select",
        sql<ViewRow>`
          SELECT id, team_id, name, description, is_default,
                 read_roles_json, read_member_ids_json,
                 post_roles_json, post_member_ids_json,
                 created_at, updated_at
          FROM team_views
          WHERE id = ${input.viewId} AND team_id = ${input.teamId}
          LIMIT 1
        `,
      );
      const current = existing[0];
      if (!current) {
        return Option.none<TeamView>();
      }
      const nextName = input.name ?? current.name;
      const nextDescription =
        input.description !== undefined ? input.description : current.description;
      const nextReadRolesJson =
        input.readRule !== undefined
          ? encodeStringArrayJson(input.readRule.roles)
          : current.read_roles_json;
      const nextReadMemberIdsJson =
        input.readRule !== undefined
          ? encodeStringArrayJson(input.readRule.memberIds)
          : current.read_member_ids_json;
      const nextPostRolesJson =
        input.postRule !== undefined
          ? encodeStringArrayJson(input.postRule.roles)
          : current.post_roles_json;
      const nextPostMemberIdsJson =
        input.postRule !== undefined
          ? encodeStringArrayJson(input.postRule.memberIds)
          : current.post_member_ids_json;

      const updated = yield* sql<ViewRow>`
        UPDATE team_views
        SET
          name = ${nextName},
          description = ${nextDescription},
          read_roles_json = ${nextReadRolesJson},
          read_member_ids_json = ${nextReadMemberIdsJson},
          post_roles_json = ${nextPostRolesJson},
          post_member_ids_json = ${nextPostMemberIdsJson},
          updated_at = ${input.updatedAt}
        WHERE id = ${input.viewId} AND team_id = ${input.teamId}
        RETURNING id, team_id, name, description, is_default,
                  read_roles_json, read_member_ids_json,
                  post_roles_json, post_member_ids_json,
                  created_at, updated_at
      `.pipe(
        Effect.mapError((cause) =>
          isUniqueConstraintError(cause)
            ? new TeamViewNameAlreadyTakenError({ viewName: nextName })
            : new TeamRepositoryError({ operation: "updateView", cause }),
        ),
      );
      return updated[0] ? Option.some(mapViewRow(updated[0])) : Option.none();
    }),

    deleteViewAndReassignThreads: Effect.fn("TeamRepository.deleteViewAndReassignThreads")(
      function* (input) {
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const existing = yield* sql<{ readonly id: string; readonly is_default: number }>`
                SELECT id, is_default
                FROM team_views
                WHERE id = ${input.viewId} AND team_id = ${input.teamId}
                LIMIT 1
              `;
              const row = existing[0];
              if (!row) return false;
              if (row.is_default === 1) {
                return yield* new TeamDefaultViewProtectedError({});
              }
              yield* sql`
                UPDATE team_thread_meta
                SET view_id = ${input.fallbackViewId}
                WHERE team_id = ${input.teamId} AND view_id = ${input.viewId}
              `;
              yield* sql`
                UPDATE team_scheduled_task_meta
                SET view_id = ${input.fallbackViewId}
                WHERE team_id = ${input.teamId} AND view_id = ${input.viewId}
              `;
              const deleted = yield* sql<{ readonly id: string }>`
                DELETE FROM team_views
                WHERE id = ${input.viewId} AND team_id = ${input.teamId} AND is_default = 0
                RETURNING id
              `;
              return deleted.length > 0;
            }),
          )
          .pipe(
            Effect.mapError((cause) =>
              isTeamDefaultViewProtectedError(cause)
                ? cause
                : new TeamRepositoryError({ operation: "deleteViewAndReassignThreads", cause }),
            ),
          );
      },
    ),

    createInvite: Effect.fn("TeamRepository.createInvite")(function* (invite) {
      yield* runSql(
        "createInvite",
        sql`
          INSERT INTO team_invites (
            id, team_id, token_hash, role, prefilled_pseudo, max_uses, uses,
            expires_at, created_by_member_id, revoked_at, created_at
          )
          VALUES (
            ${invite.id},
            ${invite.teamId},
            ${invite.tokenHash},
            ${invite.role},
            ${invite.prefilledPseudo},
            ${invite.maxUses},
            ${invite.uses},
            ${invite.expiresAt},
            ${invite.createdByMemberId},
            ${invite.revokedAt},
            ${invite.createdAt}
          )
        `,
      );
    }),

    listInvites: Effect.fn("TeamRepository.listInvites")(function* (teamId) {
      const rows = yield* runSql(
        "listInvites",
        sql<InviteRow>`
          SELECT id, team_id, token_hash, role, prefilled_pseudo, max_uses, uses,
                 expires_at, created_by_member_id, revoked_at, created_at
          FROM team_invites
          WHERE team_id = ${teamId}
          ORDER BY created_at DESC
        `,
      );
      return rows.map((row) => {
        const { tokenHash: _hash, ...invite } = mapInviteRow(row);
        return invite;
      });
    }),

    getInviteById: Effect.fn("TeamRepository.getInviteById")(function* (inviteId) {
      const rows = yield* runSql(
        "getInviteById",
        sql<InviteRow>`
          SELECT id, team_id, token_hash, role, prefilled_pseudo, max_uses, uses,
                 expires_at, created_by_member_id, revoked_at, created_at
          FROM team_invites
          WHERE id = ${inviteId}
          LIMIT 1
        `,
      );
      return rows[0] ? Option.some(mapInviteRow(rows[0])) : Option.none();
    }),

    getInviteByTokenHash: Effect.fn("TeamRepository.getInviteByTokenHash")(function* (tokenHash) {
      const rows = yield* runSql(
        "getInviteByTokenHash",
        sql<InviteRow>`
          SELECT id, team_id, token_hash, role, prefilled_pseudo, max_uses, uses,
                 expires_at, created_by_member_id, revoked_at, created_at
          FROM team_invites
          WHERE token_hash = ${tokenHash}
          LIMIT 1
        `,
      );
      return rows[0] ? Option.some(mapInviteRow(rows[0])) : Option.none();
    }),

    revokeInvite: Effect.fn("TeamRepository.revokeInvite")(function* (input) {
      const rows = yield* runSql(
        "revokeInvite",
        sql<{ readonly id: string }>`
          UPDATE team_invites
          SET revoked_at = ${input.revokedAt}
          WHERE id = ${input.inviteId} AND revoked_at IS NULL
          RETURNING id
        `,
      );
      return rows.length > 0;
    }),

    consumeInviteAndCreateMember: Effect.fn("TeamRepository.consumeInviteAndCreateMember")(
      function* (input) {
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const updated = yield* sql<{ readonly id: string }>`
                UPDATE team_invites
                SET uses = uses + 1
                WHERE id = ${input.inviteId}
                  AND revoked_at IS NULL
                  AND uses < max_uses
                  AND expires_at > ${input.nowIso}
                RETURNING id
              `;
              if (updated.length === 0) return false;
              yield* sql`
                INSERT INTO team_members (id, team_id, pseudo, role, status, created_at, updated_at)
                VALUES (
                  ${input.member.id},
                  ${input.member.teamId},
                  ${input.member.pseudo},
                  ${input.member.role},
                  ${input.member.status},
                  ${input.member.createdAt},
                  ${input.member.updatedAt}
                )
              `;
              return true;
            }),
          )
          .pipe(
            Effect.mapError((cause) =>
              isUniqueConstraintError(cause)
                ? new TeamPseudoAlreadyTakenError({ pseudo: input.member.pseudo })
                : new TeamRepositoryError({ operation: "consumeInviteAndCreateMember", cause }),
            ),
          );
      },
    ),

    rollbackInviteConsumption: Effect.fn("TeamRepository.rollbackInviteConsumption")(
      function* (input) {
        yield* runSql(
          "rollbackInviteConsumption",
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`
                DELETE FROM team_members
                WHERE id = ${input.memberId}
              `;
              yield* sql`
                UPDATE team_invites
                SET uses = CASE WHEN uses > 0 THEN uses - 1 ELSE 0 END
                WHERE id = ${input.inviteId}
              `;
            }),
          ),
        );
      },
    ),

    recordThreadAttribution: Effect.fn("TeamRepository.recordThreadAttribution")(function* (input) {
      const ownerKind: TeamThreadOwnerKind =
        input.ownerKind ?? (input.creatorMemberId === null ? "team" : "member");
      const creatorMemberId = ownerKind === "team" ? null : input.creatorMemberId;
      yield* runSql(
        "recordThreadAttribution.insert",
        sql.withTransaction(
          Effect.gen(function* () {
            const insertedRows = yield* sql<{ readonly thread_id: string }>`
              INSERT OR IGNORE INTO team_thread_meta (
                thread_id, team_id, owner_kind, creator_member_id, view_id, locked, locked_by_member_id,
                execution_environment_id, is_local_synced, created_at
              )
              VALUES (
                ${input.threadId},
                ${input.teamId},
                ${ownerKind},
                ${creatorMemberId},
                ${input.viewId},
                ${input.locked === true ? 1 : 0},
                ${input.locked === true ? (input.lockedByMemberId ?? creatorMemberId) : null},
                ${input.executionEnvironmentId ?? null},
                ${input.isLocalSynced === true ? 1 : 0},
                ${input.createdAt}
              )
              RETURNING thread_id
            `;
            if (insertedRows.length === 0) return;
            if (input.executionEnvironmentLabel != null) {
              yield* sql`
                INSERT OR IGNORE INTO team_thread_env_labels (thread_id, execution_environment_label)
                VALUES (${input.threadId}, ${input.executionEnvironmentLabel})
              `;
            }
            if (input.ownerAutomationScope !== undefined) {
              const scope = input.ownerAutomationScope;
              yield* sql`
                INSERT OR IGNORE INTO team_automation_turn_scopes (
                  turn_id, thread_id, task_id, team_id, project_id, environment_id, view_id,
                  mcp_access_level, created_at
                )
                VALUES (
                  ${scope.turnId},
                  ${scope.threadId},
                  ${scope.taskId},
                  ${scope.teamId},
                  ${scope.projectId},
                  ${scope.environmentId},
                  ${scope.viewId},
                  ${scope.mcpAccessLevel},
                  ${scope.createdAt}
                )
              `;
            }
          }),
        ),
      );
      const rows = yield* runSql(
        "recordThreadAttribution.select",
        sql<ThreadMetaRow>`
          SELECT t.thread_id, t.team_id, t.owner_kind, t.creator_member_id, m.pseudo AS creator_pseudo,
                 COALESCE(NULLIF(TRIM(w.display_name), ''), w.name) AS team_display_name,
                 t.view_id, t.locked, t.locked_by_member_id,
                 t.execution_environment_id, el.execution_environment_label,
                 t.is_local_synced, t.created_at
          FROM team_thread_meta t
          LEFT JOIN team_members m ON m.id = t.creator_member_id
          LEFT JOIN team_workspaces w ON w.id = t.team_id
          LEFT JOIN team_thread_env_labels el ON el.thread_id = t.thread_id
          WHERE t.thread_id = ${input.threadId}
          LIMIT 1
        `,
      );
      return rows[0] ? Option.some(mapThreadMetaRow(rows[0])) : Option.none();
    }),

    upsertLocalSyncedThreadAttribution: Effect.fn(
      "TeamRepository.upsertLocalSyncedThreadAttribution",
    )(function* (input) {
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const existingRows = yield* sql<{
              readonly team_id: string;
              readonly creator_member_id: string | null;
              readonly is_local_synced: number;
              readonly execution_environment_id: string | null;
            }>`
              SELECT team_id, creator_member_id, is_local_synced, execution_environment_id
              FROM team_thread_meta
              WHERE thread_id = ${input.threadId}
              LIMIT 1
            `;
            const existing = existingRows[0];
            if (existing) {
              if (
                existing.team_id !== input.teamId ||
                existing.creator_member_id !== input.creatorMemberId ||
                existing.is_local_synced !== 1
              ) {
                return yield* new TeamMemberForbiddenError({
                  reason: "Only the owner of a local-synced thread can update its synced state.",
                });
              }
              yield* sql`
                UPDATE team_thread_meta
                SET execution_environment_id = ${input.executionEnvironmentId}
                WHERE thread_id = ${input.threadId} AND team_id = ${input.teamId}
              `;
              yield* sql`
                INSERT OR REPLACE INTO team_thread_env_labels (thread_id, execution_environment_label)
                VALUES (${input.threadId}, ${input.executionEnvironmentLabel})
              `;
            } else {
              yield* sql`
                INSERT INTO team_thread_meta (
                  thread_id, team_id, owner_kind, creator_member_id, view_id, locked, locked_by_member_id,
                  execution_environment_id, is_local_synced, created_at
                )
                VALUES (
                  ${input.threadId},
                  ${input.teamId},
                  'member',
                  ${input.creatorMemberId},
                  ${input.viewId},
                  ${input.locked === true ? 1 : 0},
                  ${input.locked === true ? (input.lockedByMemberId ?? input.creatorMemberId) : null},
                  ${input.executionEnvironmentId},
                  1,
                  ${input.createdAt}
                )
              `;
              yield* sql`
                INSERT OR REPLACE INTO team_thread_env_labels (thread_id, execution_environment_label)
                VALUES (${input.threadId}, ${input.executionEnvironmentLabel})
              `;
            }
            const rows = yield* sql<ThreadMetaRow>`
              SELECT t.thread_id, t.team_id, t.owner_kind, t.creator_member_id, m.pseudo AS creator_pseudo,
                     COALESCE(NULLIF(TRIM(w.display_name), ''), w.name) AS team_display_name,
                     t.view_id, t.locked, t.locked_by_member_id,
                     t.execution_environment_id, el.execution_environment_label,
                     t.is_local_synced, t.created_at
              FROM team_thread_meta t
              LEFT JOIN team_members m ON m.id = t.creator_member_id
              LEFT JOIN team_workspaces w ON w.id = t.team_id
              LEFT JOIN team_thread_env_labels el ON el.thread_id = t.thread_id
              WHERE t.thread_id = ${input.threadId}
              LIMIT 1
            `;
            return rows[0] ? Option.some(mapThreadMetaRow(rows[0])) : Option.none();
          }),
        )
        .pipe(
          Effect.mapError((cause) => {
            if (isTeamMemberForbiddenError(cause)) return cause;
            return new TeamRepositoryError({
              operation: "upsertLocalSyncedThreadAttribution",
              cause,
            });
          }),
        );
    }),

    updateThreadView: Effect.fn("TeamRepository.updateThreadView")(function* (input) {
      const updated = yield* runSql(
        "updateThreadView.update",
        sql<{ readonly thread_id: string }>`
          UPDATE team_thread_meta
          SET view_id = ${input.viewId}
          WHERE thread_id = ${input.threadId} AND team_id = ${input.teamId}
          RETURNING thread_id
        `,
      );
      if (updated.length === 0) {
        return Option.none<TeamThreadAttribution>();
      }
      const rows = yield* runSql(
        "updateThreadView.select",
        sql<ThreadMetaRow>`
          SELECT t.thread_id, t.team_id, t.owner_kind, t.creator_member_id, m.pseudo AS creator_pseudo,
                 COALESCE(NULLIF(TRIM(w.display_name), ''), w.name) AS team_display_name,
                 t.view_id, t.locked, t.locked_by_member_id,
                 t.execution_environment_id, el.execution_environment_label,
                 t.is_local_synced, t.created_at
          FROM team_thread_meta t
          LEFT JOIN team_members m ON m.id = t.creator_member_id
          LEFT JOIN team_workspaces w ON w.id = t.team_id
          LEFT JOIN team_thread_env_labels el ON el.thread_id = t.thread_id
          WHERE t.thread_id = ${input.threadId}
          LIMIT 1
        `,
      );
      return rows[0] ? Option.some(mapThreadMetaRow(rows[0])) : Option.none();
    }),

    updateThreadLocked: Effect.fn("TeamRepository.updateThreadLocked")(function* (input) {
      const updated = yield* runSql(
        "updateThreadLocked.update",
        sql<{ readonly thread_id: string }>`
          UPDATE team_thread_meta
          SET locked = ${input.locked ? 1 : 0},
              locked_by_member_id = ${input.locked ? input.lockedByMemberId : null}
          WHERE thread_id = ${input.threadId} AND team_id = ${input.teamId}
          RETURNING thread_id
        `,
      );
      if (updated.length === 0) {
        return Option.none<TeamThreadAttribution>();
      }
      const rows = yield* runSql(
        "updateThreadLocked.select",
        sql<ThreadMetaRow>`
          SELECT t.thread_id, t.team_id, t.owner_kind, t.creator_member_id, m.pseudo AS creator_pseudo,
                 COALESCE(NULLIF(TRIM(w.display_name), ''), w.name) AS team_display_name,
                 t.view_id, t.locked, t.locked_by_member_id,
                 t.execution_environment_id, el.execution_environment_label,
                 t.is_local_synced, t.created_at
          FROM team_thread_meta t
          LEFT JOIN team_members m ON m.id = t.creator_member_id
          LEFT JOIN team_workspaces w ON w.id = t.team_id
          LEFT JOIN team_thread_env_labels el ON el.thread_id = t.thread_id
          WHERE t.thread_id = ${input.threadId}
          LIMIT 1
        `,
      );
      return rows[0] ? Option.some(mapThreadMetaRow(rows[0])) : Option.none();
    }),

    deleteThreadAttribution: Effect.fn("TeamRepository.deleteThreadAttribution")(
      function* (threadId) {
        yield* runSql(
          "deleteThreadAttribution",
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`DELETE FROM team_thread_meta WHERE thread_id = ${threadId}`;
              yield* sql`DELETE FROM team_thread_env_labels WHERE thread_id = ${threadId}`;
              yield* sql`DELETE FROM team_turn_meta WHERE thread_id = ${threadId}`;
              yield* sql`DELETE FROM team_automation_turn_scopes WHERE thread_id = ${threadId}`;
            }),
          ),
        );
      },
    ),

    deleteTurnAttribution: Effect.fn("TeamRepository.deleteTurnAttribution")(function* (input) {
      yield* runSql(
        "deleteTurnAttribution",
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              DELETE FROM team_turn_meta
              WHERE thread_id = ${input.threadId} AND turn_id = ${input.turnId}
            `;
            yield* sql`
              DELETE FROM team_automation_turn_scopes
              WHERE thread_id = ${input.threadId} AND turn_id = ${input.turnId}
            `;
          }),
        ),
      );
    }),

    listThreadAttributions: Effect.fn("TeamRepository.listThreadAttributions")(function* (teamId) {
      const rows = yield* runSql(
        "listThreadAttributions",
        sql<ThreadMetaRow>`
          SELECT t.thread_id, t.team_id, t.owner_kind, t.creator_member_id, m.pseudo AS creator_pseudo,
                 COALESCE(NULLIF(TRIM(w.display_name), ''), w.name) AS team_display_name,
                 t.view_id, t.locked, t.locked_by_member_id,
                 t.execution_environment_id, el.execution_environment_label,
                 t.is_local_synced, t.created_at
          FROM team_thread_meta t
          LEFT JOIN team_members m ON m.id = t.creator_member_id
          LEFT JOIN team_workspaces w ON w.id = t.team_id
          LEFT JOIN team_thread_env_labels el ON el.thread_id = t.thread_id
          WHERE t.team_id = ${teamId}
          ORDER BY t.created_at DESC
        `,
      );
      return rows.map(mapThreadMetaRow);
    }),

    getThreadAttribution: Effect.fn("TeamRepository.getThreadAttribution")(function* (threadId) {
      const rows = yield* runSql(
        "getThreadAttribution",
        sql<ThreadMetaRow>`
          SELECT t.thread_id, t.team_id, t.owner_kind, t.creator_member_id, m.pseudo AS creator_pseudo,
                 COALESCE(NULLIF(TRIM(w.display_name), ''), w.name) AS team_display_name,
                 t.view_id, t.locked, t.locked_by_member_id,
                 t.execution_environment_id, el.execution_environment_label,
                 t.is_local_synced, t.created_at
          FROM team_thread_meta t
          LEFT JOIN team_members m ON m.id = t.creator_member_id
          LEFT JOIN team_workspaces w ON w.id = t.team_id
          LEFT JOIN team_thread_env_labels el ON el.thread_id = t.thread_id
          WHERE t.thread_id = ${threadId}
          LIMIT 1
        `,
      );
      return rows[0] ? Option.some(mapThreadMetaRow(rows[0])) : Option.none();
    }),

    recordTurnAttribution: Effect.fn("TeamRepository.recordTurnAttribution")(function* (input) {
      const authorKind: TeamTurnAuthorKind =
        input.authorKind ?? (input.authorMemberId === null ? "team_automation" : "member");
      const authorMemberId = authorKind === "team_automation" ? null : input.authorMemberId;
      const rows = yield* runSql(
        "recordTurnAttribution",
        sql<{ readonly turn_id: string }>`
          INSERT OR IGNORE INTO team_turn_meta (turn_id, thread_id, author_kind, author_member_id, created_at)
          VALUES (${input.turnId}, ${input.threadId}, ${authorKind}, ${authorMemberId}, ${input.createdAt})
          RETURNING turn_id
        `,
      );
      return rows.length > 0;
    }),

    listTurnAttributionsForThread: Effect.fn("TeamRepository.listTurnAttributionsForThread")(
      function* (threadId) {
        const rows = yield* runSql(
          "listTurnAttributionsForThread",
          sql<TurnMetaRow>`
            SELECT t.turn_id, t.thread_id, t.author_kind, t.author_member_id, m.pseudo AS author_pseudo, t.created_at
            FROM team_turn_meta t
            LEFT JOIN team_members m ON m.id = t.author_member_id
            WHERE t.thread_id = ${threadId}
            ORDER BY t.created_at ASC
          `,
        );
        return rows.map(mapTurnMetaRow);
      },
    ),

    getTurnAttribution: Effect.fn("TeamRepository.getTurnAttribution")(function* (turnId) {
      const rows = yield* runSql(
        "getTurnAttribution",
        sql<TurnMetaRow>`
          SELECT t.turn_id, t.thread_id, t.author_kind, t.author_member_id, m.pseudo AS author_pseudo, t.created_at
          FROM team_turn_meta t
          LEFT JOIN team_members m ON m.id = t.author_member_id
          WHERE t.turn_id = ${turnId}
          LIMIT 1
        `,
      );
      return rows[0] ? Option.some(mapTurnMetaRow(rows[0])) : Option.none();
    }),

    listLatestTurnAttributions: Effect.fn("TeamRepository.listLatestTurnAttributions")(
      function* (teamId) {
        // Keep the 5 most recent non-steering runs per thread plus any non-terminal run so queued turns never evict an active run's author on reconnect.
        const rows = yield* runSql(
          "listLatestTurnAttributions",
          sql<TurnMetaRow>`
          SELECT turn_id, thread_id, author_kind, author_member_id, author_pseudo, created_at
          FROM (
            SELECT
              t.rowid AS row_ord,
              t.turn_id,
              t.thread_id,
              t.author_kind,
              t.author_member_id,
              m.pseudo AS author_pseudo,
              t.created_at,
              ROW_NUMBER() OVER (PARTITION BY t.thread_id ORDER BY t.rowid DESC) AS rn,
              EXISTS (
                SELECT 1
                FROM orchestration_v2_projection_runs r
                WHERE r.run_id = t.turn_id
                  AND r.status NOT IN ('completed', 'failed', 'cancelled', 'interrupted', 'rolled_back')
              ) AS is_non_terminal
            FROM team_turn_meta t
            INNER JOIN team_thread_meta tm ON tm.thread_id = t.thread_id
            LEFT JOIN team_members m ON m.id = t.author_member_id
            WHERE tm.team_id = ${teamId}
              AND t.turn_id NOT LIKE 'msg:%'
          )
          WHERE rn <= 5 OR is_non_terminal = 1
          ORDER BY row_ord ASC
        `,
        );
        return rows.map(mapTurnMetaRow);
      },
    ),

    threadExistsInProjection: Effect.fn("TeamRepository.threadExistsInProjection")(
      function* (threadId) {
        const rows = yield* runSql(
          "threadExistsInProjection",
          sql<{ readonly thread_id: string }>`
          SELECT thread_id
          FROM orchestration_v2_projection_threads
          WHERE thread_id = ${threadId}
            AND deleted_at IS NULL
          LIMIT 1
        `,
        );
        return rows.length > 0;
      },
    ),

    isThreadDeletedInProjection: Effect.fn("TeamRepository.isThreadDeletedInProjection")(
      function* (threadId) {
        const rows = yield* runSql(
          "isThreadDeletedInProjection",
          sql<{ readonly thread_id: string }>`
          SELECT thread_id
          FROM orchestration_v2_projection_threads
          WHERE thread_id = ${threadId}
            AND deleted_at IS NOT NULL
          LIMIT 1
        `,
        );
        return rows.length > 0;
      },
    ),

    getThreadCreatedAtInProjection: Effect.fn("TeamRepository.getThreadCreatedAtInProjection")(
      function* (threadId) {
        const rows = yield* runSql(
          "getThreadCreatedAtInProjection",
          sql<{ readonly created_at: string }>`
          SELECT created_at
          FROM orchestration_v2_projection_threads
          WHERE thread_id = ${threadId}
          LIMIT 1
        `,
        );
        const createdAt = rows[0]?.created_at;
        return createdAt !== undefined ? Option.some(createdAt) : Option.none();
      },
    ),

    getActiveRunInProjection: Effect.fn("TeamRepository.getActiveRunInProjection")(
      function* (threadId) {
        const rows = yield* runSql(
          "getActiveRunInProjection",
          sql<{
            readonly run_id: string;
            readonly status: string;
            readonly payload_json: string;
          }>`
          SELECT run_id, status, payload_json
          FROM orchestration_v2_projection_runs
          WHERE thread_id = ${threadId}
            AND status IN ('preparing', 'starting', 'running', 'waiting')
          ORDER BY ordinal DESC
          LIMIT 1
        `,
        );
        const row = rows[0];
        if (!row) return Option.none();
        return Option.some({
          runId: row.run_id,
          status: row.status,
          userMessageId: extractRunUserMessageId(row.payload_json),
        });
      },
    ),

    getRunInProjection: Effect.fn("TeamRepository.getRunInProjection")(function* (threadId, runId) {
      const rows = yield* runSql(
        "getRunInProjection",
        sql<{
          readonly run_id: string;
          readonly status: string;
          readonly payload_json: string;
        }>`
          SELECT run_id, status, payload_json
          FROM orchestration_v2_projection_runs
          WHERE thread_id = ${threadId}
            AND run_id = ${runId}
          LIMIT 1
        `,
      );
      const row = rows[0];
      if (!row) return Option.none();
      return Option.some({
        runId: row.run_id,
        status: row.status,
        userMessageId: extractRunUserMessageId(row.payload_json),
      });
    }),

    listThreadCreatedAtInProjection: Effect.fn("TeamRepository.listThreadCreatedAtInProjection")(
      function* (threadIds) {
        const result = new Map<ThreadId, string>();
        if (threadIds.length === 0) {
          return result as ReadonlyMap<ThreadId, string>;
        }
        const uniqueIds = [...new Set(threadIds)];
        const CHUNK_SIZE = 500;
        for (let offset = 0; offset < uniqueIds.length; offset += CHUNK_SIZE) {
          const chunk = uniqueIds.slice(offset, offset + CHUNK_SIZE);
          const rows = yield* runSql(
            "listThreadCreatedAtInProjection",
            sql<{ readonly thread_id: string; readonly created_at: string }>`
              SELECT thread_id, created_at
              FROM orchestration_v2_projection_threads
              WHERE thread_id IN ${sql.in(chunk)}
            `,
          );
          for (const row of rows) {
            result.set(ThreadId.make(row.thread_id), row.created_at);
          }
        }
        return result as ReadonlyMap<ThreadId, string>;
      },
    ),

    getThreadProjectIdInProjection: Effect.fn("TeamRepository.getThreadProjectIdInProjection")(
      function* (threadId) {
        const rows = yield* runSql(
          "getThreadProjectIdInProjection",
          sql<{ readonly project_id: string }>`
            SELECT project_id
            FROM orchestration_v2_projection_threads
            WHERE thread_id = ${threadId}
            LIMIT 1
          `,
        );
        return rows[0] ? Option.some(ProjectId.make(rows[0].project_id)) : Option.none();
      },
    ),

    listThreadProjectIdsInProjection: Effect.fn("TeamRepository.listThreadProjectIdsInProjection")(
      function* (threadIds) {
        const result = new Map<ThreadId, ProjectId>();
        if (threadIds.length === 0) {
          return result as ReadonlyMap<ThreadId, ProjectId>;
        }
        const uniqueIds = [...new Set(threadIds)];
        const CHUNK_SIZE = 500;
        for (let offset = 0; offset < uniqueIds.length; offset += CHUNK_SIZE) {
          const chunk = uniqueIds.slice(offset, offset + CHUNK_SIZE);
          const rows = yield* runSql(
            "listThreadProjectIdsInProjection",
            sql<{ readonly thread_id: string; readonly project_id: string }>`
              SELECT thread_id, project_id
              FROM orchestration_v2_projection_threads
              WHERE thread_id IN ${sql.in(chunk)}
            `,
          );
          for (const row of rows) {
            result.set(ThreadId.make(row.thread_id), ProjectId.make(row.project_id));
          }
        }
        return result as ReadonlyMap<ThreadId, ProjectId>;
      },
    ),

    findThreadIdByAttachmentSegment: Effect.fn("TeamRepository.findThreadIdByAttachmentSegment")(
      function* (input) {
        const exactRows = yield* runSql(
          "findThreadIdByAttachmentSegment.exact",
          sql<{ readonly thread_id: string }>`
            SELECT thread_id
            FROM team_thread_meta
            WHERE team_id = ${input.teamId} AND thread_id = ${input.segment}
            LIMIT 1
          `,
        );
        if (exactRows[0]) {
          return Option.some(ThreadId.make(exactRows[0].thread_id));
        }
        // Only fall back to scanning sanitized thread IDs when the exact PK lookup misses (e.g. thread IDs with `:`).
        const allRows = yield* runSql(
          "findThreadIdByAttachmentSegment.fallback",
          sql<{ readonly thread_id: string }>`
            SELECT thread_id
            FROM team_thread_meta
            WHERE team_id = ${input.teamId}
          `,
        );
        const matched = allRows.find(
          (row) => toSafeThreadAttachmentSegment(ThreadId.make(row.thread_id)) === input.segment,
        );
        return matched ? Option.some(ThreadId.make(matched.thread_id)) : Option.none();
      },
    ),

    followThread: Effect.fn("TeamRepository.followThread")(function* (input) {
      const rows = yield* runSql(
        "followThread",
        sql<{ readonly thread_id: string }>`
          INSERT OR IGNORE INTO team_thread_follows (thread_id, member_id, created_at)
          VALUES (${input.threadId}, ${input.memberId}, ${input.createdAt})
          RETURNING thread_id
        `,
      );
      return rows.length > 0;
    }),

    unfollowThread: Effect.fn("TeamRepository.unfollowThread")(function* (input) {
      const rows = yield* runSql(
        "unfollowThread",
        sql<{ readonly thread_id: string }>`
          DELETE FROM team_thread_follows
          WHERE thread_id = ${input.threadId} AND member_id = ${input.memberId}
          RETURNING thread_id
        `,
      );
      return rows.length > 0;
    }),

    isFollowingThread: Effect.fn("TeamRepository.isFollowingThread")(function* (input) {
      const rows = yield* runSql(
        "isFollowingThread",
        sql<{ readonly thread_id: string }>`
          SELECT thread_id
          FROM team_thread_follows
          WHERE thread_id = ${input.threadId} AND member_id = ${input.memberId}
          LIMIT 1
        `,
      );
      return rows.length > 0;
    }),

    listFollowedThreadIds: Effect.fn("TeamRepository.listFollowedThreadIds")(function* (memberId) {
      const rows = yield* runSql(
        "listFollowedThreadIds",
        sql<{ readonly thread_id: string }>`
          SELECT f.thread_id
          FROM team_thread_follows f
          WHERE f.member_id = ${memberId}
            AND NOT EXISTS (
              SELECT 1
              FROM orchestration_v2_projection_threads p
              WHERE p.thread_id = f.thread_id AND p.deleted_at IS NOT NULL
            )
          ORDER BY f.created_at DESC
        `,
      );
      return rows.map((row) => ThreadId.make(row.thread_id));
    }),

    listFollowersForThread: Effect.fn("TeamRepository.listFollowersForThread")(
      function* (threadId) {
        const rows = yield* runSql(
          "listFollowersForThread",
          sql<{ readonly member_id: string }>`
          SELECT member_id
          FROM team_thread_follows
          WHERE thread_id = ${threadId}
        `,
        );
        return rows.map((row) => TeamMemberId.make(row.member_id));
      },
    ),

    setRelayRecipientBinding: Effect.fn("TeamRepository.setRelayRecipientBinding")(
      function* (input) {
        yield* runSql(
          "setRelayRecipientBinding",
          sql`
          INSERT INTO team_relay_binding (singleton, team_id, member_id, cloud_user_id, bound_at)
          VALUES (1, ${input.teamId}, ${input.memberId}, ${input.cloudUserId}, ${input.boundAt})
          ON CONFLICT(singleton) DO UPDATE SET
            team_id = excluded.team_id,
            member_id = excluded.member_id,
            cloud_user_id = excluded.cloud_user_id,
            bound_at = excluded.bound_at
        `,
        );
      },
    ),

    getRelayRecipientBinding: Effect.fn("TeamRepository.getRelayRecipientBinding")(function* () {
      const rows = yield* runSql(
        "getRelayRecipientBinding",
        sql<{
          readonly team_id: string;
          readonly member_id: string;
          readonly cloud_user_id: string | null;
          readonly bound_at: string;
        }>`
          SELECT team_id, member_id, cloud_user_id, bound_at
          FROM team_relay_binding
          WHERE singleton = 1
          LIMIT 1
        `,
      );
      const row = rows[0];
      return row
        ? Option.some({
            teamId: TeamId.make(row.team_id),
            memberId: TeamMemberId.make(row.member_id),
            cloudUserId: row.cloud_user_id,
            boundAt: row.bound_at,
          })
        : Option.none();
    }),

    clearRelayRecipientBinding: Effect.fn("TeamRepository.clearRelayRecipientBinding")(
      function* () {
        yield* runSql("clearRelayRecipientBinding", sql`DELETE FROM team_relay_binding`);
      },
    ),

    listProjectAssignments: Effect.fn("TeamRepository.listProjectAssignments")(function* (teamId) {
      const rows = yield* runSql(
        "listProjectAssignments",
        sql<ProjectMetaRow>`
          SELECT project_id, team_id, default_view_id, repo_identity_key,
                 assigned_by_member_id, created_at, updated_at
          FROM team_project_meta
          WHERE team_id = ${teamId}
          ORDER BY created_at ASC
        `,
      );
      return rows.map(mapProjectMetaRow);
    }),

    getProjectAssignment: Effect.fn("TeamRepository.getProjectAssignment")(function* (projectId) {
      const rows = yield* runSql(
        "getProjectAssignment",
        sql<ProjectMetaRow>`
          SELECT project_id, team_id, default_view_id, repo_identity_key,
                 assigned_by_member_id, created_at, updated_at
          FROM team_project_meta
          WHERE project_id = ${projectId}
          LIMIT 1
        `,
      );
      return rows[0] ? Option.some(mapProjectMetaRow(rows[0])) : Option.none();
    }),

    upsertProjectAssignment: Effect.fn("TeamRepository.upsertProjectAssignment")(
      function* (assignment) {
        const rows = yield* runSql(
          "upsertProjectAssignment",
          sql<ProjectMetaRow>`
            INSERT INTO team_project_meta (
              project_id, team_id, default_view_id, repo_identity_key,
              assigned_by_member_id, created_at, updated_at
            )
            VALUES (
              ${assignment.projectId},
              ${assignment.teamId},
              ${assignment.defaultViewId},
              ${assignment.repoIdentityKey},
              ${assignment.assignedByMemberId},
              ${assignment.createdAt},
              ${assignment.updatedAt}
            )
            ON CONFLICT(project_id) DO UPDATE SET
              team_id = excluded.team_id,
              default_view_id = excluded.default_view_id,
              repo_identity_key = COALESCE(excluded.repo_identity_key, team_project_meta.repo_identity_key),
              updated_at = excluded.updated_at
            RETURNING project_id, team_id, default_view_id, repo_identity_key,
                      assigned_by_member_id, created_at, updated_at
          `,
        );
        return rows[0] ? mapProjectMetaRow(rows[0]) : assignment;
      },
    ),

    deleteProjectAssignment: Effect.fn("TeamRepository.deleteProjectAssignment")(function* (input) {
      const rows = yield* runSql(
        "deleteProjectAssignment",
        sql<{ readonly project_id: string }>`
          DELETE FROM team_project_meta
          WHERE team_id = ${input.teamId} AND project_id = ${input.projectId}
          RETURNING project_id
        `,
      );
      return rows.length > 0;
    }),

    listEnvironments: Effect.fn("TeamRepository.listEnvironments")(function* (teamId) {
      const rows = yield* runSql(
        "listEnvironments",
        sql<TeamEnvironmentRow>`
          SELECT id, team_id, environment_id, name, is_default, peer_link_id,
                 access_roles_json, access_member_ids_json, created_at, updated_at
          FROM team_environments
          WHERE team_id = ${teamId}
          ORDER BY is_default DESC, LOWER(name) ASC, created_at ASC
        `,
      );
      return rows.map(mapEnvironmentRow);
    }),

    getEnvironmentByEnvironmentId: Effect.fn("TeamRepository.getEnvironmentByEnvironmentId")(
      function* (input) {
        const rows = yield* runSql(
          "getEnvironmentByEnvironmentId",
          sql<TeamEnvironmentRow>`
            SELECT id, team_id, environment_id, name, is_default, peer_link_id,
                   access_roles_json, access_member_ids_json, created_at, updated_at
            FROM team_environments
            WHERE team_id = ${input.teamId} AND environment_id = ${input.environmentId}
            LIMIT 1
          `,
        );
        return rows[0] ? Option.some(mapEnvironmentRow(rows[0])) : Option.none();
      },
    ),

    ensureDefaultEnvironment: Effect.fn("TeamRepository.ensureDefaultEnvironment")(
      function* (input) {
        const existing = yield* runSql(
          "ensureDefaultEnvironment.select",
          sql<TeamEnvironmentRow>`
          SELECT id, team_id, environment_id, name, is_default, peer_link_id,
                 access_roles_json, access_member_ids_json, created_at, updated_at
          FROM team_environments
          WHERE team_id = ${input.teamId} AND is_default = 1
          LIMIT 1
        `,
        );
        if (existing[0]) {
          return mapEnvironmentRow(existing[0]);
        }
        yield* runSql(
          "ensureDefaultEnvironment.insert",
          sql`
          INSERT OR IGNORE INTO team_environments (
            id, team_id, environment_id, name, is_default, peer_link_id,
            access_roles_json, access_member_ids_json, created_at, updated_at
          )
          VALUES (
            ${input.id},
            ${input.teamId},
            ${input.environmentId},
            ${input.name},
            1,
            NULL,
            ${encodeStringArrayJson(ALL_TEAM_ROLES)},
            '[]',
            ${input.createdAt},
            ${input.createdAt}
          )
        `,
        );
        const after = yield* runSql(
          "ensureDefaultEnvironment.after",
          sql<TeamEnvironmentRow>`
          SELECT id, team_id, environment_id, name, is_default, peer_link_id,
                 access_roles_json, access_member_ids_json, created_at, updated_at
          FROM team_environments
          WHERE team_id = ${input.teamId} AND is_default = 1
          LIMIT 1
        `,
        );
        if (after[0]) {
          return mapEnvironmentRow(after[0]);
        }
        return {
          id: input.id,
          teamId: input.teamId,
          environmentId: input.environmentId,
          name: input.name,
          isDefault: true,
          peerLinkId: null,
          accessRule: { roles: [...ALL_TEAM_ROLES], memberIds: [] },
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
        };
      },
    ),

    createEnvironment: Effect.fn("TeamRepository.createEnvironment")(function* (environment) {
      yield* sql`
        INSERT INTO team_environments (
          id, team_id, environment_id, name, is_default, peer_link_id,
          access_roles_json, access_member_ids_json, created_at, updated_at
        )
        VALUES (
          ${environment.id},
          ${environment.teamId},
          ${environment.environmentId},
          ${environment.name},
          ${environment.isDefault ? 1 : 0},
          ${environment.peerLinkId},
          ${encodeStringArrayJson(environment.accessRule.roles)},
          ${encodeStringArrayJson(environment.accessRule.memberIds)},
          ${environment.createdAt},
          ${environment.updatedAt}
        )
      `.pipe(
        Effect.mapError((cause) =>
          isUniqueConstraintError(cause)
            ? new TeamEnvironmentAlreadyAttachedError({ environmentId: environment.environmentId })
            : new TeamRepositoryError({ operation: "createEnvironment", cause }),
        ),
      );
    }),

    updateEnvironment: Effect.fn("TeamRepository.updateEnvironment")(function* (input) {
      return yield* runSql(
        "updateEnvironment",
        sql.withTransaction(
          Effect.gen(function* () {
            const existingRows = yield* sql<TeamEnvironmentRow>`
              SELECT id, team_id, environment_id, name, is_default, peer_link_id,
                     access_roles_json, access_member_ids_json, created_at, updated_at
              FROM team_environments
              WHERE team_id = ${input.teamId} AND environment_id = ${input.environmentId}
              LIMIT 1
            `;
            const existing = existingRows[0];
            if (!existing) return Option.none<TeamEnvironment>();
            const nextName = input.name ?? existing.name;
            const nextAccessRoles =
              input.accessRule !== undefined
                ? encodeStringArrayJson(input.accessRule.roles)
                : existing.access_roles_json;
            const nextAccessMembers =
              input.accessRule !== undefined
                ? encodeStringArrayJson(input.accessRule.memberIds)
                : existing.access_member_ids_json;
            const updatedRows = yield* sql<TeamEnvironmentRow>`
              UPDATE team_environments
              SET name = ${nextName},
                  access_roles_json = ${nextAccessRoles},
                  access_member_ids_json = ${nextAccessMembers},
                  updated_at = ${input.updatedAt}
              WHERE team_id = ${input.teamId} AND environment_id = ${input.environmentId}
              RETURNING id, team_id, environment_id, name, is_default, peer_link_id,
                        access_roles_json, access_member_ids_json, created_at, updated_at
            `;
            return updatedRows[0] ? Option.some(mapEnvironmentRow(updatedRows[0])) : Option.none();
          }),
        ),
      );
    }),

    deleteEnvironment: Effect.fn("TeamRepository.deleteEnvironment")(function* (input) {
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const existingRows = yield* sql<{ readonly is_default: number }>`
              SELECT is_default
              FROM team_environments
              WHERE team_id = ${input.teamId} AND environment_id = ${input.environmentId}
              LIMIT 1
            `;
            const existing = existingRows[0];
            if (!existing) return false;
            if (existing.is_default === 1) {
              return yield* new TeamDefaultEnvironmentProtectedError({});
            }
            const deleted = yield* sql<{ readonly id: string }>`
              DELETE FROM team_environments
              WHERE team_id = ${input.teamId} AND environment_id = ${input.environmentId}
              RETURNING id
            `;
            return deleted.length > 0;
          }),
        )
        .pipe(
          Effect.mapError((cause) => {
            if (isTeamDefaultEnvironmentProtectedError(cause)) return cause;
            return new TeamRepositoryError({ operation: "deleteEnvironment", cause });
          }),
        );
    }),

    getLatestRunInProjection: Effect.fn("TeamRepository.getLatestRunInProjection")(
      function* (threadId) {
        const rows = yield* runSql(
          "getLatestRunInProjection",
          sql<{
            readonly run_id: string;
            readonly status: string;
            readonly payload_json: string;
          }>`
            SELECT run_id, status, payload_json
            FROM orchestration_v2_projection_runs
            WHERE thread_id = ${threadId}
              AND status != 'queued'
            ORDER BY ordinal DESC
            LIMIT 1
          `,
        );
        const row = rows[0];
        if (!row) return Option.none();
        return Option.some({
          runId: row.run_id,
          status: row.status,
          userMessageId: extractRunUserMessageId(row.payload_json),
        });
      },
    ),

    listThreadNotes: Effect.fn("TeamRepository.listThreadNotes")(function* (input) {
      const rows = yield* runSql(
        "listThreadNotes",
        input.threadId !== undefined
          ? sql<ThreadNoteRow>`
              SELECT n.id, n.thread_id, n.team_id,
                     n.author_member_id, a.pseudo AS author_pseudo, a.role AS author_role,
                     n.original_body, n.original_content_hash,
                     n.edited_body, n.edited_content_hash,
                     n.status, n.anchor_turn_id, n.anchor_seq,
                     n.included_in_turn_id, n.resolved_by_member_id,
                     r.pseudo AS resolved_by_pseudo, n.resolved_at, n.created_at
              FROM team_thread_notes n
              INNER JOIN team_members a ON a.id = n.author_member_id
              LEFT JOIN team_members r ON r.id = n.resolved_by_member_id
              WHERE n.team_id = ${input.teamId} AND n.thread_id = ${input.threadId}
              ORDER BY n.anchor_seq ASC, n.created_at ASC
            `
          : sql<ThreadNoteRow>`
              SELECT n.id, n.thread_id, n.team_id,
                     n.author_member_id, a.pseudo AS author_pseudo, a.role AS author_role,
                     n.original_body, n.original_content_hash,
                     n.edited_body, n.edited_content_hash,
                     n.status, n.anchor_turn_id, n.anchor_seq,
                     n.included_in_turn_id, n.resolved_by_member_id,
                     r.pseudo AS resolved_by_pseudo, n.resolved_at, n.created_at
              FROM team_thread_notes n
              INNER JOIN team_members a ON a.id = n.author_member_id
              LEFT JOIN team_members r ON r.id = n.resolved_by_member_id
              WHERE n.team_id = ${input.teamId}
              ORDER BY n.anchor_seq ASC, n.created_at ASC
            `,
      );
      return rows.map(mapThreadNoteRow);
    }),

    getThreadNoteById: Effect.fn("TeamRepository.getThreadNoteById")(function* (noteId) {
      const rows = yield* runSql(
        "getThreadNoteById",
        sql<ThreadNoteRow>`
          SELECT n.id, n.thread_id, n.team_id,
                 n.author_member_id, a.pseudo AS author_pseudo, a.role AS author_role,
                 n.original_body, n.original_content_hash,
                 n.edited_body, n.edited_content_hash,
                 n.status, n.anchor_turn_id, n.anchor_seq,
                 n.included_in_turn_id, n.resolved_by_member_id,
                 r.pseudo AS resolved_by_pseudo, n.resolved_at, n.created_at
          FROM team_thread_notes n
          INNER JOIN team_members a ON a.id = n.author_member_id
          LEFT JOIN team_members r ON r.id = n.resolved_by_member_id
          WHERE n.id = ${noteId}
          LIMIT 1
        `,
      );
      return rows[0] ? Option.some(mapThreadNoteRow(rows[0])) : Option.none();
    }),

    createThreadNote: Effect.fn("TeamRepository.createThreadNote")(function* (input) {
      return yield* runSql(
        "createThreadNote",
        sql.withTransaction(
          Effect.gen(function* () {
            const seqRows = yield* sql<{ readonly max_seq: number | null }>`
              SELECT MAX(anchor_seq) AS max_seq
              FROM team_thread_notes
              WHERE thread_id = ${input.threadId}
            `;
            const nextSeq = (seqRows[0]?.max_seq ?? 0) + 1;
            yield* sql`
              INSERT INTO team_thread_notes (
                id, thread_id, team_id, author_member_id,
                original_body, original_content_hash,
                edited_body, edited_content_hash,
                status, anchor_turn_id, anchor_seq,
                included_in_turn_id, resolved_by_member_id, resolved_at, created_at
              )
              VALUES (
                ${input.id},
                ${input.threadId},
                ${input.teamId},
                ${input.authorMemberId},
                ${input.originalBody},
                ${input.originalContentHash},
                NULL,
                NULL,
                'pending',
                ${input.anchorTurnId},
                ${nextSeq},
                NULL,
                NULL,
                NULL,
                ${input.createdAt}
              )
            `;
            const rows = yield* sql<ThreadNoteRow>`
              SELECT n.id, n.thread_id, n.team_id,
                     n.author_member_id, a.pseudo AS author_pseudo, a.role AS author_role,
                     n.original_body, n.original_content_hash,
                     n.edited_body, n.edited_content_hash,
                     n.status, n.anchor_turn_id, n.anchor_seq,
                     n.included_in_turn_id, n.resolved_by_member_id,
                     r.pseudo AS resolved_by_pseudo, n.resolved_at, n.created_at
              FROM team_thread_notes n
              INNER JOIN team_members a ON a.id = n.author_member_id
              LEFT JOIN team_members r ON r.id = n.resolved_by_member_id
              WHERE n.id = ${input.id}
              LIMIT 1
            `;
            return rows[0] ? Option.some(mapThreadNoteRow(rows[0])) : Option.none();
          }),
        ),
      );
    }),

    deletePendingThreadNoteByAuthor: Effect.fn("TeamRepository.deletePendingThreadNoteByAuthor")(
      function* (input) {
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const existingRows = yield* sql<{
                readonly author_member_id: string;
                readonly status: TeamThreadNoteStatus;
              }>`
                SELECT author_member_id, status
                FROM team_thread_notes
                WHERE id = ${input.noteId} AND team_id = ${input.teamId}
                LIMIT 1
              `;
              const existing = existingRows[0];
              if (!existing) return false;
              if (existing.author_member_id !== input.authorMemberId) {
                return yield* new TeamMemberForbiddenError({
                  reason: "Only the note author can delete their own pending note.",
                });
              }
              if (existing.status !== "pending") {
                return yield* new TeamNoteStateConflictError({
                  code: "note_not_pending",
                  reason: "A note can only be deleted while it is still pending.",
                });
              }
              const deleted = yield* sql<{ readonly id: string }>`
                DELETE FROM team_thread_notes
                WHERE id = ${input.noteId}
                  AND team_id = ${input.teamId}
                  AND author_member_id = ${input.authorMemberId}
                  AND status = 'pending'
                RETURNING id
              `;
              return deleted.length > 0;
            }),
          )
          .pipe(
            Effect.mapError((cause) => {
              if (isTeamMemberForbiddenError(cause) || isTeamNoteStateConflictError(cause)) {
                return cause;
              }
              return new TeamRepositoryError({
                operation: "deletePendingThreadNoteByAuthor",
                cause,
              });
            }),
          );
      },
    ),

    resolveThreadNote: Effect.fn("TeamRepository.resolveThreadNote")(function* (input) {
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const existingRows = yield* sql<{
              readonly status: TeamThreadNoteStatus;
              readonly original_content_hash: string;
              readonly edited_content_hash: string | null;
            }>`
              SELECT status, original_content_hash, edited_content_hash
              FROM team_thread_notes
              WHERE id = ${input.noteId} AND team_id = ${input.teamId}
              LIMIT 1
            `;
            const existing = existingRows[0];
            if (!existing) return Option.none<TeamThreadNote>();
            if (existing.status === "consumed") {
              return yield* new TeamNoteStateConflictError({
                code: "note_already_consumed",
                reason: "This note has already been included in a turn and cannot be modified.",
              });
            }
            const effectiveHash = existing.edited_content_hash ?? existing.original_content_hash;
            if (
              input.expectedContentHash !== undefined &&
              effectiveHash !== input.expectedContentHash
            ) {
              return yield* new TeamNoteStateConflictError({
                code: "note_hash_mismatch",
                reason: "Note content hash mismatch; reload the note before approving.",
              });
            }
            const resolvedBy = input.status === "pending" ? null : input.resolvedByMemberId;
            const resolvedAt = input.status === "pending" ? null : input.resolvedAt;
            yield* sql`
              UPDATE team_thread_notes
              SET status = ${input.status},
                  resolved_by_member_id = ${resolvedBy},
                  resolved_at = ${resolvedAt}
              WHERE id = ${input.noteId} AND team_id = ${input.teamId} AND status != 'consumed'
            `;
            const rows = yield* sql<ThreadNoteRow>`
              SELECT n.id, n.thread_id, n.team_id,
                     n.author_member_id, a.pseudo AS author_pseudo, a.role AS author_role,
                     n.original_body, n.original_content_hash,
                     n.edited_body, n.edited_content_hash,
                     n.status, n.anchor_turn_id, n.anchor_seq,
                     n.included_in_turn_id, n.resolved_by_member_id,
                     r.pseudo AS resolved_by_pseudo, n.resolved_at, n.created_at
              FROM team_thread_notes n
              INNER JOIN team_members a ON a.id = n.author_member_id
              LEFT JOIN team_members r ON r.id = n.resolved_by_member_id
              WHERE n.id = ${input.noteId}
              LIMIT 1
            `;
            return rows[0] ? Option.some(mapThreadNoteRow(rows[0])) : Option.none();
          }),
        )
        .pipe(
          Effect.mapError((cause) => {
            if (isTeamNoteStateConflictError(cause)) return cause;
            return new TeamRepositoryError({ operation: "resolveThreadNote", cause });
          }),
        );
    }),

    editThreadNote: Effect.fn("TeamRepository.editThreadNote")(function* (input) {
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const existingRows = yield* sql<{
              readonly status: TeamThreadNoteStatus;
              readonly original_content_hash: string;
            }>`
              SELECT status, original_content_hash
              FROM team_thread_notes
              WHERE id = ${input.noteId} AND team_id = ${input.teamId}
              LIMIT 1
            `;
            const existing = existingRows[0];
            if (!existing) return Option.none<TeamThreadNote>();
            if (existing.status === "consumed") {
              return yield* new TeamNoteStateConflictError({
                code: "note_already_consumed",
                reason: "This note has already been included in a turn and cannot be edited.",
              });
            }
            if (
              input.expectedOriginalContentHash !== undefined &&
              existing.original_content_hash !== input.expectedOriginalContentHash
            ) {
              return yield* new TeamNoteStateConflictError({
                code: "note_hash_mismatch",
                reason: "Original note content hash mismatch.",
              });
            }
            yield* sql`
              UPDATE team_thread_notes
              SET edited_body = ${input.editedBody},
                  edited_content_hash = ${input.editedContentHash},
                  status = ${input.status},
                  resolved_by_member_id = ${input.resolvedByMemberId},
                  resolved_at = ${input.resolvedAt}
              WHERE id = ${input.noteId} AND team_id = ${input.teamId} AND status != 'consumed'
            `;
            const rows = yield* sql<ThreadNoteRow>`
              SELECT n.id, n.thread_id, n.team_id,
                     n.author_member_id, a.pseudo AS author_pseudo, a.role AS author_role,
                     n.original_body, n.original_content_hash,
                     n.edited_body, n.edited_content_hash,
                     n.status, n.anchor_turn_id, n.anchor_seq,
                     n.included_in_turn_id, n.resolved_by_member_id,
                     r.pseudo AS resolved_by_pseudo, n.resolved_at, n.created_at
              FROM team_thread_notes n
              INNER JOIN team_members a ON a.id = n.author_member_id
              LEFT JOIN team_members r ON r.id = n.resolved_by_member_id
              WHERE n.id = ${input.noteId}
              LIMIT 1
            `;
            return rows[0] ? Option.some(mapThreadNoteRow(rows[0])) : Option.none();
          }),
        )
        .pipe(
          Effect.mapError((cause) => {
            if (isTeamNoteStateConflictError(cause)) return cause;
            return new TeamRepositoryError({ operation: "editThreadNote", cause });
          }),
        );
    }),

    consumeAcceptedNotesAndReanchorPending: Effect.fn(
      "TeamRepository.consumeAcceptedNotesAndReanchorPending",
    )(function* (input) {
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const consumedIds: Array<TeamThreadNoteId> = [];
            const seenNoteIds = new Set<string>();
            for (const ref of input.acceptedNotes) {
              if (seenNoteIds.has(ref.noteId)) continue;
              seenNoteIds.add(ref.noteId);
              const existingRows = yield* sql<{
                readonly status: TeamThreadNoteStatus;
                readonly original_content_hash: string;
                readonly edited_content_hash: string | null;
              }>`
                SELECT status, original_content_hash, edited_content_hash
                FROM team_thread_notes
                WHERE id = ${ref.noteId}
                  AND team_id = ${input.teamId}
                  AND thread_id = ${input.threadId}
                LIMIT 1
              `;
              const existing = existingRows[0];
              if (!existing) {
                return yield* new TeamNoteStateConflictError({
                  code: "note_hash_mismatch",
                  reason: `Accepted note "${ref.noteId}" was not found on this thread.`,
                });
              }
              if (existing.status === "consumed") {
                return yield* new TeamNoteStateConflictError({
                  code: "note_already_consumed",
                  reason: `Accepted note "${ref.noteId}" was already consumed by an earlier turn.`,
                });
              }
              if (existing.status !== "accepted") {
                return yield* new TeamNoteStateConflictError({
                  code: "note_not_pending",
                  reason: `Note "${ref.noteId}" is "${existing.status}" and must be explicitly accepted before dispatch.`,
                });
              }
              const effectiveHash = existing.edited_content_hash ?? existing.original_content_hash;
              if (effectiveHash !== ref.contentHash) {
                return yield* new TeamNoteStateConflictError({
                  code: "note_hash_mismatch",
                  reason: `Content hash mismatch for accepted note "${ref.noteId}".`,
                });
              }
              yield* sql`
                UPDATE team_thread_notes
                SET status = 'consumed',
                    included_in_turn_id = ${input.targetTurnId},
                    resolved_by_member_id = ${input.resolvedByMemberId},
                    resolved_at = ${input.resolvedAt}
                WHERE id = ${ref.noteId}
                  AND team_id = ${input.teamId}
                  AND thread_id = ${input.threadId}
                  AND status = 'accepted'
              `;
              consumedIds.push(ref.noteId);
            }

            // Atomically re-anchor any remaining pending notes (including concurrent arrivals) after this new turn.
            const pendingRows = yield* sql<{ readonly id: string }>`
              SELECT id
              FROM team_thread_notes
              WHERE team_id = ${input.teamId}
                AND thread_id = ${input.threadId}
                AND status = 'pending'
              ORDER BY anchor_seq ASC, created_at ASC
            `;
            const reanchoredIds: Array<string> = [];
            if (pendingRows.length > 0) {
              const seqRows = yield* sql<{ readonly max_seq: number | null }>`
                SELECT MAX(anchor_seq) AS max_seq
                FROM team_thread_notes
                WHERE thread_id = ${input.threadId}
              `;
              let nextSeq = (seqRows[0]?.max_seq ?? 0) + 1;
              for (const pending of pendingRows) {
                yield* sql`
                  UPDATE team_thread_notes
                  SET anchor_turn_id = ${input.targetTurnId},
                      anchor_seq = ${nextSeq}
                  WHERE id = ${pending.id}
                    AND team_id = ${input.teamId}
                    AND status = 'pending'
                `;
                reanchoredIds.push(pending.id);
                nextSeq += 1;
              }
            }

            const fetchByIds = (ids: ReadonlyArray<string>) =>
              ids.length === 0
                ? Effect.succeed([] as ReadonlyArray<ThreadNoteRow>)
                : sql<ThreadNoteRow>`
                    SELECT n.id, n.thread_id, n.team_id,
                           n.author_member_id, a.pseudo AS author_pseudo, a.role AS author_role,
                           n.original_body, n.original_content_hash,
                           n.edited_body, n.edited_content_hash,
                           n.status, n.anchor_turn_id, n.anchor_seq,
                           n.included_in_turn_id, n.resolved_by_member_id,
                           r.pseudo AS resolved_by_pseudo, n.resolved_at, n.created_at
                    FROM team_thread_notes n
                    INNER JOIN team_members a ON a.id = n.author_member_id
                    LEFT JOIN team_members r ON r.id = n.resolved_by_member_id
                    WHERE n.id IN ${sql.in(ids)}
                    ORDER BY n.anchor_seq ASC, n.created_at ASC
                  `;

            const [consumedRows, reanchoredRows] = yield* Effect.all([
              fetchByIds(consumedIds),
              fetchByIds(reanchoredIds),
            ]);
            return {
              consumedNotes: consumedRows.map(mapThreadNoteRow),
              reanchoredNotes: reanchoredRows.map(mapThreadNoteRow),
            };
          }),
        )
        .pipe(
          Effect.mapError((cause) => {
            if (isTeamNoteStateConflictError(cause)) return cause;
            return new TeamRepositoryError({
              operation: "consumeAcceptedNotesAndReanchorPending",
              cause,
            });
          }),
        );
    }),

    relinkNoteTurnId: Effect.fn("TeamRepository.relinkNoteTurnId")(function* (input) {
      return yield* runSql(
        "relinkNoteTurnId",
        sql.withTransaction(
          Effect.gen(function* () {
            const matched = yield* sql<{ readonly id: string }>`
              SELECT id
              FROM team_thread_notes
              WHERE team_id = ${input.teamId}
                AND thread_id = ${input.threadId}
                AND (anchor_turn_id = ${input.fromTurnId} OR included_in_turn_id = ${input.fromTurnId})
            `;
            if (matched.length === 0) return [] as ReadonlyArray<TeamThreadNote>;
            yield* sql`
              UPDATE team_thread_notes
              SET anchor_turn_id = CASE
                    WHEN anchor_turn_id = ${input.fromTurnId} THEN ${input.toTurnId}
                    ELSE anchor_turn_id
                  END,
                  included_in_turn_id = CASE
                    WHEN included_in_turn_id = ${input.fromTurnId} THEN ${input.toTurnId}
                    ELSE included_in_turn_id
                  END
              WHERE team_id = ${input.teamId}
                AND thread_id = ${input.threadId}
                AND (anchor_turn_id = ${input.fromTurnId} OR included_in_turn_id = ${input.fromTurnId})
            `;
            const ids = matched.map((row) => row.id);
            const rows = yield* sql<ThreadNoteRow>`
              SELECT n.id, n.thread_id, n.team_id,
                     n.author_member_id, a.pseudo AS author_pseudo, a.role AS author_role,
                     n.original_body, n.original_content_hash,
                     n.edited_body, n.edited_content_hash,
                     n.status, n.anchor_turn_id, n.anchor_seq,
                     n.included_in_turn_id, n.resolved_by_member_id,
                     r.pseudo AS resolved_by_pseudo, n.resolved_at, n.created_at
              FROM team_thread_notes n
              INNER JOIN team_members a ON a.id = n.author_member_id
              LEFT JOIN team_members r ON r.id = n.resolved_by_member_id
              WHERE n.id IN ${sql.in(ids)}
              ORDER BY n.anchor_seq ASC, n.created_at ASC
            `;
            return rows.map(mapThreadNoteRow);
          }),
        ),
      );
    }),

    reanchorPendingNotesForNewTurn: Effect.fn("TeamRepository.reanchorPendingNotesForNewTurn")(
      function* (input) {
        return yield* runSql(
          "reanchorPendingNotesForNewTurn",
          sql.withTransaction(
            Effect.gen(function* () {
              const pendingRows = yield* sql<{ readonly id: string }>`
                SELECT id
                FROM team_thread_notes
                WHERE team_id = ${input.teamId}
                  AND thread_id = ${input.threadId}
                  AND status = 'pending'
                  AND (anchor_turn_id IS NULL OR anchor_turn_id != ${input.targetTurnId})
                ORDER BY anchor_seq ASC, created_at ASC
              `;
              if (pendingRows.length === 0) return [] as ReadonlyArray<TeamThreadNote>;
              const seqRows = yield* sql<{ readonly max_seq: number | null }>`
                SELECT MAX(anchor_seq) AS max_seq
                FROM team_thread_notes
                WHERE thread_id = ${input.threadId}
              `;
              let nextSeq = (seqRows[0]?.max_seq ?? 0) + 1;
              const reanchoredIds: Array<string> = [];
              for (const pending of pendingRows) {
                yield* sql`
                  UPDATE team_thread_notes
                  SET anchor_turn_id = ${input.targetTurnId},
                      anchor_seq = ${nextSeq}
                  WHERE id = ${pending.id}
                    AND team_id = ${input.teamId}
                    AND status = 'pending'
                `;
                reanchoredIds.push(pending.id);
                nextSeq += 1;
              }
              const rows = yield* sql<ThreadNoteRow>`
                SELECT n.id, n.thread_id, n.team_id,
                       n.author_member_id, a.pseudo AS author_pseudo, a.role AS author_role,
                       n.original_body, n.original_content_hash,
                       n.edited_body, n.edited_content_hash,
                       n.status, n.anchor_turn_id, n.anchor_seq,
                       n.included_in_turn_id, n.resolved_by_member_id,
                       r.pseudo AS resolved_by_pseudo, n.resolved_at, n.created_at
                FROM team_thread_notes n
                INNER JOIN team_members a ON a.id = n.author_member_id
                LEFT JOIN team_members r ON r.id = n.resolved_by_member_id
                WHERE n.id IN ${sql.in(reanchoredIds)}
                ORDER BY n.anchor_seq ASC, n.created_at ASC
              `;
              return rows.map(mapThreadNoteRow);
            }),
          ),
        );
      },
    ),

    enqueuePendingRemoteRevocation: Effect.fn("TeamRepository.enqueuePendingRemoteRevocation")(
      function* (input) {
        yield* runSql(
          "enqueuePendingRemoteRevocation",
          sql`
            INSERT INTO team_pending_remote_revocations (
              id, team_id, environment_id, subject_prefix, unlink_after_revoke, created_at
            )
            VALUES (
              ${input.id},
              ${input.teamId},
              ${input.environmentId},
              ${input.subjectPrefix},
              ${input.unlinkAfterRevoke ? 1 : 0},
              ${input.createdAt}
            )
            ON CONFLICT(team_id, environment_id, subject_prefix) DO UPDATE SET
              id = excluded.id,
              unlink_after_revoke = MAX(unlink_after_revoke, excluded.unlink_after_revoke),
              created_at = excluded.created_at
          `,
        );
      },
    ),

    listPendingRemoteRevocations: Effect.fn("TeamRepository.listPendingRemoteRevocations")(
      function* (teamId?: TeamId) {
        const rows = yield* runSql(
          "listPendingRemoteRevocations",
          teamId !== undefined
            ? sql<{
                readonly id: string;
                readonly team_id: string;
                readonly environment_id: string;
                readonly subject_prefix: string;
                readonly unlink_after_revoke: number;
                readonly created_at: string;
              }>`
                SELECT id, team_id, environment_id, subject_prefix, unlink_after_revoke, created_at
                FROM team_pending_remote_revocations
                WHERE team_id = ${teamId}
                ORDER BY created_at ASC
              `
            : sql<{
                readonly id: string;
                readonly team_id: string;
                readonly environment_id: string;
                readonly subject_prefix: string;
                readonly unlink_after_revoke: number;
                readonly created_at: string;
              }>`
                SELECT id, team_id, environment_id, subject_prefix, unlink_after_revoke, created_at
                FROM team_pending_remote_revocations
                ORDER BY created_at ASC
              `,
        );
        return rows.map((row) => ({
          id: row.id,
          teamId: TeamId.make(row.team_id),
          environmentId: EnvironmentId.make(row.environment_id),
          subjectPrefix: row.subject_prefix,
          unlinkAfterRevoke: row.unlink_after_revoke === 1,
          createdAt: row.created_at,
        }));
      },
    ),

    clearPendingRemoteRevocationUnlinkFlag: Effect.fn(
      "TeamRepository.clearPendingRemoteRevocationUnlinkFlag",
    )(function* (input) {
      yield* runSql(
        "clearPendingRemoteRevocationUnlinkFlag",
        sql`
          UPDATE team_pending_remote_revocations
          SET unlink_after_revoke = 0
          WHERE team_id = ${input.teamId} AND environment_id = ${input.environmentId}
        `,
      );
    }),

    deletePendingRemoteRevocation: Effect.fn("TeamRepository.deletePendingRemoteRevocation")(
      function* (id) {
        yield* runSql(
          "deletePendingRemoteRevocation",
          sql`
            DELETE FROM team_pending_remote_revocations
            WHERE id = ${id}
          `,
        );
      },
    ),

    bindPairingLinkMeta: Effect.fn("TeamRepository.bindPairingLinkMeta")(function* (input) {
      yield* runSql("bindPairingLinkMeta", upsertTeamPairingMeta(sql, input));
    }),

    getPairingLinkMeta: Effect.fn("TeamRepository.getPairingLinkMeta")(function* (pairingLinkId) {
      return yield* runSql("getPairingLinkMeta", getTeamPairingMeta(sql, pairingLinkId));
    }),

    listPairingLinkIdsForMember: Effect.fn("TeamRepository.listPairingLinkIdsForMember")(
      function* (memberId) {
        return yield* runSql(
          "listPairingLinkIdsForMember",
          listTeamPairingLinkIdsForMember(sql, memberId),
        );
      },
    ),

    markPairingLinkMetaRevoked: Effect.fn("TeamRepository.markPairingLinkMetaRevoked")(
      function* (input) {
        yield* runSql(
          "markPairingLinkMetaRevoked",
          markTeamPairingMetaRevoked(sql, input.pairingLinkId, input.revokedAt),
        );
      },
    ),

    markAllPairingLinkMetaRevokedForMember: Effect.fn(
      "TeamRepository.markAllPairingLinkMetaRevokedForMember",
    )(function* (input) {
      yield* runSql(
        "markAllPairingLinkMetaRevokedForMember",
        markAllTeamPairingMetaRevokedForMember(sql, input.memberId, input.revokedAt),
      );
    }),

    setSessionScopeCeiling: Effect.fn("TeamRepository.setSessionScopeCeiling")(function* (input) {
      yield* runSql("setSessionScopeCeiling", upsertTeamSessionScopeCeiling(sql, input));
    }),

    getSessionScopeCeiling: Effect.fn("TeamRepository.getSessionScopeCeiling")(
      function* (sessionId) {
        return yield* runSql("getSessionScopeCeiling", getTeamSessionScopeCeiling(sql, sessionId));
      },
    ),

    setMemberMobileVisibility: Effect.fn("TeamRepository.setMemberMobileVisibility")(
      function* (input) {
        yield* runSql("setMemberMobileVisibility", setMemberUpstreamMobileVisibility(sql, input));
        const rows = yield* runSql(
          "setMemberMobileVisibility.load",
          sql<MemberRow>`
          SELECT
            m.id,
            m.team_id,
            m.pseudo,
            m.role,
            m.status,
            p.upstream_client_thread_visibility,
            m.created_at,
            m.updated_at
          FROM team_members m
          LEFT JOIN team_member_preferences p ON p.member_id = m.id
          WHERE m.id = ${input.memberId} AND m.team_id = ${input.teamId}
          LIMIT 1
        `,
        );
        return rows[0] ? Option.some(mapMemberRow(rows[0])) : Option.none();
      },
    ),

    upsertScheduledTaskMeta: Effect.fn("TeamRepository.upsertScheduledTaskMeta")(function* (meta) {
      yield* runSql(
        "upsertScheduledTaskMeta",
        sql`
          INSERT INTO team_scheduled_task_meta (
            task_id, team_id, environment_id, view_id, locked, mcp_access_level,
            created_by_member_id, updated_by_member_id, created_at, updated_at
          )
          VALUES (
            ${meta.taskId},
            ${meta.teamId},
            ${meta.environmentId},
            ${meta.viewId},
            ${meta.locked ? 1 : 0},
            ${meta.mcpAccessLevel},
            ${meta.createdByMemberId},
            ${meta.updatedByMemberId},
            ${meta.createdAt},
            ${meta.updatedAt}
          )
          ON CONFLICT (task_id) DO UPDATE SET
            environment_id = excluded.environment_id,
            view_id = excluded.view_id,
            locked = excluded.locked,
            mcp_access_level = excluded.mcp_access_level,
            updated_by_member_id = excluded.updated_by_member_id,
            updated_at = excluded.updated_at
        `,
      );
      const rows = yield* runSql(
        "upsertScheduledTaskMeta.select",
        sql<ScheduledTaskMetaRow>`
          SELECT task_id, team_id, environment_id, view_id, locked, mcp_access_level,
                 created_by_member_id, updated_by_member_id, created_at, updated_at
          FROM team_scheduled_task_meta
          WHERE task_id = ${meta.taskId}
          LIMIT 1
        `,
      );
      return rows[0] ? mapScheduledTaskMetaRow(rows[0]) : meta;
    }),

    getScheduledTaskMeta: Effect.fn("TeamRepository.getScheduledTaskMeta")(function* (taskId) {
      const rows = yield* runSql(
        "getScheduledTaskMeta",
        sql<ScheduledTaskMetaRow>`
          SELECT task_id, team_id, environment_id, view_id, locked, mcp_access_level,
                 created_by_member_id, updated_by_member_id, created_at, updated_at
          FROM team_scheduled_task_meta
          WHERE task_id = ${taskId}
          LIMIT 1
        `,
      );
      return rows[0] ? Option.some(mapScheduledTaskMetaRow(rows[0])) : Option.none();
    }),

    listScheduledTaskMetas: Effect.fn("TeamRepository.listScheduledTaskMetas")(function* (teamId) {
      const rows = yield* runSql(
        "listScheduledTaskMetas",
        sql<ScheduledTaskMetaRow>`
          SELECT task_id, team_id, environment_id, view_id, locked, mcp_access_level,
                 created_by_member_id, updated_by_member_id, created_at, updated_at
          FROM team_scheduled_task_meta
          WHERE team_id = ${teamId}
          ORDER BY created_at DESC
        `,
      );
      return rows.map(mapScheduledTaskMetaRow);
    }),

    deleteScheduledTaskMeta: Effect.fn("TeamRepository.deleteScheduledTaskMeta")(
      function* (taskId) {
        const rows = yield* runSql(
          "deleteScheduledTaskMeta",
          sql<{ readonly task_id: string }>`
          DELETE FROM team_scheduled_task_meta
          WHERE task_id = ${taskId}
          RETURNING task_id
        `,
        );
        return rows.length > 0;
      },
    ),

    recordAutomationTurnScope: Effect.fn("TeamRepository.recordAutomationTurnScope")(
      function* (scope) {
        const rows = yield* runSql(
          "recordAutomationTurnScope",
          sql<{ readonly turn_id: string }>`
            INSERT OR IGNORE INTO team_automation_turn_scopes (
              turn_id, thread_id, task_id, team_id, project_id, environment_id, view_id,
              mcp_access_level, created_at
            )
            VALUES (
              ${scope.turnId},
              ${scope.threadId},
              ${scope.taskId},
              ${scope.teamId},
              ${scope.projectId},
              ${scope.environmentId},
              ${scope.viewId},
              ${scope.mcpAccessLevel},
              ${scope.createdAt}
            )
            RETURNING turn_id
          `,
        );
        return rows.length > 0;
      },
    ),

    recordAutomationTurnWithScope: Effect.fn("TeamRepository.recordAutomationTurnWithScope")(
      function* ({ scope }) {
        return yield* runSql(
          "recordAutomationTurnWithScope",
          sql.withTransaction(
            Effect.gen(function* () {
              const turnRows = yield* sql<{ readonly turn_id: string }>`
                INSERT OR IGNORE INTO team_turn_meta (
                  turn_id, thread_id, author_kind, author_member_id, created_at
                )
                VALUES (
                  ${scope.turnId},
                  ${scope.threadId},
                  'team_automation',
                  NULL,
                  ${scope.createdAt}
                )
                RETURNING turn_id
              `;
              const scopeRows = yield* sql<{ readonly turn_id: string }>`
                INSERT OR IGNORE INTO team_automation_turn_scopes (
                  turn_id, thread_id, task_id, team_id, project_id, environment_id, view_id,
                  mcp_access_level, created_at
                )
                VALUES (
                  ${scope.turnId},
                  ${scope.threadId},
                  ${scope.taskId},
                  ${scope.teamId},
                  ${scope.projectId},
                  ${scope.environmentId},
                  ${scope.viewId},
                  ${scope.mcpAccessLevel},
                  ${scope.createdAt}
                )
                RETURNING turn_id
              `;
              return {
                turnInserted: turnRows.length > 0,
                scopeInserted: scopeRows.length > 0,
              };
            }),
          ),
        );
      },
    ),

    getAutomationTurnScope: Effect.fn("TeamRepository.getAutomationTurnScope")(function* (turnId) {
      const rows = yield* runSql(
        "getAutomationTurnScope",
        sql<AutomationTurnScopeRow>`
          SELECT turn_id, thread_id, task_id, team_id, project_id, environment_id, view_id,
                 mcp_access_level, created_at
          FROM team_automation_turn_scopes
          WHERE turn_id = ${turnId}
          LIMIT 1
        `,
      );
      return rows[0] ? Option.some(mapAutomationTurnScopeRow(rows[0])) : Option.none();
    }),
  });
});

export const layer = Layer.effect(TeamRepository, make);
