import * as eventarc from "@distilled.cloud/gcp/eventarc_v1";
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
  type LoggingConfig,
  changedFields,
  compact,
  cryptoKeyKey,
  collectPages,
  expandResource,
  expandTopic,
  hasAlchemyLabelKeys,
  loggingKey,
  normalizeLocation,
  parentOf,
  parseName,
  resourceName,
  rfc1035,
  sameJson,
  textKey,
  toLoggingConfig,
  toPhysicalId,
  userAnnotations,
  userLabels,
  retryOnTransient,
  waitForOperation,
  waitUntilGone,
  waitUntilPresent,
} from "./internal.ts";

const COLLECTION = "pipelines";

export type PipelinePayloadSchema = {
  /** Entire schema definition stored inline. */
  schemaDefinition?: string;
};

export type PipelinePayloadFormat = {
  /** Protobuf payload format. */
  protobuf?: PipelinePayloadSchema;
  /** Avro payload format. */
  avro?: PipelinePayloadSchema;
  /** JSON payload format. An empty object selects JSON. */
  json?: Record<string, never>;
};

export type PipelineTransformation = {
  /**
   * CEL expression template applied to transform messages.
   */
  transformationTemplate?: string;
};

export type PipelineMediation = {
  /**
   * How the pipeline transforms messages. Currently the only mediation.
   */
  transformation?: PipelineTransformation;
};

export type PipelineRetryPolicy = {
  /**
   * Maximum delivery attempts (1-100). Default 5.
   */
  maxAttempts?: number;
  /**
   * Minimum wait between retries, as a duration string (e.g. `"5s"`).
   * 1-600 seconds. Default `"5s"`.
   */
  minRetryDelay?: string;
  /**
   * Maximum wait between retries, as a duration string (e.g. `"60s"`).
   * 1-600 seconds. Default `"60s"`.
   */
  maxRetryDelay?: string;
};

export type PipelineDestinationNetworkConfig = {
  /**
   * Network attachment granting the pipeline access to the consumer
   * VPC, as
   * `projects/{project}/regions/{region}/networkAttachments/{name}`.
   */
  networkAttachment?: string;
};

export type PipelineDestinationHttpEndpoint = {
  /**
   * HTTPS URI of the HTTP endpoint (`https://svc.example.com/route`).
   */
  uri: string;
  /**
   * CEL expression that rewrites the destination-bound HTTP request.
   */
  messageBindingTemplate?: string;
};

export type PipelineOauthToken = {
  /**
   * Service account email used to mint the OAuth token. The caller
   * needs `iam.serviceAccounts.actAs` on this account.
   */
  serviceAccount?: string;
  /**
   * OAuth scope. Defaults to `https://www.googleapis.com/auth/cloud-platform`.
   */
  scope?: string;
};

export type PipelineOidcToken = {
  /**
   * Service account email used to mint the OIDC token.
   */
  serviceAccount?: string;
  /**
   * Audience claim. Defaults to the destination URI.
   */
  audience?: string;
};

export type PipelineAuthenticationConfig = {
  /** Attach an OAuth2 access token as an `Authorization` header. */
  oauthToken?: PipelineOauthToken;
  /** Attach a Google OIDC token as an `Authorization` header. */
  googleOidc?: PipelineOidcToken;
};

export type PipelineDestination = {
  /**
   * HTTP endpoint destination. HTTPS only.
   */
  httpEndpoint?: PipelineDestinationHttpEndpoint;
  /**
   * Workflow whose executions are triggered by events, as
   * `projects/{project}/locations/{location}/workflows/{workflow}`.
   */
  workflow?: string;
  /**
   * Pub/Sub topic to publish to, as `projects/{project}/topics/{topic}`.
   */
  topic?: string;
  /**
   * MessageBus to publish to, as
   * `projects/{project}/locations/{location}/messageBuses/{messageBus}`.
   */
  messageBus?: string;
  /**
   * VPC network config used to resolve and reach the destination.
   */
  networkConfig?: PipelineDestinationNetworkConfig;
  /**
   * Authentication attached to destination requests.
   */
  authenticationConfig?: PipelineAuthenticationConfig;
  /**
   * Message format delivered to the destination. Requires
   * `inputPayloadFormat` on the pipeline.
   */
  outputPayloadFormat?: PipelinePayloadFormat;
};

