import { Unowned } from "@/AdoptPolicy";
import { InstanceId } from "@/InstanceId";
import * as Output from "@/Output";
import { createPhysicalName } from "@/PhysicalName";
import * as Provider from "@/Provider";
import type { App } from "@/Prisma/App";
import { Branch as PrismaBranch, BranchProvider } from "@/Prisma/Branch";
import { PrismaApiError, PrismaClient } from "@/Prisma/Client";
import {
  CustomDomain as PrismaCustomDomain,
  CustomDomainProvider,
} from "@/Prisma/CustomDomain";
import {
  Database as PrismaDatabase,
  DatabaseProvider,
} from "@/Prisma/Database";
import {
  EnvironmentVariable as PrismaEnvironmentVariable,
  EnvironmentVariableProvider,
} from "@/Prisma/EnvironmentVariable";
import { Project as PrismaProject, ProjectProvider } from "@/Prisma/Project";
import { recoverDatabaseConnectionSecrets } from "@/Prisma/Internal/DatabaseSecrets";
import {
  SourceRepository as PrismaSourceRepository,
  SourceRepositoryProvider,
} from "@/Prisma/SourceRepository";
import * as Test from "@/Test/Alchemy";
import { expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";
import type { PrismaManagementClient } from "@/Prisma/Client";
import type {
  Branch as ApiBranch,
  CustomDomain as ApiCustomDomain,
  Database as ApiDatabase,
  DatabaseConnectionWithSecrets,
  Project as ApiProject,
  SourceRepository as ApiSourceRepository,
} from "@/Prisma/Types";
import { AlchemyContext } from "@/AlchemyContext";

const createdAt = "2026-01-01T00:00:00.000Z";

const liveProviderContext = Layer.succeed(AlchemyContext, {
  dotAlchemy: ".alchemy-test",
  dev: false,
  adopt: false,
});

class TestPrismaProviders extends Provider.ProviderCollection<TestPrismaProviders>()(
  "Prisma",
) {}

const projectLayer = (client: PrismaManagementClient) =>
  Layer.effect(TestPrismaProviders, Provider.collection([PrismaProject])).pipe(
    Layer.provideMerge(ProjectProvider()),
    Layer.provideMerge(Layer.succeed(PrismaClient, client)),
    Layer.provide(liveProviderContext),
  );

const branchLayer = (client: PrismaManagementClient) =>
  Layer.effect(TestPrismaProviders, Provider.collection([PrismaBranch])).pipe(
    Layer.provideMerge(BranchProvider()),
    Layer.provideMerge(Layer.succeed(PrismaClient, client)),
    Layer.provide(liveProviderContext),
  );

const databaseLayer = (client: PrismaManagementClient) =>
  Layer.effect(TestPrismaProviders, Provider.collection([PrismaDatabase])).pipe(
    Layer.provideMerge(DatabaseProvider()),
    Layer.provideMerge(Layer.succeed(PrismaClient, client)),
    Layer.provide(liveProviderContext),
  );

const environmentVariableLayer = (client: PrismaManagementClient) =>
  Layer.effect(
    TestPrismaProviders,
    Provider.collection([PrismaEnvironmentVariable]),
  ).pipe(
    Layer.provideMerge(EnvironmentVariableProvider()),
    Layer.provideMerge(Layer.succeed(PrismaClient, client)),
    Layer.provide(liveProviderContext),
  );

const customDomainLayer = (client: PrismaManagementClient) =>
  Layer.effect(
    TestPrismaProviders,
    Provider.collection([PrismaCustomDomain]),
  ).pipe(
    Layer.provideMerge(CustomDomainProvider()),
    Layer.provideMerge(Layer.succeed(PrismaClient, client)),
    Layer.provide(liveProviderContext),
  );

const sourceRepositoryLayer = (client: PrismaManagementClient) =>
  Layer.effect(
    TestPrismaProviders,
    Provider.collection([PrismaSourceRepository]),
  ).pipe(
    Layer.provideMerge(SourceRepositoryProvider()),
    Layer.provideMerge(Layer.succeed(PrismaClient, client)),
    Layer.provide(liveProviderContext),
  );

const apiProject = (
  id: string,
  name: string,
  defaultRegion: string | null = "us-east-1",
): ApiProject => ({
  id,
  type: "project",
  url: `https://api.prisma.test/v1/projects/${id}`,
  name,
  createdAt,
  defaultRegion,
  workspace: {
    id: "workspace-1",
    url: "https://api.prisma.test/v1/workspaces/workspace-1",
    name: "team",
  },
});

const apiConnection = (
  databaseId: string,
  connectionId = `connection-${databaseId}`,
): DatabaseConnectionWithSecrets => ({
  id: connectionId,
  type: "connection",
  url: `https://api.prisma.test/v1/connections/${connectionId}`,
  name: "default",
  createdAt,
  kind: "postgres",
  endpoints: {
    direct: {
      host: "db.prisma.test",
      port: 5432,
      connectionString: `postgres://user:password@db.prisma.test/${databaseId}`,
    },
    pooled: {
      host: "pool.prisma.test",
      port: 5432,
      connectionString: `postgres://user:password@pool.prisma.test/${databaseId}`,
    },
  },
  database: {
    id: databaseId,
    url: `https://api.prisma.test/v1/databases/${databaseId}`,
    name: databaseId,
  },
});

it.effect(
  "database credential recovery waits for a ready default connection",
  () => {
    const provisioning: ApiDatabase = {
      ...apiDatabase("database-provisioning", {
        projectId: "project-1",
        name: "provisioning",
      }),
      status: "provisioning",
      defaultConnectionId: null,
      connections: [],
    };
    const ready: ApiDatabase = {
      ...provisioning,
      status: "ready",
      defaultConnectionId: "connection-provisioning",
    };
    let reads = 0;
    let rotations = 0;
    const client = {
      getDatabase: () =>
        Effect.sync(() => (reads++ === 0 ? provisioning : ready)),
      rotateConnection: () =>
        Effect.sync(() => {
          rotations += 1;
          return apiConnection(ready.id, ready.defaultConnectionId!);
        }),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const fiber = yield* recoverDatabaseConnectionSecrets(
        client,
        provisioning,
        {},
      ).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.yieldNow;
      yield* TestClock.adjust("1 second");
      const recovered = yield* Fiber.join(fiber);
      expect(recovered.database.status).toBe("ready");
      expect(recovered.database.defaultConnectionId).toBe(
        "connection-provisioning",
      );
      expect(
        Redacted.value(recovered.secrets.directConnectionString!),
      ).toContain(ready.id);
      expect(rotations).toBe(1);
    }).pipe(Effect.provide(TestClock.layer()));
  },
);

it.effect(
  "database credential recovery has a bounded status-rich timeout",
  () => {
    const provisioning: ApiDatabase = {
      ...apiDatabase("database-stuck", {
        projectId: "project-1",
        name: "stuck",
      }),
      status: "provisioning",
      defaultConnectionId: null,
      connections: [],
    };
    const client = {
      getDatabase: () => Effect.succeed(provisioning),
      rotateConnection: () => Effect.die("must not rotate while provisioning"),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const fiber = yield* recoverDatabaseConnectionSecrets(
        client,
        provisioning,
        {},
      ).pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
      yield* Effect.yieldNow;
      yield* TestClock.adjust("1 minute");
      const result = yield* Fiber.join(fiber);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(String(result.failure)).toContain("database-stuck");
        expect(String(result.failure)).toContain("provisioning");
        expect(String(result.failure)).toContain("defaultConnectionId 'null'");
      }
    }).pipe(Effect.provide(TestClock.layer()));
  },
);

