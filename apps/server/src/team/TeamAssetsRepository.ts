import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  TeamId,
  TeamMemberId,
  TeamPrepromptId,
  TeamProviderId,
  TeamSkillId,
  TeamSkillSlug,
  type AuthSessionId,
  type TeamAssetProviderDriver,
  type TeamLocalProjectMapping,
  type TeamPreprompt,
  type TeamPrepromptInjectionScope,
  type TeamProvider,
  type TeamProviderDeliveryStrategy,
  type TeamProviderUsageSummary,
  type TeamPseudo,
  type TeamSkill,
  type TeamSkillReference,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { runTeamMigrations } from "./migrations.ts";

export class TeamAssetsRepositoryError extends Schema.TaggedError<TeamAssetsRepositoryError>()(
  "TeamAssetsRepositoryError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Team assets database operation failed (${this.operation}).`;
  }
}

export class TeamSkillSlugConflictError extends Schema.TaggedError<TeamSkillSlugConflictError>()(
  "TeamSkillSlugConflictError",
  {
    slug: Schema.String,
    providerDriver: Schema.String,
  },
) {
  override get message(): string {
    return `A team skill with slug "${this.slug}" already exists for provider "${this.providerDriver}".`;
  }
}

export interface StoredTeamProviderRecord extends TeamProvider {
  readonly secretKey: string | null;
}

export interface StoredLocalSyncTokenRecord {
  readonly tokenHash: string;
  readonly teamId: TeamId;
  readonly memberId: TeamMemberId;
  readonly sessionId: AuthSessionId;
  readonly revokedAt: string | null;
  readonly createdAt: string;
}

export interface StoredLocalTeamBinding {
  readonly teamId: TeamId;
  readonly teamName: string;
  readonly teamServerUrl: string;
  readonly tokenSecretKey: string | null;
  readonly providers: ReadonlyArray<TeamProvider>;
  readonly projects: ReadonlyArray<TeamLocalProjectMapping>;
  readonly skills: ReadonlyArray<TeamSkill>;
  readonly preprompts: ReadonlyArray<TeamPreprompt>;
  readonly assetsRevision: number;
  readonly updatedAt: string;
}

interface ProviderRow {
  readonly id: string;
  readonly team_id: string;
  readonly provider_instance_id: string;
  readonly driver: string;
  readonly display_name: string | null;
  readonly delivery_strategy: TeamProviderDeliveryStrategy;
  readonly upstream_base_url: string | null;
  readonly api_key_header: string | null;
  readonly api_key_prefix: string | null;
  readonly secret_key: string | null;
  readonly config_json: string;
  readonly enabled: number;
  readonly updated_by_member_id: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface UsageRow {
  readonly member_id: string;
  readonly member_pseudo: string;
  readonly provider_instance_id: string;
  readonly strategy: "proxy" | "token-lease";
  readonly request_count: number;
  readonly last_used_at: string;
}

interface SkillRow {
  readonly id: string;
  readonly team_id: string;
  readonly slug: string;
  readonly provider_driver: string;
  readonly skill_md: string;
  readonly references_json: string;
  readonly enabled: number;
  readonly revision: number;
  readonly content_hash: string;
  readonly updated_by_member_id: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface PrepromptRow {
  readonly id: string;
  readonly team_id: string;
  readonly name: string;
  readonly provider_driver: string;
  readonly injection_scope: TeamPrepromptInjectionScope;
  readonly content: string;
  readonly enabled: number;
  readonly revision: number;
  readonly content_hash: string;
  readonly updated_by_member_id: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface TombstoneRow {
  readonly asset_kind: "skill" | "preprompt";
  readonly asset_id: string;
}

interface LocalSyncTokenRow {
  readonly token_hash: string;
  readonly team_id: string;
  readonly member_id: string;
  readonly session_id: string;
  readonly revoked_at: string | null;
  readonly created_at: string;
}

interface LocalBindingRow {
  readonly team_id: string;
  readonly team_name: string;
  readonly team_server_url: string;
  readonly token_secret_key: string | null;
  readonly providers_json: string;
  readonly projects_json: string;
  readonly skills_json: string;
  readonly preprompts_json: string;
  readonly assets_revision: number;
  readonly updated_at: string;
}

const encodeJsonUnknown = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseJsonArray<T>(raw: string): ReadonlyArray<T> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ReadonlyArray<T>) : [];
  } catch {
    return [];
  }
}

const mapProviderRow = (row: ProviderRow): StoredTeamProviderRecord => ({
  id: TeamProviderId.make(row.id),
  teamId: TeamId.make(row.team_id),
  providerInstanceId: ProviderInstanceId.make(row.provider_instance_id),
  driver: ProviderDriverKind.make(row.driver),
  displayName: row.display_name,
  deliveryStrategy: row.delivery_strategy,
  hasSecret: row.secret_key !== null && row.secret_key.length > 0,
  upstreamBaseUrl: row.upstream_base_url,
  apiKeyHeader: row.api_key_header,
  apiKeyPrefix: row.api_key_prefix,
  config: parseJsonObject(row.config_json),
  enabled: row.enabled === 1,
  updatedByMemberId: TeamMemberId.make(row.updated_by_member_id),
  createdAt: IsoDateTime.make(row.created_at),
  updatedAt: IsoDateTime.make(row.updated_at),
  secretKey: row.secret_key,
});

