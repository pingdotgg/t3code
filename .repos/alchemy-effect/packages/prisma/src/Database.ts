import { Retry } from "@distilled.cloud/prisma";
import {
  type GetDatabasesResponse,
  type GetProjectBranchesResponse,
  type GetProjectDatabasesResponse,
  deleteDatabase,
  getDatabases,
  getDatabase,
  getProject,
  getProjectBranches,
  getProjectDatabases,
  updateDatabase,
  createDatabase,
} from "@distilled.cloud/prisma/management";
import { Unowned } from "alchemy/AdoptPolicy";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as ProviderLayer from "alchemy/Local/ProviderLayer";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as Path from "effect/Path";
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import type { Scope } from "effect/Scope";
import { extractConnectionSecrets } from "./Client.ts";
import { desiredBranchId } from "./internal/Branches.ts";
import {
  hasCanonicalConnectionSecrets,
  mergeConnectionSecrets,
  recoverDatabaseConnectionSecrets,
} from "./internal/DatabaseSecrets.ts";
import { DEV_TIMESTAMP, attrOrString, devId } from "./internal/DevStub.ts";
import {
  type ObservedProjectDatabase,
  type ObservedSource,
  narrowDatabaseSource,
} from "./internal/Observed.ts";
import { PrismaPaginationError } from "./internal/Pagination.ts";
import { closePrismaDevDatabase, ensurePrismaDevDatabase } from "./internal/PrismaDevDatabase.ts";
import {
  concreteIdsChanged,
  isInputObject,
  isPrismaDevId,
  resolveProjectId,
  unresolvedProjectIdOf,
} from "./internal/Refs.ts";
import type { Project } from "./Project.ts";
import type { Providers } from "./Providers.ts";
import type {
  DatabaseSourceInput,
  PrismaDatabaseRegionId,
  PrismaRegionId,
  PrismaSecretConnection,
} from "./Types.ts";

export class DatabaseConflict extends Data.TaggedError("DatabaseConflict")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class DatabaseInvalidProps extends Data.TaggedError("DatabaseInvalidProps")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class DatabaseOperationFailed extends Data.TaggedError("DatabaseOperationFailed")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface DatabaseDev {
  /**
   * Local provider used by `alchemy dev`.
   *
   * @default "@prisma/dev"
   */
  provider?: "@prisma/dev";
  /**
   * Stable local server name.
   */
  name?: string;
  /**
   * Local storage mode for the database server.
   *
   * @default "stateful"
   */
  persistenceMode?: "stateless" | "stateful";
  /**
   * HTTP control port for the local server.
   */
  port?: number;
  /**
   * Direct Postgres port for the local database.
   */
  databasePort?: number;
  /**
   * Direct Postgres port for the local shadow database.
   */
  shadowDatabasePort?: number;
  /**
   * Enable local provider debug logging.
   *
   * @default false
   */
  debug?: boolean;
  /**
   * Connection timeout in milliseconds for pending database clients.
   */
  databaseConnectTimeoutMillis?: number;
  /**
   * Idle timeout in milliseconds for active database clients.
   */
  databaseIdleTimeoutMillis?: number;
  /**
   * Connection timeout in milliseconds for pending shadow database clients.
   */
  shadowDatabaseConnectTimeoutMillis?: number;
  /**
   * Idle timeout in milliseconds for active shadow database clients.
   */
  shadowDatabaseIdleTimeoutMillis?: number;
  /**
   * Optional shell command to run after the local database is ready.
   */
  migrate?: string;
  /**
   * Working directory for the migration command.
   */
  migrateCwd?: string;
  /**
   * Maximum time to wait for the migration command before terminating it.
   * Must be a positive finite number.
   *
   * @default 900
   */
  migrateTimeoutSeconds?: number;
}

