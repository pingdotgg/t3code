import {
  deleteProject,
  getConnectionURI,
  getProject,
  getProjectOperation,
  listProjectBranchDatabases,
  listProjectBranches,
  listProjects,
  type ListProjectsResponse,
  type Project as NeonProject,
  createProject as sdkCreateProject,
  updateProject,
} from "@distilled.cloud/neon";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { OwnedBySomeoneElse, Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import {
  diffMigrations,
  migrationsAttrs,
  migrationsInputOf,
  stampedOf,
  type MigrationsInput,
} from "../SQL/Migrations/index.ts";
import { hashImports, readSqlFile } from "../SQL/SqlFile.ts";
import { recordsEqual } from "../Util/equal.ts";
import { runPgMigrations, runSql } from "./Migrations.ts";
import { parsePostgresOrigin, type PostgresOrigin } from "./PostgresOrigin.ts";
import type { Providers } from "./Providers.ts";

const DEFAULT_REGION: NeonRegion = "aws-us-east-1";
const DEFAULT_PG_VERSION: NeonPgVersion = 17;

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

export type ProjectProps = {
  /**
   * Mutable project name. If omitted at creation, a unique name is generated
   * from `${app}-${stage}-${id}`. Omitting it later preserves the deployed name.
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
   * `neondb_owner` on creation; omission preserves the observed role on adoption
   * and updates. An explicit change replaces the project.
   */
  roleName?: string;
  /**
   * Name of the default database created with the project. Defaults to
   * `neondb` on creation; omission preserves the observed database on adoption
   * and updates. An explicit change replaces the project.
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
   * SQL migrations to apply against the default branch's primary database.
   * Accepts a directory path, a `Drizzle.Schema` resource, or
   * `{ dir, table? }`.
   *
   * Bookkeeping always lives in Alchemy's `__alchemy_migrations` table. A
   * database previously migrated by drizzle-kit or Prisma is adopted by a
   * one-way conversion on first deploy: the old tool's applied history is
   * copied into Alchemy's table and the old table is left frozen. No
   * baselining required.
   */
  migrations?: MigrationsInput;
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
    /** Neon project identifier. */
    projectId: string;
    /** Observed project name. */
    projectName: string;
    /** Immutable Postgres region. */
    region: NeonRegion;
    /** Immutable Postgres major version. */
    pgVersion: NeonPgVersion;
    /** Current default branch identifier. */
    defaultBranchId: string;
    /** Current default branch name. */
    defaultBranchName: string;
    /** Database selected for connection outputs and migrations. */
    databaseName: string;
    /** Observed owner of the selected database. */
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
    /**
     * Parsed pooled connection components. Useful as a Hyperdrive `dev`
     * origin when local workers bypass Hyperdrive and connect directly.
     */
    pooledOrigin: PostgresOrigin;
    /** Observed history retention window in seconds. */
    historyRetentionSeconds: number;
    /** Whether logical replication is enabled. Once enabled it cannot be disabled. */
    enableLogicalReplication: boolean;
    /** Directory of the applied SQL migrations. */
    migrationsDir: string | undefined;
    /** Migration bookkeeping table. */
    migrationsTable: string | undefined;
    /** Applied migration content hashes. */
    migrationsHashes: Record<string, string>;
    /** Applied SQL import content hashes. */
    importHashes: Record<string, string>;
  },
  never,
  Providers
>;

type ProjectAttributes = Project["Attributes"];

/**
 * A Neon serverless Postgres project.
 *
 * Creating a project also provisions the project's default branch (named
 * "main" by default), an initial role, an initial database, and a
 * read-write compute endpoint, exposed as `connectionUri`.
 * ### Creating a Project
 * **Example:** Basic project
 * ```typescript
 * const project = yield* Neon.Project("my-project");
 * ```
 *
 * **Example:** Project with explicit region and PG version
 * ```typescript
 * const project = yield* Neon.Project("my-project", {
 *   region: "aws-eu-central-1",
 *   pgVersion: 17,
 * });
 * ```
 *
 * **Example:** Project with logical replication enabled
 * ```typescript
 * const project = yield* Neon.Project("my-project", {
 *   enableLogicalReplication: true,
 * });
 * ```
 *
 * ### Migrations and seed data
 * **Example:** Apply migrations and seed files
 * ```typescript
 * const project = yield* Neon.Project("my-project", {
 *   migrations: "./migrations",
 *   importFiles: ["./seed/users.sql"],
 * });
 * ```
 *
 * ### Branching
 * **Example:** Create a branch off the project's default branch
 * ```typescript
 * const project = yield* Neon.Project("my-project");
 * const dev = yield* Neon.Branch("dev-branch", { project });
 * ```
 *
 * @see https://neon.tech/docs/manage/projects/
 *
 * @resource
 * @product Project
 */
export const Project = Resource<Project>("Neon.Project");

export const ProjectProvider = () =>
  Provider.succeed(Project, {
    stables: ["projectId", "defaultBranchId"],
    list: Effect.fn(function* () {
      // Account-scoped collection: enumerate every project via the Neon
      // projects list API, then hydrate each into the exact `read`
      // Attributes shape with bounded concurrency.
      const projects = yield* listAllProjects;
      const rows = yield* Effect.forEach(
        projects,
        (project) =>
          hydrateProjectAttributes(project).pipe(
            // A project can be deleted between the list call and
            // hydration — skip it rather than fail the whole enumeration.
            Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          ),
        { concurrency: 10 },
      );
      return rows.filter((row): row is ProjectAttributes => row !== undefined);
    }),
    diff: Effect.fn(function* ({ id, olds = {}, news = {}, output }) {
      if (!isResolved(news)) return undefined;
      const oldName =
        output?.projectName ?? (yield* createProjectName(id, olds.name));
      // Preserve generated names; only an explicit name requests a rename.
      const name = news.name ?? oldName;
      if (
        (news.region ?? output?.region ?? DEFAULT_REGION) !==
          (output?.region ?? olds.region ?? DEFAULT_REGION) ||
        (news.pgVersion ?? output?.pgVersion ?? DEFAULT_PG_VERSION) !==
          (output?.pgVersion ?? olds.pgVersion ?? DEFAULT_PG_VERSION) ||
        (news.defaultBranchName ?? output?.defaultBranchName) !==
          output?.defaultBranchName ||
        (news.databaseName ?? output?.databaseName ?? "neondb") !==
          (output?.databaseName ?? olds.databaseName ?? "neondb") ||
        (news.roleName ?? output?.roleName ?? "neondb_owner") !==
          (output?.roleName ?? olds.roleName ?? "neondb_owner") ||
        news.orgId !== olds.orgId
      ) {
        return {
          action: "replace",
          deleteFirst: news.name === oldName && news.orgId === olds.orgId,
        } as const;
      }
      if (
        oldName !== name ||
        (news.historyRetentionSeconds ?? 86400) !==
          (output?.historyRetentionSeconds ?? 86400)
      ) {
        return { action: "update" } as const;
      }
      if (
        news.enableLogicalReplication !== undefined &&
        news.enableLogicalReplication !==
          (output?.enableLogicalReplication ?? false)
      ) {
        return { action: "update" } as const;
      }
      if (yield* diffMigrations({ news, output })) {
        return { action: "update" } as const;
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
      if (output?.projectId) {
        return yield* getProject({ project_id: output.projectId }).pipe(
          Effect.flatMap(({ project }) =>
            hydrateProjectAttributes(project, output),
          ),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      }
      const name = yield* createProjectName(id, olds?.name);
      const matches = yield* findProjectByName(name, olds?.orgId);
      if (matches.length > 1) {
        return yield* new ProjectStateError({
          reason: "Ambiguous project name",
        });
      }
      const match = matches[0];
      if (!match) return undefined;
      const attrs = yield* hydrateProjectAttributes(match, {
        defaultBranchName: olds?.defaultBranchName,
        migrationsDir: (olds && migrationsInputOf(olds))?.dir,
        migrationsTable: (olds && migrationsInputOf(olds))?.table,
      });
      return attrs && Unowned(attrs);
    }),
    reconcile: Effect.fn(function* ({ id, news = {}, output }) {
      const name =
        news.name ??
        output?.projectName ??
        (yield* createProjectName(id, undefined));
      // Names are not ownership evidence; approval applies only to the observed ID.
      const authorize = (
        project: ObservedProject,
      ): Effect.Effect<ObservedProject, OwnedBySomeoneElse> =>
        project.id === output?.projectId
          ? Effect.succeed(project)
          : Effect.fail(
              new OwnedBySomeoneElse({
                message: `Neon project "${name}" requires explicit adoption`,
                resourceType: "Neon.Project",
                logicalId: id,
                physicalName: project.id,
              }),
            );
      let observed: ObservedProject | undefined = output?.projectId
        ? yield* getProject({ project_id: output.projectId }).pipe(
            Effect.map(({ project }) => project),
            Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          )
        : undefined;
      if (!observed) {
        const matches = yield* findProjectByName(name, news.orgId);
        if (matches.length > 1) {
          return yield* new ProjectStateError({
            reason: "Ambiguous project name",
          });
        }
        observed = matches[0] ? yield* authorize(matches[0]) : undefined;
      }
      if (!observed) {
        const created = yield* sdkCreateProject({
          project: {
            name,
            region_id: news.region ?? DEFAULT_REGION,
            pg_version: news.pgVersion ?? DEFAULT_PG_VERSION,
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
        }).pipe(
          Effect.catchTag("Conflict", (error) =>
            findProjectByName(name, news.orgId).pipe(
              Effect.flatMap(
                Effect.fn(function* (matches) {
                  if (matches.length !== 1) return yield* Effect.fail(error);
                  const project = yield* authorize(matches[0]!);
                  return { project, operations: [] };
                }),
              ),
            ),
          ),
        );
        yield* waitForOperations(created.operations);
        observed = created.project;
      }
      const replication =
        observed.settings?.enable_logical_replication === true;
      if (replication && news.enableLogicalReplication === false) {
        return yield* new ProjectStateError({
          reason: "Neon logical replication cannot be disabled once enabled",
        });
      }
      const retention = news.historyRetentionSeconds ?? 86400;
      if (
        observed.name !== name ||
        observed.history_retention_seconds !== retention ||
        (news.enableLogicalReplication === true && !replication)
      ) {
        const updated = yield* updateProject({
          project_id: observed.id,
          project: {
            name: observed.name !== name ? name : undefined,
            history_retention_seconds:
              observed.history_retention_seconds !== retention
                ? retention
                : undefined,
            settings:
              news.enableLogicalReplication === true && !replication
                ? { enable_logical_replication: true }
                : undefined,
          },
        });
        yield* waitForOperations(updated.operations);
      }
      const current = yield* getProject({ project_id: observed.id });
      const projectInfo = yield* hydrateProjectAttributes(current.project, {
        defaultBranchName: news.defaultBranchName,
        databaseName:
          news.databaseName ??
          (output?.projectId === observed.id ? output.databaseName : undefined),
      });
      if (!projectInfo) {
        return yield* new ProjectStateError({
          reason: "Project has no default branch or database",
        });
      }
      const previous =
        projectInfo.projectId === output?.projectId ? output : undefined;

      const connectionUri = Redacted.make(projectInfo.connectionUri);
      const migrationsInput = migrationsInputOf(news);
      const migrations = migrationsInput
        ? yield* runPgMigrations({
            connectionUri,
            input: migrationsInput,
            stamped: stampedOf(previous),
          })
        : undefined;
      const importHashes = news.importFiles?.length
        ? yield* runImports(
            connectionUri,
            news.importFiles,
            yield* rootDir,
            previous?.importHashes ?? {},
          )
        : {};

      return {
        ...projectInfo,
        ...migrationsAttrs({
          input: migrationsInput,
          run: migrations,
          output: previous,
        }),
        importHashes,
      };
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* deleteProject({ project_id: output.projectId }).pipe(
        Effect.catchTag("NotFound", () => Effect.void),
      );
      yield* getProject({ project_id: output.projectId }).pipe(
        Effect.flatMap(() =>
          Effect.fail(new DeletionPending({ resourceId: output.projectId })),
        ),
        Effect.catchTag("NotFound", () => Effect.void),
        Effect.retry({
          while: (error) => error._tag === "NeonDeletionPending",
          schedule: Schedule.spaced("2 seconds"),
          times: 8,
        }),
        Effect.timeout("20 seconds"),
      );
    }),
  });

const rootDir = Effect.sync(process.cwd);

const createProjectName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return name ?? (yield* createPhysicalName({ id }));
  });

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

export class ProjectStateError extends Data.TaggedError(
  "NeonProjectStateError",
)<{
  reason: string;
}> {}

export class DeletionPending extends Data.TaggedError("NeonDeletionPending")<{
  resourceId: string;
}> {}

export class OperationFailed extends Data.TaggedError("NeonOperationFailed")<{
  operationId: string;
  action: string;
  status: string;
}> {}

export class OperationPending extends Data.TaggedError("NeonOperationPending")<{
  operationId: string;
  status: string;
}> {}

type PendingOperation = {
  readonly id: string;
  readonly project_id: string;
  readonly action: string;
  readonly status: string;
};

const checkOperation = (
  op: PendingOperation,
): Effect.Effect<void, OperationFailed | OperationPending> => {
  if (op.status === "finished" || op.status === "skipped") return Effect.void;
  if (
    op.status === "failed" ||
    op.status === "error" ||
    op.status === "cancelled"
  ) {
    return Effect.fail(
      new OperationFailed({
        operationId: op.id,
        action: op.action,
        status: op.status,
      }),
    );
  }
  return Effect.fail(
    new OperationPending({ operationId: op.id, status: op.status }),
  );
};

/** Wait at most 55 seconds; pending, cancelled and failed operations never succeed. */
export const waitForOperations = (
  operations: ReadonlyArray<PendingOperation>,
) =>
  Effect.forEach(
    operations,
    (op) =>
      checkOperation(op).pipe(
        Effect.catchTag("NeonOperationPending", () =>
          getProjectOperation({
            project_id: op.project_id,
            operation_id: op.id,
          }).pipe(
            Effect.flatMap(({ operation }) => checkOperation(operation)),
            Effect.retry({
              while: (error) => error._tag === "NeonOperationPending",
              schedule: Schedule.spaced("5 seconds"),
              times: 8,
            }),
          ),
        ),
      ),
    { concurrency: 10, discard: true },
  ).pipe(Effect.timeout("55 seconds"));

const findProjectByName = (name: string, orgId?: string) =>
  Effect.gen(function* () {
    const matches: ListProjectsResponse["projects"][number][] = [];
    let cursor: string | undefined;
    while (true) {
      const page = yield* listProjects({
        search: name,
        ...(orgId !== undefined ? { org_id: orgId } : {}),
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

/**
 * Exhaustively enumerate every project in the account. Uses the same
 * cursor-stop heuristic as {@link findProjectByName} because Neon returns a
 * `pagination.cursor` on every page (it's the last row's `created_at`, not a
 * "has next page" flag), so we'd otherwise loop forever re-fetching.
 */
const listAllProjects = Effect.gen(function* () {
  const projects: ListProjectsResponse["projects"][number][] = [];
  let cursor: string | undefined;
  while (true) {
    const page = yield* listProjects(cursor !== undefined ? { cursor } : {});
    projects.push(...page.projects);
    const nextCursor = page.pagination?.cursor;
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

type ObservedProject = NeonProject | ListProjectsResponse["projects"][number];

/**
 * Hydrate a project summary (from the list API) into the exact `read`
 * Attributes shape — resolving the default branch, its primary database, and
 * the direct + pooled connection URIs. Returns `undefined` when the project
 * has no branch or database yet (mirrors `read`).
 */
const hydrateProjectAttributes = (
  project: ObservedProject,
  opts: {
    defaultBranchName?: string;
    databaseName?: string;
    migrationsDir?: string;
    migrationsTable?: string;
    migrationsHashes?: Record<string, string>;
    importHashes?: Record<string, string>;
  } = {},
) =>
  Effect.gen(function* () {
    const branches: import("@distilled.cloud/neon").Branch[] = [];
    let cursor: string | undefined;
    do {
      const page = yield* listProjectBranches({
        project_id: project.id,
        cursor,
      });
      branches.push(...page.branches);
      const next = page.pagination?.next;
      if (!next || next === cursor || page.branches.length === 0) break;
      cursor = next;
    } while (cursor);
    const defaultBranch = branches.find((b) => b.default);
    if (!defaultBranch) return undefined;
    const databases = yield* listProjectBranchDatabases({
      project_id: project.id,
      branch_id: defaultBranch.id,
    });
    const db = opts.databaseName
      ? databases.databases.find((db) => db.name === opts.databaseName)
      : databases.databases[0];
    if (!db) return undefined;
    const conn = yield* resolveConnection(
      project.id,
      defaultBranch.id,
      db.name,
      db.owner_name,
    );
    return {
      projectId: project.id,
      projectName: project.name,
      region: project.region_id as NeonRegion,
      pgVersion: project.pg_version as NeonPgVersion,
      defaultBranchId: defaultBranch.id,
      defaultBranchName: defaultBranch.name,
      databaseName: db.name,
      roleName: db.owner_name,
      connectionUri: conn.uri,
      pooledConnectionUri: conn.pooled,
      origin: parsePostgresOrigin(conn.uri),
      pooledOrigin: parsePostgresOrigin(conn.pooled),
      historyRetentionSeconds: project.history_retention_seconds ?? 86400,
      enableLogicalReplication:
        project.settings?.enable_logical_replication === true,
      migrationsDir: opts.migrationsDir,
      migrationsTable: opts.migrationsTable,
      migrationsHashes: opts.migrationsHashes ?? {},
      importHashes: opts.importHashes ?? {},
    } satisfies ProjectAttributes;
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
