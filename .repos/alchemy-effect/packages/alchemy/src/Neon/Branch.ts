import {
  createProjectBranch,
  deleteProjectBranch,
  getConnectionURI,
  getProjectBranch,
  listProjectBranchDatabases,
  listProjectBranches,
  type ListProjectBranchesOutput,
  updateProjectBranch,
} from "@distilled.cloud/neon";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { isResolved } from "../Diff.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { applyMigrations, runSql } from "./Migrations.ts";
import { parsePostgresOrigin, type PostgresOrigin } from "./PostgresOrigin.ts";
import { type Project, waitForOperations } from "./Project.ts";
import type { Providers } from "./Providers.ts";
import { listSqlFiles, readSqlFile } from "../Sql/SqlFile.ts";

const findBranchByName = (projectId: string, name: string) =>
  Effect.gen(function* () {
    const matches: ListProjectBranchesOutput["branches"][number][] = [];
    let cursor: string | undefined;
    do {
      const page = yield* listProjectBranches({
        project_id: projectId,
        search: name,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      for (const b of page.branches) {
        if (b.name === name) matches.push(b);
      }
      cursor = page.pagination?.next;
    } while (cursor);
    return matches;
  });

const DEFAULT_MIGRATIONS_TABLE = "neon_migrations";

export type BranchSource =
  | Project
  | { projectId: string }
  | { project: Project };

export type ParentBranchSource =
  | Branch
  | { branchId: string }
  | { name: string };

export type BranchEndpointConfig = {
  type: "read_only" | "read_write";
  autoscalingLimitMinCu?: number;
  autoscalingLimitMaxCu?: number;
  suspendTimeoutSeconds?: number;
};

export type BranchProps = {
  /**
   * The Neon project (or `{ projectId }`) to create the branch in.
   */
  project: BranchSource;
  /**
   * Branch name. If omitted, a unique name is generated from
   * `${app}-${stage}-${id}`.
   */
  name?: string;
  /**
   * The parent branch to fork from. Accepts a `Branch`, a
   * `{ branchId }`, or `{ name }` to look up by name. Defaults to the
   * project's default branch.
   */
  parentBranch?: ParentBranchSource;
  /**
   * A Log Sequence Number on the parent branch. The new branch is created
   * with parent data as of this LSN.
   */
  parentLsn?: string;
  /**
   * An ISO-8601 timestamp identifying a point in time on the parent branch
   * to fork from.
   */
  parentTimestamp?: string;
  /**
   * Whether the branch is protected from deletion / mutation.
   *
   * @default false
   */
  protected?: boolean;
  /**
   * Initialization source.
   *
   * - `parent-data` (default) — copy schema and data from the parent.
   * - `schema-only` — copy only the schema.
   */
  initSource?: "schema-only" | "parent-data";
  /**
   * RFC-3339 timestamp at which Neon should auto-delete the branch.
   * Useful for ephemeral preview branches.
   */
  expiresAt?: string;
  /**
   * Endpoints to create for the branch. At least one `read-write` endpoint
   * is required to connect to the branch.
   *
   * @default [{ type: "read_write" }]
   */
  endpoints?: BranchEndpointConfig[];
  /**
   * Directory containing `.sql` migration files. Files are sorted by their
   * numeric prefix (e.g. `0001_init.sql`) and applied in order against the
   * branch.
   */
  migrationsDir?: string;
  /**
   * Name of the table used to track applied migrations.
   *
   * @default "neon_migrations"
   */
  migrationsTable?: string;
  /**
   * Paths to additional `.sql` files to apply after migrations.
   */
  importFiles?: string[];
};

export type Branch = Resource<
  "Neon.Branch",
  BranchProps,
  {
    branchId: string;
    branchName: string;
    projectId: string;
    parentBranchId: string | undefined;
    parentLsn: string | undefined;
    parentTimestamp: string | undefined;
    initSource: "schema-only" | "parent-data" | undefined;
    protected: boolean;
    default: boolean;
    expiresAt: string | undefined;
    databaseName: string;
    roleName: string;
    /** Postgres connection URI for the branch's primary database. */
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
    migrationsDir: string | undefined;
    migrationsTable: string | undefined;
    migrationsHashes: Record<string, string>;
    importHashes: Record<string, string>;
  },
  never,
  Providers
>;

/**
 * A branch of a Neon project.
 *
 * Branches are first-class, copy-on-write copies of a parent branch — they
 * share storage with the parent until the new branch starts diverging.
 *
 * @section Branching from a project's default branch
 * @example Basic branch
 * ```typescript
 * const project = yield* Neon.Project("my-project");
 * const dev = yield* Neon.Branch("dev-branch", { project });
 * ```
 *
 * @section Branching from another branch
 * @example Branch off another branch
 * ```typescript
 * const dev = yield* Neon.Branch("dev", { project });
 * const featureBranch = yield* Neon.Branch("feature", {
 *   project,
 *   parentBranch: dev,
 * });
 * ```
 *
 * @section Point-in-time branches
 * @example Branch from a parent at a specific LSN
 * ```typescript
 * const branch = yield* Neon.Branch("at-lsn", {
 *   project,
 *   parentLsn: "0/3FA01B0",
 * });
 * ```
 *
 * @section Migrations on a branch
 * @example Apply migrations on the branch only
 * ```typescript
 * const featureBranch = yield* Neon.Branch("feature", {
 *   project,
 *   migrationsDir: "./migrations",
 * });
 * ```
 *
 * @see https://neon.tech/docs/manage/branches/
 */
export const Branch = Resource<Branch>("Neon.Branch");

const resolveProjectId = (source: BranchSource): string => {
  if ("projectId" in source && source.projectId) {
    return source.projectId as unknown as string;
  }
  if ("project" in source && source.project) {
    return source.project.projectId as unknown as string;
  }
  throw new Error(
    "Invalid Neon project source: must be a Project, { projectId }, or { project }",
  );
};

const resolveParentBranchId = (
  source: ParentBranchSource | undefined,
  projectId: string,
) =>
  Effect.gen(function* () {
    if (!source) return undefined as string | undefined;
    if ("branchId" in source && source.branchId) {
      return source.branchId as unknown as string;
    }
    if ("name" in source && source.name) {
      const matches = yield* findBranchByName(projectId, source.name);
      if (matches.length === 0) {
        return yield* Effect.die(
          `Parent branch "${source.name}" not found in project ${projectId}`,
        );
      }
      if (matches.length > 1) {
        return yield* Effect.die(
          `Multiple branches with name "${source.name}" in project ${projectId}`,
        );
      }
      return matches[0]!.id;
    }
    return undefined as string | undefined;
  });

const buildEndpoints = (endpoints: BranchEndpointConfig[] | undefined) => {
  const list = endpoints ?? [{ type: "read_write" as const }];
  return list.map((e) => ({
    type: e.type,
    autoscaling_limit_min_cu: e.autoscalingLimitMinCu,
    autoscaling_limit_max_cu: e.autoscalingLimitMaxCu,
    suspend_timeout_seconds: e.suspendTimeoutSeconds,
  }));
};

const fetchConnection = (
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

export const BranchProvider = () =>
  Provider.effect(
    Branch,
    Effect.gen(function* () {
      const rootDir = process.cwd();

      const createBranchName = (id: string, name: string | undefined) =>
        Effect.gen(function* () {
          return name ?? (yield* createPhysicalName({ id }));
        });

      return {
        stables: ["branchId", "projectId"],
        diff: Effect.fn(function* ({ id, olds, news, output }) {
          if (!isResolved(news)) return undefined;
          if (
            news.parentLsn !== undefined &&
            output?.parentLsn !== news.parentLsn
          ) {
            return { action: "replace" } as const;
          }
          if (
            news.parentTimestamp !== undefined &&
            output?.parentTimestamp !== news.parentTimestamp
          ) {
            return { action: "replace" } as const;
          }
          if (
            output?.initSource !== undefined &&
            output.initSource !== (news.initSource ?? "parent-data")
          ) {
            return { action: "replace" } as const;
          }
          const newName = yield* createBranchName(id, news.name);
          const oldName = output?.branchName
            ? output.branchName
            : yield* createBranchName(id, olds.name);
          if (
            newName !== oldName ||
            (news.protected ?? false) !== (output?.protected ?? false) ||
            (news.expiresAt ?? undefined) !== (output?.expiresAt ?? undefined)
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
          if (output?.branchId) {
            return yield* getProjectBranch({
              project_id: output.projectId,
              branch_id: output.branchId,
            }).pipe(
              Effect.map(({ branch }) => ({
                ...output,
                branchName: branch.name,
                protected: branch.protected,
                default: branch.default,
                expiresAt: branch.expires_at,
              })),
              Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
            );
          }
          if (!olds?.project) return undefined;
          const projectId = resolveProjectId(olds.project as BranchSource);
          const name = yield* createBranchName(id, olds.name);
          const matches = yield* findBranchByName(projectId, name);
          const match = matches[0];
          if (!match) return undefined;
          const dbs = yield* listProjectBranchDatabases({
            project_id: projectId,
            branch_id: match.id,
          });
          const db = dbs.databases[0];
          if (!db) return undefined;
          const conn = yield* fetchConnection(
            projectId,
            match.id,
            db.name,
            db.owner_name,
          );
          return {
            branchId: match.id,
            branchName: match.name,
            projectId,
            parentBranchId: match.parent_id,
            parentLsn: match.parent_lsn,
            parentTimestamp: match.parent_timestamp,
            initSource: match.init_source as
              | "schema-only"
              | "parent-data"
              | undefined,
            protected: match.protected,
            default: match.default,
            expiresAt: match.expires_at,
            databaseName: db.name,
            roleName: db.owner_name,
            connectionUri: conn.uri,
            pooledConnectionUri: conn.pooled,
            origin: parsePostgresOrigin(conn.uri),
            migrationsDir: olds?.migrationsDir,
            migrationsTable: olds?.migrationsTable,
            migrationsHashes: {},
            importHashes: {},
          };
        }),
        reconcile: Effect.fn(function* ({ id, news, output }) {
          const newName = yield* createBranchName(id, news.name);

          // Ensure — when no prior output exists we create the branch;
          // otherwise sync the mutable scalar fields on the existing
          // branch via updateProjectBranch.
          const branchInfo = output
            ? yield* updateProjectBranch({
                project_id: output.projectId,
                branch_id: output.branchId,
                branch: {
                  name: newName !== output.branchName ? newName : undefined,
                  protected: news.protected,
                  expires_at: news.expiresAt ?? null,
                },
              }).pipe(
                Effect.map((r) => ({
                  branchId: output.branchId,
                  branchName: r.branch.name,
                  projectId: output.projectId,
                  parentBranchId: output.parentBranchId,
                  parentLsn: output.parentLsn,
                  parentTimestamp: output.parentTimestamp,
                  initSource: output.initSource,
                  protected: r.branch.protected,
                  default: output.default,
                  expiresAt: r.branch.expires_at,
                  databaseName: output.databaseName,
                  roleName: output.roleName,
                  connectionUri: output.connectionUri,
                  pooledConnectionUri: output.pooledConnectionUri,
                  origin: output.origin,
                })),
              )
            : yield* Effect.gen(function* () {
                const projectId = resolveProjectId(
                  news.project as BranchSource,
                );
                const parentBranchId = yield* resolveParentBranchId(
                  news.parentBranch as ParentBranchSource | undefined,
                  projectId,
                );
                const created = yield* createProjectBranch({
                  project_id: projectId,
                  branch: {
                    name: newName,
                    parent_id: parentBranchId,
                    parent_lsn: news.parentLsn,
                    parent_timestamp: news.parentTimestamp,
                    init_source: news.initSource,
                    protected: news.protected,
                    expires_at: news.expiresAt,
                  },
                  endpoints: buildEndpoints(news.endpoints),
                });
                yield* waitForOperations(created.operations);

                const db = created.databases[0];
                if (!db) {
                  return yield* Effect.die(
                    `Neon branch ${created.branch.id} created with no databases`,
                  );
                }
                const conn = yield* fetchConnection(
                  projectId,
                  created.branch.id,
                  db.name,
                  db.owner_name,
                );
                return {
                  branchId: created.branch.id,
                  branchName: created.branch.name,
                  projectId: created.branch.project_id,
                  parentBranchId: created.branch.parent_id,
                  parentLsn: created.branch.parent_lsn,
                  parentTimestamp: created.branch.parent_timestamp,
                  initSource: created.branch.init_source as
                    | "schema-only"
                    | "parent-data"
                    | undefined,
                  protected: created.branch.protected,
                  default: created.branch.default,
                  expiresAt: created.branch.expires_at,
                  databaseName: db.name,
                  roleName: db.owner_name,
                  connectionUri: conn.uri,
                  pooledConnectionUri: conn.pooled,
                  origin: parsePostgresOrigin(conn.uri),
                };
              });

          const connectionUri = Redacted.make(branchInfo.connectionUri);
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
            ...branchInfo,
            migrationsDir: news.migrationsDir,
            migrationsTable: news.migrationsDir ? migrationsTable : undefined,
            migrationsHashes,
            importHashes,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* deleteProjectBranch({
            project_id: output.projectId,
            branch_id: output.branchId,
          }).pipe(Effect.catchTag("NotFound", () => Effect.void));
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

const hashMigrations = (migrationsDir: string) =>
  listSqlFiles(migrationsDir).pipe(
    Effect.map((files) => {
      const hashes: Record<string, string> = {};
      for (const file of files) hashes[file.id] = file.hash;
      return hashes;
    }),
  );

const hashImports = (importFiles: ReadonlyArray<string>, rootDir: string) =>
  Effect.gen(function* () {
    const hashes: Record<string, string> = {};
    for (const filePath of importFiles) {
      const file = yield* readSqlFile(rootDir, filePath);
      hashes[filePath] = file.hash;
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
