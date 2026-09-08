import * as PgClient from "@effect/sql-pg/PgClient";
import {
  makePostgresState,
  type PostgresStateOptions,
} from "@/State/PostgresState";
import { StateStoreError, type StateService } from "@/State/State";
import { describe, expect, it } from "alchemy-test";
import * as Config from "effect/Config";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type * as SqlConnection from "effect/unstable/sql/SqlConnection";
import * as SqlError from "effect/unstable/sql/SqlError";

interface FakeQuery {
  text: string;
  values: ReadonlyArray<unknown>;
}

interface FakeConnection extends SqlConnection.Connection {
  queries: FakeQuery[];
  released: boolean;
}

const unsupported = (operation: string) =>
  Effect.die(new Error(`fake postgres does not support ${operation}`));

const sqlFailure = (message: string) =>
  new SqlError.SqlError({
    reason: new SqlError.ConnectionError({
      cause: new Error(message),
      message,
      operation: "execute",
    }),
  });

/**
 * Hermetic fake of the `@effect/sql` driver surface the store uses: a real
 * `SqlClient` built on the real `@effect/sql-pg` statement compiler, whose
 * connections are in-memory. It recognizes the store's fixed SQL statements
 * and keeps rows in in-memory maps, so tests exercise the real store logic
 * (lock acquisition, lease guard, encoding) without a database.
 *
 * Every acquired connection records its own queries and answers
 * `pg_backend_pid()` with its own id, so tests can prove which connection
 * ran what and can tell a pool apart from a single shared connection.
 *
 * What this fake cannot do is model a real pool: `singleConnection: true`
 * reproduces `PgClient.makeClient`/`fromClient`, where reserving and
 * running a plain statement both land on the same connection, but nothing
 * here reproduces pool exhaustion, queueing, or a killed backend. That is
 * why the store asks Postgres itself which backend answered the liveness
 * check instead of trusting the client to hand out a second connection.
 */
