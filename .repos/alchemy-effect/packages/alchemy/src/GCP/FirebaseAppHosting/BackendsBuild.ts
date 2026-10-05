import * as firebaseapphosting from "@distilled.cloud/gcp/firebaseapphosting_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels, toLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  expandParent,
  fingerprint,
  listAtNested,
  listLabeledPages,
  MAX_BACKEND_ID_LENGTH,
  normalizeLocation,
  parseName,
  replaceOnIdentity,
  ResourceNotResolved,
  stringMap,
  toPhysicalId,
  userLabels,
  waitForDeleteOperation,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type UserMetadata = {
  /** Git user name. */
  displayName?: string;
  /** Git user email. */
  email?: string;
  /** URI of a profile image. */
  imageUri?: string;
};

export type CodebaseSource = {
  /**
   * Branch to build from (latest commit). Mutually exclusive with
   * `commit`.
   */
  branch?: string;
  /**
   * Commit SHA to build from. Mutually exclusive with `branch`.
   */
  commit?: string;
  /**
   * Developer Connect gitRepositoryLink resource name used for this
   * build.
   */
  repository?: string;
};

export type ArchiveSource = {
  /** Signed URL of an archive in a storage bucket. */
  externalSignedUri?: string;
  /**
   * Cloud Storage URI of a `.zip` or `.tar.gz` archive
   * (`gs://bucket/object`).
   */
  userStorageUri?: string;
  /**
   * Directory relative to the archive root used as the web app root.
   */
  rootDirectory?: string;
  /** Optional message describing this uploaded source. */
  description?: string;
};

export type ContainerSource = {
  /**
   * Artifact Registry container image URI used as the build source.
   */
  image?: string;
};

export type BuildSource = {
  /** Git codebase at a branch or commit. */
  codebase?: CodebaseSource;
  /** Storage archive. */
  archive?: ArchiveSource;
  /** Artifact Registry container image. */
  container?: ContainerSource;
};

export type RunConfig = {
  /** Maximum Cloud Run instances per revision. */
  maxInstances?: number;
  /** Memory per instance in MiB (`128`–`32768`). */
  memoryMib?: number;
  /** Maximum concurrent requests per instance (`1`–`1000`). */
  concurrency?: number;
  /** Minimum Cloud Run instances. */
  minInstances?: number;
  /** CPUs per instance (`0.08`–`8`). */
  cpu?: number;
};

export type EnvironmentVariable = {
  /** Variable name. Must not start with `X_FIREBASE_`. */
  variable?: string;
  /** Plaintext value. */
  value?: string;
  /**
   * Secret Manager version resource name. The Cloud Build and Cloud Run
   * service accounts need `secretmanager.versions.access`.
   */
  secret?: string;
  /**
   * Where the variable is available (`BUILD`, `RUNTIME`). Unspecified
   * means both.
   */
  availability?: Array<
    firebaseapphosting.EnvironmentVariableAvailabilityItemEnum | (string & {})
  >;
};

export type BuildConfig = {
  /** Cloud Run service configuration for this build. */
  runConfig?: RunConfig;
  /**
   * Environment variables supplied at create time. Immutable. Only
   * valid for container or archive sources.
   */
  env?: EnvironmentVariable[];
};

