import {
  type CreateProjectOutput,
  deleteProject,
  getConnectionURI,
  getProject,
  getProjectOperation,
  listProjectBranchDatabases,
  listProjectBranches,
  listProjects,
  type ListProjectsOutput,
  createProject as sdkCreateProject,
  updateProject,
} from "@distilled.cloud/neon";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../Diff.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { applyMigrations, runSql } from "./Migrations.ts";
import { parsePostgresOrigin, type PostgresOrigin } from "./PostgresOrigin.ts";
import type { Providers } from "./Providers.ts";
import {
  listSqlFiles,
  readSqlFile,
  hashMigrations,
  hashImports,
} from "../Sql/SqlFile.ts";

type NeonOperationStatus =
  | "scheduling"
  | "running"
  | "finished"
  | "failed"
  | "error"
  | "cancelling"
  | "cancelled"
  | "skipped";

export class OperationFailed extends Data.TaggedError("OperationFailed")<{
  operationId: string;
  action: string;
  status: NeonOperationStatus;
  error?: string;
}> {}

class OperationPending extends Data.TaggedError("OperationPending")<{
  operationId: string;
}> {}

const isOperationComplete = (status: NeonOperationStatus): boolean =>
  status === "finished" ||
  status === "failed" ||
  status === "error" ||
  status === "cancelled" ||
  status === "skipped";

/**
 * Wait for the given operations to reach a terminal state. Polls every
 * 500ms with exponential backoff up to ~30s per operation.
 */
export const waitForOperations = (
  operations: ReadonlyArray<{
    readonly id: string;
    readonly project_id: string;
    readonly action: string;
    readonly status: NeonOperationStatus;
    readonly error?: string;
  }>,
) =>
  Effect.gen(function* () {
    for (const op of operations) {
      if (isOperationComplete(op.status)) {
        if (op.status === "failed" || op.status === "error") {
          return yield* new OperationFailed({
            operationId: op.id,
            action: op.action,
            status: op.status,
            error: op.error,
          });
        }
        continue;
      }
      yield* getProjectOperation({
        project_id: op.project_id,
        operation_id: op.id,
      }).pipe(
        Effect.flatMap(
          ({
            operation,
          }): Effect.Effect<void, OperationFailed | OperationPending> => {
            const status = operation.status as NeonOperationStatus;
            if (status === "failed" || status === "error") {
              return Effect.fail(
                new OperationFailed({
                  operationId: operation.id,
                  action: operation.action,
                  status,
                  error: operation.error,
                }),
              );
            }
            if (!isOperationComplete(status)) {
              return Effect.fail(new OperationPending({ operationId: op.id }));
            }
            return Effect.void;
          },
        ),
        Effect.retry({
          while: (e: unknown) => {
            const tag = (e as { _tag?: string })._tag;
            return (
              tag === "OperationPending" ||
              tag === "TooManyRequests" ||
              tag === "ServiceUnavailable" ||
              tag === "InternalServerError" ||
              tag === "BadGateway" ||
              tag === "GatewayTimeout"
            );
          },
          schedule: Schedule.both(
            Schedule.exponential(Duration.millis(500), 1.5),
            Schedule.recurs(60),
          ),
        }),
        Effect.catchTag("OperationPending", () => Effect.void),
      );
    }
  });

