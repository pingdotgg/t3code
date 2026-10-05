import type * as secretmanager from "@distilled.cloud/gcp/secretmanager_v1";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { SecretBindingTarget } from "../SecretManager/BindingHttp.ts";
import type { Database } from "./Database.ts";
import type { Instance } from "./Instance.ts";
import type { User } from "./User.ts";

export interface ConnectOptions {
  /** Database to connect to. */
  database: Database;
  /** Built-in database user to log in as. */
  user: User;
  /**
   * Secret Manager secret whose `latest` version holds the user's
   * password.
   */
  passwordSecret: SecretBindingTarget;
}

export interface ConnectionInfo {
  /** Instance connection name `project:region:instance`. */
  connectionName: string;
  /** Unix socket directory, `/cloudsql/{connectionName}`. */
  socketPath: string;
  /** Database name. */
  database: string;
  /** Database user name. */
  username: string;
  /** Password read from the secret. */
  password: Redacted.Redacted<string>;
  /**
   * Connection URL over the Unix socket — `postgresql://…?host=/cloudsql/…`
   * for PostgreSQL, `mysql://…?socketPath=/cloudsql/…` for MySQL. Feed it
   * to `Drizzle.Postgres` / your driver. `Redacted` because it embeds the
   * password.
   */
  url: Redacted.Redacted<string>;
}

/** The password secret has no readable `latest` version. */
export class PasswordMissing extends Data.TaggedError(
  "GCP.SQL.PasswordMissing",
)<{ secret: string }> {}

/**
 * Runtime binding that connects a Cloud Run service to a Cloud SQL
 * instance over the Cloud SQL Unix socket — no public IP allow-list, no
 * VPC.
 *
 * Binding it at init grants `roles/cloudsql.client` on the project under
 * an IAM Condition naming only this instance, mounts the instance as the
 * service's `cloudsql` volume (the socket appears at
 * `/cloudsql/{connectionName}`), and grants
 * `roles/secretmanager.secretAccessor` on the password secret. The
 * returned Effect reads the password and resolves a {@link ConnectionInfo}
 * on each execution; no socket is opened. Provide
 * {@link ConnectHttp}. Cloud Run services only.
 *
 * ### Connecting with Drizzle
 * **Example:** Drizzle over the Cloud SQL socket
 * ```typescript
 * const connect = yield* GCP.SQL.Connect(instance, {
 *   database,
 *   user,
 *   passwordSecret,
 * });
 * const db = yield* Drizzle.Postgres(
 *   connect.pipe(Effect.map((info) => info.url)),
 * );
 * // …provided with Effect.provide(GCP.SQL.ConnectHttp)
 * ```
 *
 * @binding
 * @category SQL
 */
export interface Connect extends Binding.Service<
  Connect,
  "GCP.SQL.Connect",
  (
    instance: Instance,
    options: ConnectOptions,
  ) => Effect.Effect<
    Effect.Effect<
      ConnectionInfo,
      secretmanager.AccessProjectsSecretsVersionsError | PasswordMissing,
      RuntimeContext
    >
  >
> {}

export const Connect = Binding.Service<Connect>("GCP.SQL.Connect");
