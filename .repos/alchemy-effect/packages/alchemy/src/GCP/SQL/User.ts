import * as sqladmin from "@distilled.cloud/gcp/sqladmin_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { ALCHEMY_LABEL_PREFIX } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import { recoverIfInstanceMissing, waitForSqlOperation } from "./operations.ts";

const MAX_NAME_LENGTH = 32;

const SYSTEM_USERS = new Set([
  "root",
  "postgres",
  "sqlserver",
  "cloudsqladmin",
  "cloudsqlsuperuser",
  "cloudsqlagent",
  "cloudsqliamuser",
  "cloudsqliamserviceaccount",
  "cloudsqliamgroup",
  "cloudsqlreplica",
  "cloudsqlreadonly",
  "cloudsqlapplier",
  "mysql.sys",
  "mysql.session",
  "mysql.infoschema",
]);

const AUTO_USER_TYPES = new Set([
  "CLOUD_IAM_GROUP_USER",
  "CLOUD_IAM_GROUP_SERVICE_ACCOUNT",
]);

export type UserDeletionPolicy = "DELETE" | "ABANDON";

export type UserType = sqladmin.UserTypeEnum | (string & {});

export type DualPasswordType =
  | sqladmin.UserDualPasswordTypeEnum
  | (string & {});

export type SqlServerUserDetails = {
  /**
   * Disable this SQL Server login.
   */
  disabled?: boolean;
  /**
   * SQL Server server-level roles (`sysadmin`, `dbcreator`, …).
   */
  serverRoles?: string[];
};

export type UserPasswordPolicy = {
  /**
   * Failed login attempts allowed before the user is locked.
   */
  allowedFailedAttempts?: number;
  /**
   * How long a password stays valid after it is set (duration string).
   */
  passwordExpirationDuration?: string;
  /**
   * Enable the failed-attempts lockout check.
   */
  enableFailedAttemptsCheck?: boolean;
  /**
   * Require the current password when changing it. MySQL only.
   */
  enablePasswordVerification?: boolean;
};

export type UserPasswordPolicyStatus = {
  /** Whether the user is locked out of login. */
  locked?: boolean;
  /** RFC3339 expiration of the current password. */
  passwordExpirationTime?: string;
};

export type UserProps = {
  /**
   * Cloud SQL instance id (the `{instance}` segment of
   * `projects/{project}/instances/{instance}`). Full resource names are
   * accepted and reduced to the last path segment. Immutable — changing
   * it replaces the user.
   */
  instance: string;
  /**
   * Database user name. If omitted, a unique name is generated from the
   * stack, stage, and logical id. MySQL limits names to 32 characters.
   * Immutable — changing it replaces the user.
   */
  userName?: string;
  /**
   * Host the user can connect from. MySQL `BUILT_IN` users only; omit
   * for PostgreSQL and SQL Server. Immutable — changing it replaces the
   * user. `"%"` allows any host.
   */
  host?: string;
  /**
   * Password for `BUILT_IN` users. Write-only — never returned by the
   * API. Required for PostgreSQL built-in users. Omit for IAM user
   * types. Updating this value rotates the password. Accepts a
   * `Redacted` value (e.g. `Alchemy.Random`'s `text`).
   */
  password?: string | Redacted.Redacted<string>;
  /**
   * Authentication type (`BUILT_IN`, `CLOUD_IAM_USER`,
   * `CLOUD_IAM_SERVICE_ACCOUNT`, `CLOUD_IAM_GROUP`, …). Immutable —
   * changing it replaces the user.
   * @default "BUILT_IN"
   */
  type?: UserType;
  /**
   * PostgreSQL / MySQL database roles to grant (`cloudsqlsuperuser`, …).
   */
  databaseRoles?: string[];
  /**
   * User-level password validation policy (MySQL).
   */
  passwordPolicy?: UserPasswordPolicy;
  /**
   * Dual password status (`NO_DUAL_PASSWORD`, `DUAL_PASSWORD`, …).
   */
  dualPasswordType?: DualPasswordType;
  /**
   * SQL Server–only login details. Ignored on MySQL and PostgreSQL.
   */
  sqlserverUserDetails?: SqlServerUserDetails;
  /**
   * Full email for an IAM user. MySQL IAM users only.
   */
  iamEmail?: string;
  /**
   * What to do on destroy. `ABANDON` removes the user from state without
   * calling the Cloud SQL API — useful when the parent instance is being
   * deleted, or when a PostgreSQL user still holds roles.
   * @default "DELETE"
   */
  deletionPolicy?: UserDeletionPolicy;
};

