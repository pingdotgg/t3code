import * as queues from "@distilled.cloud/cloudflare/queues";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Effectable from "effect/Effectable";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import type { PropsInput } from "../../Input.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import {
  isResourceOfType,
  Resource,
  type ResourceClass,
} from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import type { Model } from "../AI/Model.ts";
import type { Variant } from "../Images/Variant.ts";
import type { Namespace } from "../KV/Namespace.ts";
import type { Bucket } from "../R2/Bucket.ts";
import type { SuperSlurperJob } from "../R2/SuperSlurperJob.ts";
import type { Index } from "../Vectorize/VectorizeIndex.ts";
import type { Worker } from "../Workers/Worker.ts";
import type {
  WorkflowBinding,
  WorkflowResource,
} from "../Workflows/Workflow.ts";

const TypeId = "Cloudflare.Queues.Subscription" as const;
type TypeId = typeof TypeId;

/**
 * The Cloudflare product whose events the subscription delivers into the
 * Queue. Cloudflare allows a single subscription per source per account,
 * and the source is fixed at creation — changing it triggers a
 * replacement.
 */
export type SubscriptionSource =
  | {
      /** Cloudflare Images events. */
      type: "images";
    }
  | {
      /** Workers KV namespace events. */
      type: "kv";
    }
  | {
      /** R2 bucket events. */
      type: "r2";
    }
  | {
      /** Super Slurper migration events. */
      type: "superSlurper";
    }
  | {
      /** Vectorize index events. */
      type: "vectorize";
    }
  | {
      /** Workers AI model events for a specific model. */
      type: "workersAi.model";
      /** Name of the Workers AI model to subscribe to. */
      modelName: string;
    }
  | {
      /** Workers Builds events for a specific Worker. */
      type: "workersBuilds.worker";
      /** Name of the Worker whose build events to subscribe to. */
      workerName: string;
    }
  | {
      /** Workflows events for a specific workflow. */
      type: "workflows.workflow";
      /** Name of the workflow to subscribe to. */
      workflowName: string;
    };

export type SubscriptionProps = {
  /**
   * Human readable name of the subscription. If omitted, a unique name is
   * generated from the app, stage, and logical ID.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * The event source to subscribe to (e.g. `{ type: "r2" }` for R2 bucket
   * events). The constructor also accepts Workflow bindings and supported
   * Cloudflare resources or yielded `.ref(...)` references. Images variants,
   * KV namespaces, R2 buckets, Super Slurper jobs, and Vectorize indexes select
   * all events of that product in the account, not just the supplied resource.
   * Models, Workers, and Workflows select their deferred physical names.
   * References read persisted state without owning their sources.
   * Fixed at creation — changing it triggers a replacement. Cloudflare
   * allows at most one subscription per source per account.
   */
  source: SubscriptionSource;
  /**
   * Account of a resource source, captured by the constructor. Resource sources
   * must belong to the subscription's ambient Cloudflare account.
   */
  sourceAccountId?: string;
  /**
   * Event types to deliver, scoped to the source (e.g. `bucket.created`
   * and `bucket.deleted` for the `r2` source, `namespace.created` for
   * `kv`). Must contain at least one event type valid for the source.
   */
  events: string[];
  /**
   * The ID of the Queue that receives the events
   * (the destination, e.g. `queue.queueId`).
   */
  queueId: string;
  /**
   * Whether the subscription is active.
   * @default true
   */
  enabled?: boolean;
};

export type SubscriptionAttributes = {
  /**
   * Unique identifier for the subscription.
   */
  subscriptionId: string;
  /**
   * The Cloudflare account the subscription belongs to.
   */
  accountId: string;
  /**
   * Human readable name of the subscription.
   */
  name: string;
  /**
   * The event source the subscription listens to.
   */
  source: SubscriptionSource;
  /**
   * Event types delivered by this subscription.
   */
  events: string[];
  /**
   * The ID of the destination Queue.
   */
  queueId: string;
  /**
   * Whether the subscription is active.
   */
  enabled: boolean;
  /**
   * When the subscription was created.
   */
  createdAt: string;
  /**
   * When the subscription was last modified.
   */
  modifiedAt: string;
};

