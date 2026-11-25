import {
  type AuthSessionId,
  TeamId,
  TeamInviteId,
  TeamMemberId,
  type TeamInvite,
  type TeamMember,
  type TeamMemberStatus,
  type TeamPseudo,
  type TeamRole,
  type TeamSessionBinding,
  type TeamThreadAttribution,
  type TeamTurnAttribution,
  TeamViewId,
  type TeamWorkspace,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { runTeamMigrations } from "./migrations.ts";

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

const isTeamAlreadyConfiguredError = Schema.is(TeamAlreadyConfiguredError);

export interface StoredTeamInviteRecord extends TeamInvite {
  readonly tokenHash: string;
}

export interface TeamRelayRecipientBinding {
  readonly teamId: TeamId;
  readonly memberId: TeamMemberId;
  readonly cloudUserId: string | null;
  readonly boundAt: string;
}

interface WorkspaceRow {
  readonly id: string;
  readonly name: string;
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
  readonly creator_member_id: string;
  readonly creator_pseudo: string;
  readonly view_id: string;
  readonly locked: number;
  readonly created_at: string;
}

interface TurnMetaRow {
  readonly turn_id: string;
  readonly thread_id: string;
  readonly author_member_id: string;
  readonly author_pseudo: string;
  readonly created_at: string;
}

const mapWorkspaceRow = (row: WorkspaceRow): TeamWorkspace => ({
  id: TeamId.make(row.id),
  name: row.name,
  defaultViewId: TeamViewId.make(row.default_view_id),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapMemberRow = (row: MemberRow): TeamMember => ({
  id: TeamMemberId.make(row.id),
  teamId: TeamId.make(row.team_id),
  pseudo: row.pseudo as TeamPseudo,
  role: row.role,
  status: row.status,
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

const mapThreadMetaRow = (row: ThreadMetaRow): TeamThreadAttribution => ({
  threadId: ThreadId.make(row.thread_id),
  teamId: TeamId.make(row.team_id),
  creatorMemberId: TeamMemberId.make(row.creator_member_id),
  creatorPseudo: row.creator_pseudo as TeamPseudo,
  viewId: TeamViewId.make(row.view_id),
  locked: row.locked === 1,
  createdAt: row.created_at,
});

const mapTurnMetaRow = (row: TurnMetaRow): TeamTurnAttribution => ({
  turnId: row.turn_id,
  threadId: ThreadId.make(row.thread_id),
  authorMemberId: TeamMemberId.make(row.author_member_id),
  authorPseudo: row.author_pseudo as TeamPseudo,
  createdAt: row.created_at,
});

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
      readonly creatorMemberId: TeamMemberId;
      readonly viewId: TeamViewId;
      readonly createdAt: string;
    }) => Effect.Effect<Option.Option<TeamThreadAttribution>, TeamRepositoryError>;
    readonly listThreadAttributions: (
      teamId: TeamId,
    ) => Effect.Effect<ReadonlyArray<TeamThreadAttribution>, TeamRepositoryError>;
    readonly getThreadAttribution: (
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<TeamThreadAttribution>, TeamRepositoryError>;
    readonly recordTurnAttribution: (input: {
      readonly turnId: string;
      readonly threadId: ThreadId;
      readonly authorMemberId: TeamMemberId;
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
          SELECT id, name, default_view_id, created_at, updated_at
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
              INSERT INTO team_workspaces (id, singleton, name, default_view_id, created_at, updated_at)
              VALUES (
                ${input.team.id},
                1,
                ${input.team.name},
                ${input.team.defaultViewId},
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

    listMembers: Effect.fn("TeamRepository.listMembers")(function* (teamId) {
      const rows = yield* runSql(
        "listMembers",
        sql<MemberRow>`
          SELECT id, team_id, pseudo, role, status, created_at, updated_at
          FROM team_members
          WHERE team_id = ${teamId}
          ORDER BY created_at ASC
        `,
      );
      return rows.map(mapMemberRow);
    }),

    getMemberById: Effect.fn("TeamRepository.getMemberById")(function* (memberId) {
      const rows = yield* runSql(
        "getMemberById",
        sql<MemberRow>`
          SELECT id, team_id, pseudo, role, status, created_at, updated_at
          FROM team_members
          WHERE id = ${memberId}
          LIMIT 1
        `,
      );
      return rows[0] ? Option.some(mapMemberRow(rows[0])) : Option.none();
    }),

    getMemberForSession: Effect.fn("TeamRepository.getMemberForSession")(function* (sessionId) {
      const rows = yield* runSql(
        "getMemberForSession",
        sql<MemberRow>`
          SELECT m.id, m.team_id, m.pseudo, m.role, m.status, m.created_at, m.updated_at
          FROM team_session_meta s
          INNER JOIN team_members m ON m.id = s.member_id
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
      const rows = yield* sql<MemberRow>`
        UPDATE team_members
        SET pseudo = ${input.pseudo}, updated_at = ${input.updatedAt}
        WHERE id = ${input.memberId} AND team_id = ${input.teamId} AND status != 'removed'
        RETURNING id, team_id, pseudo, role, status, created_at, updated_at
      `.pipe(
        Effect.mapError((cause) =>
          isUniqueConstraintError(cause)
            ? new TeamPseudoAlreadyTakenError({ pseudo: input.pseudo })
            : new TeamRepositoryError({ operation: "updateMemberPseudo", cause }),
        ),
      );
      return rows[0] ? Option.some(mapMemberRow(rows[0])) : Option.none();
    }),

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
      yield* runSql(
        "recordThreadAttribution.insert",
        sql`
          INSERT OR IGNORE INTO team_thread_meta (
            thread_id, team_id, creator_member_id, view_id, locked, created_at
          )
          VALUES (
            ${input.threadId},
            ${input.teamId},
            ${input.creatorMemberId},
            ${input.viewId},
            0,
            ${input.createdAt}
          )
        `,
      );
      const rows = yield* runSql(
        "recordThreadAttribution.select",
        sql<ThreadMetaRow>`
          SELECT t.thread_id, t.team_id, t.creator_member_id, m.pseudo AS creator_pseudo,
                 t.view_id, t.locked, t.created_at
          FROM team_thread_meta t
          INNER JOIN team_members m ON m.id = t.creator_member_id
          WHERE t.thread_id = ${input.threadId}
          LIMIT 1
        `,
      );
      return rows[0] ? Option.some(mapThreadMetaRow(rows[0])) : Option.none();
    }),

    listThreadAttributions: Effect.fn("TeamRepository.listThreadAttributions")(function* (teamId) {
      const rows = yield* runSql(
        "listThreadAttributions",
        sql<ThreadMetaRow>`
          SELECT t.thread_id, t.team_id, t.creator_member_id, m.pseudo AS creator_pseudo,
                 t.view_id, t.locked, t.created_at
          FROM team_thread_meta t
          INNER JOIN team_members m ON m.id = t.creator_member_id
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
          SELECT t.thread_id, t.team_id, t.creator_member_id, m.pseudo AS creator_pseudo,
                 t.view_id, t.locked, t.created_at
          FROM team_thread_meta t
          INNER JOIN team_members m ON m.id = t.creator_member_id
          WHERE t.thread_id = ${threadId}
          LIMIT 1
        `,
      );
      return rows[0] ? Option.some(mapThreadMetaRow(rows[0])) : Option.none();
    }),

    recordTurnAttribution: Effect.fn("TeamRepository.recordTurnAttribution")(function* (input) {
      const rows = yield* runSql(
        "recordTurnAttribution",
        sql<{ readonly turn_id: string }>`
          INSERT OR IGNORE INTO team_turn_meta (turn_id, thread_id, author_member_id, created_at)
          VALUES (${input.turnId}, ${input.threadId}, ${input.authorMemberId}, ${input.createdAt})
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
            SELECT t.turn_id, t.thread_id, t.author_member_id, m.pseudo AS author_pseudo, t.created_at
            FROM team_turn_meta t
            INNER JOIN team_members m ON m.id = t.author_member_id
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
          SELECT t.turn_id, t.thread_id, t.author_member_id, m.pseudo AS author_pseudo, t.created_at
          FROM team_turn_meta t
          INNER JOIN team_members m ON m.id = t.author_member_id
          WHERE t.turn_id = ${turnId}
          LIMIT 1
        `,
      );
      return rows[0] ? Option.some(mapTurnMetaRow(rows[0])) : Option.none();
    }),

    listLatestTurnAttributions: Effect.fn("TeamRepository.listLatestTurnAttributions")(
      function* (teamId) {
        // Keep the most recent non-steering runs per thread so queued runs never evict an active run's author.
        const rows = yield* runSql(
          "listLatestTurnAttributions",
          sql<TurnMetaRow>`
          SELECT turn_id, thread_id, author_member_id, author_pseudo, created_at
          FROM (
            SELECT
              t.turn_id,
              t.thread_id,
              t.author_member_id,
              m.pseudo AS author_pseudo,
              t.created_at,
              ROW_NUMBER() OVER (PARTITION BY t.thread_id ORDER BY t.rowid DESC) AS rn
            FROM team_turn_meta t
            INNER JOIN team_thread_meta tm ON tm.thread_id = t.thread_id
            INNER JOIN team_members m ON m.id = t.author_member_id
            WHERE tm.team_id = ${teamId}
              AND t.turn_id NOT LIKE 'msg:%'
          )
          WHERE rn <= 5
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
  });
});

export const layer = Layer.effect(TeamRepository, make);