export type PipelineProps = {
  /**
   * Pipeline id (the `{pipeline}` segment of
   * `projects/{project}/locations/{location}/pipelines/{pipeline}`). If
   * omitted, a unique name is generated. Must match
   * `[a-z]([a-z0-9-]*[a-z0-9])?` and be 1-63 characters. Immutable —
   * changing it replaces the pipeline.
   */
  pipelineId?: string;
  /**
   * Eventarc Advanced location (`us-central1`, `us-east4`, …). Immutable
   * — changing it replaces the pipeline. `US-CENTRAL1` is accepted and
   * normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile
   *   region, else `us-central1`)
   */
  location?: string;
  /**
   * Destinations messages are forwarded to. The API currently accepts
   * exactly one destination.
   */
  destinations: PipelineDestination[];
  /**
   * Payload format expected of incoming messages. Unset treats the
   * payload as opaque bytes.
   */
  inputPayloadFormat?: PipelinePayloadFormat;
  /**
   * Mediation operations. Currently at most one transformation.
   */
  mediations?: PipelineMediation[];
  /**
   * Retry policy for non-responsive or retryable destinations.
   */
  retryPolicy?: PipelineRetryPolicy;
  /**
   * Human-readable display name.
   */
  displayName?: string;
  /**
   * Customer-managed Cloud KMS key used to encrypt/decrypt event data,
   * as
   * `projects/{project}/locations/{location}/keyRings/{keyRing}/cryptoKeys/{cryptoKey}`.
   */
  cryptoKeyName?: string;
  /**
   * Platform logging configuration.
   */
  loggingConfig?: LoggingConfig;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Free-form annotations.
   */
  annotations?: Record<string, string>;
};

