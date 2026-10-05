import * as artifactregistry from "@distilled.cloud/gcp/artifactregistry_v1";
import * as Data from "effect/Data";
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
  diffLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import { waitForDeleteOperation, waitForOperation } from "./internal.ts";

const DEFAULT_FORMAT = "DOCKER";
const DEFAULT_MODE = "STANDARD_REPOSITORY";
const MAX_NAME_LENGTH = 63;

export type RepositoryProps = {
  /**
   * Repository id (the `{repository}` segment of
   * `projects/{project}/locations/{location}/repositories/{repository}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Must be 2-63 characters, start with a letter, and match
   * `[a-z]([a-z0-9-]*[a-z0-9])?`. Immutable — changing it replaces the
   * repository.
   */
  repositoryId?: string;
  /**
   * Artifact Registry location (`us-central1`, `us`, `europe`, …).
   * Immutable — changing it replaces the repository. `US-CENTRAL1` is
   * accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * Package format (`DOCKER`, `MAVEN`, `NPM`, `PYTHON`, `APT`, `YUM`,
   * `GO`, `GENERIC`, `KFP`, `RUBY`, `GOOGET`). Immutable — changing it
   * replaces the repository.
   * @default "DOCKER"
   */
  format?: artifactregistry.RepositoryFormatEnum | (string & {});
  /**
   * Repository mode. Immutable — changing it replaces the repository.
   * @default "STANDARD_REPOSITORY"
   */
  mode?: artifactregistry.RepositoryModeEnum | (string & {});
  /**
   * User-provided description of the repository.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Cloud KMS key used to encrypt repository contents, as
   * `projects/{project}/locations/{location}/keyRings/{keyRing}/cryptoKeys/{cryptoKey}`. Immutable —
   * changing it replaces the repository.
   */
  kmsKeyName?: string;
  /**
   * Docker repository config. Only applied when `format` is `DOCKER`.
   */
  dockerConfig?: {
    /**
     * Prevent tags from being modified, moved, or deleted. Tags can still
     * be created.
     */
    immutableTags?: boolean;
  };
  /**
   * Maven repository config. Only applied when `format` is `MAVEN`.
   * Immutable — changing it replaces the repository.
   */
  mavenConfig?: {
    /** Allow republishing the same snapshot versions. */
    allowSnapshotOverwrites?: boolean;
    /** Versions the registry will accept (`RELEASE`, `SNAPSHOT`). */
    versionPolicy?:
      | artifactregistry.MavenRepositoryConfigVersionPolicyEnum
      | (string & {});
  };
  /**
   * Cleanup policies keyed by user-provided policy id.
   */
  cleanupPolicies?: artifactregistry.CleanupPolicyMap;
  /**
   * If true, the cleanup pipeline is prevented from deleting versions.
   * @default false
   */
  cleanupPolicyDryRun?: boolean;
};