export type Subscription = Resource<
  TypeId,
  SubscriptionProps,
  SubscriptionAttributes,
  never,
  Providers
>;

/** Resources whose product events can be delivered to a Queue. */
export type SubscriptionResourceSource =
  | WorkflowResource
  | Variant
  | Namespace
  | Bucket
  | SuperSlurperJob
  | Index
  | Model
  | Worker;

/** Constructor inputs; resource sources are normalized before registration. */
export type SubscriptionInput = Omit<
  PropsInput<SubscriptionProps>,
  "source" | "sourceAccountId"
> & {
  /** An explicit source, Workflow binding, resource, or yielded resource reference. */
  source:
    | PropsInput<SubscriptionProps>["source"]
    | WorkflowBinding
    | SubscriptionResourceSource;
};

type SubscriptionConstructor<Req = never> = {
  Type: TypeId;
  Props: SubscriptionProps;
  <const Methods extends Record<string, any>>(
    methods: Methods,
  ): SubscriptionClass & Methods;
  (
    id: string,
    props: SubscriptionInput,
  ): Effect.Effect<Subscription, never, Req>;
  <PropsReq = never>(
    id: string,
    props: Effect.Effect<SubscriptionInput, never, PropsReq>,
  ): Effect.Effect<Subscription, never, PropsReq | Req>;
};

type SubscriptionClass = SubscriptionConstructor<Providers> &
  Effect.Effect<SubscriptionConstructor> &
  Pick<ResourceClass<Subscription>, "Self" | "Provider" | "Aliases" | "ref">;

const SubscriptionResource = Resource<Subscription>(TypeId, {
  aliases: ["Cloudflare.Queue.Subscription"],
});

const isSourceResource = <Type extends SubscriptionResourceSource["Type"]>(
  source: SubscriptionInput["source"],
  type: Type,
): source is Extract<SubscriptionResourceSource, { Type: Type }> =>
  isResourceOfType(source, type);

const isWorkflowBinding = (
  source: SubscriptionInput["source"],
): source is WorkflowBinding =>
  typeof source === "object" &&
  source !== null &&
  (source as WorkflowBinding).kind === "Cloudflare.Workflow";

const normalizeSubscriptionProps = (
  props: SubscriptionInput,
): PropsInput<SubscriptionProps> => {
  const source = props.source;
  // Resource references are Output proxies; inspect their type before binding fields.
  if (isSourceResource(source, "Cloudflare.Workflow")) {
    return {
      ...props,
      sourceAccountId: source.accountId,
      source: { type: "workflows.workflow", workflowName: source.workflowName },
    };
  }
  if (isSourceResource(source, "Cloudflare.Worker")) {
    return {
      ...props,
      sourceAccountId: source.accountId,
      source: { type: "workersBuilds.worker", workerName: source.workerName },
    };
  }
  if (isSourceResource(source, "Cloudflare.AI.Model")) {
    return {
      ...props,
      sourceAccountId: source.accountId,
      source: { type: "workersAi.model", modelName: source.modelName },
    };
  }
  if (isSourceResource(source, "Cloudflare.Images.Variant")) {
    return {
      ...props,
      sourceAccountId: source.accountId,
      source: { type: "images" },
    };
  }
  if (isSourceResource(source, "Cloudflare.KV.Namespace")) {
    return {
      ...props,
      sourceAccountId: source.accountId,
      source: { type: "kv" },
    };
  }
  if (isSourceResource(source, "Cloudflare.R2.Bucket")) {
    return {
      ...props,
      sourceAccountId: source.accountId,
      source: { type: "r2" },
    };
  }
  if (isSourceResource(source, "Cloudflare.R2.SuperSlurperJob")) {
    return {
      ...props,
      sourceAccountId: source.accountId,
      source: { type: "superSlurper" },
    };
  }
  if (isSourceResource(source, "Cloudflare.VectorizeIndex")) {
    return {
      ...props,
      sourceAccountId: source.accountId,
      source: { type: "vectorize" },
    };
  }
  if (isWorkflowBinding(source)) {
    return {
      ...props,
      source: { type: "workflows.workflow", workflowName: source.workflowName },
    };
  }
  return { ...props, source };
};