export type Pipeline = Resource<
  "GCP.Eventarc.Pipeline",
  PipelineProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/pipelines/{pipeline}`. */
    name: string;
    /** Pipeline id (last path segment). */
    pipelineId: string;
    /** Project id. */
    project: string;
    /** Location id (`us-central1`, …). */
    location: string;
    /** Configured destinations. */
    destinations: PipelineDestination[];
    /** Incoming payload format. */
    inputPayloadFormat: PipelinePayloadFormat | undefined;
    /** Mediation operations. */
    mediations: PipelineMediation[] | undefined;
    /** Retry policy. */
    retryPolicy: PipelineRetryPolicy | undefined;
    /** Display name. */
    displayName: string | undefined;
    /** Customer-managed KMS key, if any. */
    cryptoKeyName: string | undefined;
    /** Platform logging configuration. */
    loggingConfig: LoggingConfig | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** User annotations. */
    annotations: Record<string, string>;
    /** Whether the pipeline satisfies physical zone separation. */
    satisfiesPzs: boolean | undefined;
    /** Server-assigned UUID4, stable until delete. */
    uid: string | undefined;
    /** Server checksum of the resource. */
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
 * An Eventarc Advanced pipeline that delivers matched enrollment
 * messages to a destination (HTTP, Workflows, Pub/Sub, or another
 * MessageBus), optionally transforming and retrying along the way.
 *
 * `pipelineId` and `location` are identity — changing either replaces
 * the pipeline. Destinations, mediations, retry policy, logging, CMEK,
 * display name, labels, and annotations update in place.
 *
 * ### Creating a Pipeline
 * **Example:** Publish to a Pub/Sub topic
 * ```typescript
 * const topic = yield* GCP.PubSub.Topic("Sink", {});
 * const pipeline = yield* GCP.Eventarc.Pipeline("Forward", {
 *   location: "us-central1",
 *   destinations: [{ topic: topic.name }],
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * **Example:** HTTPS destination with OIDC
 * ```typescript
 * const pipeline = yield* GCP.Eventarc.Pipeline("HttpSink", {
 *   location: "us-central1",
 *   destinations: [{
 *     httpEndpoint: { uri: "https://service-xyz-uc.a.run.app" },
 *     authenticationConfig: {
 *       googleOidc: { serviceAccount: sa.email },
 *     },
 *   }],
 * });
 * ```
 *
 * ### Updating a Pipeline
 * Re-declare the same logical id with changed props; the engine keeps the
 * physical pipeline and patches it in place.
 *
 * **Example:** Change labels and retry policy
 * ```typescript
 * const pipeline = yield* GCP.Eventarc.Pipeline("Forward", {
 *   location: "us-central1",
 *   destinations: [{ topic: topic.name }],
 *   retryPolicy: { maxAttempts: 8 },
 *   labels: { env: "prod", role: "pipeline" },
 * });
 * ```
 *
 * @resource
 * @category Eventarc
 */
export const Pipeline = Resource<Pipeline>("GCP.Eventarc.Pipeline");

const toPayloadFormat = (
  format:
    | PipelinePayloadFormat
    | eventarc.GoogleCloudEventarcV1PipelineMessagePayloadFormat
    | undefined,
): PipelinePayloadFormat | undefined => {
  if (format === undefined) return undefined;
  const next: PipelinePayloadFormat = {};
  if (format.protobuf) {
    next.protobuf = {
      schemaDefinition: format.protobuf.schemaDefinition,
    };
  }
  if (format.avro) {
    next.avro = { schemaDefinition: format.avro.schemaDefinition };
  }
  if (format.json !== undefined) {
    next.json = {};
  }
  return next.protobuf || next.avro || next.json ? next : undefined;
};

const toRetryPolicy = (
  policy:
    | PipelineRetryPolicy
    | eventarc.GoogleCloudEventarcV1PipelineRetryPolicy
    | undefined,
): PipelineRetryPolicy | undefined => {
  if (policy === undefined) return undefined;
  if (
    policy.maxAttempts === undefined &&
    policy.minRetryDelay === undefined &&
    policy.maxRetryDelay === undefined
  ) {
    return undefined;
  }
  return {
    maxAttempts: policy.maxAttempts,
    minRetryDelay: policy.minRetryDelay,
    maxRetryDelay: policy.maxRetryDelay,
  };
};

const toMediations = (
  mediations:
    | readonly PipelineMediation[]
    | eventarc.GoogleCloudEventarcV1PipelineMediationList
    | undefined,
): PipelineMediation[] | undefined => {
  if (mediations === undefined || mediations.length === 0) return undefined;
  return mediations.map((mediation) => ({
    transformation: mediation.transformation
      ? {
          transformationTemplate:
            mediation.transformation.transformationTemplate,
        }
      : undefined,
  }));
};

const toDestination = (
  destination:
    | PipelineDestination
    | eventarc.GoogleCloudEventarcV1PipelineDestination,
  project: string,
  location: string,
): PipelineDestination => {
  const auth = destination.authenticationConfig;
  return {
    httpEndpoint: destination.httpEndpoint
      ? {
          uri: destination.httpEndpoint.uri ?? "",
          messageBindingTemplate:
            destination.httpEndpoint.messageBindingTemplate,
        }
      : undefined,
    workflow: destination.workflow
      ? expandResource(destination.workflow, project, location, "workflows")
      : undefined,
    topic: destination.topic
      ? expandTopic(destination.topic, project)
      : undefined,
    messageBus: destination.messageBus
      ? expandResource(
          destination.messageBus,
          project,
          location,
          "messageBuses",
        )
      : undefined,
    networkConfig: destination.networkConfig?.networkAttachment
      ? { networkAttachment: destination.networkConfig.networkAttachment }
      : undefined,
    authenticationConfig: auth
      ? {
          oauthToken: auth.oauthToken
            ? {
                serviceAccount: auth.oauthToken.serviceAccount,
                scope: auth.oauthToken.scope,
              }
            : undefined,
          googleOidc: auth.googleOidc
            ? {
                serviceAccount: auth.googleOidc.serviceAccount,
                audience: auth.googleOidc.audience,
              }
            : undefined,
        }
      : undefined,
    outputPayloadFormat: toPayloadFormat(destination.outputPayloadFormat),
  };
};

const toDestinations = (
  destinations:
    | readonly PipelineDestination[]
    | eventarc.GoogleCloudEventarcV1PipelineDestinationList
    | undefined,
  project: string,
  location: string,
): PipelineDestination[] =>
  (destinations ?? []).map((destination) =>
    toDestination(destination, project, location),
  );

const toAttrs = (
  pipeline: eventarc.Pipeline,
  project: string,
  region: string,
) => {
  const name = pipeline.name ?? "";
  const parsed = parseName(name, COLLECTION, region);
  const location = parsed.location;
  const resolvedProject = parsed.project || project;
  return {
    name,
    pipelineId: parsed.id,
    project: resolvedProject,
    location,
    destinations: toDestinations(
      pipeline.destinations,
      resolvedProject,
      location,
    ),
    inputPayloadFormat: toPayloadFormat(pipeline.inputPayloadFormat),
    mediations: toMediations(pipeline.mediations),
    retryPolicy: toRetryPolicy(pipeline.retryPolicy),
    displayName: pipeline.displayName,
    cryptoKeyName: pipeline.cryptoKeyName,
    loggingConfig: toLoggingConfig(pipeline.loggingConfig),
    labels: userLabels(pipeline.labels),
    annotations: userAnnotations(pipeline.annotations),
    satisfiesPzs: pipeline.satisfiesPzs,
    uid: pipeline.uid,
    etag: pipeline.etag,
    createTime: pipeline.createTime,
    updateTime: pipeline.updateTime,
  };
};

const getByName = (name: string) =>
  eventarc
    .getProjectsLocationsPipelines({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const PipelineProvider = () =>
  Provider.succeed(Pipeline, {
    stables: ["name", "pipelineId", "project", "location", "uid", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousId = olds?.pipelineId ?? output?.pipelineId;
      const nextId = news.pipelineId
        ? rfc1035(news.pipelineId, "pipeline")
        : previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      if (
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const pipelineId = yield* toPhysicalId(
        id,
        olds?.pipelineId,
        output?.pipelineId,
        "pipeline",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ??
        resourceName(env.project, location, COLLECTION, pipelineId);
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
        const items = yield* collectPages(
          eventarc.listProjectsLocationsPipelines.pages({
            parent: parentOf(env.project, "-"),
            pageSize: 1000,
          }),
          (page) => page.pipelines,
        );
        return items
          .filter((item) => hasAlchemyLabelKeys(item.labels))
          .map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const pipelineId = yield* toPhysicalId(
        id,
        news.pipelineId,
        output?.pipelineId,
        "pipeline",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, COLLECTION, pipelineId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const destinations = toDestinations(
        news.destinations,
        env.project,
        location,
      );
      const desiredLogging = toLoggingConfig(news.loggingConfig);
      const desiredCrypto =
        news.cryptoKeyName && news.cryptoKeyName.length > 0
          ? news.cryptoKeyName
          : undefined;
      const desiredAnnotations = news.annotations
        ? tagRecord(news.annotations)
        : undefined;
      const desiredFormat = toPayloadFormat(news.inputPayloadFormat);
      const desiredMediations = toMediations(news.mediations);
      const desiredRetry = toRetryPolicy(news.retryPolicy);

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* eventarc
          .createProjectsLocationsPipelines({
            parent: parentOf(env.project, location),
            pipelineId,
            body: compact({
              name,
              destinations,
              inputPayloadFormat: desiredFormat,
              mediations: desiredMediations,
              retryPolicy: desiredRetry,
              displayName: news.displayName,
              cryptoKeyName: desiredCrypto,
              loggingConfig: desiredLogging,
              labels: desiredLabels,
              annotations: desiredAnnotations,
            }),
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              times: 5,
              schedule: Schedule.spaced("2 seconds"),
            }),
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilPresent(getByName(name), name);
      }

      const observed = toAttrs(current, env.project, env.region);
      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const updateMask = changedFields([
        ["labels", upsert.length > 0 || removed.length > 0],
        ["destinations", !sameJson(observed.destinations, destinations)],
        [
          "inputPayloadFormat",
          !sameJson(observed.inputPayloadFormat, desiredFormat),
        ],
        ["mediations", !sameJson(observed.mediations, desiredMediations)],
        ["retryPolicy", !sameJson(observed.retryPolicy, desiredRetry)],
        [
          "displayName",
          textKey(current.displayName) !== textKey(news.displayName),
        ],
        [
          "cryptoKeyName",
          cryptoKeyKey(current.cryptoKeyName) !== cryptoKeyKey(desiredCrypto),
        ],
        [
          "loggingConfig",
          loggingKey(current.loggingConfig) !== loggingKey(desiredLogging),
        ],
        [
          "annotations",
          !sameJson(tagRecord(current.annotations), desiredAnnotations ?? {}),
        ],
      ]);

      if (updateMask.length > 0) {
        const patched = yield* eventarc.patchProjectsLocationsPipelines({
          name: current.name ?? name,
          updateMask: updateMask.join(","),
          body: {
            name: current.name ?? name,
            destinations,
            inputPayloadFormat: desiredFormat,
            mediations: desiredMediations,
            retryPolicy: desiredRetry,
            displayName: news.displayName,
            cryptoKeyName: desiredCrypto,
            loggingConfig: desiredLogging,
            labels: desiredLabels,
            annotations: desiredAnnotations ?? {},
          },
        });
        yield* waitForOperation(patched);
        current = yield* waitUntilPresent(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* retryOnTransient(
        Effect.gen(function* () {
          const existing = yield* getByName(output.name);
          if (existing === undefined) return;
          const operation = yield* eventarc
            .deleteProjectsLocationsPipelines({
              name: output.name,
              allowMissing: true,
            })
            .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
          if (operation !== undefined) {
            yield* waitForOperation(operation, { notFoundOk: true });
          }
        }),
      ).pipe(
        Effect.catchTag("GCP.OperationFailed", (error) =>
          getByName(output.name).pipe(
            Effect.flatMap((current) =>
              current === undefined ? Effect.void : Effect.fail(error),
            ),
          ),
        ),
      );
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
