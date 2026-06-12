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
import { and, eq, isNull, or } from "drizzle-orm";

import { RelayDb } from "../db.ts";
import { relayEnvironmentLinks } from "../persistence/schema.ts";

export interface RelayLinkedEnvironmentRecord extends RelayClientEnvironmentRecord {
  readonly environmentPublicKey: string;
}

export interface AgentAwarenessDeliveryUserRecord {
  readonly userId: string;
  readonly notificationsEnabled: boolean;
  readonly liveActivitiesEnabled: boolean;
}

export class EnvironmentLinkUpsertPersistenceError extends Schema.TaggedErrorClass<EnvironmentLinkUpsertPersistenceError>()(
  "EnvironmentLinkUpsertPersistenceError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to persist environment link";
  }
}

export class EnvironmentLinkUserListPersistenceError extends Schema.TaggedErrorClass<EnvironmentLinkUserListPersistenceError>()(
  "EnvironmentLinkUserListPersistenceError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to list users linked to environment";
  }
}

export class EnvironmentPublicKeyListPersistenceError extends Schema.TaggedErrorClass<EnvironmentPublicKeyListPersistenceError>()(
  "EnvironmentPublicKeyListPersistenceError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to list environment public keys";
  }
}

export class EnvironmentLinkListPersistenceError extends Schema.TaggedErrorClass<EnvironmentLinkListPersistenceError>()(
  "EnvironmentLinkListPersistenceError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to list environment links";
  }
}

export class EnvironmentLinkLookupPersistenceError extends Schema.TaggedErrorClass<EnvironmentLinkLookupPersistenceError>()(
  "EnvironmentLinkLookupPersistenceError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to look up environment link";
  }
}

export class EnvironmentLinkRevokePersistenceError extends Schema.TaggedErrorClass<EnvironmentLinkRevokePersistenceError>()(
  "EnvironmentLinkRevokePersistenceError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to revoke environment link";
  }
}

export interface EnvironmentLinksShape {
  readonly upsert: (input: {
    readonly userId: string;
    readonly request: RelayEnvironmentLinkRequest;
    readonly proof: RelayEnvironmentLinkProofPayload;
    readonly endpoint: RelayManagedEndpoint;
  }) => Effect.Effect<void, EnvironmentLinkUpsertPersistenceError>;
  readonly listUsersForEnvironment: (input: {
    readonly environmentId: string;
  }) => Effect.Effect<ReadonlyArray<string>, EnvironmentLinkUserListPersistenceError>;
  readonly listDeliveryUsersForEnvironment: (input: {
    readonly environmentId: string;
    readonly environmentPublicKey: string;
  }) => Effect.Effect<
    ReadonlyArray<AgentAwarenessDeliveryUserRecord>,
    EnvironmentLinkUserListPersistenceError
  >;
  readonly listPublicKeysForEnvironment: (input: {
    readonly environmentId: string;
  }) => Effect.Effect<ReadonlyArray<string>, EnvironmentPublicKeyListPersistenceError>;
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
  readonly revokeForUser: (input: {
    readonly userId: string;
    readonly environmentId: string;
  }) => Effect.Effect<boolean, EnvironmentLinkRevokePersistenceError>;
}

export class EnvironmentLinks extends Context.Service<EnvironmentLinks, EnvironmentLinksShape>()(
  "t3code-relay/environments/EnvironmentLinks",
) {}

function agentAwarenessDeliveryUserCondition(environmentId: string) {
  return and(
    eq(relayEnvironmentLinks.environmentId, environmentId),
    isNull(relayEnvironmentLinks.revokedAt),
    or(
      eq(relayEnvironmentLinks.notificationsEnabled, true),
      eq(relayEnvironmentLinks.liveActivitiesEnabled, true),
    ),
  );
}

function agentAwarenessDeliveryUserKeyCondition(input: {
  readonly environmentId: string;
  readonly environmentPublicKey: string;
}) {
  return and(
    agentAwarenessDeliveryUserCondition(input.environmentId),
    eq(relayEnvironmentLinks.environmentPublicKey, input.environmentPublicKey),
  );
}

const make = Effect.gen(function* () {
  const db = yield* RelayDb;

  return EnvironmentLinks.of({
    upsert: Effect.fn("relay.environment_links.upsert")(
      function* (input) {
        yield* Effect.annotateCurrentSpan({
          "relay.environment_id": input.proof.environmentId,
        });
        const now = DateTime.formatIso(yield* DateTime.now);
        const { request, proof } = input;
        const environmentId = proof.environmentId;
        const { endpoint } = input;
        yield* db
          .insert(relayEnvironmentLinks)
          .values({
            userId: input.userId,
            environmentId,
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
            },
          });
      },
      Effect.mapError((cause) => new EnvironmentLinkUpsertPersistenceError({ cause })),
    ),

    listUsersForEnvironment: Effect.fn("relay.environment_links.list_users_for_environment")(
      function* (input) {
        yield* Effect.annotateCurrentSpan({ "relay.environment_id": input.environmentId });
        return yield* db
          .select({ userId: relayEnvironmentLinks.userId })
          .from(relayEnvironmentLinks)
          .where(agentAwarenessDeliveryUserCondition(input.environmentId))
          .pipe(
            Effect.map((rows) => rows.map((row) => row.userId)),
            Effect.mapError((cause) => new EnvironmentLinkUserListPersistenceError({ cause })),
          );
      },
    ),

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
          Effect.mapError((cause) => new EnvironmentLinkUserListPersistenceError({ cause })),
        );
    }),

    listPublicKeysForEnvironment: Effect.fn(
      "relay.environment_links.list_public_keys_for_environment",
    )(function* (input) {
      yield* Effect.annotateCurrentSpan({ "relay.environment_id": input.environmentId });
      return yield* db
        .select({ environmentPublicKey: relayEnvironmentLinks.environmentPublicKey })
        .from(relayEnvironmentLinks)
        .where(
          and(
            eq(relayEnvironmentLinks.environmentId, input.environmentId),
            isNull(relayEnvironmentLinks.revokedAt),
          ),
        )
        .pipe(
          Effect.map((rows) => [
            ...new Set(rows.map((row) => row.environmentPublicKey).filter((key) => key.length > 0)),
          ]),
          Effect.mapError((cause) => new EnvironmentPublicKeyListPersistenceError({ cause })),
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
          Effect.mapError((cause) => new EnvironmentLinkListPersistenceError({ cause })),
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
          Effect.mapError((cause) => new EnvironmentLinkLookupPersistenceError({ cause })),
        );
    }),

    revokeForUser: Effect.fn("relay.environment_links.revoke_for_user")(
      function* (input) {
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
          .returning({ environmentId: relayEnvironmentLinks.environmentId });
        return rows.length > 0;
      },
      Effect.mapError((cause) => new EnvironmentLinkRevokePersistenceError({ cause })),
    ),
  });
});

export const layer = Layer.effect(EnvironmentLinks, make);
