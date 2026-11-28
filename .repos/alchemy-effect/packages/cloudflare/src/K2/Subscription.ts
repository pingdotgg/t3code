import * as k2 from "@distilled.cloud/cloudflare/k2";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import type { Providers } from "../Providers.ts";
import type { StartAt } from "./K2Types.ts";
import type { Stream } from "./Stream.ts";

const SubscriptionTypeId = "Cloudflare.K2.Subscription" as const;
type SubscriptionTypeId = typeof SubscriptionTypeId;

export interface SubscriptionProps {
  /**
   * The stream to read from: a `Cloudflare.K2.Stream` resource (orders the
   * subscription after the stream) or a stream ID. Changing it replaces the
   * subscription.
   */
  stream: string | Stream<any>;
  /**
   * Name of the subscription: 1 to 128 letters, numbers, underscores, or
   * hyphens, unique within the stream (not case-sensitive). If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the subscription.
   * @default ${app}-${id}-${stage}-${suffix}
   */
  name?: string;
  /**
   * Where the subscription starts reading: `earliest` from the oldest
   * retained record, `latest` from after the newest one. Changing it
   * replaces the subscription.
   * @default "latest"
   */
  startAt?: StartAt;
}

export interface SubscriptionAttributes {
  /** The subscription ID. */
  subscriptionId: string;
  /** The subscription name (unique within the stream). */
  subscriptionName: string;
  /** ID of the stream the subscription reads from. */
  streamId: string;
  /** Where the subscription started reading. */
  startAt: StartAt;
  /** When the subscription was created. */
  createdAt: string;
  /** When the subscription was last modified. */
  modifiedAt: string;
}

export type Subscription = Resource<
  SubscriptionTypeId,
  SubscriptionProps,
  SubscriptionAttributes,
  never,
  Providers
>;

/**
 * A K2 subscription — a named read position on a {@link Stream}. Consumers
 * lease batches of records from a subscription, then acknowledge them to
 * advance it. Every subscription on a stream reads every record
 * independently; consumers sharing one subscription compete for batches.
 *
 * Subscriptions are immutable: changing the stream, name, or start position
 * replaces the subscription.
 * ### Creating a Subscription
 * **Example:** Read new records
 * ```typescript
 * const orders = yield* Cloudflare.K2.Stream("Orders");
 * const analytics = yield* Cloudflare.K2.Subscription("Analytics", {
 *   stream: orders,
 * });
 * ```
 *
 * **Example:** Read from the oldest retained record
 * ```typescript
 * const backfill = yield* Cloudflare.K2.Subscription("Backfill", {
 *   stream: orders,
 *   startAt: "earliest",
 * });
 * ```
 *
 * ### Pulling Records
 * **Example:** Lease, process, and acknowledge a batch
 * ```typescript
 * const inbox = yield* Cloudflare.K2.ReadSubscription(analytics);
 * const batch = yield* inbox.consume({ workerId: "worker-1", maxRecords: 100 });
 * if (Option.isSome(batch)) {
 *   yield* Effect.forEach(batch.value.records, handle);
 *   yield* inbox.ack(batch.value);
 * }
 * ```
 *
 * @resource
 * @product K2
 * @category Storage & Databases
 */
export const Subscription = Resource<Subscription>(SubscriptionTypeId);

/** Returns true if the given value is a K2 Subscription resource. */
export const isSubscription = (value: unknown): value is Subscription =>
  Predicate.hasProperty(value, "Type") && value.Type === SubscriptionTypeId;