export type User = Resource<
  "GCP.SQL.User",
  UserProps,
  {
    /** Database user name. */
    userName: string;
    /** Host the user can connect from, if set. */
    host: string | undefined;
    /** Cloud SQL instance id. */
    instance: string;
    /** Project id. */
    project: string;
    /** Authentication type. */
    type: string | undefined;
    /** IAM email, if this is an IAM user. */
    iamEmail: string | undefined;
    /** Granted database roles. */
    databaseRoles: string[] | undefined;
    /** Password policy currently on the user. */
    passwordPolicy:
      | (UserPasswordPolicy & { status?: UserPasswordPolicyStatus })
      | undefined;
    /** Dual password status. */
    dualPasswordType: string | undefined;
    /** SQL Server details, if this is a SQL Server login. */
    sqlserverUserDetails: SqlServerUserDetails | undefined;
    /** IAM group availability (`ACTIVE`, `INACTIVE`, …). */
    iamStatus: string | undefined;
    /** HTTP etag. */
    etag: string | undefined;
  },
  never,
  Providers
>;

/**
 * A database user on a Cloud SQL instance.
 *
 * Cloud SQL users have no labels field. `list` enumerates non-system
 * users on alchemy-labeled instances so `pnpm nuke:gcp` can find leaked
 * rows without dropping `root` / `postgres` / `cloudsqladmin`.
 *
 * Changing `instance`, `userName`, `host`, or `type` replaces the user.
 * `password`, `databaseRoles`, and `passwordPolicy` update in place.
 *
 * ### Creating a User
 * **Example:** Generated name on a Cloud SQL instance
 * ```typescript
 * const instance = yield* GCP.SQL.Instance("AppDb", {
 *   tier: "db-f1-micro",
 *   backupEnabled: false,
 * });
 * const appUser = yield* GCP.SQL.User("AppUser", {
 *   instance: instance.instanceName,
 *   password: "change-me",
 * });
 * ```
 *
 * **Example:** Explicit MySQL user and host
 * ```typescript
 * const appUser = yield* GCP.SQL.User("AppUser", {
 *   instance: instance.instanceName,
 *   userName: "app",
 *   host: "%",
 *   password: "change-me",
 *   type: "BUILT_IN",
 * });
 * ```
 *
 * ### IAM Users
 * **Example:** Cloud IAM database user
 * ```typescript
 * const iamUser = yield* GCP.SQL.User("IamUser", {
 *   instance: instance.instanceName,
 *   userName: "alice@example.com",
 *   type: "CLOUD_IAM_USER",
 * });
 * ```
 *
 * @resource
 * @category SQL
 */
export const User = Resource<User>("GCP.SQL.User");

export class UserNotResolved extends Data.TaggedError(
  "GCP.SQL.UserNotResolved",
)<{
  instance: string;
  userName: string;
  host: string | undefined;
}> {}

export class UserStillExists extends Data.TaggedError(
  "GCP.SQL.UserStillExists",
)<{
  instance: string;
  userName: string;
  host: string | undefined;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const instanceIdOf = (value: string) => lastSegment(value);

const normalizeHost = (host: string | undefined) => host ?? "";

const typeOf = (type: string | undefined) => (type ?? "BUILT_IN").toUpperCase();

const isIamType = (type: string | undefined) => {
  const value = typeOf(type);
  return value.startsWith("CLOUD_IAM") || value === "ENTRAID_USER";
};

const hasAlchemyInstanceLabels = (
  labels: Record<string, string | undefined> | null | undefined,
) =>
  Object.keys(labels ?? {}).some((key) => key.startsWith(ALCHEMY_LABEL_PREFIX));

const isManagedUser = (user: sqladmin.User) => {
  const name = (user.name ?? "").toLowerCase();
  if (name.length === 0) return false;
  if (SYSTEM_USERS.has(name)) return false;
  if (name.startsWith("cloudsql")) return false;
  if (name.startsWith("mysql.")) return false;
  if (user.type !== undefined && AUTO_USER_TYPES.has(user.type)) return false;
  return true;
};

const toSqlIdentifier = (name: string) => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!/^[a-z]/.test(next)) next = `u${next}`;
  next = next.slice(0, MAX_NAME_LENGTH).replace(/_+$/g, "");
  return next.length > 0 ? next : "dbuser";
};

