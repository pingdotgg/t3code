import { Unowned } from "@/AdoptPolicy";
import { InstanceId } from "@/InstanceId";
import { Branch as PrismaBranch, BranchProvider } from "@/Prisma/Branch";
import {
  PrismaApiError,
  PrismaClient,
  type DatabaseCreateResult,
} from "@/Prisma/Client";
import { Compute as PrismaCompute } from "@/Prisma/Compute";
import { App as PrismaApp, AppProvider } from "@/Prisma/App";
import {
  Deployment as PrismaDeployment,
  DeploymentProvider,
} from "@/Prisma/Deployment";
import { Connect, ConnectBinding, connectEnvKeys } from "@/Prisma/Connect";
import {
  Connection as PrismaConnection,
  ConnectionProvider,
} from "@/Prisma/Connection";
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
import { Providers as PrismaProviderCollection } from "@/Prisma/Providers";
import {
  SourceRepository as PrismaSourceRepository,
  SourceRepositoryProvider,
} from "@/Prisma/SourceRepository";
import * as Output from "@/Output";
import type { PrismaManagementClient } from "@/Prisma/Client";
import type { Database as ApiDatabase } from "@/Prisma/Types";
import { RuntimeContext } from "@/RuntimeContext";
import { Self } from "@/Self";
import { Stack, type StackSpec } from "@/Stack";
import { inMemoryState } from "@/State/InMemoryState";
import { Stage } from "@/Stage";
import { describe, expect, it } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { AlchemyContext } from "@/AlchemyContext";

type Call = [operation: string, input?: unknown];
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

const createdAt = "2026-01-01T00:00:00Z";
const updatedAt = "2026-01-01T00:00:01Z";

const redactedValue = (
  value: string | Redacted.Redacted<string> | undefined,
) => {
  if (!Redacted.isRedacted(value)) {
    throw new Error("Expected a redacted value");
  }
  return Redacted.value(value);
};

const expectJsonNotToContain = (value: unknown, ...secrets: string[]) => {
  const json = JSON.stringify(value);
  for (const secret of secrets) {
    expect(json).not.toContain(secret);
  }
};

const resourceRef = (kind: string, id: string, name = id) => ({
  id,
  url: `https://api.prisma.test/v1/${kind}/${id}`,
  name,
});

const databaseConnection = (
  databaseId: string,
  connectionId = `connection-${databaseId}`,
) => ({
  id: connectionId,
  type: "connection" as const,
  url: `https://api.prisma.test/v1/connections/${connectionId}`,
  name: "default",
  createdAt,
  kind: "postgres" as const,
  endpoints: {
    direct: {
      host: "db.prisma.test",
      port: 5432,
      connectionString: `postgres://user:password@db.prisma.test/${databaseId}`,
    },
  },
  database: resourceRef("databases", databaseId),
});

const makeClient = () => {
  const calls: Call[] = [];
  const client = {
    listProjects: () => {
      calls.push(["listProjects"]);
      return Effect.succeed([]);
    },
    createProject: (input: unknown) => {
      calls.push(["createProject", input]);
      return Effect.succeed({
        id: "project-1",
        type: "project",
        url: "https://api.prisma.test/v1/projects/project-1",
        name: "app",
        createdAt,
        defaultRegion: "us-east-1",
        workspace: resourceRef("workspaces", "workspace-1", "team"),
        database: null,
      });
    },
    listProjectDatabases: (projectId: string, query: unknown) => {
      calls.push(["listProjectDatabases", { projectId, query }]);
      return Effect.succeed([]);
    },
    createDatabase: (input: unknown) => {
      calls.push(["createDatabase", input]);
      return Effect.succeed({
        id: "database-1",
        type: "database",
        url: "https://api.prisma.test/v1/databases/database-1",
        name: "main",
        status: "ready",
        createdAt,
        isDefault: false,
        defaultConnectionId: "connection-1",
        connections: [
          {
            id: "connection-1",
            type: "connection",
            url: "https://api.prisma.test/v1/connections/connection-1",
            name: "default",
            createdAt,
            kind: "postgres",
            endpoints: {
              direct: {
                host: "db.prisma.test",
                port: 5432,
                connectionString: "postgres://direct",
              },
              pooled: {
                host: "pool.prisma.test",
                port: 5432,
                connectionString: "postgres://pooled",
              },
            },
            database: resourceRef("databases", "database-1", "main"),
          },
        ],
        project: resourceRef("projects", "project-1", "app"),
        region: { id: "us-east-1", name: "US East" },
        source: { type: "empty" },
        branchId: null,
      });
    },
    listDatabaseConnections: (databaseId: string, query: unknown) => {
      calls.push(["listDatabaseConnections", { databaseId, query }]);
      return Effect.succeed([]);
    },
    createConnection: (input: unknown) => {
      calls.push(["createConnection", input]);
      return Effect.succeed({
        id: "connection-2",
        type: "connection",
        url: "https://api.prisma.test/v1/connections/connection-2",
        name: "api",
        createdAt,
        kind: "postgres",
        endpoints: {
          direct: {
            host: "db.prisma.test",
            port: 5432,
            connectionString: "postgres://api-direct",
          },
        },
        database: resourceRef("databases", "database-1", "main"),
      });
    },
    listBranches: (projectId: string, query: unknown) => {
      calls.push(["listBranches", { projectId, query }]);
      const gitName = (query as { gitName?: string } | undefined)?.gitName;
      return Effect.succeed(
        gitName !== undefined && gitName !== "main"
          ? []
          : [
              {
                id: "branch-1",
                type: "branch",
                url: "https://api.prisma.test/v1/branches/branch-1",
                gitName: "main",
                isDefault: true,
                role: "production",
                createdAt,
                updatedAt,
                project: resourceRef("projects", "project-1", "app"),
              },
            ],
      );
    },
    getBranch: (id: string) => {
      calls.push(["getBranch", id]);
      return Effect.succeed({
        id,
        type: "branch",
        url: `https://api.prisma.test/v1/branches/${id}`,
        gitName: "main",
        isDefault: true,
        role: "production",
        createdAt,
        updatedAt,
        project: resourceRef("projects", "project-1", "app"),
      });
    },
    createBranch: (
      projectId: string,
      input: { gitName: string; isDefault?: boolean },
    ) => {
      calls.push(["createBranch", { projectId, input }]);
      return Effect.succeed({
        id: "branch-2",
        type: "branch",
        url: "https://api.prisma.test/v1/branches/branch-2",
        gitName: input.gitName,
        isDefault: input.isDefault ?? false,
        role: "preview",
        createdAt,
        updatedAt,
        project: resourceRef("projects", "project-1", "app"),
      });
    },
    listApps: (query: unknown) => {
      calls.push(["listApps", query]);
      return Effect.succeed([]);
    },
    createApp: (input: { projectId: string }) => {
      calls.push(["createApp", input]);
      return Effect.succeed({
        id: "service-1",
        type: "app",
        url: "https://api.prisma.test/v1/apps/service-1",
        name: "api",
        region: { id: "us-east-1", name: "US East" },
        projectId: "project-1",
        branchId: "branch-1",
        latestDeploymentId: null,
        appEndpointDomain: "service-1.prisma.build",
        createdAt,
      });
    },
    getApp: (id: string) => {
      calls.push(["getApp", id]);
      return Effect.succeed({
        id,
        type: "app",
        url: `https://api.prisma.test/v1/apps/${id}`,
        name: "api",
        region: { id: "us-east-1", name: "US East" },
        projectId: "project-1",
        branchId: "branch-1",
        latestDeploymentId: "version-1",
        appEndpointDomain: "service-1.prisma.build",
        createdAt,
      });
    },
    createAppDeployment: (appId: string, input: unknown) => {
      calls.push(["createAppDeployment", { appId, input }]);
      return Effect.succeed({
        id: "version-1",
        type: "deployment",
        url: "https://api.prisma.test/v1/deployments/version-1",
        foundryVersionId: "foundry-1",
        uploadUrl: null,
      });
    },
    listAppDomains: (appId: string) => {
      calls.push(["listAppDomains", appId]);
      return Effect.succeed([]);
    },
    createAppDomain: (appId: string, input: unknown) => {
      calls.push(["createAppDomain", { appId, input }]);
      return Effect.succeed({
        status: 201 as const,
        domain: {
          id: "domain-1",
          type: "custom-domain" as const,
          url: "https://api.prisma.test/v1/domains/domain-1",
          hostname: "api.example.com",
          appId: appId,
          status: "pending_dns" as const,
          foundryStatus: "pending_dns",
          failureReason: null,
          failureCategory: null,
          certExpiresAt: null,
          dnsRecords: [
            {
              type: "CNAME" as const,
              name: "api.example.com",
              value: "service-1.prisma.build",
              ttl: null,
            },
          ],
          createdAt,
          updatedAt,
        },
      });
    },
    getDeployment: (id: string) => {
      calls.push(["getDeployment", id]);
      return Effect.succeed({
        id,
        type: "deployment",
        url: `https://api.prisma.test/v1/deployments/${id}`,
        foundryVersionId: "foundry-1",
        status: "new",
        previewDomain: null,
        createdAt,
      });
    },
    listEnvironmentVariables: (query: unknown) => {
      calls.push(["listEnvironmentVariables", query]);
      return Effect.succeed([]);
    },
    createEnvironmentVariable: (input: unknown) => {
      calls.push(["createEnvironmentVariable", input]);
      return Effect.succeed({
        id: "env-1",
        type: "environment-variable",
        url: "https://api.prisma.test/v1/environment-variables/env-1",
        projectId: "project-1",
        branchId: null,
        class: "production",
        key: "TOKEN",
        valueKid: "kid-1",
        isManagedBySystem: false,
        createdAt,
        updatedAt,
      });
    },
    listSourceRepositories: (query: unknown) => {
      calls.push(["listSourceRepositories", query]);
      return Effect.succeed([]);
    },
    createSourceRepository: (input: unknown) => {
      calls.push(["createSourceRepository", input]);
      return Effect.succeed({
        id: "repo-1",
        type: "source-repository",
        url: "https://api.prisma.test/v1/source-repositories/repo-1",
        repoId: 123,
        provider: "github",
        repoFullName: "acme/api",
        defaultBranch: "main",
        isPrivate: true,
        status: "active",
        projectId: "project-1",
        installationId: "installation-1",
        createdAt,
        updatedAt,
      });
    },
    getSourceRepository: (id: string) => {
      calls.push(["getSourceRepository", id]);
      return Effect.succeed({
        id,
        type: "source-repository",
        url: `https://api.prisma.test/v1/source-repositories/${id}`,
        repoId: 123,
        provider: "github",
        repoFullName: "acme/api",
        defaultBranch: "main",
        isPrivate: true,
        status: "active",
        projectId: "project-1",
        installationId: "installation-1",
        createdAt,
        updatedAt,
      });
    },
  } as unknown as PrismaManagementClient;
  return { client, calls };
};

const liveProviderContext = Layer.succeed(AlchemyContext, {
  dotAlchemy: ".alchemy-test",
  dev: false,
  adopt: false,
});

const providerLayer = (client: PrismaManagementClient) =>
  Layer.mergeAll(
    ProjectProvider(),
    DatabaseProvider(),
    ConnectionProvider(),
    BranchProvider(),
    AppProvider(),
    DeploymentProvider(),
    CustomDomainProvider(),
    EnvironmentVariableProvider(),
    SourceRepositoryProvider(),
  ).pipe(
    Layer.provide(Layer.succeed(PrismaClient, client)),
    Layer.provide(liveProviderContext),
  );

const reconcileInput = <Props, Attrs>(
  id: string,
  news: Props,
  output?: Attrs,
  olds?: Props,
) => ({
  id,
  fqn: id,
  instanceId: "00000000000000000000000000000000",
  news,
  olds,
  output,
  session: undefined as never,
  bindings: [],
});

const deleteInput = (id: string, output: unknown) =>
  ({
    id,
    fqn: id,
    instanceId: "00000000000000000000000000000000",
    olds: {} as never,
    output,
    session: undefined as never,
    bindings: [],
  }) as never;

const readInput = <Props, Attrs>(id: string, olds: Props, output?: Attrs) =>
  ({
    id,
    fqn: id,
    instanceId: "00000000000000000000000000000000",
    olds,
    output,
  }) as never;

const diffInput = <Props, Attrs>(olds: Props, news: Props, output?: Attrs) =>
  ({
    id: "Resource",
    fqn: "Resource",
    instanceId: "00000000000000000000000000000000",
    olds,
    news,
    oldBindings: [],
    newBindings: [],
    output,
  }) as never;

