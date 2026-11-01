import * as tpu from "@distilled.cloud/gcp/tpu_v2";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels, toLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeDescription,
  hasAlchemyLabelMap,
  hasOwnershipMarker,
  normalizeLocation,
  parseDescription,
  parseName,
  replaceOnIdentity,
  ResourceNotResolved,
  toPhysicalId,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";
import { toNodeBody, type NodeProps } from "./Node.ts";

export type MultisliceParams = {
  /**
   * Prefix for generated node ids (`np` → `np-0`, `np-1`, …). Defaults to
   * the queued resource id.
   */
  nodeIdPrefix?: string;
  /**
   * Number of nodes to provision. Must be greater than 1.
   */
  nodeCount?: number;
};

export type NodeSpec = {
  /**
   * Parent location
   * (`projects/{project}/locations/{location}`). Defaults to the queued
   * resource parent.
   */
  parent?: string;
  /**
   * Unqualified node id when requesting a single node. Mutually exclusive
   * with `multisliceParams`.
   */
  nodeId?: string;
  /**
   * Multislice request. Mutually exclusive with `nodeId`.
   */
  multisliceParams?: MultisliceParams;
  /**
   * Node configuration. Alchemy ownership labels are merged into
   * `node.labels` (QueuedResource has no labels field of its own).
   */
  node?: NodeProps;
};

export type QueueingPolicy = {
  /** Absolute time after which the request fails if still unfulfilled. */
  validUntilTime?: string;
  /** Relative duration after which resources may be created. */
  validAfterDuration?: string;
  /** Absolute interval during which resources may be created. */
  validInterval?: {
    /** Inclusive start (RFC3339). */
    startTime?: string;
    /** Exclusive end (RFC3339). */
    endTime?: string;
  };
  /** Absolute time after which resources may be created. */
  validAfterTime?: string;
  /** Relative duration after which the request fails if still unfulfilled. */
  validUntilDuration?: string;
};

export type Guaranteed = {
  /**
   * Minimum duration the resources must be allocated (`3600s`, …).
   */
  minDuration?: string;
};

export type QueuedResourceProps = {
  /**
   * Queued resource id (the `{queuedResource}` segment of
   * `projects/{project}/locations/{location}/queuedResources/{queuedResource}`).
   * If omitted, a unique RFC1035 name is generated from the stack, stage,
   * and logical id. Immutable — changing it replaces the resource.
   */
  queuedResourceId?: string;
  /**
   * Zone (`us-central1-c`, …). Immutable — changing it replaces the
   * resource.
   * @default "us-central1-c"
   */
  location?: string;
  /**
   * Reservation to provision in
   * (`projects/{project}/locations/{zone}/reservations/{reservation}`).
   * Immutable.
   */
  reservationName?: string;
  /**
   * Request the Spot tier. Immutable.
   * @default false
   */
  spot?: boolean;
  /**
   * Guaranteed tier. Immutable.
   */
  guaranteed?: Guaranteed;
  /**
   * When the request may be fulfilled. Immutable.
   */
  queueingPolicy?: QueueingPolicy;
  /**
   * TPU node specification. Omit to request a default v2-8 node with the
   * standard runtime. Alchemy ownership is stamped on each nested node's
   * labels and description (QueuedResource has no labels API).
   */
  nodeSpec?: NodeSpec[];
  /**
   * Delete running nodes belonging to this request before deleting the
   * queued resource.
   * @default true
   */
  forceDestroy?: boolean;
};