/** A resource source cannot select events in a different Cloudflare account. */
export class SubscriptionSourceAccountMismatch extends Data.TaggedError(
  "SubscriptionSourceAccountMismatch",
)<{ readonly accountId: string; readonly sourceAccountId: string }> {}

const validateSourceAccount = (accountId: string, sourceAccountId?: string) =>
  sourceAccountId !== undefined && sourceAccountId !== accountId
    ? Effect.fail(
        new SubscriptionSourceAccountMismatch({ accountId, sourceAccountId }),
      )
    : Effect.void;

/**
 * A Cloudflare Queues event subscription — delivers platform events
 * (R2 bucket events, KV namespace events, Workers Builds, Workflows,
 * etc.) into a Queue as messages.
 *
 * The `source` selects which product emits the events and is fixed at
 * creation (changing it replaces the subscription). `name`, `events`,
 * `enabled`, and the destination `queueId` are all mutable in place.
 * Cloudflare allows at most one subscription per source per account.
 * ### Creating a Subscription
 * **Example:** R2 bucket events into a Queue
 * ```typescript
 * const queue = yield* Cloudflare.Queues.Queue("EventsQueue");
 *
 * const subscription = yield* Cloudflare.Queues.Subscription("R2Events", {
 *   source: { type: "r2" },
 *   events: ["bucket.created", "bucket.deleted"],
 *   queueId: queue.queueId,
 * });
 * ```
 *
 * **Example:** KV namespace events with an explicit name
 * ```typescript
 * const subscription = yield* Cloudflare.Queues.Subscription("KvEvents", {
 *   name: "kv-events",
 *   source: { type: "kv" },
 *   events: ["namespace.created"],
 *   queueId: queue.queueId,
 * });
 * ```
 *
 * **Example:** Workers Builds events for one Worker
 * ```typescript
 * const subscription = yield* Cloudflare.Queues.Subscription("BuildEvents", {
 *   source: { type: "workersBuilds.worker", workerName: "my-worker" },
 *   events: ["build.started", "build.succeeded"],
 *   queueId: queue.queueId,
 * });
 * ```
 *
 * **Example:** Workflow lifecycle events, from a Workflow bound in this stack
 * Pass the Workflow binding from the host Worker's `env` directly. Its
 * physical name remains an `Output`, so the subscription works on the
 * Workflow's first deployment and follows later renames. Only the source
 * type and physical workflow name are persisted, not the binding metadata.
 * ```typescript
 * const worker = yield* Cloudflare.Worker("Worker", {
 *   main: "./src/worker.ts",
 *   env: { INGESTION: Cloudflare.Workflow("Ingestion", { className: "IngestionWorkflow" }) },
 * });
 *
 * const subscription = yield* Cloudflare.Queues.Subscription("WorkflowEvents", {
 *   source: worker.env.INGESTION,
 *   events: ["instance.completed", "instance.errored"],
 *   queueId: queue.queueId,
 * });
 * ```
 *
 * **Example:** Workflow lifecycle events from a persisted resource reference
 * Use the logical resource ID, including any namespace. References read
 * persisted state, so deploy the host first. Omitting the options uses the
 * current stack and stage; the reference does not take ownership of the host.
 * ```typescript
 * const subscription = yield* Cloudflare.Queues.Subscription("WorkflowEvents", {
 *   source: yield* Cloudflare.Workflow.ref("Ingestion", {
 *     stack: "workflow-host",
 *     stage: "production",
 *   }),
 *   events: ["instance.completed", "instance.errored"],
 *   queueId: queue.queueId,
 * });
 * ```
 *
 * **Example:** Workflow lifecycle events by an existing physical name
 * ```typescript
 * const subscription = yield* Cloudflare.Queues.Subscription("WorkflowEvents", {
 *   source: { type: "workflows.workflow", workflowName: "existing-ingestion" },
 *   events: ["instance.completed", "instance.errored"],
 *   queueId: queue.queueId,
 * });
 * ```
 *
 * ### Resource and Reference Sources
 * **Example:** Account-wide KV events from a namespace
 * ```typescript
 * const namespace = yield* Cloudflare.KV.Namespace("Cache");
 * yield* Cloudflare.Queues.Subscription("NamespaceEvents", {
 *   source: namespace,
 *   events: ["namespace.created", "namespace.deleted"],
 *   queueId: queue.queueId,
 * });
 * ```
 * KV, R2, Images, Vectorize, and Super Slurper sources are account-wide.
 * Passing a resource retains its account and deployment dependency, but does
 * not filter events to that resource. The subscription can miss the source's
 * initial creation or final deletion because it depends on that source.
 * Use an explicit product descriptor when the subscription must exist first.
 *
 * **Example:** R2 bucket reference from another stack
 * ```typescript
 * yield* Cloudflare.Queues.Subscription("BucketEvents", {
 *   source: yield* Cloudflare.R2.Bucket.ref("Uploads", {
 *     stack: "storage",
 *     stage: "production",
 *   }),
 *   events: ["bucket.created", "bucket.deleted"],
 *   queueId: queue.queueId,
 * });
 * ```
 * All resource forms accept yielded `.ref` references with optional stack
 * and stage selectors. The referenced resource must already be deployed in
 * the same Cloudflare account. Removing a subscription does not remove its
 * referenced resource.
 *
 * **Example:** Images upload events from a variant reference
 * ```typescript
 * yield* Cloudflare.Queues.Subscription("ImageEvents", {
 *   source: yield* Cloudflare.Images.Variant.ref("Thumbnail"),
 *   events: ["image.uploaded"],
 *   queueId: queue.queueId,
 * });
 * ```
 * The variant selects its Images account; uploads are not filtered by variant.
 *
 * **Example:** Vectorize index events
 * ```typescript
 * yield* Cloudflare.Queues.Subscription("IndexEvents", {
 *   source: yield* Cloudflare.Vectorize.Index.ref("Search"),
 *   events: ["index.created", "index.deleted"],
 *   queueId: queue.queueId,
 * });
 * ```
 *
 * **Example:** Super Slurper migration events
 * ```typescript
 * yield* Cloudflare.Queues.Subscription("MigrationEvents", {
 *   source: yield* Cloudflare.R2.SuperSlurperJob.ref("Migration"),
 *   events: ["job.completed", "job.aborted"],
 *   queueId: queue.queueId,
 * });
 * ```
 * This selects all migration jobs in the account, not one job's objects.
 *
 * **Example:** Workers AI batch events
 * ```typescript
 * const model = yield* Cloudflare.AI.Model("Embeddings", {
 *   modelName: "@cf/baai/bge-m3",
 * });
 * yield* Cloudflare.Queues.Subscription("BatchEvents", {
 *   source: model,
 *   events: ["batch.queued", "batch.succeeded", "batch.failed"],
 *   queueId: queue.queueId,
 * });
 * ```
 * The model is a non-owning catalog handle. These events require asynchronous
 * batch inference; ordinary synchronous inference does not emit them.
 *
 * **Example:** Workers Builds events from a Worker reference
 * ```typescript
 * yield* Cloudflare.Queues.Subscription("BuildEvents", {
 *   source: yield* Cloudflare.Worker.ref("Website"),
 *   events: ["build.started", "build.succeeded", "build.failed"],
 *   queueId: queue.queueId,
 * });
 * ```
 * The Worker must have a Workers Builds integration to emit build events.
 * An ordinary Alchemy Worker upload is not a Workers Builds run.
 *
 * Event delivery can lag subscription creation or replacement even after the
 * destination Queue accepts messages. Deployment confirms configuration, not
 * delivery readiness; verify delivery before emitting events that must be observed.
 * During Vectorize subscription replacement or a destination Queue update,
 * Cloudflare can still route new events to the previous Queue. Replacement events
 * can carry the deleted subscription's ID; updates retain the same subscription ID.
 * A single early event does not prove that routing has fully propagated. Keep the
 * previous destination available during the transition and verify the receiving
 * Queue, `metadata.eventSubscriptionId`, and the event's resource identity.
 *
 * ### Pausing delivery
 * **Example:** Disable a subscription without deleting it
 * ```typescript
 * const subscription = yield* Cloudflare.Queues.Subscription("R2Events", {
 *   source: { type: "r2" },
 *   events: ["bucket.created"],
 *   queueId: queue.queueId,
 *   enabled: false,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/queues/event-subscriptions/
 *
 * @resource
 * @product Queues
 * @category Storage & Databases
 */
