import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { listLocations } from "./names.ts";
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
  fingerprint,
  hasAlchemyLabelMap,
  lastSegment,
  normalizeLocation,
  parseResourceName,
  specifiedEquals,
  toPhysicalRfc1035,
  userLabels,
} from "./helpers.ts";
import type { EncryptionSpec } from "./shared.ts";

const MAX_NAME_LENGTH = 63;

export type ClientConnectionConfig = {
  /** Online prediction request timeout (e.g. `"5s"`). */
  inferenceTimeout?: string;
};

export type PredictRequestResponseLoggingConfig = {
  /** Enable request/response logging. */
  enabled?: boolean;
  /** Sampling rate in `(0, 1]`. */
  samplingRate?: number;
  /** BigQuery destination for logs. */
  bigqueryDestination?: { outputUri?: string };
};

export type PrivateServiceConnectConfig = {
  /** Expose the endpoint via Private Service Connect. */
  enablePrivateServiceConnect?: boolean;
  /** Projects allowed to create forwarding rules. */
  projectAllowlist?: string[];
};

export type GenAiAdvancedFeaturesConfig = {
  /** Enable native RAG on GenAI endpoints. */
  ragConfig?: { enableRag?: boolean };
};

export type GdcConfig = {
  /** Google Distributed Cloud zone for this endpoint. Immutable. */
  zone?: string;
};

export type EndpointProps = {
  /**
   * Endpoint id (the `{endpoint}` segment of
   * `projects/{project}/locations/{location}/endpoints/{endpoint}`).
   * If omitted, a unique name is generated. Immutable — changing it
   * replaces the endpoint.
   */
  endpointId?: string;
  /**
   * Region (`us-central1`, `us-east1`, …). Immutable — changing it
   * replaces the endpoint.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Display name. Defaults to the endpoint id when omitted.
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
   * VPC network to peer
   * (`projects/{project}/global/networks/{network}`). Immutable.
   */
  network?: string;
  /**
   * Customer-managed encryption. Immutable — changing it replaces the
   * endpoint.
   */
  encryptionSpec?: EncryptionSpec;
  /**
   * Serve this endpoint through a dedicated DNS.
   * @default false
   */
  dedicatedEndpointEnabled?: boolean;
  /**
   * Traffic split from deployed-model id to percentage. Values must sum
   * to 100, or the map must be empty.
   */
  trafficSplit?: Record<string, number>;
  /**
   * Online-prediction client settings (inference timeout).
   */
  clientConnectionConfig?: ClientConnectionConfig;
  /**
   * Request/response logging for online prediction.
   */
  predictRequestResponseLoggingConfig?: PredictRequestResponseLoggingConfig;
  /**
   * Private Service Connect. Mutually exclusive with `network`.
   */
  privateServiceConnectConfig?: PrivateServiceConnectConfig;
  /**
   * Deprecated PSC flag. Prefer `privateServiceConnectConfig`. Immutable.
   */
  enablePrivateServiceConnect?: boolean;
  /**
   * GenAI advanced features (native RAG).
   */
  genAiAdvancedFeaturesConfig?: GenAiAdvancedFeaturesConfig;
  /**
   * Google Distributed Cloud zone. Immutable.
   */
  gdcConfig?: GdcConfig;
};

