import type {
  RelayWebPushPreferences,
  RelayWebPushRegistrationRequest,
} from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { and, eq } from "drizzle-orm";

import * as RelayDb from "../db.ts";
import { relayWebPushSubscriptions } from "../persistence/schema.ts";

export interface WebPushTarget {
  readonly userId: string;
  readonly subscriptionId: string;
  readonly endpoint: string;
  readonly expirationTime: number | null;
  readonly p256dh: string;
  readonly auth: string;
  readonly preferences: RelayWebPushPreferences;
}

export class WebPushSubscriptionPersistenceError extends Schema.TaggedErrorClass<WebPushSubscriptionPersistenceError>()(
  "WebPushSubscriptionPersistenceError",
  {
    operation: Schema.Literals(["register", "unregister", "list", "invalidate"]),
    userId: Schema.String,
    subscriptionId: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} Web Push subscription for ${this.userId}.`;
  }
}

export class WebPushSubscriptions extends Context.Service<
  WebPushSubscriptions,
  {
    readonly register: (input: {
      readonly userId: string;
      readonly registration: RelayWebPushRegistrationRequest;
    }) => Effect.Effect<void, WebPushSubscriptionPersistenceError>;
    readonly unregister: (input: {
      readonly userId: string;
      readonly subscriptionId: string;
    }) => Effect.Effect<void, WebPushSubscriptionPersistenceError>;
    readonly listForUser: (input: {
      readonly userId: string;
    }) => Effect.Effect<ReadonlyArray<WebPushTarget>, WebPushSubscriptionPersistenceError>;
    readonly invalidate: (input: {
      readonly userId: string;
      readonly subscriptionId: string;
    }) => Effect.Effect<void, WebPushSubscriptionPersistenceError>;
  }
>()("t3code-relay/agentActivity/WebPushSubscriptions") {}

export const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;

  const remove = Effect.fnUntraced(function* (input: {
    readonly operation: "unregister" | "invalidate";
    readonly userId: string;
    readonly subscriptionId: string;
  }) {
    yield* db
      .delete(relayWebPushSubscriptions)
      .where(
        and(
          eq(relayWebPushSubscriptions.userId, input.userId),
          eq(relayWebPushSubscriptions.subscriptionId, input.subscriptionId),
        ),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new WebPushSubscriptionPersistenceError({
              operation: input.operation,
              userId: input.userId,
              subscriptionId: input.subscriptionId,
              cause,
            }),
        ),
      );
  });

  return WebPushSubscriptions.of({
    register: Effect.fn("relay.web_push_subscriptions.register")(function* (input) {
      const registration = input.registration;
      const updatedAt = DateTime.formatIso(yield* DateTime.now);

      // A PushSubscription belongs to one browser profile. Conflict on its
      // globally unique endpoint so an account switch atomically transfers
      // ownership instead of continuing to notify the previous account.
      yield* db
        .insert(relayWebPushSubscriptions)
        .values({
          userId: input.userId,
          subscriptionId: registration.subscriptionId,
          label: registration.label,
          endpoint: registration.subscription.endpoint,
          expirationTime:
            registration.subscription.expirationTime === null
              ? null
              : String(registration.subscription.expirationTime),
          p256dh: registration.subscription.keys.p256dh,
          auth: registration.subscription.keys.auth,
          preferencesJson: registration.preferences,
          createdAt: updatedAt,
          updatedAt,
        })
        .onConflictDoUpdate({
          target: relayWebPushSubscriptions.endpoint,
          set: {
            userId: input.userId,
            subscriptionId: registration.subscriptionId,
            label: registration.label,
            endpoint: registration.subscription.endpoint,
            expirationTime:
              registration.subscription.expirationTime === null
                ? null
                : String(registration.subscription.expirationTime),
            p256dh: registration.subscription.keys.p256dh,
            auth: registration.subscription.keys.auth,
            preferencesJson: registration.preferences,
            updatedAt,
          },
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new WebPushSubscriptionPersistenceError({
                operation: "register",
                userId: input.userId,
                subscriptionId: registration.subscriptionId,
                cause,
              }),
          ),
        );
    }),
    unregister: (input) => remove({ operation: "unregister", ...input }),
    invalidate: (input) => remove({ operation: "invalidate", ...input }),
    listForUser: Effect.fn("relay.web_push_subscriptions.list_for_user")(function* (input) {
      const rows = yield* db
        .select()
        .from(relayWebPushSubscriptions)
        .where(eq(relayWebPushSubscriptions.userId, input.userId))
        .pipe(
          Effect.mapError(
            (cause) =>
              new WebPushSubscriptionPersistenceError({
                operation: "list",
                userId: input.userId,
                subscriptionId: null,
                cause,
              }),
          ),
        );
      return rows.map((row) => ({
        userId: row.userId,
        subscriptionId: row.subscriptionId,
        endpoint: row.endpoint,
        expirationTime: row.expirationTime === null ? null : Number(row.expirationTime),
        p256dh: row.p256dh,
        auth: row.auth,
        preferences: row.preferencesJson,
      }));
    }),
  });
});

export const layer = Layer.effect(WebPushSubscriptions, make);