export const Subscription: SubscriptionClass = Object.assign(
  (
    ...args:
      | [
          id: string,
          props:
            | SubscriptionInput
            | Effect.Effect<SubscriptionInput, never, any>,
        ]
      | [methods: Record<string, any>]
  ) => {
    if (typeof args[0] === "object") {
      return Object.assign(Subscription, args[0]);
    }
    const [id, props] = args as [
      string,
      SubscriptionInput | Effect.Effect<SubscriptionInput, never, any>,
    ];
    // Resource supplies Self while evaluating Effect-valued props.
    return Effect.isEffect(props)
      ? SubscriptionResource(id, Effect.map(props, normalizeSubscriptionProps))
      : SubscriptionResource(id, normalizeSubscriptionProps(props));
  },
  SubscriptionResource,
  Effectable.Prototype({
    label: `Resource<${TypeId}>`,
    evaluate: (): Effect.Effect<SubscriptionConstructor> =>
      Effect.succeed(Subscription),
  }),
) as SubscriptionClass;

/**
 * Returns true if the given value is a Subscription resource.
 */
export const isSubscription = (value: unknown): value is Subscription =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const SubscriptionProvider = () =>
  Provider.succeed(SubscriptionResource, {
    stables: ["subscriptionId", "accountId", "source", "createdAt"],
    diff: Effect.fn(function* ({ olds, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (isResolved(news)) {
        yield* validateSourceAccount(accountId, news.sourceAccountId);
      }
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace" } as const;
      }
      // An unresolved immutable source may change with its upstream resource.
      // Delete first in case it resolves to the same account-unique source.
      if (!("source" in news) || !isResolved(news.source)) {
        return { action: "replace", deleteFirst: true } as const;
      }
      // The source is fixed at creation.
      const oldSource = output?.source ?? olds?.source;
      if (oldSource && !sameSource(oldSource, news.source)) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ id, output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (!output) {
        yield* validateSourceAccount(accountId, olds?.sourceAccountId);
      }
      const acct = output?.accountId ?? accountId;

      if (output?.subscriptionId) {
        const observed = yield* getSubscriptionOrUndefined(
          acct,
          output.subscriptionId,
        );
        return observed ? toAttributes(observed, acct) : undefined;
      }
      // Cold read — recover from lost state by matching the deterministic
      // physical name. Names are not enforced unique server-side; an exact
      // match on our generated/explicit name is the best identity we have.
      const name = yield* createSubscriptionName(id, olds?.name);
      const match = yield* findByName(acct, name);
      if (!match) return undefined;
      const attributes = toAttributes(match, acct);
      return olds?.name !== undefined ? Unowned(attributes) : attributes;
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      yield* validateSourceAccount(accountId, news.sourceAccountId);
      const acct = output?.accountId ?? accountId;
      const name = yield* createSubscriptionName(id, news.name);

      // Observe — the subscriptionId cached on `output` is a hint, not a
      // guarantee: a missing subscription falls through to create.
      let observed = output?.subscriptionId
        ? yield* getSubscriptionOrUndefined(acct, output.subscriptionId)
        : undefined;

      // A source collision does not establish ownership of the existing subscription.
      if (!observed) {
        observed = yield* queues.createSubscription({
          accountId: acct,
          name,
          enabled: news.enabled ?? true,
          events: news.events,
          source: news.source,
          destination: { type: "queues.queue", queueId: news.queueId },
        });
      }

      // Sync — diff observed cloud state against desired and patch only
      // the delta; skip the API call entirely on a no-op.
      const desired = {
        name,
        enabled: news.enabled ?? true,
        events: news.events,
        queueId: news.queueId,
      };
      const dirty =
        observed.name !== desired.name ||
        observed.enabled !== desired.enabled ||
        observed.destination.queueId !== desired.queueId ||
        !sameEvents(observed.events, desired.events);

      const final = dirty
        ? yield* queues.patchSubscription({
            accountId: acct,
            subscriptionId: observed.id,
            name: desired.name,
            enabled: desired.enabled,
            events: desired.events,
            destination: { type: "queues.queue", queueId: desired.queueId },
          })
        : observed;

      return toAttributes(final, acct);
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* queues
        .deleteSubscription({
          accountId: output.accountId,
          subscriptionId: output.subscriptionId,
        })
        .pipe(Effect.catchTag("SubscriptionNotFound", () => Effect.void));
    }),
    // Account collection — subscriptions are account-scoped. Exhaustively
    // paginate `listSubscriptions` (response array is `result`) and hydrate
    // each row into the same Attributes shape `read` returns.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      return yield* queues.listSubscriptions.pages({ accountId }).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) =>
            (page.result ?? []).map((sub) => toAttributes(sub, accountId)),
          ),
        ),
      );
    }),
  });

