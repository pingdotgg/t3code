import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import type { Server, ServerOptions } from "@prisma/dev";
import type { DatabaseDev } from "./Database.ts";

export interface PrismaDevDatabaseAttrs {
  directConnectionString: Redacted.Redacted<string>;
  pooledConnectionString: Redacted.Redacted<string>;
  accelerateConnectionString: Redacted.Redacted<string>;
  host: string | null;
  user: string | null;
  password: Redacted.Redacted<string> | undefined;
}

interface PrismaDevDatabaseEntry {
  optionsKey: string;
  migrationKey: string | undefined;
  server: Server;
  attrs: PrismaDevDatabaseAttrs | undefined;
}

const servers = new Map<string, PrismaDevDatabaseEntry>();
const startMutex = Semaphore.makeUnsafe(1);
const MIGRATION_OUTPUT_LIMIT_BYTES = 1024 * 1024;

const toError = (message: string) => (cause: unknown) =>
  cause instanceof Error ? cause : new Error(`${message}: ${String(cause)}`);

const importPrismaDev = Effect.tryPromise({
  try: () => import("@prisma/dev"),
  catch: toError("Failed to load @prisma/dev"),
});

const stableJson = (value: unknown) =>
  Effect.sync(() => JSON.stringify(value) ?? "");

const sanitizeName = (value: string) =>
  value.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "alchemy";

const optionsFrom = (databaseId: string, dev: DatabaseDev): ServerOptions => ({
  name: dev.name ?? `alchemy-${sanitizeName(databaseId)}`,
  persistenceMode: dev.persistenceMode ?? "stateful",
  port: dev.port,
  databasePort: dev.databasePort,
  shadowDatabasePort: dev.shadowDatabasePort,
  debug: dev.debug,
  databaseConnectTimeoutMillis: dev.databaseConnectTimeoutMillis,
  databaseIdleTimeoutMillis: dev.databaseIdleTimeoutMillis,
  shadowDatabaseConnectTimeoutMillis: dev.shadowDatabaseConnectTimeoutMillis,
  shadowDatabaseIdleTimeoutMillis: dev.shadowDatabaseIdleTimeoutMillis,
});

const parseUrl = (label: string, value: string) =>
  Effect.try({
    try: () => new URL(value),
    catch: toError(`Invalid ${label} connection string`),
  });

const normalizeConnectionString = Effect.fn(function* (value: string) {
  const url = yield* parseUrl("local Prisma", value);
  if (
    url.hostname === "localhost" ||
    url.hostname === "::1" ||
    url.hostname === "[::1]"
  ) {
    url.hostname = "127.0.0.1";
  }
  return url.toString();
});

const detailsFrom = Effect.fn(function* (value: string) {
  const url = yield* parseUrl("direct Prisma", value);
  return yield* Effect.try({
    try: () => ({
      host: url.hostname || null,
      user: url.username ? decodeURIComponent(url.username) : null,
      password: url.password
        ? Redacted.make(decodeURIComponent(url.password))
        : undefined,
    }),
    catch: toError("Invalid direct Prisma credentials"),
  });
});

export const prismaDevDatabaseAttrsFromServer = Effect.fn(function* (
  server: Server,
) {
  const direct = yield* normalizeConnectionString(
    server.database.prismaORMConnectionString ??
      server.database.connectionString,
  );
  const pooled = server.ppg.url;
  const details = yield* detailsFrom(direct);
  return {
    directConnectionString: Redacted.make(direct),
    pooledConnectionString: Redacted.make(pooled),
    accelerateConnectionString: Redacted.make(pooled),
    host: details.host,
    user: details.user,
    password: details.password,
  };
});

const startServer = Effect.fn(function* (
  databaseId: string,
  options: ServerOptions,
) {
  const prismaDev = yield* importPrismaDev;
  return yield* Semaphore.withPermits(
    startMutex,
    1,
  )(
    Effect.tryPromise({
      try: () => prismaDev.startPrismaDevServer(options),
      catch: toError(`Failed to start local Prisma database ${databaseId}`),
    }),
  );
});

const closeEntry = Effect.fn(function* (entry: PrismaDevDatabaseEntry) {
  yield* Effect.tryPromise({
    try: () => entry.server.close(),
    catch: toError("Failed to stop local Prisma database"),
  });
});

