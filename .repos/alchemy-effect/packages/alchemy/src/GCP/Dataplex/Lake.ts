import * as dataplex from "@distilled.cloud/gcp/dataplex_v1";
import * as Data from "effect/Data";
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
import { waitForOperation } from "./operations.ts";
import {
  DataplexNotResolved,
  hasAlchemyLabelMap,
  isPendingState,
  listLakes,
  locationParent,
  normalizeLocation,
  parseResourceName,
  replaceIfChanged,
  toPhysicalRfc1035,
  userLabels,
} from "./shared.ts";

export type LakeMetastore = {
  /** Dataproc Metastore service `projects/{project}/locations/{location}/services/{service}`. */
  service?: string;
};

export type LakeProps = {
  /**
   * Lake id (the `{lake}` segment of
   * `projects/{project}/locations/{location}/lakes/{lake}`). If omitted, a
   * unique name is generated from the stack, stage, and logical id. Must
   * contain only lowercase letters, numbers, and hyphens; start with a
   * letter; end with a letter or number; and be 1-63 characters. Immutable
   * — changing it replaces the lake.
   */
  lakeId?: string;
  /**
   * Region (`us-central1`, …). Immutable — changing it replaces the lake.
   * `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * User-friendly display name.
   */
  displayName?: string;
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Optional Dataproc Metastore association.
   */
  metastore?: LakeMetastore;
};

export type Lake = Resource<
  "GCP.Dataplex.Lake",
  LakeProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/lakes/{lake}`. */
    name: string;
    /** Lake id (last path segment). */
    lakeId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** User-friendly display name. */
    displayName: string | undefined;
    /** Description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Lifecycle state (`ACTIVE`, `CREATING`, …). */
    state: string | undefined;
    /** Lake service account. */
    serviceAccount: string | undefined;
    /** Associated Dataproc Metastore service, if any. */
    metastoreService: string | undefined;
    /** Server-assigned uid. */
    uid: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Dataplex lake — a regional container for zones, assets, and tasks.
 *
 * Changing `lakeId` or `location` replaces the lake. Display name,
 * description, labels, and metastore association update in place.
 *
 * ### Creating a Lake
 * **Example:** Generated name
 * ```typescript
 * const lake = yield* GCP.Dataplex.Lake("Warehouse", {
 *   labels: { env: "dev" },
 * });
 * ```
 *
 * **Example:** Named lake with a description
 * ```typescript
 * const lake = yield* GCP.Dataplex.Lake("Warehouse", {
 *   lakeId: "analytics-lake",
 *   location: "us-central1",
 *   displayName: "Analytics",
 *   description: "curated warehouse",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * @resource
 * @category Dataplex
 */
export const Lake = Resource<Lake>("GCP.Dataplex.Lake");

export class LakeNotResolved extends Data.TaggedError(
  "GCP.Dataplex.LakeNotResolved",
)<{
  name: string;
}> {}

export class LakeStillExists extends Data.TaggedError(
  "GCP.Dataplex.LakeStillExists",
)<{
  name: string;
}> {}

const resourceName = (project: string, location: string, lakeId: string) =>
  `${locationParent(project, location)}/lakes/${lakeId}`;

const toAttrs = (lake: dataplex.GoogleCloudDataplexV1Lake, project: string) => {
  const name = lake.name ?? "";
  const parsed = parseResourceName(name, "lakes");
  return {
    name,
    lakeId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    displayName: lake.displayName,
    description: lake.description,
    labels: userLabels(lake.labels),
    state: lake.state,
    serviceAccount: lake.serviceAccount,
    metastoreService: lake.metastore?.service,
    uid: lake.uid,
    createTime: lake.createTime,
    updateTime: lake.updateTime,
  };
};

const getByName = (name: string) =>
  dataplex
    .getProjectsLocationsLakes({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

// Lakes provision a metastore-backed control plane for 2-5 minutes.
const waitUntilReady = (name: string) =>
  Effect.gen(function* () {
    const lake = yield* getByName(name);
    if (lake === undefined) {
      return yield* new LakeNotResolved({ name });
    }
    if (isPendingState(lake.state)) {
      return yield* new DataplexNotResolved({ name });
    }
    return lake;
  }).pipe(
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Dataplex.LakeNotResolved" ||
        error._tag === "GCP.Dataplex.NotResolved" ||
        error._tag === "TooManyRequests",
      times: 36,
      schedule: Schedule.spaced("10 seconds"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((lake) =>
      lake === undefined
        ? Effect.void
        : Effect.fail(new LakeStillExists({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Dataplex.LakeStillExists",
      times: 10,
      schedule: Schedule.spaced("3 seconds"),
    }),
  );

export const LakeProvider = () =>
  Provider.succeed(Lake, {
    stables: ["name", "lakeId", "project", "location", "uid", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousId = olds?.lakeId ?? output?.lakeId;
      const nextId = news.lakeId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      if (
        replaceIfChanged(previousId, nextId) ||
        (output !== undefined && previousLocation !== nextLocation)
      ) {
        return {
          action: "replace" as const,
          deleteFirst:
            previousLocation === nextLocation &&
            previousId !== undefined &&
            nextId === previousId,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const lakeId = yield* toPhysicalRfc1035(id, olds?.lakeId, output?.lakeId);
      const name = output?.name ?? resourceName(env.project, location, lakeId);
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
        const lakes = yield* listLakes(env.project, env.region);
        return lakes
          .filter((lake) => hasAlchemyLabelMap(lake.labels))
          .map((lake) => toAttrs(lake, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const lakeId = yield* toPhysicalRfc1035(id, news.lakeId, output?.lakeId);
      const name = output?.name ?? resourceName(env.project, location, lakeId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const desiredMetastore = news.metastore?.service;

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* dataplex
          .createProjectsLocationsLakes({
            parent: locationParent(env.project, location),
            lakeId,
            body: {
              displayName: news.displayName,
              description: news.description,
              labels: desiredLabels,
              metastore: desiredMetastore
                ? { service: desiredMetastore }
                : undefined,
            },
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "TooManyRequests",
              times: 8,
              schedule: Schedule.spaced("2 seconds"),
            }),
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilReady(name);
      }

      if (current === undefined) {
        return yield* new LakeNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const displayNameChanged =
        (current.displayName ?? "") !== (news.displayName ?? "");
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      const metastoreChanged =
        (current.metastore?.service ?? "") !== (desiredMetastore ?? "");

      if (
        labelsChanged ||
        displayNameChanged ||
        descriptionChanged ||
        metastoreChanged
      ) {
        const updateMask = [
          labelsChanged ? "labels" : undefined,
          displayNameChanged ? "display_name" : undefined,
          descriptionChanged ? "description" : undefined,
          metastoreChanged ? "metastore.service" : undefined,
        ].filter((field): field is string => field !== undefined);
        const operation = yield* dataplex.patchProjectsLocationsLakes({
          name: current.name ?? name,
          updateMask: updateMask.join(","),
          body: {
            displayName: news.displayName,
            description: news.description,
            labels: desiredLabels,
            metastore: desiredMetastore
              ? { service: desiredMetastore }
              : undefined,
          },
        });
        yield* waitForOperation(operation);
        current = yield* waitUntilReady(current.name ?? name);
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      const operation = yield* dataplex
        .deleteProjectsLocationsLakes({ name: output.name })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(output.name);
    }),
  });
