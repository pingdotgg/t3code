import * as Effect from "effect/Effect";
import { isResolved } from "../Diff.ts";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../AdoptPolicy.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { DEV_TIMESTAMP, devId, devProvider } from "./Internal/DevStub.ts";
import * as ProviderLayer from "../Local/ProviderLayer.ts";
import { Resource } from "../Resource.ts";
import {
  PrismaClient,
  extractConnectionSecrets,
  isConflict,
  isNotFound,
  type PrismaManagementClient,
} from "./Client.ts";
import { destroyProjectApps } from "./ComputeLifecycle.ts";
import {
  hasCanonicalConnectionSecrets,
  mergeConnectionSecrets,
  recoverDatabaseConnectionSecrets,
} from "./Internal/DatabaseSecrets.ts";
import { isInputObject, isPrismaDevId } from "./Refs.ts";
import type { Providers } from "./Providers.ts";
import type {
  Database,
  PrismaSecretConnection,
  PrismaRegionId,
  Project as ApiProject,
} from "./Types.ts";

export interface ProjectProps {
  /**
   * Project display name. If omitted, Alchemy generates a stable physical name.
   */
  name?: string;
  /**
   * Whether to create a default Prisma Postgres database with the project.
   *
   * @default true
   */
  createDatabase?: boolean;
  /**
   * Region for the default database created with the project.
   *
   * When `createDatabase` is false, omitting this leaves the project's default
   * region unset.
   *
   * @default "us-east-1" when a default database is created
   */
  region?: PrismaRegionId;
  /**
   * Opaque project settings passed through to the Management API.
   */
  settings?: Record<string, unknown>;
  /**
   * Rotate the adopted default database connection to recover its one-time
   * credentials. Prisma revokes the previous key on a best-effort basis and
   * rotation may interrupt existing consumers, so adoption leaves credentials
   * unset unless explicitly opted in.
   *
   * @default false
   */
  rotateCredentialsOnAdopt?: boolean;
}

