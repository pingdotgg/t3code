import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { deepEqual, isResolved } from "../Diff.ts";
import * as Redacted from "effect/Redacted";
import { Unowned } from "../AdoptPolicy.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import type { Scope } from "effect/Scope";
import type * as Path from "effect/Path";
import {
  closePrismaDevDatabase,
  ensurePrismaDevDatabase,
} from "./PrismaDevDatabase.ts";
import { DEV_TIMESTAMP, attrOrString, devId } from "./Internal/DevStub.ts";
import * as ProviderLayer from "../Local/ProviderLayer.ts";
import { Resource } from "../Resource.ts";
import {
  type GetDatabasesResponse,
  type GetProjectBranchesResponse,
  type GetProjectDatabasesResponse,
  deleteDatabase,
  getDatabases,
  getDatabase,
  getProjectBranches,
  getProjectDatabases,
  updateDatabase,
  createDatabase,
} from "@distilled.cloud/prisma/management";
import { Retry } from "@distilled.cloud/prisma";
import { extractConnectionSecrets } from "./Client.ts";
import type { Project } from "./Project.ts";
import {
  hasCanonicalConnectionSecrets,
  mergeConnectionSecrets,
  recoverDatabaseConnectionSecrets,
} from "./Internal/DatabaseSecrets.ts";
import type { Providers } from "./Providers.ts";
import {
  concreteIdsChanged,
  isInputObject,
  isPrismaDevId,
  resolveProjectId,
  unresolvedProjectIdOf,
} from "./Refs.ts";
import {
  type ObservedProjectDatabase,
  type ObservedSource,
  narrowDatabaseSource,
} from "./Internal/Observed.ts";
import type {
  DatabaseSourceInput,
  PrismaDatabaseRegionId,
  PrismaRegionId,
  PrismaSecretConnection,
} from "./Types.ts";
import { PrismaPaginationError } from "./Internal/Pagination.ts";

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
   * Region for the database.
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
        cursor === undefined
          ? { projectId, limit: 100 }
          : { projectId, limit: 100, cursor },
      );
      databases.push(...page.data);
      const nextCursor = page.pagination.nextCursor;
      if (!page.pagination.hasMore) break;
      if (nextCursor === null) {
        return yield* Effect.fail(
          new PrismaPaginationError({
            message:
              "Invalid Prisma Management API pagination response from getProjectDatabases: hasMore was true without a non-empty nextCursor",
          }),
        );
      }
      cursor = nextCursor;
    }
    return databases;
  });

const listAllDatabases = () =>
  Effect.gen(function* () {
    const databases: GetDatabasesResponse["data"][number][] = [];
    let cursor: string | undefined;
    while (true) {
      const page = yield* getDatabases(cursor === undefined ? {} : { cursor });
      databases.push(...page.data);
      const nextCursor = page.pagination.nextCursor;
      if (!page.pagination.hasMore) break;
      if (nextCursor === null) {
        return yield* Effect.fail(
          new PrismaPaginationError({
            message:
              "Invalid Prisma Management API pagination response from getDatabases: hasMore was true without a non-empty nextCursor",
          }),
        );
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
            new Error(
              `Prisma project '${projectId}' has multiple databases named '${name}'; refusing to select one arbitrarily.`,
            ),
          )
        : Effect.succeed(matches[0]);
    }),
  );

class GeneratedDatabaseNotVisible extends Error {}

const generatedDatabaseRecoverySchedule = Schedule.max([
  Schedule.exponential("250 millis"),
  Schedule.recurs(6),
]);