export interface DatabaseProps {
  /**
   * Project ID or `project.projectId` output that owns this database.
   */
  project: string | Project;
  /**
   * Database display name. If omitted, Alchemy generates a stable physical
   * name so interrupted creates can be recovered without duplicating a
   * database. Explicit names cannot be combined with branch attachment during
   * initial creation because the Management API creates the database before it
   * attaches the branch and exposes no idempotency key.
   */
  name?: string;
  /**
   * Region for the database. `"inherit"` uses the project's default region,
   * or the default database's region when the project has none.
   *
   * @default "us-east-1"
   */
  region?: PrismaDatabaseRegionId;
  /**
   * Standalone Prisma.Database resources cannot be the project's default
   * database because the Management API cannot demote or promote an existing
   * database, making the resource impossible to destroy safely. Use
   * Prisma.Project to manage the project-owned default database.
   *
   * @default false
   */
  isDefault?: false;
  /**
   * Optional source database/backup descriptor for clone or restore creation.
   */
  source?: DatabaseSourceInput;
  /**
   * Branch ID to attach the database to. Mutually exclusive with
   * branchGitName. Every Prisma database belongs to a Branch: omit both
   * fields to let the Management API attach it to the project's default
   * Branch, which Alchemy then leaves unmanaged.
   */
  branchId?: string;
  /**
   * Branch git name to attach the database to (the Branch is created when it
   * does not exist). Mutually exclusive with branchId. Omit both fields to
   * attach to the project's default Branch.
   */
  branchGitName?: string;
  /**
   * Stable identity of this declaration on the Prisma platform, unique per
   * branch. A rename in the Console does not change it. After lost state, the
   * provider finds the database by it instead of creating a second one, and
   * `--adopt` (or `adopt(true)`) takes it back over, because a logical ID alone
   * does not prove which stack owns it. Changing it updates the database in place.
   * @default the resource's fully qualified logical ID, e.g. `"db"` or `"App/Db"`
   */
  logicalId?: string;
  /**
   * Local database settings for `alchemy dev`. Set to `false` to keep only
   * placeholder IDs.
   */
  dev?: false | DatabaseDev;
  /**
   * Rotate the adopted database's default connection to recover its one-time
   * credentials. Prisma revokes the previous key on a best-effort basis and
   * rotation may interrupt existing consumers, so adoption leaves credentials
   * unset unless explicitly opted in.
   *
   * @default false
   */
  rotateCredentialsOnAdopt?: boolean;
}

export interface Database extends Resource<
  "Prisma.Database",
  DatabaseProps,
  {
    /**
     * Prisma database ID.
     */
    databaseId: string;
    /**
     * Prisma database display name.
     */
    databaseName: string;
    /**
     * Project ID that owns the database.
     */
    projectId: string;
    /**
     * Current Prisma database status.
     */
    status: string;
    /**
     * Prisma Postgres region ID, when available.
     */
    region: string | null;
    /**
     * Whether this is the project's default database.
     */
    isDefault: boolean;
    /**
     * Branch ID attached to the database, or null when unassigned.
     */
    branchId: string | null;
    /**
     * Default connection ID for the database.
     */
    defaultConnectionId: string | null;
    /**
     * ISO timestamp when the database was created.
     */
    createdAt: string;
    /**
     * Direct Postgres connection string, redacted in state.
     */
    directConnectionString: Redacted.Redacted<string> | undefined;
    /**
     * Pooled Postgres connection string, redacted in state.
     */
    pooledConnectionString: Redacted.Redacted<string> | undefined;
    /**
     * Accelerate connection string, redacted in state.
     */
    accelerateConnectionString: Redacted.Redacted<string> | undefined;
    /**
     * Direct database host, when returned by Prisma.
     */
    host: string | null | undefined;
    /**
     * Direct database username, when returned by Prisma.
     */
    user: string | null | undefined;
    /**
     * Direct database password, redacted in state.
     */
    password: Redacted.Redacted<string> | undefined;
    /**
     * Logical ID recorded on the database, or null when none is set.
     */
    logicalId: string | null;
  },
  never,
  Providers
> {}

/**
 * A Prisma Postgres database inside a Prisma project.
 *
 * Standalone `Prisma.Database` resources cannot be the project's default
 * database. Use `Prisma.Project` when the project should own a default
 * database. Project, region, and source changes require replacement; display
 * name and branch attachment can converge in place. Destroying this resource
 * deletes its database and data.
 *
 * ### Creating a Database
 * **Example:** Database in a project
 * ```typescript
 * const project = yield* Prisma.Project("app", { createDatabase: false });
 * const database = yield* Prisma.Database("db", {
 *   project,
 *   region: "us-east-1",
 * });
 * ```
 *
 * **Example:** Database attached to a preview branch
 * ```typescript
 * const database = yield* Prisma.Database("preview-db", {
 *   project,
 *   branchId: preview.branchId,
 * });
 * ```
 *
 * @resource
 * @product Postgres
 */
export const Database = Resource<Database>("Prisma.Database");

const createName = (id: string, name: string | undefined) =>
  name === undefined ? createPhysicalName({ id }) : Effect.succeed(name);

