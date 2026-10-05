import * as metastore from "@distilled.cloud/gcp/metastore_v1";
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
  DEFAULT_HIVE_VERSION,
  fieldMask,
  fingerprint,
  listAtLocation,
  listLabeledPages,
  locationParent,
  normalizeLocation,
  parseName,
  replaceOnIdentity,
  ResourceNotResolved,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
  waitUntilReady,
} from "./internal.ts";

export type BackendMetastore = {
  /**
   * Relative resource name of the backend. BigQuery uses
   * `projects/{project}`. Dataproc Metastore uses
   * `projects/{project}/locations/{location}/services/{service}`.
   */
  name: string;
  /**
   * Backend type (`BIGQUERY` or `DATAPROC_METASTORE`).
   */
  metastoreType?: metastore.BackendMetastoreMetastoreTypeEnum | (string & {});
};

export type FederationProps = {
  /**
   * Federation id (the `{federation}` segment of
   * `projects/{project}/locations/{location}/federations/{federation}`).
   * If omitted, a unique RFC1035 name is generated. Must be 2-63
   * characters, start with a letter, and end with a letter or number.
   * Immutable — changing it replaces the federation.
   */
  federationId?: string;
  /**
   * Region (`us-central1`, …). Immutable — changing it replaces the
   * federation. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Apache Hive metastore version of the federation. All backends must
   * be compatible. Immutable — changing it replaces the federation.
   * @default "3.1.2"
   */
  version?: string;
  /**
   * Ranked backends used to resolve database names at query time. Keys
   * are ranks (`0`, `1`, …); lower ranks are evaluated first. When
   * omitted, a BigQuery backend for the current project is used.
   */
  backendMetastores?: Record<string, BackendMetastore>;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type Federation = Resource<
  "GCP.Metastore.Federation",
  FederationProps,
  {
    /** Full resource name. */
    name: string;
    /** Federation id (last path segment). */
    federationId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Hive metastore version. */
    version: string | undefined;
    /** Ranked backend metastores. */
    backendMetastores: Record<string, BackendMetastore>;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Federation endpoint URI. */
    endpointUri: string | undefined;
    /** Server-reported state. */
    state: string | undefined;
    /** Extra status text, if any. */
    stateMessage: string | undefined;
    /** Server-generated resource uid. */
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
 * A Dataproc Metastore federation that serves metadata from ranked
 * BigQuery and Dataproc Metastore backends.
 *
 * Changing `federationId`, `location`, or `version` replaces the
 * federation. Labels and `backendMetastores` update in place.
 *
 * ### Creating a Federation
 * **Example:** BigQuery backend
 * ```typescript
 * const federation = yield* GCP.Metastore.Federation("Lakehouse", {
 *   version: "3.1.2",
 *   backendMetastores: {
 *     "1": {
 *       name: "projects/my-project",
 *       metastoreType: "BIGQUERY",
 *     },
 *   },
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * **Example:** Generated name
 * ```typescript
 * const federation = yield* GCP.Metastore.Federation("Lakehouse", {
 *   labels: { env: "test" },
 * });
 * ```
 *
 * ### Updating a Federation
 * **Example:** Labels and backends
 * ```typescript
 * // Same logical id, changed props: the engine updates it in place.
 * const federation = yield* GCP.Metastore.Federation("Lakehouse", {
 *   version: "3.1.2",
 *   backendMetastores: {
 *     "1": {
 *       name: "projects/my-project",
 *       metastoreType: "BIGQUERY",
 *     },
 *   },
 *   labels: { env: "prod", team: "data" },
 * });
 * ```
 *
 * @resource
 * @category Metastore
 */
export const Federation = Resource<Federation>("GCP.Metastore.Federation");

const resourceName = (
  project: string,
  location: string,
  federationId: string,
) => `${locationParent(project, location)}/federations/${federationId}`;

const toBackends = (
  value: Record<string, metastore.BackendMetastore | undefined> | undefined,
): Record<string, BackendMetastore> => {
  const next: Record<string, BackendMetastore> = {};
  for (const [rank, item] of Object.entries(value ?? {})) {
    if (item === undefined) continue;
    next[rank] = {
      name: item.name ?? "",
      metastoreType: item.metastoreType,
    };
  }
  return next;
};

const desiredBackends = (
  project: string,
  value: Record<string, BackendMetastore> | undefined,
): Record<string, BackendMetastore> => {
  if (value !== undefined) return toBackends(value);
  return {
    "1": {
      name: `projects/${project}`,
      metastoreType: "BIGQUERY",
    },
  };
};

const toAttrs = (
  item: metastore.Federation,
  project: string,
  region: string,
) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "federations", region);
  return {
    name,
    federationId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    version: item.version,
    backendMetastores: toBackends(item.backendMetastores),
    labels: userLabels(item.labels),
    endpointUri: item.endpointUri,
    state: item.state,
    stateMessage: item.stateMessage,
    uid: item.uid,
    createTime: item.createTime,
    updateTime: item.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : metastore
        .getProjectsLocationsFederations({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string, region: string) =>
  listAtLocation(project, (parent) =>
    listLabeledPages(
      metastore.listProjectsLocationsFederations.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.federations,
      (item) => item.labels,
    ),
  );

export const FederationProvider = () =>
  Provider.succeed(Federation, {
    stables: [
      "name",
      "federationId",
      "project",
      "location",
      "version",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousVersion = olds?.version ?? output?.version;
      const nextVersion =
        news.version ??
        olds?.version ??
        output?.version ??
        DEFAULT_HIVE_VERSION;
      return replaceOnIdentity({
        previousId: olds?.federationId ?? output?.federationId,
        nextId: news.federationId ?? olds?.federationId ?? output?.federationId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        extra: previousVersion !== undefined && nextVersion !== previousVersion,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const federationId = yield* toPhysicalId(
        id,
        olds?.federationId,
        output?.federationId,
        "federation",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, federationId);
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
        const items = yield* listOwned(env.project, env.region);
        return items.map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const federationId = yield* toPhysicalId(
        id,
        news.federationId,
        output?.federationId,
        "federation",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, federationId);
      const version = news.version ?? output?.version ?? DEFAULT_HIVE_VERSION;
      const backends = desiredBackends(env.project, news.backendMetastores);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* metastore
          .createProjectsLocationsFederations({
            parent: locationParent(env.project, location),
            federationId,
            body: {
              version,
              backendMetastores: backends,
              labels: desiredLabels,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          // ALREADY_EXISTS (6): a concurrent create won the race.
          yield* waitForOperation(created).pipe(
            Effect.catchTag("GCP.OperationFailed", (error) =>
              error.code === 6 ? Effect.void : Effect.fail(error),
            ),
          );
        }
        current = yield* waitUntilExists(getByName(name), name);
        current = yield* waitUntilReady(
          getByName(name),
          name,
          (item) => item.state,
          (item) => item.stateMessage,
        );
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const backendsChanged =
        fingerprint(toBackends(current.backendMetastores)) !==
        fingerprint(backends);
      const mask = fieldMask([
        labelsChanged && "labels",
        backendsChanged && "backendMetastores",
      ]);

      if (mask.length > 0) {
        const operation = yield* metastore.patchProjectsLocationsFederations({
          name: current.name ?? name,
          updateMask: mask,
          body: {
            labels: desiredLabels,
            backendMetastores: backends,
          },
        });
        yield* waitForOperation(operation);
        current = yield* waitUntilReady(
          getByName(current.name ?? name),
          current.name ?? name,
          (item) => item.state,
          (item) => item.stateMessage,
        );
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* metastore
        .deleteProjectsLocationsFederations({ name: output.name })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        // NOT_FOUND (5): already gone.
        yield* waitForOperation(operation).pipe(
          Effect.catchTag("GCP.OperationFailed", (error) =>
            error.code === 5 ? Effect.void : Effect.fail(error),
          ),
        );
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
