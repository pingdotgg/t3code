import {
  createProjectBranch,
  deleteProjectBranch,
  getConnectionURI,
  getProjectBranch,
  listProjectBranchDatabases,
  listProjectBranches,
  type ListProjectBranchesOutput,
  listProjects,
  type ListProjectsOutput,
  updateProjectBranch,
} from "@distilled.cloud/neon";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { isResolved } from "../Diff.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { listSqlFiles, readSqlFile } from "../SQL/SqlFile.ts";
import { recordsEqual } from "../Util/equal.ts";
import { applyMigrations, runSql } from "./Migrations.ts";
import { parsePostgresOrigin, type PostgresOrigin } from "./PostgresOrigin.ts";
import { type Project, waitForOperations } from "./Project.ts";
import type { Providers } from "./Providers.ts";

const DEFAULT_MIGRATIONS_TABLE = "neon_migrations";

export type BranchSource = Project | { projectId: string };

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
    /**
     * Parsed pooled connection components. Useful as a Hyperdrive `dev`
     * origin when local workers bypass Hyperdrive and connect directly.
     */
    pooledOrigin: PostgresOrigin;
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
 * @resource
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

export const BranchProvider = () =>
  Provider.succeed(Branch, {
    stables: ["branchId", "projectId"],
    diff: Effect.fn(function* ({ id, olds, news, output }) {
      // Normally we short-circuit on `isResolved(news)` at the beginning.
      // However, this wouldn't detect an upstream project change, causing an update when what we really want is a replace.
      // So, we check the project first before short-circuiting. `projectId` is a stable attribute of `Project`, so the
      // planning engine resolves `news.project` to a plain object carrying that stable id (even when the project is being
      // updated in place). An unchanged project therefore resolves to the same string; a changed/replaced project resolves
      // to either a different string or an unresolved output, so `oldProjectId !== newProjectId` evaluates correctly.
      // An Output-valued `project` doesn't survive a `creating`-state
      // round-trip (it deserializes as `undefined`) — when the old project is
      // unknown, fall through to the create/update recovery path rather than
      // force a replacement.
      const oldProjectId =
        output?.projectId ??
        (olds.project !== undefined
          ? maybeResolveProjectId(olds.project as BranchSource)
          : undefined);
      const newProjectId =
        "project" in news
          ? maybeResolveProjectId(news.project as BranchSource)
          : undefined;
      if (oldProjectId !== undefined && oldProjectId !== newProjectId) {
        return { action: "replace" } as const;
      }
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
      const oldName =
        output?.branchName ?? (yield* createBranchName(id, olds.name));
      // Auto-generated names are engine-owned: the deployed name stays
      // authoritative even if the generator would name this id differently
      // today. Only an explicit user-provided name can force a rename.
      const newName = news.name ?? oldName;
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
        const newHashes = yield* hashImports(news.importFiles, yield* rootDir);
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
            pooledOrigin:
              output.pooledOrigin ??
              parsePostgresOrigin(output.pooledConnectionUri),
          })),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      }
      if (!olds?.project) return undefined;
      const projectId = maybeResolveProjectId(olds.project as BranchSource);
      if (projectId === undefined) {
        // The project reference survived as an object but its Output-valued
        // `projectId` did not — there is nothing to look the branch up in.
        return undefined;
      }
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
        pooledOrigin: parsePostgresOrigin(conn.pooled),
        migrationsDir: olds?.migrationsDir,
        migrationsTable: olds?.migrationsTable,
        migrationsHashes: {},
        importHashes: {},
      };
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      // Prefer the deployed name: regenerating would target a different
      // resource if the generator's output for this id ever drifts. An
      // explicit `news.name` still renames the branch in place.
      const newName =
        news.name ??
        output?.branchName ??
        (yield* createBranchName(id, news.name));

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
              pooledOrigin:
                output.pooledOrigin ??
                parsePostgresOrigin(output.pooledConnectionUri),
            })),
          )
        : yield* Effect.gen(function* () {
            const projectId = resolveProjectId(news.project as BranchSource);
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
              pooledOrigin: parsePostgresOrigin(conn.pooled),
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
            yield* rootDir,
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
    // Parent fan-out: branches are scoped to a project, and there is no
    // account-wide branch enumeration API. Enumerate every project, then
    // list+hydrate the branches of each (bounded concurrency), producing
    // the exact `read` Attributes shape for each branch.
    list: Effect.fn(function* () {
      const projects = yield* listAllProjects;
      const perProject = yield* Effect.forEach(
        projects,
        (project) =>
          Effect.gen(function* () {
            const branches = yield* listAllBranches(project.id);
            return yield* Effect.forEach(
              branches,
              (branch) => hydrateBranch(project.id, branch),
              { concurrency: 10 },
            );
          }).pipe(
            // The project may be deleted between enumeration and listing.
            Effect.catchTag("NotFound", () => Effect.succeed([])),
          ),
        { concurrency: 10 },
      );
      return perProject
        .flat()
        .filter((row): row is Branch["Attributes"] => row !== undefined);
    }),
  });

