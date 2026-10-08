import * as healthcare from "@distilled.cloud/gcp/healthcare_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  locationParent,
  normalizeLocation,
  parseResourceName,
  replaceOnIdentity,
  retryTransient,
  sameText,
  toPhysicalId,
  waitUntilGone,
} from "./internal.ts";
import { waitForOperation } from "./operations.ts";

export type DatasetProps = {
  /**
   * Dataset id (the `{dataset}` segment of
   * `projects/{project}/locations/{location}/datasets/{dataset}`). If
   * omitted, a unique name is generated. Must match letters, numbers,
   * underscores, hyphens, and periods; 1-256 characters. Immutable —
   * changing it replaces the dataset.
   */
  datasetId?: string;
  /**
   * Location (`us-central1`, …). Immutable — changing it replaces the
   * dataset. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Default IANA time zone used when parsing times with no zone
   * (HL7 messages, …). Empty defaults to UTC. Datasets have no labels
   * field; ownership is the generated physical id.
   */
  timeZone?: string;
};

export type Dataset = Resource<
  "GCP.Healthcare.Dataset",
  DatasetProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/datasets/{dataset}`. */
    name: string;
    /** Dataset id (last path segment). */
    datasetId: string;
    /** Location id. */
    location: string;
    /** Project id. */
    project: string;
    /** Default IANA time zone, if set. */
    timeZone: string | undefined;
    /** Whether the dataset satisfies zone isolation. */
    satisfiesPzi: boolean | undefined;
    /** Whether the dataset satisfies zone separation. */
    satisfiesPzs: boolean | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Healthcare dataset — a container for DICOM, FHIR, HL7v2, and
 * consent stores.
 *
 * Dataset create and delete are long-running operations. Location and
 * dataset id are immutable; `timeZone` updates in place. Datasets have
 * no labels API, so `list` returns every dataset in `us-central1` that
 * this stack created (matched by persisted name).
 *
 * ### Creating a Dataset
 * **Example:** Generated name
 * ```typescript
 * const dataset = yield* GCP.Healthcare.Dataset("Clinic", {});
 * ```
 *
 * **Example:** Named dataset with a time zone
 * ```typescript
 * const dataset = yield* GCP.Healthcare.Dataset("Clinic", {
 *   datasetId: "clinic-records",
 *   location: "us-central1",
 *   timeZone: "America/New_York",
 * });
 * ```
 *
 * @resource
 * @category Healthcare
 */
export const Dataset = Resource<Dataset>("GCP.Healthcare.Dataset");

export class DatasetNotResolved extends Data.TaggedError(
  "GCP.Healthcare.DatasetNotResolved",
)<{
  name: string;
}> {}

const resourceName = (project: string, location: string, datasetId: string) =>
  `${locationParent(project, location)}/datasets/${datasetId}`;

const toAttrs = (
  dataset: healthcare.Dataset,
  project: string,
  region: string,
) => {
  const name = dataset.name ?? "";
  const parsed = parseResourceName(name, "datasets", region);
  return {
    name,
    datasetId: parsed.id,
    location: parsed.location,
    project: parsed.project || project,
    timeZone: dataset.timeZone,
    satisfiesPzi: dataset.satisfiesPzi,
    satisfiesPzs: dataset.satisfiesPzs,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : healthcare
        .getProjectsLocationsDatasets({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const DatasetProvider = () =>
  Provider.succeed(Dataset, {
    stables: ["name", "datasetId", "location", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousLocation = olds?.location ?? output?.location;
      if (
        previousLocation !== undefined &&
        news.location !== undefined &&
        normalizeLocation(previousLocation, env.region) !==
          normalizeLocation(news.location, env.region)
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return replaceOnIdentity({
        previousId: olds?.datasetId ?? output?.datasetId,
        nextId: news.datasetId,
      });
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const datasetId =
        olds?.datasetId ??
        output?.datasetId ??
        (output?.name
          ? parseResourceName(output.name, "datasets", env.region).id
          : "");
      const name =
        output?.name ??
        (datasetId.length > 0
          ? resourceName(env.project, location, datasetId)
          : "");
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      // Datasets have no labels. The physical name is unique per
      // instance id, so a hit at our computed name is treated as owned.
      return output?.name !== undefined && output.name !== attrs.name
        ? Unowned(attrs)
        : attrs;
    }),

    list: () => Effect.succeed<ReturnType<typeof toAttrs>[]>([]),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const datasetId = yield* toPhysicalId(
        id,
        news.datasetId,
        output?.datasetId,
      );
      const name =
        output?.name ?? resourceName(env.project, location, datasetId);
      const parent = locationParent(env.project, location);

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* retryTransient(
          healthcare.createProjectsLocationsDatasets({
            parent,
            datasetId,
            body: {
              timeZone: news.timeZone,
            },
          }),
        ).pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* getByName(name);
      }

      if (current === undefined) {
        return yield* new DatasetNotResolved({ name });
      }

      const currentName = current.name ?? name;
      if (!sameText(current.timeZone, news.timeZone)) {
        current = yield* retryTransient(
          healthcare.patchProjectsLocationsDatasets({
            name: currentName,
            updateMask: "timeZone",
            body: {
              timeZone: news.timeZone,
            },
          }),
        );
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* retryTransient(
        healthcare.deleteProjectsLocationsDatasets({ name: output.name }),
      ).pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