// Distilled emits the cursor-paginated list operations as plain ops, so
// callers walk `pagination` themselves (see `src/Neon/Project.ts`).
const listProjectDatabases = (projectId: string) =>
  Effect.gen(function* () {
    const databases: GetProjectDatabasesResponse["data"][number][] = [];
    let cursor: string | undefined;
    while (true) {
      const page = yield* getProjectDatabases(
        cursor === undefined ? { projectId, limit: 100 } : { projectId, limit: 100, cursor },
      );
      databases.push(...page.data);
      const nextCursor = page.pagination.nextCursor;
      if (!page.pagination.hasMore) break;
      if (nextCursor === null) {
        return yield* new PrismaPaginationError({
          message:
            "Invalid Prisma Management API pagination response from getProjectDatabases: hasMore was true without a non-empty nextCursor",
        });
      }
      cursor = nextCursor;
    }
    return databases;
  });

const listAllDatabases = (
  filter: { projectId?: string; logicalId?: string; branchId?: string } = {},
) =>
  Effect.gen(function* () {
    const databases: GetDatabasesResponse["data"][number][] = [];
    let cursor: string | undefined;
    while (true) {
      const page = yield* getDatabases(cursor === undefined ? filter : { ...filter, cursor });
      databases.push(...page.data);
      const nextCursor = page.pagination.nextCursor;
      if (!page.pagination.hasMore) break;
      if (nextCursor === null) {
        return yield* new PrismaPaginationError({
          message:
            "Invalid Prisma Management API pagination response from getDatabases: hasMore was true without a non-empty nextCursor",
        });
      }
      cursor = nextCursor;
    }
    return databases;
  });

const findDatabaseByName = (projectId: string, name: string) =>
  listProjectDatabases(projectId).pipe(
    Effect.flatMap((databases) => {
      const matches = databases.filter((database) => database.name === name);
      return matches.length > 1
        ? Effect.fail(
            new DatabaseConflict({
              message: `Prisma project '${projectId}' has multiple databases named '${name}'; refusing to select one arbitrarily.`,
            }),
          )
        : Effect.succeed(matches[0]);
    }),
  );

const findDatabaseByLogicalId = Effect.fn(function* (
  projectId: string,
  logicalId: string,
  props: { branchId?: string; branchGitName?: string },
) {
  const branch = yield* desiredBranchId(projectId, props);
  if (!branch.resolved) return undefined;
  const databases = yield* listAllDatabases({
    projectId,
    logicalId,
    branchId: branch.id,
  });
  return databases.find(
    (database) => database.logicalId === logicalId && database.branchId === branch.id,
  );
});

const logicalIdTaken = (
  logicalId: string,
  branchId: string | null,
  projectId: string,
  cause: unknown,
) =>
  new Error(
    `Prisma database logical ID '${logicalId}' is already used by another database on branch '${branchId}' in project '${projectId}'. Logical IDs are unique per branch; choose a different logicalId or remove it from the other database.`,
    { cause },
  );

class GeneratedDatabaseNotVisible extends Data.TaggedError("GeneratedDatabaseNotVisible")<{
  readonly message: string;
}> {}

const generatedDatabaseRecoverySchedule = Schedule.max([
  Schedule.exponential("250 millis"),
  Schedule.recurs(6),
]);

const recoverGeneratedDatabaseAfterConflict = (projectId: string, name: string) =>
  findDatabaseByName(projectId, name).pipe(
    Effect.flatMap((database) =>
      database
        ? Effect.succeed(database)
        : Effect.fail(
            new GeneratedDatabaseNotVisible({
              message: `Generated Prisma database '${name}' already exists but is not visible yet.`,
            }),
          ),
    ),
    Effect.retry({
      while: (error) => error instanceof GeneratedDatabaseNotVisible,
      schedule: generatedDatabaseRecoverySchedule,
    }),
  );

const findDefaultDatabase = (projectId: string) =>
  listProjectDatabases(projectId).pipe(
    Effect.flatMap((databases) => {
      const matches = databases.filter((database) => database.isDefault);
      return matches.length > 1
        ? Effect.fail(
            new DatabaseConflict({
              message: `Prisma project '${projectId}' has multiple default databases; refusing to select one arbitrarily.`,
            }),
          )
        : Effect.succeed(matches[0]);
    }),
  );