const collectMigrationOutput = <E>(
  stream: Stream.Stream<Uint8Array, E>,
  label: "stdout" | "stderr",
) =>
  Stream.runFoldEffect(
    stream,
    () => ({ chunks: [] as Uint8Array[], bytes: 0 }),
    (state, chunk) => {
      const bytes = state.bytes + chunk.byteLength;
      return bytes > MIGRATION_OUTPUT_LIMIT_BYTES
        ? Effect.fail(
            new Error(
              `Local Prisma migration ${label} exceeded the ${MIGRATION_OUTPUT_LIMIT_BYTES} byte safety limit. Reduce migration verbosity.`,
            ),
          )
        : Effect.succeed({ chunks: [...state.chunks, chunk], bytes });
    },
  ).pipe(
    Effect.map(({ chunks, bytes }) => {
      const output = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return new TextDecoder().decode(output);
    }),
  );

const sensitiveValuesFromUrl = (value: string) => {
  try {
    const url = new URL(value);
    const values = new Set<string>();
    const add = (secret: string | undefined) => {
      if (!secret) return;
      values.add(secret);
      try {
        values.add(decodeURIComponent(secret));
      } catch {
        // Keep the original value when it is not valid percent-encoding.
      }
      values.add(encodeURIComponent(secret));
    };
    add(url.username);
    add(url.password);
    for (const [key, secret] of url.searchParams) {
      if (/(?:api[_-]?key|token|secret|password|credential)/i.test(key)) {
        add(secret);
      }
    }
    return values;
  } catch {
    return new Set<string>();
  }
};

const redactMigrationOutput = (
  output: string,
  attrs: PrismaDevDatabaseAttrs,
) => {
  const password = attrs.password ? Redacted.value(attrs.password) : undefined;
  const connectionStrings = [
    Redacted.value(attrs.directConnectionString),
    Redacted.value(attrs.pooledConnectionString),
    Redacted.value(attrs.accelerateConnectionString),
  ];
  const knownSecrets = [
    ...connectionStrings,
    ...connectionStrings.flatMap((value) => [...sensitiveValuesFromUrl(value)]),
    password,
    password === undefined ? undefined : encodeURIComponent(password),
  ]
    .filter((value): value is string => value !== undefined && value !== "")
    .sort((left, right) => right.length - left.length);
  return knownSecrets.reduce(
    (redacted, secret) => redacted.split(secret).join("[REDACTED]"),
    output,
  );
};

const runMigration = Effect.fn(function* (
  dev: DatabaseDev,
  attrs: PrismaDevDatabaseAttrs,
  timeoutSeconds: number,
) {
  const path = yield* Path.Path;
  const command = dev.migrate;
  if (command === undefined || command.trim() === "") return;

  const cwd = dev.migrateCwd ? path.resolve(dev.migrateCwd) : path.resolve(".");
  const resultOption = yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* ChildProcess.make(command, [], {
        shell: true,
        cwd,
        env: {
          DATABASE_URL: Redacted.value(attrs.pooledConnectionString),
          DIRECT_URL: Redacted.value(attrs.directConnectionString),
          POOLED_DATABASE_URL: Redacted.value(attrs.pooledConnectionString),
        },
        extendEnv: true,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        // Scoped interruption must terminate the entire POSIX process group
        // immediately. The Effect process runtime defaults to a detached group
        // on POSIX, so descendants cannot outlive a timed-out migration.
        killSignal: "SIGKILL",
      });
      return yield* Effect.all(
        [
          handle.exitCode,
          collectMigrationOutput(handle.stdout, "stdout"),
          collectMigrationOutput(handle.stderr, "stderr"),
        ] as const,
        { concurrency: 3 },
      );
    }).pipe(Effect.timeoutOption(Duration.seconds(timeoutSeconds))),
  );
  if (Option.isNone(resultOption)) {
    return yield* Effect.fail(
      new Error(
        `Local Prisma migration command timed out after ${timeoutSeconds} seconds and was terminated.`,
      ),
    );
  }
  const [exitCode, rawStdout, rawStderr] = resultOption.value;
  const stdout = redactMigrationOutput(rawStdout, attrs);
  const stderr = redactMigrationOutput(rawStderr, attrs);
  if (exitCode !== 0) {
    return yield* Effect.fail(
      new Error(
        `Local Prisma migration command failed with exit code ${exitCode}${stderr ? `\n${stderr}` : ""}`,
      ),
    );
  }
  if (stdout) yield* Effect.logDebug("Local Prisma migration output", stdout);
  if (stderr) yield* Effect.logDebug("Local Prisma migration stderr", stderr);
});