const makeFakePostgres = (options: { singleConnection?: boolean } = {}) => {
  const resources = new Map<string, unknown>();
  const outputs = new Map<string, unknown>();
  const connections: FakeConnection[] = [];
  const control = {
    lockAcquired: true,
    lockLive: true,
    lockQueries: 0,
    failLockQuery: false,
    // Holds the lock query in flight: `started` fires when the store issues
    // it, and it only answers once `release` completes.
    lockGate: undefined as
      | { started: Deferred.Deferred<void>; release: Deferred.Deferred<void> }
      | undefined,
  };

  const resourceKey = (stack: unknown, stage: unknown, fqn: unknown) =>
    `${stack} ${stage} ${fqn}`;
  const outputKey = (stack: unknown, stage: unknown) => `${stack} ${stage}`;

  const rows = (
    values: ReadonlyArray<SqlConnection.Row>,
  ): Effect.Effect<ReadonlyArray<SqlConnection.Row>, SqlError.SqlError> =>
    Effect.succeed(values);

  const handle = (
    text: string,
    values: ReadonlyArray<unknown>,
    backendPid: number,
  ): Effect.Effect<ReadonlyArray<SqlConnection.Row>, SqlError.SqlError> => {
    const sql = text.replaceAll(/\s+/g, " ").trim().toLowerCase();
    if (sql === "begin" || sql === "commit" || sql === "rollback") {
      return rows([]);
    }
    if (sql.includes("pg_try_advisory_lock")) {
      control.lockQueries += 1;
      if (control.failLockQuery) {
        return Effect.fail(sqlFailure("connection terminated unexpectedly"));
      }
      const acquired = rows([
        { acquired: control.lockAcquired, pid: backendPid },
      ]);
      const gate = control.lockGate;
      return gate === undefined
        ? acquired
        : Effect.sync(() => {
            Deferred.doneUnsafe(gate.started, Effect.void);
          }).pipe(
            Effect.andThen(Deferred.await(gate.release)),
            Effect.andThen(acquired),
          );
    }
    if (sql.includes("pg_advisory_xact_lock")) {
      return rows([{}]);
    }
    if (sql.includes("pg_advisory_unlock")) {
      return rows([{}]);
    }
    if (sql.includes("from pg_locks")) {
      return rows([{ live: control.lockLive, checker_pid: backendPid }]);
    }
    if (sql.startsWith("create table")) {
      return rows([]);
    }
    if (sql.startsWith("insert into alchemy_resource_state")) {
      const [stack, stage, fqn, json] = values;
      resources.set(resourceKey(stack, stage, fqn), JSON.parse(String(json)));
      return rows([]);
    }
    if (sql.startsWith("insert into alchemy_stack_output")) {
      const [stack, stage, json] = values;
      outputs.set(outputKey(stack, stage), JSON.parse(String(json)));
      return rows([]);
    }
    if (sql.includes("value ->> 'status'")) {
      const [stack, stage] = values;
      return rows(
        Array.from(resources.entries())
          .filter(([key]) => key.startsWith(`${stack} ${stage} `))
          .map(([, value]) => ({ value }))
          .filter(
            (row) =>
              (row.value as { status?: string } | undefined)?.status ===
              "replaced",
          ),
      );
    }
    if (sql.startsWith("select value from alchemy_resource_state")) {
      const [stack, stage, fqn] = values;
      const value = resources.get(resourceKey(stack, stage, fqn));
      return rows(value === undefined ? [] : [{ value }]);
    }
    if (sql.startsWith("select value from alchemy_stack_output")) {
      const [stack, stage] = values;
      const value = outputs.get(outputKey(stack, stage));
      return rows(value === undefined ? [] : [{ value }]);
    }
    if (sql.startsWith("select fqn from alchemy_resource_state")) {
      const [stack, stage] = values;
      return rows(
        Array.from(resources.keys())
          .filter((key) => key.startsWith(`${stack} ${stage} `))
          .map((key) => ({ fqn: key.split(" ")[2] }))
          .sort((a, b) => String(a.fqn).localeCompare(String(b.fqn))),
      );
    }
    if (sql.startsWith("select stack from alchemy_resource_state")) {
      const stacks = new Set<string>();
      for (const key of resources.keys()) stacks.add(key.split(" ")[0]!);
      for (const key of outputs.keys()) stacks.add(key.split(" ")[0]!);
      return rows(
        Array.from(stacks)
          .sort()
          .map((stack) => ({ stack })),
      );
    }
    if (sql.startsWith("select stage from alchemy_resource_state")) {
      const [stack] = values;
      const stages = new Set<string>();
      for (const key of resources.keys()) {
        const [s, stage] = key.split(" ");
        if (s === stack) stages.add(stage!);
      }
      for (const key of outputs.keys()) {
        const [s, stage] = key.split(" ");
        if (s === stack) stages.add(stage!);
      }
      return rows(
        Array.from(stages)
          .sort()
          .map((stage) => ({ stage })),
      );
    }
    if (sql.startsWith("delete from alchemy_resource_state")) {
      const [stack, stage, fqn] = values;
      if (fqn !== undefined) {
        resources.delete(resourceKey(stack, stage, fqn));
      } else if (stage !== undefined) {
        for (const key of Array.from(resources.keys())) {
          if (key.startsWith(`${stack} ${stage} `)) {
            resources.delete(key);
          }
        }
      } else {
        for (const key of Array.from(resources.keys())) {
          if (key.startsWith(`${stack} `)) resources.delete(key);
        }
      }
      return rows([]);
    }
    if (sql.startsWith("delete from alchemy_stack_output")) {
      const [stack, stage] = values;
      for (const key of Array.from(outputs.keys())) {
        const [s, keyStage] = key.split(" ");
        if (s === stack && (stage === undefined || keyStage === stage)) {
          outputs.delete(key);
        }
      }
      return rows([]);
    }
    return Effect.die(new Error(`fake postgres does not recognize: ${sql}`));
  };

  let nextBackendPid = 100;

  const makeConnection = (): FakeConnection => {
    const queries: FakeQuery[] = [];
    const backendPid = nextBackendPid++;
    const execute = (text: string, values: ReadonlyArray<unknown>) =>
      Effect.suspend(() => {
        queries.push({ text, values });
        return handle(text, values, backendPid);
      });
    const connection: FakeConnection = {
      queries,
      released: false,
      execute,
      executeUnprepared: execute,
      executeRaw: execute,
      executeValues: () => unsupported("executeValues"),
      executeValuesUnprepared: () => unsupported("executeValuesUnprepared"),
      executeStream: () => Stream.fromEffect(unsupported("executeStream")),
    };
    connections.push(connection);
    return connection;
  };

  // A scoped acquirer, exactly like a pool's: every acquisition hands out a
  // fresh connection and marks it released when its scope closes. With
  // `singleConnection`, every acquisition returns the same connection —
  // what `PgClient.makeClient` does, where `reserve` and plain statements
  // share one backend.
  const shared = options.singleConnection ? makeConnection() : undefined;
  const acquirer: SqlConnection.Acquirer =
    shared === undefined
      ? Effect.acquireRelease(Effect.sync(makeConnection), (connection) =>
          Effect.sync(() => {
            connection.released = true;
          }),
        )
      : Effect.succeed(shared);

  const client = SqlClient.make({
    acquirer,
    compiler: PgClient.makeCompiler(),
    spanAttributes: [],
  }).pipe(Effect.provide(Reactivity.layer));

  return { client, connections, resources, outputs, control };
};