const resolveDatabaseRegion = Effect.fn(function* (
  projectId: string,
  region: PrismaDatabaseRegionId | undefined,
) {
  if (region !== "inherit") {
    return (region ?? "us-east-1") as PrismaRegionId;
  }
  const project = yield* getProject({ id: projectId });
  if (project.data.defaultRegion !== null) {
    return project.data.defaultRegion as PrismaRegionId;
  }
  const database = yield* findDefaultDatabase(projectId);
  const inherited = database?.region?.id;
  if (inherited === undefined) {
    return yield* new DatabaseOperationFailed({
      message: `Cannot resolve Prisma database region 'inherit' because project '${projectId}' has no default region and no default database region. Create or promote a default database first, or specify an explicit region.`,
    });
  }
  return inherited as PrismaRegionId;
});

const stripDatabaseIdPrefix = (databaseId: string) =>
  databaseId.startsWith("db_") ? databaseId.slice(3) : databaseId;

const normalizeDatabaseSource = (
  source: DatabaseSourceInput | { readonly type: "unknown" } | undefined,
) => {
  if (source === undefined || source.type === "empty") {
    return { type: "empty" as const };
  }
  if (source.type === "unknown") return { type: "unknown" as const };
  return source.type === "database"
    ? {
        type: "database" as const,
        databaseId: stripDatabaseIdPrefix(source.databaseId),
      }
    : {
        type: "backup" as const,
        databaseId: stripDatabaseIdPrefix(source.databaseId),
        backupId: source.backupId,
      };
};

const sourceMatches = (observed: ObservedSource | null, desired: DatabaseSourceInput | undefined) =>
  deepEqual(
    normalizeDatabaseSource(narrowDatabaseSource(observed)),
    normalizeDatabaseSource(desired),
  );

const desiredSourcesMatch = (
  left: DatabaseSourceInput | undefined,
  right: DatabaseSourceInput | undefined,
) => deepEqual(normalizeDatabaseSource(left), normalizeDatabaseSource(right));

const branchIdForGitName = (projectId: string, gitName: string) =>
  getProjectBranches({ projectId, gitName, limit: 2 }).pipe(
    Effect.map((response: GetProjectBranchesResponse) => response.data),
    Effect.flatMap((branches) =>
      branches.length > 1
        ? Effect.fail(
            new DatabaseConflict({
              message: `Prisma project '${projectId}' has multiple branches named '${gitName}'; refusing to select one arbitrarily.`,
            }),
          )
        : Effect.succeed(branches[0]?.id),
    ),
  );

const attrsFrom = (
  database: ObservedProjectDatabase,
  secrets: PrismaSecretConnection,
): Database["Attributes"] => ({
  databaseId: database.id,
  databaseName: database.name,
  projectId: database.project.id,
  status: database.status,
  region: database.region?.id ?? null,
  isDefault: database.isDefault,
  branchId: database.branchId,
  defaultConnectionId: database.defaultConnectionId,
  createdAt: database.createdAt,
  directConnectionString: secrets.directConnectionString,
  pooledConnectionString: secrets.pooledConnectionString,
  accelerateConnectionString: secrets.accelerateConnectionString,
  host: secrets.host,
  user: secrets.user,
  password: secrets.password,
  logicalId: database.logicalId ?? null,
});

const branchNeedsSync = Effect.fn(function* (
  projectId: string,
  database: ObservedProjectDatabase,
  props: DatabaseProps,
) {
  if (props.branchId !== undefined && !isPrismaDevId(props.branchId)) {
    return database.branchId !== props.branchId;
  }
  if (props.branchGitName === undefined) {
    // No attachment requested: the Management API attaches every database to
    // a Branch (the project default when omitted) and rejects detaching, so
    // the observed attachment is left alone.
    return false;
  }
  const branchId = yield* branchIdForGitName(projectId, props.branchGitName);
  return branchId === undefined || branchId !== database.branchId;
});

const branchAttachment = (props: DatabaseProps) =>
  props.branchId !== undefined && !isPrismaDevId(props.branchId)
    ? {
        branchId: props.branchId,
        branchGitName: undefined,
      }
    : props.branchGitName !== undefined
      ? {
          branchId: undefined,
          branchGitName: props.branchGitName,
        }
      : {
          branchId: undefined,
          branchGitName: undefined,
        };