const makeProjectCloud = (initial: ApiProject[] = []) => {
  const projects = new Map(initial.map((project) => [project.id, project]));
  const databases = new Map<string, ApiDatabase>();
  const calls: Array<[string, unknown?]> = [];
  let nextId = initial.length + 1;
  let nextDatabaseId = 1;
  let conflictNextProjectDatabaseCreate = false;
  let staleNextProjectDatabaseObservation = false;
  let staleProjectReads = 0;
  let staleProjectDefaultRegion: string | null = null;
  let staleDatabaseLists = 0;
  let staleDatabases: ApiDatabase[] = [];

  const currentProject = (project: ApiProject) => {
    const database = Array.from(databases.values()).find(
      (database) => database.project.id === project.id && database.isDefault,
    );
    return {
      ...project,
      defaultRegion: database?.region?.id ?? null,
    };
  };

  const makeDatabase = (
    project: ApiProject,
    input: { region?: string; isDefault?: boolean },
  ): ApiDatabase => {
    if (input.isDefault) {
      for (const [id, database] of databases) {
        if (database.project.id === project.id && database.isDefault) {
          databases.set(id, { ...database, isDefault: false });
        }
      }
    }
    const id = `project-database-${nextDatabaseId++}`;
    const database: ApiDatabase = {
      id,
      type: "database",
      url: `https://api.prisma.test/v1/databases/${id}`,
      name: project.name,
      status: "ready",
      createdAt,
      isDefault: input.isDefault ?? false,
      defaultConnectionId: `connection-${id}`,
      connections: [apiConnection(id)],
      project: {
        id: project.id,
        url: project.url,
        name: project.name,
      },
      region: {
        id: input.region ?? "us-east-1",
        name: input.region ?? "us-east-1",
      },
      source: { type: "empty" },
      branchId: null,
    };
    databases.set(id, database);
    return database;
  };

  const client = {
    listProjects: () =>
      Effect.sync(() => {
        calls.push(["listProjects"]);
        return Array.from(projects.values()).map(currentProject);
      }),
    getProject: (id: string) =>
      Effect.suspend(() => {
        calls.push(["getProject", id]);
        const stored = projects.get(id);
        const project = stored
          ? staleProjectReads > 0
            ? {
                ...currentProject(stored),
                defaultRegion: staleProjectDefaultRegion,
              }
            : currentProject(stored)
          : undefined;
        if (staleProjectReads > 0) staleProjectReads -= 1;
        return project
          ? Effect.succeed(project)
          : Effect.fail(
              new PrismaApiError({
                method: "GET",
                path: `/v1/projects/${id}`,
                status: 404,
                message: "not found",
              }),
            );
      }),
    createProject: (input: {
      name?: string;
      region?: string;
      createDatabase?: boolean;
    }) =>
      Effect.sync(() => {
        calls.push(["createProject", input]);
        const id = `project-${nextId++}`;
        const project = apiProject(id, input.name ?? `project-${id}`, null);
        projects.set(id, project);
        const database =
          input.createDatabase === false
            ? null
            : makeDatabase(project, {
                region: input.region,
                isDefault: true,
              });
        return { ...currentProject(project), database };
      }),
    updateProject: (
      id: string,
      input: { name?: string; settings?: Record<string, unknown> },
    ) =>
      Effect.sync(() => {
        calls.push(["updateProject", { id, input }]);
        const project = projects.get(id)!;
        const updated = { ...project, name: input.name ?? project.name };
        projects.set(id, updated);
        return currentProject(updated);
      }),
    listProjectDatabases: (projectId: string) =>
      Effect.sync(() => {
        calls.push(["listProjectDatabases", projectId]);
        if (staleDatabaseLists > 0) {
          staleDatabaseLists -= 1;
          return staleDatabases;
        }
        return Array.from(databases.values()).filter(
          (database) => database.project.id === projectId,
        );
      }),
    createProjectDatabase: (
      projectId: string,
      input: { region?: string; isDefault?: boolean },
    ) =>
      Effect.suspend(() => {
        calls.push(["createProjectDatabase", { projectId, input }]);
        if (conflictNextProjectDatabaseCreate) {
          conflictNextProjectDatabaseCreate = false;
          return Effect.fail(
            new PrismaApiError({
              method: "POST",
              path: `/v1/projects/${projectId}/databases`,
              status: 409,
              message: "default database promotion in progress",
            }),
          );
        }
        const previousDefault = Array.from(databases.values()).find(
          (database) => database.project.id === projectId && database.isDefault,
        );
        const created = makeDatabase(projects.get(projectId)!, input);
        if (staleNextProjectDatabaseObservation) {
          staleNextProjectDatabaseObservation = false;
          staleProjectReads = 1;
          staleProjectDefaultRegion = previousDefault?.region?.id ?? null;
          staleDatabaseLists = 1;
          staleDatabases = Array.from(databases.values())
            .filter((database) => database.project.id === projectId)
            .map((database) => ({
              ...database,
              isDefault: database.id === previousDefault?.id,
            }));
        }
        return Effect.succeed(created);
      }),
    getDatabase: (id: string) =>
      Effect.suspend(() => {
        calls.push(["getDatabase", id]);
        const database = databases.get(id);
        return database
          ? Effect.succeed(database)
          : Effect.fail(
              new PrismaApiError({
                method: "GET",
                path: `/v1/databases/${id}`,
                status: 404,
                message: "not found",
              }),
            );
      }),
    deleteDatabase: (id: string) =>
      Effect.sync(() => {
        calls.push(["deleteDatabase", id]);
        databases.delete(id);
      }),
    rotateConnection: (id: string) =>
      Effect.sync(() => {
        calls.push(["rotateConnection", id]);
        const database = Array.from(databases.values()).find(
          (database) => database.defaultConnectionId === id,
        )!;
        return apiConnection(database.id, id);
      }),
    listApps: (query: unknown) =>
      Effect.sync(() => {
        calls.push(["listApps", query]);
        return [];
      }),
    deleteProject: (id: string) =>
      Effect.sync(() => {
        calls.push(["deleteProject", id]);
        projects.delete(id);
        for (const [databaseId, database] of databases) {
          if (database.project.id === id) databases.delete(databaseId);
        }
      }),
  } as unknown as PrismaManagementClient;

  return {
    client,
    calls,
    databases,
    projects,
    conflictNextProjectDatabaseCreate: () => {
      conflictNextProjectDatabaseCreate = true;
    },
    staleNextProjectDatabaseObservation: () => {
      staleNextProjectDatabaseObservation = true;
    },
  };
};

const foreignProject = apiProject("project-foreign", "app");
const refusalCloud = makeProjectCloud([foreignProject]);
const refusal = Test.make({ providers: projectLayer(refusalCloud.client) });

refusal.test.provider(
  "Plan refuses cold adoption of a foreign Prisma project",
  (stack) =>
    Effect.gen(function* () {
      refusalCloud.projects.clear();
      refusalCloud.projects.set(foreignProject.id, foreignProject);
      refusalCloud.calls.length = 0;
      yield* stack.destroy();

      const result = yield* stack
        .deploy(
          PrismaProject("Project", {
            name: "app",
            createDatabase: false,
          }),
        )
        .pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(String(result.failure)).toContain("Cannot adopt resource");
      }
      expect(refusalCloud.projects.get("project-foreign")?.name).toBe("app");
      expect(refusalCloud.calls.map(([operation]) => operation)).not.toContain(
        "updateProject",
      );

      yield* stack.destroy();
    }),
);

