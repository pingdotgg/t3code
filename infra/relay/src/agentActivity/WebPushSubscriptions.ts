import type {
  RelayAgentActivityState,
  RelayPwaWebPushSubscriptionRegistrationRequest,
  RelayWebPushPreferences,
  RelayWebPushSubscriptionRegistrationRequest,
} from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { and, eq, lt } from "drizzle-orm";

import * as RelayDb from "../db.ts";
import {
  relayWebPushSubscriptions,
  relayWebPushSubscriptionStates,
} from "../persistence/schema.ts";

export type WebPushNotification = {
  readonly eventId: string;
  readonly deepLink: string;
  readonly showProjectAndThreadNames: boolean;
  readonly title: string;
  readonly body: string;
  readonly subscription: typeof relayWebPushSubscriptions.$inferSelect;
};

export class WebPushSubscriptionPersistenceError extends Schema.TaggedError<WebPushSubscriptionPersistenceError>()(
  "WebPushSubscriptionPersistenceError",
  { cause: Schema.Defect() },
) {}

function mapPersistenceError<A, E>(effect: Effect.Effect<A, E>) {
  return effect.pipe(
    Effect.mapError((cause) => new WebPushSubscriptionPersistenceError({ cause })),
  );
}

export class WebPushSubscriptions extends Context.Service<
  WebPushSubscriptions,
  {
    readonly register: (input: {
      readonly userId: string;
      readonly payload: RelayWebPushSubscriptionRegistrationRequest;
    }) => Effect.Effect<{ readonly subscriptionId: string }, WebPushSubscriptionPersistenceError>;
    readonly remove: (input: {
      readonly userId: string;
      readonly subscriptionId: string;
    }) => Effect.Effect<boolean, WebPushSubscriptionPersistenceError>;
    readonly get: (input: {
      readonly userId: string;
      readonly subscriptionId: string;
    }) => Effect.Effect<
      typeof relayWebPushSubscriptions.$inferSelect | null,
      WebPushSubscriptionPersistenceError
    >;
    readonly transition: (input: {
      readonly userId: string;
      readonly state: RelayAgentActivityState | null;
    }) => Effect.Effect<ReadonlyArray<WebPushNotification>, WebPushSubscriptionPersistenceError>;
    readonly registerPwa: (input: {
      readonly payload: RelayPwaWebPushSubscriptionRegistrationRequest;
    }) => Effect.Effect<{ readonly subscriptionId: string }, WebPushSubscriptionPersistenceError>;
    readonly removePwa: (input: {
      readonly installationId: string;
      readonly installationSecret: string;
      readonly subscriptionId: string;
    }) => Effect.Effect<boolean, WebPushSubscriptionPersistenceError>;
    readonly getPwa: (input: {
      readonly installationId: string;
      readonly installationSecret: string;
      readonly subscriptionId: string;
    }) => Effect.Effect<
      typeof relayWebPushSubscriptions.$inferSelect | null,
      WebPushSubscriptionPersistenceError
    >;
    readonly transitionEnvironment: (input: {
      readonly environmentId: string;
      readonly state: RelayAgentActivityState | null;
    }) => Effect.Effect<ReadonlyArray<WebPushNotification>, WebPushSubscriptionPersistenceError>;
  }
>()("t3code-relay/agentActivity/WebPushSubscriptions") {}

function wantsNotification(preferences: RelayWebPushPreferences, kind: string): boolean {
  if (!preferences.enabled) return false;
  switch (kind) {
    case "plan_ready":
      return preferences.notifyOnPlanReady;
    case "input_required":
      return preferences.notifyOnInput;
    case "agent_completed":
      return preferences.notifyOnCompletion;
    case "agent_failed":
      return preferences.notifyOnFailure;
    default:
      return false;
  }
}

function notificationKind(
  previous: { readonly phase: string; readonly hasActionableProposedPlan: boolean },
  next: RelayAgentActivityState,
): string | null {
  if (!previous.hasActionableProposedPlan && next.hasActionableProposedPlan) return "plan_ready";
  if (
    (next.phase === "waiting_for_approval" || next.phase === "waiting_for_input") &&
    previous.phase !== next.phase
  ) {
    return "input_required";
  }
  if (next.phase === "completed" && previous.phase !== "completed") return "agent_completed";
  if (next.phase === "failed" && previous.phase !== "failed") return "agent_failed";
  return null;
}