export const ensurePrismaDevDatabase = Effect.fn(function* (
  databaseId: string,
  dev: false | DatabaseDev | undefined,
) {
  if (dev === false) {
    const cached = servers.get(databaseId);
    if (cached !== undefined) {
      yield* closeEntry(cached);
      servers.delete(databaseId);
    }
    return undefined;
  }
  const config: DatabaseDev = dev ?? {};
  if (config.provider !== undefined && config.provider !== "@prisma/dev") {
    return yield* Effect.fail(
      new Error(
        `Unsupported Prisma local database provider ${config.provider}`,
      ),
    );
  }
  const migrateTimeoutSeconds = config.migrateTimeoutSeconds ?? 900;
  if (!Number.isFinite(migrateTimeoutSeconds) || migrateTimeoutSeconds <= 0) {
    return yield* Effect.fail(
      new Error("migrateTimeoutSeconds must be a positive finite number."),
    );
  }

  const options = optionsFrom(databaseId, config);
  const optionsKey = yield* stableJson(options);
  const cached = servers.get(databaseId);
  let entry = cached;
  if (
    entry === undefined ||
    entry.optionsKey !== optionsKey ||
    entry.attrs === undefined
  ) {
    if (entry !== undefined) {
      // Keep the handle tracked when close fails so a later cleanup can retry
      // instead of leaking an unreachable local database process.
      yield* closeEntry(entry);
      servers.delete(databaseId);
    }
    const server = yield* startServer(databaseId, options);
    // `@prisma/dev` binds Postgres/HTTP to 127.0.0.1. Native Linux Docker
    // must not SYN the bridge IP (UFW INPUT). The workerd sidecar proxy
    // unix-socket-tunnels these ports into the container netns.
    const attrsResult = yield* Effect.result(
      prismaDevDatabaseAttrsFromServer(server),
    );
    if (Result.isFailure(attrsResult)) {
      const closeResult = yield* Effect.result(
        Effect.tryPromise({
          try: () => server.close(),
          catch: toError("Failed to stop invalid local Prisma database"),
        }),
      );
      if (Result.isFailure(closeResult)) {
        servers.set(databaseId, {
          optionsKey,
          migrationKey: undefined,
          server,
          attrs: undefined,
        });
        return yield* Effect.fail(
          new AggregateError(
            [attrsResult.failure, closeResult.failure],
            `Failed to initialize and stop local Prisma database ${databaseId}`,
          ),
        );
      }
      return yield* Effect.fail(attrsResult.failure);
    }
    const attrs = attrsResult.success;
    entry = {
      optionsKey,
      migrationKey: undefined,
      server,
      attrs,
    };
    servers.set(databaseId, entry);
  }

  if (entry.attrs === undefined) {
    return yield* Effect.fail(
      new Error(`Local Prisma database ${databaseId} has no usable endpoints.`),
    );
  }
  const attrs = entry.attrs;

  if (config.migrate !== undefined && config.migrate.trim() !== "") {
    const migrationKey = yield* stableJson({
      command: config.migrate,
      cwd: config.migrateCwd,
      optionsKey,
    });
    if (entry.migrationKey !== migrationKey) {
      yield* runMigration(config, attrs, migrateTimeoutSeconds);
      entry.migrationKey = migrationKey;
    }
  }

  return attrs;
});

export const closePrismaDevDatabase = Effect.fn(function* (databaseId: string) {
  const entry = servers.get(databaseId);
  if (entry === undefined) return;
  yield* closeEntry(entry);
  servers.delete(databaseId);
});

export const closePrismaDevDatabases = Effect.fn(function* () {
  const ids = Array.from(servers.keys());
  const failures: Error[] = [];
  for (const id of ids) {
    const result = yield* closePrismaDevDatabase(id).pipe(Effect.result);
    if (Result.isFailure(result)) failures.push(result.failure);
  }
  if (failures.length === 1) {
    return yield* Effect.fail(failures[0]!);
  }
  if (failures.length > 1) {
    return yield* Effect.fail(
      new AggregateError(
        failures,
        `Failed to stop ${failures.length} local Prisma databases`,
      ),
    );
  }
});
