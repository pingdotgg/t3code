import type {
  RelayClientEnvironmentRecord,
  RelayEnvironmentLinkProofPayload,
  RelayEnvironmentLinkRequest,
  RelayManagedEndpoint,
} from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { and, eq, isNull, or, sql } from "drizzle-orm";

import * as RelayDb from "../db.ts";
import { relayEnvironmentLinks } from "../persistence/schema.ts";

export interface RelayLinkedEnvironmentRecord extends RelayClientEnvironmentRecord {
  readonly environmentPublicKey: string;
}

export interface AgentAwarenessDeliveryUserRecord {
  readonly userId: string;
  readonly notificationsEnabled: boolean;
  readonly liveActivitiesEnabled: boolean;
}

export class EnvironmentLinkUpsertPersistenceError extends Schema.TaggedError<EnvironmentLinkUpsertPersistenceError>()(
  "EnvironmentLinkUpsertPersistenceError",
  {
    userId: Schema.String,
    environmentId: Schema.String,
    deviceId: Schema.optionalKey(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to persist environment link for user '${this.userId}', environment '${this.environmentId}'`;
  }
}

export class EnvironmentLinkUserListPersistenceError extends Schema.TaggedError<EnvironmentLinkUserListPersistenceError>()(
  "EnvironmentLinkUserListPersistenceError",
  {
    environmentId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Environment link user query 'list-delivery-users' failed for environment '${this.environmentId}'`;
  }
}

export class EnvironmentLinkListPersistenceError extends Schema.TaggedError<EnvironmentLinkListPersistenceError>()(
  "EnvironmentLinkListPersistenceError",
  {
    userId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to list environment links for user '${this.userId}'`;
  }
}

export class EnvironmentLinkLookupPersistenceError extends Schema.TaggedError<EnvironmentLinkLookupPersistenceError>()(
  "EnvironmentLinkLookupPersistenceError",
  {
    userId: Schema.String,
    environmentId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to look up environment link for user '${this.userId}', environment '${this.environmentId}'`;
  }
}

export class EnvironmentLinkEnvironmentLookupPersistenceError extends Schema.TaggedError<EnvironmentLinkEnvironmentLookupPersistenceError>()(
  "EnvironmentLinkEnvironmentLookupPersistenceError",
  {
    environmentId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to look up active managed links for environment '${this.environmentId}'`;
  }
}

export class EnvironmentLinkRevokePersistenceError extends Schema.TaggedError<EnvironmentLinkRevokePersistenceError>()(
  "EnvironmentLinkRevokePersistenceError",
  {
    userId: Schema.String,
    environmentId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to revoke environment link for user '${this.userId}', environment '${this.environmentId}'`;
  }
}

export class EnvironmentLinks extends Context.Service<
  EnvironmentLinks,
  {
    readonly upsert: (input: {
      readonly userId: string;
      readonly request: RelayEnvironmentLinkRequest;
      readonly proof: RelayEnvironmentLinkProofPayload;
      readonly endpoint: RelayManagedEndpoint;
    }) => Effect.Effect<void, EnvironmentLinkUpsertPersistenceError>;
    readonly listDeliveryUsersForEnvironment: (input: {
      readonly environmentId: string;
      readonly environmentPublicKey: string;
    }) => Effect.Effect<
      ReadonlyArray<AgentAwarenessDeliveryUserRecord>,
      EnvironmentLinkUserListPersistenceError
    >;
    readonly listForUser: (input: {
      readonly userId: string;
    }) => Effect.Effect<
      ReadonlyArray<RelayClientEnvironmentRecord>,
      EnvironmentLinkListPersistenceError
    >;
    readonly getForUser: (input: {
      readonly userId: string;
      readonly environmentId: string;
    }) => Effect.Effect<RelayLinkedEnvironmentRecord | null, EnvironmentLinkLookupPersistenceError>;
    /**
     * Active relay-managed links for an environment, narrowed to one user or to
     * links proven by one environment key. The environment id alone is public
     * and any account can link it, so callers acting on it must narrow.
     */
    readonly findActiveManagedForEnvironment: (input: {
      readonly environmentId: string;
      readonly userId?: string;
      readonly environmentPublicKey?: string;
    }) => Effect.Effect<
      ReadonlyArray<
        RelayLinkedEnvironmentRecord & {
          readonly userId: string;
          readonly holdWebhooksWhileOffline: boolean;
        }
      >,
      EnvironmentLinkEnvironmentLookupPersistenceError
    >;
    /** Sets the webhook-hold opt-in on the active links proven by one environment key. */
    readonly setHoldWebhooksWhileOffline: (input: {
      readonly environmentId: string;
      readonly environmentPublicKey: string;
      readonly holdWebhooksWhileOffline: boolean;
    }) => Effect.Effect<void, EnvironmentLinkEnvironmentLookupPersistenceError>;
    readonly revokeForUser: (input: {
      readonly userId: string;
      readonly environmentId: string;
    }) => Effect.Effect<boolean, EnvironmentLinkRevokePersistenceError>;
  }
>()("t3code-relay/environments/EnvironmentLinks") {}

function agentAwarenessDeliveryUserKeyCondition(input: {
  readonly environmentId: string;
  readonly environmentPublicKey: string;
}) {
  return and(
    eq(relayEnvironmentLinks.environmentId, input.environmentId),
    isNull(relayEnvironmentLinks.revokedAt),
    or(
      eq(relayEnvironmentLinks.notificationsEnabled, true),
      eq(relayEnvironmentLinks.liveActivitiesEnabled, true),
    ),
    eq(relayEnvironmentLinks.environmentPublicKey, input.environmentPublicKey),
  );
}

const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;

  return EnvironmentLinks.of({
    upsert: Effect.fn("relay.environment_links.upsert")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.environment_id": input.proof.environmentId,
      });
      const now = DateTime.formatIso(yield* DateTime.now);
      const { request, proof } = input;
      const environmentId = proof.environmentId;
      // The webhook-hold opt-in belongs to the environment: a new or re-made
      // link carries it over from the environment's other active links. Only
      // links proven by the same key count; an environment id is public, so
      // anyone can link one and switch the opt-in on for their own link.
      const inheritedHoldWebhooks = sql<boolean>`EXISTS (
        SELECT 1 FROM ${relayEnvironmentLinks} AS other
        WHERE other.environment_id = ${environmentId}
          AND other.environment_public_key = ${proof.environmentPublicKey}
          AND other.revoked_at IS NULL
          AND other.hold_webhooks_while_offline
      )`;
      const { endpoint } = input;
      yield* db
        .insert(relayEnvironmentLinks)
        .values({
          userId: input.userId,
          environmentId,
          holdWebhooksWhileOffline: inheritedHoldWebhooks,
          environmentLabel: proof.descriptor.label,
          environmentPublicKey: proof.environmentPublicKey,
          endpointHttpBaseUrl: endpoint.httpBaseUrl,
          endpointWsBaseUrl: endpoint.wsBaseUrl,
          endpointProviderKind: endpoint.providerKind,
          notificationsEnabled: request.notificationsEnabled,
          liveActivitiesEnabled: request.liveActivitiesEnabled,
          managedTunnelsEnabled: request.managedTunnelsEnabled,
          createdByDeviceId: request.deviceId ?? null,
          revokedAt: null,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [relayEnvironmentLinks.userId, relayEnvironmentLinks.environmentId],
          set: {
            environmentPublicKey: proof.environmentPublicKey,
            environmentLabel: proof.descriptor.label,
            endpointHttpBaseUrl: endpoint.httpBaseUrl,
            endpointWsBaseUrl: endpoint.wsBaseUrl,
            endpointProviderKind: endpoint.providerKind,
            notificationsEnabled: request.notificationsEnabled,
            liveActivitiesEnabled: request.liveActivitiesEnabled,
            managedTunnelsEnabled: request.managedTunnelsEnabled,
            createdByDeviceId: request.deviceId ?? null,
            revokedAt: null,
            updatedAt: now,
            holdWebhooksWhileOffline: inheritedHoldWebhooks,
          },
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new EnvironmentLinkUpsertPersistenceError({
                userId: input.userId,
                environmentId,
                ...(request.deviceId === undefined ? {} : { deviceId: request.deviceId }),
                cause,
              }),
          ),
        );
    }),

    listDeliveryUsersForEnvironment: Effect.fn(
      "relay.environment_links.list_delivery_users_for_environment",
    )(function* (input) {
      yield* Effect.annotateCurrentSpan({ "relay.environment_id": input.environmentId });
      return yield* db
        .select({
          userId: relayEnvironmentLinks.userId,
          notificationsEnabled: relayEnvironmentLinks.notificationsEnabled,
          liveActivitiesEnabled: relayEnvironmentLinks.liveActivitiesEnabled,
        })
        .from(relayEnvironmentLinks)
        .where(agentAwarenessDeliveryUserKeyCondition(input))
        .pipe(
          Effect.map((rows) =>
            rows.map((row) => ({
              userId: row.userId,
              notificationsEnabled: row.notificationsEnabled,
              liveActivitiesEnabled: row.liveActivitiesEnabled,
            })),
          ),
          Effect.mapError(
            (cause) =>
              new EnvironmentLinkUserListPersistenceError({
                environmentId: input.environmentId,
                cause,
              }),
          ),
        );
    }),

    listForUser: Effect.fn("relay.environment_links.list_for_user")(function* (input) {
      return yield* db
        .select({
          environmentId: relayEnvironmentLinks.environmentId,
          environmentLabel: relayEnvironmentLinks.environmentLabel,
          endpointHttpBaseUrl: relayEnvironmentLinks.endpointHttpBaseUrl,
          endpointWsBaseUrl: relayEnvironmentLinks.endpointWsBaseUrl,
          endpointProviderKind: relayEnvironmentLinks.endpointProviderKind,
          createdAt: relayEnvironmentLinks.createdAt,
        })
        .from(relayEnvironmentLinks)
        .where(
          and(
            eq(relayEnvironmentLinks.userId, input.userId),
            isNull(relayEnvironmentLinks.revokedAt),
          ),
        )
        .pipe(
          Effect.map((rows) =>
            rows.map((row) => ({
              environmentId: row.environmentId as RelayClientEnvironmentRecord["environmentId"],
              label:
                row.environmentLabel.trim().length > 0 ? row.environmentLabel : row.environmentId,
              endpoint: {
                httpBaseUrl: row.endpointHttpBaseUrl,
                wsBaseUrl: row.endpointWsBaseUrl,
                providerKind:
                  row.endpointProviderKind as RelayClientEnvironmentRecord["endpoint"]["providerKind"],
              },
              linkedAt: row.createdAt,
            })),
          ),
          Effect.mapError(
            (cause) =>
              new EnvironmentLinkListPersistenceError({
                userId: input.userId,
                cause,
              }),
          ),
        );
    }),

    getForUser: Effect.fn("relay.environment_links.get_for_user")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.environment_id": input.environmentId,
      });
      return yield* db
        .select({
          environmentId: relayEnvironmentLinks.environmentId,
          environmentLabel: relayEnvironmentLinks.environmentLabel,
          environmentPublicKey: relayEnvironmentLinks.environmentPublicKey,
          endpointHttpBaseUrl: relayEnvironmentLinks.endpointHttpBaseUrl,
          endpointWsBaseUrl: relayEnvironmentLinks.endpointWsBaseUrl,
          endpointProviderKind: relayEnvironmentLinks.endpointProviderKind,
          createdAt: relayEnvironmentLinks.createdAt,
        })
        .from(relayEnvironmentLinks)
        .where(
          and(
            eq(relayEnvironmentLinks.userId, input.userId),
            eq(relayEnvironmentLinks.environmentId, input.environmentId),
            isNull(relayEnvironmentLinks.revokedAt),
          ),
        )
        .limit(1)
        .pipe(
          Effect.map((rows) => {
            const row = rows[0];
            return row
              ? {
                  environmentId: row.environmentId as RelayClientEnvironmentRecord["environmentId"],
                  label:
                    row.environmentLabel.trim().length > 0
                      ? row.environmentLabel
                      : row.environmentId,
                  endpoint: {
                    httpBaseUrl: row.endpointHttpBaseUrl,
                    wsBaseUrl: row.endpointWsBaseUrl,
                    providerKind:
                      row.endpointProviderKind as RelayClientEnvironmentRecord["endpoint"]["providerKind"],
                  },
                  environmentPublicKey: row.environmentPublicKey,
                  linkedAt: row.createdAt,
                }
              : null;
          }),
          Effect.mapError(
            (cause) =>
              new EnvironmentLinkLookupPersistenceError({
                userId: input.userId,
                environmentId: input.environmentId,
                cause,
              }),
          ),
        );
    }),

    findActiveManagedForEnvironment: Effect.fn(
      "relay.environment_links.find_active_managed_for_environment",
    )(function* (input) {
      yield* Effect.annotateCurrentSpan({ "relay.environment_id": input.environmentId });
      return yield* db
        .select({
          userId: relayEnvironmentLinks.userId,
          environmentId: relayEnvironmentLinks.environmentId,
          environmentLabel: relayEnvironmentLinks.environmentLabel,
          environmentPublicKey: relayEnvironmentLinks.environmentPublicKey,
          endpointHttpBaseUrl: relayEnvironmentLinks.endpointHttpBaseUrl,
          endpointWsBaseUrl: relayEnvironmentLinks.endpointWsBaseUrl,
          endpointProviderKind: relayEnvironmentLinks.endpointProviderKind,
          createdAt: relayEnvironmentLinks.createdAt,
          holdWebhooksWhileOffline: relayEnvironmentLinks.holdWebhooksWhileOffline,
        })
        .from(relayEnvironmentLinks)
        .where(
          and(
            eq(relayEnvironmentLinks.environmentId, input.environmentId),
            isNull(relayEnvironmentLinks.revokedAt),
            eq(relayEnvironmentLinks.endpointProviderKind, "cloudflare_tunnel"),
            eq(relayEnvironmentLinks.managedTunnelsEnabled, true),
            input.userId === undefined ? undefined : eq(relayEnvironmentLinks.userId, input.userId),
            input.environmentPublicKey === undefined
              ? undefined
              : eq(relayEnvironmentLinks.environmentPublicKey, input.environmentPublicKey),
          ),
        )
        // At most one row per user who linked this environment.
        .pipe(
          Effect.map((rows) =>
            rows.map((row) => ({
              userId: row.userId,
              environmentId: row.environmentId as RelayClientEnvironmentRecord["environmentId"],
              label:
                row.environmentLabel.trim().length > 0 ? row.environmentLabel : row.environmentId,
              endpoint: {
                httpBaseUrl: row.endpointHttpBaseUrl,
                wsBaseUrl: row.endpointWsBaseUrl,
                providerKind:
                  row.endpointProviderKind as RelayClientEnvironmentRecord["endpoint"]["providerKind"],
              },
              environmentPublicKey: row.environmentPublicKey,
              linkedAt: row.createdAt,
              holdWebhooksWhileOffline: row.holdWebhooksWhileOffline,
            })),
          ),
          Effect.mapError(
            (cause) =>
              new EnvironmentLinkEnvironmentLookupPersistenceError({
                environmentId: input.environmentId,
                cause,
              }),
          ),
        );
    }),

    setHoldWebhooksWhileOffline: Effect.fn(
      "relay.environment_links.set_hold_webhooks_while_offline",
    )(function* (input) {
      yield* Effect.annotateCurrentSpan({ "relay.environment_id": input.environmentId });
      yield* db
        .update(relayEnvironmentLinks)
        .set({ holdWebhooksWhileOffline: input.holdWebhooksWhileOffline })
        .where(
          and(
            eq(relayEnvironmentLinks.environmentId, input.environmentId),
            eq(relayEnvironmentLinks.environmentPublicKey, input.environmentPublicKey),
            isNull(relayEnvironmentLinks.revokedAt),
          ),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new EnvironmentLinkEnvironmentLookupPersistenceError({
                environmentId: input.environmentId,
                cause,
              }),
          ),
        );
    }),

    revokeForUser: Effect.fn("relay.environment_links.revoke_for_user")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.environment_id": input.environmentId,
      });
      const revokedAt = DateTime.formatIso(yield* DateTime.now);
      const rows = yield* db
        .update(relayEnvironmentLinks)
        .set({
          revokedAt,
          updatedAt: revokedAt,
        })
        .where(
          and(
            eq(relayEnvironmentLinks.userId, input.userId),
            eq(relayEnvironmentLinks.environmentId, input.environmentId),
            isNull(relayEnvironmentLinks.revokedAt),
          ),
        )
        .returning({ environmentId: relayEnvironmentLinks.environmentId })
        .pipe(
          Effect.mapError(
            (cause) =>
              new EnvironmentLinkRevokePersistenceError({
                userId: input.userId,
                environmentId: input.environmentId,
                cause,
              }),
          ),
        );
      return rows.length > 0;
    }),
  });
});

export const layer = Layer.effect(EnvironmentLinks, make);