type ObservedSubscription =
  | queues.GetSubscriptionResponse
  | queues.CreateSubscriptionResponse
  | queues.PatchSubscriptionResponse;

/**
 * Read a subscription by ID, mapping "gone" (`SubscriptionNotFound`,
 * HTTP 404 "No subscription with this ID") to `undefined`.
 */
const getSubscriptionOrUndefined = (
  accountId: string,
  subscriptionId: string,
) =>
  queues
    .getSubscription({ accountId, subscriptionId })
    .pipe(
      Effect.catchTag("SubscriptionNotFound", () => Effect.succeed(undefined)),
    );

/**
 * Find a subscription by exact name. Cloudflare's list endpoint has no
 * name filter, so scan the paginated stream.
 */
const findByName = (accountId: string, name: string) =>
  queues.listSubscriptions.items({ accountId }).pipe(
    Stream.filter((s) => s.name === name),
    Stream.runHead,
    Effect.map(Option.getOrUndefined),
  );

const createSubscriptionName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return name ?? (yield* createPhysicalName({ id, lowercase: true }));
  });

/**
 * The wire shape of a subscription source — a flattened view of the
 * response union (only the member matching `type` carries its name field).
 */
type WireSource = {
  type?: string | null;
  modelName?: string | null;
  workerName?: string | null;
  workflowName?: string | null;
};