const generatedProjectRecoveryCloud = makeProjectCloud();
const generatedProjectRecovery = Test.make({
  providers: projectLayer(generatedProjectRecoveryCloud.client),
});

generatedProjectRecovery.test.provider(
  "generated Project physical names recover as owned for the same instance",
  (stack) =>
    Effect.gen(function* () {
      generatedProjectRecoveryCloud.projects.clear();
      yield* stack.destroy();
      const instanceId = "00000000000000000000000000000000";
      const name = yield* createPhysicalName({ id: "Project" }).pipe(
        Effect.provideService(InstanceId, instanceId),
      );
      generatedProjectRecoveryCloud.projects.set(
        "project-generated",
        apiProject("project-generated", name, null),
      );
      const provider = yield* PrismaProject.Provider;
      const observed = yield* provider.read!({
        id: "Project",
        instanceId,
        olds: { createDatabase: false },
        output: undefined,
      } as never).pipe(Effect.provideService(InstanceId, instanceId));

      expect(observed).toBeDefined();
      expect(Unowned.is(observed!)).toBe(false);
      expect((observed as PrismaProject["Attributes"]).projectName).toBe(name);
      generatedProjectRecoveryCloud.databases.set("database-new-default", {
        ...apiDatabase("database-new-default", {
          projectId: "project-generated",
          name: "new-default",
          isDefault: true,
        }),
        connections: [],
      });
      const staleSecret = Redacted.make("postgres://old-project-secret");
      const switched = yield* provider.read!({
        id: "Project",
        instanceId,
        olds: { createDatabase: true },
        output: {
          ...(observed as PrismaProject["Attributes"]),
          databaseId: "database-old-default",
          directConnectionString: staleSecret,
          pooledConnectionString: staleSecret,
          accelerateConnectionString: staleSecret,
          password: Redacted.make("old-password"),
        },
      } as never).pipe(Effect.provideService(InstanceId, instanceId));
      expect((switched as PrismaProject["Attributes"]).databaseId).toBe(
        "database-new-default",
      );
      expect(
        (switched as PrismaProject["Attributes"]).directConnectionString,
      ).toBeUndefined();
      expect(
        (switched as PrismaProject["Attributes"]).password,
      ).toBeUndefined();
      const cannotDropAdoptedDefault = yield* provider
        .reconcile({
          id: "Project",
          instanceId,
          news: { createDatabase: false },
          olds: undefined,
          output: switched,
          bindings: [],
        } as never)
        .pipe(Effect.provideService(InstanceId, instanceId), Effect.result);
      expect(Result.isFailure(cannotDropAdoptedDefault)).toBe(true);
      if (Result.isFailure(cannotDropAdoptedDefault)) {
        expect(String(cannotDropAdoptedDefault.failure)).toContain(
          "cannot be removed in place",
        );
      }
      generatedProjectRecoveryCloud.calls.length = 0;
      const recoveredSecrets = yield* provider
        .reconcile({
          id: "Project",
          instanceId,
          news: { createDatabase: true },
          olds: { createDatabase: true },
          output: switched,
          bindings: [],
        } as never)
        .pipe(Effect.provideService(InstanceId, instanceId));
      expect(
        Redacted.value(recoveredSecrets.directConnectionString!),
      ).toContain("database-new-default");
      expect(generatedProjectRecoveryCloud.calls).toContainEqual([
        "rotateConnection",
        "connection-database-new-default",
      ]);
      generatedProjectRecoveryCloud.projects.clear();
      generatedProjectRecoveryCloud.databases.clear();
      yield* stack.destroy();
    }),
);

const adoptionCloud = makeProjectCloud([foreignProject]);
const adoption = Test.make({
  providers: projectLayer(adoptionCloud.client),
  adopt: true,
});

adoption.test.provider(
  "Plan adopts explicitly and applies write-only project settings",
  (stack) =>
    Effect.gen(function* () {
      adoptionCloud.projects.clear();
      adoptionCloud.projects.set(foreignProject.id, foreignProject);
      adoptionCloud.calls.length = 0;
      yield* stack.destroy();

      const project = yield* stack.deploy(
        PrismaProject("Project", {
          name: "app",
          createDatabase: true,
          region: "us-east-1",
          settings: {},
        }),
      );

      expect(project.projectId).toBe("project-foreign");
      expect(adoptionCloud.calls).toContainEqual([
        "updateProject",
        { id: "project-foreign", input: { name: "app", settings: {} } },
      ]);

      yield* stack.destroy();
    }),
);

const replacementCloud = makeProjectCloud();
const replacement = Test.make({
  providers: projectLayer(replacementCloud.client),
});

replacement.test.provider(
  "Apply refuses to replace a data-bearing default database for a region change",
  (stack) =>
    Effect.gen(function* () {
      replacementCloud.projects.clear();
      replacementCloud.calls.length = 0;
      yield* stack.destroy();

      const first = yield* stack.deploy(
        PrismaProject("Project", {
          name: "app",
          createDatabase: true,
          region: "us-east-1",
        }),
      );
      replacementCloud.calls.length = 0;

      const result = yield* stack
        .deploy(
          PrismaProject("Project", {
            name: "app",
            createDatabase: true,
            region: "us-west-1" as const,
          }),
        )
        .pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(String(result.failure)).toContain("Cannot safely change");
        expect(String(result.failure)).toContain("explicit data migration");
      }
      expect(first.projectId).toBeDefined();
      const operations = replacementCloud.calls.map(([operation]) => operation);
      expect(operations).not.toContain("createProjectDatabase");
      expect(operations).not.toContain("deleteDatabase");
      expect(operations).not.toContain("deleteProject");
      expect(Array.from(replacementCloud.databases.values())).toHaveLength(1);
      expect(
        Array.from(replacementCloud.databases.values())[0]?.region?.id,
      ).toBe("us-east-1");

      yield* stack.destroy();
    }),
);

const eventuallyConsistentRegionCloud = makeProjectCloud();
const eventuallyConsistentRegion = Test.make({
  providers: projectLayer(eventuallyConsistentRegionCloud.client),
});

eventuallyConsistentRegion.test.provider(
  "Project default database creation retries one stale observation",
  (stack) =>
    Effect.gen(function* () {
      eventuallyConsistentRegionCloud.projects.clear();
      eventuallyConsistentRegionCloud.databases.clear();
      yield* stack.destroy();

      const first = yield* stack.deploy(
        PrismaProject("Project", {
          name: "app",
          createDatabase: false,
        }),
      );
      eventuallyConsistentRegionCloud.calls.length = 0;
      eventuallyConsistentRegionCloud.staleNextProjectDatabaseObservation();
      const second = yield* stack.deploy(
        PrismaProject("Project", {
          name: "app",
          createDatabase: true,
          region: "us-west-1" as const,
        }),
      );

      expect(second.projectId).toBe(first.projectId);
      expect(second.defaultRegion).toBe("us-west-1");
      expect(Redacted.value(second.directConnectionString!)).toContain(
        second.databaseId!,
      );
      expect(
        eventuallyConsistentRegionCloud.calls.filter(
          ([operation]) => operation === "getProject",
        ).length,
      ).toBeGreaterThanOrEqual(3);
      expect(
        eventuallyConsistentRegionCloud.calls.filter(
          ([operation]) => operation === "listProjectDatabases",
        ).length,
      ).toBeGreaterThanOrEqual(3);

      yield* stack.destroy();
    }),
);