function notificationCopy(input: {
  readonly state: RelayAgentActivityState;
  readonly kind: string;
  readonly names: boolean;
}) {
  if (!input.names) {
    return { title: "T3 Code", body: "Agent activity needs your attention." };
  }
  switch (input.kind) {
    case "plan_ready":
      return { title: input.state.threadTitle, body: `Plan ready · ${input.state.projectTitle}` };
    case "input_required":
      return {
        title: input.state.threadTitle,
        body: `${input.state.headline} · ${input.state.projectTitle}`,
      };
    case "agent_completed":
      return {
        title: input.state.threadTitle,
        body: `Agent completed · ${input.state.projectTitle}`,
      };
    default:
      return { title: input.state.threadTitle, body: `Agent failed · ${input.state.projectTitle}` };
  }
}

function hashInstallationSecret(crypto: Crypto.Crypto, secret: string) {
  return Effect.gen(function* () {
    const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(secret));
    return Encoding.encodeBase64Url(digest);
  });
}

export const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  const crypto = yield* Crypto.Crypto;
  return WebPushSubscriptions.of({
    registerPwa: (input) =>
      Effect.gen(function* () {
        const now = DateTime.formatIso(yield* DateTime.now);
        const id = yield* crypto.randomUUIDv4;
        const installation = input.payload.installation;
        const installationSecretHash = yield* hashInstallationSecret(
          crypto,
          installation.installationSecret,
        );
        const existing = yield* db
          .select({
            id: relayWebPushSubscriptions.id,
            installationSecretHash: relayWebPushSubscriptions.installationSecretHash,
          })
          .from(relayWebPushSubscriptions)
          .where(eq(relayWebPushSubscriptions.installationId, installation.installationId))
          .limit(1);
        if (existing[0] && existing[0].installationSecretHash !== installationSecretHash) {
          return yield* Effect.die(
            "PWA installation credential does not match the registered installation.",
          );
        }
        const endpointRows = yield* db
          .select({ id: relayWebPushSubscriptions.id })
          .from(relayWebPushSubscriptions)
          .where(eq(relayWebPushSubscriptions.endpoint, input.payload.endpoint))
          .limit(1);
        const endpointOwner = endpointRows[0];
        // Push services can retain an endpoint when a Home Screen install is
        // removed and added again. Transfer it only inside this authenticated
        // installation upsert and clear its old transition baseline.
        if (endpointOwner && endpointOwner.id !== existing[0]?.id) {
          yield* db
            .delete(relayWebPushSubscriptionStates)
            .where(eq(relayWebPushSubscriptionStates.subscriptionId, endpointOwner.id));
          yield* db
            .delete(relayWebPushSubscriptions)
            .where(eq(relayWebPushSubscriptions.id, endpointOwner.id));
        }
        const rows = yield* db
          .insert(relayWebPushSubscriptions)
          .values({
            id,
            // Keeps legacy account-owned rows intact while making anonymous
            // ownership explicit and non-linkable to a user account.
            userId: `pwa:${installation.installationId}`,
            environmentId: input.payload.environmentId,
            installationId: installation.installationId,
            installationSecretHash,
            endpoint: input.payload.endpoint,
            p256dh: input.payload.keys.p256dh,
            auth: input.payload.keys.auth,
            preferencesJson: input.payload.preferences,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: relayWebPushSubscriptions.installationId,
            set: {
              environmentId: input.payload.environmentId,
              endpoint: input.payload.endpoint,
              p256dh: input.payload.keys.p256dh,
              auth: input.payload.keys.auth,
              preferencesJson: input.payload.preferences,
              updatedAt: now,
            },
          })
          .returning({ id: relayWebPushSubscriptions.id });
        const row = rows[0];
        if (!row) return yield* Effect.die("PWA registration returned no subscription id.");
        return { subscriptionId: row.id };
      }).pipe(mapPersistenceError, Effect.withSpan("relay.web_push_subscriptions.register_pwa")),
    removePwa: (input) =>
      Effect.gen(function* () {
        const installationSecretHash = yield* hashInstallationSecret(
          crypto,
          input.installationSecret,
        );
        const deleted = yield* db
          .delete(relayWebPushSubscriptions)
          .where(
            and(
              eq(relayWebPushSubscriptions.id, input.subscriptionId),
              eq(relayWebPushSubscriptions.installationId, input.installationId),
              eq(relayWebPushSubscriptions.installationSecretHash, installationSecretHash),
            ),
          )
          .returning({ id: relayWebPushSubscriptions.id });
        if (deleted.length === 0) return false;
        yield* db
          .delete(relayWebPushSubscriptionStates)
          .where(eq(relayWebPushSubscriptionStates.subscriptionId, input.subscriptionId));
        return true;
      }).pipe(mapPersistenceError, Effect.withSpan("relay.web_push_subscriptions.remove_pwa")),
    getPwa: (input) =>
      Effect.gen(function* () {
        const installationSecretHash = yield* hashInstallationSecret(
          crypto,
          input.installationSecret,
        );
        const rows = yield* db
          .select()
          .from(relayWebPushSubscriptions)
          .where(
            and(
              eq(relayWebPushSubscriptions.id, input.subscriptionId),
              eq(relayWebPushSubscriptions.installationId, input.installationId),
              eq(relayWebPushSubscriptions.installationSecretHash, installationSecretHash),
            ),
          )
          .limit(1);
        return rows[0] ?? null;
      }).pipe(mapPersistenceError),
    register: (input) =>
      Effect.gen(function* () {
        const now = DateTime.formatIso(yield* DateTime.now);
        const id = yield* crypto.randomUUIDv4;
        const existingRows = yield* db
          .select({ id: relayWebPushSubscriptions.id, userId: relayWebPushSubscriptions.userId })
          .from(relayWebPushSubscriptions)
          .where(eq(relayWebPushSubscriptions.endpoint, input.payload.endpoint))
          .limit(1);
        const existing = existingRows[0] ?? null;
        const rows = yield* db
          .insert(relayWebPushSubscriptions)
          .values({
            id,
            userId: input.userId,
            endpoint: input.payload.endpoint,
            p256dh: input.payload.keys.p256dh,
            auth: input.payload.keys.auth,
            preferencesJson: input.payload.preferences,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: relayWebPushSubscriptions.endpoint,
            set: {
              userId: input.userId,
              p256dh: input.payload.keys.p256dh,
              auth: input.payload.keys.auth,
              preferencesJson: input.payload.preferences,
              updatedAt: now,
            },
          })
          .returning({ id: relayWebPushSubscriptions.id });
        const row = rows[0];
        if (!row) return yield* Effect.die("Web Push registration returned no subscription id.");
        // A browser endpoint is installation-scoped and may be reused after an
        // account change. Its old account's transition baseline must never
        // influence the new owner's first delivery.
        if (existing !== null && existing.userId !== input.userId) {
          yield* db
            .delete(relayWebPushSubscriptionStates)
            .where(eq(relayWebPushSubscriptionStates.subscriptionId, row.id));
        }
        return { subscriptionId: row.id };
      }).pipe(mapPersistenceError, Effect.withSpan("relay.web_push_subscriptions.register")),
    remove: (input) =>
      Effect.gen(function* () {
        const deleted = yield* db
          .delete(relayWebPushSubscriptions)
          .where(
            and(
              eq(relayWebPushSubscriptions.id, input.subscriptionId),
              eq(relayWebPushSubscriptions.userId, input.userId),
            ),
          )
          .returning({ id: relayWebPushSubscriptions.id });
        if (deleted.length === 0) return false;
        yield* db
          .delete(relayWebPushSubscriptionStates)
          .where(eq(relayWebPushSubscriptionStates.subscriptionId, input.subscriptionId));
        return true;
      }).pipe(mapPersistenceError, Effect.withSpan("relay.web_push_subscriptions.remove")),
    get: (input) =>
      Effect.gen(function* () {
        const rows = yield* db
          .select()
          .from(relayWebPushSubscriptions)
          .where(
            and(
              eq(relayWebPushSubscriptions.id, input.subscriptionId),
              eq(relayWebPushSubscriptions.userId, input.userId),
            ),
          )
          .limit(1);
        return rows[0] ?? null;
      }).pipe(mapPersistenceError, Effect.withSpan("relay.web_push_subscriptions.get")),
    transition: (input) =>
      Effect.gen(function* () {
        const state = input.state;
        if (state === null) return [];
        const subscriptions = yield* db
          .select()
          .from(relayWebPushSubscriptions)
          .where(eq(relayWebPushSubscriptions.userId, input.userId));
        const items = yield* Effect.forEach(subscriptions, (subscription) =>
          Effect.gen(function* () {
            const previousRows = yield* db
              .select()
              .from(relayWebPushSubscriptionStates)
              .where(
                and(
                  eq(relayWebPushSubscriptionStates.subscriptionId, subscription.id),
                  eq(relayWebPushSubscriptionStates.environmentId, state.environmentId),
                  eq(relayWebPushSubscriptionStates.threadId, state.threadId),
                ),
              )
              .limit(1);
            const previous = previousRows[0];
            if (previous && previous.updatedAt >= state.updatedAt) return null;
            const baselineRows = yield* db
              .insert(relayWebPushSubscriptionStates)
              .values({
                subscriptionId: subscription.id,
                environmentId: state.environmentId,
                threadId: state.threadId,
                phase: state.phase,
                hasActionableProposedPlan: state.hasActionableProposedPlan ?? false,
                updatedAt: state.updatedAt,
              })
              .onConflictDoUpdate({
                target: [
                  relayWebPushSubscriptionStates.subscriptionId,
                  relayWebPushSubscriptionStates.environmentId,
                  relayWebPushSubscriptionStates.threadId,
                ],
                set: {
                  phase: state.phase,
                  hasActionableProposedPlan: state.hasActionableProposedPlan ?? false,
                  updatedAt: state.updatedAt,
                },
                setWhere: lt(relayWebPushSubscriptionStates.updatedAt, state.updatedAt),
              })
              .returning({ updatedAt: relayWebPushSubscriptionStates.updatedAt });
            // A concurrent newer delivery won the compare-and-swap. Do not use
            // the stale pre-read baseline to produce a duplicate notification.
            if (previous && baselineRows.length === 0) return null;
            if (!previous) return null;
            const kind = notificationKind(previous, {
              ...state,
              hasActionableProposedPlan: state.hasActionableProposedPlan ?? false,
            });
            if (!kind || !wantsNotification(subscription.preferencesJson, kind)) return null;
            const copy = notificationCopy({
              state: {
                ...state,
                hasActionableProposedPlan: state.hasActionableProposedPlan ?? false,
              },
              kind,
              names: subscription.preferencesJson.showProjectAndThreadNames,
            });
            return {
              eventId: `web:${subscription.id}:${state.environmentId}:${state.threadId}:${kind}:${state.updatedAt}`,
              deepLink: state.deepLink,
              showProjectAndThreadNames: subscription.preferencesJson.showProjectAndThreadNames,
              title: copy.title,
              body: copy.body,
              subscription,
            } satisfies WebPushNotification;
          }),
        );
        return items.filter((item): item is WebPushNotification => item !== null);
      }).pipe(mapPersistenceError, Effect.withSpan("relay.web_push_subscriptions.transition")),
    transitionEnvironment: (input) =>
      Effect.gen(function* () {
        const state = input.state;
        if (state === null) return [];
        const subscriptions = yield* db
          .select()
          .from(relayWebPushSubscriptions)
          .where(eq(relayWebPushSubscriptions.environmentId, input.environmentId));
        const items = yield* Effect.forEach(subscriptions, (subscription) =>
          Effect.gen(function* () {
            const previousRows = yield* db
              .select()
              .from(relayWebPushSubscriptionStates)
              .where(
                and(
                  eq(relayWebPushSubscriptionStates.subscriptionId, subscription.id),
                  eq(relayWebPushSubscriptionStates.environmentId, state.environmentId),
                  eq(relayWebPushSubscriptionStates.threadId, state.threadId),
                ),
              )
              .limit(1);
            const previous = previousRows[0];
            if (previous && previous.updatedAt >= state.updatedAt) return null;
            const baselineRows = yield* db
              .insert(relayWebPushSubscriptionStates)
              .values({
                subscriptionId: subscription.id,
                environmentId: state.environmentId,
                threadId: state.threadId,
                phase: state.phase,
                hasActionableProposedPlan: state.hasActionableProposedPlan ?? false,
                updatedAt: state.updatedAt,
              })
              .onConflictDoUpdate({
                target: [
                  relayWebPushSubscriptionStates.subscriptionId,
                  relayWebPushSubscriptionStates.environmentId,
                  relayWebPushSubscriptionStates.threadId,
                ],
                set: {
                  phase: state.phase,
                  hasActionableProposedPlan: state.hasActionableProposedPlan ?? false,
                  updatedAt: state.updatedAt,
                },
                setWhere: lt(relayWebPushSubscriptionStates.updatedAt, state.updatedAt),
              })
              .returning({ updatedAt: relayWebPushSubscriptionStates.updatedAt });
            if ((previous && baselineRows.length === 0) || !previous) return null;
            const kind = notificationKind(previous, {
              ...state,
              hasActionableProposedPlan: state.hasActionableProposedPlan ?? false,
            });
            if (!kind || !wantsNotification(subscription.preferencesJson, kind)) return null;
            const copy = notificationCopy({
              state: {
                ...state,
                hasActionableProposedPlan: state.hasActionableProposedPlan ?? false,
              },
              kind,
              names: subscription.preferencesJson.showProjectAndThreadNames,
            });
            return {
              eventId: `web:${subscription.id}:${state.environmentId}:${state.threadId}:${kind}:${state.updatedAt}`,
              deepLink: state.deepLink,
              showProjectAndThreadNames: subscription.preferencesJson.showProjectAndThreadNames,
              title: copy.title,
              body: copy.body,
              subscription,
            } satisfies WebPushNotification;
          }),
        );
        return items.filter((item): item is WebPushNotification => item !== null);
      }).pipe(
        mapPersistenceError,
        Effect.withSpan("relay.web_push_subscriptions.transition_environment"),
      ),
  });
});

export const layer = Layer.effect(WebPushSubscriptions, make);