export interface Project extends Resource<
  "Prisma.Project",
  ProjectProps,
  {
    /**
     * Prisma project ID.
     */
    projectId: string;
    /**
     * Prisma project display name.
     */
    projectName: string;
    /**
     * Workspace ID that owns the project.
     */
    workspaceId: string;
    /**
     * ISO timestamp when the project was created.
     */
    createdAt: string;
    /**
     * Default Prisma Postgres region for the project, when available.
     */
    defaultRegion: string | null;
    /**
     * Default database ID created with or discovered for the project.
     */
    databaseId: string | undefined;
    /**
     * Default database connection ID, when a database exists.
     */
    defaultConnectionId: string | undefined;
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
 * A Prisma project, optionally with a default Prisma Postgres database.
 *
 * A Project is the ownership boundary for its databases, branches, apps, and
 * repository link. Destroying this resource deletes the project and its
 * contained data. Set `createDatabase: false` when you want standalone
 * `Prisma.Database` resources with independent lifecycles.
 *
 * ### Creating a Project
 * **Example:** Project with a default database
 * ```typescript
 * const project = yield* Prisma.Project("app", {
 *   name: "app",
 *   region: "us-east-1",
 * });
 * ```
 *
 * **Example:** Project only
 * ```typescript
 * const project = yield* Prisma.Project("control-plane", {
 *   createDatabase: false,
 * });
 * ```
 *
 * @resource
 */
export const Project = Resource<Project>("Prisma.Project");

const createName = (id: string, name: string | undefined) =>
  name === undefined ? createPhysicalName({ id }) : Effect.succeed(name);

const findProjectByName = (client: PrismaManagementClient, name: string) =>
  client.listProjects().pipe(
    Effect.flatMap((projects) => {
      const matches = projects.filter((p: ApiProject) => p.name === name);
      return matches.length > 1
        ? Effect.fail(
            new Error(
              `Multiple Prisma projects are named '${name}'; use a unique project name before managing it with Alchemy.`,
            ),
          )
        : Effect.succeed(matches[0]);
    }),
  );

class GeneratedProjectNotVisible extends Error {}

const generatedProjectRecoverySchedule = Schedule.max([
  Schedule.exponential("250 millis"),
  Schedule.recurs(6),
]);

const recoverGeneratedProjectAfterConflict = (
  client: PrismaManagementClient,
  name: string,
) =>
  findProjectByName(client, name).pipe(
    Effect.flatMap((project) =>
      project
        ? Effect.succeed(project)
        : Effect.fail(
            new GeneratedProjectNotVisible(
              `Generated Prisma project '${name}' already exists but is not visible yet.`,
            ),
          ),
    ),
    Effect.retry({
      while: (error) => error instanceof GeneratedProjectNotVisible,
      schedule: generatedProjectRecoverySchedule,
    }),
  );

const defaultDatabase = (client: PrismaManagementClient, projectId: string) =>
  client.listProjectDatabases(projectId, { limit: 100 }).pipe(
    Effect.flatMap((databases) => {
      const matches = databases.filter((db) => db.isDefault);
      return matches.length > 1
        ? Effect.fail(
            new Error(
              `Prisma project '${projectId}' has multiple default databases; refusing to select one arbitrarily.`,
            ),
          )
        : Effect.succeed(matches[0]);
    }),
  );

class DefaultDatabaseConsistencyError extends Error {}

const defaultDatabaseConsistencySchedule = Schedule.max([
  Schedule.exponential("250 millis"),
  Schedule.recurs(6),
]);

const requireDefaultDatabaseInRegion = (
  database: ProjectDatabaseAttrs | undefined,
  projectName: string,
  desiredRegion: string,
) =>
  database?.region?.id === desiredRegion
    ? Effect.succeed(database)
    : Effect.fail(
        new DefaultDatabaseConsistencyError(
          database
            ? `Prisma project '${projectName}' still has default database '${database.id}' in region '${database.region?.id ?? "unknown"}', but region '${desiredRegion}' was requested. Retry after any in-progress default database promotion completes.`
            : `Prisma project '${projectName}' does not expose the requested default database in region '${desiredRegion}'. Retry after any in-progress default database creation completes.`,
        ),
      );

type ProjectDatabaseAttrs = Database;

const observeDesiredDefaultDatabase = (
  client: PrismaManagementClient,
  projectName: string,
  projectId: string,
  expectedDatabaseId: string,
  desiredRegion: string,
) =>
  Effect.gen(function* () {
    const project = yield* client
      .getProject(projectId)
      .pipe(
        Effect.catchIf(isNotFound, () =>
          Effect.fail(
            new DefaultDatabaseConsistencyError(
              `Prisma project '${projectName}' (${projectId}) is not visible yet while verifying its new default database.`,
            ),
          ),
        ),
      );
    const database = yield* requireDefaultDatabaseInRegion(
      yield* defaultDatabase(client, projectId).pipe(
        Effect.catchIf(isNotFound, () =>
          Effect.fail(
            new DefaultDatabaseConsistencyError(
              `Prisma project '${projectName}' default database list is not visible yet.`,
            ),
          ),
        ),
      ),
      projectName,
      desiredRegion,
    );
    if (database.id !== expectedDatabaseId) {
      return yield* Effect.fail(
        new DefaultDatabaseConsistencyError(
          `Prisma project '${projectName}' exposes default database '${database.id}', but newly created database '${expectedDatabaseId}' was expected. Retry after the in-progress default database promotion completes.`,
        ),
      );
    }
    if (project.defaultRegion !== desiredRegion) {
      return yield* Effect.fail(
        new DefaultDatabaseConsistencyError(
          `Prisma project '${projectName}' still reports default region '${project.defaultRegion ?? "unknown"}', but region '${desiredRegion}' was requested. Retry after the in-progress default database promotion completes.`,
        ),
      );
    }
    return { project, database };
  }).pipe(
    Effect.retry({
      while: (error) => error instanceof DefaultDatabaseConsistencyError,
      schedule: defaultDatabaseConsistencySchedule,
    }),
  );

const attrsFrom = (
  project: ApiProject,
  database: ProjectDatabaseAttrs | undefined,
  secrets: PrismaSecretConnection,
): Project["Attributes"] => ({
  projectId: project.id,
  projectName: project.name,
  workspaceId: project.workspace.id,
  createdAt: project.createdAt,
  // The default database observation is authoritative. Project.defaultRegion
  // may briefly lag after Prisma atomically promotes a replacement database.
  defaultRegion: database?.region?.id ?? project.defaultRegion,
  databaseId: database?.id,
  defaultConnectionId: database?.defaultConnectionId ?? undefined,
  directConnectionString: secrets.directConnectionString,
  pooledConnectionString: secrets.pooledConnectionString,
  accelerateConnectionString: secrets.accelerateConnectionString,
  host: secrets.host,
  user: secrets.user,
  password: secrets.password,
});

const ProviderLive = () =>
  Provider.effect(
    Project,
    Effect.gen(function* () {
      const client = yield* PrismaClient;
      return {
        stables: ["projectId"],
        list: Effect.fn(function* () {
          const projects = yield* client.listProjects();
          return yield* Effect.forEach(
            projects,
            Effect.fn(function* (project) {
              const database = yield* defaultDatabase(client, project.id).pipe(
                Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
              );
              return attrsFrom(project, database, {});
            }),
            { concurrency: 8 },
          );
        }),
        diff: Effect.fn(function* ({ id, olds = {}, news = {}, output }) {
          if (isPrismaDevId(output?.projectId)) {
            return { action: "update" } as const;
          }
          if (!isInputObject(news)) return undefined;
          if (
            isResolved(news.rotateCredentialsOnAdopt) &&
            news.rotateCredentialsOnAdopt === true &&
            olds.rotateCredentialsOnAdopt !== true
          ) {
            return { action: "update" } as const;
          }
          const desiredCreateDatabase = isResolved(news.createDatabase)
            ? (news.createDatabase ?? true)
            : undefined;
          const desiredRegion = isResolved(news.region)
            ? (news.region ?? "us-east-1")
            : undefined;
          const hadDatabase =
            output?.databaseId !== undefined ||
            (!output && (olds.createDatabase ?? true));

          // The API cannot remove a project's last/default database. Moving
          // from a database-bearing project to `createDatabase: false`
          // therefore requires replacing the project itself.
          if (desiredCreateDatabase === false && hadDatabase) {
            // A replacement may coexist when its generated name changes with
            // the instance id, or when this update also changes the explicit
            // name. A stable explicit name collides with the old generation
            // and must be removed before creating the new project.
            const deleteFirst = isResolved(news.name)
              ? news.name !== undefined &&
                (!output || news.name === output.projectName)
              : true;
            return { action: "replace", deleteFirst } as const;
          }

          // Adding a missing default database and replacing only that database
          // for a region change are both supported in-place. Preserve the
          // project (and its apps, repository link, environment, and IDs).
          if (
            desiredCreateDatabase === true &&
            output?.databaseId !== undefined &&
            desiredRegion !== undefined &&
            output.defaultRegion !== desiredRegion
          ) {
            return yield* Effect.fail(
              new Error(
                `Cannot safely change Prisma project '${output.projectName}' default database region from '${output.defaultRegion ?? "unknown"}' to '${desiredRegion}' in place. The Management API would create an empty default database and leave the data-bearing database to be deleted. Create a replacement project and perform an explicit data migration/cutover instead.`,
              ),
            );
          }
          if (
            desiredCreateDatabase === true &&
            (output?.databaseId === undefined ||
              (olds.createDatabase ?? true) === false)
          ) {
            return { action: "update" } as const;
          }
          const updateProps = {
            name: news.name,
            settings: news.settings,
          };
          if (!isResolved(updateProps)) return undefined;
          const resolvedUpdateProps = updateProps as Pick<
            ProjectProps,
            "name" | "settings"
          >;
          const nextName = yield* createName(id, resolvedUpdateProps.name);
          const oldName =
            output?.projectName ?? (yield* createName(id, olds.name));
          if (
            nextName !== oldName ||
            // Settings are write-only in the Management API project
            // response. Re-apply an explicit desired value every deploy so
            // out-of-band changes converge, and write `{}` once when a
            // previously managed settings prop is removed.
            resolvedUpdateProps.settings !== undefined ||
            (olds.settings !== undefined &&
              resolvedUpdateProps.settings === undefined)
          ) {
            return { action: "update" } as const;
          }
          return undefined;
        }),
        read: Effect.fn(function* ({ id, output, olds = {} }) {
          const projectId = isPrismaDevId(output?.projectId)
            ? undefined
            : output?.projectId;
          const project = projectId
            ? yield* client
                .getProject(projectId)
                .pipe(
                  Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
                )
            : yield* findProjectByName(
                client,
                yield* createName(id, olds.name),
              );
          if (!project) return undefined;
          const database = yield* defaultDatabase(client, project.id).pipe(
            Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
          );
          const cachedSecrets =
            output?.databaseId === database?.id ? output : undefined;
          const attrs = attrsFrom(project, database, {
            directConnectionString: cachedSecrets?.directConnectionString,
            pooledConnectionString: cachedSecrets?.pooledConnectionString,
            accelerateConnectionString:
              cachedSecrets?.accelerateConnectionString,
            host: cachedSecrets?.host,
            user: cachedSecrets?.user,
            password: cachedSecrets?.password,
          });
          // An omitted name is derived from this exact PlanScope instance ID.
          // Finding it proves this is create-recovery, not a foreign natural-
          // key match. User-supplied names still require explicit adoption.
          return projectId === undefined && olds.name !== undefined
            ? Unowned(attrs)
            : attrs;
        }),
        reconcile: Effect.fn(function* ({ id, news = {}, olds, output }) {
          const name = yield* createName(id, news.name);
          const outputProjectId = isPrismaDevId(output?.projectId)
            ? undefined
            : output?.projectId;
          let project = outputProjectId
            ? yield* client
                .getProject(outputProjectId)
                .pipe(
                  Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
                )
            : news.name === undefined
              ? yield* findProjectByName(client, name)
              : undefined;

          let createdDatabase: ProjectDatabaseAttrs | undefined;
          let secrets: PrismaSecretConnection = {};
          let createdProject = false;
          let recoverCreateSecrets = false;
          if (!project) {
            const result = yield* client
              .createProject({
                name,
                createDatabase: news.createDatabase ?? true,
                region: news.region,
              })
              .pipe(
                Effect.map((project) => ({
                  project,
                  database:
                    project.database === null
                      ? undefined
                      : {
                          ...project.database,
                          project: {
                            id: project.id,
                            url: project.url,
                            name: project.name,
                          },
                        },
                  secrets: extractConnectionSecrets(
                    project.database?.connections[0],
                  ),
                  created: true,
                  recoverSecrets: true,
                })),
                Effect.catchIf(isConflict, () =>
                  news.name === undefined
                    ? recoverGeneratedProjectAfterConflict(client, name).pipe(
                        Effect.map((project) => ({
                          project,
                          database: undefined,
                          secrets: {},
                          // The generated physical name is owned by this
                          // resource instance. Treat a conflict followed by an
                          // exact read as lost-response recovery so write-only
                          // default credentials are restored.
                          created: false,
                          recoverSecrets: true,
                        })),
                      )
                    : Effect.fail(
                        new Error(
                          `Prisma project '${name}' appeared after the adoption check. Refusing to take it over; rerun with adoption enabled if it is the intended project.`,
                        ),
                      ),
                ),
              );
            project = result.project;
            createdDatabase = result.database;
            secrets = result.secrets;
            createdProject = result.created;
            recoverCreateSecrets = result.recoverSecrets;
          }
          if (!project) {
            return yield* Effect.fail(
              new Error(
                `Prisma project '${name}' could not be observed after create recovery.`,
              ),
            );
          }
          const ownedGeneratedIdentity =
            news.name === undefined && project.name === name;

          if (news.createDatabase === false && createdDatabase) {
            return yield* Effect.fail(
              new Error(
                `Prisma created unexpected default database '${createdDatabase.name}' (${createdDatabase.id}) for project '${project.name}' even though createDatabase was false. Refusing to persist a state the Management API cannot remove in place.`,
              ),
            );
          }

          if (news.createDatabase === false && !createdProject) {
            const existingDefault = yield* defaultDatabase(
              client,
              project.id,
            ).pipe(Effect.catchIf(isNotFound, () => Effect.succeed(undefined)));
            if (existingDefault) {
              return yield* Effect.fail(
                new Error(
                  `Prisma project '${project.name}' already owns default database '${existingDefault.name}' (${existingDefault.id}), which cannot be removed in place. Refusing to adopt or reconcile it as createDatabase: false; replace the Prisma.Project instead.`,
                ),
              );
            }
          }

          // Project reads do not expose settings. Whenever settings are
          // explicitly managed, write them during reconcile (including the
          // forced reconcile after adoption) instead of trusting `olds` as an
          // observation of cloud state. When the prop is removed after being
          // managed, an empty object clears the previously managed settings.
          const settingsChanged =
            news.settings !== undefined || olds?.settings !== undefined;
          if (project.name !== name || settingsChanged) {
            project = yield* client.updateProject(project.id, {
              name,
              ...(settingsChanged ? { settings: news.settings ?? {} } : {}),
            });
          }
          const projectId = project.id;

          let database = createdDatabase;
          let defaultDatabaseChanged = false;
          if (news.createDatabase !== false && !database) {
            database = yield* defaultDatabase(client, projectId).pipe(
              Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
            );
          }

          if (news.createDatabase !== false) {
            const desiredRegion = news.region ?? "us-east-1";
            if (database && database.region?.id !== desiredRegion) {
              return yield* Effect.fail(
                new Error(
                  `Cannot safely change Prisma project '${name}' default database region from '${database.region?.id ?? "unknown"}' to '${desiredRegion}' in place. The Management API would create an empty default database and risk deleting the existing data-bearing database. Create a replacement project and perform an explicit data migration/cutover instead.`,
                ),
              );
            }
            if (!database) {
              defaultDatabaseChanged = true;
              const created = yield* client
                .createProjectDatabase(projectId, {
                  region: desiredRegion,
                  isDefault: true,
                })
                .pipe(
                  Effect.catchIf(isConflict, () =>
                    defaultDatabase(client, projectId).pipe(
                      Effect.flatMap((database) =>
                        requireDefaultDatabaseInRegion(
                          database,
                          name,
                          desiredRegion,
                        ),
                      ),
                    ),
                  ),
                );
              database = yield* requireDefaultDatabaseInRegion(
                created,
                name,
                desiredRegion,
              );
              secrets = extractConnectionSecrets(created.connections[0]);
            }
          }

          // Project.defaultRegion is derived from the current default database;
          // re-read both resources after an in-place database replacement and
          // verify the Management API actually exposes the desired region.
          if (defaultDatabaseChanged) {
            const changedDatabaseId = database?.id;
            if (changedDatabaseId === undefined) {
              return yield* Effect.fail(
                new DefaultDatabaseConsistencyError(
                  `Prisma project '${name}' did not return an identifier for its new default database.`,
                ),
              );
            }
            const observed = yield* observeDesiredDefaultDatabase(
              client,
              name,
              project.id,
              changedDatabaseId,
              news.region ?? "us-east-1",
            );
            project = observed.project;
            database = observed.database;
          }

          const persistedSecrets =
            output &&
            database !== undefined &&
            output.databaseId === database.id
              ? {
                  directConnectionString: output.directConnectionString,
                  pooledConnectionString: output.pooledConnectionString,
                  accelerateConnectionString: output.accelerateConnectionString,
                  host: output.host,
                  user: output.user,
                  password: output.password,
                }
              : {};
          const knownSecrets = mergeConnectionSecrets(
            secrets,
            persistedSecrets,
          );
          let finalSecrets = knownSecrets;
          if (
            database &&
            (recoverCreateSecrets ||
              (ownedGeneratedIdentity &&
                !hasCanonicalConnectionSecrets(knownSecrets)) ||
              defaultDatabaseChanged ||
              olds !== undefined ||
              news.rotateCredentialsOnAdopt === true)
          ) {
            const recovered = yield* recoverDatabaseConnectionSecrets(
              client,
              database,
              knownSecrets,
            );
            database = recovered.database;
            finalSecrets = recovered.secrets;
          }

          return attrsFrom(project, database, finalSecrets);
        }),
        delete: Effect.fn(function* ({ output }) {
          if (isPrismaDevId(output.projectId)) return;
          yield* destroyProjectApps(client, output.projectId);
        }),
      };
    }),
  );

const ProviderLocal = () =>
  devProvider(Project, ["projectId"], ({ id, news }) => ({
    projectId: devId("project", id),
    projectName: news.name ?? id,
    workspaceId: devId("workspace", "local"),
    createdAt: DEV_TIMESTAMP,
    defaultRegion:
      news.createDatabase === false
        ? (news.region ?? null)
        : (news.region ?? "us-east-1"),
    databaseId:
      news.createDatabase === false ? undefined : devId("database", id),
    defaultConnectionId:
      news.createDatabase === false ? undefined : devId("connection", id),
    directConnectionString: undefined,
    pooledConnectionString: undefined,
    accelerateConnectionString: undefined,
    host: undefined,
    user: undefined,
    password: undefined,
  }));

export const ProjectProvider = () =>
  ProviderLayer.dual(Project, {
    local: () => ProviderLocal(),
    live: () => ProviderLive(),
  });