const conflictingRegionCloud = makeProjectCloud();
const conflictingRegion = Test.make({
  providers: projectLayer(conflictingRegionCloud.client),
});

conflictingRegion.test.provider(
  "Project default database creation rejects a conflict without an observed default",
  (stack) =>
    Effect.gen(function* () {
      conflictingRegionCloud.projects.clear();
      conflictingRegionCloud.databases.clear();
      yield* stack.destroy();

      const first = yield* stack.deploy(
        PrismaProject("Project", {
          name: "app",
          createDatabase: false,
        }),
      );
      conflictingRegionCloud.calls.length = 0;
      conflictingRegionCloud.conflictNextProjectDatabaseCreate();

      const result = yield* stack
        .deploy(
          PrismaProject("Project", {
            name: "app",
            createDatabase: true,
            region: "us-west-1" as const,
          }),
        )
        .pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(String(result.failure)).toContain(
          "does not expose the requested default database",
        );
      }
      expect(first.databaseId).toBeUndefined();
      expect(conflictingRegionCloud.databases.size).toBe(0);
      expect(
        conflictingRegionCloud.calls.map(([operation]) => operation),
      ).not.toContain("deleteDatabase");

      conflictingRegionCloud.databases.clear();
      yield* stack.destroy();
    }),
);

const addDefaultCloud = makeProjectCloud();
const addDefault = Test.make({
  providers: projectLayer(addDefaultCloud.client),
});

addDefault.test.provider(
  "Apply adds a missing Project default database without replacing the Project",
  (stack) =>
    Effect.gen(function* () {
      addDefaultCloud.projects.clear();
      addDefaultCloud.databases.clear();
      yield* stack.destroy();

      const first = yield* stack.deploy(
        PrismaProject("Project", {
          name: "app",
          createDatabase: false,
        }),
      );
      addDefaultCloud.calls.length = 0;
      const second = yield* stack.deploy(
        PrismaProject("Project", {
          name: "app",
          createDatabase: true,
          region: "us-west-1" as const,
        }),
      );

      expect(second.projectId).toBe(first.projectId);
      expect(second.defaultRegion).toBe("us-west-1");
      expect(addDefaultCloud.databases.size).toBe(1);
      expect(addDefaultCloud.calls.map(([operation]) => operation)).toContain(
        "createProjectDatabase",
      );
      expect(
        addDefaultCloud.calls.map(([operation]) => operation),
      ).not.toContain("deleteProject");

      yield* stack.destroy();
    }),
);

const removeDefaultCloud = makeProjectCloud();
const removeDefault = Test.make({
  providers: projectLayer(removeDefaultCloud.client),
});

removeDefault.test.provider(
  "Apply replaces a Project when removing its last default database",
  (stack) =>
    Effect.gen(function* () {
      removeDefaultCloud.projects.clear();
      removeDefaultCloud.databases.clear();
      yield* stack.destroy();

      const first = yield* stack.deploy(
        PrismaProject("Project", {
          name: "app",
          createDatabase: true,
        }),
      );
      removeDefaultCloud.calls.length = 0;
      const second = yield* stack.deploy(
        PrismaProject("Project", {
          name: "app",
          createDatabase: false,
        }),
      );

      expect(second.projectId).not.toBe(first.projectId);
      expect(second.databaseId).toBeUndefined();
      const operations = removeDefaultCloud.calls.map(
        ([operation]) => operation,
      );
      expect(operations.indexOf("deleteProject")).toBeLessThan(
        operations.indexOf("createProject"),
      );

      yield* stack.destroy();
    }),
);

const apiDatabase = (
  id: string,
  input: {
    projectId: string;
    name?: string;
    region?: string;
    isDefault?: boolean;
    source?: ApiDatabase["source"];
  },
): ApiDatabase => ({
  id,
  type: "database",
  url: `https://api.prisma.test/v1/databases/${id}`,
  name: input.name ?? `database-${id}`,
  status: "ready",
  createdAt,
  isDefault: input.isDefault ?? false,
  defaultConnectionId: `connection-${id}`,
  connections: [apiConnection(id)],
  project: {
    id: input.projectId,
    url: `https://api.prisma.test/v1/projects/${input.projectId}`,
    name: "app",
  },
  region: { id: input.region ?? "us-east-1", name: "Region" },
  source: input.source ?? { type: "empty" },
  branchId: null,
});

const makeDatabaseCloud = () => {
  const databases = new Map<string, ApiDatabase>();
  const calls: Array<[string, unknown?]> = [];
  let nextId = 1;
  const client = {
    listDatabases: () => Effect.succeed(Array.from(databases.values())),
    listProjectDatabases: (projectId: string) =>
      Effect.succeed(
        Array.from(databases.values()).filter(
          (database) => database.project.id === projectId,
        ),
      ),
    getDatabase: (id: string) =>
      Effect.suspend(() => {
        calls.push(["getDatabase", id]);
        const database = databases.get(id);
        return database
          ? Effect.succeed(database)
          : Effect.fail(
              new PrismaApiError({
                method: "GET",
                path: `/v1/databases/${id}`,
                status: 404,
                message: "not found",
              }),
            );
      }),
    createDatabase: (input: {
      projectId: string;
      name?: string;
      region?: string;
      isDefault?: boolean;
      source?: ApiDatabase["source"];
    }) =>
      Effect.sync(() => {
        calls.push(["createDatabase", input]);
        if (input.isDefault) {
          for (const [id, database] of databases) {
            if (database.project.id === input.projectId && database.isDefault) {
              databases.set(id, { ...database, isDefault: false });
            }
          }
        }
        const id = `database-${nextId++}`;
        const database = apiDatabase(id, input);
        databases.set(id, database);
        return database;
      }),
    updateDatabase: (id: string, input: { name?: string }) =>
      Effect.sync(() => {
        const database = databases.get(id)!;
        const updated = { ...database, name: input.name ?? database.name };
        databases.set(id, updated);
        return updated;
      }),
    rotateConnection: (id: string) =>
      Effect.sync(() => {
        calls.push(["rotateConnection", id]);
        const database = Array.from(databases.values()).find(
          (database) => database.defaultConnectionId === id,
        )!;
        return apiConnection(database.id, id);
      }),
    deleteDatabase: (id: string) =>
      Effect.sync(() => {
        calls.push(["deleteDatabase", id]);
        databases.delete(id);
      }),
  } as unknown as PrismaManagementClient;
  return { client, calls, databases };
};

const generatedDatabaseRecoveryCloud = makeDatabaseCloud();
const generatedDatabaseRecovery = Test.make({
  providers: databaseLayer(generatedDatabaseRecoveryCloud.client),
});