const toSource = (wire: unknown): SubscriptionSource => {
  const source = wire as WireSource;
  switch (source.type) {
    case "workersAi.model":
      return { type: "workersAi.model", modelName: source.modelName ?? "" };
    case "workersBuilds.worker":
      return {
        type: "workersBuilds.worker",
        workerName: source.workerName ?? "",
      };
    case "workflows.workflow":
      return {
        type: "workflows.workflow",
        workflowName: source.workflowName ?? "",
      };
    case "images":
    case "kv":
    case "r2":
    case "superSlurper":
    case "vectorize":
      return { type: source.type };
    default:
      // Unknown/new source types added server-side: surface the raw type
      // so diff treats it as a foreign source rather than crashing.
      return { type: source.type as never };
  }
};

const sameSource = (a: SubscriptionSource, b: SubscriptionSource): boolean => {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case "workersAi.model":
      return a.modelName === (b as { modelName?: string }).modelName;
    case "workersBuilds.worker":
      return a.workerName === (b as { workerName?: string }).workerName;
    case "workflows.workflow":
      return a.workflowName === (b as { workflowName?: string }).workflowName;
    default:
      return true;
  }
};

const sameEvents = (observed: readonly string[], desired: readonly string[]) =>
  observed.length === desired.length &&
  [...observed].sort().join(",") === [...desired].sort().join(",");

const toAttributes = (
  subscription: ObservedSubscription,
  accountId: string,
): SubscriptionAttributes => ({
  subscriptionId: subscription.id,
  accountId,
  name: subscription.name,
  source: toSource(subscription.source),
  events: [...subscription.events],
  queueId: subscription.destination.queueId,
  enabled: subscription.enabled,
  createdAt: subscription.createdAt,
  modifiedAt: subscription.modifiedAt,
});