const connectionRunning = (
  connections: FakeConnection[],
  fragment: string,
): FakeConnection | undefined =>
  connections.find((connection) =>
    connection.queries.some((query) => query.text.includes(fragment)),
  );

type FakePostgres = ReturnType<typeof makeFakePostgres>;

const withStore = <A, E>(
  fake: FakePostgres,
  options: Omit<PostgresStateOptions, "client">,
  use: (store: StateService) => Effect.Effect<A, E>,
): Effect.Effect<A, E | StateStoreError> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const store = yield* makePostgresState(
      { ...options, client: yield* fake.client },
      scope,
    );
    return yield* use(store);
  }).pipe(Effect.scoped);

/** Builds the store without a client, to exercise option validation. */
const withoutClient = <A, E, E2>(
  options: PostgresStateOptions<E2>,
  use: (store: StateService) => Effect.Effect<A, E>,
): Effect.Effect<A, E | StateStoreError> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const store = yield* makePostgresState(options, scope);
    return yield* use(store);
  }).pipe(Effect.scoped);

const request = { stack: "app", stage: "prod", fqn: "app/prod/db" };

const sampleState = {
  kind: "resource",
  status: "created",
  logicalId: "db",
  output: { password: Redacted.make("s3cret") },
} as never;

describe("Postgres state store", () => {
  it.effect("requires exactly one of client or url", () => {
    const fake = makeFakePostgres();
    return Effect.gen(function* () {
      const neither = yield* withoutClient({}, (store) =>
        store.get(request),
      ).pipe(Effect.flip);
      expect(neither).toBeInstanceOf(StateStoreError);
      expect(neither.message).toContain("exactly one of `client` or `url`");

      const both = yield* withStore(
        fake,
        { url: Redacted.make("postgres://localhost/state") },
        (store) => store.get(request),
      ).pipe(Effect.flip);
      expect(both).toBeInstanceOf(StateStoreError);
      expect((both as StateStoreError).message).toContain(
        "exactly one of `client` or `url`",
      );
    });
  });

  it.effect("reports an unresolvable url config as a state store error", () => {
    // `url` accepts any Effect of a Redacted string, so
    // `Config.redacted(...)` can be passed straight through; a missing
    // variable surfaces as a StateStoreError like any other failure.
    return withoutClient(
      { url: Config.redacted("ALCHEMY_TEST_MISSING_STATE_DATABASE_URL") },
      (store) => store.get(request),
    ).pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(error).toBeInstanceOf(StateStoreError);
        expect(error.message).toContain(
          "ALCHEMY_TEST_MISSING_STATE_DATABASE_URL",
        );
      }),
    );
  });

  it.effect("round-trips resource state including Redacted values", () => {
    const fake = makeFakePostgres();
    return withStore(fake, {}, (store) =>
      Effect.gen(function* () {
        expect(yield* store.get(request)).toBeUndefined();

        yield* store.set({ ...request, value: sampleState });
        const revived = (yield* store.get(request)) as {
          status: string;
          output: { password: Redacted.Redacted<string> };
        };

        expect(revived.status).toBe("created");
        expect(Redacted.isRedacted(revived.output.password)).toBe(true);
        expect(Redacted.value(revived.output.password)).toBe("s3cret");

        // The jsonb column stores the encoded (redaction-marked) form, so
        // the raw secret round-trips through encodeState, not plain JSON.
        const stored = fake.resources.get("app prod app/prod/db");
        expect(JSON.stringify(stored)).toContain("__redacted__");
      }),
    );
  });

  it.effect("serializes the schema migration under an advisory lock", () => {
    const fake = makeFakePostgres();
    return withStore(fake, {}, (store) =>
      Effect.gen(function* () {
        yield* store.get(request);

        const migration = connectionRunning(fake.connections, "create table");
        expect(migration).toBeDefined();
        const statements = migration!.queries.map((query) =>
          query.text.replaceAll(/\s+/g, " ").trim().toLowerCase(),
        );
        expect(statements[0]).toBe("begin");
        expect(statements[1]).toContain("pg_advisory_xact_lock");
        expect(migration!.queries[1]?.values).toEqual(["alchemy:schema"]);
        expect(statements[2]).toContain(
          "create table if not exists alchemy_resource_state",
        );
        expect(statements[3]).toContain(
          "create table if not exists alchemy_stack_output",
        );
        expect(statements[4]).toBe("commit");
        expect(migration!.released).toBe(true);
      }),
    );
  });

  it.effect("acquires the advisory lock once per stack/stage", () => {
    const fake = makeFakePostgres();
    return withStore(fake, {}, (store) =>
      Effect.gen(function* () {
        yield* store.set({ ...request, value: sampleState });
        yield* store.get(request);
        yield* store.list(request);
        yield* store.setOutput({ ...request, value: { url: "https://x" } });
        expect(yield* store.getOutput(request)).toEqual({ url: "https://x" });

        expect(fake.control.lockQueries).toBe(1);
        const lock = connectionRunning(
          fake.connections,
          "pg_try_advisory_lock",
        );
        expect(lock?.queries[0]?.values).toEqual(["alchemy:app/prod"]);
      }),
    );
  });

  it.effect(
    "never runs the lease check on the reserved lock connection",
    () => {
      const fake = makeFakePostgres();
      return withStore(fake, { leaseCheckTtlMs: 0 }, (store) =>
        Effect.gen(function* () {
          yield* store.set({ ...request, value: sampleState });
          yield* store.get(request);

          const lock = connectionRunning(
            fake.connections,
            "pg_try_advisory_lock",
          );
          expect(lock).toBeDefined();
          // The reserved connection only ever takes the lock; the liveness
          // check must ask a different backend, because the reserved
          // connection cannot reliably report on itself once its backend
          // has been killed server-side.
          expect(
            lock!.queries.some((query) => query.text.includes("pg_locks")),
          ).toBe(false);
          expect(
            fake.connections
              .filter((connection) => connection !== lock)
              .some((connection) =>
                connection.queries.some((query) =>
                  query.text.includes("pg_locks"),
                ),
              ),
          ).toBe(true);
        }),
      );
    },
  );

  it.effect(
    "refuses a client that cannot verify the lock independently",
    () => {
      // A single-connection client routes the liveness check straight back to
      // the backend holding the lock, which cannot vouch for itself. The
      // store notices because the check reports its own backend pid.
      const fake = makeFakePostgres({ singleConnection: true });
      return withStore(fake, { leaseCheckTtlMs: 0 }, (store) =>
        Effect.gen(function* () {
          const error = yield* store.get(request).pipe(Effect.flip);
          expect(error).toBeInstanceOf(StateStoreError);
          expect(error.message).toContain("cannot be verified");
          expect(error.message).toContain("not pool-backed");
        }),
      );
    },
  );

  it.effect("prefixes the lock key with lockKeyPrefix", () => {
    const fake = makeFakePostgres();
    return withStore(fake, { lockKeyPrefix: "my-app" }, (store) =>
      Effect.gen(function* () {
        yield* store.get(request);
        const lock = connectionRunning(
          fake.connections,
          "pg_try_advisory_lock",
        );
        expect(lock?.queries[0]?.values).toEqual(["my-app:app/prod"]);
      }),
    );
  });

  it.effect("fails immediately when another deploy holds the lock", () => {
    const fake = makeFakePostgres();
    fake.control.lockAcquired = false;
    return withStore(fake, {}, (store) =>
      Effect.gen(function* () {
        const result = yield* store.get(request).pipe(Effect.flip);
        expect(result).toBeInstanceOf(StateStoreError);
        expect(result.message).toContain(
          "another deploy holds the Postgres state lock",
        );
        // The reserved connection is released on contention.
        const lock = connectionRunning(
          fake.connections,
          "pg_try_advisory_lock",
        );
        expect(lock?.released).toBe(true);
      }),
    );
  });

  it.effect(
    "releases the reserved connection when the lock query fails",
    () => {
      const fake = makeFakePostgres();
      // The lock attempt fails at the driver, so the reserved connection must
      // go back to the pool rather than leak.
      fake.control.failLockQuery = true;
      return withStore(fake, {}, (store) =>
        Effect.gen(function* () {
          const error = yield* store.get(request).pipe(Effect.flip);
          expect(error).toBeInstanceOf(StateStoreError);
          expect(error.message).toContain("connection terminated unexpectedly");

          const lock = connectionRunning(
            fake.connections,
            "pg_try_advisory_lock",
          );
          expect(lock?.released).toBe(true);
        }),
      );
    },
  );

  it.effect(
    "registers the unlock finalizer even when interrupted mid-acquisition",
    () => {
      const fake = makeFakePostgres();
      return Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        fake.control.lockGate = { started, release };

        const fiber = yield* withStore(fake, {}, (store) =>
          store.get(request),
        ).pipe(Effect.forkChild({ startImmediately: true }));

        // Interrupt while the lock query is still in flight. Taking the
        // lock and registering its unlock finalizer is uninterruptible, so
        // the store must finish both before the interruption is honored —
        // otherwise the session lock would stay held on a connection handed
        // back to the pool, and every later deploy of this stack/stage
        // would fail on it.
        yield* Deferred.await(started);
        const interrupting = yield* Fiber.interrupt(fiber).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(interrupting);

        const lock = connectionRunning(
          fake.connections,
          "pg_try_advisory_lock",
        );
        expect(lock).toBeDefined();
        expect(
          lock!.queries.some((query) =>
            query.text.includes("pg_advisory_unlock"),
          ),
        ).toBe(true);
        expect(lock!.released).toBe(true);
      });
    },
  );

  it.effect("unlocks and releases the lock connection on scope close", () => {
    const fake = makeFakePostgres();
    return withStore(fake, {}, (store) =>
      store.set({ ...request, value: sampleState }),
    ).pipe(
      Effect.andThen(
        Effect.sync(() => {
          const lock = connectionRunning(
            fake.connections,
            "pg_try_advisory_lock",
          );
          expect(lock).toBeDefined();
          expect(
            lock!.queries.some((query) =>
              query.text.includes("pg_advisory_unlock"),
            ),
          ).toBe(true);
          expect(lock!.released).toBe(true);
        }),
      ),
    );
  });

  it.effect("fails loudly when the lock lease is lost mid-run", () => {
    const fake = makeFakePostgres();
    return withStore(fake, { leaseCheckTtlMs: 0 }, (store) =>
      Effect.gen(function* () {
        yield* store.set({ ...request, value: sampleState });

        fake.control.lockLive = false;
        const result = yield* store.get(request).pipe(Effect.flip);
        expect(result).toBeInstanceOf(StateStoreError);
        expect(result.message).toContain("was lost mid-run");

        // Stage-less operations re-verify held leases too.
        const listResult = yield* store.listStacks().pipe(Effect.flip);
        expect(listResult.message).toContain("was lost mid-run");
      }),
    );
  });

  it.effect("filters replaced resources in SQL", () => {
    const fake = makeFakePostgres();
    return withStore(fake, {}, (store) =>
      Effect.gen(function* () {
        yield* store.set({ ...request, value: sampleState });
        yield* store.set({
          ...request,
          fqn: "app/prod/old",
          value: { ...(sampleState as object), status: "replaced" } as never,
        });

        const replaced = yield* store.getReplacedResources(request);
        expect(replaced).toHaveLength(1);
        expect(replaced[0]?.status).toBe("replaced");
      }),
    );
  });

  it.effect("lists stacks, stages, and fqns", () => {
    const fake = makeFakePostgres();
    return withStore(fake, {}, (store) =>
      Effect.gen(function* () {
        yield* store.set({ ...request, value: sampleState });
        yield* store.set({
          ...request,
          fqn: "app/prod/api",
          value: sampleState,
        });
        yield* store.setOutput({
          stack: "other",
          stage: "dev",
          value: { ok: true },
        });

        expect(yield* store.listStacks()).toEqual(["app", "other"]);
        expect(yield* store.listStages("app")).toEqual(["prod"]);
        expect(yield* store.list(request)).toEqual([
          "app/prod/api",
          "app/prod/db",
        ]);
      }),
    );
  });

  it.effect("deleteStack removes resource rows and stack outputs", () => {
    const fake = makeFakePostgres();
    return withStore(fake, {}, (store) =>
      Effect.gen(function* () {
        yield* store.set({ ...request, value: sampleState });
        yield* store.setOutput({ ...request, value: { ok: true } });

        yield* store.deleteStack({ stack: "app", stage: "prod" });
        expect(yield* store.get(request)).toBeUndefined();
        expect(yield* store.getOutput(request)).toBeUndefined();

        yield* store.set({ ...request, value: sampleState });
        yield* store.deleteStack({ stack: "app" });
        expect(fake.resources.size).toBe(0);
        expect(fake.outputs.size).toBe(0);
      }),
    );
  });

  it.effect("stage-less deleteStack locks every stage before deleting", () => {
    const fake = makeFakePostgres();
    // Rows written by an earlier run: this store has not touched the stack
    // yet, so it holds no leases when deleteStack starts.
    fake.resources.set("app prod app/prod/db", { status: "created" });
    fake.outputs.set("app prod", { ok: true });

    return withStore(fake, {}, (store) =>
      Effect.gen(function* () {
        yield* store.deleteStack({ stack: "app" });

        const lock = connectionRunning(
          fake.connections,
          "pg_try_advisory_lock",
        );
        expect(lock?.queries[0]?.values).toEqual(["alchemy:app/prod"]);
        expect(fake.resources.size).toBe(0);
        expect(fake.outputs.size).toBe(0);
      }),
    );
  });

  it.effect("delete removes a single resource", () => {
    const fake = makeFakePostgres();
    return withStore(fake, {}, (store) =>
      Effect.gen(function* () {
        yield* store.set({ ...request, value: sampleState });
        yield* store.delete(request);
        expect(yield* store.get(request)).toBeUndefined();
      }),
    );
  });
});