generatedDatabaseRecovery.test.provider(
  "unnamed Database physical names recover exactly without adoption",
  (stack) =>
    Effect.gen(function* () {
      generatedDatabaseRecoveryCloud.databases.clear();
      yield* stack.destroy();
      const instanceId = "00000000000000000000000000000000";
      const name = yield* createPhysicalName({ id: "Database" }).pipe(
        Effect.provideService(InstanceId, instanceId),
      );
      generatedDatabaseRecoveryCloud.databases.set("database-generated", {
        ...apiDatabase("database-generated", {
          projectId: "project-1",
          name,
          isDefault: false,
        }),
        connections: [],
      });
      const provider = yield* PrismaDatabase.Provider;
      const observed = yield* provider.read!({
        id: "Database",
        instanceId,
        olds: { project: "project-1", isDefault: false },
        output: undefined,
      } as never).pipe(Effect.provideService(InstanceId, instanceId));

      expect(observed).toBeDefined();
      expect(Unowned.is(observed!)).toBe(false);
      expect((observed as PrismaDatabase["Attributes"]).databaseName).toBe(
        name,
      );
      const localSecret = Redacted.make("postgres://local-dev-secret");
      const fromDev = yield* provider.read!({
        id: "Database",
        instanceId,
        olds: { project: "project-1", isDefault: false },
        output: {
          databaseId: "dev:database:Database",
          databaseName: "local",
          projectId: "dev:project:Project",
          status: "ready",
          region: null,
          isDefault: false,
          branchId: null,
          defaultConnectionId: null,
          createdAt,
          directConnectionString: localSecret,
          pooledConnectionString: localSecret,
          accelerateConnectionString: localSecret,
          host: "127.0.0.1",
          user: "postgres",
          password: Redacted.make("local-password"),
        },
      } as never).pipe(Effect.provideService(InstanceId, instanceId));
      expect((fromDev as PrismaDatabase["Attributes"]).databaseId).toBe(
        "database-generated",
      );
      expect(
        (fromDev as PrismaDatabase["Attributes"]).directConnectionString,
      ).toBeUndefined();
      expect(
        (fromDev as PrismaDatabase["Attributes"]).password,
      ).toBeUndefined();

      generatedDatabaseRecoveryCloud.calls.length = 0;
      const recovered = yield* provider
        .reconcile({
          id: "Database",
          instanceId,
          news: { project: "project-1", isDefault: false },
          olds: { project: "project-1", isDefault: false },
          output: observed,
          bindings: [],
        } as never)
        .pipe(Effect.provideService(InstanceId, instanceId));
      expect(Redacted.value(recovered.directConnectionString!)).toContain(
        "database-generated",
      );
      expect(generatedDatabaseRecoveryCloud.calls).toContainEqual([
        "rotateConnection",
        "connection-database-generated",
      ]);

      const explicit = {
        ...apiDatabase("database-explicit", {
          projectId: "project-1",
          name: "explicit",
          isDefault: false,
        }),
        connections: [],
      };
      generatedDatabaseRecoveryCloud.databases.set(explicit.id, explicit);
      const adoptionObserved = yield* provider.read!({
        id: "ExplicitDatabase",
        instanceId,
        olds: {
          project: "project-1",
          name: "explicit",
          isDefault: false,
        },
        output: undefined,
      } as never).pipe(Effect.provideService(InstanceId, instanceId));
      expect(Unowned.is(adoptionObserved!)).toBe(true);
      const wrongRegion = yield* provider
        .reconcile({
          id: "ExplicitDatabase",
          instanceId,
          news: {
            project: "project-1",
            name: "explicit",
            region: "us-west-1",
            isDefault: false,
          },
          olds: undefined,
          output: adoptionObserved,
          bindings: [],
        } as never)
        .pipe(Effect.provideService(InstanceId, instanceId), Effect.result);
      expect(Result.isFailure(wrongRegion)).toBe(true);
      if (Result.isFailure(wrongRegion)) {
        expect(String(wrongRegion.failure)).toContain("immutable region");
      }
      const cannotPromoteAdopted = yield* provider
        .reconcile({
          id: "ExplicitDatabase",
          instanceId,
          news: {
            project: "project-1",
            name: "explicit",
            isDefault: true,
          },
          olds: undefined,
          output: adoptionObserved,
          bindings: [],
        } as never)
        .pipe(Effect.provideService(InstanceId, instanceId), Effect.result);
      expect(Result.isFailure(cannotPromoteAdopted)).toBe(true);
      if (Result.isFailure(cannotPromoteAdopted)) {
        expect(String(cannotPromoteAdopted.failure)).toContain(
          "cannot manage a default database",
        );
      }
      const adopted = yield* provider
        .reconcile({
          id: "ExplicitDatabase",
          instanceId,
          news: {
            project: "project-1",
            name: "explicit",
            isDefault: false,
          },
          olds: undefined,
          output: adoptionObserved,
          bindings: [],
        } as never)
        .pipe(Effect.provideService(InstanceId, instanceId));
      expect(adopted.directConnectionString).toBeUndefined();
      expect(
        generatedDatabaseRecoveryCloud.calls.filter(
          ([operation, id]) =>
            operation === "rotateConnection" &&
            id === "connection-database-explicit",
        ),
      ).toEqual([]);

      const adoptedWithRotation = yield* provider
        .reconcile({
          id: "ExplicitDatabase",
          instanceId,
          news: {
            project: "project-1",
            name: "explicit",
            isDefault: false,
            rotateCredentialsOnAdopt: true,
          },
          olds: undefined,
          output: adoptionObserved,
          bindings: [],
        } as never)
        .pipe(Effect.provideService(InstanceId, instanceId));
      expect(
        Redacted.value(adoptedWithRotation.directConnectionString!),
      ).toContain("database-explicit");
      expect(generatedDatabaseRecoveryCloud.calls).toContainEqual([
        "rotateConnection",
        "connection-database-explicit",
      ]);
      generatedDatabaseRecoveryCloud.databases.clear();
      yield* stack.destroy();
    }),
);

it.effect("refuses an undeletable standalone default database", () => {
  let created = false;
  const client = {
    createDatabase: () =>
      Effect.sync(() => {
        created = true;
        throw new Error("must fail before create");
      }),
  } as unknown as PrismaManagementClient;

  return Effect.gen(function* () {
    const provider = yield* PrismaDatabase.Provider;
    const error = yield* provider
      .reconcile({
        id: "Database",
        instanceId: "00000000000000000000000000000000",
        news: {
          project: "project-1",
          name: "primary",
          region: "us-east-1",
          isDefault: true,
        },
        olds: undefined,
        output: undefined,
        bindings: [],
      } as never)
      .pipe(Effect.flip);

    expect(String(error)).toContain("could never be destroyed");
    expect(created).toBe(false);
  }).pipe(
    Effect.provide(DatabaseProvider()),
    Effect.provide(Layer.succeed(PrismaClient, client)),
    Effect.provide(liveProviderContext),
  );
});

const inheritedRegionCloud = makeDatabaseCloud();
const inheritedRegion = Test.make({
  providers: databaseLayer(inheritedRegionCloud.client),
});

inheritedRegion.test.provider(
  "Database region inherit is stable and follows the project default region",
  (stack) =>
    Effect.gen(function* () {
      inheritedRegionCloud.databases.clear();
      yield* stack.destroy();
      inheritedRegionCloud.databases.set(
        "project-default",
        apiDatabase("project-default", {
          projectId: "project-1",
          name: "project-default",
          region: "us-east-1",
          isDefault: true,
        }),
      );

      const first = yield* stack.deploy(
        PrismaDatabase("Database", {
          project: "project-1",
          name: "inherited",
          region: "inherit",
        }),
      );
      expect(first.region).toBe("us-east-1");

      inheritedRegionCloud.calls.length = 0;
      const second = yield* stack.deploy(
        PrismaDatabase("Database", {
          project: "project-1",
          name: "inherited",
          region: "inherit",
        }),
      );
      expect(second.databaseId).toBe(first.databaseId);
      expect(
        inheritedRegionCloud.calls.map(([operation]) => operation),
      ).not.toContain("createDatabase");

      inheritedRegionCloud.databases.set("project-default", {
        ...inheritedRegionCloud.databases.get("project-default")!,
        region: { id: "us-west-1", name: "US West" },
      });
      inheritedRegionCloud.calls.length = 0;
      const moved = yield* stack.deploy(
        PrismaDatabase("Database", {
          project: "project-1",
          name: "inherited",
          region: "inherit",
        }),
      );
      expect(moved.databaseId).not.toBe(first.databaseId);
      expect(moved.region).toBe("us-west-1");
      expect(
        inheritedRegionCloud.calls.map(([operation]) => operation),
      ).toContain("createDatabase");

      yield* stack.destroy();
      inheritedRegionCloud.databases.clear();
    }),
);

