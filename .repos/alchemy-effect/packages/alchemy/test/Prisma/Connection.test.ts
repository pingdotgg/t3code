import { Unowned } from "@/AdoptPolicy";
import {
  PrismaApiError,
  PrismaClient,
  type PrismaManagementClient,
} from "@/Prisma/Client";
import { connectEnvKeys } from "@/Prisma/Connect";
import { Connection, ConnectionProvider } from "@/Prisma/Connection";
import type {
  DatabaseConnection,
  DatabaseConnectionWithSecrets,
} from "@/Prisma/Types";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { AlchemyContext } from "@/AlchemyContext";

const createdAt = "2026-01-01T00:00:00.000Z";
const instanceId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const connection = (id: string, name: string): DatabaseConnection => ({
  id,
  type: "connection",
  url: `https://api.prisma.test/v1/connections/${id}`,
  name,
  createdAt,
  kind: "postgres",
  endpoints: {
    direct: { host: "db.prisma.test", port: 5432 },
    pooled: { host: "pooled.db.prisma.test", port: 5432 },
  },
  database: {
    id: "database-1",
    url: "https://api.prisma.test/v1/databases/database-1",
    name: "main",
  },
});

const withSecrets = (
  value: DatabaseConnection,
  suffix: string,
): DatabaseConnectionWithSecrets => ({
  ...value,
  endpoints: {
    direct: {
      host: "db.prisma.test",
      port: 5432,
      connectionString: `postgres://direct-${suffix}`,
    },
    pooled: {
      host: "pooled.db.prisma.test",
      port: 5432,
      connectionString: `postgres://pooled-${suffix}`,
    },
  },
});

const liveProviderContext = Layer.succeed(AlchemyContext, {
  dotAlchemy: ".alchemy-test",
  dev: false,
  adopt: false,
});

const providerLayer = (client: PrismaManagementClient) =>
  ConnectionProvider().pipe(
    Layer.provide(Layer.succeed(PrismaClient, client)),
    Layer.provide(liveProviderContext),
  );

const connectionProps = { database: "database-1", name: "api" };

const reconcileInput = (
  output?: Connection["Attributes"],
  olds?: typeof connectionProps,
  reconcileInstanceId = instanceId,
) => ({
  id: "Connection",
  fqn: "Connection",
  instanceId: reconcileInstanceId,
  news: connectionProps,
  olds,
  output,
  session: undefined as never,
  bindings: [],
});

const readInput = (
  connectionsOutput?: Connection["Attributes"],
  readInstanceId = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
) => ({
  id: "Connection",
  fqn: "Connection",
  instanceId: readInstanceId,
  olds: { database: "database-1", name: "api" },
  output: connectionsOutput,
});

