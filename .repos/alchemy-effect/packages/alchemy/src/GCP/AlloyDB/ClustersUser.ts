import * as alloydb from "@distilled.cloud/gcp/alloydb_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { ALCHEMY_LABEL_PREFIX } from "../Labels.ts";
import type { Providers } from "../Providers.ts";

const DEFAULT_USER_TYPE = "ALLOYDB_BUILT_IN";
const MAX_NAME_LENGTH = 63;

const SYSTEM_USERS = new Set(["postgres"]);

export type ClustersUserProps = {
  /**
   * Parent cluster id or full resource name
   * (`projects/{project}/locations/{location}/clusters/{cluster}`).
   * Immutable — changing it replaces the user.
   */
  cluster: string;
  /**
   * Region of the parent cluster (`us-central1`, …). Ignored when
   * `cluster` is a full resource name. Immutable — changing it replaces
   * the user. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Database user id (the `{user}` segment of
   * `.../clusters/{cluster}/users/{user}`). If omitted, a unique
   * PostgreSQL identifier is generated. For IAM users this is the
   * principal email. Immutable — changing it replaces the user.
   */
  userId?: string;
  /**
   * User type. `ALLOYDB_BUILT_IN` requires `password`.
   * `ALLOYDB_IAM_USER` uses IAM authentication. Immutable — changing
   * it replaces the user.
   * @default "ALLOYDB_BUILT_IN"
   */
  userType?: alloydb.UserUserTypeEnum | (string & {});
  /**
   * Password for `ALLOYDB_BUILT_IN` users. Write-only — never returned
   * by the API. Updating this value rotates the password.
   */
  password?: string;
  /**
   * PostgreSQL roles to grant (`alloydbsuperuser`, `pg_monitor`, …).
   */
  databaseRoles?: string[];
  /**
   * Keep roles the user already has that are not listed in
   * `databaseRoles`. Create-only.
   */
  keepExtraRoles?: boolean;
};