const validateDatabaseProps = (props: DatabaseProps) =>
  Effect.gen(function* () {
    if ((props as { isDefault?: boolean }).isDefault === true) {
      return yield* new DatabaseInvalidProps({
        message:
          "Prisma.Database cannot manage a default database because the Management API has no safe demotion or promote-existing operation, so the resource could never be destroyed. Use Prisma.Project for the project-owned default database.",
      });
    }
    if (props.branchId !== undefined && props.branchGitName !== undefined) {
      return yield* new DatabaseInvalidProps({
        message: "branchId and branchGitName are mutually exclusive.",
      });
    }
    if ((props.branchId as unknown) === null || (props.branchGitName as unknown) === null) {
      return yield* new DatabaseInvalidProps({
        message:
          "Every Prisma database belongs to a Branch; the Management API rejects detaching (null). Omit both branchId and branchGitName to attach to the project's default branch, or provide one of them.",
      });
    }
  });

const ProviderLive = () =>
  Provider.effect(
    Database,
    Effect.gen(function* () {
      return {
        stables: ["databaseId"],
        list: () =>
          listAllDatabases().pipe(
            Effect.map((databases) =>
              // Default databases are project-owned and the API rejects
              // direct deletion. Project.list/delete owns their teardown;
              // exposing them here would make unsafe nuke retry forever.
              databases
                .filter((database) => !database.isDefault)
                .map((database) => attrsFrom(database, {})),
            ),
          ),
        diff: Effect.fn(function* ({ id, fqn, olds, news, output }) {
          if (!isInputObject(news)) return undefined;
          if (
            isResolved(news.rotateCredentialsOnAdopt) &&
            news.rotateCredentialsOnAdopt === true &&
            olds.rotateCredentialsOnAdopt !== true
          ) {
            return { action: "update" } as const;
          }
          if ((news as { isDefault?: unknown }).isDefault === true) {
            return yield* new DatabaseInvalidProps({
              message:
                "Prisma.Database cannot manage a default database because the Management API has no safe demotion or promote-existing operation. Use Prisma.Project for the project-owned default database.",
            });
          }
          if (isPrismaDevId(output?.databaseId)) {
            return { action: "update" } as const;
          }
          const oldProjectId = output?.projectId ?? unresolvedProjectIdOf(olds.project);
          const newProjectId = isResolved(news.project)
            ? unresolvedProjectIdOf(news.project)
            : undefined;
          const desiredRegionInput = isResolved(news.region)
            ? (news.region ?? "us-east-1")
            : undefined;
          const regionProjectId = newProjectId ?? oldProjectId;
          const desiredRegion =
            desiredRegionInput === "inherit"
              ? regionProjectId
                ? yield* resolveDatabaseRegion(regionProjectId, desiredRegionInput)
                : undefined
              : desiredRegionInput;
          const observedRegion = output ? output.region : (olds.region ?? "us-east-1");
          const desiredIsDefault = isResolved(news.isDefault)
            ? (news.isDefault ?? false)
            : undefined;
          const observedIsDefault = output?.isDefault ?? olds.isDefault ?? false;

          // A default database cannot be deleted from its old project after a
          // cross-project replacement. Block before creating anything until
          // another database has been promoted in the original project.
          if (observedIsDefault && concreteIdsChanged(oldProjectId, newProjectId)) {
            return { action: "update" } as const;
          }

          // Prisma has no API operation that directly demotes the current
          // default database. Do not schedule a doomed create-first
          // replacement: reconcile will fail before mutation until another
          // database has been promoted and this one is observed as nondefault.
          if (desiredIsDefault === false && observedIsDefault) {
            return { action: "update" } as const;
          }
          if (
            concreteIdsChanged(oldProjectId, newProjectId) ||
            (desiredRegion !== undefined && desiredRegion !== observedRegion) ||
            (desiredIsDefault !== undefined && desiredIsDefault !== observedIsDefault) ||
            (isResolved(news.source) && !desiredSourcesMatch(news.source, olds.source))
          ) {
            // A stable explicit name in the same project collides with the
            // old generation, so it must go before the replacement is created.
            const deleteFirst =
              !concreteIdsChanged(oldProjectId, newProjectId) &&
              (isResolved(news.name)
                ? news.name !== undefined &&
                  (!output || (yield* createName(id, news.name)) === output.databaseName)
                : true);
            return { action: "replace", deleteFirst } as const;
          }
          if (
            isResolved(news.logicalId) &&
            (news.logicalId ?? fqn) !== (output ? output.logicalId : (olds.logicalId ?? fqn))
          ) {
            return { action: "update" } as const;
          }
          if (!isResolved(news.name)) return undefined;
          const desiredName = yield* createName(id, news.name);
          const observedName = output?.databaseName ?? (yield* createName(id, olds.name));
          // Omitting both branch fields leaves the observed attachment
          // unmanaged (every database belongs to a Branch; detaching is not
          // an API operation), so only an explicit target can mismatch.
          let branchMismatch = false;
          if (isResolved(news.branchId) && news.branchId !== undefined) {
            branchMismatch =
              !isPrismaDevId(news.branchId) &&
              (output?.branchId ?? olds.branchId ?? null) !== news.branchId;
          } else if (isResolved(news.branchGitName) && news.branchGitName !== undefined) {
            if (output && newProjectId !== undefined) {
              const desiredBranchId = yield* branchIdForGitName(newProjectId, news.branchGitName);
              branchMismatch = desiredBranchId === undefined || desiredBranchId !== output.branchId;
            } else {
              branchMismatch = news.branchGitName !== olds.branchGitName;
            }
          }
          if (desiredName !== observedName || branchMismatch) {
            return { action: "update" } as const;
          }
          return undefined;
        }),
        read: Effect.fn(function* ({ id, fqn, output, olds, previous }) {
          const databaseId = isPrismaDevId(output?.databaseId) ? undefined : output?.databaseId;
          let generatedIdentityMatch = false;
          let database = databaseId
            ? yield* getDatabase({ databaseId }).pipe(
                Effect.map((response) => response.data),
                Effect.catchTag("NotFound", () => Effect.undefined),
              )
            : undefined;
          if (!database && databaseId === undefined) {
            const projectId = unresolvedProjectIdOf(olds.project);
            if (projectId) {
              database = yield* findDatabaseByLogicalId(projectId, olds.logicalId ?? fqn, olds);
              // A logical ID alone does not prove ownership: another
              // declaration, stage, or stack on the branch can hold it. Only
              // the generated name, which embeds this instance's ID, does.
              generatedIdentityMatch =
                database !== undefined &&
                olds.name === undefined &&
                database.name === (yield* createName(id, undefined));
            }
            // An explicit logical ID is the only identity. A derived one falls
            // back to the name for databases created before logical IDs existed.
            if (!database && projectId && olds.logicalId === undefined) {
              const name = yield* createName(id, olds.name);
              database = yield* findDatabaseByName(projectId, name);
              generatedIdentityMatch = database !== undefined && olds.name === undefined;
              if (!database && olds.name === undefined && (olds.isDefault ?? false)) {
                database = yield* findDefaultDatabase(projectId);
              }
            }
          }
          if (!database) return undefined;
          if (databaseId === undefined && !sourceMatches(database.source, olds.source)) {
            return yield* new DatabaseConflict({
              message: `Prisma database '${database.name}' has immutable source ${JSON.stringify(database.source)} but ${JSON.stringify(olds.source ?? { type: "empty" })} was requested; refusing to adopt a database that cannot converge.`,
            });
          }
          const cachedSecrets = output?.databaseId === database.id ? output : undefined;
          const attrs = attrsFrom(database, {
            directConnectionString: cachedSecrets?.directConnectionString,
            pooledConnectionString: cachedSecrets?.pooledConnectionString,
            accelerateConnectionString: cachedSecrets?.accelerateConnectionString,
            host: cachedSecrets?.host,
            user: cachedSecrets?.user,
            password: cachedSecrets?.password,
          });
          // Only a declaration assigns a logical ID, so a match is this database.
          // The generation a replacement is replacing is ours too.
          return databaseId === undefined &&
            !generatedIdentityMatch &&
            database.id !== previous?.databaseId
            ? Unowned(attrs)
            : attrs;
        }),
        reconcile: Effect.fn(function* ({ id, fqn, news, olds, output }) {
          yield* validateDatabaseProps(news);
          const projectId = yield* resolveProjectId(news.project);
          const region = yield* resolveDatabaseRegion(projectId, news.region);
          const name = yield* createName(id, news.name);
          const databaseId = isPrismaDevId(output?.databaseId) ? undefined : output?.databaseId;
          let database: ObservedProjectDatabase | undefined = databaseId
            ? yield* getDatabase({ databaseId }).pipe(
                Effect.map((response) => response.data),
                Effect.catchTag("NotFound", () => Effect.undefined),
              )
            : undefined;
          const logicalId = news.logicalId ?? fqn;
          if (!database) {
            database = yield* findDatabaseByLogicalId(projectId, logicalId, news);
          }
          if (!database && news.logicalId === undefined && news.name === undefined) {
            database = yield* findDatabaseByName(projectId, name);
          }

          let secrets: PrismaSecretConnection = {};
          let recoverCreateSecrets = false;
          const attach = branchAttachment(news);
          if (!database) {
            if (
              news.name !== undefined &&
              (news.branchId !== undefined || news.branchGitName !== undefined)
            ) {
              return yield* new DatabaseInvalidProps({
                message: `Cannot safely create explicitly named Prisma database '${name}' with a branch attachment. The Management API creates the database before attaching the branch and exposes no idempotency key, so a failed response cannot be distinguished from a foreign database. Omit name to use Alchemy's recoverable physical identity, or wait for an atomic Management API operation.`,
              });
            }
            let createAttach: {
              branchId: string | undefined;
              branchGitName: string | undefined;
            } = attach;
            // The API refuses logicalId together with branchGitName on create.
            // When the branch does not exist yet, create it through
            // branchGitName and set the logical ID in a follow-up update.
            let createLogicalId: string | undefined = logicalId;
            if (attach.branchGitName !== undefined) {
              const branchId = yield* branchIdForGitName(projectId, attach.branchGitName);
              if (branchId === undefined) {
                createLogicalId = undefined;
              } else {
                createAttach = { branchId, branchGitName: undefined };
              }
            }
            const result = yield* createDatabase({
              projectId,
              name,
              region,
              isDefault: news.isDefault ?? false,
              ...(news.source === undefined ? {} : { source: news.source }),
              branchId: createAttach.branchId,
              branchGitName: createAttach.branchGitName,
              ...(createLogicalId === undefined ? {} : { logicalId: createLogicalId }),
            }).pipe(
              // A replayed create would make a second database; the retry
              // policy cannot see the request, so opt out explicitly.
              Retry.none,
              Effect.map((response) => ({
                database: response.data,
                secrets: extractConnectionSecrets(response.data.connections[0]),
                recoverSecrets: true,
              })),
              Effect.catchTag("Conflict", (conflict) =>
                Effect.gen(function* () {
                  const taken =
                    createLogicalId === undefined
                      ? undefined
                      : yield* findDatabaseByLogicalId(projectId, createLogicalId, createAttach);
                  if (taken) {
                    return yield* Effect.fail(
                      logicalIdTaken(logicalId, taken.branchId, projectId, conflict),
                    );
                  }
                  if (news.logicalId !== undefined) {
                    return yield* new DatabaseConflict({
                      message: `A Prisma database named '${name}' already exists in project '${projectId}' without logical ID '${logicalId}'. Refusing to take it over; choose a different name.`,
                      cause: conflict,
                    });
                  }
                  return yield* news.name === undefined
                    ? recoverGeneratedDatabaseAfterConflict(projectId, name).pipe(
                        Effect.map((database) => ({
                          database,
                          secrets: {},
                          // The generated physical name is owned by this
                          // resource instance. A conflict after the POST can
                          // be a lost successful response, so recover the
                          // write-only default credentials below.
                          recoverSecrets: true,
                        })),
                      )
                    : Effect.fail(
                        new DatabaseConflict({
                          message: `A Prisma database named '${name}' appeared after the adoption check. Refusing to take it over; rerun with adoption enabled if it is the intended database.`,
                        }),
                      );
                }),
              ),
            );
            database = result.database;
            secrets = result.secrets;
            recoverCreateSecrets = result.recoverSecrets;
          }

          if (database.project.id !== projectId) {
            return yield* new DatabaseInvalidProps({
              message: database.isDefault
                ? `Cannot move default Prisma database '${database.name}' from project '${database.project.id}' to '${projectId}' because the old default cannot be deleted. Promote another database in the original project first, then retry the move.`
                : `Prisma database '${database.name}' belongs to project '${database.project.id}', not requested project '${projectId}'. Refusing to claim convergence; replace the database.`,
            });
          }
          if (database.region?.id !== region) {
            return yield* new DatabaseConflict({
              message: `Prisma database '${database.name}' is in immutable region '${database.region?.id ?? "unknown"}', not requested region '${region}'. Refusing to claim convergence; replace the database.`,
            });
          }
          if (!sourceMatches(database.source, news.source)) {
            return yield* new DatabaseConflict({
              message: `Prisma database '${database.name}' has immutable source ${JSON.stringify(database.source)}, not requested source ${JSON.stringify(news.source ?? { type: "empty" })}. Refusing to claim convergence; replace the database.`,
            });
          }
          if (database.isDefault === true && (news.isDefault ?? false) === false) {
            return yield* new DatabaseConflict({
              message: `Cannot demote default Prisma database '${database.name}' directly because the Management API has no demotion operation. Promote another database in project '${projectId}' first, then retry this deployment.`,
            });
          }

          const ownedGeneratedIdentity = news.name === undefined && database.name === name;

          const desired = { ...news, name };
          const needsPatch =
            database.name !== name || (yield* branchNeedsSync(projectId, database, desired));
          if (needsPatch) {
            // Omitted branch props preserve the attachment; null is rejected.
            database = (yield* updateDatabase({
              databaseId: database.id,
              name,
              branchId: attach.branchId,
              branchGitName: attach.branchGitName,
            })).data;
          }
          if (database.logicalId !== logicalId) {
            const { branchId } = database;
            // The API refuses to rebind a logical ID; it must be cleared first.
            if (database.logicalId) {
              database = (yield* updateDatabase({ databaseId: database.id, logicalId: null })).data;
            }
            // The API refuses logicalId in the same request as a branch
            // move, so it is set only after the move above.
            database = (yield* updateDatabase({
              databaseId: database.id,
              logicalId,
            }).pipe(
              Effect.catchTag("Conflict", (conflict) =>
                Effect.fail(logicalIdTaken(logicalId, branchId, projectId, conflict)),
              ),
            )).data;
          }

          const persistedSecrets = output?.databaseId === database.id ? output : undefined;
          const knownSecrets = mergeConnectionSecrets(secrets, {
            directConnectionString: persistedSecrets?.directConnectionString,
            pooledConnectionString: persistedSecrets?.pooledConnectionString,
            accelerateConnectionString: persistedSecrets?.accelerateConnectionString,
            host: persistedSecrets?.host,
            user: persistedSecrets?.user,
            password: persistedSecrets?.password,
          });
          if (
            recoverCreateSecrets ||
            (ownedGeneratedIdentity && !hasCanonicalConnectionSecrets(knownSecrets)) ||
            olds !== undefined ||
            news.rotateCredentialsOnAdopt === true
          ) {
            const recovered = yield* recoverDatabaseConnectionSecrets(database, knownSecrets);
            database = recovered.database;
            return attrsFrom(database, recovered.secrets);
          }
          return attrsFrom(database, knownSecrets);
        }),
        delete: Effect.fn(function* ({ output }) {
          if (isPrismaDevId(output.databaseId)) return;
          const database = yield* getDatabase({
            databaseId: output.databaseId,
          }).pipe(
            Effect.map((response) => response.data),
            Effect.catchTag("NotFound", () => Effect.undefined),
          );
          if (!database) return;
          if (database.isDefault) {
            return yield* new DatabaseConflict({
              message: `Cannot delete default Prisma database '${database.name ?? output.databaseId}' directly. Promote another database first, or delete the owning Prisma.Project so the API can remove its project-owned default database.`,
            });
          }
          yield* deleteDatabase({
            databaseId: output.databaseId,
          }).pipe(Effect.catchTag("NotFound", () => Effect.void));
        }),
      };
    }),
  );

