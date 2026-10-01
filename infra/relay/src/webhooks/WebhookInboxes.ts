import {
  RELAY_WEBHOOK_INBOX_PATH_PREFIX,
  RELAY_WEBHOOK_MAX_PENDING_PER_INBOX,
  type RelayWebhookDelivery,
  type RelayWebhookInbox,
} from "@t3tools/contracts/relay";
import { normalizeRelayIssuer } from "@t3tools/shared/relayJwt";
import { and, asc, count, eq, isNull, lt, or } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as RelayConfiguration from "../Config.ts";
import * as RelayDb from "../db.ts";
import {
  relayEnvironmentLinks,
  relayWebhookDeliveries,
  relayWebhookInboxes,
} from "../persistence/schema.ts";

export class WebhookInboxPersistenceError extends Schema.TaggedError<WebhookInboxPersistenceError>()(
  "WebhookInboxPersistenceError",
  {
    operation: Schema.Literals([
      "create",
      "remove",
      "receive",
      "lookup",
      "mark-attempted",
      "complete",
      "list-retryable",
      "prune",
    ]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Webhook inbox '${this.operation}' failed.`;
  }
}

export interface WebhookInboxOwner {
  readonly environmentId: string;
  readonly environmentPublicKey: string;
}

export type WebhookReceiveResult =
  | { readonly status: "stored"; readonly deliveryId: string }
  | { readonly status: "inbox_not_found" }
  | { readonly status: "inbox_full" };

/** A pending delivery plus the linked user and environment it is pushed to. */
export interface WebhookDeliveryTarget {
  readonly delivery: RelayWebhookDelivery;
  readonly userId: string;
  readonly environmentId: string;
}

export class WebhookInboxes extends Context.Service<
  WebhookInboxes,
  {
    /** Null when `userId` has no active link to the environment. */
    readonly create: (
      owner: WebhookInboxOwner & { readonly userId: string },
    ) => Effect.Effect<RelayWebhookInbox | null, WebhookInboxPersistenceError>;
    readonly remove: (
      input: WebhookInboxOwner & { readonly inboxId: string },
    ) => Effect.Effect<void, WebhookInboxPersistenceError>;
    /** Stores a public webhook request if the inbox belongs to an actively linked environment. */
    readonly receive: (input: {
      readonly inboxId: string;
      readonly headers: Readonly<Record<string, string>>;
      readonly body: string;
    }) => Effect.Effect<WebhookReceiveResult, WebhookInboxPersistenceError>;
    /** Null once the delivery was completed, expired, or its environment was unlinked. */
    readonly getForDelivery: (
      deliveryId: string,
    ) => Effect.Effect<WebhookDeliveryTarget | null, WebhookInboxPersistenceError>;
    readonly markAttempted: (input: {
      readonly deliveryId: string;
      readonly attemptedAt: string;
    }) => Effect.Effect<void, WebhookInboxPersistenceError>;
    /** Deletes a delivery its environment accepted. */
    readonly complete: (deliveryId: string) => Effect.Effect<void, WebhookInboxPersistenceError>;
    /** Pending deliveries not attempted since `attemptedBefore`, oldest first. */
    readonly listRetryable: (input: {
      readonly attemptedBefore: string;
      readonly limit: number;
    }) => Effect.Effect<ReadonlyArray<string>, WebhookInboxPersistenceError>;
    readonly pruneExpired: (input: {
      readonly receivedBefore: string;
    }) => Effect.Effect<void, WebhookInboxPersistenceError>;
  }
>()("t3code-relay/webhooks/WebhookInboxes") {}

const persistenceError =
  (operation: WebhookInboxPersistenceError["operation"]) => (cause: unknown) =>
    new WebhookInboxPersistenceError({ operation, cause });

// Inbox ids are the only credential a sender needs, so they carry 256 bits.
const INBOX_ID_BYTES = 32;

// Deliveries follow the inbox owner's own link, never another user's link to the same machine.
const activeOwnerLink = and(
  eq(relayEnvironmentLinks.userId, relayWebhookInboxes.userId),
  eq(relayEnvironmentLinks.environmentId, relayWebhookInboxes.environmentId),
  eq(relayEnvironmentLinks.environmentPublicKey, relayWebhookInboxes.environmentPublicKey),
  isNull(relayEnvironmentLinks.revokedAt),
);

const ownedInbox = (owner: WebhookInboxOwner) =>
  and(
    eq(relayWebhookInboxes.environmentId, owner.environmentId),
    eq(relayWebhookInboxes.environmentPublicKey, owner.environmentPublicKey),
  );

export const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  const crypto = yield* Crypto.Crypto;
  const settings = yield* RelayConfiguration.RelayConfiguration;
  const inboxUrl = (inboxId: string) =>
    `${normalizeRelayIssuer(settings.relayIssuer)}${RELAY_WEBHOOK_INBOX_PATH_PREFIX}${inboxId}`;

  return WebhookInboxes.of({
    create: Effect.fn("relay.webhook_inboxes.create")(function* (owner) {
      yield* Effect.annotateCurrentSpan({ "relay.environment_id": owner.environmentId });
      const inboxId = yield* crypto
        .randomBytes(INBOX_ID_BYTES)
        .pipe(Effect.map(Encoding.encodeBase64Url), Effect.mapError(persistenceError("create")));
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      const [link] = yield* db
        .select({ userId: relayEnvironmentLinks.userId })
        .from(relayEnvironmentLinks)
        .where(
          and(
            eq(relayEnvironmentLinks.userId, owner.userId),
            eq(relayEnvironmentLinks.environmentId, owner.environmentId),
            eq(relayEnvironmentLinks.environmentPublicKey, owner.environmentPublicKey),
            isNull(relayEnvironmentLinks.revokedAt),
          ),
        )
        .limit(1)
        .pipe(Effect.mapError(persistenceError("create")));
      if (!link) {
        return null;
      }
      yield* db
        .insert(relayWebhookInboxes)
        .values({ inboxId, createdAt, ...owner })
        .pipe(Effect.mapError(persistenceError("create")));
      return { inboxId, url: inboxUrl(inboxId), createdAt };
    }),

    remove: Effect.fn("relay.webhook_inboxes.remove")(function* (input) {
      yield* Effect.annotateCurrentSpan({ "relay.environment_id": input.environmentId });
      // Deliveries cascade with the inbox.
      yield* db
        .delete(relayWebhookInboxes)
        .where(and(eq(relayWebhookInboxes.inboxId, input.inboxId), ownedInbox(input)))
        .pipe(Effect.mapError(persistenceError("remove")));
    }),

    receive: Effect.fn("relay.webhook_inboxes.receive")(function* (input) {
      const deliveryId = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError(persistenceError("receive")),
      );
      const receivedAt = DateTime.formatIso(yield* DateTime.now);
      // The inbox row lock serializes concurrent receives, so the backlog cap
      // holds even when two requests arrive at once.
      const receiveLocked = Effect.gen(function* () {
        const [inbox] = yield* db
          .select({ inboxId: relayWebhookInboxes.inboxId })
          .from(relayWebhookInboxes)
          .innerJoin(relayEnvironmentLinks, activeOwnerLink)
          .where(eq(relayWebhookInboxes.inboxId, input.inboxId))
          .limit(1)
          .for("update", { of: relayWebhookInboxes });
        if (!inbox) {
          return { status: "inbox_not_found" as const };
        }
        const [backlog] = yield* db
          .select({ pending: count() })
          .from(relayWebhookDeliveries)
          .where(eq(relayWebhookDeliveries.inboxId, input.inboxId));
        // Bounds what an offline machine (or a leaked URL) can pile up.
        if ((backlog?.pending ?? 0) >= RELAY_WEBHOOK_MAX_PENDING_PER_INBOX) {
          return { status: "inbox_full" as const };
        }
        yield* db.insert(relayWebhookDeliveries).values({
          deliveryId,
          inboxId: input.inboxId,
          receivedAt,
          headers: { ...input.headers },
          body: input.body,
        });
        return { status: "stored" as const, deliveryId };
      });
      return yield* db.$client
        .withTransaction(receiveLocked)
        .pipe(Effect.mapError(persistenceError("receive")));
    }),

    getForDelivery: Effect.fn("relay.webhook_inboxes.get_for_delivery")(function* (deliveryId) {
      const [row] = yield* db
        .select({
          deliveryId: relayWebhookDeliveries.deliveryId,
          inboxId: relayWebhookDeliveries.inboxId,
          receivedAt: relayWebhookDeliveries.receivedAt,
          headers: relayWebhookDeliveries.headers,
          body: relayWebhookDeliveries.body,
          userId: relayWebhookInboxes.userId,
          environmentId: relayWebhookInboxes.environmentId,
        })
        .from(relayWebhookDeliveries)
        .innerJoin(
          relayWebhookInboxes,
          eq(relayWebhookInboxes.inboxId, relayWebhookDeliveries.inboxId),
        )
        .innerJoin(relayEnvironmentLinks, activeOwnerLink)
        .where(eq(relayWebhookDeliveries.deliveryId, deliveryId))
        .limit(1)
        .pipe(Effect.mapError(persistenceError("lookup")));
      if (!row) {
        return null;
      }
      const { userId, environmentId, ...delivery } = row;
      return { delivery, userId, environmentId };
    }),

    markAttempted: Effect.fn("relay.webhook_inboxes.mark_attempted")(function* (input) {
      yield* db
        .update(relayWebhookDeliveries)
        .set({ lastAttemptedAt: input.attemptedAt })
        .where(eq(relayWebhookDeliveries.deliveryId, input.deliveryId))
        .pipe(Effect.mapError(persistenceError("mark-attempted")));
    }),

    complete: Effect.fn("relay.webhook_inboxes.complete")(function* (deliveryId) {
      yield* db
        .delete(relayWebhookDeliveries)
        .where(eq(relayWebhookDeliveries.deliveryId, deliveryId))
        .pipe(Effect.mapError(persistenceError("complete")));
    }),

    listRetryable: Effect.fn("relay.webhook_inboxes.list_retryable")(function* (input) {
      // A fresh delivery is already queued, so only deliveries older than the
      // cutoff are retried.
      const rows = yield* db
        .select({ deliveryId: relayWebhookDeliveries.deliveryId })
        .from(relayWebhookDeliveries)
        .where(
          and(
            lt(relayWebhookDeliveries.receivedAt, input.attemptedBefore),
            or(
              isNull(relayWebhookDeliveries.lastAttemptedAt),
              lt(relayWebhookDeliveries.lastAttemptedAt, input.attemptedBefore),
            ),
          ),
        )
        .orderBy(asc(relayWebhookDeliveries.receivedAt))
        .limit(input.limit)
        .pipe(Effect.mapError(persistenceError("list-retryable")));
      return rows.map((row) => row.deliveryId);
    }),

    pruneExpired: Effect.fn("relay.webhook_inboxes.prune_expired")(function* (input) {
      yield* db
        .delete(relayWebhookDeliveries)
        .where(lt(relayWebhookDeliveries.receivedAt, input.receivedBefore))
        .pipe(Effect.mapError(persistenceError("prune")));
    }),
  });
});

export const layer = Layer.effect(WebhookInboxes, make);
