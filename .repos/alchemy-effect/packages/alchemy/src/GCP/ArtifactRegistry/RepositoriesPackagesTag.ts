import * as artifactregistry from "@distilled.cloud/gcp/artifactregistry_v1";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  ResourceNotResolved,
  expandRepository,
  hasAlchemyLabelMap,
  lastSegment,
  listAlchemyRepositories,
  listChildResources,
  listPackages,
  listTags,
  locationFromRepository,
  missingGet,
  normalizeLocation,
  parseName,
  replaceOnIdentity,
  sameText,
  toPhysicalId,
} from "./internal.ts";

export type RepositoriesPackagesTagProps = {
  /**
   * Parent repository. Full name
   * `projects/{project}/locations/{location}/repositories/{repository}`
   * or the repository id (combined with `location`). Immutable —
   * changing it replaces the tag.
   */
  repository: string;
  /**
   * Package that owns the tag. Full name
   * `.../repositories/{repository}/packages/{package}` or the package
   * id. Immutable — changing it replaces the tag.
   */
  packageId: string;
  /**
   * Region used when `repository` is a bare id.
   * @default the repository's location, else the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * Tag id (the `{tag}` segment of `.../packages/{package}/tags/{tag}`).
   * If omitted, a unique name is generated. Allowed characters:
   * `[a-zA-Z0-9-._~:@]`. Immutable — changing it replaces the tag.
   */
  tagId?: string;
  /**
   * Version this tag points at. Full name
   * `.../packages/{package}/versions/{version}` or the version id.
   */
  version: string;
};

export type RepositoriesPackagesTag = Resource<
  "GCP.ArtifactRegistry.RepositoriesPackagesTag",
  RepositoriesPackagesTagProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/repositories/{repository}/packages/{package}/tags/{tag}`. */
    name: string;
    /** Tag id (last path segment). */
    tagId: string;
    /** Parent package resource name. */
    package: string;
    /** Package id (last path segment). */
    packageId: string;
    /** Parent repository resource name. */
    repository: string;
    /** Project id. */
    project: string;
    /** Location id (`us-central1`). */
    location: string;
    /** Version resource name this tag currently points at. */
    version: string | undefined;
  },
  never,
  Providers
>;

/**
 * An Artifact Registry package tag — an alternate name for a version.
 *
 * Tags have no labels field. `list` / nuke find tags whose parent
 * repository carries Alchemy labels. Changing `repository`, `packageId`,
 * `location`, or `tagId` replaces the tag. `version` updates in place.
 *
 * The package and version must already exist (for example a Docker
 * image digest). Generic repositories reject tag create with HTTP 501.
 *
 * ### Creating a RepositoriesPackagesTag
 * **Example:** Point `stable` at a version
 * ```typescript
 * const tag = yield* GCP.ArtifactRegistry.RepositoriesPackagesTag("Stable", {
 *   repository: images.name,
 *   packageId: "app",
 *   tagId: "stable",
 *   version: "sha256:abc123",
 * });
 * ```
 *
 * **Example:** Move the tag to a new version
 * ```typescript
 * const tag = yield* GCP.ArtifactRegistry.RepositoriesPackagesTag("Stable", {
 *   repository: images.name,
 *   packageId: "app",
 *   tagId: "stable",
 *   version: "sha256:def456",
 * });
 * ```
 *
 * @resource
 * @category ArtifactRegistry
 */
export const RepositoriesPackagesTag = Resource<RepositoriesPackagesTag>(
  "GCP.ArtifactRegistry.RepositoriesPackagesTag",
);

const expandPackage = (repository: string, packageId: string) => {
  const next = packageId.replace(/\/+$/, "");
  if (next.includes("/packages/")) return next;
  return `${repository}/packages/${next}`;
};

const expandVersion = (packageName: string, version: string) => {
  const next = version.replace(/\/+$/, "");
  if (next.includes("/versions/")) return next;
  return `${packageName}/versions/${next}`;
};

const resourceNameOf = (packageName: string, tagId: string) =>
  `${packageName}/tags/${tagId}`;

const toAttrs = (
  tag: artifactregistry.Tag,
  project: string,
  region: string,
) => {
  const name = tag.name ?? "";
  const parsed = parseName(name, "tags", region);
  const pkg = parsed.parent;
  return {
    name,
    tagId: parsed.id,
    package: pkg,
    packageId: lastSegment(pkg),
    repository: parseName(pkg, "packages", region).parent,
    project: parsed.project || project,
    location: parsed.location,
    version: tag.version,
  };
};

const getByName = missingGet(
  artifactregistry.getProjectsLocationsRepositoriesPackagesTags,
);

const getRepository = missingGet(
  artifactregistry.getProjectsLocationsRepositories,
);

export const RepositoriesPackagesTagProvider = () =>
  Provider.succeed(RepositoriesPackagesTag, {
    stables: [
      "name",
      "tagId",
      "package",
      "packageId",
      "repository",
      "project",
      "location",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousId = olds?.tagId ?? output?.tagId;
      const nextId = news.tagId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ??
          locationFromRepository(news.repository, previousLocation),
        env.region,
      );
      const previousPackage = lastSegment(
        olds?.packageId ?? output?.packageId ?? "",
      );
      const nextPackage = lastSegment(news.packageId);
      return replaceOnIdentity({
        previousId,
        nextId,
        previousLocation,
        nextLocation,
        previousParent: previousPackage,
        nextParent: nextPackage,
        extra:
          lastSegment(olds?.repository ?? output?.repository ?? "") !==
            lastSegment(news.repository) &&
          (olds?.repository ?? output?.repository) !== undefined,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ??
          output?.location ??
          locationFromRepository(
            olds?.repository ?? output?.repository,
            env.region,
          ),
        env.region,
      );
      const repository = expandRepository(
        olds?.repository ?? output?.repository ?? "",
        env.project,
        location,
      );
      const packageName = expandPackage(
        repository,
        olds?.packageId ?? output?.packageId ?? "",
      );
      const tagId = yield* toPhysicalId(id, olds?.tagId, output?.tagId, "tag");
      const name = output?.name ?? resourceNameOf(packageName, tagId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      const repo = yield* getRepository(attrs.repository);
      return hasAlchemyLabelMap(repo?.labels) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const repos = yield* listAlchemyRepositories(env.project);
        const packages = yield* listChildResources(repos, listPackages);
        const tags = yield* listChildResources(packages, listTags);
        return tags.map((tag) => toAttrs(tag, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ??
          output?.location ??
          locationFromRepository(news.repository, env.region),
        env.region,
      );
      const repository = expandRepository(
        news.repository,
        env.project,
        location,
      );
      const packageName = expandPackage(repository, news.packageId);
      const tagId = yield* toPhysicalId(id, news.tagId, output?.tagId, "tag");
      const name = resourceNameOf(packageName, tagId);
      const version = expandVersion(packageName, news.version);

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* artifactregistry
          .createProjectsLocationsRepositoriesPackagesTags({
            parent: packageName,
            tagId,
            body: {
              version,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      const observed = current.name ?? name;
      if (!sameText(current.version, version)) {
        current =
          yield* artifactregistry.patchProjectsLocationsRepositoriesPackagesTags(
            {
              name: observed,
              updateMask: "version",
              body: {
                name: observed,
                version,
              },
            },
          );
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* artifactregistry
        .deleteProjectsLocationsRepositoriesPackagesTags({
          name: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
