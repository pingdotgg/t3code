import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as eventarc from "@distilled.cloud/gcp/eventarc_v1";
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
import { waitForOperation } from "./internal.ts";

const DEFAULT_CONTENT_TYPE = "application/json";
const MAX_NAME_LENGTH = 63;

export type EventFilter = {
  /**
   * CloudEvents attribute to match. Every trigger must include a filter
   * on `type`.
   */
  attribute: string;
  /**
   * Value the attribute must equal (or match via `operator`).
   */
  value: string;
  /**
   * Optional match operator. Allowed values: `path_pattern`,
   * `match-path-pattern`. Omitted means exact match.
   */
  operator?: string;
};

export type CloudRunDestination = {
  /**
   * Cloud Run service name (the `{service}` segment, not a full resource
   * name). Must live in the same project as the trigger.
   */
  service: string;
  /**
   * Region the Cloud Run service is deployed in.
   */
  region: string;
  /**
   * Relative path on the service events are sent to, e.g. `/events`.
   */
  path?: string;
};

export type GkeDestination = {
  /**
   * GKE cluster name. Must be in the same project as the trigger.
   */
  cluster: string;
  /**
   * Zone (zonal clusters) or region (regional clusters) of the cluster.
   */
  location: string;
  /**
   * GKE service name.
   */
  service: string;
  /**
   * Kubernetes namespace the service runs in.
   */
  namespace: string;
  /**
   * Relative path on the GKE service events are sent to.
   */
  path?: string;
};

export type HttpEndpointDestination = {
  /**
   * RFC2396 URI of the HTTP endpoint (`http://` or `https://`).
   */
  uri: string;
};

export type NetworkConfig = {
  /**
   * Network attachment granting Eventarc access to the VPC, as
   * `projects/{project}/regions/{region}/networkAttachments/{name}`.
   * Required with `httpEndpoint`.
   */
  networkAttachment: string;
};

export type Destination = {
  /**
   * Cloud Run service that receives events.
   */
  cloudRun?: CloudRunDestination;
  /**
   * GKE service that receives events.
   */
  gke?: GkeDestination;
  /**
   * Workflow resource name
   * (`projects/{project}/locations/{location}/workflows/{workflow}`).
   */
  workflow?: string;
  /**
   * Internal HTTP endpoint that receives events.
   */
  httpEndpoint?: HttpEndpointDestination;
  /**
   * VPC network config. Only valid with `httpEndpoint`.
   */
  networkConfig?: NetworkConfig;
};

export type PubsubTransport = {
  /**
   * Existing Pub/Sub topic Eventarc uses as the event source, as
   * `projects/{project}/topics/{topic}`. Required for
   * `google.cloud.pubsub.topic.v1.messagePublished`. Immutable —
   * changing it replaces the trigger. Eventarc-managed topics are not
   * deleted with the trigger.
   */
  topic?: string;
  /**
   * Output only. Pub/Sub subscription Eventarc manages for delivery.
   */
  subscription?: string;
};

export type Transport = {
  /**
   * Pub/Sub transport intermediary.
   */
  pubsub?: PubsubTransport;
};

export type RetryPolicy = {
  /**
   * Maximum delivery attempts. The only valid value is `1`. Cloud Run
   * destinations only.
   */
  maxAttempts?: number;
};

