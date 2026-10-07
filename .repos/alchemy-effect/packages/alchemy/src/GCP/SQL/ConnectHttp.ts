import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Output from "../../Output.ts";
import { bindGcpHost } from "../Host.ts";
import { CLOUD_SQL_MOUNT_PATH } from "../HostRuntime.ts";
import { grantFor } from "../HttpBinding.ts";
import { ReadSecret } from "../SecretManager/ReadSecret.ts";
import { ReadSecretHttp } from "../SecretManager/ReadSecretHttp.ts";
import {
  Connect,
  PasswordMissing,
  type ConnectionInfo,
  type ConnectOptions,
} from "./Connect.ts";
import type { Instance } from "./Instance.ts";

const socketUrl = (options: {
  databaseVersion: string | undefined;
  socketPath: string;
  database: string;
  username: string;
  password: string;
}) => {
  const mysql = (options.databaseVersion ?? "")
    .toUpperCase()
    .startsWith("MYSQL_");
  // The socket travels as a query parameter; `localhost` only satisfies
  // URL parsers that reject credentials with an empty host.
  const url = new URL(
    `${mysql ? "mysql" : "postgresql"}://localhost/${encodeURIComponent(options.database)}`,
  );
  url.username = encodeURIComponent(options.username);
  url.password = encodeURIComponent(options.password);
  url.searchParams.set(mysql ? "socketPath" : "host", options.socketPath);
  return url.toString();
};

/**
 * HTTP implementation of {@link Connect}: reads the password through
 * `GCP.SecretManager.ReadSecret` and connects over the Cloud Run
 * `cloudsql` socket volume.
 *
 * @layer
 * @provides GCP.SQL.Connect
 * @category SQL
 */
export const ConnectHttp = Layer.effect(
  Connect,
  Effect.gen(function* () {
    const readSecret = yield* ReadSecret;
    return Effect.fn(function* (instance: Instance, options: ConnectOptions) {
      yield* bindGcpHost({
        tag: "GCP.SQL.Connect",
        resource: instance,
        // Cloud SQL has no instance-level IAM policy; an IAM Condition
        // scopes the project grant to this instance.
        iam: [
          grantFor(
            { role: "roles/cloudsql.client", scopeByCondition: true },
            Output.interpolate`projects/${instance.project}/instances/${instance.instanceName}`,
          ),
        ],
        cloudSqlInstances: [
          Output.interpolate`${instance.project}:${instance.region}:${instance.instanceName}`,
        ],
      });
      const password = yield* readSecret(options.passwordSecret);
      const project = yield* instance.project;
      const region = yield* instance.region;
      const instanceName = yield* instance.instanceName;
      const databaseVersion = yield* instance.databaseVersion;
      const database = yield* options.database.databaseName;
      const username = yield* options.user.userName;
      const secretName = yield* options.passwordSecret.name;

      return Effect.gen(function* () {
        const value = yield* password.access();
        if (value === undefined) {
          return yield* new PasswordMissing({ secret: yield* secretName });
        }
        const connectionName = `${yield* project}:${yield* region}:${yield* instanceName}`;
        const socketPath = `${CLOUD_SQL_MOUNT_PATH}/${connectionName}`;
        const databaseName = yield* database;
        const userName = yield* username;
        const info: ConnectionInfo = {
          connectionName,
          socketPath,
          database: databaseName,
          username: userName,
          password: Redacted.make(value),
          url: Redacted.make(
            socketUrl({
              databaseVersion: yield* databaseVersion,
              socketPath,
              database: databaseName,
              username: userName,
              password: value,
            }),
          ),
        };
        return info;
      });
    });
  }),
).pipe(Layer.provide(ReadSecretHttp));