const environmentVariable = {
  id: "env-1",
  type: "environment-variable" as const,
  url: "https://api.prisma.test/v1/environment-variables/env-1",
  projectId: "project-1",
  branchId: null,
  class: "production" as const,
  key: "TOKEN",
  valueKid: "kid-1",
  isManagedBySystem: false,
  createdAt,
  updatedAt: createdAt,
};
const environmentSecrets = new Map([[environmentVariable.id, "foreign"]]);
const environmentCalls: Array<[string, unknown?]> = [];
const environmentClient = {
  listEnvironmentVariables: () => Effect.succeed([environmentVariable]),
  getEnvironmentVariable: (id: string) =>
    Effect.succeed({ ...environmentVariable, id }),
  createEnvironmentVariable: () =>
    Effect.fail(
      new PrismaApiError({
        method: "POST",
        path: "/v1/environment-variables",
        status: 409,
        message: "already exists",
      }),
    ),
  updateEnvironmentVariable: (id: string, input: { value: string }) =>
    Effect.sync(() => {
      environmentCalls.push(["updateEnvironmentVariable", { id, input }]);
      environmentSecrets.set(id, input.value);
      return { ...environmentVariable, id };
    }),
  deleteEnvironmentVariable: (id: string) =>
    Effect.sync(() => {
      environmentSecrets.delete(id);
    }),
} as unknown as PrismaManagementClient;
const environmentAdoption = Test.make({
  providers: environmentVariableLayer(environmentClient),
  adopt: true,
});

environmentAdoption.test.provider(
  "adoption and ordinary deploys always converge write-only environment secrets",
  (stack) =>
    Effect.gen(function* () {
      environmentSecrets.clear();
      environmentSecrets.set(environmentVariable.id, "foreign");
      environmentCalls.length = 0;
      yield* stack.destroy();

      const deploy = () =>
        stack.deploy(
          PrismaEnvironmentVariable("Token", {
            project: "project-1",
            class: "production",
            key: "TOKEN",
            value: Redacted.make("desired"),
          }),
        );

      yield* deploy();
      expect(environmentSecrets.get("env-1")).toBe("desired");

      environmentSecrets.set("env-1", "externally-drifted");
      yield* deploy();
      expect(environmentSecrets.get("env-1")).toBe("desired");
      expect(
        environmentCalls.filter(
          ([operation]) => operation === "updateEnvironmentVariable",
        ),
      ).toHaveLength(2);

      yield* stack.destroy();
    }),
);

const customDomainCalls: Array<[string, unknown?]> = [];
const customDomainCloud = new Map<string, ApiCustomDomain>();
let nextCustomDomainId = 1;
const customDomainClient = {
  listAppDomains: (appId: string) =>
    Effect.sync(() => {
      customDomainCalls.push(["listAppDomains", appId]);
      return Array.from(customDomainCloud.values()).filter(
        (domain) => domain.appId === appId,
      );
    }),
  getCustomDomain: (id: string) =>
    Effect.suspend(() => {
      const domain = customDomainCloud.get(id);
      return domain
        ? Effect.succeed(domain)
        : Effect.fail(
            new PrismaApiError({
              method: "GET",
              path: `/v1/domains/${id}`,
              status: 404,
              message: "not found",
            }),
          );
    }),
  getApp: (appId: string) =>
    Effect.sync(() => {
      customDomainCalls.push(["getApp", appId]);
      return {
        id: appId,
        type: "app" as const,
        url: `https://api.prisma.test/v1/apps/${appId}`,
        name: "api",
        region: { id: "us-east-1", name: "US East" },
        projectId: "project-1",
        branchId: "branch-1",
        latestDeploymentId: null,
        appEndpointDomain: "api.prisma.build",
        createdAt,
      };
    }),
  getBranch: (branchId: string) =>
    Effect.succeed({
      id: branchId,
      type: "branch" as const,
      url: `https://api.prisma.test/v1/branches/${branchId}`,
      gitName: "main",
      isDefault: true,
      role: "production" as const,
      createdAt,
      updatedAt: createdAt,
      project: {
        id: "project-1",
        url: "https://api.prisma.test/v1/projects/project-1",
        name: "app",
      },
    }),
  createAppDomain: (appId: string, input: { hostname: string }) =>
    Effect.sync(() => {
      customDomainCalls.push(["createAppDomain", { appId, input }]);
      const id = `domain-${nextCustomDomainId++}`;
      const domain: ApiCustomDomain = {
        id,
        type: "custom-domain" as const,
        url: `https://api.prisma.test/v1/domains/${id}`,
        hostname: input.hostname,
        appId,
        status: "pending_dns" as const,
        foundryStatus: "pending",
        failureReason: null,
        failureCategory: null,
        certExpiresAt: null,
        dnsRecords: [
          {
            type: "CNAME" as const,
            name: input.hostname,
            value: "api.prisma.build",
            ttl: null,
          },
        ],
        createdAt,
        updatedAt: createdAt,
      };
      customDomainCloud.set(id, domain);
      return { status: 201 as const, domain };
    }),
  retryCustomDomain: (id: string) =>
    Effect.sync(() => {
      customDomainCalls.push(["retryCustomDomain", id]);
      const domain = customDomainCloud.get(id)!;
      const retried: ApiCustomDomain = {
        ...domain,
        status: "verifying",
        foundryStatus: "provisioning",
        failureReason: null,
        failureCategory: null,
        updatedAt: createdAt,
      };
      customDomainCloud.set(id, retried);
      return retried;
    }),
  deleteCustomDomain: (id: string) =>
    Effect.sync(() => {
      customDomainCalls.push(["deleteCustomDomain", id]);
      customDomainCloud.delete(id);
    }),
} as unknown as PrismaManagementClient;
const customDomains = Test.make({
  providers: customDomainLayer(customDomainClient),
});

