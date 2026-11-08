import {
  BETA_GATEWAY_LINK_LIMIT,
  type RelayEnvironmentLinkProofPayload,
  type RelayEnvironmentLinkRequest,
  type RelayManagedEndpoint,
  type RelayManagedEndpointRuntimeConfig,
} from "@t3tools/contracts/relay";
import { and, count, eq, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Hex from "effect/encoding/Hex";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlError from "effect/sql/SqlError";

import * as RelayConfiguration from "../Config.ts";
import * as RelayDb from "../db.ts";
import { isManagedEndpointHostname } from "../deploymentConfig.ts";
import {
  relayEnvironmentLinks as linksTable,
  relayManagedEndpointAllocations,
  relayDpopProofs,
} from "../persistence/schema.ts";
import { betaGatewayEndpoint } from "./betaGatewayEndpoint.ts";
import * as EnvironmentCredentials from "./EnvironmentCredentials.ts";
import * as EnvironmentLinks from "./EnvironmentLinks.ts";
import { tunnelAccountLock, ManagedTunnelLimitExceeded } from "./ManagedTunnelLimits.ts";

export class BetaGatewayUnavailable extends Schema.TaggedError<BetaGatewayUnavailable>()(
  "BetaGatewayUnavailable",
  {},
) {}

export class BetaGatewayPersistenceError extends Schema.TaggedError<BetaGatewayPersistenceError>()(
  "BetaGatewayPersistenceError",
  { cause: Schema.Defect() },
) {}

export class BetaGatewayLinks extends Context.Service<
  BetaGatewayLinks,
  {
    readonly enroll: (input: {
      readonly userId: string;
      readonly proof: RelayEnvironmentLinkProofPayload;
      readonly challengeExpiresAt: number;
      readonly request: RelayEnvironmentLinkRequest;
    }) => Effect.Effect<
      {
        readonly environmentId: RelayEnvironmentLinkProofPayload["environmentId"];
        readonly endpoint: RelayManagedEndpoint;
        readonly endpointRuntime: RelayManagedEndpointRuntimeConfig;
        readonly environmentCredential: string;
      },
      | BetaGatewayUnavailable
      | BetaGatewayPersistenceError
      | EnvironmentLinks.EnvironmentLinkUpsertPersistenceError
      | EnvironmentLinks.BetaGatewayLinkConflict
      | EnvironmentCredentials.EnvironmentCredentialCreatePersistenceError
      | ManagedTunnelLimitExceeded
    >;
    readonly finishBetaRetirement: (input: {
      readonly userId: string;
      readonly environmentId: string;
      readonly endpointKey: string;
    }) => Effect.Effect<void, BetaGatewayPersistenceError>;
    readonly revoke: (input: {
      readonly userId: string;
      readonly environmentId: string;
      readonly attemptId?: string;
      readonly endpointKey?: string;
    }) => Effect.Effect<string | null, BetaGatewayPersistenceError>;
    readonly authorizeBetaConnectors: (
      hashes: ReadonlyArray<string>,
    ) => Effect.Effect<
      ReadonlyArray<{ readonly tokenHash: string; readonly hostname: string }>,
      BetaGatewayPersistenceError
    >;
    readonly findHookEndpoint: (endpointKey: string) => Effect.Effect<
      | (RelayManagedEndpoint & {
          readonly environmentId: string;
          readonly holdWhileOffline: boolean;
        })
      | null,
      BetaGatewayPersistenceError
    >;
  }
>()("t3code-relay/environments/BetaGatewayLinks") {}

const persistenceError = (cause: unknown) => new BetaGatewayPersistenceError({ cause });
const activeBetaLink = and(
  eq(linksTable.endpointProviderKind, "t3_relay"),
  eq(linksTable.managedTunnelsEnabled, true),
  isNull(linksTable.revokedAt),
);

const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  const config = yield* RelayConfiguration.RelayConfiguration;
  const links = yield* EnvironmentLinks.EnvironmentLinks;
  const credentials = yield* EnvironmentCredentials.EnvironmentCredentials;
  const random = yield* SecureRandom.SecureRandom;
  const digest = yield* Digest.Digest;
  const hash = (value: string) =>
    digest
      .digest(Digest.sha256, new TextEncoder().encode(value))
      .pipe(Effect.map(Hex.encode), Effect.mapError(persistenceError));
  const cancellationScope = (userId: string, environmentId: string) =>
    hash(JSON.stringify(["cancel-beta-enrollment", userId, environmentId])).pipe(
      Effect.map((value) => `beta:${value}`),
    );

  return BetaGatewayLinks.of({
    finishBetaRetirement: Effect.fn("relay.beta_links.finish_retirement")(function* (input) {
      yield* db
        .update(linksTable)
        .set({ betaConnectorHash: null })
        .where(
          and(
            eq(linksTable.userId, input.userId),
            eq(linksTable.environmentId, input.environmentId),
            eq(linksTable.betaEndpointKey, input.endpointKey),
            isNotNull(linksTable.revokedAt),
          ),
        )
        .pipe(Effect.mapError(persistenceError));
    }),
    revoke: Effect.fn("relay.beta_links.revoke")(function* (input) {
      const thumbprint =
        input.attemptId && config.betaGatewayDomain
          ? yield* cancellationScope(input.userId, input.environmentId)
          : null;
      return yield* db.$client
        .withTransaction(
          Effect.gen(function* () {
            yield* db.execute(tunnelAccountLock(input.userId));
            if (thumbprint && input.attemptId) {
              const now = yield* DateTime.now;
              // A signed challenge lives for five minutes. Unlink must win even if its enrollment POST arrives later.
              yield* db
                .insert(relayDpopProofs)
                .values({
                  thumbprint,
                  jti: input.attemptId,
                  iat: Math.floor(now.epochMilliseconds / 1000),
                  createdAt: DateTime.formatIso(now),
                  expiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 10 })),
                })
                .onConflictDoNothing();
            }
            const [link] = yield* db
              .select({
                key: linksTable.betaEndpointKey,
                publicKey: linksTable.environmentPublicKey,
              })
              .from(linksTable)
              .where(
                and(
                  eq(linksTable.userId, input.userId),
                  eq(linksTable.environmentId, input.environmentId),
                  eq(linksTable.endpointProviderKind, "t3_relay"),
                  isNotNull(linksTable.betaConnectorHash),
                  input.attemptId ? eq(linksTable.betaEnrollmentId, input.attemptId) : undefined,
                  input.endpointKey ? eq(linksTable.betaEndpointKey, input.endpointKey) : undefined,
                ),
              )
              .limit(1);
            if (!link?.key) return null;
            if (yield* links.revokeForUser(input)) {
              yield* credentials.revokeForEnvironmentPublicKey({
                environmentId: input.environmentId,
                environmentPublicKey: link.publicKey,
              });
            }
            return link.key;
          }),
        )
        .pipe(Effect.mapError(persistenceError));
    }),
    enroll: Effect.fn("relay.beta_links.enroll")(function* (input) {
      const { userId, proof, request } = input;
      const { environmentId, environmentPublicKey } = proof;
      const domain = config.betaGatewayDomain;
      if (!domain || !isManagedEndpointHostname(`connector.${domain}`, domain)) {
        return yield* new BetaGatewayUnavailable({});
      }
      const freshKey = Hex.encode(yield* random.randomBytes(8));
      const tokenBytes = yield* random.randomBytes(32);
      const connectorToken = Hex.encode(tokenBytes);
      const connectorHash = yield* hash(connectorToken);
      const thumbprint = yield* cancellationScope(userId, environmentId);
      const write = Effect.gen(function* () {
        yield* db.execute(tunnelAccountLock(userId)).pipe(Effect.mapError(persistenceError));
        const [cancelled] = yield* db
          .select({ jti: relayDpopProofs.jti })
          .from(relayDpopProofs)
          .where(
            and(eq(relayDpopProofs.thumbprint, thumbprint), eq(relayDpopProofs.jti, proof.jti)),
          )
          .limit(1)
          .pipe(Effect.mapError(persistenceError));
        if (
          cancelled ||
          (yield* DateTime.now).epochMilliseconds >=
            Math.min(proof.exp, input.challengeExpiresAt) * 1000
        )
          return yield* new EnvironmentLinks.BetaGatewayLinkConflict({ userId, environmentId });
        // A classic reservation precedes its external tunnel and final link write.
        const [classic] = yield* db
          .select({ environmentId: relayManagedEndpointAllocations.environmentId })
          .from(relayManagedEndpointAllocations)
          .where(
            and(
              eq(relayManagedEndpointAllocations.userId, userId),
              eq(relayManagedEndpointAllocations.environmentId, environmentId),
            ),
          )
          .limit(1)
          .pipe(Effect.mapError(persistenceError));
        if (classic)
          return yield* new EnvironmentLinks.BetaGatewayLinkConflict({ userId, environmentId });
        // Unlink takes a row lock. An enrollment that observed the old key must finish before unlink can retire it.
        const [record] = yield* db
          .select({
            key: linksTable.betaEndpointKey,
            provider: linksTable.endpointProviderKind,
            revokedAt: linksTable.revokedAt,
            publicKey: linksTable.environmentPublicKey,
            httpBaseUrl: linksTable.endpointHttpBaseUrl,
            wsBaseUrl: linksTable.endpointWsBaseUrl,
          })
          .from(linksTable)
          .where(and(eq(linksTable.userId, userId), eq(linksTable.environmentId, environmentId)))
          .for("update")
          .pipe(Effect.mapError(persistenceError));
        const active = record?.revokedAt === null ? record : undefined;
        if (
          active &&
          (active.provider !== "t3_relay" || active.publicKey !== environmentPublicKey)
        ) {
          return yield* new EnvironmentLinks.BetaGatewayLinkConflict({ userId, environmentId });
        }
        const endpointKey = active ? active.key : freshKey;
        const endpoint = betaGatewayEndpoint(domain, endpointKey, active);
        if (!endpointKey || !endpoint || (!active && record?.key === endpointKey)) {
          return yield* new EnvironmentLinks.BetaGatewayLinkConflict({ userId, environmentId });
        }
        const [usage] = yield* db
          .select({ slots: count() })
          .from(linksTable)
          .where(
            and(
              activeBetaLink,
              eq(linksTable.userId, userId),
              ne(linksTable.environmentId, environmentId),
            ),
          )
          .pipe(Effect.mapError(persistenceError));
        if (usage && usage.slots >= BETA_GATEWAY_LINK_LIMIT) {
          return yield* new ManagedTunnelLimitExceeded({
            userId,
            environmentId,
            activeTunnels: usage.slots,
            maxTunnels: BETA_GATEWAY_LINK_LIMIT,
          });
        }
        yield* links.upsert({
          userId,
          request,
          proof,
          endpoint,
          beta: { endpointKey, connectorHash },
        });
        const environmentCredential = yield* credentials.create({
          environmentId,
          environmentPublicKey,
        });
        return {
          environmentId,
          endpoint,
          environmentCredential,
          endpointRuntime: {
            providerKind: "t3_relay" as const,
            connectorToken,
            hostname: new URL(endpoint.httpBaseUrl).hostname,
            gatewayUrl: `wss://connector.${domain}/connect`,
          },
        };
      });
      return yield* db.$client
        .withTransaction(write)
        .pipe(
          Effect.mapError((error) =>
            SqlError.isSqlError(error) ? persistenceError(error) : error,
          ),
        );
    }),
    authorizeBetaConnectors: Effect.fn("relay.beta_links.authorize")(function* (hashes) {
      if (hashes.length === 0 || !config.betaGatewayDomain) return [];
      const rows = yield* db
        .select({
          hash: linksTable.betaConnectorHash,
          key: linksTable.betaEndpointKey,
          httpBaseUrl: linksTable.endpointHttpBaseUrl,
          wsBaseUrl: linksTable.endpointWsBaseUrl,
        })
        .from(linksTable)
        .where(and(activeBetaLink, inArray(linksTable.betaConnectorHash, hashes)))
        .pipe(Effect.mapError(persistenceError));
      return rows.flatMap(({ hash, key, ...stored }) => {
        const endpoint = betaGatewayEndpoint(config.betaGatewayDomain, key, stored);
        return hash && endpoint
          ? [{ tokenHash: hash, hostname: new URL(endpoint.httpBaseUrl).hostname }]
          : [];
      });
    }),
    findHookEndpoint: Effect.fn("relay.beta_links.find_hook_endpoint")(function* (key) {
      const endpoint = betaGatewayEndpoint(config.betaGatewayDomain, key);
      if (!endpoint) return null;
      const [row] = yield* db
        .select({
          environmentId: linksTable.environmentId,
          holdWhileOffline: linksTable.holdWebhooksWhileOffline,
        })
        .from(linksTable)
        .where(
          and(
            activeBetaLink,
            eq(linksTable.betaEndpointKey, key),
            eq(linksTable.endpointHttpBaseUrl, endpoint.httpBaseUrl),
            eq(linksTable.endpointWsBaseUrl, endpoint.wsBaseUrl),
          ),
        )
        .limit(1)
        .pipe(Effect.mapError(persistenceError));
      return row ? { ...row, ...endpoint } : null;
    }),
  });
});

export const layer = Layer.effect(BetaGatewayLinks, make);
