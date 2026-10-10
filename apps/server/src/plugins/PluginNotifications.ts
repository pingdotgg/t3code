/**
 * Notifications sent by plugins with the `notifications` capability, shown by
 * clients as toasts.
 *
 * Delivery is best-effort and in memory only. The server retains the last
 * `PLUGIN_NOTIFICATION_MAX_RETAINED` notifications for `retentionMillis`, and
 * that retained set is the whole state: every frame carries it, so a client
 * that reconnects sees what it missed and drops what was removed meanwhile.
 * A notification leaves the set when it expires, when newer ones evict it, or
 * when its plugin's process stops (disable, remove, crash). A server restart
 * starts a new epoch with nothing retained.
 *
 * Every notification fits `PLUGIN_NOTIFICATION_MAX_ENCODED_BYTES`, so a whole
 * frame stays within `PLUGIN_NOTIFICATION_FRAME_MAX_BYTES` whatever plugins send.
 */
import {
  PLUGIN_NOTIFICATION_BODY_MAX_LENGTH,
  PLUGIN_NOTIFICATION_MAX_ENCODED_BYTES,
  PLUGIN_NOTIFICATION_MAX_RETAINED,
  PLUGIN_NOTIFICATION_TITLE_MAX_LENGTH,
  PLUGIN_NOTIFICATIONS_CAPABILITY,
  type PluginNotification,
  type PluginNotificationFrame,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { normalizeContributionStatusText } from "@t3tools/provider-core/server/ContributionStatusStore";
import { subscribeBeforeSnapshot } from "../utils/subscribeBeforeSnapshot.ts";
import * as PluginSupervisor from "./PluginSupervisor.ts";
import { makeTokenBucket } from "./pluginTokenBucket.ts";

/**
 * Retention covers a short disconnect, not history; it is elapsed time, so a
 * wall clock change neither shortens nor extends it. Per plugin process,
 * `burst` notifications at once, then one per `refillMillis`. `threadIdMaxLength`
 * bounds the one identifier a plugin chooses.
 */
const PLUGIN_NOTIFICATION_LIMITS = {
  retained: PLUGIN_NOTIFICATION_MAX_RETAINED,
  retentionMillis: 2 * 60_000,
  burst: 5,
  refillMillis: 5_000,
  threadIdMaxLength: 128,
} as const;

const decodeShowInput = Schema.decodeUnknownEffect(
  Schema.Struct({
    title: Schema.String,
    body: Schema.optionalKey(Schema.String),
    tone: Schema.optionalKey(Schema.Literals(["neutral", "info", "success", "warning", "error"])),
    threadId: Schema.optionalKey(
      ThreadId.check(Schema.isMaxLength(PLUGIN_NOTIFICATION_LIMITS.threadIdMaxLength)),
    ),
  }),
);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
/** UTF-8 bytes of a notification's JSON, as a frame carries it. */
const encodedBytes = (notification: PluginNotification) =>
  Buffer.byteLength(encodeJson(notification));
/** Elapsed time, which a wall clock change does not move. */
const elapsedMillis = Effect.map(Clock.monotonicTimeNanos, (nanos) => Number(nanos / 1_000_000n));

interface Retained {
  readonly notification: PluginNotification;
  /** In `elapsedMillis`, not wall time. */
  readonly expiresAt: number;
  readonly lifetime: Scope.Scope;
}

interface Generation {
  readonly bucket: ReturnType<typeof makeTokenBucket>;
  closed: boolean;
}

export class PluginNotifications extends Context.Service<
  PluginNotifications,
  {
    /** The retained set now, then the whole set again after every change. */
    readonly subscribe: Stream.Stream<PluginNotificationFrame>;
  }
>()("t3/plugins/PluginNotifications") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.fn("PluginNotifications.make")(function* () {
  const supervisor = yield* PluginSupervisor.PluginSupervisor;
  const crypto = yield* Crypto.Crypto;
  const epoch = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
  // Every frame is the whole set, so a slow subscriber only skips intermediate ones.
  const changes = yield* PubSub.sliding<PluginNotificationFrame>(1);
  // Orders issue, removal and each subscriber's first frame against one another.
  const lock = yield* Semaphore.make(1);
  // Wakes the expiry loop after each send, so it always sleeps until the true next expiry.
  const retaining = yield* Queue.sliding<void>(1);
  const generations = new WeakMap<Scope.Scope, Generation>();
  let sequence = 0;
  let retained: ReadonlyArray<Retained> = [];

  const currentFrame = (): PluginNotificationFrame => ({
    epoch,
    notifications: retained.map((entry) => entry.notification),
  });

  /** Removes entries under the lock and publishes the set when any left. */
  const remove = (keep: (entry: Retained) => boolean) =>
    lock.withPermit(
      Effect.suspend(() => {
        const next = retained.filter(keep);
        if (next.length === retained.length) return Effect.void;
        retained = next;
        return PubSub.publish(changes, currentFrame());
      }),
    );

  // Entries expire in issue order, so the oldest is always the next to go.
  yield* Effect.forkScoped(
    Effect.forever(
      Effect.gen(function* () {
        const oldest = retained[0];
        if (oldest === undefined) return yield* Queue.take(retaining);
        const now = yield* elapsedMillis;
        if (oldest.expiresAt > now)
          return yield* Effect.raceFirst(
            Effect.sleep(oldest.expiresAt - now),
            Queue.take(retaining),
          );
        yield* remove((entry) => entry.expiresAt > now);
      }),
    ),
  );

  const generationOf = Effect.fnUntraced(function* (lifetime: Scope.Scope) {
    const existing = generations.get(lifetime);
    if (existing !== undefined) return existing;
    const generation: Generation = {
      bucket: makeTokenBucket(PLUGIN_NOTIFICATION_LIMITS),
      closed: false,
    };
    generations.set(lifetime, generation);
    yield* Scope.addFinalizer(
      lifetime,
      Effect.suspend(() => {
        generation.closed = true;
        return remove((entry) => entry.lifetime !== lifetime);
      }),
    );
    return generation;
  });

  const show: PluginSupervisor.PluginHostMethod = ({ registration, input, admitted, lifetime }) =>
    Effect.gen(function* () {
      if (!registration.manifest.capabilities.includes(PLUGIN_NOTIFICATIONS_CAPABILITY))
        return yield* new PluginSupervisor.PluginHostCallError({
          message: `The plugin did not declare the "${PLUGIN_NOTIFICATIONS_CAPABILITY}" capability.`,
        });
      const request = yield* decodeShowInput(input).pipe(
        Effect.mapError(
          () =>
            new PluginSupervisor.PluginHostCallError({
              message: `A notification needs a title string; body is a string; threadId is a string of at most ${PLUGIN_NOTIFICATION_LIMITS.threadIdMaxLength} characters; tone is neutral, info, success, warning or error.`,
            }),
        ),
      );
      const title = normalizeContributionStatusText(
        request.title,
        PLUGIN_NOTIFICATION_TITLE_MAX_LENGTH,
      );
      if (title.length === 0)
        return yield* new PluginSupervisor.PluginHostCallError({
          message: "The notification title is empty.",
        });
      const body =
        request.body === undefined
          ? ""
          : normalizeContributionStatusText(request.body, PLUGIN_NOTIFICATION_BODY_MAX_LENGTH);
      const record = (sequence: number, createdAt: number): PluginNotification => ({
        sequence,
        pluginId: registration.manifest.id,
        pluginName: registration.manifest.name,
        title,
        ...(body.length === 0 ? {} : { body }),
        ...(request.tone === undefined || request.tone === "neutral" ? {} : { tone: request.tone }),
        ...(request.threadId === undefined ? {} : { threadId: request.threadId }),
        createdAt: DateTime.formatIso(DateTime.makeUnsafe(createdAt)),
      });
      // Refused before it takes a token or a sequence. Measured with the widest
      // sequence (an ISO timestamp is fixed width), so the record sent is never larger.
      const widest = record(Number.MAX_SAFE_INTEGER, yield* Clock.currentTimeMillis);
      if (encodedBytes(widest) > PLUGIN_NOTIFICATION_MAX_ENCODED_BYTES)
        return yield* new PluginSupervisor.PluginHostCallError({
          message: `The notification is too large: at most ${PLUGIN_NOTIFICATION_MAX_ENCODED_BYTES} bytes encoded.`,
        });
      const generation = yield* generationOf(lifetime);
      if (!(yield* generation.bucket.take))
        return yield* new PluginSupervisor.PluginHostCallError({
          message: `Too many notifications: at most ${PLUGIN_NOTIFICATION_LIMITS.burst} at once, then one every ${PLUGIN_NOTIFICATION_LIMITS.refillMillis / 1000} seconds.`,
        });
      return yield* lock.withPermit(
        Effect.gen(function* () {
          // Checked under the lock, so a withdrawal never misses a notification it races.
          if (generation.closed)
            return yield* new PluginSupervisor.PluginHostCallError({
              message: "The plugin was stopped.",
            });
          yield* admitted;
          const now = yield* elapsedMillis;
          sequence += 1;
          retained = [
            ...retained,
            {
              notification: record(sequence, yield* Clock.currentTimeMillis),
              expiresAt: now + PLUGIN_NOTIFICATION_LIMITS.retentionMillis,
              lifetime,
            },
          ].slice(-PLUGIN_NOTIFICATION_LIMITS.retained);
          yield* PubSub.publish(changes, currentFrame());
          yield* Queue.offer(retaining, undefined);
          return null;
        }),
      );
    });

  yield* supervisor.serveHostMethod("notifications.show", show);

  return PluginNotifications.of({
    subscribe: Stream.unwrap(
      Effect.map(
        subscribeBeforeSnapshot(changes, Effect.sync(currentFrame), lock),
        ({ latest, changes }) => Stream.concat(Stream.make(latest), changes),
      ),
    ),
  });
});

export const layer = Layer.effect(PluginNotifications, make());