export type BackendsBuildProps = {
  /**
   * Parent backend. Full name
   * `projects/{project}/locations/{location}/backends/{backend}` or the
   * backend id (combined with `location`). Immutable — changing it
   * replaces the build.
   */
  backend: string;
  /**
   * Region used when `backend` is a bare id.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Build id (the `{buildId}` segment). If omitted, a unique RFC1035
   * name is generated from the stack, stage, and logical id. Immutable
   * — changing it replaces the build.
   */
  buildId?: string;
  /**
   * Source for the build. Immutable — changing it replaces the build.
   */
  source: BuildSource;
  /**
   * Additional Cloud Run / environment configuration. Immutable —
   * changing it replaces the build.
   */
  config?: BuildConfig;
  /**
   * Human-readable name. 63 character limit.
   */
  displayName?: string;
  /**
   * User annotations (preserved by external tools).
   */
  annotations?: Record<string, string>;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type BackendsBuild = Resource<
  "GCP.FirebaseAppHosting.BackendsBuild",
  BackendsBuildProps,
  {
    /** Full resource name. */
    name: string;
    /** Build id (last path segment). */
    buildId: string;
    /** Parent backend name. */
    backend: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Build source. */
    source: BuildSource | undefined;
    /** Additional configuration. */
    config: BuildConfig | undefined;
    /** Human-readable name. */
    displayName: string | undefined;
    /** Environment name of the backend when this build was created. */
    environment: string | undefined;
    /** Artifact Registry image URI used by the Cloud Run revision. */
    image: string | undefined;
    /** Cloud Build logs URI. */
    buildLogsUri: string | undefined;
    /** Server-reported build state. */
    state: string | undefined;
    /** True while the build has an ongoing LRO. */
    reconciling: boolean;
    /** User annotations. */
    annotations: Record<string, string>;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-generated resource uid. */
    uid: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
    /** Server-computed etag. */
    etag: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Firebase App Hosting build of a backend from a git commit, storage
 * archive, or container image.
 *
 * Builds have no update API. Changing `buildId`, `backend`,
 * `location`, `source`, or `config` replaces the build.
 *
 * ### Creating a Build
 * **Example:** Container image
 * ```typescript
 * const build = yield* GCP.FirebaseAppHosting.BackendsBuild("Hello", {
 *   backend: backend.name,
 *   source: {
 *     container: { image: "us-docker.pkg.dev/cloudrun/container/hello" },
 *   },
 *   labels: { env: "test" },
 * });
 * ```
 *
 * **Example:** Archive source with Cloud Run limits
 * ```typescript
 * const build = yield* GCP.FirebaseAppHosting.BackendsBuild("Archive", {
 *   backend: backend.name,
 *   source: { archive: { userStorageUri: "gs://bucket/app.tar.gz" } },
 *   config: { runConfig: { cpu: 1, memoryMib: 512, maxInstances: 4 } },
 * });
 * ```
 *
 * @resource
 * @category FirebaseAppHosting
 */
export const BackendsBuild = Resource<BackendsBuild>(
  "GCP.FirebaseAppHosting.BackendsBuild",
);

const resourceName = (backend: string, buildId: string) =>
  `${backend}/builds/${buildId}`;

const toCodebaseSource = (
  value: firebaseapphosting.CodebaseSource | undefined,
): CodebaseSource | undefined =>
  value === undefined
    ? undefined
    : {
        branch: value.branch,
        commit: value.commit,
        repository: value.repository,
      };

const toArchiveSource = (
  value: firebaseapphosting.ArchiveSource | undefined,
): ArchiveSource | undefined =>
  value === undefined
    ? undefined
    : {
        externalSignedUri: value.externalSignedUri,
        userStorageUri: value.userStorageUri,
        rootDirectory: value.rootDirectory,
        description: value.description,
      };

const toContainerSource = (
  value: firebaseapphosting.ContainerSource | undefined,
): ContainerSource | undefined =>
  value === undefined ? undefined : { image: value.image };

const toSource = (
  value: firebaseapphosting.BuildSource | undefined,
): BuildSource | undefined =>
  value === undefined
    ? undefined
    : {
        codebase: toCodebaseSource(value.codebase),
        archive: toArchiveSource(value.archive),
        container: toContainerSource(value.container),
      };

const toConfig = (
  value: firebaseapphosting.Config | undefined,
): BuildConfig | undefined =>
  value === undefined
    ? undefined
    : {
        runConfig: value.runConfig
          ? {
              maxInstances: value.runConfig.maxInstances,
              memoryMib: value.runConfig.memoryMib,
              concurrency: value.runConfig.concurrency,
              minInstances: value.runConfig.minInstances,
              cpu: value.runConfig.cpu,
            }
          : undefined,
        env: value.env?.map((item) => ({
          variable: item.variable,
          value: item.value,
          secret: item.secret,
          availability: item.availability,
        })),
      };

const toAttrs = (item: firebaseapphosting.Build, project: string) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "builds");
  return {
    name,
    buildId: parsed.id,
    backend: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    source: toSource(item.source),
    config: toConfig(item.config),
    displayName: item.displayName,
    environment: item.environment,
    image: item.image,
    buildLogsUri: item.buildLogsUri,
    state: item.state,
    reconciling: item.reconciling === true,
    annotations: stringMap(item.annotations),
    labels: userLabels(item.labels),
    uid: item.uid,
    createTime: item.createTime,
    updateTime: item.updateTime,
    etag: item.etag,
  };
};

const getByName = (name: string) =>
  firebaseapphosting
    .getProjectsLocationsBackendsBuilds({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string) =>
  listAtNested(project, "backends/-", (parent) =>
    listLabeledPages(
      firebaseapphosting.listProjectsLocationsBackendsBuilds.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.builds,
      (item) => item.labels,
    ),
  );

export const BackendsBuildProvider = () =>
  Provider.succeed(BackendsBuild, {
    stables: [
      "name",
      "buildId",
      "backend",
      "project",
      "location",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const previousParent =
        (olds?.backend ?? output?.backend)
          ? expandParent(
              olds?.backend ?? output?.backend ?? "",
              env.project,
              previousLocation,
              "backends",
            )
          : undefined;
      const nextParent = expandParent(
        news.backend,
        env.project,
        location,
        "backends",
      );
      return replaceOnIdentity({
        previousId: olds?.buildId ?? output?.buildId,
        nextId: news.buildId ?? olds?.buildId ?? output?.buildId,
        previousLocation,
        nextLocation: location,
        previousParent,
        nextParent,
        extra:
          fingerprint(olds?.source ?? output?.source) !==
            fingerprint(news.source) ||
          fingerprint(olds?.config ?? output?.config) !==
            fingerprint(news.config),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const buildId = yield* toPhysicalId(
        id,
        olds?.buildId,
        output?.buildId,
        "build",
        MAX_BACKEND_ID_LENGTH,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const backend =
        output?.backend ??
        (olds?.backend
          ? expandParent(olds.backend, env.project, location, "backends")
          : undefined);
      const name =
        output?.name ?? (backend ? resourceName(backend, buildId) : undefined);
      if (name === undefined) return undefined;
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listOwned(env.project);
        return items.map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const buildId = yield* toPhysicalId(
        id,
        news.buildId,
        output?.buildId,
        "build",
        MAX_BACKEND_ID_LENGTH,
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const backend = expandParent(
        news.backend,
        env.project,
        location,
        "backends",
      );
      const name = resourceName(backend, buildId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const desiredAnnotations = news.annotations ?? {};

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* firebaseapphosting
          .createProjectsLocationsBackendsBuilds({
            parent: backend,
            buildId,
            body: {
              source: news.source,
              config: news.config,
              displayName: news.displayName,
              annotations: desiredAnnotations,
              labels: desiredLabels,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* firebaseapphosting
        .deleteProjectsLocationsBackendsBuilds({
          name: output.name,
        })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForDeleteOperation(operation);
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