export const SubscriptionProvider = () =>
  Provider.succeed(Subscription, {
    stables: ["subscriptionId", "subscriptionName", "streamId", "startAt", "createdAt"],

    diff: Effect.fn(function* ({ id, olds, news, output }) {
      if (!isResolved(news)) return undefined;
      const oldName = output?.subscriptionName ?? (yield* subscriptionName(id, olds?.name));
      const newName = news.name ?? oldName;
      const oldStartAt = output?.startAt ?? olds?.startAt ?? "latest";
      const streamChanged =
        (output?.streamId ?? streamIdOf(olds?.stream)) !== streamIdOf(news.stream);
      if (
        streamChanged ||
        newName.toLowerCase() !== oldName.toLowerCase() ||
        (news.startAt ?? "latest") !== oldStartAt
      ) {
        // An explicit name is reused by the replacement; K2 rejects the same
        // name with different settings, so delete the old one first.
        return {
          action: "replace",
          deleteFirst: news.name !== undefined && !streamChanged,
        } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, output, olds, previous }) {
      const streamId = output?.streamId ?? streamIdOf(olds?.stream);
      if (!streamId) return undefined;
      if (output?.subscriptionId) {
        const observed = yield* getSubscription(streamId, output.subscriptionId);
        if (observed) return toAttributes(observed, streamId);
      }
      const name = yield* subscriptionName(id, olds?.name);
      const match = yield* findSubscriptionByName(streamId, name);
      if (match) {
        const attrs = toAttributes(match, streamId);
        // The generation a replacement is replacing is ours.
        return olds?.name !== undefined && attrs.subscriptionId !== previous?.subscriptionId
          ? Unowned(attrs)
          : attrs;
      }
      return undefined;
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const streamId = streamIdOf(news.stream);
      if (streamId === undefined) {
        return yield* new SubscriptionStreamUnresolved({
          message: "`stream` did not resolve to a stream ID",
        });
      }
      const name =
        output?.streamId === streamId
          ? output.subscriptionName
          : yield* subscriptionName(id, news.name);
      const startAt = news.startAt ?? "latest";

      // Observe — the cached id is only valid on the same stream.
      let observed =
        output?.subscriptionId && output.streamId === streamId
          ? yield* getSubscription(streamId, output.subscriptionId)
          : undefined;

      // Ensure — creating with the same name and settings returns the
      // existing subscription's id, so a lost state write converges here.
      if (!observed) {
        const created = yield* k2.createSubscription({
          streamId,
          name,
          startAt: { type: startAt },
        });
        observed = yield* k2.getSubscription({ streamId, subscriptionId: created.id });
      }

      // Subscriptions have no mutable settings; every change is a replace.
      return toAttributes(observed, streamId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* k2
        .deleteSubscription({
          streamId: output.streamId,
          subscriptionId: output.subscriptionId,
        })
        .pipe(Effect.catchTag(["K2SubscriptionNotFound", "K2StreamNotFound"], () => Effect.void));
    }),
  });

interface ObservedSubscription {
  id: string;
  name: string;
  startAt: k2.SubscriptionStartAt;
  createdAt: string;
  modifiedAt: string;
}

const subscriptionName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    if (name) return name;
    const generated = yield* createPhysicalName({ id, maxLength: 128 });
    return generated.replaceAll(/[^a-zA-Z0-9_-]/g, "-");
  });

/** The `stream` prop did not resolve to a stream ID. */
export class SubscriptionStreamUnresolved extends Data.TaggedError(
  "K2SubscriptionStreamUnresolved",
)<{ message: string }> {}

/**
 * The stream ID behind a `stream` prop: the string itself, or the `streamId`
 * attribute of a resolved `Cloudflare.K2.Stream`.
 */
const streamIdOf = (stream: unknown): string | undefined =>
  typeof stream === "string"
    ? stream
    : stream !== null &&
        typeof stream === "object" &&
        typeof (stream as { streamId?: unknown }).streamId === "string"
      ? (stream as { streamId: string }).streamId
      : undefined;

const getSubscription = (streamId: string, subscriptionId: string) =>
  k2.getSubscription({ streamId, subscriptionId }).pipe(
    Effect.map((s): ObservedSubscription | undefined => s),
    Effect.catchTag(["K2SubscriptionNotFound", "K2StreamNotFound"], () => Effect.undefined),
  );

/** `listSubscriptions` filters by name server-side (at most one match). */
const findSubscriptionByName = (streamId: string, name: string) =>
  k2.listSubscriptions({ streamId, name }).pipe(
    Effect.map((subs): ObservedSubscription | undefined =>
      subs.find((s) => s.name.toLowerCase() === name.toLowerCase()),
    ),
    Effect.catchTag("K2StreamNotFound", () => Effect.undefined),
  );

const toAttributes = (
  observed: ObservedSubscription,
  streamId: string,
): SubscriptionAttributes => ({
  subscriptionId: observed.id,
  subscriptionName: observed.name,
  streamId,
  startAt: observed.startAt.type === "earliest" ? "earliest" : "latest",
  createdAt: observed.createdAt,
  modifiedAt: observed.modifiedAt,
});