describe("Prisma Connection provider", () => {
  it.effect(
    "recovers a crash after create without creating another key",
    () => {
      const connections: DatabaseConnection[] = [];
      let creates = 0;
      let rotations = 0;
      const client = {
        listDatabaseConnections: () => Effect.succeed(connections),
        createConnection: (input: { name: string }) =>
          Effect.sync(() => {
            creates += 1;
            const created = connection("connection-1", input.name);
            connections.push(created);
            return withSecrets(created, "created");
          }),
        getConnection: (id: string) =>
          Effect.succeed(connections.find((item) => item.id === id)!),
        rotateConnection: (id: string) =>
          Effect.sync(() => {
            rotations += 1;
            return withSecrets(
              connections.find((item) => item.id === id)!,
              "rotated",
            );
          }),
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const provider = yield* Connection.Provider;
        const first = yield* provider.reconcile(reconcileInput());
        // Simulate create succeeding but state persistence failing. Refresh
        // recovers the deterministic key without its one-time credentials.
        const observed = yield* provider.read!(
          readInput(undefined, instanceId),
        );
        expect(observed).toBeDefined();
        expect(Unowned.is(observed)).toBe(false);
        expect(observed?.directConnectionString).toBeUndefined();
        const recovered = yield* provider.reconcile(reconcileInput(observed!));

        expect(creates).toBe(1);
        expect(rotations).toBe(1);
        expect(connections[0]?.name).toBe("api-aaaaaaaaaaaa");
        expect(first.connectionId).toBe("connection-1");
        expect(recovered.connectionId).toBe("connection-1");
        expect(Redacted.value(recovered.directConnectionString!)).toBe(
          "postgres://direct-rotated",
        );
      }).pipe(Effect.provide(providerLayer(client)));
    },
  );

  it.effect(
    "recovers credentials after a generated connection create conflict",
    () => {
      const connections: DatabaseConnection[] = [];
      let creates = 0;
      let rotations = 0;
      const client = {
        listDatabaseConnections: () => Effect.succeed(connections),
        createConnection: (input: { name: string }) =>
          Effect.gen(function* () {
            creates += 1;
            connections.push(connection("connection-1", input.name));
            return yield* Effect.fail(
              new PrismaApiError({
                method: "POST",
                path: "/v1/connections",
                status: 409,
                message: "already exists",
              }),
            );
          }),
        rotateConnection: (id: string) =>
          Effect.sync(() => {
            rotations += 1;
            return withSecrets(
              connections.find((item) => item.id === id)!,
              "recovered",
            );
          }),
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const provider = yield* Connection.Provider;
        const recovered = yield* provider.reconcile(reconcileInput());

        expect(creates).toBe(1);
        expect(rotations).toBe(1);
        expect(recovered.connectionId).toBe("connection-1");
        expect(Redacted.value(recovered.directConnectionString!)).toBe(
          "postgres://direct-recovered",
        );
      }).pipe(Effect.provide(providerLayer(client)));
    },
  );

  it.effect(
    "recovers exact generated credentials and supports rotation",
    () => {
      const existing = connection("connection-1", "api-aaaaaaaaaaaa");
      let rotations = 0;
      const client = {
        getConnection: () => Effect.succeed(existing),
        rotateConnection: () =>
          Effect.sync(() => {
            rotations += 1;
            return withSecrets(existing, "adopted");
          }),
      } as unknown as PrismaManagementClient;
      const output: Connection["Attributes"] = {
        connectionId: existing.id,
        connectionName: existing.name,
        databaseId: existing.database.id,
        kind: existing.kind,
        createdAt,
        directConnectionString: undefined,
        pooledConnectionString: undefined,
        accelerateConnectionString: undefined,
        host: "db.prisma.test",
        user: undefined,
        password: undefined,
        databaseUrl: undefined,
        origin: undefined,
        pooledOrigin: undefined,
      };

      return Effect.gen(function* () {
        const provider = yield* Connection.Provider;
        const recovered = yield* provider.reconcile({
          ...reconcileInput(output),
          olds: undefined,
        });
        expect(Redacted.value(recovered.directConnectionString!)).toBe(
          "postgres://direct-adopted",
        );
        expect(rotations).toBe(1);

        const stable = yield* provider.reconcile(
          reconcileInput(recovered, connectionProps),
        );
        expect(Redacted.value(stable.directConnectionString!)).toBe(
          "postgres://direct-adopted",
        );
        expect(rotations).toBe(1);

        const optedIn = yield* provider.reconcile({
          ...reconcileInput(recovered, connectionProps),
          news: { ...connectionProps, rotate: true },
        });
        expect(rotations).toBe(2);
        expect(Redacted.value(optedIn.directConnectionString!)).toBe(
          "postgres://direct-adopted",
        );
      }).pipe(Effect.provide(providerLayer(client)));
    },
  );

  it.effect("rejects a blank connection name before calling Prisma", () => {
    let listed = false;
    const client = {
      listDatabaseConnections: () =>
        Effect.sync(() => {
          listed = true;
          return [];
        }),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* Connection.Provider;
      const error = yield* provider
        .reconcile({
          ...reconcileInput(),
          news: { database: "database-1", name: "   " },
        })
        .pipe(Effect.flip);

      expect(String(error)).toContain(
        "must contain at least one non-space character",
      );
      expect(listed).toBe(false);
    }).pipe(Effect.provide(providerLayer(client)));
  });

  it.effect("does not rotate again when the rotate flag is reset", () => {
    const existing = connection("connection-1", "api-aaaaaaaaaaaa");
    let rotations = 0;
    const client = {
      getConnection: () => Effect.succeed(existing),
      rotateConnection: () =>
        Effect.sync(() => {
          rotations += 1;
          return withSecrets(existing, "unexpected");
        }),
    } as unknown as PrismaManagementClient;
    const output: Connection["Attributes"] = {
      connectionId: existing.id,
      connectionName: existing.name,
      databaseId: existing.database.id,
      kind: existing.kind,
      createdAt,
      directConnectionString: Redacted.make("postgres://direct-current"),
      pooledConnectionString: Redacted.make("postgres://pooled-current"),
      accelerateConnectionString: undefined,
      host: "db.prisma.test",
      user: "app",
      password: Redacted.make("current-password"),
      databaseUrl: Redacted.make("postgres://pooled-current"),
      origin: undefined,
      pooledOrigin: undefined,
    };

    return Effect.gen(function* () {
      const provider = yield* Connection.Provider;
      const recovered = yield* provider.reconcile({
        ...reconcileInput(output),
        news: { ...connectionProps, rotate: false },
        olds: { ...connectionProps, rotate: true },
      });

      expect(rotations).toBe(0);
      expect(Redacted.value(recovered.directConnectionString!)).toBe(
        "postgres://direct-current",
      );
    }).pipe(Effect.provide(providerLayer(client)));
  });

  it.effect("rejects a persisted connection with mismatched identity", () => {
    const wrong = {
      ...connection("connection-1", "api-aaaaaaaaaaaa"),
      database: {
        id: "database-foreign",
        url: "https://api.prisma.test/v1/databases/database-foreign",
        name: "foreign",
      },
    };
    let rotations = 0;
    const client = {
      getConnection: () => Effect.succeed(wrong),
      rotateConnection: () =>
        Effect.sync(() => {
          rotations += 1;
          return withSecrets(wrong, "unexpected");
        }),
    } as unknown as PrismaManagementClient;
    const output: Connection["Attributes"] = {
      connectionId: wrong.id,
      connectionName: wrong.name,
      databaseId: "database-foreign",
      kind: wrong.kind,
      createdAt,
      directConnectionString: undefined,
      pooledConnectionString: undefined,
      accelerateConnectionString: undefined,
      host: undefined,
      user: undefined,
      password: undefined,
      databaseUrl: undefined,
      origin: undefined,
      pooledOrigin: undefined,
    };

    return Effect.gen(function* () {
      const provider = yield* Connection.Provider;
      const diff = yield* provider.diff!({
        id: "Connection",
        fqn: "Connection",
        instanceId,
        olds: connectionProps,
        news: connectionProps,
        output,
        oldBindings: [],
        newBindings: [],
      });
      expect(diff).toEqual({ action: "replace" });

      const error = yield* provider
        .reconcile(reconcileInput(output, connectionProps))
        .pipe(Effect.flip);
      expect(String(error)).toContain("mismatched identity");
      expect(rotations).toBe(0);
    }).pipe(Effect.provide(providerLayer(client)));
  });

  it.effect("recovers its deterministic key as owned while creating", () => {
    const existing = connection("connection-1", "api-aaaaaaaaaaaa");
    const client = {
      listDatabaseConnections: () =>
        Effect.succeed([
          existing,
          connection("connection-foreign", "api-bbbbbbbbbbbb"),
        ]),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* Connection.Provider;
      const output = yield* provider.read!(readInput(undefined, instanceId));

      expect(output?.connectionId).toBe("connection-1");
      expect(Unowned.is(output)).toBe(false);
    }).pipe(Effect.provide(providerLayer(client)));
  });

  it.effect(
    "reports a foreign generated key as unowned on a cold probe",
    () => {
      const existing = connection("connection-1", "api-aaaaaaaaaaaa");
      const client = {
        listDatabaseConnections: () => Effect.succeed([existing]),
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const provider = yield* Connection.Provider;
        const output = yield* provider.read!(readInput());

        expect(output?.connectionId).toBe("connection-1");
        expect(Unowned.is(output)).toBe(true);
      }).pipe(Effect.provide(providerLayer(client)));
    },
  );

  it.effect(
    "preserves an adopted connection from an older generated instance name",
    () => {
      const currentInstanceId = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
      const existing = connection("connection-1", "api-aaaaaaaaaaaa");
      let creates = 0;
      let rotations = 0;
      const client = {
        listDatabaseConnections: () => Effect.succeed([existing]),
        getConnection: () => Effect.succeed(existing),
        createConnection: () =>
          Effect.sync(() => {
            creates += 1;
            return withSecrets(existing, "unexpected");
          }),
        rotateConnection: () =>
          Effect.sync(() => {
            rotations += 1;
            return withSecrets(existing, "adopted-old-generated");
          }),
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const provider = yield* Connection.Provider;
        const observed = yield* provider.read!(
          readInput(undefined, currentInstanceId),
        );
        expect(observed?.connectionName).toBe("api-aaaaaaaaaaaa");
        expect(Unowned.is(observed)).toBe(true);

        const adopted = yield* provider.reconcile(
          reconcileInput(observed!, undefined, currentInstanceId),
        );
        expect(adopted.connectionName).toBe("api-aaaaaaaaaaaa");
        expect(adopted.directConnectionString).toBeUndefined();
        expect(creates).toBe(0);
        expect(rotations).toBe(0);

        const diff = yield* provider.diff!({
          id: "Connection",
          fqn: "Connection",
          instanceId: currentInstanceId,
          olds: connectionProps,
          news: connectionProps,
          output: adopted,
          oldBindings: [],
          newBindings: [],
        });
        expect(diff).toBeUndefined();

        const rotated = yield* provider.reconcile({
          ...reconcileInput(adopted, connectionProps, currentInstanceId),
          news: { ...connectionProps, rotate: true },
        });
        expect(rotations).toBe(1);
        expect(Redacted.value(rotated.directConnectionString!)).toBe(
          "postgres://direct-adopted-old-generated",
        );

        const refreshed = yield* provider.read!(
          readInput(rotated, currentInstanceId),
        );
        expect(refreshed?.connectionName).toBe("api-aaaaaaaaaaaa");
        expect(Redacted.value(refreshed!.directConnectionString!)).toBe(
          "postgres://direct-adopted-old-generated",
        );
      }).pipe(Effect.provide(providerLayer(client)));
    },
  );

  it.effect("preserves an adopted connection with its natural name", () => {
    const existing = connection("connection-1", "api");
    let creates = 0;
    let rotations = 0;
    const client = {
      listDatabaseConnections: () => Effect.succeed([existing]),
      getConnection: () => Effect.succeed(existing),
      createConnection: () =>
        Effect.sync(() => {
          creates += 1;
          return withSecrets(existing, "unexpected");
        }),
      rotateConnection: () =>
        Effect.sync(() => {
          rotations += 1;
          return withSecrets(existing, "adopted-natural");
        }),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* Connection.Provider;
      const observed = yield* provider.read!(readInput(undefined, instanceId));
      expect(observed?.connectionName).toBe("api");
      expect(Unowned.is(observed)).toBe(true);

      const adopted = yield* provider.reconcile(reconcileInput(observed!));
      expect(adopted.connectionName).toBe("api");
      expect(adopted.directConnectionString).toBeUndefined();
      expect(creates).toBe(0);
      expect(rotations).toBe(0);

      const rotated = yield* provider.reconcile({
        ...reconcileInput(adopted, connectionProps),
        news: { ...connectionProps, rotate: true },
      });
      expect(rotations).toBe(1);
      expect(Redacted.value(rotated.directConnectionString!)).toBe(
        "postgres://direct-adopted-natural",
      );
    }).pipe(Effect.provide(providerLayer(client)));
  });

  it.effect("rejects drift from an adopted physical connection name", () => {
    const persisted = connection("connection-1", "api");
    const renamed = connection("connection-1", "api-bbbbbbbbbbbb");
    const client = {
      getConnection: () => Effect.succeed(renamed),
    } as unknown as PrismaManagementClient;
    const output: Connection["Attributes"] = {
      connectionId: persisted.id,
      connectionName: persisted.name,
      databaseId: persisted.database.id,
      kind: persisted.kind,
      createdAt: persisted.createdAt,
      directConnectionString: undefined,
      pooledConnectionString: undefined,
      accelerateConnectionString: undefined,
      host: persisted.endpoints.direct?.host,
      user: undefined,
      databaseUrl: undefined,
      origin: undefined,
      pooledOrigin: undefined,
      password: undefined,
    };

    return Effect.gen(function* () {
      const provider = yield* Connection.Provider;
      const error = yield* provider.read!(readInput(output, instanceId)).pipe(
        Effect.flip,
      );

      expect(String(error)).toContain("no longer matches persisted");
      expect(String(error)).toContain("name 'api'");
    }).pipe(Effect.provide(providerLayer(client)));
  });

  it.effect("fails ambiguous generated-name recovery", () => {
    const client = {
      listDatabaseConnections: () =>
        Effect.succeed([
          connection("connection-1", "api-aaaaaaaaaaaa"),
          connection("connection-2", "api-bbbbbbbbbbbb"),
        ]),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* Connection.Provider;
      const error = yield* provider.read!(
        readInput(undefined, "cccccccccccccccccccccccccccccccc"),
      ).pipe(Effect.flip);

      expect(String(error)).toContain("has 2 connections named");
      expect(String(error)).toContain("<instance-id>");
    }).pipe(Effect.provide(providerLayer(client)));
  });

  it("does not collide binding keys after lossy normalization", () => {
    const hyphenated = connectEnvKeys({
      FQN: "db-a",
      LogicalId: "db-a",
    });
    const underscored = connectEnvKeys({
      FQN: "db_a",
      LogicalId: "db_a",
    });

    expect(hyphenated.directConnectionString).not.toBe(
      underscored.directConnectionString,
    );
  });

  it.effect("defaults the connection name to the logical ID", () => {
    const created = withSecrets(
      connection("connection-1", "Connection-aaaaaaaaaaaa"),
      "new",
    );
    let createdName: string | undefined;
    const client = {
      getConnection: () => Effect.succeed(undefined),
      listDatabaseConnections: () => Effect.succeed([]),
      createConnection: (input: { name: string }) =>
        Effect.sync(() => {
          createdName = input.name;
          return created;
        }),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* Connection.Provider;
      yield* provider.reconcile({
        ...reconcileInput(),
        news: { database: "database-1" },
      });
      // name omitted -> logical ID prefix + instance identity suffix
      expect(createdName).toBe("Connection-aaaaaaaaaaaa");
    }).pipe(Effect.provide(providerLayer(client)));
  });

  it.effect("materializes databaseUrl and parsed origins on reconcile", () => {
    const created = withSecrets(
      connection("connection-1", "api-aaaaaaaaaaaa"),
      "new",
    );
    const client = {
      getConnection: () => Effect.succeed(undefined),
      listDatabaseConnections: () => Effect.succeed([]),
      createConnection: () => Effect.succeed(created),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* Connection.Provider;
      const attrs = yield* provider.reconcile(reconcileInput());

      // databaseUrl prefers the pooled endpoint for application traffic.
      expect(Redacted.value(attrs.databaseUrl!)).toBe("postgres://pooled-new");
      // origin parses the direct connection string into Hyperdrive's shape.
      expect(attrs.origin?.host).toBe("direct-new");
      expect(attrs.origin?.scheme).toBe("postgres");
      expect(attrs.pooledOrigin?.host).toBe("pooled-new");
    }).pipe(Effect.provide(providerLayer(client)));
  });
});