export type Endpoint = Resource<
  "GCP.AIPlatform.Endpoint",
  EndpointProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/endpoints/{endpoint}`. */
    name: string;
    /** Endpoint id (last path segment). */
    endpointId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Display name. */
    displayName: string | undefined;
    /** Description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Peered VPC network, if any. */
    network: string | undefined;
    /** Customer-managed encryption key, if any. */
    encryptionSpec: EncryptionSpec | undefined;
    /** Whether a dedicated DNS is enabled. */
    dedicatedEndpointEnabled: boolean;
    /** Dedicated endpoint DNS, if provisioned. */
    dedicatedEndpointDns: string | undefined;
    /** Traffic split map. */
    trafficSplit: Record<string, number>;
    /** Client connection config. */
    clientConnectionConfig: ClientConnectionConfig | undefined;
    /** Request/response logging config. */
    predictRequestResponseLoggingConfig:
      | PredictRequestResponseLoggingConfig
      | undefined;
    /** Private Service Connect config. */
    privateServiceConnectConfig: PrivateServiceConnectConfig | undefined;
    /** Deprecated PSC flag. */
    enablePrivateServiceConnect: boolean;
    /** GenAI advanced features. */
    genAiAdvancedFeaturesConfig: GenAiAdvancedFeaturesConfig | undefined;
    /** GDC config. */
    gdcConfig: GdcConfig | undefined;
    /** Deployed model ids. */
    deployedModelIds: string[];
    /** Associated model-deployment monitoring job, if any. */
    modelDeploymentMonitoringJob: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
    /** Server etag. */
    etag: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Vertex AI Endpoint for online prediction.
 *
 * Name, location, network, encryption, and GDC zone are identity —
 * changing them replaces the endpoint. Display name, description, labels,
 * traffic split, dedicated-endpoint flag, client connection, logging, and
 * GenAI features update in place.
 *
 * ### Creating an Endpoint
 * **Example:** Generated name
 * ```typescript
 * const endpoint = yield* GCP.AIPlatform.Endpoint("Predictor", {});
 * ```
 *
 * **Example:** Named endpoint with labels
 * ```typescript
 * const endpoint = yield* GCP.AIPlatform.Endpoint("Predictor", {
 *   endpointId: "orders-predictor",
 *   displayName: "orders",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating an Endpoint
 * **Example:** Change display name and labels
 * ```typescript
 * // Same logical id, changed props: the engine updates it in place.
 * const endpoint = yield* GCP.AIPlatform.Endpoint("Predictor", {
 *   displayName: "orders-v2",
 *   labels: { env: "prod", role: "predict" },
 * });
 * ```
 *
 * @resource
 * @category AIPlatform
 */
export const Endpoint = Resource<Endpoint>("GCP.AIPlatform.Endpoint");

export class EndpointNotResolved extends Data.TaggedError(
  "GCP.AIPlatform.EndpointNotResolved",
)<{
  name: string;
}> {}

export class EndpointStillExists extends Data.TaggedError(
  "GCP.AIPlatform.EndpointStillExists",
)<{
  name: string;
}> {}

const resourceName = (project: string, location: string, endpointId: string) =>
  `projects/${project}/locations/${location}/endpoints/${endpointId}`;

const trafficSplitOf = (
  split: Record<string, number | undefined> | null | undefined,
): Record<string, number> =>
  Object.fromEntries(
    Object.entries(split ?? {}).flatMap(([key, value]) =>
      typeof value === "number" ? [[key, value] as const] : [],
    ),
  );

const toEncryption = (
  spec:
    | aiplatform.GoogleCloudAiplatformV1EncryptionSpec
    | EncryptionSpec
    | undefined,
): EncryptionSpec | undefined => {
  const kmsKeyName = spec?.kmsKeyName;
  if (kmsKeyName === undefined || kmsKeyName.length === 0) return undefined;
  return { kmsKeyName };
};

const toClientConnection = (
  config:
    | aiplatform.GoogleCloudAiplatformV1ClientConnectionConfig
    | ClientConnectionConfig
    | undefined,
): ClientConnectionConfig | undefined => {
  if (config?.inferenceTimeout === undefined) return undefined;
  return { inferenceTimeout: config.inferenceTimeout };
};

const toLogging = (
  config:
    | aiplatform.GoogleCloudAiplatformV1PredictRequestResponseLoggingConfig
    | PredictRequestResponseLoggingConfig
    | undefined,
): PredictRequestResponseLoggingConfig | undefined => {
  if (config === undefined) return undefined;
  return {
    enabled: config.enabled,
    samplingRate: config.samplingRate,
    bigqueryDestination: config.bigqueryDestination
      ? { outputUri: config.bigqueryDestination.outputUri }
      : undefined,
  };
};

const toPsc = (
  config:
    | aiplatform.GoogleCloudAiplatformV1PrivateServiceConnectConfig
    | PrivateServiceConnectConfig
    | undefined,
): PrivateServiceConnectConfig | undefined => {
  if (config === undefined) return undefined;
  return {
    enablePrivateServiceConnect: config.enablePrivateServiceConnect === true,
    projectAllowlist: config.projectAllowlist,
  };
};

const toGenAi = (
  config:
    | aiplatform.GoogleCloudAiplatformV1GenAiAdvancedFeaturesConfig
    | GenAiAdvancedFeaturesConfig
    | undefined,
): GenAiAdvancedFeaturesConfig | undefined => {
  if (config === undefined) return undefined;
  return {
    ragConfig:
      config.ragConfig === undefined
        ? undefined
        : { enableRag: config.ragConfig.enableRag === true },
  };
};

const toGdc = (
  config: aiplatform.GoogleCloudAiplatformV1GdcConfig | GdcConfig | undefined,
): GdcConfig | undefined => {
  const zone = config?.zone;
  if (zone === undefined || zone.length === 0) return undefined;
  return { zone };
};

const toAttrs = (
  endpoint: aiplatform.GoogleCloudAiplatformV1Endpoint,
  project: string,
) => {
  const name = endpoint.name ?? "";
  const parsed = parseResourceName(name, "endpoints");
  return {
    name,
    endpointId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    displayName: endpoint.displayName,
    description: endpoint.description,
    labels: userLabels(endpoint.labels),
    network: endpoint.network,
    encryptionSpec: toEncryption(endpoint.encryptionSpec),
    dedicatedEndpointEnabled: endpoint.dedicatedEndpointEnabled === true,
    dedicatedEndpointDns: endpoint.dedicatedEndpointDns,
    trafficSplit: trafficSplitOf(endpoint.trafficSplit),
    clientConnectionConfig: toClientConnection(endpoint.clientConnectionConfig),
    predictRequestResponseLoggingConfig: toLogging(
      endpoint.predictRequestResponseLoggingConfig,
    ),
    privateServiceConnectConfig: toPsc(endpoint.privateServiceConnectConfig),
    enablePrivateServiceConnect: endpoint.enablePrivateServiceConnect === true,
    genAiAdvancedFeaturesConfig: toGenAi(endpoint.genAiAdvancedFeaturesConfig),
    gdcConfig: toGdc(endpoint.gdcConfig),
    deployedModelIds: (endpoint.deployedModels ?? []).flatMap((model) =>
      model.id ? [model.id] : [],
    ),
    modelDeploymentMonitoringJob: endpoint.modelDeploymentMonitoringJob,
    createTime: endpoint.createTime,
    updateTime: endpoint.updateTime,
    etag: endpoint.etag,
  };
};

const getByName = (name: string) =>
  aiplatform
    .getProjectsLocationsEndpoints({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((endpoint) =>
      endpoint
        ? Effect.succeed(endpoint)
        : Effect.fail(new EndpointNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.AIPlatform.EndpointNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((endpoint) =>
      endpoint === undefined
        ? Effect.void
        : Effect.fail(new EndpointStillExists({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.AIPlatform.EndpointStillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const toCreateBody = (
  news: EndpointProps,
  endpointId: string,
  desiredLabels: Record<string, string>,
): aiplatform.GoogleCloudAiplatformV1Endpoint => ({
  displayName: news.displayName ?? endpointId,
  description: news.description,
  labels: desiredLabels,
  network: news.network,
  encryptionSpec: news.encryptionSpec,
  dedicatedEndpointEnabled:
    news.dedicatedEndpointEnabled === true ? true : undefined,
  trafficSplit: news.trafficSplit,
  clientConnectionConfig: news.clientConnectionConfig,
  predictRequestResponseLoggingConfig: news.predictRequestResponseLoggingConfig,
  privateServiceConnectConfig: news.privateServiceConnectConfig,
  enablePrivateServiceConnect:
    news.enablePrivateServiceConnect === true ? true : undefined,
  genAiAdvancedFeaturesConfig: news.genAiAdvancedFeaturesConfig,
  gdcConfig: news.gdcConfig,
});

export const EndpointProvider = () =>
  Provider.succeed(Endpoint, {
    stables: ["name", "endpointId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      const env = yield* GcpEnvironment.current;
      if (!isResolved(news)) return undefined;
      const previousId = olds?.endpointId ?? output?.endpointId;
      const nextId = news.endpointId
        ? lastSegment(news.endpointId)
        : previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const previousNetwork = olds?.network ?? output?.network ?? "";
      const nextNetwork = news.network ?? previousNetwork;
      const previousKey =
        olds?.encryptionSpec?.kmsKeyName ??
        output?.encryptionSpec?.kmsKeyName ??
        "";
      const nextKey = news.encryptionSpec?.kmsKeyName ?? previousKey;
      const previousGdc =
        olds?.gdcConfig?.zone ?? output?.gdcConfig?.zone ?? "";
      const nextGdc = news.gdcConfig?.zone ?? previousGdc;
      const previousPsc =
        olds?.enablePrivateServiceConnect ??
        output?.enablePrivateServiceConnect ??
        false;
      const nextPsc = news.enablePrivateServiceConnect ?? previousPsc;
      const replace =
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation ||
        previousNetwork !== nextNetwork ||
        previousKey !== nextKey ||
        previousGdc !== nextGdc ||
        previousPsc !== nextPsc;
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
      const endpointId = yield* toPhysicalRfc1035(
        id,
        olds?.endpointId,
        output?.endpointId,
        MAX_NAME_LENGTH,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, endpointId);
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
        return yield* Stream.fromIterable(listLocations(env.region))
          .pipe(
            Stream.flatMap((location) =>
              aiplatform.listProjectsLocationsEndpoints.pages({
                parent: `projects/${env.project}/locations/${location}`,
                pageSize: 100,
              }),
            ),
          )
          .pipe(
            Stream.flatMap((page) => Stream.fromIterable(page.endpoints ?? [])),
            Stream.filter((endpoint) => hasAlchemyLabelMap(endpoint.labels)),
            Stream.map((endpoint) => toAttrs(endpoint, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () => Effect.succeed([])),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const endpointId = yield* toPhysicalRfc1035(
        id,
        news.endpointId,
        output?.endpointId,
        MAX_NAME_LENGTH,
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, endpointId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const displayName = news.displayName ?? endpointId;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* aiplatform
          .createProjectsLocationsEndpoints({
            parent: `projects/${env.project}/locations/${location}`,
            endpointId,
            body: toCreateBody(news, endpointId, desiredLabels),
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(name);
      }

      if (current === undefined) {
        return yield* new EndpointNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const displayNameChanged = (current.displayName ?? "") !== displayName;
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      const dedicatedChanged =
        (current.dedicatedEndpointEnabled === true) !==
        (news.dedicatedEndpointEnabled === true);
      const trafficChanged =
        news.trafficSplit !== undefined &&
        fingerprint(trafficSplitOf(current.trafficSplit)) !==
          fingerprint(news.trafficSplit);
      const clientChanged =
        news.clientConnectionConfig !== undefined &&
        !specifiedEquals(
          news.clientConnectionConfig,
          toClientConnection(current.clientConnectionConfig),
        );
      const loggingChanged =
        news.predictRequestResponseLoggingConfig !== undefined &&
        !specifiedEquals(
          news.predictRequestResponseLoggingConfig,
          toLogging(current.predictRequestResponseLoggingConfig),
        );
      const pscChanged =
        news.privateServiceConnectConfig !== undefined &&
        !specifiedEquals(
          news.privateServiceConnectConfig,
          toPsc(current.privateServiceConnectConfig),
        );
      const genAiChanged =
        news.genAiAdvancedFeaturesConfig !== undefined &&
        !specifiedEquals(
          news.genAiAdvancedFeaturesConfig,
          toGenAi(current.genAiAdvancedFeaturesConfig),
        );

      if (
        labelsChanged ||
        displayNameChanged ||
        descriptionChanged ||
        dedicatedChanged ||
        trafficChanged ||
        clientChanged ||
        loggingChanged ||
        pscChanged ||
        genAiChanged
      ) {
        const updateMask = [
          labelsChanged ? "labels" : undefined,
          displayNameChanged ? "display_name" : undefined,
          descriptionChanged ? "description" : undefined,
          dedicatedChanged ? "dedicated_endpoint_enabled" : undefined,
          trafficChanged ? "traffic_split" : undefined,
          clientChanged ? "client_connection_config" : undefined,
          loggingChanged
            ? "predict_request_response_logging_config"
            : undefined,
          pscChanged ? "private_service_connect_config" : undefined,
          genAiChanged ? "gen_ai_advanced_features_config" : undefined,
        ].filter((field): field is string => field !== undefined);

        current = yield* aiplatform
          .patchProjectsLocationsEndpoints({
            name,
            updateMask: updateMask.join(","),
            body: {
              name,
              labels: desiredLabels,
              displayName,
              description: news.description,
              dedicatedEndpointEnabled: news.dedicatedEndpointEnabled === true,
              trafficSplit: news.trafficSplit,
              clientConnectionConfig: news.clientConnectionConfig,
              predictRequestResponseLoggingConfig:
                news.predictRequestResponseLoggingConfig,
              privateServiceConnectConfig: news.privateServiceConnectConfig,
              genAiAdvancedFeaturesConfig: news.genAiAdvancedFeaturesConfig,
            },
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              times: 8,
              schedule: Schedule.spaced("5 seconds"),
            }),
          );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* aiplatform
        .deleteProjectsLocationsEndpoints({ name: output.name })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("5 seconds"),
          }),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(output.name);
    }),
  });