export type TriggerProps = {
  /**
   * Trigger id (the `{trigger}` segment of
   * `projects/{project}/locations/{location}/triggers/{trigger}`). If
   * omitted, a unique name is generated from the stack, stage, and
   * logical id. Must match `[a-z]([a-z0-9-]*[a-z0-9])?` and be 1-63
   * characters. Immutable — changing it replaces the trigger.
   */
  triggerId?: string;
  /**
   * Eventarc location (`us-central1`, `us-east1`, …). Immutable —
   * changing it replaces the trigger. `US-CENTRAL1` is accepted and
   * normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile
   *   region, else `us-central1`)
   */
  location?: string;
  /**
   * CloudEvents attribute filters. Every event must match all filters.
   * A `type` filter is required. Immutable — changing filters replaces
   * the trigger.
   */
  eventFilters: EventFilter[];
  /**
   * Where matching events are delivered (Cloud Run, GKE, Workflows, or
   * an HTTP endpoint).
   */
  destination: Destination;
  /**
   * Transport intermediary. For Pub/Sub events, set `pubsub.topic` to an
   * existing topic. Immutable — changing the topic replaces the trigger.
   */
  transport?: Transport;
  /**
   * Partner channel,
   * `projects/{project}/locations/{location}/channels/{channel}`.
   * Required for Eventarc SaaS partner events. Immutable — changing it
   * replaces the trigger.
   */
  channel?: string;
  /**
   * IAM service account email Eventarc uses as the trigger identity.
   * The caller needs `iam.serviceAccounts.actAs` on this account. If
   * omitted, Alchemy uses the project's Compute Engine default service
   * account (`{PROJECT_NUMBER}-compute@developer.gserviceaccount.com`).
   * Required by the Eventarc API for Workflows (and most other)
   * destinations.
   */
  serviceAccount?: string;
  /**
   * MIME type expected in the CloudEvent `data` payload.
   * @default "application/json"
   */
  eventDataContentType?: string;
  /**
   * Retry policy. Cloud Run destinations only; omit for the 24-hour
   * default.
   */
  retryPolicy?: RetryPolicy;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type Trigger = Resource<
  "GCP.Eventarc.Trigger",
  TriggerProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/triggers/{trigger}`. */
    name: string;
    /** Trigger id (last path segment). */
    triggerId: string;
    /** Project id. */
    project: string;
    /** Location id (`us-central1`, …). */
    location: string;
    /** CloudEvents attribute filters. */
    eventFilters: EventFilter[];
    /** Destination currently configured on the trigger. */
    destination: Destination | undefined;
    /** Transport intermediary, including Eventarc-managed Pub/Sub resources. */
    transport: Transport | undefined;
    /** Partner channel, if any. */
    channel: string | undefined;
    /** Trigger identity service account. */
    serviceAccount: string | undefined;
    /** CloudEvent data MIME type. */
    eventDataContentType: string | undefined;
    /** Retry policy, if set. */
    retryPolicy: RetryPolicy | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-assigned UUID4, stable until delete. */
    uid: string | undefined;
    /** Server checksum of the resource. */
    etag: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
    /** Whether the trigger satisfies physical zone separation. */
    satisfiesPzs: boolean | undefined;
    /** Reasons the trigger is in FAILED state, if any. */
    conditions: eventarc.StateConditionMap | undefined;
  },
  never,
  Providers
>;

/**
 * An Eventarc trigger that routes events matching a set of CloudEvents
 * filters to a Cloud Run service, GKE service, Workflow, or HTTP
 * endpoint.
 *
 * `triggerId`, `location`, `eventFilters`, `channel`, and
 * `transport.pubsub.topic` are identity — changing any of them replaces
 * the trigger. Destination, service account, content type, retry policy,
 * and labels update in place.
 *
 * ### Creating a Trigger
 * **Example:** Pub/Sub messages to a Workflow
 * ```typescript
 * const topic = yield* GCP.PubSub.Topic("events", {});
 * const trigger = yield* GCP.Eventarc.Trigger("orders", {
 *   eventFilters: [
 *     {
 *       attribute: "type",
 *       value: "google.cloud.pubsub.topic.v1.messagePublished",
 *     },
 *   ],
 *   destination: {
 *     workflow:
 *       "projects/my-project/locations/us-central1/workflows/orders",
 *   },
 *   transport: { pubsub: { topic: topic.name } },
 * });
 * ```
 *
 * **Example:** Pub/Sub messages to Cloud Run
 * ```typescript
 * const trigger = yield* GCP.Eventarc.Trigger("orders", {
 *   triggerId: "order-events",
 *   location: "us-central1",
 *   eventFilters: [
 *     {
 *       attribute: "type",
 *       value: "google.cloud.pubsub.topic.v1.messagePublished",
 *     },
 *   ],
 *   destination: {
 *     cloudRun: { service: "order-handler", region: "us-central1" },
 *   },
 *   transport: { pubsub: { topic: topic.name } },
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating a Trigger
 * Re-declare the same logical id with changed props; the engine keeps the
 * physical trigger and patches it in place.
 *
 * **Example:** Change labels and the CloudEvent content type
 * ```typescript
 * const trigger = yield* GCP.Eventarc.Trigger("orders", {
 *   eventFilters: [
 *     {
 *       attribute: "type",
 *       value: "google.cloud.pubsub.topic.v1.messagePublished",
 *     },
 *   ],
 *   destination: {
 *     workflow:
 *       "projects/my-project/locations/us-central1/workflows/orders",
 *   },
 *   transport: { pubsub: { topic: topic.name } },
 *   eventDataContentType: "application/json",
 *   labels: { env: "prod", role: "events" },
 * });
 * ```
 *
 * @resource
 * @category Eventarc
 */
export const Trigger = Resource<Trigger>("GCP.Eventarc.Trigger");

export class TriggerNotHealthy extends Data.TaggedError(
  "GCP.Eventarc.TriggerNotHealthy",
)<{ name: string; conditions: string }> {}

export class TriggerNotResolved extends Data.TaggedError(
  "GCP.Eventarc.TriggerNotResolved",
)<{
  name: string;
}> {}

export class TriggerStillExists extends Data.TaggedError(
  "GCP.Eventarc.TriggerStillExists",
)<{
  name: string;
}> {}

export class TriggerServiceAccountMissing extends Data.TaggedError(
  "GCP.Eventarc.TriggerServiceAccountMissing",
)<{
  project: string;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const normalizeLocation = (
  location: string | undefined,
  defaultLocation: string,
) => lastSegment(location ?? defaultLocation).toLowerCase();

const rfc1035 = (name: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `t${next}`;
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/g, "");
  return next.length > 0 ? next : "trigger";
};

const resourceName = (project: string, location: string, triggerId: string) =>
  `projects/${project}/locations/${location}/triggers/${triggerId}`;

const parseName = (name: string, defaultLocation: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const triggersAt = parts.lastIndexOf("triggers");
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : defaultLocation,
    triggerId:
      triggersAt >= 0 && parts[triggersAt + 1]
        ? parts[triggersAt + 1]!
        : lastSegment(name),
  };
};

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const toId = (id: string, triggerId: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (triggerId !== undefined) return rfc1035(triggerId);
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: MAX_NAME_LENGTH,
        lowercase: true,
      }),
    );
  });