type PrismaDevDatabaseRequirements = ChildProcessSpawner | Path.Path | Scope;

const ProviderLocal = () =>
  Provider.succeed<Database, never, never, never, PrismaDevDatabaseRequirements>(Database, {
    stables: ["databaseId"],
    list: () => Effect.succeed([]),
    diff: Effect.fn(function* () {
      return { action: "update" } as const;
    }),
    read: Effect.fn(function* ({ output }) {
      return output;
    }),
    reconcile: Effect.fn(function* ({ id, fqn, news, output }) {
      const databaseId = output?.databaseId ?? devId("database", id);
      const local = yield* ensurePrismaDevDatabase(databaseId, news.dev);
      return {
        databaseId,
        databaseName: news.name ?? id,
        projectId: attrOrString(news.project, "projectId") ?? devId("project", id),
        status: "ready",
        region: news.region ?? "us-east-1",
        isDefault: news.isDefault ?? false,
        branchId: news.branchId ?? null,
        defaultConnectionId: devId("connection", id),
        createdAt: output?.createdAt ?? DEV_TIMESTAMP,
        directConnectionString: local?.directConnectionString,
        pooledConnectionString: local?.pooledConnectionString,
        accelerateConnectionString: local?.accelerateConnectionString,
        host: local?.host,
        user: local?.user,
        password: local?.password,
        logicalId: news.logicalId ?? fqn,
      } satisfies Database["Attributes"];
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* closePrismaDevDatabase(output.databaseId);
    }),
  });

export const DatabaseProvider = () =>
  ProviderLayer.dual(Database, {
    local: () => ProviderLocal(),
    live: () => ProviderLive(),
  });