const toUserName = (
  id: string,
  userName: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    if (userName !== undefined) return userName;
    if (existing !== undefined) return existing;
    return toSqlIdentifier(
      yield* createPhysicalName({
        id,
        maxLength: MAX_NAME_LENGTH,
        lowercase: true,
        delimiter: "_",
      }),
    );
  });

const rolesKey = (roles: string[] | undefined) =>
  JSON.stringify([...(roles ?? [])].map((role) => role.toLowerCase()).sort());

const policyKey = (
  policy:
    | UserPasswordPolicy
    | sqladmin.UserPasswordValidationPolicy
    | undefined,
) =>
  JSON.stringify({
    allowedFailedAttempts: policy?.allowedFailedAttempts ?? null,
    passwordExpirationDuration: policy?.passwordExpirationDuration ?? "",
    enableFailedAttemptsCheck: policy?.enableFailedAttemptsCheck === true,
    enablePasswordVerification: policy?.enablePasswordVerification === true,
  });

const sqlServerKey = (details: SqlServerUserDetails | undefined) =>
  JSON.stringify({
    disabled: details?.disabled === true,
    serverRoles: [...(details?.serverRoles ?? [])]
      .map((role) => role.toLowerCase())
      .sort(),
  });

const dualPasswordOf = (value: string | undefined) =>
  (value ?? "DUAL_PASSWORD_TYPE_UNSPECIFIED").toUpperCase();

const toPasswordPolicy = (
  policy:
    | UserPasswordPolicy
    | sqladmin.UserPasswordValidationPolicy
    | undefined,
): sqladmin.UserPasswordValidationPolicy | undefined => {
  if (policy === undefined) return undefined;
  return {
    allowedFailedAttempts: policy.allowedFailedAttempts,
    passwordExpirationDuration: policy.passwordExpirationDuration,
    enableFailedAttemptsCheck: policy.enableFailedAttemptsCheck,
    enablePasswordVerification: policy.enablePasswordVerification,
  };
};

const toAttrs = (live: sqladmin.User, project: string, instance: string) => ({
  userName: live.name ?? "",
  host: live.host,
  instance: live.instance ?? instance,
  project: live.project ?? project,
  type: live.type,
  iamEmail: live.iamEmail,
  databaseRoles: live.databaseRoles,
  passwordPolicy: live.passwordPolicy,
  dualPasswordType: live.dualPasswordType,
  sqlserverUserDetails: live.sqlserverUserDetails,
  iamStatus: live.iamStatus,
  etag: live.etag,
});

const matchesUser = (
  live: sqladmin.User,
  userName: string,
  host: string | undefined,
) =>
  (live.name ?? "") === userName &&
  (host === undefined || normalizeHost(live.host) === normalizeHost(host));

const getByName = (
  project: string,
  instance: string,
  userName: string,
  host: string | undefined,
) =>
  sqladmin
    .getUsers({
      project,
      instance,
      name: userName,
      ...(normalizeHost(host) ? { host: normalizeHost(host) } : {}),
    })
    .pipe(
      Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
      recoverIfInstanceMissing(project, instance, () => undefined),
      Effect.flatMap((live) => {
        if (live !== undefined && matchesUser(live, userName, host)) {
          return Effect.succeed(live);
        }
        return sqladmin.listUsers({ project, instance }).pipe(
          Effect.map((page) =>
            (page.items ?? []).find((item) =>
              matchesUser(item, userName, host),
            ),
          ),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          recoverIfInstanceMissing(project, instance, () => undefined),
        );
      }),
    );

const waitForOperation = (
  project: string,
  operation: sqladmin.Operation,
  options?: { notFoundOk?: boolean },
) =>
  waitForSqlOperation(project, operation, {
    budget: "10 minutes",
    notFoundOk: options?.notFoundOk,
  });

