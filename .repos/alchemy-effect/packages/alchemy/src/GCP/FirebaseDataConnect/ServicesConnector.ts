import * as firebasedataconnect from "@distilled.cloud/gcp/firebasedataconnect_v1";
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
  expandParent,
  fieldMask,
  fingerprint,
  listAtNested,
  listLabeledPages,
  MAX_CONNECTOR_ID_LENGTH,
  normalizeLocation,
  parseName,
  replaceOnIdentity,
  ResourceNotResolved,
  retryStaleEtag,
  sameText,
  stringMap,
  toPhysicalId,
  userLabels,
  waitForDeleteOperation,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
  waitUntilReady,
} from "./internal.ts";
import type { Source } from "./ServicesSchema.ts";

export type ClientCache = {
  /**
   * When true, connector source is validated for client-side caching
   * (stricter aliases, etc.).
   */
  strictValidationEnabled?: boolean;
  /**
   * When true, responses include entityIds in GraphQL extensions for
   * normalized client caching. Only enable when primary keys are not
   * sensitive.
   */
  entityIdIncluded?: boolean;
};

export type ServicesConnectorProps = {
  /**
   * Parent Data Connect service. Full name
   * `projects/{project}/locations/{location}/services/{service}` or the
   * service id (combined with `location`). Immutable — changing it
   * replaces the connector. The service must already have an active
   * schema compatible with `source`.
   */
  service: string;
  /**
   * Region used when `service` is a bare id.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Connector id (the `{connector}` segment). If omitted, a unique
   * RFC1035 name is generated from the stack, stage, and logical id.
   * Immutable — changing it replaces the connector.
   */
  connectorId?: string;
  /**
   * GraphQL operations (queries and mutations) that make up the
   * connector. Must be compatible with the active schema.
   */
  source: Source;
  /**
   * Client-side cache settings.
   */
  clientCache?: ClientCache;
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

export type ServicesConnector = Resource<
  "GCP.FirebaseDataConnect.ServicesConnector",
  ServicesConnectorProps,
  {
    /** Full resource name. */
    name: string;
    /** Connector id (last path segment). */
    connectorId: string;
    /** Parent service name. */
    service: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** GraphQL operation source files. */
    source: Source | undefined;
    /** Client-side cache settings. */
    clientCache: ClientCache | undefined;
    /** Human-readable name. */
    displayName: string | undefined;
    /** True while Data Connect is compiling or deploying the connector. */
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
 * A Firebase Data Connect connector — a set of GraphQL queries and
 * mutations compiled against the service's active schema.
 *
 * Changing `connectorId`, `service`, or `location` replaces the
 * connector. Source, client cache, display name, labels, and
 * annotations update in place. Create fails if the service has no
 * schema or the operations are incompatible with it.
 *
 * ### Creating a Connector
 * **Example:** Public query
 * ```typescript
 * const schema = yield* GCP.FirebaseDataConnect.ServicesSchema("Main", {
 *   service: service.name,
 *   source: {
 *     files: [{
 *       path: "schema.gql",
 *       content: "type Note @table { title: String! }",
 *     }],
 *   },
 *   datasources: [{ postgresql: { unlinked: true } }],
 * });
 * const connector = yield* GCP.FirebaseDataConnect.ServicesConnector(
 *   "Queries",
 *   {
 *     service: schema.service,
 *     source: {
 *       files: [{
 *         path: "queries.gql",
 *         content:
 *           "query ListNotes @auth(level: PUBLIC) { notes { id title } }",
 *       }],
 *     },
 *     labels: { env: "test" },
 *   },
 * );
 * ```
 *
 * ### Updating a Connector
 * **Example:** Display name and labels
 * ```typescript
 * const connector = yield* GCP.FirebaseDataConnect.ServicesConnector(
 *   "Queries",
 *   {
 *     service: schema.service,
 *     source: {
 *       files: [{
 *         path: "queries.gql",
 *         content:
 *           "query ListNotes @auth(level: PUBLIC) { notes { id title } }",
 *       }],
 *     },
 *     displayName: "notes queries v2",
 *     labels: { env: "prod" },
 *   },
 * );
 * ```
 *
 * @resource
 * @category FirebaseDataConnect
 */
export const ServicesConnector = Resource<ServicesConnector>(
  "GCP.FirebaseDataConnect.ServicesConnector",
);

const resourceName = (service: string, connectorId: string) =>
  `${service}/connectors/${connectorId}`;

const toFile = (value: firebasedataconnect.File) => ({
  content: value.content,
  path: value.path,
});

const toSource = (
  value: firebasedataconnect.Source | undefined,
): Source | undefined =>
  value === undefined ? undefined : { files: value.files?.map(toFile) };

const toClientCache = (
  value: firebasedataconnect.ClientCache | undefined,
): ClientCache | undefined =>
  value === undefined
    ? undefined
    : {
        strictValidationEnabled: value.strictValidationEnabled,
        entityIdIncluded: value.entityIdIncluded,
      };

const toAttrs = (
  item: firebasedataconnect.Connector,
  project: string,
  region: string,
): ServicesConnector["Attributes"] => {
  const name = item.name ?? "";
  const parsed = parseName(name, "connectors", region);
  return {
    name,
    connectorId: parsed.id,
    service: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    source: toSource(item.source),
    clientCache: toClientCache(item.clientCache),
    displayName: item.displayName,
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
  firebasedataconnect
    .getProjectsLocationsServicesConnectors({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string) =>
  listAtNested(project, "services/-", (parent) =>
    listLabeledPages(
      firebasedataconnect.listProjectsLocationsServicesConnectors.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.connectors,
      (item) => item.labels,
    ),
  );

export const ServicesConnectorProvider = () =>
  Provider.succeed(ServicesConnector, {
    stables: [
      "name",
      "connectorId",
      "service",
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
        (olds?.service ?? output?.service)
          ? expandParent(
              olds?.service ?? output?.service ?? "",
              env.project,
              previousLocation,
              "services",
            )
          : undefined;
      const nextParent = expandParent(
        news.service,
        env.project,
        location,
        "services",
      );
      return replaceOnIdentity({
        previousId: olds?.connectorId ?? output?.connectorId,
        nextId: news.connectorId ?? olds?.connectorId ?? output?.connectorId,
        previousLocation,
        nextLocation: location,
        previousParent,
        nextParent,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const connectorId = yield* toPhysicalId(
        id,
        olds?.connectorId,
        output?.connectorId,
        "connector",
        MAX_CONNECTOR_ID_LENGTH,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const service =
        output?.service ??
        (olds?.service
          ? expandParent(olds.service, env.project, location, "services")
          : undefined);
      const name =
        output?.name ??
        (service ? resourceName(service, connectorId) : undefined);
      if (name === undefined) return undefined;
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
        const items = yield* listOwned(env.project);
        return items.map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const connectorId = yield* toPhysicalId(
        id,
        news.connectorId,
        output?.connectorId,
        "connector",
        MAX_CONNECTOR_ID_LENGTH,
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const service = expandParent(
        news.service,
        env.project,
        location,
        "services",
      );
      const name = resourceName(service, connectorId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const desiredAnnotations = news.annotations ?? {};
      const body: firebasedataconnect.Connector = {
        source: news.source,
        clientCache: news.clientCache,
        displayName: news.displayName,
        annotations: desiredAnnotations,
        labels: desiredLabels,
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* firebasedataconnect
          .createProjectsLocationsServicesConnectors({
            parent: service,
            connectorId,
            body,
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

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const mask = fieldMask([
        (upsert.length > 0 || removed.length > 0) && "labels",
        fingerprint(stringMap(current.annotations)) !==
          fingerprint(desiredAnnotations) && "annotations",
        !sameText(current.displayName, news.displayName) && "displayName",
        fingerprint(toSource(current.source)) !== fingerprint(news.source) &&
          "source",
        fingerprint(toClientCache(current.clientCache)) !==
          fingerprint(news.clientCache) && "clientCache",
      ]);

      if (mask.length > 0) {
        const patchName = current.name ?? name;
        yield* retryStaleEtag(
          firebasedataconnect
            .patchProjectsLocationsServicesConnectors({
              name: patchName,
              updateMask: mask,
              body,
            })
            .pipe(Effect.flatMap((operation) => waitForOperation(operation))),
        );
        current = yield* waitUntilExists(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      current = yield* waitUntilReady(
        getByName(current.name ?? name),
        current.name ?? name,
      );
      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* firebasedataconnect
        .deleteProjectsLocationsServicesConnectors({
          name: output.name,
          force: true,
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
