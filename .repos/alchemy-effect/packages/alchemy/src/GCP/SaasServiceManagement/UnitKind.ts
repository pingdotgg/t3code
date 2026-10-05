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

const COLLECTION = "unitKinds";

export type UnitKindBoundaryType =
  | saasservicemgmt.UnitKindBoundaryTypeEnum
  | (string & {});

export type UnitKindDependency = {
  /** UnitKind resource name this kind depends on. Immutable. */
  unitKind?: string;
  /** Alias used in variable mappings. */
  alias?: string;
};

export type UnitKindFromMapping = {
  outputVariable?: string;
  dependency?: string;
};

export type UnitKindToMapping = {
  inputVariable?: string;
  ignoreForLookup?: boolean;
  dependency?: string;
};

export type UnitKindVariableMapping = {
  variable?: string;
  from?: UnitKindFromMapping;
  to?: UnitKindToMapping;
};

export type UnitKindProps = {
  /**
   * UnitKind id (the `{unitKind}` segment of
   * `projects/{project}/locations/{location}/unitKinds/{unitKind}`). If
   * omitted, a unique RFC1035 name is generated. Immutable — changing
   * it replaces the unit kind.
   */
  unitKindId?: string;
  /**
   * Region of the unit kind (`us-central1`, …). Immutable — changing it
   * replaces the unit kind. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * SaaS this unit kind belongs to. Accepts a SaaS id or a full
   * resource name. Immutable — changing it replaces the unit kind.
   */
  saas: string;
  /**
   * Default Release used when creating new units of this kind. Accepts
   * a release id or a full resource name.
   */
  defaultRelease?: string;
  /**
   * Default flag revisions applied to newly created units.
   */
  defaultFlagRevisions?: string[];
  /**
   * Other unit kinds this kind depends on. Immutable — changing them
   * replaces the unit kind.
   */
  dependencies?: UnitKindDependency[];
  /**
   * Input variable mappings to or from dependencies. Maximum 100.
   */
  inputVariableMappings?: UnitKindVariableMapping[];
  /**
   * Output variable mappings from this unit kind. Maximum 100.
   */
  outputVariableMappings?: UnitKindVariableMapping[];
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Unstructured annotations preserved across updates.
   */
  annotations?: Record<string, string>;
};

