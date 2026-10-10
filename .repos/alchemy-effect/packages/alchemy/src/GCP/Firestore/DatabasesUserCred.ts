import * as firestore from "@distilled.cloud/gcp/firestore_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  databaseIdOf,
  databaseNameOf,
  lastSegment,
  parseDatabaseName,
  toResourceId,
} from "./internal.ts";

export type DatabasesUserCredProps = {
  /**
   * Parent database. Full name `projects/{project}/databases/{database}`
   * or the database id. User creds require an Enterprise edition
   * database with MongoDB-compatible API access enabled. Immutable —
   * changing it replaces the creds.
   */
  database: string;
  /**
   * User creds id (the `{user_creds}` segment of
   * `.../databases/{database}/userCreds/{user_creds}`). If omitted, a
   * unique name is generated. Must be 4-63 characters, match
   * `[a-z][a-z0-9-]*[a-z0-9]`, and must not look like a UUID.
   * Immutable — changing it replaces the creds.
   */
  userCredsId?: string;
  /**
   * Disable the creds. Enable/disable updates in place.
   * @default false
   */
  disabled?: boolean;
};

export type DatabasesUserCred = Resource<
  "GCP.Firestore.DatabasesUserCred",
  DatabasesUserCredProps,
  {
    /** Full resource name `.../databases/{database}/userCreds/{user_creds}`. */
    name: string;
    /** User creds id (last path segment). */
    userCredsId: string;
    /** Parent database resource name. */
    database: string;
    /** Parent database id. */
    databaseId: string;
    /** Project id. */
    project: string;
    /** Whether the creds are disabled. */
    disabled: boolean;
    /** Server-reported state (`ENABLED`, `DISABLED`). */
    state: string | undefined;
    /**
     * Plaintext server-generated password. Only populated on create and
     * password reset; later reads preserve the last known value.
     */
    securePassword: string | undefined;
    /** Resource Identity principal, if any. */
    principal: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * User credentials for a Cloud Firestore database with MongoDB
 * compatibility.
 *
 * User creds are owned by the parent database and require Enterprise
 * edition with the MongoDB-compatible API enabled. The plaintext
 * password is returned only on create (and password reset); later
 * reads keep the last known value from state. Enable/disable updates
 * in place. Changing `userCredsId` or `database` replaces the creds.
 *
 * User creds have no labels field: `read` reports creds it finds without
 * prior state as unowned (adopt them with `--adopt`).
 *
 * ### Creating User Creds
 * **Example:** Enabled creds on an Enterprise database
 * ```typescript
 * const database = yield* GCP.Firestore.Database("App", {
 *   location: "us-central1",
 *   databaseEdition: "ENTERPRISE",
 *   mongodbCompatibleDataAccessMode: "DATA_ACCESS_MODE_ENABLED",
 * });
 * const creds = yield* GCP.Firestore.DatabasesUserCred("AppUser", {
 *   database: database.name,
 * });
 * ```
 *
 * **Example:** Disabled creds
 * ```typescript
 * const creds = yield* GCP.Firestore.DatabasesUserCred("AppUser", {
 *   database: database.name,
 *   disabled: true,
 * });
 * ```
 *
 * @resource
 * @category Firestore
 */
export const DatabasesUserCred = Resource<DatabasesUserCred>(
  "GCP.Firestore.DatabasesUserCred",
);

export class UserCredNotResolved extends Data.TaggedError(
  "GCP.Firestore.UserCredNotResolved",
)<{
  name: string;
}> {}

export class UserCredStillExists extends Data.TaggedError(
  "GCP.Firestore.UserCredStillExists",
)<{
  name: string;
}> {}

const resourceName = (databaseName: string, userCredsId: string) =>
  `${databaseName}/userCreds/${userCredsId}`;

const toAttrs = (
  creds: firestore.GoogleFirestoreAdminV1UserCreds,
  project: string,
  securePassword?: string,
): DatabasesUserCred["Attributes"] => {
  const name = creds.name ?? "";
  const parsed = parseDatabaseName(name);
  const state = creds.state;
  return {
    name,
    userCredsId: parsed.userCredsId || lastSegment(name),
    database: databaseNameOf(parsed.project || project, parsed.databaseId),
    databaseId: parsed.databaseId,
    project: parsed.project || project,
    disabled: state === "DISABLED",
    state,
    securePassword: creds.securePassword ?? securePassword,
    principal: creds.resourceIdentity?.principal,
    createTime: creds.createTime,
    updateTime: creds.updateTime,
  };
};

const getByName = (name: string) =>
  firestore
    .getProjectsDatabasesUserCreds({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOnDatabase = (parent: string) =>
  firestore.listProjectsDatabasesUserCreds({ parent }).pipe(
    Effect.map((page) => page.userCreds ?? []),
    Effect.catchTag("NotFound", () =>
      Effect.succeed([] as firestore.GoogleFirestoreAdminV1UserCreds[]),
    ),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (creds) => creds === undefined,
      () => new UserCredStillExists({ name }),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Firestore.UserCredStillExists",
      times: 8,
      schedule: Schedule.spaced("2 seconds"),
    }),
    Effect.asVoid,
  );

const syncEnabled = (
  name: string,
  disabled: boolean,
  current: firestore.GoogleFirestoreAdminV1UserCreds,
) => {
  const isDisabled = current.state === "DISABLED";
  if (isDisabled === disabled) return Effect.succeed(current);
  return disabled
    ? firestore.disableProjectsDatabasesUserCreds({ name, body: {} })
    : firestore.enableProjectsDatabasesUserCreds({ name, body: {} });
};

export const DatabasesUserCredProvider = () =>
  Provider.succeed(DatabasesUserCred, {
    stables: [
      "name",
      "userCredsId",
      "database",
      "databaseId",
      "project",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.userCredsId ?? output?.userCredsId;
      const nextId = news.userCredsId ?? previousId;
      const previousDatabase = databaseIdOf(
        olds?.database ?? output?.database ?? output?.databaseId ?? "",
      );
      const nextDatabase = databaseIdOf(news.database);
      if (
        (previousId !== undefined &&
          nextId !== undefined &&
          previousId !== nextId) ||
        (previousDatabase.length > 0 && previousDatabase !== nextDatabase)
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const userCredsId = yield* toResourceId(
        id,
        olds?.userCredsId,
        output?.userCredsId,
      );
      const databaseRef = olds?.database ?? output?.database;
      const name =
        output?.name ??
        (databaseRef !== undefined
          ? resourceName(databaseNameOf(env.project, databaseRef), userCredsId)
          : undefined);
      if (name === undefined) return undefined;
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, output?.securePassword);
      // No labels field: without prior state they may not be ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = databaseNameOf(env.project, news.database);
      const userCredsId = yield* toResourceId(
        id,
        news.userCredsId,
        output?.userCredsId,
      );
      const name = resourceName(parent, userCredsId);
      const disabled = news.disabled === true;

      let current = yield* getByName(output?.name ?? name);
      let createdPassword = output?.securePassword;

      if (current === undefined) {
        const created = yield* firestore
          .createProjectsDatabasesUserCreds({
            parent,
            userCredsId,
            body: {},
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              listOnDatabase(parent).pipe(
                Effect.map(
                  (creds) =>
                    creds.find(
                      (item) => lastSegment(item.name ?? "") === userCredsId,
                    ) ?? undefined,
                ),
                Effect.flatMap((found) =>
                  found !== undefined ? Effect.succeed(found) : getByName(name),
                ),
              ),
            ),
          );
        current = created ?? undefined;
        if (current?.securePassword !== undefined) {
          createdPassword = current.securePassword;
        }
      }

      if (current === undefined) {
        return yield* new UserCredNotResolved({ name });
      }

      current = yield* syncEnabled(current.name ?? name, disabled, current);
      return toAttrs(current, env.project, createdPassword);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* firestore
        .deleteProjectsDatabasesUserCreds({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone(output.name);
    }),
  });
