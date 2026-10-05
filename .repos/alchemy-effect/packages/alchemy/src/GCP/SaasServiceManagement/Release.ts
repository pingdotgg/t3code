import * as saasservicemgmt from "@distilled.cloud/gcp/saasservicemgmt_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  ResourceNotResolved,
  collectPages,
  expandName,
  fieldMask,
  fingerprint,
  hasAlchemyLabelKeys,
  lastSegment,
  normalizeLocation,
  parentOf,
  parseName,
  replaceOnIdentity,
  resourceName,
  sameRef,
  toPhysicalId,
  userAnnotations,
  userLabels,
  waitUntilGone,
} from "./internal.ts";

const COLLECTION = "releases";

export type ReleaseBlueprint = {
  /**
   * URI of the OCI blueprint package. Hostname may be omitted to use
   * the regional Artifact Registry path. Immutable.
   */
  package?: string;
  /** Actuation engine (`terraform`, `helm`, …). Output-only. */
  engine?: string;
  /** Version metadata from the image manifest. Output-only. */
  version?: string;
};

export type ReleaseVariable = {
  type?: saasservicemgmt.UnitVariableTypeEnum | (string & {});
  value?: string;
  variable?: string;
};

export type ReleaseProps = {
  /**
   * Release id (the `{release}` segment of
   * `projects/{project}/locations/{location}/releases/{release}`). If
   * omitted, a unique RFC1035 name is generated. Immutable — changing
   * it replaces the release.
   */
  releaseId?: string;
  /**
   * Region of the release (`us-central1`, …). Immutable — changing it
   * replaces the release. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * UnitKind this release belongs to. Accepts a unit kind id or a full
   * resource name. Immutable — changing it replaces the release.
   */
  unitKind: string;
  /**
   * Blueprint package that actuates units of this release. `package` is
   * immutable — changing it replaces the release.
   */
  blueprint?: ReleaseBlueprint;
  /**
   * Default values for input variables declared on the blueprint.
   * Maximum 100.
   */
  inputVariableDefaults?: ReleaseVariable[];
  /**
   * Releases a unit may upgrade from to reach this one. Empty means no
   * constraint.
   */
  upgradeableFromReleases?: string[];
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Unstructured annotations preserved across updates.
   */
  annotations?: Record<string, string>;
};