export type QueuedResource = Resource<
  "GCP.TPU.QueuedResource",
  QueuedResourceProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/queuedResources/{queuedResource}`. */
    name: string;
    /** Queued resource id (last path segment). */
    queuedResourceId: string;
    /** Project id. */
    project: string;
    /** Zone id. */
    location: string;
    /** Reservation name, if any. */
    reservationName: string | undefined;
    /** Whether the Spot tier is set. */
    spot: boolean;
    /** Guaranteed tier configuration. */
    guaranteed: Guaranteed | undefined;
    /** Queueing policy. */
    queueingPolicy: QueueingPolicy | undefined;
    /** Node specification currently stored on the request. */
    nodeSpec: NodeSpec[];
    /** Server-reported state (`ACCEPTED`, `WAITING_FOR_RESOURCES`, …). */
    state: string | undefined;
    /** Who initiated the current state (`USER`, `SERVICE`). */
    stateInitiator: string | undefined;
    /** Error that caused `FAILED`, if any. */
    failedError: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud TPU queued resource request. The request sits in a queue until
 * capacity is available, then provisions the requested TPU node(s).
 *
 * Queued resources have no labels field — Alchemy stamps ownership onto
 * each nested `nodeSpec.node` labels and description so `list` / nuke can
 * find them. The resource is create-only: changing identity or the node
 * spec replaces it.
 *
 * ### Creating a Queued Resource
 * **Example:** Default v2-8 request
 * ```typescript
 * const request = yield* GCP.TPU.QueuedResource("Trainer", {});
 * ```
 *
 * **Example:** Spot request with an explicit node spec
 * ```typescript
 * const request = yield* GCP.TPU.QueuedResource("Trainer", {
 *   location: "us-central1-c",
 *   spot: true,
 *   nodeSpec: [{
 *     nodeId: "app-tpu",
 *     node: {
 *       acceleratorType: "v2-8",
 *       runtimeVersion: "tpu-ubuntu2204-base",
 *       labels: { env: "prod" },
 *     },
 *   }],
 * });
 * ```
 *
 * @resource
 * @category TPU
 */
export const QueuedResource = Resource<QueuedResource>(
  "GCP.TPU.QueuedResource",
);

const resourceName = (
  project: string,
  location: string,
  queuedResourceId: string,
) =>
  `projects/${project}/locations/${location}/queuedResources/${queuedResourceId}`;

const parentOf = (project: string, location: string) =>
  `projects/${project}/locations/${location}`;

const intervalOf = (
  interval: tpu.Interval | QueueingPolicy["validInterval"] | undefined,
) => {
  if (interval === undefined) return undefined;
  return { startTime: interval.startTime, endTime: interval.endTime };
};

const queueingOf = (
  policy: tpu.QueueingPolicy | QueueingPolicy | undefined,
): QueueingPolicy | undefined => {
  if (policy === undefined) return undefined;
  return {
    validUntilTime: policy.validUntilTime,
    validAfterDuration: policy.validAfterDuration,
    validInterval: intervalOf(policy.validInterval),
    validAfterTime: policy.validAfterTime,
    validUntilDuration: policy.validUntilDuration,
  };
};

const queueingKey = (policy: QueueingPolicy | undefined) =>
  JSON.stringify({
    validUntilTime: policy?.validUntilTime ?? "",
    validAfterDuration: policy?.validAfterDuration ?? "",
    validIntervalStart: policy?.validInterval?.startTime ?? "",
    validIntervalEnd: policy?.validInterval?.endTime ?? "",
    validAfterTime: policy?.validAfterTime ?? "",
    validUntilDuration: policy?.validUntilDuration ?? "",
  });

const guaranteedOf = (
  guaranteed: tpu.Guaranteed | Guaranteed | undefined,
): Guaranteed | undefined => {
  if (guaranteed === undefined) return undefined;
  return { minDuration: guaranteed.minDuration };
};

const networkTagsOf = (node: tpu.Node | NodeProps) => {
  if ("networkTags" in node && node.networkTags) {
    return [...node.networkTags];
  }
  if ("tags" in node && node.tags) {
    return [...node.tags];
  }
  return undefined;
};

const stringRecordOf = (map: Record<string, string | undefined> | undefined) =>
  map
    ? Object.fromEntries(
        Object.entries(map).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      )
    : undefined;

const nodeSpecOf = (
  spec: tpu.NodeSpec | NodeSpec,
  parent: string,
): NodeSpec => ({
  parent: spec.parent ?? parent,
  nodeId: spec.nodeId,
  multisliceParams: spec.multisliceParams
    ? {
        nodeIdPrefix: spec.multisliceParams.nodeIdPrefix,
        nodeCount: spec.multisliceParams.nodeCount,
      }
    : undefined,
  node: spec.node
    ? {
        description: spec.node.description,
        labels: stringRecordOf(spec.node.labels),
        metadata: stringRecordOf(spec.node.metadata),
        networkTags: networkTagsOf(spec.node),
        runtimeVersion: spec.node.runtimeVersion,
        acceleratorType: spec.node.acceleratorType,
        acceleratorConfig: spec.node.acceleratorConfig,
        cidrBlock: spec.node.cidrBlock,
        serviceAccount: spec.node.serviceAccount,
        networkConfig: spec.node.networkConfig,
        networkConfigs: spec.node.networkConfigs,
        bootDiskConfig: spec.node.bootDiskConfig,
        dataDisks: spec.node.dataDisks,
        schedulingConfig: spec.node.schedulingConfig,
        shieldedInstanceConfig: spec.node.shieldedInstanceConfig,
      }
    : undefined,
});

const nodeSpecKey = (spec: NodeSpec) =>
  JSON.stringify({
    parent: spec.parent ?? "",
    nodeId: spec.nodeId ?? "",
    prefix: spec.multisliceParams?.nodeIdPrefix ?? "",
    count: spec.multisliceParams?.nodeCount ?? "",
    runtime: spec.node?.runtimeVersion ?? "",
    accelerator: spec.node?.acceleratorType ?? "",
    topology: spec.node?.acceleratorConfig?.topology ?? "",
    cidr: spec.node?.cidrBlock ?? "",
  });

const specsKey = (specs: readonly NodeSpec[]) =>
  JSON.stringify(specs.map(nodeSpecKey));

const nestedNodes = (resource: tpu.QueuedResource) =>
  resource.tpu?.nodeSpec ?? [];

const nestedOwnershipLabels = (resource: tpu.QueuedResource) => {
  const labels: Record<string, string> = {};
  for (const spec of nestedNodes(resource)) {
    Object.assign(labels, tagRecord(spec.node?.labels));
    Object.assign(labels, parseDescription(spec.node?.description).labels);
  }
  return labels;
};

const hasNestedOwnership = (resource: tpu.QueuedResource) => {
  for (const spec of nestedNodes(resource)) {
    if (hasAlchemyLabelMap(spec.node?.labels)) return true;
    if (hasOwnershipMarker(spec.node?.description)) return true;
  }
  return false;
};

const desiredSpecs = (
  news: QueuedResourceProps,
  parent: string,
  desiredLabels: Record<string, string>,
): tpu.NodeSpec[] => {
  const specs =
    news.nodeSpec !== undefined && news.nodeSpec.length > 0
      ? news.nodeSpec
      : [{ node: {} as NodeProps }];
  return specs.map((spec) => {
    const node = spec.node ?? {};
    const description = encodeDescription(desiredLabels, node.description);
    const labels = { ...toLabels(node.labels), ...desiredLabels };
    return {
      parent: spec.parent ?? parent,
      nodeId: spec.nodeId,
      multisliceParams: spec.multisliceParams,
      node: toNodeBody({ ...node, labels }, labels, { description }),
    };
  });
};

const toAttrs = (resource: tpu.QueuedResource, project: string) => {
  const name = resource.name ?? "";
  const parsed = parseName(name, "queuedResources");
  const parent = parentOf(parsed.project || project, parsed.location);
  return {
    name,
    queuedResourceId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    reservationName: resource.reservationName,
    spot: resource.spot !== undefined,
    guaranteed: guaranteedOf(resource.guaranteed),
    queueingPolicy: queueingOf(resource.queueingPolicy),
    nodeSpec: (resource.tpu?.nodeSpec ?? []).map((spec) => {
      const mapped = nodeSpecOf(spec, parent);
      if (mapped.node?.description !== undefined) {
        mapped.node = {
          ...mapped.node,
          description: parseDescription(mapped.node.description).description,
          labels: mapped.node.labels
            ? Object.fromEntries(
                Object.entries(mapped.node.labels).filter(
                  ([key]) => !key.startsWith("alchemy-"),
                ),
              )
            : undefined,
        };
      }
      return mapped;
    }),
    state: resource.state?.state,
    stateInitiator: resource.state?.stateInitiator,
    failedError: resource.state?.failedData?.error?.message,
    createTime: resource.createTime,
  };
};

const isPlaceholder = (resource: tpu.QueuedResource) => {
  const name = resource.name ?? "";
  return (
    name.length === 0 ||
    name.endsWith("/queuedResources/-") ||
    name.endsWith("/queuedResources/")
  );
};

const getByName = (name: string) =>
  tpu
    .getProjectsLocationsQueuedResources({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const specIdentityChanged = (
  previous: QueuedResourceProps | { nodeSpec?: NodeSpec[] } | undefined,
  next: QueuedResourceProps,
  parent: string,
) => {
  const previousSpecs = (previous?.nodeSpec ?? []).map((spec) =>
    nodeSpecOf(spec, parent),
  );
  const nextSpecs =
    next.nodeSpec !== undefined && next.nodeSpec.length > 0
      ? next.nodeSpec.map((spec) => nodeSpecOf(spec, parent))
      : previousSpecs;
  if (previousSpecs.length === 0) return false;
  return specsKey(previousSpecs) !== specsKey(nextSpecs);
};

export const QueuedResourceProvider = () =>
  Provider.succeed(QueuedResource, {
    stables: ["name", "queuedResourceId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;

      const previousId = olds?.queuedResourceId ?? output?.queuedResourceId;
      const nextId = news.queuedResourceId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
      );
      const nextLocation = normalizeLocation(news.location ?? output?.location);
      const parent = `projects/_/locations/${nextLocation}`;
      const previousReservation =
        olds?.reservationName ?? output?.reservationName ?? "";
      const nextReservation = news.reservationName ?? previousReservation;
      const previousSpot = olds?.spot ?? output?.spot ?? false;
      const nextSpot = news.spot ?? previousSpot;
      const previousGuaranteed =
        guaranteedOf(olds?.guaranteed ?? output?.guaranteed)?.minDuration ?? "";
      const nextGuaranteed =
        guaranteedOf(news.guaranteed ?? olds?.guaranteed ?? output?.guaranteed)
          ?.minDuration ?? previousGuaranteed;
      const previousQueueing = queueingKey(
        queueingOf(olds?.queueingPolicy ?? output?.queueingPolicy),
      );
      const nextQueueing = queueingKey(
        queueingOf(
          news.queueingPolicy ?? olds?.queueingPolicy ?? output?.queueingPolicy,
        ),
      );

      return replaceOnIdentity({
        previousId,
        nextId,
        previousLocation,
        nextLocation,
        extra:
          previousReservation !== nextReservation ||
          previousSpot !== nextSpot ||
          previousGuaranteed !== nextGuaranteed ||
          previousQueueing !== nextQueueing ||
          specIdentityChanged(olds ?? output, news, parent),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const queuedResourceId = yield* toPhysicalId(
        id,
        olds?.queuedResourceId,
        output?.queuedResourceId,
      );
      const location = normalizeLocation(olds?.location ?? output?.location);
      const name =
        output?.name ?? resourceName(env.project, location, queuedResourceId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const nested = nestedOwnershipLabels(existing);
      return (yield* hasAlchemyLabels(id, nested)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* tpu.listProjectsLocationsQueuedResources
          .pages({
            parent: `projects/${env.project}/locations/-`,
            pageSize: 1000,
          })
          .pipe(
            Stream.flatMap((page) =>
              Stream.fromIterable(page.queuedResources ?? []),
            ),
            Stream.filter(
              (resource) =>
                !isPlaceholder(resource) && hasNestedOwnership(resource),
            ),
            Stream.map((resource) => toAttrs(resource, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () => Effect.succeed([])),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const queuedResourceId = yield* toPhysicalId(
        id,
        news.queuedResourceId,
        output?.queuedResourceId,
      );
      const location = normalizeLocation(news.location ?? output?.location);
      const parent = parentOf(env.project, location);
      const name = resourceName(env.project, location, queuedResourceId);
      const desiredLabels = yield* createInternalLabels(id);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* tpu
          .createProjectsLocationsQueuedResources({
            parent,
            queuedResourceId,
            body: {
              reservationName: news.reservationName,
              spot: news.spot === true ? {} : undefined,
              guaranteed: news.guaranteed,
              queueingPolicy: news.queueingPolicy,
              tpu: { nodeSpec: desiredSpecs(news, parent, desiredLabels) },
            },
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

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output, olds }) {
      const force = olds?.forceDestroy !== false;
      const operation = yield* tpu
        .deleteProjectsLocationsQueuedResources({
          name: output.name,
          force,
        })
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
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