customDomains.test.provider(
  "custom domains use the canonical App API and exact status fields",
  (stack) =>
    Effect.gen(function* () {
      customDomainCalls.length = 0;
      customDomainCloud.clear();
      nextCustomDomainId = 1;
      yield* stack.destroy();

      const domain = yield* stack.deploy(
        PrismaCustomDomain("Domain", {
          app: {
            appId: Output.asOutput("app-1"),
          } as unknown as App,
          hostname: "NEW.EXAMPLE.COM.",
        }),
      );

      expect(domain.appId).toBe("app-1");
      expect(domain.hostname).toBe("new.example.com");
      expect(domain.foundryStatus).toBe("pending");
      expect(customDomainCalls).toContainEqual(["listAppDomains", "app-1"]);
      expect(customDomainCalls).toContainEqual([
        "createAppDomain",
        { appId: "app-1", input: { hostname: "new.example.com" } },
      ]);

      const replacement = domain;

      customDomainCloud.set(replacement.customDomainId, {
        ...customDomainCloud.get(replacement.customDomainId)!,
        status: "failed",
        foundryStatus: "failed",
        failureReason: "DNS verification failed",
        failureCategory: "dns",
      });
      const provider = yield* PrismaCustomDomain.Provider;
      const failed = yield* provider.read!({
        id: "Domain",
        instanceId: "00000000000000000000000000000000",
        olds: { app: "app-1", hostname: "new.example.com" },
        output: replacement,
      } as never);
      const failedDiff = yield* provider.diff!({
        id: "Domain",
        instanceId: "00000000000000000000000000000000",
        olds: { app: "app-1", hostname: "new.example.com" },
        news: { app: "app-1", hostname: "new.example.com" },
        output: failed,
        oldBindings: [],
        newBindings: [],
      } as never);
      expect(failedDiff).toEqual({ action: "update" });
      const activeDiff = yield* provider.diff!({
        id: "Domain",
        instanceId: "00000000000000000000000000000000",
        olds: { app: "app-1", hostname: "new.example.com" },
        news: { app: "app-1", hostname: "new.example.com" },
        output: { ...replacement, status: "active" },
        oldBindings: [],
        newBindings: [],
      } as never);
      expect(activeDiff).toBeUndefined();
      customDomainCalls.length = 0;
      const retried = yield* provider.reconcile({
        id: "Domain",
        instanceId: "00000000000000000000000000000000",
        news: { app: "app-1", hostname: "new.example.com" },
        olds: { app: "app-1", hostname: "new.example.com" },
        output: failed,
        bindings: [],
      } as never);
      expect(retried.customDomainId).toBe(replacement.customDomainId);
      expect(retried.status).toBe("verifying");
      expect(customDomainCalls).toContainEqual([
        "retryCustomDomain",
        replacement.customDomainId,
      ]);
      expect(
        customDomainCalls.filter(
          ([operation]) => operation === "retryCustomDomain",
        ),
      ).toHaveLength(1);
      const moveDiff = yield* provider.diff!({
        id: "Domain",
        instanceId: "00000000000000000000000000000000",
        olds: { app: "app-1", hostname: "new.example.com" },
        news: { app: "app-2", hostname: "new.example.com" },
        output: retried,
        oldBindings: [],
        newBindings: [],
      } as never).pipe(Effect.result);
      expect(Result.isFailure(moveDiff)).toBe(true);
      if (Result.isFailure(moveDiff)) {
        expect(String(moveDiff.failure)).toContain("cannot atomically replace");
      }
      const hostnameDiff = yield* provider.diff!({
        id: "Domain",
        instanceId: "00000000000000000000000000000000",
        olds: { app: "app-1", hostname: "new.example.com" },
        news: { app: "app-1", hostname: "other.example.com" },
        output: retried,
        oldBindings: [],
        newBindings: [],
      } as never).pipe(Effect.result);
      expect(Result.isFailure(hostnameDiff)).toBe(true);

      const mismatch = yield* provider
        .reconcile({
          id: "Domain",
          instanceId: "00000000000000000000000000000000",
          news: { app: "app-2", hostname: "new.example.com" },
          olds: { app: "app-1", hostname: "new.example.com" },
          output: retried,
          bindings: [],
        } as never)
        .pipe(Effect.result);
      expect(Result.isFailure(mismatch)).toBe(true);

      yield* stack.destroy();
    }),
);

const sourceRepositoryCloud = new Map<string, ApiSourceRepository>();
const sourceRepositoryCalls: Array<[string, unknown?]> = [];
let nextSourceRepositoryId = 1;
const sourceRepositoryClient = {
  listProjects: () =>
    Effect.succeed([
      apiProject("project-1", "one", null),
      apiProject("project-2", "two", null),
    ]),
  listSourceRepositories: ({ projectId }: { projectId: string }) =>
    Effect.succeed(
      Array.from(sourceRepositoryCloud.values()).filter(
        (repository) =>
          repository.projectId === projectId && repository.status === "active",
      ),
    ),
  listApps: () => Effect.succeed([]),
  listProjectDatabases: () => Effect.succeed([]),
  listBranches: (projectId: string) =>
    Effect.succeed([
      {
        id: `branch-${projectId}`,
        type: "branch" as const,
        url: `https://api.prisma.test/v1/branches/branch-${projectId}`,
        gitName: "main",
        isDefault: true,
        role: "production" as const,
        createdAt,
        updatedAt: createdAt,
        project: {
          id: projectId,
          url: `https://api.prisma.test/v1/projects/${projectId}`,
          name: projectId,
        },
      },
    ]),
  getSourceRepository: (id: string) =>
    Effect.suspend(() => {
      const repository = sourceRepositoryCloud.get(id);
      return repository?.status === "active"
        ? Effect.succeed(repository)
        : Effect.fail(
            new PrismaApiError({
              method: "GET",
              path: `/v1/source-repositories/${id}`,
              status: 404,
              message: "not found",
            }),
          );
    }),
  createSourceRepository: (input: {
    projectId: string;
    provider: "github";
    providerRepositoryId: number;
    installationId?: string;
  }) =>
    Effect.suspend(() => {
      sourceRepositoryCalls.push(["createSourceRepository", input]);
      const conflict = Array.from(sourceRepositoryCloud.values()).some(
        (repository) =>
          repository.status === "active" &&
          (repository.projectId === input.projectId ||
            repository.repoId === input.providerRepositoryId),
      );
      if (conflict) {
        return Effect.fail(
          new PrismaApiError({
            method: "POST",
            path: "/v1/source-repositories",
            status: 409,
            message: "already linked",
          }),
        );
      }
      const id = `source-${nextSourceRepositoryId++}`;
      const repository: ApiSourceRepository = {
        id,
        type: "source-repository",
        url: `https://api.prisma.test/v1/source-repositories/${id}`,
        repoId: input.providerRepositoryId,
        provider: input.provider,
        repoFullName: `owner/repo-${input.providerRepositoryId}`,
        defaultBranch: "main",
        isPrivate: false,
        status: "active",
        projectId: input.projectId,
        installationId: input.installationId ?? "installation-auto",
        createdAt,
        updatedAt: createdAt,
      };
      sourceRepositoryCloud.set(id, repository);
      return Effect.succeed(repository);
    }),
  deleteSourceRepository: (id: string) =>
    Effect.sync(() => {
      sourceRepositoryCalls.push(["deleteSourceRepository", id]);
      const repository = sourceRepositoryCloud.get(id);
      if (repository) {
        sourceRepositoryCloud.set(id, {
          ...repository,
          status: "archived",
        });
      }
    }),
} as unknown as PrismaManagementClient;
const sourceRepositories = Test.make({
  providers: sourceRepositoryLayer(sourceRepositoryClient),
});

sourceRepositories.test.provider(
  "source repository links reject non-atomic relinks without mutating the live link",
  (stack) =>
    Effect.gen(function* () {
      sourceRepositoryCloud.clear();
      sourceRepositoryCalls.length = 0;
      nextSourceRepositoryId = 1;
      yield* stack.destroy();

      const first = yield* stack.deploy(
        PrismaSourceRepository("Repository", {
          project: "project-1",
          providerRepositoryId: 123,
        }),
      );
      sourceRepositoryCalls.length = 0;
      const relink = yield* stack
        .deploy(
          PrismaSourceRepository("Repository", {
            project: "project-2",
            providerRepositoryId: 456,
          }),
        )
        .pipe(Effect.result);
      expect(Result.isFailure(relink)).toBe(true);
      if (Result.isFailure(relink)) {
        expect(String(relink.failure)).toContain(
          "cannot be replaced atomically",
        );
      }
      expect(sourceRepositoryCalls).toEqual([]);
      expect(sourceRepositoryCloud.get(first.sourceRepositoryId)?.status).toBe(
        "active",
      );

      const provider = yield* PrismaSourceRepository.Provider;
      const archivedDiff = yield* provider.diff!({
        id: "Repository",
        instanceId: "00000000000000000000000000000000",
        olds: { project: "project-1", providerRepositoryId: 123 },
        news: { project: "project-1", providerRepositoryId: 123 },
        output: { ...first, status: "archived" as const },
        oldBindings: [],
        newBindings: [],
      } as never).pipe(Effect.result);
      expect(Result.isFailure(archivedDiff)).toBe(true);

      yield* stack.destroy();
      expect(sourceRepositoryCloud.get(first.sourceRepositoryId)?.status).toBe(
        "archived",
      );
    }),
);