const compact = <T extends Record<string, unknown>>(value: T): T => {
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined && entry !== "") next[key] = entry;
  }
  return next as T;
};

const toEventFilters = (
  filters: eventarc.EventFilterList | undefined,
): EventFilter[] =>
  (filters ?? [])
    .filter(
      (
        filter,
      ): filter is eventarc.EventFilter & {
        attribute: string;
        value: string;
      } =>
        typeof filter.attribute === "string" &&
        typeof filter.value === "string",
    )
    .map((filter) =>
      compact({
        attribute: filter.attribute,
        value: filter.value,
        operator: filter.operator,
      }),
    );

const toDestination = (
  destination: eventarc.Destination | undefined,
): Destination | undefined => {
  if (destination === undefined) return undefined;
  const next = compact({
    cloudRun: destination.cloudRun
      ? compact({
          service: destination.cloudRun.service ?? "",
          region: destination.cloudRun.region ?? "",
          path: destination.cloudRun.path,
        })
      : undefined,
    gke: destination.gke
      ? compact({
          cluster: destination.gke.cluster ?? "",
          location: destination.gke.location ?? "",
          service: destination.gke.service ?? "",
          namespace: destination.gke.namespace ?? "",
          path: destination.gke.path,
        })
      : undefined,
    workflow: destination.workflow,
    httpEndpoint: destination.httpEndpoint
      ? compact({ uri: destination.httpEndpoint.uri ?? "" })
      : undefined,
    networkConfig: destination.networkConfig
      ? compact({
          networkAttachment: destination.networkConfig.networkAttachment ?? "",
        })
      : undefined,
  });
  return Object.keys(next).length > 0 ? next : undefined;
};

const fromDestination = (destination: Destination): eventarc.Destination =>
  compact({
    cloudRun: destination.cloudRun
      ? compact({
          service: destination.cloudRun.service,
          region: destination.cloudRun.region,
          path: destination.cloudRun.path,
        })
      : undefined,
    gke: destination.gke
      ? compact({
          cluster: destination.gke.cluster,
          location: destination.gke.location,
          service: destination.gke.service,
          namespace: destination.gke.namespace,
          path: destination.gke.path,
        })
      : undefined,
    workflow: destination.workflow,
    httpEndpoint: destination.httpEndpoint
      ? compact({ uri: destination.httpEndpoint.uri })
      : undefined,
    networkConfig: destination.networkConfig
      ? compact({
          networkAttachment: destination.networkConfig.networkAttachment,
        })
      : undefined,
  });

const toTransport = (
  transport: eventarc.Transport | undefined,
): Transport | undefined => {
  if (transport?.pubsub === undefined) return undefined;
  return {
    pubsub: compact({
      topic: transport.pubsub.topic,
      subscription: transport.pubsub.subscription,
    }),
  };
};

const topicKey = (topic: string | undefined, project: string) => {
  if (topic === undefined || topic.length === 0) return "";
  if (topic.includes("/")) return topic;
  return `projects/${project}/topics/${topic}`;
};

const saKey = (serviceAccount: string | undefined) => {
  if (serviceAccount === undefined || serviceAccount.length === 0) return "";
  return serviceAccount.includes("/")
    ? lastSegment(serviceAccount)
    : serviceAccount;
};