export type UnitKind = Resource<
  "GCP.SaasServiceManagement.UnitKind",
  UnitKindProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/unitKinds/{unitKind}`. */
    name: string;
    /** UnitKind id (last path segment). */
    unitKindId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** SaaS resource name. */
    saas: string | undefined;
    /** SaaS id (last path segment). */
    saasId: string | undefined;
    /** Default release resource name. */
    defaultRelease: string | undefined;
    /** Default flag revisions. */
    defaultFlagRevisions: ReadonlyArray<string>;
    /** Declared dependencies. */
    dependencies: UnitKindDependency[];
    /** Input variable mappings. */
    inputVariableMappings: UnitKindVariableMapping[];
    /** Output variable mappings. */
    outputVariableMappings: UnitKindVariableMapping[];
    /** Boundary type reported by the API. */
    boundaryType: string | undefined;
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
 * An App Lifecycle Manager unit kind — the blueprint family that Units
 * of a SaaS share.
 *
 * Units of the same kind follow the same release model and are typically
 * rolled out together. `unitKindId`, `location`, `saas`, and
 * `dependencies` replace the unit kind. Default release, mappings,
 * labels, and annotations update in place.
 *
 * ### Creating a UnitKind
 * **Example:** Kind of a SaaS
 * ```typescript
 * const product = yield* GCP.SaasServiceManagement.Saa("Inventory", {
 *   locations: [{ name: "us-central1" }],
 * });
 * const kind = yield* GCP.SaasServiceManagement.UnitKind("Store", {
 *   saas: product.name,
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating a UnitKind
 * **Example:** Point at a default release
 * ```typescript
 * const kind = yield* GCP.SaasServiceManagement.UnitKind("Store", {
 *   unitKindId: kind.unitKindId,
 *   saas: product.name,
 *   defaultRelease: release.name,
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * @resource
 * @category SaasServiceManagement
 */
export const UnitKind = Resource<UnitKind>(
  "GCP.SaasServiceManagement.UnitKind",
);

const expandDependencies = (
  dependencies: UnitKindDependency[] | undefined,
  project: string,
  location: string,
): saasservicemgmt.Dependency[] | undefined =>
  dependencies?.map((dependency) => ({
    alias: dependency.alias,
    unitKind: dependency.unitKind
      ? expandName(dependency.unitKind, project, location, COLLECTION)
      : undefined,
  }));

const toAttrs = (item: saasservicemgmt.UnitKind, project: string) => {
  const name = item.name ?? "";
  const parsed = parseName(name, COLLECTION);
  return {
    name,
    unitKindId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    saas: item.saas,
    saasId: item.saas ? lastSegment(item.saas) : undefined,
    defaultRelease: item.defaultRelease,
    defaultFlagRevisions: item.defaultFlagRevisions ?? [],
    dependencies: (item.dependencies ?? []).map((dependency) => ({
      unitKind: dependency.unitKind,
      alias: dependency.alias,
    })),
    inputVariableMappings: item.inputVariableMappings ?? [],
    outputVariableMappings: item.outputVariableMappings ?? [],
    boundaryType: item.boundaryType,
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
        .getProjectsLocationsUnitKinds({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string, location: string) =>
  collectPages(
    saasservicemgmt.listProjectsLocationsUnitKinds.pages({
      parent: parentOf(project, "-"),
      pageSize: 1000,
    }),
    (page) => page.unitKinds,
  ).pipe(
    Effect.map((items) =>
      items.filter((item) => hasAlchemyLabelKeys(item.labels)),
    ),
    Effect.flatMap((items) =>
      items.length > 0
        ? Effect.succeed(items)
        : collectPages(
            saasservicemgmt.listProjectsLocationsUnitKinds.pages({
              parent: parentOf(project, location),
              pageSize: 1000,
            }),
            (page) => page.unitKinds,
          ).pipe(
            Effect.map((fallback) =>
              fallback.filter((item) => hasAlchemyLabelKeys(item.labels)),
            ),
          ),
    ),
  );

export const UnitKindProvider = () =>
  Provider.succeed(UnitKind, {
    stables: [
      "name",
      "unitKindId",
      "project",
      "location",
      "saasId",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      return replaceOnIdentity({
        previousId: olds?.unitKindId ?? output?.unitKindId,
        nextId: news.unitKindId ?? olds?.unitKindId ?? output?.unitKindId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location ?? env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location ?? env.region,
        ),
        extra:
          !sameRef(olds?.saas ?? output?.saas, news.saas) ||
          (news.dependencies !== undefined &&
            fingerprint(news.dependencies) !==
              fingerprint(olds?.dependencies ?? output?.dependencies)),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const unitKindId = yield* toPhysicalId(
        id,
        olds?.unitKindId,
        output?.unitKindId,
        "ukind",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location ?? env.region,
      );
      const name =
        output?.name ??
        resourceName(env.project, location, COLLECTION, unitKindId);
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
      const unitKindId = yield* toPhysicalId(
        id,
        news.unitKindId,
        output?.unitKindId,
        "ukind",
      );
      const location = normalizeLocation(
        news.location ?? output?.location ?? env.region,
      );
      const name = resourceName(env.project, location, COLLECTION, unitKindId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const saas = expandName(news.saas, env.project, location, "saas");
      const defaultRelease =
        news.defaultRelease === undefined
          ? undefined
          : expandName(news.defaultRelease, env.project, location, "releases");
      const dependencies = expandDependencies(
        news.dependencies,
        env.project,
        location,
      );
      const annotations = news.annotations;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* saasservicemgmt
          .createProjectsLocationsUnitKinds({
            parent: parentOf(env.project, location),
            unitKindId,
            body: {
              saas,
              defaultRelease,
              defaultFlagRevisions: news.defaultFlagRevisions,
              dependencies,
              inputVariableMappings: news.inputVariableMappings,
              outputVariableMappings: news.outputVariableMappings,
              labels: desiredLabels,
              annotations,
            },
          })
          .pipe(
            // A Saas created seconds earlier is unreadable here until it
            // propagates.
            Effect.retry({
              while: (error) => error._tag === "SaasNotFound",
              schedule: Schedule.spaced("2 seconds"),
              times: 15,
            }),
            Effect.catchTag("Conflict", () => getByName(name)),
          );
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
      const defaultReleaseChanged =
        news.defaultRelease !== undefined &&
        !sameRef(current.defaultRelease, defaultRelease);
      const flagRevisionsChanged =
        news.defaultFlagRevisions !== undefined &&
        fingerprint(current.defaultFlagRevisions) !==
          fingerprint(news.defaultFlagRevisions);
      const inputChanged =
        news.inputVariableMappings !== undefined &&
        fingerprint(current.inputVariableMappings) !==
          fingerprint(news.inputVariableMappings);
      const outputChanged =
        news.outputVariableMappings !== undefined &&
        fingerprint(current.outputVariableMappings) !==
          fingerprint(news.outputVariableMappings);
      const mask = fieldMask([
        labelsChanged && "labels",
        annotationsChanged && "annotations",
        defaultReleaseChanged && "defaultRelease",
        flagRevisionsChanged && "defaultFlagRevisions",
        inputChanged && "inputVariableMappings",
        outputChanged && "outputVariableMappings",
      ]);

      if (mask.length > 0) {
        current = yield* saasservicemgmt.patchProjectsLocationsUnitKinds({
          name: current.name ?? name,
          updateMask: mask,
          body: {
            name: current.name ?? name,
            etag: current.etag,
            defaultRelease,
            defaultFlagRevisions: news.defaultFlagRevisions,
            inputVariableMappings: news.inputVariableMappings,
            outputVariableMappings: news.outputVariableMappings,
            labels: desiredLabels,
            annotations,
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* saasservicemgmt
        .deleteProjectsLocationsUnitKinds({ name: output.name })
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