export function stripProviderSecretKey(record: StoredTeamProviderRecord): TeamProvider {
  const { secretKey: _secretKey, ...pub } = record;
  return pub;
}

const mapSkillRow = (row: SkillRow): TeamSkill => ({
  id: TeamSkillId.make(row.id),
  teamId: TeamId.make(row.team_id),
  slug: TeamSkillSlug.make(row.slug),
  providerDriver:
    row.provider_driver === "*"
      ? "*"
      : (ProviderDriverKind.make(row.provider_driver) as TeamAssetProviderDriver),
  skillMd: row.skill_md,
  references: [...parseJsonArray<TeamSkillReference>(row.references_json)],
  enabled: row.enabled === 1,
  revision: NonNegativeInt.make(row.revision),
  contentHash: row.content_hash,
  updatedByMemberId: TeamMemberId.make(row.updated_by_member_id),
  createdAt: IsoDateTime.make(row.created_at),
  updatedAt: IsoDateTime.make(row.updated_at),
});

const mapPrepromptRow = (row: PrepromptRow): TeamPreprompt => ({
  id: TeamPrepromptId.make(row.id),
  teamId: TeamId.make(row.team_id),
  name: row.name,
  providerDriver:
    row.provider_driver === "*"
      ? "*"
      : (ProviderDriverKind.make(row.provider_driver) as TeamAssetProviderDriver),
  injectionScope: row.injection_scope,
  content: row.content,
  enabled: row.enabled === 1,
  revision: NonNegativeInt.make(row.revision),
  contentHash: row.content_hash,
  updatedByMemberId: TeamMemberId.make(row.updated_by_member_id),
  createdAt: IsoDateTime.make(row.created_at),
  updatedAt: IsoDateTime.make(row.updated_at),
});

