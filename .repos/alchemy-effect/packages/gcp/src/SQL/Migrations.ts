import * as crypto from "node:crypto";
import * as tls from "node:tls";
import {
  makeStatementExecutor,
  MigrationError,
  migrationError,
  probeExecutor,
  retryLogin,
  rowsFromCells,
  runMigrations,
  withMySqlExecutor,
  withPgExecutor,
  type NormalizedMigrationsInput,
  type SqlExecutor,
  type StampedMigrationsState,
} from "@alchemy.run/sql/Migrations";
import * as secretmanager from "@distilled.cloud/gcp/secretmanager_v1";
import * as sqladmin from "@distilled.cloud/gcp/sqladmin_v1";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

/**
 * How migrations reach a Cloud SQL database:
 *
 * - `"data-api"` — Cloud SQL's `instances.executeSql` over HTTPS. Needs
 *   `dataApiAccess: true` on the instance; no network route to the
 *   database. The Data API only reads passwords from Secret Manager, so
 *   each deploy stages the password in a short-lived regional secret.
 * - `"connector"` — a `pg`/`mysql2` connection from the deploying machine
 *   through the Cloud SQL connector (an ephemeral client certificate from
 *   the SQL Admin API, TLS to port 3307). Needs a route to the instance's
 *   public (or private) IP, but no authorized networks.
 */
export type MigrationsTransport = "data-api" | "connector";

/** The connector's server-side proxy port. */
const CONNECTOR_PORT = 3307;
const CONNECT_TIMEOUT_MILLIS = 15_000;

const dialectOf = (
  instance: string,
  databaseVersion: string | undefined,
): Effect.Effect<"postgres" | "mysql", MigrationError> => {
  const version = (databaseVersion ?? "").toUpperCase();
  if (version.startsWith("POSTGRES_")) return Effect.succeed("postgres");
  if (version.startsWith("MYSQL_")) return Effect.succeed("mysql");
  return Effect.fail(
    new MigrationError({
      message: `Cloud SQL instance '${instance}' runs ${databaseVersion ?? "an unknown engine"}; migrations support PostgreSQL and MySQL`,
    }),
  );
};