describe("Prisma resource providers", () => {
  it("derives namespaced-safe env keys for connection bindings", () => {
    expect(
      connectEnvKeys({
        FQN: "Connection",
        LogicalId: "Connection",
      }).directConnectionString,
    ).toBe("PRISMA_CONNECTION_DIRECT_CONNECTION_STRING");
    expect(
      connectEnvKeys({
        FQN: "Api/Connection",
        LogicalId: "Connection",
      }).directConnectionString,
    ).toBe("PRISMA_API_CONNECTION_DIRECT_CONNECTION_STRING");
  });

  it.effect(
    "ConnectBinding resolves bound connection outputs at runtime",
    () => {
      const stored: Record<string, Output.Output> = {};
      let capturedBindingEnv: Record<string, Output.Output> | undefined;
      const runtime = {
        Type: "Prisma.Compute",
        id: "App",
        env: stored,
        set: (id: string, output: Output.Output) =>
          Effect.sync(() => {
            const key = id.replaceAll(/[^a-zA-Z0-9]/g, "_");
            stored[key] = output;
            return key;
          }),
        get: <T>(key: string): Effect.Effect<T> => {
          const output = stored[key];
          if (!output) return Effect.die(`missing runtime binding ${key}`);
          return Output.evaluate(output, {}) as Effect.Effect<T>;
        },
      };
      const host = {
        Type: "Prisma.Compute",
        LogicalId: "App",
        FQN: "App",
        bind: (...args: unknown[]) =>
          args[0] instanceof Array
            ? (binding: { env?: Record<string, Output.Output> }) =>
                Effect.sync(() => {
                  capturedBindingEnv = binding.env;
                })
            : Effect.void,
      };
      const escapedPooledConnectionString =
        "__ALCHEMY_PRISMA_CONNECTION_VALUE__:prisma://pooled";
      const connection = {
        Type: "Prisma.Connection",
        LogicalId: "Connection",
        FQN: "Api/Connection",
        connectionId: Output.asOutput("connection-1"),
        databaseId: Output.asOutput("database-1"),
        directConnectionString: Output.asOutput(
          Redacted.make("postgres://direct"),
        ),
        pooledConnectionString: Output.asOutput(
          Redacted.make(escapedPooledConnectionString),
        ),
        accelerateConnectionString: Output.asOutput(undefined),
        host: Output.asOutput("db.example.test"),
        user: Output.asOutput(null),
        password: Output.asOutput(Redacted.make("password")),
      } as PrismaConnection;

      return Effect.gen(function* () {
        const db = yield* Connect(connection);
        const keys = connectEnvKeys(connection);
        const encodedEnv = yield* Output.evaluate(
          capturedBindingEnv ?? {},
          {},
        ) as Effect.Effect<Record<string, unknown>>;

        expect(Object.keys(stored)).toEqual([]);
        expect(encodedEnv[keys.accelerateConnectionString]).toEqual(
          expect.any(String),
        );
        expect(encodedEnv[keys.user]).toEqual(expect.any(String));
        expect(yield* db.connectionId).toBe("connection-1");
        expect(Redacted.value(yield* db.databaseUrl)).toBe(
          escapedPooledConnectionString,
        );
        expect(Redacted.value((yield* db.directConnectionString)!)).toBe(
          "postgres://direct",
        );
        expect(Redacted.value((yield* db.pooledConnectionString)!)).toBe(
          escapedPooledConnectionString,
        );
        expect(yield* db.accelerateConnectionString).toBeUndefined();
        expect(yield* db.user).toBeNull();
        expect(Redacted.value((yield* db.password)!)).toBe("password");
        expect(Object.keys(stored)).toEqual(
          expect.arrayContaining([
            "PRISMA_API_CONNECTION_CONNECTION_ID",
            "PRISMA_API_CONNECTION_DIRECT_CONNECTION_STRING",
            "PRISMA_API_CONNECTION_POOLED_CONNECTION_STRING",
            "PRISMA_API_CONNECTION_ACCELERATE_CONNECTION_STRING",
            "PRISMA_API_CONNECTION_USER",
            "PRISMA_API_CONNECTION_PASSWORD",
          ]),
        );
      }).pipe(
        Effect.provide(ConnectBinding),
        Effect.provide(Layer.succeed(RuntimeContext, runtime)),
        Effect.provide(Layer.succeed(Self, host)),
        Effect.provide(
          Layer.succeed(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({ ALCHEMY_PHASE: "runtime" }),
          ),
        ),
      );
    },
  );

  it.effect(
    "ConnectBinding does not require the deploy-time host at runtime",
    () => {
      const stored: Record<string, Output.Output> = {};
      const runtime = {
        Type: "Prisma.Compute",
        id: "App",
        env: stored,
        set: (id: string, output: Output.Output) =>
          Effect.sync(() => {
            const key = id.replaceAll(/[^a-zA-Z0-9]/g, "_");
            stored[key] = output;
            return key;
          }),
        get: <T>(key: string): Effect.Effect<T> => {
          const output = stored[key];
          if (!output) return Effect.die(`missing runtime binding ${key}`);
          return Output.evaluate(output, {}) as Effect.Effect<T>;
        },
      };
      const connection = {
        Type: "Prisma.Connection",
        LogicalId: "Connection",
        FQN: "Connection",
        connectionId: Output.asOutput("connection-1"),
        databaseId: Output.asOutput("database-1"),
        directConnectionString: Output.asOutput(
          Redacted.make("postgres://runtime"),
        ),
        pooledConnectionString: Output.asOutput(undefined),
        accelerateConnectionString: Output.asOutput(undefined),
        host: Output.asOutput("db.example.test"),
        user: Output.asOutput("api"),
        password: Output.asOutput(Redacted.make("password")),
      } as PrismaConnection;

      // The deploy-time host dispatch is guarded by `__ALCHEMY_RUNTIME__`,
      // which bundles fold to `true` — simulate that so no Self is needed.
      const wasRuntime = globalThis.__ALCHEMY_RUNTIME__;
      globalThis.__ALCHEMY_RUNTIME__ = true;
      return Effect.gen(function* () {
        const db = yield* Connect(connection);

        expect(yield* db.connectionId).toBe("connection-1");
        expect(Redacted.value(yield* db.databaseUrl)).toBe(
          "postgres://runtime",
        );
      }).pipe(
        Effect.provide(ConnectBinding),
        Effect.provide(Layer.succeed(RuntimeContext, runtime)),
        Effect.provide(
          Layer.succeed(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({ ALCHEMY_PHASE: "runtime" }),
          ),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            globalThis.__ALCHEMY_RUNTIME__ = wasRuntime;
          }),
        ),
      );
    },
  );

  it.effect(
    "Prisma.Compute records Connection.bind env on platform bindings",
    () => {
      const stack: Omit<StackSpec, "output"> = {
        name: "prisma-compute-binding-test",
        stage: "test",
        resources: {},
        bindings: {},
        actions: {},
      };
      const connection = {
        Type: "Prisma.Connection",
        LogicalId: "Connection",
        FQN: "Api/Connection",
        connectionId: Output.asOutput("connection-1"),
        databaseId: Output.asOutput("database-1"),
        directConnectionString: Output.asOutput(
          Redacted.make("postgres://api"),
        ),
        pooledConnectionString: Output.asOutput(
          Redacted.make("prisma+postgres://api"),
        ),
        accelerateConnectionString: Output.asOutput(undefined),
        host: Output.asOutput("db.example.test"),
        user: Output.asOutput("api"),
        password: Output.asOutput(Redacted.make("password")),
      } as PrismaConnection;

      return Effect.gen(function* () {
        const app = yield* PrismaCompute(
          "App",
          {
            project: "project-1",
            appName: "api",
            main: "app.ts",
          },
          Effect.gen(function* () {
            yield* Connect(connection);
          }).pipe(Effect.provide(ConnectBinding)),
        );

        const keys = connectEnvKeys(connection);
        const binding = stack.bindings[app.FQN]?.[0];
        const env = yield* Output.evaluate(binding?.data.env ?? {}, {});

        expect(binding?.sid).toBe("Connection");
        expect(Object.keys(env)).toEqual(
          expect.arrayContaining([
            keys.connectionId,
            keys.databaseId,
            keys.directConnectionString,
            keys.pooledConnectionString,
            keys.password,
          ]),
        );
        expect(env[keys.connectionId]).toBe("connection-1");
        expect(env[keys.databaseId]).toBe("database-1");
        expect(
          redactedValue(env[keys.directConnectionString] ?? undefined),
        ).toBe("postgres://api");
        expect(
          redactedValue(env[keys.pooledConnectionString] ?? undefined),
        ).toBe("prisma+postgres://api");
        expect(redactedValue(env[keys.password] ?? undefined)).toBe("password");
      }).pipe(
        Effect.provide(inMemoryState()),
        Effect.provide(
          Layer.succeed(PrismaProviderCollection, {
            kind: "ProviderCollection" as const,
            get: () => undefined,
            providers: {},
          }),
        ),
        Effect.provideService(Stack, stack),
        Effect.provideService(Stage, "test"),
        Effect.provide(
          Layer.succeed(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({ ALCHEMY_PHASE: "plan" }),
          ),
        ),
      );
    },
  );

  it.effect("Connection.bind records env for AWS Lambda function hosts", () => {
    const stored: Record<string, Output.Output> = {};
    let capturedBindingEnv: Record<string, Output.Output> | undefined;
    const runtime = {
      Type: "AWS.Lambda.Function",
      id: "Api",
      env: stored,
      set: (id: string, output: Output.Output) =>
        Effect.sync(() => {
          const key = id.replaceAll(/[^a-zA-Z0-9]/g, "_");
          stored[key] = output;
          return key;
        }),
      get: <T>(key: string): Effect.Effect<T> => {
        const output = stored[key];
        if (!output) return Effect.die(`missing runtime binding ${key}`);
        return Output.evaluate(output, {}) as Effect.Effect<T>;
      },
    };
    const host = {
      Type: "AWS.Lambda.Function",
      LogicalId: "Api",
      FQN: "Api",
      bind: (...args: unknown[]) =>
        args[0] instanceof Array
          ? (binding: { env?: Record<string, Output.Output> }) =>
              Effect.sync(() => {
                capturedBindingEnv = binding.env;
              })
          : Effect.void,
    };
    const connection = {
      Type: "Prisma.Connection",
      LogicalId: "Connection",
      FQN: "Connection",
      connectionId: Output.asOutput("connection-1"),
      databaseId: Output.asOutput("database-1"),
      directConnectionString: Output.asOutput(Redacted.make("postgres://api")),
      pooledConnectionString: Output.asOutput(undefined),
      accelerateConnectionString: Output.asOutput(undefined),
      host: Output.asOutput("db.example.test"),
      user: Output.asOutput("api"),
      password: Output.asOutput(Redacted.make("password")),
    } as PrismaConnection;

    return Effect.gen(function* () {
      const db = yield* Connect(connection);
      const keys = connectEnvKeys(connection);
      const env = yield* Output.evaluate(
        capturedBindingEnv ?? {},
        {},
      ) as Effect.Effect<Record<string, unknown>>;

      expect(Object.keys(env)).toEqual(
        expect.arrayContaining([
          keys.connectionId,
          keys.databaseId,
          keys.directConnectionString,
          keys.password,
        ]),
      );
      expect(env[keys.connectionId]).toBe("connection-1");
      expect(env[keys.databaseId]).toBe("database-1");
      expect(
        redactedValue(
          env[keys.directConnectionString] as
            | string
            | Redacted.Redacted<string>
            | undefined,
        ),
      ).toBe("postgres://api");
      expect(
        redactedValue(
          env[keys.password] as string | Redacted.Redacted<string> | undefined,
        ),
      ).toBe("password");
      expect(Redacted.value(yield* db.databaseUrl)).toBe("postgres://api");
    }).pipe(
      Effect.provide(ConnectBinding),
      Effect.provide(inMemoryState()),
      Effect.provide(Layer.succeed(RuntimeContext, runtime)),
      Effect.provide(Layer.succeed(Self, host)),
      Effect.provide(
        Layer.succeed(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({ ALCHEMY_PHASE: "runtime" }),
        ),
      ),
    );
  });

  it.effect("Connection.bind records native text bindings for Workers", () => {
    const workerEnv: Record<string, string> = {};
    let capturedBindings: unknown[] | undefined;
    const runtime = {
      Type: "Cloudflare.Worker",
      id: "Worker",
      env: {},
      set: (id: string) => Effect.succeed(id.replaceAll(/[^a-zA-Z0-9]/g, "_")),
      get: <T>(key: string): Effect.Effect<T> => {
        const value = workerEnv[key];
        if (value === undefined) {
          return Effect.die(`missing worker binding ${key}`);
        }
        return Effect.succeed(value as T);
      },
    };
    const host = {
      Type: "Cloudflare.Worker",
      LogicalId: "Worker",
      FQN: "Worker",
      bind: (...args: unknown[]) =>
        args[0] instanceof Array
          ? (binding: {
              bindings?: Output.Output<{
                type: string;
                name: string;
                text: string;
              }>[];
            }) =>
              Effect.sync(() => {
                capturedBindings = binding.bindings;
              })
          : Effect.void,
    };
    const connection = {
      Type: "Prisma.Connection",
      LogicalId: "Connection",
      FQN: "Connection",
      connectionId: Output.asOutput("connection-1"),
      databaseId: Output.asOutput("database-1"),
      directConnectionString: Output.asOutput(Redacted.make("postgres://api")),
      pooledConnectionString: Output.asOutput(undefined),
      accelerateConnectionString: Output.asOutput(undefined),
      host: Output.asOutput("db.example.test"),
      user: Output.asOutput("api"),
      password: Output.asOutput(Redacted.make("password")),
    } as PrismaConnection;

    return Effect.gen(function* () {
      const db = yield* Connect(connection);
      const keys = connectEnvKeys(connection);
      const bindings = (yield* Output.evaluate(
        capturedBindings ?? [],
        {},
      )) as Array<{ type: string; name: string; text: string }>;

      for (const binding of bindings) {
        workerEnv[binding.name] = binding.text;
      }

      expect(bindings).toEqual(
        expect.arrayContaining([
          {
            type: "plain_text",
            name: keys.connectionId,
            text: "connection-1",
          },
          {
            type: "plain_text",
            name: keys.databaseId,
            text: "database-1",
          },
          {
            type: "secret_text",
            name: keys.directConnectionString,
            text: "postgres://api",
          },
          {
            type: "secret_text",
            name: keys.password,
            text: "password",
          },
        ]),
      );
      expect("connectionString" in db).toBe(false);
      expect(Redacted.value(yield* db.databaseUrl)).toBe("postgres://api");
      expect(Redacted.value((yield* db.password)!)).toBe("password");
    }).pipe(
      Effect.provide(ConnectBinding),
      Effect.provide(inMemoryState()),
      Effect.provide(Layer.succeed(RuntimeContext, runtime)),
      Effect.provide(Layer.succeed(Self, host)),
      Effect.provide(
        Layer.succeed(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({ ALCHEMY_PHASE: "runtime" }),
        ),
      ),
    );
  });

  it.effect("rejects conflicting App branch inputs", () => {
    const { client } = makeClient();

    return Effect.gen(function* () {
      const serviceProvider = yield* PrismaApp.Provider;
      const error = yield* serviceProvider
        .reconcile(
          reconcileInput("App", {
            project: "project-1",
            displayName: "api",
            branchId: "branch-1",
            branchGitName: "main",
          }),
        )
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "branchId and branchGitName are mutually exclusive",
      );
    }).pipe(Effect.provide(providerLayer(client)));
  });

  it.effect("rejects conflicting Database branch inputs", () => {
    const { client } = makeClient();

    return Effect.gen(function* () {
      const databaseProvider = yield* PrismaDatabase.Provider;
      const error = yield* databaseProvider
        .reconcile(
          reconcileInput("Database", {
            project: "project-1",
            name: "main",
            branchId: "branch-1",
            branchGitName: "main",
          }),
        )
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "branchId and branchGitName are mutually exclusive",
      );
    }).pipe(Effect.provide(providerLayer(client)));
  });

  it.effect(
    "classifies Prisma resource diffs as updates or replacements",
    () => {
      const { client } = makeClient();

      return Effect.gen(function* () {
        const projectProvider = yield* PrismaProject.Provider;
        const databaseProvider = yield* PrismaDatabase.Provider;
        const connectionProvider = yield* PrismaConnection.Provider;
        const branchProvider = yield* PrismaBranch.Provider;
        const serviceProvider = yield* PrismaApp.Provider;
        const versionProvider = yield* PrismaDeployment.Provider;
        const envProvider = yield* PrismaEnvironmentVariable.Provider;
        const repoProvider = yield* PrismaSourceRepository.Provider;

        expect(
          yield* projectProvider.diff!(
            diffInput(
              { name: "app", region: "us-east-1", createDatabase: false },
              { name: "renamed", region: "us-east-1", createDatabase: false },
            ),
          ),
        ).toEqual({ action: "update" });
        expect(
          yield* projectProvider.diff!(
            diffInput(
              { name: "app", region: "us-east-1", createDatabase: false },
              { name: "app", region: "us-west-2", createDatabase: false },
            ),
          ),
        ).toBeUndefined();
        expect(
          yield* projectProvider.diff!(
            diffInput(
              { name: "app", region: "us-east-1", createDatabase: false },
              {
                name: "app",
                region: "us-west-2",
                createDatabase: Output.asOutput(false),
              },
            ),
          ),
        ).toBeUndefined();
        expect(
          yield* projectProvider.diff!(
            diffInput(
              { name: "app", region: "us-east-1", createDatabase: false },
              {
                name: "app",
                region: "us-west-2",
                createDatabase: false,
                settings: Output.asOutput({}),
              },
            ),
          ),
        ).toBeUndefined();
        expect(
          yield* projectProvider.diff!(
            diffInput(
              {
                name: "app",
                region: "us-east-1",
                createDatabase: false,
                settings: { preview: true, tier: "dev" },
              },
              {
                name: "app",
                region: "us-east-1",
                createDatabase: false,
                settings: { tier: "dev", preview: true },
              },
            ),
          ),
        ).toEqual({ action: "update" });

        expect(
          yield* databaseProvider.diff!(
            diffInput(
              { project: "project-1", name: "main", region: "us-east-1" },
              { project: "project-1", name: "primary", region: "us-east-1" },
            ),
          ),
        ).toEqual({ action: "update" });
        expect(
          yield* databaseProvider.diff!(
            diffInput(
              {
                project: "project-1",
                name: "main",
                region: "us-east-1",
                source: {
                  type: "backup",
                  databaseId: "database-source",
                  backupId: "backup-1",
                },
              },
              {
                project: "project-1",
                name: "main",
                region: "us-east-1",
                source: {
                  backupId: "backup-1",
                  databaseId: "database-source",
                  type: "backup",
                },
              },
            ),
          ),
        ).toBeUndefined();
        expect(
          yield* databaseProvider.diff!(
            diffInput(
              { project: "project-1", name: "main", region: "us-east-1" },
              {
                project: Output.asOutput("project-1"),
                name: "main",
                region: "us-west-2",
              },
            ),
          ),
        ).toEqual({ action: "replace" });
        expect(
          yield* databaseProvider.diff!(
            diffInput(
              {
                project: "project-1",
                name: "main",
                region: "us-east-1",
                branchId: "branch-1",
              },
              {
                project: "project-1",
                name: "main",
                region: "us-west-2",
                branchId: Output.asOutput("branch-1"),
              },
            ),
          ),
        ).toEqual({ action: "replace" });

        expect(
          yield* connectionProvider.diff!(
            diffInput(
              { database: "database-1", name: "api", rotate: false },
              { database: "database-1", name: "api", rotate: true },
            ),
          ),
        ).toEqual({ action: "update" });
        expect(
          yield* connectionProvider.diff!(
            diffInput(
              { database: "database-1", name: "api" },
              { database: "database-1", name: "worker" },
            ),
          ),
        ).toEqual({ action: "replace" });
        expect(
          yield* connectionProvider.diff!(
            diffInput(
              { database: "database-1", name: "api" },
              { database: Output.asOutput("database-1"), name: "worker" },
            ),
          ),
        ).toEqual({ action: "replace" });
        expect(
          yield* connectionProvider.diff!(
            diffInput(
              { database: "database-1", name: "api", rotate: false },
              {
                database: "database-1",
                name: "worker",
                rotate: Output.asOutput(false),
              },
            ),
          ),
        ).toEqual({ action: "replace" });

        expect(
          yield* branchProvider.diff!(
            diffInput(
              { project: "project-1", gitName: "main", isDefault: false },
              { project: "project-1", gitName: "main", isDefault: true },
            ),
          ),
        ).toEqual({ action: "update" });
        expect(
          yield* branchProvider.diff!(
            diffInput(
              { project: "project-1", gitName: "main", isDefault: true },
              { project: "project-1", gitName: "main", isDefault: false },
            ),
          ),
        ).toBeUndefined();
        expect(
          yield* branchProvider.diff!(
            diffInput(
              { project: "project-1", gitName: "main" },
              { project: "project-1", gitName: "release" },
            ),
          ),
        ).toEqual({ action: "replace" });
        expect(
          yield* branchProvider.diff!(
            diffInput(
              { project: "project-1", gitName: "main" },
              { project: Output.asOutput("project-1"), gitName: "release" },
            ),
          ),
        ).toEqual({ action: "replace" });
        expect(
          yield* branchProvider.diff!(
            diffInput(
              { project: "project-1", gitName: "main", isDefault: false },
              {
                project: "project-1",
                gitName: "release",
                isDefault: Output.asOutput(false),
              },
            ),
          ),
        ).toEqual({ action: "replace" });

        expect(
          yield* serviceProvider.diff!(
            diffInput(
              {
                project: "project-1",
                displayName: "api",
                regionId: "us-east-1",
              },
              {
                project: "project-1",
                displayName: "web",
                regionId: "us-east-1",
              },
            ),
          ),
        ).toEqual({ action: "update" });
        const appRegionChanges = yield* Effect.forEach(
          [
            serviceProvider.diff!(
              diffInput(
                {
                  project: "project-1",
                  displayName: "api",
                  regionId: "us-east-1",
                },
                {
                  project: "project-1",
                  displayName: "api",
                  regionId: "us-west-2",
                },
              ),
            ),
            serviceProvider.diff!(
              diffInput(
                {
                  project: "project-1",
                  displayName: "api",
                  regionId: "us-east-1",
                },
                {
                  project: Output.asOutput("project-1"),
                  displayName: "api",
                  regionId: "us-west-2",
                },
              ),
            ),
            serviceProvider.diff!(
              diffInput(
                {
                  project: "project-1",
                  displayName: "api",
                  regionId: "us-east-1",
                  branchId: "branch-1",
                },
                {
                  project: "project-1",
                  displayName: "api",
                  regionId: "us-west-2",
                  branchId: Output.asOutput("branch-1"),
                },
              ),
            ),
          ],
          (change) => change.pipe(Effect.result),
        );
        for (const change of appRegionChanges) {
          expect(Result.isFailure(change)).toBe(true);
          if (Result.isFailure(change)) {
            expect(String(change.failure)).toContain("cannot atomically move");
          }
        }

        expect(
          yield* versionProvider.diff!(
            diffInput(
              { app: "service-1", start: false },
              { app: "service-1", start: true },
            ),
          ),
        ).toEqual({ action: "update" });
        expect(
          yield* versionProvider.diff!(
            diffInput(
              { app: "service-1", portMapping: { http: 3000 } },
              { app: "service-1", portMapping: { http: 8080 } },
            ),
          ),
        ).toEqual({ action: "replace" });
        expect(
          yield* versionProvider.diff!(
            diffInput(
              { app: "service-1", portMapping: { http: 3000 } },
              {
                app: Output.asOutput("service-1"),
                portMapping: { http: 8080 },
              },
            ),
          ),
        ).toEqual({ action: "replace" });
        expect(
          yield* versionProvider.diff!(
            diffInput(
              {
                app: "service-1",
                portMapping: { http: 3000 },
                start: false,
              },
              {
                app: "service-1",
                portMapping: { http: 8080 },
                start: Output.asOutput(false),
              },
            ),
          ),
        ).toEqual({ action: "replace" });

        expect(
          yield* envProvider.diff!(
            diffInput(
              {
                project: "project-1",
                class: "production" as const,
                key: "TOKEN",
                value: Redacted.make("old"),
              },
              {
                project: "project-1",
                class: "production" as const,
                key: "TOKEN",
                value: Redacted.make("new"),
              },
            ),
          ),
        ).toEqual({ action: "update" });
        expect(
          yield* envProvider.diff!(
            diffInput(
              {
                project: "project-1",
                class: "production" as const,
                key: "TOKEN",
                value: Redacted.make("same"),
              },
              {
                project: "project-1",
                class: "production" as const,
                key: "TOKEN",
                value: Redacted.make("same"),
              },
            ),
          ),
        ).toEqual({ action: "update" });
        expect(
          yield* envProvider.diff!(
            diffInput(
              {
                project: "project-1",
                class: "production" as const,
                key: "TOKEN",
                value: Redacted.make("secret"),
              },
              {
                project: "project-1",
                class: "preview" as const,
                key: "TOKEN",
                value: Redacted.make("secret"),
              },
            ),
          ),
        ).toEqual({ action: "replace" });
        expect(
          yield* envProvider.diff!(
            diffInput(
              {
                project: "project-1",
                class: "production" as const,
                key: "TOKEN",
                value: Redacted.make("secret"),
              },
              {
                project: Output.asOutput("project-1"),
                class: "preview" as const,
                key: "TOKEN",
                value: Output.asOutput(Redacted.make("secret")),
              },
            ),
          ),
        ).toEqual({ action: "replace" });
        expect(
          yield* envProvider.diff!(
            diffInput(
              {
                project: "project-1",
                class: "production" as const,
                key: "TOKEN",
                value: Redacted.make("secret"),
              },
              {
                project: "project-1",
                class: "preview" as const,
                key: Output.asOutput("TOKEN"),
                value: Redacted.make("secret"),
              },
            ),
          ),
        ).toEqual({ action: "replace" });

        const repositoryChanges = yield* Effect.forEach(
          [
            repoProvider.diff!(
              diffInput(
                { project: "project-1", providerRepositoryId: 123 },
                { project: "project-1", providerRepositoryId: 456 },
              ),
            ),
            repoProvider.diff!(
              diffInput(
                { project: "project-1", providerRepositoryId: 123 },
                {
                  project: Output.asOutput("project-1"),
                  providerRepositoryId: 456,
                },
              ),
            ),
            repoProvider.diff!(
              diffInput(
                {
                  project: "project-1",
                  providerRepositoryId: 123,
                  installationId: "install-1",
                },
                {
                  project: "project-1",
                  providerRepositoryId: 456,
                  installationId: Output.asOutput("install-1"),
                },
              ),
            ),
          ],
          (change) => change.pipe(Effect.result),
        );
        for (const change of repositoryChanges) {
          expect(Result.isFailure(change)).toBe(true);
          if (Result.isFailure(change)) {
            expect(String(change.failure)).toContain(
              "cannot be replaced atomically",
            );
          }
        }
      }).pipe(
        Effect.provide(providerLayer(client)),
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(Stack, {
          name: "prisma-provider-diff-test",
          stage: "test",
          resources: {},
          bindings: {},
          actions: {},
        }),
        Effect.provideService(Stage, "test"),
      );
    },
  );

  it.effect("reads existing Prisma resources for adoption and refresh", () => {
    const calls: Call[] = [];
    const database = {
      id: "database-1",
      type: "database" as const,
      url: "https://api.prisma.test/v1/databases/database-1",
      name: "main",
      status: "ready" as const,
      createdAt,
      isDefault: true,
      defaultConnectionId: "connection-1",
      connections: [databaseConnection("database-1", "connection-1")],
      project: resourceRef("projects", "project-1", "app"),
      region: { id: "us-east-1", name: "US East" },
      source: { type: "empty" },
      branchId: null,
    };
    const client = {
      listProjects: () =>
        Effect.sync(() => {
          calls.push(["listProjects"]);
          return [
            {
              id: "project-1",
              type: "project" as const,
              url: "https://api.prisma.test/v1/projects/project-1",
              name: "app",
              createdAt,
              defaultRegion: "us-east-1",
              workspace: resourceRef("workspaces", "workspace-1", "team"),
            },
          ];
        }),
      getProject: (id: string) =>
        Effect.sync(() => {
          calls.push(["getProject", id]);
          return {
            id,
            type: "project" as const,
            url: `https://api.prisma.test/v1/projects/${id}`,
            name: "app",
            createdAt,
            defaultRegion: "us-east-1",
            workspace: resourceRef("workspaces", "workspace-1", "team"),
          };
        }),
      listProjectDatabases: (projectId: string, query: unknown) =>
        Effect.sync(() => {
          calls.push(["listProjectDatabases", { projectId, query }]);
          return [database];
        }),
      listDatabaseConnections: (databaseId: string, query: unknown) =>
        Effect.sync(() => {
          calls.push(["listDatabaseConnections", { databaseId, query }]);
          return [
            {
              id: "connection-1",
              type: "connection" as const,
              url: "https://api.prisma.test/v1/connections/connection-1",
              name: "api",
              createdAt,
              kind: "postgres" as const,
              endpoints: {
                direct: {
                  host: "db.prisma.test",
                  port: 5432,
                },
              },
              database: resourceRef("databases", "database-1", "main"),
            },
          ];
        }),
      listBranches: (projectId: string, query: unknown) =>
        Effect.sync(() => {
          calls.push(["listBranches", { projectId, query }]);
          return [
            {
              id: "branch-1",
              type: "branch" as const,
              url: "https://api.prisma.test/v1/branches/branch-1",
              gitName: "main",
              isDefault: true,
              createdAt,
              updatedAt,
              project: resourceRef("projects", "project-1", "app"),
            },
          ];
        }),
      listApps: (query: { projectId: string; limit?: number }) =>
        Effect.sync(() => {
          calls.push(["listApps", query]);
          return [
            {
              id: "service-1",
              type: "app" as const,
              url: "https://api.prisma.test/v1/apps/service-1",
              name: "api",
              region: { id: "us-east-1", name: "US East" },
              projectId: query.projectId,
              branchId: "branch-1",
              latestDeploymentId: "version-1",
              appEndpointDomain: "api.prisma.build",
              createdAt,
            },
          ];
        }),
      listAppDeployments: (appId: string, query: unknown) =>
        Effect.sync(() => {
          calls.push(["listAppDeployments", { appId, query }]);
          return [
            {
              id: "version-1",
              type: "deployment" as const,
              url: "https://api.prisma.test/v1/deployments/version-1",
              foundryVersionId: "foundry-1",
              createdAt,
            },
          ];
        }),
      getDeployment: (id: string) =>
        Effect.sync(() => {
          calls.push(["getDeployment", id]);
          return {
            id,
            type: "deployment" as const,
            url: `https://api.prisma.test/v1/deployments/${id}`,
            foundryVersionId: "foundry-1",
            status: "running",
            previewDomain: "version-1.preview.prisma.build",
            createdAt,
          };
        }),
      listEnvironmentVariables: (query: unknown) =>
        Effect.sync(() => {
          calls.push(["listEnvironmentVariables", query]);
          return [
            {
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
              updatedAt,
            },
          ];
        }),
      listSourceRepositories: (query: unknown) =>
        Effect.sync(() => {
          calls.push(["listSourceRepositories", query]);
          return [
            {
              id: "repo-1",
              type: "source-repository" as const,
              url: "https://api.prisma.test/v1/source-repositories/repo-1",
              repoId: 123,
              provider: "github" as const,
              repoFullName: "acme/api",
              defaultBranch: "main",
              isPrivate: true,
              status: "active" as const,
              projectId: "project-1",
              installationId: "installation-1",
              createdAt,
              updatedAt,
            },
          ];
        }),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const projectProvider = yield* PrismaProject.Provider;
      const databaseProvider = yield* PrismaDatabase.Provider;
      const connectionProvider = yield* PrismaConnection.Provider;
      const branchProvider = yield* PrismaBranch.Provider;
      const serviceProvider = yield* PrismaApp.Provider;
      const versionProvider = yield* PrismaDeployment.Provider;
      const envProvider = yield* PrismaEnvironmentVariable.Provider;
      const repoProvider = yield* PrismaSourceRepository.Provider;

      const project = yield* projectProvider.read!(
        readInput("Project", { name: "app" }),
      );
      const database = yield* databaseProvider.read!(
        readInput("Database", { project: "project-1", name: "main" }),
      );
      const connection = yield* connectionProvider.read!(
        readInput("Connection", { database: "database-1", name: "api" }),
      );
      const branch = yield* branchProvider.read!(
        readInput("Branch", { project: "project-1", gitName: "main" }),
      );
      const service = yield* serviceProvider.read!(
        readInput("App", {
          project: "project-1",
          displayName: "api",
        }),
      );
      const version = yield* versionProvider.read!(
        readInput(
          "Deployment",
          { app: "service-1" },
          {
            deploymentId: "version-1",
            appId: "service-1",
            foundryVersionId: "foundry-1",
            status: "new",
            previewDomain: null,
            uploadUrl: null,
            appEndpointDomain: undefined,
            createdAt,
          },
        ),
      );
      const env = yield* envProvider.read!(
        readInput("EnvironmentVariable", {
          project: "project-1",
          class: "production" as const,
          key: "TOKEN",
          value: Redacted.make("secret"),
        }),
      );
      const repo = yield* repoProvider.read!(
        readInput("SourceRepository", {
          project: "project-1",
          providerRepositoryId: 123,
        }),
      );

      expect(project?.projectId).toBe("project-1");
      expect(project?.databaseId).toBe("database-1");
      expect(database?.databaseId).toBe("database-1");
      expect(connection?.connectionId).toBe("connection-1");
      expect(branch?.branchId).toBe("branch-1");
      expect(service?.appId).toBe("service-1");
      expect(version?.deploymentId).toBe("version-1");
      expect(version?.status).toBe("running");
      expect(env?.environmentVariableId).toBe("env-1");
      expect(env?.valueKid).toBe("kid-1");
      expect(env?.value && Redacted.value(env.value)).toBe("");
      expect(repo?.sourceRepositoryId).toBe("repo-1");
      expect(Unowned.is(project!)).toBe(true);
      expect(Unowned.is(database!)).toBe(true);
      expect(Unowned.is(branch!)).toBe(true);
      expect(Unowned.is(env!)).toBe(true);
      expect(Unowned.is(repo!)).toBe(true);
      expect(calls.map(([operation]) => operation)).toEqual([
        "listProjects",
        "listProjectDatabases",
        "listProjectDatabases",
        "listDatabaseConnections",
        "listDatabaseConnections",
        "listDatabaseConnections",
        "listBranches",
        "listApps",
        "listBranches",
        "getDeployment",
        "listAppDeployments",
        "listEnvironmentVariables",
        "listSourceRepositories",
      ]);
      expect(calls.map(([operation]) => operation)).not.toContain(
        "createProject",
      );
    }).pipe(
      Effect.provide(providerLayer(client)),
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(Stack, {
        name: "prisma-provider-read-test",
        stage: "test",
        resources: {},
        bindings: {},
        actions: {},
      }),
      Effect.provideService(Stage, "test"),
    );
  });

  it.effect("treats Prisma 404 during delete as already gone", () => {
    const calls: Call[] = [];
    const notFound = (method: "GET" | "DELETE", path: string) =>
      new PrismaApiError({
        method,
        path,
        status: 404,
        message: "not found",
      });
    const failNotFound = (
      operation: string,
      id: string,
      method: "GET" | "DELETE",
      path: string,
    ) =>
      Effect.gen(function* () {
        calls.push([operation, id]);
        return yield* Effect.fail(notFound(method, path));
      });

    const client = {
      listApps: (query: unknown) =>
        Effect.sync(() => {
          calls.push(["listApps", query]);
          return [];
        }),
      deleteProject: (id: string) =>
        failNotFound("deleteProject", id, "DELETE", `/v1/projects/${id}`),
      getDatabase: (id: string) =>
        failNotFound("getDatabase", id, "GET", `/v1/databases/${id}`),
      deleteDatabase: (id: string) =>
        failNotFound("deleteDatabase", id, "DELETE", `/v1/databases/${id}`),
      getConnection: (id: string) =>
        failNotFound("getConnection", id, "GET", `/v1/connections/${id}`),
      deleteConnection: (id: string) =>
        failNotFound("deleteConnection", id, "DELETE", `/v1/connections/${id}`),
      getBranch: (id: string) =>
        failNotFound("getBranch", id, "GET", `/v1/branches/${id}`),
      deleteBranch: (id: string) =>
        failNotFound("deleteBranch", id, "DELETE", `/v1/branches/${id}`),
      getEnvironmentVariable: (id: string) =>
        failNotFound(
          "getEnvironmentVariable",
          id,
          "GET",
          `/v1/environment-variables/${id}`,
        ),
      deleteEnvironmentVariable: (id: string) =>
        failNotFound(
          "deleteEnvironmentVariable",
          id,
          "DELETE",
          `/v1/environment-variables/${id}`,
        ),
      deleteSourceRepository: (id: string) =>
        failNotFound(
          "deleteSourceRepository",
          id,
          "DELETE",
          `/v1/source-repositories/${id}`,
        ),
      getSourceRepository: (id: string) =>
        failNotFound(
          "getSourceRepository",
          id,
          "GET",
          `/v1/source-repositories/${id}`,
        ),
      listAppDeployments: (appId: string) =>
        failNotFound(
          "listAppDeployments",
          appId,
          "GET",
          `/v1/apps/${appId}/deployments`,
        ),
      deleteApp: (id: string) =>
        failNotFound("deleteApp", id, "DELETE", `/v1/apps/${id}`),
      getApp: (id: string) =>
        failNotFound("getApp", id, "GET", `/v1/apps/${id}`),
      getDeployment: (id: string) =>
        failNotFound("getDeployment", id, "GET", `/v1/deployments/${id}`),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const projectProvider = yield* PrismaProject.Provider;
      const databaseProvider = yield* PrismaDatabase.Provider;
      const connectionProvider = yield* PrismaConnection.Provider;
      const branchProvider = yield* PrismaBranch.Provider;
      const serviceProvider = yield* PrismaApp.Provider;
      const versionProvider = yield* PrismaDeployment.Provider;
      const envProvider = yield* PrismaEnvironmentVariable.Provider;
      const repoProvider = yield* PrismaSourceRepository.Provider;

      yield* projectProvider.delete!(
        deleteInput("Project", { projectId: "project-1" }),
      );
      yield* databaseProvider.delete!(
        deleteInput("Database", { databaseId: "database-1" }),
      );
      yield* connectionProvider.delete!(
        deleteInput("Connection", { connectionId: "connection-1" }),
      );
      yield* branchProvider.delete!(
        deleteInput("Branch", { branchId: "branch-1" }),
      );
      yield* envProvider.delete!(
        deleteInput("EnvironmentVariable", {
          environmentVariableId: "env-1",
        }),
      );
      yield* repoProvider.delete!(
        deleteInput("SourceRepository", { sourceRepositoryId: "repo-1" }),
      );
      yield* serviceProvider.delete!(
        deleteInput("App", { appId: "service-1" }),
      );
      yield* versionProvider.delete!(
        deleteInput("Deployment", { deploymentId: "version-1" }),
      );

      expect(calls).toEqual([
        ["listApps", { projectId: "project-1", limit: 100 }],
        ["deleteProject", "project-1"],
        ["getDatabase", "database-1"],
        ["getConnection", "connection-1"],
        ["getBranch", "branch-1"],
        ["getEnvironmentVariable", "env-1"],
        ["getSourceRepository", "repo-1"],
        ["getApp", "service-1"],
        ["getDeployment", "version-1"],
      ]);
    }).pipe(Effect.provide(providerLayer(client)));
  });

  it.effect(
    "does not delete cloud projects for dev placeholder project IDs",
    () => {
      const calls: Call[] = [];
      const client = {
        listProjects: () =>
          Effect.sync(() => {
            calls.push(["listProjects"]);
            return [
              {
                id: "project-cloud",
                type: "project",
                url: "https://api.prisma.test/v1/projects/project-cloud",
                name: "local-project",
                createdAt,
                defaultRegion: "us-east-1",
                workspace: resourceRef("workspaces", "workspace-1", "team"),
                database: null,
              },
            ];
          }),
        deleteProject: (id: string) =>
          Effect.sync(() => {
            calls.push(["deleteProject", id]);
          }),
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const projectProvider = yield* PrismaProject.Provider;

        yield* projectProvider.delete!(
          deleteInput("Project", {
            projectId: "dev:project:Project",
            projectName: "local-project",
          }),
        );

        expect(calls).toEqual([]);
      }).pipe(Effect.provide(providerLayer(client)));
    },
  );

  it.effect(
    "reconciles each greenfield Prisma resource through the client",
    () => {
      const { client, calls } = makeClient();

      return Effect.gen(function* () {
        const projectProvider = yield* PrismaProject.Provider;
        const databaseProvider = yield* PrismaDatabase.Provider;
        const connectionProvider = yield* PrismaConnection.Provider;
        const branchProvider = yield* PrismaBranch.Provider;
        const serviceProvider = yield* PrismaApp.Provider;
        const versionProvider = yield* PrismaDeployment.Provider;
        const envProvider = yield* PrismaEnvironmentVariable.Provider;
        const repoProvider = yield* PrismaSourceRepository.Provider;

        const project = yield* projectProvider.reconcile(
          reconcileInput("Project", {
            name: "app",
            createDatabase: false,
            region: "us-east-1",
          }),
        );
        const database = yield* databaseProvider.reconcile(
          reconcileInput("Database", {
            project: project.projectId,
            name: "main",
            region: "us-east-1",
          }),
        );
        const connection = yield* connectionProvider.reconcile(
          reconcileInput("Connection", {
            database: database.databaseId,
            name: "api",
          }),
        );
        const branch = yield* branchProvider.reconcile(
          reconcileInput("Branch", {
            project: project.projectId,
            gitName: "preview",
            isDefault: false,
          }),
        );
        const service = yield* serviceProvider.reconcile(
          reconcileInput("App", {
            project: project.projectId,
            displayName: "api",
            regionId: "us-east-1",
          }),
        );
        const version = yield* versionProvider.reconcile(
          reconcileInput("Deployment", {
            app: service.appId,
            portMapping: { http: 3000 },
            skipCodeUpload: true,
          }),
        );
        const env = yield* envProvider.reconcile(
          reconcileInput("EnvironmentVariable", {
            project: project.projectId,
            class: "production" as const,
            key: "TOKEN",
            value: Redacted.make("secret"),
          }),
        );
        const repo = yield* repoProvider.reconcile(
          reconcileInput("SourceRepository", {
            project: project.projectId,
            providerRepositoryId: 123,
          }),
        );

        expect(project.projectId).toBe("project-1");
        expect(database.databaseId).toBe("database-1");
        expect(Redacted.value(database.directConnectionString!)).toBe(
          "postgres://direct",
        );
        expect(connection.connectionId).toBe("connection-2");
        expectJsonNotToContain(
          database,
          "postgres://direct",
          "postgres://pooled",
        );
        expectJsonNotToContain(connection, "postgres://api-direct");
        expect(branch.branchId).toBe("branch-2");
        expect(service.appId).toBe("service-1");
        expect(version.deploymentId).toBe("version-1");
        expect(env.environmentVariableId).toBe("env-1");
        expect(Redacted.value(env.value)).toBe("secret");
        expectJsonNotToContain(env, "secret");
        expect(repo.sourceRepositoryId).toBe("repo-1");

        expect(calls).toEqual([
          [
            "createProject",
            { name: "app", createDatabase: false, region: "us-east-1" },
          ],
          [
            "createDatabase",
            {
              projectId: "project-1",
              name: "main",
              region: "us-east-1",
              isDefault: false,
              source: undefined,
              branchId: undefined,
              branchGitName: undefined,
            },
          ],
          [
            "listDatabaseConnections",
            { databaseId: "database-1", query: { limit: 100 } },
          ],
          [
            "createConnection",
            { databaseId: "database-1", name: "api-000000000000" },
          ],
          ["listBranches", { projectId: "project-1", query: undefined }],
          [
            "createBranch",
            {
              projectId: "project-1",
              input: { gitName: "preview", isDefault: false },
            },
          ],
          ["listBranches", { projectId: "project-1", query: { limit: 100 } }],
          [
            "createApp",
            {
              projectId: "project-1",
              displayName: "api",
              regionId: "us-east-1",
              branchId: "branch-1",
              branchGitName: undefined,
            },
          ],
          ["listBranches", { projectId: "project-1", query: { limit: 100 } }],
          [
            "createAppDeployment",
            {
              appId: "service-1",
              input: {
                portMapping: { http: 3000 },
                skipCodeUpload: true,
              },
            },
          ],
          ["getDeployment", "version-1"],
          [
            "createEnvironmentVariable",
            {
              projectId: "project-1",
              class: "production",
              key: "TOKEN",
              value: "secret",
            },
          ],
          [
            "listApps",
            {
              projectId: "project-1",
              branchId: "unassigned",
              limit: 100,
            },
          ],
          [
            "listProjectDatabases",
            { projectId: "project-1", query: { limit: 100 } },
          ],
          [
            "createSourceRepository",
            {
              projectId: "project-1",
              provider: "github",
              providerRepositoryId: 123,
              installationId: undefined,
            },
          ],
          ["getSourceRepository", "repo-1"],
          [
            "listBranches",
            {
              projectId: "project-1",
              query: { gitName: "main", limit: 100 },
            },
          ],
        ]);
      }).pipe(
        Effect.provide(providerLayer(client)),
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(Stack, {
          name: "prisma-provider-test",
          stage: "test",
          resources: {},
          bindings: {},
          actions: {},
        }),
        Effect.provideService(Stage, "test"),
      );
    },
  );

  it.effect("reconciles a Prisma custom domain through the client", () => {
    const { client, calls } = makeClient();

    return Effect.gen(function* () {
      const domainProvider = yield* PrismaCustomDomain.Provider;
      const domain = yield* domainProvider.reconcile(
        reconcileInput("CustomDomain", {
          app: "service-1",
          hostname: "api.example.com",
        }),
      );

      expect(domain.customDomainId).toBe("domain-1");
      expect(domain.hostname).toBe("api.example.com");
      expect(domain.appId).toBe("service-1");
      expect(domain.foundryStatus).toBe("pending_dns");
      expect(domain.dnsRecords[0]?.type).toBe("CNAME");
      expect(calls).toEqual([
        ["listAppDomains", "service-1"],
        ["getApp", "service-1"],
        ["getBranch", "branch-1"],
        [
          "createAppDomain",
          {
            appId: "service-1",
            input: { hostname: "api.example.com" },
          },
        ],
      ]);
    }).pipe(Effect.provide(providerLayer(client)));
  });

  it.effect(
    "refuses to claim an existing custom domain during reconcile",
    () => {
      const { client, calls } = makeClient();
      const existing = {
        id: "domain-existing",
        type: "custom-domain" as const,
        url: "https://api.prisma.test/v1/domains/domain-existing",
        hostname: "api.example.com",
        appId: "service-1",
        status: "active" as const,
        foundryStatus: "ready",
        failureReason: null,
        failureCategory: null,
        certExpiresAt: null,
        dnsRecords: [],
        createdAt,
        updatedAt,
      };
      Object.assign(client, {
        listAppDomains: (appId: string) =>
          Effect.sync(() => {
            calls.push(["listAppDomains", appId]);
            return [existing];
          }),
        createAppDomain: () => Effect.die("must not claim an existing domain"),
      });

      return Effect.gen(function* () {
        const domainProvider = yield* PrismaCustomDomain.Provider;
        const error = yield* domainProvider
          .reconcile(
            reconcileInput("CustomDomain", {
              app: "service-1",
              hostname: "api.example.com",
            }),
          )
          .pipe(Effect.flip);

        expect((error as Error).message).toContain("explicit adoption");
        expect(calls).toEqual([["listAppDomains", "service-1"]]);
      }).pipe(Effect.provide(providerLayer(client)));
    },
  );

  it.effect(
    "routes a 200 custom-domain create race through explicit adoption",
    () => {
      const { client, calls } = makeClient();
      let visible = false;
      const raced = {
        id: "domain-raced",
        type: "custom-domain" as const,
        url: "https://api.prisma.test/v1/domains/domain-raced",
        hostname: "api.example.com",
        appId: "service-1",
        status: "pending_dns" as const,
        foundryStatus: "pending",
        failureReason: null,
        failureCategory: null,
        certExpiresAt: null,
        dnsRecords: [],
        createdAt,
        updatedAt,
      };
      Object.assign(client, {
        listAppDomains: (appId: string) =>
          Effect.sync(() => {
            calls.push(["listAppDomains", appId]);
            return visible ? [raced] : [];
          }),
        createAppDomain: (appId: string, input: unknown) =>
          Effect.sync(() => {
            calls.push(["createAppDomain", { appId, input }]);
            visible = true;
            return { status: 200 as const, domain: raced };
          }),
      });

      return Effect.gen(function* () {
        const domainProvider = yield* PrismaCustomDomain.Provider;
        const error = yield* domainProvider
          .reconcile(
            reconcileInput("CustomDomain", {
              app: "service-1",
              hostname: raced.hostname,
            }),
          )
          .pipe(Effect.flip);

        expect((error as Error).message).toContain("explicit adoption");
        expect(calls).toContainEqual([
          "createAppDomain",
          {
            appId: "service-1",
            input: { hostname: raced.hostname },
          },
        ]);

        const observed = yield* domainProvider.read!(
          readInput("CustomDomain", {
            app: "service-1",
            hostname: raced.hostname,
          }),
        );
        expect(observed?.customDomainId).toBe(raced.id);
        expect(Unowned.is(observed!)).toBe(true);
      }).pipe(Effect.provide(providerLayer(client)));
    },
  );

  it.effect("normalizes Prisma custom domain hostnames when matching", () => {
    const { client, calls } = makeClient();
    Object.assign(client, {
      listAppDomains: (appId: string) =>
        Effect.sync(() => {
          calls.push(["listAppDomains", appId]);
          return [
            {
              id: "domain-1",
              type: "custom-domain" as const,
              url: "https://api.prisma.test/v1/domains/domain-1",
              hostname: "api.example.com",
              appId: appId,
              status: "pending_dns" as const,
              foundryStatus: "pending",
              failureReason: null,
              failureCategory: null,
              certExpiresAt: null,
              dnsRecords: [
                {
                  type: "CNAME" as const,
                  name: "api.example.com",
                  value: "service-1.prisma.build",
                  ttl: null,
                },
              ],
              createdAt,
              updatedAt,
            },
          ];
        }),
    });

    return Effect.gen(function* () {
      const domainProvider = yield* PrismaCustomDomain.Provider;
      const domain = yield* domainProvider.read!(
        readInput("CustomDomain", {
          app: "service-1",
          hostname: "API.EXAMPLE.COM.",
        }),
      );

      expect(domain?.customDomainId).toBe("domain-1");
      expect(domain?.hostname).toBe("api.example.com");
      expect(Unowned.is(domain!)).toBe(true);
      expect(calls).toEqual([["listAppDomains", "service-1"]]);
    }).pipe(Effect.provide(providerLayer(client)));
  });

  it.effect("rejects Prisma custom domains on non-default branches", () => {
    const { client, calls } = makeClient();
    Object.assign(client, {
      getBranch: (id: string) =>
        Effect.sync(() => {
          calls.push(["getBranch", id]);
          return {
            id,
            type: "branch" as const,
            url: `https://api.prisma.test/v1/branches/${id}`,
            gitName: "preview",
            isDefault: false,
            createdAt,
            updatedAt,
            project: resourceRef("projects", "project-1", "app"),
          };
        }),
    });

    return Effect.gen(function* () {
      const domainProvider = yield* PrismaCustomDomain.Provider;
      const error = yield* domainProvider
        .reconcile(
          reconcileInput("CustomDomain", {
            app: "service-1",
            hostname: "api.example.com",
          }),
        )
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "custom domains can only be attached to apps on the default Branch",
      );
      expect(calls).toEqual([
        ["listAppDomains", "service-1"],
        ["getApp", "service-1"],
        ["getBranch", "branch-1"],
      ]);
    }).pipe(Effect.provide(providerLayer(client)));
  });

  it.effect("starts a direct deployment only after observing status", () => {
    const calls: Call[] = [];
    let status = "new";
    let latestDeploymentId: string | null = null;
    const client = {
      createAppDeployment: (appId: string, input: unknown) =>
        Effect.sync(() => {
          calls.push(["createAppDeployment", { appId, input }]);
          return {
            id: "version-1",
            type: "deployment" as const,
            url: "https://api.prisma.test/v1/deployments/version-1",
            foundryVersionId: "foundry-1",
            uploadUrl: null,
          };
        }),
      getDeployment: (id: string) =>
        Effect.sync(() => {
          calls.push(["getDeployment", id]);
          return {
            id,
            type: "deployment" as const,
            url: `https://api.prisma.test/v1/deployments/${id}`,
            foundryVersionId: "foundry-1",
            status,
            previewDomain:
              status === "running" ? "version-1.preview.prisma.build" : null,
            createdAt,
          };
        }),
      startDeployment: (id: string) =>
        Effect.sync(() => {
          calls.push(["startDeployment", id]);
          status = "running";
          return { previewDomain: "version-1.preview.prisma.build" };
        }),
      getApp: (id: string) =>
        Effect.sync(() => {
          calls.push(["getApp", id]);
          return {
            id,
            type: "app" as const,
            url: `https://api.prisma.test/v1/apps/${id}`,
            name: "api-000000000000",
            region: { id: "us-east-1", name: "US East" },
            projectId: "project-1",
            branchId: null,
            latestDeploymentId,
            appEndpointDomain: "api.prisma.build",
            createdAt,
          };
        }),
      promoteApp: (appId: string, { deploymentId }: { deploymentId: string }) =>
        Effect.sync(() => {
          calls.push(["promoteApp", { appId, deploymentId }]);
          latestDeploymentId = deploymentId;
          return { appEndpointDomain: "api.prisma.build" };
        }),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* PrismaDeployment.Provider;
      const output = yield* provider.reconcile(
        reconcileInput("Deployment", {
          app: "service-1",
          skipCodeUpload: true,
          start: true,
          promote: true,
        }),
      );

      expect(output.status).toBe("running");
      expect(output.previewDomain).toBe("version-1.preview.prisma.build");
      expect(output.appEndpointDomain).toBe("api.prisma.build");
      expect(calls).toEqual([
        [
          "createAppDeployment",
          {
            appId: "service-1",
            input: {
              portMapping: undefined,
              skipCodeUpload: true,
            },
          },
        ],
        ["getDeployment", "version-1"],
        ["startDeployment", "version-1"],
        ["getDeployment", "version-1"],
        ["promoteApp", { appId: "service-1", deploymentId: "version-1" }],
        ["getApp", "service-1"],
      ]);
    }).pipe(
      Effect.provide(providerLayer(client)),
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(Stack, {
        name: "prisma-deployment-test",
        stage: "test",
        resources: {},
        bindings: {},
        actions: {},
      }),
      Effect.provideService(Stage, "test"),
    );
  });

  it.effect(
    "ignores branch env overrides when reconciling project env vars",
    () => {
      const calls: Call[] = [];
      const branchVariable = {
        id: "env-branch",
        type: "environment-variable" as const,
        url: "https://api.prisma.test/v1/environment-variables/env-branch",
        projectId: "project-1",
        branchId: "branch-1",
        class: "production" as const,
        key: "TOKEN",
        valueKid: "kid-branch",
        isManagedBySystem: false,
        createdAt,
        updatedAt,
      };
      const projectVariable = {
        id: "env-project",
        type: "environment-variable" as const,
        url: "https://api.prisma.test/v1/environment-variables/env-project",
        projectId: "project-1",
        branchId: null,
        class: "production" as const,
        key: "TOKEN",
        valueKid: "kid-old",
        isManagedBySystem: false,
        createdAt,
        updatedAt,
      };
      const client = {
        listEnvironmentVariables: (query: unknown) =>
          Effect.sync(() => {
            calls.push(["listEnvironmentVariables", query]);
            return [
              branchVariable,
              { ...branchVariable, id: "env-branch-2", branchId: "branch-2" },
              projectVariable,
            ];
          }),
        getEnvironmentVariable: (id: string) =>
          Effect.sync(() => {
            calls.push(["getEnvironmentVariable", id]);
            return projectVariable;
          }),
        updateEnvironmentVariable: (id: string, input: unknown) =>
          Effect.sync(() => {
            calls.push(["updateEnvironmentVariable", { id, input }]);
            return {
              ...projectVariable,
              id,
              valueKid: "kid-new",
              updatedAt: "2026-01-01T00:00:02Z",
            };
          }),
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const envProvider = yield* PrismaEnvironmentVariable.Provider;
        const observed = yield* envProvider.read!(
          readInput("EnvironmentVariable", {
            project: "project-1",
            class: "production" as const,
            key: "TOKEN",
            value: Redacted.make("secret"),
          }),
        );
        expect(Unowned.is(observed!)).toBe(true);
        const env = yield* envProvider.reconcile(
          reconcileInput(
            "EnvironmentVariable",
            {
              project: "project-1",
              class: "production" as const,
              key: "TOKEN",
              value: Redacted.make("secret"),
            },
            observed,
          ),
        );

        expect(env.environmentVariableId).toBe("env-project");
        expect(env.branchId).toBeNull();
        expect(redactedValue(env.value)).toBe("secret");
        expect(calls).toEqual([
          [
            "listEnvironmentVariables",
            {
              projectId: "project-1",
              class: "production",
              key: "TOKEN",
              limit: 100,
            },
          ],
          ["getEnvironmentVariable", "env-project"],
          [
            "updateEnvironmentVariable",
            { id: "env-project", input: { value: "secret" } },
          ],
        ]);
      }).pipe(Effect.provide(providerLayer(client)));
    },
  );

  it.effect("refuses to mutate system-managed environment variables", () => {
    const calls: Call[] = [];
    const systemVariable = {
      id: "env-system",
      type: "environment-variable" as const,
      url: "https://api.prisma.test/v1/environment-variables/env-system",
      projectId: "project-1",
      branchId: null,
      class: "production" as const,
      key: "PRISMA_INTERNAL_URL",
      valueKid: "kid-system",
      isManagedBySystem: true,
      createdAt,
      updatedAt,
    };
    const client = {
      listEnvironmentVariables: (query: unknown) =>
        Effect.sync(() => {
          calls.push(["listEnvironmentVariables", query]);
          return [systemVariable];
        }),
      getEnvironmentVariable: (id: string) =>
        Effect.sync(() => {
          calls.push(["getEnvironmentVariable", id]);
          return systemVariable;
        }),
      updateEnvironmentVariable: (id: string, input: unknown) =>
        Effect.sync(() => {
          calls.push(["updateEnvironmentVariable", { id, input }]);
          return systemVariable;
        }),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const envProvider = yield* PrismaEnvironmentVariable.Provider;
      const observed = yield* envProvider.read!(
        readInput("EnvironmentVariable", {
          project: "project-1",
          class: "production" as const,
          key: "PRISMA_INTERNAL_URL",
          value: Redacted.make("secret"),
        }),
      );
      const error = yield* envProvider
        .reconcile(
          reconcileInput(
            "EnvironmentVariable",
            {
              project: "project-1",
              class: "production" as const,
              key: "PRISMA_INTERNAL_URL",
              value: Redacted.make("secret"),
            },
            observed,
          ),
        )
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "is managed by Prisma and cannot be managed by Alchemy",
      );
      expect(calls).toEqual([
        [
          "listEnvironmentVariables",
          {
            projectId: "project-1",
            class: "production",
            key: "PRISMA_INTERNAL_URL",
            limit: 100,
          },
        ],
        ["getEnvironmentVariable", "env-system"],
      ]);
    }).pipe(Effect.provide(providerLayer(client)));
  });

  it.effect(
    "skips direct delete for system-managed environment variables",
    () => {
      const calls: Call[] = [];
      const notes: string[] = [];
      const client = {
        getEnvironmentVariable: (id: string) =>
          Effect.sync(() => {
            calls.push(["getEnvironmentVariable", id]);
            return {
              id,
              type: "environment-variable" as const,
              url: `https://api.prisma.test/v1/environment-variables/${id}`,
              projectId: "project-1",
              branchId: null,
              class: "production" as const,
              key: "PRISMA_INTERNAL_URL",
              valueKid: "kid-system",
              isManagedBySystem: true,
              createdAt,
              updatedAt,
            };
          }),
        deleteEnvironmentVariable: (id: string) =>
          Effect.sync(() => {
            calls.push(["deleteEnvironmentVariable", id]);
          }),
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const envProvider = yield* PrismaEnvironmentVariable.Provider;
        yield* envProvider.delete!({
          id: "EnvironmentVariable",
          fqn: "EnvironmentVariable",
          instanceId: "00000000000000000000000000000000",
          olds: {} as never,
          output: {
            environmentVariableId: "env-system",
            projectId: "project-1",
            branchId: null,
            class: "production",
            key: "PRISMA_INTERNAL_URL",
            value: Redacted.make("secret"),
            valueKid: "kid-system",
            isManagedBySystem: true,
            createdAt,
            updatedAt,
          },
          session: {
            note: (message: string) =>
              Effect.sync(() => {
                notes.push(message);
              }),
          } as never,
          bindings: [],
        });

        expect(calls).toEqual([["getEnvironmentVariable", "env-system"]]);
        expect(notes).toEqual([
          "Skipping direct delete for system-managed Prisma environment variable 'PRISMA_INTERNAL_URL'.",
        ]);
      }).pipe(Effect.provide(providerLayer(client)));
    },
  );

  it.effect(
    "checks live environment variable ownership before deleting",
    () => {
      const calls: Call[] = [];
      const client = {
        getEnvironmentVariable: (id: string) =>
          Effect.sync(() => {
            calls.push(["getEnvironmentVariable", id]);
            return {
              id,
              type: "environment-variable" as const,
              url: `https://api.prisma.test/v1/environment-variables/${id}`,
              projectId: "project-1",
              branchId: null,
              class: "production" as const,
              key: "PRISMA_INTERNAL_URL",
              valueKid: "kid-system",
              isManagedBySystem: true,
              createdAt,
              updatedAt,
            };
          }),
        deleteEnvironmentVariable: (id: string) =>
          Effect.sync(() => {
            calls.push(["deleteEnvironmentVariable", id]);
          }),
      } as unknown as PrismaManagementClient;

      const session = {
        note: (message: string) =>
          Effect.sync(() => {
            calls.push(["note", message]);
          }),
      };

      return Effect.gen(function* () {
        const envProvider = yield* PrismaEnvironmentVariable.Provider;
        yield* envProvider.delete!({
          id: "EnvironmentVariable",
          fqn: "EnvironmentVariable",
          instanceId: "00000000000000000000000000000000",
          olds: {} as never,
          output: {
            environmentVariableId: "env-system",
            projectId: "project-1",
            branchId: null,
            class: "production",
            key: "PRISMA_INTERNAL_URL",
            value: Redacted.make("secret"),
            valueKid: "kid-user",
            isManagedBySystem: false,
            createdAt,
            updatedAt,
          },
          session: session as never,
          bindings: [],
        });

        expect(calls).toEqual([
          ["getEnvironmentVariable", "env-system"],
          [
            "note",
            "Skipping direct delete for system-managed Prisma environment variable 'PRISMA_INTERNAL_URL'.",
          ],
        ]);
      }).pipe(Effect.provide(providerLayer(client)));
    },
  );

  it.effect(
    "deletes an environment variable when stale state says system-managed",
    () => {
      const calls: Call[] = [];
      const client = {
        getEnvironmentVariable: (id: string) =>
          Effect.sync(() => {
            calls.push(["getEnvironmentVariable", id]);
            return {
              id,
              type: "environment-variable" as const,
              url: `https://api.prisma.test/v1/environment-variables/${id}`,
              projectId: "project-1",
              branchId: null,
              class: "production" as const,
              key: "PRISMA_INTERNAL_URL",
              valueKid: "kid-user",
              isManagedBySystem: false,
              createdAt,
              updatedAt,
            };
          }),
        deleteEnvironmentVariable: (id: string) =>
          Effect.sync(() => {
            calls.push(["deleteEnvironmentVariable", id]);
          }),
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const envProvider = yield* PrismaEnvironmentVariable.Provider;
        yield* envProvider.delete!({
          id: "EnvironmentVariable",
          fqn: "EnvironmentVariable",
          instanceId: "00000000000000000000000000000000",
          olds: {} as never,
          output: {
            environmentVariableId: "env-1",
            projectId: "project-1",
            branchId: null,
            class: "production",
            key: "PRISMA_INTERNAL_URL",
            value: Redacted.make("secret"),
            valueKid: "kid-system",
            isManagedBySystem: true,
            createdAt,
            updatedAt,
          },
          session: undefined as never,
          bindings: [],
        });

        expect(calls).toEqual([
          ["getEnvironmentVariable", "env-1"],
          ["deleteEnvironmentVariable", "env-1"],
        ]);
      }).pipe(Effect.provide(providerLayer(client)));
    },
  );

  it.effect("validates Prisma environment variable writes locally", () => {
    const calls: Call[] = [];
    const client = {
      listEnvironmentVariables: (query: unknown) =>
        Effect.sync(() => {
          calls.push(["listEnvironmentVariables", query]);
          return [];
        }),
      createEnvironmentVariable: (input: unknown) =>
        Effect.sync(() => {
          calls.push(["createEnvironmentVariable", input]);
          return {
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
            updatedAt,
          };
        }),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const envProvider = yield* PrismaEnvironmentVariable.Provider;
      const invalidKey = yield* envProvider
        .reconcile(
          reconcileInput("EnvironmentVariable", {
            project: "project-1",
            class: "production" as const,
            key: "bad-key",
            value: Redacted.make("secret"),
          }),
        )
        .pipe(Effect.flip);
      const emptyValue = yield* envProvider
        .reconcile(
          reconcileInput("EnvironmentVariable", {
            project: "project-1",
            class: "production" as const,
            key: "TOKEN",
            value: Redacted.make(""),
          }),
        )
        .pipe(Effect.flip);

      expect(invalidKey).toBeInstanceOf(Error);
      expect((invalidKey as Error).message).toContain(
        "must match POSIX env-var key shape",
      );
      expect(emptyValue).toBeInstanceOf(Error);
      expect((emptyValue as Error).message).toContain(
        "value must be non-empty",
      );
      expect(calls).toEqual([]);
    }).pipe(Effect.provide(providerLayer(client)));
  });

  it.effect("updates mutable Prisma resources from observed state", () => {
    const calls: Call[] = [];
    const client = {
      getDatabase: (id: string) =>
        Effect.sync(() => {
          calls.push(["getDatabase", id]);
          return {
            id,
            type: "database" as const,
            url: `https://api.prisma.test/v1/databases/${id}`,
            name: "main",
            status: "ready" as const,
            createdAt,
            isDefault: false,
            defaultConnectionId: "connection-1",
            connections: [databaseConnection(id, "connection-1")],
            project: resourceRef("projects", "project-1", "app"),
            region: { id: "us-east-1", name: "US East" },
            source: { type: "empty" },
            branchId: null,
          };
        }),
      updateDatabase: (id: string, input: unknown) =>
        Effect.sync(() => {
          calls.push(["updateDatabase", { id, input }]);
          return {
            id,
            type: "database" as const,
            url: `https://api.prisma.test/v1/databases/${id}`,
            name: "primary",
            status: "ready" as const,
            createdAt,
            isDefault: false,
            defaultConnectionId: "connection-1",
            connections: [databaseConnection(id, "connection-1")],
            project: resourceRef("projects", "project-1", "app"),
            region: { id: "us-east-1", name: "US East" },
            source: { type: "empty" },
            branchId: "branch-1",
          };
        }),
      getConnection: (id: string) =>
        Effect.sync(() => {
          calls.push(["getConnection", id]);
          return {
            id,
            type: "connection" as const,
            url: `https://api.prisma.test/v1/connections/${id}`,
            name: "api-000000000000",
            createdAt,
            kind: "postgres" as const,
            endpoints: {
              direct: {
                host: "db.prisma.test",
                port: 5432,
                connectionString: "postgres://old-direct",
              },
            },
            database: resourceRef("databases", "database-1", "main"),
          };
        }),
      rotateConnection: (id: string) =>
        Effect.sync(() => {
          calls.push(["rotateConnection", id]);
          return {
            id,
            type: "connection" as const,
            url: `https://api.prisma.test/v1/connections/${id}`,
            name: "api-000000000000",
            createdAt,
            kind: "postgres" as const,
            endpoints: {
              direct: {
                host: "db.prisma.test",
                port: 5432,
                connectionString:
                  "postgres://app:new-password@db.prisma.test/database-1",
              },
            },
            database: resourceRef("databases", "database-1", "main"),
          };
        }),
      getBranch: (id: string) =>
        Effect.sync(() => {
          calls.push(["getBranch", id]);
          return {
            id,
            type: "branch" as const,
            url: `https://api.prisma.test/v1/branches/${id}`,
            gitName: "main",
            isDefault: false,
            role: "preview" as const,
            createdAt,
            updatedAt,
            project: resourceRef("projects", "project-1", "app"),
          };
        }),
      updateBranch: (id: string, input: unknown) =>
        Effect.sync(() => {
          calls.push(["updateBranch", { id, input }]);
          return {
            id,
            type: "branch" as const,
            url: `https://api.prisma.test/v1/branches/${id}`,
            gitName: "main",
            isDefault: true,
            role: "preview" as const,
            createdAt,
            updatedAt: "2026-01-01T00:00:02Z",
            project: resourceRef("projects", "project-1", "app"),
          };
        }),
      listBranches: (projectId: string, query: unknown) =>
        Effect.sync(() => {
          calls.push(["listBranches", { projectId, query }]);
          return [
            {
              id: "branch-default",
              type: "branch" as const,
              url: "https://api.prisma.test/v1/branches/branch-default",
              gitName: "production",
              isDefault: true,
              role: "production" as const,
              createdAt,
              updatedAt,
              project: resourceRef("projects", projectId, "app"),
            },
          ];
        }),
      getApp: (id: string) =>
        Effect.sync(() => {
          calls.push(["getApp", id]);
          return {
            id,
            type: "app" as const,
            url: `https://api.prisma.test/v1/apps/${id}`,
            name: "api",
            region: { id: "us-east-1", name: "US East" },
            projectId: "project-1",
            branchId: null,
            latestDeploymentId: null,
            appEndpointDomain: "service-1.prisma.build",
            createdAt,
          };
        }),
      updateApp: (id: string, input: unknown) =>
        Effect.sync(() => {
          calls.push(["updateApp", { id, input }]);
          return {
            id,
            type: "app" as const,
            url: `https://api.prisma.test/v1/apps/${id}`,
            name: "web",
            region: { id: "us-east-1", name: "US East" },
            projectId: "project-1",
            branchId: "branch-1",
            latestDeploymentId: null,
            appEndpointDomain: "service-1.prisma.build",
            createdAt,
          };
        }),
      getEnvironmentVariable: (id: string) =>
        Effect.sync(() => {
          calls.push(["getEnvironmentVariable", id]);
          return {
            id,
            type: "environment-variable" as const,
            url: `https://api.prisma.test/v1/environment-variables/${id}`,
            projectId: "project-1",
            branchId: null,
            class: "production" as const,
            key: "TOKEN",
            valueKid: "kid-old",
            isManagedBySystem: false,
            createdAt,
            updatedAt,
          };
        }),
      updateEnvironmentVariable: (id: string, input: unknown) =>
        Effect.sync(() => {
          calls.push(["updateEnvironmentVariable", { id, input }]);
          return {
            id,
            type: "environment-variable" as const,
            url: `https://api.prisma.test/v1/environment-variables/${id}`,
            projectId: "project-1",
            branchId: null,
            class: "production" as const,
            key: "TOKEN",
            valueKid: "kid-new",
            isManagedBySystem: false,
            createdAt,
            updatedAt: "2026-01-01T00:00:02Z",
          };
        }),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const databaseProvider = yield* PrismaDatabase.Provider;
      const connectionProvider = yield* PrismaConnection.Provider;
      const branchProvider = yield* PrismaBranch.Provider;
      const serviceProvider = yield* PrismaApp.Provider;
      const envProvider = yield* PrismaEnvironmentVariable.Provider;

      const database = yield* databaseProvider.reconcile(
        reconcileInput(
          "Database",
          {
            project: "project-1",
            name: "primary",
            region: "us-east-1",
            branchId: "branch-1",
          },
          {
            databaseId: "database-1",
            databaseName: "main",
            projectId: "project-1",
            status: "ready",
            region: "us-east-1",
            isDefault: false,
            branchId: null,
            defaultConnectionId: "connection-1",
            createdAt,
            directConnectionString: undefined,
            pooledConnectionString: undefined,
            accelerateConnectionString: undefined,
            host: undefined,
            user: undefined,
            password: undefined,
          },
        ),
      );
      const connection = yield* connectionProvider.reconcile(
        reconcileInput(
          "Connection",
          {
            database: "database-1",
            name: "api",
            rotate: true,
          },
          {
            connectionId: "connection-1",
            connectionName: "api-000000000000",
            databaseId: "database-1",
            kind: "postgres" as const,
            createdAt,
            directConnectionString: Redacted.make("postgres://old-direct"),
            pooledConnectionString: undefined,
            accelerateConnectionString: undefined,
            host: "db.prisma.test",
            user: undefined,
            password: undefined,
            databaseUrl: Redacted.make("postgres://old-direct"),
            origin: undefined,
            pooledOrigin: undefined,
          },
          {
            database: "database-1",
            name: "api",
            rotate: false,
          },
        ),
      );
      const branch = yield* branchProvider.reconcile(
        reconcileInput(
          "Branch",
          {
            project: "project-1",
            gitName: "main",
            isDefault: true,
          },
          {
            branchId: "branch-1",
            gitName: "main",
            projectId: "project-1",
            isDefault: false,
            role: "preview",
            createdAt,
            updatedAt,
          },
        ),
      );
      const service = yield* serviceProvider.reconcile(
        reconcileInput(
          "App",
          {
            project: "project-1",
            displayName: "web",
            regionId: "us-east-1",
            branchId: "branch-1",
          },
          {
            appId: "service-1",
            name: "api",
            projectId: "project-1",
            regionId: "us-east-1",
            branchId: null,
            latestDeploymentId: null,
            appEndpointDomain: "service-1.prisma.build",
            createdAt,
          },
        ),
      );
      const env = yield* envProvider.reconcile(
        reconcileInput(
          "EnvironmentVariable",
          {
            project: "project-1",
            class: "production" as const,
            key: "TOKEN",
            value: Redacted.make("new-secret"),
          },
          {
            environmentVariableId: "env-1",
            projectId: "project-1",
            branchId: null,
            class: "production" as const,
            key: "TOKEN",
            value: Redacted.make("old-secret"),
            valueKid: "kid-old",
            isManagedBySystem: false,
            createdAt,
            updatedAt,
          },
        ),
      );

      expect(database.databaseName).toBe("primary");
      expect(database.branchId).toBe("branch-1");
      expect(Redacted.value(connection.directConnectionString!)).toBe(
        "postgres://app:new-password@db.prisma.test/database-1",
      );
      expect(connection.user).toBe("app");
      expect(Redacted.value(connection.password!)).toBe("new-password");
      expectJsonNotToContain(
        connection,
        "postgres://app:new-password@db.prisma.test/database-1",
        "new-password",
      );
      expect(branch.isDefault).toBe(true);
      expect(service.name).toBe("web");
      expect(service.branchId).toBe("branch-1");
      expect(env.valueKid).toBe("kid-new");
      expect(Redacted.value(env.value)).toBe("new-secret");
      expectJsonNotToContain(env, "new-secret");
      expect(calls).toEqual([
        ["getDatabase", "database-1"],
        [
          "updateDatabase",
          {
            id: "database-1",
            input: {
              name: "primary",
              branchId: "branch-1",
              branchGitName: undefined,
            },
          },
        ],
        ["getConnection", "connection-1"],
        ["rotateConnection", "connection-1"],
        ["getBranch", "branch-1"],
        ["listBranches", { projectId: "project-1", query: undefined }],
        ["updateBranch", { id: "branch-1", input: { isDefault: true } }],
        ["getApp", "service-1"],
        [
          "updateApp",
          {
            id: "service-1",
            input: {
              displayName: "web",
              branchId: "branch-1",
              branchGitName: undefined,
            },
          },
        ],
        ["getEnvironmentVariable", "env-1"],
        [
          "updateEnvironmentVariable",
          { id: "env-1", input: { value: "new-secret" } },
        ],
      ]);
    }).pipe(
      Effect.provide(providerLayer(client)),
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(Stack, {
        name: "prisma-provider-update-test",
        stage: "test",
        resources: {},
        bindings: {},
        actions: {},
      }),
      Effect.provideService(Stage, "test"),
    );
  });

  it.effect(
    "skips branchGitName updates when observed branch ids already match",
    () => {
      const calls: Call[] = [];
      const branch = {
        id: "branch-main",
        type: "branch" as const,
        url: "https://api.prisma.test/v1/branches/branch-main",
        gitName: "main",
        isDefault: true,
        createdAt,
        updatedAt,
        project: resourceRef("projects", "project-1", "app"),
      };
      const client = {
        getDatabase: (id: string) =>
          Effect.sync(() => {
            calls.push(["getDatabase", id]);
            return {
              id,
              type: "database" as const,
              url: `https://api.prisma.test/v1/databases/${id}`,
              name: "main",
              status: "ready" as const,
              createdAt,
              isDefault: false,
              defaultConnectionId: "connection-1",
              connections: [databaseConnection(id, "connection-1")],
              project: resourceRef("projects", "project-1", "app"),
              region: { id: "us-east-1", name: "US East" },
              source: { type: "empty" },
              branchId: "branch-main",
            };
          }),
        getApp: (id: string) =>
          Effect.sync(() => {
            calls.push(["getApp", id]);
            return {
              id,
              type: "app" as const,
              url: `https://api.prisma.test/v1/apps/${id}`,
              name: "api",
              region: { id: "us-east-1", name: "US East" },
              projectId: "project-1",
              branchId: "branch-main",
              latestDeploymentId: null,
              appEndpointDomain: "service-1.prisma.build",
              createdAt,
            };
          }),
        listBranches: (projectId: string, query: unknown) =>
          Effect.sync(() => {
            calls.push(["listBranches", { projectId, query }]);
            return [branch];
          }),
        updateDatabase: (id: string, input: unknown) =>
          Effect.sync(() => {
            calls.push(["updateDatabase", { id, input }]);
            throw new Error("updateDatabase should not be called");
          }),
        updateApp: (id: string, input: unknown) =>
          Effect.sync(() => {
            calls.push(["updateApp", { id, input }]);
            throw new Error("updateApp should not be called");
          }),
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const databaseProvider = yield* PrismaDatabase.Provider;
        const serviceProvider = yield* PrismaApp.Provider;

        const database = yield* databaseProvider.reconcile(
          reconcileInput(
            "Database",
            {
              project: "project-1",
              name: "main",
              region: "us-east-1",
              branchGitName: "main",
            },
            {
              databaseId: "database-1",
              databaseName: "main",
              projectId: "project-1",
              status: "ready",
              region: "us-east-1",
              isDefault: false,
              branchId: "branch-main",
              defaultConnectionId: "connection-1",
              createdAt,
              directConnectionString: undefined,
              pooledConnectionString: undefined,
              accelerateConnectionString: undefined,
              host: undefined,
              user: undefined,
              password: undefined,
            },
          ),
        );
        const service = yield* serviceProvider.reconcile(
          reconcileInput(
            "App",
            {
              project: "project-1",
              displayName: "api",
              regionId: "us-east-1",
              branchGitName: "main",
            },
            {
              appId: "service-1",
              name: "api",
              projectId: "project-1",
              regionId: "us-east-1",
              branchId: "branch-main",
              latestDeploymentId: null,
              appEndpointDomain: "service-1.prisma.build",
              createdAt,
            },
          ),
        );

        expect(database.branchId).toBe("branch-main");
        expect(service.branchId).toBe("branch-main");
        expect(calls).toEqual([
          ["getDatabase", "database-1"],
          [
            "listBranches",
            { projectId: "project-1", query: { gitName: "main", limit: 2 } },
          ],
          [
            "listBranches",
            {
              projectId: "project-1",
              query: { gitName: "main", limit: 100 },
            },
          ],
          ["getApp", "service-1"],
          [
            "listBranches",
            {
              projectId: "project-1",
              query: { gitName: "main", limit: 100 },
            },
          ],
        ]);
      }).pipe(
        Effect.provide(providerLayer(client)),
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(Stack, {
          name: "prisma-branch-noop-test",
          stage: "test",
          resources: {},
          bindings: {},
          actions: {},
        }),
        Effect.provideService(Stage, "test"),
      );
    },
  );

  it.effect(
    "normalizes Management API clone source ids before comparing immutable state",
    () => {
      const calls: Call[] = [];
      const database = {
        id: "database-clone",
        type: "database" as const,
        url: "https://api.prisma.test/v1/databases/database-clone",
        name: "clone",
        status: "ready" as const,
        createdAt,
        isDefault: false,
        defaultConnectionId: "connection-clone",
        connections: [databaseConnection("database-clone", "connection-clone")],
        project: resourceRef("projects", "project-1", "app"),
        region: { id: "us-east-1", name: "US East" },
        source: { type: "database" as const, databaseId: "source" },
        branchId: null,
      };
      const client = {
        getDatabase: (id: string) =>
          Effect.sync(() => {
            calls.push(["getDatabase", id]);
            return database;
          }),
        updateDatabase: () =>
          Effect.die("normalized clone source must not trigger an update"),
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const provider = yield* PrismaDatabase.Provider;
        const result = yield* provider.reconcile(
          reconcileInput(
            "Database",
            {
              project: "project-1",
              name: "clone",
              region: "us-east-1",
              source: { type: "database" as const, databaseId: "db_source" },
            },
            {
              databaseId: "database-clone",
              databaseName: "clone",
              projectId: "project-1",
              status: "ready" as const,
              region: "us-east-1",
              isDefault: false,
              branchId: null,
              defaultConnectionId: "connection-clone",
              createdAt,
              directConnectionString: undefined,
              pooledConnectionString: undefined,
              accelerateConnectionString: undefined,
              host: undefined,
              user: undefined,
              password: undefined,
            },
          ),
        );

        expect(result.databaseId).toBe("database-clone");
        expect(calls).toEqual([["getDatabase", "database-clone"]]);
      }).pipe(Effect.provide(providerLayer(client)));
    },
  );

  it.effect("detaches an observed branch when branch props are omitted", () => {
    const calls: Call[] = [];
    const database = {
      id: "database-1",
      type: "database" as const,
      url: "https://api.prisma.test/v1/databases/database-1",
      name: "main",
      status: "ready" as const,
      createdAt,
      isDefault: false,
      defaultConnectionId: "connection-1",
      connections: [],
      project: resourceRef("projects", "project-1", "app"),
      region: { id: "us-east-1", name: "US East" },
      source: { type: "empty" as const },
      branchId: "branch-1",
    };
    const client = {
      getDatabase: (id: string) =>
        Effect.sync(() => {
          calls.push(["getDatabase", id]);
          return database;
        }),
      updateDatabase: (id: string, input: unknown) =>
        Effect.sync(() => {
          calls.push(["updateDatabase", { id, input }]);
          return { ...database, branchId: null };
        }),
      rotateConnection: () =>
        Effect.die("persisted credentials must prevent an unrelated rotation"),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* PrismaDatabase.Provider;
      const result = yield* provider.reconcile(
        reconcileInput(
          "Database",
          {
            project: "project-1",
            name: "main",
            region: "us-east-1",
          },
          {
            databaseId: "database-1",
            databaseName: "main",
            projectId: "project-1",
            status: "ready" as const,
            region: "us-east-1",
            isDefault: false,
            branchId: "branch-1",
            defaultConnectionId: "connection-1",
            createdAt,
            directConnectionString: Redacted.make("postgres://persisted"),
            pooledConnectionString: undefined,
            accelerateConnectionString: undefined,
            host: "db.prisma.test",
            user: "user",
            password: undefined,
          },
          {
            project: "project-1",
            name: "main",
            region: "us-east-1",
            branchId: "branch-1",
          },
        ),
      );

      expect(result.branchId).toBeNull();
      expect(calls).toEqual([
        ["getDatabase", "database-1"],
        [
          "updateDatabase",
          {
            id: "database-1",
            input: {
              name: "main",
              branchId: null,
              branchGitName: undefined,
            },
          },
        ],
      ]);
    }).pipe(Effect.provide(providerLayer(client)));
  });

  it.effect(
    "forces Project and Database reconcile when adoption rotation is enabled",
    () => {
      const { client } = makeClient();

      return Effect.gen(function* () {
        const projectProvider = yield* PrismaProject.Provider;
        const databaseProvider = yield* PrismaDatabase.Provider;

        expect(
          yield* projectProvider.diff!(
            diffInput(
              {
                name: "app",
                createDatabase: false,
                rotateCredentialsOnAdopt: false,
              },
              {
                name: "app",
                createDatabase: false,
                rotateCredentialsOnAdopt: true,
              },
            ),
          ),
        ).toEqual({ action: "update" });
        expect(
          yield* databaseProvider.diff!(
            diffInput(
              {
                project: "project-1",
                name: "main",
                region: "us-east-1",
                rotateCredentialsOnAdopt: false,
              },
              {
                project: "project-1",
                name: "main",
                region: "us-east-1",
                rotateCredentialsOnAdopt: true,
              },
            ),
          ),
        ).toEqual({ action: "update" });
      }).pipe(Effect.provide(providerLayer(client)));
    },
  );

  it.effect("rejects non-atomic explicit-name database branch creation", () => {
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
        .reconcile(
          reconcileInput("Database", {
            project: "project-1",
            name: "main",
            region: "us-east-1",
            branchGitName: "main",
          }),
        )
        .pipe(Effect.flip);

      expect((error as Error).message).toContain(
        "cannot be distinguished from a foreign database",
      );
      expect(created).toBe(false);
    }).pipe(Effect.provide(providerLayer(client)));
  });

  it.effect(
    "recovers credentials after a generated database create conflict",
    () => {
      const calls: Call[] = [];
      let attemptedName: string | undefined;
      const recoveredDatabase = () => ({
        id: "database-recovered",
        type: "database" as const,
        url: "https://api.prisma.test/v1/databases/database-recovered",
        name: attemptedName!,
        status: "ready" as const,
        createdAt,
        isDefault: false,
        defaultConnectionId: "connection-recovered",
        connections: [],
        project: resourceRef("projects", "project-1", "app"),
        region: { id: "us-east-1", name: "US East" },
        source: { type: "empty" as const },
        branchId: "branch-main",
      });
      const client = {
        listProjectDatabases: (projectId: string, query: unknown) =>
          Effect.sync(() => {
            calls.push(["listProjectDatabases", { projectId, query }]);
            return attemptedName === undefined ? [] : [recoveredDatabase()];
          }),
        createDatabase: (input: { name: string }) =>
          Effect.gen(function* () {
            calls.push(["createDatabase", input]);
            attemptedName = input.name;
            return yield* Effect.fail(
              new PrismaApiError({
                method: "POST",
                path: "/v1/databases",
                status: 409,
                message: "already exists",
              }),
            );
          }),
        listBranches: () =>
          Effect.succeed([
            {
              id: "branch-main",
              gitName: "main",
            },
          ]),
        rotateConnection: (id: string) =>
          Effect.sync(() => {
            calls.push(["rotateConnection", id]);
            return databaseConnection("database-recovered", id);
          }),
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const provider = yield* PrismaDatabase.Provider;
        const recovered = yield* provider.reconcile(
          reconcileInput("Database", {
            project: "project-1",
            region: "us-east-1",
            branchGitName: "main",
          }),
        );

        expect(attemptedName).toContain("-Database-test-");
        expect(redactedValue(recovered.directConnectionString)).toContain(
          "database-recovered",
        );
        expect(calls).toContainEqual([
          "rotateConnection",
          "connection-recovered",
        ]);
      }).pipe(
        Effect.provide(providerLayer(client)),
        Effect.provideService(Stack, {
          name: "prisma-database-recovery-test",
          stage: "test",
          resources: {},
          bindings: {},
          actions: {},
        }),
        Effect.provideService(Stage, "test"),
        Effect.provideService(InstanceId, "00000000000000000000000000000000"),
      );
    },
  );

  it.effect(
    "recovers default credentials after a generated project create conflict",
    () => {
      const calls: Call[] = [];
      let attemptedName: string | undefined;
      const project = () => ({
        id: "project-recovered",
        type: "project" as const,
        url: "https://api.prisma.test/v1/projects/project-recovered",
        name: attemptedName!,
        createdAt,
        defaultRegion: "us-east-1",
        workspace: resourceRef("workspaces", "workspace-1", "team"),
      });
      const database = {
        id: "database-default",
        type: "database" as const,
        url: "https://api.prisma.test/v1/databases/database-default",
        name: "default",
        status: "ready" as const,
        createdAt,
        isDefault: true,
        defaultConnectionId: "connection-default",
        connections: [],
        project: resourceRef("projects", "project-recovered", "recovered"),
        region: { id: "us-east-1", name: "US East" },
        source: { type: "empty" as const },
        branchId: null,
      };
      const client = {
        listProjects: () =>
          Effect.sync(() => {
            calls.push(["listProjects"]);
            return attemptedName === undefined ? [] : [project()];
          }),
        createProject: (input: { name: string }) =>
          Effect.gen(function* () {
            calls.push(["createProject", input]);
            attemptedName = input.name;
            return yield* Effect.fail(
              new PrismaApiError({
                method: "POST",
                path: "/v1/projects",
                status: 409,
                message: "already exists",
              }),
            );
          }),
        listProjectDatabases: (projectId: string, query: unknown) =>
          Effect.sync(() => {
            calls.push(["listProjectDatabases", { projectId, query }]);
            return [database];
          }),
        rotateConnection: (id: string) =>
          Effect.sync(() => {
            calls.push(["rotateConnection", id]);
            return databaseConnection("database-default", id);
          }),
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const provider = yield* PrismaProject.Provider;
        const recovered = yield* provider.reconcile(
          reconcileInput("Project", {
            createDatabase: true,
            region: "us-east-1",
          }),
        );

        expect(attemptedName).toContain("-Project-test-");
        expect(redactedValue(recovered.directConnectionString)).toContain(
          "database-default",
        );
        expect(calls).toContainEqual([
          "rotateConnection",
          "connection-default",
        ]);
      }).pipe(
        Effect.provide(providerLayer(client)),
        Effect.provideService(Stack, {
          name: "prisma-project-recovery-test",
          stage: "test",
          resources: {},
          bindings: {},
          actions: {},
        }),
        Effect.provideService(Stage, "test"),
        Effect.provideService(InstanceId, "00000000000000000000000000000000"),
      );
    },
  );

  it.effect(
    "rejects a createDatabase false response that contains a default database",
    () => {
      const calls: Call[] = [];
      const client = {
        createProject: (input: unknown) =>
          Effect.sync(() => {
            calls.push(["createProject", input]);
            return {
              id: "project-1",
              type: "project" as const,
              url: "https://api.prisma.test/v1/projects/project-1",
              name: "app",
              createdAt,
              defaultRegion: "us-east-1",
              workspace: resourceRef("workspaces", "workspace-1", "team"),
              database: {
                id: "database-unexpected",
                type: "database" as const,
                url: "https://api.prisma.test/v1/databases/database-unexpected",
                name: "default",
                status: "ready" as const,
                createdAt,
                isDefault: true,
                defaultConnectionId: null,
                connections: [],
                region: { id: "us-east-1", name: "US East" },
                source: { type: "empty" as const },
                branchId: null,
              },
            };
          }),
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const provider = yield* PrismaProject.Provider;
        const error = yield* provider
          .reconcile(
            reconcileInput("Project", {
              name: "app",
              createDatabase: false,
              region: "us-east-1",
            }),
          )
          .pipe(Effect.flip);

        expect((error as Error).message).toContain(
          "created unexpected default database",
        );
        expect(calls).toEqual([
          [
            "createProject",
            { name: "app", createDatabase: false, region: "us-east-1" },
          ],
        ]);
      }).pipe(Effect.provide(providerLayer(client)));
    },
  );

  it.effect("ensures a default database on an existing Prisma project", () => {
    const calls: Call[] = [];
    let createdDefault: ApiDatabase | undefined;
    const client = {
      listProjects: () =>
        Effect.sync(() => {
          calls.push(["listProjects"]);
          return [
            {
              id: "project-1",
              type: "project" as const,
              url: "https://api.prisma.test/v1/projects/project-1",
              name: "app",
              createdAt,
              defaultRegion: "us-east-1",
              workspace: resourceRef("workspaces", "workspace-1", "team"),
            },
          ];
        }),
      getProject: (id: string) =>
        Effect.sync(() => {
          calls.push(["getProject", id]);
          return {
            id,
            type: "project" as const,
            url: `https://api.prisma.test/v1/projects/${id}`,
            name: "app",
            createdAt,
            defaultRegion: "us-east-1",
            workspace: resourceRef("workspaces", "workspace-1", "team"),
          };
        }),
      listProjectDatabases: (projectId: string, query: unknown) =>
        Effect.sync(() => {
          calls.push(["listProjectDatabases", { projectId, query }]);
          return [
            {
              id: "database-reporting",
              type: "database" as const,
              url: "https://api.prisma.test/v1/databases/database-reporting",
              name: "reporting",
              status: "ready" as const,
              createdAt,
              isDefault: false,
              defaultConnectionId: null,
              connections: [],
              project: resourceRef("projects", "project-1", "app"),
              region: { id: "us-east-1", name: "US East" },
              source: { type: "empty" },
              branchId: null,
            },
            ...(createdDefault === undefined ? [] : [createdDefault]),
          ];
        }),
      createProjectDatabase: (projectId: string, input: unknown) =>
        Effect.sync(() => {
          calls.push(["createProjectDatabase", { projectId, input }]);
          const database: DatabaseCreateResult = {
            id: "database-1",
            type: "database" as const,
            url: "https://api.prisma.test/v1/databases/database-1",
            name: "main",
            status: "ready" as const,
            createdAt,
            isDefault: true,
            defaultConnectionId: "connection-1",
            connections: [
              {
                id: "connection-1",
                type: "connection" as const,
                url: "https://api.prisma.test/v1/connections/connection-1",
                name: "default",
                createdAt,
                kind: "postgres" as const,
                endpoints: {
                  direct: {
                    host: "db.prisma.test",
                    port: 5432,
                    connectionString: "postgres://direct",
                  },
                },
                database: resourceRef("databases", "database-1", "main"),
              },
            ],
            project: resourceRef("projects", "project-1", "app"),
            region: { id: "us-east-1", name: "US East" },
            source: { type: "empty" },
            branchId: null,
          };
          createdDefault = database;
          return database;
        }),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const projectProvider = yield* PrismaProject.Provider;
      const observed = yield* projectProvider.read!(
        readInput("Project", { name: "app", region: "us-east-1" }),
      );
      expect(Unowned.is(observed!)).toBe(true);
      const project = yield* projectProvider.reconcile(
        reconcileInput(
          "Project",
          { name: "app", region: "us-east-1" },
          observed,
        ),
      );

      expect(project.projectId).toBe("project-1");
      expect(project.databaseId).toBe("database-1");
      expect(Redacted.value(project.directConnectionString!)).toBe(
        "postgres://direct",
      );
      expectJsonNotToContain(project, "postgres://direct");
      expect(calls).toEqual([
        ["listProjects"],
        [
          "listProjectDatabases",
          { projectId: "project-1", query: { limit: 100 } },
        ],
        ["getProject", "project-1"],
        [
          "listProjectDatabases",
          { projectId: "project-1", query: { limit: 100 } },
        ],
        [
          "createProjectDatabase",
          {
            projectId: "project-1",
            input: { region: "us-east-1", isDefault: true },
          },
        ],
        ["getProject", "project-1"],
        [
          "listProjectDatabases",
          { projectId: "project-1", query: { limit: 100 } },
        ],
      ]);
    }).pipe(
      Effect.provide(
        ProjectProvider().pipe(
          Layer.provide(Layer.succeed(PrismaClient, client)),
          Layer.provide(liveProviderContext),
        ),
      ),
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(Stack, {
        name: "prisma-project-ensure-test",
        stage: "test",
        resources: {},
        bindings: {},
        actions: {},
      }),
      Effect.provideService(Stage, "test"),
    );
  });

  it.effect("clears previously managed project settings", () => {
    const calls: Call[] = [];
    const client = {
      getProject: (id: string) =>
        Effect.sync(() => {
          calls.push(["getProject", id]);
          return {
            id,
            type: "project" as const,
            url: `https://api.prisma.test/v1/projects/${id}`,
            name: "app",
            createdAt,
            defaultRegion: "us-east-1",
            workspace: resourceRef("workspaces", "workspace-1", "team"),
          };
        }),
      listProjectDatabases: (projectId: string, query: unknown) =>
        Effect.sync(() => {
          calls.push(["listProjectDatabases", { projectId, query }]);
          return [];
        }),
      updateProject: (id: string, input: unknown) =>
        Effect.sync(() => {
          calls.push(["updateProject", { id, input }]);
          return {
            id,
            type: "project" as const,
            url: `https://api.prisma.test/v1/projects/${id}`,
            name: "app",
            createdAt,
            defaultRegion: "us-east-1",
            workspace: resourceRef("workspaces", "workspace-1", "team"),
          };
        }),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const projectProvider = yield* PrismaProject.Provider;
      const project = yield* projectProvider.reconcile(
        reconcileInput(
          "Project",
          { name: "app", createDatabase: false },
          {
            projectId: "project-1",
            projectName: "app",
            workspaceId: "workspace-1",
            createdAt,
            defaultRegion: "us-east-1",
            databaseId: undefined,
            defaultConnectionId: undefined,
            directConnectionString: undefined,
            pooledConnectionString: undefined,
            accelerateConnectionString: undefined,
            host: undefined,
            user: undefined,
            password: undefined,
          },
          {
            name: "app",
            createDatabase: false,
            settings: { preview: true },
          },
        ),
      );

      expect(project.projectId).toBe("project-1");
      expect(calls).toEqual([
        ["getProject", "project-1"],
        [
          "listProjectDatabases",
          { projectId: "project-1", query: { limit: 100 } },
        ],
        [
          "updateProject",
          {
            id: "project-1",
            input: { name: "app", settings: {} },
          },
        ],
      ]);
    }).pipe(
      Effect.provide(
        ProjectProvider().pipe(
          Layer.provide(Layer.succeed(PrismaClient, client)),
          Layer.provide(liveProviderContext),
        ),
      ),
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(Stack, {
        name: "prisma-project-settings-test",
        stage: "test",
        resources: {},
        bindings: {},
        actions: {},
      }),
      Effect.provideService(Stage, "test"),
    );
  });

  it.effect("renames a project without clearing unmanaged settings", () => {
    const calls: Call[] = [];
    const client = {
      getProject: (id: string) =>
        Effect.sync(() => {
          calls.push(["getProject", id]);
          return {
            id,
            type: "project" as const,
            url: `https://api.prisma.test/v1/projects/${id}`,
            name: "app",
            createdAt,
            defaultRegion: "us-east-1",
            workspace: resourceRef("workspaces", "workspace-1", "team"),
          };
        }),
      listProjectDatabases: (projectId: string, query: unknown) =>
        Effect.sync(() => {
          calls.push(["listProjectDatabases", { projectId, query }]);
          return [];
        }),
      updateProject: (id: string, input: unknown) =>
        Effect.sync(() => {
          calls.push(["updateProject", { id, input }]);
          return {
            id,
            type: "project" as const,
            url: `https://api.prisma.test/v1/projects/${id}`,
            name: "renamed",
            createdAt,
            defaultRegion: "us-east-1",
            workspace: resourceRef("workspaces", "workspace-1", "team"),
          };
        }),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const projectProvider = yield* PrismaProject.Provider;
      yield* projectProvider.reconcile(
        reconcileInput(
          "Project",
          { name: "renamed", createDatabase: false },
          {
            projectId: "project-1",
            projectName: "app",
            workspaceId: "workspace-1",
            createdAt,
            defaultRegion: "us-east-1",
            databaseId: undefined,
            defaultConnectionId: undefined,
            directConnectionString: undefined,
            pooledConnectionString: undefined,
            accelerateConnectionString: undefined,
            host: undefined,
            user: undefined,
            password: undefined,
          },
          { name: "app", createDatabase: false },
        ),
      );

      expect(calls).toEqual([
        ["getProject", "project-1"],
        [
          "listProjectDatabases",
          { projectId: "project-1", query: { limit: 100 } },
        ],
        [
          "updateProject",
          {
            id: "project-1",
            input: { name: "renamed" },
          },
        ],
      ]);
    }).pipe(
      Effect.provide(
        ProjectProvider().pipe(
          Layer.provide(Layer.succeed(PrismaClient, client)),
          Layer.provide(liveProviderContext),
        ),
      ),
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(Stack, {
        name: "prisma-project-rename-test",
        stage: "test",
        resources: {},
        bindings: {},
        actions: {},
      }),
      Effect.provideService(Stage, "test"),
    );
  });

  it.effect("deletes Prisma resources through their management APIs", () => {
    const calls: Call[] = [];
    const status = new Map([["version-1", "running"]]);
    const client = {
      deleteProject: (id: string) =>
        Effect.sync(() => {
          calls.push(["deleteProject", id]);
        }),
      deleteDatabase: (id: string) =>
        Effect.sync(() => {
          calls.push(["deleteDatabase", id]);
        }),
      getDatabase: (id: string) =>
        Effect.sync(() => {
          calls.push(["getDatabase", id]);
          return { id, isDefault: false };
        }),
      deleteConnection: (id: string) =>
        Effect.sync(() => {
          calls.push(["deleteConnection", id]);
        }),
      getConnection: (id: string) =>
        Effect.sync(() => {
          calls.push(["getConnection", id]);
          return {
            id,
            name: "api-000000000000",
            database: { id: "database-1" },
          };
        }),
      deleteBranch: (id: string) =>
        Effect.sync(() => {
          calls.push(["deleteBranch", id]);
        }),
      getBranch: (id: string) =>
        Effect.sync(() => {
          calls.push(["getBranch", id]);
          return {
            id,
            gitName: "preview",
            isDefault: false,
            role: "preview" as const,
            project: { id: "project-1" },
          };
        }),
      listApps: (query: unknown) =>
        Effect.sync(() => {
          calls.push(["listApps", query]);
          return [];
        }),
      listAppDeployments: (appId: string, query: unknown) =>
        Effect.sync(() => {
          calls.push(["listAppDeployments", { appId, query }]);
          return [
            {
              id: "version-1",
              type: "deployment" as const,
              url: "https://api.prisma.test/v1/deployments/version-1",
              foundryVersionId: "foundry-1",
              createdAt,
            },
          ];
        }),
      getDeployment: (id: string) =>
        Effect.sync(() => {
          calls.push(["getDeployment", id]);
          return {
            id,
            type: "deployment" as const,
            url: `https://api.prisma.test/v1/deployments/${id}`,
            foundryVersionId: "foundry-1",
            status: status.get(id) ?? "stopped",
            previewDomain: null,
            createdAt,
          };
        }),
      stopDeployment: (id: string) =>
        Effect.sync(() => {
          calls.push(["stopDeployment", id]);
          status.set(id, "stopped");
        }),
      deleteDeployment: (id: string) =>
        Effect.sync(() => {
          calls.push(["deleteDeployment", id]);
        }),
      deleteApp: (id: string) =>
        Effect.sync(() => {
          calls.push(["deleteApp", id]);
        }),
      getApp: (id: string) =>
        Effect.sync(() => {
          calls.push(["getApp", id]);
          return {
            id,
            name: "api",
            projectId: "project-1",
            region: { id: "us-east-1" },
            branchId: "branch-1",
          };
        }),
      deleteCustomDomain: (id: string) =>
        Effect.sync(() => {
          calls.push(["deleteCustomDomain", id]);
        }),
      getCustomDomain: (id: string) =>
        Effect.sync(() => {
          calls.push(["getCustomDomain", id]);
          return { id, appId: "service-1", hostname: "api.example.com" };
        }),
      getEnvironmentVariable: (id: string) =>
        Effect.sync(() => {
          calls.push(["getEnvironmentVariable", id]);
          return {
            id,
            type: "environment-variable" as const,
            url: `https://api.prisma.test/v1/environment-variables/${id}`,
            projectId: "project-1",
            branchId: null,
            class: "production" as const,
            key: "TOKEN",
            valueKid: "kid-1",
            isManagedBySystem: false,
            createdAt,
            updatedAt,
          };
        }),
      deleteEnvironmentVariable: (id: string) =>
        Effect.sync(() => {
          calls.push(["deleteEnvironmentVariable", id]);
        }),
      deleteSourceRepository: (id: string) =>
        Effect.sync(() => {
          calls.push(["deleteSourceRepository", id]);
        }),
      getSourceRepository: (id: string) =>
        Effect.sync(() => {
          calls.push(["getSourceRepository", id]);
          return {
            id,
            projectId: "project-1",
            repoId: 123,
            provider: "github" as const,
            installationId: "installation-1",
          };
        }),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const projectProvider = yield* PrismaProject.Provider;
      const databaseProvider = yield* PrismaDatabase.Provider;
      const connectionProvider = yield* PrismaConnection.Provider;
      const branchProvider = yield* PrismaBranch.Provider;
      const serviceProvider = yield* PrismaApp.Provider;
      const versionProvider = yield* PrismaDeployment.Provider;
      const domainProvider = yield* PrismaCustomDomain.Provider;
      const envProvider = yield* PrismaEnvironmentVariable.Provider;
      const repoProvider = yield* PrismaSourceRepository.Provider;

      yield* versionProvider.delete(
        deleteInput("Deployment", {
          deploymentId: "version-1",
          appId: "service-1",
        }),
      );
      yield* serviceProvider.delete(
        deleteInput("App", {
          appId: "service-1",
          projectId: "project-1",
          regionId: "us-east-1",
          name: "api",
          branchId: "branch-1",
        }),
      );
      yield* repoProvider.delete(
        deleteInput("SourceRepository", {
          sourceRepositoryId: "repo-1",
          projectId: "project-1",
          repoId: 123,
          provider: "github",
          installationId: "installation-1",
        }),
      );
      yield* domainProvider.delete(
        deleteInput("CustomDomain", {
          customDomainId: "domain-1",
          appId: "service-1",
          hostname: "api.example.com",
        }),
      );
      yield* envProvider.delete(
        deleteInput("EnvironmentVariable", {
          environmentVariableId: "env-1",
          projectId: "project-1",
          branchId: null,
          class: "production",
          key: "TOKEN",
        }),
      );
      yield* branchProvider.delete(
        deleteInput("Branch", {
          branchId: "branch-1",
          projectId: "project-1",
          gitName: "preview",
        }),
      );
      yield* connectionProvider.delete(
        deleteInput("Connection", {
          connectionId: "connection-1",
          databaseId: "database-1",
          connectionName: "api-000000000000",
        }),
      );
      yield* databaseProvider.delete(
        deleteInput("Database", { databaseId: "database-1" }),
      );
      yield* projectProvider.delete(
        deleteInput("Project", { projectId: "project-1" }),
      );

      expect(calls).toEqual([
        ["getDeployment", "version-1"],
        ["listAppDeployments", { appId: "service-1", query: undefined }],
        ["getDeployment", "version-1"],
        ["stopDeployment", "version-1"],
        ["getDeployment", "version-1"],
        ["deleteDeployment", "version-1"],
        ["getApp", "service-1"],
        ["deleteApp", "service-1"],
        ["getSourceRepository", "repo-1"],
        ["deleteSourceRepository", "repo-1"],
        ["getCustomDomain", "domain-1"],
        ["deleteCustomDomain", "domain-1"],
        ["getEnvironmentVariable", "env-1"],
        ["deleteEnvironmentVariable", "env-1"],
        ["getBranch", "branch-1"],
        ["deleteBranch", "branch-1"],
        ["getConnection", "connection-1"],
        ["deleteConnection", "connection-1"],
        ["getDatabase", "database-1"],
        ["deleteDatabase", "database-1"],
        ["listApps", { projectId: "project-1", limit: 100 }],
        ["deleteProject", "project-1"],
      ]);
    }).pipe(
      Effect.provide(providerLayer(client)),
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(Stack, {
        name: "prisma-provider-delete-test",
        stage: "test",
        resources: {},
        bindings: {},
        actions: {},
      }),
      Effect.provideService(Stage, "test"),
    );
  });

  it.effect("rejects direct delete for a default Prisma database", () => {
    const calls: Call[] = [];
    const client = {
      getDatabase: (id: string) =>
        Effect.sync(() => {
          calls.push(["getDatabase", id]);
          return { id, isDefault: true };
        }),
      deleteDatabase: (id: string) =>
        Effect.sync(() => {
          calls.push(["deleteDatabase", id]);
        }),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const databaseProvider = yield* PrismaDatabase.Provider;
      const result = yield* databaseProvider
        .delete({
          id: "Postgres",
          fqn: "Postgres",
          instanceId: "00000000000000000000000000000000",
          olds: {} as never,
          output: {
            databaseId: "database-1",
            projectId: "project-1",
            isDefault: true,
          },
          session: undefined,
          bindings: [],
        } as never)
        .pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(String(result.failure)).toContain(
          "Cannot delete default Prisma database",
        );
      }
      expect(calls).toEqual([["getDatabase", "database-1"]]);
    }).pipe(Effect.provide(providerLayer(client)));
  });

  it.effect("checks live database default state before deleting", () => {
    const calls: Call[] = [];
    const client = {
      getDatabase: (id: string) =>
        Effect.sync(() => {
          calls.push(["getDatabase", id]);
          return { id, isDefault: true };
        }),
      deleteDatabase: (id: string) =>
        Effect.sync(() => {
          calls.push(["deleteDatabase", id]);
        }),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const databaseProvider = yield* PrismaDatabase.Provider;
      const result = yield* databaseProvider
        .delete({
          id: "Postgres",
          fqn: "Postgres",
          instanceId: "00000000000000000000000000000000",
          olds: {} as never,
          output: {
            databaseId: "database-1",
            projectId: "project-1",
            isDefault: false,
          },
          session: undefined,
          bindings: [],
        } as never)
        .pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      expect(calls).toEqual([["getDatabase", "database-1"]]);
    }).pipe(Effect.provide(providerLayer(client)));
  });

  it.effect("rejects default Prisma database delete without a session", () => {
    const calls: Call[] = [];
    const client = {
      getDatabase: (id: string) =>
        Effect.sync(() => {
          calls.push(["getDatabase", id]);
          return { id, isDefault: true };
        }),
      deleteDatabase: (id: string) =>
        Effect.sync(() => {
          calls.push(["deleteDatabase", id]);
        }),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const databaseProvider = yield* PrismaDatabase.Provider;
      const result = yield* databaseProvider
        .delete({
          id: "Postgres",
          fqn: "Postgres",
          instanceId: "00000000000000000000000000000000",
          olds: {} as never,
          output: {
            databaseId: "database-1",
            projectId: "project-1",
            isDefault: true,
          },
          session: undefined,
          bindings: [],
        } as never)
        .pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      expect(calls).toEqual([["getDatabase", "database-1"]]);
    }).pipe(Effect.provide(providerLayer(client)));
  });

  it.effect("deletes a database when stale state says it is default", () => {
    const calls: Call[] = [];
    const client = {
      getDatabase: (id: string) =>
        Effect.sync(() => {
          calls.push(["getDatabase", id]);
          return { id, isDefault: false };
        }),
      deleteDatabase: (id: string) =>
        Effect.sync(() => {
          calls.push(["deleteDatabase", id]);
        }),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const databaseProvider = yield* PrismaDatabase.Provider;
      yield* databaseProvider.delete({
        id: "Postgres",
        fqn: "Postgres",
        instanceId: "00000000000000000000000000000000",
        olds: {} as never,
        output: {
          databaseId: "database-1",
          projectId: "project-1",
          isDefault: true,
        },
        session: undefined,
        bindings: [],
      } as never);

      expect(calls).toEqual([
        ["getDatabase", "database-1"],
        ["deleteDatabase", "database-1"],
      ]);
    }).pipe(Effect.provide(providerLayer(client)));
  });

  it.effect("rejects direct delete for a default Prisma branch", () => {
    const calls: Call[] = [];
    const client = {
      getBranch: (id: string) =>
        Effect.sync(() => {
          calls.push(["getBranch", id]);
          return {
            id,
            gitName: "preview",
            isDefault: true,
            role: "preview" as const,
            project: { id: "project-1" },
          };
        }),
      deleteBranch: (id: string) =>
        Effect.sync(() => {
          calls.push(["deleteBranch", id]);
        }),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const branchProvider = yield* PrismaBranch.Provider;
      const result = yield* branchProvider
        .delete({
          id: "MainBranch",
          fqn: "MainBranch",
          instanceId: "00000000000000000000000000000000",
          olds: {} as never,
          output: {
            branchId: "branch-1",
            projectId: "project-1",
            gitName: "preview",
            isDefault: true,
            role: "preview",
          },
          session: undefined,
          bindings: [],
        } as never)
        .pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(String(result.failure)).toContain(
          "Cannot safely delete default Prisma branch",
        );
      }
      expect(calls).toEqual([["getBranch", "branch-1"]]);
    }).pipe(Effect.provide(providerLayer(client)));
  });

  it.effect("checks live branch default state before deleting", () => {
    const calls: Call[] = [];
    const client = {
      getBranch: (id: string) =>
        Effect.sync(() => {
          calls.push(["getBranch", id]);
          return {
            id,
            gitName: "preview",
            isDefault: true,
            role: "preview" as const,
            project: { id: "project-1" },
          };
        }),
      deleteBranch: (id: string) =>
        Effect.sync(() => {
          calls.push(["deleteBranch", id]);
        }),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const branchProvider = yield* PrismaBranch.Provider;
      const result = yield* branchProvider
        .delete({
          id: "MainBranch",
          fqn: "MainBranch",
          instanceId: "00000000000000000000000000000000",
          olds: {} as never,
          output: {
            branchId: "branch-1",
            projectId: "project-1",
            gitName: "preview",
            isDefault: false,
            role: "preview",
          },
          session: undefined,
          bindings: [],
        } as never)
        .pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      expect(calls).toEqual([["getBranch", "branch-1"]]);
    }).pipe(Effect.provide(providerLayer(client)));
  });

  it.effect("rejects default Prisma branch delete without a session", () => {
    const calls: Call[] = [];
    const client = {
      getBranch: (id: string) =>
        Effect.sync(() => {
          calls.push(["getBranch", id]);
          return {
            id,
            gitName: "preview",
            isDefault: true,
            role: "preview" as const,
            project: { id: "project-1" },
          };
        }),
      deleteBranch: (id: string) =>
        Effect.sync(() => {
          calls.push(["deleteBranch", id]);
        }),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const branchProvider = yield* PrismaBranch.Provider;
      const result = yield* branchProvider
        .delete({
          id: "MainBranch",
          fqn: "MainBranch",
          instanceId: "00000000000000000000000000000000",
          olds: {} as never,
          output: {
            branchId: "branch-1",
            projectId: "project-1",
            gitName: "preview",
            isDefault: true,
            role: "preview",
          },
          session: undefined,
          bindings: [],
        } as never)
        .pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      expect(calls).toEqual([["getBranch", "branch-1"]]);
    }).pipe(Effect.provide(providerLayer(client)));
  });

  it.effect("deletes a branch when stale state says it is default", () => {
    const calls: Call[] = [];
    const client = {
      getBranch: (id: string) =>
        Effect.sync(() => {
          calls.push(["getBranch", id]);
          return {
            id,
            gitName: "preview",
            isDefault: false,
            role: "preview" as const,
            project: { id: "project-1" },
          };
        }),
      deleteBranch: (id: string) =>
        Effect.sync(() => {
          calls.push(["deleteBranch", id]);
        }),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const branchProvider = yield* PrismaBranch.Provider;
      yield* branchProvider.delete({
        id: "MainBranch",
        fqn: "MainBranch",
        instanceId: "00000000000000000000000000000000",
        olds: {} as never,
        output: {
          branchId: "branch-1",
          projectId: "project-1",
          gitName: "preview",
          isDefault: true,
          role: "preview",
        },
        session: undefined,
        bindings: [],
      } as never);

      expect(calls).toEqual([
        ["getBranch", "branch-1"],
        ["deleteBranch", "branch-1"],
      ]);
    }).pipe(Effect.provide(providerLayer(client)));
  });

  it.effect("refuses to adopt explicit identities after create races", () => {
    const calls: Call[] = [];
    const visible = new Set<string>();
    const conflict = (path: string) =>
      new PrismaApiError({
        method: "POST",
        path,
        status: 409,
        message: "already exists",
      });
    const project = {
      id: "project-1",
      type: "project" as const,
      url: "https://api.prisma.test/v1/projects/project-1",
      name: "app",
      createdAt,
      defaultRegion: "us-east-1",
      workspace: resourceRef("workspaces", "workspace-1", "team"),
    };
    const database = {
      id: "database-1",
      type: "database" as const,
      url: "https://api.prisma.test/v1/databases/database-1",
      name: "main",
      status: "ready" as const,
      createdAt,
      isDefault: false,
      defaultConnectionId: "connection-1",
      connections: [],
      project: resourceRef("projects", "project-1", "app"),
      region: { id: "us-east-1", name: "US East" },
      source: { type: "empty" },
      branchId: null,
    };
    const connection = {
      id: "connection-1",
      type: "connection" as const,
      url: "https://api.prisma.test/v1/connections/connection-1",
      name: "api-000000000000",
      createdAt,
      kind: "postgres" as const,
      endpoints: {
        direct: { host: "db.prisma.test", port: 5432 },
      },
      database: resourceRef("databases", "database-1", "main"),
    };
    const branch = {
      id: "branch-1",
      type: "branch" as const,
      url: "https://api.prisma.test/v1/branches/branch-1",
      gitName: "preview",
      isDefault: false,
      role: "preview" as const,
      createdAt,
      updatedAt,
      project: resourceRef("projects", "project-1", "app"),
    };
    const defaultBranch = {
      ...branch,
      id: "branch-main",
      url: "https://api.prisma.test/v1/branches/branch-main",
      gitName: "main",
      isDefault: true,
      role: "production" as const,
    };
    const service = {
      id: "service-1",
      type: "app" as const,
      url: "https://api.prisma.test/v1/apps/service-1",
      name: "api",
      region: { id: "us-east-1", name: "US East" },
      projectId: "project-1",
      branchId: null,
      latestDeploymentId: null,
      appEndpointDomain: "service-1.prisma.build",
      createdAt,
    };
    const variable = {
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
      updatedAt,
    };
    const repo = {
      id: "repo-1",
      type: "source-repository" as const,
      url: "https://api.prisma.test/v1/source-repositories/repo-1",
      repoId: 123,
      provider: "github" as const,
      repoFullName: "acme/api",
      defaultBranch: "main",
      isPrivate: true,
      status: "active" as const,
      projectId: "project-1",
      installationId: "installation-1",
      createdAt,
      updatedAt,
    };

    const client = {
      listProjects: () =>
        Effect.sync(() => {
          calls.push(["listProjects"]);
          return visible.has("project") ? [project] : [];
        }),
      createProject: (input: unknown) =>
        Effect.gen(function* () {
          calls.push(["createProject", input]);
          visible.add("project");
          return yield* Effect.fail(conflict("/v1/projects"));
        }),
      listProjectDatabases: (projectId: string, query: unknown) =>
        Effect.sync(() => {
          calls.push(["listProjectDatabases", { projectId, query }]);
          return visible.has("database") ? [database] : [];
        }),
      createDatabase: (input: unknown) =>
        Effect.gen(function* () {
          calls.push(["createDatabase", input]);
          visible.add("database");
          return yield* Effect.fail(conflict("/v1/databases"));
        }),
      listDatabaseConnections: (databaseId: string, query: unknown) =>
        Effect.sync(() => {
          calls.push(["listDatabaseConnections", { databaseId, query }]);
          return visible.has("connection") ? [connection] : [];
        }),
      createConnection: (input: unknown) =>
        Effect.gen(function* () {
          calls.push(["createConnection", input]);
          visible.add("connection");
          return yield* Effect.fail(conflict("/v1/connections"));
        }),
      rotateConnection: (id: string) =>
        Effect.sync(() => {
          calls.push(["rotateConnection", id]);
          return {
            ...connection,
            endpoints: {
              direct: {
                host: "db.prisma.test",
                port: 5432,
                connectionString:
                  "postgres://app:rotated-password@db.prisma.test/database-1",
              },
            },
          };
        }),
      listBranches: (projectId: string, query: unknown) =>
        Effect.sync(() => {
          calls.push(["listBranches", { projectId, query }]);
          const gitName = (query as { gitName?: string } | undefined)?.gitName;
          if (gitName === "preview") {
            return visible.has("branch") ? [branch] : [];
          }
          return [defaultBranch, ...(visible.has("branch") ? [branch] : [])];
        }),
      createBranch: (projectId: string, input: unknown) =>
        Effect.gen(function* () {
          calls.push(["createBranch", { projectId, input }]);
          visible.add("branch");
          return yield* Effect.fail(
            conflict(`/v1/projects/${projectId}/branches`),
          );
        }),
      listApps: (query: unknown) =>
        Effect.sync(() => {
          calls.push(["listApps", query]);
          return visible.has("service") ? [service] : [];
        }),
      createApp: (input: { projectId: string }) =>
        Effect.gen(function* () {
          calls.push(["createApp", input]);
          visible.add("service");
          return yield* Effect.fail(conflict(`/v1/apps`));
        }),
      listEnvironmentVariables: (query: unknown) =>
        Effect.sync(() => {
          calls.push(["listEnvironmentVariables", query]);
          return visible.has("env") ? [variable] : [];
        }),
      createEnvironmentVariable: (input: unknown) =>
        Effect.gen(function* () {
          calls.push(["createEnvironmentVariable", input]);
          visible.add("env");
          return yield* Effect.fail(conflict("/v1/environment-variables"));
        }),
      updateEnvironmentVariable: (id: string, input: unknown) =>
        Effect.sync(() => {
          calls.push(["updateEnvironmentVariable", { id, input }]);
          return variable;
        }),
      listSourceRepositories: (query: unknown) =>
        Effect.sync(() => {
          calls.push(["listSourceRepositories", query]);
          return visible.has("repo") ? [repo] : [];
        }),
      createSourceRepository: (input: unknown) =>
        Effect.gen(function* () {
          calls.push(["createSourceRepository", input]);
          visible.add("repo");
          return yield* Effect.fail(conflict("/v1/source-repositories"));
        }),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const projectProvider = yield* PrismaProject.Provider;
      const databaseProvider = yield* PrismaDatabase.Provider;
      const connectionProvider = yield* PrismaConnection.Provider;
      const branchProvider = yield* PrismaBranch.Provider;
      const serviceProvider = yield* PrismaApp.Provider;
      const envProvider = yield* PrismaEnvironmentVariable.Provider;
      const repoProvider = yield* PrismaSourceRepository.Provider;

      const projectError = yield* projectProvider
        .reconcile(
          reconcileInput("Project", { name: "app", createDatabase: false }),
        )
        .pipe(Effect.flip);
      const databaseError = yield* databaseProvider
        .reconcile(
          reconcileInput("Database", { project: "project-1", name: "main" }),
        )
        .pipe(Effect.flip);
      const connectionOut = yield* connectionProvider.reconcile(
        reconcileInput("Connection", {
          database: "database-1",
          name: "api",
          rotate: true,
        }),
      );
      const branchError = yield* branchProvider
        .reconcile(
          reconcileInput("Branch", {
            project: "project-1",
            gitName: "preview",
          }),
        )
        .pipe(Effect.flip);
      const serviceError = yield* serviceProvider
        .reconcile(
          reconcileInput("App", {
            project: "project-1",
            displayName: "api",
          }),
        )
        .pipe(Effect.flip);
      const envError = yield* envProvider
        .reconcile(
          reconcileInput("EnvironmentVariable", {
            project: "project-1",
            class: "production" as const,
            key: "TOKEN",
            value: Redacted.make("secret"),
          }),
        )
        .pipe(Effect.flip);
      const repoError = yield* repoProvider
        .reconcile(
          reconcileInput("SourceRepository", {
            project: "project-1",
            providerRepositoryId: 123,
          }),
        )
        .pipe(Effect.flip);

      expect((projectError as Error).message).toContain(
        "appeared after the adoption check",
      );
      expect((databaseError as Error).message).toContain(
        "appeared after the adoption check",
      );
      expect(connectionOut.connectionId).toBe("connection-1");
      expect(Redacted.value(connectionOut.directConnectionString!)).toBe(
        "postgres://app:rotated-password@db.prisma.test/database-1",
      );
      expect(Redacted.value(connectionOut.password!)).toBe("rotated-password");
      expect((branchError as Error).message).toContain(
        "appeared after the adoption check",
      );
      expect((serviceError as Error).message).toContain(
        "not owned by this App resource",
      );
      expect((envError as Error).message).toContain(
        "appeared after the adoption check",
      );
      expect((repoError as Error).message).toContain(
        "appeared after the adoption check",
      );
      expect(calls.filter(([name]) => name.startsWith("create"))).toEqual([
        [
          "createProject",
          { name: "app", createDatabase: false, region: undefined },
        ],
        [
          "createDatabase",
          {
            projectId: "project-1",
            name: "main",
            region: "us-east-1",
            isDefault: false,
            source: undefined,
            branchId: undefined,
            branchGitName: undefined,
          },
        ],
        [
          "createConnection",
          { databaseId: "database-1", name: "api-000000000000" },
        ],
        [
          "createBranch",
          {
            projectId: "project-1",
            input: { gitName: "preview", isDefault: undefined },
          },
        ],
        [
          "createApp",
          {
            projectId: "project-1",
            displayName: "api",
            regionId: undefined,
            branchId: "branch-main",
            branchGitName: undefined,
          },
        ],
        [
          "createEnvironmentVariable",
          {
            projectId: "project-1",
            class: "production",
            key: "TOKEN",
            value: "secret",
          },
        ],
        [
          "createSourceRepository",
          {
            projectId: "project-1",
            provider: "github",
            providerRepositoryId: 123,
            installationId: undefined,
          },
        ],
      ]);
      expect(calls).toContainEqual(["rotateConnection", "connection-1"]);
    }).pipe(
      Effect.provide(providerLayer(client)),
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(Stack, {
        name: "prisma-provider-conflict-test",
        stage: "test",
        resources: {},
        bindings: {},
        actions: {},
      }),
      Effect.provideService(Stage, "test"),
    );
  });
});