const mapLocalBindingRow = (row: LocalBindingRow): StoredLocalTeamBinding => ({
  teamId: TeamId.make(row.team_id),
  teamName: row.team_name,
  teamServerUrl: row.team_server_url,
  tokenSecretKey: row.token_secret_key,
  providers: parseJsonArray<TeamProvider>(row.providers_json),
  projects: parseJsonArray<TeamLocalProjectMapping>(row.projects_json),
  skills: parseJsonArray<TeamSkill>(row.skills_json),
  preprompts: parseJsonArray<TeamPreprompt>(row.preprompts_json),
  assetsRevision: row.assets_revision,
  updatedAt: row.updated_at,
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

export class TeamAssetsRepository extends Context.Service<
  TeamAssetsRepository,
  {
    readonly listProviders: (
      teamId: TeamId,
    ) => Effect.Effect<ReadonlyArray<StoredTeamProviderRecord>, TeamAssetsRepositoryError>;
    readonly getProviderByInstanceId: (
      teamId: TeamId,
      providerInstanceId: ProviderInstanceId,
    ) => Effect.Effect<Option.Option<StoredTeamProviderRecord>, TeamAssetsRepositoryError>;
    readonly upsertProvider: (input: {
      readonly id: TeamProviderId;
      readonly teamId: TeamId;
      readonly providerInstanceId: ProviderInstanceId;
      readonly driver: ProviderDriverKind;
      readonly displayName: string | null;
      readonly deliveryStrategy: TeamProviderDeliveryStrategy;
      readonly upstreamBaseUrl: string | null;
      readonly apiKeyHeader: string | null;
      readonly apiKeyPrefix: string | null;
      readonly secretKey: string | null;
      readonly config: Readonly<Record<string, unknown>>;
      readonly enabled: boolean;
      readonly updatedByMemberId: TeamMemberId;
      readonly now: string;
    }) => Effect.Effect<StoredTeamProviderRecord, TeamAssetsRepositoryError>;
    readonly deleteProvider: (
      teamId: TeamId,
      providerInstanceId: ProviderInstanceId,
    ) => Effect.Effect<Option.Option<StoredTeamProviderRecord>, TeamAssetsRepositoryError>;
    readonly recordProviderUsage: (input: {
      readonly id: string;
      readonly teamId: TeamId;
      readonly providerInstanceId: ProviderInstanceId;
      readonly memberId: TeamMemberId;
      readonly strategy: "proxy" | "token-lease";
      readonly requestPath: string | null;
      readonly statusCode: number;
      readonly createdAt: string;
    }) => Effect.Effect<void, TeamAssetsRepositoryError>;
    readonly listProviderUsageSummary: (
      teamId: TeamId,
    ) => Effect.Effect<ReadonlyArray<TeamProviderUsageSummary>, TeamAssetsRepositoryError>;

    readonly getAssetsRevision: (
      teamId: TeamId,
    ) => Effect.Effect<number, TeamAssetsRepositoryError>;
    readonly listSkills: (
      teamId: TeamId,
      options?: { readonly sinceRevision?: number },
    ) => Effect.Effect<ReadonlyArray<TeamSkill>, TeamAssetsRepositoryError>;
    readonly upsertSkill: (input: {
      readonly id: TeamSkillId;
      readonly teamId: TeamId;
      readonly slug: string;
      readonly providerDriver: TeamAssetProviderDriver;
      readonly skillMd: string;
      readonly references: ReadonlyArray<TeamSkillReference>;
      readonly enabled: boolean;
      readonly contentHash: string;
      readonly updatedByMemberId: TeamMemberId;
      readonly now: string;
    }) => Effect.Effect<
      { readonly skill: TeamSkill; readonly revision: number },
      TeamAssetsRepositoryError | TeamSkillSlugConflictError
    >;
    readonly deleteSkill: (input: {
      readonly teamId: TeamId;
      readonly skillId: TeamSkillId;
      readonly tombstoneId: string;
      readonly now: string;
    }) => Effect.Effect<
      { readonly deleted: boolean; readonly revision: number },
      TeamAssetsRepositoryError
    >;

    readonly listPreprompts: (
      teamId: TeamId,
      options?: { readonly sinceRevision?: number },
    ) => Effect.Effect<ReadonlyArray<TeamPreprompt>, TeamAssetsRepositoryError>;
    readonly upsertPreprompt: (input: {
      readonly id: TeamPrepromptId;
      readonly teamId: TeamId;
      readonly name: string;
      readonly providerDriver: TeamAssetProviderDriver;
      readonly injectionScope: TeamPrepromptInjectionScope;
      readonly content: string;
      readonly enabled: boolean;
      readonly contentHash: string;
      readonly updatedByMemberId: TeamMemberId;
      readonly now: string;
    }) => Effect.Effect<
      { readonly preprompt: TeamPreprompt; readonly revision: number },
      TeamAssetsRepositoryError
    >;
    readonly deletePreprompt: (input: {
      readonly teamId: TeamId;
      readonly prepromptId: TeamPrepromptId;
      readonly tombstoneId: string;
      readonly now: string;
    }) => Effect.Effect<
      { readonly deleted: boolean; readonly revision: number },
      TeamAssetsRepositoryError
    >;
    readonly listAssetTombstonesSince: (
      teamId: TeamId,
      sinceRevision: number,
    ) => Effect.Effect<
      {
        readonly deletedSkillIds: ReadonlyArray<TeamSkillId>;
        readonly deletedPrepromptIds: ReadonlyArray<TeamPrepromptId>;
      },
      TeamAssetsRepositoryError
    >;

    readonly insertLocalSyncToken: (input: {
      readonly tokenHash: string;
      readonly teamId: TeamId;
      readonly memberId: TeamMemberId;
      readonly sessionId: AuthSessionId;
      readonly createdAt: string;
    }) => Effect.Effect<void, TeamAssetsRepositoryError>;
    readonly findLocalSyncTokenByHash: (
      tokenHash: string,
    ) => Effect.Effect<Option.Option<StoredLocalSyncTokenRecord>, TeamAssetsRepositoryError>;
    readonly revokeLocalSyncTokensForMember: (
      memberId: TeamMemberId,
      revokedAt: string,
    ) => Effect.Effect<void, TeamAssetsRepositoryError>;

    readonly listLocalBindings: () => Effect.Effect<
      ReadonlyArray<StoredLocalTeamBinding>,
      TeamAssetsRepositoryError
    >;
    readonly getLocalBinding: (
      teamId: TeamId,
    ) => Effect.Effect<Option.Option<StoredLocalTeamBinding>, TeamAssetsRepositoryError>;
    readonly upsertLocalBinding: (input: {
      readonly teamId: TeamId;
      readonly teamName: string;
      readonly teamServerUrl: string;
      readonly tokenSecretKey: string | null;
      readonly providers: ReadonlyArray<TeamProvider>;
      readonly projects: ReadonlyArray<TeamLocalProjectMapping>;
      readonly skills?: ReadonlyArray<TeamSkill>;
      readonly preprompts?: ReadonlyArray<TeamPreprompt>;
      readonly assetsRevision?: number;
      readonly updatedAt: string;
    }) => Effect.Effect<StoredLocalTeamBinding, TeamAssetsRepositoryError>;
    readonly updateLocalBindingAssets: (input: {
      readonly teamId: TeamId;
      readonly skills: ReadonlyArray<TeamSkill>;
      readonly preprompts: ReadonlyArray<TeamPreprompt>;
      readonly assetsRevision: number;
      readonly updatedAt: string;
    }) => Effect.Effect<void, TeamAssetsRepositoryError>;
    readonly deleteLocalBinding: (
      teamId: TeamId,
    ) => Effect.Effect<Option.Option<StoredLocalTeamBinding>, TeamAssetsRepositoryError>;
    readonly findLocalTeamIdForProject: (input: {
      readonly projectId: ProjectId;
      readonly repoIdentityKey?: string | null;
    }) => Effect.Effect<Option.Option<TeamId>, TeamAssetsRepositoryError>;
  }
>()("t3/team/TeamAssetsRepository") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runTeamMigrations().pipe(
    Effect.mapError((cause) => new TeamAssetsRepositoryError({ operation: "migrate", cause })),
  );

  const runSql = <A, E>(operation: string, effect: Effect.Effect<A, E>) =>
    effect.pipe(Effect.mapError((cause) => new TeamAssetsRepositoryError({ operation, cause })));

  const bumpRevisionTx = Effect.fn("TeamAssetsRepository.bumpRevisionTx")(function* (
    teamId: TeamId,
    now: string,
  ) {
    const rows = yield* sql<{ readonly revision: number }>`
      SELECT revision FROM team_asset_revisions WHERE team_id = ${teamId} LIMIT 1
    `;
    const nextRevision = (rows[0]?.revision ?? 0) + 1;
    yield* sql`
      INSERT INTO team_asset_revisions (team_id, revision, updated_at)
      VALUES (${teamId}, ${nextRevision}, ${now})
      ON CONFLICT(team_id) DO UPDATE SET
        revision = excluded.revision,
        updated_at = excluded.updated_at
    `;
    return nextRevision;
  });

  return TeamAssetsRepository.of({
    listProviders: Effect.fn("TeamAssetsRepository.listProviders")(function* (teamId) {
      const rows = yield* runSql(
        "listProviders",
        sql<ProviderRow>`
          SELECT id, team_id, provider_instance_id, driver, display_name, delivery_strategy,
                 upstream_base_url, api_key_header, api_key_prefix, secret_key, config_json,
                 enabled, updated_by_member_id, created_at, updated_at
          FROM team_providers
          WHERE team_id = ${teamId}
          ORDER BY LOWER(COALESCE(display_name, provider_instance_id)) ASC, created_at ASC
        `,
      );
      return rows.map(mapProviderRow);
    }),

    getProviderByInstanceId: Effect.fn("TeamAssetsRepository.getProviderByInstanceId")(
      function* (teamId, providerInstanceId) {
        const rows = yield* runSql(
          "getProviderByInstanceId",
          sql<ProviderRow>`
          SELECT id, team_id, provider_instance_id, driver, display_name, delivery_strategy,
                 upstream_base_url, api_key_header, api_key_prefix, secret_key, config_json,
                 enabled, updated_by_member_id, created_at, updated_at
          FROM team_providers
          WHERE team_id = ${teamId} AND provider_instance_id = ${providerInstanceId}
          LIMIT 1
        `,
        );
        return rows[0] ? Option.some(mapProviderRow(rows[0])) : Option.none();
      },
    ),

    upsertProvider: Effect.fn("TeamAssetsRepository.upsertProvider")(function* (input) {
      const configJson = encodeJsonUnknown(input.config);
      return yield* runSql(
        "upsertProvider",
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              INSERT INTO team_providers (
                id, team_id, provider_instance_id, driver, display_name, delivery_strategy,
                upstream_base_url, api_key_header, api_key_prefix, secret_key, config_json,
                enabled, updated_by_member_id, created_at, updated_at
              )
              VALUES (
                ${input.id},
                ${input.teamId},
                ${input.providerInstanceId},
                ${input.driver},
                ${input.displayName},
                ${input.deliveryStrategy},
                ${input.upstreamBaseUrl},
                ${input.apiKeyHeader},
                ${input.apiKeyPrefix},
                ${input.secretKey},
                ${configJson},
                ${input.enabled ? 1 : 0},
                ${input.updatedByMemberId},
                ${input.now},
                ${input.now}
              )
              ON CONFLICT(team_id, provider_instance_id) DO UPDATE SET
                driver = excluded.driver,
                display_name = excluded.display_name,
                delivery_strategy = excluded.delivery_strategy,
                upstream_base_url = excluded.upstream_base_url,
                api_key_header = excluded.api_key_header,
                api_key_prefix = excluded.api_key_prefix,
                secret_key = excluded.secret_key,
                config_json = excluded.config_json,
                enabled = excluded.enabled,
                updated_by_member_id = excluded.updated_by_member_id,
                updated_at = excluded.updated_at
            `;
            const rows = yield* sql<ProviderRow>`
              SELECT id, team_id, provider_instance_id, driver, display_name, delivery_strategy,
                     upstream_base_url, api_key_header, api_key_prefix, secret_key, config_json,
                     enabled, updated_by_member_id, created_at, updated_at
              FROM team_providers
              WHERE team_id = ${input.teamId} AND provider_instance_id = ${input.providerInstanceId}
              LIMIT 1
            `;
            return mapProviderRow(rows[0]!);
          }),
        ),
      );
    }),

    deleteProvider: Effect.fn("TeamAssetsRepository.deleteProvider")(
      function* (teamId, providerInstanceId) {
        return yield* runSql(
          "deleteProvider",
          sql.withTransaction(
            Effect.gen(function* () {
              const existing = yield* sql<ProviderRow>`
              SELECT id, team_id, provider_instance_id, driver, display_name, delivery_strategy,
                     upstream_base_url, api_key_header, api_key_prefix, secret_key, config_json,
                     enabled, updated_by_member_id, created_at, updated_at
              FROM team_providers
              WHERE team_id = ${teamId} AND provider_instance_id = ${providerInstanceId}
              LIMIT 1
            `;
              if (!existing[0]) return Option.none();
              yield* sql`
              DELETE FROM team_providers
              WHERE team_id = ${teamId} AND provider_instance_id = ${providerInstanceId}
            `;
              return Option.some(mapProviderRow(existing[0]));
            }),
          ),
        );
      },
    ),

    recordProviderUsage: Effect.fn("TeamAssetsRepository.recordProviderUsage")(function* (input) {
      yield* runSql(
        "recordProviderUsage",
        sql`
          INSERT INTO team_provider_usage (
            id, team_id, provider_instance_id, member_id, strategy, request_path, status_code, created_at
          )
          VALUES (
            ${input.id},
            ${input.teamId},
            ${input.providerInstanceId},
            ${input.memberId},
            ${input.strategy},
            ${input.requestPath},
            ${input.statusCode},
            ${input.createdAt}
          )
        `,
      );
    }),

    listProviderUsageSummary: Effect.fn("TeamAssetsRepository.listProviderUsageSummary")(
      function* (teamId) {
        const rows = yield* runSql(
          "listProviderUsageSummary",
          sql<UsageRow>`
          SELECT u.member_id, m.pseudo AS member_pseudo, u.provider_instance_id, u.strategy,
                 COUNT(*) AS request_count, MAX(u.created_at) AS last_used_at
          FROM team_provider_usage u
          INNER JOIN team_members m ON m.id = u.member_id
          WHERE u.team_id = ${teamId}
          GROUP BY u.member_id, u.provider_instance_id, u.strategy
          ORDER BY last_used_at DESC
        `,
        );
        return rows.map((row) => ({
          memberId: TeamMemberId.make(row.member_id),
          memberPseudo: row.member_pseudo as TeamPseudo,
          providerInstanceId: ProviderInstanceId.make(row.provider_instance_id),
          strategy: row.strategy,
          requestCount: NonNegativeInt.make(Number(row.request_count)),
          lastUsedAt: IsoDateTime.make(row.last_used_at),
        }));
      },
    ),

    getAssetsRevision: Effect.fn("TeamAssetsRepository.getAssetsRevision")(function* (teamId) {
      const rows = yield* runSql(
        "getAssetsRevision",
        sql<{ readonly revision: number }>`
          SELECT revision FROM team_asset_revisions WHERE team_id = ${teamId} LIMIT 1
        `,
      );
      return rows[0]?.revision ?? 0;
    }),

    listSkills: Effect.fn("TeamAssetsRepository.listSkills")(function* (teamId, options) {
      const since = options?.sinceRevision;
      const rows = yield* runSql(
        "listSkills",
        since !== undefined && since > 0
          ? sql<SkillRow>`
              SELECT id, team_id, slug, provider_driver, skill_md, references_json, enabled,
                     revision, content_hash, updated_by_member_id, created_at, updated_at
              FROM team_skills
              WHERE team_id = ${teamId} AND revision > ${since}
              ORDER BY slug ASC, provider_driver ASC
            `
          : sql<SkillRow>`
              SELECT id, team_id, slug, provider_driver, skill_md, references_json, enabled,
                     revision, content_hash, updated_by_member_id, created_at, updated_at
              FROM team_skills
              WHERE team_id = ${teamId}
              ORDER BY slug ASC, provider_driver ASC
            `,
      );
      return rows.map(mapSkillRow);
    }),

    upsertSkill: Effect.fn("TeamAssetsRepository.upsertSkill")(function* (input) {
      const referencesJson = encodeJsonUnknown(input.references);
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const revision = yield* bumpRevisionTx(input.teamId, input.now);
            const existingById = yield* sql<{ readonly id: string }>`
              SELECT id FROM team_skills WHERE id = ${input.id} AND team_id = ${input.teamId} LIMIT 1
            `;
            if (existingById[0]) {
              yield* sql`
                UPDATE team_skills
                SET slug = ${input.slug},
                    provider_driver = ${input.providerDriver},
                    skill_md = ${input.skillMd},
                    references_json = ${referencesJson},
                    enabled = ${input.enabled ? 1 : 0},
                    revision = ${revision},
                    content_hash = ${input.contentHash},
                    updated_by_member_id = ${input.updatedByMemberId},
                    updated_at = ${input.now}
                WHERE id = ${input.id} AND team_id = ${input.teamId}
              `;
            } else {
              yield* sql`
                INSERT INTO team_skills (
                  id, team_id, slug, provider_driver, skill_md, references_json, enabled,
                  revision, content_hash, updated_by_member_id, created_at, updated_at
                )
                VALUES (
                  ${input.id},
                  ${input.teamId},
                  ${input.slug},
                  ${input.providerDriver},
                  ${input.skillMd},
                  ${referencesJson},
                  ${input.enabled ? 1 : 0},
                  ${revision},
                  ${input.contentHash},
                  ${input.updatedByMemberId},
                  ${input.now},
                  ${input.now}
                )
              `;
            }
            const rows = yield* sql<SkillRow>`
              SELECT id, team_id, slug, provider_driver, skill_md, references_json, enabled,
                     revision, content_hash, updated_by_member_id, created_at, updated_at
              FROM team_skills
              WHERE id = ${input.id} AND team_id = ${input.teamId}
              LIMIT 1
            `;
            return { skill: mapSkillRow(rows[0]!), revision };
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            errorChainIncludes(cause, "UNIQUE constraint failed: team_skills")
              ? new TeamSkillSlugConflictError({
                  slug: input.slug,
                  providerDriver: input.providerDriver,
                })
              : new TeamAssetsRepositoryError({ operation: "upsertSkill", cause }),
          ),
        );
    }),

    deleteSkill: Effect.fn("TeamAssetsRepository.deleteSkill")(function* (input) {
      return yield* runSql(
        "deleteSkill",
        sql.withTransaction(
          Effect.gen(function* () {
            const existing = yield* sql<{ readonly id: string }>`
              SELECT id FROM team_skills WHERE id = ${input.skillId} AND team_id = ${input.teamId} LIMIT 1
            `;
            if (!existing[0]) {
              const revRows = yield* sql<{ readonly revision: number }>`
                SELECT revision FROM team_asset_revisions WHERE team_id = ${input.teamId} LIMIT 1
              `;
              return { deleted: false, revision: revRows[0]?.revision ?? 0 };
            }
            const revision = yield* bumpRevisionTx(input.teamId, input.now);
            yield* sql`
              DELETE FROM team_skills WHERE id = ${input.skillId} AND team_id = ${input.teamId}
            `;
            yield* sql`
              INSERT INTO team_asset_tombstones (
                id, team_id, asset_kind, asset_id, deleted_at_revision, deleted_at
              )
              VALUES (
                ${input.tombstoneId}, ${input.teamId}, 'skill', ${input.skillId}, ${revision}, ${input.now}
              )
            `;
            return { deleted: true, revision };
          }),
        ),
      );
    }),

    listPreprompts: Effect.fn("TeamAssetsRepository.listPreprompts")(function* (teamId, options) {
      const since = options?.sinceRevision;
      const rows = yield* runSql(
        "listPreprompts",
        since !== undefined && since > 0
          ? sql<PrepromptRow>`
              SELECT id, team_id, name, provider_driver, injection_scope, content, enabled,
                     revision, content_hash, updated_by_member_id, created_at, updated_at
              FROM team_preprompts
              WHERE team_id = ${teamId} AND revision > ${since}
              ORDER BY injection_scope ASC, LOWER(name) ASC, created_at ASC
            `
          : sql<PrepromptRow>`
              SELECT id, team_id, name, provider_driver, injection_scope, content, enabled,
                     revision, content_hash, updated_by_member_id, created_at, updated_at
              FROM team_preprompts
              WHERE team_id = ${teamId}
              ORDER BY injection_scope ASC, LOWER(name) ASC, created_at ASC
            `,
      );
      return rows.map(mapPrepromptRow);
    }),

    upsertPreprompt: Effect.fn("TeamAssetsRepository.upsertPreprompt")(function* (input) {
      return yield* runSql(
        "upsertPreprompt",
        sql.withTransaction(
          Effect.gen(function* () {
            const revision = yield* bumpRevisionTx(input.teamId, input.now);
            const existingById = yield* sql<{ readonly id: string }>`
              SELECT id FROM team_preprompts WHERE id = ${input.id} AND team_id = ${input.teamId} LIMIT 1
            `;
            if (existingById[0]) {
              yield* sql`
                UPDATE team_preprompts
                SET name = ${input.name},
                    provider_driver = ${input.providerDriver},
                    injection_scope = ${input.injectionScope},
                    content = ${input.content},
                    enabled = ${input.enabled ? 1 : 0},
                    revision = ${revision},
                    content_hash = ${input.contentHash},
                    updated_by_member_id = ${input.updatedByMemberId},
                    updated_at = ${input.now}
                WHERE id = ${input.id} AND team_id = ${input.teamId}
              `;
            } else {
              yield* sql`
                INSERT INTO team_preprompts (
                  id, team_id, name, provider_driver, injection_scope, content, enabled,
                  revision, content_hash, updated_by_member_id, created_at, updated_at
                )
                VALUES (
                  ${input.id},
                  ${input.teamId},
                  ${input.name},
                  ${input.providerDriver},
                  ${input.injectionScope},
                  ${input.content},
                  ${input.enabled ? 1 : 0},
                  ${revision},
                  ${input.contentHash},
                  ${input.updatedByMemberId},
                  ${input.now},
                  ${input.now}
                )
              `;
            }
            const rows = yield* sql<PrepromptRow>`
              SELECT id, team_id, name, provider_driver, injection_scope, content, enabled,
                     revision, content_hash, updated_by_member_id, created_at, updated_at
              FROM team_preprompts
              WHERE id = ${input.id} AND team_id = ${input.teamId}
              LIMIT 1
            `;
            return { preprompt: mapPrepromptRow(rows[0]!), revision };
          }),
        ),
      );
    }),

    deletePreprompt: Effect.fn("TeamAssetsRepository.deletePreprompt")(function* (input) {
      return yield* runSql(
        "deletePreprompt",
        sql.withTransaction(
          Effect.gen(function* () {
            const existing = yield* sql<{ readonly id: string }>`
              SELECT id FROM team_preprompts WHERE id = ${input.prepromptId} AND team_id = ${input.teamId} LIMIT 1
            `;
            if (!existing[0]) {
              const revRows = yield* sql<{ readonly revision: number }>`
                SELECT revision FROM team_asset_revisions WHERE team_id = ${input.teamId} LIMIT 1
              `;
              return { deleted: false, revision: revRows[0]?.revision ?? 0 };
            }
            const revision = yield* bumpRevisionTx(input.teamId, input.now);
            yield* sql`
              DELETE FROM team_preprompts WHERE id = ${input.prepromptId} AND team_id = ${input.teamId}
            `;
            yield* sql`
              INSERT INTO team_asset_tombstones (
                id, team_id, asset_kind, asset_id, deleted_at_revision, deleted_at
              )
              VALUES (
                ${input.tombstoneId}, ${input.teamId}, 'preprompt', ${input.prepromptId}, ${revision}, ${input.now}
              )
            `;
            return { deleted: true, revision };
          }),
        ),
      );
    }),

    listAssetTombstonesSince: Effect.fn("TeamAssetsRepository.listAssetTombstonesSince")(
      function* (teamId, sinceRevision) {
        if (sinceRevision <= 0) {
          return { deletedSkillIds: [], deletedPrepromptIds: [] };
        }
        const rows = yield* runSql(
          "listAssetTombstonesSince",
          sql<TombstoneRow>`
          SELECT asset_kind, asset_id
          FROM team_asset_tombstones
          WHERE team_id = ${teamId} AND deleted_at_revision > ${sinceRevision}
        `,
        );
        const deletedSkillIds: Array<TeamSkillId> = [];
        const deletedPrepromptIds: Array<TeamPrepromptId> = [];
        for (const row of rows) {
          if (row.asset_kind === "skill") deletedSkillIds.push(TeamSkillId.make(row.asset_id));
          else deletedPrepromptIds.push(TeamPrepromptId.make(row.asset_id));
        }
        return { deletedSkillIds, deletedPrepromptIds };
      },
    ),

    insertLocalSyncToken: Effect.fn("TeamAssetsRepository.insertLocalSyncToken")(function* (input) {
      yield* runSql(
        "insertLocalSyncToken",
        sql`
          INSERT INTO team_local_sync_tokens (
            token_hash, team_id, member_id, session_id, revoked_at, created_at
          )
          VALUES (
            ${input.tokenHash},
            ${input.teamId},
            ${input.memberId},
            ${input.sessionId},
            NULL,
            ${input.createdAt}
          )
          ON CONFLICT(token_hash) DO UPDATE SET
            revoked_at = NULL
        `,
      );
    }),

    findLocalSyncTokenByHash: Effect.fn("TeamAssetsRepository.findLocalSyncTokenByHash")(
      function* (tokenHash) {
        const rows = yield* runSql(
          "findLocalSyncTokenByHash",
          sql<LocalSyncTokenRow>`
          SELECT token_hash, team_id, member_id, session_id, revoked_at, created_at
          FROM team_local_sync_tokens
          WHERE token_hash = ${tokenHash}
          LIMIT 1
        `,
        );
        const row = rows[0];
        if (!row) return Option.none();
        return Option.some({
          tokenHash: row.token_hash,
          teamId: TeamId.make(row.team_id),
          memberId: TeamMemberId.make(row.member_id),
          sessionId: row.session_id as AuthSessionId,
          revokedAt: row.revoked_at,
          createdAt: row.created_at,
        });
      },
    ),

    revokeLocalSyncTokensForMember: Effect.fn(
      "TeamAssetsRepository.revokeLocalSyncTokensForMember",
    )(function* (memberId, revokedAt) {
      yield* runSql(
        "revokeLocalSyncTokensForMember",
        sql`
          UPDATE team_local_sync_tokens
          SET revoked_at = COALESCE(revoked_at, ${revokedAt})
          WHERE member_id = ${memberId}
        `,
      );
    }),

    listLocalBindings: Effect.fn("TeamAssetsRepository.listLocalBindings")(function* () {
      const rows = yield* runSql(
        "listLocalBindings",
        sql<LocalBindingRow>`
          SELECT team_id, team_name, team_server_url, token_secret_key,
                 providers_json, projects_json, skills_json, preprompts_json,
                 assets_revision, updated_at
          FROM team_local_bindings
          ORDER BY team_id ASC
        `,
      );
      return rows.map(mapLocalBindingRow);
    }),

    getLocalBinding: Effect.fn("TeamAssetsRepository.getLocalBinding")(function* (teamId) {
      const rows = yield* runSql(
        "getLocalBinding",
        sql<LocalBindingRow>`
          SELECT team_id, team_name, team_server_url, token_secret_key,
                 providers_json, projects_json, skills_json, preprompts_json,
                 assets_revision, updated_at
          FROM team_local_bindings
          WHERE team_id = ${teamId}
          LIMIT 1
        `,
      );
      return rows[0] ? Option.some(mapLocalBindingRow(rows[0])) : Option.none();
    }),

    upsertLocalBinding: Effect.fn("TeamAssetsRepository.upsertLocalBinding")(function* (input) {
      const providersJson = encodeJsonUnknown(input.providers);
      const projectsJson = encodeJsonUnknown(input.projects);
      return yield* runSql(
        "upsertLocalBinding",
        sql.withTransaction(
          Effect.gen(function* () {
            const existing = yield* sql<LocalBindingRow>`
              SELECT team_id, team_name, team_server_url, token_secret_key,
                     providers_json, projects_json, skills_json, preprompts_json,
                     assets_revision, updated_at
              FROM team_local_bindings
              WHERE team_id = ${input.teamId}
              LIMIT 1
            `;
            const prev = existing[0];
            const skillsJson =
              input.skills !== undefined
                ? encodeJsonUnknown(input.skills)
                : (prev?.skills_json ?? "[]");
            const prepromptsJson =
              input.preprompts !== undefined
                ? encodeJsonUnknown(input.preprompts)
                : (prev?.preprompts_json ?? "[]");
            const assetsRevision = input.assetsRevision ?? prev?.assets_revision ?? 0;
            const tokenSecretKey = input.tokenSecretKey ?? prev?.token_secret_key ?? null;
            yield* sql`
              INSERT INTO team_local_bindings (
                team_id, team_name, team_server_url, token_secret_key,
                providers_json, projects_json, skills_json, preprompts_json,
                assets_revision, updated_at
              )
              VALUES (
                ${input.teamId},
                ${input.teamName},
                ${input.teamServerUrl},
                ${tokenSecretKey},
                ${providersJson},
                ${projectsJson},
                ${skillsJson},
                ${prepromptsJson},
                ${assetsRevision},
                ${input.updatedAt}
              )
              ON CONFLICT(team_id) DO UPDATE SET
                team_name = excluded.team_name,
                team_server_url = excluded.team_server_url,
                token_secret_key = excluded.token_secret_key,
                providers_json = excluded.providers_json,
                projects_json = excluded.projects_json,
                skills_json = excluded.skills_json,
                preprompts_json = excluded.preprompts_json,
                assets_revision = excluded.assets_revision,
                updated_at = excluded.updated_at
            `;
            const rows = yield* sql<LocalBindingRow>`
              SELECT team_id, team_name, team_server_url, token_secret_key,
                     providers_json, projects_json, skills_json, preprompts_json,
                     assets_revision, updated_at
              FROM team_local_bindings
              WHERE team_id = ${input.teamId}
              LIMIT 1
            `;
            return mapLocalBindingRow(rows[0]!);
          }),
        ),
      );
    }),

    updateLocalBindingAssets: Effect.fn("TeamAssetsRepository.updateLocalBindingAssets")(
      function* (input) {
        const skillsJson = encodeJsonUnknown(input.skills);
        const prepromptsJson = encodeJsonUnknown(input.preprompts);
        yield* runSql(
          "updateLocalBindingAssets",
          sql`
          UPDATE team_local_bindings
          SET skills_json = ${skillsJson},
              preprompts_json = ${prepromptsJson},
              assets_revision = ${input.assetsRevision},
              updated_at = ${input.updatedAt}
          WHERE team_id = ${input.teamId}
        `,
        );
      },
    ),

    deleteLocalBinding: Effect.fn("TeamAssetsRepository.deleteLocalBinding")(function* (teamId) {
      return yield* runSql(
        "deleteLocalBinding",
        sql.withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<LocalBindingRow>`
              SELECT team_id, team_name, team_server_url, token_secret_key,
                     providers_json, projects_json, skills_json, preprompts_json,
                     assets_revision, updated_at
              FROM team_local_bindings
              WHERE team_id = ${teamId}
              LIMIT 1
            `;
            if (!rows[0]) return Option.none();
            yield* sql`
              DELETE FROM team_local_bindings WHERE team_id = ${teamId}
            `;
            return Option.some(mapLocalBindingRow(rows[0]));
          }),
        ),
      );
    }),

    findLocalTeamIdForProject: Effect.fn("TeamAssetsRepository.findLocalTeamIdForProject")(
      function* (input) {
        const rows = yield* runSql(
          "findLocalTeamIdForProject",
          sql<Pick<LocalBindingRow, "team_id" | "projects_json">>`
            SELECT team_id, projects_json FROM team_local_bindings
          `,
        );
        for (const row of rows) {
          const projects = parseJsonArray<TeamLocalProjectMapping>(row.projects_json);
          for (const mapping of projects) {
            if (
              mapping.localProjectId === input.projectId ||
              mapping.teamProjectId === input.projectId
            ) {
              return Option.some(TeamId.make(row.team_id));
            }
            if (
              input.repoIdentityKey &&
              mapping.repoIdentityKey &&
              mapping.repoIdentityKey === input.repoIdentityKey
            ) {
              return Option.some(TeamId.make(row.team_id));
            }
          }
        }
        return Option.none();
      },
    ),
  });
});

export const layer = Layer.effect(TeamAssetsRepository, make);