const filtersKey = (filters: EventFilter[] | undefined) =>
  JSON.stringify(
    [...(filters ?? [])]
      .map((filter) => ({
        attribute: filter.attribute,
        value: filter.value,
        operator: filter.operator ?? "",
      }))
      .sort((left, right) =>
        left.attribute === right.attribute
          ? left.value.localeCompare(right.value)
          : left.attribute.localeCompare(right.attribute),
      ),
  );

const destinationKey = (destination: Destination | undefined) =>
  JSON.stringify(toDestination(fromDestination(destination ?? {})) ?? {});

const contentTypeKey = (value: string | undefined) =>
  (value === undefined || value.length === 0
    ? DEFAULT_CONTENT_TYPE
    : value
  ).toLowerCase();

const retryKey = (policy: RetryPolicy | undefined) =>
  JSON.stringify({ maxAttempts: policy?.maxAttempts ?? null });

const toAttrs = (
  trigger: eventarc.Trigger,
  project: string,
  region: string,
) => {
  const name = trigger.name ?? "";
  const parsed = parseName(name, region);
  return {
    name,
    triggerId: parsed.triggerId,
    project: parsed.project || project,
    location: parsed.location,
    eventFilters: toEventFilters(trigger.eventFilters),
    destination: toDestination(trigger.destination),
    transport: toTransport(trigger.transport),
    channel: trigger.channel,
    serviceAccount: trigger.serviceAccount,
    eventDataContentType: trigger.eventDataContentType ?? DEFAULT_CONTENT_TYPE,
    retryPolicy: trigger.retryPolicy
      ? compact({ maxAttempts: trigger.retryPolicy.maxAttempts })
      : undefined,
    labels: userLabels(trigger.labels),
    uid: trigger.uid,
    etag: trigger.etag,
    createTime: trigger.createTime,
    updateTime: trigger.updateTime,
    satisfiesPzs: trigger.satisfiesPzs,
    conditions: trigger.conditions,
  };
};