const waitUntilExists = (
  project: string,
  instance: string,
  userName: string,
  host: string | undefined,
) =>
  getByName(project, instance, userName, host).pipe(
    Effect.flatMap((user) =>
      user
        ? Effect.succeed(user)
        : Effect.fail(new UserNotResolved({ instance, userName, host })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.SQL.UserNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (
  project: string,
  instance: string,
  userName: string,
  host: string | undefined,
) =>
  getByName(project, instance, userName, host).pipe(
    Effect.flatMap((user) =>
      user === undefined
        ? Effect.void
        : Effect.fail(new UserStillExists({ instance, userName, host })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.SQL.UserStillExists",
      times: 10,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const passwordValue = (password: string | Redacted.Redacted<string>) =>
  Redacted.isRedacted(password) ? Redacted.value(password) : password;

const toBody = (
  news: UserProps,
  userName: string,
  instance: string,
  project: string,
  current?: sqladmin.User,
  options?: { includePassword?: boolean },
): sqladmin.User => {
  const type = news.type ?? current?.type;
  const includePassword =
    options?.includePassword !== false &&
    news.password !== undefined &&
    !isIamType(type);
  return {
    name: userName,
    instance,
    project,
    host: news.host ?? current?.host,
    type,
    password:
      includePassword && news.password !== undefined
        ? passwordValue(news.password)
        : undefined,
    // Echoing the observed roles back is rejected ("Invalid request to
    // update database roles"); send roles only when they are declared.
    databaseRoles: news.databaseRoles,
    passwordPolicy: toPasswordPolicy(
      news.passwordPolicy ?? current?.passwordPolicy,
    ),
    dualPasswordType: news.dualPasswordType ?? current?.dualPasswordType,
    sqlserverUserDetails:
      news.sqlserverUserDetails ?? current?.sqlserverUserDetails,
    iamEmail: news.iamEmail ?? current?.iamEmail,
  };
};

const recoverIfPresent = <E>(
  project: string,
  instance: string,
  userName: string,
  host: string | undefined,
  error: E,
) =>
  getByName(project, instance, userName, host).pipe(
    Effect.flatMap((existing) => (existing ? Effect.void : Effect.fail(error))),
  );

export const UserProvider = () =>
  Provider.succeed(User, {
    stables: ["userName", "host", "instance", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousInstance = olds?.instance ?? output?.instance;
      const nextInstance = news.instance;
      const previousName = olds?.userName ?? output?.userName;
      const nextName = news.userName ?? previousName;
      const previousHost = olds?.host ?? output?.host;
      const nextHost = news.host ?? previousHost;
      const previousType = olds?.type ?? output?.type;
      const nextType = news.type ?? previousType;
      const instanceChanged =
        previousInstance !== undefined &&
        instanceIdOf(previousInstance) !== instanceIdOf(nextInstance);
      const nameChanged =
        previousName !== undefined &&
        nextName !== undefined &&
        previousName !== nextName;
      const hostChanged =
        previousHost !== undefined &&
        nextHost !== undefined &&
        normalizeHost(previousHost) !== normalizeHost(nextHost);
      const typeChanged =
        previousType !== undefined &&
        nextType !== undefined &&
        typeOf(previousType) !== typeOf(nextType);
      if (!instanceChanged && !nameChanged && !hostChanged && !typeChanged) {
        return undefined;
      }
      const identityChanged = instanceChanged || nameChanged || hostChanged;
      return {
        action: "replace" as const,
        deleteFirst: typeChanged && !identityChanged,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const instance = instanceIdOf(olds?.instance ?? output?.instance ?? "");
      if (instance.length === 0) return undefined;
      const userName = yield* toUserName(id, olds?.userName, output?.userName);
      const host = olds?.host ?? output?.host;
      const existing = yield* getByName(env.project, instance, userName, host);
      if (existing === undefined) return undefined;
      return toAttrs(existing, env.project, instance);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const instances = yield* sqladmin.listInstances
          .items({
            project: env.project,
            maxResults: 1000,
            filter: "instanceType:CLOUD_SQL_INSTANCE",
          })
          .pipe(
            Stream.filter((instance) =>
              hasAlchemyInstanceLabels(instance.settings?.userLabels),
            ),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () =>
              Effect.succeed([] as sqladmin.DatabaseInstance[]),
            ),
          );
        const pages = yield* Effect.forEach(
          instances,
          (instance) => {
            const instanceName = instance.name;
            if (instanceName === undefined || instanceName.length === 0) {
              return Effect.succeed([] as User["Attributes"][]);
            }
            return sqladmin
              .listUsers({
                project: env.project,
                instance: instanceName,
              })
              .pipe(
                Effect.map((page) =>
                  (page.items ?? [])
                    .filter(isManagedUser)
                    .map((user) => toAttrs(user, env.project, instanceName)),
                ),
                // The instance may be deleted mid-listing.
                Effect.catchTag("NotFound", () =>
                  Effect.succeed([] as User["Attributes"][]),
                ),
                recoverIfInstanceMissing(
                  env.project,
                  instanceName,
                  () => [] as User["Attributes"][],
                ),
              );
          },
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output, olds }) {
      const env = yield* GcpEnvironment.current;
      const instance = instanceIdOf(news.instance);
      const userName = yield* toUserName(id, news.userName, output?.userName);
      const host = news.host ?? output?.host;

      let current = yield* getByName(env.project, instance, userName, host);
      let inserted = false;

      if (current === undefined) {
        const created = yield* sqladmin
          .insertUsers({
            project: env.project,
            instance,
            body: toBody(news, userName, instance, env.project),
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitForOperation(env.project, operation).pipe(Effect.as(true)),
            ),
            Effect.catchTag("Conflict", (error) =>
              recoverIfPresent(
                env.project,
                instance,
                userName,
                host,
                error,
              ).pipe(Effect.as(false)),
            ),
            Effect.catchTag("BadRequest", (error) =>
              recoverIfPresent(
                env.project,
                instance,
                userName,
                host,
                error,
              ).pipe(Effect.as(false)),
            ),
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              times: 8,
              schedule: Schedule.spaced("5 seconds"),
            }),
          );
        current = yield* waitUntilExists(env.project, instance, userName, host);
        inserted = created;
      }

      const passwordChanged =
        news.password !== undefined &&
        !inserted &&
        !isIamType(news.type ?? current.type) &&
        (olds?.password === undefined ||
          passwordValue(olds.password) !== passwordValue(news.password));
      const rolesChanged =
        news.databaseRoles !== undefined &&
        rolesKey(current.databaseRoles) !== rolesKey(news.databaseRoles);
      const policyChanged =
        news.passwordPolicy !== undefined &&
        policyKey(current.passwordPolicy) !== policyKey(news.passwordPolicy);
      const dualPasswordChanged =
        news.dualPasswordType !== undefined &&
        dualPasswordOf(current.dualPasswordType) !==
          dualPasswordOf(news.dualPasswordType);
      const sqlServerChanged =
        news.sqlserverUserDetails !== undefined &&
        sqlServerKey(current.sqlserverUserDetails) !==
          sqlServerKey(news.sqlserverUserDetails);
      const iamEmailChanged =
        news.iamEmail !== undefined &&
        (current.iamEmail ?? "") !== news.iamEmail;

      if (
        passwordChanged ||
        rolesChanged ||
        policyChanged ||
        dualPasswordChanged ||
        sqlServerChanged ||
        iamEmailChanged
      ) {
        const patched = yield* sqladmin.updateUsers({
          project: env.project,
          instance,
          name: userName,
          ...(normalizeHost(host) ? { host: normalizeHost(host) } : {}),
          revokeExistingRoles: rolesChanged ? true : undefined,
          body: toBody(news, userName, instance, env.project, current, {
            includePassword: passwordChanged,
          }),
        });
        yield* waitForOperation(env.project, patched);
        current = yield* waitUntilExists(env.project, instance, userName, host);
      }

      return toAttrs(current, env.project, instance);
    }),

    delete: Effect.fn(function* ({ olds, output }) {
      if (olds.deletionPolicy === "ABANDON") return;
      const project = output.project;
      const instance = instanceIdOf(output.instance);
      const userName = output.userName;
      const host = output.host;
      yield* sqladmin
        .deleteUsers({
          project,
          instance,
          name: userName,
          ...(normalizeHost(host) ? { host: normalizeHost(host) } : {}),
        })
        .pipe(
          Effect.flatMap((operation) =>
            waitForOperation(project, operation, { notFoundOk: true }),
          ),
          Effect.catchTag("NotFound", () => Effect.void),
          recoverIfInstanceMissing(project, instance, () => undefined),
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("5 seconds"),
          }),
        );
      yield* waitUntilGone(project, instance, userName, host);
    }),
  });
