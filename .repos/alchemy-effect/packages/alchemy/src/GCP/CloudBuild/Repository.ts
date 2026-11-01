import * as cloudbuild from "@distilled.cloud/gcp/cloudbuild_v2";
import * as Data from "effect/Data";
import type { GcpOpContext } from "@distilled.cloud/gcp/Protocol";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import { waitForOperation as waitForLongRunningOperation } from "../Operation.ts";

const MAX_NAME_LENGTH = 63;

export type RepositoryProps = {
  /**
   * Parent Cloud Build connection. Full name
   * `projects/{project}/locations/{location}/connections/{connection}` or
   * the connection id (combined with `location`). Immutable — changing it
   * replaces the repository.
   */
  connection: string;
  /**
   * Cloud Build location (`us-central1`, `us-east1`, …). Used when
   * `connection` is a bare id. Immutable — changing it replaces the
   * repository. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Repository id (the `{repository}` segment of
   * `projects/{project}/locations/{location}/connections/{connection}/repositories/{repository}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Unique within the connection. Immutable — changing it
   * replaces the repository.
   */
  repositoryId?: string;
  /**
   * Git clone HTTPS URI (e.g. `https://github.com/{owner}/{repo}.git`).
   * Immutable — changing it replaces the repository.
   */
  remoteUri: string;
  /**
   * User annotations. Cloud Build repositories have no labels, so Alchemy
   * ownership (`alchemy-stack` / `alchemy-stage` / `alchemy-id`) is stored
   * here for `list` / nuke. The API has no update method — changing
   * annotations replaces the repository.
   */
  annotations?: Record<string, string>;
};