const recoverGeneratedDatabaseAfterConflict = (
  projectId: string,
  name: string,
) =>
  findDatabaseByName(projectId, name).pipe(
    Effect.flatMap((database) =>
      database
        ? Effect.succeed(database)
        : Effect.fail(
            new GeneratedDatabaseNotVisible(
              `Generated Prisma database '${name}' already exists but is not visible yet.`,
            ),
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
            new Error(
              `Prisma project '${projectId}' has multiple default databases; refusing to select one arbitrarily.`,
            ),
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
  const database = yield* findDefaultDatabase(projectId);
  const inherited = database?.region?.id;
  if (inherited === undefined) {
    return yield* Effect.fail(
      new Error(
        `Cannot resolve Prisma database region 'inherit' because project '${projectId}' has no default database region. Create or promote a default database first, or specify an explicit region.`,
      ),
    );
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

const sourceMatches = (
  observed: ObservedSource | null,
  desired: DatabaseSourceInput | undefined,
) =>
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
            new Error(
              `Prisma project '${projectId}' has multiple branches named '${gitName}'; refusing to select one arbitrarily.`,
            ),
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
      return yield* Effect.fail(
        new Error(
          "Prisma.Database cannot manage a default database because the Management API has no safe demotion or promote-existing operation, so the resource could never be destroyed. Use Prisma.Project for the project-owned default database.",
        ),
      );
    }
    if (props.branchId !== undefined && props.branchGitName !== undefined) {
      return yield* Effect.fail(
        new Error("branchId and branchGitName are mutually exclusive."),
      );
    }
    if (
      (props.branchId as unknown) === null ||
      (props.branchGitName as unknown) === null
    ) {
      return yield* Effect.fail(
        new Error(
          "Every Prisma database belongs to a Branch; the Management API rejects detaching (null). Omit both branchId and branchGitName to attach to the project's default branch, or provide one of them.",
        ),
      );
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
        diff: Effect.fn(function* ({ id, olds, news, output }) {
          if (!isInputObject(news)) return undefined;
          if (
            isResolved(news.rotateCredentialsOnAdopt) &&
            news.rotateCredentialsOnAdopt === true &&
            olds.rotateCredentialsOnAdopt !== true
          ) {
            return { action: "update" } as const;
          }
          if ((news as { isDefault?: unknown }).isDefault === true) {
            return yield* Effect.fail(
              new Error(
                "Prisma.Database cannot manage a default database because the Management API has no safe demotion or promote-existing operation. Use Prisma.Project for the project-owned default database.",
              ),
            );
          }
          if (isPrismaDevId(output?.databaseId)) {
            return { action: "update" } as const;
          }
          const oldProjectId =
            output?.projectId ?? unresolvedProjectIdOf(olds.project);
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
                ? yield* resolveDatabaseRegion(
                    regionProjectId,
                    desiredRegionInput,
                  )
                : undefined
              : desiredRegionInput;
          const observedRegion = output
            ? output.region
            : (olds.region ?? "us-east-1");
          const desiredIsDefault = isResolved(news.isDefault)
            ? (news.isDefault ?? false)
            : undefined;
          const observedIsDefault =
            output?.isDefault ?? olds.isDefault ?? false;

          // A default database cannot be deleted from its old project after a
          // cross-project replacement. Block before creating anything until
          // another database has been promoted in the original project.
          if (
            observedIsDefault &&
            concreteIdsChanged(oldProjectId, newProjectId)
          ) {
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
            (desiredIsDefault !== undefined &&
              desiredIsDefault !== observedIsDefault) ||
            (isResolved(news.source) &&
              !desiredSourcesMatch(news.source, olds.source))
          ) {
            return { action: "replace" } as const;
          }
          if (!isResolved(news.name)) return undefined;
          const desiredName = yield* createName(id, news.name);
          const observedName =
            output?.databaseName ?? (yield* createName(id, olds.name));
          // Omitting both branch fields leaves the observed attachment
          // unmanaged (every database belongs to a Branch; detaching is not
          // an API operation), so only an explicit target can mismatch.
          let branchMismatch = false;
          if (isResolved(news.branchId) && news.branchId !== undefined) {
            branchMismatch =
              !isPrismaDevId(news.branchId) &&
              (output?.branchId ?? olds.branchId ?? null) !== news.branchId;
          } else if (
            isResolved(news.branchGitName) &&
            news.branchGitName !== undefined
          ) {
            if (output && newProjectId !== undefined) {
              const desiredBranchId = yield* branchIdForGitName(
                newProjectId,
                news.branchGitName,
              );
              branchMismatch =
                desiredBranchId === undefined ||
                desiredBranchId !== output.branchId;
            } else {
              branchMismatch = news.branchGitName !== olds.branchGitName;
            }
          }
          if (desiredName !== observedName || branchMismatch) {
            return { action: "update" } as const;
          }
          return undefined;
        }),
        read: Effect.fn(function* ({ id, output, olds }) {
          const databaseId = isPrismaDevId(output?.databaseId)
            ? undefined
            : output?.databaseId;
          let generatedIdentityMatch = false;
          let database = databaseId
            ? yield* getDatabase({ databaseId }).pipe(
                Effect.map((response) => response.data),
                Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
              )
            : undefined;
          if (!database && databaseId === undefined) {
            const projectId = unresolvedProjectIdOf(olds.project);
            if (projectId) {
              const name = yield* createName(id, olds.name);
              database = yield* findDatabaseByName(projectId, name);
              generatedIdentityMatch =
                database !== undefined && olds.name === undefined;
              if (
                !database &&
                olds.name === undefined &&
                (olds.isDefault ?? false)
              ) {
                database = yield* findDefaultDatabase(projectId);
              }
            }
          }
          if (!database) return undefined;
          if (
            databaseId === undefined &&
            !sourceMatches(database.source, olds.source)
          ) {
            return yield* Effect.fail(
              new Error(
                `Prisma database '${database.name}' has immutable source ${JSON.stringify(database.source)} but ${JSON.stringify(olds.source ?? { type: "empty" })} was requested; refusing to adopt a database that cannot converge.`,
              ),
            );
          }
          const cachedSecrets =
            output?.databaseId === database.id ? output : undefined;
          const attrs = attrsFrom(database, {
            directConnectionString: cachedSecrets?.directConnectionString,
            pooledConnectionString: cachedSecrets?.pooledConnectionString,
            accelerateConnectionString:
              cachedSecrets?.accelerateConnectionString,
            host: cachedSecrets?.host,
            user: cachedSecrets?.user,
            password: cachedSecrets?.password,
          });
          return databaseId === undefined && !generatedIdentityMatch
            ? Unowned(attrs)
            : attrs;
        }),
        reconcile: Effect.fn(function* ({ id, news, olds, output }) {
          yield* validateDatabaseProps(news);
          const projectId = yield* resolveProjectId(news.project);
          const region = yield* resolveDatabaseRegion(projectId, news.region);
          const name = yield* createName(id, news.name);
          const databaseId = isPrismaDevId(output?.databaseId)
            ? undefined
            : output?.databaseId;
          let database: ObservedProjectDatabase | undefined = databaseId
            ? yield* getDatabase({ databaseId }).pipe(
                Effect.map((response) => response.data),
                Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
              )
            : undefined;
          if (!database && news.name === undefined) {
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
              return yield* Effect.fail(
                new Error(
                  `Cannot safely create explicitly named Prisma database '${name}' with a branch attachment. The Management API creates the database before attaching the branch and exposes no idempotency key, so a failed response cannot be distinguished from a foreign database. Omit name to use Alchemy's recoverable physical identity, or wait for an atomic Management API operation.`,
                ),
              );
            }
            const result = yield* createDatabase({
              projectId,
              name,
              region,
              isDefault: news.isDefault ?? false,
              ...(news.source === undefined ? {} : { source: news.source }),
              branchId: attach.branchId,
              branchGitName: attach.branchGitName,
            }).pipe(
              // A replayed create would make a second database; the retry
              // policy cannot see the request, so opt out explicitly.
              Retry.none,
              Effect.map((response) => ({
                database: response.data,
                secrets: extractConnectionSecrets(response.data.connections[0]),
                recoverSecrets: true,
              })),
              Effect.catchTag("Conflict", () =>
                news.name === undefined
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
                      new Error(
                        `A Prisma database named '${name}' appeared after the adoption check. Refusing to take it over; rerun with adoption enabled if it is the intended database.`,
                      ),
                    ),
              ),
            );
            database = result.database;
            secrets = result.secrets;
            recoverCreateSecrets = result.recoverSecrets;
          }

          if (database.project.id !== projectId) {
            return yield* Effect.fail(
              new Error(
                database.isDefault
                  ? `Cannot move default Prisma database '${database.name}' from project '${database.project.id}' to '${projectId}' because the old default cannot be deleted. Promote another database in the original project first, then retry the move.`
                  : `Prisma database '${database.name}' belongs to project '${database.project.id}', not requested project '${projectId}'. Refusing to claim convergence; replace the database.`,
              ),
            );
          }
          if (database.region?.id !== region) {
            return yield* Effect.fail(
              new Error(
                `Prisma database '${database.name}' is in immutable region '${database.region?.id ?? "unknown"}', not requested region '${region}'. Refusing to claim convergence; replace the database.`,
              ),
            );
          }
          if (!sourceMatches(database.source, news.source)) {
            return yield* Effect.fail(
              new Error(
                `Prisma database '${database.name}' has immutable source ${JSON.stringify(database.source)}, not requested source ${JSON.stringify(news.source ?? { type: "empty" })}. Refusing to claim convergence; replace the database.`,
              ),
            );
          }
          if (
            database.isDefault === true &&
            (news.isDefault ?? false) === false
          ) {
            return yield* Effect.fail(
              new Error(
                `Cannot demote default Prisma database '${database.name}' directly because the Management API has no demotion operation. Promote another database in project '${projectId}' first, then retry this deployment.`,
              ),
            );
          }

          const ownedGeneratedIdentity =
            news.name === undefined && database.name === name;

          const desired = { ...news, name };
          const needsPatch =
            database.name !== name ||
            (yield* branchNeedsSync(projectId, database, desired));
          if (needsPatch) {
            // Omitted branch props preserve the attachment; null is rejected.
            database = (yield* updateDatabase({
              databaseId: database.id,
              name,
              branchId: attach.branchId,
              branchGitName: attach.branchGitName,
            })).data;
          }

          const persistedSecrets =
            output?.databaseId === database.id ? output : undefined;
          const knownSecrets = mergeConnectionSecrets(secrets, {
            directConnectionString: persistedSecrets?.directConnectionString,
            pooledConnectionString: persistedSecrets?.pooledConnectionString,
            accelerateConnectionString:
              persistedSecrets?.accelerateConnectionString,
            host: persistedSecrets?.host,
            user: persistedSecrets?.user,
            password: persistedSecrets?.password,
          });
          if (
            recoverCreateSecrets ||
            (ownedGeneratedIdentity &&
              !hasCanonicalConnectionSecrets(knownSecrets)) ||
            olds !== undefined ||
            news.rotateCredentialsOnAdopt === true
          ) {
            const recovered = yield* recoverDatabaseConnectionSecrets(
              database,
              knownSecrets,
            );
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
            Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          );
          if (!database) return;
          if (database.isDefault) {
            return yield* Effect.fail(
              new Error(
                `Cannot delete default Prisma database '${database.name ?? output.databaseId}' directly. Promote another database first, or delete the owning Prisma.Project so the API can remove its project-owned default database.`,
              ),
            );
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
  Provider.succeed<
    Database,
    never,
    never,
    never,
    PrismaDevDatabaseRequirements
  >(Database, {
    stables: ["databaseId"],
    list: () => Effect.succeed([]),
    diff: Effect.fn(function* () {
      return { action: "update" } as const;
    }),
    read: Effect.fn(function* ({ output }) {
      return output;
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const databaseId = output?.databaseId ?? devId("database", id);
      const local = yield* ensurePrismaDevDatabase(databaseId, news.dev);
      return {
        databaseId,
        databaseName: news.name ?? id,
        projectId:
          attrOrString(news.project, "projectId") ?? devId("project", id),
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