const findProjectByName = (name: string) =>
  Effect.gen(function* () {
    const matches: ListProjectsOutput["projects"][number][] = [];
    let cursor: string | undefined;
    while (true) {
      const page = yield* listProjects({
        search: name,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      for (const p of page.projects) {
        if (p.name === name) matches.push(p);
      }
      const nextCursor = page.pagination?.cursor;
      // Neon returns a `pagination.cursor` on every response — it's the
      // `created_at` of the last row, not a "has next page" flag — so we
      // can't loop on cursor presence alone or we spin forever re-fetching
      // empty/identical pages. Stop once a page comes back empty or the
      // cursor stops advancing.
      if (
        page.projects.length === 0 ||
        nextCursor === undefined ||
        nextCursor === cursor
      ) {
        break;
      }
      cursor = nextCursor;
    }
    return matches;
  });

export type NeonRegion =
  | "aws-us-east-1"
  | "aws-us-east-2"
  | "aws-us-west-2"
  | "aws-eu-central-1"
  | "aws-eu-west-2"
  | "aws-ap-southeast-1"
  | "aws-ap-southeast-2"
  | "aws-sa-east-1"
  | "azure-eastus2"
  | "azure-westus3"
  | "azure-gwc";

export type NeonPgVersion = 14 | 15 | 16 | 17 | 18;

const DEFAULT_MIGRATIONS_TABLE = "neon_migrations";
const DEFAULT_REGION: NeonRegion = "aws-us-east-1";
const DEFAULT_PG_VERSION: NeonPgVersion = 17;

export type ProjectProps = {
  /**
   * Name of the project. If omitted, a unique name is generated from
   * `${app}-${stage}-${id}`.
   */
  name?: string;
  /**
   * Region where the project is provisioned. Cannot be changed after
   * creation.
   *
   * @default "aws-us-east-1"
   */
  region?: NeonRegion;
  /**
   * Postgres version. Cannot be changed after creation.
   *
   * @default 17
   */
  pgVersion?: NeonPgVersion;
  /**
   * Name of the default branch. Defaults to Neon's default ("main"). Cannot
   * be changed after creation.
   */
  defaultBranchName?: string;
  /**
   * Name of the default role created with the project. Defaults to
   * `neondb_owner`. Cannot be changed after creation.
   */
  roleName?: string;
  /**
   * Name of the default database created with the project. Defaults to
   * `neondb`. Cannot be changed after creation.
   */
  databaseName?: string;
  /**
   * Number of seconds of WAL history retained on the project for
   * point-in-time branching/restore.
   *
   * @default 86400
   */
  historyRetentionSeconds?: number;
  /**
   * Optional Neon organization ID. Cannot be changed after creation.
   */
  orgId?: string;
  /**
   * Enable Postgres logical replication on the project. Once enabled,
   * Neon does not support disabling it again.
   *
   * @default false
   * @see https://neon.tech/docs/guides/logical-replication-neon
   */
  enableLogicalReplication?: boolean;
  /**
   * Directory containing `.sql` migration files. Files are sorted by their
   * numeric prefix (e.g. `0001_init.sql`) and applied in order against the
   * default branch's primary database.
   */
  migrationsDir?: string;
  /**
   * Name of the table used to track applied migrations.
   *
   * @default "neon_migrations"
   */
  migrationsTable?: string;
  /**
   * Paths to additional `.sql` files to apply after migrations. Each file
   * is hashed; only files whose contents change are re-applied on
   * subsequent deploys.
   */
  importFiles?: string[];
};

export type Project = Resource<
  "Neon.Project",
  ProjectProps,
  {
    projectId: string;
    projectName: string;
    region: NeonRegion;
    pgVersion: NeonPgVersion;
    defaultBranchId: string;
    defaultBranchName: string;
    databaseName: string;
    roleName: string;
    /** Postgres connection URI for the default branch + database. */
    connectionUri: string;
    /** Pooled connection URI (uses pgbouncer). */
    pooledConnectionUri: string;
    /**
     * Parsed connection components ready to feed into a Postgres origin
     * — e.g. `Cloudflare.Hyperdrive`'s `origin` prop. Points at the
     * direct (non-pooled) endpoint, which is the recommended target
     * when fronting Neon with another pooler like Hyperdrive.
     */
    origin: PostgresOrigin;
    historyRetentionSeconds: number;
    enableLogicalReplication: boolean;
    migrationsDir: string | undefined;
    migrationsTable: string | undefined;
    migrationsHashes: Record<string, string>;
    importHashes: Record<string, string>;
  },
  never,
  Providers
>;

/**
 * A Neon serverless Postgres project.
 *
 * Creating a project also provisions the project's default branch (named
 * "main" by default), an initial role, an initial database, and a
 * read-write compute endpoint, exposed as `connectionUri`.
 *
 * @section Creating a Project
 * @example Basic project
 * ```typescript
 * const project = yield* Neon.Project("my-project");
 * ```
 *
 * @example Project with explicit region and PG version
 * ```typescript
 * const project = yield* Neon.Project("my-project", {
 *   region: "aws-eu-central-1",
 *   pgVersion: 17,
 * });
 * ```
 *
 * @example Project with logical replication enabled
 * ```typescript
 * const project = yield* Neon.Project("my-project", {
 *   enableLogicalReplication: true,
 * });
 * ```
 *
 * @section Migrations and seed data
 * @example Apply migrations and seed files
 * ```typescript
 * const project = yield* Neon.Project("my-project", {
 *   migrationsDir: "./migrations",
 *   importFiles: ["./seed/users.sql"],
 * });
 * ```
 *
 * @section Branching
 * @example Create a branch off the project's default branch
 * ```typescript
 * const project = yield* Neon.Project("my-project");
 * const dev = yield* Neon.Branch("dev-branch", { project });
 * ```
 *
 * @see https://neon.tech/docs/manage/projects/
 */
export const Project = Resource<Project>("Neon.Project");

const getRoleName = (creation: CreateProjectOutput) =>
  creation.roles.find((r) => !r.protected)?.name ?? creation.roles[0]?.name;

const getDatabaseName = (creation: CreateProjectOutput) =>
  creation.databases[0]?.name ?? "neondb";

const resolveConnection = (
  projectId: string,
  branchId: string,
  databaseName: string,
  roleName: string,
) =>
  Effect.gen(function* () {
    const direct = yield* getConnectionURI({
      project_id: projectId,
      branch_id: branchId,
      database_name: databaseName,
      role_name: roleName,
      pooled: false,
    });
    const pooled = yield* getConnectionURI({
      project_id: projectId,
      branch_id: branchId,
      database_name: databaseName,
      role_name: roleName,
      pooled: true,
    });
    return { uri: direct.uri, pooled: pooled.uri };
  });

export const ProjectProvider = () =>
  Provider.effect(
    Project,
    Effect.gen(function* () {
      const rootDir = process.cwd();

      const createProjectName = (id: string, name: string | undefined) =>
        Effect.gen(function* () {
          return name ?? (yield* createPhysicalName({ id }));
        });

      return {
        stables: ["projectId", "defaultBranchId"],
        diff: Effect.fn(function* ({ id, olds = {}, news = {}, output }) {
          if (!isResolved(news)) return undefined;
          const name = yield* createProjectName(id, news.name);
          const oldName = output?.projectName
            ? output.projectName
            : yield* createProjectName(id, olds.name);
          if (
            oldName !== name ||
            (news.region ?? DEFAULT_REGION) !==
              (output?.region ?? olds.region ?? DEFAULT_REGION) ||
            (news.pgVersion ?? DEFAULT_PG_VERSION) !==
              (output?.pgVersion ?? olds.pgVersion ?? DEFAULT_PG_VERSION) ||
            (news.defaultBranchName ?? output?.defaultBranchName) !==
              output?.defaultBranchName
          ) {
            return { action: "replace" } as const;
          }
          if (
            (news.historyRetentionSeconds ?? 86400) !==
            (output?.historyRetentionSeconds ?? 86400)
          ) {
            return { action: "update" } as const;
          }
          if (
            (news.enableLogicalReplication ?? false) !==
            (output?.enableLogicalReplication ?? false)
          ) {
            return { action: "update" } as const;
          }
          if (news.migrationsDir) {
            const newHashes = yield* hashMigrations(news.migrationsDir);
            if (!recordsEqual(newHashes, output?.migrationsHashes ?? {})) {
              return { action: "update" } as const;
            }
            if (
              (news.migrationsTable ?? DEFAULT_MIGRATIONS_TABLE) !==
              (output?.migrationsTable ?? DEFAULT_MIGRATIONS_TABLE)
            ) {
              return { action: "update" } as const;
            }
          }
          if (news.importFiles?.length) {
            const newHashes = yield* hashImports(news.importFiles, rootDir);
            if (!recordsEqual(newHashes, output?.importHashes ?? {})) {
              return { action: "update" } as const;
            }
          }
          return undefined;
        }),
        read: Effect.fn(function* ({ id, output, olds }) {
          if (output?.projectId) {
            return yield* getProject({ project_id: output.projectId }).pipe(
              Effect.map(({ project }) => ({
                ...output,
                projectName: project.name,
                historyRetentionSeconds: project.history_retention_seconds,
                enableLogicalReplication:
                  project.settings?.enable_logical_replication === true,
              })),
              Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
            );
          }
          const name = yield* createProjectName(id, olds?.name);
          const matches = yield* findProjectByName(name);
          const match = matches[0];
          if (!match) return undefined;
          const branches = yield* listProjectBranches({
            project_id: match.id,
            search: olds?.defaultBranchName ?? "main",
          });
          const defaultBranch =
            branches.branches.find((b) => b.default) ?? branches.branches[0];
          if (!defaultBranch) return undefined;
          const databases = yield* listProjectBranchDatabases({
            project_id: match.id,
            branch_id: defaultBranch.id,
          });
          const db = databases.databases[0];
          if (!db) return undefined;
          const conn = yield* resolveConnection(
            match.id,
            defaultBranch.id,
            db.name,
            db.owner_name,
          );
          return {
            projectId: match.id,
            projectName: match.name,
            region: match.region_id as NeonRegion,
            pgVersion: match.pg_version as NeonPgVersion,
            defaultBranchId: defaultBranch.id,
            defaultBranchName: defaultBranch.name,
            databaseName: db.name,
            roleName: db.owner_name,
            connectionUri: conn.uri,
            pooledConnectionUri: conn.pooled,
            origin: parsePostgresOrigin(conn.uri),
            historyRetentionSeconds: match.history_retention_seconds ?? 86400,
            enableLogicalReplication:
              match.settings?.enable_logical_replication === true,
            migrationsDir: olds?.migrationsDir,
            migrationsTable: olds?.migrationsTable,
            migrationsHashes: {},
            importHashes: {},
          };
        }),
        reconcile: Effect.fn(function* ({ id, news = {}, output }) {
          // Ensure — when no prior output exists we create the project
          // (and let `read` upstream decide adoption); otherwise update
          // the mutable scalar fields on the existing project.
          const projectInfo = output
            ? yield* updateProject({
                project_id: output.projectId,
                project: {
                  name: news.name,
                  history_retention_seconds: news.historyRetentionSeconds,
                  settings:
                    (news.enableLogicalReplication ?? false) !==
                    (output.enableLogicalReplication ?? false)
                      ? {
                          enable_logical_replication:
                            news.enableLogicalReplication ?? false,
                        }
                      : undefined,
                },
              }).pipe(
                Effect.map((r) => ({
                  projectId: output.projectId,
                  projectName: r.project.name,
                  region: output.region,
                  pgVersion: output.pgVersion,
                  defaultBranchId: output.defaultBranchId,
                  defaultBranchName: output.defaultBranchName,
                  databaseName: output.databaseName,
                  roleName: output.roleName,
                  connectionUri: output.connectionUri,
                  pooledConnectionUri: output.pooledConnectionUri,
                  origin: output.origin,
                  historyRetentionSeconds:
                    r.project.history_retention_seconds ??
                    output.historyRetentionSeconds,
                  enableLogicalReplication:
                    r.project.settings?.enable_logical_replication === true,
                })),
              )
            : yield* Effect.gen(function* () {
                const name = yield* createProjectName(id, news.name);
                const created = yield* sdkCreateProject({
                  project: {
                    name,
                    region_id: news.region,
                    pg_version: news.pgVersion,
                    branch: {
                      name: news.defaultBranchName,
                      role_name: news.roleName,
                      database_name: news.databaseName,
                    },
                    history_retention_seconds: news.historyRetentionSeconds,
                    org_id: news.orgId,
                    settings: news.enableLogicalReplication
                      ? { enable_logical_replication: true }
                      : undefined,
                  },
                });
                yield* waitForOperations(created.operations);

                const branchId = created.branch.id;
                const databaseName = getDatabaseName(created);
                const roleName = getRoleName(created) ?? "neondb_owner";
                const conn = yield* resolveConnection(
                  created.project.id,
                  branchId,
                  databaseName,
                  roleName,
                );
                return {
                  projectId: created.project.id,
                  projectName: created.project.name,
                  region: created.project.region_id as NeonRegion,
                  pgVersion: created.project.pg_version as NeonPgVersion,
                  defaultBranchId: branchId,
                  defaultBranchName: created.branch.name,
                  databaseName,
                  roleName,
                  connectionUri: conn.uri,
                  pooledConnectionUri: conn.pooled,
                  origin: parsePostgresOrigin(conn.uri),
                  historyRetentionSeconds:
                    created.project.history_retention_seconds ?? 86400,
                  enableLogicalReplication:
                    created.project.settings?.enable_logical_replication ===
                    true,
                };
              });

          const connectionUri = Redacted.make(projectInfo.connectionUri);
          const migrationsTable =
            news.migrationsTable ??
            output?.migrationsTable ??
            DEFAULT_MIGRATIONS_TABLE;
          const migrationsHashes = news.migrationsDir
            ? yield* runMigrations(
                connectionUri,
                news.migrationsDir,
                migrationsTable,
              )
            : (output?.migrationsHashes ?? {});
          const importHashes = news.importFiles?.length
            ? yield* runImports(
                connectionUri,
                news.importFiles,
                rootDir,
                output?.importHashes ?? {},
              )
            : {};

          return {
            ...projectInfo,
            migrationsDir: news.migrationsDir,
            migrationsTable: news.migrationsDir ? migrationsTable : undefined,
            migrationsHashes,
            importHashes,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* deleteProject({ project_id: output.projectId }).pipe(
            Effect.tapError(Console.log),
            Effect.catchTag("NotFound", () => Effect.void),
          );
        }),
      };
    }),
  );

const runMigrations = (
  connectionUri: Redacted.Redacted<string>,
  migrationsDir: string,
  migrationsTable: string,
) =>
  Effect.gen(function* () {
    const files = yield* listSqlFiles(migrationsDir);
    if (files.length > 0) {
      yield* applyMigrations({
        connectionUri,
        migrationsTable,
        migrationsFiles: files,
      });
    }
    const hashes: Record<string, string> = {};
    for (const file of files) hashes[file.id] = file.hash;
    return hashes;
  });

const runImports = (
  connectionUri: Redacted.Redacted<string>,
  importFiles: ReadonlyArray<string>,
  rootDir: string,
  previous: Record<string, string>,
) =>
  Effect.gen(function* () {
    const hashes: Record<string, string> = { ...previous };
    for (const filePath of importFiles) {
      const file = yield* readSqlFile(rootDir, filePath);
      if (previous[filePath] === file.hash) {
        hashes[filePath] = file.hash;
        continue;
      }
      yield* runSql(connectionUri, file.sql);
      hashes[filePath] = file.hash;
    }
    const tracked = new Set(importFiles);
    for (const key of Object.keys(hashes)) {
      if (!tracked.has(key)) delete hashes[key];
    }
    return hashes;
  });

const recordsEqual = (
  a: Record<string, string>,
  b: Record<string, string>,
): boolean => {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (a[k] !== b[k]) return false;
  }
  return true;
};
