import * as turso from "@distilled.cloud/turso/turso";
import { deepEqual } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { organization } from "./Credentials.ts";
import type { Providers } from "./Providers.ts";

export class DatabaseTokenUnexpectedResponse extends Data.TaggedError(
  "DatabaseTokenUnexpectedResponse",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Access level of a Turso SQL auth token. */
export type TokenAuthorization = "full-access" | "read-only";

/** Props shared by {@link DatabaseToken} and {@link GroupToken}. */
export interface SqlTokenProps {
  /**
   * Access level granted by the token.
   * @default "full-access"
   */
  authorization?: TokenAuthorization;
  /**
   * Token lifetime, e.g. `"2w"`, `"7d"`, `"1h30m"`. Omit for a token that
   * never expires. An expired token is re-minted on the next deploy.
   */
  expiration?: string;
  /**
   * Databases this token may `ATTACH` for reading (requires `allowAttach`
   * on those databases). Not supported on AWS-hosted databases.
   */
  readAttach?: string[];
}

/** Attributes shared by {@link DatabaseToken} and {@link GroupToken}. */
export interface SqlTokenAttributes {
  /** The token (a JWT), sent as `Authorization: Bearer <token>`. */
  token: Redacted.Redacted<string>;
  /** The organization slug the token belongs to. */
  organization: string;
  /** Access level granted by the token. */
  authorization: TokenAuthorization;
  /** Expiry as epoch milliseconds, or `undefined` for a non-expiring token. */
  expiresAt: number | undefined;
}

export interface DatabaseTokenProps extends SqlTokenProps {
  /** Name of the database the token grants access to (e.g. `db.name`). */
  database: string;
}

export interface DatabaseTokenAttributes extends SqlTokenAttributes {
  /** Name of the database the token grants access to. */
  database: string;
  /** UUID of the database the token was minted for. */
  dbId: string;
}

export type DatabaseToken = Resource<
  "Turso.DatabaseToken",
  DatabaseTokenProps,
  DatabaseTokenAttributes,
  never,
  Providers
>;

/**
 * A token that lets an app run SQL on one Turso database. Workers and
 * Lambdas should use {@link Connect}, which creates one for you. Use
 * `DatabaseToken` for anything else, such as a container or a CI job.
 *
 * You can't cancel a single token. Changing a prop creates a new token, but
 * the old one keeps working until it expires. Destroying the resource doesn't
 * stop it either. Give tokens you share an `expiration`, or cancel every token
 * for the database with `turso db tokens invalidate`.
 * @see https://docs.turso.tech/api-reference/databases/create-token
 *
 * ### Creating a Token
 * **Example:** Full-access token
 * ```typescript
 * const token = yield* Turso.DatabaseToken("Token", {
 *   database: db.name,
 * });
 * ```
 *
 * **Example:** Read-only token that expires after two weeks
 * ```typescript
 * const token = yield* Turso.DatabaseToken("ReadOnly", {
 *   database: db.name,
 *   authorization: "read-only",
 *   expiration: "2w",
 * });
 * ```
 *
 * @resource
 * @product Database
 */
export const DatabaseToken = Resource<DatabaseToken>("Turso.DatabaseToken");

/** Decode a Turso JWT's `exp` claim (seconds) to epoch milliseconds. */
export const tokenExpiry = (token: Redacted.Redacted<string>): number | undefined => {
  const payload = Redacted.value(token).split(".")[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      exp?: number;
    };
    return typeof claims.exp === "number" ? claims.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
};

/** Re-mint a token that expires within the hour. */
const RENEW_WITHIN_MS = 60 * 60 * 1000;

/**
 * `diff` for SQL tokens: an unchanged token that is about to expire still
 * needs an update, so the deploy re-mints it.
 */
export const diffSqlToken = Effect.fn(function* ({
  output,
}: {
  output: SqlTokenAttributes | undefined;
}) {
  if (output?.expiresAt === undefined) return undefined;
  const now = yield* Clock.currentTimeMillis;
  return output.expiresAt - now <= RENEW_WITHIN_MS ? ({ action: "update" } as const) : undefined;
});

/** Whether a previously minted token can be kept as-is. */
export const isTokenCurrent = Effect.fn(function* (
  output: SqlTokenAttributes | undefined,
  olds: SqlTokenProps | undefined,
  news: SqlTokenProps,
) {
  if (output === undefined || olds === undefined) return false;
  if (
    (news.authorization ?? "full-access") !== (olds.authorization ?? "full-access") ||
    news.expiration !== olds.expiration ||
    !deepEqual(news.readAttach ?? [], olds.readAttach ?? [])
  ) {
    return false;
  }
  if (output.expiresAt === undefined) return true;
  // Re-mint a token that expires within the hour, so a deploy never hands
  // consumers a token about to lapse.
  const now = yield* Clock.currentTimeMillis;
  return output.expiresAt - now > RENEW_WITHIN_MS;
});

export const DatabaseTokenProvider = () =>
  Provider.effect(
    DatabaseToken,
    Effect.gen(function* () {
      return {
        stables: ["organization"],
        diff: diffSqlToken,
        reconcile: Effect.fn(function* ({ news, olds, output }) {
          const org = output?.organization ?? (yield* organization);

          // Observe — the token is bound to the database's UUID, so a
          // database replaced under the same name invalidates it.
          const { database } = yield* turso.getDatabase({
            organizationSlug: org,
            databaseName: news.database,
          });
          const dbId = database?.DbId ?? "";
          if (
            output !== undefined &&
            output.database === news.database &&
            output.dbId === dbId &&
            (yield* isTokenCurrent(output, olds, news))
          ) {
            return output;
          }

          // Ensure — mint.
          const authorization = news.authorization ?? "full-access";
          const { jwt } = yield* turso.createDatabaseToken({
            organizationSlug: org,
            databaseName: news.database,
            authorization,
            expiration: news.expiration,
            permissions: news.readAttach
              ? { read_attach: { databases: news.readAttach } }
              : undefined,
          });
          if (!jwt) {
            return yield* new DatabaseTokenUnexpectedResponse({
              message: `Turso returned no token for ${news.database}`,
            });
          }
          return {
            token: jwt,
            organization: org,
            authorization,
            expiresAt: tokenExpiry(jwt),
            database: news.database,
            dbId,
          };
        }),
        // Turso cannot revoke a single token; it simply stops being tracked.
        delete: () => Effect.void,
      };
    }),
  );