const branchCloud = new Map<string, ApiBranch>();
const branchCalls: Array<[string, unknown?]> = [];
let nextBranchId = 1;
const branchClient = {
  listProjects: () => Effect.succeed([apiProject("project-1", "app")]),
  listBranches: (_projectId: string, query?: { gitName?: string }) =>
    Effect.succeed(
      Array.from(branchCloud.values()).filter(
        (branch) =>
          query?.gitName === undefined || branch.gitName === query.gitName,
      ),
    ),
  getBranch: (id: string) => Effect.succeed(branchCloud.get(id)!),
  createBranch: (
    projectId: string,
    input: { gitName: string; isDefault?: boolean },
  ) =>
    Effect.sync(() => {
      branchCalls.push(["createBranch", { projectId, input }]);
      const first = branchCloud.size === 0;
      const makeDefault = first || input.isDefault === true;
      if (makeDefault) {
        for (const [id, branch] of branchCloud) {
          branchCloud.set(id, { ...branch, isDefault: false });
        }
      }
      const id = `branch-${nextBranchId++}`;
      const branch = {
        id,
        type: "branch" as const,
        url: `https://api.prisma.test/v1/branches/${id}`,
        gitName: input.gitName,
        isDefault: makeDefault,
        role: first ? ("production" as const) : ("preview" as const),
        createdAt,
        updatedAt: createdAt,
        project: {
          id: projectId,
          url: `https://api.prisma.test/v1/projects/${projectId}`,
          name: "app",
        },
      };
      branchCloud.set(id, branch);
      return branch;
    }),
  updateBranch: (id: string, input: { isDefault?: boolean | null }) =>
    Effect.sync(() => {
      branchCalls.push(["updateBranch", { id, input }]);
      if (input.isDefault !== true) {
        throw new Error("the Management API rejects default demotion");
      }
      for (const [branchId, branch] of branchCloud) {
        branchCloud.set(branchId, {
          ...branch,
          isDefault: branchId === id,
        });
      }
      return branchCloud.get(id)!;
    }),
  deleteBranch: (id: string) =>
    Effect.sync(() => {
      branchCalls.push(["deleteBranch", id]);
      branchCloud.delete(id);
    }),
} as unknown as PrismaManagementClient;
const branches = Test.make({ providers: branchLayer(branchClient) });

branches.test.provider(
  "branch promotion persists and restores the displaced default on destroy",
  (stack) =>
    Effect.gen(function* () {
      branchCloud.clear();
      branchCalls.length = 0;
      nextBranchId = 1;
      yield* stack.destroy();

      const main: ApiBranch = {
        id: "branch-main",
        type: "branch",
        url: "https://api.prisma.test/v1/branches/branch-main",
        gitName: "main",
        isDefault: true,
        role: "production",
        createdAt,
        updatedAt: createdAt,
        project: {
          id: "project-1",
          url: "https://api.prisma.test/v1/projects/project-1",
          name: "app",
        },
      };
      branchCloud.set(main.id, main);

      const preview = yield* stack.deploy(
        PrismaBranch("Preview", {
          project: "project-1",
          gitName: "preview",
          isDefault: true,
        }),
      );
      expect(preview.isDefault).toBe(true);
      expect(preview.role).toBe("preview");
      expect(preview.previousDefaultBranchId).toBe(main.id);
      expect(branchCloud.get(main.id)?.isDefault).toBe(false);
      expect(branchCloud.get(main.id)?.role).toBe("production");

      const provider = yield* PrismaBranch.Provider;
      const alreadyDefaultDiff = yield* provider.diff!({
        id: "Preview",
        instanceId: "00000000000000000000000000000000",
        olds: {
          project: "project-1",
          gitName: "preview",
          isDefault: true,
        },
        news: {
          project: "project-1",
          gitName: "preview",
          isDefault: true,
        },
        output: preview,
        oldBindings: [],
        newBindings: [],
      } as never);
      expect(alreadyDefaultDiff).toBeUndefined();

      // A different API client can promote another branch, atomically
      // demoting the desired default. The next deploy must observe and heal it
      // even though desired props did not change.
      branchCloud.set(main.id, {
        ...branchCloud.get(main.id)!,
        isDefault: true,
      });
      branchCloud.set(preview.branchId, {
        ...branchCloud.get(preview.branchId)!,
        isDefault: false,
      });
      branchCalls.length = 0;
      const observed = yield* provider.read!({
        id: "Preview",
        instanceId: "00000000000000000000000000000000",
        olds: {
          project: "project-1",
          gitName: "preview",
          isDefault: true,
        },
        output: preview,
      } as never);
      const driftDiff = yield* provider.diff!({
        id: "Preview",
        instanceId: "00000000000000000000000000000000",
        olds: {
          project: "project-1",
          gitName: "preview",
          isDefault: true,
        },
        news: {
          project: "project-1",
          gitName: "preview",
          isDefault: true,
        },
        output: observed,
        oldBindings: [],
        newBindings: [],
      } as never);
      expect(driftDiff).toEqual({ action: "update" });
      yield* provider.reconcile({
        id: "Preview",
        instanceId: "00000000000000000000000000000000",
        news: {
          project: "project-1",
          gitName: "preview",
          isDefault: true,
        },
        olds: {
          project: "project-1",
          gitName: "preview",
          isDefault: true,
        },
        output: observed,
        bindings: [],
      } as never);
      expect(branchCloud.get(preview.branchId)?.isDefault).toBe(true);
      expect(branchCalls).toContainEqual([
        "updateBranch",
        { id: preview.branchId, input: { isDefault: true } },
      ]);
      expect(yield* provider.list()).toEqual([]);
      branchCalls.length = 0;
      yield* stack.destroy();
      expect(branchCloud.get(main.id)?.isDefault).toBe(true);
      expect(branchCloud.has(preview.branchId)).toBe(false);
      expect(branchCalls).toContainEqual([
        "updateBranch",
        { id: main.id, input: { isDefault: true } },
      ]);
      expect(branchCalls).toContainEqual(["deleteBranch", preview.branchId]);

      branchCloud.clear();
      branchCalls.length = 0;
      const firstBranch = yield* provider
        .reconcile({
          id: "UnsafeFirst",
          instanceId: "00000000000000000000000000000000",
          news: {
            project: "project-1",
            gitName: "main",
            isDefault: false,
          },
          olds: undefined,
          output: undefined,
          bindings: [],
        } as never)
        .pipe(Effect.result);
      expect(Result.isFailure(firstBranch)).toBe(true);
      if (Result.isFailure(firstBranch)) {
        expect(String(firstBranch.failure)).toContain(
          "undeletable production branch",
        );
      }
      expect(branchCalls.map(([operation]) => operation)).not.toContain(
        "createBranch",
      );
    }),
);