export type Repository = Resource<
  "GCP.CloudBuild.Repository",
  RepositoryProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/connections/{connection}/repositories/{repository}`. */
    name: string;
    /** Repository id (last path segment). */
    repositoryId: string;
    /** Parent connection resource name. */
    connection: string;
    /** Connection id (last path segment of the parent). */
    connectionId: string;
    /** Project id. */
    project: string;
    /** Location id (`us-central1`, …). */
    location: string;
    /** Git clone HTTPS URI. */
    remoteUri: string;
    /** User annotations (Alchemy ownership keys stripped). */
    annotations: Record<string, string>;
    /** External id of the webhook created for the repository. */
    webhookId: string | undefined;
    /** Server checksum of the resource. */
    etag: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Build v2 repository — links a remote Git repository to a
 * {@link Connection}.
 *
 * Changing `repositoryId`, `connection`, `location`, `remoteUri`, or
 * `annotations` replaces the repository. There is no update API; every
 * user-facing field is immutable.
 *
 * Cloud Build repositories have no labels. Alchemy stores ownership in
 * annotations (`alchemy-stack` / `alchemy-stage` / `alchemy-id`) so
 * `list` / `pnpm nuke:gcp` can find them.
 *
 * ### Creating a Repository
 * **Example:** Generated name
 * ```typescript
 * const github = yield* GCP.CloudBuild.Connection("Github", {
 *   githubConfig: {},
 * });
 * const source = yield* GCP.CloudBuild.Repository("Source", {
 *   connection: github.name,
 *   remoteUri: "https://github.com/{owner}/{repo}.git",
 * });
 * ```
 *
 * **Example:** Named repository with annotations
 * ```typescript
 * const source = yield* GCP.CloudBuild.Repository("Source", {
 *   connection: github.name,
 *   repositoryId: "app-source",
 *   remoteUri: "https://github.com/{owner}/{repo}.git",
 *   annotations: { env: "prod" },
 * });
 * ```
 *
 * ### Fetching Git Refs
 * **Example:** List branches
 * ```typescript
 * const fetchGitRefs = yield* GCP.CloudBuild.FetchGitRefs(source);
 * const { refNames } = yield* fetchGitRefs({ refType: "BRANCH" });
 * ```
 *
 * ### Cloning with a Token
 * **Example:** Fetch a read token
 * ```typescript
 * const accessReadToken = yield* GCP.CloudBuild.AccessReadToken(source);
 * const { token } = yield* accessReadToken();
 * ```
 *
 * @resource
 * @category CloudBuild
 */
export const Repository = Resource<Repository>("GCP.CloudBuild.Repository");

export class RepositoryNotResolved extends Data.TaggedError(
  "GCP.CloudBuild.RepositoryNotResolved",
)<{
  name: string;
}> {}

export class RepositoryStillExists extends Data.TaggedError(
  "GCP.CloudBuild.RepositoryStillExists",
)<{
  name: string;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const normalizeLocation = (location: string | undefined, fallback: string) =>
  lastSegment(location ?? fallback).toLowerCase();

const parseName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const repositoriesAt = parts.lastIndexOf("repositories");
  const connectionsAt = parts.lastIndexOf("connections");
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  const connection =
    connectionsAt >= 0 ? parts.slice(0, connectionsAt + 2).join("/") : "";
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1] ? parts[locationsAt + 1]! : "",
    connection,
    connectionId:
      connectionsAt >= 0 && parts[connectionsAt + 1]
        ? parts[connectionsAt + 1]!
        : "",
    repositoryId:
      repositoriesAt >= 0 && parts[repositoriesAt + 1]
        ? parts[repositoriesAt + 1]!
        : lastSegment(name),
  };
};

const resolveParent = (
  project: string,
  connection: string,
  location: string | undefined,
  defaultLocation: string,
) => {
  if (connection.includes("/")) {
    const parsed = parseName(
      connection.includes("/repositories/")
        ? connection
        : `${connection.replace(/\/+$/, "")}/repositories/_`,
    );
    return {
      parent: parsed.connection,
      location: parsed.location,
      project: parsed.project || project,
      connectionId: parsed.connectionId,
    };
  }
  const loc = normalizeLocation(location, defaultLocation);
  return {
    parent: `projects/${project}/locations/${loc}/connections/${connection}`,
    location: loc,
    project,
    connectionId: connection,
  };
};

const parentKey = (
  connection: string | undefined,
  location: string | undefined,
  defaultLocation: string,
) => {
  if (connection === undefined || connection === "") return undefined;
  const parsed = resolveParent("", connection, location, defaultLocation);
  return `${parsed.location}/${parsed.connectionId}`;
};

const resourceName = (parent: string, repositoryId: string) =>
  `${parent}/repositories/${repositoryId}`;

const userAnnotations = (
  annotations: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(annotations));

const toId = (
  id: string,
  repositoryId: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    return (
      repositoryId ??
      existing ??
      (yield* createPhysicalName({
        id,
        maxLength: MAX_NAME_LENGTH,
        lowercase: true,
      }))
    );
  });

const annotationsEqual = (
  left: Record<string, string>,
  right: Record<string, string>,
) => {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => key === rightKeys[index] && left[key] === right[key],
    )
  );
};

const toAttrs = (repository: cloudbuild.Repository, project: string) => {
  const name = repository.name ?? "";
  const parsed = parseName(name);
  return {
    name,
    repositoryId: parsed.repositoryId,
    connection: parsed.connection,
    connectionId: parsed.connectionId,
    project: parsed.project || project,
    location: parsed.location,
    remoteUri: repository.remoteUri ?? "",
    annotations: userAnnotations(repository.annotations),
    webhookId: repository.webhookId,
    etag: repository.etag,
    createTime: repository.createTime,
    updateTime: repository.updateTime,
  };
};

const getByName = (name: string) =>
  cloudbuild
    .getProjectsLocationsConnectionsRepositories({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

/**
 * Wait on a Cloud Build repositories long-running operation (seconds to a minute).
 * `ALREADY_EXISTS` (a create race) counts as success; so does `NOT_FOUND`
 * when `notFoundOk` (deletes). Returns the final operation.
 */
const waitForOperation = (
  operation: cloudbuild.Operation,
  options?: { notFoundOk?: boolean },
) =>
  Effect.suspend(() => {
    let latest = operation;
    return waitForLongRunningOperation(
      operation,
      (name) => {
        const get = cloudbuild.getProjectsLocationsOperations({ name }).pipe(
          Effect.tap((current) =>
            Effect.sync(() => {
              latest = current;
            }),
          ),
        );
        const observe: Effect.Effect<
          cloudbuild.Operation,
          cloudbuild.GetProjectsLocationsOperationsError,
          GcpOpContext
        > =
          options?.notFoundOk === true
            ? get.pipe(
                Effect.catchTag("NotFound", () =>
                  Effect.succeed<cloudbuild.Operation>({ name, done: true }),
                ),
              )
            : get.pipe(
                // A just-returned operation can briefly 404 on read.
                Effect.retry({
                  while: (error) => error._tag === "NotFound",
                  times: 5,
                  schedule: Schedule.exponential("250 millis"),
                }),
              );
        return observe;
      },
      { budget: "5 minutes" },
    ).pipe(
      Effect.map(() => latest),
      // google.rpc.Code ALREADY_EXISTS = 6, NOT_FOUND = 5.
      Effect.catchTag("GCP.OperationFailed", (error) =>
        error.code === 6 || (options?.notFoundOk === true && error.code === 5)
          ? Effect.succeed(latest)
          : Effect.fail(error),
      ),
    );
  });

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((repository) =>
      repository
        ? Effect.succeed(repository)
        : Effect.fail(new RepositoryNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.CloudBuild.RepositoryNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((repository) =>
      repository === undefined
        ? Effect.void
        : Effect.fail(new RepositoryStillExists({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.CloudBuild.RepositoryStillExists",
      times: 10,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const listRepositoriesAt = (parent: string, project: string) =>
  cloudbuild.listProjectsLocationsConnectionsRepositories
    .pages({
      parent,
      pageSize: 1000,
      returnPartialSuccess: true,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.repositories ?? [])),
      Stream.filter((repository) =>
        Object.keys(repository.annotations ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ),
      Stream.map((repository) => toAttrs(repository, project)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const listOwnedRepositories = (project: string) =>
  Effect.gen(function* () {
    const connections = yield* cloudbuild.listProjectsLocationsConnections
      .pages({
        parent: `projects/${project}/locations/-`,
        pageSize: 1000,
        returnPartialSuccess: true,
      })
      .pipe(
        Stream.flatMap((page) => Stream.fromIterable(page.connections ?? [])),
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
        Effect.catchTag("NotFound", () =>
          Effect.succeed([] as cloudbuild.Connection[]),
        ),
      );

    const pages = yield* Effect.forEach(
      connections,
      (connection) =>
        connection.name
          ? listRepositoriesAt(connection.name, project)
          : Effect.succeed([] as ReturnType<typeof toAttrs>[]),
      { concurrency: 4 },
    );
    return pages.flat();
  });

export const RepositoryProvider = () =>
  Provider.succeed(Repository, {
    stables: [
      "name",
      "repositoryId",
      "connection",
      "connectionId",
      "project",
      "location",
      "remoteUri",
      "webhookId",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      const env = yield* GcpEnvironment.current;
      if (!isResolved(news)) return undefined;
      if (output === undefined && olds === undefined) return undefined;

      const previousId = olds?.repositoryId ?? output?.repositoryId;
      const nextId = news.repositoryId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      const previousParent = parentKey(
        olds?.connection ?? output?.connection,
        olds?.location ?? output?.location,
        env.region,
      );
      const nextParent =
        news.connection !== undefined
          ? parentKey(
              news.connection,
              news.location ?? olds?.location ?? output?.location,
              env.region,
            )
          : previousParent;
      const previousUri = olds?.remoteUri ?? output?.remoteUri ?? "";
      const nextUri = news.remoteUri ?? previousUri;
      const previousAnnotations = toLabels(
        olds?.annotations ?? output?.annotations,
      );
      const nextAnnotations = toLabels(news.annotations);

      const replace =
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation ||
        (previousParent !== undefined &&
          nextParent !== undefined &&
          previousParent !== nextParent) ||
        (previousUri !== "" && nextUri !== previousUri) ||
        !annotationsEqual(previousAnnotations, nextAnnotations);

      if (!replace) return undefined;
      return {
        action: "replace" as const,
        deleteFirst:
          previousParent === nextParent &&
          previousLocation === nextLocation &&
          previousId !== undefined &&
          nextId === previousId,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      let name = output?.name;
      if (name === undefined || name.length === 0) {
        const connectionRef = olds?.connection ?? output?.connection;
        if (typeof connectionRef !== "string" || connectionRef.length === 0) {
          return undefined;
        }
        const repositoryId = yield* toId(
          id,
          olds?.repositoryId,
          output?.repositoryId,
        );
        const parent = resolveParent(
          env.project,
          connectionRef,
          olds?.location ?? output?.location,
          env.region,
        );
        name = resourceName(parent.parent, repositoryId);
      }
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.annotations)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* listOwnedRepositories(env.project);
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const repositoryId = yield* toId(
        id,
        news.repositoryId,
        output?.repositoryId,
      );
      const parent = resolveParent(
        env.project,
        news.connection ?? output?.connection ?? "",
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(parent.parent, repositoryId);
      const desiredAnnotations = {
        ...toLabels(news.annotations),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* cloudbuild
          .createProjectsLocationsConnectionsRepositories({
            parent: parent.parent,
            repositoryId,
            body: {
              remoteUri: news.remoteUri,
              annotations: desiredAnnotations,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(name);
      }

      if (current === undefined) {
        return yield* new RepositoryNotResolved({ name });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const name = output.name;
      if (name === undefined || name.length === 0) {
        return;
      }
      const operation = yield* cloudbuild
        .deleteProjectsLocationsConnectionsRepositories({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(name);
    }),
  });
