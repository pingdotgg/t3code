import {
  createProjectBranch,
  createProjectEndpoint,
  deleteProjectEndpoint,
  getProject,
  listProjectBranchEndpoints,
  updateProjectEndpoint,
  deleteProjectBranch,
  getConnectionURI,
  getProjectBranch,
  listProjectBranchDatabases,
  listProjectBranches,
  type ListProjectBranchesResponse,
  listProjects,
  type ListProjectsResponse,
  updateProjectBranch,
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
import { DeletionPending, type Project, waitForOperations } from "./Project.ts";
import type { Providers } from "./Providers.ts";

export type BranchSource = Project | { projectId: string };

export type ParentBranchSource =
  | Branch
  | { branchId: string }
  | { name: string };

export type BranchEndpointConfig = {
  /** Endpoint access mode. A branch has exactly one read-write endpoint. */
  type: "read_only" | "read_write";
  /** Minimum compute units. Removing this setting restores the project default. */
  autoscalingLimitMinCu?: number;
  /** Maximum compute units. Removing this setting restores the project default. */
  autoscalingLimitMaxCu?: number;
  /** Idle timeout in seconds; 0 selects the plan default and -1 disables suspension. */
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
   * Compute endpoints owned by this branch. Exactly one `read_write` endpoint
   * is required for the connection outputs. Settings update in place; removing
   * a setting restores the project default and removing an endpoint deletes it.
   * Do not independently manage endpoints on a branch managed by this resource.
   *
   * @default [{ type: "read_write" }]
   */
  endpoints?: BranchEndpointConfig[];
  /**
   * SQL migrations to apply against the branch. Accepts a directory path, a
   * `Drizzle.Schema` resource, or `{ dir, table? }`.
   *
   * Bookkeeping always lives in Alchemy's `__alchemy_migrations` table. A
   * database previously migrated by drizzle-kit or Prisma is adopted by a
   * one-way conversion on first deploy: the old tool's applied history is
   * copied into Alchemy's table and the old table is left frozen. No
   * baselining required.
   */
  migrations?: MigrationsInput;
  /**
   * Paths to additional `.sql` files to apply after migrations.
   */
  importFiles?: string[];
};

export type Branch = Resource<
  "Neon.Branch",
  BranchProps,
  {
    /** Neon branch identifier. */
    branchId: string;
    /** Observed branch name. */
    branchName: string;
    /** Owning project identifier. */
    projectId: string;
    /** Parent branch identifier, when present. */
    parentBranchId: string | undefined;
    /** Parent log sequence number used for the fork. */
    parentLsn: string | undefined;
    /** Parent timestamp used for the fork. */
    parentTimestamp: string | undefined;
    /** Whether the fork copied data or only schema. */
    initSource: "schema-only" | "parent-data" | undefined;
    /** Whether deletion and mutation protection is enabled. */
    protected: boolean;
    /** Whether this is the project's current default branch. */
    default: boolean;
    /** Automatic expiration timestamp, when configured. */
    expiresAt: string | undefined;
    /** Database selected for connection outputs and migrations. */
    databaseName: string;
    /** Observed owner of the selected database. */
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

/**
 * A branch of a Neon project.
 *
 * Branches are first-class, copy-on-write copies of a parent branch — they
 * share storage with the parent until the new branch starts diverging.
 * ### Branching from a project's default branch
 * **Example:** Basic branch
 * ```typescript
 * const project = yield* Neon.Project("my-project");
 * const dev = yield* Neon.Branch("dev-branch", { project });
 * ```
 *
 * ### Branching from another branch
 * **Example:** Branch off another branch
 * ```typescript
 * const dev = yield* Neon.Branch("dev", { project });
 * const featureBranch = yield* Neon.Branch("feature", {
 *   project,
 *   parentBranch: dev,
 * });
 * ```
 *
 * ### Point-in-time branches
 * **Example:** Branch from a parent at a specific LSN
 * ```typescript
 * const branch = yield* Neon.Branch("at-lsn", {
 *   project,
 *   parentLsn: "0/3FA01B0",
 * });
 * ```
 *
 * ### Migrations on a branch
 * **Example:** Apply migrations on the branch only
 * ```typescript
 * const featureBranch = yield* Neon.Branch("feature", {
 *   project,
 *   migrations: "./migrations",
 * });
 * ```
 *
 * @see https://neon.tech/docs/manage/branches/
 *
 * @resource
 * @product Branch
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
      const replacement = {
        action: "replace",
        deleteFirst:
          news.name !== undefined &&
          news.name === (output?.branchName ?? olds.name) &&
          oldProjectId === newProjectId,
      } as const;
      if (
        olds.parentLsn !== news.parentLsn ||
        olds.parentTimestamp !== news.parentTimestamp ||
        (olds.initSource ?? "parent-data") !==
          (news.initSource ?? "parent-data")
      ) {
        return replacement;
      }
      if (output && news.parentBranch) {
        const parent = yield* resolveParentBranchId(
          news.parentBranch as ParentBranchSource,
          output.projectId,
        );
        // Schema-only branches are roots; the source is a creation input,
        // not an observed parent relationship.
        const previousParent =
          news.initSource === "schema-only"
            ? yield* resolveParentBranchId(
                olds.parentBranch as ParentBranchSource | undefined,
                output.projectId,
              )
            : output.parentBranchId;
        if (parent !== previousParent) return replacement;
      } else if (output && olds.parentBranch && !news.parentBranch) {
        return replacement;
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
      if (output?.branchId) {
        return yield* getProjectBranch({
          project_id: output.projectId,
          branch_id: output.branchId,
        }).pipe(
          Effect.flatMap(({ branch }) =>
            hydrateBranch(output.projectId, branch, output),
          ),
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
      // The whole project may already be gone (out-of-band deletion); the
      // branch is gone with it, so recovery observes an absent branch.
      const matches = yield* findBranchByName(projectId, name).pipe(
        Effect.catchTag("NotFound", () => Effect.succeed([])),
      );
      if (matches.length > 1)
        return yield* new BranchStateError({ reason: "Ambiguous branch name" });
      const match = matches[0];
      if (!match) return undefined;
      const attrs = yield* hydrateBranch(projectId, match);
      return attrs && Unowned(attrs);
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const projectId = yield* resolveProjectId(news.project as BranchSource);
      const newName =
        news.name ??
        output?.branchName ??
        (yield* createBranchName(id, undefined));
      const endpoints = news.endpoints ?? [{ type: "read_write" as const }];
      if (
        endpoints.filter((endpoint) => endpoint.type === "read_write")
          .length !== 1
      ) {
        return yield* new BranchStateError({
          reason:
            "Branch requires exactly one read_write endpoint for its connection outputs",
        });
      }
      // Approval of a cached branch never authorizes a different same-name ID.
      const authorize = (
        branch: ListProjectBranchesResponse["branches"][number],
      ): Effect.Effect<
        ListProjectBranchesResponse["branches"][number],
        OwnedBySomeoneElse
      > =>
        projectId === output?.projectId && branch.id === output.branchId
          ? Effect.succeed(branch)
          : Effect.fail(
              new OwnedBySomeoneElse({
                message: `Neon branch "${newName}" requires explicit adoption`,
                resourceType: "Neon.Branch",
                logicalId: id,
                physicalName: branch.id,
              }),
            );
      let observed =
        output?.branchId && output.projectId === projectId
          ? yield* getProjectBranch({
              project_id: projectId,
              branch_id: output.branchId,
            }).pipe(
              Effect.map(({ branch }) => branch),
              Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
            )
          : undefined;
      if (!observed) {
        const matches = yield* findBranchByName(projectId, newName);
        if (matches.length > 1)
          return yield* new BranchStateError({
            reason: "Ambiguous branch name",
          });
        observed = matches[0] ? yield* authorize(matches[0]) : undefined;
      }
      if (!observed) {
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
          endpoints: buildEndpoints(endpoints),
        }).pipe(
          Effect.catchTag("Conflict", (error) =>
            findBranchByName(projectId, newName).pipe(
              Effect.flatMap(
                Effect.fn(function* (matches) {
                  if (matches.length !== 1) return yield* Effect.fail(error);
                  const branch = yield* authorize(matches[0]!);
                  return { branch, operations: [] };
                }),
              ),
            ),
          ),
        );
        yield* waitForOperations(created.operations);
        observed = created.branch;
      }
      if (
        observed.name !== newName ||
        observed.protected !== (news.protected ?? false) ||
        observed.expires_at !== news.expiresAt
      ) {
        const updated = yield* updateProjectBranch({
          project_id: projectId,
          branch_id: observed.id,
          branch: {
            name: observed.name !== newName ? newName : undefined,
            protected:
              observed.protected !== (news.protected ?? false)
                ? (news.protected ?? false)
                : undefined,
            expires_at:
              observed.expires_at !== news.expiresAt
                ? (news.expiresAt ?? null)
                : undefined,
          },
        });
        yield* waitForOperations(updated.operations);
      }
      yield* syncEndpoints(projectId, observed.id, endpoints);
      const current = yield* getProjectBranch({
        project_id: projectId,
        branch_id: observed.id,
      });
      const branchInfo = yield* hydrateBranch(
        projectId,
        current.branch,
        output?.branchId === observed.id ? output : undefined,
      );
      if (!branchInfo)
        return yield* new BranchStateError({
          reason: "Branch has no database or connection endpoint",
        });
      const previous =
        branchInfo.branchId === output?.branchId ? output : undefined;

      const connectionUri = Redacted.make(branchInfo.connectionUri);
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
        ...branchInfo,
        ...migrationsAttrs({
          input: migrationsInput,
          run: migrations,
          output: previous,
        }),
        importHashes,
      };
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* Effect.gen(function* () {
        const { branch } = yield* getProjectBranch({
          project_id: output.projectId,
          branch_id: output.branchId,
        });
        if (branch.protected) {
          const updated = yield* updateProjectBranch({
            project_id: output.projectId,
            branch_id: output.branchId,
            branch: { protected: false },
          });
          yield* waitForOperations(updated.operations);
        }
        const deleted = yield* deleteProjectBranch({
          project_id: output.projectId,
          branch_id: output.branchId,
        });
        yield* waitForOperations(deleted.operations);
      }).pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* getProjectBranch({
        project_id: output.projectId,
        branch_id: output.branchId,
      }).pipe(
        Effect.flatMap(() =>
          Effect.fail(new DeletionPending({ resourceId: output.branchId })),
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
  const projects: ListProjectsResponse["projects"][number][] = [];
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
    const branches: ListProjectBranchesResponse["branches"][number][] = [];
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
  branch: ListProjectBranchesResponse["branches"][number],
  previous?: Branch["Attributes"],
) =>
  Effect.gen(function* () {
    const dbs = yield* listProjectBranchDatabases({
      project_id: projectId,
      branch_id: branch.id,
    });
    const db =
      dbs.databases.find((db) => db.name === previous?.databaseName) ??
      dbs.databases[0];
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
      initSource:
        branch.init_source === "parent-schema" ||
        branch.init_source === "schema-only"
          ? "schema-only"
          : branch.init_source === "parent-data"
            ? "parent-data"
            : undefined,
      protected: branch.protected,
      default: branch.default,
      expiresAt: branch.expires_at,
      databaseName: db.name,
      roleName: db.owner_name,
      connectionUri: conn.uri,
      pooledConnectionUri: conn.pooled,
      origin: parsePostgresOrigin(conn.uri),
      pooledOrigin: parsePostgresOrigin(conn.pooled),
      migrationsDir: previous?.migrationsDir,
      migrationsTable: previous?.migrationsTable,
      migrationsHashes: previous?.migrationsHashes ?? {},
      importHashes: previous?.importHashes ?? {},
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
    const matches: ListProjectBranchesResponse["branches"][number][] = [];
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
  if (source && "projectId" in source && typeof source.projectId === "string") {
    return source.projectId;
  }
  return undefined;
};

const resolveProjectId = (source: BranchSource) => {
  const projectId = maybeResolveProjectId(source);
  return projectId
    ? Effect.succeed(projectId)
    : Effect.fail(
        new BranchStateError({
          reason:
            "Invalid Neon project source: must be a Project or { projectId }",
        }),
      );
};

const resolveParentBranchId = (
  source: ParentBranchSource | undefined,
  projectId: string,
) =>
  Effect.gen(function* () {
    if (!source) return undefined as string | undefined;
    if ("branchId" in source && typeof source.branchId === "string") {
      if (
        "projectId" in source &&
        typeof source.projectId === "string" &&
        source.projectId !== projectId
      ) {
        return yield* new BranchStateError({
          reason: "Parent branch belongs to another project",
        });
      }
      return source.branchId;
    }
    if ("name" in source && source.name) {
      const matches = yield* findBranchByName(projectId, source.name);
      if (matches.length === 0) {
        return yield* new BranchStateError({
          reason: `Parent branch "${source.name}" not found in project ${projectId}`,
        });
      }
      if (matches.length > 1) {
        return yield* new BranchStateError({
          reason: `Multiple branches with name "${source.name}" in project ${projectId}`,
        });
      }
      return matches[0]!.id;
    }
    return undefined as string | undefined;
  });

export class BranchStateError extends Data.TaggedError("NeonBranchStateError")<{
  reason: string;
}> {}

const syncEndpoints = Effect.fn(function* (
  projectId: string,
  branchId: string,
  desired: BranchEndpointConfig[],
) {
  const { project } = yield* getProject({ project_id: projectId });
  const defaults = project.default_endpoint_settings ?? {};
  const { endpoints } = yield* listProjectBranchEndpoints({
    project_id: projectId,
    branch_id: branchId,
  });
  const remaining = [...endpoints].sort((a, b) => a.id.localeCompare(b.id));
  for (const config of desired) {
    const index = remaining.findIndex(
      (endpoint) => endpoint.type === config.type,
    );
    let observed = index < 0 ? undefined : remaining.splice(index, 1)[0];
    const settings = {
      autoscaling_limit_min_cu:
        config.autoscalingLimitMinCu ??
        defaults.autoscaling_limit_min_cu ??
        0.25,
      autoscaling_limit_max_cu:
        config.autoscalingLimitMaxCu ?? defaults.autoscaling_limit_max_cu ?? 2,
      suspend_timeout_seconds:
        config.suspendTimeoutSeconds ?? defaults.suspend_timeout_seconds ?? 0,
    };
    if (!observed) {
      const created = yield* createProjectEndpoint({
        project_id: projectId,
        endpoint: { branch_id: branchId, type: config.type, ...settings },
      }).pipe(
        Effect.catchTag("Conflict", (error) =>
          listProjectBranchEndpoints({
            project_id: projectId,
            branch_id: branchId,
          }).pipe(
            Effect.flatMap(({ endpoints }) => {
              const matches = endpoints.filter(
                (endpoint) => endpoint.type === "read_write",
              );
              return config.type === "read_write" && matches.length === 1
                ? Effect.succeed({ endpoint: matches[0]!, operations: [] })
                : Effect.fail(error);
            }),
          ),
        ),
      );
      yield* waitForOperations(created.operations);
      observed = created.endpoint;
    }
    if (
      observed.autoscaling_limit_min_cu !== settings.autoscaling_limit_min_cu ||
      observed.autoscaling_limit_max_cu !== settings.autoscaling_limit_max_cu ||
      observed.suspend_timeout_seconds !== settings.suspend_timeout_seconds
    ) {
      const updated = yield* updateProjectEndpoint({
        project_id: projectId,
        endpoint_id: observed.id,
        endpoint: settings,
      });
      yield* waitForOperations(updated.operations);
    }
  }
  for (const endpoint of remaining) {
    yield* deleteProjectEndpoint({
      project_id: projectId,
      endpoint_id: endpoint.id,
    }).pipe(
      Effect.flatMap(({ operations }) => waitForOperations(operations)),
      Effect.catchTag("NotFound", () => Effect.void),
    );
  }
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