const getByName = (name: string) =>
  eventarc
    .getProjectsLocationsTriggers({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

/**
 * Block until Eventarc reports every trigger condition healthy (`OK`), so
 * nothing downstream assumes a trigger that is still provisioning its
 * transport. A trigger whose conditions settle on an error fails.
 */
const waitUntilHealthy = (name: string) =>
  waitUntilExists(name).pipe(
    Effect.flatMap((trigger) => {
      const failing = Object.entries(trigger.conditions ?? {}).filter(
        ([, condition]) =>
          condition?.code !== undefined && condition.code !== "OK",
      );
      return failing.length === 0
        ? Effect.succeed(trigger)
        : Effect.fail(
            new TriggerNotHealthy({
              name,
              conditions: failing
                .map(
                  ([key, condition]) =>
                    `${key}: ${condition?.code} ${condition?.message ?? ""}`,
                )
                .join("; "),
            }),
          );
    }),
    Effect.retry({
      while: (error) => error._tag === "GCP.Eventarc.TriggerNotHealthy",
      times: 30,
      schedule: Schedule.spaced("5 seconds"),
    }),
  );

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((trigger) =>
      trigger
        ? Effect.succeed(trigger)
        : Effect.fail(new TriggerNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Eventarc.TriggerNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((trigger) =>
      trigger === undefined
        ? Effect.void
        : Effect.fail(new TriggerStillExists({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Eventarc.TriggerStillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const desiredTransport = (
  news: TriggerProps,
): eventarc.Transport | undefined => {
  const topic = news.transport?.pubsub?.topic;
  if (topic === undefined || topic.length === 0) return undefined;
  return { pubsub: { topic } };
};

const defaultServiceAccount = (project: string) =>
  resourcemanager.getProjects({ name: `projects/${project}` }).pipe(
    Effect.flatMap((resource) => {
      const projectNumber = lastSegment(resource.name ?? "");
      if (!/^\d+$/.test(projectNumber)) {
        return Effect.fail(new TriggerServiceAccountMissing({ project }));
      }
      return Effect.succeed(
        `${projectNumber}-compute@developer.gserviceaccount.com`,
      );
    }),
  );

const resolveServiceAccount = (
  project: string,
  news: TriggerProps,
  current: eventarc.Trigger | undefined,
) =>
  Effect.gen(function* () {
    if (news.serviceAccount !== undefined && news.serviceAccount.length > 0) {
      return news.serviceAccount;
    }
    if (
      current?.serviceAccount !== undefined &&
      current.serviceAccount.length > 0
    ) {
      return current.serviceAccount;
    }
    return yield* defaultServiceAccount(project);
  });

export const TriggerProvider = () =>
  Provider.succeed(Trigger, {
    stables: [
      "name",
      "triggerId",
      "project",
      "location",
      "uid",
      "createTime",
      "channel",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;

      const previousId = olds?.triggerId ?? output?.triggerId;
      const nextId = news.triggerId ? rfc1035(news.triggerId) : previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const project = output?.project ?? "";
      const previousChannel = olds?.channel ?? output?.channel ?? "";
      const nextChannel = news.channel ?? previousChannel;
      const previousTopic = topicKey(
        olds?.transport?.pubsub?.topic ?? output?.transport?.pubsub?.topic,
        project,
      );
      const nextTopic =
        news.transport?.pubsub?.topic !== undefined
          ? topicKey(news.transport.pubsub.topic, project)
          : previousTopic;
      const previousFilters = filtersKey(
        olds?.eventFilters ?? output?.eventFilters,
      );
      const nextFilters = filtersKey(news.eventFilters);

      const replace =
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation ||
        previousChannel !== nextChannel ||
        (nextTopic.length > 0 &&
          previousTopic.length > 0 &&
          nextTopic !== previousTopic) ||
        previousFilters !== nextFilters;

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
      const triggerId = yield* toId(id, olds?.triggerId, output?.triggerId);
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, triggerId);
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
        return yield* eventarc.listProjectsLocationsTriggers
          .pages({
            parent: `projects/${env.project}/locations/-`,
            pageSize: 1000,
          })
          .pipe(
            Stream.flatMap((page) => Stream.fromIterable(page.triggers ?? [])),
            Stream.filter((trigger) =>
              Object.keys(trigger.labels ?? {}).some((key) =>
                key.startsWith("alchemy-"),
              ),
            ),
            Stream.map((trigger) => toAttrs(trigger, env.project, env.region)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const triggerId = yield* toId(id, news.triggerId, output?.triggerId);
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, triggerId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const eventFilters = news.eventFilters.map((filter) =>
        compact({
          attribute: filter.attribute,
          value: filter.value,
          operator: filter.operator,
        }),
      );
      const destination = fromDestination(news.destination);
      const transport = desiredTransport(news);

      let current = yield* getByName(name);
      const serviceAccount = yield* resolveServiceAccount(
        env.project,
        news,
        current,
      );

      if (current === undefined) {
        const created = yield* eventarc
          .createProjectsLocationsTriggers({
            parent: `projects/${env.project}/locations/${location}`,
            triggerId,
            body: {
              name,
              labels: desiredLabels,
              eventFilters,
              destination,
              transport,
              channel: news.channel,
              serviceAccount,
              eventDataContentType: news.eventDataContentType,
              retryPolicy: news.retryPolicy,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(name);
      }

      if (current === undefined) {
        return yield* new TriggerNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const destinationChanged =
        destinationKey(toDestination(current.destination)) !==
        destinationKey(news.destination);
      const serviceAccountChanged =
        saKey(serviceAccount) !== saKey(current.serviceAccount);
      const contentTypeChanged =
        news.eventDataContentType !== undefined &&
        contentTypeKey(current.eventDataContentType) !==
          contentTypeKey(news.eventDataContentType);
      const retryChanged =
        news.retryPolicy !== undefined &&
        retryKey(current.retryPolicy) !== retryKey(news.retryPolicy);

      if (
        labelsChanged ||
        destinationChanged ||
        serviceAccountChanged ||
        contentTypeChanged ||
        retryChanged
      ) {
        const updateMask = [
          labelsChanged ? "labels" : undefined,
          destinationChanged ? "destination" : undefined,
          serviceAccountChanged ? "serviceAccount" : undefined,
          contentTypeChanged ? "eventDataContentType" : undefined,
          retryChanged ? "retryPolicy" : undefined,
        ].filter((field): field is string => field !== undefined);

        const patched = yield* eventarc.patchProjectsLocationsTriggers({
          name,
          updateMask: updateMask.join(","),
          body: {
            name,
            labels: desiredLabels,
            destination,
            serviceAccount,
            eventDataContentType: news.eventDataContentType,
            retryPolicy: news.retryPolicy,
          },
        });
        yield* waitForOperation(patched);
        current = yield* waitUntilExists(name);
      }

      current = yield* waitUntilHealthy(name);
      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const existing = yield* getByName(output.name);
      if (existing === undefined) return;
      const operation = yield* eventarc
        .deleteProjectsLocationsTriggers({
          name: output.name,
          allowMissing: true,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(output.name);
    }),
  });