export type Release = Resource<
  "GCP.SaasServiceManagement.Release",
  ReleaseProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/releases/{release}`. */
    name: string;
    /** Release id (last path segment). */
    releaseId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** UnitKind resource name. */
    unitKind: string | undefined;
    /** UnitKind id (last path segment). */
    unitKindId: string | undefined;
    /** Blueprint package. */
    blueprint: ReleaseBlueprint | undefined;
    /** Input variable defaults. */
    inputVariableDefaults: ReleaseVariable[];
    /** Input variables declared on the blueprint. */
    inputVariables: ReleaseVariable[];
    /** Output variables declared on the blueprint. */
    outputVariables: ReleaseVariable[];
    /** Releases this one may be upgraded from. */
    upgradeableFromReleases: ReadonlyArray<string>;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** User annotations. */
    annotations: Record<string, string>;
    /** Server UUID. */
    uid: string | undefined;
    /** Server etag. */
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
 * An App Lifecycle Manager release — a version of a UnitKind packaged
 * as an OCI blueprint.
 *
 * `releaseId`, `location`, `unitKind`, and `blueprint.package` replace
 * the release. Input variable defaults, upgrade constraints, labels,
 * and annotations update in place.
 *
 * ### Creating a Release
 * **Example:** Blueprint release
 * ```typescript
 * const release = yield* GCP.SaasServiceManagement.Release("V1", {
 *   unitKind: kind.name,
 *   blueprint: { package: "us-central1-docker.pkg.dev/proj/blueprints/store:v1" },
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating a Release
 * **Example:** Default input variables
 * ```typescript
 * const release = yield* GCP.SaasServiceManagement.Release("V1", {
 *   releaseId: release.releaseId,
 *   unitKind: kind.name,
 *   blueprint: { package: "us-central1-docker.pkg.dev/proj/blueprints/store:v1" },
 *   inputVariableDefaults: [{ variable: "region", type: "STRING", value: "us-central1" }],
 * });
 * ```
 *
 * @resource
 * @category SaasServiceManagement
 */
export const Release = Resource<Release>("GCP.SaasServiceManagement.Release");

const expandUpgradeable = (
  values: string[] | undefined,
  project: string,
  location: string,
) => values?.map((value) => expandName(value, project, location, COLLECTION));

const toAttrs = (item: saasservicemgmt.Release, project: string) => {
  const name = item.name ?? "";
  const parsed = parseName(name, COLLECTION);
  return {
    name,
    releaseId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    unitKind: item.unitKind,
    unitKindId: item.unitKind ? lastSegment(item.unitKind) : undefined,
    blueprint: item.blueprint
      ? {
          package: item.blueprint.package,
          engine: item.blueprint.engine,
          version: item.blueprint.version,
        }
      : undefined,
    inputVariableDefaults: item.inputVariableDefaults ?? [],
    inputVariables: item.inputVariables ?? [],
    outputVariables: item.outputVariables ?? [],
    upgradeableFromReleases:
      item.releaseRequirements?.upgradeableFromReleases ?? [],
    labels: userLabels(item.labels),
    annotations: userAnnotations(item.annotations),
    uid: item.uid,
    etag: item.etag,
    createTime: item.createTime,
    updateTime: item.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : saasservicemgmt
        .getProjectsLocationsReleases({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string, location: string) =>
  collectPages(
    saasservicemgmt.listProjectsLocationsReleases.pages({
      parent: parentOf(project, "-"),
      pageSize: 1000,
    }),
    (page) => page.releases,
  ).pipe(
    Effect.map((items) =>
      items.filter((item) => hasAlchemyLabelKeys(item.labels)),
    ),
    Effect.flatMap((items) =>
      items.length > 0
        ? Effect.succeed(items)
        : collectPages(
            saasservicemgmt.listProjectsLocationsReleases.pages({
              parent: parentOf(project, location),
              pageSize: 1000,
            }),
            (page) => page.releases,
          ).pipe(
            Effect.map((fallback) =>
              fallback.filter((item) => hasAlchemyLabelKeys(item.labels)),
            ),
          ),
    ),
  );

export const ReleaseProvider = () =>
  Provider.succeed(Release, {
    stables: [
      "name",
      "releaseId",
      "project",
      "location",
      "unitKindId",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousPackage =
        olds?.blueprint?.package ?? output?.blueprint?.package;
      const nextPackage = news.blueprint?.package ?? previousPackage;
      return replaceOnIdentity({
        previousId: olds?.releaseId ?? output?.releaseId,
        nextId: news.releaseId ?? olds?.releaseId ?? output?.releaseId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location ?? env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location ?? env.region,
        ),
        extra:
          !sameRef(olds?.unitKind ?? output?.unitKind, news.unitKind) ||
          (previousPackage !== undefined &&
            nextPackage !== undefined &&
            previousPackage !== nextPackage),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const releaseId = yield* toPhysicalId(
        id,
        olds?.releaseId,
        output?.releaseId,
        "rel",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location ?? env.region,
      );
      const name =
        output?.name ??
        resourceName(env.project, location, COLLECTION, releaseId);
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
        const items = yield* listOwned(env.project, env.region);
        return items.map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const releaseId = yield* toPhysicalId(
        id,
        news.releaseId,
        output?.releaseId,
        "rel",
      );
      const location = normalizeLocation(
        news.location ?? output?.location ?? env.region,
      );
      const name = resourceName(env.project, location, COLLECTION, releaseId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const unitKind = expandName(
        news.unitKind,
        env.project,
        location,
        "unitKinds",
      );
      const upgradeableFromReleases = expandUpgradeable(
        news.upgradeableFromReleases,
        env.project,
        location,
      );
      const annotations = news.annotations;
      const blueprint = news.blueprint
        ? { package: news.blueprint.package }
        : undefined;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* saasservicemgmt
          .createProjectsLocationsReleases({
            parent: parentOf(env.project, location),
            releaseId,
            body: {
              unitKind,
              blueprint,
              inputVariableDefaults: news.inputVariableDefaults,
              releaseRequirements:
                upgradeableFromReleases === undefined
                  ? undefined
                  : { upgradeableFromReleases },
              labels: desiredLabels,
              annotations,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const annotationsChanged =
        annotations !== undefined &&
        fingerprint(userAnnotations(current.annotations)) !==
          fingerprint(annotations);
      const defaultsChanged =
        news.inputVariableDefaults !== undefined &&
        fingerprint(current.inputVariableDefaults) !==
          fingerprint(news.inputVariableDefaults);
      const requirementsChanged =
        news.upgradeableFromReleases !== undefined &&
        fingerprint(current.releaseRequirements?.upgradeableFromReleases) !==
          fingerprint(upgradeableFromReleases);
      const mask = fieldMask([
        labelsChanged && "labels",
        annotationsChanged && "annotations",
        defaultsChanged && "inputVariableDefaults",
        requirementsChanged && "releaseRequirements",
      ]);

      if (mask.length > 0) {
        current = yield* saasservicemgmt.patchProjectsLocationsReleases({
          name: current.name ?? name,
          updateMask: mask,
          body: {
            name: current.name ?? name,
            etag: current.etag,
            inputVariableDefaults: news.inputVariableDefaults,
            releaseRequirements:
              upgradeableFromReleases === undefined
                ? undefined
                : { upgradeableFromReleases },
            labels: desiredLabels,
            annotations,
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* saasservicemgmt
        .deleteProjectsLocationsReleases({ name: output.name })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.void),
        );
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