/** Secret ids allow letters, numbers, `-` and `_`, up to 255 characters. */
const stagedSecretId = (instance: string, database: string) =>
  `alchemy-migrations-${instance}-${database}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 255);

/**
 * Write the password into a regional secret in the instance's region for
 * the scope of `use`, then delete the secret. The id is deterministic, so a
 * secret left behind by a crashed deploy is reused and removed by the next.
 */
const withStagedPassword = <A, E, R>(
  options: {
    project: string;
    region: string;
    secretId: string;
    password: string;
    labels: Record<string, string>;
  },
  use: (secretVersion: string) => Effect.Effect<A, E, R>,
) => {
  const parent = `projects/${options.project}/locations/${options.region}`;
  const name = `${parent}/secrets/${options.secretId}`;
  return Effect.acquireUseRelease(
    Effect.gen(function* () {
      const data = yield* Effect.sync(() =>
        Buffer.from(options.password, "utf8").toString("base64"),
      );
      yield* secretmanager
        .createProjectsLocationsSecrets({
          parent,
          secretId: options.secretId,
          body: { labels: options.labels },
        })
        .pipe(Effect.catchTag("Conflict", () => Effect.void));
      const version = yield* secretmanager.addVersionProjectsLocationsSecrets({
        parent: name,
        body: { payload: { data } },
      });
      return version.name ?? `${name}/versions/latest`;
    }).pipe(Effect.mapError(migrationError(`Staging the migrations password in ${name}`))),
    use,
    () =>
      secretmanager.deleteProjectsLocationsSecrets({ name }).pipe(
        Effect.catchTag("NotFound", () => Effect.void),
        Effect.ignore,
      ),
  );
};

/**
 * `instances.executeSql` as a {@link SqlExecutor}: each migration batch is
 * one request wrapped in a transaction (MySQL DDL still commits
 * implicitly).
 */
const makeDataApiExecutor = Effect.fn(function* (options: {
  dialect: "postgres" | "mysql";
  project: string;
  instance: string;
  database: string;
  user: string;
  passwordSecretVersion: string;
}) {
  const executeSql = yield* sqladmin.executeSqlInstances;
  return makeStatementExecutor({
    dialect: options.dialect,
    batch: "transaction",
    execute: (sqlStatement) =>
      executeSql({
        project: options.project,
        instance: options.instance,
        body: {
          database: options.database,
          user: options.user,
          passwordSecretVersion: options.passwordSecretVersion,
          sqlStatement,
        },
      }).pipe(
        Effect.mapError(migrationError(`executeSql on '${options.instance}'`)),
        // SQL errors come back inside a 200 response.
        Effect.flatMap((response) => {
          const failure = response.status?.code
            ? response.status
            : response.results?.find((result) => result.status?.code)?.status;
          if (failure) {
            return Effect.fail(
              new MigrationError({
                message: `executeSql on '${options.instance}' failed: ${failure.message ?? `code ${failure.code}`}`,
              }),
            );
          }
          const last = response.results?.at(-1);
          return Effect.succeed(rowsFromCells(last?.columns, last?.rows));
        }),
      ),
  });
});

/**
 * Open a TLS socket to the instance through the Cloud SQL connector: an
 * ephemeral client certificate signed by the SQL Admin API, verified
 * against the instance's server CA. The socket is ready for the database
 * protocol (no `SSLRequest`, no MySQL TLS upgrade).
 */
const dialConnector = Effect.fn(function* (options: { project: string; instance: string }) {
  const settings = yield* sqladmin
    .getConnect({ project: options.project, instance: options.instance })
    .pipe(Effect.mapError(migrationError(`Reading connect settings of '${options.instance}'`)));
  const address =
    settings.ipAddresses?.find((ip) => ip.type === "PRIMARY")?.ipAddress ??
    settings.ipAddresses?.find((ip) => ip.type === "PRIVATE")?.ipAddress;
  const serverCa = settings.serverCaCert?.cert;
  if (!address || !serverCa) {
    return yield* new MigrationError({
      message: `Cloud SQL instance '${options.instance}' has no IP address to connect to`,
    });
  }
  const keys = yield* Effect.sync(() =>
    crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    }),
  );
  const ephemeral = yield* sqladmin
    .generateEphemeralCertConnect({
      project: options.project,
      instance: options.instance,
      body: { public_key: keys.publicKey },
    })
    .pipe(
      Effect.mapError(migrationError(`Requesting a client certificate for '${options.instance}'`)),
    );
  const clientCert = ephemeral.ephemeralCert?.cert;
  if (!clientCert) {
    return yield* new MigrationError({
      message: `The SQL Admin API returned no client certificate for '${options.instance}'`,
    });
  }
  // Per-instance CAs name the instance `project:instance`; shared and
  // customer CAs identify it by its DNS name.
  const legacyName = `${options.project}:${options.instance}`;
  const dnsName = settings.serverCaMode?.includes("CAS") ? settings.dnsName : undefined;
  return yield* Effect.callback<tls.TLSSocket, MigrationError>((resume) => {
    const socket = tls.connect({
      host: address,
      port: CONNECTOR_PORT,
      ca: serverCa,
      cert: clientCert,
      key: keys.privateKey,
      servername: dnsName,
      timeout: CONNECT_TIMEOUT_MILLIS,
      checkServerIdentity: (host, cert) =>
        dnsName
          ? tls.checkServerIdentity(dnsName.replace(/\.$/, ""), cert)
          : cert.subject.CN === legacyName
            ? undefined
            : new Error(
                `server certificate names '${[cert.subject.CN].flat().join(", ")}', expected '${legacyName}'`,
              ),
    });
    const fail = (cause: Error) => {
      socket.destroy();
      resume(
        Effect.fail(
          new MigrationError({
            message: `Failed to connect to '${options.instance}' at ${address}:${CONNECTOR_PORT}: ${cause.message}`,
            cause,
          }),
        ),
      );
    };
    socket.once("error", fail);
    socket.once("timeout", () => fail(new Error("timed out")));
    socket.once("secureConnect", () => {
      socket.off("error", fail);
      socket.setTimeout(0);
      resume(Effect.succeed(socket));
    });
    return Effect.sync(() => socket.destroy());
  });
});

/**
 * A `pg`/`mysql2` session over the Cloud SQL connector for the scope of
 * `use`. A new user's login delay is retried on the dial and login, never
 * on `use`.
 */
const withConnectorExecutor = <A, E, R>(
  options: {
    dialect: "postgres" | "mysql";
    project: string;
    instance: string;
    database: string;
    user: string;
    password: string;
  },
  use: (executor: SqlExecutor) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const socket = yield* dialConnector(options);
    const credentials = {
      database: options.database,
      user: options.user,
      password: options.password,
    };
    return yield* options.dialect === "postgres"
      ? withPgExecutor(
          {
            ...credentials,
            // `pg` dials its stream itself; this one is already connected.
            stream: () =>
              Object.assign(socket, {
                connect: () => {
                  process.nextTick(() => socket.emit("connect"));
                  return socket;
                },
              }),
            ssl: false,
          },
          use,
        )
      : withMySqlExecutor({ ...credentials, stream: socket }, use);
  });

/**
 * Apply migrations to a database on a Cloud SQL instance. Call once the
 * database exists.
 */
export const runDatabaseMigrations = Effect.fn(function* (options: {
  project: string;
  instance: string;
  database: string;
  input: NormalizedMigrationsInput;
  stamped: StampedMigrationsState;
  transport: MigrationsTransport | undefined;
  user: string | undefined;
  password: string | Redacted.Redacted<string> | undefined;
  labels: Record<string, string>;
}) {
  const { project, instance, database } = options;
  const live = yield* sqladmin
    .getInstances({ project, instance })
    .pipe(Effect.mapError(migrationError(`Reading Cloud SQL instance '${instance}'`)));
  const dialect = yield* dialectOf(instance, live.databaseVersion);
  if (options.user === undefined || options.password === undefined) {
    return yield* new MigrationError({
      message: `Migrations on '${instance}/${database}' need credentials; set migrationsUser and migrationsPassword`,
    });
  }
  const user = options.user;
  const password = Redacted.isRedacted(options.password)
    ? Redacted.value(options.password)
    : options.password;
  const dataApi = live.settings?.dataApiAccess === "ALLOW_DATA_API";
  const transport = options.transport ?? (dataApi ? "data-api" : "connector");

  if (transport === "data-api") {
    if (!dataApi) {
      return yield* new MigrationError({
        message: `migrationsTransport "data-api" needs dataApiAccess: true on Cloud SQL instance '${instance}'`,
      });
    }
    const region = live.region;
    if (!region) {
      return yield* new MigrationError({
        message: `Cloud SQL instance '${instance}' has no region`,
      });
    }
    return yield* runMigrations({
      input: options.input,
      stamped: options.stamped,
      withExecutor: (apply) =>
        withStagedPassword(
          {
            project,
            region,
            secretId: stagedSecretId(instance, database),
            password,
            labels: options.labels,
          },
          (passwordSecretVersion) =>
            makeDataApiExecutor({
              dialect,
              project,
              instance,
              database,
              user,
              passwordSecretVersion,
            }).pipe(Effect.flatMap(probeExecutor), Effect.flatMap(apply)),
        ),
    });
  }

  const target = { dialect, project, instance, database, user, password };
  return yield* runMigrations({
    input: options.input,
    stamped: options.stamped,
    withExecutor: (apply) =>
      // Logins fail while opening the session, so probe with a session of
      // its own; the retry never reruns `apply`.
      retryLogin(withConnectorExecutor(target, (executor) => executor.query("SELECT 1"))).pipe(
        Effect.andThen(withConnectorExecutor(target, apply)),
      ),
  });
});