const listAllProjects = Effect.gen(function* () {
  const projects: ListProjectsOutput["projects"][number][] = [];
  let cursor: string | undefined;
  while (true) {
    const page = yield* listProjects(cursor !== undefined ? { cursor } : {});
    projects.push(...page.projects);
    const nextCursor = page.pagination?.cursor;
    // Neon returns a `pagination.cursor` on every response (the `created_at`
    // of the last row), not a "has next page" flag — stop once a page comes
    // back empty or the cursor stops advancing to avoid an infinite loop.
    if (
      page.projects.length === 0 ||
      nextCursor === undefined ||
      nextCursor === cursor
    ) {
      break;
    }
    cursor = nextCursor;
  }
  return projects;
});

const listAllBranches = (projectId: string) =>
  Effect.gen(function* () {
    const branches: ListProjectBranchesOutput["branches"][number][] = [];
    let cursor: string | undefined;
    do {
      const page = yield* listProjectBranches({
        project_id: projectId,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      branches.push(...page.branches);
      cursor = page.pagination?.next;
    } while (cursor);
    return branches;
  });

const hydrateBranch = (
  projectId: string,
  branch: ListProjectBranchesOutput["branches"][number],
) =>
  Effect.gen(function* () {
    const dbs = yield* listProjectBranchDatabases({
      project_id: projectId,
      branch_id: branch.id,
    });
    const db = dbs.databases[0];
    if (!db) return undefined;
    const conn = yield* fetchConnection(
      projectId,
      branch.id,
      db.name,
      db.owner_name,
    );
    const attributes: Branch["Attributes"] = {
      branchId: branch.id,
      branchName: branch.name,
      projectId,
      parentBranchId: branch.parent_id,
      parentLsn: branch.parent_lsn,
      parentTimestamp: branch.parent_timestamp,
      initSource: branch.init_source as
        | "schema-only"
        | "parent-data"
        | undefined,
      protected: branch.protected,
      default: branch.default,
      expiresAt: branch.expires_at,
      databaseName: db.name,
      roleName: db.owner_name,
      connectionUri: conn.uri,
      pooledConnectionUri: conn.pooled,
      origin: parsePostgresOrigin(conn.uri),
      pooledOrigin: parsePostgresOrigin(conn.pooled),
      migrationsDir: undefined,
      migrationsTable: undefined,
      migrationsHashes: {},
      importHashes: {},
    };
    return attributes;
  }).pipe(
    // A branch/database/endpoint can disappear mid-enumeration — skip it.
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

const rootDir = Effect.sync(() => process.cwd());
const createBranchName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return name ?? (yield* createPhysicalName({ id }));
  });

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

const maybeResolveProjectId = (source: BranchSource): string | undefined => {
  if (source && "projectId" in source && source.projectId) {
    return source.projectId as unknown as string;
  }
  return undefined;
};

const resolveProjectId = (source: BranchSource): string => {
  const projectId = maybeResolveProjectId(source);
  if (projectId) return projectId;
  throw new Error(
    "Invalid Neon project source: must be a Project or { projectId }",
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