export type Repository = Resource<
  "GCP.ArtifactRegistry.Repository",
  RepositoryProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/repositories/{repository}`. */
    name: string;
    /** Repository id (last path segment). */
    repositoryId: string;
    /** Project id. */
    project: string;
    /** Location id (`us-central1`, `us`, …). */
    location: string;
    /** Package format (`DOCKER`, `NPM`, …). */
    format: string;
    /** Repository mode (`STANDARD_REPOSITORY`, …). */
    mode: string;
    /** User-provided description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Registry endpoint, e.g. `us-central1-docker.pkg.dev/proj/repo`. */
    registryUri: string | undefined;
    /** KMS key used for encryption, if any. */
    kmsKeyName: string | undefined;
    /** Whether Docker tags are immutable. */
    immutableTags: boolean;
    /** Whether cleanup policies run in dry-run mode. */
    cleanupPolicyDryRun: boolean;
    /** Server-reported size of stored artifacts, in bytes. */
    sizeBytes: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An Artifact Registry repository for Docker images, language packages, or
 * generic artifacts.
 *
 * Changing `repositoryId`, `location`, `format`, `mode`, `kmsKeyName`, or
 * Maven version policy replaces the repository.
 *
 * ### Creating a Repository
 * **Example:** Generated name
 * ```typescript
 * const images = yield* GCP.ArtifactRegistry.Repository("Images", {});
 * ```
 *
 * **Example:** Explicit id, format, and labels
 * ```typescript
 * const images = yield* GCP.ArtifactRegistry.Repository("Images", {
 *   repositoryId: "app-images",
 *   location: "us-central1",
 *   format: "DOCKER",
 *   description: "container images",
 *   labels: { env: "prod" },
 *   dockerConfig: { immutableTags: true },
 * });
 * ```
 *
 * @resource
 * @category ArtifactRegistry
 */
export const Repository = Resource<Repository>(
  "GCP.ArtifactRegistry.Repository",
);

export class RepositoryNotResolved extends Data.TaggedError(
  "GCP.ArtifactRegistry.RepositoryNotResolved",
)<{
  name: string;
}> {}

export class RepositoryStillExists extends Data.TaggedError(
  "GCP.ArtifactRegistry.RepositoryStillExists",
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

const normalizeFormat = (format: string | undefined) =>
  (format ?? DEFAULT_FORMAT).toUpperCase();

const normalizeMode = (mode: string | undefined) => {
  const value = (mode ?? DEFAULT_MODE).toUpperCase();
  return value === "MODE_UNSPECIFIED" ? DEFAULT_MODE : value;
};

const resourceName = (
  project: string,
  location: string,
  repositoryId: string,
) => `projects/${project}/locations/${location}/repositories/${repositoryId}`;

const parseName = (name: string, fallbackLocation: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const repositoriesAt = parts.lastIndexOf("repositories");
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : fallbackLocation,
    repositoryId:
      repositoriesAt >= 0 && parts[repositoriesAt + 1]
        ? parts[repositoriesAt + 1]!
        : lastSegment(name),
  };
};

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

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

const toAttrs = (
  repo: artifactregistry.Repository,
  project: string,
  region: string,
) => {
  const name = repo.name ?? "";
  const parsed = parseName(name, region);
  return {
    name,
    repositoryId: parsed.repositoryId,
    project: parsed.project || project,
    location: parsed.location,
    format: normalizeFormat(repo.format),
    mode: normalizeMode(repo.mode),
    description: repo.description,
    labels: userLabels(repo.labels),
    registryUri: repo.registryUri,
    kmsKeyName: repo.kmsKeyName,
    immutableTags: repo.dockerConfig?.immutableTags === true,
    cleanupPolicyDryRun: repo.cleanupPolicyDryRun === true,
    sizeBytes: repo.sizeBytes,
    createTime: repo.createTime,
    updateTime: repo.updateTime,
  };
};

const getByName = (name: string) =>
  artifactregistry
    .getProjectsLocationsRepositories({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const mavenKey = (config: RepositoryProps["mavenConfig"] | undefined) =>
  `${config?.allowSnapshotOverwrites === true}:${(
    config?.versionPolicy ?? "VERSION_POLICY_UNSPECIFIED"
  ).toUpperCase()}`;

const cleanupPoliciesJson = (
  policies: artifactregistry.CleanupPolicyMap | undefined,
) => JSON.stringify(policies ?? {});

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (repo): repo is artifactregistry.Repository => repo !== undefined,
      () => new RepositoryNotResolved({ name }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.ArtifactRegistry.RepositoryNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (repo) => repo === undefined,
      () => new RepositoryStillExists({ name }),
    ),
    Effect.asVoid,
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.ArtifactRegistry.RepositoryStillExists",
      times: 10,
      schedule: Schedule.spaced("1 second"),
    }),
  );

export const RepositoryProvider = () =>
  Provider.succeed(Repository, {
    stables: [
      "name",
      "repositoryId",
      "project",
      "location",
      "format",
      "mode",
      "kmsKeyName",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;

      const previousId = olds?.repositoryId ?? output?.repositoryId;
      const nextId = news.repositoryId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const previousFormat = normalizeFormat(olds?.format ?? output?.format);
      const nextFormat = normalizeFormat(news.format ?? output?.format);
      const previousMode = normalizeMode(olds?.mode ?? output?.mode);
      const nextMode = normalizeMode(news.mode ?? output?.mode);
      const previousKms = olds?.kmsKeyName ?? output?.kmsKeyName ?? "";
      const nextKms = news.kmsKeyName ?? previousKms;
      const mavenChanged =
        mavenKey(news.mavenConfig) !== mavenKey(olds?.mavenConfig);

      const replace =
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation ||
        previousFormat !== nextFormat ||
        previousMode !== nextMode ||
        previousKms !== nextKms ||
        mavenChanged;

      if (!replace) return undefined;
      return {
        action: "replace" as const,
        deleteFirst:
          previousLocation === nextLocation &&
          previousId !== undefined &&
          nextId === previousId,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const repositoryId = yield* toId(
        id,
        olds?.repositoryId,
        output?.repositoryId,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, repositoryId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* artifactregistry.listProjectsLocationsRepositories
          .pages({
            parent: `projects/${env.project}/locations/-`,
            pageSize: 1000,
          })
          .pipe(Stream.runCollect);
        return Array.from(pages).flatMap((page) =>
          (page.repositories ?? [])
            .filter((repo) =>
              Object.keys(repo.labels ?? {}).some((key) =>
                key.startsWith("alchemy-"),
              ),
            )
            .map((repo) => toAttrs(repo, env.project, env.region)),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const repositoryId = yield* toId(
        id,
        news.repositoryId,
        output?.repositoryId,
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const format = normalizeFormat(news.format);
      const mode = normalizeMode(news.mode);
      const name = resourceName(env.project, location, repositoryId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const desiredImmutableTags = news.dockerConfig?.immutableTags === true;
      const desiredCleanupDryRun = news.cleanupPolicyDryRun === true;
      const desiredMaven = format === "MAVEN" ? news.mavenConfig : undefined;
      const desiredDocker =
        format === "DOCKER"
          ? { immutableTags: desiredImmutableTags }
          : undefined;

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* artifactregistry
          .createProjectsLocationsRepositories({
            parent: `projects/${env.project}/locations/${location}`,
            repositoryId,
            body: {
              format,
              mode,
              description: news.description,
              labels: desiredLabels,
              kmsKeyName: news.kmsKeyName,
              dockerConfig: desiredDocker,
              mavenConfig: desiredMaven,
              cleanupPolicies: news.cleanupPolicies,
              cleanupPolicyDryRun: desiredCleanupDryRun,
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

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      const dockerChanged =
        format === "DOCKER" &&
        (current.dockerConfig?.immutableTags === true) !== desiredImmutableTags;
      const cleanupDryRunChanged =
        (current.cleanupPolicyDryRun === true) !== desiredCleanupDryRun;
      const cleanupPoliciesChanged =
        cleanupPoliciesJson(current.cleanupPolicies) !==
        cleanupPoliciesJson(news.cleanupPolicies);

      if (
        labelsChanged ||
        descriptionChanged ||
        dockerChanged ||
        cleanupDryRunChanged ||
        cleanupPoliciesChanged
      ) {
        const updateMask = [
          labelsChanged ? "labels" : undefined,
          descriptionChanged ? "description" : undefined,
          dockerChanged ? "dockerConfig" : undefined,
          cleanupDryRunChanged ? "cleanupPolicyDryRun" : undefined,
          cleanupPoliciesChanged ? "cleanupPolicies" : undefined,
        ].filter((field): field is string => field !== undefined);

        current = yield* artifactregistry.patchProjectsLocationsRepositories({
          name,
          updateMask: updateMask.join(","),
          body: {
            name,
            labels: desiredLabels,
            description: news.description,
            dockerConfig: desiredDocker,
            cleanupPolicyDryRun: desiredCleanupDryRun,
            cleanupPolicies: news.cleanupPolicies ?? {},
          },
        });
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* artifactregistry
        .deleteProjectsLocationsRepositories({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        yield* waitForDeleteOperation(operation);
      }
      yield* waitUntilGone(output.name);
    }),
  });