export type ClustersUser = Resource<
  "GCP.AlloyDB.ClustersUser",
  ClustersUserProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/clusters/{cluster}/users/{user}`. */
    name: string;
    /** Database user id (last path segment). */
    userId: string;
    /** Parent cluster id. */
    clusterId: string;
    /** Parent cluster resource name. */
    clusterName: string;
    /** Project id. */
    project: string;
    /** Region id (`us-central1`, …). */
    location: string;
    /** User type (`ALLOYDB_BUILT_IN`, `ALLOYDB_IAM_USER`). */
    userType: string;
    /** Granted database roles. */
    databaseRoles: string[];
  },
  never,
  Providers
>;

/**
 * A database user on an AlloyDB cluster.
 *
 * AlloyDB users have no labels field. `list` enumerates non-`postgres`
 * users on alchemy-labeled clusters so `pnpm nuke:gcp` can find leaked
 * rows without dropping the built-in superuser.
 *
 * Changing `cluster`, `location`, `userId`, or `userType` replaces the
 * user. `password` and `databaseRoles` update in place. Creating a
 * built-in user requires a READY primary instance.
 *
 * ### Creating a User
 * **Example:** Built-in user on a cluster
 * ```typescript
 * const cluster = yield* GCP.AlloyDB.Cluster("AppDb", {
 *   pscConfig: { pscEnabled: true },
 *   initialUser: { user: "postgres", password: "change-me" },
 * });
 * const primary = yield* GCP.AlloyDB.Instance("Primary", {
 *   cluster: cluster.name,
 * });
 * const appUser = yield* GCP.AlloyDB.ClustersUser("AppUser", {
 *   cluster: primary.clusterName,
 *   password: "change-me-too",
 *   databaseRoles: ["alloydbsuperuser"],
 * });
 * ```
 *
 * **Example:** Explicit id and IAM user
 * ```typescript
 * const iamUser = yield* GCP.AlloyDB.ClustersUser("Analyst", {
 *   cluster: cluster.name,
 *   userId: "analyst@example.com",
 *   userType: "ALLOYDB_IAM_USER",
 *   databaseRoles: ["pg_read_all_data"],
 * });
 * ```
 *
 * @resource
 * @category AlloyDB
 */
export const ClustersUser = Resource<ClustersUser>("GCP.AlloyDB.ClustersUser");

export class ClustersUserNotResolved extends Data.TaggedError(
  "GCP.AlloyDB.ClustersUserNotResolved",
)<{
  name: string;
}> {}

export class ClustersUserClusterMissing extends Data.TaggedError(
  "GCP.AlloyDB.ClustersUserClusterMissing",
)<{
  message: string;
}> {}

export class ClustersUserStillExists extends Data.TaggedError(
  "GCP.AlloyDB.ClustersUserStillExists",
)<{
  name: string;
}> {}

const lastSegment = (value: string | undefined) => {
  if (value === undefined || value.length === 0) return "";
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const normalizeLocation = (location: string) =>
  lastSegment(location).toLowerCase();

const normalizeUserType = (type: string | undefined) => {
  const value = (type ?? DEFAULT_USER_TYPE).toUpperCase();
  return value === "USER_TYPE_UNSPECIFIED" ? DEFAULT_USER_TYPE : value;
};

const isIamType = (type: string | undefined) =>
  normalizeUserType(type) === "ALLOYDB_IAM_USER";

const pgIdentifier = (name: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!/^[a-z]/.test(next)) next = `u${next}`;
  next = next.slice(0, MAX_NAME_LENGTH).replace(/_+$/g, "");
  return next.length > 0 ? next : "dbuser";
};

const resourceName = (
  project: string,
  location: string,
  clusterId: string,
  userId: string,
) =>
  `projects/${project}/locations/${location}/clusters/${clusterId}/users/${userId}`;

const clusterNameOf = (project: string, location: string, clusterId: string) =>
  `projects/${project}/locations/${location}/clusters/${clusterId}`;

const parseName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const usersAt = parts.lastIndexOf("users");
  const clustersAt = parts.lastIndexOf("clusters");
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1] ? parts[locationsAt + 1]! : "",
    clusterId:
      clustersAt >= 0 && parts[clustersAt + 1] ? parts[clustersAt + 1]! : "",
    userId:
      usersAt >= 0 && parts[usersAt + 1]
        ? parts[usersAt + 1]!
        : lastSegment(name),
  };
};

const parseClusterRef = (
  cluster: string,
  fallbackProject: string,
  fallbackLocation: string,
) => {
  const trimmed = cluster.trim();
  if (trimmed.length === 0) {
    return {
      project: fallbackProject,
      location: normalizeLocation(fallbackLocation),
      clusterId: "",
    };
  }
  if (trimmed.includes("/clusters/") || trimmed.includes("projects/")) {
    const parsed = parseName(
      trimmed.includes("/users/") ? trimmed : `${trimmed}/users/_`,
    );
    return {
      project: parsed.project || fallbackProject,
      location: normalizeLocation(parsed.location || fallbackLocation),
      clusterId: parsed.clusterId === "_" ? "" : parsed.clusterId,
    };
  }
  return {
    project: fallbackProject,
    location: normalizeLocation(fallbackLocation),
    clusterId: lastSegment(trimmed),
  };
};

const toId = (
  id: string,
  userId: string | undefined,
  existing: string | undefined,
  userType: string,
) =>
  Effect.gen(function* () {
    if (userId !== undefined) return userId;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: MAX_NAME_LENGTH,
      lowercase: true,
      delimiter: isIamType(userType) ? "-" : "_",
    });
    return isIamType(userType) ? generated : pgIdentifier(generated);
  });

const rolesKey = (roles: string[] | undefined) =>
  JSON.stringify([...(roles ?? [])].map((role) => role.toLowerCase()).sort());

const toRoles = (roles: string[] | undefined): string[] =>
  (roles ?? []).filter((role) => role.length > 0);

const hasAlchemyClusterLabels = (
  labels: Record<string, string | undefined> | null | undefined,
) =>
  Object.keys(labels ?? {}).some((key) => key.startsWith(ALCHEMY_LABEL_PREFIX));

const isManagedUser = (user: alloydb.User) => {
  const name = lastSegment(user.name).toLowerCase();
  if (name.length === 0) return false;
  if (SYSTEM_USERS.has(name)) return false;
  return true;
};

const isPlaceholder = (user: alloydb.User) => {
  const name = user.name ?? "";
  return name.endsWith("/users/-") || name.endsWith("/users/");
};

const toAttrs = (user: alloydb.User, project: string) => {
  const name = user.name ?? "";
  const parsed = parseName(name);
  const resolvedProject = parsed.project || project;
  return {
    name,
    userId: parsed.userId,
    clusterId: parsed.clusterId,
    clusterName: clusterNameOf(
      resolvedProject,
      parsed.location,
      parsed.clusterId,
    ),
    project: resolvedProject,
    location: parsed.location,
    userType: normalizeUserType(user.userType),
    databaseRoles: toRoles(user.databaseRoles),
  };
};

const getByName = (name: string) =>
  alloydb
    .getProjectsLocationsClustersUsers({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((user) =>
      user
        ? Effect.succeed(user)
        : Effect.fail(new ClustersUserNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.AlloyDB.ClustersUserNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((user) =>
      user === undefined
        ? Effect.void
        : Effect.fail(new ClustersUserStillExists({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.AlloyDB.ClustersUserStillExists",
      times: 10,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const toBody = (
  news: ClustersUserProps,
  userType: string,
  options?: { includePassword?: boolean; includeKeepExtraRoles?: boolean },
): alloydb.User => {
  const body: alloydb.User = {
    userType,
  };
  if (news.databaseRoles !== undefined) {
    body.databaseRoles = news.databaseRoles;
  }
  if (
    options?.includePassword !== false &&
    news.password !== undefined &&
    !isIamType(userType)
  ) {
    body.password = news.password;
  }
  if (
    options?.includeKeepExtraRoles === true &&
    news.keepExtraRoles !== undefined
  ) {
    body.keepExtraRoles = news.keepExtraRoles;
  }
  return body;
};

export const ClustersUserProvider = () =>
  Provider.succeed(ClustersUser, {
    stables: [
      "name",
      "userId",
      "clusterId",
      "clusterName",
      "project",
      "location",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;

      const previousId = olds?.userId ?? output?.userId;
      const nextId = news.userId ?? previousId;
      const previousCluster = lastSegment(olds?.cluster ?? output?.clusterId);
      const nextCluster = lastSegment(news.cluster ?? previousCluster);
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location ?? env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? output?.location ?? env.region,
      );
      const previousType = normalizeUserType(
        olds?.userType ?? output?.userType,
      );
      const nextType = normalizeUserType(news.userType ?? output?.userType);

      const replace =
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        (previousCluster.length > 0 &&
          nextCluster.length > 0 &&
          previousCluster !== nextCluster) ||
        previousLocation !== nextLocation ||
        previousType !== nextType;

      if (!replace) return undefined;
      return {
        action: "replace" as const,
        deleteFirst:
          previousLocation === nextLocation &&
          previousCluster === nextCluster &&
          previousId !== undefined &&
          nextId === previousId,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      if (output?.name) {
        const existing = yield* getByName(output.name);
        if (existing === undefined) return undefined;
        return toAttrs(existing, env.project);
      }
      const userType = normalizeUserType(olds?.userType ?? output?.userType);
      const userId = yield* toId(id, olds?.userId, output?.userId, userType);
      const ref = parseClusterRef(
        olds?.cluster ?? output?.clusterName ?? output?.clusterId ?? "",
        env.project,
        olds?.location ?? output?.location ?? env.region,
      );
      if (ref.clusterId.length === 0) return undefined;
      const name = resourceName(
        ref.project,
        ref.location,
        ref.clusterId,
        userId,
      );
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      return toAttrs(existing, env.project);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const clusters = yield* alloydb.listProjectsLocationsClusters
          .pages({
            parent: `projects/${env.project}/locations/-`,
            pageSize: 1000,
          })
          .pipe(
            Stream.flatMap((page) => Stream.fromIterable(page.clusters ?? [])),
            Stream.filter(
              (cluster) =>
                (cluster.name ?? "").length > 0 &&
                hasAlchemyClusterLabels(cluster.labels),
            ),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () => Effect.succeed([])),
          );

        const pages = yield* Effect.forEach(
          clusters,
          (cluster) => {
            const parent = cluster.name;
            if (parent === undefined || parent.length === 0) {
              return Effect.succeed([] as ClustersUser["Attributes"][]);
            }
            return alloydb.listProjectsLocationsClustersUsers
              .pages({
                parent,
                pageSize: 1000,
              })
              .pipe(
                Stream.flatMap((page) => Stream.fromIterable(page.users ?? [])),
                Stream.filter(
                  (user) => !isPlaceholder(user) && isManagedUser(user),
                ),
                Stream.map((user) => toAttrs(user, env.project)),
                Stream.runCollect,
                Effect.map((chunk) => Array.from(chunk)),
                Effect.catchTag("NotFound", () => Effect.succeed([])),
              );
          },
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output, olds }) {
      const env = yield* GcpEnvironment.current;
      const userType = normalizeUserType(news.userType);
      const userId = yield* toId(id, news.userId, output?.userId, userType);
      const ref = parseClusterRef(
        news.cluster,
        env.project,
        news.location ?? output?.location ?? env.region,
      );
      if (ref.clusterId.length === 0) {
        return yield* new ClustersUserClusterMissing({
          message:
            "GCP.AlloyDB.ClustersUser requires `cluster` (cluster id or full resource name)",
        });
      }
      const name = resourceName(
        ref.project,
        ref.location,
        ref.clusterId,
        userId,
      );
      const parent = clusterNameOf(ref.project, ref.location, ref.clusterId);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* alloydb
          .createProjectsLocationsClustersUsers({
            parent,
            userId,
            body: toBody(news, userType, {
              includePassword: true,
              includeKeepExtraRoles: true,
            }),
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        current =
          created !== undefined ? created : yield* waitUntilExists(name);
      }

      if (current === undefined) {
        return yield* new ClustersUserNotResolved({ name });
      }

      const passwordChanged =
        news.password !== undefined &&
        !isIamType(userType) &&
        (olds !== undefined
          ? news.password !== olds.password
          : output !== undefined);
      const rolesChanged =
        news.databaseRoles !== undefined &&
        rolesKey(news.databaseRoles) !== rolesKey(current.databaseRoles);

      if (passwordChanged || rolesChanged) {
        const updateMask = [
          passwordChanged ? "password" : undefined,
          rolesChanged ? "databaseRoles" : undefined,
        ].filter((field): field is string => field !== undefined);

        current = yield* alloydb
          .patchProjectsLocationsClustersUsers({
            name,
            updateMask: updateMask.join(","),
            body: toBody(news, userType, {
              includePassword: passwordChanged,
            }),
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              times: 8,
              schedule: Schedule.spaced("2 seconds"),
            }),
          );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* alloydb
        .deleteProjectsLocationsClustersUsers({ name: output.name })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.void),
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
        );
      yield* waitUntilGone(output.name);
    }),
  });
